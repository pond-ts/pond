//! Reading times written as text, by pond-ts's rules (`Time.parse`).

use jiff::Timestamp;
use jiff::civil::{Date, DateTime};
use jiff::tz::TimeZone;

use crate::error::{PondError, Result};

/// A time written as text, as epoch milliseconds, read the way pond-ts's
/// `Time.parse(text)` reads it. Same as [`parse_time_in`] with `"UTC"`.
///
/// ```
/// # use pond_rs::parse_time;
/// assert_eq!(parse_time("2026-03-07T09:00:00Z")?, 1_772_874_000_000);
/// assert_eq!(parse_time("2026-03-07T10:00:00+01:00")?, 1_772_874_000_000);
/// assert_eq!(parse_time("2026-03-07")?, 1_772_841_600_000); // UTC midnight
/// # Ok::<(), pond_rs::PondError>(())
/// ```
pub fn parse_time(text: &str) -> Result<i64> {
    parse_time_in(text, "UTC")
}

/// A time written as text, as epoch milliseconds, read the way pond-ts's
/// `Time.parse(text, { timeZone })` reads it:
///
/// - `2026-03` and `2026-03-07`: the start of that month or day in
///   `time_zone` (on a day that starts at 01:00 because of a clock change,
///   01:00).
/// - `2026-03-07T09:00`, with optional seconds and up to nine digits of
///   fraction, `T` or a space between date and time: that wall-clock time in
///   `time_zone`. A time the clocks skip (02:30 on a spring-forward night)
///   moves forward by the gap; a time that happens twice takes the earlier.
/// - Anything else must name its offset (`Z`, `+01:00`, …), and
///   `time_zone` is not used (not even checked). Bracketed notes after the
///   offset (`[Europe/Madrid]`, `[u-ca=iso8601]`) are checked as Temporal
///   checks them, then ignored.
///
/// `time_zone` is an IANA name (`"Europe/Madrid"`) or an offset (`"+05:30"`,
/// `"+0530"`, `"+05"`). Fractions below a millisecond round down (towards
/// the past), as in pond-ts. A malformed time, or an unknown `time_zone`
/// when the text needs one, is an error.
///
/// Zone rules come from the tz database bundled into pond-rs
/// ([`tzdb_version`](crate::tzdb_version)); pond-ts uses its JavaScript
/// runtime's. Where the two disagree about a zone's history (or its
/// predicted future), so do the results.
///
/// ```
/// # use pond_rs::parse_time_in;
/// let t = parse_time_in("2026-03-07 09:00", "America/New_York")?;
/// assert_eq!(t, 1_772_892_000_000); // 14:00 UTC
/// # Ok::<(), pond_rs::PondError>(())
/// ```
pub fn parse_time_in(text: &str, time_zone: &str) -> Result<i64> {
    let bad = |why: String| PondError::InvalidData {
        call: "parse_time",
        message: format!("cannot read {text:?} as a time: {why}"),
    };
    let zone = || match crate::sequence::fixed_offset(time_zone) {
        Some(zone) => Ok(zone),
        None => TimeZone::get(time_zone).map_err(|e| PondError::InvalidData {
            call: "parse_time",
            message: format!("unknown time zone {time_zone:?}: {e}"),
        }),
    };
    let b = text.as_bytes();
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    let num = |r: std::ops::Range<usize>| -> i32 {
        b[r].iter().fold(0, |n, d| n * 10 + i32::from(d - b'0'))
    };
    let is_date = b.len() >= 10 && digits(0..4) && b[4] == b'-' && digits(5..7);
    let is_date = is_date && b[7] == b'-' && digits(8..10);

    // `YYYY-MM`: the first of the month.
    if b.len() == 7 && digits(0..4) && b[4] == b'-' && digits(5..7) {
        let date =
            Date::new(num(0..4) as i16, num(5..7) as i8, 1).map_err(|e| bad(e.to_string()))?;
        return start_of_day(date, &zone()?).map_err(bad);
    }
    // `YYYY-MM-DD`.
    if b.len() == 10 && is_date {
        let date = Date::new(num(0..4) as i16, num(5..7) as i8, num(8..10) as i8)
            .map_err(|e| bad(e.to_string()))?;
        return start_of_day(date, &zone()?).map_err(bad);
    }
    // `YYYY-MM-DD[T ]HH:MM[:SS[.f{1,9}]]`, wall-clock time in the zone.
    if let Some(dt) = local_date_time(b, is_date) {
        let (date, hour, minute, second, nano) = dt;
        let date = Date::new(date.0, date.1, date.2).map_err(|e| bad(e.to_string()))?;
        // A leap second (`:60`) is read as `:59`, as Temporal does.
        if second > 60 {
            return Err(bad("seconds must be 0 to 60".into()));
        }
        let second = second.min(59);
        let dt = DateTime::new(
            date.year(),
            date.month(),
            date.day(),
            hour,
            minute,
            second,
            nano,
        )
        .map_err(|e| bad(e.to_string()))?;
        let zoned = dt.to_zoned(zone()?).map_err(|e| bad(e.to_string()))?;
        return Ok(floor_ms(zoned.timestamp()));
    }
    let bare = strip_annotations(text).map_err(|why| bad(why.into()))?;
    offset_check(bare).map_err(|why| bad(why.into()))?;
    let ts: Timestamp = bare.parse().map_err(|e: jiff::Error| bad(e.to_string()))?;
    Ok(floor_ms(ts))
}

/// The text before its bracketed notes (`[Europe/Madrid]`, `[u-ca=iso8601]`),
/// after checking the notes as Temporal's `Instant.from` does: at most one
/// time-zone note, first (its zone is not used); then `key=value` notes with
/// lower-case keys. A note marked critical (`[!…]`) is refused unless it is
/// the zone or a calendar (`u-ca`, ignored), and a critical calendar is
/// refused when a second calendar note is present. jiff refuses critical
/// notes it does not know, so pond-rs reads the notes itself.
fn strip_annotations(text: &str) -> std::result::Result<&str, &'static str> {
    let Some(start) = text.find('[') else {
        return Ok(text);
    };
    let (bare, mut rest) = text.split_at(start);
    let (mut first, mut calendars, mut critical_calendar) = (true, 0, false);
    while !rest.is_empty() {
        let end = rest.find(']').ok_or("a '[' note is not closed")?;
        let note = &rest[1..end];
        rest = &rest[end + 1..];
        if !rest.is_empty() && !rest.starts_with('[') {
            return Err("text after a ']' note");
        }
        let (critical, note) = match note.strip_prefix('!') {
            Some(n) => (true, n),
            None => (false, note),
        };
        match note.split_once('=') {
            Some((key, value)) => {
                let key_ok = key
                    .bytes()
                    .next()
                    .is_some_and(|b| b.is_ascii_lowercase() || b == b'_')
                    && key.bytes().all(|b| {
                        b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-'
                    });
                let value_ok = !value.is_empty()
                    && value
                        .split('-')
                        .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric()));
                if !key_ok || !value_ok {
                    return Err("a malformed '[key=value]' note");
                }
                if key == "u-ca" {
                    calendars += 1;
                    critical_calendar |= critical;
                } else if critical {
                    return Err("a critical '[!…]' note of an unknown kind");
                }
            }
            None => {
                // An offset to the minute (`+01:00`, `+0100`, `+01`) or a
                // zone name: `/`-separated parts, each starting with a
                // letter, `.` or `_`.
                let zone_ok = if note.starts_with(['+', '-']) {
                    crate::sequence::fixed_offset(note).is_some()
                } else {
                    note.split('/').all(|part| {
                        part.bytes()
                            .next()
                            .is_some_and(|b| b.is_ascii_alphabetic() || b == b'.' || b == b'_')
                            && part
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b"._+-".contains(&b))
                    })
                };
                if !first || !zone_ok {
                    return Err("a malformed '[zone]' note");
                }
            }
        }
        first = false;
    }
    if calendars > 1 && critical_calendar {
        return Err("a critical calendar note with a second calendar note");
    }
    Ok(bare)
}

/// Refuses the two offsets jiff reads but Temporal reads differently: hours
/// past 23 (Temporal refuses them; jiff takes up to 25) and fractions of a
/// second (Temporal keeps them; jiff rounds to the second, so pond-rs
/// refuses rather than be half a second out).
fn offset_check(text: &str) -> std::result::Result<(), &'static str> {
    // The offset follows the time, which follows `T`, `t` or a space.
    let Some(time_at) = text.find(['T', 't', ' ']) else {
        return Ok(());
    };
    let time = &text[time_at..];
    let Some(sign_at) = time.rfind(['+', '-', '\u{2212}']) else {
        return Ok(());
    };
    let offset = &time[sign_at..];
    let offset = offset.trim_start_matches(['+', '-', '\u{2212}']);
    if offset
        .get(..2)
        .and_then(|h| h.parse::<u8>().ok())
        .is_some_and(|h| h > 23)
    {
        return Err("offset hours must be 0 to 23");
    }
    if offset.contains(['.', ',']) {
        return Err("offsets with fractions of a second are not supported");
    }
    Ok(())
}

/// The start of `date` in `zone`: midnight, or the first time that day
/// exists when the clocks skip midnight.
fn start_of_day(date: Date, zone: &TimeZone) -> std::result::Result<i64, String> {
    let zoned = date
        .to_zoned(zone.clone())
        .and_then(|z| z.start_of_day())
        .map_err(|e| e.to_string())?;
    Ok(floor_ms(zoned.timestamp()))
}

type LocalParts = ((i16, i8, i8), i8, i8, i8, i32);

/// Splits `YYYY-MM-DD[T ]HH:MM[:SS[.f{1,9}]]` (exactly pond-ts's pattern)
/// into its parts, or `None` when `b` is not that shape.
fn local_date_time(b: &[u8], is_date: bool) -> Option<LocalParts> {
    let digits =
        |r: std::ops::Range<usize>| b.get(r).is_some_and(|s| s.iter().all(u8::is_ascii_digit));
    let num = |r: std::ops::Range<usize>| -> i32 {
        b[r].iter().fold(0, |n, d| n * 10 + i32::from(d - b'0'))
    };
    if !is_date || b.len() < 16 || !matches!(b[10], b'T' | b' ') {
        return None;
    }
    if !(digits(11..13) && b[13] == b':' && digits(14..16)) {
        return None;
    }
    let (mut second, mut nano) = (0, 0);
    match b.len() {
        16 => {}
        19.. if b[16] == b':' && digits(17..19) => {
            second = num(17..19);
            if b.len() > 19 {
                let fraction = &b[20..];
                if b[19] != b'.' || fraction.is_empty() || fraction.len() > 9 {
                    return None;
                }
                if !fraction.iter().all(u8::is_ascii_digit) {
                    return None;
                }
                let n = fraction.iter().fold(0, |n, d| n * 10 + i32::from(d - b'0'));
                nano = n * 10_i32.pow(9 - fraction.len() as u32);
            }
        }
        _ => return None,
    }
    let date = (num(0..4) as i16, num(5..7) as i8, num(8..10) as i8);
    Some((
        date,
        num(11..13) as i8,
        num(14..16) as i8,
        second as i8,
        nano,
    ))
}

/// Epoch milliseconds, rounding sub-millisecond parts towards the past (as
/// Temporal's `epochMilliseconds` does), so `…59.9995Z` before 1970 is -1.
fn floor_ms(ts: Timestamp) -> i64 {
    ts.as_nanosecond().div_euclid(1_000_000) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    // The parity fixture covers what pond-ts and pond-rs read alike; these
    // are the known differences, pinned so a change is noticed.
    #[test]
    fn differences_from_pond_ts_are_errors() {
        // Temporal reads years to ±271821; jiff to ±9999 and times up to
        // 9999-12-30 22:00 UTC or so.
        assert!(parse_time("-271821-04-20T00:00Z").is_err());
        assert!(parse_time("9999-12-31").is_err());
        // Temporal keeps an offset's fraction of a second; jiff rounds it.
        let e = parse_time("2025-01-01T09:00:00+00:00:00.5").unwrap_err();
        assert!(e.to_string().contains("fractions of a second"), "{e}");
    }

    // Every cut and every spliced-in character of some valid times gives a
    // value or an error, never a panic (the parser indexes bytes).
    #[test]
    fn odd_text_never_panics() {
        let base = [
            "2025-03",
            "2025-03-30",
            "2025-03-30T02:30:00.123456789",
            "2025-01-01T09:00:00+01:00[Europe/Madrid]",
        ];
        for text in base {
            for (at, _) in text.char_indices().chain([(text.len(), ' ')]) {
                let _ = parse_time(&text[..at]);
                for c in ['é', '\u{2212}', '+', '-', 'T', ' ', '9', '.', '['] {
                    let mut s = text.to_string();
                    s.insert(at, c);
                    let _ = parse_time_in(&s, "Europe/Madrid");
                }
            }
        }
    }

    #[test]
    fn errors_say_what_could_not_be_read() {
        let e = parse_time("2025-1-1").unwrap_err().to_string();
        assert!(e.starts_with("parse_time: cannot read \"2025-1-1\""), "{e}");
        let e = parse_time_in("2025-01-01", "Mars/Base")
            .unwrap_err()
            .to_string();
        assert!(e.contains("unknown time zone \"Mars/Base\""), "{e}");
    }
}
