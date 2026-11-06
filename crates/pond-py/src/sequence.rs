//! `pond_rs.Sequence`: the grid `aggregate`, `align`, `materialize` and
//! `rolling(over=…)` work on.

use pond_rs::Sequence;
use pyo3::prelude::*;
use pyo3::types::PyList;

use crate::convert::{IntoPy, duration, time_ms};

/// A grid of buckets: fixed-length steps (`Sequence.every("5m")`) or
/// calendar units in a time zone (`Sequence.calendar("day",
/// "America/New_York")`). Methods that take a sequence also take a step
/// such as `"1m"` or a `timedelta`, meaning `Sequence.every(step)`.
#[pyclass(name = "Sequence", module = "pond_rs", frozen)]
pub struct PySequence {
    pub inner: Sequence,
}

#[pymethods]
impl PySequence {
    /// Fixed-length buckets of `step` (`"5m"` or a `timedelta`), starting
    /// at `anchor` (a time; epoch 0 when not given).
    #[staticmethod]
    #[pyo3(signature = (step, *, anchor=None))]
    fn every(step: &Bound<'_, PyAny>, anchor: Option<&Bound<'_, PyAny>>) -> PyResult<Self> {
        let mut inner = Sequence::every(&duration(step, "Sequence.every")?).py_err()?;
        if let Some(a) = anchor {
            inner = inner.with_anchor(time_ms(a, "Sequence.every anchor")?);
        }
        Ok(PySequence { inner })
    }

    /// Calendar buckets (`"minute"`, `"hour"`, `"day"`, `"week"`,
    /// `"month"`, `"quarter"`, `"year"`) in an IANA time zone, so a day
    /// is 23 or 25 hours when the clocks change. Weeks start on Monday
    /// unless `week_starts_on` (1 = Monday … 7 = Sunday) says otherwise.
    #[staticmethod]
    #[pyo3(signature = (unit, time_zone="UTC", *, week_starts_on=None))]
    fn calendar(unit: &str, time_zone: &str, week_starts_on: Option<i8>) -> PyResult<Self> {
        let mut inner = Sequence::calendar(unit, time_zone).py_err()?;
        if let Some(day) = week_starts_on {
            inner = inner.with_week_start(day).py_err()?;
        }
        Ok(PySequence { inner })
    }

    /// Every bucket overlapping `[begin, end]`, as `(begin, end)` pairs of
    /// epoch milliseconds.
    fn buckets<'py>(
        &self,
        py: Python<'py>,
        begin: &Bound<'py, PyAny>,
        end: &Bound<'py, PyAny>,
    ) -> PyResult<Bound<'py, PyList>> {
        let (b, e) = (time_ms(begin, "buckets")?, time_ms(end, "buckets")?);
        let keys = py
            .detach(|| self.inner.buckets_overlapping(b, e))
            .py_err()?;
        PyList::new(py, keys.begin.iter().zip(&keys.end).map(|(b, e)| (*b, *e)))
    }

    fn __repr__(&self) -> String {
        format!("{:?}", self.inner)
    }
}
