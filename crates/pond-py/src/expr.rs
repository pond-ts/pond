//! Column expressions ([PND-EXPR]): `col("v") > 0`, as pond-ts
//! `col('v').gt(0)`. An `Expr` is data, so `filter`, `find`, `some`,
//! `every`, `map`, `with_column` and live `filter` run it inside pond-rs
//! over whole columns, with Python's lock released and no Python call per
//! row.

use pond_rs::{Expr, Literal};
use pyo3::exceptions::PyTypeError;
use pyo3::prelude::*;
use pyo3::types::{PyBool, PyFloat, PyInt, PyString};

use crate::convert::err;

/// A per-row rule written as data: `col("v") > 0`,
/// `(col("v") / col("w") > 10) & (col("host") == "h3")`. Build it with
/// `col`, `lit` and `when`, then pass it where a function would go.
///
/// Operators: `== != > >= < <=`, `&` (and), `|` (or), `~` (not),
/// `+ - * /`, unary `-`, `abs()`. The same as methods: `eq`, `ne`, `gt`,
/// `ge`, `lt`, `le`, `and_`, `or_`, `not_`, `add`, `sub`, `mul`, `div`,
/// `neg`, `abs`, plus `is_in(values)`, `is_missing()` and `fill(value)`.
///
/// Gaps: a comparison with a gap is false (so `!=` is true), arithmetic
/// with a gap gives a gap, a non-finite result (`x / 0`) is a gap, and
/// `&`, `|` and `when` read a gap as false.
#[pyclass(name = "Expr", module = "pond_rs", frozen)]
pub struct PyExpr {
    pub(crate) inner: Expr,
}

/// A plain Python value, or an `Expr`, as an `Expr`.
fn operand(v: &Bound<'_, PyAny>) -> PyResult<Expr> {
    if let Ok(e) = v.cast::<PyExpr>() {
        return Ok(e.get().inner.clone());
    }
    Ok(pond_rs::lit(literal(v, "an expression operand")?))
}

/// `True`/`False`, a finite number, or text.
fn literal(v: &Bound<'_, PyAny>, what: &str) -> PyResult<Literal> {
    // `bool` is a kind of `int` in Python, so it is checked first.
    if v.is_instance_of::<PyBool>() {
        return Ok(Literal::Boolean(v.extract()?));
    }
    if v.is_instance_of::<PyInt>() || v.is_instance_of::<PyFloat>() {
        let x: f64 = v.extract()?;
        if x.is_finite() {
            return Ok(Literal::Number(x));
        }
    }
    if v.is_instance_of::<PyString>() {
        return Ok(Literal::String(v.extract()?));
    }
    Err(PyTypeError::new_err(format!(
        "{what}: expected an Expr, a finite number, text or True/False, got {}",
        v.repr()?
    )))
}

fn wrap(inner: Expr) -> PyExpr {
    PyExpr { inner }
}

#[pymethods]
impl PyExpr {
    fn eq(&self, other: &Bound<'_, PyAny>) -> PyResult<Self> {
        Ok(wrap(self.inner.clone().eq(operand(other)?)))
    }
    fn ne(&self, other: &Bound<'_, PyAny>) -> PyResult<Self> {
        Ok(wrap(self.inner.clone().ne(operand(other)?)))
    }
    fn gt(&self, other: &Bound<'_, PyAny>) -> PyResult<Self> {
        Ok(wrap(self.inner.clone().gt(operand(other)?)))
    }
    fn ge(&self, other: &Bound<'_, PyAny>) -> PyResult<Self> {
        Ok(wrap(self.inner.clone().ge(operand(other)?)))
    }
    fn lt(&self, other: &Bound<'_, PyAny>) -> PyResult<Self> {
        Ok(wrap(self.inner.clone().lt(operand(other)?)))
    }
    fn le(&self, other: &Bound<'_, PyAny>) -> PyResult<Self> {
        Ok(wrap(self.inner.clone().le(operand(other)?)))
    }
    /// One of `values` (false for a gap).
    fn is_in(&self, values: Vec<Bound<'_, PyAny>>) -> PyResult<Self> {
        let values = values
            .iter()
            .map(|v| literal(v, "is_in"))
            .collect::<PyResult<Vec<_>>>()?;
        Ok(wrap(self.inner.clone().is_in(values)))
    }
    fn and_(&self, other: &Bound<'_, PyAny>) -> PyResult<Self> {
        Ok(wrap(self.inner.clone().and(operand(other)?)))
    }
    fn or_(&self, other: &Bound<'_, PyAny>) -> PyResult<Self> {
        Ok(wrap(self.inner.clone().or(operand(other)?)))
    }
    fn not_(&self) -> Self {
        wrap(self.inner.clone().not())
    }
    fn add(&self, other: &Bound<'_, PyAny>) -> PyResult<Self> {
        Ok(wrap(self.inner.clone().add(operand(other)?)))
    }
    fn sub(&self, other: &Bound<'_, PyAny>) -> PyResult<Self> {
        Ok(wrap(self.inner.clone().sub(operand(other)?)))
    }
    fn mul(&self, other: &Bound<'_, PyAny>) -> PyResult<Self> {
        Ok(wrap(self.inner.clone().mul(operand(other)?)))
    }
    fn div(&self, other: &Bound<'_, PyAny>) -> PyResult<Self> {
        Ok(wrap(self.inner.clone().div(operand(other)?)))
    }
    fn neg(&self) -> Self {
        wrap(self.inner.clone().neg())
    }
    fn abs(&self) -> Self {
        wrap(self.inner.clone().abs())
    }
    /// True where the value is a gap.
    fn is_missing(&self) -> Self {
        wrap(self.inner.clone().is_missing())
    }
    /// Gaps replaced by `value` (an `Expr` or a plain value of the same
    /// kind). In `TimeSeries.map` a gap stays a gap; fill in `with_column`.
    fn fill(&self, value: &Bound<'_, PyAny>) -> PyResult<Self> {
        Ok(wrap(self.inner.clone().fill(operand(value)?)))
    }

    fn __eq__(&self, o: &Bound<'_, PyAny>) -> PyResult<Self> {
        self.eq(o)
    }
    fn __ne__(&self, o: &Bound<'_, PyAny>) -> PyResult<Self> {
        self.ne(o)
    }
    fn __gt__(&self, o: &Bound<'_, PyAny>) -> PyResult<Self> {
        self.gt(o)
    }
    fn __ge__(&self, o: &Bound<'_, PyAny>) -> PyResult<Self> {
        self.ge(o)
    }
    fn __lt__(&self, o: &Bound<'_, PyAny>) -> PyResult<Self> {
        self.lt(o)
    }
    fn __le__(&self, o: &Bound<'_, PyAny>) -> PyResult<Self> {
        self.le(o)
    }
    fn __and__(&self, o: &Bound<'_, PyAny>) -> PyResult<Self> {
        self.and_(o)
    }
    fn __rand__(&self, o: &Bound<'_, PyAny>) -> PyResult<Self> {
        Ok(wrap(operand(o)?.and(self.inner.clone())))
    }
    fn __or__(&self, o: &Bound<'_, PyAny>) -> PyResult<Self> {
        self.or_(o)
    }
    fn __ror__(&self, o: &Bound<'_, PyAny>) -> PyResult<Self> {
        Ok(wrap(operand(o)?.or(self.inner.clone())))
    }
    fn __invert__(&self) -> Self {
        self.not_()
    }
    fn __add__(&self, o: &Bound<'_, PyAny>) -> PyResult<Self> {
        self.add(o)
    }
    fn __radd__(&self, o: &Bound<'_, PyAny>) -> PyResult<Self> {
        Ok(wrap(operand(o)?.add(self.inner.clone())))
    }
    fn __sub__(&self, o: &Bound<'_, PyAny>) -> PyResult<Self> {
        self.sub(o)
    }
    fn __rsub__(&self, o: &Bound<'_, PyAny>) -> PyResult<Self> {
        Ok(wrap(operand(o)?.sub(self.inner.clone())))
    }
    fn __mul__(&self, o: &Bound<'_, PyAny>) -> PyResult<Self> {
        self.mul(o)
    }
    fn __rmul__(&self, o: &Bound<'_, PyAny>) -> PyResult<Self> {
        Ok(wrap(operand(o)?.mul(self.inner.clone())))
    }
    fn __truediv__(&self, o: &Bound<'_, PyAny>) -> PyResult<Self> {
        self.div(o)
    }
    fn __rtruediv__(&self, o: &Bound<'_, PyAny>) -> PyResult<Self> {
        Ok(wrap(operand(o)?.div(self.inner.clone())))
    }
    fn __neg__(&self) -> Self {
        self.neg()
    }
    fn __abs__(&self) -> Self {
        self.abs()
    }
    /// An `Expr` is a rule, not a truth value: `and` / `or` / `not` and
    /// `if` cannot read it. Use `&`, `|` and `~`.
    fn __bool__(&self) -> PyResult<bool> {
        Err(PyTypeError::new_err(
            "an Expr has no truth value; combine with & | ~ (not and / or / not)",
        ))
    }

    /// The JSON form: the same tree as pond-ts `Expr.toJSON()`.
    fn to_json(&self) -> String {
        self.inner.to_json()
    }
    /// An `Expr` from its JSON form (pond-ts `JSON.stringify(expr)`).
    #[staticmethod]
    fn from_json(text: &str) -> PyResult<Self> {
        Expr::from_json(text).map(wrap).map_err(err)
    }
    fn __repr__(&self) -> String {
        format!("Expr({})", self.inner.to_json())
    }
}

/// The value of column `name` in each row.
#[pyfunction]
pub fn col(name: &str) -> PyExpr {
    wrap(pond_rs::col(name))
}

/// A fixed value: `lit(100) - col("pct")`. Plain values are wrapped for
/// you; this is needed only when the value comes first in a method chain.
#[pyfunction]
pub fn lit(value: &Bound<'_, PyAny>) -> PyResult<PyExpr> {
    Ok(wrap(pond_rs::lit(literal(value, "lit")?)))
}

/// `then` where `condition` is true, else `otherwise` (a gap in
/// `condition` counts as false).
#[pyfunction]
pub fn when(
    condition: &Bound<'_, PyAny>,
    then: &Bound<'_, PyAny>,
    otherwise: &Bound<'_, PyAny>,
) -> PyResult<PyExpr> {
    Ok(wrap(pond_rs::when(
        operand(condition)?,
        operand(then)?,
        operand(otherwise)?,
    )))
}

/// `v` as an `Expr`, when it is one.
pub fn as_expr(v: &Bound<'_, PyAny>) -> Option<Expr> {
    v.cast::<PyExpr>().ok().map(|e| e.get().inner.clone())
}

pub fn register(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<PyExpr>()?;
    m.add_function(wrap_pyfunction!(col, m)?)?;
    m.add_function(wrap_pyfunction!(lit, m)?)?;
    m.add_function(wrap_pyfunction!(when, m)?)?;
    Ok(())
}
