//! Shared parity-harness code: fixture loading and comparison.
//!
//! Two fixtures, both committed in the pond-ts packages and read here as-is:
//!
//! - **Core parity** (`packages/core/test/fixtures/parity.json`): pond-ts's
//!   own output for a set of core operations, written by
//!   `packages/core/scripts/parity/generate.mjs`. Series are in
//!   `TimeSeries.toJSON()` form.
//! - **Study oracle** (`packages/financial/test/fixtures/study-oracle.json`):
//!   pandas / TA-Lib reference values for the financial studies, written by
//!   `packages/financial/scripts/oracle/generate.py`.
//!
//! A missing cell is JSON `null` in both, and `None` here. In the core
//! fixture, `-0`, `NaN` and `±Infinity` are tagged as
//! `{"f64": "-0" | "NaN" | "inf" | "-inf"}` because plain JSON loses them.

#![allow(dead_code)] // each test binary uses a different subset

use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;

/// Path to a file relative to the repository root.
pub fn repo_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(relative)
}

fn read_json<T: for<'de> Deserialize<'de>>(relative: &str) -> T {
    let path = repo_path(relative);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("cannot parse {}: {e}", path.display()))
}

// ---------------------------------------------------------------------------
// Core parity fixture
// ---------------------------------------------------------------------------

pub const CORE_FIXTURE: &str = "packages/core/test/fixtures/parity.json";

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ColumnDef {
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub required: Option<bool>,
}

/// A series in `TimeSeries.toJSON()` form. The first column is the key:
/// a number for `time`, an array for `timeRange` / `interval`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SeriesJson {
    pub name: String,
    pub schema: Vec<ColumnDef>,
    pub rows: Vec<Vec<Value>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoreCase {
    pub id: String,
    pub input: String,
    pub op: String,
    pub args: Vec<Value>,
    /// Absolute tolerance for finite value cells; `None` means exact.
    #[serde(default)]
    pub tolerance: Option<f64>,
    /// The result when pond-ts succeeds. Exactly one of `expected` / `error`.
    #[serde(default)]
    pub expected: Option<SeriesJson>,
    /// Set when pond-ts throws. Only "pond-rs also returns an error" is
    /// checked; the message is pond-ts's, kept for reference.
    #[serde(default)]
    pub error: Option<ErrorJson>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ErrorJson {
    pub name: String,
    pub message: String,
}

/// Check one case's outcome: success must match `expected`, and a pond-ts
/// error must be an error in pond-rs too.
pub fn check_case(case: &CoreCase, actual: &Result<SeriesJson, String>) -> Result<(), String> {
    match (&case.expected, &case.error, actual) {
        (Some(expected), None, Ok(actual)) => compare_series(expected, actual, case.tolerance),
        (Some(_), None, Err(why)) => Err(format!("pond-ts succeeds, pond-rs errored: {why}")),
        (None, Some(e), Ok(_)) => Err(format!(
            "pond-ts throws ({}: {}), pond-rs succeeded",
            e.name, e.message
        )),
        (None, Some(_), Err(_)) => Ok(()),
        _ => Err("fixture case must have exactly one of expected / error".to_string()),
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CoreFixture {
    pub meta: Value,
    pub inputs: BTreeMap<String, SeriesJson>,
    pub cases: Vec<CoreCase>,
}

pub fn load_core_fixture() -> CoreFixture {
    read_json(CORE_FIXTURE)
}

/// Compare two series cell by cell. Schema, row count and key cells must
/// match exactly; value cells must match within `tolerance` (exact when
/// `None`), and a missing cell only matches a missing cell.
pub fn compare_series(
    expected: &SeriesJson,
    actual: &SeriesJson,
    tolerance: Option<f64>,
) -> Result<(), String> {
    if expected.name != actual.name {
        return Err(format!(
            "series name differs: expected '{}', got '{}'",
            expected.name, actual.name
        ));
    }
    if expected.schema != actual.schema {
        return Err(format!(
            "schema differs: expected {:?}, got {:?}",
            expected.schema, actual.schema
        ));
    }
    if expected.rows.len() != actual.rows.len() {
        return Err(format!(
            "row count differs: expected {}, got {}",
            expected.rows.len(),
            actual.rows.len()
        ));
    }
    for (r, (exp_row, act_row)) in expected.rows.iter().zip(&actual.rows).enumerate() {
        if exp_row.len() != act_row.len() {
            return Err(format!("row {r}: width differs"));
        }
        if !same_key(&exp_row[0], &act_row[0]) {
            return Err(format!(
                "row {r}: key differs: expected {}, got {}",
                exp_row[0], act_row[0]
            ));
        }
        for (c, (exp, act)) in exp_row.iter().zip(act_row).enumerate().skip(1) {
            let column = &expected.schema[c].name;
            compare_cell(exp, act, tolerance)
                .map_err(|why| format!("row {r} column '{column}': {why}"))?;
        }
    }
    Ok(())
}

/// Keys compare by numeric value, so `1000` and `1000.0` are the same key.
/// A `time` key is a number; `timeRange` / `interval` keys are arrays.
fn same_key(expected: &Value, actual: &Value) -> bool {
    match (expected, actual) {
        (Value::Array(e), Value::Array(a)) => {
            e.len() == a.len() && e.iter().zip(a).all(|(e, a)| same_key(e, a))
        }
        _ => match (expected.as_f64(), actual.as_f64()) {
            (Some(e), Some(a)) => e == a,
            _ => expected == actual,
        },
    }
}

/// A cell as a number: a plain JSON number, or a tagged
/// `{"f64": "-0" | "NaN" | "inf" | "-inf"}`. `None` for anything else
/// (`null`, strings, …).
pub fn cell_number(cell: &Value) -> Option<f64> {
    if let Some(tag) = cell.get("f64").and_then(Value::as_str) {
        return match tag {
            "-0" => Some(-0.0),
            "NaN" => Some(f64::NAN),
            "inf" => Some(f64::INFINITY),
            "-inf" => Some(f64::NEG_INFINITY),
            other => panic!("unknown f64 tag '{other}'"),
        };
    }
    cell.as_f64()
}

fn compare_cell(expected: &Value, actual: &Value, tolerance: Option<f64>) -> Result<(), String> {
    match (cell_number(expected), cell_number(actual)) {
        (Some(e), Some(a)) => compare_number(e, a, tolerance),
        _ if expected == actual => Ok(()),
        _ => Err(format!("expected {expected}, got {actual}")),
    }
}

/// Exact means the same bits: `-0.0` and `0.0` differ, and any NaN matches
/// any NaN. A tolerance applies only when both values are finite and neither
/// is a zero of the other sign: signed zeros, signs of infinity and
/// NaN-ness must still match exactly.
pub fn compare_number(expected: f64, actual: f64, tolerance: Option<f64>) -> Result<(), String> {
    let same_bits =
        expected.to_bits() == actual.to_bits() || (expected.is_nan() && actual.is_nan());
    let zero_sign_differs = (expected == 0.0 || actual == 0.0)
        && expected.is_sign_negative() != actual.is_sign_negative();
    let ok = match tolerance {
        _ if zero_sign_differs => false,
        Some(tol) if expected.is_finite() && actual.is_finite() => (expected - actual).abs() <= tol,
        _ => same_bits,
    };
    if ok {
        Ok(())
    } else {
        Err(format!(
            "expected {expected:?}, got {actual:?} (diff {:e}, tolerance {})",
            (expected - actual).abs(),
            tolerance.map_or("exact".to_string(), |t| format!("{t:e}"))
        ))
    }
}

// ---------------------------------------------------------------------------
// Study oracle fixture
// ---------------------------------------------------------------------------

pub const STUDY_FIXTURE: &str = "packages/financial/test/fixtures/study-oracle.json";

/// Matches `toBeCloseTo(expected, 9)` in `study-oracle.test.ts`:
/// |difference| < 5e-10.
pub const STUDY_TOLERANCE: f64 = 5e-10;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StudyInputs {
    pub closes: Vec<f64>,
    pub long_closes: Vec<f64>,
    pub opens: Vec<f64>,
    pub highs: Vec<f64>,
    pub lows: Vec<f64>,
    pub volumes: Vec<f64>,
    pub benchmarks: Vec<f64>,
    pub session_times: Vec<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StudyCase {
    pub study: String,
    pub params: serde_json::Map<String, Value>,
    /// Absent: the 80-bar OHLCV input. `"long"`: the 900-bar close-only
    /// input. `"session"`: the same 80 bars on a trading-session clock.
    #[serde(default)]
    pub input: Option<String>,
    pub expected: BTreeMap<String, Vec<Option<f64>>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StudyFixture {
    pub meta: Value,
    pub input: StudyInputs,
    pub cases: Vec<StudyCase>,
}

pub fn load_study_fixture() -> StudyFixture {
    read_json(STUDY_FIXTURE)
}

/// Compare one output column bar by bar.
pub fn compare_column(
    expected: &[Option<f64>],
    actual: &[Option<f64>],
    tolerance: f64,
) -> Result<(), String> {
    if expected.len() != actual.len() {
        return Err(format!(
            "length differs: expected {}, got {}",
            expected.len(),
            actual.len()
        ));
    }
    for (i, (exp, act)) in expected.iter().zip(actual).enumerate() {
        match (exp, act) {
            (None, None) => {}
            (Some(e), Some(a)) if (e - a).abs() < tolerance => {}
            _ => return Err(format!("bar {i}: expected {exp:?}, got {act:?}")),
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/// Every case of an implemented op must actually run: an arm that returns
/// `None` for some arguments would otherwise skip those cases silently.
pub fn check_coverage(
    label: &str,
    op: &str,
    implemented: &[&str],
    ran: bool,
    failures: &mut Vec<String>,
) {
    let listed = implemented.contains(&op);
    if listed && !ran {
        failures.push(format!(
            "{label}: '{op}' is implemented but this case did not run"
        ));
    }
    if ran && !listed {
        failures.push(format!(
            "{label}: '{op}' ran but is not listed as implemented"
        ));
    }
}

/// Print a one-line coverage summary (visible with `cargo test -- --nocapture`)
/// and fail with every mismatch listed.
pub fn report(fixture: &str, implemented: usize, total: usize, failures: &[String]) {
    println!("{fixture}: {implemented}/{total} cases implemented");
    assert!(
        failures.is_empty(),
        "{} of {implemented} implemented cases disagree with {fixture}:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
