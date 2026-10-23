//! pond-rs financial studies against the pandas / TA-Lib oracle — the same
//! committed fixture `packages/financial/test/study-oracle.test.ts` uses.
//!
//! To bring a study under test, add a match arm to [`run`] that returns each
//! expected output column by name.

mod common;

use common::studies::call_study;
use common::{
    STUDY_TOLERANCE, StudyCase, StudyFixture, check_coverage, compare_column, load_study_fixture,
    report,
};
use pond_rs::{Column, TimeSeries};
use std::collections::BTreeMap;

/// Studies with an arm in [`run`]. Every oracle case for a listed study must
/// run and match; a study that runs without being listed is also an error.
/// The case's input: the oracle's bars (open, high, low, close, volume, and
/// the two-column studies' `bench`) or its long run of closes.
fn bars(fixture: &StudyFixture, case: &StudyCase) -> TimeSeries {
    let input = &fixture.input;
    let columns = match case.input.as_deref() {
        None => vec![
            Column::required("open", input.opens.clone()),
            Column::required("high", input.highs.clone()),
            Column::required("low", input.lows.clone()),
            Column::required("close", input.closes.clone()),
            Column::required("volume", input.volumes.clone()),
            Column::required("bench", input.benchmarks.clone()),
        ],
        Some("long") => vec![Column::required("close", input.long_closes.clone())],
        Some("session") => vec![
            Column::required("open", input.opens.clone()),
            Column::required("high", input.highs.clone()),
            Column::required("low", input.lows.clone()),
            Column::required("close", input.closes.clone()),
            Column::required("volume", input.volumes.clone()),
        ],
        Some(other) => panic!("{}: input '{other}' is not bars or closes", case.study),
    };
    let time = match case.input.as_deref() {
        // The generator's session clock: 30-minute bars on a New York
        // 09:30-16:00 grid, two bars in no session.
        Some("session") => input.session_times.iter().map(|&t| t as i64).collect(),
        None => (0..input.closes.len() as i64).collect(),
        _ => (0..input.long_closes.len() as i64).collect(),
    };
    TimeSeries::new("oracle", time, columns).expect("oracle bars are a valid series")
}

/// Run one case through pond-rs. `None` means the study is not implemented yet.
fn run(fixture: &StudyFixture, case: &StudyCase) -> Option<BTreeMap<String, Vec<Option<f64>>>> {
    pond_rs::financial::catalog::study_descriptor(&case.study)?;
    // The session studies read the calendar the generator laid its clock
    // out on, rebuilt from the same rules (as study-oracle.test.ts does).
    let mut params = case.params.clone();
    if case.input.as_deref() == Some("session") {
        params.insert(
            "sessions".into(),
            serde_json::json!({
                "rules": {
                    "timeZone": "America/New_York",
                    "open": "09:30",
                    "close": "16:00",
                    "holidays": ["2024-01-15"],
                },
                "from": "2024-01-08",
                "to": "2024-01-16",
            }),
        );
    }
    let out = call_study(&bars(fixture, case), &case.study, &params)
        .unwrap_or_else(|e| panic!("{}: {e}", case.study));
    Some(
        case.expected
            .keys()
            .filter_map(|name| {
                let column = out.column(name).ok()?.numbers().ok()?;
                Some((name.clone(), column.iter().collect()))
            })
            .collect(),
    )
}

#[test]
fn fixture_loads() {
    let fixture = load_study_fixture();
    assert!(!fixture.cases.is_empty(), "study oracle has no cases");
    let bars = fixture.input.closes.len();
    for series in [
        &fixture.input.opens,
        &fixture.input.highs,
        &fixture.input.lows,
        &fixture.input.volumes,
        &fixture.input.benchmarks,
        &fixture.input.session_times,
    ] {
        assert_eq!(series.len(), bars, "OHLCV inputs must be the same length");
    }
    for case in &fixture.cases {
        let len = match case.input.as_deref() {
            None | Some("session") => bars,
            Some("long") => fixture.input.long_closes.len(),
            Some(other) => panic!("{}: unknown input '{other}'", case.study),
        };
        for (column, values) in &case.expected {
            assert_eq!(values.len(), len, "{}.{column}: wrong length", case.study);
        }
    }
}

#[test]
fn implemented_studies_match_oracle() {
    let fixture = load_study_fixture();
    let mut implemented = 0;
    let mut failures = Vec::new();
    let names: Vec<&str> = pond_rs::financial::catalog::STUDIES
        .iter()
        .map(|d| d.name)
        .collect();
    for case in &fixture.cases {
        let label = format!(
            "{}({})",
            case.study,
            serde_json::Value::Object(case.params.clone())
        );
        let actual = run(&fixture, case);
        check_coverage(&label, &case.study, &names, actual.is_some(), &mut failures);
        let Some(actual) = actual else {
            continue;
        };
        implemented += 1;
        for (column, expected) in &case.expected {
            match actual.get(column) {
                None => failures.push(format!("{label}: missing output column '{column}'")),
                Some(values) => {
                    if let Err(why) = compare_column(expected, values, STUDY_TOLERANCE) {
                        failures.push(format!("{label}.{column}: {why}"));
                    }
                }
            }
        }
    }
    report("study oracle", implemented, fixture.cases.len(), &failures);
}

#[test]
fn comparator_catches_mismatches() {
    let fixture = load_study_fixture();
    let expected = fixture.cases[0].expected.values().next().unwrap();
    assert!(compare_column(expected, expected, STUDY_TOLERANCE).is_ok());

    let first = expected.iter().position(Option::is_some).unwrap();
    let mut wrong = expected.clone();
    wrong[first] = wrong[first].map(|v| v + 1e-9);
    assert!(compare_column(expected, &wrong, STUDY_TOLERANCE).is_err());

    let mut wrong = expected.clone();
    wrong[first] = None;
    assert!(compare_column(expected, &wrong, STUDY_TOLERANCE).is_err());

    let mut wrong = expected.clone();
    wrong.pop();
    assert!(compare_column(expected, &wrong, STUDY_TOLERANCE).is_err());
}
