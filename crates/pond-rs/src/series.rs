//! `TimeSeries`: a key column (points in time, or intervals) plus named
//! value columns (numbers, text, true/false), all the same length.

use crate::column::{BooleanColumn, ColumnData, Float64Column, StringColumn};
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
    /// A value column of text.
    String,
    /// A value column of true/false values.
    Boolean,
}

impl ColumnKind {
    /// The name pond-ts uses in a schema (`"time"`, `"interval"`,
    /// `"number"`, `"string"`, `"boolean"`).
    pub fn as_str(self) -> &'static str {
        match self {
            ColumnKind::Time => "time",
            ColumnKind::Interval => "interval",
            ColumnKind::Number => "number",
            ColumnKind::String => "string",
            ColumnKind::Boolean => "boolean",
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

/// A named value column: numbers, text or true/false values. Handed to
/// [`TimeSeries::new`], and read back with [`TimeSeries::column`].
///
/// ```
/// # use pond_rs::{Column, ColumnKind, TimeSeries};
/// let s = TimeSeries::new("hosts", vec![0, 1000], vec![
///     Column::required("cpu", vec![0.5, 0.7]),
///     Column::optional("host", vec![Some("a"), None]),
///     Column::required("up", vec![true, false]),
/// ])?;
/// assert_eq!(s.column("host")?.kind(), ColumnKind::String);
/// assert_eq!(s.column("host")?.strings()?.get(0), Some("a"));
/// assert!(s.column("host")?.numbers().is_err()); // not a number column
/// # Ok::<(), pond_rs::PondError>(())
/// ```
#[derive(Debug, Clone, PartialEq)]
pub struct Column {
    pub(crate) name: String,
    pub(crate) required: bool,
    pub(crate) data: ColumnData,
}

impl Column {
    /// A column with no gaps: `Vec<f64>`, `Vec<&str>`, `Vec<String>`,
    /// `Vec<bool>` (or an array of them, or a built column). A gap (a
    /// non-finite number, or a `None`) is rejected when the series is built.
    pub fn required(name: impl Into<String>, values: impl Into<ColumnData>) -> Self {
        Self {
            name: name.into(),
            required: true,
            data: values.into(),
        }
    }

    /// A column that may have gaps: as [`Column::required`], or with
    /// `Option` values (`vec![Some(1.0), None]`, `[Some("a"), None]`) where
    /// `None` is a gap. A non-finite number is a gap too.
    pub fn optional(name: impl Into<String>, values: impl Into<ColumnData>) -> Self {
        Self {
            name: name.into(),
            required: false,
            data: values.into(),
        }
    }

    /// A number column that may have gaps, given as raw `f64` where any
    /// non-finite value (`NaN`, `±inf`) is a gap. The same as
    /// [`Column::optional`] with a `Vec<f64>`.
    pub fn optional_raw(name: impl Into<String>, values: Vec<f64>) -> Self {
        Self::optional(name, values)
    }

    /// A column around existing storage, without copying.
    pub(crate) fn from_data(name: String, data: impl Into<ColumnData>, required: bool) -> Self {
        Self {
            name,
            required,
            data: data.into(),
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn is_required(&self) -> bool {
        self.required
    }

    /// What the column holds: [`ColumnKind::Number`], `String` or `Boolean`.
    pub fn kind(&self) -> ColumnKind {
        self.data.kind()
    }

    /// The values, whichever kind they are.
    pub fn data(&self) -> &ColumnData {
        &self.data
    }

    /// The values of a number column; an error for any other kind.
    pub fn numbers(&self) -> Result<&Float64Column> {
        match &self.data {
            ColumnData::Number(c) => Ok(c),
            _ => Err(self.wrong_kind("Column::numbers", "number")),
        }
    }

    /// The values of a text column; an error for any other kind.
    pub fn strings(&self) -> Result<&StringColumn> {
        match &self.data {
            ColumnData::String(c) => Ok(c),
            _ => Err(self.wrong_kind("Column::strings", "string")),
        }
    }

    /// The values of a true/false column; an error for any other kind.
    pub fn booleans(&self) -> Result<&BooleanColumn> {
        match &self.data {
            ColumnData::Boolean(c) => Ok(c),
            _ => Err(self.wrong_kind("Column::booleans", "boolean")),
        }
    }

    fn wrong_kind(&self, call: &'static str, wanted: &str) -> PondError {
        PondError::WrongKind {
            call,
            column: self.name.clone(),
            kind: self.kind().as_str(),
            reason: format!("this call needs a {wanted} column"),
        }
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

/// Largest key time, in epoch milliseconds, either side of 1970: the range
/// of a JavaScript `Date` (so of pond-ts), 100 million days. Keeping keys in
/// it leaves room for any window or step arithmetic in `i64`. Checked on
/// every series built from outside data; a derived series can go one bucket
/// past it (`aggregate` of a row near the limit gives a bucket whose end is
/// beyond it), as pond-ts's does.
pub const MAX_TIME_MS: i64 = 8_640_000_000_000_000;

impl TimeSeries {
    /// Build a time-keyed series. The key column is named `"time"`; times are
    /// epoch milliseconds within ±[`MAX_TIME_MS`] and must be non-decreasing
    /// (repeats are allowed).
    pub fn new(name: impl Into<String>, time: Vec<i64>, columns: Vec<Column>) -> Result<Self> {
        Self::with_key(
            "TimeSeries::new",
            name.into(),
            "time".into(),
            Key::Time(time),
            columns,
        )
    }

    /// Build an interval-keyed series, the shape `aggregate` returns. The key
    /// column is always named `"interval"` (pond-ts takes the name from the
    /// schema; pond-rs has no way to choose it yet). Row `i` covers `[begin[i], end[i])` and
    /// is labelled `label[i]`; rows must be ordered by `begin`, and the same
    /// time limits as [`TimeSeries::new`] apply.
    ///
    /// ```
    /// # use pond_rs::{Column, IntervalKeys, TimeSeries};
    /// let days = TimeSeries::from_intervals(
    ///     "days",
    ///     IntervalKeys { label: vec![0, 86_400_000], begin: vec![0, 86_400_000], end: vec![86_400_000, 172_800_000] },
    ///     vec![Column::required("total", vec![12.0, 7.5])],
    /// )?;
    /// assert_eq!(days.key_name(), "interval");
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn from_intervals(
        name: impl Into<String>,
        keys: IntervalKeys,
        columns: Vec<Column>,
    ) -> Result<Self> {
        Self::with_key(
            "TimeSeries::from_intervals",
            name.into(),
            "interval".into(),
            Key::Interval(keys),
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
        let out_of_range = |t: &i64| !(-MAX_TIME_MS..=MAX_TIME_MS).contains(t);
        let edges: [&[i64]; 3] = match &key {
            Key::Time(t) => [t, &[], &[]],
            Key::Interval(k) => [&k.begin, &k.end, &k.label],
        };
        for edge in edges {
            if let Some(i) = edge.iter().position(out_of_range) {
                return Err(invalid(format!(
                    "time {} ms at row {i} is outside the supported range ±{MAX_TIME_MS} ms (years -271821 to 275760, as JavaScript dates)",
                    edge[i]
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
            if column.required && column.data.missing_count() > 0 {
                let i = (0..rows)
                    .find(|&i| !column.data.is_present(i))
                    .expect("a gap exists");
                return Err(invalid(format!(
                    "required column '{}' has a gap at row {i}; use Column::optional if gaps are allowed",
                    column.name
                )));
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
            kind: c.kind(),
            required: c.required,
        }))
        .collect()
    }

    /// The value columns, in schema order.
    pub fn columns(&self) -> &[Column] {
        &self.columns
    }

    /// A value column by name; an error naming the columns there are when
    /// there is none. Then [`Column::numbers`], [`Column::strings`] or
    /// [`Column::booleans`] for its values.
    pub fn column(&self, name: &str) -> Result<&Column> {
        Ok(&self.columns[self.column_index("TimeSeries::column", name)?])
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
