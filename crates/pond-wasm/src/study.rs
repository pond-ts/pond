//! Financial studies through pond-rs's catalog (`study(name, options)`,
//! pond-ts's option shapes as JSON), and trading calendars for the session
//! studies. Plain Rust, like [`crate::dispatch`], so it runs (and is
//! tested) natively too.
//!
//! A calendar lives in a table here, addressed by number as series are; a
//! study's `sessions` option names one as `{"calendar": id}`.

use std::cell::RefCell;
use std::sync::Arc;

use pond_rs::financial::catalog::{STUDIES, StudyDescriptor, study_descriptor};
use pond_rs::financial::{
    DateBound, Session, SessionAnchor, SessionRef, SessionRules, Stamped, TagSessions,
    TradingCalendar, generate_sessions,
};
use pond_rs::{PartitionedSeries, TimeSeries};
use serde_json::{Map, Number, Value, json};

use crate::dispatch::{Args, Res, decode_f64, pond};

thread_local! {
    /// Every live calendar, by id. A freed slot is `None` and reused.
    static CALENDARS: RefCell<Vec<Option<Arc<TradingCalendar>>>> =
        const { RefCell::new(Vec::new()) };
}

/// Keep a calendar; its id.
pub fn calendar_store(c: TradingCalendar) -> u32 {
    CALENDARS.with(|t| {
        let mut t = t.borrow_mut();
        let c = Some(Arc::new(c));
        match t.iter().position(Option::is_none) {
            Some(i) => {
                t[i] = c;
                i as u32
            }
            None => {
                t.push(c);
                (t.len() - 1) as u32
            }
        }
    })
}

/// Drop a calendar. Safe to call twice.
pub fn calendar_free(id: u32) {
    CALENDARS.with(|t| {
        if let Some(slot) = t.borrow_mut().get_mut(id as usize) {
            *slot = None;
        }
    });
}

/// How many calendars are alive (for leak checks).
pub fn calendars_alive() -> u32 {
    CALENDARS.with(|t| t.borrow().iter().filter(|c| c.is_some()).count() as u32)
}

/// The calendar `id`.
pub fn calendar(id: u32) -> Res<Arc<TradingCalendar>> {
    CALENDARS.with(|t| match t.borrow().get(id as usize) {
        Some(Some(c)) => Ok(c.clone()),
        _ => Err(format!("calendar {id} was freed or never existed")),
    })
}

// ---- studies ---------------------------------------------------------------

/// The catalog as pond-ts's descriptors (JSON, without `run`).
pub fn studies() -> Value {
    Value::Array(STUDIES.iter().map(StudyDescriptor::to_json).collect())
}

/// One study's descriptor, or `null` when there is no such study.
pub fn study_info(name: &str) -> Value {
    study_descriptor(name).map_or(Value::Null, StudyDescriptor::to_json)
}

/// Every study's name (the JS package adds one method per name).
pub fn study_names() -> impl Iterator<Item = &'static str> {
    STUDIES.iter().map(|d| d.name)
}

/// A study call, ready to run on a series or on each partition.
pub struct StudyCall {
    d: &'static StudyDescriptor,
    options: Map<String, Value>,
    calendar: Option<Arc<TradingCalendar>>,
}

/// `{"f64": "-0"}` back to the number -0 (JSON numbers carry it); NaN and
/// the infinities stay tagged, so a number option refuses them.
fn untag(v: &mut Value) {
    match v {
        Value::Object(o) if o.len() == 1 && o.contains_key("f64") => {
            if let Some(n) = decode_f64(v).and_then(Number::from_f64) {
                *v = Value::Number(n);
            }
        }
        Value::Object(o) => o.values_mut().for_each(untag),
        Value::Array(a) => a.iter_mut().for_each(untag),
        _ => {}
    }
}

/// `study(name, options)`: options are pond-ts's (options a study does not
/// have are ignored, as in pond-ts); `sessions` may be `{"calendar": id}`.
pub(crate) fn study_call(a: &Args) -> Res<StudyCall> {
    let name = a.str(0, "a study name")?;
    let d = study_descriptor(name)
        .ok_or_else(|| format!("study: '{name}' is not a study; studies() lists them"))?;
    let mut options = match a.options(1)? {
        Value::Object(o) => o.clone(),
        _ => Map::new(),
    };
    let mut calendar = None;
    if let Some(id) = options.get("sessions").and_then(|s| s.get("calendar")) {
        let id = id
            .as_u64()
            .ok_or_else(|| format!("{name}: 'sessions' names no calendar"))?;
        calendar = Some(self::calendar(id as u32)?);
        options.remove("sessions");
    }
    options.values_mut().for_each(untag);
    Ok(StudyCall {
        d,
        options,
        calendar,
    })
}

impl StudyCall {
    fn run(&self, s: &TimeSeries) -> pond_rs::Result<TimeSeries> {
        match &self.calendar {
            Some(c) => self.d.run_with(s, &self.options, SessionAnchor::from(&**c)),
            None => self.d.run(s, &self.options),
        }
    }
}

/// What a study runs on: a series, or each partition of one.
pub trait StudyTarget: Sized {
    fn run_study(&self, call: &StudyCall) -> Res<Self>;
}

impl StudyTarget for TimeSeries {
    fn run_study(&self, call: &StudyCall) -> Res<Self> {
        pond(call.run(self))
    }
}

impl StudyTarget for PartitionedSeries {
    fn run_study(&self, call: &StudyCall) -> Res<Self> {
        pond(self.map(|s| call.run(s)))
    }
}

// ---- calendars ---------------------------------------------------------------

/// A session as pond-ts writes one (`breaks` always present).
fn session_json(s: &Session) -> Value {
    let breaks: Vec<Value> = s
        .breaks
        .iter()
        .map(|b| json!({ "start": b.start, "end": b.end }))
        .collect();
    json!({ "date": s.date, "open": s.open, "close": s.close, "breaks": breaks })
}

fn sessions_json(list: &[Session]) -> Value {
    Value::Array(list.iter().map(session_json).collect())
}

fn maybe_session(s: Option<&Session>) -> Value {
    s.map_or(Value::Null, session_json)
}

/// A whole number of milliseconds.
fn ms(v: &Value, what: &str) -> Res<i64> {
    v.as_i64()
        .or_else(|| {
            decode_f64(v)
                .filter(|x| x.fract() == 0.0 && x.abs() <= 8.64e15)
                .map(|x| x as i64)
        })
        .ok_or_else(|| format!("{what} must be whole epoch milliseconds, got {v}"))
}

fn text<'a>(v: &'a Value, what: &str) -> Res<&'a str> {
    v.as_str()
        .ok_or_else(|| format!("{what} must be text, got {v}"))
}

fn list<'a>(v: &'a Value, what: &str) -> Res<&'a [Value]> {
    match v {
        Value::Null => Ok(&[]),
        Value::Array(a) => Ok(a),
        _ => Err(format!("{what} must be a list, got {v}")),
    }
}

/// Sessions written as pond-ts `Session` objects (times in epoch ms).
pub fn parse_sessions(v: &Value) -> Res<Vec<Session>> {
    list(v, "sessions")?
        .iter()
        .map(|s| {
            if !s.is_object() {
                return Err(format!(
                    "a session is {{ date, open, close, breaks? }}, got {s}"
                ));
            }
            let mut session = Session::new(
                text(&s["date"], "session date")?,
                ms(&s["open"], "session open")?,
                ms(&s["close"], "session close")?,
            );
            for b in list(&s["breaks"], "session breaks")? {
                session = session
                    .with_break(ms(&b["start"], "break start")?, ms(&b["end"], "break end")?);
            }
            Ok(session)
        })
        .collect()
}

/// pond-ts `SessionRules`: `{ timeZone, open, close, weekmask?, breaks?,
/// holidays?, earlyCloses? }`.
fn session_rules(v: &Value) -> Res<SessionRules> {
    let mut r = SessionRules::new(
        text(&v["timeZone"], "rules.timeZone")?,
        text(&v["open"], "rules.open")?,
        text(&v["close"], "rules.close")?,
    );
    if !v["weekmask"].is_null() {
        let days = list(&v["weekmask"], "rules.weekmask")?
            .iter()
            .map(|d| {
                d.as_u64()
                    .and_then(|d| u8::try_from(d).ok())
                    .ok_or_else(|| format!("rules.weekmask: expected weekday numbers, got {d}"))
            })
            .collect::<Res<Vec<u8>>>()?;
        r = r.weekmask(&days);
    }
    for b in list(&v["breaks"], "rules.breaks")? {
        r = r.with_break(
            text(&b["start"], "break start")?,
            text(&b["end"], "break end")?,
        );
    }
    for h in list(&v["holidays"], "rules.holidays")? {
        r = r.holiday(text(h, "holiday")?);
    }
    for e in list(&v["earlyCloses"], "rules.earlyCloses")? {
        r = r.early_close(
            text(&e["date"], "early close date")?,
            text(&e["close"], "early close")?,
        );
    }
    Ok(r)
}

/// One end of a `{ from, to }` range: a date as text, or epoch ms.
fn date_bound(v: &Value, what: &str) -> Res<DateBound> {
    match v {
        Value::String(s) => Ok(DateBound::Date(s.clone())),
        _ => ms(v, what).map(DateBound::At),
    }
}

fn rules_and_range(rules: &Value, range: &Value) -> Res<(SessionRules, DateBound, DateBound)> {
    Ok((
        session_rules(rules)?,
        date_bound(&range["from"], "range.from")?,
        date_bound(&range["to"], "range.to")?,
    ))
}

/// pond-ts `TradingCalendar.fromRules(rules, { from, to })`.
pub fn from_rules(rules: &Value, range: &Value) -> Res<TradingCalendar> {
    let (r, from, to) = rules_and_range(rules, range)?;
    pond(TradingCalendar::from_rules(&r, from, to))
}

/// pond-ts `generateSessions(rules, { from, to })`: the sessions, unchecked.
pub fn generate(rules: &Value, range: &Value) -> Res<Value> {
    let (r, from, to) = rules_and_range(rules, range)?;
    Ok(sessions_json(&pond(generate_sessions(&r, from, to))?))
}

/// pond-ts `TradingCalendar.fromSessions(sessions, { timeZone })`.
pub fn from_sessions(sessions: &Value, time_zone: Option<&str>) -> Res<TradingCalendar> {
    let c = pond(TradingCalendar::from_sessions(parse_sessions(sessions)?))?;
    Ok(match time_zone {
        Some(z) => c.with_time_zone(z),
        None => c,
    })
}

/// `YYYY-MM-DD`, exactly.
fn is_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            _ => c.is_ascii_digit(),
        })
}

/// A date to look a session up by. pond-ts compares any text with session
/// dates as text, so `""` or `"Jan 12"` would quietly find nothing (or the
/// wrong neighbour): only `YYYY-MM-DD` is taken, as in the Python bridge.
fn lookup_date<'a>(op: &str, v: &'a Value) -> Res<&'a str> {
    match v.as_str() {
        Some(d) if is_iso_date(d) => Ok(d),
        _ => Err(format!("{op}: expected a date as YYYY-MM-DD, got {v}")),
    }
}

/// A calendar lookup, pond-ts's name and argument; the answer as JSON
/// (sessions as objects, `null` for none).
pub fn calendar_query(c: &TradingCalendar, op: &str, arg: &Value) -> Res<Value> {
    let instant = || ms(arg, &format!("{op}: the time"));
    let step = |next: bool| -> Res<Value> {
        let r = match arg {
            Value::String(_) => SessionRef::Date(lookup_date(op, arg)?),
            _ => SessionRef::At(instant()?),
        };
        Ok(maybe_session(if next {
            c.next_session(r)
        } else {
            c.previous_session(r)
        }))
    };
    Ok(match op {
        "sessions" => sessions_json(c.sessions()),
        "length" => json!(c.len()),
        "timeZone" => c.time_zone().map_or(Value::Null, |z| json!(z)),
        "sessionOn" => maybe_session(c.session_on(lookup_date(op, arg)?)),
        "isTradingDay" => json!(c.is_trading_day(lookup_date(op, arg)?)),
        "sessionContaining" => maybe_session(c.session_containing(instant()?)),
        "isOpen" => json!(c.is_open(instant()?)),
        "sessionsInRange" => sessions_json(c.sessions_in_range(
            ms(&arg["start"], "sessionsInRange: range.start")?,
            ms(&arg["end"], "sessionsInRange: range.end")?,
        )),
        "nextSession" => step(true)?,
        "previousSession" => step(false)?,
        _ => return Err(format!("TradingCalendar has no '{op}'")),
    })
}

/// pond-ts `calendar.tagSessions(series, { column, stamped })`.
pub fn tag_sessions(c: &TradingCalendar, series: &TimeSeries, options: &Value) -> Res<TimeSeries> {
    let mut o = TagSessions::default();
    match &options["column"] {
        Value::Null => {}
        v => o = o.column(text(v, "tagSessions: column")?),
    }
    o = o.stamped(match &options["stamped"] {
        Value::Null => Stamped::Open,
        Value::String(s) if s == "open" => Stamped::Open,
        Value::String(s) if s == "close" => Stamped::Close,
        v => {
            return Err(format!(
                "tagSessions: stamped must be 'open' or 'close', got {v}"
            ));
        }
    });
    pond(c.tag_sessions(series, o))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bars() -> TimeSeries {
        let close: Vec<f64> = (0..30).map(|i| 100.0 + (i % 7) as f64).collect();
        TimeSeries::new(
            "bars",
            (0..30).collect(),
            vec![pond_rs::Column::required("close", close)],
        )
        .unwrap()
    }

    #[test]
    fn a_study_runs_by_name_with_pond_ts_options() {
        let list = [json!("rsi"), json!({ "period": 5, "peroid": 9 })];
        let a = Args {
            op: "study",
            list: &list,
        };
        let out = bars().run_study(&study_call(&a).unwrap()).unwrap();
        assert!(out.column("rsi").is_ok());
        let list = [json!("nope")];
        let a = Args {
            op: "study",
            list: &list,
        };
        assert!(study_call(&a).is_err());
    }

    #[test]
    fn calendar_lookups_take_only_iso_dates() {
        let c = from_sessions(
            &json!([{ "date": "2024-01-08", "open": 100, "close": 200 }]),
            None,
        )
        .unwrap();
        assert_eq!(
            calendar_query(&c, "isTradingDay", &json!("2024-01-08")).unwrap(),
            json!(true)
        );
        assert!(calendar_query(&c, "sessionOn", &json!("")).is_err());
        assert!(calendar_query(&c, "nextSession", &json!("Jan 8")).is_err());
        assert_eq!(
            calendar_query(&c, "nextSession", &json!(50)).unwrap()["date"],
            json!("2024-01-08")
        );
    }
}
