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
        let kept = expr::kept_rows(&expr::evaluate(test, self));
        if kept.len() == self.len() {
            return Ok(self.clone());
        }
        Ok(self.take_rows(&kept))
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
            vec![Column::required("v", (0..n).map(|i| i as f64).collect::<Vec<_>>())],
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
