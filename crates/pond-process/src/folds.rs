//! The standard folds every registry starts with (`folds.ts`).

use pond_rs::Reducer;
use serde_json::{Map, Value, json};

use crate::context::{
    FoldContext, fact_number, first_present, last_present, present, stamper, value_at,
};
use crate::registry::{Def, ParamDef, param_text};

type Fact = Result<Value, crate::error::ProcessError>;

fn last(ctx: &FoldContext) -> Fact {
    let v = ctx.input("source");
    Ok(match last_present(v) {
        None => json!({ "value": null }),
        Some(i) => value_at(ctx, v, stamper(ctx, v.len()), i),
    })
}

/// `{min, max}`, each `{value, at}`; the first of equal values wins.
pub(crate) fn extremes_of(ctx: &FoldContext) -> Map<String, Value> {
    let v = ctx.input("source");
    let fmt = stamper(ctx, v.len());
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    let (mut lo_at, mut hi_at) = (None, None);
    for (i, &x) in v.iter().enumerate() {
        if !present(x) {
            continue;
        }
        if x < lo {
            lo = x;
            lo_at = Some(i);
        }
        if x > hi {
            hi = x;
            hi_at = Some(i);
        }
    }
    let mut out = Map::new();
    match (lo_at, hi_at) {
        (Some(l), Some(h)) => {
            out.insert(
                "min".into(),
                json!({ "value": fact_number(lo), "at": fmt(ctx.at(l)) }),
            );
            out.insert(
                "max".into(),
                json!({ "value": fact_number(hi), "at": fmt(ctx.at(h)) }),
            );
        }
        _ => {
            out.insert("min".into(), Value::Null);
            out.insert("max".into(), Value::Null);
        }
    }
    out
}

fn percentile_rank(ctx: &FoldContext) -> Fact {
    let v = ctx.input("source");
    let Some(i) = last_present(v) else {
        return Ok(json!({ "value": null }));
    };
    let last = v[i];
    let (mut seen, mut below) = (0u64, 0u64);
    for &x in v {
        if !present(x) {
            continue;
        }
        seen += 1;
        if x < last {
            below += 1;
        }
    }
    let fraction = below as f64 / seen as f64;
    Ok(json!({
        "value": fact_number(fraction),
        "note": format!(
            "{}th percentile of {seen} observations",
            pond_rs::js_number(crate::context::js_round(fraction * 100.0))
        ),
    }))
}

/// First row of bin `i` when `n` rows are cut into `bins` equal row bins
/// (core `Float64Column.bin`'s split).
fn bin_start(i: usize, n: usize, bins: usize) -> usize {
    (i * n) / bins
}

/// One bin's channels, in core `bin`'s order; NaN on every channel when
/// the bin has no present value.
fn bin_channels(v: &[f64], how: &str) -> Vec<f64> {
    let mut lo: Option<f64> = None;
    let (mut hi, mut first, mut last) = (0.0, 0.0, 0.0);
    for &x in v {
        if !present(x) {
            continue;
        }
        match lo {
            None => {
                lo = Some(x);
                hi = x;
                first = x;
            }
            Some(l) => {
                if x < l {
                    lo = Some(x);
                }
                if x > hi {
                    hi = x;
                }
            }
        }
        last = x;
    }
    let m4 = |f: &dyn Fn(f64, f64, f64, f64) -> Vec<f64>| match lo {
        None => f(f64::NAN, f64::NAN, f64::NAN, f64::NAN),
        Some(l) => f(l, hi, first, last),
    };
    let scalar = |r: Reducer| vec![r.reduce(v).unwrap_or(f64::NAN)];
    match how {
        "sample" => m4(&|_, _, _, last| vec![last]),
        "minMax" => m4(&|lo, hi, _, _| vec![lo, hi]),
        "minMaxFirstLast" => m4(&|lo, hi, first, last| vec![lo, hi, first, last]),
        "mean" => scalar(Reducer::Avg),
        "median" => scalar(Reducer::Median),
        "min" => scalar(Reducer::Min),
        _ => scalar(Reducer::Max),
    }
}

fn shape(ctx: &FoldContext) -> Fact {
    let v = ctx.input("source");
    let n = v.len();
    let no_scale = || {
        let mut m = Map::new();
        for k in ["first", "last", "min", "max"] {
            m.insert(k.into(), Value::Null);
        }
        m
    };
    let mut out = Map::new();
    if n == 0 {
        out.insert("points".into(), json!(0));
        out.extend(no_scale());
        out.insert("series".into(), json!([]));
        return Ok(Value::Object(out));
    }
    let fmt = stamper(ctx, n);
    let bins = (ctx.number("points") as usize).min(n);
    let how = ctx.text("how");
    let mut series = Vec::new();
    for b in 0..bins {
        let (start, end) = (bin_start(b, n, bins), bin_start(b + 1, n, bins));
        let channels = bin_channels(&v[start..end], how);
        if channels[0].is_nan() {
            continue;
        }
        // The bin END time: its last row's, even when that row is a gap.
        let mut point = vec![json!(fmt(ctx.at(end - 1)))];
        point.extend(channels.into_iter().map(fact_number));
        series.push(Value::Array(point));
    }
    out.insert("points".into(), json!(series.len()));
    match (first_present(v), last_present(v)) {
        (Some(f), Some(l)) => {
            out.insert("first".into(), value_at(ctx, v, fmt, f));
            out.insert("last".into(), value_at(ctx, v, fmt, l));
            out.extend(extremes_of(ctx));
        }
        _ => out.extend(no_scale()),
    }
    out.insert("series".into(), Value::Array(series));
    Ok(Value::Object(out))
}

/// `last`, `extremes`, `percentileRank` and `shape`, in that order.
pub fn standard_folds() -> Vec<Def> {
    vec![
        Def::fold(
            "last",
            "read",
            "The most recent defined value, with its date. The usual way to ask \"what is it now?\".",
            "inherit",
        )
        .input("source")
        .label(|_, inputs| format!("latest {inputs}"))
        .folds(last),
        Def::fold(
            "extremes",
            "read",
            "The lowest and highest values over the whole series, each with its date.",
            "inherit",
        )
        .input("source")
        .label(|_, inputs| format!("range of {inputs}"))
        .folds(|c| Ok(Value::Object(extremes_of(c)))),
        Def::fold(
            "percentileRank",
            "read",
            "Where the latest value sits within the series’ own history, as a 0–1 fraction. Answers \"is this unusual?\" without needing a second series to compare against.",
            "%ile",
        )
        .input("source")
        .label(|_, inputs| format!("rank of {inputs}"))
        .folds(percentile_rank),
        Def::fold(
            "shape",
            "read",
            "The whole series in at most `points` equal row bins, one point per bin at the bin end time. `how` sums up each bin: `sample` (its last value, the default), `mean`, `median`, `min`, `max`, `minMax` ([time, lo, hi], so a spike always shows) or `minMaxFirstLast` ([time, lo, hi, first, last]). Also reports `first`, `last`, `min` and `max` over the whole series, each { value, at }, to label the line. The honest answer to \"show me the series\" for a caller paying by the token.",
            "inherit",
        )
        .param("points", ParamDef::int(40.0).min(2.0).max(400.0).suggest(20.0, 120.0))
        .param(
            "how",
            ParamDef::choice(
                "sample",
                &["sample", "mean", "median", "min", "max", "minMax", "minMaxFirstLast"],
            ),
        )
        .input("source")
        .label(|p, inputs| {
            format!("shape({}, {}) of {inputs}", param_text(p, "points"), param_text(p, "how"))
        })
        .folds(shape),
    ]
}
