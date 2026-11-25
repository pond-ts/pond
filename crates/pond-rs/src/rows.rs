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

/// A filter that copies its columns one after another makes Arrow's list
/// of the kept rows, once, when what its columns count toward one comes to
/// this ([`TimeSeries::filter_copy`]). A column counts only where, with
/// the list there, it would be copied by it (`ColumnData::list_weight`). A
/// number column counts one, so on most masks this is how many number
/// columns it takes; the kinds and the masks that gain more by the list
/// count more (the constants below). A dictionary column counts as a
/// number column does. Plain text counts this whole number where it goes
/// by the list (few rows kept, a row or two at a time:
/// `RowFilter::text_by_list`), and nothing on any other mask.
///
/// Timed on an x86 server at 100,000 and 1,000,000 rows, with rows kept at
/// random. Number columns, with a quarter to three quarters of the rows
/// kept: at 8 columns the list was 5 to 17% faster than the copy from the
/// mask, at 4 the two were level over those shares taken together (the
/// list 9% faster to 12% slower), and at 1 and 2 the copy from the mask
/// was level to 21% faster. (Taken share by share, fewer columns gain
/// where the kept rows come one or two at a time: that is what
/// [`LIST_WEIGHT_SINGLE`] and [`LIST_WEIGHT_SCATTERED`] are for.) Decimal
/// columns, the same shares: at 8 the list was level to 13% faster, and at
/// 4, the fewest that make a list, the two were level (the list 10% faster
/// to 9% slower over twelve lines). With more than four rows in five kept,
/// 4 decimal columns were level at 1,000,000 rows, and at 100,000 the list
/// was the slower by 6% on the middle line of six (from 3% faster to 13%
/// slower); at 8 and 16 the two were level at 1,000,000 rows and the list
/// 3 to 13% faster at 100,000 (on eleven lines of twelve).
pub(crate) const FILTER_LIST_COLUMNS: usize = 8;

/// What a decimal column counts toward [`FILTER_LIST_COLUMNS`]: its values
/// are 16 bytes to a number's 8.
pub(crate) const LIST_WEIGHT_DECIMAL: usize = 2;

/// What a number column counts on a mask whose kept rows come mostly one
/// at a time ([`RowFilter::mostly_single`]): three such columns make a
/// list.
///
/// Timed on an x86 server with rows kept at random: the list for every
/// column against the copy from the words, at 1,000,000 and at 100,000
/// rows. Three number columns, with a tenth of the rows kept, 0.85 and
/// 1.00; a quarter, 0.92 and 1.01; a third, 0.93 and 0.91; four in ten,
/// 0.91 and 0.99. Two number columns, for which the rule makes no list:
/// a tenth kept, 0.91 and 0.92; a quarter to four in ten, 0.91 to 0.98
/// and 0.96 to 1.04; a half, 0.99 and 1.06.
pub(crate) const LIST_WEIGHT_SINGLE: usize = 3;

/// What a number column counts on a mask whose kept rows are scattered
/// ([`RowFilter::scattered`]) but not mostly single: four such columns
/// make a list. On any other mask a number column counts one.
///
/// Timed as [`LIST_WEIGHT_SINGLE`], with half the rows kept at random (two
/// rows to a stretch): four number columns, 0.93 and 1.00; five, 0.90 and
/// 0.94; six, 0.88 and 0.93; seven, 0.87 and 0.96. Three, for which the
/// rule makes no list: 0.94 and 1.01. With six rows in ten kept (two and a
/// half to a stretch), where a column counts one and none of these tables
/// makes a list: four to seven columns by the list, 0.94 to 1.00 and 0.97
/// to 1.03.
pub(crate) const LIST_WEIGHT_SCATTERED: usize = 2;

/// What a run of bits counts (a true/false column's values, or the marks
/// for gaps of a true/false or a decimal column that has gaps), on a mask
/// whose bits go faster by the list ([`RowFilter::bits_by_list`]): one
/// run, and one number column whose rows come one at a time, make a list
/// between them.
///
/// Timed on an x86 server with 1, 2 and 5% of the rows kept at random, at
/// 1,000,000 and at 100,000 rows: this code against itself with bits
/// never by the list, each line timed twice. One true/false column beside
/// one number column took 0.86 to 0.96 of the time (the middle of the
/// readings 0.93) and 0.75 to 0.95 (0.91); two true/false columns, or one
/// with gaps, 0.82 to 0.90 (0.86) and 0.83 to 1.09 (0.93); four, or two
/// with gaps, 0.73 to 0.87 (0.79) and 0.69 to 0.87 (0.83). With 10% kept,
/// where bits go from the words in both, the same tables read 0.87 to
/// 1.05 and 0.88 to 1.10: that is what two builds of one copy differ by.
/// (Sixteen columns are with `BITS_LIST_ROWS` in `row_filter.rs`.)
pub(crate) const LIST_WEIGHT_BITS: usize = 5;

/// How [`TimeSeries::filter_rows`] copies the kept rows. The series that
/// comes out is the same each way.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FilterCopy {
    /// The key, then each column, each straight from the mask.
    Direct,
    /// The same copies, the key and each column on a core of its own.
    Split,
    /// One after another, with a list of the kept rows made once: each
    /// column goes by it where that is the faster for this mask
    /// (`ColumnData::filter`).
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
    /// made first would be a step every core waits for, so no column is
    /// handed one. (Plain text that goes by the list asks for it itself,
    /// whichever way this is, and the first such column to ask makes it:
    /// `RowFilter::text_by_list`. With a core each that takes a series of
    /// over a million rows, under one in eight of them kept.) Otherwise
    /// the copies run one after another, and a list of the kept rows pays
    /// once the columns that would be copied faster by it gain enough
    /// between them: each counts toward it by its kind and by the mask
    /// (`ColumnData::list_weight`), and the list is made when the counts
    /// come to [`FILTER_LIST_COLUMNS`].
    pub(crate) fn filter_copy(&self, keep: &RowFilter, threads: usize) -> FilterCopy {
        if keep.count() >= FILTER_SPLIT_ROWS && threads > 1 {
            return FilterCopy::Split;
        }
        let sharing = self.columns().iter().map(|c| c.data().list_weight(keep));
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

    /// One column of each kind over `rows` rows, with a gap in every fifth
    /// row or with none: `w` a number, `m` a decimal, `d` a dictionary of
    /// strings, `b` true/false, `t` plain text.
    fn column_of(kind: char, name: &str, rows: usize, gaps: bool) -> Column {
        let there = |i: usize| !gaps || !i.is_multiple_of(5);
        match kind {
            'w' => Column::required(name, vec![1.0; rows]),
            'm' => {
                let cents = (0..rows).map(|i| there(i).then_some(i as i128));
                let cents = crate::column::DecimalColumn::from_options(cents, 2);
                Column::optional(name, cents.unwrap())
            }
            'd' => {
                let words: arrow_array::DictionaryArray<arrow_array::types::Int32Type> = (0..rows)
                    .map(|i| there(i).then_some(["a", "b"][i % 2]))
                    .collect();
                let words = StringColumn::dictionary(words).unwrap();
                Column::from_data(name.into(), words, false)
            }
            'b' => {
                let flags = (0..rows).map(|i| there(i).then_some(i.is_multiple_of(3)));
                Column::optional(name, flags.collect::<Vec<_>>())
            }
            't' if gaps => {
                let text = (0..rows).map(|i| there(i).then_some("a"));
                Column::optional(name, text.collect::<Vec<_>>())
            }
            't' => Column::required(name, vec!["a"; rows]),
            _ => unreachable!("no such kind"),
        }
    }

    /// A series of the kinds in `kinds` (see [`column_of`]): a letter for
    /// a column without gaps, the same letter in capitals for one with.
    fn series_of(kinds: &str, rows: usize) -> TimeSeries {
        let columns = kinds.chars().enumerate().map(|(c, kind)| {
            let gaps = kind.is_ascii_uppercase();
            column_of(kind.to_ascii_lowercase(), &format!("c{c}"), rows, gaps)
        });
        TimeSeries::new("s", (0..rows as i64).collect(), columns.collect()).unwrap()
    }

    #[test]
    fn filter_copy_goes_by_rows_kept_cores_and_columns() {
        use FilterCopy::{Direct, Listed, Split};
        let rows = 640;
        let mask = |f: &dyn Fn(usize) -> bool| -> RowFilter { (0..rows).map(f).collect() };
        // On one core: the way for a series of these kinds and this mask.
        let how = |kinds: &str, keep: &RowFilter| series_of(kinds, rows).filter_copy(keep, 1);

        // Every other row. Values of every width are the faster by the
        // list: a number counts 3 toward it (the rows come one at a time),
        // and so does a dictionary, for its keys; a decimal's values count
        // 2. Plain text counts nothing here: it goes by the list only where
        // few rows are kept (below). Nor do bits: half the rows are kept,
        // and they go faster from the words.
        let every_other = mask(&|i| i % 2 == 0);
        assert!(every_other.mostly_single() && !every_other.bits_by_list());
        assert!(every_other.list_pays(8) && every_other.list_pays(16));
        for (kinds, way) in [
            ("ww", Direct),
            ("www", Listed),
            ("wm", Direct),
            ("wwm", Listed),
            ("mmm", Direct),
            ("mmmm", Listed),
            ("M", Direct),
            ("wM", Direct),
            ("wwb", Direct),
            ("wwB", Direct),
            ("bbbb", Direct),
            ("dd", Direct),
            ("ddd", Listed),
            ("wwd", Listed),
            ("wd", Direct),
            ("tttttttt", Direct),
            ("wwt", Direct),
            ("wwwt", Listed),
        ] {
            assert_eq!(how(kinds, &every_other), way, "every other row, {kinds}");
        }
        // One row in 16: so few that bits go by the list too, and each run
        // of them counts 5 (a true/false column's values, and the gap
        // marks of a true/false or a decimal column that has gaps). Plain
        // text goes by the list as well, and one such column makes it.
        let one_in_16 = mask(&|i| i % 16 == 0);
        assert!(one_in_16.mostly_single() && one_in_16.bits_by_list());
        assert!(one_in_16.text_by_list());
        for (kinds, way) in [
            ("t", Listed),
            ("T", Listed),
            ("wt", Listed),
            ("b", Direct),
            ("mb", Direct),
            ("wb", Listed),
            ("bb", Listed),
            ("B", Listed),
            ("M", Direct),
            ("wM", Listed),
            ("mM", Listed),
        ] {
            assert_eq!(how(kinds, &one_in_16), way, "one row in 16, {kinds}");
        }
        // Two rows kept, two dropped: scattered, but no longer one at a
        // time, so a number counts 2; and bits no longer go by the list,
        // so they count nothing.
        let pairs = mask(&|i| i % 4 < 2);
        assert!(pairs.scattered() && !pairs.mostly_single() && !pairs.bits_by_list());
        for (kinds, way) in [
            ("www", Direct),
            ("wwww", Listed),
            ("wwwBB", Direct),
            ("wwM", Direct),
            ("wwMM", Listed),
            ("ddd", Direct),
            ("dddd", Listed),
            ("wwwt", Direct),
        ] {
            assert_eq!(how(kinds, &pairs), way, "pairs, {kinds}");
        }
        // Eight kept, eight dropped: not scattered, so a number counts 1.
        let eights = mask(&|i| i % 16 < 8);
        assert!(!eights.scattered() && eights.list_pays(8) && eights.list_pays(16));
        for (kinds, way) in [
            ("wwwwwww", Direct),
            ("wwwwwwww", Listed),
            ("wwwwwm", Direct),
            ("wwwwwwm", Listed),
            ("wmmm", Direct),
            ("mmmm", Listed),
            ("ddddddd", Direct),
            ("dddddddd", Listed),
            ("wwwwwwd", Direct),
            ("wwwwwwwd", Listed),
            ("wwwwwwwB", Direct),
            ("wwwwwM", Direct),
            ("wwwwwwM", Listed),
            ("wwwwwwwt", Direct),
        ] {
            assert_eq!(how(kinds, &eights), way, "eights, {kinds}");
        }
        // Only the columns this mask copies faster by the list count. Half
        // the rows in stretches of 20: values of up to eight bytes do (a
        // number's 8, a dictionary key's 4), a decimal's 16 do not.
        let twenties = mask(&|i| i % 40 < 20);
        assert!(twenties.list_pays(8) && !twenties.list_pays(16));
        assert_eq!(how("wwwwwwww", &twenties), Listed);
        assert_eq!(how("wwwwwwwmmmm", &twenties), Direct);
        assert_eq!(how("ddddddd", &twenties), Direct);
        assert_eq!(how("dddddddd", &twenties), Listed);
        assert_eq!(how("wwwwwwwd", &twenties), Listed);
        // Six rows in seven, six at a time: the other way round.
        let sixes = mask(&|i| i % 7 != 6);
        assert!(!sixes.list_pays(8) && sixes.list_pays(16));
        assert_eq!(how("wwwwwwwwwwwwwwww", &sixes), Direct);
        assert_eq!(how("wwwwwwwwwwwwwwwwmmm", &sixes), Direct);
        assert_eq!(how("mmmm", &sixes), Listed);
        assert_eq!(how("dddddddd", &sixes), Direct);
        // More than four rows in five, 32 at a time: values of up to eight
        // bytes go by the list (of stretches) again, and count 1.
        let most = mask(&|i| i % 33 != 32);
        assert!(most.list_pays(8) && !most.scattered());
        assert_eq!(how("wwwwwww", &most), Direct);
        assert_eq!(how("wwwwwwww", &most), Listed);
        assert_eq!(how("ddddddd", &most), Direct);
        assert_eq!(how("wwwwwwwd", &most), Listed);
        // Three rows in four, 48 at a time: nothing counts (keys go
        // straight from the mask, as numbers do).
        let long = mask(&|i| i % 64 < 48);
        assert_eq!(how("wwwwwwwwdddddddd", &long), Direct);
        // Plain text counts nothing on the others, nor where as few rows
        // are kept three at a time.
        let few_threes = mask(&|i| i % 48 < 3);
        assert!(few_threes.bits_by_list() && !few_threes.text_by_list());
        for keep in [&every_other, &pairs, &eights, &sixes, &most, &few_threes] {
            assert_eq!(how("tttttttttttt", keep), Direct);
        }
        // Half the rows in one long stretch: nothing counts.
        let first_half = mask(&|i| i < 320);
        assert!(!first_half.list_pays(8) && !first_half.list_pays(16));
        assert_eq!(how("wwwwwwwwMMMMDDBBtt", &first_half), Direct);

        // Many rows kept: a core each, when there is more than one.
        let rows = 2 * FILTER_SPLIT_ROWS;
        let wide = series_of("wwwwwwww", rows);
        let many: RowFilter = (0..rows).map(|i| i % 2 == 0).collect();
        assert_eq!(many.count(), FILTER_SPLIT_ROWS);
        assert_eq!(wide.filter_copy(&many, 2), Split);
        assert_eq!(wide.filter_copy(&many, 1), Listed);
        let one_fewer: RowFilter = (0..rows).map(|i| i % 2 == 0 && i > 0).collect();
        assert_eq!(one_fewer.count(), FILTER_SPLIT_ROWS - 1);
        assert_eq!(wide.filter_copy(&one_fewer, 2), Listed);
        // On one core nothing is split, however many rows are kept: five
        // times the rows it takes on two.
        let rows = 5 * FILTER_SPLIT_ROWS;
        let all: RowFilter = (0..rows).map(|_| true).collect();
        let long = series_of("w", rows);
        assert_eq!(long.filter_copy(&all, 1), Direct);
        assert_eq!(long.filter_copy(&all, 2), Split);
    }

    /// Which way a column was copied shows in whether the mask's list of
    /// kept rows was made. The rows that come out are the same either way,
    /// so no test of results can tell the two apart.
    #[test]
    fn filter_takes_the_list_only_where_the_rules_say() {
        let rows = 640;
        let column = |kind: char, gaps: bool| column_of(kind, "c", rows, gaps);
        // A mask made afresh for each copy: its list is made at most once.
        let by_list = |c: &Column, mask: &dyn Fn(usize) -> bool, listed: bool| {
            let keep: RowFilter = (0..c.data().len()).map(mask).collect();
            let kept = c.data().filter(&keep, listed);
            assert_eq!(kept.len(), keep.count());
            keep.has_list()
        };
        // Every other row: the list pays for every width.
        let every_other = |i: usize| i.is_multiple_of(2);
        // One row in 16: as every other row, and bits go by the list too.
        let one_in_16 = |i: usize| i.is_multiple_of(16);
        // Two kept, two dropped: as every other row.
        let pairs = |i: usize| i % 4 < 2;
        // One long stretch: nothing goes by the list.
        let first_half = |i: usize| i < 320;
        // Half the rows in stretches of 20: the list pays for values of up
        // to eight bytes, not for wider ones.
        let twenties = |i: usize| i % 40 < 20;
        // Six rows in seven, six at a time: the other way round.
        let sixes = |i: usize| i % 7 != 6;
        // Three rows in four, 48 at a time: long stretches.
        let long = |i: usize| i % 64 < 48;
        // All but one row in 33: most rows, in long stretches.
        let most = |i: usize| i % 33 != 32;
        // One row in 16 again, three at a time: bits go by the list, plain
        // text does not.
        let few_threes = |i: usize| i % 48 < 3;
        let masks: [(&str, &dyn Fn(usize) -> bool); 9] = [
            ("every other", &every_other),
            ("one in 16", &one_in_16),
            ("pairs", &pairs),
            ("first half", &first_half),
            ("twenties", &twenties),
            ("sixes", &sixes),
            ("long", &long),
            ("most", &most),
            ("few threes", &few_threes),
        ];

        // Numbers, decimal values and dictionary keys: only with the list
        // there to share, and only where it pays for their width.
        let (number, cents, words) = (column('w', false), column('m', false), column('d', false));
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
        // True/false values, and the gap marks of a decimal or a
        // dictionary column: only with the list there to share, and only
        // on a mask whose bits go by it. (On `sixes` a number's
        // values and a dictionary's keys do not go by the list, so a list
        // made there would be made for the marks.)
        let (flags, gappy) = (column('b', false), column('b', true));
        for c in [&flags, &gappy] {
            assert!(by_list(c, &one_in_16, true), "{}", c.name());
            assert!(!by_list(c, &one_in_16, false), "{}", c.name());
            assert!(!by_list(c, &every_other, true), "{}", c.name());
            assert!(!by_list(c, &pairs, true), "{}", c.name());
            assert!(!by_list(c, &sixes, true), "{}", c.name());
        }
        let gappy_words = column('d', true);
        assert!(!by_list(&gappy_words, &every_other, false));
        assert!(!by_list(&gappy_words, &sixes, true));
        assert!(by_list(&gappy_words, &most, true));
        assert!(!by_list(&gappy_words, &most, false));
        assert!(!by_list(&column('m', true), &every_other, false));
        // A decimal column's gap marks go by the list only on a mask whose
        // bits do. Its values make the list on such a mask anyway, so what
        // shows the way the marks went is whether any word of bits was
        // copied from the mask.
        let gappy_cents = column('m', true);
        let marks_from_the_mask = |mask: &dyn Fn(usize) -> bool, listed: bool| {
            crate::row_filter::take_bit_words();
            assert_eq!(by_list(&gappy_cents, mask, listed), listed);
            crate::row_filter::take_bit_words() > 0
        };
        assert!(!marks_from_the_mask(&one_in_16, true));
        assert!(marks_from_the_mask(&one_in_16, false));
        assert!(marks_from_the_mask(&every_other, true));
        assert!(marks_from_the_mask(&pairs, true));
        // Plain text, with gaps or without: by the list where few rows are
        // kept, one at a time, and nowhere else. It asks for the list
        // itself, whichever way the series is copied: one text column is
        // enough to choose the listed way, and where each column has a core
        // of its own there is no listed way to choose. Copied from the
        // words, its gap marks go from the words too, even on a mask whose
        // bits go by the list ("few threes").
        for text in [column('t', false), column('t', true)] {
            for (name, mask) in masks {
                for listed in [true, false] {
                    let by = by_list(&text, mask, listed);
                    assert_eq!(by, name == "one in 16", "{name}, {listed}");
                }
            }
        }

        // What a column counts toward the list and how it is copied are
        // two readings of the same rules: a column counts exactly when,
        // with the list there to share, it would go by it.
        for (kind, gaps) in [
            ('w', false),
            ('m', false),
            ('m', true),
            ('d', false),
            ('d', true),
            ('b', false),
            ('b', true),
            ('t', false),
            ('t', true),
        ] {
            let c = column(kind, gaps);
            for (name, mask) in masks {
                let keep: RowFilter = (0..rows).map(mask).collect();
                let counts = c.data().list_weight(&keep) > 0;
                assert_eq!(
                    by_list(&c, mask, true),
                    counts,
                    "{kind}, gaps {gaps}, {name}"
                );
            }
        }

        // A whole series, of every kind: only the listed way makes the
        // list, or text that goes by it.
        let s = series_of("wwwwMMDDBBtT", rows);
        for (name, mask) in masks {
            let kept = (0..rows).filter(|&i| mask(i)).count();
            for (how, may) in [
                (FilterCopy::Direct, false),
                (FilterCopy::Split, false),
                (FilterCopy::Listed, true),
            ] {
                let keep: RowFilter = (0..rows).map(mask).collect();
                assert_eq!(s.filter_rows_by(&keep, how).len(), kept);
                let text = keep.text_by_list();
                assert!(may || text || !keep.has_list(), "{name}, {how:?}");
                assert!(!text || keep.has_list(), "{name}, {how:?}");
            }
        }
        let keep: RowFilter = (0..rows).map(every_other).collect();
        s.filter_rows_by(&keep, FilterCopy::Listed);
        assert!(keep.has_list());
        // And the way chosen for a series never leaves a list unmade that
        // a column then makes for itself: where the choice is a copy
        // straight from the mask, no column makes one.
        for kinds in [
            "ww",
            "www",
            "wb",
            "wd",
            "d",
            "M",
            "wwwBB",
            "t",
            "wt",
            "wwwtT",
            "dddT",
            "wwwwwwwBM",
        ] {
            let s = series_of(kinds, rows);
            for (name, mask) in masks {
                let keep: RowFilter = (0..rows).map(mask).collect();
                let how = s.filter_copy(&keep, 1);
                s.filter_rows_by(&keep, how);
                assert_eq!(
                    keep.has_list(),
                    how == FilterCopy::Listed
                        && s.columns().iter().any(|c| c.data().list_weight(&keep) > 0),
                    "{kinds}, {name}"
                );
            }
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
