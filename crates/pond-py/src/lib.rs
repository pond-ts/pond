//! Python bindings for pond-rs: the `pond_rs` module.
//!
//! Frames come in and go out as Arrow (pyarrow, polars and pandas all speak
//! it), so a column with no gaps crosses without being copied. Every
//! pond-rs call runs with Python's global lock released; a Python function
//! passed in (a filter, a scan step) takes the lock back while it runs.

#![allow(clippy::too_many_arguments)] // keyword options map one to one

mod arrow_io;
mod calendar;
mod callback;
mod convert;
mod live;
mod partition;
mod row;
mod sequence;
mod series;
mod shared;
mod study;
mod value_series;

use pyo3::prelude::*;

// The allocator matters more than anything else for round trips through
// Arrow: the bridges plan probe measured 44-49 ms with the system allocator
// against 14-17 ms with mimalloc for the same 4-column frame. A Python
// extension, unlike a Rust library, can choose its process's allocator for
// its own memory.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

mod errors {
    pyo3::create_exception!(
        pond_rs,
        PondError,
        pyo3::exceptions::PyValueError,
        "An error from pond-rs: bad input data, an unknown column, a column of the wrong kind, a bad duration or reducer name. The message names the call and the column."
    );
}
pub use errors::PondError as PondErrorPy;

/// Parse a time written as text to epoch milliseconds, as pond-ts's
/// `Time.parse` does. Text without an offset is read in `time_zone`
/// (UTC when not given).
#[pyfunction]
#[pyo3(signature = (text, time_zone=None))]
fn parse_time(py: Python<'_>, text: &str, time_zone: Option<&str>) -> PyResult<i64> {
    let text = text.to_string();
    let zone = time_zone.map(str::to_string);
    py.detach(move || match zone {
        Some(z) => ::pond_rs::parse_time_in(&text, &z),
        None => ::pond_rs::parse_time(&text),
    })
    .map_err(convert::err)
}

/// Parse a duration (`"500ms"`, `"5s"`, `"5m"`, `"1h"`, `"1d"`) to whole
/// milliseconds.
#[pyfunction]
fn parse_duration(text: &str) -> PyResult<i64> {
    ::pond_rs::parse_duration(text).map_err(convert::err)
}

#[pymodule]
fn pond_rs(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("__version__", env!("CARGO_PKG_VERSION"))?;
    m.add("PondError", m.py().get_type::<PondErrorPy>())?;
    m.add_function(wrap_pyfunction!(parse_time, m)?)?;
    m.add_function(wrap_pyfunction!(parse_duration, m)?)?;
    m.add_class::<series::PyTimeSeries>()?;
    m.add_class::<partition::PyPartitionedSeries>()?;
    m.add_class::<sequence::PySequence>()?;
    m.add_class::<row::PyRow>()?;
    m.add_class::<value_series::PyValueSeries>()?;
    m.add_class::<calendar::PyTradingCalendar>()?;
    m.add_function(wrap_pyfunction!(study::studies, m)?)?;
    m.add_function(wrap_pyfunction!(study::study_info, m)?)?;
    live::register(m)?;
    m.add("tzdb_version", ::pond_rs::tzdb_version())?;
    Ok(())
}
