//! The pond-ts methods that take a function (`filter`, `find`, `some`,
//! `every`, `mapColumns`, `scan`, `collapse`, `asInterval` with a
//! function) and the row lookups (`at`, `bisect`, `nearest`, …).
//!
//! An expression argument (`col('v').gt(0)`) arrives as `{"expr": tree}`,
//! the JSON tree pond-ts's `Expr.toJSON()` writes, and runs in pond-rs
//! with no function calls at all.
//!
//! A function argument arrives as `{"fn": k}`: the `k`th function the
//! caller passed, called through [`Callbacks`]. pond-rs's closures cannot
//! fail (or fail with pond-rs's own error), so a function that throws is
//! remembered by [`Failure`]: the remaining rows skip the function and the
//! call returns the first error once pond-rs is done.

use std::sync::Mutex;

use pond_rs::{ColumnKind, EventKey, Expr, Label, PartitionedSeries, Scalar, TimeSeries};
use serde_json::Value;

use crate::dispatch::{Args, Outcome, Res, event_key, pond};

/// The functions one call passed, by position.
///
/// `Sync` and `Acc: Send + Sync` are what pond-rs's partitioned `scan`
/// asks for (its partitions may run on several cores). pond-wasm builds
/// pond-rs without threads, so every call runs on one thread.
pub trait Callbacks: Sync {
    /// A `scan` accumulator.
    type Acc: Clone + Send + Sync;
    /// `filter` / `find` / `some` / `every`: the test, on row `row` of `s`.
    fn test(&self, k: usize, s: &TimeSeries, row: usize) -> Res<bool>;
    /// `mapColumns` on a number column (called on present values only).
    /// `NaN` for a gap: pond-ts stores a result of the wrong type as one.
    fn map_number(&self, k: usize, v: f64) -> Res<f64>;
    /// `mapColumns` on a text column; `None` for a gap.
    fn map_string(&self, k: usize, v: &str) -> Res<Option<String>>;
    /// `mapColumns` on a true/false column; `None` for a gap.
    fn map_boolean(&self, k: usize, v: bool) -> Res<Option<bool>>;
    /// A value the caller passed as is (`scan`'s initial accumulator).
    fn value(&self, k: usize) -> Res<Self::Acc>;
    /// One `scan` step: `(acc, value, index) => [acc, output]`.
    fn scan(&self, k: usize, acc: Self::Acc, v: f64, i: usize) -> Res<(Self::Acc, f64)>;
    /// `collapse`: the output cell for row `row` of `s` (`None` for a gap).
    fn collapse(&self, k: usize, s: &TimeSeries, row: usize) -> Res<Option<Scalar>>;
    /// `asInterval(fn)`: the label for row `i`, whose extent is
    /// `[begin, end]`.
    fn label(&self, k: usize, begin: i64, end: i64, i: usize) -> Res<Label>;
}

/// No functions: every call to one fails. For callers that pass none.
pub struct NoCallbacks;

impl Callbacks for NoCallbacks {
    type Acc = ();
    fn test(&self, _: usize, _: &TimeSeries, _: usize) -> Res<bool> {
        Err(NONE.into())
    }
    fn map_number(&self, _: usize, _: f64) -> Res<f64> {
        Err(NONE.into())
    }
    fn map_string(&self, _: usize, _: &str) -> Res<Option<String>> {
        Err(NONE.into())
    }
    fn map_boolean(&self, _: usize, _: bool) -> Res<Option<bool>> {
        Err(NONE.into())
    }
    fn value(&self, _: usize) -> Res<()> {
        Err(NONE.into())
    }
    fn scan(&self, _: usize, _: (), _: f64, _: usize) -> Res<((), f64)> {
        Err(NONE.into())
    }
    fn collapse(&self, _: usize, _: &TimeSeries, _: usize) -> Res<Option<Scalar>> {
        Err(NONE.into())
    }
    fn label(&self, _: usize, _: i64, _: i64, _: usize) -> Res<Label> {
        Err(NONE.into())
    }
}

const NONE: &str = "this call passed no functions";

/// The first error a function gave during one pond-rs call.
#[derive(Default)]
struct Failure(Mutex<Option<String>>);

impl Failure {
    fn failed(&self) -> bool {
        self.0.lock().is_ok_and(|e| e.is_some())
    }
    /// `r`'s value, or `fallback` (remembering the error) if it failed.
    fn keep<T>(&self, r: Res<T>, fallback: impl FnOnce() -> T) -> T {
        r.unwrap_or_else(|e| {
            if let Ok(mut first) = self.0.lock() {
                first.get_or_insert(e);
            }
            fallback()
        })
    }
    /// The remembered error if there is one, else pond-rs's result.
    fn finish<T>(self, r: pond_rs::Result<T>) -> Res<T> {
        match self.0.into_inner().ok().flatten() {
            Some(e) => Err(e),
            None => pond(r),
        }
    }
}

/// `{"fn": k}`: the position of a function argument.
pub fn fn_ref(v: &Value) -> Option<usize> {
    v.get("fn")?.as_u64().map(|k| k as usize)
}

/// `{"expr": tree}`: an expression argument, read from its JSON tree.
pub fn expr_ref(v: &Value) -> Option<Res<Expr>> {
    v.get("expr").map(|tree| pond(Expr::from_value(tree)))
}

fn function(a: &Args, i: usize) -> Res<usize> {
    fn_ref(a.get(i)).ok_or_else(|| a.bad(i, "a function"))
}

/// The ops this module runs, for [`crate::dispatch::OPS`].
pub const OPS: &[&str] = &[
    "filter",
    "find",
    "some",
    "every",
    "mapColumns",
    "scan",
    "collapse",
    "at",
    "bisect",
    "includesKey",
    "atOrBefore",
    "atOrAfter",
    "nearest",
    "overlaps",
    "contains",
    "intersection",
    "timeRange",
];

fn span(k: Option<EventKey>) -> Outcome {
    Outcome::Span(k.map(|k| (k.begin(), k.end())))
}

/// One of [`OPS`] (or `asInterval` with a function), or `None` for any
/// other call.
pub(crate) fn call<C: Callbacks>(input: &TimeSeries, a: &Args, cb: &C) -> Option<Res<Outcome>> {
    let row = |r: Option<pond_rs::Row<'_>>| Outcome::Row(r.map(|r| r.index()));
    let key = || event_key(a.get(0));
    Some(match a.op {
        "at" => a.whole(0, "a row position").map(|i| row(input.at(i))),
        "bisect" => key().map(|k| Outcome::Number(input.bisect(k) as f64)),
        "includesKey" => key().map(|k| Outcome::Bool(input.includes_key(k))),
        "atOrBefore" => key().map(|k| row(input.at_or_before(k))),
        "atOrAfter" => key().map(|k| row(input.at_or_after(k))),
        "nearest" => key().map(|k| row(input.nearest(k))),
        "overlaps" => key().map(|k| Outcome::Bool(input.overlaps(k))),
        "contains" => key().map(|k| Outcome::Bool(input.contains(k))),
        "intersection" => key().map(|k| span(input.intersection(k))),
        "timeRange" => Ok(span(input.time_range())),
        "filter" => tests(input, a, cb),
        "find" | "some" | "every" => tests(input, a, cb),
        "mapColumns" => map_columns(input, a, cb),
        "scan" => scan(input, a, cb).map(Outcome::Series),
        "collapse" => collapse(input, a, cb),
        "asInterval" if fn_ref(a.get(0)).is_some() => as_interval(input, a, cb),
        _ => return None,
    })
}

fn tests<C: Callbacks>(input: &TimeSeries, a: &Args, cb: &C) -> Res<Outcome> {
    if let Some(e) = expr_ref(a.get(0)) {
        let e = e?;
        return match a.op {
            "filter" => pond(input.filter_expr(&e)).map(Outcome::Series),
            "find" => pond(input.find_expr(&e)).map(|r| Outcome::Row(r.map(|r| r.index()))),
            "some" => pond(input.some_expr(&e)).map(Outcome::Bool),
            _ => pond(input.every_expr(&e)).map(Outcome::Bool),
        };
    }
    let k = function(a, 0)?;
    let failure = Failure::default();
    // After a failure the function is not called again, and the answer
    // given stops `find` / `some` / `every` at once.
    let stop = a.op != "every";
    let test = |r: &pond_rs::Row<'_>| -> pond_rs::Result<bool> {
        if failure.failed() {
            return Ok(stop);
        }
        Ok(failure.keep(cb.test(k, input, r.index()), || stop))
    };
    match a.op {
        "filter" => {
            let r = input.filter(|r| test(r).map(|keep| keep && !failure.failed()));
            failure.finish(r).map(Outcome::Series)
        }
        "find" => {
            let r = input.find(test).map(|r| r.map(|r| r.index()));
            failure.finish(r).map(Outcome::Row)
        }
        "some" => {
            let r = input.some(test);
            failure.finish(r).map(Outcome::Bool)
        }
        _ => {
            let r = input.every(test);
            failure.finish(r).map(Outcome::Bool)
        }
    }
}

fn map_columns<C: Callbacks>(input: &TimeSeries, a: &Args, cb: &C) -> Res<Outcome> {
    let Some(spec) = a.get(0).as_object() else {
        return Err(a.bad(0, "a mapping { column: function or expression }"));
    };
    if spec.is_empty() {
        return Err("mapColumns() requires at least one column".into());
    }
    // Expressions read the columns as they were before any mapping (as
    // pond-ts), so they run first, on the input; each function reads only
    // its own column, which no expression touched.
    let mut exprs = Vec::new();
    for (column, f) in spec {
        if let Some(e) = expr_ref(f) {
            exprs.push((column.as_str(), e?));
        }
    }
    let mut out = if exprs.is_empty() {
        input.clone()
    } else {
        let pairs: Vec<(&str, &Expr)> = exprs.iter().map(|(c, e)| (*c, e)).collect();
        pond(input.map_exprs(&pairs))?
    };
    let failure = Failure::default();
    for (column, f) in spec {
        if f.get("expr").is_some() {
            continue;
        }
        let k = fn_ref(f).ok_or_else(|| {
            format!("mapColumns: '{column}' must map to a function or expression")
        })?;
        let kind = out
            .schema()
            .into_iter()
            .find(|d| &d.name == column)
            .map(|d| d.kind);
        let r = match kind {
            Some(ColumnKind::String) => {
                let mapped = out.column(column).and_then(|c| c.strings()).map(|values| {
                    values
                        .iter()
                        .map(|v| {
                            let v = v?;
                            if failure.failed() {
                                return None;
                            }
                            failure.keep(cb.map_string(k, v), || None)
                        })
                        .collect::<Vec<Option<String>>>()
                });
                mapped.and_then(|m| replace(&out, column, m.into()))
            }
            Some(ColumnKind::Boolean) => {
                let mapped = out.column(column).and_then(|c| c.booleans()).map(|values| {
                    values
                        .iter()
                        .map(|v| {
                            let v = v?;
                            if failure.failed() {
                                return None;
                            }
                            failure.keep(cb.map_boolean(k, v), || None)
                        })
                        .collect::<Vec<Option<bool>>>()
                });
                mapped.and_then(|m| replace(&out, column, m.into()))
            }
            Some(ColumnKind::Array) => {
                return Err(format!(
                    "mapColumns: array column '{column}' is not supported by @pond-ts/rs yet"
                ));
            }
            // Numbers, and unknown names (pond-rs names the error).
            _ => out.map_numbers(column, |v| {
                if failure.failed() {
                    return f64::NAN;
                }
                failure.keep(cb.map_number(k, v), || f64::NAN)
            }),
        };
        if failure.failed() {
            return failure.finish(r).map(Outcome::Series);
        }
        out = pond(r)?;
    }
    Ok(Outcome::Series(out))
}

/// `s` with column `name` holding `data` instead, in the same place. It
/// stays required if it was and `data` has no gaps (as pond-rs's own
/// `map_*`; pond-ts keeps it required either way: [PND-MAPREQ]).
fn replace(s: &TimeSeries, name: &str, data: pond_rs::ColumnData) -> pond_rs::Result<TimeSeries> {
    let at = s.columns().iter().position(|c| c.name() == name);
    let Some(at) = at else {
        return s.column(name).map(|_| s.clone());
    };
    let required = s.columns()[at].is_required() && data.missing_count() == 0;
    let column = if required {
        pond_rs::Column::required(name, data)
    } else {
        pond_rs::Column::optional(name, data)
    };
    // `select` keeps the series' order, so rebuild from the columns before.
    let before: Vec<&str> = s.columns()[..at].iter().map(|c| c.name()).collect();
    let mut out = s.select(&before)?.with_column(column)?;
    for c in &s.columns()[at + 1..] {
        out = out.with_column(c.clone())?;
    }
    Ok(out)
}

/// `scan` on a series or a partitioned view.
pub trait Scan: Sized {
    fn scan_any<A: Clone + Send + Sync>(
        &self,
        column: &str,
        output: Option<&str>,
        init: A,
        step: impl Fn(A, f64, usize) -> (A, f64) + Send + Sync,
    ) -> pond_rs::Result<Self>;
}

impl Scan for TimeSeries {
    fn scan_any<A: Clone + Send + Sync>(
        &self,
        column: &str,
        output: Option<&str>,
        init: A,
        step: impl Fn(A, f64, usize) -> (A, f64) + Send + Sync,
    ) -> pond_rs::Result<Self> {
        match output {
            None => self.scan(column, init, step),
            Some(name) => self.scan_to(column, name, init, step),
        }
    }
}

impl Scan for PartitionedSeries {
    fn scan_any<A: Clone + Send + Sync>(
        &self,
        column: &str,
        output: Option<&str>,
        init: A,
        step: impl Fn(A, f64, usize) -> (A, f64) + Send + Sync,
    ) -> pond_rs::Result<Self> {
        match output {
            None => self.scan(column, init, step),
            Some(name) => self.scan_to(column, name, init, step),
        }
    }
}

/// pond-ts `scan(column, step, init, { output })`.
pub(crate) fn scan<T: Scan, C: Callbacks>(input: &T, a: &Args, cb: &C) -> Res<T> {
    let column = a.str(0, "a column name")?;
    let k = function(a, 1)?;
    let init = cb.value(function(a, 2)?)?;
    let output = a.options(3)?["output"].as_str();
    let failure = Failure::default();
    let fallback = init.clone();
    let r = input.scan_any(column, output, init, |acc, v, i| {
        if failure.failed() {
            return (acc, f64::NAN);
        }
        failure.keep(cb.scan(k, acc, v, i), || (fallback.clone(), f64::NAN))
    });
    failure.finish(r)
}

fn collapse<C: Callbacks>(input: &TimeSeries, a: &Args, cb: &C) -> Res<Outcome> {
    let columns = a.names(0)?;
    let output = a.str(1, "an output column name")?;
    let k = function(a, 2)?;
    let append = a.options(3)?["append"] == Value::Bool(true);
    let failure = Failure::default();
    let f = |r: &pond_rs::Row<'_>| -> pond_rs::Result<Option<Scalar>> {
        if failure.failed() {
            return Ok(None);
        }
        Ok(failure.keep(cb.collapse(k, input, r.index()), || None))
    };
    let r = if append {
        input.collapse_keep(&columns, output, f)
    } else {
        input.collapse(&columns, output, f)
    };
    failure.finish(r).map(Outcome::Series)
}

fn as_interval<C: Callbacks>(input: &TimeSeries, a: &Args, cb: &C) -> Res<Outcome> {
    let k = function(a, 0)?;
    let failure = Failure::default();
    let r = input.as_interval_with(|range, i| -> Label {
        if failure.failed() {
            return Label::from("");
        }
        failure.keep(cb.label(k, range.begin(), range.end(), i), || {
            Label::from("")
        })
    });
    failure.finish(r).map(Outcome::Series)
}
