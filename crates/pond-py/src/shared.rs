//! The operations a series and a partitioned series both have, with the
//! same Python signature. [`shared_methods!`] writes them once for each
//! class.

use pond_rs::{
    Agg, Align, AlignMethod, Change, Fill, FillLimits, FirstRow, Keep, Materialize,
    PartitionedSeries, Pick, Reducer, Rolling, RollingOver, Sample, Sequence, Smooth, TimeSeries,
};
use pyo3::exceptions::PyTypeError;
use pyo3::prelude::*;
use pyo3::types::{PyBool, PyDict, PyInt, PyString, PyTuple};

use crate::callback::Callback;
use crate::convert::{alignment, duration, value, value_error};

/// One pond-rs method per shared operation, the same on both types.
pub trait Ops: Sized + Sync {
    fn rolling_with(&self, w: &str, a: &[Agg], o: Rolling) -> pond_rs::Result<Self>;
    fn rolling_rows(&self, n: usize, a: &[Agg], o: Rolling) -> pond_rs::Result<Self>;
    fn rolling_over(
        &self,
        s: &Sequence,
        w: &str,
        a: &[Agg],
        o: RollingOver,
    ) -> pond_rs::Result<Self>;
    fn aggregate(&self, s: &Sequence, a: &[Agg]) -> pond_rs::Result<Self>;
    fn diff_with(&self, c: &[&str], o: Change) -> pond_rs::Result<Self>;
    fn rate_with(&self, c: &[&str], o: Change) -> pond_rs::Result<Self>;
    fn pct_change_with(&self, c: &[&str], o: Change) -> pond_rs::Result<Self>;
    fn shift(&self, c: &[&str], n: i64) -> pond_rs::Result<Self>;
    fn cumulative(&self, spec: &[(&str, Reducer)]) -> pond_rs::Result<Self>;
    fn fill_with(&self, spec: &[(&str, Fill)], l: &FillLimits) -> pond_rs::Result<Self>;
    fn fill_all_with(&self, f: Fill, l: &FillLimits) -> pond_rs::Result<Self>;
    fn align(&self, s: &Sequence, o: Align) -> pond_rs::Result<Self>;
    fn materialize(&self, s: &Sequence, o: Materialize) -> pond_rs::Result<Self>;
    fn dedupe(&self, k: Keep) -> pond_rs::Result<Self>;
    fn smooth(&self, c: &str, s: &Smooth) -> pond_rs::Result<Self>;
    fn baseline(&self, c: &str, w: &str, sigma: f64, o: Rolling) -> pond_rs::Result<Self>;
    fn baseline_named(
        &self,
        c: &str,
        w: &str,
        sigma: f64,
        o: Rolling,
        n: [&str; 4],
    ) -> pond_rs::Result<Self>;
    fn outliers(&self, c: &str, w: &str, sigma: f64, o: Rolling) -> pond_rs::Result<Self>;
    fn scan_any(
        &self,
        c: &str,
        output: Option<&str>,
        init: Acc,
        step: &Callback,
    ) -> pond_rs::Result<Self>;
    fn sample(&self, how: Sample) -> pond_rs::Result<Self>;
}

macro_rules! impl_ops {
    ($t:ty) => {
        impl Ops for $t {
            fn rolling_with(&self, w: &str, a: &[Agg], o: Rolling) -> pond_rs::Result<Self> {
                <$t>::rolling_with(self, w, a, o)
            }
            fn rolling_rows(&self, n: usize, a: &[Agg], o: Rolling) -> pond_rs::Result<Self> {
                <$t>::rolling_rows(self, n, a, o)
            }
            fn rolling_over(
                &self,
                s: &Sequence,
                w: &str,
                a: &[Agg],
                o: RollingOver,
            ) -> pond_rs::Result<Self> {
                <$t>::rolling_over(self, s, w, a, o)
            }
            fn aggregate(&self, s: &Sequence, a: &[Agg]) -> pond_rs::Result<Self> {
                <$t>::aggregate(self, s, a)
            }
            fn diff_with(&self, c: &[&str], o: Change) -> pond_rs::Result<Self> {
                <$t>::diff_with(self, c, o)
            }
            fn rate_with(&self, c: &[&str], o: Change) -> pond_rs::Result<Self> {
                <$t>::rate_with(self, c, o)
            }
            fn pct_change_with(&self, c: &[&str], o: Change) -> pond_rs::Result<Self> {
                <$t>::pct_change_with(self, c, o)
            }
            fn shift(&self, c: &[&str], n: i64) -> pond_rs::Result<Self> {
                <$t>::shift(self, c, n)
            }
            fn cumulative(&self, spec: &[(&str, Reducer)]) -> pond_rs::Result<Self> {
                <$t>::cumulative(self, spec)
            }
            fn fill_with(&self, spec: &[(&str, Fill)], l: &FillLimits) -> pond_rs::Result<Self> {
                <$t>::fill_with(self, spec, l)
            }
            fn fill_all_with(&self, f: Fill, l: &FillLimits) -> pond_rs::Result<Self> {
                <$t>::fill_all_with(self, f, l)
            }
            fn align(&self, s: &Sequence, o: Align) -> pond_rs::Result<Self> {
                <$t>::align(self, s, o)
            }
            fn materialize(&self, s: &Sequence, o: Materialize) -> pond_rs::Result<Self> {
                <$t>::materialize(self, s, o)
            }
            fn dedupe(&self, k: Keep) -> pond_rs::Result<Self> {
                <$t>::dedupe(self, k)
            }
            fn smooth(&self, c: &str, s: &Smooth) -> pond_rs::Result<Self> {
                <$t>::smooth(self, c, s)
            }
            fn baseline(&self, c: &str, w: &str, sigma: f64, o: Rolling) -> pond_rs::Result<Self> {
                <$t>::baseline(self, c, w, sigma, o)
            }
            fn baseline_named(
                &self,
                c: &str,
                w: &str,
                sigma: f64,
                o: Rolling,
                n: [&str; 4],
            ) -> pond_rs::Result<Self> {
                <$t>::baseline_named(self, c, w, sigma, o, n)
            }
            fn outliers(&self, c: &str, w: &str, sigma: f64, o: Rolling) -> pond_rs::Result<Self> {
                <$t>::outliers(self, c, w, sigma, o)
            }
            fn scan_any(
                &self,
                c: &str,
                output: Option<&str>,
                init: Acc,
                cb: &Callback,
            ) -> pond_rs::Result<Self> {
                let step = |acc: Acc, v: f64, i: usize| scan_step(cb, acc, v, i);
                match output {
                    None => <$t>::scan(self, c, init, step),
                    Some(o) => <$t>::scan_to(self, c, o, init, step),
                }
            }
            fn sample(&self, how: Sample) -> pond_rs::Result<Self> {
                <$t>::sample(self, how)
            }
        }
    };
}

impl_ops!(TimeSeries);
impl_ops!(PartitionedSeries);

/// A scan's running state: a Python object. Cloning (once per partition,
/// on any thread) takes the lock to bump its count.
pub struct Acc(pub Option<Py<PyAny>>);

impl Clone for Acc {
    fn clone(&self) -> Self {
        Acc(self
            .0
            .as_ref()
            .map(|p| Python::attach(|py| p.clone_ref(py))))
    }
}

fn scan_step(cb: &Callback, acc: Acc, v: f64, i: usize) -> (Acc, f64) {
    cb.run(|py, f| {
        let state = match &acc.0 {
            Some(p) => p.bind(py).clone(),
            None => py.None().into_bound(py),
        };
        let out = f.call1((state, v, i))?;
        let pair = out
            .cast::<PyTuple>()
            .map_err(|_| PyTypeError::new_err("a scan step returns (state, output)"))?;
        if pair.len() != 2 {
            return Err(PyTypeError::new_err("a scan step returns (state, output)"));
        }
        let output = pair.get_item(1)?;
        let output = if output.is_none() {
            f64::NAN
        } else {
            output.extract::<f64>()?
        };
        Ok((Acc(Some(pair.get_item(0)?.unbind())), output))
    })
    .unwrap_or((Acc(None), f64::NAN))
}

// ---------------------------------------------------------------------------
// Option builders shared by both classes
// ---------------------------------------------------------------------------

pub fn rolling_options(align: &str, min_samples: usize, append: bool) -> PyResult<Rolling> {
    Ok(Rolling {
        alignment: alignment(align)?,
        min_samples,
        append,
    })
}

pub fn change(drop_first: bool, output: Option<&str>) -> Change {
    let mut c = Change::default();
    if drop_first {
        c = c.first(FirstRow::Drop);
    }
    if let Some(o) = output {
        c = c.output(o);
    }
    c
}

pub fn fill_strategy(obj: &Bound<'_, PyAny>) -> PyResult<Fill> {
    if let Ok(text) = obj.cast::<PyString>() {
        return Ok(match text.to_cow()?.as_ref() {
            "hold" => Fill::Hold,
            "bfill" => Fill::Bfill,
            "linear" => Fill::Linear,
            "zero" => Fill::Zero,
            other => Fill::Value(pond_rs::Value::String(other.to_string())),
        });
    }
    Ok(Fill::Value(value(obj, "fill")?))
}

pub fn fill_limits(
    limit: Option<usize>,
    max_gap: Option<&Bound<'_, PyAny>>,
) -> PyResult<FillLimits> {
    let mut l = FillLimits::none();
    if let Some(n) = limit {
        l = l.limit(n);
    }
    if let Some(g) = max_gap {
        l = l.max_gap(&duration(g, "fill max_gap")?);
    }
    Ok(l)
}

pub fn align_method(word: &str) -> PyResult<AlignMethod> {
    match word {
        "hold" => Ok(AlignMethod::Hold),
        "linear" => Ok(AlignMethod::Linear),
        other => Err(value_error(format!(
            "method must be 'hold' or 'linear', got '{other}'"
        ))),
    }
}

pub fn pick(word: &str) -> PyResult<Pick> {
    match word {
        "first" => Ok(Pick::First),
        "last" => Ok(Pick::Last),
        "nearest" => Ok(Pick::Nearest),
        other => Err(value_error(format!(
            "pick must be 'first', 'last' or 'nearest', got '{other}'"
        ))),
    }
}

/// `keep`: `"first"`, `"last"`, `"error"`, `"drop"`, or `("min", column)`
/// / `("max", column)`.
pub fn keep(obj: &Bound<'_, PyAny>) -> PyResult<Keep> {
    if let Ok(t) = obj.cast::<PyTuple>()
        && t.len() == 2
    {
        let how: String = t.get_item(0)?.extract()?;
        let column: String = t.get_item(1)?.extract()?;
        return match how.as_str() {
            "min" => Ok(Keep::Min(column)),
            "max" => Ok(Keep::Max(column)),
            other => Err(value_error(format!(
                "keep (how, column): how must be 'min' or 'max', got '{other}'"
            ))),
        };
    }
    match obj.extract::<String>()?.as_str() {
        "first" => Ok(Keep::First),
        "last" => Ok(Keep::Last),
        "error" => Ok(Keep::Error),
        "drop" => Ok(Keep::Drop),
        other => Err(value_error(format!(
            "keep must be 'first', 'last', 'error', 'drop', ('min', column) or ('max', column), got '{other}'"
        ))),
    }
}

pub fn smooth_options(
    method: &str,
    alpha: Option<f64>,
    span: Option<f64>,
    window: Option<&Bound<'_, PyAny>>,
    warmup: Option<usize>,
    min_samples: Option<usize>,
    align: Option<&str>,
    missing: &str,
    output: Option<&str>,
) -> PyResult<Smooth> {
    let mut s = match method {
        "ema" => match (alpha, span) {
            (Some(a), None) => Smooth::ema(a),
            (None, Some(s)) => Smooth::ema_span(s),
            _ => return Err(value_error("ema needs exactly one of alpha or span")),
        },
        "moving_average" | "movingAverage" => match window {
            Some(w) => Smooth::moving_average(&duration(w, "smooth window")?),
            None => return Err(value_error("moving_average needs a window")),
        },
        "loess" => match span {
            Some(s) => Smooth::loess(s),
            None => return Err(value_error("loess needs a span")),
        },
        other => {
            return Err(value_error(format!(
                "method must be 'ema', 'moving_average' or 'loess', got '{other}'"
            )));
        }
    };
    if let Some(n) = warmup {
        s = s.warmup(n);
    }
    if let Some(n) = min_samples {
        s = s.min_samples(n);
    }
    if let Some(a) = align {
        s = s.alignment(alignment(a)?);
    }
    match missing {
        "bridge" => {}
        "skip" => s = s.skip_missing(),
        other => {
            return Err(value_error(format!(
                "missing must be 'bridge' or 'skip', got '{other}'"
            )));
        }
    }
    if let Some(o) = output {
        s = s.output(o);
    }
    Ok(s)
}

/// `baseline(names=…)`: `{"avg", "sd", "upper", "lower"}` (any subset) or
/// a 4-tuple in that order.
pub fn baseline_names(obj: &Bound<'_, PyAny>) -> PyResult<[String; 4]> {
    let default = ["avg", "sd", "upper", "lower"];
    if let Ok(d) = obj.cast::<PyDict>() {
        let mut out = default.map(str::to_string);
        for (k, v) in d.iter() {
            let k: String = k.extract()?;
            let slot = default.iter().position(|d| *d == k).ok_or_else(|| {
                value_error(format!(
                    "baseline names: unknown key '{k}' (expected avg, sd, upper, lower)"
                ))
            })?;
            out[slot] = v.extract()?;
        }
        return Ok(out);
    }
    let v: Vec<String> = obj.extract()?;
    v.try_into()
        .map_err(|_| value_error("baseline names: give 4 names (avg, sd, upper, lower)"))
}

pub fn sample_how(stride: Option<usize>, reservoir: Option<usize>, seed: u64) -> PyResult<Sample> {
    match (stride, reservoir) {
        (Some(n), None) => Ok(Sample::Stride(n)),
        (None, Some(size)) => Ok(Sample::Reservoir { size, seed }),
        _ => Err(value_error(
            "sample takes exactly one of stride= or reservoir=",
        )),
    }
}

/// A rolling window: an `int` is a count of rows, anything else a duration.
pub enum Window {
    Rows(usize),
    Span(String),
}

pub fn window(obj: &Bound<'_, PyAny>) -> PyResult<Window> {
    if obj.is_instance_of::<PyInt>() && !obj.is_instance_of::<PyBool>() {
        return Ok(Window::Rows(obj.extract()?));
    }
    Ok(Window::Span(duration(obj, "rolling window")?))
}

/// The shared methods as one `#[pymethods]` block for `$py` (a class with
/// an `inner: Arc<$rs>` field and a `wrap` constructor).
macro_rules! shared_methods {
    ($py:ty) => {
        #[pymethods]
        impl $py {
            /// Reduce a window around each row. `window` is a duration
            /// (`"5m"`, a `timedelta`) or a count of rows (an `int`).
            /// `aggs` maps each output column to a reducer: `{"avg": ("cpu",
            /// "avg")}`, or `{"cpu": "avg"}` to reduce a column into
            /// itself. With `over` (a sequence or step), the window is
            /// evaluated once per grid point instead of once per row.
            #[pyo3(signature = (window, aggs, *, alignment="trailing", min_samples=0, append=false, over=None, sample="begin", range=None))]
            fn rolling(
                &self,
                py: Python<'_>,
                window: &Bound<'_, PyAny>,
                aggs: &Bound<'_, PyAny>,
                alignment: &str,
                min_samples: usize,
                append: bool,
                over: Option<&Bound<'_, PyAny>>,
                sample: &str,
                range: Option<&Bound<'_, PyAny>>,
            ) -> PyResult<Self> {
                let aggs = crate::convert::aggs(aggs)?;
                let options = crate::shared::rolling_options(alignment, min_samples, append)?;
                let w = crate::shared::window(window)?;
                let inner = &*self.inner;
                let out = if let Some(over) = over {
                    if append {
                        return Err(crate::convert::value_error(
                            "rolling: append cannot be used with over",
                        ));
                    }
                    let seq = crate::convert::sequence(over)?;
                    let crate::shared::Window::Span(w) = w else {
                        return Err(crate::convert::value_error(
                            "rolling over a sequence takes a duration window, not a row count",
                        ));
                    };
                    let o = pond_rs::RollingOver {
                        alignment: options.alignment,
                        min_samples,
                        sample: crate::convert::at(sample, "sample")?,
                        range: crate::convert::range(range)?,
                    };
                    py.detach(|| crate::shared::Ops::rolling_over(inner, &seq, &w, &aggs, o))
                } else {
                    match w {
                        crate::shared::Window::Rows(n) => py.detach(|| {
                            crate::shared::Ops::rolling_rows(inner, n, &aggs, options)
                        }),
                        crate::shared::Window::Span(w) => py.detach(|| {
                            crate::shared::Ops::rolling_with(inner, &w, &aggs, options)
                        }),
                    }
                };
                out.map(Self::wrap).map_err(crate::convert::err)
            }

            /// Reduce the rows in each bucket of `sequence` (a `Sequence`,
            /// or a step such as `"1m"`). One row per bucket, keyed by the
            /// bucket as an interval.
            fn aggregate(
                &self,
                py: Python<'_>,
                sequence: &Bound<'_, PyAny>,
                aggs: &Bound<'_, PyAny>,
            ) -> PyResult<Self> {
                let seq = crate::convert::sequence(sequence)?;
                let aggs = crate::convert::aggs(aggs)?;
                let inner = &*self.inner;
                py.detach(|| crate::shared::Ops::aggregate(inner, &seq, &aggs))
                    .map(Self::wrap)
                    .map_err(crate::convert::err)
            }

            /// Change from the previous row, per column.
            #[pyo3(signature = (columns, *, drop_first=false, output=None))]
            fn diff(&self, py: Python<'_>, columns: &Bound<'_, PyAny>, drop_first: bool, output: Option<&str>) -> PyResult<Self> {
                let names = crate::convert::names(columns)?;
                let o = crate::shared::change(drop_first, output);
                let inner = &*self.inner;
                py.detach(|| crate::shared::Ops::diff_with(inner, &crate::convert::refs(&names), o))
                    .map(Self::wrap).map_err(crate::convert::err)
            }

            /// Change from the previous row per second.
            #[pyo3(signature = (columns, *, drop_first=false, output=None))]
            fn rate(&self, py: Python<'_>, columns: &Bound<'_, PyAny>, drop_first: bool, output: Option<&str>) -> PyResult<Self> {
                let names = crate::convert::names(columns)?;
                let o = crate::shared::change(drop_first, output);
                let inner = &*self.inner;
                py.detach(|| crate::shared::Ops::rate_with(inner, &crate::convert::refs(&names), o))
                    .map(Self::wrap).map_err(crate::convert::err)
            }

            /// Fractional change from the previous row.
            #[pyo3(signature = (columns, *, drop_first=false, output=None))]
            fn pct_change(&self, py: Python<'_>, columns: &Bound<'_, PyAny>, drop_first: bool, output: Option<&str>) -> PyResult<Self> {
                let names = crate::convert::names(columns)?;
                let o = crate::shared::change(drop_first, output);
                let inner = &*self.inner;
                py.detach(|| crate::shared::Ops::pct_change_with(inner, &crate::convert::refs(&names), o))
                    .map(Self::wrap).map_err(crate::convert::err)
            }

            /// Move column values `n` rows later (earlier when negative).
            fn shift(&self, py: Python<'_>, columns: &Bound<'_, PyAny>, n: i64) -> PyResult<Self> {
                let names = crate::convert::names(columns)?;
                let inner = &*self.inner;
                py.detach(|| crate::shared::Ops::shift(inner, &crate::convert::refs(&names), n))
                    .map(Self::wrap).map_err(crate::convert::err)
            }

            /// Running reductions: `{"cpu": "sum"}`.
            fn cumulative(&self, py: Python<'_>, spec: &Bound<'_, PyAny>) -> PyResult<Self> {
                let spec = crate::convert::column_reducers(spec)?;
                let spec: Vec<(&str, pond_rs::Reducer)> = spec.iter().map(|(c, r)| (c.as_str(), *r)).collect();
                let inner = &*self.inner;
                py.detach(|| crate::shared::Ops::cumulative(inner, &spec))
                    .map(Self::wrap).map_err(crate::convert::err)
            }

            /// Fill gaps. `strategy` is `"hold"`, `"bfill"`, `"linear"`,
            /// `"zero"` or a value, for every column; or a mapping
            /// `{column: strategy}`.
            #[pyo3(signature = (strategy, *, limit=None, max_gap=None))]
            fn fill(&self, py: Python<'_>, strategy: &Bound<'_, PyAny>, limit: Option<usize>, max_gap: Option<&Bound<'_, PyAny>>) -> PyResult<Self> {
                let limits = crate::shared::fill_limits(limit, max_gap)?;
                let inner = &*self.inner;
                if let Ok(map) = strategy.cast::<pyo3::types::PyDict>() {
                    let spec = map.iter()
                        .map(|(c, s)| Ok((c.extract::<String>()?, crate::shared::fill_strategy(&s)?)))
                        .collect::<PyResult<Vec<_>>>()?;
                    let spec: Vec<(&str, pond_rs::Fill)> = spec.iter().map(|(c, f)| (c.as_str(), f.clone())).collect();
                    return py.detach(|| crate::shared::Ops::fill_with(inner, &spec, &limits))
                        .map(Self::wrap).map_err(crate::convert::err);
                }
                let f = crate::shared::fill_strategy(strategy)?;
                py.detach(|| crate::shared::Ops::fill_all_with(inner, f, &limits))
                    .map(Self::wrap).map_err(crate::convert::err)
            }

            /// Values at each point of a grid, holding or interpolating.
            #[pyo3(signature = (sequence, *, method="hold", sample="begin", range=None))]
            fn align(&self, py: Python<'_>, sequence: &Bound<'_, PyAny>, method: &str, sample: &str, range: Option<&Bound<'_, PyAny>>) -> PyResult<Self> {
                let seq = crate::convert::sequence(sequence)?;
                let o = pond_rs::Align {
                    method: crate::shared::align_method(method)?,
                    sample: crate::convert::at(sample, "sample")?,
                    range: crate::convert::range(range)?,
                };
                let inner = &*self.inner;
                py.detach(|| crate::shared::Ops::align(inner, &seq, o))
                    .map(Self::wrap).map_err(crate::convert::err)
            }

            /// One row per grid bucket, picked from the rows inside it.
            #[pyo3(signature = (sequence, *, pick="last", sample="begin", range=None))]
            fn materialize(&self, py: Python<'_>, sequence: &Bound<'_, PyAny>, pick: &str, sample: &str, range: Option<&Bound<'_, PyAny>>) -> PyResult<Self> {
                let seq = crate::convert::sequence(sequence)?;
                let o = pond_rs::Materialize {
                    pick: crate::shared::pick(pick)?,
                    sample: crate::convert::at(sample, "sample")?,
                    range: crate::convert::range(range)?,
                };
                let inner = &*self.inner;
                py.detach(|| crate::shared::Ops::materialize(inner, &seq, o))
                    .map(Self::wrap).map_err(crate::convert::err)
            }

            /// One row per key: `keep` is `"first"`, `"last"`, `"error"`,
            /// `"drop"`, `("min", column)` or `("max", column)`.
            #[pyo3(signature = (keep=None))]
            fn dedupe(&self, py: Python<'_>, keep: Option<&Bound<'_, PyAny>>) -> PyResult<Self> {
                let k = match keep {
                    Some(k) => crate::shared::keep(k)?,
                    None => pond_rs::Keep::Last,
                };
                let inner = &*self.inner;
                py.detach(|| crate::shared::Ops::dedupe(inner, k))
                    .map(Self::wrap).map_err(crate::convert::err)
            }

            /// Smooth one column: `method` is `"ema"` (with `alpha` or
            /// `span`), `"moving_average"` (with `window`) or `"loess"`
            /// (with `span`, a fraction of the rows).
            #[pyo3(signature = (column, method, *, alpha=None, span=None, window=None, warmup=None, min_samples=None, alignment=None, missing="bridge", output=None))]
            fn smooth(&self, py: Python<'_>, column: &str, method: &str, alpha: Option<f64>, span: Option<f64>, window: Option<&Bound<'_, PyAny>>, warmup: Option<usize>, min_samples: Option<usize>, alignment: Option<&str>, missing: &str, output: Option<&str>) -> PyResult<Self> {
                let s = crate::shared::smooth_options(method, alpha, span, window, warmup, min_samples, alignment, missing, output)?;
                let inner = &*self.inner;
                py.detach(|| crate::shared::Ops::smooth(inner, column, &s))
                    .map(Self::wrap).map_err(crate::convert::err)
            }

            /// Rolling mean and standard deviation of `column`, with bands
            /// `sigma` deviations either side. Adds `avg`, `sd`, `upper`,
            /// `lower` (rename them with `names`).
            #[pyo3(signature = (column, window, sigma, *, alignment="trailing", min_samples=0, names=None))]
            fn baseline(&self, py: Python<'_>, column: &str, window: &Bound<'_, PyAny>, sigma: f64, alignment: &str, min_samples: usize, names: Option<&Bound<'_, PyAny>>) -> PyResult<Self> {
                let w = crate::convert::duration(window, "baseline window")?;
                let o = crate::shared::rolling_options(alignment, min_samples, false)?;
                let inner = &*self.inner;
                match names {
                    None => py.detach(|| crate::shared::Ops::baseline(inner, column, &w, sigma, o)),
                    Some(n) => {
                        let n = crate::shared::baseline_names(n)?;
                        let refs = [n[0].as_str(), n[1].as_str(), n[2].as_str(), n[3].as_str()];
                        py.detach(|| crate::shared::Ops::baseline_named(inner, column, &w, sigma, o, refs))
                    }
                }
                .map(Self::wrap).map_err(crate::convert::err)
            }

            /// The rows of `column` more than `sigma` rolling deviations
            /// from the rolling mean.
            #[pyo3(signature = (column, window, sigma, *, alignment="trailing", min_samples=0))]
            fn outliers(&self, py: Python<'_>, column: &str, window: &Bound<'_, PyAny>, sigma: f64, alignment: &str, min_samples: usize) -> PyResult<Self> {
                let w = crate::convert::duration(window, "outliers window")?;
                let o = crate::shared::rolling_options(alignment, min_samples, false)?;
                let inner = &*self.inner;
                py.detach(|| crate::shared::Ops::outliers(inner, column, &w, sigma, o))
                    .map(Self::wrap).map_err(crate::convert::err)
            }

            /// A running fold over `column`: `step(state, value, index)`
            /// returns `(state, output)`, starting from `init`. The outputs
            /// replace the column (or go to `output`); an output of `None`
            /// is a gap.
            #[pyo3(signature = (column, step, init, *, output=None))]
            fn scan(&self, py: Python<'_>, column: &str, step: &Bound<'_, PyAny>, init: &Bound<'_, PyAny>, output: Option<&str>) -> PyResult<Self> {
                let cb = crate::callback::Callback::new(step)?;
                let init = crate::shared::Acc(Some(init.clone().unbind()));
                let inner = &*self.inner;
                let out = py.detach(|| crate::shared::Ops::scan_any(inner, column, output, init, &cb));
                cb.finish(out).map(Self::wrap)
            }

            /// Keep every `stride`-th row, or a random `reservoir` of rows
            /// (the same rows for the same `seed`).
            #[pyo3(signature = (*, stride=None, reservoir=None, seed=0))]
            fn sample(&self, py: Python<'_>, stride: Option<usize>, reservoir: Option<usize>, seed: u64) -> PyResult<Self> {
                let how = crate::shared::sample_how(stride, reservoir, seed)?;
                let inner = &*self.inner;
                py.detach(|| crate::shared::Ops::sample(inner, how))
                    .map(Self::wrap).map_err(crate::convert::err)
            }
        }
    };
}

pub(crate) use shared_methods;
