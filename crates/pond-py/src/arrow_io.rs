//! Frames in and out through Arrow's C interface.
//!
//! In: anything with `__arrow_c_stream__` (pyarrow tables, polars frames,
//! pandas 2.2+ frames, DuckDB results, …) or `__arrow_c_array__` (a pyarrow
//! record batch). The buffers stay where Python put them: pond-rs reads a
//! gap-free float column of a one-chunk table in place.
//!
//! Out: a series is itself an Arrow stream (`__arrow_c_stream__`), so
//! `pyarrow.table(s)` and `polars.DataFrame(s)` take its buffers without a
//! copy; `to_pyarrow` / `to_polars` / `to_pandas` are shorthands.

use std::sync::Arc;

use arrow_array::ffi_stream::FFI_ArrowArrayStream;
use arrow_array::{RecordBatch, RecordBatchIterator, RecordBatchReader};
use arrow_pyarrow::{FromPyArrow, IntoPyArrow};
use pyo3::exceptions::PyTypeError;
use pyo3::prelude::*;
use pyo3::types::PyCapsule;

/// The record batches of an Arrow-speaking Python object.
pub fn batches(obj: &Bound<'_, PyAny>) -> PyResult<Vec<RecordBatch>> {
    if obj.hasattr("__arrow_c_stream__")? {
        let reader = arrow_array::ffi_stream::ArrowArrayStreamReader::from_pyarrow_bound(obj)?;
        let schema = reader.schema();
        let mut out = reader
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| crate::convert::value_error(format!("reading Arrow data: {e}")))?;
        // A table with no rows may arrive as no batches at all.
        if out.is_empty() {
            out.push(RecordBatch::new_empty(schema));
        }
        return Ok(out);
    }
    if obj.hasattr("__arrow_c_array__")? {
        return Ok(vec![RecordBatch::from_pyarrow_bound(obj)?]);
    }
    // Older polars and pandas have no capsule interface but convert.
    if obj.hasattr("to_arrow")? {
        return batches(&obj.call_method0("to_arrow")?);
    }
    let module: String = obj
        .get_type()
        .getattr("__module__")
        .and_then(|m| m.extract())
        .unwrap_or_default();
    if module.starts_with("pandas") {
        let pa = obj.py().import("pyarrow")?;
        return batches(&pa.getattr("Table")?.call_method1("from_pandas", (obj,))?);
    }
    Err(PyTypeError::new_err(format!(
        "expected Arrow data (a pyarrow Table or RecordBatch, a polars or pandas DataFrame, or anything with __arrow_c_stream__), got {}",
        obj.get_type().name()?
    )))
}

/// A record batch as an Arrow C stream capsule, which the receiver takes
/// ownership of.
pub fn stream_capsule<'py>(py: Python<'py>, batch: RecordBatch) -> PyResult<Bound<'py, PyCapsule>> {
    let schema = batch.schema();
    let reader: Box<dyn RecordBatchReader + Send> =
        Box::new(RecordBatchIterator::new(vec![Ok(batch)], schema));
    let stream = FFI_ArrowArrayStream::new(reader);
    PyCapsule::new_with_value(py, stream, c"arrow_array_stream")
}

/// A record batch as a `pyarrow.Table`.
pub fn to_pyarrow<'py>(py: Python<'py>, batch: RecordBatch) -> PyResult<Bound<'py, PyAny>> {
    let schema = batch.schema();
    let table = arrow_pyarrow::Table::try_new(vec![batch], Arc::clone(&schema))
        .map_err(|e| crate::convert::value_error(e.to_string()))?;
    table.into_pyarrow(py)
}

/// A record batch as a `polars.DataFrame` (through the C stream, so no
/// pyarrow needed).
pub fn to_polars<'py>(py: Python<'py>, owner: &Bound<'py, PyAny>) -> PyResult<Bound<'py, PyAny>> {
    let pl = py.import("polars")?;
    pl.getattr("DataFrame")?.call1((owner,))
}

/// A record batch as a `pandas.DataFrame` (through pyarrow).
pub fn to_pandas<'py>(py: Python<'py>, batch: RecordBatch) -> PyResult<Bound<'py, PyAny>> {
    to_pyarrow(py, batch)?.call_method0("to_pandas")
}
