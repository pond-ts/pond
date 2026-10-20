//! pond-rs against pond-ts's own output for core operations.
//!
//! To bring an operation under test, add a match arm to [`run`] that builds
//! the input series, calls the pond-rs operation, and returns the result in
//! `toJSON()` form (or `Err` with the pond-rs error text). Every fixture case
//! for that op is then checked.

mod common;

use common::{
    ColumnDef, CoreCase, CoreFixture, Outcome, SeriesJson, cell_number, check_case, check_coverage,
    compare_series, load_core_fixture, report,
};
use pond_rs::Value as Literal;
use pond_rs::{
    Agg, Align, AlignMethod, ArrowKey, At, Column, ColumnData, ColumnKind, Fill, FillLimits,
    FirstRow, IntervalKeys, Join, JoinType, Keep, Key, Labels, Materialize, OnConflict, Pick,
    Reducer, Sequence, TimeRangeKeys, TimeSeries,
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
    "slice",
    "filter",
    "mapColumns",
    "withColumn",
    "partitionBy",
    "groupBy",
    "align",
    "materialize",
    "dedupe",
    "join",
    "joinMany",
    "tail",
    "reduce",
    "overlapping",
    "containedBy",
    "trim",
    "before",
    "after",
    "within",
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
    "slice",
    "filter",
    "mapColumns",
    "withColumn",
    "partitionBy",
    "groupBy",
    "align",
    "materialize",
    "dedupe",
    "join",
    "joinMany",
    "tail",
    "reduce",
    "overlapping",
    "containedBy",
    "trim",
    "before",
    "after",
    "within",
];

/// The ops a plain series and a partitioned one both have, with the same
/// argument shapes: `Some(result)`, or `None` for any other op.
macro_rules! shared_op {
    ($target:expr, $op:expr, $args:expr) => {{
        let args: &[Value] = $args;
        match $op {
            "rolling" => {
                let window = args[0].as_str().expect("rolling window is a string");
                Some(mapping(&args[1]).and_then(|aggs| $target.rolling(window, &aggs)))
            }
            "aggregate" => {
                Some(sequence(&args[0]["sequence"]).and_then(|seq| {
                    mapping(&args[1]).and_then(|aggs| $target.aggregate(&seq, &aggs))
                }))
            }
            "diff" | "rate" | "pctChange" => {
                let names = column_names(&args[0]);
                let first = match args.get(1).and_then(|o| o["drop"].as_bool()) {
                    Some(true) => FirstRow::Drop,
                    _ => FirstRow::Keep,
                };
                Some(match $op {
                    "diff" => $target.diff(&names, first),
                    "rate" => $target.rate(&names, first),
                    _ => $target.pct_change(&names, first),
                })
            }
            "cumulative" => Some($target.cumulative(&cumulative_spec(&args[0]))),
            "shift" => {
                let n = args[1].as_f64().expect("shift offset");
                Some($target.shift(&column_names(&args[0]), n as i64))
            }
            "fill" => {
                let limits = fill_limits(args.get(1));
                Some(match &args[0] {
                    Value::String(_) => $target.fill_all(fill_strategy(&args[0]), &limits),
                    Value::Object(map) => {
                        let spec: Vec<(&str, Fill)> = map
                            .iter()
                            .map(|(c, v)| (c.as_str(), fill_strategy(v)))
                            .collect();
                        $target.fill(&spec, &limits)
                    }
                    other => panic!("fill takes a strategy or a mapping, got {other}"),
                })
            }
            "align" => Some(sequence(&args[0]["sequence"]).and_then(|seq| {
                let o = args.get(1).unwrap_or(&Value::Null);
                let method = match o["method"].as_str() {
                    None | Some("hold") => AlignMethod::Hold,
                    Some("linear") => AlignMethod::Linear,
                    Some(other) => panic!("unknown align method {other}"),
                };
                $target.align(
                    &seq,
                    Align {
                        method,
                        sample: sample(o),
                        range: range(o),
                    },
                )
            })),
            "materialize" => Some(sequence(&args[0]["sequence"]).and_then(|seq| {
                let o = args.get(1).unwrap_or(&Value::Null);
                let pick = match o["select"].as_str() {
                    None | Some("last") => Pick::Last,
                    Some("first") => Pick::First,
                    Some("nearest") => Pick::Nearest,
                    Some(other) => panic!("unknown materialize select {other}"),
                };
                $target.materialize(
                    &seq,
                    Materialize {
                        pick,
                        sample: sample(o),
                        range: range(o),
                    },
                )
            })),
            "dedupe" => {
                let keep = &args.first().unwrap_or(&Value::Null)["keep"];
                let keep = match keep {
                    Value::Null => Keep::Last,
                    Value::String(k) => match k.as_str() {
                        "first" => Keep::First,
                        "last" => Keep::Last,
                        "error" => Keep::Error,
                        "drop" => Keep::Drop,
                        other => panic!("unknown keep {other}"),
                    },
                    Value::Object(m) => match (m.get("min"), m.get("max")) {
                        (Some(c), _) => Keep::Min(c.as_str().expect("column").into()),
                        (_, Some(c)) => Keep::Max(c.as_str().expect("column").into()),
                        _ => panic!("unknown keep {keep}"),
                    },
                    other => panic!("unknown keep {other}"),
                };
                Some($target.dedupe(keep))
            }
            _ => None,
        }
    }};
}

/// `sample` in align / materialize options.
fn sample(options: &Value) -> At {
    match options["sample"].as_str() {
        None | Some("begin") => At::Begin,
        Some("center") => At::Center,
        Some("end") => At::End,
        Some(other) => panic!("unknown sample {other}"),
    }
}

/// `range`: `{ start, end }` or one time (a zero-length range).
fn range(options: &Value) -> Option<(i64, i64)> {
    match &options["range"] {
        Value::Null => None,
        Value::Number(t) => {
            let t = t.as_i64().expect("whole ms");
            Some((t, t))
        }
        r => Some((
            r["start"].as_i64().expect("range start"),
            r["end"].as_i64().expect("range end"),
        )),
    }
}

fn cumulative_spec(json: &Value) -> Vec<(&str, Reducer)> {
    json.as_object()
        .expect("cumulative takes a mapping")
        .iter()
        .map(|(c, r)| {
            (
                c.as_str(),
                Reducer::parse(r.as_str().expect("reducer")).unwrap(),
            )
        })
        .collect()
}

fn fill_limits(options: Option<&Value>) -> FillLimits {
    let mut limits = FillLimits::none();
    if let Some(limit) = options.and_then(|o| o["limit"].as_u64()) {
        limits = limits.limit(limit as usize);
    }
    if let Some(max_gap) = options.and_then(|o| o["maxGap"].as_str()) {
        limits = limits.max_gap(max_gap);
    }
    limits
}

fn fill_strategy(v: &Value) -> Fill {
    match v.as_str() {
        Some("hold") => Fill::Hold,
        Some("bfill") => Fill::Bfill,
        Some("linear") => Fill::Linear,
        Some("zero") => Fill::Zero,
        Some(text) => Fill::Value(Literal::String(text.into())),
        None => match v {
            Value::Bool(b) => Fill::Value(Literal::Boolean(*b)),
            _ => Fill::Value(Literal::Number(v.as_f64().expect("a literal"))),
        },
    }
}

/// A partition key as pond-ts writes it: `String(value)` for one column
/// (`missing` for a gap), `JSON.stringify` of the values for several.
fn partition_key(key: &[Option<Literal>], missing: &str) -> String {
    fn js_number(v: f64) -> String {
        assert!(
            v == 0.0 || (1e-6..1e21).contains(&v.abs()),
            "no JavaScript exponent form in the harness yet: {v}"
        );
        if v == v.trunc() {
            format!("{}", v as i64)
        } else {
            format!("{v}")
        }
    }
    let text = |v: &Literal| match v {
        Literal::Number(x) => js_number(*x),
        Literal::String(s) => s.clone(),
        Literal::Boolean(b) => b.to_string(),
        Literal::Decimal(d) => d.to_string(),
    };
    if let [one] = key {
        return one.as_ref().map_or(missing.to_string(), text);
    }
    let parts: Vec<String> = key
        .iter()
        .map(|v| match v {
            None => "null".to_string(),
            Some(Literal::String(s)) => serde_json::to_string(s).unwrap(),
            Some(other) => text(other),
        })
        .collect();
    format!("[{}]", parts.join(","))
}

/// Run one case through pond-rs. `None` means the op is not implemented yet.
fn run(fixture: &CoreFixture, case: &CoreCase) -> Option<Result<Outcome, String>> {
    let input = to_series(&fixture.inputs[&case.input]);
    if case.op == "shift" && case.args[1].as_f64().is_some_and(|n| n.fract() != 0.0) {
        // A fractional offset cannot be written in Rust (`n` is an i64);
        // pond-ts rejects it, so stand in that error here.
        return Some(Err("shift offset must be a whole number".into()));
    }
    if let Some(result) = shared_op!(input, case.op.as_str(), &case.args) {
        return Some(
            result
                .map(|s| to_json(&s).into())
                .map_err(|e| e.to_string()),
        );
    }
    if case.op == "reduce" {
        let reduced = mapping(&case.args[0]).and_then(|aggs| input.reduce(&aggs));
        return Some(
            reduced
                .map(|r| {
                    Outcome::Record(
                        r.columns()
                            .iter()
                            .map(|c| (c.name().to_string(), encode(c.data(), 0)))
                            .collect(),
                    )
                })
                .map_err(|e| e.to_string()),
        );
    }
    let result = match case.op.as_str() {
        "tail" => input.tail(case.args[0].as_str().expect("tail takes a duration string")),
        "overlapping" => event_key(&case.args[0]).map(|k| input.overlapping(k)),
        "containedBy" => event_key(&case.args[0]).map(|k| input.contained_by(k)),
        "trim" => event_key(&case.args[0]).map(|k| input.trim(k)),
        "before" => event_key(&case.args[0]).map(|k| input.before(k)),
        "after" => event_key(&case.args[0]).map(|k| input.after(k)),
        "within" => {
            let ms = |i: usize| case.args[i].as_i64().expect("within takes whole ms");
            input.within(ms(0), ms(1))
        }
        "join" => {
            let other = to_series(&fixture.inputs[series_name(&case.args[0])]);
            input.join(&other, join_options(case.args.get(1)))
        }
        "joinMany" => {
            let others: Vec<TimeSeries> = case.args[0]
                .as_array()
                .expect("joinMany takes a list of series")
                .iter()
                .map(|a| to_series(&fixture.inputs[series_name(a)]))
                .collect();
            let all: Vec<&TimeSeries> = std::iter::once(&input).chain(&others).collect();
            TimeSeries::join_many(&all, join_options(case.args.get(1)))
        }
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
        "slice" => {
            let at = |i: usize| {
                case.args
                    .get(i)
                    .map(|v| v.as_i64().expect("whole position"))
            };
            Ok(match (at(0), at(1)) {
                (None, _) => input.slice(..),
                (Some(b), None) => input.slice(b..),
                (Some(b), Some(e)) => input.slice(b..e),
            })
        }
        "filter" => {
            let spec = &case.args[0]["fn"];
            input.filter(|r| row_test(spec, r))
        }
        "mapColumns" => {
            let spec = case.args[0]
                .as_object()
                .expect("mapColumns takes a mapping");
            if spec.is_empty() {
                // pond-rs maps one column per call, so an empty mapping
                // cannot be written; stand in pond-ts's error.
                return Some(Err("mapColumns needs at least one column".into()));
            }
            let mut out = Ok(input);
            for (column, mapper) in spec {
                let column = column.as_str();
                let mapper = &mapper["fn"];
                out = out.and_then(|s| match mapper.as_str() {
                    Some("upper") => s.map_strings(column, |v| v.to_uppercase()),
                    Some("not") => s.map_booleans(column, |v| !v),
                    _ => {
                        let mul = mapper["mul"].as_f64().expect("mul");
                        let add = mapper["add"].as_f64().expect("add");
                        s.map_numbers(column, |v| v * mul + add)
                    }
                });
            }
            // pond-ts keeps a mapped column marked required even when the
            // mapping leaves a gap ([PND-MAPREQ]); pond-rs makes it
            // optional. Check that, then compare the rest as pond-ts has it.
            return Some(
                out.map(|s| {
                    let mut json = to_json(&s);
                    if case.id == "mapColumns-overflow" {
                        assert_eq!(
                            json.schema[1].required,
                            Some(false),
                            "mapped gap makes it optional"
                        );
                        json.schema[1].required = None;
                    }
                    Outcome::from(json)
                })
                .map_err(|e| e.to_string()),
            );
        }
        "withColumn" => {
            let name = case.args[0].as_str().expect("column name");
            let values: Vec<Option<f64>> = case.args[1]
                .as_array()
                .expect("values")
                .iter()
                .map(Value::as_f64)
                .collect();
            input.with_column(Column::optional(name, values))
        }
        "partitionBy" => {
            let by = column_names(&case.args[0]);
            let steps = case.args[1].as_array().expect("steps");
            let mut view = match input.partition_by(&by) {
                Ok(v) => v,
                Err(e) => return Some(Err(e.to_string())),
            };
            for step in steps {
                let step = step.as_array().expect("a step is [method, ...args]");
                let method = step[0].as_str().expect("method name");
                view = match shared_op!(view, method, &step[1..]) {
                    Some(Ok(v)) => v,
                    Some(Err(e)) => return Some(Err(e.to_string())),
                    None => panic!("no partitioned '{method}' in the harness"),
                };
            }
            return Some(match case.args[2].as_str() {
                Some("collect") => view
                    .collect()
                    .map(|s| to_json(&s).into())
                    .map_err(|e| e.to_string()),
                Some("toMap") => Ok(Outcome::Groups(
                    view.iter()
                        .map(|(key, s)| (partition_key(key, " undefined"), to_json(s)))
                        .collect(),
                )),
                other => panic!("unknown partition end {other:?}"),
            });
        }
        "groupBy" => {
            let column = case.args[0].as_str().expect("groupBy column");
            return Some(
                input
                    .group_by(&[column])
                    .map(|groups| {
                        Outcome::Groups(
                            groups
                                .iter()
                                .map(|(key, s)| (partition_key(key, "undefined"), to_json(s)))
                                .collect(),
                        )
                    })
                    .map_err(|e| e.to_string()),
            );
        }
        _ => return None,
    };
    Some(
        result
            .map(|s| to_json(&s).into())
            .map_err(|e| e.to_string()),
    )
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

/// A `filter` / `find` test spec from the fixture (cases.mjs `closure`).
fn row_test(spec: &Value, r: &pond_rs::Row<'_>) -> pond_rs::Result<bool> {
    if let Some(column) = spec["column"].as_str() {
        return Ok(match (&spec["gt"], &spec["eq"]) {
            (Value::Number(gt), _) => r.number(column)?.is_some_and(|v| v > gt.as_f64().unwrap()),
            (_, Value::String(eq)) => r.string(column)? == Some(eq.as_str()),
            (_, Value::Bool(eq)) => r.boolean(column)? == Some(*eq),
            _ => panic!("unknown filter spec {spec}"),
        });
    }
    if let Some(column) = spec["missing"].as_str() {
        return Ok(r.number(column)?.is_none());
    }
    if let Some(n) = spec["everyNth"].as_u64() {
        return Ok(r.index() % n as usize == 0);
    }
    if let Some(t) = spec["beginAtLeast"].as_i64() {
        return Ok(r.begin() >= t);
    }
    if let Some(t) = spec["endAtMost"].as_i64() {
        return Ok(r.end() <= t);
    }
    panic!("unknown filter spec {spec}")
}

/// A pond-ts `KeyLike` from the fixture: a number or `{"time": t}` is a
/// time, `[start, end]` a time range, `[label, start, end]` an interval
/// (also as `{"timeRange": …}` / `{"interval": …}`).
fn event_key(arg: &Value) -> pond_rs::Result<pond_rs::EventKey> {
    let ms = |v: &Value| v.as_i64().unwrap_or_else(|| panic!("whole ms, got {v}"));
    match arg {
        Value::Array(a) if a.len() == 2 => pond_rs::EventKey::time_range(ms(&a[0]), ms(&a[1])),
        Value::Array(a) if a.len() == 3 => {
            let label: pond_rs::Label = match &a[0] {
                Value::String(t) => t.as_str().into(),
                v => decode_f64(v).into(),
            };
            pond_rs::EventKey::interval(label, ms(&a[1]), ms(&a[2]))
        }
        Value::Object(o) if o.contains_key("time") => Ok(pond_rs::EventKey::time(ms(&o["time"]))),
        Value::Object(o) if o.contains_key("timeRange") => event_key(&o["timeRange"]),
        Value::Object(o) if o.contains_key("interval") => event_key(&o["interval"]),
        v => Ok(pond_rs::EventKey::time(ms(v))),
    }
}

/// A number cell, with the fixture's tags for -0 / NaN / infinities.
fn decode_f64(v: &Value) -> f64 {
    match v["f64"].as_str() {
        Some("-0") => -0.0,
        Some("NaN") => f64::NAN,
        Some("inf") => f64::INFINITY,
        Some("-inf") => f64::NEG_INFINITY,
        _ => v.as_f64().unwrap_or_else(|| panic!("a number, got {v}")),
    }
}

/// Every row lookup in the fixture (`bisect`, `includesKey`, `atOrBefore`,
/// `atOrAfter`, `nearest`, `at`, `find`, `some`, `every`) gives the row,
/// index or answer pond-ts gives, or fails where pond-ts throws.
#[test]
fn row_lookups_match_pond_ts() {
    let fixture = load_core_fixture();
    assert!(!fixture.queries.is_empty(), "core fixture has no queries");
    let inputs: std::collections::BTreeMap<&str, TimeSeries> = fixture
        .queries
        .iter()
        .map(|q| (q.input.as_str(), to_series(&fixture.inputs[&q.input])))
        .collect();
    let mut failures = Vec::new();
    for q in &fixture.queries {
        let s = &inputs[q.input.as_str()];
        let pos = |r: Option<pond_rs::Row<'_>>| r.map_or(Value::Null, |r| json!(r.index()));
        let span =
            |r: Option<pond_rs::EventKey>| r.map_or(Value::Null, |r| json!([r.begin(), r.end()]));
        let got: pond_rs::Result<Value> = match q.op.as_str() {
            "at" => Ok(pos(s.at(q.arg.as_i64().expect("position")))),
            "find" => s.find(|r| row_test(&q.arg, r)).map(pos),
            "some" => s.some(|r| row_test(&q.arg, r)).map(|b| json!(b)),
            "every" => s.every(|r| row_test(&q.arg, r)).map(|b| json!(b)),
            "timeRange" => Ok(span(s.time_range())),
            op => event_key(&q.arg).map(|k| match op {
                "overlaps" => json!(s.overlaps(k)),
                "contains" => json!(s.contains(k)),
                "intersection" => span(s.intersection(k)),
                "bisect" => json!(s.bisect(k)),
                "includesKey" => json!(s.includes_key(k)),
                "atOrBefore" => pos(s.at_or_before(k)),
                "atOrAfter" => pos(s.at_or_after(k)),
                "nearest" => pos(s.nearest(k)),
                _ => panic!("unknown query op {op}"),
            }),
        };
        // A `null` expected (no row) reads as `None`; `error` tells them apart.
        let want = q
            .error
            .is_none()
            .then(|| q.expected.clone().unwrap_or(Value::Null));
        let same = match (&got, &want) {
            (Ok(v), Some(want)) => v == want,
            (Err(_), None) => true,
            // Known difference: on an empty series pond-ts `nearest` returns
            // before it builds the key, so a backwards range is no error
            // there. pond-rs checks a key when it is built, before any call.
            (Err(_), Some(Value::Null)) => {
                q.op == "nearest" && s.is_empty() && matches!(&q.arg, Value::Array(_))
            }
            _ => false,
        };
        if !same {
            failures.push(format!(
                "{}.{}({}): pond-rs {got:?}, pond-ts {}",
                q.input,
                q.op,
                q.arg,
                q.expected
                    .as_ref()
                    .map_or_else(|| format!("{:?}", q.error), |v| v.to_string())
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} differ:\n{}",
        failures.len(),
        fixture.queries.len(),
        failures.join("\n")
    );
}

/// Every text pond-ts's `Time.parse` reads (or refuses) in the fixture,
/// read (or refused) the same by `parse_time_in`.
#[test]
fn times_parse_as_pond_ts_parses_them() {
    let fixture = load_core_fixture();
    assert!(
        !fixture.time_parse.is_empty(),
        "core fixture has no timeParse"
    );
    let mut failures = Vec::new();
    for case in &fixture.time_parse {
        let got = pond_rs::parse_time_in(&case.input, &case.time_zone);
        let same = match (&got, case.expected) {
            (Ok(ms), Some(want)) => *ms == want,
            (Err(_), None) => true,
            _ => false,
        };
        if !same {
            failures.push(format!(
                "{:?} in {}: pond-rs {got:?}, pond-ts {}",
                case.input,
                case.time_zone,
                case.expected
                    .map_or_else(|| format!("{:?}", case.error), |ms| ms.to_string())
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
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
        // Known difference: on an empty series pond-ts `overlapping` / `trim`
        // never build their range, so a backwards one is no error there.
        // pond-rs checks a key when it is built.
        let empty_backwards = ["span-overlapping-emptyHosts-8", "span-trim-emptyHosts-8"];
        if empty_backwards.contains(&case.id.as_str()) {
            assert!(
                actual.is_err(),
                "{}: pond-rs should refuse the key",
                case.id
            );
            continue;
        }
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
        let own: Result<Outcome, String> = match (&case.expected, &case.groups, &case.reduced) {
            (Some(expected), _, _) => Ok(Outcome::Series(expected.clone())),
            (None, Some(groups), _) => Ok(Outcome::Groups(groups.clone())),
            (None, None, Some(record)) => Ok(Outcome::Record(record.clone())),
            (None, None, None) => Err("pond-rs error".to_string()),
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
    assert!(check_case(error_case, &Ok(expected.clone().into())).is_err());

    // Groups: a different key, a missing group or a series where groups
    // are expected are all caught.
    let case = find(&fixture, "partition-toMap");
    let groups = case.groups.clone().unwrap();
    let mut wrong = groups.clone();
    wrong[0].0 = "zz".into();
    assert!(check_case(case, &Ok(Outcome::Groups(wrong))).is_err());
    let mut wrong = groups.clone();
    wrong.pop();
    assert!(check_case(case, &Ok(Outcome::Groups(wrong))).is_err());
    assert!(check_case(case, &Ok(groups[0].1.clone().into())).is_err());
    let case = find(&fixture, "pctChange-signed");
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

/// `{ "series": name }`: another fixture input.
fn series_name(arg: &Value) -> &str {
    arg["series"]
        .as_str()
        .expect("a series argument names an input")
}

/// pond-ts join options: `{ type?, onConflict?, prefixes? }`.
fn join_options(arg: Option<&Value>) -> Join {
    let o = arg.unwrap_or(&Value::Null);
    let how = match o["type"].as_str() {
        None | Some("outer") => JoinType::Outer,
        Some("inner") => JoinType::Inner,
        Some("left") => JoinType::Left,
        Some("right") => JoinType::Right,
        Some(other) => panic!("unknown join type {other}"),
    };
    let on_conflict = match o["onConflict"].as_str() {
        None | Some("error") => OnConflict::Error,
        Some("prefix") => OnConflict::Prefix(
            o["prefixes"]
                .as_array()
                .expect("prefixes")
                .iter()
                .map(|p| p.as_str().expect("prefix").to_string())
                .collect(),
        ),
        Some(other) => panic!("unknown onConflict {other}"),
    };
    Join { how, on_conflict }
}
