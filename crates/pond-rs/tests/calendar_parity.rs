//! pond-rs trading calendar against `@pond-ts/financial`: the committed
//! fixture `packages/financial/test/fixtures/calendar-parity.json` (written
//! by `packages/financial/scripts/parity/generate.mjs`, kept fresh by
//! `calendar-parity.test.ts`). Sessions, lookups and session tags must be
//! the same; errors must happen on the same calls.

mod common;

use common::repo_path;
use pond_rs::financial::{
    DateBound, Session, SessionRules, Stamped, TagSessions, TradingCalendar, generate_sessions,
    normalize_sessions,
};
use pond_rs::{Column, TimeSeries};
use serde_json::Value;

const FIXTURE: &str = "packages/financial/test/fixtures/calendar-parity.json";

/// Error messages pond-ts does not write itself (Temporal's, core
/// `withColumn`'s); pond-rs words these its own way.
const FOREIGN_MESSAGES: &[&str] = &[
    "Unrecognized time zone",
    "invalid RFC 9557 string",
    "value out of range",
    "withColumnAppended",
];

fn load() -> Vec<Value> {
    let text = std::fs::read_to_string(repo_path(FIXTURE)).expect("calendar parity fixture");
    let fixture: Value = serde_json::from_str(&text).expect("calendar parity fixture parses");
    fixture["cases"].as_array().expect("cases").clone()
}

fn text(v: &Value) -> &str {
    v.as_str().expect("a string")
}

fn sessions(v: &Value) -> Vec<Session> {
    v.as_array()
        .expect("a session list")
        .iter()
        .map(|s| {
            let mut session = Session::new(
                text(&s["date"]),
                s["open"].as_i64().unwrap(),
                s["close"].as_i64().unwrap(),
            );
            for b in s["breaks"].as_array().into_iter().flatten() {
                session =
                    session.with_break(b["start"].as_i64().unwrap(), b["end"].as_i64().unwrap());
            }
            session
        })
        .collect()
}

fn rules(v: &Value) -> SessionRules {
    let mut rules = SessionRules::new(text(&v["timeZone"]), text(&v["open"]), text(&v["close"]));
    if let Some(days) = v["weekmask"].as_array() {
        let days: Vec<u8> = days.iter().map(|d| d.as_u64().unwrap() as u8).collect();
        rules = rules.weekmask(&days);
    }
    for b in v["breaks"].as_array().into_iter().flatten() {
        rules = rules.with_break(text(&b["start"]), text(&b["end"]));
    }
    for h in v["holidays"].as_array().into_iter().flatten() {
        rules = rules.holiday(text(h));
    }
    for e in v["earlyCloses"].as_array().into_iter().flatten() {
        rules = rules.early_close(text(&e["date"]), text(&e["close"]));
    }
    rules
}

fn bound(v: &Value) -> DateBound {
    match v {
        Value::String(s) => DateBound::Date(s.clone()),
        other => DateBound::At(other.as_i64().expect("an integer instant")),
    }
}

/// Compare a result with the case's `expected` / `error`.
fn outcome<T: PartialEq + std::fmt::Debug>(
    case: &Value,
    got: pond_rs::Result<T>,
    expected: impl FnOnce(&Value) -> T,
) -> Result<(), String> {
    match (case.get("expected"), got) {
        (Some(want), Ok(got)) => {
            let want = expected(want);
            if got == want {
                Ok(())
            } else {
                Err(format!("got {got:?}\nwant {want:?}"))
            }
        }
        (Some(_), Err(e)) => Err(format!("pond-rs errored: {e}")),
        (None, Ok(got)) => Err(format!(
            "pond-ts throws ({}), pond-rs gave {got:?}",
            case["error"]["message"]
        )),
        (None, Err(e)) => {
            let want = case["error"]["message"].as_str().unwrap_or_default();
            // Messages are pond-ts's word for word, except those Temporal
            // or pond-ts core write (zone and date parsing, a column clash).
            let foreign = FOREIGN_MESSAGES.iter().any(|p| want.starts_with(p));
            if foreign || e.to_string().contains(want) {
                Ok(())
            } else {
                Err(format!(
                    "message differs\n  pond-ts: {want}\n  pond-rs: {e}"
                ))
            }
        }
    }
}

fn generate_case(case: &Value) -> Result<(), String> {
    let r = rules(&case["rules"]);
    let (from, to) = (bound(&case["from"]), bound(&case["to"]));
    outcome(
        case,
        generate_sessions(&r, from.clone(), to.clone()),
        sessions,
    )?;
    // fromRules: accepted, or the same sessions refused.
    let calendar = TradingCalendar::from_rules(&r, from, to);
    match (&case["calendar"], calendar) {
        (Value::Bool(true), Ok(cal)) => {
            if cal.time_zone() != Some(r.time_zone()) {
                return Err("from_rules lost the zone".into());
            }
            Ok(())
        }
        // generateSessions throws (checked above), or fromRules refuses.
        (Value::Null, Err(_)) => Ok(()),
        (Value::Object(want), Err(e)) => {
            let want = want["message"].as_str().unwrap_or_default();
            if e.to_string().contains(want) {
                Ok(())
            } else {
                Err(format!(
                    "from_rules message differs\n  pond-ts: {want}\n  pond-rs: {e}"
                ))
            }
        }
        (Value::Object(e), Ok(_)) => Err(format!(
            "fromRules throws ({}), from_rules succeeds",
            e["message"]
        )),
        (want, got) => Err(format!("from_rules: got {got:?}, want {want}")),
    }
}

fn queries_case(case: &Value) -> Result<(), String> {
    let cal = if case.get("rules").is_some() {
        TradingCalendar::from_rules(
            &rules(&case["rules"]),
            bound(&case["from"]),
            bound(&case["to"]),
        )
    } else {
        TradingCalendar::from_sessions(sessions(&case["sessions"]))
    }
    .map_err(|e| e.to_string())?;
    if cal.sessions() != sessions(&case["sessions"]) {
        return Err("calendar sessions differ".into());
    }
    let date = |s: Option<&Session>| s.map_or(Value::Null, |s| Value::from(s.date.as_str()));
    for q in case["queries"].as_array().unwrap() {
        let arg = &q["arg"];
        let got = match (text(&q["call"]), arg) {
            ("length", _) => Value::from(cal.len()),
            ("sessionOn", Value::String(d)) => date(cal.session_on(d)),
            ("isTradingDay", Value::String(d)) => Value::from(cal.is_trading_day(d)),
            ("nextSession", Value::String(d)) => date(cal.next_session(d.as_str())),
            ("previousSession", Value::String(d)) => date(cal.previous_session(d.as_str())),
            ("nextSession", t) => date(cal.next_session(t.as_i64().unwrap())),
            ("previousSession", t) => date(cal.previous_session(t.as_i64().unwrap())),
            ("sessionContaining", t) => date(cal.session_containing(t.as_i64().unwrap())),
            ("isOpen", t) => Value::from(cal.is_open(t.as_i64().unwrap())),
            ("sessionsInRange", r) => Value::from(
                cal.sessions_in_range(r["start"].as_i64().unwrap(), r["end"].as_i64().unwrap())
                    .iter()
                    .map(|s| s.date.clone())
                    .collect::<Vec<_>>(),
            ),
            (call, _) => panic!("unknown query {call}"),
        };
        if got != q["result"] {
            return Err(format!(
                "{}({arg}): got {got}, want {}",
                q["call"], q["result"]
            ));
        }
    }
    Ok(())
}

fn tag_case(case: &Value) -> Result<(), String> {
    let cal =
        TradingCalendar::from_sessions(sessions(&case["sessions"])).map_err(|e| e.to_string())?;
    let keys: Vec<i64> = case["keys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| k.as_i64().unwrap())
        .collect();
    let close: Vec<f64> = (0..keys.len()).map(|i| i as f64).collect();
    let series = TimeSeries::new("bars", keys, vec![Column::required("close", close)]).unwrap();
    let options = &case["options"];
    let mut tag = TagSessions::default();
    if let Some(column) = options["column"].as_str() {
        tag = tag.column(column);
    }
    match options["stamped"].as_str() {
        Some("close") => tag = tag.stamped(Stamped::Close),
        Some("open") => tag = tag.stamped(Stamped::Open),
        Some(other) => panic!("stamped {other}"),
        None => {}
    }
    let got = cal.tag_sessions(&series, tag).map(|tagged| {
        let column = tagged.columns().last().unwrap();
        assert!(!column.is_required(), "session ids are optional");
        column.numbers().unwrap().iter().collect::<Vec<_>>()
    });
    outcome(case, got, |want| {
        want.as_array().unwrap().iter().map(Value::as_f64).collect()
    })
}

#[test]
fn calendar_matches_pond_ts() {
    let cases = load();
    let mut failures = Vec::new();
    let mut counts = std::collections::BTreeMap::<&str, (usize, usize)>::new();
    for case in &cases {
        let kind = text(&case["kind"]);
        let result = match kind {
            "generate" => generate_case(case),
            "sessions" => outcome(
                case,
                normalize_sessions(sessions(&case["sessions"])),
                sessions,
            ),
            "queries" => queries_case(case),
            "tag" => tag_case(case),
            other => panic!("unknown case kind {other}"),
        };
        let entry = counts.entry(kind).or_default();
        if case.get("error").is_some() {
            entry.1 += 1;
        } else {
            entry.0 += 1;
        }
        if let Err(why) = result {
            failures.push(format!("{} {}: {why}", case["id"], case["name"]));
        }
    }
    println!("calendar parity (results, errors): {counts:?}");
    assert!(
        failures.is_empty(),
        "{} of {} cases failed:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}
