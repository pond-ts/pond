//! The [`TimeSeries`] methods that take a column expression ([`Expr`]):
//! `filter_expr`, `find_expr`, `some_expr`, `every_expr`, `map_expr` and
//! `with_column_expr` (pond-ts's `filter` / `find` / `some` / `every` /
//! `mapColumns` / `withColumn` given an expression).

use crate::column::ColumnData;
use crate::error::Result;
use crate::expr::{self, Expr, Source, Vals};
use crate::rows::Row;
use crate::series::{Column, ColumnDef, TimeSeries};

impl Source for TimeSeries {
    fn len(&self) -> usize {
        TimeSeries::len(self)
    }
    fn data(&self, name: &str) -> &ColumnData {
        self.columns()
            .iter()
            .find(|c| c.name() == name)
            .expect("checked: the column exists")
            .data()
    }
}

/// Rows per stretch when `find` / `some` / `every` look for an early answer:
/// 1,024 at first, doubling to 65,536 (as pond-ts).
const FIRST_STRETCH: usize = 1024;
const MAX_STRETCH: usize = 65_536;

impl TimeSeries {
    fn value_defs(&self) -> Vec<ColumnDef> {
        self.schema().into_iter().skip(1).collect()
    }

    /// The rows where `test` (a true/false expression) holds, in order;
    /// pond-ts `filter` given an expression. A gap fails any comparison.
    ///
    /// ```
    /// # use pond_rs::{col, Column, TimeSeries};
    /// let s = TimeSeries::new("s", vec![0, 1000, 2000], vec![
    ///     Column::optional("cpu", vec![Some(0.2), None, Some(0.9)]),
    /// ])?;
    /// assert_eq!(s.filter_expr(&col("cpu").gt(0.5))?.key().begin(), &[2000]);
    /// assert_eq!(s.filter_expr(&col("cpu").gt(0.5).not())?.len(), 2); // keeps the gap
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn filter_expr(&self, test: &Expr) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::filter_expr";
        expr::check_test(test, &self.value_defs(), CALL)?;
        let keep = expr::mask(test, self);
        if keep.count() == self.len() {
            return Ok(self.clone());
        }
        Ok(self.filter_rows(&keep))
    }

    /// First row where `test` evaluates to `want`, looking at growing
    /// stretches so an early answer costs little.
    fn first_where(&self, test: &Expr, call: &'static str, want: bool) -> Result<Option<usize>> {
        expr::check_test(test, &self.value_defs(), call)?;
        let n = self.len();
        let (mut start, mut size) = (0, FIRST_STRETCH);
        while start < n {
            let end = n.min(start + size);
            let part = self.row_range(start..end);
            let Vals::Boolean(v) = expr::evaluate(test, &part) else {
                unreachable!("checked: a true/false expression")
            };
            if let Some(i) = v.iter().position(|&x| (x == 1) == want) {
                return Ok(Some(start + i));
            }
            start = end;
            size = (size * 2).min(MAX_STRETCH);
        }
        Ok(None)
    }

    /// The first row where `test` holds (pond-ts `find` given an
    /// expression).
    pub fn find_expr(&self, test: &Expr) -> Result<Option<Row<'_>>> {
        Ok(self
            .first_where(test, "TimeSeries::find_expr", true)?
            .and_then(|i| self.row(i)))
    }

    /// Whether `test` holds for some row (`false` for an empty series).
    pub fn some_expr(&self, test: &Expr) -> Result<bool> {
        Ok(self
            .first_where(test, "TimeSeries::some_expr", true)?
            .is_some())
    }

    /// Whether `test` holds for every row (`true` for an empty series).
    pub fn every_expr(&self, test: &Expr) -> Result<bool> {
        Ok(self
            .first_where(test, "TimeSeries::every_expr", false)?
            .is_none())
    }

    /// Column `column` replaced by `value`, an expression of the column's
    /// kind that may read any column (as this series has them); pond-ts
    /// `mapColumns({ column: expression })`. A gap cell stays a gap, so
    /// `fill` changes nothing here: use [`TimeSeries::with_column_expr`]
    /// to fill. A required column that gains a gap (`x / 0`) becomes
    /// optional, as with [`TimeSeries::map_numbers`].
    ///
    /// ```
    /// # use pond_rs::{col, Column, TimeSeries};
    /// let s = TimeSeries::new("t", vec![0, 1000], vec![
    ///     Column::optional("celsius", vec![Some(20.0), None]),
    /// ])?;
    /// let f = s.map_expr("celsius", &col("celsius").mul(1.8).add(32))?;
    /// assert_eq!(f.column("celsius")?.numbers()?.get(0), Some(68.0));
    /// assert_eq!(f.column("celsius")?.numbers()?.get(1), None);
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn map_expr(&self, column: &str, value: &Expr) -> Result<TimeSeries> {
        self.map_exprs(&[(column, value)])
    }

    /// Several columns replaced at once, each as [`TimeSeries::map_expr`];
    /// every expression reads the columns as they were before any
    /// replacement (pond-ts `mapColumns` with several entries).
    pub fn map_exprs(&self, columns: &[(&str, &Expr)]) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::map_exprs";
        if columns.is_empty() {
            return Err(crate::PondError::InvalidData {
                call: CALL,
                message: "needs at least one column".into(),
            });
        }
        let defs = self.value_defs();
        let mut out = self.columns().to_vec();
        for &(name, value) in columns {
            let c = self.column_index(CALL, name)?;
            let target = &self.columns()[c];
            let want = target.kind();
            let kind = expr::check(value, &defs, CALL)?;
            if kind.column_kind() != want {
                return Err(crate::PondError::WrongKind {
                    call: CALL,
                    column: name.to_string(),
                    kind: want.as_str(),
                    reason: format!("the expression gives {}", kind.column_kind().as_str()),
                });
            }
            let values = expr::evaluate(value, self);
            let (data, gapless) = match (values, target.data()) {
                // Numbers: keep the target's gaps in the same pass.
                (Vals::Number(v), ColumnData::Number(t)) => {
                    let mut v = v.into_owned();
                    let mut gap = false;
                    if t.all_finite() {
                        for x in &v {
                            gap |= x.is_nan();
                        }
                    } else {
                        for (x, &t) in v.iter_mut().zip(t.values()) {
                            if !t.is_finite() {
                                *x = f64::NAN;
                            }
                            gap |= x.is_nan();
                        }
                    }
                    (ColumnData::from(v), !gap)
                }
                (values, data) => {
                    // A target with no gaps has nothing to keep.
                    let gaps = (data.missing_count() > 0)
                        .then(|| expr::evaluate(&expr::col_expr(name), self));
                    let d = expr::column_of(values, gaps.as_ref());
                    let gapless = d.missing_count() == 0;
                    (d, gapless)
                }
            };
            out[c] = Column::from_data(name.to_string(), data, target.is_required() && gapless);
        }
        Ok(self.with_value_columns(out))
    }

    /// This series with a new optional column `name` holding `value`, an
    /// expression of any kind (pond-ts `withColumn(name, expression)`).
    /// Unlike [`TimeSeries::map_expr`], `fill` fills gaps here.
    pub fn with_column_expr(&self, name: &str, value: &Expr) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::with_column_expr";
        expr::check(value, &self.value_defs(), CALL)?;
        let data = expr::column_of(expr::evaluate(value, self), None);
        self.with_column(Column::from_data(name.to_string(), data, false))
            .map_err(|e| e.renamed(CALL))
    }
}

#[cfg(test)]
mod tests {
    use crate::{Column, TimeSeries, col};

    /// `find` / `some` / `every` look at stretches of 1,024 rows, then
    /// 2,048, … : a match in a later stretch must report its own row, the
    /// same as the closure version.
    #[test]
    fn stretches_find_rows_past_the_first() {
        let n = 200_000;
        let s = TimeSeries::new(
            "s",
            (0..n as i64).collect(),
            vec![Column::required(
                "v",
                (0..n).map(|i| i as f64).collect::<Vec<_>>(),
            )],
        )
        .unwrap();
        for at in [0, 1023, 1024, 1025, 3071, 3072, 3073, 70_000, n - 1, n] {
            let k = at as f64;
            let hit = col("v").eq(k);
            let by_fn = s
                .find(|r| Ok(r.number("v")? == Some(k)))
                .unwrap()
                .map(|r| r.index());
            let by_expr = s.find_expr(&hit).unwrap().map(|r| r.index());
            assert_eq!(by_expr, by_fn, "find at {at}");
            assert_eq!(by_expr, (at < n).then_some(at), "find at {at}");
            assert_eq!(s.some_expr(&hit).unwrap(), at < n, "some at {at}");
            assert_eq!(s.every_expr(&hit.not()).unwrap(), at >= n, "every at {at}");
        }
    }

    #[test]
    fn map_exprs_needs_a_column() {
        let s = TimeSeries::new("s", vec![0], vec![Column::required("v", vec![1.0])]).unwrap();
        assert!(s.map_exprs(&[]).is_err());
    }
}

/// The mask path of `filter_expr` (one-pass test, each column copied
/// straight from the mask) against what it replaced: the row-number path
/// and a row-by-row reading of the comparison.
#[cfg(test)]
mod filter_tests {
    use super::*;
    use crate::column::{ArrayColumn, BooleanColumn, DecimalColumn, Scalar, StringColumn};
    use crate::expr::{col, lit};
    use crate::row_filter::RowFilter;
    use crate::rows::FilterCopy;
    use crate::series::{IntervalKeys, Key, Labels, TimeRangeKeys};
    use arrow_array::DictionaryArray;
    use arrow_array::types::Int32Type;

    /// Numbers with gaps stored every way a gap can be (NaN, +inf, -inf),
    /// and the largest and smallest values that are not gaps.
    fn v(i: usize) -> f64 {
        match i % 11 {
            3 => f64::NAN,
            7 => f64::INFINITY,
            9 => f64::NEG_INFINITY,
            5 if i.is_multiple_of(4) => f64::MAX,
            5 if i % 4 == 1 => f64::MIN,
            _ => ((i * 37) % 23) as f64 - 5.0,
        }
    }

    fn columns(n: usize) -> Vec<Column> {
        let words = ["a", "bb", "a string longer than twelve bytes", ""];
        let dict: DictionaryArray<Int32Type> =
            (0..n).map(|i| (i % 5 != 2).then(|| words[i % 4])).collect();
        vec![
            Column::optional_raw("v", (0..n).map(v).collect()),
            Column::required("w", (0..n).map(|i| i as f64).collect::<Vec<f64>>()),
            Column::optional(
                "s",
                StringColumn::from_options((0..n).map(|i| (i % 6 != 1).then(|| words[i % 4]))),
            ),
            Column::from_data("d".into(), StringColumn::dictionary(dict).unwrap(), false),
            Column::optional(
                "b",
                BooleanColumn::from_options((0..n).map(|i| (i % 4 != 0).then_some(i % 3 == 0))),
            ),
            Column::optional(
                "m",
                DecimalColumn::from_options(
                    (0..n).map(|i| (i % 8 != 0).then_some(i as i128 * 125)),
                    2,
                )
                .unwrap(),
            ),
            Column::optional(
                "a",
                ArrayColumn::from_options(
                    (0..n).map(|i| (i % 3 != 0).then(|| vec![Scalar::Number(i as f64)])),
                ),
            ),
        ]
    }

    fn keys(n: usize) -> Vec<Key> {
        let t: Vec<i64> = (0..n as i64).map(|i| i * 10).collect();
        let shifted = |d: i64| t.iter().map(|x| x + d).collect::<Vec<_>>();
        vec![
            Key::Time(t.clone()),
            Key::TimeRange(TimeRangeKeys {
                begin: t.clone(),
                end: shifted(5),
            }),
            Key::Interval(IntervalKeys {
                label: Labels::Number(t.iter().map(|&x| x as f64).collect()),
                begin: t.clone(),
                end: shifted(10),
            }),
            Key::Interval(IntervalKeys {
                label: Labels::String(StringColumn::from_options(
                    t.iter().map(|x| Some(format!("k{x}"))),
                )),
                begin: t.clone(),
                end: shifted(10),
            }),
        ]
    }

    #[test]
    fn filter_rows_matches_take_rows() {
        // Lengths around the 64-row words of a mask, and masks with no rows,
        // every row, scattered rows and long runs.
        for n in [0, 1, 63, 64, 65, 130, 1000] {
            let masks: Vec<Vec<bool>> = vec![
                vec![false; n],
                vec![true; n],
                (0..n).map(|i| i % 3 == 1).collect(),
                (0..n).map(|i| (i * 7) % 5 < 2).collect(),
                (0..n).map(|i| (i / 50) % 2 == 0).collect(),
            ];
            for key in keys(n) {
                let s = TimeSeries::from_parts("s".into(), "time".into(), key, columns(n));
                for m in &masks {
                    let rows: Vec<usize> = (0..n).filter(|&i| m[i]).collect();
                    let keep: RowFilter = m.iter().copied().collect();
                    let want = s.take_rows(&rows);
                    // Each way of going about the copies gives the same
                    // series, columns in the same order.
                    for how in [FilterCopy::Direct, FilterCopy::Split, FilterCopy::Listed] {
                        let got = s.filter_rows_by(&keep, how);
                        assert_eq!(got, want, "n {n}, {} kept, {how:?}", rows.len());
                        assert!(got.column("d").unwrap().strings().unwrap().is_dictionary());
                        // A number column's note that it has no gap is what
                        // later steps go by: it must say what the values say.
                        for name in ["v", "w"] {
                            let c = got.column(name).unwrap().numbers().unwrap();
                            let finite = c.values().iter().all(|x| x.is_finite());
                            assert_eq!(c.all_finite(), finite, "n {n}, {name}, {how:?}");
                        }
                    }
                    // The way chosen for this series and mask, and `filter`
                    // with a closure.
                    assert_eq!(s.filter_rows(&keep), want, "n {n}, {} kept", rows.len());
                    let by_closure = s.filter(|r| Ok(m[r.index()])).unwrap();
                    assert_eq!(by_closure, want, "n {n}, {} kept, closure", rows.len());
                }
            }
        }
    }

    /// Through the public call, where the library chooses how to copy as it
    /// does for a caller: a filter that keeps enough rows to be copied on
    /// several cores (where there are several), and one over enough number
    /// columns to be copied by the list.
    #[test]
    fn a_long_filter_and_a_wide_one_match_the_row_by_row_copy() {
        let n = 400_000;
        let s = TimeSeries::new("s", (0..n as i64).collect(), columns(n)).unwrap();
        // Scattered rows, a little under half of them.
        let test = col("v").gt(4.0);
        let v = s.column("v").unwrap().numbers().unwrap();
        let rows: Vec<usize> = (0..n)
            .filter(|&i| v.get(i).is_some_and(|x| x > 4.0))
            .collect();
        let keep = expr::mask(&test, &s);
        assert_eq!(keep.count(), rows.len());
        let want = s.take_rows(&rows);
        // With more than one core this is the split copy.
        let cores = crate::par::threads();
        let how = s.filter_copy(&keep, cores);
        let expected = if cores > 1 {
            FilterCopy::Split
        } else {
            FilterCopy::Direct
        };
        assert_eq!(how, expected, "{} rows kept, {cores} cores", rows.len());
        assert_eq!(s.filter_expr(&test).unwrap(), want);
        for how in [FilterCopy::Direct, FilterCopy::Split, FilterCopy::Listed] {
            assert_eq!(s.filter_rows_by(&keep, how), want, "{how:?}");
        }

        // Fewer rows (too few kept to split) and six more number columns:
        // with `v`, `w` and the dictionary column that is eight to copy by
        // the list, on any number of cores.
        let n = 200_000;
        let mut wide = columns(n);
        wide.extend((0..6).map(|c| {
            let values = (0..n).map(|i| ((i * 31 + c) % 1000) as f64);
            Column::required(format!("x{c}"), values.collect::<Vec<f64>>())
        }));
        let s = TimeSeries::new("s", (0..n as i64).collect(), wide).unwrap();
        let v = s.column("v").unwrap().numbers().unwrap();
        let rows: Vec<usize> = (0..n)
            .filter(|&i| v.get(i).is_some_and(|x| x > 4.0))
            .collect();
        let keep = expr::mask(&test, &s);
        assert_eq!(keep.count(), rows.len());
        assert_eq!(s.filter_copy(&keep, cores), FilterCopy::Listed);
        assert_eq!(s.filter_expr(&test).unwrap(), s.take_rows(&rows));
    }

    /// A filter that keeps nothing, written either way: no rows, a
    /// dictionary column that is still a dictionary, and a series that
    /// still stacks with the one it came from.
    #[test]
    fn nothing_kept_gives_an_empty_series_that_still_stacks() {
        for n in [1, 64, 130] {
            for key in keys(n) {
                let s = TimeSeries::from_parts("s".into(), "time".into(), key, columns(n));
                let by_test = s.filter_expr(&col("w").lt(-1.0)).unwrap();
                let by_closure = s.filter(|_| Ok(false)).unwrap();
                for got in [&by_test, &by_closure] {
                    assert_eq!(got.len(), 0);
                    assert_eq!(got, &s.take_rows(&[]));
                    assert!(got.column("d").unwrap().strings().unwrap().is_dictionary());
                    assert_eq!(TimeSeries::concat(&[got, &s]).unwrap(), s);
                    assert_eq!(TimeSeries::concat(&[&s, got]).unwrap(), s);
                }
            }
        }
    }

    #[test]
    fn mask_matches_each_comparison_row_by_row() {
        let n = 200;
        let s = TimeSeries::new("s", (0..n as i64).collect(), columns(n)).unwrap();
        type Build = fn(Expr, Expr) -> Expr;
        type Holds = fn(f64, f64) -> bool;
        let ops: [(&str, Build, Holds); 6] = [
            ("gt", |a, b| a.gt(b), |x, k| x > k),
            ("ge", |a, b| a.ge(b), |x, k| x >= k),
            ("lt", |a, b| a.lt(b), |x, k| x < k),
            ("le", |a, b| a.le(b), |x, k| x <= k),
            ("eq", |a, b| a.eq(b), |x, k| x == k),
            ("ne", |a, b| a.ne(b), |x, k| x != k),
        ];
        for name in ["v", "w"] {
            let c = s.column(name).unwrap().numbers().unwrap();
            for k in [-1.0, 0.0, 5.0, 17.0, f64::MAX, f64::MIN] {
                for (op, build, holds) in ops {
                    // A gap fails every comparison but `ne`.
                    let want: Vec<bool> = (0..n)
                        .map(|i| c.get(i).map_or(op == "ne", |x| holds(x, k)))
                        .collect();
                    // `k op v` is `v op' k`, so its row-by-row answer is
                    // `holds(k, x)`.
                    let want_left: Vec<bool> = (0..n)
                        .map(|i| c.get(i).map_or(op == "ne", |x| holds(k, x)))
                        .collect();
                    let bits = |e: &Expr| -> Vec<bool> { expr::mask(e, &s).iter().collect() };
                    let generic = |e: &Expr| -> Vec<bool> {
                        let expr::Vals::Boolean(v) = expr::evaluate(e, &s) else {
                            unreachable!()
                        };
                        v.iter().map(|&x| x == 1).collect()
                    };
                    let right = build(col(name), lit(k));
                    let left = build(lit(k), col(name));
                    // Arithmetic first takes the evaluated path, with gaps as NaN.
                    let computed = build(col(name).add(0), lit(k));
                    let at = format!("{name} {op} {k}");
                    assert_eq!(bits(&right), want, "{at}");
                    assert_eq!(generic(&right), want, "{at}, evaluated");
                    assert_eq!(bits(&left), want_left, "{k} {op} {name}");
                    assert_eq!(generic(&left), want_left, "{k} {op} {name}, evaluated");
                    assert_eq!(bits(&computed), want, "{at}, after arithmetic");
                    // And through the public call: those rows of every
                    // column, as the row-by-row copy gives them.
                    let rows: Vec<usize> = (0..n).filter(|&i| want[i]).collect();
                    assert_eq!(s.filter_expr(&right).unwrap(), s.take_rows(&rows), "{at}");
                }
            }
            // A constant that is not finite cannot be applied through the
            // public calls (`check` refuses it), but the mask still answers
            // as the evaluated path does.
            for k in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
                for (op, build, _) in ops {
                    for e in [build(col(name), lit(k)), build(lit(k), col(name))] {
                        let expr::Vals::Boolean(want) = expr::evaluate(&e, &s) else {
                            unreachable!()
                        };
                        let want: Vec<bool> = want.iter().map(|&x| x == 1).collect();
                        let got: Vec<bool> = expr::mask(&e, &s).iter().collect();
                        assert_eq!(got, want, "{name} {op} {k}");
                    }
                }
            }
        }
    }
}
