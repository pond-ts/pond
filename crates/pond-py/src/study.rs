//! Financial studies through pond-rs's catalog: `series.study("rsi",
//! period=14)`, the named form `series.rsi(period=14)`, and
//! `pond_rs.studies()` describing every study.

use std::sync::Arc;

use pond_rs::financial::TradingCalendar;
use pond_rs::financial::catalog::{STUDIES, StudyAnchor, StudyDescriptor, StudyNaming};
use pond_rs::financial::{SessionAnchor, catalog::study_descriptor};
use pond_rs::serde_json::{Map, Number, Value};
use pond_rs::{PartitionedSeries, TimeSeries};
use pyo3::exceptions::{PyAttributeError, PyTypeError};
use pyo3::prelude::*;
use pyo3::types::{PyBool, PyDict, PyFloat, PyInt, PyList, PyString};

use crate::calendar::{PyTradingCalendar, session, session_to_py};
use crate::convert::{time_ms, value_error};

/// `anchored_vwap` to `anchoredVwap`: Python's spelling of a pond-ts name.
fn camel(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut upper = false;
    for c in name.chars() {
        if c == '_' {
            upper = true;
        } else if upper {
            out.extend(c.to_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// `anchoredVwap` to `anchored_vwap`.
pub fn snake(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 4);
    for c in name.chars() {
        if c.is_ascii_uppercase() {
            out.push('_');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// The study called `name`, in pond-ts's spelling or Python's.
pub fn descriptor(name: &str) -> Option<&'static StudyDescriptor> {
    study_descriptor(name).or_else(|| study_descriptor(&camel(name)))
}

/// Every option name the study reads, in pond-ts's spelling.
fn option_names(d: &StudyDescriptor) -> Vec<&'static str> {
    let mut names: Vec<&'static str> = d.inputs.iter().map(|i| i.role).collect();
    names.extend(d.params.iter().map(|p| p.name));
    names.push(match d.naming {
        StudyNaming::Output(_) => "output",
        StudyNaming::Prefix(_) => "prefix",
    });
    match d.anchor {
        Some(StudyAnchor::Session) => names.extend(["session", "sessions", "stamped"]),
        Some(StudyAnchor::Time) => names.push("anchor"),
        None => {}
    }
    // pond-ts takes a `close` on medianPrice and never reads it.
    if d.name == "medianPrice" {
        names.push("close");
    }
    names
}

/// A plain Python value as JSON: `None`, a bool, a number, text, or a
/// list or dict of them.
fn json(obj: &Bound<'_, PyAny>, what: &str) -> PyResult<Value> {
    if obj.is_none() {
        return Ok(Value::Null);
    }
    if let Ok(b) = obj.cast::<PyBool>() {
        return Ok(Value::Bool(b.is_true()));
    }
    if obj.is_instance_of::<PyInt>() {
        if let Ok(i) = obj.extract::<i64>() {
            return Ok(Value::from(i));
        }
        let f: f64 = obj.extract()?;
        return Ok(Value::from(f));
    }
    if obj.is_instance_of::<PyFloat>() {
        let f: f64 = obj.extract()?;
        return Number::from_f64(f)
            .map(Value::Number)
            .ok_or_else(|| value_error(format!("{what} must be a finite number; got {f}")));
    }
    if let Ok(s) = obj.cast::<PyString>() {
        return Ok(Value::String(s.to_cow()?.into_owned()));
    }
    if let Ok(d) = obj.cast::<PyDict>() {
        let mut m = Map::new();
        for (k, v) in d.iter() {
            m.insert(k.extract::<String>()?, json(&v, what)?);
        }
        return Ok(Value::Object(m));
    }
    if let Ok(l) = obj.cast::<PyList>() {
        return l.iter().map(|v| json(&v, what)).collect();
    }
    // numpy numbers and other number-like objects.
    if let Ok(f) = obj.extract::<f64>() {
        return Number::from_f64(f)
            .map(Value::Number)
            .ok_or_else(|| value_error(format!("{what} must be a finite number; got {f}")));
    }
    Err(PyTypeError::new_err(format!(
        "{what}: expected a number, text, bool or None, got {}",
        obj.get_type().name()?
    )))
}

/// A study call, ready to run on any series: the descriptor, its options
/// as pond-ts's JSON, and a calendar when `sessions=` was one.
pub struct StudyCall {
    d: &'static StudyDescriptor,
    options: Map<String, Value>,
    calendar: Option<Arc<TradingCalendar>>,
}

impl StudyCall {
    pub fn new(name: &str, options: Option<&Bound<'_, PyDict>>) -> PyResult<Self> {
        let d = descriptor(name).ok_or_else(|| {
            value_error(format!(
                "'{name}' is not a study; pond_rs.studies() lists them"
            ))
        })?;
        let known = option_names(d);
        let mut map = Map::new();
        let mut calendar = None;
        for (k, v) in options.into_iter().flat_map(|o| o.iter()) {
            let given: String = k.extract()?;
            let key = camel(&given);
            if !known.contains(&key.as_str()) {
                let mut names: Vec<String> = known.iter().map(|n| snake(n)).collect();
                names.sort();
                return Err(PyTypeError::new_err(format!(
                    "{}() got an unexpected option '{given}'; it takes {}",
                    snake(d.name),
                    names.join(", ")
                )));
            }
            let what = format!("{}: '{given}'", snake(d.name));
            let value = match key.as_str() {
                // A float stays a number (pond-ts rounds a fractional
                // anchor up); anything else is a time.
                "anchor" if !v.is_none() && !v.is_instance_of::<PyFloat>() => {
                    Value::from(time_ms(&v, &what)?)
                }
                "sessions" if v.is_instance_of::<PyTradingCalendar>() => {
                    let cal = v.cast::<PyTradingCalendar>()?;
                    calendar = Some(cal.get().inner.clone());
                    continue;
                }
                "sessions" if !v.is_none() => {
                    let list = v
                        .try_iter()?
                        .map(|s| {
                            let s = session(&s?)?;
                            let d = session_to_py(v.py(), &s)?;
                            json(d.as_any(), &what)
                        })
                        .collect::<PyResult<Vec<_>>>()?;
                    Value::Array(list)
                }
                _ => json(&v, &what)?,
            };
            map.insert(key, value);
        }
        Ok(StudyCall {
            d,
            options: map,
            calendar,
        })
    }

    pub fn run(&self, series: &TimeSeries) -> pond_rs::Result<TimeSeries> {
        match &self.calendar {
            Some(cal) => self
                .d
                .run_with(series, &self.options, SessionAnchor::from(&**cal)),
            None => self.d.run(series, &self.options),
        }
    }

    pub fn run_on<T: StudyTarget>(&self, target: &T) -> pond_rs::Result<T> {
        T::run_study(self, target)
    }
}

/// A series a study runs on: once, or once per partition.
pub trait StudyTarget: Sized {
    fn run_study(call: &StudyCall, target: &Self) -> pond_rs::Result<Self>;
}

impl StudyTarget for TimeSeries {
    fn run_study(call: &StudyCall, target: &Self) -> pond_rs::Result<Self> {
        call.run(target)
    }
}

impl StudyTarget for PartitionedSeries {
    fn run_study(call: &StudyCall, target: &Self) -> pond_rs::Result<Self> {
        target.map(|s| call.run(s))
    }
}

/// The catalog's JSON as Python objects.
fn to_py<'py>(py: Python<'py>, v: &Value) -> PyResult<Bound<'py, PyAny>> {
    py.import("json")?.call_method1("loads", (v.to_string(),))
}

/// Describe every study: name, family, summary, the columns it reads,
/// its options with defaults and ranges, and the columns it writes.
#[pyfunction]
pub fn studies<'py>(py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
    let all: Vec<Value> = STUDIES.iter().map(describe).collect();
    to_py(py, &Value::Array(all))
}

/// Describe one study (pond-ts's name or Python's: `"anchoredVwap"` or
/// `"anchored_vwap"`).
#[pyfunction]
pub fn study_info<'py>(py: Python<'py>, name: &str) -> PyResult<Bound<'py, PyAny>> {
    let d = descriptor(name).ok_or_else(|| {
        value_error(format!(
            "'{name}' is not a study; pond_rs.studies() lists them"
        ))
    })?;
    to_py(py, &describe(d))
}

/// The descriptor's JSON plus the Python method name.
fn describe(d: &StudyDescriptor) -> Value {
    let mut v = d.to_json();
    if let Value::Object(o) = &mut v {
        o.insert("method".into(), Value::from(snake(d.name)));
        o.insert("output_names".into(), Value::from(d.output_names()));
    }
    v
}

/// `series.rsi`: a study bound to its series, called with the options.
#[pyclass(module = "pond_rs", frozen)]
pub struct BoundStudy {
    target: Py<PyAny>,
    name: &'static str,
}

#[pymethods]
impl BoundStudy {
    #[pyo3(signature = (**options))]
    fn __call__<'py>(
        &self,
        py: Python<'py>,
        options: Option<&Bound<'py, PyDict>>,
    ) -> PyResult<Bound<'py, PyAny>> {
        self.target
            .bind(py)
            .call_method("study", (self.name,), options)
    }

    fn __repr__(&self) -> String {
        format!("<study {}>", snake(self.name))
    }

    #[getter]
    fn __doc__(&self) -> String {
        descriptor(self.name).map_or(String::new(), |d| d.summary.to_string())
    }
}

/// The attribute lookup both series classes fall back to: a study by its
/// Python name.
pub fn study_attribute(target: &Bound<'_, PyAny>, name: &str) -> PyResult<BoundStudy> {
    // Only Python spellings: `series.rsi`, `series.anchored_vwap`.
    match descriptor(name) {
        Some(d) if !name.starts_with('_') && snake(d.name) == name => Ok(BoundStudy {
            target: target.clone().unbind(),
            name: d.name,
        }),
        _ => Err(PyAttributeError::new_err(format!(
            "'{}' object has no attribute '{name}'",
            target.get_type().name()?
        ))),
    }
}

/// Every study's Python method name, for `dir()`.
pub fn study_methods() -> impl Iterator<Item = String> {
    STUDIES.iter().map(|d| snake(d.name))
}
