//! Python values to pond-rs values and back: times, durations, keys, cells,
//! reducer mappings, sequences and the small option words.

use pond_rs::{
    Agg, Alignment, At, ColumnData, Decimal, EventKey, Label, PondError, Reducer, Scalar, Sequence,
    Value,
};
use pyo3::exceptions::PyTypeError;
use pyo3::prelude::*;
use pyo3::sync::PyOnceLock;
use pyo3::types::{PyBool, PyDict, PyFloat, PyInt, PyList, PyString, PyTuple};

use crate::PondErrorPy;
use crate::sequence::PySequence;

/// A pond-rs error as the Python exception `pond_rs.PondError`.
pub fn err(e: PondError) -> PyErr {
    PondErrorPy::new_err(e.to_string())
}

/// `Result<T, PondError>` to `PyResult<T>`.
pub trait IntoPy<T> {
    fn py_err(self) -> PyResult<T>;
}

impl<T> IntoPy<T> for pond_rs::Result<T> {
    fn py_err(self) -> PyResult<T> {
        self.map_err(err)
    }
}

/// A bad value given to the binding (an unknown option word, a time that
/// is not whole milliseconds): `pond_rs.PondError`, like pond-rs's own
/// errors. A value of the wrong type is a `TypeError`.
pub fn value_error(message: impl Into<String>) -> PyErr {
    PondErrorPy::new_err(message.into())
}

fn datetime_module(py: Python<'_>) -> PyResult<&Bound<'_, PyAny>> {
    static MODULE: PyOnceLock<Py<PyAny>> = PyOnceLock::new();
    MODULE
        .get_or_try_init(py, || {
            Ok::<_, PyErr>(py.import("datetime")?.into_any().unbind())
        })
        .map(|m| m.bind(py))
}

/// `datetime(1970, 1, 1, tzinfo=timezone.utc)`.
fn epoch(py: Python<'_>) -> PyResult<&Bound<'_, PyAny>> {
    static EPOCH: PyOnceLock<Py<PyAny>> = PyOnceLock::new();
    EPOCH
        .get_or_try_init(py, || {
            let dt = datetime_module(py)?;
            let utc = dt.getattr("timezone")?.getattr("utc")?;
            let kwargs = PyDict::new(py);
            kwargs.set_item("tzinfo", utc)?;
            Ok::<_, PyErr>(
                dt.getattr("datetime")?
                    .call((1970, 1, 1), Some(&kwargs))?
                    .unbind(),
            )
        })
        .map(|e| e.bind(py))
}

/// A `datetime.timedelta` as whole milliseconds; a sub-millisecond part is
/// an error rather than being rounded.
fn timedelta_ms(td: &Bound<'_, PyAny>, what: &str) -> PyResult<i64> {
    let days: i64 = td.getattr("days")?.extract()?;
    let seconds: i64 = td.getattr("seconds")?.extract()?;
    let micros: i64 = td.getattr("microseconds")?.extract()?;
    if micros % 1000 != 0 {
        return Err(value_error(format!(
            "{what}: {} has a part smaller than a millisecond; pond-rs times are whole milliseconds",
            td.str()?
        )));
    }
    Ok(days * 86_400_000 + seconds * 1000 + micros / 1000)
}

fn is_instance(obj: &Bound<'_, PyAny>, class: &str) -> PyResult<bool> {
    let dt = datetime_module(obj.py())?;
    obj.is_instance(&dt.getattr(class)?)
}

/// A point in time as epoch milliseconds. Takes an `int` (milliseconds), a
/// `datetime` (one without a time zone is read as UTC), a `date` (midnight
/// UTC) or a string `parse_time` reads.
pub fn time_ms(obj: &Bound<'_, PyAny>, what: &str) -> PyResult<i64> {
    if obj.is_instance_of::<PyBool>() {
        return Err(PyTypeError::new_err(format!(
            "{what}: expected a time (int milliseconds, datetime, date or text), got a bool"
        )));
    }
    if obj.is_instance_of::<PyInt>() {
        return obj.extract::<i64>();
    }
    let type_name = obj.get_type().name()?.to_string();
    if type_name == "datetime64" {
        // numpy: through nanoseconds, so a sub-millisecond part is seen.
        if obj.call_method0("__str__")?.extract::<String>()? == "NaT" {
            return Err(value_error(format!("{what}: NaT is not a time")));
        }
        let ns: i64 = obj
            .call_method1("astype", ("datetime64[ns]",))?
            .call_method1("astype", ("int64",))?
            .extract()?;
        if ns % 1_000_000 != 0 {
            return Err(value_error(format!(
                "{what}: {} has a part smaller than a millisecond; pond-rs times are whole milliseconds",
                obj.str()?
            )));
        }
        return Ok(ns / 1_000_000);
    }
    if obj.hasattr("__index__")? && !obj.is_instance_of::<PyFloat>() {
        // numpy integers and other int-like objects.
        let index = obj.py().import("operator")?.call_method1("index", (obj,))?;
        return index.extract::<i64>();
    }
    if obj.is_instance_of::<PyFloat>() {
        let v: f64 = obj.extract()?;
        if v.fract() != 0.0 || !v.is_finite() || v.abs() > 9.0e15 {
            return Err(value_error(format!(
                "{what}: {v} is not a whole number of milliseconds"
            )));
        }
        return Ok(v as i64);
    }
    if let Ok(text) = obj.cast::<PyString>() {
        return pond_rs::parse_time(&text.to_cow()?).py_err();
    }
    let py = obj.py();
    if is_instance(obj, "datetime")? {
        let aware = if obj.getattr("tzinfo")?.is_none() {
            let utc = datetime_module(py)?.getattr("timezone")?.getattr("utc")?;
            let kwargs = PyDict::new(py);
            kwargs.set_item("tzinfo", utc)?;
            obj.call_method("replace", (), Some(&kwargs))?
        } else {
            obj.clone()
        };
        // pandas.Timestamp keeps nanoseconds beyond datetime's microseconds.
        if let Ok(ns) = obj.getattr("nanosecond")
            && ns.extract::<i64>().unwrap_or(0) != 0
        {
            return Err(value_error(format!(
                "{what}: {} has a part smaller than a millisecond; pond-rs times are whole milliseconds",
                obj.str()?
            )));
        }
        let delta = aware.call_method1("__sub__", (epoch(py)?,))?;
        return timedelta_ms(&delta, what);
    }
    if is_instance(obj, "date")? {
        let ordinal: i64 = obj.call_method0("toordinal")?.extract()?;
        // date(1970, 1, 1).toordinal() == 719163
        return Ok((ordinal - 719_163) * 86_400_000);
    }
    Err(PyTypeError::new_err(format!(
        "{what}: expected a time (int milliseconds, datetime, date or text), got {}",
        obj.get_type().name()?
    )))
}

/// A length of time as pond's duration text (`"5m"`, `"250ms"`): a string
/// is passed on as it is, a `timedelta` becomes whole milliseconds.
pub fn duration(obj: &Bound<'_, PyAny>, what: &str) -> PyResult<String> {
    if let Ok(text) = obj.cast::<PyString>() {
        return Ok(text.to_cow()?.to_string());
    }
    if is_instance(obj, "timedelta")? {
        let ms = timedelta_ms(obj, what)?;
        if ms < 0 {
            return Err(value_error(format!(
                "{what}: a duration cannot be negative"
            )));
        }
        return Ok(format!("{ms}ms"));
    }
    Err(PyTypeError::new_err(format!(
        "{what}: expected a duration ('5m', '1h', … or a timedelta), got {}",
        obj.get_type().name()?
    )))
}

/// A signed length of time in milliseconds: an `int`, a `timedelta`, or
/// duration text with an optional leading `-`.
pub fn signed_ms(obj: &Bound<'_, PyAny>, what: &str) -> PyResult<i64> {
    if obj.is_instance_of::<PyInt>() && !obj.is_instance_of::<PyBool>() {
        return obj.extract();
    }
    if let Ok(text) = obj.cast::<PyString>() {
        let text = text.to_cow()?;
        let text: &str = &text;
        return match text.strip_prefix('-') {
            Some(rest) => pond_rs::parse_duration(rest).map(|v| -v).py_err(),
            None => pond_rs::parse_duration(text).py_err(),
        };
    }
    if is_instance(obj, "timedelta")? {
        return timedelta_ms(obj, what);
    }
    Err(PyTypeError::new_err(format!(
        "{what}: expected milliseconds, a timedelta or duration text, got {}",
        obj.get_type().name()?
    )))
}

/// A key to look up or cut by: a time (see [`time_ms`]); a 2-tuple
/// `(begin, end)`, a time range; or a 3-tuple `(label, begin, end)`, an
/// interval.
pub fn event_key(obj: &Bound<'_, PyAny>, what: &str) -> PyResult<EventKey> {
    if let Ok(t) = obj.cast::<PyTuple>() {
        return match t.len() {
            2 => EventKey::time_range(
                time_ms(&t.get_item(0)?, what)?,
                time_ms(&t.get_item(1)?, what)?,
            )
            .py_err(),
            3 => EventKey::interval(
                label(&t.get_item(0)?, what)?,
                time_ms(&t.get_item(1)?, what)?,
                time_ms(&t.get_item(2)?, what)?,
            )
            .py_err(),
            n => Err(value_error(format!(
                "{what}: a key tuple is (begin, end) or (label, begin, end), got {n} items"
            ))),
        };
    }
    Ok(EventKey::time(time_ms(obj, what)?))
}

/// An interval label: a number or text.
pub fn label(obj: &Bound<'_, PyAny>, what: &str) -> PyResult<Label> {
    if let Ok(text) = obj.cast::<PyString>() {
        return Ok(Label::String(text.to_cow()?.to_string()));
    }
    if !obj.is_instance_of::<PyBool>()
        && let Ok(v) = obj.extract::<f64>()
    {
        return Ok(Label::Number(v));
    }
    Err(PyTypeError::new_err(format!(
        "{what}: a label is a number or text, got {}",
        obj.get_type().name()?
    )))
}

/// One array element: a number, text or bool.
pub fn scalar(obj: &Bound<'_, PyAny>, what: &str) -> PyResult<Scalar> {
    if obj.is_instance_of::<PyBool>() {
        return Ok(Scalar::Boolean(obj.extract()?));
    }
    if let Ok(text) = obj.cast::<PyString>() {
        return Ok(Scalar::String(text.to_cow()?.to_string()));
    }
    if let Ok(v) = obj.extract::<f64>() {
        return Ok(Scalar::Number(v));
    }
    Err(PyTypeError::new_err(format!(
        "{what}: an array element is a number, text or bool, got {}",
        obj.get_type().name()?
    )))
}

pub fn scalars(obj: &Bound<'_, PyAny>, what: &str) -> PyResult<Vec<Scalar>> {
    obj.try_iter()?.map(|item| scalar(&item?, what)).collect()
}

pub fn scalar_to_py<'py>(py: Python<'py>, s: &Scalar) -> PyResult<Bound<'py, PyAny>> {
    Ok(match s {
        Scalar::Number(v) => v.into_pyobject(py)?.into_any(),
        Scalar::String(v) => v.into_pyobject(py)?.into_any(),
        Scalar::Boolean(v) => PyBool::new(py, *v).to_owned().into_any(),
    })
}

/// A single value: a number, text, bool or a list (an array).
pub fn value(obj: &Bound<'_, PyAny>, what: &str) -> PyResult<Value> {
    if obj.is_instance_of::<PyList>() || obj.is_instance_of::<PyTuple>() {
        return Ok(Value::Array(scalars(obj, what)?));
    }
    Ok(match scalar(obj, what)? {
        Scalar::Number(v) => Value::Number(v),
        Scalar::String(v) => Value::String(v),
        Scalar::Boolean(v) => Value::Boolean(v),
    })
}

fn decimal_to_py<'py>(py: Python<'py>, d: Decimal) -> PyResult<Bound<'py, PyAny>> {
    static DECIMAL: PyOnceLock<Py<PyAny>> = PyOnceLock::new();
    let class = DECIMAL.get_or_try_init(py, || {
        Ok::<_, PyErr>(py.import("decimal")?.getattr("Decimal")?.unbind())
    })?;
    class.bind(py).call1((d.to_string(),))
}

pub fn value_to_py<'py>(py: Python<'py>, v: Option<&Value>) -> PyResult<Bound<'py, PyAny>> {
    Ok(match v {
        None => py.None().into_bound(py),
        Some(Value::Number(x)) => x.into_pyobject(py)?.into_any(),
        Some(Value::Decimal(d)) => decimal_to_py(py, *d)?,
        Some(Value::String(s)) => s.into_pyobject(py)?.into_any(),
        Some(Value::Boolean(b)) => PyBool::new(py, *b).to_owned().into_any(),
        Some(Value::Array(a)) => array_to_py(py, a)?,
    })
}

fn array_to_py<'py>(py: Python<'py>, a: &[Scalar]) -> PyResult<Bound<'py, PyAny>> {
    let items = a
        .iter()
        .map(|s| scalar_to_py(py, s))
        .collect::<PyResult<Vec<_>>>()?;
    Ok(PyList::new(py, items)?.into_any())
}

/// Cell `i` of a column as a Python value (`None` for a gap).
pub fn cell_to_py<'py>(
    py: Python<'py>,
    data: &ColumnData,
    i: usize,
) -> PyResult<Bound<'py, PyAny>> {
    Ok(match data {
        ColumnData::Number(c) => match c.get(i) {
            Some(v) => v.into_pyobject(py)?.into_any(),
            None => py.None().into_bound(py),
        },
        ColumnData::Decimal(c) => match c.get(i) {
            Some(d) => decimal_to_py(py, d)?,
            None => py.None().into_bound(py),
        },
        ColumnData::String(c) => match c.get(i) {
            Some(s) => s.into_pyobject(py)?.into_any(),
            None => py.None().into_bound(py),
        },
        ColumnData::Boolean(c) => match c.get(i) {
            Some(b) => PyBool::new(py, b).to_owned().into_any(),
            None => py.None().into_bound(py),
        },
        ColumnData::Array(c) => match c.get(i) {
            Some(a) => array_to_py(py, a)?,
            None => py.None().into_bound(py),
        },
    })
}

/// A whole column as a Python list.
pub fn column_to_py<'py>(py: Python<'py>, data: &ColumnData) -> PyResult<Bound<'py, PyList>> {
    let items = (0..data.len())
        .map(|i| cell_to_py(py, data, i))
        .collect::<PyResult<Vec<_>>>()?;
    PyList::new(py, items)
}

pub fn reducer(name: &str) -> PyResult<Reducer> {
    Reducer::parse(name).py_err()
}

/// A reducer mapping, `{output: spec}` in order. A spec is a reducer name
/// (the output names its own source column, as in pond-ts), a
/// `(source, reducer)` tuple, or `{"from": source, "using": reducer}`.
pub fn aggs(obj: &Bound<'_, PyAny>) -> PyResult<Vec<Agg>> {
    let map = obj.cast::<PyDict>().map_err(|_| {
        PyTypeError::new_err(
            "expected a mapping {output: reducer}, {output: (column, reducer)} or {output: {'from': column, 'using': reducer}}",
        )
    })?;
    map.iter()
        .map(|(output, spec)| {
            let output: String = output.extract()?;
            if let Ok(name) = spec.cast::<PyString>() {
                return Ok(Agg::of(output, reducer(&name.to_cow()?)?));
            }
            if let Ok(t) = spec.cast::<PyTuple>()
                && t.len() == 2
            {
                let source: String = t.get_item(0)?.extract()?;
                let using: String = t.get_item(1)?.extract()?;
                return Ok(Agg::new(output, source, reducer(&using)?));
            }
            if let Ok(d) = spec.cast::<PyDict>() {
                let source: String = d
                    .get_item("from")?
                    .ok_or_else(|| value_error(format!("'{output}': spec has no 'from'")))?
                    .extract()?;
                let using: String = d
                    .get_item("using")?
                    .ok_or_else(|| value_error(format!("'{output}': spec has no 'using'")))?
                    .extract()?;
                return Ok(Agg::new(output, source, reducer(&using)?));
            }
            Err(PyTypeError::new_err(format!(
                "'{output}': a reducer spec is a name, a (column, reducer) tuple or {{'from', 'using'}}"
            )))
        })
        .collect()
}

/// `{column: reducer}` for `cumulative`.
pub fn column_reducers(obj: &Bound<'_, PyAny>) -> PyResult<Vec<(String, Reducer)>> {
    let map = obj
        .cast::<PyDict>()
        .map_err(|_| PyTypeError::new_err("expected a mapping {column: reducer}"))?;
    map.iter()
        .map(|(c, r)| Ok((c.extract()?, reducer(&r.extract::<String>()?)?)))
        .collect()
}

/// One column name or a list of them.
pub fn names(obj: &Bound<'_, PyAny>) -> PyResult<Vec<String>> {
    if let Ok(text) = obj.cast::<PyString>() {
        return Ok(vec![text.to_cow()?.to_string()]);
    }
    obj.try_iter()?.map(|n| n?.extract::<String>()).collect()
}

pub fn refs(names: &[String]) -> Vec<&str> {
    names.iter().map(String::as_str).collect()
}

/// A `Sequence`, or a step (`"1m"`, a `timedelta`) meaning `Sequence.every`.
pub fn sequence(obj: &Bound<'_, PyAny>) -> PyResult<Sequence> {
    if let Ok(s) = obj.cast::<PySequence>() {
        return Ok(s.borrow().inner.clone());
    }
    Sequence::every(&duration(obj, "sequence")?).py_err()
}

pub fn alignment(word: &str) -> PyResult<Alignment> {
    match word {
        "trailing" => Ok(Alignment::Trailing),
        "leading" => Ok(Alignment::Leading),
        "centered" | "centred" => Ok(Alignment::Centered),
        other => Err(value_error(format!(
            "alignment must be 'trailing', 'leading' or 'centered', got '{other}'"
        ))),
    }
}

pub fn at(word: &str, what: &str) -> PyResult<At> {
    match word {
        "begin" => Ok(At::Begin),
        "center" | "centre" => Ok(At::Center),
        "end" => Ok(At::End),
        other => Err(value_error(format!(
            "{what} must be 'begin', 'center' or 'end', got '{other}'"
        ))),
    }
}

/// `range`: a `(start, end)` tuple or one time (a zero-length range).
pub fn range(obj: Option<&Bound<'_, PyAny>>) -> PyResult<Option<(i64, i64)>> {
    let Some(obj) = obj else { return Ok(None) };
    if obj.is_none() {
        return Ok(None);
    }
    if let Ok(t) = obj.cast::<PyTuple>() {
        if t.len() != 2 {
            return Err(value_error("range is (start, end) or one time"));
        }
        return Ok(Some((
            time_ms(&t.get_item(0)?, "range")?,
            time_ms(&t.get_item(1)?, "range")?,
        )));
    }
    let t = time_ms(obj, "range")?;
    Ok(Some((t, t)))
}

/// A column kind word for `kind=` options.
pub fn column_kind(word: &str) -> PyResult<pond_rs::ColumnKind> {
    use pond_rs::ColumnKind as K;
    match word {
        "number" => Ok(K::Number),
        "string" => Ok(K::String),
        "boolean" => Ok(K::Boolean),
        "array" => Ok(K::Array),
        "decimal" => Ok(K::Decimal),
        other => Err(value_error(format!(
            "kind must be 'number', 'string', 'boolean', 'array' or 'decimal', got '{other}'"
        ))),
    }
}

/// A partition key as a Python value: the value itself for one column, a
/// tuple for several.
pub fn partition_key_to_py<'py>(
    py: Python<'py>,
    key: &[Option<Value>],
) -> PyResult<Bound<'py, PyAny>> {
    if let [one] = key {
        return value_to_py(py, one.as_ref());
    }
    let items = key
        .iter()
        .map(|v| value_to_py(py, v.as_ref()))
        .collect::<PyResult<Vec<_>>>()?;
    Ok(PyTuple::new(py, items)?.into_any())
}
