//! Value columns: numbers, text and true/false values.
//!
//! In a number column a gap is stored as `NaN`, as in pond-ts
//! ([PND-NANREP]): any non-finite value in the buffer means "missing". Text
//! and true/false columns mark gaps with an Arrow null.
//!
//! The values live in an Arrow buffer (shared, immutable, reference
//! counted). So a column read from Arrow can point at Arrow's memory instead
//! of copying it, a column written to Arrow is handed over without a copy,
//! and cloning a column or a series does not copy values.

use std::sync::Arc;

use arrow_array::builder::StringBuilder;
use arrow_array::cast::AsArray;
use arrow_array::types::Int32Type;
use arrow_array::{Array, ArrayRef, BooleanArray, DictionaryArray, Int32Array, StringArray};
use arrow_buffer::{NullBuffer, ScalarBuffer};
use arrow_schema::DataType;

/// A column of `f64` values where any non-finite value (`NaN`, `±inf`) is a
/// gap. Reading a gap gives `None`.
#[derive(Debug, Clone, PartialEq)]
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
    /// dictionary column stays one, sharing its list of strings.
    pub(crate) fn take(&self, rows: &[Option<usize>]) -> Self {
        match &self.repr {
            StringRepr::Plain(a) => {
                let picked: Vec<Option<&str>> = rows
                    .iter()
                    .map(|r| r.and_then(|i| a.is_valid(i).then(|| a.value(i))))
                    .collect();
                // Sized up front: growing the buffers as strings arrive
                // costs more than the copy itself.
                let bytes = picked.iter().flatten().map(|s| s.len()).sum();
                let mut out = StringBuilder::with_capacity(picked.len(), bytes);
                for v in picked {
                    out.append_option(v);
                }
                Self::plain(out.finish())
            }
            StringRepr::Dictionary(a) => {
                let keys: Int32Array = rows
                    .iter()
                    .map(|r| r.and_then(|i| a.is_valid(i).then(|| a.keys().value(i))))
                    .collect();
                Self {
                    repr: StringRepr::Dictionary(DictionaryArray::new(keys, a.values().clone())),
                }
            }
        }
    }
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

/// What a value column holds: numbers, text, or true/false values.
#[derive(Debug, Clone, PartialEq)]
pub enum ColumnData {
    Number(Float64Column),
    String(StringColumn),
    Boolean(BooleanColumn),
}

impl ColumnData {
    pub fn len(&self) -> usize {
        match self {
            ColumnData::Number(c) => c.len(),
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
            ColumnData::String(c) => c.missing_count(),
            ColumnData::Boolean(c) => c.missing_count(),
        }
    }

    /// The Arrow validity bits of a text or true/false column (`None` when
    /// it has no gaps, and always for numbers, whose gaps are non-finite
    /// values instead).
    pub(crate) fn arrow_nulls(&self) -> Option<NullBuffer> {
        match self {
            ColumnData::Number(_) => None,
            ColumnData::String(c) => c.arrow().logical_nulls(),
            ColumnData::Boolean(c) => c.values.nulls().cloned(),
        }
    }

    /// True when row `i` holds a value. Panics if `i` is out of range.
    pub fn is_present(&self, i: usize) -> bool {
        match self {
            ColumnData::Number(c) => c.get(i).is_some(),
            ColumnData::String(c) => c.get(i).is_some(),
            ColumnData::Boolean(c) => c.get(i).is_some(),
        }
    }

    /// pond-ts's name for the kind: `"number"`, `"string"` or `"boolean"`.
    pub fn kind_name(&self) -> &'static str {
        match self {
            ColumnData::Number(_) => "number",
            ColumnData::String(_) => "string",
            ColumnData::Boolean(_) => "boolean",
        }
    }
}

impl From<Float64Column> for ColumnData {
    fn from(c: Float64Column) -> Self {
        ColumnData::Number(c)
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
