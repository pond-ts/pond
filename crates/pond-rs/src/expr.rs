//! Column expressions: per-row rules written as data, `col("v").gt(0.0)`,
//! run over whole columns instead of calling a closure once per row
//! (pond-ts `col` / `lit` / `when`, [PND-EXPR]).
//!
//! An [`Expr`] is a small tree. It is checked against the series' schema
//! when a method receives it (unknown column, wrong kind), then evaluated
//! one operation at a time over whole columns. Its JSON form
//! ([`Expr::to_json`], [`Expr::from_json`]) is pond-ts's, so an expression
//! built in JavaScript or Python reaches pond-rs unchanged.
//!
//! Gaps behave as in pond-ts, where they follow what a function would do
//! with `undefined`:
//! - a comparison with a gap is false, and `not` flips plainly (so
//!   `not` of a comparison keeps gap rows);
//! - `eq` with a gap on either side is false, and `ne` is exactly
//!   `eq(..).not()`;
//! - arithmetic with a gap is a gap, and a non-finite result (`x / 0`) is a
//!   gap;
//! - `and` / `or` / `not` / `when` read a gap as false.
//!
//! ```
//! # use pond_rs::{col, lit, when, Column, TimeSeries};
//! let s = TimeSeries::new("s", vec![0, 1000, 2000], vec![
//!     Column::optional("cpu", vec![Some(0.2), None, Some(0.9)]),
//!     Column::required("host", vec!["a", "b", "a"]),
//! ])?;
//! let busy = s.filter_expr(&col("cpu").gt(0.5).and(col("host").eq("a")))?;
//! assert_eq!(busy.key().begin(), &[2000]);
//! let pct = s.with_column_expr("pct", &col("cpu").mul(100))?;
//! assert_eq!(pct.column("pct")?.numbers()?.get(2), Some(90.0));
//! let label = s.with_column_expr("level", &when(col("cpu").gt(0.5), "high", "low"))?;
//! assert_eq!(label.column("level")?.strings()?.get(1), Some("low")); // gap: false
//! assert_eq!(lit(10).sub(col("cpu")).to_json(),
//!     r#"{"op":"sub","args":[{"lit":10.0},{"col":"cpu"}]}"#);
//! # Ok::<(), pond_rs::PondError>(())
//! ```

use std::borrow::Cow;
use std::sync::Arc;

use serde_json::{Value as Json, json};

use crate::column::{BooleanColumn, ColumnData, Float64Column, StringColumn, Value};
use crate::error::{PondError, Result};
use crate::series::{ColumnDef, ColumnKind};

/// A fixed value an expression can hold.
#[derive(Debug, Clone, PartialEq)]
pub enum Literal {
    /// A number (must be finite when the expression is applied).
    Number(f64),
    /// Text.
    String(String),
    /// True/false.
    Boolean(bool),
}

/// An operation an [`Expr`] can name; the JSON form uses pond-ts's names
/// (`"isMissing"`, `"in"`, …).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    /// Equal.
    Eq,
    /// Not equal.
    Ne,
    /// Greater than.
    Gt,
    /// Greater than or equal.
    Ge,
    /// Less than.
    Lt,
    /// Less than or equal.
    Le,
    /// One of a list of values.
    In,
    /// Both true.
    And,
    /// Either true.
    Or,
    /// Not.
    Not,
    /// Plus.
    Add,
    /// Minus.
    Sub,
    /// Times.
    Mul,
    /// Divided by.
    Div,
    /// Negated.
    Neg,
    /// Absolute value.
    Abs,
    /// True where the value is a gap.
    IsMissing,
    /// Gaps replaced.
    Fill,
    /// Choice.
    When,
}

const OPS: [(Op, &str, usize); 19] = [
    (Op::Eq, "eq", 2),
    (Op::Ne, "ne", 2),
    (Op::Gt, "gt", 2),
    (Op::Ge, "ge", 2),
    (Op::Lt, "lt", 2),
    (Op::Le, "le", 2),
    (Op::In, "in", 1),
    (Op::And, "and", 2),
    (Op::Or, "or", 2),
    (Op::Not, "not", 1),
    (Op::Add, "add", 2),
    (Op::Sub, "sub", 2),
    (Op::Mul, "mul", 2),
    (Op::Div, "div", 2),
    (Op::Neg, "neg", 1),
    (Op::Abs, "abs", 1),
    (Op::IsMissing, "isMissing", 1),
    (Op::Fill, "fill", 2),
    (Op::When, "when", 3),
];

impl Op {
    /// The name in the JSON form.
    pub fn name(self) -> &'static str {
        OPS.iter().find(|o| o.0 == self).map(|o| o.1).unwrap_or("?")
    }
    fn arity(self) -> usize {
        OPS.iter().find(|o| o.0 == self).map(|o| o.2).unwrap_or(0)
    }
    fn from_name(name: &str) -> Option<Op> {
        OPS.iter().find(|o| o.1 == name).map(|o| o.0)
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Node {
    Col(String),
    Lit(Literal),
    Op {
        op: Op,
        args: Vec<Expr>,
        values: Vec<Literal>,
    },
}

/// A column expression. Build one with [`col`], [`lit`] or [`when`] and
/// the methods below; pass it to [`TimeSeries::filter_expr`],
/// [`find_expr`](crate::TimeSeries::find_expr),
/// [`some_expr`](crate::TimeSeries::some_expr),
/// [`every_expr`](crate::TimeSeries::every_expr),
/// [`map_expr`](crate::TimeSeries::map_expr),
/// [`with_column_expr`](crate::TimeSeries::with_column_expr) or the live
/// layer's `filter_expr`. Cloning is cheap (the tree is shared).
///
/// Arguments take anything that turns into an expression: another `Expr`,
/// or a plain `f64`, `i32`, `&str`, `String` or `bool`.
///
/// [`TimeSeries::filter_expr`]: crate::TimeSeries::filter_expr
#[derive(Debug, Clone, PartialEq)]
pub struct Expr(Arc<Node>);

/// The value of column `name` in each row.
pub fn col(name: impl Into<String>) -> Expr {
    Expr(Arc::new(Node::Col(name.into())))
}

/// A fixed value. Plain values are wrapped for you; this is needed only
/// when the value comes first: `lit(100).sub(col("pct"))`.
pub fn lit(value: impl Into<Literal>) -> Expr {
    Expr(Arc::new(Node::Lit(value.into())))
}

/// `then` where `condition` is true, else `otherwise` (a gap in
/// `condition` counts as false).
pub fn when(condition: impl Into<Expr>, then: impl Into<Expr>, otherwise: impl Into<Expr>) -> Expr {
    Expr::op(
        Op::When,
        vec![condition.into(), then.into(), otherwise.into()],
    )
}

impl From<f64> for Literal {
    fn from(v: f64) -> Self {
        Literal::Number(v)
    }
}
impl From<i32> for Literal {
    fn from(v: i32) -> Self {
        Literal::Number(v.into())
    }
}
impl From<&str> for Literal {
    fn from(v: &str) -> Self {
        Literal::String(v.to_string())
    }
}
impl From<String> for Literal {
    fn from(v: String) -> Self {
        Literal::String(v)
    }
}
impl From<bool> for Literal {
    fn from(v: bool) -> Self {
        Literal::Boolean(v)
    }
}

macro_rules! into_expr {
    ($($t:ty),*) => {$(
        impl From<$t> for Expr {
            fn from(v: $t) -> Self {
                lit(v)
            }
        }
    )*};
}
into_expr!(f64, i32, &str, String, bool);

impl From<Literal> for Expr {
    fn from(v: Literal) -> Self {
        Expr(Arc::new(Node::Lit(v)))
    }
}

impl Expr {
    fn op(op: Op, args: Vec<Expr>) -> Expr {
        Expr(Arc::new(Node::Op {
            op,
            args,
            values: Vec::new(),
        }))
    }
    fn bin(self, op: Op, other: impl Into<Expr>) -> Expr {
        Expr::op(op, vec![self, other.into()])
    }

    /// Equal (`false` when either side is a gap).
    pub fn eq(self, other: impl Into<Expr>) -> Expr {
        self.bin(Op::Eq, other)
    }
    /// Not equal: exactly `eq(other).not()`, so `true` when either side is
    /// a gap.
    pub fn ne(self, other: impl Into<Expr>) -> Expr {
        self.bin(Op::Ne, other)
    }
    /// Greater than (numbers, or text in JavaScript's order: UTF-16 code
    /// units).
    pub fn gt(self, other: impl Into<Expr>) -> Expr {
        self.bin(Op::Gt, other)
    }
    /// Greater than or equal.
    pub fn ge(self, other: impl Into<Expr>) -> Expr {
        self.bin(Op::Ge, other)
    }
    /// Less than.
    pub fn lt(self, other: impl Into<Expr>) -> Expr {
        self.bin(Op::Lt, other)
    }
    /// Less than or equal.
    pub fn le(self, other: impl Into<Expr>) -> Expr {
        self.bin(Op::Le, other)
    }
    /// One of `values` (`false` for a gap); pond-ts `in`.
    pub fn is_in<L: Into<Literal>>(self, values: impl IntoIterator<Item = L>) -> Expr {
        Expr(Arc::new(Node::Op {
            op: Op::In,
            args: vec![self],
            values: values.into_iter().map(Into::into).collect(),
        }))
    }
    /// Both true (a gap counts as false).
    pub fn and(self, other: impl Into<Expr>) -> Expr {
        self.bin(Op::And, other)
    }
    /// Either true (a gap counts as false).
    pub fn or(self, other: impl Into<Expr>) -> Expr {
        self.bin(Op::Or, other)
    }
    /// Not (a gap counts as false, so `not` gives true).
    #[allow(clippy::should_implement_trait)]
    pub fn not(self) -> Expr {
        Expr::op(Op::Not, vec![self])
    }
    /// Plus.
    #[allow(clippy::should_implement_trait)]
    pub fn add(self, other: impl Into<Expr>) -> Expr {
        self.bin(Op::Add, other)
    }
    /// Minus.
    #[allow(clippy::should_implement_trait)]
    pub fn sub(self, other: impl Into<Expr>) -> Expr {
        self.bin(Op::Sub, other)
    }
    /// Times.
    #[allow(clippy::should_implement_trait)]
    pub fn mul(self, other: impl Into<Expr>) -> Expr {
        self.bin(Op::Mul, other)
    }
    /// Divided by (division by zero gives a gap).
    #[allow(clippy::should_implement_trait)]
    pub fn div(self, other: impl Into<Expr>) -> Expr {
        self.bin(Op::Div, other)
    }
    /// Negated.
    #[allow(clippy::should_implement_trait)]
    pub fn neg(self) -> Expr {
        Expr::op(Op::Neg, vec![self])
    }
    /// Absolute value.
    pub fn abs(self) -> Expr {
        Expr::op(Op::Abs, vec![self])
    }
    /// `true` where the value is a gap.
    pub fn is_missing(self) -> Expr {
        Expr::op(Op::IsMissing, vec![self])
    }
    /// Gaps replaced by `value` (an expression or a plain value of the same
    /// kind).
    pub fn fill(self, value: impl Into<Expr>) -> Expr {
        self.bin(Op::Fill, value)
    }

    /// The JSON form, as pond-ts `toJSON()` gives it:
    /// `{"op":"gt","args":[{"col":"v"},{"lit":0.0}]}`.
    pub fn to_json(&self) -> String {
        self.to_value().to_string()
    }

    /// The JSON form as a [`serde_json::Value`].
    pub fn to_value(&self) -> Json {
        let lit = |l: &Literal| match l {
            Literal::Number(v) => json!(v),
            Literal::String(v) => json!(v),
            Literal::Boolean(v) => json!(v),
        };
        match &*self.0 {
            Node::Col(c) => json!({ "col": c }),
            Node::Lit(l) => json!({ "lit": lit(l) }),
            Node::Op { op, args, values } => {
                let mut m = serde_json::Map::new();
                m.insert("op".into(), json!(op.name()));
                m.insert(
                    "args".into(),
                    Json::Array(args.iter().map(Expr::to_value).collect()),
                );
                if *op == Op::In {
                    m.insert(
                        "values".into(),
                        Json::Array(values.iter().map(lit).collect()),
                    );
                }
                Json::Object(m)
            }
        }
    }

    /// An expression from its JSON form (pond-ts `toJSON()`).
    pub fn from_json(text: &str) -> Result<Expr> {
        let v: Json = serde_json::from_str(text).map_err(|e| bad(format!("not JSON: {e}")))?;
        Expr::from_value(&v)
    }

    /// An expression from its JSON form as a [`serde_json::Value`].
    pub fn from_value(v: &Json) -> Result<Expr> {
        let literal = |v: &Json| -> Result<Literal> {
            match v {
                Json::Number(n) => Ok(Literal::Number(n.as_f64().unwrap_or(f64::NAN))),
                Json::String(s) => Ok(Literal::String(s.clone())),
                Json::Bool(b) => Ok(Literal::Boolean(*b)),
                other => Err(bad(format!(
                    "expected a finite number, text or true/false, got {other}"
                ))),
            }
        };
        let Some(m) = v.as_object() else {
            return Err(bad(format!("not an expression: {v}")));
        };
        if let Some(c) = m.get("col") {
            let Some(c) = c.as_str() else {
                return Err(bad(format!("col must be a column name, got {c}")));
            };
            return Ok(col(c));
        }
        if let Some(l) = m.get("lit") {
            return Ok(Expr::from(literal(l)?));
        }
        let name = m.get("op").and_then(Json::as_str);
        let Some(op) = name.and_then(Op::from_name) else {
            return Err(bad(match name {
                Some(n) => format!("unknown operation '{n}'"),
                None => format!("not an expression: {v}"),
            }));
        };
        let args = match m.get("args").and_then(Json::as_array) {
            Some(a) if a.len() == op.arity() => {
                a.iter().map(Expr::from_value).collect::<Result<Vec<_>>>()?
            }
            _ => {
                return Err(bad(format!(
                    "{} takes {} operand(s)",
                    op.name(),
                    op.arity()
                )));
            }
        };
        let values = if op == Op::In {
            match m.get("values").and_then(Json::as_array) {
                Some(vs) => vs.iter().map(literal).collect::<Result<Vec<_>>>()?,
                None => return Err(bad("in needs a list of values".into())),
            }
        } else {
            Vec::new()
        };
        Ok(Expr(Arc::new(Node::Op { op, args, values })))
    }
}

/// A bare column read, for internal use.
pub(crate) fn col_expr(name: &str) -> Expr {
    col(name)
}

fn bad(message: String) -> PondError {
    PondError::InvalidData {
        call: "Expr",
        message,
    }
}

// ─── Checking ───────────────────────────────────────────────────────

/// The kind of value an expression gives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Number,
    String,
    Boolean,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Number => "number",
            Kind::String => "string",
            Kind::Boolean => "boolean",
        }
    }
    pub(crate) fn column_kind(self) -> ColumnKind {
        match self {
            Kind::Number => ColumnKind::Number,
            Kind::String => ColumnKind::String,
            Kind::Boolean => ColumnKind::Boolean,
        }
    }
}

fn literal_kind(l: &Literal) -> Kind {
    match l {
        Literal::Number(_) => Kind::Number,
        Literal::String(_) => Kind::String,
        Literal::Boolean(_) => Kind::Boolean,
    }
}

fn show(l: &Literal) -> String {
    match l {
        Literal::Number(v) => crate::grid::js_number(*v),
        Literal::String(v) => Json::from(v.as_str()).to_string(),
        Literal::Boolean(v) => v.to_string(),
    }
}

/// The kind `e` gives over `columns` (the value columns), or an error
/// naming what is wrong, with pond-ts's wording.
pub(crate) fn check(e: &Expr, columns: &[ColumnDef], call: &'static str) -> Result<Kind> {
    let fail = |message: String| PondError::InvalidData { call, message };
    let check_literal = |l: &Literal| match l {
        Literal::Number(v) if !v.is_finite() => Err(fail(format!(
            "expected a finite number, text or true/false, got {}",
            crate::grid::js_number(*v)
        ))),
        _ => Ok(literal_kind(l)),
    };
    match &*e.0 {
        Node::Col(name) => {
            let Some(c) = columns.iter().find(|d| &d.name == name) else {
                return Err(PondError::UnknownColumn {
                    call,
                    column: name.clone(),
                    available: columns.iter().map(|d| d.name.clone()).collect(),
                });
            };
            match c.kind {
                ColumnKind::Number => Ok(Kind::Number),
                ColumnKind::String => Ok(Kind::String),
                ColumnKind::Boolean => Ok(Kind::Boolean),
                other => Err(PondError::WrongKind {
                    call,
                    column: name.clone(),
                    kind: other.as_str(),
                    reason: "expressions read number, string and boolean columns".into(),
                }),
            }
        }
        Node::Lit(l) => check_literal(l),
        Node::Op { op, args, values } => {
            let op = *op;
            let kinds = args
                .iter()
                .map(|a| check(a, columns, call))
                .collect::<Result<Vec<_>>>()?;
            let all = || {
                kinds
                    .iter()
                    .map(|k| k.name())
                    .collect::<Vec<_>>()
                    .join(" and ")
            };
            let same = |what: &str| {
                if kinds[0] != kinds[1] {
                    Err(fail(format!(
                        "{} needs two values of the same kind, got {} and {}{what}",
                        op.name(),
                        kinds[0].name(),
                        kinds[1].name()
                    )))
                } else {
                    Ok(())
                }
            };
            match op {
                Op::Eq | Op::Ne => {
                    same("")?;
                    Ok(Kind::Boolean)
                }
                Op::Gt | Op::Ge | Op::Lt | Op::Le => {
                    same("")?;
                    if kinds[0] == Kind::Boolean {
                        return Err(fail(format!(
                            "{} compares numbers or text, not true/false",
                            op.name()
                        )));
                    }
                    Ok(Kind::Boolean)
                }
                Op::In => {
                    for v in values {
                        let k = check_literal(v)?;
                        if k != kinds[0] {
                            return Err(fail(format!(
                                "in: {} is not a {}",
                                show(v),
                                kinds[0].name()
                            )));
                        }
                    }
                    Ok(Kind::Boolean)
                }
                Op::And | Op::Or | Op::Not => {
                    if kinds.iter().any(|&k| k != Kind::Boolean) {
                        return Err(fail(format!(
                            "{} needs true/false values, got {}",
                            op.name(),
                            all()
                        )));
                    }
                    Ok(Kind::Boolean)
                }
                Op::Add | Op::Sub | Op::Mul | Op::Div | Op::Neg | Op::Abs => {
                    if kinds.iter().any(|&k| k != Kind::Number) {
                        return Err(fail(format!("{} needs numbers, got {}", op.name(), all())));
                    }
                    Ok(Kind::Number)
                }
                Op::IsMissing => Ok(Kind::Boolean),
                Op::Fill => {
                    same(" (fill value)")?;
                    Ok(kinds[0])
                }
                Op::When => {
                    if kinds[0] != Kind::Boolean {
                        return Err(fail(format!(
                            "when needs a true/false condition, got {}",
                            kinds[0].name()
                        )));
                    }
                    if kinds[1] != kinds[2] {
                        return Err(fail(format!(
                            "when needs both branches of the same kind, got {} and {}",
                            kinds[1].name(),
                            kinds[2].name()
                        )));
                    }
                    Ok(kinds[1])
                }
            }
        }
    }
}

/// [`check`], and refuse anything that is not a true/false expression.
pub(crate) fn check_test(e: &Expr, columns: &[ColumnDef], call: &'static str) -> Result<()> {
    match check(e, columns, call)? {
        Kind::Boolean => Ok(()),
        k => Err(PondError::InvalidData {
            call,
            message: format!("needs a true/false expression, got {}", k.name()),
        }),
    }
}

// ─── Column-wise evaluation ─────────────────────────────────────────

/// Values in flight: numbers (`NaN` a gap), true/false (1 / 0 / -1 for a
/// gap), text (`None` a gap). Borrowed while they are a column's own
/// values; an operation that owns its input writes over it.
pub(crate) enum Vals<'a> {
    Number(Cow<'a, [f64]>),
    Boolean(Vec<i8>),
    String(Vec<Option<Cow<'a, str>>>),
}

impl Vals<'_> {
    fn is_gap(&self, i: usize) -> bool {
        match self {
            Vals::Number(v) => v[i].is_nan(),
            Vals::Boolean(v) => v[i] < 0,
            Vals::String(v) => v[i].is_none(),
        }
    }
}

/// Where an expression reads its columns.
pub(crate) trait Source {
    fn len(&self) -> usize;
    fn data(&self, name: &str) -> &ColumnData;
}

/// `e` (already [`check`]ed) over `src`.
pub(crate) fn evaluate<'a>(e: &Expr, src: &'a dyn Source) -> Vals<'a> {
    let n = src.len();
    match &*e.0 {
        Node::Col(name) => read(src.data(name)),
        Node::Lit(l) => spread(l, n),
        Node::Op { op, args, values } => {
            if let Some(v) = scalar_case(*op, args, values, src) {
                return v;
            }
            let mut vals: Vec<Vals<'a>> = args.iter().map(|a| evaluate(a, src)).collect();
            match op {
                Op::Eq | Op::Ne | Op::Gt | Op::Ge | Op::Lt | Op::Le => {
                    let b = vals.pop().expect("two operands");
                    let a = vals.pop().expect("two operands");
                    Vals::Boolean(compare(*op, &a, &b, n))
                }
                Op::In => {
                    let a = &vals[0];
                    Vals::Boolean(
                        (0..n)
                            .map(|i| {
                                (!a.is_gap(i) && values.iter().any(|v| cell_is(a, i, v))) as i8
                            })
                            .collect(),
                    )
                }
                Op::And | Op::Or => {
                    let (Vals::Boolean(q), Vals::Boolean(mut p)) =
                        (vals.pop().expect("two"), vals.pop().expect("two"))
                    else {
                        unreachable!("checked: true/false operands")
                    };
                    let and = *op == Op::And;
                    for (x, &y) in p.iter_mut().zip(&q) {
                        *x = if and {
                            (*x == 1 && y == 1) as i8
                        } else {
                            (*x == 1 || y == 1) as i8
                        };
                    }
                    Vals::Boolean(p)
                }
                Op::Not => {
                    let Some(Vals::Boolean(mut p)) = vals.pop() else {
                        unreachable!("checked: true/false operand")
                    };
                    for x in &mut p {
                        *x = (*x != 1) as i8;
                    }
                    Vals::Boolean(p)
                }
                Op::Add | Op::Sub | Op::Mul | Op::Div => {
                    let (Vals::Number(q), Vals::Number(p)) =
                        (vals.pop().expect("two"), vals.pop().expect("two"))
                    else {
                        unreachable!("checked: number operands")
                    };
                    let out = match op {
                        Op::Add => binary(p, q, |x, y| x + y),
                        Op::Sub => binary(p, q, |x, y| x - y),
                        Op::Mul => binary(p, q, |x, y| x * y),
                        _ => binary(p, q, |x, y| x / y),
                    };
                    Vals::Number(Cow::Owned(out))
                }
                Op::Neg | Op::Abs => {
                    let Some(Vals::Number(p)) = vals.pop() else {
                        unreachable!("checked: number operand")
                    };
                    Vals::Number(Cow::Owned(if *op == Op::Neg {
                        unary(p, |x| -x)
                    } else {
                        unary(p, f64::abs)
                    }))
                }
                Op::IsMissing => {
                    let a = &vals[0];
                    Vals::Boolean((0..n).map(|i| a.is_gap(i) as i8).collect())
                }
                Op::Fill => {
                    let b = vals.pop().expect("two");
                    let a = vals.pop().expect("two");
                    let keep: Vec<bool> = (0..n).map(|i| !a.is_gap(i)).collect();
                    pick(&keep, a, b)
                }
                Op::When => {
                    let c = vals.pop().expect("three");
                    let b = vals.pop().expect("three");
                    let Some(Vals::Boolean(cond)) = vals.pop() else {
                        unreachable!("checked: true/false condition")
                    };
                    let keep: Vec<bool> = cond.iter().map(|&x| x == 1).collect();
                    pick(&keep, b, c)
                }
            }
        }
    }
}

fn read(data: &ColumnData) -> Vals<'_> {
    match data {
        ColumnData::Number(c) => {
            // NaN gaps are read as they are; only a gap stored as an
            // infinity needs a copy.
            if c.all_finite() || !has_infinity(c.values()) {
                Vals::Number(Cow::Borrowed(c.values()))
            } else {
                // A gap may be stored as an infinity; in flight it is NaN.
                Vals::Number(Cow::Owned(
                    c.values()
                        .iter()
                        .map(|&v| if v.is_finite() { v } else { f64::NAN })
                        .collect(),
                ))
            }
        }
        ColumnData::Boolean(c) => {
            Vals::Boolean(c.iter().map(|v| v.map_or(-1, |b| b as i8)).collect())
        }
        ColumnData::String(c) => Vals::String(c.iter().map(|v| v.map(Cow::Borrowed)).collect()),
        _ => unreachable!("checked: number, string or boolean column"),
    }
}

/// True when any value is ±infinity. Checked in blocks so the compiler
/// can use wide instructions (a plain `any` is about twice as slow).
fn has_infinity(v: &[f64]) -> bool {
    v.chunks(4096)
        .any(|c| c.iter().fold(false, |a, x| a | x.is_infinite()))
}

fn spread<'a>(l: &Literal, n: usize) -> Vals<'a> {
    match l {
        Literal::Number(v) => Vals::Number(Cow::Owned(vec![*v; n])),
        Literal::Boolean(v) => Vals::Boolean(vec![*v as i8; n]),
        Literal::String(v) => Vals::String(vec![Some(Cow::Owned(v.clone())); n]),
    }
}

fn cell_is(a: &Vals<'_>, i: usize, v: &Literal) -> bool {
    match (a, v) {
        (Vals::Number(p), Literal::Number(x)) => p[i] == *x,
        (Vals::Boolean(p), Literal::Boolean(x)) => (p[i] == 1) == *x,
        (Vals::String(p), Literal::String(x)) => p[i].as_deref() == Some(x.as_str()),
        _ => false,
    }
}

/// JavaScript's text order: UTF-16 code units (differs from Rust's byte
/// order only above U+FFFF against U+E000..U+FFFF).
fn js_order(a: &str, b: &str) -> std::cmp::Ordering {
    if a.is_ascii() && b.is_ascii() {
        a.cmp(b)
    } else {
        a.encode_utf16().cmp(b.encode_utf16())
    }
}

fn holds(op: Op, o: std::cmp::Ordering) -> bool {
    use std::cmp::Ordering::*;
    match op {
        Op::Gt => o == Greater,
        Op::Ge => o != Less,
        Op::Lt => o == Less,
        Op::Le => o != Greater,
        Op::Eq => o == Equal,
        _ => o != Equal,
    }
}

fn num_holds(op: Op, x: f64, y: f64) -> bool {
    // NaN (a gap) makes every comparison false, so `ne` is `!(x == y)`.
    match op {
        Op::Gt => x > y,
        Op::Ge => x >= y,
        Op::Lt => x < y,
        Op::Le => x <= y,
        Op::Eq => x == y,
        _ => x != y,
    }
}

fn compare(op: Op, a: &Vals<'_>, b: &Vals<'_>, n: usize) -> Vec<i8> {
    match (a, b) {
        (Vals::Number(p), Vals::Number(q)) => p
            .iter()
            .zip(q.iter())
            .map(|(&x, &y)| num_holds(op, x, y) as i8)
            .collect(),
        (Vals::String(p), Vals::String(q)) => (0..n)
            .map(|i| match (&p[i], &q[i]) {
                (Some(x), Some(y)) => holds(op, js_order(x, y)) as i8,
                _ => (op == Op::Ne) as i8,
            })
            .collect(),
        (Vals::Boolean(p), Vals::Boolean(q)) => (0..n)
            .map(|i| {
                let both = p[i] >= 0 && q[i] >= 0;
                let eq = both && p[i] == q[i];
                (if op == Op::Eq { eq } else { !eq }) as i8
            })
            .collect(),
        _ => unreachable!("checked: operands of one kind"),
    }
}

fn arith(op: Op) -> fn(f64, f64) -> f64 {
    match op {
        Op::Add => |x, y| x + y,
        Op::Sub => |x, y| x - y,
        Op::Mul => |x, y| x * y,
        _ => |x, y| x / y,
    }
}

/// A non-finite result (division by zero, overflow) is a gap at once.
#[inline(always)]
fn gap_if_infinite(x: f64) -> f64 {
    if x.is_finite() { x } else { f64::NAN }
}

/// `f` on each value, written over `p` when it is owned. One pass, with
/// the finite check inline (a separate pass, or `f` behind a function
/// pointer, costs several times more).
fn unary(p: Cow<'_, [f64]>, f: impl Fn(f64) -> f64) -> Vec<f64> {
    match p {
        Cow::Owned(mut p) => {
            for x in &mut p {
                *x = gap_if_infinite(f(*x));
            }
            p
        }
        Cow::Borrowed(p) => p.iter().map(|&x| gap_if_infinite(f(x))).collect(),
    }
}

/// `f` on each pair, written over whichever side is owned.
fn binary(p: Cow<'_, [f64]>, q: Cow<'_, [f64]>, f: impl Fn(f64, f64) -> f64) -> Vec<f64> {
    match (p, q) {
        (Cow::Owned(mut p), q) => {
            for (x, &y) in p.iter_mut().zip(q.iter()) {
                *x = gap_if_infinite(f(*x, y));
            }
            p
        }
        (p, Cow::Owned(mut q)) => {
            for (y, &x) in q.iter_mut().zip(p.iter()) {
                *y = gap_if_infinite(f(x, *y));
            }
            q
        }
        (p, q) => p
            .iter()
            .zip(q.iter())
            .map(|(&x, &y)| gap_if_infinite(f(x, y)))
            .collect(),
    }
}

/// `yes[i]` where `keep[i]`, else `no[i]`.
fn pick<'a>(keep: &[bool], yes: Vals<'a>, no: Vals<'a>) -> Vals<'a> {
    match (yes, no) {
        (Vals::Number(y), Vals::Number(z)) => Vals::Number(Cow::Owned(
            keep.iter()
                .zip(y.iter().zip(z.iter()))
                .map(|(&k, (&y, &z))| if k { y } else { z })
                .collect(),
        )),
        (Vals::Boolean(y), Vals::Boolean(z)) => Vals::Boolean(
            keep.iter()
                .zip(y.iter().zip(&z))
                .map(|(&k, (&y, &z))| if k { y } else { z })
                .collect(),
        ),
        (Vals::String(y), Vals::String(z)) => Vals::String(
            keep.iter()
                .zip(y.into_iter().zip(z))
                .map(|(&k, (y, z))| if k { y } else { z })
                .collect(),
        ),
        _ => unreachable!("checked: branches of one kind"),
    }
}

/// Shapes with one literal side, done without spreading the literal: a
/// number compared with or combined with a number, and text `eq` / `ne` /
/// `in` against fixed values on a column (a dictionary column decides
/// once per distinct string).
fn scalar_case<'a>(
    op: Op,
    args: &[Expr],
    values: &[Literal],
    src: &'a dyn Source,
) -> Option<Vals<'a>> {
    if op == Op::In {
        let Node::Col(name) = &*args[0].0 else {
            return None;
        };
        let ColumnData::String(c) = src.data(name) else {
            return None;
        };
        return Some(Vals::Boolean(text_test(
            c,
            |s| {
                values
                    .iter()
                    .any(|v| matches!(v, Literal::String(x) if x == s))
            },
            0,
        )));
    }
    let compare = matches!(op, Op::Eq | Op::Ne | Op::Gt | Op::Ge | Op::Lt | Op::Le);
    let arithmetic = matches!(op, Op::Add | Op::Sub | Op::Mul | Op::Div);
    if !compare && !arithmetic {
        return None;
    }
    let (lit_left, other, value) = match (&*args[0].0, &*args[1].0) {
        (Node::Lit(_), Node::Lit(_)) => return None,
        (Node::Lit(l), _) => (true, &args[1], l),
        (_, Node::Lit(l)) => (false, &args[0], l),
        _ => return None,
    };
    match value {
        Literal::String(want) => {
            if !matches!(op, Op::Eq | Op::Ne) {
                return None;
            }
            let Node::Col(name) = &*other.0 else {
                return None;
            };
            let ColumnData::String(c) = src.data(name) else {
                return None;
            };
            let eq = op == Op::Eq;
            Some(Vals::Boolean(text_test(
                c,
                |s| (s == want) == eq,
                (!eq) as i8,
            )))
        }
        Literal::Number(k) => {
            let k = *k;
            let Vals::Number(p) = evaluate(other, src) else {
                return None;
            };
            if arithmetic {
                let out = match (op, lit_left) {
                    (Op::Add, _) => unary(p, |x| x + k),
                    (Op::Mul, _) => unary(p, |x| x * k),
                    (Op::Sub, false) => unary(p, |x| x - k),
                    (Op::Sub, true) => unary(p, |x| k - x),
                    (Op::Div, false) => unary(p, |x| x / k),
                    _ => unary(p, |x| k / x),
                };
                return Some(Vals::Number(Cow::Owned(out)));
            }
            // `5 < v` is `v > 5`.
            let op = if lit_left {
                match op {
                    Op::Gt => Op::Lt,
                    Op::Ge => Op::Le,
                    Op::Lt => Op::Gt,
                    Op::Le => Op::Ge,
                    o => o,
                }
            } else {
                op
            };
            Some(Vals::Boolean(
                p.iter().map(|&x| num_holds(op, x, k) as i8).collect(),
            ))
        }
        Literal::Boolean(_) => None,
    }
}

fn text_test(c: &StringColumn, keep: impl Fn(&str) -> bool, gap: i8) -> Vec<i8> {
    c.test_values(keep, gap)
}

/// Evaluated values as column data; gaps where `keep_gaps_of` has them,
/// when given.
pub(crate) fn column_of(values: Vals<'_>, keep_gaps_of: Option<&Vals<'_>>) -> ColumnData {
    let gap = |i: usize| keep_gaps_of.is_some_and(|g| g.is_gap(i));
    match values {
        Vals::Number(v) => {
            let mut v = v.into_owned();
            match keep_gaps_of {
                Some(Vals::Number(g)) => {
                    for (x, g) in v.iter_mut().zip(g.iter()) {
                        if g.is_nan() {
                            *x = f64::NAN;
                        }
                    }
                }
                Some(_) => {
                    for (i, x) in v.iter_mut().enumerate() {
                        if gap(i) {
                            *x = f64::NAN;
                        }
                    }
                }
                None => {}
            }
            Float64Column::from_values(v).into()
        }
        Vals::Boolean(v) => BooleanColumn::from_options(
            v.iter()
                .enumerate()
                .map(|(i, &x)| (x >= 0 && !gap(i)).then_some(x == 1)),
        )
        .into(),
        Vals::String(v) => StringColumn::from_options(
            v.iter()
                .enumerate()
                .map(|(i, x)| if gap(i) { None } else { x.as_deref() }),
        )
        .into(),
    }
}

/// The true/false values as row numbers kept (a gap fails).
pub(crate) fn kept_rows(values: &Vals<'_>) -> Vec<usize> {
    let Vals::Boolean(v) = values else {
        unreachable!("checked: a true/false expression")
    };
    v.iter()
        .enumerate()
        .filter_map(|(i, &x)| (x == 1).then_some(i))
        .collect()
}

// ─── Per-row evaluation (live layer) ────────────────────────────────

/// One row's value; `None` is a gap.
#[derive(Debug, Clone, PartialEq)]
enum Cell<'a> {
    Number(f64),
    String(Cow<'a, str>),
    Boolean(bool),
}

/// `e` (already [`check`]ed) on one row, reading cells through `get`.
pub(crate) fn evaluate_row<'a>(e: &'a Expr, get: &dyn Fn(&str) -> Option<&'a Value>) -> bool {
    matches!(row_value(e, get), Some(Cell::Boolean(true)))
}

fn row_value<'a>(e: &'a Expr, get: &dyn Fn(&str) -> Option<&'a Value>) -> Option<Cell<'a>> {
    match &*e.0 {
        Node::Col(name) => match get(name)? {
            Value::Number(v) => v.is_finite().then_some(Cell::Number(*v)),
            Value::String(v) => Some(Cell::String(Cow::Borrowed(v))),
            Value::Boolean(v) => Some(Cell::Boolean(*v)),
            _ => None,
        },
        Node::Lit(l) => Some(match l {
            Literal::Number(v) => Cell::Number(*v),
            Literal::String(v) => Cell::String(Cow::Borrowed(v)),
            Literal::Boolean(v) => Cell::Boolean(*v),
        }),
        Node::Op { op, args, values } => {
            let at = |i: usize| row_value(&args[i], get);
            let truthy = |i: usize| matches!(at(i), Some(Cell::Boolean(true)));
            let num = |i: usize| match at(i) {
                Some(Cell::Number(v)) => v,
                _ => f64::NAN,
            };
            let b = |v: bool| Some(Cell::Boolean(v));
            let gap_or = |v: f64| v.is_finite().then_some(Cell::Number(v));
            match op {
                Op::Eq | Op::Ne => {
                    let eq = match (at(0), at(1)) {
                        (Some(x), Some(y)) => x == y,
                        _ => false,
                    };
                    b(if *op == Op::Eq { eq } else { !eq })
                }
                Op::Gt | Op::Ge | Op::Lt | Op::Le => b(match (at(0), at(1)) {
                    (Some(Cell::Number(x)), Some(Cell::Number(y))) => num_holds(*op, x, y),
                    (Some(Cell::String(x)), Some(Cell::String(y))) => holds(*op, js_order(&x, &y)),
                    _ => false,
                }),
                Op::In => {
                    let a = at(0);
                    b(a.is_some_and(|a| {
                        values.iter().any(|v| match (&a, v) {
                            (Cell::Number(x), Literal::Number(y)) => x == y,
                            (Cell::String(x), Literal::String(y)) => x == y,
                            (Cell::Boolean(x), Literal::Boolean(y)) => x == y,
                            _ => false,
                        })
                    }))
                }
                Op::And => b(truthy(0) && truthy(1)),
                Op::Or => b(truthy(0) || truthy(1)),
                Op::Not => b(!truthy(0)),
                Op::Add | Op::Sub | Op::Mul | Op::Div => gap_or(arith(*op)(num(0), num(1))),
                Op::Neg => gap_or(-num(0)),
                Op::Abs => gap_or(num(0).abs()),
                Op::IsMissing => b(at(0).is_none()),
                Op::Fill => at(0).or_else(|| at(1)),
                Op::When => {
                    if truthy(0) {
                        at(1)
                    } else {
                        at(2)
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    //! The column-wise evaluator and the per-row one (live layer) must
    //! agree on every expression; random trees over a series with gaps,
    //! zeros, a gap stored as an infinity and a dictionary text column.
    use super::*;
    use crate::series::{Column, TimeSeries};
    use arrow_array::{DictionaryArray, types::Int32Type};

    fn series() -> TimeSeries {
        let n = 64;
        let a: Vec<f64> = (0..n)
            .map(|i| match i % 9 {
                0 => f64::NAN,
                4 => f64::INFINITY, // a gap stored as an infinity
                5 => 0.0,
                k => k as f64 - 3.5,
            })
            .collect();
        let b: Vec<Option<f64>> = (0..n)
            .map(|i| (i % 7 != 3).then_some(((i * 5) % 11) as f64 - 5.0))
            .collect();
        let words = ["east", "west", "", "Zed", "é", "\u{1F600}", "\u{FF5E}"];
        let h: Vec<Option<&str>> = (0..n)
            .map(|i| (i % 6 != 1).then_some(words[(i * 3) % words.len()]))
            .collect();
        let d: DictionaryArray<Int32Type> = (0..n)
            .map(|i| (i % 5 != 2).then_some(words[i % 4]))
            .collect();
        let up: Vec<Option<bool>> = (0..n).map(|i| (i % 8 != 6).then_some(i % 3 == 0)).collect();
        TimeSeries::new(
            "s",
            (0..n as i64).collect(),
            vec![
                Column::optional_raw("a", a),
                Column::optional("b", b),
                Column::optional("h", h),
                Column::from_data(
                    "d".into(),
                    StringColumn::dictionary(d).expect("utf8 values"),
                    false,
                ),
                Column::optional("up", up),
            ],
        )
        .unwrap()
    }

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn pick(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    fn tree(r: &mut Rng, kind: Kind, depth: u32) -> Expr {
        let leaf = depth == 0 || r.pick(3) == 0;
        match kind {
            Kind::Number => {
                if leaf {
                    return match r.pick(4) {
                        0 => col("a"),
                        1 => col("b"),
                        2 => lit(0),
                        _ => lit([2.5, -1.0, 0.5][r.pick(3)]),
                    };
                }
                let x = tree(r, Kind::Number, depth - 1);
                let y = tree(r, Kind::Number, depth - 1);
                match r.pick(8) {
                    0 => x.add(y),
                    1 => x.sub(y),
                    2 => x.mul(y),
                    3 => x.div(y),
                    4 => x.neg(),
                    5 => x.abs(),
                    6 => x.fill(y),
                    _ => when(tree(r, Kind::Boolean, depth - 1), x, y),
                }
            }
            Kind::String => {
                if leaf {
                    return match r.pick(3) {
                        0 => col("h"),
                        1 => col("d"),
                        _ => lit(["east", "", "\u{1F600}"][r.pick(3)]),
                    };
                }
                let x = tree(r, Kind::String, depth - 1);
                let y = tree(r, Kind::String, depth - 1);
                if r.pick(2) == 0 {
                    x.fill(y)
                } else {
                    when(tree(r, Kind::Boolean, depth - 1), x, y)
                }
            }
            Kind::Boolean => {
                if leaf {
                    return if r.pick(3) == 0 { lit(true) } else { col("up") };
                }
                let k = [Kind::Number, Kind::String][r.pick(2)];
                let x = tree(r, k, depth - 1);
                let y = tree(r, k, depth - 1);
                match r.pick(13) {
                    0 => x.eq(y),
                    1 => x.ne(y),
                    2 => x.gt(y),
                    3 => x.ge(y),
                    4 => x.lt(y),
                    5 => x.le(y),
                    6 => match k {
                        Kind::Number => x.is_in([0.0, 2.5, -1.0]),
                        _ => x.is_in(["east", "", "\u{FF5E}"]),
                    },
                    7 => x.is_missing(),
                    8 => tree(r, Kind::Boolean, depth - 1).and(tree(r, Kind::Boolean, depth - 1)),
                    9 => tree(r, Kind::Boolean, depth - 1).or(tree(r, Kind::Boolean, depth - 1)),
                    10 => tree(r, Kind::Boolean, depth - 1).not(),
                    11 => tree(r, Kind::Boolean, depth - 1).eq(col("up")),
                    _ => when(
                        tree(r, Kind::Boolean, depth - 1),
                        tree(r, Kind::Boolean, depth - 1),
                        col("up"),
                    ),
                }
            }
        }
    }

    /// Row `i` of `v` as the per-row evaluator's value.
    fn cell(v: &Vals<'_>, i: usize) -> Option<Value> {
        match v {
            Vals::Number(p) => p[i].is_finite().then(|| Value::Number(p[i])),
            Vals::Boolean(p) => (p[i] >= 0).then(|| Value::Boolean(p[i] == 1)),
            Vals::String(p) => p[i].as_ref().map(|s| Value::String(s.to_string())),
        }
    }

    #[test]
    fn column_and_row_evaluators_agree() {
        let s = series();
        let defs: Vec<ColumnDef> = s.schema().into_iter().skip(1).collect();
        let rows: Vec<Vec<(String, Option<Value>)>> = (0..s.len())
            .map(|i| {
                s.columns()
                    .iter()
                    .map(|c| {
                        let v = match c.data() {
                            ColumnData::Number(x) => x.get(i).map(Value::Number),
                            ColumnData::String(x) => x.get(i).map(Value::from),
                            ColumnData::Boolean(x) => x.get(i).map(Value::Boolean),
                            _ => None,
                        };
                        (c.name().to_string(), v)
                    })
                    .collect()
            })
            .collect();
        let mut r = Rng(0x5eed_1234_abcd);
        for t in 0..4000 {
            let kind = [Kind::Number, Kind::String, Kind::Boolean][t % 3];
            let e = tree(&mut r, kind, 3);
            assert_eq!(check(&e, &defs, "test").unwrap(), kind, "{}", e.to_json());
            let whole = evaluate(&e, &s);
            for (i, row) in rows.iter().enumerate() {
                let get = |name: &str| {
                    row.iter()
                        .find(|(n, _)| n == name)
                        .and_then(|(_, v)| v.as_ref())
                };
                let one = row_value(&e, &get);
                let want = cell(&whole, i);
                let got = one.map(|c| match c {
                    Cell::Number(v) => Value::Number(v),
                    Cell::String(v) => Value::String(v.into_owned()),
                    Cell::Boolean(v) => Value::Boolean(v),
                });
                let same = match (&got, &want) {
                    (Some(Value::Number(x)), Some(Value::Number(y))) => x.to_bits() == y.to_bits(),
                    _ => got == want,
                };
                assert!(
                    same,
                    "row {i} of {}: row {got:?}, columns {want:?}",
                    e.to_json()
                );
            }
            // JSON round trip.
            assert_eq!(Expr::from_json(&e.to_json()).unwrap(), e);
        }
    }

    #[test]
    fn utf16_text_order() {
        // JavaScript puts U+1F600 (surrogates D83D..) before U+FF5E.
        assert_eq!(js_order("\u{1F600}", "\u{FF5E}"), std::cmp::Ordering::Less);
        let s = series();
        let n = s.filter_expr(&col("h").lt("\u{FF5E}")).unwrap().len();
        let emoji = s.filter_expr(&col("h").eq("\u{1F600}")).unwrap().len();
        assert!(emoji > 0 && n >= emoji);
    }
}
