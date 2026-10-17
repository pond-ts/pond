//! pond-rs financial studies against the pandas / TA-Lib oracle — the same
//! committed fixture `packages/financial/test/study-oracle.test.ts` uses.
//!
//! To bring a study under test, add a match arm to [`run`] that returns each
//! expected output column by name.

mod common;

use common::{
    STUDY_TOLERANCE, StudyCase, StudyFixture, compare_column, load_study_fixture, report,
};
use std::collections::BTreeMap;

/// Run one case through pond-rs. `None` means the study is not implemented yet.
fn run(_fixture: &StudyFixture, case: &StudyCase) -> Option<BTreeMap<String, Vec<Option<f64>>>> {
    #[allow(clippy::match_single_binding)]
    match case.study.as_str() {
        // R2 adds arms here, e.g. "sma" => Some(...)
        _ => None,
    }
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
    for case in &fixture.cases {
        let Some(actual) = run(&fixture, case) else {
            continue;
        };
        implemented += 1;
        let label = format!(
            "{}({})",
            case.study,
            serde_json::Value::Object(case.params.clone())
        );
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
