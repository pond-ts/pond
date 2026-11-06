//! `pond_rs.Row`: one row of a series, handed to Python functions and
//! returned by lookups.

use std::sync::Arc;

use pond_rs::{Key, Labels, TimeSeries};
use pyo3::exceptions::PyKeyError;
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList, PyTuple};

use crate::convert::cell_to_py;

/// One row of a series: `row["cpu"]` reads a cell (`None` for a gap),
/// `row.index` is its position, `row.begin` / `row.end` its key's edges
/// in epoch milliseconds (equal for a time key).
#[pyclass(name = "Row", module = "pond_rs", frozen)]
pub struct PyRow {
    pub series: Arc<TimeSeries>,
    pub index: usize,
}

impl PyRow {
    fn cell<'py>(&self, py: Python<'py>, column: &str) -> PyResult<Option<Bound<'py, PyAny>>> {
        match self.series.columns().iter().find(|c| c.name() == column) {
            Some(c) => Ok(Some(cell_to_py(py, c.data(), self.index)?)),
            None => Ok(None),
        }
    }
}

#[pymethods]
impl PyRow {
    /// The row's position in its series.
    #[getter]
    fn index(&self) -> usize {
        self.index
    }

    /// The key's start (its time, for a time key), epoch milliseconds.
    #[getter]
    fn begin(&self) -> i64 {
        self.series.key().begin()[self.index]
    }

    /// The key's end (its time, for a time key), epoch milliseconds.
    #[getter]
    fn end(&self) -> i64 {
        match self.series.key().end() {
            Some(e) => e[self.index],
            None => self.begin(),
        }
    }

    /// The key as the lookups take it: a time, `(begin, end)`, or
    /// `(label, begin, end)`.
    #[getter]
    fn key<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let i = self.index;
        Ok(match self.series.key() {
            Key::Time(t) => t[i].into_pyobject(py)?.into_any(),
            Key::TimeRange(k) => (k.begin[i], k.end[i]).into_pyobject(py)?.into_any(),
            Key::Interval(k) => {
                let label = match &k.label {
                    Labels::Number(v) => v[i].into_pyobject(py)?.into_any(),
                    Labels::String(s) => s.get(i).into_pyobject(py)?.into_any(),
                };
                PyTuple::new(
                    py,
                    [
                        label,
                        k.begin[i].into_pyobject(py)?.into_any(),
                        k.end[i].into_pyobject(py)?.into_any(),
                    ],
                )?
                .into_any()
            }
        })
    }

    fn __getitem__<'py>(&self, py: Python<'py>, column: &str) -> PyResult<Bound<'py, PyAny>> {
        self.cell(py, column)?
            .ok_or_else(|| PyKeyError::new_err(column.to_string()))
    }

    /// The cell in `column`, or `default` when there is no such column.
    #[pyo3(signature = (column, default=None))]
    fn get<'py>(
        &self,
        py: Python<'py>,
        column: &str,
        default: Option<Bound<'py, PyAny>>,
    ) -> PyResult<Bound<'py, PyAny>> {
        Ok(match self.cell(py, column)? {
            Some(v) => v,
            None => default.unwrap_or_else(|| py.None().into_bound(py)),
        })
    }

    /// The value column names.
    fn keys<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyList>> {
        PyList::new(py, self.series.columns().iter().map(|c| c.name()))
    }

    /// `{column: cell}` for every value column.
    fn to_dict<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyDict>> {
        let d = PyDict::new(py);
        for c in self.series.columns() {
            d.set_item(c.name(), cell_to_py(py, c.data(), self.index)?)?;
        }
        Ok(d)
    }

    fn __repr__(&self, py: Python<'_>) -> PyResult<String> {
        Ok(format!(
            "Row(index={}, key={}, {})",
            self.index,
            self.key(py)?.repr()?,
            self.to_dict(py)?.repr()?
        ))
    }
}
