//! Trading calendars (pond-ts `@pond-ts/financial` `calendar/`): the
//! sessions an exchange trades, built from an explicit list or from rules
//! (hours in an IANA zone, a weekmask, holidays, early closes), and the
//! lookups the session studies and session tagging read.

use std::collections::{HashMap, HashSet};

use jiff::Timestamp;
use jiff::civil::Date;
use jiff::tz::TimeZone;

use crate::error::{PondError, Result};
use crate::series::{Column, TimeSeries};

/// A pause inside a session (a lunch break): `[start, end)`, epoch
/// milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionBreak {
    pub start: i64,
    pub end: i64,
}

/// One trading day: its date (`YYYY-MM-DD`, the session's name), its
/// `[open, close)` in epoch milliseconds (the open trades, the close does
/// not) and any breaks inside it.
///
/// ```
/// use pond_rs::financial::Session;
/// let day = Session::new("2024-01-08", 1_704_724_200_000, 1_704_747_600_000);
/// assert_eq!(day.close - day.open, 6 * 3_600_000 + 30 * 60_000);
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub date: String,
    pub open: i64,
    pub close: i64,
    /// Sorted, not overlapping, inside `[open, close]`.
    pub breaks: Vec<SessionBreak>,
}

impl Session {
    /// A session with no breaks.
    pub fn new(date: &str, open: i64, close: i64) -> Self {
        Self {
            date: date.to_string(),
            open,
            close,
            breaks: Vec::new(),
        }
    }

    /// The same session with a break `[start, end)` added after the others.
    pub fn with_break(mut self, start: i64, end: i64) -> Self {
        self.breaks.push(SessionBreak { start, end });
        self
    }
}

/// Checks a session list and sorts it by open (pond-ts
/// `normalizeSessions`): each date `YYYY-MM-DD`, `open < close`, breaks
/// inside the session, sorted and apart; no two sessions on one date, none
/// overlapping, dates in the same order as opens. Errors name the first
/// problem, as pond-ts does.
pub fn normalize_sessions(sessions: impl IntoIterator<Item = Session>) -> Result<Vec<Session>> {
    const CALL: &str = "normalize_sessions";
    let err = |message: String| PondError::InvalidData {
        call: CALL,
        message,
    };
    let mut sessions: Vec<Session> = sessions.into_iter().collect();
    for s in &sessions {
        if !is_iso_date(&s.date) {
            return Err(err(format!(
                "session date must be an ISO YYYY-MM-DD string; got {}",
                json_string(&s.date)
            )));
        }
        if s.close <= s.open {
            return Err(err(format!(
                "session {}: close ({}) must be > open ({})",
                s.date, s.close, s.open
            )));
        }
        let mut prev_end = s.open;
        for b in &s.breaks {
            if b.end <= b.start {
                return Err(err(format!(
                    "session {}: break end must be > start",
                    s.date
                )));
            }
            if b.start < prev_end || b.end > s.close {
                return Err(err(format!(
                    "session {}: breaks must be sorted, non-overlapping, and within [open, close]",
                    s.date
                )));
            }
            prev_end = b.end;
        }
    }
    // Stable, as JavaScript's sort.
    sessions.sort_by_key(|s| s.open);
    for pair in sessions.windows(2) {
        let (prev, cur) = (&pair[0], &pair[1]);
        if cur.date == prev.date {
            return Err(err(format!("duplicate session date: {}", cur.date)));
        }
        if cur.open < prev.close {
            return Err(err(format!(
                "sessions overlap: {} [{}, {}) and {} [{}, {})",
                prev.date, prev.open, prev.close, cur.date, cur.open, cur.close
            )));
        }
        if cur.date < prev.date {
            return Err(err(format!(
                "session date order disagrees with open times: {} opens before {}",
                prev.date, cur.date
            )));
        }
    }
    Ok(sessions)
}

/// `^\d{4}-\d{2}-\d{2}$` (ASCII digits, as JavaScript's `\d`).
fn is_iso_date(date: &str) -> bool {
    let b = date.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            _ => c.is_ascii_digit(),
        })
}

/// `JSON.stringify` of a string, for error messages.
fn json_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_default()
}

/// Rules that generate a session list (pond-ts `SessionRules`): open and
/// close in local wall time (`"HH:MM"`, the close may be `"24:00"`) in an
/// IANA zone, so a 09:30 open is 09:30 local all year, across clock
/// changes. Trading days are Monday to Friday unless
/// [`weekmask`](Self::weekmask) says otherwise.
///
/// Only same-day sessions: an overnight session (close on the next day)
/// goes in an explicit [`Session`] list instead, as in pond-ts.
///
/// ```
/// use pond_rs::financial::{SessionRules, TradingCalendar};
/// let nyse = SessionRules::new("America/New_York", "09:30", "16:00")
///     .holiday("2024-01-15")
///     .early_close("2024-01-12", "13:00");
/// let cal = TradingCalendar::from_rules(&nyse, "2024-01-08", "2024-01-16")?;
/// assert_eq!(cal.len(), 6); // the weekend and the holiday are not sessions
/// assert!(!cal.is_trading_day("2024-01-15"));
/// let friday = cal.session_on("2024-01-12").unwrap();
/// assert_eq!(friday.close - friday.open, 3 * 3_600_000 + 30 * 60_000);
/// # Ok::<(), pond_rs::PondError>(())
/// ```
#[derive(Debug, Clone, PartialEq)]
pub struct SessionRules {
    time_zone: String,
    open: String,
    close: String,
    weekmask: Option<Vec<u8>>,
    breaks: Vec<(String, String)>,
    holidays: Vec<String>,
    early_closes: Vec<(String, String)>,
}

impl SessionRules {
    /// Sessions from `open` to `close` (`"HH:MM"`) in `time_zone`, Monday
    /// to Friday.
    pub fn new(time_zone: &str, open: &str, close: &str) -> Self {
        Self {
            time_zone: time_zone.to_string(),
            open: open.to_string(),
            close: close.to_string(),
            weekmask: None,
            breaks: Vec::new(),
            holidays: Vec::new(),
            early_closes: Vec::new(),
        }
    }

    /// The trading days, as ISO weekday numbers: 1 = Monday … 7 = Sunday.
    pub fn weekmask(mut self, days: &[u8]) -> Self {
        self.weekmask = Some(days.to_vec());
        self
    }

    /// A break every session (e.g. a lunch), local `"HH:MM"` times inside
    /// `[open, close]`. A day that closes early drops a break that would
    /// end after its close.
    pub fn with_break(mut self, start: &str, end: &str) -> Self {
        self.breaks.push((start.to_string(), end.to_string()));
        self
    }

    /// A date (`YYYY-MM-DD`) with no session.
    pub fn holiday(mut self, date: &str) -> Self {
        self.holidays.push(date.to_string());
        self
    }

    /// Dates (`YYYY-MM-DD`) with no session.
    pub fn holidays<I, D>(mut self, dates: I) -> Self
    where
        I: IntoIterator<Item = D>,
        D: AsRef<str>,
    {
        self.holidays
            .extend(dates.into_iter().map(|d| d.as_ref().to_string()));
        self
    }

    /// A half-day: on `date` the session closes at `close` (`"HH:MM"`)
    /// instead. A later entry for the same date replaces an earlier one.
    pub fn early_close(mut self, date: &str, close: &str) -> Self {
        self.early_closes
            .push((date.to_string(), close.to_string()));
        self
    }

    /// The zone the hours are read in.
    pub fn time_zone(&self) -> &str {
        &self.time_zone
    }
}

/// One end of the date range rules generate over: a date, or an instant
/// (epoch milliseconds), read as its local date in the rules' zone.
/// `"2024-01-08"` and `1_704_724_200_000_i64` both convert into one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DateBound {
    /// A date as Temporal's `PlainDate.from` reads it (`2024-01-08`; a
    /// time after it is allowed and ignored).
    Date(String),
    /// An instant, epoch milliseconds.
    At(i64),
}

impl From<&str> for DateBound {
    fn from(date: &str) -> Self {
        DateBound::Date(date.to_string())
    }
}

impl From<String> for DateBound {
    fn from(date: String) -> Self {
        DateBound::Date(date)
    }
}

impl From<i64> for DateBound {
    fn from(at: i64) -> Self {
        DateBound::At(at)
    }
}

/// The sessions `rules` describe from `from` to `to`, both dates included
/// (pond-ts `generateSessions`). Days off the weekmask and holidays have no
/// session; an early close shortens its day. Open, close and breaks are
/// resolved to instants day by day, so they follow the zone's clock
/// changes: a time the clock skips moves forward by the skip, a time it
/// repeats takes the earlier instant (Temporal's `compatible`).
pub fn generate_sessions(
    rules: &SessionRules,
    from: impl Into<DateBound>,
    to: impl Into<DateBound>,
) -> Result<Vec<Session>> {
    generate(rules, &from.into(), &to.into())
}

const GENERATE: &str = "generate_sessions";

fn generate_error(message: impl Into<String>) -> PondError {
    PondError::InvalidData {
        call: GENERATE,
        message: message.into(),
    }
}

fn generate(rules: &SessionRules, from: &DateBound, to: &DateBound) -> Result<Vec<Session>> {
    // The zone is looked up the first time it is needed, as pond-ts: a
    // range of two dates with no trading day never reads it.
    let mut cached: Option<TimeZone> = None;
    let mut zone = || -> Result<TimeZone> {
        if let Some(z) = &cached {
            return Ok(z.clone());
        }
        let z = time_zone(GENERATE, &rules.time_zone)?;
        cached = Some(z.clone());
        Ok(z)
    };
    let weekmask: &[u8] = rules.weekmask.as_deref().unwrap_or(&[1, 2, 3, 4, 5]);
    let holidays: HashSet<&str> = rules.holidays.iter().map(String::as_str).collect();
    // A later entry for a date replaces an earlier one, as pond-ts's Map.
    let early_closes: HashMap<&str, &String> = rules
        .early_closes
        .iter()
        .map(|(d, c)| (d.as_str(), c))
        .collect();

    let open_min = parse_minutes(&rules.open)?;
    let regular_close_min = parse_minutes(&rules.close)?;
    if regular_close_min <= open_min {
        return Err(generate_error(format!(
            "SessionRules close ({}) must be after open ({}); overnight sessions are not supported by rules — use an explicit session list.",
            rules.close, rules.open
        )));
    }
    let mut break_mins = Vec::with_capacity(rules.breaks.len());
    for (start, end) in &rules.breaks {
        break_mins.push((parse_minutes(start)?, parse_minutes(end)?));
    }
    break_mins.sort_by_key(|b| b.0);
    let mut prev_end = open_min;
    for &(start, end) in &break_mins {
        if end <= start {
            return Err(generate_error("break end must be after start"));
        }
        if start < prev_end || end > regular_close_min {
            return Err(generate_error(
                "breaks must be within [open, close], sorted, and non-overlapping",
            ));
        }
        prev_end = end;
    }

    let start = plain_date(from, &mut zone)?;
    let end = plain_date(to, &mut zone)?;
    if end < start {
        return Err(generate_error("range.to must be on or after range.from"));
    }

    let mut sessions = Vec::new();
    let mut date = start;
    loop {
        let weekday = date.weekday().to_monday_one_offset();
        if weekmask.iter().any(|&d| i16::from(d) == i16::from(weekday)) {
            let iso = date.to_string();
            if !holidays.contains(iso.as_str()) {
                let early = early_closes.get(iso.as_str()).copied();
                let close_min = match early {
                    Some(close) => parse_minutes(close)?,
                    None => regular_close_min,
                };
                if close_min <= open_min {
                    return Err(generate_error(format!(
                        "early close {} on {iso} is not after open {}",
                        early.map_or("", String::as_str),
                        rules.open
                    )));
                }
                let tz = zone()?;
                let open = instant_at(date, open_min, &tz)?;
                let close = instant_at(date, close_min, &tz)?;
                let mut breaks = Vec::new();
                for &(start, end) in break_mins.iter().filter(|b| b.1 <= close_min) {
                    breaks.push(SessionBreak {
                        start: instant_at(date, start, &tz)?,
                        end: instant_at(date, end, &tz)?,
                    });
                }
                sessions.push(Session {
                    date: iso,
                    open,
                    close,
                    breaks,
                });
            }
        }
        if date >= end {
            break;
        }
        date = date
            .tomorrow()
            .map_err(|e| generate_error(format!("date out of range: {e}")))?;
    }
    Ok(sessions)
}

/// `"HH:MM"` (or `"24:00"`) as minutes after midnight, `0..=1440`.
fn parse_minutes(time: &str) -> Result<u32> {
    let b = time.as_bytes();
    let well_formed =
        b.len() == 5 && b[2] == b':' && [0, 1, 3, 4].iter().all(|&i| b[i].is_ascii_digit());
    if !well_formed {
        return Err(generate_error(format!(
            "time must be \"HH:MM\"; got {}",
            json_string(time)
        )));
    }
    let digit = |i: usize| u32::from(b[i] - b'0');
    let (hours, minutes) = (digit(0) * 10 + digit(1), digit(3) * 10 + digit(4));
    if minutes > 59 {
        return Err(generate_error(format!(
            "minutes out of range in {}",
            json_string(time)
        )));
    }
    let total = hours * 60 + minutes;
    if total > 1440 {
        return Err(generate_error(format!(
            "time past 24:00 in {}",
            json_string(time)
        )));
    }
    Ok(total)
}

/// The instant of a local wall-clock minute on `date`; 1440 is the start of
/// the next day.
fn instant_at(date: Date, minutes: u32, zone: &TimeZone) -> Result<i64> {
    let bad = |e: jiff::Error| generate_error(format!("cannot place {date} in the time zone: {e}"));
    let zoned = if minutes == 1440 {
        date.tomorrow()
            .and_then(|d| d.to_zoned(zone.clone()))
            .and_then(|z| z.start_of_day())
            .map_err(bad)?
    } else {
        // Both below 60 and 24: minutes < 1440.
        let (h, m) = ((minutes / 60) as i8, (minutes % 60) as i8);
        date.at(h, m, 0, 0).to_zoned(zone.clone()).map_err(bad)?
    };
    Ok(zoned.timestamp().as_millisecond())
}

fn plain_date(bound: &DateBound, zone: &mut impl FnMut() -> Result<TimeZone>) -> Result<Date> {
    match bound {
        DateBound::Date(text) => {
            // Temporal reads a date in another calendar (`[u-ca=gregory]`)
            // and pond-ts then writes session dates with the annotation
            // still on; jiff would drop it. Refuse it instead.
            if let Some(at) = text.find("u-ca=") {
                let value = text[at + 5..].split(']').next().unwrap_or_default();
                if !value.eq_ignore_ascii_case("iso8601") {
                    return Err(generate_error(format!(
                        "cannot read {} as a date: only the ISO calendar is supported",
                        json_string(text)
                    )));
                }
            }
            text.parse::<Date>().map_err(|e| {
                generate_error(format!("cannot read {} as a date: {e}", json_string(text)))
            })
        }
        DateBound::At(ms) => {
            let at = Timestamp::from_millisecond(*ms)
                .map_err(|e| generate_error(format!("instant {ms} out of range: {e}")))?;
            Ok(at.to_zoned(zone()?).date())
        }
    }
}

/// An IANA zone name, or a fixed offset (`+05:30`), as Temporal reads it.
fn time_zone(call: &'static str, name: &str) -> Result<TimeZone> {
    match crate::sequence::fixed_offset(name) {
        Some(zone) => Ok(zone),
        None => TimeZone::get(name).map_err(|e| PondError::InvalidData {
            call,
            message: format!("unknown time zone '{name}': {e}"),
        }),
    }
}

/// Which side of a session's edges a bar's time falls on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Stamped {
    /// A session owns `[open, close)`: a bar at the open is in it, one at
    /// the close is not (bars stamped with their start).
    #[default]
    Open,
    /// A session owns `(open, close]`: a bar at the close is in it, one at
    /// the open belongs to the session before, if that closed there (bars
    /// stamped with their end).
    Close,
}

/// A day to step from in [`TradingCalendar::next_session`] /
/// [`previous_session`](TradingCalendar::previous_session): an instant
/// (epoch milliseconds, compared with session opens) or a date
/// (`YYYY-MM-DD`, compared with session dates).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionRef<'a> {
    At(i64),
    Date(&'a str),
}

impl From<i64> for SessionRef<'_> {
    fn from(at: i64) -> Self {
        SessionRef::At(at)
    }
}

impl<'a> From<&'a str> for SessionRef<'a> {
    fn from(date: &'a str) -> Self {
        SessionRef::Date(date)
    }
}

/// Options for [`TradingCalendar::tag_sessions`]: the column to write
/// (default `session`) and the bar-stamp convention (default
/// [`Stamped::Open`]).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TagSessions {
    column: Option<String>,
    stamped: Stamped,
}

impl TagSessions {
    /// Write the session ids to this column instead of `session`.
    pub fn column(mut self, name: &str) -> Self {
        self.column = Some(name.to_string());
        self
    }

    /// How a bar's time lands on a session's edges.
    pub fn stamped(mut self, stamped: Stamped) -> Self {
        self.stamped = stamped;
        self
    }
}

/// A trading calendar (pond-ts `TradingCalendar`): sessions in order, none
/// overlapping, and lookups over them. It covers exactly the sessions it was
/// built from; a lookup outside them finds nothing.
///
/// ```
/// use pond_rs::financial::{Session, TradingCalendar};
/// let cal = TradingCalendar::from_sessions([
///     Session::new("2024-01-09", 2_000, 3_000),
///     Session::new("2024-01-08", 0, 1_000).with_break(400, 500),
/// ])?;
/// assert_eq!(cal.sessions()[0].date, "2024-01-08"); // sorted by open
/// assert_eq!(cal.session_containing(450).unwrap().date, "2024-01-08");
/// assert!(!cal.is_open(450)); // inside the break
/// assert!(cal.session_containing(1_500).is_none()); // between sessions
/// assert_eq!(cal.next_session(1_500).unwrap().date, "2024-01-09");
/// assert_eq!(cal.previous_session("2024-01-09").unwrap().date, "2024-01-08");
/// # Ok::<(), pond_rs::PondError>(())
/// ```
#[derive(Debug, Clone, PartialEq)]
pub struct TradingCalendar {
    sessions: Vec<Session>,
    opens: Vec<i64>,
    time_zone: Option<String>,
}

impl TradingCalendar {
    /// A calendar from a session list, checked and sorted as
    /// [`normalize_sessions`] does (pond-ts `fromSessions`).
    pub fn from_sessions(sessions: impl IntoIterator<Item = Session>) -> Result<Self> {
        let sessions = normalize_sessions(sessions)
            .map_err(|e| e.renamed("TradingCalendar::from_sessions"))?;
        Ok(Self::build(sessions, None))
    }

    /// A calendar of the sessions `rules` generate from `from` to `to`
    /// (pond-ts `fromRules`). Keeps the rules' zone as
    /// [`time_zone`](Self::time_zone).
    pub fn from_rules(
        rules: &SessionRules,
        from: impl Into<DateBound>,
        to: impl Into<DateBound>,
    ) -> Result<Self> {
        const CALL: &str = "TradingCalendar::from_rules";
        let sessions = generate(rules, &from.into(), &to.into()).map_err(|e| e.renamed(CALL))?;
        let sessions = normalize_sessions(sessions).map_err(|e| e.renamed(CALL))?;
        Ok(Self::build(sessions, Some(rules.time_zone.clone())))
    }

    fn build(sessions: Vec<Session>, time_zone: Option<String>) -> Self {
        let opens = sessions.iter().map(|s| s.open).collect();
        Self {
            sessions,
            opens,
            time_zone,
        }
    }

    /// The same calendar, noting the exchange's zone (pond-ts
    /// `fromSessions(list, { timeZone })`). Nothing here reads it; it is for
    /// whoever displays the calendar's times.
    pub fn with_time_zone(mut self, time_zone: &str) -> Self {
        self.time_zone = Some(time_zone.to_string());
        self
    }

    /// The exchange's zone: the rules' zone, or the one given to
    /// [`with_time_zone`](Self::with_time_zone).
    pub fn time_zone(&self) -> Option<&str> {
        self.time_zone.as_deref()
    }

    /// Every session, in order.
    pub fn sessions(&self) -> &[Session] {
        &self.sessions
    }

    /// How many sessions.
    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    /// The session on `date` (`YYYY-MM-DD`), if it is a trading day.
    pub fn session_on(&self, date: &str) -> Option<&Session> {
        self.sessions
            .binary_search_by(|s| s.date.as_str().cmp(date))
            .ok()
            .map(|i| &self.sessions[i])
    }

    /// Whether `date` (`YYYY-MM-DD`) has a session.
    pub fn is_trading_day(&self, date: &str) -> bool {
        self.session_on(date).is_some()
    }

    /// The session whose `[open, close)` holds `at`, if any. A time inside
    /// a break is still inside its session; [`is_open`](Self::is_open)
    /// leaves breaks out.
    pub fn session_containing(&self, at: i64) -> Option<&Session> {
        let i = self.opens.partition_point(|&o| o <= at);
        let s = self.sessions.get(i.checked_sub(1)?)?;
        (at < s.close).then_some(s)
    }

    /// Whether the market trades at `at`: inside a session and not in one
    /// of its breaks.
    pub fn is_open(&self, at: i64) -> bool {
        self.session_containing(at)
            .is_some_and(|s| !s.breaks.iter().any(|b| at >= b.start && at < b.end))
    }

    /// The sessions overlapping `[start, end)`, in order. Empty when
    /// `end <= start`.
    pub fn sessions_in_range(&self, start: i64, end: i64) -> &[Session] {
        if end <= start {
            return &[];
        }
        // From the session that may hold `start` (it is left out if it
        // closed by then) to the last that opens before `end`.
        let first = self
            .opens
            .partition_point(|&o| o <= start)
            .saturating_sub(1);
        let first = if self.sessions.get(first).is_some_and(|s| s.close <= start) {
            first + 1
        } else {
            first
        };
        let last = self.opens.partition_point(|&o| o < end);
        &self.sessions[first.min(last)..last]
    }

    /// The first session after `from`: one opening after an instant (so a
    /// time inside a session gives the next one), or dated after a date.
    pub fn next_session<'a>(&self, from: impl Into<SessionRef<'a>>) -> Option<&Session> {
        let i = match from.into() {
            SessionRef::At(at) => self.opens.partition_point(|&o| o <= at),
            SessionRef::Date(date) => self.sessions.partition_point(|s| s.date.as_str() <= date),
        };
        self.sessions.get(i)
    }

    /// The last session before `from`: one opening before an instant (so a
    /// time inside a session gives that session), or dated before a date.
    pub fn previous_session<'a>(&self, from: impl Into<SessionRef<'a>>) -> Option<&Session> {
        let i = match from.into() {
            SessionRef::At(at) => self.opens.partition_point(|&o| o < at),
            SessionRef::Date(date) => self.sessions.partition_point(|s| s.date.as_str() < date),
        };
        self.sessions.get(i.checked_sub(1)?)
    }

    /// `series` with a session-id column added (pond-ts `tagSessions`): for
    /// each row, the open (epoch milliseconds) of the session its time (the
    /// key's start) falls in, or a gap in closed time. Use it as a
    /// `partition_by` key so rolling windows and fills stop at session
    /// edges, or hand it to a session study. Breaks do not split a session.
    ///
    /// ```
    /// use pond_rs::financial::{Session, Stamped, TagSessions, TradingCalendar};
    /// use pond_rs::{Column, TimeSeries};
    /// let cal = TradingCalendar::from_sessions([Session::new("2024-01-08", 100, 200)])?;
    /// let bars = TimeSeries::new("bars", vec![100, 150, 200],
    ///     vec![Column::required("close", vec![1.0, 2.0, 3.0])])?;
    /// let open = cal.tag_sessions(&bars, TagSessions::default())?;
    /// let ids: Vec<_> = open.column("session")?.numbers()?.iter().collect();
    /// assert_eq!(ids, [Some(100.0), Some(100.0), None]);
    /// let close = cal.tag_sessions(&bars, TagSessions::default().stamped(Stamped::Close))?;
    /// let ids: Vec<_> = close.column("session")?.numbers()?.iter().collect();
    /// assert_eq!(ids, [None, Some(100.0), Some(100.0)]);
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn tag_sessions(&self, series: &TimeSeries, options: TagSessions) -> Result<TimeSeries> {
        let column = options.column.as_deref().unwrap_or("session");
        let ids = session_id_values(series.key().begin(), &self.sessions, options.stamped);
        series
            .with_column(Column::optional(column, ids))
            .map_err(|e| e.renamed("TradingCalendar::tag_sessions"))
    }
}

/// pond-ts `sessionIdValues`: for each time (ascending), the open of the
/// session holding it, or `NaN` in closed time. One forward walk over the
/// times and the (sorted, non-overlapping) sessions.
pub(super) fn session_id_values(times: &[i64], sessions: &[Session], stamped: Stamped) -> Vec<f64> {
    let close_stamped = stamped == Stamped::Close;
    let mut c = 0;
    times
        .iter()
        .map(|&t| {
            while c < sessions.len()
                && (if close_stamped {
                    sessions[c].close < t
                } else {
                    sessions[c].close <= t
                })
            {
                c += 1;
            }
            match sessions.get(c) {
                Some(s)
                    if (if close_stamped {
                        t > s.open
                    } else {
                        t >= s.open
                    }) =>
                {
                    s.open as f64
                }
                _ => f64::NAN,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minutes_parse_as_pond_ts() {
        assert_eq!(parse_minutes("00:00").unwrap(), 0);
        assert_eq!(parse_minutes("24:00").unwrap(), 1440);
        assert_eq!(parse_minutes("09:30").unwrap(), 570);
        for (bad, why) in [
            ("9:30", "must be \"HH:MM\""),
            ("09:3", "must be \"HH:MM\""),
            ("09-30", "must be \"HH:MM\""),
            ("０9:30", "must be \"HH:MM\""),
            ("23:60", "minutes out of range"),
            ("99:99", "minutes out of range"),
            ("24:01", "past 24:00"),
            ("25:00", "past 24:00"),
        ] {
            let e = parse_minutes(bad).unwrap_err().to_string();
            assert!(e.contains(why), "{bad}: {e}");
        }
    }

    /// pond-ts checks the hours, the breaks, then the range, then each
    /// day's early close; the zone only when a day needs it.
    #[test]
    fn errors_come_in_pond_ts_order() {
        let base = || SessionRules::new("Nowhere/Zone", "09:30", "16:00");
        let msg = |r: &SessionRules, from: &str, to: &str| {
            generate_sessions(r, from, to).unwrap_err().to_string()
        };
        // A bad zone with no trading day in range is never read.
        assert_eq!(
            generate_sessions(&base(), "2024-01-06", "2024-01-07").unwrap(),
            vec![]
        );
        assert!(msg(&base(), "2024-01-08", "2024-01-08").contains("unknown time zone"));
        let late_open = SessionRules::new("Nowhere/Zone", "16:00", "16:00").with_break("x", "y");
        assert!(msg(&late_open, "x", "y").contains("must be after open"));
        let bad_break = base().with_break("12:00", "x");
        assert!(msg(&bad_break, "x", "y").contains("\"x\""));
        let backwards = base().with_break("12:00", "11:00");
        assert!(msg(&backwards, "x", "y").contains("break end must be after start"));
        assert!(msg(&base(), "x", "2024-01-08").contains("as a date"));
        assert!(msg(&base(), "2024-01-09", "2024-01-08").contains("range.to"));
        // An early close is read only on a trading day.
        let early = base()
            .holiday("2024-01-08")
            .early_close("2024-01-08", "bad");
        assert!(generate_sessions(&early, "2024-01-06", "2024-01-08").is_ok());
        let early = base().early_close("2024-01-08", "09:00");
        assert!(msg(&early, "2024-01-08", "2024-01-08").contains("early close 09:00"));
    }

    /// A time-range series is tagged by each row's start, as pond-ts reads
    /// `begin` for every key type.
    #[test]
    fn range_keys_tag_by_their_start() {
        use crate::TimeRangeKeys;
        let cal = TradingCalendar::from_sessions([Session::new("2024-01-08", 100, 200)]).unwrap();
        let bars = TimeSeries::from_time_ranges(
            "bars",
            TimeRangeKeys {
                begin: vec![50, 100, 199],
                end: vec![150, 250, 400],
            },
            vec![Column::required("close", vec![1.0, 2.0, 3.0])],
        )
        .unwrap();
        let tagged = cal.tag_sessions(&bars, TagSessions::default()).unwrap();
        let ids: Vec<_> = tagged
            .column("session")
            .unwrap()
            .numbers()
            .unwrap()
            .iter()
            .collect();
        assert_eq!(ids, [None, Some(100.0), Some(100.0)]);
    }

    /// Known differences in reading a range bound, pinned here because
    /// pond-ts's own result is not one to copy (see the plan's step 3a).
    #[test]
    fn date_bounds_outside_the_fixture() {
        let rules = SessionRules::new("America/New_York", "09:30", "16:00");
        let one = |from: &str| generate_sessions(&rules, from, "2024-01-08");
        // pond-ts writes "2024-01-08[u-ca=gregory]" as the session date.
        for other in ["2024-01-08[u-ca=gregory]", "2024-01-08[u-ca=japanese]"] {
            let e = one(other).unwrap_err().to_string();
            assert!(e.contains("only the ISO calendar"), "{e}");
        }
        assert_eq!(one("2024-01-08[u-ca=iso8601]").unwrap().len(), 1);
        assert_eq!(one("2024-01-08[u-ca=ISO8601]").unwrap().len(), 1);
    }
}
