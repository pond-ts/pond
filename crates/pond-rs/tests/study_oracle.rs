//! pond-rs financial studies against the pandas / TA-Lib oracle — the same
//! committed fixture `packages/financial/test/study-oracle.test.ts` uses.
//!
//! To bring a study under test, add a match arm to [`run`] that returns each
//! expected output column by name.

mod common;

use common::studies::{STUDIES, call_study};
use common::{
    STUDY_TOLERANCE, StudyCase, StudyFixture, check_coverage, compare_column, load_study_fixture,
    report,
};
use pond_rs::{Column, TimeSeries};
use std::collections::BTreeMap;

/// Studies with an arm in [`run`]. Every oracle case for a listed study must
/// run and match; a study that runs without being listed is also an error.
fn closes(fixture: &StudyFixture, case: &StudyCase) -> TimeSeries {
    let closes = match case.input.as_deref() {
        None => &fixture.input.closes,
        Some("long") => &fixture.input.long_closes,
        Some(other) => panic!("{}: input '{other}' is not close-only", case.study),
    };
    let time = (0..closes.len() as i64).collect();
    TimeSeries::new(
        "oracle",
        time,
        vec![Column::required("close", closes.clone())],
    )
    .expect("oracle closes are a valid series")
}

/// Run one case through pond-rs. `None` means the study is not implemented yet.
fn run(fixture: &StudyFixture, case: &StudyCase) -> Option<BTreeMap<String, Vec<Option<f64>>>> {
    if !STUDIES.contains(&case.study.as_str()) {
        return None;
    }
    let out = call_study(&closes(fixture, case), &case.study, &case.params)
        .expect("oracle calls are expressible")
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
    for case in &fixture.cases {
        let label = format!(
            "{}({})",
            case.study,
            serde_json::Value::Object(case.params.clone())
        );
        let actual = run(&fixture, case);
        check_coverage(
            &label,
            &case.study,
            STUDIES,
            actual.is_some(),
            &mut failures,
        );
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
