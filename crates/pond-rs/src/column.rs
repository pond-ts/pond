//! Value columns: numbers, exact decimals, text and true/false values.
//!
//! In a number column a gap is stored as `NaN`, as in pond-ts
//! ([PND-NANREP]): any non-finite value in the buffer means "missing".
//! Decimal, text and true/false columns mark gaps with an Arrow null.
//!
//! The values live in an Arrow buffer (shared, immutable, reference
//! counted). So a column read from Arrow can point at Arrow's memory instead
//! of copying it, a column written to Arrow is handed over without a copy,
//! and cloning a column or a series does not copy values.

use std::sync::Arc;

use arrow_array::builder::StringBuilder;
use arrow_array::cast::AsArray;
use arrow_array::types::{Decimal128Type, Int32Type};
use arrow_array::{
    Array, ArrayRef, BooleanArray, Decimal128Array, DictionaryArray, StringArray, UInt32Array,
};
use arrow_buffer::{NullBuffer, ScalarBuffer};
use arrow_schema::DataType;

use crate::series::ColumnKind;

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
        let all_finite = values.iter().all(|v| v.is_finite());
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

    pub fn len(&self) -> usize {
        self.values.len()
    }

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

    pub fn len(&self) -> usize {
        match &self.repr {
            StringRepr::Plain(a) => a.len(),
            StringRepr::Dictionary(a) => a.len(),
        }
    }

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

    pub fn len(&self) -> usize {
        self.values.len()
    }

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
    Number(f64),
    /// As a fill value, must have the column's scale.
    Decimal(Decimal),
    String(String),
    Boolean(bool),
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
/// `count`, `first`, `last`, `min`, `max` and `sum`; every other reducer
/// works on the nearest `f64` and gives a number column.
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

    pub fn len(&self) -> usize {
        self.values.len()
    }

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

/// What a value column holds: numbers, exact decimals, text, or true/false
/// values.
#[derive(Debug, Clone, PartialEq)]
pub enum ColumnData {
    Number(Float64Column),
    Decimal(DecimalColumn),
    String(StringColumn),
    Boolean(BooleanColumn),
}

impl ColumnData {
    pub fn len(&self) -> usize {
        match self {
            ColumnData::Number(c) => c.len(),
            ColumnData::Decimal(c) => c.len(),
            ColumnData::String(c) => c.len(),
            ColumnData::Boolean(c) => c.len(),
        }
    }

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
        }
    }

    /// The Arrow validity bits of a decimal, text or true/false column
    /// (`None` when it has no gaps, and always for numbers, whose gaps are
    /// non-finite values instead).
    pub(crate) fn arrow_nulls(&self) -> Option<NullBuffer> {
        match self {
            ColumnData::Number(_) => None,
            ColumnData::Decimal(c) => c.nulls().cloned(),
            ColumnData::String(c) => c.arrow().logical_nulls(),
            ColumnData::Boolean(c) => c.values.nulls().cloned(),
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
        }
    }

    /// True when row `i` holds a value. Panics if `i` is out of range.
    pub fn is_present(&self, i: usize) -> bool {
        match self {
            ColumnData::Number(c) => c.get(i).is_some(),
            ColumnData::Decimal(c) => c.get(i).is_some(),
            ColumnData::String(c) => c.get(i).is_some(),
            ColumnData::Boolean(c) => c.get(i).is_some(),
        }
    }

    /// What the column holds: [`ColumnKind::Number`], `Decimal`, `String`
    /// or `Boolean`.
    pub fn kind(&self) -> ColumnKind {
        match self {
            ColumnData::Number(_) => ColumnKind::Number,
            ColumnData::Decimal(_) => ColumnKind::Decimal,
            ColumnData::String(_) => ColumnKind::String,
            ColumnData::Boolean(_) => ColumnKind::Boolean,
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

/// `From` for plain values (`Vec<f64>`, `Vec<&str>`, `Vec<bool>`, …), their
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
}
