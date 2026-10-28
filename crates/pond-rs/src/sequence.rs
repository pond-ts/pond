//! Sequences: the bucket grids `aggregate` reduces into.

use std::str::FromStr;

use jiff::civil::Date;
use jiff::tz::TimeZone;
use jiff::{Timestamp, ToSpan};

use crate::duration::parse_duration;
use crate::error::{PondError, Result};
use crate::reshape::At;
use crate::series::{IntervalKeys, Labels};

/// A calendar unit for [`Sequence::calendar`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CalendarUnit {
    Day,
    Week,
    Month,
    Quarter,
    Year,
}

impl FromStr for CalendarUnit {
    type Err = PondError;

    /// pond-ts names: `day`, `week`, `month`, `quarter`, `year`.
    fn from_str(unit: &str) -> Result<Self> {
        Ok(match unit {
            "day" => CalendarUnit::Day,
            "week" => CalendarUnit::Week,
            "month" => CalendarUnit::Month,
            "quarter" => CalendarUnit::Quarter,
            "year" => CalendarUnit::Year,
            _ => {
                return Err(PondError::InvalidData {
                    call: "Sequence::calendar",
                    message: format!(
                        "unknown calendar unit '{unit}' (expected day, week, month, quarter or year; for hours use Sequence::every(\"1h\"))"
                    ),
                });
            }
        })
    }
}

/// Times a live calendar aggregation takes, `[lo, hi)`: years -9997 to
/// 9997 (UTC). jiff handles years -9999 to 9999, and a bucket near either
/// end, in a zone up to 14 hours off UTC, needs the year beside it.
#[cfg(feature = "live")]
pub(crate) const CALENDAR_RANGE_MS: (i64, i64) = (-377_642_044_800_000, 253_339_228_800_000);

/// An unbounded grid of buckets. Realised over a concrete range by
/// [`Sequence::buckets_overlapping`]. Build one with [`Sequence::every`] or
/// [`Sequence::calendar`]; the constructors are the only way in, so every
/// `Sequence` is valid (a positive step, a known zone, a week start 1–7).
#[derive(Debug, Clone, PartialEq)]
pub struct Sequence(Grid);

#[derive(Debug, Clone, PartialEq)]
enum Grid {
    /// Fixed-length steps: buckets `[anchor + k·step, anchor + (k+1)·step)`.
    Every { step_ms: i64, anchor_ms: i64 },
    /// Calendar buckets in a time zone: each starts at local midnight of the
    /// unit's first day, so a day can be 23 or 25 hours long.
    Calendar {
        unit: CalendarUnit,
        zone: TimeZone,
        /// First day of a week, ISO numbering: 1 = Monday … 7 = Sunday.
        week_starts_on: i8,
    },
}

impl Sequence {
    /// Fixed-length buckets, anchored at Unix epoch 0, e.g.
    /// `Sequence::every("1m")`. Same as pond-ts `Sequence.every`.
    pub fn every(step: &str) -> Result<Self> {
        Self::every_ms(parse_duration(step)?)
    }

    /// Fixed-length buckets of `step_ms` milliseconds, anchored at epoch 0.
    pub fn every_ms(step_ms: i64) -> Result<Self> {
        if step_ms <= 0 {
            // pond-ts accepts '0s' here and then cannot realise the grid;
            // rejecting it up front is the useful answer.
            return Err(PondError::InvalidData {
                call: "Sequence::every",
                message: format!("step must be positive, got {step_ms} ms"),
            });
        }
        Ok(Sequence(Grid::Every {
            step_ms,
            anchor_ms: 0,
        }))
    }

    /// Calendar buckets in an IANA time zone, e.g.
    /// `Sequence::calendar("day", "America/New_York")`. Same as pond-ts
    /// `Sequence.calendar(unit, { timeZone })`. Weeks start on Monday; see
    /// [`Sequence::with_week_start`].
    ///
    /// Time-zone rules come from the tz database bundled into pond-rs
    /// ([`tzdb_version`]); pond-ts uses the one in its JavaScript runtime.
    /// If the two disagree about a zone's history, so do the buckets.
    pub fn calendar(unit: &str, time_zone: &str) -> Result<Self> {
        let unit = unit.parse()?;
        let zone = match fixed_offset(time_zone) {
            Some(zone) => zone,
            None => TimeZone::get(time_zone).map_err(|e| PondError::InvalidData {
                call: "Sequence::calendar",
                message: format!("unknown time zone '{time_zone}': {e}"),
            })?,
        };
        Ok(Sequence(Grid::Calendar {
            unit,
            zone,
            week_starts_on: 1,
        }))
    }

    /// `(step, anchor)` in ms for a fixed-length sequence; `None` for a
    /// calendar one.
    #[cfg(feature = "live")]
    pub(crate) fn fixed_step(&self) -> Option<(i64, i64)> {
        match self.0 {
            Grid::Every { step_ms, anchor_ms } => Some((step_ms, anchor_ms)),
            Grid::Calendar { .. } => None,
        }
    }

    /// The same grid shifted so a bucket starts at `anchor_ms`. Calendar
    /// sequences have no anchor and are returned unchanged.
    pub fn with_anchor(self, anchor_ms: i64) -> Self {
        match self.0 {
            Grid::Every { step_ms, .. } => Sequence(Grid::Every { step_ms, anchor_ms }),
            calendar => Sequence(calendar),
        }
    }

    /// For calendar weeks: the first day, ISO numbering (1 = Monday … 7 =
    /// Sunday). Fixed sequences are returned unchanged.
    pub fn with_week_start(self, iso_weekday: i8) -> Result<Self> {
        if !(1..=7).contains(&iso_weekday) {
            return Err(PondError::InvalidData {
                call: "Sequence::with_week_start",
                message: format!("week start must be 1 (Monday) to 7 (Sunday), got {iso_weekday}"),
            });
        }
        Ok(match self.0 {
            Grid::Calendar { unit, zone, .. } => Sequence(Grid::Calendar {
                unit,
                zone,
                week_starts_on: iso_weekday,
            }),
            every => Sequence(every),
        })
    }

    /// Every bucket whose extent overlaps the closed range `[begin, end]`,
    /// including the one containing `begin`. This is how pond-ts `aggregate`
    /// realises its grid (`coverage: 'overlap'`).
    ///
    /// pond-ts divides in floating point; this divides exactly in integers.
    /// They agree whenever the quotient is below 2^53 / step, i.e. for any
    /// real timestamp.
    pub fn buckets_overlapping(&self, begin: i64, end: i64) -> Result<IntervalKeys> {
        if end < begin {
            return Err(grid_error(format!(
                "range ends ({end}) before it begins ({begin})"
            )));
        }
        match &self.0 {
            &Grid::Every { step_ms, anchor_ms } => {
                // In i128 so no step, anchor or time can overflow; a bucket
                // edge outside i64 is an error.
                let (step, anchor) = (i128::from(step_ms), i128::from(anchor_ms));
                let first = (i128::from(begin) - anchor).div_euclid(step);
                let last = (i128::from(end) - anchor).div_euclid(step);
                let edge = |k: i128| {
                    i64::try_from(anchor + k * step).map_err(|_| {
                        grid_error(format!(
                            "bucket edge out of range for [{begin}, {end}] with step {step_ms} ms"
                        ))
                    })
                };
                // Checked before allocating: a vast range is an error, not
                // an out-of-memory abort.
                let count = usize::try_from(last - first + 1)
                    .ok()
                    .filter(|&n| n <= MAX_BUCKETS)
                    .ok_or_else(|| {
                        grid_error(format!(
                            "[{begin}, {end}] with step {step_ms} ms is more than {MAX_BUCKETS} buckets"
                        ))
                    })?;
                let mut starts = Vec::with_capacity(count);
                let mut ends = Vec::with_capacity(count);
                let mut start = edge(first)?;
                for k in first..=last {
                    let next = edge(k + 1)?;
                    starts.push(start);
                    ends.push(next);
                    start = next;
                }
                Ok(labelled_by_start(starts, ends))
            }
            Grid::Calendar { .. } => {
                // pond-ts walks from the bucket holding `begin`, one bucket at
                // a time, while the bucket starts at or before `end`.
                let (mut starts, mut ends) = (vec![], vec![]);
                self.walk_calendar(begin, |start, next| {
                    if start > end {
                        return false;
                    }
                    starts.push(start);
                    ends.push(next);
                    true
                })?;
                Ok(labelled_by_start(starts, ends))
            }
        }
    }

    /// The calendar bucket containing `t`, as `(start, end)`; `None` for a
    /// fixed sequence. An error past the years jiff handles (±9999).
    #[cfg(feature = "live")]
    pub(crate) fn calendar_bucket(&self, t: i64) -> Option<Result<(i64, i64)>> {
        if !matches!(self.0, Grid::Calendar { .. }) {
            return None;
        }
        let mut bucket = (0, 0);
        Some(
            self.walk_calendar(t, |start, next| {
                bucket = (start, next);
                false
            })
            .map(|()| bucket),
        )
    }

    /// The buckets whose sample point (`at`: start, middle or end) falls in
    /// the closed range `[begin, end]`; for [`At::End`], in `(begin, end]`,
    /// so a bucket wholly before `begin` is not picked by its end. This is
    /// how pond-ts `align` and `materialize` realise their grid
    /// (`bounded(range, { sample })`), where the sample point becomes the
    /// row's time.
    ///
    /// pond-ts divides in floating point; this works exactly in integers
    /// (in half milliseconds, so a middle on a half millisecond is exact).
    pub(crate) fn buckets_sampled(&self, begin: i64, end: i64, at: At) -> Result<IntervalKeys> {
        if end < begin {
            return Err(grid_error(format!(
                "range ends ({end}) before it begins ({begin})"
            )));
        }
        // The sample point of `[start, next)`, doubled.
        let sample2 = |start: i64, next: i64| -> i128 {
            match at {
                At::Begin => 2 * i128::from(start),
                At::Center => i128::from(start) + i128::from(next),
                At::End => 2 * i128::from(next),
            }
        };
        let (begin2, end2) = (2 * i128::from(begin), 2 * i128::from(end));
        let picked = |s2: i128| match at {
            At::End => s2 > begin2,
            _ => s2 >= begin2,
        };
        match &self.0 {
            &Grid::Every { step_ms, anchor_ms } => {
                let (step, anchor) = (i128::from(step_ms), i128::from(anchor_ms));
                // Bucket k is [anchor + k·step, …); its doubled sample point
                // is 2·anchor + 2k·step + offset.
                let offset = match at {
                    At::Begin => 0,
                    At::Center => step,
                    At::End => 2 * step,
                };
                let num = |t2: i128| t2 - offset - 2 * anchor;
                let den = 2 * step;
                let first = match at {
                    At::End => num(begin2).div_euclid(den) + 1,
                    _ => -(-num(begin2)).div_euclid(den),
                };
                let last = num(end2).div_euclid(den);
                if last < first {
                    return Ok(labelled_by_start(vec![], vec![]));
                }
                let count = usize::try_from(last - first + 1)
                    .ok()
                    .filter(|&n| n <= MAX_BUCKETS)
                    .ok_or_else(|| {
                        grid_error(format!(
                            "[{begin}, {end}] with step {step_ms} ms is more than {MAX_BUCKETS} buckets"
                        ))
                    })?;
                let edge = |k: i128| {
                    i64::try_from(anchor + k * step).map_err(|_| {
                        grid_error(format!(
                            "bucket edge out of range for [{begin}, {end}] with step {step_ms} ms"
                        ))
                    })
                };
                let mut starts = Vec::with_capacity(count);
                let mut ends = Vec::with_capacity(count);
                for k in first..=last {
                    starts.push(edge(k)?);
                    ends.push(edge(k + 1)?);
                }
                Ok(labelled_by_start(starts, ends))
            }
            Grid::Calendar { .. } => {
                let (mut starts, mut ends) = (vec![], vec![]);
                self.walk_calendar(begin, |start, next| {
                    let s2 = sample2(start, next);
                    if s2 > end2 {
                        return false;
                    }
                    if picked(s2) {
                        starts.push(start);
                        ends.push(next);
                    }
                    true
                })?;
                Ok(labelled_by_start(starts, ends))
            }
        }
    }

    /// Calendar buckets from the one holding `begin`, in order, handed to
    /// `visit(start, end)` until it returns false. Each bucket's end is
    /// pond-ts `zone.next(unit, start)`: the unit after the one holding the
    /// local date of `start`. So a local day that never happens (Samoa
    /// skipped 2011-12-30) yields no bucket, rather than an empty one.
    fn walk_calendar(&self, begin: i64, mut visit: impl FnMut(i64, i64) -> bool) -> Result<()> {
        let Grid::Calendar {
            unit,
            zone,
            week_starts_on,
        } = &self.0
        else {
            unreachable!("called on calendar grids only");
        };
        let first = unit_start(*unit, local_date(zone, begin)?, *week_starts_on)?;
        let mut start = midnight_ms(zone, first)?;
        loop {
            let day = unit_start(*unit, local_date(zone, start)?, *week_starts_on)?;
            let next = midnight_ms(zone, advance(*unit, day)?)?;
            if !visit(start, next) {
                return Ok(());
            }
            start = next;
        }
    }
}

/// The version of the tz database bundled into pond-rs, e.g. `"2026e"`.
pub fn tzdb_version() -> Option<&'static str> {
    jiff_tzdb::VERSION
}

/// A fixed-offset zone name as Temporal (and so pond-ts) accepts it:
/// `±HH`, `±HHMM` or `±HH:MM`, e.g. `"+05:30"`.
pub(crate) fn fixed_offset(name: &str) -> Option<TimeZone> {
    let (sign, rest) = match name.as_bytes().first()? {
        b'+' => (1, &name[1..]),
        b'-' => (-1, &name[1..]),
        _ => return None,
    };
    // Byte lengths and slices below assume ASCII ("+a€" must not be cut
    // inside the euro sign).
    if !rest.is_ascii() {
        return None;
    }
    let (hh, mm) = match rest.len() {
        2 => (rest, "00"),
        4 => rest.split_at(2),
        5 if rest.as_bytes()[2] == b':' => (&rest[..2], &rest[3..]),
        _ => return None,
    };
    let number = |s: &str| -> Option<i32> {
        s.bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| s.parse().ok())?
    };
    let (hours, minutes) = (number(hh)?, number(mm)?);
    if hours > 23 || minutes > 59 {
        return None;
    }
    let offset = jiff::tz::Offset::from_seconds(sign * (hours * 3600 + minutes * 60)).ok()?;
    Some(TimeZone::fixed(offset))
}

/// Most buckets one call will build (2^28, a few GB of keys): a guard
/// against a range or step mistake turning into an out-of-memory abort.
const MAX_BUCKETS: usize = 1 << 28;

fn grid_error(message: String) -> PondError {
    PondError::InvalidData {
        call: "Sequence::buckets_overlapping",
        message,
    }
}

fn calendar_error(message: String) -> PondError {
    PondError::InvalidData {
        call: "Sequence::calendar",
        message,
    }
}

/// The local calendar date at instant `ms` in `zone`.
fn local_date(zone: &TimeZone, ms: i64) -> Result<Date> {
    let ts = Timestamp::from_millisecond(ms)
        .map_err(|e| calendar_error(format!("time {ms} ms is out of range: {e}")))?;
    Ok(ts.to_zoned(zone.clone()).date())
}

/// pond-ts `TimeZone.#startDays`: the first day of the unit holding `date`.
fn unit_start(unit: CalendarUnit, date: Date, week_starts_on: i8) -> Result<Date> {
    let out = match unit {
        CalendarUnit::Day => date,
        CalendarUnit::Week => {
            let weekday = date.weekday().to_monday_one_offset();
            let back = (weekday - week_starts_on + 7) % 7;
            date.checked_sub(i64::from(back).days())
                .map_err(|e| calendar_error(e.to_string()))?
        }
        CalendarUnit::Month => date.first_of_month(),
        CalendarUnit::Quarter => {
            let month = date.month();
            Date::new(date.year(), month - (month - 1) % 3, 1)
                .map_err(|e| calendar_error(e.to_string()))?
        }
        CalendarUnit::Year => date.first_of_year(),
    };
    Ok(out)
}

/// pond-ts `TimeZone.#advanceDays`: the first day of the following unit.
fn advance(unit: CalendarUnit, start: Date) -> Result<Date> {
    let span = match unit {
        CalendarUnit::Day => 1.day(),
        CalendarUnit::Week => 7.days(),
        CalendarUnit::Month => 1.month(),
        CalendarUnit::Quarter => 3.months(),
        CalendarUnit::Year => 1.year(),
    };
    start
        .checked_add(span)
        .map_err(|e| calendar_error(e.to_string()))
}

/// The first instant of local day `date` in `zone`, in epoch milliseconds.
/// A midnight skipped by a clock change resolves to the first instant after
/// the gap, and a repeated midnight to the earlier one: Temporal's (and
/// pond-ts's) `'compatible'` rule, which is also jiff's.
fn midnight_ms(zone: &TimeZone, date: Date) -> Result<i64> {
    let zoned = date
        .to_zoned(zone.clone())
        .map_err(|e| calendar_error(e.to_string()))?;
    Ok(zoned.timestamp().as_millisecond())
}

/// Buckets labelled by their start, as pond-ts labels them.
fn labelled_by_start(begin: Vec<i64>, end: Vec<i64>) -> IntervalKeys {
    IntervalKeys {
        label: Labels::Number(begin.iter().map(|&b| b as f64).collect()),
        begin,
        end,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(feature = "live")]
    fn calendar_buckets_cover_the_live_range() {
        let (lo, hi) = CALENDAR_RANGE_MS;
        for unit in ["day", "week", "month", "quarter", "year"] {
            for zone in [
                "UTC",
                "Pacific/Kiritimati",
                "Pacific/Pago_Pago",
                "+14:00",
                "-12:00",
            ] {
                let seq = Sequence::calendar(unit, zone).unwrap();
                for t in [lo, lo + 1, hi - 1] {
                    let (start, end) = seq
                        .calendar_bucket(t)
                        .unwrap()
                        .unwrap_or_else(|e| panic!("{unit} {zone} {t}: {e}"));
                    assert!(start <= t && t < end, "{unit} {zone} {t}");
                }
            }
        }
        assert!(Sequence::every("1s").unwrap().calendar_bucket(0).is_none());
    }

    #[test]
    fn overlap_includes_the_bucket_holding_begin() {
        let keys = Sequence::every("5s")
            .unwrap()
            .buckets_overlapping(2_500, 10_000)
            .unwrap();
        assert_eq!(keys.begin, vec![0, 5_000, 10_000]);
        assert_eq!(keys.end, vec![5_000, 10_000, 15_000]);
        assert_eq!(keys.label, keys.begin.clone().into());
    }

    #[test]
    fn negative_times_floor_down() {
        let keys = Sequence::every("5s")
            .unwrap()
            .buckets_overlapping(-1, -1)
            .unwrap();
        assert_eq!(keys.begin, vec![-5_000]);
    }

    #[test]
    fn anchor_shifts_the_grid() {
        let keys = Sequence::every("5s")
            .unwrap()
            .with_anchor(1_000)
            .buckets_overlapping(0, 7_000)
            .unwrap();
        assert_eq!(keys.begin, vec![-4_000, 1_000, 6_000]);
    }

    const NY_2026_03_07: i64 = 1_772_859_600_000; // 00:00 EST

    #[test]
    fn calendar_days_follow_the_clock_change() {
        let days = Sequence::calendar("day", "America/New_York").unwrap();
        // 2026-03-08 is 23 hours long in New York.
        let keys = days
            .buckets_overlapping(NY_2026_03_07 + 5, NY_2026_03_07 + 2 * 86_400_000)
            .unwrap();
        let lengths: Vec<i64> = keys
            .begin
            .iter()
            .zip(&keys.end)
            .map(|(b, e)| e - b)
            .collect();
        assert_eq!(keys.begin[0], NY_2026_03_07);
        assert_eq!(lengths, vec![86_400_000, 82_800_000, 86_400_000]);
    }

    #[test]
    fn calendar_weeks_months_quarters_years() {
        let t = 1_781_049_600_000; // 2026-06-10 00:00 UTC, a Wednesday
        let first = |unit: &str| {
            Sequence::calendar(unit, "UTC")
                .unwrap()
                .buckets_overlapping(t, t)
                .unwrap()
                .begin[0]
        };
        assert_eq!(first("week"), t - 2 * 86_400_000); // Monday 06-08
        assert_eq!(first("month"), 1_780_272_000_000); // 06-01
        assert_eq!(first("quarter"), 1_775_001_600_000); // 04-01
        assert_eq!(first("year"), 1_767_225_600_000); // 01-01
        let sunday = Sequence::calendar("week", "UTC")
            .unwrap()
            .with_week_start(7)
            .unwrap()
            .buckets_overlapping(t, t)
            .unwrap();
        assert_eq!(sunday.begin[0], t - 3 * 86_400_000);
    }

    #[test]
    fn calendar_skips_a_day_that_never_happened() {
        // Samoa jumped from 2011-12-29 to 2011-12-31.
        let keys = Sequence::calendar("day", "Pacific/Apia")
            .unwrap()
            .buckets_overlapping(1_325_030_400_000, 1_325_462_400_000)
            .unwrap();
        assert_eq!(keys.begin.len(), 6);
        assert!(keys.begin.iter().zip(&keys.end).all(|(b, e)| e > b));
    }

    #[test]
    fn calendar_accepts_fixed_offsets() {
        let start = |zone: &str| {
            Sequence::calendar("day", zone)
                .unwrap()
                .buckets_overlapping(0, 0)
                .unwrap()
                .begin[0]
        };
        assert_eq!(start("+05:30"), -19_800_000);
        assert_eq!(start("+0530"), -19_800_000);
        assert_eq!(start("-08"), -57_600_000);
        assert!(Sequence::calendar("day", "+5:30").is_err());
        assert!(Sequence::calendar("day", "+24:00").is_err());
    }

    #[test]
    fn calendar_rejects_unknown_names() {
        assert!(Sequence::calendar("hour", "UTC").is_err());
        assert!(Sequence::calendar("day", "Mars/Olympus").is_err());
    }

    #[test]
    fn zero_step_is_rejected() {
        assert!(Sequence::every("0s").is_err());
        assert!(Sequence::every_ms(-1).is_err());
    }

    #[test]
    fn extreme_ranges_are_errors_not_panics() {
        let ms = Sequence::every_ms(1).unwrap();
        assert!(ms.buckets_overlapping(i64::MAX, i64::MAX).is_err());
        assert!(ms.buckets_overlapping(i64::MIN, i64::MAX).is_err());
        assert!(ms.buckets_overlapping(5, 4).is_err());
        let huge = Sequence::every_ms(i64::MAX).unwrap().with_anchor(i64::MIN);
        assert!(huge.buckets_overlapping(0, 0).is_ok());
        assert!(huge.buckets_overlapping(i64::MAX, i64::MAX).is_err());
        let days = Sequence::calendar("day", "UTC").unwrap();
        assert!(days.buckets_overlapping(i64::MAX - 1, i64::MAX).is_err());
    }

    #[test]
    fn non_ascii_offsets_are_rejected_not_panics() {
        for zone in ["+a€", "+€", "-0€", "+05:€", "+0€30"] {
            assert!(Sequence::calendar("day", zone).is_err(), "{zone}");
        }
    }
}
