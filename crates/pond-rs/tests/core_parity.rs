//! pond-rs against pond-ts's own output for core operations.
//!
//! To bring an operation under test, add a match arm to [`run`] that builds
//! the input series, calls the pond-rs operation, and returns the result in
//! `toJSON()` form (or `Err` with the pond-rs error text). Every fixture case
//! for that op is then checked.

mod common;

use common::{
    ColumnDef, CoreCase, CoreFixture, SeriesJson, cell_number, check_case, check_coverage,
    compare_series, load_core_fixture, report,
};
use pond_rs::{
    Agg, ArrowKey, At, Column, ColumnData, ColumnKind, Fill, FillLimits, FillValue, FirstRow,
    IntervalKeys, Key, Labels, Reducer, Sequence, TimeRangeKeys, TimeSeries,
};
use serde_json::{Value, json};

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
    "select",
    "rename",
    "asTime",
];

/// Ops with an arm in [`run`]. Every fixture case for a listed op must run
/// and match; an op that runs without being listed is also an error.
const IMPLEMENTED_OPS: &[&str] = &[
    "rolling",
    "aggregate",
    "select",
    "rename",
    "asTime",
    "diff",
    "rate",
    "pctChange",
    "cumulative",
    "shift",
    "fill",
];

/// Run one case through pond-rs. `None` means the op is not implemented yet.
fn run(fixture: &CoreFixture, case: &CoreCase) -> Option<Result<SeriesJson, String>> {
    let input = to_series(&fixture.inputs[&case.input]);
    let result = match case.op.as_str() {
        "rolling" => {
            let window = case.args[0].as_str().expect("rolling window is a string");
            mapping(&case.args[1]).and_then(|aggs| input.rolling(window, &aggs))
        }
        "aggregate" => sequence(&case.args[0]["sequence"])
            .and_then(|seq| mapping(&case.args[1]).and_then(|aggs| input.aggregate(&seq, &aggs))),
        "select" => {
            let names: Vec<&str> = case
                .args
                .iter()
                .map(|a| a.as_str().expect("select takes column names"))
                .collect();
            input.select(&names)
        }
        "rename" => {
            let renames: Vec<(&str, &str)> = case.args[0]
                .as_object()
                .expect("rename takes a mapping")
                .iter()
                .map(|(from, to)| (from.as_str(), to.as_str().expect("new name")))
                .collect();
            input.rename(&renames)
        }
        "asTime" => {
            let at = match case.args.first().and_then(|o| o["at"].as_str()) {
                None | Some("begin") => At::Begin,
                Some("center") => At::Center,
                Some("end") => At::End,
                Some(other) => panic!("unknown asTime anchor {other}"),
            };
            input.as_time(at)
        }
        "diff" | "rate" | "pctChange" => {
            let names = column_names(&case.args[0]);
            let first = match case.args.get(1).and_then(|o| o["drop"].as_bool()) {
                Some(true) => FirstRow::Drop,
                _ => FirstRow::Keep,
            };
            match case.op.as_str() {
                "diff" => input.diff(&names, first),
                "rate" => input.rate(&names, first),
                _ => input.pct_change(&names, first),
            }
        }
        "cumulative" => {
            let spec: Vec<(&str, Reducer)> = case.args[0]
                .as_object()
                .expect("cumulative takes a mapping")
                .iter()
                .map(|(c, r)| {
                    (
                        c.as_str(),
                        Reducer::parse(r.as_str().expect("reducer")).unwrap(),
                    )
                })
                .collect();
            input.cumulative(&spec)
        }
        "shift" => {
            let n = case.args[1].as_f64().expect("shift offset");
            // A fractional offset cannot be written in Rust (`n` is an i64);
            // pond-ts rejects it, so stand in that error here.
            if n.fract() != 0.0 {
                return Some(Err("shift offset must be a whole number".into()));
            }
            input.shift(&column_names(&case.args[0]), n as i64)
        }
        "fill" => {
            let options = case.args.get(1);
            let mut limits = FillLimits::none();
            if let Some(limit) = options.and_then(|o| o["limit"].as_u64()) {
                limits = limits.limit(limit as usize);
            }
            if let Some(max_gap) = options.and_then(|o| o["maxGap"].as_str()) {
                limits = limits.max_gap(max_gap);
            }
            let strategy = |v: &Value| match v.as_str() {
                Some("hold") => Fill::Hold,
                Some("bfill") => Fill::Bfill,
                Some("linear") => Fill::Linear,
                Some("zero") => Fill::Zero,
                Some(text) => Fill::Value(FillValue::String(text.into())),
                None => match v {
                    Value::Bool(b) => Fill::Value(FillValue::Boolean(*b)),
                    _ => Fill::Value(FillValue::Number(v.as_f64().expect("a literal"))),
                },
            };
            match &case.args[0] {
                Value::String(_) => input.fill_all(strategy(&case.args[0]), &limits),
                Value::Object(map) => {
                    let spec: Vec<(&str, Fill)> =
                        map.iter().map(|(c, v)| (c.as_str(), strategy(v))).collect();
                    input.fill(&spec, &limits)
                }
                other => panic!("fill takes a strategy or a mapping, got {other}"),
            }
        }
        _ => return None,
    };
    Some(result.map(|s| to_json(&s)).map_err(|e| e.to_string()))
}

/// `{every}` or `{calendar, timeZone, weekStartsOn?}`.
/// One column name or a list of them.
fn column_names(json: &Value) -> Vec<&str> {
    match json {
        Value::String(name) => vec![name.as_str()],
        Value::Array(names) => names
            .iter()
            .map(|n| n.as_str().expect("column name"))
            .collect(),
        other => panic!("expected column names, got {other}"),
    }
}

fn sequence(json: &Value) -> pond_rs::Result<Sequence> {
    if let Some(every) = json["every"].as_str() {
        return Sequence::every(every);
    }
    let unit = json["calendar"]
        .as_str()
        .expect("sequence is every or calendar");
    let zone = json["timeZone"].as_str().expect("calendar timeZone");
    let seq = Sequence::calendar(unit, zone)?;
    match json["weekStartsOn"].as_i64() {
        Some(day) => seq.with_week_start(day as i8),
        None => Ok(seq),
    }
}

/// A fixture input series as a pond-rs `TimeSeries`.
fn to_series(json: &SeriesJson) -> TimeSeries {
    let key_kind = json.schema[0].kind.as_str();
    assert!(
        ["time", "timeRange", "interval"].contains(&key_kind),
        "{}: inputs are time-, timeRange- or interval-keyed",
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
    let ms = |v: &Value| v.as_i64().expect("key times are integers");
    if key_kind == "time" {
        let time = json.rows.iter().map(|row| ms(&row[0])).collect();
        TimeSeries::new(&json.name, time, columns).expect("fixture input is a valid series")
    } else if key_kind == "timeRange" {
        let part = |p: usize| json.rows.iter().map(|row| ms(&row[0][p])).collect();
        let keys = TimeRangeKeys {
            begin: part(0),
            end: part(1),
        };
        TimeSeries::from_time_ranges(&json.name, keys, columns)
            .expect("fixture input is a valid series")
    } else {
        let part = |p: usize| json.rows.iter().map(|row| ms(&row[0][p])).collect();
        let labels: Vec<&Value> = json.rows.iter().map(|row| &row[0][0]).collect();
        let label: Labels = if labels.iter().all(|l| l.is_string()) {
            labels
                .iter()
                .map(|l| l.as_str().unwrap())
                .collect::<Vec<_>>()
                .into()
        } else {
            labels
                .iter()
                .map(|l| l.as_f64().expect("interval labels are numbers or text"))
                .collect::<Vec<_>>()
                .into()
        };
        let keys = IntervalKeys {
            label,
            begin: part(1),
            end: part(2),
        };
        TimeSeries::from_intervals(&json.name, keys, columns)
            .expect("fixture input is a valid series")
    }
}

/// pond-ts mapping object: `{ out: 'avg' }` (shorthand) or
/// `{ out: { from, using } }`, in key order.
fn mapping(json: &Value) -> pond_rs::Result<Vec<Agg>> {
    json.as_object()
        .expect("mapping is an object")
        .iter()
        .map(|(output, spec)| match spec {
            Value::String(reducer) => Ok(Agg::of(output, Reducer::parse(reducer)?)),
            _ => Ok(Agg::new(
                output,
                spec["from"].as_str().expect("spec.from"),
                Reducer::parse(spec["using"].as_str().expect("spec.using"))?,
            )),
        })
        .collect()
}

/// A pond-rs series in `TimeSeries.toJSON()` form, tagging what plain JSON
/// would lose.
fn to_json(series: &TimeSeries) -> SeriesJson {
    let schema = series
        .schema()
        .into_iter()
        .map(|def| ColumnDef {
            name: def.name,
            kind: def.kind.as_str().to_string(),
            required: match def.kind {
                ColumnKind::Time | ColumnKind::TimeRange | ColumnKind::Interval => None,
                _ => (!def.required).then_some(false),
            },
        })
        .collect();
    let rows = (0..series.len())
        .map(|i| {
            let key = match series.key() {
                Key::Time(t) => json!(t[i]),
                Key::TimeRange(k) => json!([k.begin[i], k.end[i]]),
                Key::Interval(k) => {
                    let label = match &k.label {
                        Labels::Number(v) => json!(v[i]),
                        Labels::String(c) => json!(c.get(i)),
                    };
                    json!([label, k.begin[i], k.end[i]])
                }
            };
            std::iter::once(key)
                .chain(series.columns().iter().map(|c| encode(c.data(), i)))
                .collect()
        })
        .collect();
    SeriesJson {
        name: series.name().to_string(),
        schema,
        rows,
    }
}

fn encode(data: &ColumnData, i: usize) -> Value {
    match data {
        ColumnData::Number(c) => match c.get(i) {
            None => Value::Null,
            Some(v) if v == 0.0 && v.is_sign_negative() => json!({ "f64": "-0" }),
            Some(v) => json!(v),
        },
        // pond-ts has no decimals, so no fixture holds one.
        ColumnData::Decimal(_) => panic!("pond-ts has no decimal columns"),
        ColumnData::String(c) => c.get(i).map_or(Value::Null, |v| json!(v)),
        ColumnData::Boolean(c) => c.get(i).map_or(Value::Null, |v| json!(v)),
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
    assert!(compare_series(expected, &wrong, Some(1e-12)).is_err());
    assert!(common::compare_number(-0.0, 0.0, Some(1.0)).is_err());
    assert!(common::compare_number(0.0, -0.0, Some(1.0)).is_err());
    assert!(common::compare_number(-0.0, -0.0, Some(1.0)).is_ok());
    assert!(common::compare_number(0.0, -1e-20, Some(1e-12)).is_ok());

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

/// Arrow IPC files built from pond-ts's own `toArrow` output (its buffers,
/// null bits and dictionaries) by apache-arrow in
/// `packages/core/scripts/parity/export.mjs`: pond-rs must read back the
/// input series exactly. `noisy` is every field Float64, the key included
/// (pond-ts's documented recipe); `mixed` adds Utf8, Dictionary<Int32, Utf8>
/// and Boolean fields (`toArrow`'s `utf8`, `dictionary` and `bool`). The
/// script, not pond-ts, picks the Arrow types and which fields are nullable.
#[test]
fn reads_the_pond_ts_arrow_exports() {
    let fixture = load_core_fixture();
    for (input, file, key) in [
        ("noisy", "parity-export.arrow", ArrowKey::from("time")),
        ("mixed", "parity-export-mixed.arrow", "time".into()),
        (
            "ranges",
            "parity-export-ranges.arrow",
            ArrowKey::TimeRange("timeRange".into()),
        ),
        (
            "labelled",
            "parity-export-labelled.arrow",
            ArrowKey::Interval("interval".into()),
        ),
    ] {
        let bytes = std::fs::read(common::repo_path(&format!(
            "packages/core/test/fixtures/{file}"
        )))
        .unwrap();
        let series = TimeSeries::from_ipc_bytes(input, bytes, key.clone()).unwrap();
        compare_series(&fixture.inputs[input], &to_json(&series), None)
            .unwrap_or_else(|why| panic!("{file}: {why}"));
        // pond-rs's own file reads back the same.
        let mut written = Vec::new();
        series.write_ipc(&mut written).unwrap();
        let again = TimeSeries::from_ipc_bytes(input, written, key).unwrap();
        compare_series(&fixture.inputs[input], &to_json(&again), None)
            .unwrap_or_else(|why| panic!("{file} rewritten by pond-rs: {why}"));
        if input == "mixed" {
            // pond-ts wrote `site` as a dictionary and `host` as plain text;
            // pond-rs keeps each as it came.
            assert!(
                series
                    .column("site")
                    .unwrap()
                    .strings()
                    .unwrap()
                    .is_dictionary()
            );
            assert!(
                !series
                    .column("host")
                    .unwrap()
                    .strings()
                    .unwrap()
                    .is_dictionary()
            );
        }
    }
}
