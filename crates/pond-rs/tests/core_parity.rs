//! pond-rs against pond-ts's own output for core operations.
//!
//! To bring an operation under test, add a match arm to [`run`] that builds
//! the input series, calls the pond-rs operation, and returns the result in
//! `toJSON()` form (or `Err` with the pond-rs error text). Every fixture case
//! for that op is then checked.

mod common;

use common::{
    CoreCase, CoreFixture, SeriesJson, check_case, check_coverage, compare_series,
    load_core_fixture, report,
};

/// Every op the fixture may contain. A new op in the fixture fails
/// `fixture_ops_are_known` until it is listed here, so additions are noticed.
const KNOWN_OPS: &[&str] = &[
    "rolling",
    "aggregate",
    "diff",
    "rate",
    "pctChange",
    "cumulative",
    "shift",
    "fill",
];

/// Ops with an arm in [`run`]. Every fixture case for a listed op must run
/// and match; an op that runs without being listed is also an error.
const IMPLEMENTED_OPS: &[&str] = &[];

/// Run one case through pond-rs. `None` means the op is not implemented yet.
fn run(_fixture: &CoreFixture, case: &CoreCase) -> Option<Result<SeriesJson, String>> {
    #[allow(clippy::match_single_binding)]
    match case.op.as_str() {
        // R1 adds arms here, e.g. "rolling" => Some(...)
        _ => None,
    }
}

#[test]
fn fixture_ops_are_known() {
    let fixture = load_core_fixture();
    assert!(!fixture.cases.is_empty(), "core fixture has no cases");
    for case in &fixture.cases {
        assert!(
            KNOWN_OPS.contains(&case.op.as_str()),
            "case '{}' uses op '{}', which is not in KNOWN_OPS",
            case.id,
            case.op
        );
        assert!(
            fixture.inputs.contains_key(&case.input),
            "case '{}' names unknown input '{}'",
            case.id,
            case.input
        );
    }
}

#[test]
fn implemented_ops_match_pond_ts() {
    let fixture = load_core_fixture();
    let mut implemented = 0;
    let mut failures = Vec::new();
    for case in &fixture.cases {
        let actual = run(&fixture, case);
        check_coverage(
            &case.id,
            &case.op,
            IMPLEMENTED_OPS,
            actual.is_some(),
            &mut failures,
        );
        let Some(actual) = actual else {
            continue;
        };
        implemented += 1;
        if let Err(why) = check_case(case, &actual) {
            failures.push(format!("{} ({}): {why}", case.id, case.op));
        }
    }
    report("core parity", implemented, fixture.cases.len(), &failures);
}

/// The comparator must accept a correct answer and reject wrong ones, or a
/// green harness means nothing. Exercised on the real fixture data.
#[test]
fn comparator_catches_mismatches() {
    let fixture = load_core_fixture();
    for case in &fixture.cases {
        let own: Result<SeriesJson, String> = match &case.expected {
            Some(expected) => Ok(expected.clone()),
            None => Err("pond-rs error".to_string()),
        };
        check_case(case, &own).unwrap_or_else(|why| panic!("{} rejects itself: {why}", case.id));
    }

    let case = find(&fixture, "rolling-3s-avg-sum");
    let expected = case.expected.as_ref().unwrap();

    // A one-ulp change to a value cell is caught when exact.
    let mut wrong = expected.clone();
    let cell = &mut wrong.rows[1][1];
    let v = cell.as_f64().unwrap();
    *cell = serde_json::json!(f64::from_bits(v.to_bits() + 1));
    assert!(compare_series(expected, &wrong, None).is_err());
    // …and accepted within a tolerance.
    assert!(compare_series(expected, &wrong, Some(1e-12)).is_ok());

    // Missing vs present is caught.
    let mut wrong = expected.clone();
    wrong.rows[1][1] = serde_json::Value::Null;
    assert!(compare_series(expected, &wrong, Some(1.0)).is_err());

    // A key written as 1000.0 instead of 1000 is the same key.
    let mut same = expected.clone();
    same.rows[1][0] = serde_json::json!(1000.0);
    assert!(compare_series(expected, &same, None).is_ok());

    // A schema difference, including `required`, is caught.
    let mut wrong = expected.clone();
    wrong.schema[1].required = Some(true);
    assert!(compare_series(expected, &wrong, None).is_err());

    // A shifted key is caught.
    let mut wrong = expected.clone();
    wrong.rows[0][0] = serde_json::json!(1);
    assert!(compare_series(expected, &wrong, None).is_err());

    // A dropped row is caught.
    let mut wrong = expected.clone();
    wrong.rows.pop();
    assert!(compare_series(expected, &wrong, None).is_err());

    // Signed zero is exact, even under a tolerance: -0 is not 0.
    let case = find(&fixture, "pctChange-signed");
    let expected = case.expected.as_ref().unwrap();
    assert_eq!(expected.rows[1][1], serde_json::json!({ "f64": "-0" }));
    let mut wrong = expected.clone();
    wrong.rows[1][1] = serde_json::json!(0);
    assert!(compare_series(expected, &wrong, None).is_err());

    // An infinity never matches a finite value, tolerance or not.
    let mut wrong = expected.clone();
    wrong.rows[2][1] = serde_json::json!({ "f64": "-inf" });
    assert!(compare_series(expected, &wrong, Some(1e300)).is_err());

    // Success where pond-ts throws is caught, and the reverse.
    let error_case = find(&fixture, "error-unknown-column");
    assert!(check_case(error_case, &Ok(expected.clone())).is_err());
    assert!(check_case(case, &Err("boom".to_string())).is_err());
}

fn find<'a>(fixture: &'a CoreFixture, id: &str) -> &'a CoreCase {
    fixture
        .cases
        .iter()
        .find(|c| c.id == id)
        .unwrap_or_else(|| panic!("fixture case '{id}' missing"))
}
