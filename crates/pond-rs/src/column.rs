//! Value columns: numbers, exact decimals, text, true/false values and
//! arrays.
//!
//! In a number column a gap is stored as `NaN`, as in pond-ts
//! ([PND-NANREP]): any non-finite value in the buffer means "missing".
//! Decimal, text and true/false columns mark gaps with an Arrow null; an
//! array column marks them with `None` (or, while it is still held as the
//! Arrow list it was read from, with a null list).
//!
//! The values live in an Arrow buffer (shared, immutable, reference
//! counted). So a column read from Arrow can point at Arrow's memory instead
//! of copying it, a column written to Arrow is handed over without a copy,
//! and cloning a column or a series does not copy values.

use std::fmt;
use std::sync::{Arc, OnceLock};

use arrow_array::builder::StringBuilder;
use arrow_array::cast::AsArray;
use arrow_array::types::{Decimal128Type, Float64Type, Int32Type};
use arrow_array::{
    Array, ArrayRef, BooleanArray, Decimal128Array, DictionaryArray, Float64Array, ListArray,
    StringArray, UInt32Array,
};
use arrow_buffer::{NullBuffer, OffsetBuffer, ScalarBuffer};
use arrow_schema::{DataType, Field};

use crate::row_filter::RowFilter;
use crate::series::ColumnKind;

/// True when every value is finite. Looks at 64 values at a time, with no
/// branch inside the 64 (so they are tested several at a time), and stops
/// at the first 64 that hold a value that is not.
fn all_finite(v: &[f64]) -> bool {
    v.chunks(64)
        .all(|c| c.iter().fold(true, |ok, x| ok & x.is_finite()))
}

/// A column of `f64` values where any non-finite value (`NaN`, `±inf`) is a
/// gap. Reading a gap gives `None`.
#[derive(Debug, Clone)]
pub struct Float64Column {
    values: ScalarBuffer<f64>,
    /// True when every value is finite (no gaps). Only a speed hint: the
    /// results are the same either way.
    all_finite: bool,
}

impl Float64Column {
    /// Build from raw values; non-finite values become gaps.
    pub fn from_values(values: Vec<f64>) -> Self {
        Self::from_buffer(values.into())
    }

    /// Wrap an Arrow buffer as it is, without copying: non-finite values are
    /// gaps.
    pub(crate) fn from_buffer(values: ScalarBuffer<f64>) -> Self {
        let all_finite = all_finite(&values);
        Self { values, all_finite }
    }

    /// The Arrow buffer holding the values (cheap to clone: shared).
    pub(crate) fn buffer(&self) -> &ScalarBuffer<f64> {
        &self.values
    }

    /// Build from optional values; `None` is a gap.
    pub fn from_options(values: impl IntoIterator<Item = Option<f64>>) -> Self {
        Self::from_values(values.into_iter().map(|v| v.unwrap_or(f64::NAN)).collect())
    }

    /// Number of values.
    pub fn len(&self) -> usize {
        self.values.len()
    }

    /// `true` when there are no values.
    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    /// The value at `i`, or `None` for a gap. Panics if `i` is out of range.
    pub fn get(&self, i: usize) -> Option<f64> {
        let v = self.values[i];
        v.is_finite().then_some(v)
    }

    /// The raw buffer: gaps are non-finite values.
    pub fn values(&self) -> &[f64] {
        &self.values
    }

    /// True when the column has no gaps.
    pub fn all_finite(&self) -> bool {
        self.all_finite
    }

    /// Number of gaps.
    pub fn missing_count(&self) -> usize {
        if self.all_finite {
            0
        } else {
            self.values.iter().filter(|v| !v.is_finite()).count()
        }
    }

    /// Iterate as `Option<f64>`.
    pub fn iter(&self) -> impl Iterator<Item = Option<f64>> + '_ {
        self.values.iter().map(|&v| v.is_finite().then_some(v))
    }
}

/// Two number columns are equal when they hold the same values, bit for bit
/// (so `-0.0` and `0.0` differ), and gaps in the same rows, however each gap
/// is stored (`NaN` or an infinity).
impl PartialEq for Float64Column {
    fn eq(&self, other: &Self) -> bool {
        let bits = |c: &Self| c.iter().map(|v| v.map(f64::to_bits)).collect::<Vec<_>>();
        self.len() == other.len() && bits(self) == bits(other)
    }
}

/// A column of text values (pond-ts `kind: 'string'`). A gap is an Arrow
/// null; an empty string is a value, not a gap.
///
/// Held as an Arrow `Utf8` array, or as a dictionary (`Dictionary<Int32,
/// Utf8>`: each row an index into a list of distinct strings) when it was
/// read that way from Arrow. Reading gives the same values either way;
/// [`StringColumn::is_dictionary`] says which, and `to_arrow` writes it back
/// the same way. Two columns are equal when they hold the same values,
/// however each is held.
#[derive(Debug, Clone)]
pub struct StringColumn {
    repr: StringRepr,
}

#[derive(Debug, Clone)]
enum StringRepr {
    Plain(StringArray),
    Dictionary(DictionaryArray<Int32Type>),
}

impl StringColumn {
    /// Build from optional values; `None` is a gap.
    pub fn from_options<S: AsRef<str>>(values: impl IntoIterator<Item = Option<S>>) -> Self {
        Self::plain(values.into_iter().collect::<StringArray>())
    }

    /// Wrap an Arrow `Utf8` array without copying.
    pub(crate) fn plain(array: StringArray) -> Self {
        Self {
            repr: StringRepr::Plain(array),
        }
    }

    /// Wrap an Arrow dictionary array without copying. Its values must be
    /// `Utf8` with no nulls.
    pub(crate) fn dictionary(array: DictionaryArray<Int32Type>) -> Option<Self> {
        let values = array.values();
        (values.data_type() == &DataType::Utf8 && values.null_count() == 0).then_some(Self {
            repr: StringRepr::Dictionary(array),
        })
    }

    /// Number of values.
    pub fn len(&self) -> usize {
        match &self.repr {
            StringRepr::Plain(a) => a.len(),
            StringRepr::Dictionary(a) => a.len(),
        }
    }

    /// `true` when there are no values.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The value at `i`, or `None` for a gap. Panics if `i` is out of range.
    pub fn get(&self, i: usize) -> Option<&str> {
        assert!(i < self.len(), "row {i} out of range ({} rows)", self.len());
        match &self.repr {
            StringRepr::Plain(a) => a.is_valid(i).then(|| a.value(i)),
            StringRepr::Dictionary(a) => a.is_valid(i).then(|| {
                let key = a.keys().value(i) as usize;
                a.values().as_string::<i32>().value(key)
            }),
        }
    }

    /// Iterate as `Option<&str>`.
    pub fn iter(&self) -> impl Iterator<Item = Option<&str>> + '_ {
        (0..self.len()).map(|i| self.get(i))
    }

    /// Number of gaps.
    pub fn missing_count(&self) -> usize {
        self.arrow().logical_null_count()
    }

    /// True when held as a dictionary (see the type's notes).
    pub fn is_dictionary(&self) -> bool {
        matches!(self.repr, StringRepr::Dictionary(_))
    }

    /// The Arrow array behind the column (shared, not copied).
    pub(crate) fn arrow(&self) -> ArrayRef {
        match &self.repr {
            StringRepr::Plain(a) => Arc::new(a.clone()),
            StringRepr::Dictionary(a) => Arc::new(a.clone()),
        }
    }

    /// The rows named by `rows`, in that order; `None` gives a gap. A
    /// dictionary column stays one, sharing its whole list of strings, so a
    /// short result (an `aggregate` of a long column) still carries, and
    /// writes to Arrow, every distinct string of the source.
    pub(crate) fn take(&self, rows: &[Option<usize>]) -> Self {
        self.take_indices(&indices_of(rows))
    }
}

impl StringColumn {
    /// The rows where `keep` is set, in order. Plain text goes as
    /// [`RowFilter::text`] has it. A dictionary column filters its keys and
    /// keeps its values, as [`StringColumn::take_indices`]: straight from
    /// the mask, or by the list of kept rows ([`RowFilter::by_list`]) when
    /// `listed` says the list is there to share and the keys are the
    /// faster by it ([`RowFilter::list_pays`]).
    pub(crate) fn filter(&self, keep: &RowFilter, listed: bool) -> Self {
        match &self.repr {
            StringRepr::Plain(a) => Self::plain(keep.text(a)),
            StringRepr::Dictionary(a) => Self {
                repr: StringRepr::Dictionary(if listed && keep.list_pays(size_of::<i32>()) {
                    keep.by_list(a).as_dictionary::<Int32Type>().clone()
                } else {
                    keep.dictionary(a)
                }),
            },
        }
    }
}

impl StringColumn {
    /// The rows at `indices` (a null index gives a gap), with Arrow's
    /// gather kernel: offsets first, then one copy per row, about three
    /// times faster than appending to a builder. A dictionary column
    /// gathers its keys and keeps its values.
    pub(crate) fn take_indices(&self, indices: &UInt32Array) -> Self {
        let array: &dyn Array = match &self.repr {
            StringRepr::Plain(a) => a,
            StringRepr::Dictionary(a) => a,
        };
        let out = arrow_select::take::take(array, indices, None).expect("row numbers are in range");
        match &self.repr {
            StringRepr::Plain(_) => Self::plain(out.as_string::<i32>().clone()),
            StringRepr::Dictionary(_) => Self {
                repr: StringRepr::Dictionary(out.as_dictionary::<Int32Type>().clone()),
            },
        }
    }
}

impl StringColumn {
    /// Per row, 1 where `keep` holds for the value, 0 where it does not,
    /// `gap` for a gap. A dictionary column decides once per distinct
    /// string, then reads its keys (column expressions' text tests).
    pub(crate) fn test_values(&self, keep: impl Fn(&str) -> bool, gap: i8) -> Vec<i8> {
        match &self.repr {
            StringRepr::Plain(a) => (0..a.len())
                .map(|i| {
                    if a.is_valid(i) {
                        keep(a.value(i)) as i8
                    } else {
                        gap
                    }
                })
                .collect(),
            StringRepr::Dictionary(a) => {
                let values = a.values().as_string::<i32>();
                let table: Vec<i8> = (0..values.len())
                    .map(|k| keep(values.value(k)) as i8)
                    .collect();
                let keys = a.keys();
                (0..a.len())
                    .map(|i| {
                        if a.is_valid(i) {
                            table[keys.value(i) as usize]
                        } else {
                            gap
                        }
                    })
                    .collect()
            }
        }
    }
}

/// `rows` as Arrow row numbers, `None` as a null.
pub(crate) fn indices_of(rows: &[Option<usize>]) -> UInt32Array {
    rows.iter()
        .map(|r| r.map(|i| u32::try_from(i).expect("a text column has under 2^32 rows")))
        .collect()
}

impl PartialEq for StringColumn {
    fn eq(&self, other: &Self) -> bool {
        self.len() == other.len() && self.iter().eq(other.iter())
    }
}

/// A column of true/false values (pond-ts `kind: 'boolean'`). A gap is an
/// Arrow null. Held as an Arrow `Boolean` array (one bit per row).
#[derive(Debug, Clone, PartialEq)]
pub struct BooleanColumn {
    values: BooleanArray,
}

impl BooleanColumn {
    /// Build from optional values; `None` is a gap.
    pub fn from_options(values: impl IntoIterator<Item = Option<bool>>) -> Self {
        Self::from_arrow(values.into_iter().collect())
    }

    /// Wrap an Arrow array without copying.
    pub(crate) fn from_arrow(values: BooleanArray) -> Self {
        Self { values }
    }

    /// Number of values.
    pub fn len(&self) -> usize {
        self.values.len()
    }

    /// `true` when there are no values.
    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    /// The value at `i`, or `None` for a gap. Panics if `i` is out of range.
    pub fn get(&self, i: usize) -> Option<bool> {
        assert!(i < self.len(), "row {i} out of range ({} rows)", self.len());
        self.values.is_valid(i).then(|| self.values.value(i))
    }

    /// Iterate as `Option<bool>`.
    pub fn iter(&self) -> impl Iterator<Item = Option<bool>> + '_ {
        self.values.iter()
    }

    /// Number of gaps.
    pub fn missing_count(&self) -> usize {
        self.values.null_count()
    }

    /// The Arrow array behind the column (shared, not copied).
    pub(crate) fn arrow(&self) -> ArrayRef {
        Arc::new(self.values.clone())
    }

    /// The rows named by `rows`, in that order; `None` gives a gap.
    pub(crate) fn take(&self, rows: &[Option<usize>]) -> Self {
        Self::from_options(rows.iter().map(|r| r.and_then(|i| self.get(i))))
    }
}

/// One value of any column kind: a [`Fill::Value`](crate::Fill::Value)
/// literal, or one part of a partition key
/// ([`PartitionedSeries`](crate::PartitionedSeries)), where `None` stands
/// for a gap.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    /// A number.
    Number(f64),
    /// As a fill value, must have the column's scale.
    Decimal(Decimal),
    /// Text.
    String(String),
    /// A true/false value.
    Boolean(bool),
    /// The elements of one array cell (see [`ArrayColumn`]).
    Array(Vec<Scalar>),
}

impl From<f64> for Value {
    fn from(v: f64) -> Self {
        Value::Number(v)
    }
}

impl From<&str> for Value {
    fn from(v: &str) -> Self {
        Value::String(v.to_string())
    }
}

impl From<String> for Value {
    fn from(v: String) -> Self {
        Value::String(v)
    }
}

impl From<bool> for Value {
    fn from(v: bool) -> Self {
        Value::Boolean(v)
    }
}

impl From<Vec<Scalar>> for Value {
    fn from(v: Vec<Scalar>) -> Self {
        Value::Array(v)
    }
}

impl From<Decimal> for Value {
    fn from(v: Decimal) -> Self {
        Value::Decimal(v)
    }
}

impl Value {
    /// The number, if this is a [`Value::Number`].
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Number(v) => Some(*v),
            _ => None,
        }
    }

    /// The decimal, if this is a [`Value::Decimal`].
    pub fn as_decimal(&self) -> Option<Decimal> {
        match self {
            Value::Decimal(v) => Some(*v),
            _ => None,
        }
    }

    /// The text, if this is a [`Value::String`]. For a partition key part
    /// (`Option<Value>`), `part.as_ref().and_then(Value::as_str)`:
    ///
    /// ```
    /// # use pond_rs::{Column, TimeSeries, Value};
    /// let s = TimeSeries::new("s", vec![0, 1], vec![
    ///     Column::required("symbol", vec!["AAPL", "MSFT"]),
    /// ])?;
    /// let parts = s.partition_by(&["symbol"])?;
    /// let names: Vec<&str> = parts
    ///     .iter()
    ///     .filter_map(|(key, _)| key[0].as_ref().and_then(Value::as_str))
    ///     .collect();
    /// assert_eq!(names, ["AAPL", "MSFT"]);
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(v) => Some(v),
            _ => None,
        }
    }

    /// The true/false value, if this is a [`Value::Boolean`].
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Boolean(v) => Some(*v),
            _ => None,
        }
    }

    /// The elements, if this is a [`Value::Array`].
    pub fn as_array(&self) -> Option<&[Scalar]> {
        match self {
            Value::Array(v) => Some(v),
            _ => None,
        }
    }
}

/// One exact decimal: `value × 10^-scale`, so `Decimal { value: 125, scale:
/// 2 }` is `1.25`. Prints as a decimal (`1.25`). Equality compares `value`
/// and `scale` as stored, so `1.25` at scale 2 is not equal to `1.250` at
/// scale 3 (a column has one scale, so within a column this never arises).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Decimal {
    /// The whole number stored (Arrow's raw `i128`).
    pub value: i128,
    /// Digits after the decimal point (negative: zeros before it).
    pub scale: i8,
}

impl Decimal {
    /// The nearest `f64` (exact when the decimal is one; correctly rounded
    /// otherwise).
    pub fn to_f64(self) -> f64 {
        // Both parts are exact and one division rounds once.
        const EXACT: u128 = 1 << 53;
        if (-22..=22).contains(&self.scale) && self.value.unsigned_abs() <= EXACT {
            let power = 10f64.powi(i32::from(self.scale.abs()));
            return if self.scale >= 0 {
                self.value as f64 / power
            } else {
                self.value as f64 * power
            };
        }
        // Rust's float parsing rounds correctly.
        self.to_string().parse().expect("a decimal parses as f64")
    }
}

impl std::fmt::Display for Decimal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let digits = self.value.unsigned_abs().to_string();
        let sign = if self.value < 0 { "-" } else { "" };
        let scale = i32::from(self.scale);
        if scale <= 0 {
            let zeros = if self.value == 0 {
                0
            } else {
                (-scale) as usize
            };
            return write!(f, "{sign}{digits}{}", "0".repeat(zeros));
        }
        let scale = scale as usize;
        let padded = format!("{digits:0>width$}", width = scale + 1);
        let (whole, frac) = padded.split_at(padded.len() - scale);
        write!(f, "{sign}{whole}.{frac}")
    }
}

/// A column of exact decimals: Arrow `Decimal128(precision, scale)`. Each
/// value is a whole number (`i128`) and the column has one scale, so `1.25`
/// at scale 2 is stored as `125`. A gap is an Arrow null.
///
/// pond-ts has no decimal kind. pond-rs keeps decimals exact through
/// `count`, `first`, `last`, `min`, `max`, `keep`, `sum` and `difference`;
/// every other reducer works on the nearest `f64` and gives a number
/// column (or, for `unique`, `top<N>` and `samples`, a list of numbers).
#[derive(Debug, Clone, PartialEq)]
pub struct DecimalColumn {
    values: Decimal128Array,
}

impl DecimalColumn {
    /// Build from raw whole numbers at `scale` (`None` is a gap), with the
    /// widest precision, 38 digits. An error if a value has more than 38
    /// digits or `scale` is outside `-38..=38`.
    pub fn from_options(
        values: impl IntoIterator<Item = Option<i128>>,
        scale: i8,
    ) -> crate::error::Result<Self> {
        let array: Decimal128Array = values.into_iter().collect();
        Self::with_type(array, 38, scale)
    }

    /// [`DecimalColumn::from_options`] with no gaps.
    pub fn from_values(values: Vec<i128>, scale: i8) -> crate::error::Result<Self> {
        Self::from_options(values.into_iter().map(Some), scale)
    }

    pub(crate) fn with_type(
        array: Decimal128Array,
        precision: u8,
        scale: i8,
    ) -> crate::error::Result<Self> {
        let invalid = |e: arrow_schema::ArrowError| crate::error::PondError::InvalidData {
            call: "DecimalColumn",
            message: e.to_string(),
        };
        let array = array
            .with_precision_and_scale(precision, scale)
            .map_err(invalid)?;
        // Not arrow's validate_decimal_precision: it casts the scale to u8,
        // so it refuses every negative scale.
        let max = 10u128.pow(u32::from(precision)) - 1;
        if let Some(i) =
            (0..array.len()).find(|&i| array.is_valid(i) && array.value(i).unsigned_abs() > max)
        {
            return Err(crate::error::PondError::InvalidData {
                call: "DecimalColumn",
                message: format!(
                    "row {i}: {} has more than {precision} digits (the precision)",
                    Decimal {
                        value: array.value(i),
                        scale
                    }
                ),
            });
        }
        Ok(Self { values: array })
    }

    /// Number of values.
    pub fn len(&self) -> usize {
        self.values.len()
    }

    /// `true` when there are no values.
    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    /// Digits after the decimal point, the same for every row.
    pub fn scale(&self) -> i8 {
        self.values.scale()
    }

    /// The most digits a value may have (Arrow's precision, at most 38).
    pub fn precision(&self) -> u8 {
        self.values.precision()
    }

    /// The value at `i`, or `None` for a gap. Panics if `i` is out of range.
    pub fn get(&self, i: usize) -> Option<Decimal> {
        assert!(i < self.len(), "row {i} out of range ({} rows)", self.len());
        self.values.is_valid(i).then(|| Decimal {
            value: self.values.value(i),
            scale: self.scale(),
        })
    }

    /// Iterate as `Option<Decimal>`.
    pub fn iter(&self) -> impl Iterator<Item = Option<Decimal>> + '_ {
        (0..self.len()).map(|i| self.get(i))
    }

    /// The raw whole numbers (gaps hold an unspecified value; see
    /// [`DecimalColumn::get`]).
    pub(crate) fn raw(&self) -> &[i128] {
        self.values.values()
    }

    /// Number of gaps.
    pub fn missing_count(&self) -> usize {
        self.values.null_count()
    }

    /// The Arrow array behind the column (shared, not copied).
    pub(crate) fn arrow(&self) -> ArrayRef {
        Arc::new(self.values.clone())
    }

    pub(crate) fn nulls(&self) -> Option<&NullBuffer> {
        self.values.nulls()
    }

    /// Each row as the nearest `f64`, `NaN` for a gap.
    pub(crate) fn to_f64s(&self) -> Vec<f64> {
        let scale = self.scale();
        // Decimal::to_f64's fast path with the divisor worked out once.
        let divisor = (0..=22)
            .contains(&scale)
            .then(|| 10f64.powi(i32::from(scale)));
        const EXACT: i128 = 1 << 53;
        let raw = self.raw();
        (0..self.len())
            .map(|i| {
                let value = raw[i];
                match divisor {
                    _ if self.values.is_null(i) => f64::NAN,
                    Some(d) if (-EXACT..=EXACT).contains(&value) => value as i64 as f64 / d,
                    _ => Decimal { value, scale }.to_f64(),
                }
            })
            .collect()
    }

    /// Raw values at this column's scale and the given precision.
    pub(crate) fn rebuild(
        &self,
        values: impl IntoIterator<Item = Option<i128>>,
        precision: u8,
    ) -> Self {
        let array: Decimal128Array = values.into_iter().collect();
        Self {
            values: array
                .with_precision_and_scale(precision, self.scale())
                .expect("this column's own scale"),
        }
    }

    /// The rows named by `rows`, in that order; `None` gives a gap.
    pub(crate) fn take(&self, rows: &[Option<usize>]) -> Self {
        self.rebuild(
            rows.iter()
                .map(|r| r.and_then(|i| self.values.is_valid(i).then(|| self.values.value(i)))),
            self.precision(),
        )
    }
}

/// One element of an array cell: a number, text or a true/false value, as
/// pond-ts's `ScalarValue`. Numbers must be finite (checked when a series
/// is built).
///
/// `==` compares as JavaScript's `includes` does on finite elements
/// (SameValueZero): `0.0` equals `-0.0`, and values of different kinds never
/// match (`1` is not `"1"`).
#[derive(Debug, Clone, PartialEq)]
pub enum Scalar {
    /// A number.
    Number(f64),
    /// Text.
    String(String),
    /// A true/false value.
    Boolean(bool),
}

impl Scalar {
    /// The kind of column this element would sit in: number, string or
    /// boolean.
    pub fn kind(&self) -> ColumnKind {
        match self {
            Scalar::Number(_) => ColumnKind::Number,
            Scalar::String(_) => ColumnKind::String,
            Scalar::Boolean(_) => ColumnKind::Boolean,
        }
    }

    /// The number, if this is a [`Scalar::Number`].
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Scalar::Number(v) => Some(*v),
            _ => None,
        }
    }

    /// The text, if this is a [`Scalar::String`].
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Scalar::String(v) => Some(v),
            _ => None,
        }
    }

    /// The true/false value, if this is a [`Scalar::Boolean`].
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Scalar::Boolean(v) => Some(*v),
            _ => None,
        }
    }

    /// The same element as a [`Value`].
    pub fn to_value(&self) -> Value {
        match self {
            Scalar::Number(v) => Value::Number(*v),
            Scalar::String(v) => Value::String(v.clone()),
            Scalar::Boolean(v) => Value::Boolean(*v),
        }
    }

    /// Equal bit for bit: as `==`, except `0.0` and `-0.0` differ.
    pub(crate) fn same(&self, other: &Scalar) -> bool {
        match (self, other) {
            (Scalar::Number(a), Scalar::Number(b)) => a.to_bits() == b.to_bits(),
            _ => self == other,
        }
    }
}

impl From<f64> for Scalar {
    fn from(v: f64) -> Self {
        Scalar::Number(v)
    }
}

impl From<i32> for Scalar {
    fn from(v: i32) -> Self {
        Scalar::Number(f64::from(v))
    }
}

impl From<&str> for Scalar {
    fn from(v: &str) -> Self {
        Scalar::String(v.to_string())
    }
}

impl From<String> for Scalar {
    fn from(v: String) -> Self {
        Scalar::String(v)
    }
}

impl From<bool> for Scalar {
    fn from(v: bool) -> Self {
        Scalar::Boolean(v)
    }
}

/// One array cell: its elements, shared (cloning a cell or a column does
/// not copy them).
pub(crate) type Cell = Arc<[Scalar]>;

/// A column of arrays (pond-ts `kind: 'array'`): each row holds a list of
/// numbers, text and true/false values, mixed freely, or is a gap. An empty
/// list is a value, not a gap. Numbers must be finite.
///
/// ```
/// # use pond_rs::{ArrayColumn, Column, Scalar, TimeSeries};
/// let tags = ArrayColumn::from_options([
///     Some(vec!["a".into(), "b".into()]),
///     Some(vec![]),
///     None,
///     Some(vec![Scalar::from(1.0), true.into()]),
/// ]);
/// let s = TimeSeries::new("s", vec![0, 1, 2, 3], vec![Column::optional("tags", tags)])?;
/// let tags = s.column("tags")?.arrays()?;
/// assert_eq!(tags.get(0), Some(&[Scalar::from("a"), "b".into()][..]));
/// assert_eq!(tags.get(1), Some(&[][..])); // empty, not a gap
/// assert_eq!(tags.get(2), None);
/// # Ok::<(), pond_rs::PondError>(())
/// ```
///
/// In Arrow an array column is a list: [`TimeSeries::to_arrow`] writes one
/// when every element in the column is the same kind, and
/// [`TimeSeries::from_arrow`] reads lists of numbers, text or true/false
/// values. pond-ts has no Arrow form for arrays.
///
/// Cost: a column read from an Arrow list of numbers or text, and the
/// output of `samples` over a number or decimal column, is held as the
/// Arrow list. The first call of [`ArrayColumn::get`] or
/// [`ArrayColumn::iter`] on it (or on a slice or clone of it) builds every
/// row's list of [`Scalar`]s, one allocation per row and per text item,
/// and keeps them; later calls are free.
///
/// [`TimeSeries::to_arrow`]: crate::TimeSeries::to_arrow
/// [`TimeSeries::from_arrow`]: crate::TimeSeries::from_arrow
#[derive(Clone)]
pub struct ArrayColumn {
    store: Arc<ArrayStore>,
    offset: usize,
    len: usize,
}

/// The rows behind an array column (and every slice of it), in one or both
/// of two forms. A column built from Rust values has its cells. A column
/// read from Arrow, or written by a kernel that makes lists of numbers,
/// has the Arrow list; its cells are built from the list the first time
/// one is read and kept. Both forms always hold the same rows.
struct ArrayStore {
    /// The rows as an Arrow list in the layout [`canonical_list`] gives.
    list: Option<ListArray>,
    /// The rows as cells; made on first use when `list` is set.
    cells: OnceLock<Box<[Option<Cell>]>>,
}

/// A window on an array column held as an Arrow list (see
/// [`ArrayColumn::list_view`]).
pub(crate) struct ListView<'a> {
    /// Row `r`'s items are `offsets[r]..offsets[r + 1]` of `values`.
    pub(crate) offsets: &'a [i32],
    /// The items of every row: `Float64` or `Utf8`, none null.
    pub(crate) values: &'a ArrayRef,
    /// Which rows are gaps, when any is.
    nulls: Option<NullBuffer>,
}

impl ListView<'_> {
    /// True when row `r` is a gap.
    pub(crate) fn is_gap(&self, r: usize) -> bool {
        self.nulls.as_ref().is_some_and(|n| n.is_null(r))
    }

    /// The items as numbers, when the lists hold numbers.
    pub(crate) fn numbers(&self) -> Option<&[f64]> {
        self.values
            .as_primitive_opt::<Float64Type>()
            .map(|a| &a.values()[..])
    }
}

/// `list` in the one layout an array column keeps and
/// `TimeSeries::to_arrow` writes: `List` of non-null `Float64` or `Utf8`
/// items named `item`, offsets from 0, the items exactly those the rows
/// use, an empty range under every null list, and no null buffer when no
/// list is null. `None` when the list cannot be put that way without
/// reading its items one by one: another item type, a null item, items
/// under a null list, or no items at all (a column with none is written as
/// a list of `Utf8`, whatever it was read as).
///
/// Cost: one pass over the offsets and the null bits; the items are shared,
/// not copied.
pub(crate) fn canonical_list(list: &ListArray) -> Option<ListArray> {
    let values = list.values();
    if values.null_count() > 0 {
        return None;
    }
    let offsets = list.value_offsets();
    let (lo, hi) = (offsets[0] as usize, offsets[list.len()] as usize);
    if hi == lo {
        return None;
    }
    let nulls = list.nulls().filter(|n| n.null_count() > 0);
    if let Some(nulls) = nulls
        && (0..list.len()).any(|r| nulls.is_null(r) && offsets[r] != offsets[r + 1])
    {
        return None;
    }
    let items: ArrayRef = match values.data_type() {
        DataType::Float64 => {
            let v = values.as_primitive::<Float64Type>();
            Arc::new(Float64Array::new(v.values().slice(lo, hi - lo), None))
        }
        DataType::Utf8 => {
            let v = values.as_string::<i32>();
            let text = v.value_offsets();
            let (first, last) = (text[lo], text[hi]);
            let whole =
                lo == 0 && hi == v.len() && first == 0 && last as usize == v.value_data().len();
            if whole {
                Arc::new(StringArray::new(
                    v.offsets().clone(),
                    v.values().clone(),
                    None,
                ))
            } else {
                let rebased: Vec<i32> = text[lo..=hi].iter().map(|o| o - first).collect();
                let bytes = v
                    .values()
                    .slice_with_length(first as usize, (last - first) as usize);
                Arc::new(StringArray::new(
                    OffsetBuffer::new(rebased.into()),
                    bytes,
                    None,
                ))
            }
        }
        _ => return None,
    };
    let offsets = if lo == 0 {
        list.offsets().clone()
    } else {
        let lo = lo as i32;
        OffsetBuffer::new(offsets.iter().map(|o| o - lo).collect::<Vec<i32>>().into())
    };
    // The null bits are written out afresh, so the buffer is the same
    // whatever spare bits or bit offset the source had.
    let nulls = nulls.map(|n| NullBuffer::from_iter((0..list.len()).map(|r| n.is_valid(r))));
    let item = Arc::new(Field::new_list_field(items.data_type().clone(), false));
    Some(ListArray::new(item, offsets, items, nulls))
}

/// The rows of a canonical list as cells.
fn cells_of(list: &ListArray) -> Box<[Option<Cell>]> {
    let offsets = list.value_offsets();
    let range = |r: usize| offsets[r] as usize..offsets[r + 1] as usize;
    let present = |r: usize| list.nulls().is_none_or(|n| n.is_valid(r));
    match list.values().data_type() {
        DataType::Float64 => {
            let v = list.values().as_primitive::<Float64Type>().values();
            (0..list.len())
                .map(|r| {
                    present(r).then(|| v[range(r)].iter().map(|&x| Scalar::Number(x)).collect())
                })
                .collect()
        }
        _ => {
            let v = list.values().as_string::<i32>();
            (0..list.len())
                .map(|r| {
                    present(r).then(|| {
                        range(r)
                            .map(|k| Scalar::String(v.value(k).to_string()))
                            .collect()
                    })
                })
                .collect()
        }
    }
}

impl ArrayColumn {
    /// Build from optional lists; `None` is a gap.
    pub fn from_options(values: impl IntoIterator<Item = Option<Vec<Scalar>>>) -> Self {
        Self::from_cells(values.into_iter().map(|v| v.map(Cell::from)).collect())
    }

    pub(crate) fn from_cells(cells: Vec<Option<Cell>>) -> Self {
        let len = cells.len();
        Self {
            store: Arc::new(ArrayStore {
                list: None,
                cells: OnceLock::from({
                    // Moved to a block of their own and the `Vec`'s freed,
                    // not kept in the `Vec`'s block. Keeping it measured
                    // 0.3-0.5 ms slower on later `unique` / `top` reduces
                    // of a 1M-row series, with the same instruction count:
                    // the block the `Vec` frees is where their scratch
                    // lists then go.
                    let mut moved = Vec::with_capacity(len);
                    moved.extend(cells);
                    moved.into_boxed_slice()
                }),
            }),
            offset: 0,
            len,
        }
    }

    /// A column that is `list`'s rows, which must be laid out as
    /// [`canonical_list`] lays them out.
    ///
    /// Cost: nothing is read or copied. The cells behind
    /// [`ArrayColumn::get`] and [`ArrayColumn::iter`] are built the first
    /// time one is asked for: one allocation per row and one per text item.
    pub(crate) fn from_list(list: ListArray) -> Self {
        debug_assert!(list.value_offsets()[0] == 0 && !list.values().is_empty());
        let len = list.len();
        Self {
            store: Arc::new(ArrayStore {
                list: Some(list),
                cells: OnceLock::new(),
            }),
            offset: 0,
            len,
        }
    }

    /// Number of values.
    pub fn len(&self) -> usize {
        self.len
    }

    /// `true` when there are no values.
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Every row of the store, built from the Arrow list if need be.
    fn store_cells(&self) -> &[Option<Cell>] {
        self.store.cells.get_or_init(|| {
            cells_of(
                self.store
                    .list
                    .as_ref()
                    .expect("a store has cells or a list"),
            )
        })
    }

    /// The rows as cells (built from the Arrow list if need be): `None` is
    /// a gap.
    pub(crate) fn cells(&self) -> &[Option<Cell>] {
        &self.store_cells()[self.offset..self.offset + self.len]
    }

    /// The column as an Arrow list, when it is held as one: the rows'
    /// offsets, the items and the gaps, without building any cell.
    pub(crate) fn list_view(&self) -> Option<ListView<'_>> {
        let list = self.store.list.as_ref()?;
        Some(ListView {
            offsets: &list.value_offsets()[self.offset..=self.offset + self.len],
            values: list.values(),
            nulls: list.nulls().map(|n| n.slice(self.offset, self.len)),
        })
    }

    /// The column as an Arrow list in the layout `TimeSeries::to_arrow`
    /// writes, when it is held as one (see [`canonical_list`]).
    ///
    /// Cost: the whole column shares the list; a slice shares the items and
    /// copies its offsets.
    pub(crate) fn list(&self) -> Option<ListArray> {
        let list = self.store.list.as_ref()?;
        if self.offset == 0 && self.len == list.len() {
            return Some(list.clone());
        }
        canonical_list(&list.slice(self.offset, self.len))
    }

    /// The list at `i`, or `None` for a gap. Panics if `i` is out of range.
    pub fn get(&self, i: usize) -> Option<&[Scalar]> {
        self.cells()[i].as_deref()
    }

    /// The shared cell at `i`.
    pub(crate) fn cell(&self, i: usize) -> Option<&Cell> {
        self.cells()[i].as_ref()
    }

    /// True when row `i` holds a list. Panics if `i` is out of range.
    pub(crate) fn is_present(&self, i: usize) -> bool {
        assert!(i < self.len, "row {i} of {}", self.len);
        match (self.store.cells.get(), &self.store.list) {
            (Some(cells), _) => cells[self.offset + i].is_some(),
            (None, Some(list)) => list.is_valid(self.offset + i),
            (None, None) => unreachable!("a store has cells or a list"),
        }
    }

    /// Iterate as `Option<&[Scalar]>`.
    pub fn iter(&self) -> impl Iterator<Item = Option<&[Scalar]>> + '_ {
        self.cells().iter().map(|c| c.as_deref())
    }

    /// Number of gaps.
    pub fn missing_count(&self) -> usize {
        match (self.store.cells.get(), &self.store.list) {
            (None, Some(list)) => list
                .nulls()
                .map_or(0, |n| n.slice(self.offset, self.len).null_count()),
            _ => self.cells().iter().filter(|c| c.is_none()).count(),
        }
    }

    /// The first element that is not a finite number, string or boolean
    /// (a non-finite number): `(row, element)`.
    pub(crate) fn first_bad_element(&self) -> Option<(usize, usize)> {
        if let Some(view) = self.list_view() {
            let numbers = view.numbers()?;
            let (lo, hi) = (view.offsets[0] as usize, view.offsets[self.len] as usize);
            let at = lo + numbers[lo..hi].iter().position(|v| !v.is_finite())?;
            // The last row starting at or before the item (empty rows
            // before it share its start).
            let row = view.offsets.partition_point(|&o| o as usize <= at) - 1;
            return Some((row, at - view.offsets[row] as usize));
        }
        self.iter().enumerate().find_map(|(r, cell)| {
            cell?
                .iter()
                .position(|e| matches!(e, Scalar::Number(v) if !v.is_finite()))
                .map(|e| (r, e))
        })
    }

    /// The rows named by `rows`, in that order; `None` gives a gap. Cells
    /// are shared, not copied.
    pub(crate) fn take(&self, rows: &[Option<usize>]) -> Self {
        let cells = self.cells();
        Self::from_cells(
            rows.iter()
                .map(|r| r.and_then(|i| cells[i].clone()))
                .collect(),
        )
    }
}

/// As the cells, whichever form the column is held in.
impl fmt::Debug for ArrayColumn {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ArrayColumn")
            .field("cells", &self.store_cells())
            .field("offset", &self.offset)
            .field("len", &self.len)
            .finish()
    }
}

/// Equal when the same rows are gaps and the lists hold the same elements
/// bit for bit (so `-0.0` and `0.0` differ, as in number columns).
impl PartialEq for ArrayColumn {
    fn eq(&self, other: &Self) -> bool {
        self.len == other.len
            && self.iter().zip(other.iter()).all(|(a, b)| match (a, b) {
                (None, None) => true,
                (Some(a), Some(b)) => a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.same(y)),
                _ => false,
            })
    }
}

/// What a value column holds: numbers, exact decimals, text, true/false
/// values, or arrays.
#[derive(Debug, Clone, PartialEq)]
pub enum ColumnData {
    /// Numbers (`f64`, `NaN` marks a gap).
    Number(Float64Column),
    /// Exact decimals.
    Decimal(DecimalColumn),
    /// Text.
    String(StringColumn),
    /// True/false values.
    Boolean(BooleanColumn),
    /// Arrays of scalars.
    Array(ArrayColumn),
}

impl ColumnData {
    /// Number of values.
    pub fn len(&self) -> usize {
        match self {
            ColumnData::Number(c) => c.len(),
            ColumnData::Decimal(c) => c.len(),
            ColumnData::String(c) => c.len(),
            ColumnData::Boolean(c) => c.len(),
            ColumnData::Array(c) => c.len(),
        }
    }

    /// `true` when there are no values.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Number of gaps.
    pub fn missing_count(&self) -> usize {
        match self {
            ColumnData::Number(c) => c.missing_count(),
            ColumnData::Decimal(c) => c.missing_count(),
            ColumnData::String(c) => c.missing_count(),
            ColumnData::Boolean(c) => c.missing_count(),
            ColumnData::Array(c) => c.missing_count(),
        }
    }

    /// The validity bits of a decimal, text, true/false or array column
    /// (`None` when it has no gaps, and always for numbers, whose gaps are
    /// non-finite values instead).
    pub(crate) fn arrow_nulls(&self) -> Option<NullBuffer> {
        match self {
            ColumnData::Number(_) => None,
            ColumnData::Decimal(c) => c.nulls().cloned(),
            ColumnData::String(c) => c.arrow().logical_nulls(),
            ColumnData::Boolean(c) => c.values.nulls().cloned(),
            ColumnData::Array(c) => (c.missing_count() > 0)
                .then(|| NullBuffer::from(c.iter().map(|v| v.is_some()).collect::<Vec<bool>>())),
        }
    }

    /// The rows in `range`, sharing this column's buffers (no copy).
    pub(crate) fn slice(&self, range: std::ops::Range<usize>) -> ColumnData {
        let (offset, len) = (range.start, range.len());
        match self {
            ColumnData::Number(c) => ColumnData::Number(Float64Column {
                values: c.values.slice(offset, len),
                // A slice of a column with no gaps has none either.
                all_finite: c.all_finite || c.values[range].iter().all(|v| v.is_finite()),
            }),
            ColumnData::Decimal(c) => ColumnData::Decimal(DecimalColumn {
                values: c.values.slice(offset, len),
            }),
            ColumnData::String(c) => ColumnData::String(StringColumn {
                repr: match &c.repr {
                    StringRepr::Plain(a) => StringRepr::Plain(a.slice(offset, len)),
                    StringRepr::Dictionary(a) => StringRepr::Dictionary(a.slice(offset, len)),
                },
            }),
            ColumnData::Boolean(c) => ColumnData::Boolean(BooleanColumn {
                values: c.values.slice(offset, len),
            }),
            ColumnData::Array(c) => ColumnData::Array(ArrayColumn {
                store: c.store.clone(),
                offset: c.offset + offset,
                len,
            }),
        }
    }

    /// Rows picked from several columns of this kind: `(source, row)`
    /// pairs, in order. Every source must be the kind of the first.
    pub(crate) fn gather(sources: &[&ColumnData], picks: &[(u32, u32)]) -> ColumnData {
        macro_rules! each {
            ($variant:ident) => {
                sources
                    .iter()
                    .map(|s| match s {
                        ColumnData::$variant(c) => c,
                        _ => unreachable!("sources checked to share a kind"),
                    })
                    .collect::<Vec<_>>()
            };
        }
        match sources[0] {
            ColumnData::Number(_) => {
                let cols = each!(Number);
                let values: Vec<&[f64]> = cols.iter().map(|c| c.values()).collect();
                ColumnData::from(
                    picks
                        .iter()
                        .map(|&(s, r)| values[s as usize][r as usize])
                        .collect::<Vec<f64>>(),
                )
            }
            ColumnData::Decimal(first) => {
                let cols = each!(Decimal);
                let precision = cols.iter().map(|c| c.precision()).max().unwrap_or(38);
                first
                    .rebuild(
                        picks
                            .iter()
                            .map(|&(s, r)| cols[s as usize].get(r as usize).map(|d| d.value)),
                        precision,
                    )
                    .into()
            }
            ColumnData::String(_) => {
                let cols = each!(String);
                let picked: Vec<Option<&str>> = picks
                    .iter()
                    .map(|&(s, r)| cols[s as usize].get(r as usize))
                    .collect();
                // Sized up front, as in `StringColumn::take`.
                let bytes = picked.iter().flatten().map(|s| s.len()).sum();
                let mut out = StringBuilder::with_capacity(picked.len(), bytes);
                for v in picked {
                    out.append_option(v);
                }
                StringColumn::plain(out.finish()).into()
            }
            ColumnData::Boolean(_) => {
                let cols = each!(Boolean);
                BooleanColumn::from_options(
                    picks.iter().map(|&(s, r)| cols[s as usize].get(r as usize)),
                )
                .into()
            }
            ColumnData::Array(_) => {
                let cols: Vec<&[Option<Cell>]> = each!(Array).iter().map(|c| c.cells()).collect();
                ArrayColumn::from_cells(
                    picks
                        .iter()
                        .map(|&(s, r)| cols[s as usize][r as usize].clone())
                        .collect(),
                )
                .into()
            }
        }
    }

    /// The rows where `keep` is set, in order: what `filter` keeps. Text
    /// goes by Arrow's kernel or stretch by stretch ([`RowFilter::text`])
    /// and arrays by row number; the other kinds are copied straight from
    /// the mask. Except that numbers, decimal values and dictionary keys
    /// go by the kernel's list of kept rows when `listed` says the list is
    /// there to share and [`RowFilter::list_pays`] that this mask is the
    /// faster by it for values of that width (see [`RowFilter`] for the
    /// two ways, and `TimeSeries::filter_rows` for the choice).
    pub(crate) fn filter(&self, keep: &RowFilter, listed: bool) -> ColumnData {
        match self {
            ColumnData::Number(c) => {
                let values: ScalarBuffer<f64> = if listed && keep.list_pays(size_of::<f64>()) {
                    let all = Float64Array::new(c.values.clone(), None);
                    let kept = keep.by_list(&all);
                    kept.as_primitive::<Float64Type>().values().clone()
                } else {
                    keep.vec(&c.values).into()
                };
                // A subset of values with no gap has no gap.
                let all_finite = c.all_finite || all_finite(&values);
                ColumnData::Number(Float64Column { values, all_finite })
            }
            ColumnData::Decimal(c) => {
                let a = &c.values;
                let values: ScalarBuffer<i128> = if listed && keep.list_pays(size_of::<i128>()) {
                    let all = Decimal128Array::new(a.values().clone(), None);
                    let kept = keep.by_list(&all);
                    kept.as_primitive::<Decimal128Type>().values().clone()
                } else {
                    keep.vec(a.values()).into()
                };
                // The gap marks come straight from the mask either way.
                // That timed faster than the kernel's copy of them from
                // 45% of the rows kept on; with a quarter kept or fewer
                // the kernel's was a few points the faster (the numbers
                // are in PND_RUST_PLAN.md, "Considered, not done").
                let kept = Decimal128Array::new(values, keep.nulls(a.nulls()));
                ColumnData::Decimal(DecimalColumn {
                    values: kept.with_data_type(a.data_type().clone()),
                })
            }
            ColumnData::String(c) => ColumnData::String(c.filter(keep, listed)),
            ColumnData::Boolean(c) => {
                let a = &c.values;
                ColumnData::Boolean(BooleanColumn::from_arrow(BooleanArray::new(
                    keep.bits(a.values()),
                    keep.nulls(a.nulls()),
                )))
            }
            // Array cells are shared, not copied: keep the row-number path.
            ColumnData::Array(c) => {
                let rows: Vec<Option<usize>> = keep.rows().map(Some).collect();
                ColumnData::Array(c.take(&rows))
            }
        }
    }

    /// The rows named by `rows`, in that order; `None` gives a gap.
    pub(crate) fn take(&self, rows: &[Option<usize>]) -> ColumnData {
        match self {
            ColumnData::Number(c) => {
                let v = c.values();
                ColumnData::from(
                    rows.iter()
                        .map(|r| r.map_or(f64::NAN, |i| v[i]))
                        .collect::<Vec<f64>>(),
                )
            }
            ColumnData::Decimal(c) => c.take(rows).into(),
            ColumnData::String(c) => c.take(rows).into(),
            ColumnData::Boolean(c) => c.take(rows).into(),
            ColumnData::Array(c) => c.take(rows).into(),
        }
    }

    /// The rows at `indices`, in that order; a null index gives a gap.
    /// Text, true/false and decimal columns use Arrow's gather kernel.
    pub(crate) fn take_indices(&self, indices: &UInt32Array) -> ColumnData {
        let gather = |a: &dyn Array| {
            arrow_select::take::take(a, indices, None).expect("row numbers are in range")
        };
        match self {
            ColumnData::Number(c) => {
                let v = c.values();
                ColumnData::from(
                    indices
                        .iter()
                        .map(|r| r.map_or(f64::NAN, |i| v[i as usize]))
                        .collect::<Vec<f64>>(),
                )
            }
            ColumnData::Decimal(c) => DecimalColumn {
                values: gather(&c.values).as_primitive::<Decimal128Type>().clone(),
            }
            .into(),
            ColumnData::String(c) => c.take_indices(indices).into(),
            ColumnData::Boolean(c) => {
                BooleanColumn::from_arrow(gather(&c.values).as_boolean().clone()).into()
            }
            ColumnData::Array(c) => {
                let cells = c.cells();
                ArrayColumn::from_cells(
                    indices
                        .iter()
                        .map(|r| r.and_then(|i| cells[i as usize].clone()))
                        .collect(),
                )
                .into()
            }
        }
    }

    /// True when row `i` holds a value. Panics if `i` is out of range.
    pub fn is_present(&self, i: usize) -> bool {
        match self {
            ColumnData::Number(c) => c.get(i).is_some(),
            ColumnData::Decimal(c) => c.get(i).is_some(),
            ColumnData::String(c) => c.get(i).is_some(),
            ColumnData::Boolean(c) => c.get(i).is_some(),
            ColumnData::Array(c) => c.is_present(i),
        }
    }

    /// What the column holds: [`ColumnKind::Number`], `Decimal`, `String`,
    /// `Boolean` or `Array`.
    pub fn kind(&self) -> ColumnKind {
        match self {
            ColumnData::Number(_) => ColumnKind::Number,
            ColumnData::Decimal(_) => ColumnKind::Decimal,
            ColumnData::String(_) => ColumnKind::String,
            ColumnData::Boolean(_) => ColumnKind::Boolean,
            ColumnData::Array(_) => ColumnKind::Array,
        }
    }
}

impl From<Float64Column> for ColumnData {
    fn from(c: Float64Column) -> Self {
        ColumnData::Number(c)
    }
}

impl From<DecimalColumn> for ColumnData {
    fn from(c: DecimalColumn) -> Self {
        ColumnData::Decimal(c)
    }
}

impl From<StringColumn> for ColumnData {
    fn from(c: StringColumn) -> Self {
        ColumnData::String(c)
    }
}

impl From<BooleanColumn> for ColumnData {
    fn from(c: BooleanColumn) -> Self {
        ColumnData::Boolean(c)
    }
}

impl From<ArrayColumn> for ColumnData {
    fn from(c: ArrayColumn) -> Self {
        ColumnData::Array(c)
    }
}

/// `From` for plain values (`Vec<f64>`, `Vec<&str>`, `Vec<bool>`,
/// `Vec<Vec<Scalar>>`, …), their
/// `Option` forms (`None` is a gap), and arrays of either.
macro_rules! column_data_from {
    ($($item:ty => |$v:ident| $build:expr;)*) => {$(
        impl From<Vec<$item>> for ColumnData {
            fn from($v: Vec<$item>) -> Self {
                $build
            }
        }
        impl<const N: usize> From<[$item; N]> for ColumnData {
            fn from(values: [$item; N]) -> Self {
                Vec::from(values).into()
            }
        }
    )*};
}

column_data_from! {
    f64 => |v| ColumnData::Number(Float64Column::from_values(v));
    Option<f64> => |v| ColumnData::Number(Float64Column::from_options(v));
    &str => |v| ColumnData::String(StringColumn::from_options(v.into_iter().map(Some)));
    Option<&str> => |v| ColumnData::String(StringColumn::from_options(v));
    String => |v| ColumnData::String(StringColumn::from_options(v.into_iter().map(Some)));
    Option<String> => |v| ColumnData::String(StringColumn::from_options(v));
    bool => |v| ColumnData::Boolean(BooleanColumn::from_options(v.into_iter().map(Some)));
    Option<bool> => |v| ColumnData::Boolean(BooleanColumn::from_options(v));
    Vec<Scalar> => |v| ColumnData::Array(ArrayColumn::from_options(v.into_iter().map(Some)));
    Option<Vec<Scalar>> => |v| ColumnData::Array(ArrayColumn::from_options(v));
}

#[cfg(test)]
mod tests {
    use super::all_finite;

    #[test]
    fn all_finite_finds_a_gap_anywhere() {
        for n in [0, 1, 63, 64, 65, 200] {
            let v = vec![1.5; n];
            assert!(all_finite(&v));
            for at in 0..n {
                for gap in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
                    let mut v = v.clone();
                    v[at] = gap;
                    assert!(!all_finite(&v), "n {n}, gap at {at}");
                }
            }
        }
    }
}
