//! `pond_rs.ValueSeries`: rows keyed by a number axis.

use std::sync::Arc;

use pond_rs::{KeyOrder, RowFormat, ValueSeries};
use pyo3::prelude::*;
use pyo3::types::{PyCapsule, PyList};

use crate::arrow_io;
use crate::convert::{IntoPy, column_to_py, err, value_error};

/// A series keyed by a number axis instead of time (a distance, a strike
/// price), from `TimeSeries.by_value(axis)`. The axis never goes down.
#[pyclass(name = "ValueSeries", module = "pond_rs", frozen)]
pub struct PyValueSeries {
    pub inner: Arc<ValueSeries>,
}

impl PyValueSeries {
    pub fn wrap(s: ValueSeries) -> Self {
        PyValueSeries { inner: Arc::new(s) }
    }
}

fn order(word: &str) -> PyResult<KeyOrder> {
    match word {
        "strict" => Ok(KeyOrder::Strict),
        "reorder" => Ok(KeyOrder::Reorder),
        "clamp" => Ok(KeyOrder::Clamp),
        other => Err(value_error(format!(
            "order must be 'strict', 'reorder' or 'clamp', got '{other}'"
        ))),
    }
}

#[pymethods]
impl PyValueSeries {
    /// Read pond's JSON row format for a value series.
    #[staticmethod]
    #[pyo3(signature = (text, *, order="strict"))]
    fn from_json(py: Python<'_>, text: &str, order: &str) -> PyResult<Self> {
        let o = self::order(order)?;
        py.detach(|| ValueSeries::from_json(text, o))
            .map(Self::wrap)
            .map_err(err)
    }

    /// Read pond's column-oriented JSON for a value series.
    #[staticmethod]
    #[pyo3(signature = (text, *, order="strict"))]
    fn from_columns_json(py: Python<'_>, text: &str, order: &str) -> PyResult<Self> {
        let o = self::order(order)?;
        py.detach(|| ValueSeries::from_columns_json(text, o))
            .map(Self::wrap)
            .map_err(err)
    }

    /// Build from Arrow data, keyed by the number column `axis`.
    #[staticmethod]
    #[pyo3(signature = (data, axis, *, name="series"))]
    fn from_arrow(
        py: Python<'_>,
        data: &Bound<'_, PyAny>,
        axis: &str,
        name: &str,
    ) -> PyResult<Self> {
        let batches = arrow_io::batches(data)?;
        py.detach(|| ValueSeries::from_arrow(name, &batches, axis))
            .map(Self::wrap)
            .map_err(err)
    }

    #[getter]
    fn name(&self) -> &str {
        self.inner.name()
    }

    /// The axis column's name.
    #[getter]
    fn axis_name(&self) -> &str {
        self.inner.axis_name()
    }

    /// The axis values.
    fn axis(&self) -> Vec<f64> {
        self.inner.axis().to_vec()
    }

    /// Every column, axis first, as `{"name", "kind", "required"}`.
    #[getter]
    fn schema<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyList>> {
        crate::series::schema_list(py, self.inner.schema())
    }

    /// The value column names.
    #[getter]
    fn columns(&self) -> Vec<&str> {
        self.inner.columns().iter().map(|c| c.name()).collect()
    }

    /// One value column as a list (`None` for a gap).
    fn column<'py>(&self, py: Python<'py>, name: &str) -> PyResult<Bound<'py, PyList>> {
        column_to_py(py, self.inner.column(name).py_err()?.data())
    }

    fn __len__(&self) -> usize {
        self.inner.len()
    }

    fn __repr__(&self) -> String {
        format!(
            "ValueSeries('{}', {} rows, axis '{}')",
            self.inner.name(),
            self.inner.len(),
            self.inner.axis_name()
        )
    }

    /// The row whose axis value is nearest `value`, or `None` when empty.
    fn nearest_index(&self, value: f64) -> Option<usize> {
        self.inner.nearest_index(value)
    }

    /// The rows with axis values in `[lo, hi]`.
    fn slice_by_value(&self, lo: f64, hi: f64) -> Self {
        Self::wrap(self.inner.slice_by_value(lo, hi))
    }

    /// pond's JSON row format; `row_format` is `"array"` or `"object"`.
    #[pyo3(signature = (row_format="array"))]
    fn to_json(&self, row_format: &str) -> PyResult<String> {
        let f = match row_format {
            "array" => RowFormat::Array,
            "object" => RowFormat::Object,
            other => {
                return Err(value_error(format!(
                    "row_format must be 'array' or 'object', got '{other}'"
                )));
            }
        };
        self.inner.to_json(f).py_err()
    }

    /// pond's column-oriented JSON.
    fn to_columns_json(&self) -> PyResult<String> {
        self.inner.to_columns_json().py_err()
    }

    #[pyo3(signature = (requested_schema=None))]
    fn __arrow_c_stream__<'py>(
        &self,
        py: Python<'py>,
        requested_schema: Option<Bound<'py, PyAny>>,
    ) -> PyResult<Bound<'py, PyCapsule>> {
        let _ = requested_schema;
        let batch = py.detach(|| self.inner.to_arrow()).py_err()?;
        arrow_io::stream_capsule(py, batch)
    }

    /// As a `pyarrow.Table`.
    fn to_pyarrow<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let batch = py.detach(|| self.inner.to_arrow()).py_err()?;
        arrow_io::to_pyarrow(py, batch)
    }

    /// As a `polars.DataFrame`.
    fn to_polars<'py>(slf: &Bound<'py, Self>) -> PyResult<Bound<'py, PyAny>> {
        arrow_io::to_polars(slf.py(), slf.as_any())
    }

    /// As a `pandas.DataFrame` (through pyarrow).
    fn to_pandas<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let batch = py.detach(|| self.inner.to_arrow()).py_err()?;
        arrow_io::to_pandas(py, batch)
    }
}
