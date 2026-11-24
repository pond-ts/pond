//! Picking rows and changing columns with your own Rust code: `slice`,
//! `filter`, `rows` / `row`, `with_column` and the `map_*` family.
//!
//! pond-ts's `map(schema, event => event)` rebuilds whole rows through a
//! closure. pond-rs has no row objects to rebuild; the same work is a loop
//! over [`TimeSeries::rows`] that collects a new column, handed to
//! [`TimeSeries::with_column`]:
//!
//! ```
//! # use pond_rs::{Column, TimeSeries};
//! let s = TimeSeries::new("power", vec![0, 1000, 2000], vec![
//!     Column::required("volts", vec![230.0, 231.0, 229.0]),
//!     Column::optional("amps", vec![Some(2.0), None, Some(1.5)]),
//! ])?;
//! let watts = s
//!     .rows()
//!     .map(|r| Ok(r.number("volts")?.zip(r.number("amps")?).map(|(v, a)| v * a)))
//!     .collect::<pond_rs::Result<Vec<_>>>()?;
//! let s = s.with_column(Column::optional("watts", watts))?;
//! assert_eq!(s.column("watts")?.numbers()?.get(0), Some(460.0));
//! assert_eq!(s.column("watts")?.numbers()?.get(1), None); // amps missing
//! # Ok::<(), pond_rs::PondError>(())
//! ```

use std::ops::{Bound, RangeBounds};

use crate::column::{ArrayColumn, BooleanColumn, ColumnData, Decimal, Scalar, StringColumn};
use crate::error::{PondError, Result};
use crate::row_filter::RowFilter;
use crate::series::{Column, TimeSeries};

/// From this many kept rows on, `filter` copies the key and each column on
/// a core of its own. Handing the copies out costs about 0.1 ms, whatever
/// there is to copy. Measured with four cores on a key, a number column
/// and a text column: no faster than one core at 74,000 kept rows, 13%
/// faster at 148,000.
const FILTER_SPLIT_ROWS: usize = 1 << 17;

/// A filter that copies its columns one after another makes a list of the
/// kept rows, once, when this many columns would be copied faster by it
/// than straight from the mask ([`TimeSeries::filter_copy`]). A decimal
/// column counts as two: its values are 16 bytes to a number's 8.
///
/// Timed on an x86 server at 100,000 and 1,000,000 rows, with rows kept at
/// random. Number columns, with a quarter to three quarters of the rows
/// kept: at 8 columns the list was 5 to 17% faster than the copy from the
/// mask, at 4 the two were level (the list 9% faster to 12% slower), and
/// at 1 and 2 the copy from the mask was level to 21% faster. Decimal
/// columns, the same shares: at 8 the list was level to 13% faster, and at
/// 4, the fewest that make a list, the two were level (the list 10% faster
/// to 9% slower over twelve lines). With more than four rows in five kept,
/// 4 decimal columns were level at 1,000,000 rows, and at 100,000 the list
/// was the slower by 6% on the middle line of six (from 3% faster to 13%
/// slower); at 8 and 16 the two were level at 1,000,000 rows and the list
/// 3 to 13% faster at 100,000 (on eleven lines of twelve). (With a tenth
/// of the rows kept or fewer the list is already the faster at 4 number
/// columns, by 14 to 23%, and at 2 and 3 decimal columns; the bar is not
/// lowered for that, see PND_RUST_PLAN.md, "Considered, not done".)
const FILTER_LIST_COLUMNS: usize = 8;

/// How [`TimeSeries::filter_rows`] copies the kept rows. The series that
/// comes out is the same each way.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FilterCopy {
    /// The key, then each column, each straight from the mask.
    Direct,
    /// The same copies, the key and each column on a core of its own.
    Split,
    /// One after another, with a list of the kept rows made once: number,
    /// decimal and dictionary columns go by it when that is the faster
    /// for this mask ([`RowFilter::list_pays`]).
    Listed,
}

/// One row of a series, handed to [`TimeSeries::filter`]'s closure and
/// yielded by [`TimeSeries::rows`]. Values are read by column name; a name
/// the series does not have, or a column of another kind, is an error.
#[derive(Debug, Clone, Copy)]
pub struct Row<'a> {
    series: &'a TimeSeries,
    index: usize,
}

impl<'a> Row<'a> {
    /// The row's position in the series, from 0.
    pub fn index(&self) -> usize {
        self.index
    }

    pub(crate) fn series(&self) -> &'a TimeSeries {
        self.series
    }

    /// The row's time in epoch milliseconds (its start, for time ranges and
    /// intervals).
    pub fn begin(&self) -> i64 {
        self.series.key().begin()[self.index]
    }

    /// The row's end in epoch milliseconds; the same as [`Row::begin`] for
    /// a series keyed by points in time.
    pub fn end(&self) -> i64 {
        self.series
            .key()
            .end()
            .map_or_else(|| self.begin(), |e| e[self.index])
    }

    /// The number in `column`, or `None` for a gap.
    pub fn number(&self, column: &str) -> Result<Option<f64>> {
        self.column("Row::number", column)?
            .numbers()
            .map(|c| c.get(self.index))
            .map_err(|e| as_call(e, "Row::number"))
    }

    /// The exact decimal in `column`, or `None` for a gap.
    pub fn decimal(&self, column: &str) -> Result<Option<Decimal>> {
        self.column("Row::decimal", column)?
            .decimals()
            .map(|c| c.get(self.index))
            .map_err(|e| as_call(e, "Row::decimal"))
    }

    /// The text in `column`, or `None` for a gap.
    pub fn string(&self, column: &str) -> Result<Option<&'a str>> {
        self.column("Row::string", column)?
            .strings()
            .map(|c| c.get(self.index))
            .map_err(|e| as_call(e, "Row::string"))
    }

    /// The true/false value in `column`, or `None` for a gap.
    pub fn boolean(&self, column: &str) -> Result<Option<bool>> {
        self.column("Row::boolean", column)?
            .booleans()
            .map(|c| c.get(self.index))
            .map_err(|e| as_call(e, "Row::boolean"))
    }

    /// The array in `column`, or `None` for a gap.
    pub fn array(&self, column: &str) -> Result<Option<&'a [Scalar]>> {
        self.column("Row::array", column)?
            .arrays()
            .map(|c| c.get(self.index))
            .map_err(|e| as_call(e, "Row::array"))
    }

    fn column(&self, call: &'static str, name: &str) -> Result<&'a Column> {
        Ok(&self.series.columns()[self.series.column_index(call, name)?])
    }
}

impl TimeSeries {
    /// The rows in `range`, by position. Negative positions count from the
    /// end (`-1` is the last row) and positions past either end are
    /// clamped, as JavaScript's `Array.prototype.slice` and pond-ts's
    /// `slice` do; a range that ends before it starts gives no rows. Value
    /// columns share memory with this series.
    ///
    /// ```
    /// # use pond_rs::{Column, TimeSeries};
    /// let s = TimeSeries::new("s", vec![0, 1, 2, 3, 4], vec![
    ///     Column::required("v", vec![10.0, 11.0, 12.0, 13.0, 14.0]),
    /// ])?;
    /// assert_eq!(s.slice(1..3).len(), 2);
    /// assert_eq!(s.slice(-2..).key().begin(), &[3, 4]); // the last two
    /// assert_eq!(s.slice(..-1).len(), 4); // all but the last
    /// assert_eq!(s.slice(2..=-1).len(), 3); // `..=-1` runs to the end
    /// assert_eq!(s.slice(..100).len(), 5); // clamped
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn slice(&self, range: impl RangeBounds<i64>) -> TimeSeries {
        let n = self.len() as i64;
        // A position from the front: negative counts back from the end.
        let at = |i: i64| if i < 0 { n.saturating_add(i) } else { i };
        let clamp = |i: i64| i.clamp(0, n) as usize;
        let start = clamp(match range.start_bound() {
            Bound::Included(&i) => at(i),
            Bound::Excluded(&i) => at(i).saturating_add(1),
            Bound::Unbounded => 0,
        });
        let end = clamp(match range.end_bound() {
            Bound::Included(&i) => at(i).saturating_add(1),
            Bound::Excluded(&i) => at(i),
            Bound::Unbounded => n,
        });
        self.row_range(start..end.max(start))
    }

    /// The rows for which `keep` returns `Ok(true)`, in order. An error from
    /// `keep` stops the walk and is returned.
    ///
    /// Reading a value by name looks the column up on every row; for the
    /// fastest loop, fetch the column once and index it with
    /// [`Row::index`].
    ///
    /// ```
    /// # use pond_rs::{Column, TimeSeries};
    /// let s = TimeSeries::new("s", vec![0, 1000, 2000], vec![
    ///     Column::optional("cpu", vec![Some(0.2), None, Some(0.9)]),
    /// ])?;
    /// let busy = s.filter(|r| Ok(r.number("cpu")?.is_some_and(|v| v > 0.5)))?;
    /// assert_eq!(busy.key().begin(), &[2000]);
    ///
    /// let cpu = s.column("cpu")?.numbers()?;
    /// let gaps = s.filter(|r| Ok(cpu.get(r.index()).is_none()))?;
    /// assert_eq!(gaps.len(), 1);
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn filter<F>(&self, mut keep: F) -> Result<TimeSeries>
    where
        F: FnMut(&Row<'_>) -> Result<bool>,
    {
        let mut words = vec![0u64; self.len().div_ceil(64)];
        for row in self.rows() {
            if keep(&row)? {
                words[row.index / 64] |= 1 << (row.index % 64);
            }
        }
        let keep = RowFilter::from_words(words, self.len());
        if keep.count() == self.len() {
            return Ok(self.clone());
        }
        Ok(self.filter_rows(&keep))
    }

    /// Every row, in order. See [`Row`].
    pub fn rows(&self) -> impl ExactSizeIterator<Item = Row<'_>> + '_ {
        (0..self.len()).map(move |index| Row {
            series: self,
            index,
        })
    }

    /// The row at `index`, or `None` past the end.
    pub fn row(&self, index: usize) -> Option<Row<'_>> {
        (index < self.len()).then_some(Row {
            series: self,
            index,
        })
    }

    /// The first row, or `None` for an empty series (pond-ts `first()`).
    pub fn first(&self) -> Option<Row<'_>> {
        self.row(0)
    }

    /// The last row, or `None` for an empty series (pond-ts `last()`).
    ///
    /// ```
    /// # use pond_rs::{Column, TimeSeries};
    /// let s = TimeSeries::new("s", vec![0, 1000], vec![
    ///     Column::required("close", vec![10.0, 11.5]),
    /// ])?;
    /// let last = s.last().expect("not empty");
    /// assert_eq!((last.begin(), last.number("close")?), (1000, Some(11.5)));
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn last(&self) -> Option<Row<'_>> {
        self.len().checked_sub(1).and_then(|i| self.row(i))
    }

    /// The rows in the trailing `duration` (`"60m"`, see
    /// [`parse_duration`](crate::parse_duration)): those starting strictly
    /// after the last row's start minus `duration`, as pond-ts
    /// `tail(duration)`. An empty series is returned as is (without reading
    /// `duration`, as in pond-ts). Value columns share memory with this
    /// series.
    ///
    /// With [`TimeSeries::reduce`], this is "the state over the last hour"
    /// without a `rolling` pass over the whole history:
    ///
    /// ```
    /// # use pond_rs::{Agg, Column, Reducer, TimeSeries};
    /// let s = TimeSeries::new("s", vec![0, 1_800_000, 3_600_000], vec![
    ///     Column::required("close", vec![10.0, 12.0, 14.0]),
    /// ])?;
    /// let hour = s.tail("60m")?; // starts after 0: the last two rows
    /// assert_eq!(hour.len(), 2);
    /// let r = hour.reduce(&[Agg::new("mean", "close", Reducer::Avg)])?;
    /// assert_eq!(r.number("mean")?, Some(13.0));
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn tail(&self, duration: &str) -> Result<TimeSeries> {
        let begin = self.key().begin();
        // pond-ts returns an empty series before reading the duration.
        let Some(&last) = begin.last() else {
            return Ok(self.clone());
        };
        let duration = crate::parse_duration(duration)?;
        let cutoff = last.saturating_sub(duration);
        // Rows are in begin order, so the kept rows are a suffix.
        let start = begin.partition_point(|&b| b <= cutoff);
        Ok(self.row_range(start..begin.len()))
    }

    /// This series with `column` added after the existing columns. An error
    /// if its length differs from the series, its name is taken (by a
    /// value column or the key), or it is required and has a gap. Existing
    /// columns are shared, not copied.
    ///
    /// pond-ts's `withColumn` takes numbers only and always makes the new
    /// column optional; here any [`Column`] works, and
    /// [`Column::required`] / [`Column::optional`] decide.
    pub fn with_column(&self, column: Column) -> Result<TimeSeries> {
        let mut columns = self.columns().to_vec();
        columns.push(column);
        TimeSeries::check_columns(
            "TimeSeries::with_column",
            self.key_name(),
            self.len(),
            &columns,
        )?;
        Ok(self.with_value_columns(columns))
    }

    /// `column` with `f` applied to every number (pond-ts's `mapColumns`).
    /// Gaps stay gaps and are not passed to `f`; a non-finite result
    /// (`NaN`, `±inf`) is a gap. A required column that gains a gap becomes
    /// optional (as pond-ts `mapColumns`).
    ///
    /// ```
    /// # use pond_rs::{Column, TimeSeries};
    /// let s = TimeSeries::new("t", vec![0, 1000], vec![
    ///     Column::optional("celsius", vec![Some(20.0), None]),
    /// ])?;
    /// let f = s.map_numbers("celsius", |c| c * 1.8 + 32.0)?;
    /// assert_eq!(f.column("celsius")?.numbers()?.get(0), Some(68.0));
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn map_numbers<F>(&self, column: &str, mut f: F) -> Result<TimeSeries>
    where
        F: FnMut(f64) -> f64,
    {
        self.map_column("TimeSeries::map_numbers", column, |col| {
            let values = col.numbers()?.values();
            Ok(ColumnData::from(
                values
                    .iter()
                    .map(|&v| if v.is_finite() { f(v) } else { f64::NAN })
                    .collect::<Vec<f64>>(),
            ))
        })
    }

    /// `column` with `f` applied to every text value. Gaps stay gaps. `f`
    /// may return a `String` or a `&'static str`.
    pub fn map_strings<F, S>(&self, column: &str, mut f: F) -> Result<TimeSeries>
    where
        F: FnMut(&str) -> S,
        S: AsRef<str>,
    {
        self.map_column("TimeSeries::map_strings", column, |col| {
            let mapped: Vec<Option<S>> = col.strings()?.iter().map(|v| v.map(&mut f)).collect();
            Ok(StringColumn::from_options(mapped).into())
        })
    }

    /// `column` with `f` applied to every true/false value. Gaps stay gaps.
    pub fn map_booleans<F>(&self, column: &str, mut f: F) -> Result<TimeSeries>
    where
        F: FnMut(bool) -> bool,
    {
        self.map_column("TimeSeries::map_booleans", column, |col| {
            let mapped = col.booleans()?.iter().map(|v| v.map(&mut f));
            Ok(BooleanColumn::from_options(mapped).into())
        })
    }

    /// `column` with `f` applied to every array. Gaps stay gaps. Every
    /// number in a result must be finite, or the call fails naming the row
    /// (pond-ts's `mapColumns` silently turns such a result into a gap).
    ///
    /// ```
    /// # use pond_rs::{Column, Scalar, TimeSeries};
    /// let s = TimeSeries::new("s", vec![0], vec![
    ///     Column::required("tags", vec![vec![Scalar::from("b"), "a".into()]]),
    /// ])?;
    /// let f = s.map_arrays("tags", |tags| tags.iter().rev().cloned().collect())?;
    /// assert_eq!(f.column("tags")?.arrays()?.get(0), Some(&["a".into(), Scalar::from("b")][..]));
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn map_arrays<F>(&self, column: &str, mut f: F) -> Result<TimeSeries>
    where
        F: FnMut(&[Scalar]) -> Vec<Scalar>,
    {
        const CALL: &str = "TimeSeries::map_arrays";
        self.map_column(CALL, column, |col| {
            let mapped = ArrayColumn::from_options(col.arrays()?.iter().map(|v| v.map(&mut f)));
            if let Some((row, e)) = mapped.first_bad_element() {
                return Err(PondError::InvalidData {
                    call: CALL,
                    message: format!(
                        "row {row} of '{}' maps to an array whose element {e} is not a finite number, string, or boolean",
                        col.name()
                    ),
                });
            }
            Ok(mapped.into())
        })
    }

    /// `column` with `f` applied to every exact decimal. Gaps stay gaps.
    /// Each result must keep the column's scale and fit its precision (the
    /// column's Arrow type), or the call fails naming the row; a decimal
    /// column has one type for every row. pond-ts has no decimal kind.
    pub fn map_decimals<F>(&self, column: &str, mut f: F) -> Result<TimeSeries>
    where
        F: FnMut(Decimal) -> Decimal,
    {
        const CALL: &str = "TimeSeries::map_decimals";
        self.map_column(CALL, column, |col| {
            let d = col.decimals()?;
            let max = 10u128.pow(u32::from(d.precision())) - 1;
            let mapped = d
                .iter()
                .enumerate()
                .map(|(row, v)| {
                    let Some(v) = v else { return Ok(None) };
                    let out = f(v);
                    if out.scale != d.scale() {
                        return Err(PondError::InvalidData {
                            call: CALL,
                            message: format!(
                                "row {row} of '{}' maps to {out} at scale {}, but the column has scale {}",
                                col.name(),
                                out.scale,
                                d.scale()
                            ),
                        });
                    }
                    if out.value.unsigned_abs() > max {
                        return Err(PondError::InvalidData {
                            call: CALL,
                            message: format!(
                                "row {row} of '{}' maps to {out}, which has more than the column's {} digits",
                                col.name(),
                                d.precision()
                            ),
                        });
                    }
                    Ok(Some(out.value))
                })
                .collect::<Result<Vec<Option<i128>>>>()?;
            Ok(d.rebuild(mapped, d.precision()).into())
        })
    }

    /// Replace one value column with what `build` makes of it. The result
    /// becomes optional if it has a gap.
    fn map_column(
        &self,
        call: &'static str,
        name: &str,
        build: impl FnOnce(&Column) -> Result<ColumnData>,
    ) -> Result<TimeSeries> {
        let c = self.column_index(call, name)?;
        let column = &self.columns()[c];
        let data = build(column).map_err(|e| as_call(e, call))?;
        let required = column.is_required() && data.missing_count() == 0;
        let mut columns = self.columns().to_vec();
        columns[c] = Column::from_data(column.name().to_string(), data, required);
        Ok(self.with_value_columns(columns))
    }

    /// The rows `keep` keeps, in order: `take_rows` for the rows of a mask
    /// (see [`RowFilter`] for the copies, and [`FilterCopy`] for the ways
    /// to go about them).
    pub(crate) fn filter_rows(&self, keep: &RowFilter) -> TimeSeries {
        self.filter_rows_by(keep, self.filter_copy(keep, crate::par::threads()))
    }

    /// The way [`TimeSeries::filter_rows`] goes with `threads` cores to
    /// use.
    ///
    /// When many rows are kept and there is more than one core, the key
    /// and each column get a core of their own: a list of the kept rows
    /// made first would be a step every core waits for. (Text in short
    /// stretches still goes by Arrow's kernel and its list; the first text
    /// column's core makes it.) Otherwise the copies run one after
    /// another, and a list of the kept rows pays once enough columns share
    /// it: [`FILTER_LIST_COLUMNS`] of the number, decimal and dictionary
    /// columns that this mask copies faster by the list than straight
    /// from its words ([`RowFilter::list_pays`]), a decimal column
    /// counting as two.
    pub(crate) fn filter_copy(&self, keep: &RowFilter, threads: usize) -> FilterCopy {
        if keep.count() >= FILTER_SPLIT_ROWS && threads > 1 {
            return FilterCopy::Split;
        }
        let sharing = self.columns().iter().map(|c| match c.data() {
            ColumnData::Number(_) => usize::from(keep.list_pays(size_of::<f64>())),
            ColumnData::Decimal(_) => 2 * usize::from(keep.list_pays(size_of::<i128>())),
            ColumnData::String(s) if s.is_dictionary() => {
                usize::from(keep.list_pays(size_of::<i32>()))
            }
            _ => 0,
        });
        if sharing.sum::<usize>() >= FILTER_LIST_COLUMNS {
            FilterCopy::Listed
        } else {
            FilterCopy::Direct
        }
    }

    /// [`TimeSeries::filter_rows`], with the way chosen.
    pub(crate) fn filter_rows_by(&self, keep: &RowFilter, how: FilterCopy) -> TimeSeries {
        let listed = how == FilterCopy::Listed;
        let column = |c: &Column| {
            Column::from_data(
                c.name().to_string(),
                c.data().filter(keep, listed),
                c.is_required(),
            )
        };
        let (key, columns) = if how == FilterCopy::Split {
            crate::par::join(
                || self.key().filter(keep),
                || crate::par::map(self.columns(), column),
            )
        } else {
            (
                self.key().filter(keep),
                self.columns().iter().map(column).collect(),
            )
        };
        TimeSeries::from_parts(
            self.name().to_string(),
            self.key_name().to_string(),
            key,
            columns,
        )
    }

    /// The rows at `rows` (in that order); value columns and key copied.
    pub(crate) fn take_rows(&self, rows: &[usize]) -> TimeSeries {
        let picks: Vec<Option<usize>> = rows.iter().map(|&i| Some(i)).collect();
        let columns = self
            .columns()
            .iter()
            .map(|c| {
                Column::from_data(c.name().to_string(), c.data().take(&picks), c.is_required())
            })
            .collect();
        TimeSeries::from_parts(
            self.name().to_string(),
            self.key_name().to_string(),
            self.key().take(rows),
            columns,
        )
    }
}

/// A wrong-kind error from a column accessor, renamed to the call the user
/// made.
pub(crate) fn as_call(e: PondError, call: &'static str) -> PondError {
    match e {
        PondError::WrongKind {
            column,
            kind,
            reason,
            ..
        } => PondError::WrongKind {
            call,
            column,
            kind,
            reason,
        },
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::series::{IntervalKeys, Labels};

    fn series() -> TimeSeries {
        TimeSeries::new(
            "s",
            vec![0, 1000, 2000, 3000],
            vec![
                Column::optional("x", vec![Some(1.0), None, Some(3.0), Some(4.0)]),
                Column::optional("host", vec![Some("a"), Some("b"), None, Some("a")]),
                Column::required("up", vec![true, false, true, true]),
            ],
        )
        .unwrap()
    }

    #[test]
    fn tail_of_an_empty_series_does_not_read_the_duration() {
        let empty = series().slice(0..0);
        assert_eq!(empty.tail("garbage").unwrap().len(), 0);
        assert!(series().tail("garbage").is_err());
    }

    #[test]
    #[allow(clippy::reversed_empty_ranges)] // backwards ranges are the point
    fn slice_follows_array_slice() {
        let s = series();
        let begins = |r: TimeSeries| r.key().begin().to_vec();
        assert_eq!(begins(s.slice(..)), vec![0, 1000, 2000, 3000]);
        assert_eq!(begins(s.slice(1..3)), vec![1000, 2000]);
        assert_eq!(begins(s.slice(-1..)), vec![3000]);
        assert_eq!(begins(s.slice(..=-2)), vec![0, 1000, 2000]);
        assert_eq!(begins(s.slice(..=1)), vec![0, 1000]);
        assert!(s.slice(3..1).is_empty());
        assert!(s.slice(10..).is_empty());
        assert!(s.slice(-10..-9).is_empty());
        assert_eq!(s.slice(i64::MIN..i64::MAX).len(), 4);
        assert_eq!(s.slice(..=i64::MAX).len(), 4);
        assert_eq!(s.slice((Bound::Excluded(0), Bound::Unbounded)).len(), 3);
    }

    #[test]
    fn filter_keeps_matching_rows_of_every_kind() {
        let s = series();
        let a = s.filter(|r| Ok(r.string("host")? == Some("a"))).unwrap();
        assert_eq!(a.key().begin(), &[0, 3000]);
        assert_eq!(a.column("x").unwrap().numbers().unwrap().get(1), Some(4.0));
        assert_eq!(
            a.column("up").unwrap().booleans().unwrap().get(0),
            Some(true)
        );
        assert!(a.column("up").unwrap().is_required());

        let none = s.filter(|_| Ok(false)).unwrap();
        assert!(none.is_empty());
        assert_eq!(none.columns().len(), 3);

        let all = s.filter(|_| Ok(true)).unwrap();
        assert_eq!(all, s);
    }

    #[test]
    fn filter_copy_goes_by_rows_kept_cores_and_columns() {
        let series = |rows: usize, numbers: usize, text: bool| {
            let mut columns: Vec<Column> = (0..numbers)
                .map(|c| Column::required(format!("w{c}"), vec![1.0; rows]))
                .collect();
            if text {
                columns.push(Column::required("t", vec!["a"; rows]));
            }
            TimeSeries::new("s", (0..rows as i64).collect(), columns).unwrap()
        };
        let cents = |name: &str, rows: usize| {
            let cents = crate::column::DecimalColumn::from_options((0..rows as i128).map(Some), 2);
            Column::optional(name, cents.unwrap())
        };
        let with_cents = |rows: usize, numbers: usize, decimals: usize| {
            (0..decimals).fold(series(rows, numbers, false), |s, d| {
                s.with_column(cents(&format!("m{d}"), rows)).unwrap()
            })
        };
        let every_other = |rows: usize| -> RowFilter { (0..rows).map(|i| i % 2 == 0).collect() };
        // Every other row: a mask every column is the faster by the list
        // for. By the list from eight number columns on, whatever else the
        // series holds.
        let scattered = every_other(640);
        assert!(scattered.list_pays(8) && scattered.list_pays(16));
        for cores in [1, 8] {
            let how = |numbers, text| series(640, numbers, text).filter_copy(&scattered, cores);
            assert_eq!(how(0, true), FilterCopy::Direct);
            assert_eq!(how(7, false), FilterCopy::Direct);
            assert_eq!(how(7, true), FilterCopy::Direct);
            assert_eq!(how(8, false), FilterCopy::Listed);
            assert_eq!(how(8, true), FilterCopy::Listed);
        }
        // A dictionary column's keys go by the list as numbers do.
        let words: arrow_array::DictionaryArray<arrow_array::types::Int32Type> =
            (0..640).map(|i| Some(["a", "b"][i % 2])).collect();
        let words = Column::from_data("d".into(), StringColumn::dictionary(words).unwrap(), false);
        let with_words = series(640, 7, true).with_column(words).unwrap();
        let d = with_words.column("d").unwrap();
        assert!(d.strings().unwrap().is_dictionary());
        assert_eq!(with_words.filter_copy(&scattered, 1), FilterCopy::Listed);
        // A decimal column counts as two.
        let how = |numbers, decimals| with_cents(640, numbers, decimals).filter_copy(&scattered, 1);
        assert_eq!(how(6, 1), FilterCopy::Listed);
        assert_eq!(how(5, 1), FilterCopy::Direct);
        assert_eq!(how(0, 4), FilterCopy::Listed);
        assert_eq!(how(1, 3), FilterCopy::Direct);
        // Only the columns this mask copies faster by the list count. Half
        // the rows in one long stretch: none does.
        let first_half: RowFilter = (0..640).map(|i| i < 320).collect();
        assert!(!first_half.list_pays(8) && !first_half.list_pays(16));
        assert_eq!(
            with_cents(640, 8, 4).filter_copy(&first_half, 1),
            FilterCopy::Direct
        );
        // Half the rows in stretches of 20: numbers do, decimals do not.
        let twenties: RowFilter = (0..640).map(|i| i % 40 < 20).collect();
        assert!(twenties.list_pays(8) && !twenties.list_pays(16));
        let how = |numbers, decimals| with_cents(640, numbers, decimals).filter_copy(&twenties, 1);
        assert_eq!(how(8, 0), FilterCopy::Listed);
        assert_eq!(how(7, 4), FilterCopy::Direct);
        // Six rows in seven, a stretch of six at a time: decimals do,
        // numbers do not.
        let sixes: RowFilter = (0..644).map(|i| i % 7 != 6).collect();
        assert!(!sixes.list_pays(8) && sixes.list_pays(16));
        let how = |numbers, decimals| with_cents(644, numbers, decimals).filter_copy(&sixes, 1);
        assert_eq!(how(16, 0), FilterCopy::Direct);
        assert_eq!(how(16, 3), FilterCopy::Direct);
        assert_eq!(how(0, 4), FilterCopy::Listed);
        // Many rows kept: a core each, when there is more than one.
        let rows = 2 * FILTER_SPLIT_ROWS;
        let (wide, many) = (series(rows, 8, false), every_other(rows));
        assert_eq!(many.count(), FILTER_SPLIT_ROWS);
        assert_eq!(wide.filter_copy(&many, 2), FilterCopy::Split);
        assert_eq!(wide.filter_copy(&many, 1), FilterCopy::Listed);
        let one_fewer: RowFilter = (0..rows).map(|i| i % 2 == 0 && i > 0).collect();
        assert_eq!(one_fewer.count(), FILTER_SPLIT_ROWS - 1);
        assert_eq!(wide.filter_copy(&one_fewer, 2), FilterCopy::Listed);
    }

    /// Which way a column was copied shows in whether the mask's list of
    /// kept rows was made. The rows that come out are the same either way,
    /// so no test of results can tell the two apart.
    #[test]
    fn filter_takes_the_list_only_where_the_rules_say() {
        let rows = 640;
        let number = Column::required("w", vec![1.0; rows]);
        let cents = crate::column::DecimalColumn::from_options((0..rows as i128).map(Some), 2);
        let cents = Column::optional("m", cents.unwrap());
        let words: arrow_array::DictionaryArray<arrow_array::types::Int32Type> =
            (0..rows).map(|i| Some(["a", "b"][i % 2])).collect();
        let words = Column::from_data("d".into(), StringColumn::dictionary(words).unwrap(), false);
        let text = Column::required("t", vec!["a"; rows]);
        let flags = Column::optional("b", (0..rows).map(|i| Some(i % 3 == 0)).collect::<Vec<_>>());
        // A mask made afresh for each copy: its list is made at most once.
        let by_list = |c: &Column, mask: &dyn Fn(usize) -> bool, listed: bool| {
            let keep: RowFilter = (0..rows).map(mask).collect();
            let kept = c.data().filter(&keep, listed);
            assert_eq!(kept.len(), keep.count());
            keep.has_list()
        };
        // Every other row: the list pays for every width, and the text is
        // in short stretches.
        let every_other = |i: usize| i.is_multiple_of(2);
        // One long stretch: nothing goes by the list.
        let first_half = |i: usize| i < 320;
        // Half the rows in stretches of 20: the list pays for values of up
        // to eight bytes, not for wider ones.
        let twenties = |i: usize| i % 40 < 20;
        // Six rows in seven, six at a time: the other way round.
        let sixes = |i: usize| i % 7 != 6;

        // Numbers, decimal values and dictionary keys: only with the list
        // there to share, and only where it pays for their width.
        for c in [&number, &cents, &words] {
            assert!(by_list(c, &every_other, true), "{}", c.name());
            assert!(!by_list(c, &every_other, false), "{}", c.name());
            assert!(!by_list(c, &first_half, true), "{}", c.name());
        }
        assert!(by_list(&number, &twenties, true));
        assert!(by_list(&words, &twenties, true));
        assert!(!by_list(&cents, &twenties, true));
        assert!(!by_list(&number, &sixes, true));
        assert!(!by_list(&words, &sixes, true));
        assert!(by_list(&cents, &sixes, true));
        // Text: by the list whenever its rows come in short stretches,
        // shared or not, and never when they come in long ones.
        for listed in [true, false] {
            assert!(by_list(&text, &every_other, listed));
            assert!(by_list(&text, &twenties, listed));
            assert!(by_list(&text, &sixes, listed));
            assert!(!by_list(&text, &first_half, listed));
            // From 32 rows a stretch, stretch by stretch.
            assert!(by_list(&text, &|i| i % 64 < 31, listed));
            assert!(!by_list(&text, &|i| i % 64 < 32, listed));
        }
        // True/false values: never.
        assert!(!by_list(&flags, &every_other, true));

        // A whole series of numbers: only the listed way makes the list.
        let columns: Vec<Column> = (0..8)
            .map(|c| Column::required(format!("w{c}"), vec![1.0; rows]))
            .collect();
        let s = TimeSeries::new("s", (0..rows as i64).collect(), columns).unwrap();
        for (how, made) in [
            (FilterCopy::Direct, false),
            (FilterCopy::Split, false),
            (FilterCopy::Listed, true),
        ] {
            let keep: RowFilter = (0..rows).map(every_other).collect();
            assert_eq!(s.filter_rows_by(&keep, how).len(), 320);
            assert_eq!(keep.has_list(), made, "{how:?}");
        }
    }

    #[test]
    fn filter_passes_errors_through() {
        let s = series();
        let err = s.filter(|r| Ok(r.number("nope")?.is_some())).unwrap_err();
        assert!(matches!(
            err,
            PondError::UnknownColumn {
                call: "Row::number",
                ..
            }
        ));
        let err = s.filter(|r| Ok(r.number("host")?.is_some())).unwrap_err();
        assert!(
            matches!(
                err,
                PondError::WrongKind {
                    call: "Row::number",
                    ..
                }
            ),
            "{err}"
        );
        let mut seen = 0;
        let _ = s.filter(|_| {
            seen += 1;
            Err(PondError::Unsupported {
                call: "test",
                message: "stop".into(),
            })
        });
        assert_eq!(seen, 1, "the first error stops the walk");
    }

    #[test]
    fn rows_read_keys_and_values() {
        let s = TimeSeries::from_intervals(
            "i",
            IntervalKeys {
                label: Labels::from(vec!["p", "q"]),
                begin: vec![0, 10],
                end: vec![5, 20],
            },
            vec![Column::required("v", vec![1.5, 2.5])],
        )
        .unwrap();
        let r = s.row(1).unwrap();
        assert_eq!((r.index(), r.begin(), r.end()), (1, 10, 20));
        assert_eq!(r.number("v").unwrap(), Some(2.5));
        assert!(s.row(2).is_none());
        assert_eq!(s.rows().len(), 2);
        let kept = s.filter(|r| Ok(r.end() > 5)).unwrap();
        assert_eq!(kept.key().begin(), &[10]);
        assert_eq!(
            kept.key(),
            &crate::series::Key::Interval(IntervalKeys {
                label: Labels::from(vec!["q"]),
                begin: vec![10],
                end: vec![20],
            })
        );
        let t = series();
        assert_eq!(t.row(2).unwrap().end(), 2000);
        assert_eq!(t.row(1).unwrap().string("host").unwrap(), Some("b"));
        assert_eq!(t.row(0).unwrap().boolean("up").unwrap(), Some(true));
    }

    #[test]
    fn with_column_checks_the_new_column() {
        let s = series();
        let out = s
            .with_column(Column::required("y", vec![1.0, 2.0, 3.0, 4.0]))
            .unwrap();
        assert_eq!(out.columns().len(), 4);
        assert!(out.column("y").unwrap().is_required());
        for bad in [
            Column::required("y", vec![1.0, 2.0]),
            Column::required("x", vec![1.0, 2.0, 3.0, 4.0]),
            Column::required("time", vec![1.0, 2.0, 3.0, 4.0]),
            Column::required("y", vec![1.0, f64::NAN, 3.0, 4.0]),
        ] {
            let err = s.with_column(bad).unwrap_err();
            assert!(
                matches!(
                    err,
                    PondError::InvalidData {
                        call: "TimeSeries::with_column",
                        ..
                    }
                ),
                "{err}"
            );
        }
    }

    #[test]
    fn map_numbers_keeps_gaps_and_drops_non_finite() {
        let s = TimeSeries::new(
            "s",
            vec![0, 1, 2],
            vec![Column::required("v", vec![1.0, 2.0, 0.0])],
        )
        .unwrap();
        let mut calls = 0;
        let out = s
            .map_numbers("v", |v| {
                calls += 1;
                1.0 / (v - 2.0)
            })
            .unwrap();
        assert_eq!(calls, 3);
        let v = out.column("v").unwrap();
        assert_eq!(v.numbers().unwrap().get(1), None, "1/0 is a gap");
        assert!(!v.is_required(), "a gap makes the column optional");
        let same = s.map_numbers("v", |v| v * 2.0).unwrap();
        assert!(same.column("v").unwrap().is_required());

        let mut seen = Vec::new();
        series()
            .map_numbers("x", |v| {
                seen.push(v);
                v
            })
            .unwrap();
        assert_eq!(seen, vec![1.0, 3.0, 4.0], "gaps are not passed in");
    }

    #[test]
    fn map_other_kinds() {
        let s = series();
        let up = s.map_strings("host", |h| h.to_uppercase()).unwrap();
        let host = up.column("host").unwrap().strings().unwrap();
        assert_eq!(
            host.iter().collect::<Vec<_>>(),
            vec![Some("A"), Some("B"), None, Some("A")]
        );
        let fixed = s.map_strings("host", |_| "z").unwrap();
        assert_eq!(
            fixed.column("host").unwrap().strings().unwrap().get(2),
            None
        );
        let flipped = s.map_booleans("up", |b| !b).unwrap();
        assert_eq!(
            flipped.column("up").unwrap().booleans().unwrap().get(1),
            Some(true)
        );
        assert!(flipped.column("up").unwrap().is_required());
    }

    #[test]
    fn map_errors() {
        let s = series();
        let err = s.map_numbers("host", |v| v).unwrap_err();
        assert!(
            matches!(
                err,
                PondError::WrongKind {
                    call: "TimeSeries::map_numbers",
                    ..
                }
            ),
            "{err}"
        );
        let err = s.map_booleans("nope", |v| v).unwrap_err();
        assert!(matches!(
            err,
            PondError::UnknownColumn {
                call: "TimeSeries::map_booleans",
                ..
            }
        ));
    }

    #[test]
    fn map_decimals_checks_scale_and_precision() {
        use crate::column::DecimalColumn;
        let d = DecimalColumn::from_options([Some(125), None, Some(-999)], 2).unwrap();
        // Narrow the type to 3 digits so the precision check bites.
        let d = d.rebuild(d.iter().map(|v| v.map(|v| v.value)), 3);
        let s = TimeSeries::new("d", vec![0, 1, 2], vec![Column::optional("p", d)]).unwrap();
        let doubled = s
            .map_decimals("p", |v| Decimal {
                value: v.value / 2,
                scale: v.scale,
            })
            .unwrap();
        let p = doubled.column("p").unwrap().decimals().unwrap();
        assert_eq!(p.get(0).map(|v| v.value), Some(62));
        assert_eq!(p.get(1), None);
        assert_eq!(p.precision(), 3);

        let err = s
            .map_decimals("p", |v| Decimal {
                value: v.value * 10,
                scale: v.scale,
            })
            .unwrap_err();
        assert!(err.to_string().contains("row 0 of 'p'"), "{err}");
        let err = s
            .map_decimals("p", |v| Decimal {
                value: v.value,
                scale: 3,
            })
            .unwrap_err();
        assert!(err.to_string().contains("scale"), "{err}");
    }
}
