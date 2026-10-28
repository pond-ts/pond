//! `TimeSeries`: a key column (points in time, time ranges, or labelled
//! intervals) plus named value columns (numbers, text, true/false), all the
//! same length.

use crate::column::{
    ArrayColumn, BooleanColumn, ColumnData, DecimalColumn, Float64Column, StringColumn,
};
use crate::error::{PondError, Result};
use std::sync::Arc;

/// What a schema column holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColumnKind {
    /// Key: a point in time, epoch milliseconds.
    Time,
    /// Key: a `[begin, end]` span, epoch milliseconds.
    TimeRange,
    /// Key: a labelled `[begin, end)` span, epoch milliseconds.
    Interval,
    /// Key of a [`ValueSeries`](crate::ValueSeries): a number axis
    /// (distance, strike, frequency), not a time.
    Value,
    /// A value column of `f64`.
    Number,
    /// A value column of exact decimals (pond-rs only; pond-ts has none).
    Decimal,
    /// A value column of text.
    String,
    /// A value column of true/false values.
    Boolean,
    /// A value column of arrays of numbers, text and true/false values
    /// ([`ArrayColumn`](crate::ArrayColumn)).
    Array,
}

impl ColumnKind {
    /// The name pond-ts uses in a schema (`"time"`, `"timeRange"`,
    /// `"interval"`, `"value"`, `"number"`, `"string"`, `"boolean"`, `"array"`), and `"decimal"`,
    /// which pond-ts does not have.
    pub fn as_str(self) -> &'static str {
        match self {
            ColumnKind::Time => "time",
            ColumnKind::TimeRange => "timeRange",
            ColumnKind::Interval => "interval",
            ColumnKind::Value => "value",
            ColumnKind::Number => "number",
            ColumnKind::Decimal => "decimal",
            ColumnKind::String => "string",
            ColumnKind::Boolean => "boolean",
            ColumnKind::Array => "array",
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

impl ColumnDef {
    /// A column that may not have gaps (pond-ts's default).
    pub fn required(name: impl Into<String>, kind: ColumnKind) -> Self {
        Self {
            name: name.into(),
            kind,
            required: true,
        }
    }

    /// A column that may have gaps (pond-ts `required: false`).
    pub fn optional(name: impl Into<String>, kind: ColumnKind) -> Self {
        Self {
            name: name.into(),
            kind,
            required: false,
        }
    }
}

/// Time-range keys (pond-ts `timeRange`): row `i` spans `begin[i]` to
/// `end[i]`, epoch milliseconds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimeRangeKeys {
    pub begin: Vec<i64>,
    pub end: Vec<i64>,
}

/// Interval keys: row `i` covers `[begin[i], end[i])` and is labelled
/// `label[i]` (for buckets made by a sequence, the label is the start).
#[derive(Debug, Clone, PartialEq)]
pub struct IntervalKeys {
    pub label: Labels,
    pub begin: Vec<i64>,
    pub end: Vec<i64>,
}

/// Interval labels: numbers or text, one kind for the whole key, as in
/// pond-ts. Every row has a label (no gaps). Build them with `.into()` from
/// `Vec<f64>`, `Vec<i64>`, `Vec<&str>` or `Vec<String>`.
#[derive(Debug, Clone, PartialEq)]
pub enum Labels {
    /// Number labels. `aggregate` labels each bucket with its start, in
    /// epoch milliseconds. Must be finite.
    Number(Vec<f64>),
    /// Text labels.
    String(StringColumn),
}

impl Labels {
    pub fn len(&self) -> usize {
        match self {
            Labels::Number(v) => v.len(),
            Labels::String(c) => c.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Number labels, or `None` for text labels.
    pub fn numbers(&self) -> Option<&[f64]> {
        match self {
            Labels::Number(v) => Some(v),
            Labels::String(_) => None,
        }
    }

    /// Text labels, or `None` for number labels.
    pub fn strings(&self) -> Option<&StringColumn> {
        match self {
            Labels::Number(_) => None,
            Labels::String(c) => Some(c),
        }
    }
}

impl From<Vec<f64>> for Labels {
    fn from(v: Vec<f64>) -> Self {
        Labels::Number(v)
    }
}

/// Exact for whole numbers up to 2^53 (every key time is): larger values
/// round to the nearest `f64`.
impl From<Vec<i64>> for Labels {
    fn from(v: Vec<i64>) -> Self {
        Labels::Number(v.into_iter().map(|x| x as f64).collect())
    }
}

impl From<Vec<&str>> for Labels {
    fn from(v: Vec<&str>) -> Self {
        Labels::String(StringColumn::from_options(v.into_iter().map(Some)))
    }
}

impl From<Vec<String>> for Labels {
    fn from(v: Vec<String>) -> Self {
        Labels::String(StringColumn::from_options(v.into_iter().map(Some)))
    }
}

impl From<StringColumn> for Labels {
    fn from(c: StringColumn) -> Self {
        Labels::String(c)
    }
}

/// The key column.
#[derive(Debug, Clone, PartialEq)]
pub enum Key {
    /// Points in time, epoch milliseconds, non-decreasing.
    Time(Vec<i64>),
    /// Time ranges, ordered by begin, then end.
    TimeRange(TimeRangeKeys),
    /// Labelled intervals, ordered by begin, then end.
    Interval(IntervalKeys),
}

impl Key {
    pub fn len(&self) -> usize {
        self.begin().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Start of each row (the time itself for point keys).
    pub fn begin(&self) -> &[i64] {
        match self {
            Key::Time(t) => t,
            Key::TimeRange(k) => &k.begin,
            Key::Interval(k) => &k.begin,
        }
    }

    /// End of each row, or `None` for point keys.
    pub fn end(&self) -> Option<&[i64]> {
        match self {
            Key::Time(_) => None,
            Key::TimeRange(k) => Some(&k.end),
            Key::Interval(k) => Some(&k.end),
        }
    }

    /// The rows in `range`, copied.
    pub(crate) fn rows(&self, range: std::ops::Range<usize>) -> Key {
        match self {
            Key::Time(t) => Key::Time(t[range].to_vec()),
            Key::TimeRange(k) => Key::TimeRange(TimeRangeKeys {
                begin: k.begin[range.clone()].to_vec(),
                end: k.end[range].to_vec(),
            }),
            Key::Interval(k) => Key::Interval(IntervalKeys {
                label: match &k.label {
                    Labels::Number(v) => Labels::Number(v[range.clone()].to_vec()),
                    Labels::String(s) => {
                        let rows: Vec<Option<usize>> = range.clone().map(Some).collect();
                        Labels::String(s.take(&rows))
                    }
                },
                begin: k.begin[range.clone()].to_vec(),
                end: k.end[range].to_vec(),
            }),
        }
    }

    /// Rows picked from several keys of this kind: `(source, row)` pairs,
    /// in order.
    pub(crate) fn gather(sources: &[&Key], picks: &[(u32, u32)]) -> Key {
        let pick = |v: &dyn Fn(&Key) -> &[i64]| -> Vec<i64> {
            let cols: Vec<&[i64]> = sources.iter().map(|k| v(k)).collect();
            picks
                .iter()
                .map(|&(s, r)| cols[s as usize][r as usize])
                .collect()
        };
        let begin = pick(&|k| k.begin());
        match sources[0] {
            Key::Time(_) => Key::Time(begin),
            Key::TimeRange(_) => Key::TimeRange(TimeRangeKeys {
                begin,
                end: pick(&|k| k.end().expect("same kind")),
            }),
            Key::Interval(first) => {
                let labels: Vec<&Labels> = sources
                    .iter()
                    .map(|k| match k {
                        Key::Interval(i) => &i.label,
                        _ => unreachable!("same kind"),
                    })
                    .collect();
                let label = match &first.label {
                    Labels::Number(_) => Labels::Number(
                        picks
                            .iter()
                            .map(|&(s, r)| {
                                labels[s as usize].numbers().expect("same kind")[r as usize]
                            })
                            .collect(),
                    ),
                    Labels::String(_) => {
                        Labels::String(StringColumn::from_options(picks.iter().map(|&(s, r)| {
                            labels[s as usize]
                                .strings()
                                .expect("same kind")
                                .get(r as usize)
                        })))
                    }
                };
                Key::Interval(IntervalKeys {
                    label,
                    begin,
                    end: pick(&|k| k.end().expect("same kind")),
                })
            }
        }
    }

    /// The rows at `rows`, in that order, copied.
    pub(crate) fn take(&self, rows: &[usize]) -> Key {
        let pick = |v: &[i64]| rows.iter().map(|&i| v[i]).collect::<Vec<i64>>();
        match self {
            Key::Time(t) => Key::Time(pick(t)),
            Key::TimeRange(k) => Key::TimeRange(TimeRangeKeys {
                begin: pick(&k.begin),
                end: pick(&k.end),
            }),
            Key::Interval(k) => Key::Interval(IntervalKeys {
                label: match &k.label {
                    Labels::Number(v) => Labels::Number(rows.iter().map(|&i| v[i]).collect()),
                    Labels::String(s) => {
                        let picks: Vec<Option<usize>> = rows.iter().map(|&i| Some(i)).collect();
                        Labels::String(s.take(&picks))
                    }
                },
                begin: pick(&k.begin),
                end: pick(&k.end),
            }),
        }
    }

    pub(crate) fn kind(&self) -> ColumnKind {
        match self {
            Key::Time(_) => ColumnKind::Time,
            Key::TimeRange(_) => ColumnKind::TimeRange,
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

    /// What the column holds: [`ColumnKind::Number`], `Decimal`, `String`,
    /// `Boolean` or `Array`.
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

    /// The values of a decimal column; an error for any other kind.
    pub fn decimals(&self) -> Result<&DecimalColumn> {
        match &self.data {
            ColumnData::Decimal(c) => Ok(c),
            _ => Err(self.wrong_kind("Column::decimals", "decimal")),
        }
    }

    /// The values of a true/false column; an error for any other kind.
    pub fn booleans(&self) -> Result<&BooleanColumn> {
        match &self.data {
            ColumnData::Boolean(c) => Ok(c),
            _ => Err(self.wrong_kind("Column::booleans", "boolean")),
        }
    }

    /// The values of an array column; an error for any other kind.
    pub fn arrays(&self) -> Result<&ArrayColumn> {
        match &self.data {
            ColumnData::Array(c) => Ok(c),
            _ => Err(self.wrong_kind("Column::arrays", "array")),
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
    /// Shared: operations that keep the rows share the key instead of
    /// copying it.
    key: Arc<Key>,
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
    ///     IntervalKeys {
    ///         label: vec!["mon", "tue"].into(),
    ///         begin: vec![0, 86_400_000],
    ///         end: vec![86_400_000, 172_800_000],
    ///     },
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

    /// Build a series keyed by time ranges (pond-ts `timeRange`). The key
    /// column is named `"timeRange"`, pond-ts's default. Rows must be
    /// ordered by `begin`, then `end`; each `end` must not be before its
    /// `begin`, and the same time limits as [`TimeSeries::new`] apply.
    ///
    /// ```
    /// # use pond_rs::{Column, TimeRangeKeys, TimeSeries};
    /// let outages = TimeSeries::from_time_ranges(
    ///     "outages",
    ///     TimeRangeKeys { begin: vec![0, 5_000], end: vec![2_000, 5_500] },
    ///     vec![Column::required("hosts", vec![3.0, 1.0])],
    /// )?;
    /// assert_eq!(outages.key_name(), "timeRange");
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn from_time_ranges(
        name: impl Into<String>,
        keys: TimeRangeKeys,
        columns: Vec<Column>,
    ) -> Result<Self> {
        Self::with_key(
            "TimeSeries::from_time_ranges",
            name.into(),
            "timeRange".into(),
            Key::TimeRange(keys),
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
            if k.label.len() != rows {
                return Err(invalid(
                    "interval labels and begins have different lengths".into(),
                ));
            }
            match &k.label {
                Labels::Number(v) => {
                    if let Some(i) = v.iter().position(|l| !l.is_finite()) {
                        return Err(invalid(format!(
                            "interval label at row {i} is {}; number labels must be finite",
                            v[i]
                        )));
                    }
                }
                Labels::String(c) => {
                    if let Some(i) = c.iter().position(|l| l.is_none()) {
                        return Err(invalid(format!(
                            "interval label at row {i} is missing; every row needs a label"
                        )));
                    }
                }
            }
        }
        if let Some(end) = key.end() {
            if end.len() != rows {
                return Err(invalid("key begins and ends have different lengths".into()));
            }
            if let Some(i) = (0..rows).find(|&i| end[i] < key.begin()[i]) {
                return Err(invalid(format!(
                    "key at row {i} ends ({}) before it begins ({})",
                    end[i],
                    key.begin()[i]
                )));
            }
        }
        let out_of_range = |t: &i64| !(-MAX_TIME_MS..=MAX_TIME_MS).contains(t);
        for edge in [key.begin(), key.end().unwrap_or(&[])] {
            if let Some(i) = edge.iter().position(out_of_range) {
                return Err(invalid(format!(
                    "time {} ms at row {i} is outside the supported range ±{MAX_TIME_MS} ms (years -271821 to 275760, as JavaScript dates)",
                    edge[i]
                )));
            }
        }
        // Ordered by begin, then (for ranges and intervals) by end, as in
        // pond-ts.
        let order = |i: usize| (key.begin()[i], key.end().map_or(0, |e| e[i]));
        if let Some(i) = (1..rows).find(|&i| order(i) < order(i - 1)) {
            let show = |i: usize| match key.end() {
                None => format!("{}", key.begin()[i]),
                Some(e) => format!("[{}, {}]", key.begin()[i], e[i]),
            };
            return Err(invalid(format!(
                "key is not in order: row {i} ({}) sorts before row {} ({}); keys are ordered by begin, then end",
                show(i),
                i - 1,
                show(i - 1)
            )));
        }
        Self::check_columns(call, &key_name, rows, &columns)?;
        Ok(Self {
            name,
            key_name,
            key: Arc::new(key),
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

    /// The value-column rules: names unique and not the key's, every
    /// column `rows` long, no gap in a required column.
    pub(crate) fn check_columns(
        call: &'static str,
        key_name: &str,
        rows: usize,
        columns: &[Column],
    ) -> Result<()> {
        let invalid = |message: String| PondError::InvalidData { call, message };
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
            if let ColumnData::Array(a) = &column.data {
                if let Some((r, e)) = a.first_bad_element() {
                    return Err(invalid(format!(
                        "column '{}' row {r}: array element {e} must be a finite number, string, or boolean",
                        column.name
                    )));
                }
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
        Ok(())
    }

    pub(crate) fn from_parts(
        name: String,
        key_name: String,
        key: impl Into<Arc<Key>>,
        columns: Vec<Column>,
    ) -> Self {
        let key = key.into();
        debug_assert!(columns.iter().all(|c| c.data.len() == key.len()));
        Self {
            name,
            key_name,
            key,
            columns,
        }
    }

    /// The key, shared rather than copied, for a result with the same rows.
    pub(crate) fn shared_key(&self) -> Arc<Key> {
        Arc::clone(&self.key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ranges(begin: Vec<i64>, end: Vec<i64>) -> Result<TimeSeries> {
        TimeSeries::from_time_ranges("r", TimeRangeKeys { begin, end }, vec![])
    }

    fn intervals(label: Labels) -> Result<TimeSeries> {
        let keys = IntervalKeys {
            label,
            begin: vec![0, 10],
            end: vec![10, 20],
        };
        TimeSeries::from_intervals("i", keys, vec![])
    }

    #[test]
    fn range_keys_are_checked_as_pond_ts_checks_them() {
        // Same start: ordered by end. Zero length is allowed.
        assert!(ranges(vec![0, 0, 5], vec![2, 9, 5]).is_ok());
        let e = ranges(vec![0, 0], vec![9, 2]).unwrap_err().to_string();
        assert!(
            e.contains("row 1 ([0, 2]) sorts before row 0 ([0, 9])"),
            "{e}"
        );
        let e = ranges(vec![5], vec![4]).unwrap_err().to_string();
        assert!(e.contains("ends (4) before it begins (5)"), "{e}");
        assert!(ranges(vec![0, 1], vec![1]).is_err());
        assert!(ranges(vec![0], vec![MAX_TIME_MS + 1]).is_err());
    }

    #[test]
    fn interval_labels_are_checked() {
        // Repeats and fractions are fine.
        assert!(intervals(vec![1.5, 1.5].into()).is_ok());
        assert!(intervals(vec!["a", "a"].into()).is_ok());
        let e = intervals(vec![1.0, f64::NAN].into())
            .unwrap_err()
            .to_string();
        assert!(e.contains("label at row 1"), "{e}");
        let gap = Labels::String(StringColumn::from_options([Some("a"), None]));
        let e = intervals(gap).unwrap_err().to_string();
        assert!(e.contains("label at row 1 is missing"), "{e}");
        assert!(intervals(vec![1.0].into()).is_err());
    }
}
