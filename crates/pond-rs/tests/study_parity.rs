//! pond-rs financial studies against `@pond-ts/financial`, bit for bit: the
//! committed fixture `packages/financial/test/fixtures/study-parity.json`
//! (written by `packages/financial/scripts/parity/generate.mjs`, kept fresh
//! by `study-parity.test.ts`). The pandas / TA-Lib check is
//! `study_oracle.rs`.

mod common;

use common::studies::{STUDIES, call_study};
use common::{cell_number, compare_number, repo_path};
use pond_rs::{Column, ColumnData, TimeSeries};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

const FIXTURE: &str = "packages/financial/test/fixtures/study-parity.json";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InputJson {
    name: String,
    schema: Vec<common::ColumnDef>,
    rows: Vec<Vec<Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct OutputColumn {
    name: String,
    kind: String,
    required: bool,
    values: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    id: String,
    study: String,
    input: String,
    options: Map<String, Value>,
    expected: Option<Vec<OutputColumn>>,
    error: Option<common::ErrorJson>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture {
    #[allow(dead_code)]
    meta: Value,
    inputs: BTreeMap<String, InputJson>,
    cases: Vec<Case>,
}

fn load() -> Fixture {
    let text = std::fs::read_to_string(repo_path(FIXTURE)).expect("study parity fixture");
    serde_json::from_str(&text).expect("study parity fixture parses")
}

fn to_series(json: &InputJson) -> TimeSeries {
    assert_eq!(
        json.schema[0].kind, "time",
        "{}: inputs are time-keyed",
        json.name
    );
    let columns = json.schema[1..]
        .iter()
        .enumerate()
        .map(|(c, def)| {
            let cells = json.rows.iter().map(|row| &row[c + 1]);
            let data: ColumnData = match def.kind.as_str() {
                "number" => cells.map(cell_number).collect::<Vec<_>>().into(),
                "string" => cells
                    .map(|v| v.as_str().map(str::to_string))
                    .collect::<Vec<_>>()
                    .into(),
                "boolean" => cells.map(Value::as_bool).collect::<Vec<_>>().into(),
                other => panic!("{}.{}: unknown column kind {other}", json.name, def.name),
            };
            if def.required.unwrap_or(true) {
                Column::required(&def.name, data)
            } else {
                Column::optional(&def.name, data)
            }
        })
        .collect();
    let time = json
        .rows
        .iter()
        .map(|row| row[0].as_i64().unwrap())
        .collect();
    TimeSeries::new(&json.name, time, columns).expect("fixture input is a valid series")
}

/// Known difference: pond-ts reads a missing or non-number source column
/// as all gaps (except where core `rolling` throws); pond-rs refuses it, as
/// it refuses smoothing a text column.
fn refused(series: &TimeSeries, case: &Case) -> bool {
    common::studies::sources(&case.study, &case.options)
        .iter()
        .any(|source| {
            !matches!(
                series.column(source).map(|c| c.kind()),
                Ok(pond_rs::ColumnKind::Number)
            )
        })
}

fn check(case: &Case, input: &TimeSeries, got: &TimeSeries) -> Result<(), String> {
    let expected = case.expected.as_ref().unwrap();
    let added = &got.columns()[input.columns().len()..];
    if added.len() != expected.len() {
        return Err(format!(
            "added {} columns, pond-ts {}",
            added.len(),
            expected.len()
        ));
    }
    if got.columns()[..input.columns().len()] != *input.columns() || got.len() != input.len() {
        return Err("changed the input's columns or rows".into());
    }
    for (column, want) in added.iter().zip(expected) {
        if column.name() != want.name
            || column.kind().as_str() != want.kind
            || column.is_required() != want.required
        {
            return Err(format!(
                "column {} {} required={}, pond-ts {} {} required={}",
                column.name(),
                column.kind().as_str(),
                column.is_required(),
                want.name,
                want.kind,
                want.required
            ));
        }
        let values = column.numbers().map_err(|e| e.to_string())?;
        for (i, cell) in want.values.iter().enumerate() {
            let actual = values.get(i).unwrap_or(f64::NAN);
            let result = match cell_number(cell) {
                None => match values.get(i) {
                    None => Ok(()),
                    Some(v) => Err(format!("expected a gap, got {v:?}")),
                },
                Some(e) => compare_number(e, actual, None),
            };
            result.map_err(|why| format!("{}[{i}]: {why}", column.name()))?;
        }
    }
    Ok(())
}

#[test]
fn studies_match_pond_ts() {
    let fixture = load();
    let inputs: BTreeMap<&str, TimeSeries> = fixture
        .inputs
        .iter()
        .map(|(name, json)| (name.as_str(), to_series(json)))
        .collect();
    let mut failures = Vec::new();
    let (mut matched, mut errors, mut refusals, mut unexpressible) = (0, 0, 0, 0);
    for case in &fixture.cases {
        let label = format!("{} {}", case.id, Value::Object(case.options.clone()));
        let input = &inputs[case.input.as_str()];
        let Some(got) = call_study(input, &case.study, &case.options) else {
            unexpressible += 1;
            if case.error.is_none() {
                failures.push(format!(
                    "{label}: pond-ts accepts a call Rust cannot express"
                ));
            }
            continue;
        };
        match (&case.expected, &got) {
            (Some(_), Ok(_)) if refused(input, case) => {
                failures.push(format!("{label}: pond-rs should refuse this source column"));
            }
            (Some(_), Err(_)) if refused(input, case) => refusals += 1,
            (Some(_), Ok(series)) => match check(case, input, series) {
                Ok(()) => matched += 1,
                Err(why) => failures.push(format!("{label}: {why}")),
            },
            (Some(_), Err(e)) => failures.push(format!("{label}: pond-rs errored: {e}")),
            (None, Err(_)) => errors += 1,
            (None, Ok(_)) => failures.push(format!(
                "{label}: pond-ts throws ({}), pond-rs succeeds",
                case.error.as_ref().map_or("?", |e| e.message.as_str())
            )),
        }
    }
    println!(
        "study parity: {matched} matched, {errors} errors agree, {refusals} refused (known), {unexpressible} calls Rust cannot express"
    );
    assert!(
        failures.is_empty(),
        "{} of {} cases failed:\n{}",
        failures.len(),
        fixture.cases.len(),
        failures.join("\n")
    );
}

#[test]
fn every_study_is_known() {
    let fixture = load();
    for case in &fixture.cases {
        assert!(
            STUDIES.contains(&case.study.as_str()),
            "{}: study '{}' has no arm in call_study()",
            case.id,
            case.study
        );
    }
}
