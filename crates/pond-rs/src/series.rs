//! `TimeSeries`: a key column (points in time, or intervals) plus named
//! number columns, all the same length.

use crate::column::Float64Column;
use crate::error::{PondError, Result};

/// What a schema column holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnKind {
    /// Key: a point in time, epoch milliseconds.
    Time,
    /// Key: a labelled `[begin, end)` span, epoch milliseconds.
    Interval,
    /// A value column of `f64`.
    Number,
}

impl ColumnKind {
    /// The name pond-ts uses in a schema (`"time"`, `"interval"`, `"number"`).
    pub fn as_str(self) -> &'static str {
        match self {
            ColumnKind::Time => "time",
            ColumnKind::Interval => "interval",
            ColumnKind::Number => "number",
        }
    }
}

/// One schema entry. `required: false` means the column may have gaps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnDef {
    pub name: String,
    pub kind: ColumnKind,
    pub required: bool,
}

/// Interval keys: row `i` covers `[begin[i], end[i])` and is labelled
/// `label[i]` (for buckets made by a sequence, the label is the start).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntervalKeys {
    pub label: Vec<i64>,
    pub begin: Vec<i64>,
    pub end: Vec<i64>,
}

/// The key column.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Key {
    /// Points in time, epoch milliseconds, non-decreasing.
    Time(Vec<i64>),
    /// Intervals, ordered by begin.
    Interval(IntervalKeys),
}

impl Key {
    pub fn len(&self) -> usize {
        match self {
            Key::Time(t) => t.len(),
            Key::Interval(k) => k.begin.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Start of each row (the time itself for point keys).
    pub fn begin(&self) -> &[i64] {
        match self {
            Key::Time(t) => t,
            Key::Interval(k) => &k.begin,
        }
    }

    fn kind(&self) -> ColumnKind {
        match self {
            Key::Time(_) => ColumnKind::Time,
            Key::Interval(_) => ColumnKind::Interval,
        }
    }
}

/// A value column handed to [`TimeSeries::new`].
#[derive(Debug, Clone, PartialEq)]
pub struct Column {
    pub(crate) name: String,
    pub(crate) required: bool,
    pub(crate) data: Float64Column,
}

impl Column {
    /// A column with no gaps. A non-finite value is rejected when the series
    /// is built.
    pub fn required(name: impl Into<String>, values: Vec<f64>) -> Self {
        Self {
            name: name.into(),
            required: true,
            data: Float64Column::from_values(values),
        }
    }

    /// A column that may have gaps (`None`).
    pub fn optional(
        name: impl Into<String>,
        values: impl IntoIterator<Item = Option<f64>>,
    ) -> Self {
        Self {
            name: name.into(),
            required: false,
            data: Float64Column::from_options(values),
        }
    }

    /// A column that may have gaps, given as raw `f64` where any non-finite
    /// value (`NaN`, `±inf`) is a gap.
    pub fn optional_raw(name: impl Into<String>, values: Vec<f64>) -> Self {
        Self {
            name: name.into(),
            required: false,
            data: Float64Column::from_values(values),
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn is_required(&self) -> bool {
        self.required
    }

    pub fn data(&self) -> &Float64Column {
        &self.data
    }
}

/// A time series: a name, a key column and value columns of equal length.
#[derive(Debug, Clone, PartialEq)]
pub struct TimeSeries {
    name: String,
    key_name: String,
    key: Key,
    columns: Vec<Column>,
}

impl TimeSeries {
    /// Build a time-keyed series. The key column is named `"time"`; times are
    /// epoch milliseconds and must be non-decreasing (repeats are allowed).
    pub fn new(name: impl Into<String>, time: Vec<i64>, columns: Vec<Column>) -> Result<Self> {
        Self::with_key(
            "TimeSeries::new",
            name.into(),
            "time".into(),
            Key::Time(time),
            columns,
        )
    }

    /// Build a series with any key, checking every rule.
    pub(crate) fn with_key(
        call: &'static str,
        name: String,
        key_name: String,
        key: Key,
        columns: Vec<Column>,
    ) -> Result<Self> {
        let invalid = |message: String| PondError::InvalidData { call, message };
        let rows = key.len();
        if let Key::Interval(k) = &key {
            if k.label.len() != rows || k.end.len() != rows {
                return Err(invalid("interval key parts have different lengths".into()));
            }
            if let Some(i) = (0..rows).find(|&i| k.end[i] < k.begin[i]) {
                return Err(invalid(format!(
                    "interval at row {i} ends before it begins"
                )));
            }
        }
        if let Some(i) = key.begin().windows(2).position(|w| w[1] < w[0]) {
            return Err(invalid(format!(
                "key is not in order: row {} ({}) comes before row {} ({})",
                i + 1,
                key.begin()[i + 1],
                i,
                key.begin()[i]
            )));
        }
        for (c, column) in columns.iter().enumerate() {
            if column.name == key_name {
                return Err(invalid(format!(
                    "value column '{}' has the same name as the key",
                    column.name
                )));
            }
            if columns[..c].iter().any(|other| other.name == column.name) {
                return Err(invalid(format!("column '{}' appears twice", column.name)));
            }
            if column.data.len() != rows {
                return Err(invalid(format!(
                    "column '{}' has {} values but the key has {rows}",
                    column.name,
                    column.data.len()
                )));
            }
            if column.required {
                if let Some(i) = column.data.values().iter().position(|v| !v.is_finite()) {
                    return Err(invalid(format!(
                        "required column '{}' has a gap at row {i}; use Column::optional if gaps are allowed",
                        column.name
                    )));
                }
            }
        }
        Ok(Self {
            name,
            key_name,
            key,
            columns,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// Number of rows.
    pub fn len(&self) -> usize {
        self.key.len()
    }

    pub fn is_empty(&self) -> bool {
        self.key.is_empty()
    }

    pub fn key(&self) -> &Key {
        &self.key
    }

    /// The key column's name (`"time"`, `"interval"`, …).
    pub fn key_name(&self) -> &str {
        &self.key_name
    }

    /// The schema: the key first, then each value column in order.
    pub fn schema(&self) -> Vec<ColumnDef> {
        std::iter::once(ColumnDef {
            name: self.key_name.clone(),
            kind: self.key.kind(),
            required: true,
        })
        .chain(self.columns.iter().map(|c| ColumnDef {
            name: c.name.clone(),
            kind: ColumnKind::Number,
            required: c.required,
        }))
        .collect()
    }

    /// The value columns, in schema order.
    pub fn columns(&self) -> &[Column] {
        &self.columns
    }

    /// A value column by name.
    pub fn column(&self, name: &str) -> Option<&Float64Column> {
        self.columns
            .iter()
            .find(|c| c.name == name)
            .map(|c| &c.data)
    }

    pub(crate) fn column_index(&self, call: &'static str, name: &str) -> Result<usize> {
        self.columns
            .iter()
            .position(|c| c.name == name)
            .ok_or_else(|| PondError::UnknownColumn {
                call,
                column: name.to_string(),
                available: self.columns.iter().map(|c| c.name.clone()).collect(),
            })
    }

    pub(crate) fn from_parts(
        name: String,
        key_name: String,
        key: Key,
        columns: Vec<Column>,
    ) -> Self {
        debug_assert!(columns.iter().all(|c| c.data.len() == key.len()));
        Self {
            name,
            key_name,
            key,
            columns,
        }
    }
}
