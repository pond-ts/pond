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

use crate::column::{BooleanColumn, ColumnData, Decimal, StringColumn};
use crate::error::{PondError, Result};
use crate::series::{Column, TimeSeries};

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
        let mut kept = Vec::new();
        for row in self.rows() {
            if keep(&row)? {
                kept.push(row.index);
            }
        }
        if kept.len() == self.len() {
            return Ok(self.clone());
        }
        Ok(self.take_rows(&kept))
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
    /// `tail(duration)`. An empty series is returned as is. Value columns
    /// share memory with this series.
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
        let duration = crate::parse_duration(duration)?;
        let begin = self.key().begin();
        let Some(&last) = begin.last() else {
            return Ok(self.clone());
        };
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
    /// optional (pond-ts keeps it marked required, which its own `fromJSON`
    /// then refuses: [PND-MAPREQ]).
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
fn as_call(e: PondError, call: &'static str) -> PondError {
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
