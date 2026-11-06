//! `pond_rs.TimeSeries`.

use std::sync::Arc;

use pond_rs::{
    ArrayOptions, ArrowKey, Bins, Column, ColumnData, ColumnDef, ColumnKind, IntervalKeys, Join,
    JoinType, JsonOptions, Key, KeyOrder, Labels, OnConflict, Pivot, RowFormat, Scalar,
    TimeRangeKeys, TimeSeries,
};
use pyo3::exceptions::{PyIndexError, PyTypeError};
use pyo3::prelude::*;
use pyo3::types::{PyBool, PyBytes, PyCapsule, PyDict, PyList, PySlice, PyString, PyTuple};

use crate::arrow_io;
use crate::callback::Callback;
use crate::convert::{
    IntoPy, aggs, at, column_kind, column_to_py, duration, err, event_key, label, names,
    partition_key_to_py, reducer, refs, scalar, scalars, signed_ms, time_ms, value_error,
};
use crate::partition::PyPartitionedSeries;
use crate::row::PyRow;
use crate::shared::shared_methods;
use crate::value_series::PyValueSeries;

/// A time series: a key column (times, time ranges or labelled intervals,
/// always in order) and value columns of numbers, exact decimals, text,
/// true/false values or arrays, any of which may have gaps.
///
/// Build one from a pyarrow Table, a polars or pandas DataFrame, or a dict
/// of columns: `TimeSeries(df, key="time")`. Get a frame back with
/// `to_pyarrow()`, `to_polars()` or `to_pandas()`, or hand the series
/// straight to `pyarrow.table(s)` / `polars.DataFrame(s)`.
///
/// Every operation returns a new series; none changes this one.
#[pyclass(name = "TimeSeries", module = "pond_rs", frozen)]
pub struct PyTimeSeries {
    pub inner: Arc<TimeSeries>,
}

impl PyTimeSeries {
    pub fn wrap(s: TimeSeries) -> Self {
        PyTimeSeries { inner: Arc::new(s) }
    }

    fn row(&self, index: usize) -> PyRow {
        PyRow {
            series: Arc::clone(&self.inner),
            index,
        }
    }

    fn rows_of(&self, r: Option<pond_rs::Row<'_>>) -> Option<PyRow> {
        r.map(|r| self.row(r.index()))
    }
}

fn key_kind(word: &str, key: &str) -> PyResult<ArrowKey> {
    match word {
        "time" => Ok(ArrowKey::Time(key.to_string())),
        "time_range" | "timeRange" => Ok(ArrowKey::TimeRange(key.to_string())),
        "interval" => Ok(ArrowKey::Interval(key.to_string())),
        other => Err(value_error(format!(
            "key_kind must be 'time', 'time_range' or 'interval', got '{other}'"
        ))),
    }
}

fn kind_word(kind: ColumnKind) -> &'static str {
    kind.as_str()
}

/// A Python list (or any iterable) as a column, its kind taken from the
/// first value that is not `None`. Required when it has no `None`.
fn column_from_values(name: &str, values: &Bound<'_, PyAny>) -> PyResult<Column> {
    let items: Vec<Bound<'_, PyAny>> = values.try_iter()?.collect::<PyResult<_>>()?;
    let what = format!("column '{name}'");
    let first = items.iter().find(|v| !v.is_none());
    let data: ColumnData = match first {
        None => items.iter().map(|_| None::<f64>).collect::<Vec<_>>().into(),
        Some(v) if v.is_instance_of::<PyBool>() => items
            .iter()
            .map(|v| {
                if v.is_none() {
                    Ok(None)
                } else {
                    v.extract::<bool>().map(Some)
                }
            })
            .collect::<PyResult<Vec<_>>>()?
            .into(),
        Some(v) if v.is_instance_of::<PyString>() => items
            .iter()
            .map(|v| {
                if v.is_none() {
                    Ok(None)
                } else {
                    v.extract::<String>().map(Some)
                }
            })
            .collect::<PyResult<Vec<_>>>()?
            .into(),
        Some(v) if v.is_instance_of::<PyList>() || v.is_instance_of::<PyTuple>() => items
            .iter()
            .map(|v| {
                if v.is_none() {
                    Ok(None)
                } else {
                    scalars(v, &what).map(Some)
                }
            })
            .collect::<PyResult<Vec<Option<Vec<Scalar>>>>>()?
            .into(),
        Some(_) => items
            .iter()
            .map(|v| {
                if v.is_none() {
                    Ok(None)
                } else {
                    v.extract::<f64>().map(Some).map_err(|_| {
                        PyTypeError::new_err(format!(
                            "{what}: mixes numbers with {}",
                            v.get_type()
                                .name()
                                .map(|n| n.to_string())
                                .unwrap_or_default()
                        ))
                    })
                }
            })
            .collect::<PyResult<Vec<_>>>()?
            .into(),
    };
    Ok(if items.iter().any(|v| v.is_none()) {
        Column::optional(name, data)
    } else {
        Column::required(name, data)
    })
}

/// A series from a dict `{key: times, column: values, …}`.
fn from_dict(name: &str, d: &Bound<'_, PyDict>, key: &str, kind: &str) -> PyResult<TimeSeries> {
    let key_values = d.get_item(key)?.ok_or_else(|| {
        value_error(format!(
            "no key column '{key}' in the dict (set key= to its name)"
        ))
    })?;
    let mut columns = Vec::new();
    for (k, v) in d.iter() {
        let k: String = k.extract()?;
        if k != key {
            columns.push(column_from_values(&k, &v)?);
        }
    }
    let keys: Vec<Bound<'_, PyAny>> = key_values.try_iter()?.collect::<PyResult<_>>()?;
    let part = |p: usize| -> PyResult<Vec<i64>> {
        keys.iter()
            .map(|k| {
                let t = k.cast::<PyTuple>().map_err(|_| {
                    value_error(format!(
                        "key '{key}': each key is a tuple for key_kind '{kind}'"
                    ))
                })?;
                time_ms(&t.get_item(p)?, key)
            })
            .collect()
    };
    let series = match kind {
        "time" => {
            let times = keys
                .iter()
                .map(|k| time_ms(k, key))
                .collect::<PyResult<_>>()?;
            TimeSeries::new(name, times, columns)
        }
        "time_range" | "timeRange" => {
            let k = TimeRangeKeys {
                begin: part(0)?,
                end: part(1)?,
            };
            TimeSeries::from_time_ranges(name, k, columns)
        }
        "interval" => {
            let labels = keys
                .iter()
                .map(|k| label(&k.cast::<PyTuple>()?.get_item(0)?, key))
                .collect::<PyResult<Vec<_>>>()?;
            let label: Labels = if labels
                .iter()
                .all(|l| matches!(l, pond_rs::Label::String(_)))
            {
                labels
                    .into_iter()
                    .map(|l| match l {
                        pond_rs::Label::String(s) => s,
                        pond_rs::Label::Number(_) => unreachable!(),
                    })
                    .collect::<Vec<_>>()
                    .into()
            } else {
                labels
                    .into_iter()
                    .map(|l| match l {
                        pond_rs::Label::Number(v) => Ok(v),
                        pond_rs::Label::String(_) => {
                            Err(value_error("interval labels are all numbers or all text"))
                        }
                    })
                    .collect::<PyResult<Vec<f64>>>()?
                    .into()
            };
            let k = IntervalKeys {
                label,
                begin: part(1)?,
                end: part(2)?,
            };
            TimeSeries::from_intervals(name, k, columns)
        }
        other => {
            return Err(value_error(format!(
                "key_kind must be 'time', 'time_range' or 'interval', got '{other}'"
            )));
        }
    };
    series.py_err()
}

fn key_order(word: &str) -> PyResult<KeyOrder> {
    match word {
        "strict" => Ok(KeyOrder::Strict),
        "reorder" => Ok(KeyOrder::Reorder),
        "clamp" => Ok(KeyOrder::Clamp),
        other => Err(value_error(format!(
            "order must be 'strict', 'reorder' or 'clamp', got '{other}'"
        ))),
    }
}

fn row_format(word: &str) -> PyResult<RowFormat> {
    match word {
        "array" => Ok(RowFormat::Array),
        "object" => Ok(RowFormat::Object),
        other => Err(value_error(format!(
            "row_format must be 'array' or 'object', got '{other}'"
        ))),
    }
}

fn join_options(how: &str, on_conflict: &str, prefixes: Option<Vec<String>>) -> PyResult<Join> {
    let how = match how {
        "outer" => JoinType::Outer,
        "inner" => JoinType::Inner,
        "left" => JoinType::Left,
        "right" => JoinType::Right,
        other => {
            return Err(value_error(format!(
                "how must be 'outer', 'inner', 'left' or 'right', got '{other}'"
            )));
        }
    };
    let on_conflict = match (on_conflict, prefixes) {
        ("error", None) => OnConflict::Error,
        ("prefix", Some(p)) => OnConflict::Prefix(p),
        ("prefix", None) => return Err(value_error("on_conflict='prefix' needs prefixes=[…]")),
        ("error", Some(_)) => {
            return Err(value_error(
                "prefixes= is only used with on_conflict='prefix'",
            ));
        }
        (other, _) => {
            return Err(value_error(format!(
                "on_conflict must be 'error' or 'prefix', got '{other}'"
            )));
        }
    };
    Ok(Join { how, on_conflict })
}

fn series_list(items: &Bound<'_, PyAny>) -> PyResult<Vec<Arc<TimeSeries>>> {
    items
        .try_iter()?
        .map(|s| Ok(Arc::clone(&s?.cast::<PyTimeSeries>()?.get().inner)))
        .collect()
}

pub fn schema_list(py: Python<'_>, schema: Vec<ColumnDef>) -> PyResult<Bound<'_, PyList>> {
    let items = schema
        .into_iter()
        .map(|d| {
            let e = PyDict::new(py);
            e.set_item("name", d.name)?;
            e.set_item("kind", kind_word(d.kind))?;
            e.set_item("required", d.required)?;
            Ok(e)
        })
        .collect::<PyResult<Vec<_>>>()?;
    PyList::new(py, items)
}

fn table_to_py<'py>(py: Python<'py>, table: &pond_rs::Table) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new(py);
    for c in table.columns() {
        d.set_item(c.name(), column_to_py(py, c.data())?)?;
    }
    Ok(d)
}

fn kind_to_column_kind(def: &Bound<'_, PyDict>) -> PyResult<ColumnDef> {
    let name: String = def
        .get_item("name")?
        .ok_or_else(|| value_error("a schema entry needs 'name'"))?
        .extract()?;
    let kind: String = def
        .get_item("kind")?
        .ok_or_else(|| value_error("a schema entry needs 'kind'"))?
        .extract()?;
    let kind = match kind.as_str() {
        "time" => ColumnKind::Time,
        "timeRange" | "time_range" => ColumnKind::TimeRange,
        "interval" => ColumnKind::Interval,
        other => column_kind(other)?,
    };
    let required = match def.get_item("required")? {
        Some(r) => r.extract()?,
        None => true,
    };
    Ok(if required {
        ColumnDef::required(name, kind)
    } else {
        ColumnDef::optional(name, kind)
    })
}

#[pymethods]
impl PyTimeSeries {
    /// Build a series from Arrow data (a pyarrow Table or RecordBatch, a
    /// polars or pandas DataFrame, or anything with `__arrow_c_stream__`)
    /// or from a dict of columns.
    ///
    /// `key` names the key column. `key_kind` is `"time"` (one column of
    /// times), `"time_range"` (`<key>` and `<key>End`) or `"interval"`
    /// (`<key>`, `<key>End` and `<key>Label`); in a dict, a time range key
    /// is a list of `(begin, end)` tuples and an interval key of
    /// `(label, begin, end)`. Every other column is a value column.
    ///
    /// Arrow key columns may be timestamps of any unit, dates, or integer
    /// epoch milliseconds; dict keys may be ints (milliseconds),
    /// datetimes (no time zone means UTC), dates or text. A gap-free
    /// float64 column of a one-chunk Arrow table is used in place, not
    /// copied.
    #[new]
    #[pyo3(signature = (data, *, name="series", key="time", key_kind="time"))]
    fn new(
        py: Python<'_>,
        data: &Bound<'_, PyAny>,
        name: &str,
        key: &str,
        key_kind: &str,
    ) -> PyResult<Self> {
        if let Ok(d) = data.cast::<PyDict>() {
            return from_dict(name, d, key, key_kind).map(Self::wrap);
        }
        let k = self::key_kind(key_kind, key)?;
        let batches = arrow_io::batches(data)?;
        py.detach(|| TimeSeries::from_arrow(name, &batches, k))
            .map(Self::wrap)
            .map_err(err)
    }

    /// Read an Arrow IPC file (Feather v2 / `.arrow`, or the stream
    /// format; compressed or not) from a path or from bytes.
    #[staticmethod]
    #[pyo3(signature = (source, *, name="series", key="time", key_kind="time"))]
    fn read_ipc(
        py: Python<'_>,
        source: &Bound<'_, PyAny>,
        name: &str,
        key: &str,
        key_kind: &str,
    ) -> PyResult<Self> {
        let k = self::key_kind(key_kind, key)?;
        let bytes: Vec<u8> = if let Ok(b) = source.cast::<PyBytes>() {
            b.as_bytes().to_vec()
        } else {
            let path: std::path::PathBuf = source.extract()?;
            std::fs::read(&path).map_err(|e| {
                pyo3::exceptions::PyOSError::new_err(format!("{}: {e}", path.display()))
            })?
        };
        py.detach(|| TimeSeries::from_ipc_bytes(name, bytes, k))
            .map(Self::wrap)
            .map_err(err)
    }

    /// Write the series as an Arrow IPC file to `path`, or return the
    /// file's bytes when no path is given.
    #[pyo3(signature = (path=None))]
    fn write_ipc<'py>(
        &self,
        py: Python<'py>,
        path: Option<std::path::PathBuf>,
    ) -> PyResult<Option<Bound<'py, PyBytes>>> {
        let mut bytes = Vec::new();
        py.detach(|| self.inner.write_ipc(&mut bytes)).py_err()?;
        match path {
            Some(p) => {
                std::fs::write(&p, &bytes).map_err(|e| {
                    pyo3::exceptions::PyOSError::new_err(format!("{}: {e}", p.display()))
                })?;
                Ok(None)
            }
            None => Ok(Some(PyBytes::new(py, &bytes))),
        }
    }

    /// Read pond's JSON row format (what pond-ts `toJSON` writes). Times
    /// written as text without an offset are read in `time_zone`.
    /// `order` is `"strict"` (rows out of order are an error),
    /// `"reorder"` or `"clamp"`.
    #[staticmethod]
    #[pyo3(signature = (text, *, time_zone=None, order="strict"))]
    fn from_json(
        py: Python<'_>,
        text: &str,
        time_zone: Option<&str>,
        order: &str,
    ) -> PyResult<Self> {
        let mut o = JsonOptions::new().order(key_order(order)?);
        if let Some(z) = time_zone {
            o = o.time_zone(z);
        }
        py.detach(|| TimeSeries::from_json(text, &o))
            .map(Self::wrap)
            .map_err(err)
    }

    /// pond's JSON row format; `row_format` is `"array"` or `"object"`.
    #[pyo3(signature = (row_format="array"))]
    fn to_json(&self, py: Python<'_>, row_format: &str) -> PyResult<String> {
        let f = self::row_format(row_format)?;
        py.detach(|| self.inner.to_json(f)).py_err()
    }

    /// Read pond's column-oriented JSON (pond-ts `toColumns`).
    #[staticmethod]
    #[pyo3(signature = (text, *, order="strict"))]
    fn from_columns_json(py: Python<'_>, text: &str, order: &str) -> PyResult<Self> {
        let o = key_order(order)?;
        py.detach(|| TimeSeries::from_columns_json(text, o))
            .map(Self::wrap)
            .map_err(err)
    }

    /// pond's column-oriented JSON (pond-ts `toColumns`).
    fn to_columns_json(&self, py: Python<'_>) -> PyResult<String> {
        py.detach(|| self.inner.to_columns_json()).py_err()
    }

    /// Read chart points (pond-ts `toPoints`) with a schema: a list of
    /// `{"name", "kind", "required"}`, the key first.
    #[staticmethod]
    fn from_points_json(
        py: Python<'_>,
        text: &str,
        name: &str,
        schema: &Bound<'_, PyAny>,
    ) -> PyResult<Self> {
        let schema = schema
            .try_iter()?
            .map(|d| kind_to_column_kind(d?.cast::<PyDict>()?))
            .collect::<PyResult<Vec<_>>>()?;
        py.detach(|| TimeSeries::from_points_json(text, name, &schema))
            .map(Self::wrap)
            .map_err(err)
    }

    /// Chart points (pond-ts `toPoints`).
    fn to_points_json(&self, py: Python<'_>) -> PyResult<String> {
        py.detach(|| self.inner.to_points_json()).py_err()
    }

    /// The series as an Arrow C stream, so `pyarrow.table(s)` and
    /// `polars.DataFrame(s)` read it without copying.
    #[pyo3(signature = (requested_schema=None))]
    fn __arrow_c_stream__<'py>(
        &self,
        py: Python<'py>,
        requested_schema: Option<Bound<'py, PyAny>>,
    ) -> PyResult<Bound<'py, PyCapsule>> {
        let _ = requested_schema; // pond-rs's own types are always given
        let batch = py.detach(|| self.inner.to_arrow()).py_err()?;
        arrow_io::stream_capsule(py, batch)
    }

    /// The series as a `pyarrow.Table`. Times are `timestamp[ms, UTC]`;
    /// a gap is a null.
    fn to_pyarrow<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let batch = py.detach(|| self.inner.to_arrow()).py_err()?;
        arrow_io::to_pyarrow(py, batch)
    }

    /// The series as a `polars.DataFrame` (no pyarrow needed).
    fn to_polars<'py>(slf: &Bound<'py, Self>) -> PyResult<Bound<'py, PyAny>> {
        arrow_io::to_polars(slf.py(), slf.as_any())
    }

    /// The series as a `pandas.DataFrame` (through pyarrow; this copies).
    fn to_pandas<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let batch = py.detach(|| self.inner.to_arrow()).py_err()?;
        arrow_io::to_pandas(py, batch)
    }

    /// The series' name.
    #[getter]
    fn name(&self) -> &str {
        self.inner.name()
    }

    /// The key column's name.
    #[getter]
    fn key_name(&self) -> &str {
        self.inner.key_name()
    }

    /// `"time"`, `"time_range"` or `"interval"`, the words the
    /// constructor's `key_kind` takes.
    #[getter]
    fn key_kind(&self) -> &'static str {
        match self.inner.key() {
            Key::Time(_) => "time",
            Key::TimeRange(_) => "time_range",
            Key::Interval(_) => "interval",
        }
    }

    /// The value column names, in order.
    #[getter]
    fn columns(&self) -> Vec<&str> {
        self.inner.columns().iter().map(|c| c.name()).collect()
    }

    /// Every column, key first, as `{"name", "kind", "required"}`.
    #[getter]
    fn schema<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyList>> {
        schema_list(py, self.inner.schema())
    }

    fn __len__(&self) -> usize {
        self.inner.len()
    }

    fn __repr__(&self) -> String {
        let cols: Vec<String> = self
            .inner
            .schema()
            .into_iter()
            .map(|d| {
                format!(
                    "{}: {}{}",
                    d.name,
                    kind_word(d.kind),
                    if d.required { "" } else { "?" }
                )
            })
            .collect();
        format!(
            "TimeSeries('{}', {} rows, [{}])",
            self.inner.name(),
            self.inner.len(),
            cols.join(", ")
        )
    }

    /// One value column as a list (`None` for a gap).
    fn column<'py>(&self, py: Python<'py>, name: &str) -> PyResult<Bound<'py, PyList>> {
        let c = self.inner.column(name).py_err()?;
        column_to_py(py, c.data())
    }

    /// Row `index`; negative counts from the end.
    fn __getitem__<'py>(
        &self,
        py: Python<'py>,
        index: &Bound<'py, PyAny>,
    ) -> PyResult<Bound<'py, PyAny>> {
        if let Ok(s) = index.cast::<PySlice>() {
            let start: Option<i64> = s.getattr("start")?.extract()?;
            let stop: Option<i64> = s.getattr("stop")?.extract()?;
            if !s.getattr("step")?.is_none() {
                return Err(value_error("a series slice takes no step"));
            }
            return Ok(Bound::new(py, self.slice(py, start, stop))?.into_any());
        }
        let i: i64 = index.extract()?;
        match self.inner.at(i) {
            Some(r) => Ok(Bound::new(py, self.row(r.index()))?.into_any()),
            None => Err(PyIndexError::new_err(format!(
                "row {i} out of range ({} rows)",
                self.inner.len()
            ))),
        }
    }

    fn __iter__(&self) -> RowIter {
        RowIter {
            series: Arc::clone(&self.inner),
            next: 0,
        }
    }

    /// Row `index` (negative counts from the end), or `None`.
    fn at(&self, index: i64) -> Option<PyRow> {
        self.rows_of(self.inner.at(index))
    }

    /// The first row, or `None` when empty.
    fn first(&self) -> Option<PyRow> {
        self.rows_of(self.inner.first())
    }

    /// The last row, or `None` when empty.
    fn last(&self) -> Option<PyRow> {
        self.rows_of(self.inner.last())
    }

    // --- lookups --------------------------------------------------------

    /// Where `key` would go to keep the keys in order (the first row not
    /// before it).
    fn bisect(&self, key: &Bound<'_, PyAny>) -> PyResult<usize> {
        Ok(self.inner.bisect(event_key(key, "bisect")?))
    }

    /// Whether some row has exactly this key.
    fn includes_key(&self, key: &Bound<'_, PyAny>) -> PyResult<bool> {
        Ok(self.inner.includes_key(event_key(key, "includes_key")?))
    }

    /// The last row at or before `key`, or `None`.
    fn at_or_before(&self, key: &Bound<'_, PyAny>) -> PyResult<Option<PyRow>> {
        Ok(self.rows_of(self.inner.at_or_before(event_key(key, "at_or_before")?)))
    }

    /// The first row at or after `key`, or `None`.
    fn at_or_after(&self, key: &Bound<'_, PyAny>) -> PyResult<Option<PyRow>> {
        Ok(self.rows_of(self.inner.at_or_after(event_key(key, "at_or_after")?)))
    }

    /// The row nearest `key` in time, or `None` when empty.
    fn nearest(&self, key: &Bound<'_, PyAny>) -> PyResult<Option<PyRow>> {
        Ok(self.rows_of(self.inner.nearest(event_key(key, "nearest")?)))
    }

    /// The first row for which `test(row)` is true, or `None`. `test` may
    /// be an `Expr` (`col("v") > 400`).
    fn find(&self, py: Python<'_>, test: &Bound<'_, PyAny>) -> PyResult<Option<PyRow>> {
        if let Some(e) = crate::expr::as_expr(test) {
            let found = py.detach(|| self.inner.find_expr(&e).map(|r| r.map(|r| r.index())));
            return Ok(found.map_err(err)?.map(|i| self.row(i)));
        }
        let cb = Callback::new(test)?;
        let me = Arc::clone(&self.inner);
        let found = self
            .inner
            .find(|r| row_test(&cb, &me, r))
            .map(|r| r.map(|r| r.index()));
        Ok(cb.finish(found)?.map(|i| self.row(i)))
    }

    /// Whether `test(row)` is true for some row (`test` may be an `Expr`).
    fn some(&self, py: Python<'_>, test: &Bound<'_, PyAny>) -> PyResult<bool> {
        if let Some(e) = crate::expr::as_expr(test) {
            return py.detach(|| self.inner.some_expr(&e)).map_err(err);
        }
        let cb = Callback::new(test)?;
        let me = Arc::clone(&self.inner);
        let out = self.inner.some(|r| row_test(&cb, &me, r));
        cb.finish(out)
    }

    /// Whether `test(row)` is true for every row (`test` may be an `Expr`).
    fn every(&self, py: Python<'_>, test: &Bound<'_, PyAny>) -> PyResult<bool> {
        if let Some(e) = crate::expr::as_expr(test) {
            return py.detach(|| self.inner.every_expr(&e)).map_err(err);
        }
        let cb = Callback::new(test)?;
        let me = Arc::clone(&self.inner);
        let out = self.inner.every(|r| row_test(&cb, &me, r));
        cb.finish(out)
    }

    /// The span from the first key's start to the last key's end, as
    /// `(begin, end)`, or `None` when empty.
    fn time_range<'py>(&self, py: Python<'py>) -> PyResult<Option<Bound<'py, PyAny>>> {
        self.inner
            .time_range()
            .map(|k| (k.begin(), k.end()).into_pyobject(py).map(|t| t.into_any()))
            .transpose()
    }

    /// Whether the series' span overlaps `key`.
    fn overlaps(&self, key: &Bound<'_, PyAny>) -> PyResult<bool> {
        Ok(self.inner.overlaps(event_key(key, "overlaps")?))
    }

    /// Whether the series' span contains `key`.
    fn contains(&self, key: &Bound<'_, PyAny>) -> PyResult<bool> {
        Ok(self.inner.contains(event_key(key, "contains")?))
    }

    /// The overlap of the series' span and `key` as `(begin, end)`, or
    /// `None`.
    fn intersection<'py>(
        &self,
        py: Python<'py>,
        key: &Bound<'py, PyAny>,
    ) -> PyResult<Option<Bound<'py, PyAny>>> {
        self.inner
            .intersection(event_key(key, "intersection")?)
            .map(|k| (k.begin(), k.end()).into_pyobject(py).map(|t| t.into_any()))
            .transpose()
    }

    // --- whole-series reductions ----------------------------------------

    /// Reduce the whole series to one value per output: `{"total":
    /// ("bytes", "sum")}` gives `{"total": …}`.
    fn reduce<'py>(
        &self,
        py: Python<'py>,
        aggs: &Bound<'py, PyAny>,
    ) -> PyResult<Bound<'py, PyDict>> {
        let aggs = self::aggs(aggs)?;
        let reduced = py.detach(|| self.inner.reduce(&aggs)).py_err()?;
        let d = PyDict::new(py);
        for c in reduced.columns() {
            d.set_item(c.name(), crate::convert::cell_to_py(py, c.data(), 0)?)?;
        }
        Ok(d)
    }

    // --- columns ----------------------------------------------------------

    /// Keep these value columns, in this order.
    #[pyo3(signature = (*columns))]
    fn select(&self, py: Python<'_>, columns: &Bound<'_, PyTuple>) -> PyResult<Self> {
        let mut names = Vec::new();
        for c in columns.iter() {
            names.extend(self::names(&c)?);
        }
        py.detach(|| self.inner.select(&refs(&names)))
            .map(Self::wrap)
            .map_err(err)
    }

    /// Rename value columns: `{"old": "new"}`.
    fn rename(&self, py: Python<'_>, mapping: &Bound<'_, PyDict>) -> PyResult<Self> {
        let pairs = mapping
            .iter()
            .map(|(a, b)| Ok((a.extract::<String>()?, b.extract::<String>()?)))
            .collect::<PyResult<Vec<_>>>()?;
        let pairs: Vec<(&str, &str)> = pairs
            .iter()
            .map(|(a, b)| (a.as_str(), b.as_str()))
            .collect();
        py.detach(|| self.inner.rename(&pairs))
            .map(Self::wrap)
            .map_err(err)
    }

    /// Add (or replace) a value column from a list, its kind taken from
    /// the values, or from an `Expr` (an optional column of the
    /// expression's kind; `fill` fills gaps here).
    fn with_column(&self, py: Python<'_>, name: &str, values: &Bound<'_, PyAny>) -> PyResult<Self> {
        if let Some(e) = crate::expr::as_expr(values) {
            return py
                .detach(|| self.inner.with_column_expr(name, &e))
                .map(Self::wrap)
                .map_err(err);
        }
        let column = column_from_values(name, values)?;
        py.detach(|| self.inner.with_column(column))
            .map(Self::wrap)
            .map_err(err)
    }

    /// Apply `f` to every value of `column` (gaps stay gaps). `f` takes
    /// and returns a float, a str, a bool or a list, as the column holds.
    ///
    /// `f` may be an `Expr` of the column's kind, which may read other
    /// columns: `map("v", col("v") / col("w"))`. A gap stays a gap.
    fn map(&self, py: Python<'_>, column: &str, f: &Bound<'_, PyAny>) -> PyResult<Self> {
        if let Some(e) = crate::expr::as_expr(f) {
            return py
                .detach(|| self.inner.map_expr(column, &e))
                .map(Self::wrap)
                .map_err(err);
        }
        let cb = Callback::new(f)?;
        let kind = self.inner.column(column).py_err()?.kind();
        let s = &*self.inner;
        let out = py.detach(|| match kind {
            ColumnKind::Number => s.map_numbers(column, |v| {
                cb.run(|_, f| {
                    let r = f.call1((v,))?;
                    Ok(if r.is_none() {
                        f64::NAN
                    } else {
                        r.extract::<f64>()?
                    })
                })
                .unwrap_or(f64::NAN)
            }),
            ColumnKind::String => s.map_strings(column, |v| {
                cb.run(|_, f| f.call1((v,))?.extract::<String>())
                    .unwrap_or_default()
            }),
            ColumnKind::Boolean => s.map_booleans(column, |v| {
                cb.run(|_, f| f.call1((v,))?.extract::<bool>()).unwrap_or(v)
            }),
            ColumnKind::Array => s.map_arrays(column, |v| {
                cb.run(|py, f| {
                    let items = v
                        .iter()
                        .map(|x| crate::convert::scalar_to_py(py, x))
                        .collect::<PyResult<Vec<_>>>()?;
                    scalars(&f.call1((PyList::new(py, items)?,))?, "map")
                })
                .unwrap_or_default()
            }),
            _ => Err(pond_rs::PondError::Unsupported {
                call: "map",
                message: format!("mapping a {} column from Python", kind.as_str()),
            }),
        });
        cb.finish(out).map(Self::wrap)
    }

    // --- keys ---------------------------------------------------------------

    /// Re-key by a point in each key: `at` is `"begin"`, `"center"` or
    /// `"end"`.
    #[pyo3(signature = (at="begin"))]
    fn as_time(&self, py: Python<'_>, at: &str) -> PyResult<Self> {
        let a = self::at(at, "at")?;
        py.detach(|| self.inner.as_time(a))
            .map(Self::wrap)
            .map_err(err)
    }

    /// Re-key as time ranges (a time becomes a zero-length range).
    fn as_time_range(&self, py: Python<'_>) -> PyResult<Self> {
        py.detach(|| self.inner.as_time_range())
            .map(Self::wrap)
            .map_err(err)
    }

    /// Re-key as intervals labelled `label` (a number or text), or by
    /// `label(row)` when it is a function.
    fn as_interval(&self, py: Python<'_>, label: &Bound<'_, PyAny>) -> PyResult<Self> {
        if label.is_callable() {
            let cb = Callback::new(label)?;
            let me = Arc::clone(&self.inner);
            let out = py.detach(|| {
                self.inner.as_interval_with(|_, i| {
                    cb.run(|py, f| {
                        let row = Bound::new(
                            py,
                            PyRow {
                                series: Arc::clone(&me),
                                index: i,
                            },
                        )?;
                        self::label(&f.call1((row,))?, "as_interval")
                    })
                    .unwrap_or(pond_rs::Label::Number(f64::NAN))
                })
            });
            return cb.finish(out).map(Self::wrap);
        }
        let l = self::label(label, "as_interval")?;
        py.detach(|| self.inner.as_interval(l))
            .map(Self::wrap)
            .map_err(err)
    }

    /// Move every key by `by`: milliseconds, a `timedelta`, or duration
    /// text (`"1h"`, `"-30m"`).
    fn offset_time(&self, py: Python<'_>, by: &Bound<'_, PyAny>) -> PyResult<Self> {
        let ms = signed_ms(by, "offset_time")?;
        py.detach(|| self.inner.offset_time_ms(ms))
            .map(Self::wrap)
            .map_err(err)
    }

    // --- picking rows ---------------------------------------------------

    /// Rows `start` to `end` (end not included), like a list slice.
    #[pyo3(signature = (start=None, end=None))]
    fn slice(&self, py: Python<'_>, start: Option<i64>, end: Option<i64>) -> Self {
        let s = &*self.inner;
        Self::wrap(py.detach(|| match (start, end) {
            (None, None) => s.slice(..),
            (Some(b), None) => s.slice(b..),
            (None, Some(e)) => s.slice(..e),
            (Some(b), Some(e)) => s.slice(b..e),
        }))
    }

    /// Several columns at once (pond-ts `mapColumns`): `{column: f}` where
    /// each `f` is an `Expr` or a function as for `map`. Every expression
    /// reads the columns as they were before any mapping, so
    /// `{"a": col("a") * 2, "b": col("b") / col("a")}` divides by the old
    /// `a`. A gap stays a gap.
    fn map_columns(&self, py: Python<'_>, mapping: &Bound<'_, PyDict>) -> PyResult<Self> {
        let mut exprs = Vec::new();
        let mut fns = Vec::new();
        for (k, v) in mapping.iter() {
            let column: String = k.extract()?;
            match crate::expr::as_expr(&v) {
                Some(e) => exprs.push((column, e)),
                None => fns.push((column, v)),
            }
        }
        let mut out = if exprs.is_empty() {
            if fns.is_empty() {
                return Err(crate::PondErrorPy::new_err(
                    "TimeSeries::map_columns: needs at least one column",
                ));
            }
            PyTimeSeries {
                inner: Arc::clone(&self.inner),
            }
        } else {
            let pairs: Vec<(&str, &pond_rs::Expr)> =
                exprs.iter().map(|(c, e)| (c.as_str(), e)).collect();
            py.detach(|| self.inner.map_exprs(&pairs))
                .map(Self::wrap)
                .map_err(err)?
        };
        // A function reads only its own column, which no expression wrote.
        for (column, f) in fns {
            out = out.map(py, &column, &f)?;
        }
        Ok(out)
    }

    /// The rows for which `keep(row)` is true. `keep` may be an `Expr`
    /// (`col("v") > 0`), which runs with no Python call per row.
    fn filter(&self, py: Python<'_>, keep: &Bound<'_, PyAny>) -> PyResult<Self> {
        if let Some(e) = crate::expr::as_expr(keep) {
            return py
                .detach(|| self.inner.filter_expr(&e))
                .map(Self::wrap)
                .map_err(err);
        }
        let cb = Callback::new(keep)?;
        let me = Arc::clone(&self.inner);
        let out = py.detach(|| self.inner.filter(|r| row_test(&cb, &me, r)));
        cb.finish(out).map(Self::wrap)
    }

    /// The rows that start after the last row's time minus `duration`.
    fn tail(&self, py: Python<'_>, duration: &Bound<'_, PyAny>) -> PyResult<Self> {
        let d = self::duration(duration, "tail")?;
        py.detach(|| self.inner.tail(&d))
            .map(Self::wrap)
            .map_err(err)
    }

    /// The rows wholly inside `[begin, end]` (both ends included).
    fn within(
        &self,
        py: Python<'_>,
        begin: &Bound<'_, PyAny>,
        end: &Bound<'_, PyAny>,
    ) -> PyResult<Self> {
        let (b, e) = (time_ms(begin, "within")?, time_ms(end, "within")?);
        py.detach(|| self.inner.within(b, e))
            .map(Self::wrap)
            .map_err(err)
    }

    /// The rows whose key overlaps `key`.
    fn overlapping(&self, py: Python<'_>, key: &Bound<'_, PyAny>) -> PyResult<Self> {
        let k = event_key(key, "overlapping")?;
        Ok(Self::wrap(py.detach(|| self.inner.overlapping(k))))
    }

    /// The rows whose key lies inside `key`.
    fn contained_by(&self, py: Python<'_>, key: &Bound<'_, PyAny>) -> PyResult<Self> {
        let k = event_key(key, "contained_by")?;
        Ok(Self::wrap(py.detach(|| self.inner.contained_by(k))))
    }

    /// The rows overlapping `key`, with their keys clipped to it.
    fn trim(&self, py: Python<'_>, key: &Bound<'_, PyAny>) -> PyResult<Self> {
        let k = event_key(key, "trim")?;
        Ok(Self::wrap(py.detach(|| self.inner.trim(k))))
    }

    /// The rows that end strictly before `key`'s start.
    fn before(&self, py: Python<'_>, key: &Bound<'_, PyAny>) -> PyResult<Self> {
        let k = event_key(key, "before")?;
        Ok(Self::wrap(py.detach(|| self.inner.before(k))))
    }

    /// The rows that start strictly after `key`'s start.
    fn after(&self, py: Python<'_>, key: &Bound<'_, PyAny>) -> PyResult<Self> {
        let k = event_key(key, "after")?;
        Ok(Self::wrap(py.detach(|| self.inner.after(k))))
    }

    // --- arrays ---------------------------------------------------------

    /// The rows whose array in `column` holds `value`.
    fn array_contains(
        &self,
        py: Python<'_>,
        column: &str,
        value: &Bound<'_, PyAny>,
    ) -> PyResult<Self> {
        let v = scalar(value, "array_contains")?;
        py.detach(|| self.inner.array_contains(column, v))
            .map(Self::wrap)
            .map_err(err)
    }

    /// The rows whose array in `column` holds every one of `values`.
    fn array_contains_all(
        &self,
        py: Python<'_>,
        column: &str,
        values: &Bound<'_, PyAny>,
    ) -> PyResult<Self> {
        let v = scalars(values, "array_contains_all")?;
        py.detach(|| self.inner.array_contains_all(column, &v))
            .map(Self::wrap)
            .map_err(err)
    }

    /// The rows whose array in `column` holds any of `values`.
    fn array_contains_any(
        &self,
        py: Python<'_>,
        column: &str,
        values: &Bound<'_, PyAny>,
    ) -> PyResult<Self> {
        let v = scalars(values, "array_contains_any")?;
        py.detach(|| self.inner.array_contains_any(column, &v))
            .map(Self::wrap)
            .map_err(err)
    }

    /// Reduce each row's array in `column` with `reducer`, into the column
    /// (or `output`). `kind` sets the result's kind when the reducer can
    /// give several.
    #[pyo3(signature = (column, reducer, *, output=None, kind=None))]
    fn array_aggregate(
        &self,
        py: Python<'_>,
        column: &str,
        reducer: &str,
        output: Option<String>,
        kind: Option<&str>,
    ) -> PyResult<Self> {
        let r = self::reducer(reducer)?;
        let o = ArrayOptions {
            output,
            kind: kind.map(column_kind).transpose()?,
        };
        py.detach(|| self.inner.array_aggregate(column, r, &o))
            .map(Self::wrap)
            .map_err(err)
    }

    /// One row per array element of `column`.
    #[pyo3(signature = (column, *, output=None, kind=None))]
    fn array_explode(
        &self,
        py: Python<'_>,
        column: &str,
        output: Option<String>,
        kind: Option<&str>,
    ) -> PyResult<Self> {
        let o = ArrayOptions {
            output,
            kind: kind.map(column_kind).transpose()?,
        };
        py.detach(|| self.inner.array_explode(column, &o))
            .map(Self::wrap)
            .map_err(err)
    }

    // --- reshaping --------------------------------------------------------

    /// Join on the key. `how` is `"outer"`, `"inner"`, `"left"` or
    /// `"right"`; a column name in both is an error unless
    /// `on_conflict="prefix"` with `prefixes=[left, right]`.
    #[pyo3(signature = (other, *, how="outer", on_conflict="error", prefixes=None))]
    fn join(
        &self,
        py: Python<'_>,
        other: &PyTimeSeries,
        how: &str,
        on_conflict: &str,
        prefixes: Option<Vec<String>>,
    ) -> PyResult<Self> {
        let o = join_options(how, on_conflict, prefixes)?;
        let other = Arc::clone(&other.inner);
        py.detach(|| self.inner.join(&other, o))
            .map(Self::wrap)
            .map_err(err)
    }

    /// Join several series on the key at once (options as for `join`).
    #[staticmethod]
    #[pyo3(signature = (series, *, how="outer", on_conflict="error", prefixes=None))]
    fn join_many(
        py: Python<'_>,
        series: &Bound<'_, PyAny>,
        how: &str,
        on_conflict: &str,
        prefixes: Option<Vec<String>>,
    ) -> PyResult<Self> {
        let o = join_options(how, on_conflict, prefixes)?;
        let all = series_list(series)?;
        let refs: Vec<&TimeSeries> = all.iter().map(|s| &**s).collect();
        py.detach(|| TimeSeries::join_many(&refs, o))
            .map(Self::wrap)
            .map_err(err)
    }

    /// Stack series with the same columns into one, in key order.
    #[staticmethod]
    fn concat(py: Python<'_>, series: &Bound<'_, PyAny>) -> PyResult<Self> {
        let all = series_list(series)?;
        let refs: Vec<&TimeSeries> = all.iter().map(|s| &**s).collect();
        py.detach(|| TimeSeries::concat(&refs))
            .map(Self::wrap)
            .map_err(err)
    }

    /// Replace `columns` by one column `output` holding `f(row)` (a
    /// number, text, bool or `None`). With `keep=True` the columns stay.
    #[pyo3(signature = (columns, output, f, *, keep=false))]
    fn collapse(
        &self,
        py: Python<'_>,
        columns: &Bound<'_, PyAny>,
        output: &str,
        f: &Bound<'_, PyAny>,
        keep: bool,
    ) -> PyResult<Self> {
        let names = self::names(columns)?;
        let cb = Callback::new(f)?;
        let me = Arc::clone(&self.inner);
        let step = |r: &pond_rs::Row<'_>| -> pond_rs::Result<Option<Scalar>> {
            let i = r.index();
            cb.try_run(|py, f| {
                let row = Bound::new(
                    py,
                    PyRow {
                        series: Arc::clone(&me),
                        index: i,
                    },
                )?;
                let v = f.call1((row,))?;
                if v.is_none() {
                    Ok(None)
                } else {
                    scalar(&v, "collapse").map(Some)
                }
            })
        };
        let n = refs(&names);
        let out = py.detach(|| {
            if keep {
                self.inner.collapse_keep(&n, output, step)
            } else {
                self.inner.collapse(&n, output, step)
            }
        });
        cb.finish(out).map(Self::wrap)
    }

    /// Long to wide: one column per value of `group`, holding `value`.
    /// Rows sharing a time and group are an error unless `aggregate`
    /// names a reducer; `groups` fixes the columns and their order.
    #[pyo3(signature = (group, value, *, aggregate=None, groups=None))]
    fn pivot_by_group(
        &self,
        py: Python<'_>,
        group: &str,
        value: &str,
        aggregate: Option<&str>,
        groups: Option<Vec<String>>,
    ) -> PyResult<Self> {
        let mut p = Pivot::default();
        if let Some(a) = aggregate {
            p = p.aggregate(reducer(a)?);
        }
        if let Some(g) = groups {
            p = p.groups(g);
        }
        py.detach(|| self.inner.pivot_by_group(group, value, &p))
            .map(Self::wrap)
            .map_err(err)
    }

    /// A histogram of `column`: bins `width` wide from `origin`, or
    /// between `edges` (`upper_inclusive` puts a value on an edge in the
    /// bin below). Returns `{column: [values]}` with the bin edges and
    /// one entry per output.
    #[pyo3(signature = (column, aggs, *, width=None, origin=0.0, edges=None, upper_inclusive=false))]
    fn by_column<'py>(
        &self,
        py: Python<'py>,
        column: &str,
        aggs: &Bound<'py, PyAny>,
        width: Option<f64>,
        origin: f64,
        edges: Option<Vec<f64>>,
        upper_inclusive: bool,
    ) -> PyResult<Bound<'py, PyDict>> {
        let aggs = self::aggs(aggs)?;
        let bins = match (width, edges) {
            (Some(w), None) => Bins::width_from(w, origin),
            (None, Some(e)) if upper_inclusive => Bins::edges_upper_inclusive(e),
            (None, Some(e)) => Bins::edges(e),
            _ => {
                return Err(value_error(
                    "by_column takes exactly one of width= or edges=",
                ));
            }
        };
        let t = py
            .detach(|| self.inner.by_column(column, &bins, &aggs))
            .py_err()?;
        table_to_py(py, &t)
    }

    /// Reduce the rows whose `column` value is within `radius` of each
    /// row's value (or of each of `at`). Returns `{column: [values]}`.
    #[pyo3(signature = (column, radius, aggs, *, at=None))]
    fn rolling_by_column<'py>(
        &self,
        py: Python<'py>,
        column: &str,
        radius: f64,
        aggs: &Bound<'py, PyAny>,
        at: Option<Vec<f64>>,
    ) -> PyResult<Bound<'py, PyDict>> {
        let aggs = self::aggs(aggs)?;
        let t = py
            .detach(|| match &at {
                Some(c) => self.inner.rolling_by_column_at(column, radius, c, &aggs),
                None => self.inner.rolling_by_column(column, radius, &aggs),
            })
            .py_err()?;
        table_to_py(py, &t)
    }

    /// The rows keyed by the number column `axis` instead of time.
    fn by_value(&self, py: Python<'_>, axis: &str) -> PyResult<PyValueSeries> {
        py.detach(|| self.inner.by_value(axis))
            .map(PyValueSeries::wrap)
            .map_err(err)
    }

    // --- per entity -------------------------------------------------------

    /// Split by the values of `columns` so the next operations run per
    /// group (on several cores); `collect()` puts the groups back together.
    fn partition_by(
        &self,
        py: Python<'_>,
        columns: &Bound<'_, PyAny>,
    ) -> PyResult<PyPartitionedSeries> {
        let names = self::names(columns)?;
        py.detach(|| self.inner.partition_by(&refs(&names)))
            .map(PyPartitionedSeries::wrap)
            .map_err(err)
    }

    /// The series split by the values of `columns`: `{key: series}`, a
    /// key being the value (or a tuple of values for several columns).
    fn group_by<'py>(
        &self,
        py: Python<'py>,
        columns: &Bound<'py, PyAny>,
    ) -> PyResult<Bound<'py, PyDict>> {
        let names = self::names(columns)?;
        let groups = py.detach(|| self.inner.group_by(&refs(&names))).py_err()?;
        let d = PyDict::new(py);
        for (k, s) in groups {
            d.set_item(partition_key_to_py(py, &k)?, Self::wrap(s))?;
        }
        Ok(d)
    }
}

shared_methods!(PyTimeSeries);

/// Rows of a series, one at a time (`for row in series`).
#[pyclass(module = "pond_rs")]
pub struct RowIter {
    series: Arc<TimeSeries>,
    next: usize,
}

#[pymethods]
impl RowIter {
    fn __iter__(slf: PyRef<'_, Self>) -> PyRef<'_, Self> {
        slf
    }

    fn __next__(&mut self) -> Option<PyRow> {
        (self.next < self.series.len()).then(|| {
            self.next += 1;
            PyRow {
                series: Arc::clone(&self.series),
                index: self.next - 1,
            }
        })
    }
}

/// Call a Python row test.
fn row_test(cb: &Callback, me: &Arc<TimeSeries>, r: &pond_rs::Row<'_>) -> pond_rs::Result<bool> {
    let i = r.index();
    cb.try_run(|py, f| {
        let row = Bound::new(
            py,
            PyRow {
                series: Arc::clone(me),
                index: i,
            },
        )?;
        f.call1((row,))?.is_truthy()
    })
}
