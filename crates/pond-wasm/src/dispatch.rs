//! pond-ts method calls, with pond-ts's argument shapes, run on pond-rs.
//!
//! JavaScript sends each call as a method name and its arguments as JSON,
//! the same shapes pond-ts takes (`rolling('5m', { avg: 'avg' })`,
//! `aggregate(Sequence.every('1m'), { … })`), with three encodings for what
//! JSON cannot carry: `{"series": id}` for another series, `{"sequence":
//! {"every": d}}` / `{"sequence": {"calendar": u, "timeZone": z,
//! "weekStartsOn"?: w}}` for a `Sequence`, and `{"f64": "-0" | "NaN" | "inf"
//! | "-inf"}` for numbers JSON drops. Plain Rust, so it runs (and is tested)
//! natively too.

use pond_rs::Value as Literal;
use pond_rs::{
    Agg, Align, AlignMethod, Alignment, ArrayOptions, At, Bins, Change, Column, ColumnData,
    ColumnKind, Fill, FillLimits, FirstRow, Join, JoinType, Keep, Materialize, OnConflict,
    PartitionedSeries, Pick, Reducer, Rolling, RollingOver, Scalar, Sequence, TimeSeries,
};
use serde_json::Value;

use crate::callbacks::{self, Callbacks};

/// What a call returns.
pub enum Outcome {
    /// A new series.
    Series(TimeSeries),
    /// One series per group, keyed the way pond-ts keys `toMap` /
    /// `groupBy` (`String(value)`, or a JSON array for several columns).
    Groups(Vec<(String, TimeSeries)>),
    /// One row of named cells (`reduce`).
    Record(Vec<(String, Option<Literal>)>),
    /// Rows of named cells (`byColumn`, `rollingByColumn`).
    Records(Vec<Vec<(String, Option<Literal>)>>),
    /// A row position, or none (`at`, `find`, `nearest`, …).
    Row(Option<usize>),
    /// A yes / no answer (`some`, `includesKey`, …).
    Bool(bool),
    /// A number (`bisect`).
    Number(f64),
    /// A time span `[begin, end]`, or none (`timeRange`, `intersection`).
    Span(Option<(i64, i64)>),
}

/// An error message for JavaScript.
pub type Res<T> = Result<T, String>;

pub(crate) fn pond<T>(r: pond_rs::Result<T>) -> Res<T> {
    r.map_err(|e| e.to_string())
}

/// The ops a `partitionBy` step can run (the arms of `shared_op!`).
pub const PARTITIONED_OPS: &[&str] = &[
    "rolling",
    "aggregate",
    "diff",
    "rate",
    "pctChange",
    "cumulative",
    "shift",
    "fill",
    "align",
    "materialize",
    "dedupe",
    "smooth",
    "baseline",
    "outliers",
    "sample",
    "scan",
];

/// The ops [`call`] runs without functions or row lookups; those are
/// [`crate::callbacks::OPS`].
pub const OPS: &[&str] = &[
    "rolling",
    "aggregate",
    "diff",
    "rate",
    "pctChange",
    "cumulative",
    "shift",
    "fill",
    "align",
    "materialize",
    "dedupe",
    "smooth",
    "baseline",
    "outliers",
    "sample",
    "reduce",
    "byColumn",
    "rollingByColumn",
    "tail",
    "overlapping",
    "containedBy",
    "trim",
    "before",
    "after",
    "within",
    "asTimeRange",
    "asInterval",
    "offsetTime",
    "join",
    "joinMany",
    "arrayContains",
    "arrayContainsAll",
    "arrayContainsAny",
    "arrayAggregate",
    "arrayExplode",
    "concat",
    "pivotByGroup",
    "select",
    "rename",
    "asTime",
    "slice",
    "withColumn",
    "partitionBy",
    "groupBy",
];

/// The arguments of one call, with typed accessors that name the call and
/// the argument when one is the wrong shape.
pub(crate) struct Args<'a> {
    pub(crate) op: &'a str,
    pub(crate) list: &'a [Value],
}

const NULL: Value = Value::Null;

impl<'a> Args<'a> {
    pub(crate) fn get(&self, i: usize) -> &'a Value {
        self.list.get(i).unwrap_or(&NULL)
    }
    pub(crate) fn bad(&self, i: usize, want: &str) -> String {
        format!(
            "{}: argument {} must be {want}, got {}",
            self.op,
            i + 1,
            self.get(i)
        )
    }
    pub(crate) fn str(&self, i: usize, want: &str) -> Res<&'a str> {
        self.get(i).as_str().ok_or_else(|| self.bad(i, want))
    }
    pub(crate) fn names(&self, i: usize) -> Res<Vec<&'a str>> {
        column_names(self.get(i)).ok_or_else(|| self.bad(i, "a column name or a list of them"))
    }
    pub(crate) fn options(&self, i: usize) -> Res<&'a Value> {
        match self.get(i) {
            v @ (Value::Null | Value::Object(_)) => Ok(v),
            _ => Err(self.bad(i, "an options object")),
        }
    }
    pub(crate) fn whole(&self, i: usize, want: &str) -> Res<i64> {
        whole_number(self.get(i)).ok_or_else(|| self.bad(i, want))
    }
}

fn column_names(v: &Value) -> Option<Vec<&str>> {
    match v {
        Value::String(s) => Some(vec![s.as_str()]),
        Value::Array(a) => a.iter().map(Value::as_str).collect(),
        _ => None,
    }
}

/// An option field that must be one of `allowed` (or absent: the first).
fn choice<'a>(op: &str, o: &'a Value, field: &str, allowed: &[&'a str]) -> Res<&'a str> {
    match &o[field] {
        Value::Null => Ok(allowed[0]),
        Value::String(s) if allowed.contains(&s.as_str()) => Ok(s.as_str()),
        other => Err(format!(
            "{op}: option '{field}' must be one of {allowed:?}, got {other}"
        )),
    }
}

fn opt_count(op: &str, o: &Value, field: &str) -> Res<Option<usize>> {
    match &o[field] {
        Value::Null => Ok(None),
        v => whole_number(v)
            .and_then(|n| usize::try_from(n).ok())
            .map(Some)
            .ok_or_else(|| format!("{op}: option '{field}' must be a whole number, got {v}")),
    }
}

/// A whole number within JavaScript's exact range. `-0` (sent as
/// `{"f64": "-0"}`) is 0, as JavaScript reads it.
fn whole_number(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| {
        decode_f64(v)
            .filter(|n| n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15)
            .map(|n| n as i64)
    })
}

/// A number, with the `{"f64": …}` tags for what JSON cannot write.
pub fn decode_f64(v: &Value) -> Option<f64> {
    match v["f64"].as_str() {
        Some("-0") => Some(-0.0),
        Some("NaN") => Some(f64::NAN),
        Some("inf") => Some(f64::INFINITY),
        Some("-inf") => Some(f64::NEG_INFINITY),
        _ => v.as_f64(),
    }
}

fn scalar(v: &Value) -> Res<Scalar> {
    match v {
        Value::String(s) => Ok(Scalar::String(s.clone())),
        Value::Bool(b) => Ok(Scalar::Boolean(*b)),
        _ => decode_f64(v)
            .map(Scalar::Number)
            .ok_or_else(|| format!("expected a number, text or true/false, got {v}")),
    }
}

fn sequence(v: &Value) -> Res<Sequence> {
    let s = &v["sequence"];
    if let Some(every) = s["every"].as_str() {
        return pond(Sequence::every(every));
    }
    let (Some(unit), Some(zone)) = (s["calendar"].as_str(), s["timeZone"].as_str()) else {
        return Err(format!("expected a Sequence, got {v}"));
    };
    let seq = pond(Sequence::calendar(unit, zone))?;
    match &s["weekStartsOn"] {
        Value::Null => Ok(seq),
        w => match whole_number(w) {
            Some(day) if (-128..=127).contains(&day) => pond(seq.with_week_start(day as i8)),
            _ => Err(format!("weekStartsOn must be a day number, got {w}")),
        },
    }
}

/// `{ out: 'avg' }` or `{ out: { from, using } }`, in key order.
fn mapping(op: &str, v: &Value) -> Res<Vec<Agg>> {
    let Some(map) = v.as_object() else {
        return Err(format!("{op}: expected a mapping object, got {v}"));
    };
    map.iter()
        .map(|(output, spec)| match spec {
            Value::String(r) => Ok(Agg::of(output, pond(Reducer::parse(r))?)),
            _ => match (spec["from"].as_str(), spec["using"].as_str()) {
                (Some(from), Some(using)) => {
                    Ok(Agg::new(output, from, pond(Reducer::parse(using))?))
                }
                _ => Err(format!(
                    "{op}: mapping entry '{output}' must be a reducer name or {{ from, using }}"
                )),
            },
        })
        .collect()
}

fn rolling_options(op: &str, o: &Value) -> Res<Rolling> {
    Ok(Rolling {
        alignment: match choice(op, o, "alignment", &["trailing", "leading", "centered"])? {
            "leading" => Alignment::Leading,
            "centered" => Alignment::Centered,
            _ => Alignment::Trailing,
        },
        min_samples: opt_count(op, o, "minSamples")?.unwrap_or(0),
        append: o["append"].as_bool().unwrap_or(false),
    })
}

fn at(op: &str, o: &Value, field: &str) -> Res<At> {
    Ok(match choice(op, o, field, &["begin", "center", "end"])? {
        "center" => At::Center,
        "end" => At::End,
        _ => At::Begin,
    })
}

fn range(op: &str, o: &Value) -> Res<Option<(i64, i64)>> {
    let ms =
        |v: &Value| whole_number(v).ok_or_else(|| format!("{op}: range times must be whole ms"));
    match &o["range"] {
        Value::Null => Ok(None),
        v if v.is_number() || v.get("f64").is_some() => {
            let t = ms(&o["range"])?;
            Ok(Some((t, t)))
        }
        r => Ok(Some((ms(&r["start"])?, ms(&r["end"])?))),
    }
}

fn fill_strategy(v: &Value) -> Res<Fill> {
    Ok(match v {
        Value::String(s) => match s.as_str() {
            "hold" => Fill::Hold,
            "bfill" => Fill::Bfill,
            "linear" => Fill::Linear,
            "zero" => Fill::Zero,
            text => Fill::Value(Literal::String(text.into())),
        },
        Value::Bool(b) => Fill::Value(Literal::Boolean(*b)),
        Value::Array(a) => Fill::Value(Literal::Array(
            a.iter().map(scalar).collect::<Res<Vec<_>>>()?,
        )),
        _ => Fill::Value(Literal::Number(
            decode_f64(v).ok_or_else(|| format!("fill: unknown strategy {v}"))?,
        )),
    })
}

fn fill_limits(o: &Value) -> Res<FillLimits> {
    let mut limits = FillLimits::none();
    if let Some(n) = opt_count("fill", o, "limit")? {
        limits = limits.limit(n);
    }
    if let Some(gap) = o["maxGap"].as_str() {
        limits = limits.max_gap(gap);
    }
    Ok(limits)
}

fn array_options(o: &Value) -> Res<ArrayOptions> {
    let kind = match o["kind"].as_str() {
        None => None,
        Some(k) => Some(column_kind(k)?),
    };
    Ok(ArrayOptions {
        output: o["as"].as_str().map(str::to_string),
        kind,
    })
}

fn column_kind(k: &str) -> Res<ColumnKind> {
    Ok(match k {
        "number" => ColumnKind::Number,
        "string" => ColumnKind::String,
        "boolean" => ColumnKind::Boolean,
        "array" => ColumnKind::Array,
        other => return Err(format!("unknown column kind '{other}'")),
    })
}

fn smooth_options(a: &Args, method: &str, o: &Value) -> Res<pond_rs::Smooth> {
    use pond_rs::Smooth;
    let mut smooth = match method {
        "ema" => match (decode_f64(&o["alpha"]), decode_f64(&o["span"])) {
            (Some(x), None) => Smooth::ema(x),
            (None, Some(s)) => Smooth::ema_span(s),
            _ => return Err("smooth: ema needs exactly one of alpha or span".into()),
        },
        "movingAverage" => match o["window"].as_str() {
            Some(w) => Smooth::moving_average(w),
            None => return Err("smooth: movingAverage needs a window".into()),
        },
        "loess" => match decode_f64(&o["span"]) {
            Some(s) => Smooth::loess(s),
            None => return Err("smooth: loess needs a span".into()),
        },
        other => return Err(format!("{}: unknown method '{other}'", a.op)),
    };
    if let Some(n) = opt_count(a.op, o, "warmup")? {
        smooth = smooth.warmup(n);
    }
    if let Some(n) = opt_count(a.op, o, "minSamples")? {
        smooth = smooth.min_samples(n);
    }
    if o["alignment"].is_string() {
        smooth = smooth.alignment(rolling_options(a.op, o)?.alignment);
    }
    if choice(a.op, o, "missing", &["bridge", "skip"])? == "skip" {
        smooth = smooth.skip_missing();
    }
    if let Some(name) = o["output"].as_str() {
        smooth = smooth.output(name);
    }
    Ok(smooth)
}

fn join_options(o: &Value) -> Res<Join> {
    let how = match choice("join", o, "type", &["outer", "inner", "left", "right"])? {
        "inner" => JoinType::Inner,
        "left" => JoinType::Left,
        "right" => JoinType::Right,
        _ => JoinType::Outer,
    };
    let on_conflict = match choice("join", o, "onConflict", &["error", "prefix"])? {
        "prefix" => OnConflict::Prefix(
            o["prefixes"]
                .as_array()
                .and_then(|p| p.iter().map(|s| s.as_str().map(str::to_string)).collect())
                .ok_or("join: onConflict 'prefix' needs prefixes, a list of text")?,
        ),
        _ => OnConflict::Error,
    };
    Ok(Join { how, on_conflict })
}

/// A pond-ts `KeyLike`: a number or `{"time": t}`, `[start, end]` or
/// `{"timeRange": …}`, `[label, start, end]` or `{"interval": …}`.
pub(crate) fn event_key(v: &Value) -> Res<pond_rs::EventKey> {
    let ms =
        |v: &Value| whole_number(v).ok_or_else(|| format!("key times must be whole ms, got {v}"));
    match v {
        Value::Array(a) if a.len() == 2 => {
            pond(pond_rs::EventKey::time_range(ms(&a[0])?, ms(&a[1])?))
        }
        Value::Array(a) if a.len() == 3 => {
            let label: pond_rs::Label = match &a[0] {
                Value::String(t) => t.as_str().into(),
                l => decode_f64(l)
                    .ok_or_else(|| format!("interval labels are numbers or text, got {l}"))?
                    .into(),
            };
            pond(pond_rs::EventKey::interval(label, ms(&a[1])?, ms(&a[2])?))
        }
        Value::Object(o) if o.contains_key("time") => Ok(pond_rs::EventKey::time(ms(&o["time"])?)),
        Value::Object(o) if o.contains_key("timeRange") => event_key(&o["timeRange"]),
        Value::Object(o) if o.contains_key("interval") => event_key(&o["interval"]),
        v => Ok(pond_rs::EventKey::time(ms(v)?)),
    }
}

/// A cell of a column as a value (`None` for a gap).
pub fn cell(data: &ColumnData, i: usize) -> Option<Literal> {
    match data {
        ColumnData::Number(c) => c.get(i).map(Literal::Number),
        ColumnData::Decimal(c) => c.get(i).map(Literal::Decimal),
        ColumnData::String(c) => c.get(i).map(|s| Literal::String(s.to_string())),
        ColumnData::Boolean(c) => c.get(i).map(Literal::Boolean),
        ColumnData::Array(c) => c.get(i).map(|a| Literal::Array(a.to_vec())),
    }
}

/// A partition key as pond-ts writes it: `String(value)` for one column
/// (`missing` for a gap), `JSON.stringify` of the values for several.
fn partition_key(key: &[Option<Literal>], missing: &str) -> String {
    let text = |v: &Literal| match v {
        Literal::Number(x) => js_number(*x),
        Literal::String(s) => s.clone(),
        Literal::Boolean(b) => b.to_string(),
        Literal::Decimal(d) => d.to_string(),
        Literal::Array(_) => String::new(), // partition_by refuses arrays
    };
    if let [one] = key {
        return one.as_ref().map_or(missing.to_string(), text);
    }
    let parts: Vec<String> = key
        .iter()
        .map(|v| match v {
            None => "null".to_string(),
            Some(Literal::String(s)) => serde_json::to_string(s).unwrap_or_default(),
            Some(other) => text(other),
        })
        .collect();
    format!("[{}]", parts.join(","))
}

/// A number as JavaScript's `String(n)` writes it.
pub fn js_number(v: f64) -> String {
    if v.is_nan() {
        return "NaN".into();
    }
    if v.is_infinite() {
        return if v > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if v == 0.0 {
        return "0".into();
    }
    let a = v.abs();
    if (1e-7..1e21).contains(&a) {
        // Rust's shortest round-trip digits, never in exponent form here,
        // match JavaScript's in this range.
        let s = format!("{v}");
        return s;
    }
    // Exponent form: JavaScript writes `1e+21`, `1.5e-7`.
    let s = format!("{v:e}");
    match s.split_once('e') {
        Some((m, e)) if !e.starts_with('-') => format!("{m}e+{e}"),
        _ => s,
    }
}

/// The ops a series and a partitioned view both have, with the same
/// argument shapes; `None` for any other op.
macro_rules! shared_op {
    ($target:expr, $a:expr) => {{
        let a: &Args = $a;
        match a.op {
            "rolling" => Some(if let Some(window) = a.get(0).as_str() {
                let o = a.options(2)?;
                let aggs = mapping(a.op, a.get(1))?;
                pond($target.rolling_with(window, &aggs, rolling_options(a.op, o)?))
            } else if let Some(rows) =
                whole_number(&a.get(0)["count"]).and_then(|n| u64::try_from(n).ok())
            {
                let o = a.options(2)?;
                let aggs = mapping(a.op, a.get(1))?;
                pond($target.rolling_rows(rows as usize, &aggs, rolling_options(a.op, o)?))
            } else {
                let seq = sequence(a.get(0))?;
                let window = a.str(1, "a window duration")?;
                let o = a.options(3)?;
                let r = rolling_options(a.op, o)?;
                let options = RollingOver {
                    alignment: r.alignment,
                    min_samples: r.min_samples,
                    sample: at(a.op, o, "sample")?,
                    range: range(a.op, o)?,
                };
                let aggs = mapping(a.op, a.get(2))?;
                pond($target.rolling_over(&seq, window, &aggs, options))
            }),
            "aggregate" => {
                let seq = sequence(a.get(0))?;
                let aggs = mapping(a.op, a.get(1))?;
                Some(pond($target.aggregate(&seq, &aggs)))
            }
            "diff" | "rate" | "pctChange" => {
                let names = a.names(0)?;
                let o = a.options(1)?;
                let mut options = Change::default();
                if o["drop"].as_bool() == Some(true) {
                    options = options.first(FirstRow::Drop);
                }
                if let Some(output) = o["output"].as_str() {
                    options = options.output(output);
                }
                Some(pond(match a.op {
                    "diff" => $target.diff_with(&names, options),
                    "rate" => $target.rate_with(&names, options),
                    _ => $target.pct_change_with(&names, options),
                }))
            }
            "cumulative" => {
                let Some(map) = a.get(0).as_object() else {
                    return Err(a.bad(0, "a mapping of column to reducer"));
                };
                let spec = map
                    .iter()
                    .map(|(c, r)| {
                        let r = r.as_str().ok_or_else(|| a.bad(0, "reducer names"))?;
                        Ok((c.as_str(), pond(Reducer::parse(r))?))
                    })
                    .collect::<Res<Vec<_>>>()?;
                Some(pond($target.cumulative(&spec)))
            }
            "shift" => {
                let names = a.names(0)?;
                let n = a.whole(1, "a whole number of rows")?;
                Some(pond($target.shift(&names, n)))
            }
            "fill" => {
                let limits = fill_limits(a.options(1)?)?;
                Some(pond(match a.get(0) {
                    Value::Object(map) => {
                        let spec = map
                            .iter()
                            .map(|(c, v)| Ok((c.as_str(), fill_strategy(v)?)))
                            .collect::<Res<Vec<_>>>()?;
                        $target.fill_with(&spec, &limits)
                    }
                    v => $target.fill_all_with(fill_strategy(v)?, &limits),
                }))
            }
            "align" => {
                let seq = sequence(a.get(0))?;
                let o = a.options(1)?;
                let method = match choice(a.op, o, "method", &["hold", "linear"])? {
                    "linear" => AlignMethod::Linear,
                    _ => AlignMethod::Hold,
                };
                Some(pond($target.align(
                    &seq,
                    Align {
                        method,
                        sample: at(a.op, o, "sample")?,
                        range: range(a.op, o)?,
                    },
                )))
            }
            "materialize" => {
                let seq = sequence(a.get(0))?;
                let o = a.options(1)?;
                let pick = match choice(a.op, o, "select", &["last", "first", "nearest"])? {
                    "first" => Pick::First,
                    "nearest" => Pick::Nearest,
                    _ => Pick::Last,
                };
                Some(pond($target.materialize(
                    &seq,
                    Materialize {
                        pick,
                        sample: at(a.op, o, "sample")?,
                        range: range(a.op, o)?,
                    },
                )))
            }
            "dedupe" => {
                let keep = match &a.options(0)?["keep"] {
                    Value::Null => Keep::Last,
                    Value::String(k) => match k.as_str() {
                        "first" => Keep::First,
                        "last" => Keep::Last,
                        "error" => Keep::Error,
                        "drop" => Keep::Drop,
                        other => return Err(format!("dedupe: unknown keep '{other}'")),
                    },
                    Value::Object(m) => match (m.get("min"), m.get("max")) {
                        (Some(Value::String(c)), _) => Keep::Min(c.clone()),
                        (_, Some(Value::String(c))) => Keep::Max(c.clone()),
                        _ => return Err("dedupe: keep must be { min } or { max } a column".into()),
                    },
                    other => return Err(format!("dedupe: unknown keep {other}")),
                };
                Some(pond($target.dedupe(keep)))
            }
            "smooth" => {
                let column = a.str(0, "a column name")?;
                let method = a.str(1, "a smoothing method")?;
                let smooth = smooth_options(a, method, a.options(2)?)?;
                Some(pond($target.smooth(column, &smooth)))
            }
            "baseline" | "outliers" => {
                let column = a.str(0, "a column name")?;
                let o = a.options(1)?;
                let window = o["window"]
                    .as_str()
                    .ok_or_else(|| format!("{}: options need a window", a.op))?;
                let sigma = decode_f64(&o["sigma"])
                    .ok_or_else(|| format!("{}: options need sigma", a.op))?;
                let options = rolling_options(a.op, o)?;
                Some(pond(if a.op == "outliers" {
                    $target.outliers(column, window, sigma, options)
                } else if o["names"].is_null() {
                    $target.baseline(column, window, sigma, options)
                } else {
                    let names = &o["names"];
                    let name = |k: &'static str| names[k].as_str().unwrap_or(k);
                    $target.baseline_named(
                        column,
                        window,
                        sigma,
                        options,
                        [name("avg"), name("sd"), name("upper"), name("lower")],
                    )
                }))
            }
            "sample" => {
                let o = a.options(0)?;
                let whole = |v: &Value| whole_number(v).filter(|n| *n >= 0);
                Some(
                    match (whole(&o["stride"]), whole(&o["reservoir"]["size"])) {
                        (Some(n), _) => pond($target.sample(pond_rs::Sample::Stride(n as usize))),
                        (_, Some(n)) => pond($target.sample(pond_rs::Sample::Reservoir {
                            size: n as usize,
                            seed: 0,
                        })),
                        _ => Err(
                            "sample: give { stride } or { reservoir: { size } }, a whole number"
                                .into(),
                        ),
                    },
                )
            }
            _ => None,
        }
    }};
}

/// Run `op` on `input` with pond-ts-shaped `args`. `series` resolves a
/// `{"series": id}` argument.
pub fn call<C: Callbacks>(
    input: &TimeSeries,
    op: &str,
    args: &[Value],
    series: &dyn Fn(&Value) -> Res<TimeSeries>,
    cb: &C,
) -> Res<Outcome> {
    let a = Args { op, list: args };
    if let Some(r) = shared_op!(input, &a) {
        return r.map(Outcome::Series);
    }
    if let Some(r) = callbacks::call(input, &a, cb) {
        return r;
    }
    let s = Outcome::Series;
    Ok(match op {
        "reduce" => {
            let aggs = mapping(op, a.get(0))?;
            let r = pond(input.reduce(&aggs))?;
            Outcome::Record(
                r.columns()
                    .iter()
                    .map(|c| (c.name().to_string(), cell(c.data(), 0)))
                    .collect(),
            )
        }
        "byColumn" | "rollingByColumn" => value_axis(input, &a)?,
        "tail" => s(pond(input.tail(a.str(0, "a duration")?))?),
        "overlapping" => s(input.overlapping(event_key(a.get(0))?)),
        "containedBy" => s(input.contained_by(event_key(a.get(0))?)),
        "trim" => s(input.trim(event_key(a.get(0))?)),
        "before" => s(input.before(event_key(a.get(0))?)),
        "after" => s(input.after(event_key(a.get(0))?)),
        "within" => s(pond(input.within(
            a.whole(0, "a start time in ms")?,
            a.whole(1, "an end time in ms")?,
        ))?),
        "asTimeRange" => s(pond(input.as_time_range())?),
        "asInterval" => s(pond(match a.get(0) {
            Value::String(label) => input.as_interval(label.as_str()),
            v => match decode_f64(v) {
                Some(n) => input.as_interval(n),
                None => return Err(a.bad(0, "a label (text or number)")),
            },
        })?),
        "offsetTime" => s(pond(match a.get(0) {
            Value::String(by) => input.offset_time(by),
            _ => input.offset_time_ms(a.whole(0, "a duration or whole ms")?),
        })?),
        "join" => {
            let other = series(a.get(0))?;
            s(pond(input.join(&other, join_options(a.options(1)?)?))?)
        }
        "joinMany" | "concat" => {
            let Some(list) = a.get(0).as_array() else {
                return Err(a.bad(0, "a list of series"));
            };
            let others = list.iter().map(series).collect::<Res<Vec<_>>>()?;
            let all: Vec<&TimeSeries> = std::iter::once(input).chain(&others).collect();
            s(pond(if op == "concat" {
                TimeSeries::concat(&all)
            } else {
                TimeSeries::join_many(&all, join_options(a.options(1)?)?)
            })?)
        }
        "arrayContains" => s(pond(
            input.array_contains(a.str(0, "a column name")?, scalar(a.get(1))?),
        )?),
        "arrayContainsAll" | "arrayContainsAny" => {
            let column = a.str(0, "a column name")?;
            let Some(list) = a.get(1).as_array() else {
                return Err(a.bad(1, "a list of values"));
            };
            let values = list.iter().map(scalar).collect::<Res<Vec<_>>>()?;
            s(pond(if op == "arrayContainsAll" {
                input.array_contains_all(column, &values)
            } else {
                input.array_contains_any(column, &values)
            })?)
        }
        "arrayAggregate" => {
            let r = pond(Reducer::parse(a.str(1, "a reducer name")?))?;
            s(pond(input.array_aggregate(
                a.str(0, "a column name")?,
                r,
                &array_options(a.options(2)?)?,
            ))?)
        }
        "arrayExplode" => s(pond(
            input.array_explode(a.str(0, "a column name")?, &array_options(a.options(1)?)?),
        )?),
        "pivotByGroup" => {
            let o = a.options(2)?;
            let mut pivot = pond_rs::Pivot::default();
            if let Some(name) = o["aggregate"].as_str() {
                pivot = pivot.aggregate(pond(Reducer::parse(name))?);
            }
            if let Some(groups) = o["groups"].as_array() {
                let names: Vec<&str> = groups
                    .iter()
                    .map(Value::as_str)
                    .collect::<Option<_>>()
                    .ok_or("pivotByGroup: groups must be text")?;
                pivot = pivot.groups(names);
            }
            s(pond(input.pivot_by_group(
                a.str(0, "the group column")?,
                a.str(1, "the value column")?,
                &pivot,
            ))?)
        }
        "select" => {
            let names = args
                .iter()
                .map(Value::as_str)
                .collect::<Option<Vec<_>>>()
                .ok_or("select: arguments must be column names")?;
            s(pond(input.select(&names))?)
        }
        "rename" => {
            let Some(map) = a.get(0).as_object() else {
                return Err(a.bad(0, "a mapping of old name to new name"));
            };
            let renames = map
                .iter()
                .map(|(from, to)| to.as_str().map(|t| (from.as_str(), t)))
                .collect::<Option<Vec<_>>>()
                .ok_or("rename: new names must be text")?;
            s(pond(input.rename(&renames))?)
        }
        "asTime" => s(pond(input.as_time(at(op, a.options(0)?, "at")?))?),
        "slice" => {
            let pos = |i: usize| match a.get(i) {
                Value::Null => Ok(None),
                _ => a.whole(i, "a whole row position").map(Some),
            };
            s(match (pos(0)?, pos(1)?) {
                (None, _) => input.slice(..),
                (Some(b), None) => input.slice(b..),
                (Some(b), Some(e)) => input.slice(b..e),
            })
        }
        "withColumn" => {
            let name = a.str(0, "a column name")?;
            let Some(list) = a.get(1).as_array() else {
                return Err(a.bad(1, "a list of values"));
            };
            let values: Vec<Option<f64>> = list.iter().map(decode_f64).collect();
            s(pond(input.with_column(Column::optional(name, values)))?)
        }
        "partitionBy" => partition(input, &a, cb)?,
        "groupBy" => {
            let column = a.str(0, "a column name")?;
            let groups = pond(input.group_by(&[column]))?;
            Outcome::Groups(
                groups
                    .into_iter()
                    .map(|(key, s)| (partition_key(&key, "undefined"), s))
                    .collect(),
            )
        }
        other => return Err(format!("unknown method '{other}'")),
    })
}

/// `partitionBy(by, steps, end)`: steps `[[method, ...args]]` run on the
/// partitioned view, `end` `"collect"` or `"toMap"`.
fn partition<C: Callbacks>(input: &TimeSeries, a: &Args, cb: &C) -> Res<Outcome> {
    let by = a.names(0)?;
    let Some(steps) = a.get(1).as_array() else {
        return Err(a.bad(1, "a list of steps [method, ...args]"));
    };
    let mut view: PartitionedSeries = pond(input.partition_by(&by))?;
    for step in steps {
        let Some((Value::String(method), rest)) = step.as_array().and_then(|s| s.split_first())
        else {
            return Err(format!(
                "partitionBy: a step is [method, ...args], got {step}"
            ));
        };
        let sa = Args {
            op: method,
            list: rest,
        };
        view = match shared_op!(view, &sa) {
            Some(r) => r?,
            None if sa.op == "scan" => callbacks::scan(&view, &sa, cb)?,
            None => return Err(format!("partitionBy: no partitioned '{method}'")),
        };
    }
    match a.get(2).as_str() {
        Some("collect") | None => Ok(Outcome::Series(pond(view.collect())?)),
        Some("toMap") => Ok(Outcome::Groups(
            view.iter()
                .map(|(key, s)| (partition_key(key, " undefined"), s.clone()))
                .collect(),
        )),
        Some(other) => Err(format!("partitionBy: unknown end '{other}'")),
    }
}

/// `byColumn` / `rollingByColumn`, as records.
fn value_axis(input: &TimeSeries, a: &Args) -> Res<Outcome> {
    let column = a.str(0, "a column name")?;
    let spec = a.get(1);
    let aggs = mapping(a.op, a.get(2))?;
    let numbers = |v: &Value| -> Res<Vec<f64>> {
        v.as_array()
            .and_then(|l| l.iter().map(decode_f64).collect())
            .ok_or_else(|| format!("{}: expected a list of numbers, got {v}", a.op))
    };
    let table = if a.op == "byColumn" {
        let bins = match spec.get("edges") {
            Some(edges) if spec["inclusive"] == "(]" => {
                Bins::edges_upper_inclusive(numbers(edges)?)
            }
            Some(edges) => Bins::edges(numbers(edges)?),
            None => Bins::width_from(
                decode_f64(&spec["width"]).ok_or("byColumn: bins need edges or a width")?,
                spec.get("origin").and_then(decode_f64).unwrap_or(0.0),
            ),
        };
        pond(input.by_column(column, &bins, &aggs))?
    } else {
        let radius = decode_f64(&spec["radius"]).ok_or("rollingByColumn: needs a radius")?;
        match spec.get("at") {
            Some(at) => pond(input.rolling_by_column_at(column, radius, &numbers(at)?, &aggs))?,
            None => pond(input.rolling_by_column(column, radius, &aggs))?,
        }
    };
    Ok(Outcome::Records(
        (0..table.len())
            .map(|row| {
                table
                    .columns()
                    .iter()
                    .map(|c| (c.name().to_string(), cell(c.data(), row)))
                    .collect()
            })
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::callbacks::NoCallbacks;
    use pond_rs::JsonOptions;
    use serde_json::json;

    fn series() -> TimeSeries {
        let text = r#"{"name":"s","schema":[{"name":"time","kind":"time"},
            {"name":"v","kind":"number"},{"name":"host","kind":"string"}],
            "rows":[[0,1,"a"],[1000,2,"b"]]}"#;
        TimeSeries::from_json(text, &JsonOptions::default()).unwrap()
    }

    fn no_series(v: &Value) -> Res<TimeSeries> {
        Err(format!("no series {v}"))
    }

    /// `PARTITIONED_OPS` (which the JS package reads to build its
    /// partitioned methods) lists exactly the ops a step can run.
    #[test]
    fn partitioned_ops_match_the_steps() {
        let s = series();
        let step = |op: &str| {
            let args = [json!("host"), json!([[op]]), json!("collect")];
            match call(&s, "partitionBy", &args, &no_series, &NoCallbacks) {
                Err(why) => !why.contains("no partitioned"),
                Ok(_) => true,
            }
        };
        for op in PARTITIONED_OPS {
            assert!(step(op), "'{op}' is listed but no step runs it");
        }
        let all = OPS.iter().chain(callbacks::OPS);
        for op in all.filter(|op| !PARTITIONED_OPS.contains(op)) {
            assert!(!step(op), "'{op}' runs as a step but is not listed");
        }
    }
}
