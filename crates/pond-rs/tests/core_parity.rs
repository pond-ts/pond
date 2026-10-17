//! pond-rs against pond-ts's own output for core operations.
//!
//! To bring an operation under test, add a match arm to [`run`] that builds
//! the input series, calls the pond-rs operation, and returns the result in
//! `toJSON()` form. Every fixture case for that op is then checked.

mod common;

use common::{CoreCase, CoreFixture, SeriesJson, compare_series, load_core_fixture, report};

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

/// Run one case through pond-rs. `None` means the op is not implemented yet.
fn run(_fixture: &CoreFixture, case: &CoreCase) -> Option<SeriesJson> {
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
        let Some(actual) = run(&fixture, case) else {
            continue;
        };
        implemented += 1;
        if let Err(why) = compare_series(&case.expected, &actual, case.tolerance) {
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
        compare_series(&case.expected, &case.expected, case.tolerance)
            .unwrap_or_else(|why| panic!("{} rejects itself: {why}", case.id));
    }

    let case = fixture
        .cases
        .iter()
        .find(|c| c.id == "rolling-3s-avg-sum")
        .expect("reference case present");
    let mut wrong = case.expected.clone();

    // A one-ulp change to a value cell is caught when exact.
    let cell = &mut wrong.rows[1][1];
    let v = cell.as_f64().unwrap();
    *cell = serde_json::json!(f64::from_bits(v.to_bits() + 1));
    assert!(compare_series(&case.expected, &wrong, None).is_err());
    // …and accepted within a tolerance.
    assert!(compare_series(&case.expected, &wrong, Some(1e-12)).is_ok());

    // Missing vs present is caught.
    let mut wrong = case.expected.clone();
    wrong.rows[1][1] = serde_json::Value::Null;
    assert!(compare_series(&case.expected, &wrong, Some(1.0)).is_err());

    // A shifted key is caught.
    let mut wrong = case.expected.clone();
    wrong.rows[0][0] = serde_json::json!(1);
    assert!(compare_series(&case.expected, &wrong, None).is_err());

    // A dropped row is caught.
    let mut wrong = case.expected.clone();
    wrong.rows.pop();
    assert!(compare_series(&case.expected, &wrong, None).is_err());
}
