//! Row-by-row operations: `diff`, `rate`, `pct_change`, `shift`,
//! `cumulative` and `fill`. Each reads one row against its neighbours in
//! storage order, as pond-ts does.
//!
//! On a series holding several entities (hosts, devices) the "previous row"
//! may belong to another entity; pond-ts scopes these per entity with
//! `partitionBy`, which pond-rs does not have yet.

use std::ops::Range;

use arrow_buffer::i256;

use crate::column::{
    ArrayColumn, BooleanColumn, Cell, ColumnData, DecimalColumn, Scalar, StringColumn, Value,
};
use crate::duration::parse_duration;
use crate::error::{PondError, Result};
use crate::reducer::Reducer;
use crate::series::{Column, TimeSeries};

/// Whether [`TimeSeries::diff`], [`TimeSeries::rate`] and
/// [`TimeSeries::pct_change`] keep the first row, which has no row before
/// it (pond-ts `{ drop }`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FirstRow {
    /// Keep it, with a gap in each changed column (pond-ts default).
    #[default]
    Keep,
    /// Remove it from the result (pond-ts `{ drop: true }`).
    Drop,
}

/// How [`TimeSeries::fill`] fills a run of gaps.
#[derive(Debug, Clone, PartialEq)]
pub enum Fill {
    /// The value before the run (forward fill). A run at the start stays.
    Hold,
    /// The value after the run (backward fill). A run at the end stays.
    Bfill,
    /// A straight line between the values on either side, by time. Number
    /// columns only; a run at either end stays.
    Linear,
    /// Zero. Number and decimal columns only.
    Zero,
    /// This value. Its kind must match the column's.
    Value(Value),
}

/// Caps on which runs of gaps [`TimeSeries::fill`] fills. A run that breaks
/// a cap is left entirely unfilled, never partly (pond-ts `{ limit, maxGap
/// }`).
///
/// ```
/// # use pond_rs::FillLimits;
/// let caps = FillLimits::none().limit(3).max_gap("5m");
/// ```
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FillLimits {
    limit: Option<usize>,
    max_gap: Option<String>,
}

impl FillLimits {
    /// No caps: every run that can be filled is.
    pub fn none() -> Self {
        Self::default()
    }

    /// Fill only runs of at most `rows` gaps.
    pub fn limit(mut self, rows: usize) -> Self {
        self.limit = Some(rows);
        self
    }

    /// Fill only runs spanning at most this duration (`"5m"`), measured
    /// from the value before the run to the value after it. A run at the
    /// start is measured from its first row to the value after; a run at
    /// the end from the value before to its last row (as pond-ts does).
    pub fn max_gap(mut self, duration: &str) -> Self {
        self.max_gap = Some(duration.to_string());
        self
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Delta {
    Diff,
    Rate,
    Pct,
}

impl Delta {
    fn call(self) -> &'static str {
        match self {
            Delta::Diff => "diff",
            Delta::Rate => "rate",
            Delta::Pct => "pct_change",
        }
    }
}

/// A number result, with non-finite values as gaps (`-0.0` kept).
fn finite_or_gap(v: f64) -> f64 {
    if v.is_finite() { v } else { f64::NAN }
}

impl TimeSeries {
    /// Each row's value minus the row before it, for each named column
    /// (pond-ts `diff`). The first row, and any row where it or the row
    /// before is a gap, gets a gap: the row before is the one directly
    /// above, not the last row with a value. Other columns pass through.
    ///
    /// Number columns give numbers. Decimal columns give exact decimals
    /// (precision 38; an error if a difference has more digits). Other
    /// kinds are an error. Changed columns may have gaps afterwards.
    ///
    /// ```
    /// # use pond_rs::{Column, FirstRow, TimeSeries};
    /// let s = TimeSeries::new("s", vec![0, 1000, 2000],
    ///     vec![Column::required("v", vec![1.0, 4.0, 3.0])])?;
    /// let d = s.diff(&["v"], FirstRow::Keep)?;
    /// let got: Vec<_> = d.column("v")?.numbers()?.iter().collect();
    /// assert_eq!(got, [None, Some(3.0), Some(-1.0)]);
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn diff(&self, columns: &[&str], first: FirstRow) -> Result<TimeSeries> {
        self.change(Delta::Diff, columns, first)
    }

    /// Each row's change from the row before, per second of key time:
    /// `(value - previous) / ((begin - previous begin) / 1000)` (pond-ts
    /// `rate`). Gaps as for [`TimeSeries::diff`]; two rows with the same
    /// begin give a gap. Range and interval keys use their begin. Number
    /// and decimal columns give numbers (decimals via the nearest `f64`).
    pub fn rate(&self, columns: &[&str], first: FirstRow) -> Result<TimeSeries> {
        self.change(Delta::Rate, columns, first)
    }

    /// Each row's change as a fraction of the row before:
    /// `(value - previous) / previous` (pond-ts `pctChange`; not multiplied
    /// by 100). Gaps as for [`TimeSeries::diff`]; a previous value of 0
    /// gives a gap. Number and decimal columns give numbers.
    pub fn pct_change(&self, columns: &[&str], first: FirstRow) -> Result<TimeSeries> {
        self.change(Delta::Pct, columns, first)
    }

    fn change(&self, change: Delta, columns: &[&str], first: FirstRow) -> Result<TimeSeries> {
        let call = change.call();
        let targets = self.targets(call, columns)?;
        let begin = self.key().begin();
        let n = self.len();
        // Seconds between each row and the one before, as pond-ts computes
        // them: one subtraction, one division.
        let seconds = |i: usize| (begin[i] - begin[i - 1]) as f64 / 1000.0;
        let floats = |values: &[f64]| -> Vec<f64> {
            let mut out = vec![f64::NAN; n];
            for i in 1..n {
                let (prev, cur) = (values[i - 1], values[i]);
                if !prev.is_finite() || !cur.is_finite() {
                    continue;
                }
                let delta = cur - prev;
                out[i] = finite_or_gap(match change {
                    Delta::Diff => delta,
                    Delta::Rate => {
                        let dt = seconds(i);
                        if dt == 0.0 { f64::NAN } else { delta / dt }
                    }
                    Delta::Pct => {
                        if prev == 0.0 {
                            f64::NAN
                        } else {
                            delta / prev
                        }
                    }
                });
            }
            out
        };
        let mut out = self.columns().to_vec();
        for &c in &targets {
            let column = &self.columns()[c];
            let data: ColumnData = match column.data() {
                ColumnData::Number(f) => floats(f.values()).into(),
                ColumnData::Decimal(d) if change == Delta::Diff => {
                    let mut values = vec![None; n];
                    for (i, slot) in values.iter_mut().enumerate().skip(1) {
                        if let (Some(prev), Some(cur)) = (d.get(i - 1), d.get(i)) {
                            *slot = Some(decimal_fit(
                                call,
                                column.name(),
                                i,
                                cur.value.checked_sub(prev.value),
                            )?);
                        }
                    }
                    d.rebuild(values, 38).into()
                }
                ColumnData::Decimal(d) => floats(&d.to_f64s()).into(),
                other => {
                    return Err(wrong_kind(
                        call,
                        column,
                        other,
                        "needs a number or decimal column",
                    ));
                }
            };
            out[c] = Column::from_data(column.name().to_string(), data, false);
        }
        let result = self.with_value_columns(out);
        Ok(match first {
            FirstRow::Drop if n > 0 => result.row_range(1..n),
            _ => result,
        })
    }

    /// Move each named column's values down `n` rows (a lag; `n` negative
    /// moves them up, a lead), leaving gaps in the rows moved away from
    /// (pond-ts `shift`). Keys and other columns stay put. Works on every
    /// column kind (pond-ts: numbers only); the columns may have gaps
    /// afterwards.
    pub fn shift(&self, columns: &[&str], n: i64) -> Result<TimeSeries> {
        let targets = self.targets("shift", columns)?;
        let len = self.len() as i64;
        let rows: Vec<Option<usize>> = (0..len)
            .map(|i| {
                let from = i.checked_sub(n)?;
                (0..len).contains(&from).then_some(from as usize)
            })
            .collect();
        let mut out = self.columns().to_vec();
        for &c in &targets {
            let column = &self.columns()[c];
            out[c] = Column::from_data(column.name().to_string(), column.data().take(&rows), false);
        }
        Ok(self.with_value_columns(out))
    }

    /// Running totals down each named column (pond-ts `cumulative`):
    /// `Reducer::Sum`, `Max`, `Min` or `Count` (of rows with a value). A gap
    /// keeps the running value; rows before the first value are gaps.
    /// `sum` adds left to right from `+0.0`; once it overflows, the rest of
    /// the column is gaps. Number columns give numbers; decimal columns give
    /// exact decimals (`count` gives numbers; `sum` at precision 38, an
    /// error past it). Other kinds, or other reducers, are an error.
    ///
    /// ```
    /// # use pond_rs::{Column, Reducer, TimeSeries};
    /// let s = TimeSeries::new("s", vec![0, 1000, 2000],
    ///     vec![Column::optional("v", vec![Some(1.0), None, Some(2.0)])])?;
    /// let c = s.cumulative(&[("v", Reducer::Sum)])?;
    /// let got: Vec<_> = c.column("v")?.numbers()?.iter().collect();
    /// assert_eq!(got, [Some(1.0), Some(1.0), Some(3.0)]);
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn cumulative(&self, spec: &[(&str, Reducer)]) -> Result<TimeSeries> {
        const CALL: &str = "cumulative";
        let names: Vec<&str> = spec.iter().map(|&(name, _)| name).collect();
        let targets = self.targets(CALL, &names)?;
        let mut out = self.columns().to_vec();
        for (i, (&c, &(name, reducer))) in targets.iter().zip(spec).enumerate() {
            named_once(CALL, names[..i].iter().copied(), name)?;
            if !matches!(
                reducer,
                Reducer::Sum | Reducer::Max | Reducer::Min | Reducer::Count
            ) {
                return Err(PondError::InvalidData {
                    call: CALL,
                    message: format!(
                        "column '{name}': cumulative takes sum, max, min or count, not {reducer:?}"
                    ),
                });
            }
            let column = &self.columns()[c];
            let data: ColumnData = match column.data() {
                ColumnData::Number(f) => running(f.values(), reducer).into(),
                ColumnData::Decimal(d) if reducer == Reducer::Count => {
                    running(&d.to_f64s(), reducer).into()
                }
                ColumnData::Decimal(d) => running_decimal(column.name(), d, reducer)?.into(),
                other => {
                    return Err(wrong_kind(
                        CALL,
                        column,
                        other,
                        "needs a number or decimal column",
                    ));
                }
            };
            out[c] = Column::from_data(column.name().to_string(), data, false);
        }
        Ok(self.with_value_columns(out))
    }

    /// A running fold of your own down one number column (pond-ts
    /// `cumulative({ col: (acc, v) => … })`): the first value starts the
    /// running value as it is, then each later value `v` makes it
    /// `f(acc, v)`. Gaps keep the running value; rows before the first
    /// value are gaps, and a non-finite running value is written as a gap
    /// (but still passed to `f` next).
    ///
    /// ```
    /// # use pond_rs::{Column, TimeSeries};
    /// let s = TimeSeries::new("s", vec![0, 1, 2],
    ///     vec![Column::required("v", vec![2.0, 3.0, 4.0])])?;
    /// let product = s.cumulative_with("v", |acc, v| acc * v)?;
    /// assert_eq!(product.column("v")?.numbers()?.get(2), Some(24.0));
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn cumulative_with(
        &self,
        column: &str,
        mut f: impl FnMut(f64, f64) -> f64,
    ) -> Result<TimeSeries> {
        const CALL: &str = "cumulative_with";
        let c = self.column_index(CALL, column)?;
        let source = &self.columns()[c];
        let values = match source.data() {
            ColumnData::Number(v) => v.values(),
            other => return Err(wrong_kind(CALL, source, other, "needs a number column")),
        };
        let mut acc: Option<f64> = None;
        let folded: Vec<f64> = values
            .iter()
            .map(|&v| {
                if v.is_finite() {
                    acc = Some(acc.map_or(v, |a| f(a, v)));
                }
                acc.map_or(f64::NAN, finite_or_gap)
            })
            .collect();
        let mut out = self.columns().to_vec();
        out[c] = Column::from_data(source.name().to_string(), ColumnData::from(folded), false);
        Ok(self.with_value_columns(out))
    }

    /// Fill runs of gaps in the named columns (pond-ts `fill({ col:
    /// strategy })`). Other columns are left as they are, and each column
    /// keeps its kind and its required flag.
    ///
    /// A run that a strategy cannot fill (nothing before it for `Hold`,
    /// nothing after for `Bfill`, either for `Linear`) or that breaks a cap
    /// in `limits` stays entirely unfilled. `Linear` interpolates by begin
    /// time: `before + (after - before) * ((t - t_before) / (t_after -
    /// t_before))`, or `before` when the two times are equal.
    ///
    /// Errors, where pond-ts is silent or errs only on some data: an
    /// unknown column, `Linear` on a column that is not numbers, `Zero` on
    /// one that is not numbers or decimals, and a `Value` of the wrong
    /// kind (or a decimal of another scale).
    ///
    /// ```
    /// # use pond_rs::{Column, Fill, FillLimits, TimeSeries};
    /// let s = TimeSeries::new("s", vec![0, 1000, 2000],
    ///     vec![Column::optional("v", vec![Some(1.0), None, Some(3.0)])])?;
    /// let f = s.fill(&[("v", Fill::Linear)], &FillLimits::none())?;
    /// assert_eq!(f.column("v")?.numbers()?.get(1), Some(2.0));
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn fill(&self, spec: &[(&str, Fill)], limits: &FillLimits) -> Result<TimeSeries> {
        let mut plan = Vec::with_capacity(spec.len());
        for (i, (name, fill)) in spec.iter().enumerate() {
            let c = self.column_index("fill", name)?;
            named_once("fill", spec[..i].iter().map(|(n, _)| *n), name)?;
            check_fill(&self.columns()[c], fill)?;
            plan.push((c, fill));
        }
        self.fill_plan(&plan, limits)
    }

    /// Fill runs of gaps in every value column with one strategy (pond-ts
    /// `fill('hold')`). As in pond-ts, `Linear` skips columns that are not
    /// numbers and `Zero` skips columns that are not numbers or decimals.
    /// A `Value` is an error here; give values per column with
    /// [`TimeSeries::fill`].
    pub fn fill_all(&self, fill: Fill, limits: &FillLimits) -> Result<TimeSeries> {
        if let Fill::Value(_) = fill {
            return Err(PondError::InvalidData {
                call: "fill_all",
                message: "takes Hold, Bfill, Linear or Zero; give a value per column with fill"
                    .into(),
            });
        }
        let plan: Vec<(usize, &Fill)> = (0..self.columns().len())
            .filter(|&c| check_fill(&self.columns()[c], &fill).is_ok())
            .map(|c| (c, &fill))
            .collect();
        self.fill_plan(&plan, limits)
    }

    fn fill_plan(&self, plan: &[(usize, &Fill)], limits: &FillLimits) -> Result<TimeSeries> {
        let max_gap = limits.max_gap.as_deref().map(parse_duration).transpose()?;
        let times = self.key().begin();
        let mut out = self.columns().to_vec();
        for &(c, fill) in plan {
            let column = &self.columns()[c];
            let data = column.data();
            let n = data.len();
            let runs: Vec<Range<usize>> = gap_runs(n, |i| data.is_present(i))
                .filter(|run| fillable(run, n, fill, limits.limit, max_gap, times))
                .collect();
            if runs.is_empty() {
                continue;
            }
            let filled: ColumnData = match data {
                ColumnData::Number(f) => {
                    let mut v = f.values().to_vec();
                    for run in &runs {
                        for j in run.clone() {
                            v[j] = match fill {
                                Fill::Hold => v[run.start - 1],
                                Fill::Bfill => v[run.end],
                                Fill::Zero => 0.0,
                                Fill::Value(Value::Number(x)) => *x,
                                Fill::Linear => {
                                    let (t0, t1) = (times[run.start - 1], times[run.end]);
                                    let (before, after) = (v[run.start - 1], v[run.end]);
                                    let span = (t1 - t0) as f64;
                                    if span == 0.0 {
                                        before
                                    } else {
                                        before + (after - before) * ((times[j] - t0) as f64 / span)
                                    }
                                }
                                _ => unreachable!("checked by check_fill"),
                            };
                        }
                    }
                    ColumnData::from(v)
                }
                ColumnData::Decimal(d) => {
                    let mut v: Vec<Option<i128>> = d.iter().map(|x| x.map(|x| x.value)).collect();
                    for run in &runs {
                        let value = match fill {
                            Fill::Hold => v[run.start - 1],
                            Fill::Bfill => v[run.end],
                            Fill::Zero => Some(0),
                            Fill::Value(Value::Decimal(x)) => Some(x.value),
                            _ => unreachable!("checked by check_fill"),
                        };
                        v[run.clone()].fill(value);
                    }
                    d.rebuild(v, d.precision()).into()
                }
                ColumnData::String(s) => {
                    let mut v: Vec<Option<&str>> = s.iter().collect();
                    for run in &runs {
                        let value = match fill {
                            Fill::Hold => v[run.start - 1],
                            Fill::Bfill => v[run.end],
                            Fill::Value(Value::String(x)) => Some(x.as_str()),
                            _ => unreachable!("checked by check_fill"),
                        };
                        v[run.clone()].fill(value);
                    }
                    StringColumn::from_options(v).into()
                }
                ColumnData::Boolean(b) => {
                    let mut v: Vec<Option<bool>> = b.iter().collect();
                    for run in &runs {
                        let value = match fill {
                            Fill::Hold => v[run.start - 1],
                            Fill::Bfill => v[run.end],
                            Fill::Value(Value::Boolean(x)) => Some(*x),
                            _ => unreachable!("checked by check_fill"),
                        };
                        v[run.clone()].fill(value);
                    }
                    BooleanColumn::from_options(v).into()
                }
                ColumnData::Array(a) => {
                    let mut v: Vec<Option<Cell>> = (0..n).map(|i| a.cell(i).cloned()).collect();
                    for run in &runs {
                        let value = match fill {
                            Fill::Hold => v[run.start - 1].clone(),
                            Fill::Bfill => v[run.end].clone(),
                            Fill::Value(Value::Array(x)) => Some(Cell::from(x.as_slice())),
                            _ => unreachable!("checked by check_fill"),
                        };
                        v[run.clone()].fill(value);
                    }
                    ArrayColumn::from_cells(v).into()
                }
            };
            out[c] = Column::from_data(column.name().to_string(), filled, column.is_required());
        }
        Ok(self.with_value_columns(out))
    }

    /// The value columns named, as indexes; an error for none or an unknown
    /// name.
    fn targets(&self, call: &'static str, names: &[&str]) -> Result<Vec<usize>> {
        if names.is_empty() {
            return Err(PondError::InvalidData {
                call,
                message: "needs at least one column".into(),
            });
        }
        names
            .iter()
            .map(|name| self.column_index(call, name))
            .collect()
    }

    /// This series with its value columns replaced.
    pub(crate) fn with_value_columns(&self, columns: Vec<Column>) -> TimeSeries {
        TimeSeries::from_parts(
            self.name().to_string(),
            self.key_name().to_string(),
            self.shared_key(),
            columns,
        )
    }

    /// The rows in `range`, key and columns together. Value columns share
    /// their buffers with this series; the key is copied.
    pub(crate) fn row_range(&self, range: Range<usize>) -> TimeSeries {
        let columns = self
            .columns()
            .iter()
            .map(|c| {
                Column::from_data(
                    c.name().to_string(),
                    c.data().slice(range.clone()),
                    c.is_required(),
                )
            })
            .collect();
        TimeSeries::from_parts(
            self.name().to_string(),
            self.key_name().to_string(),
            self.key().rows(range),
            columns,
        )
    }
}

/// An error if `name` is among the earlier entries of a spec.
fn named_once<'a>(
    call: &'static str,
    mut earlier: impl Iterator<Item = &'a str>,
    name: &str,
) -> Result<()> {
    if earlier.any(|e| e == name) {
        return Err(PondError::InvalidData {
            call,
            message: format!("column '{name}' is named twice"),
        });
    }
    Ok(())
}

fn wrong_kind(call: &'static str, column: &Column, data: &ColumnData, reason: &str) -> PondError {
    PondError::WrongKind {
        call,
        column: column.name().to_string(),
        kind: data.kind().as_str(),
        reason: reason.to_string(),
    }
}

/// A decimal result as a 38-digit raw value, or an error naming the row.
fn decimal_fit(call: &'static str, column: &str, row: usize, value: Option<i128>) -> Result<i128> {
    const MAX: u128 = 10u128.pow(38) - 1;
    value
        .filter(|v| v.unsigned_abs() <= MAX)
        .ok_or_else(|| PondError::InvalidData {
            call,
            message: format!("decimal result in '{column}' at row {row} has more than 38 digits"),
        })
}

/// pond-ts's running sum / max / min / count over `f64` values.
fn running(values: &[f64], reducer: Reducer) -> Vec<f64> {
    let mut acc = 0.0f64;
    let mut seen = false;
    values
        .iter()
        .map(|&v| {
            if v.is_finite() {
                acc = match reducer {
                    Reducer::Sum => acc + v,
                    Reducer::Count => acc + 1.0,
                    // Strict comparisons: on a tie the earlier value stays.
                    Reducer::Max => {
                        if !seen || v > acc {
                            v
                        } else {
                            acc
                        }
                    }
                    Reducer::Min => {
                        if !seen || v < acc {
                            v
                        } else {
                            acc
                        }
                    }
                    _ => unreachable!("checked by cumulative"),
                };
                seen = true;
            }
            if seen { finite_or_gap(acc) } else { f64::NAN }
        })
        .collect()
}

/// Exact running sum / max / min of a decimal column.
fn running_decimal(name: &str, d: &DecimalColumn, reducer: Reducer) -> Result<DecimalColumn> {
    let mut sum = i256::ZERO;
    let mut best: Option<i128> = None;
    let mut values = Vec::with_capacity(d.len());
    for (row, v) in d.iter().enumerate() {
        if let Some(v) = v {
            match reducer {
                Reducer::Sum => {
                    sum = sum.wrapping_add(i256::from_i128(v.value));
                    best = Some(decimal_fit("cumulative", name, row, sum.to_i128())?);
                }
                Reducer::Max => best = Some(best.map_or(v.value, |b| b.max(v.value))),
                Reducer::Min => best = Some(best.map_or(v.value, |b| b.min(v.value))),
                _ => unreachable!("checked by cumulative"),
            }
        }
        values.push(best);
    }
    let precision = if reducer == Reducer::Sum {
        38
    } else {
        d.precision()
    };
    Ok(d.rebuild(values, precision))
}

/// The maximal runs of rows where `present` is false.
fn gap_runs(n: usize, present: impl Fn(usize) -> bool) -> impl Iterator<Item = Range<usize>> {
    let mut i = 0;
    std::iter::from_fn(move || {
        while i < n && present(i) {
            i += 1;
        }
        if i == n {
            return None;
        }
        let start = i;
        while i < n && !present(i) {
            i += 1;
        }
        Some(start..i)
    })
}

/// pond-ts's checks for one run, in its order: the strategy's neighbours,
/// then `limit`, then `max_gap`.
fn fillable(
    run: &Range<usize>,
    n: usize,
    fill: &Fill,
    limit: Option<usize>,
    max_gap: Option<i64>,
    times: &[i64],
) -> bool {
    let (has_prev, has_next) = (run.start > 0, run.end < n);
    let neighbours = match fill {
        Fill::Linear => has_prev && has_next,
        Fill::Hold => has_prev,
        Fill::Bfill => has_next,
        Fill::Zero | Fill::Value(_) => true,
    };
    if !neighbours || limit.is_some_and(|l| run.len() > l) {
        return false;
    }
    let Some(max_gap) = max_gap else {
        return true;
    };
    let span = match (has_prev, has_next) {
        (true, true) => times[run.end] - times[run.start - 1],
        (true, false) => times[run.end - 1] - times[run.start - 1],
        (false, true) => times[run.end] - times[run.start],
        (false, false) => 0,
    };
    span <= max_gap
}

/// Whether `fill` can apply to this column's kind.
fn check_fill(column: &Column, fill: &Fill) -> Result<()> {
    let data = column.data();
    let ok = match (fill, data) {
        (Fill::Hold | Fill::Bfill, _) => true,
        (Fill::Linear, ColumnData::Number(_)) => true,
        (Fill::Zero, ColumnData::Number(_) | ColumnData::Decimal(_)) => true,
        (Fill::Value(Value::Number(_)), ColumnData::Number(_)) => true,
        (Fill::Value(Value::Decimal(x)), ColumnData::Decimal(d)) => {
            if x.scale != d.scale() {
                return Err(PondError::InvalidData {
                    call: "fill",
                    message: format!(
                        "column '{}' has scale {}, but the fill value {x} has scale {}",
                        column.name(),
                        d.scale(),
                        x.scale
                    ),
                });
            }
            let max = 10u128.pow(u32::from(d.precision())) - 1;
            if x.value.unsigned_abs() > max {
                return Err(PondError::InvalidData {
                    call: "fill",
                    message: format!(
                        "fill value {x} for column '{}' has more than its {} digits",
                        column.name(),
                        d.precision()
                    ),
                });
            }
            true
        }
        (Fill::Value(Value::String(_)), ColumnData::String(_)) => true,
        (Fill::Value(Value::Boolean(_)), ColumnData::Boolean(_)) => true,
        (Fill::Value(Value::Array(x)), ColumnData::Array(_)) => {
            if let Some(e) = x
                .iter()
                .position(|e| matches!(e, Scalar::Number(v) if !v.is_finite()))
            {
                return Err(PondError::InvalidData {
                    call: "fill",
                    message: format!(
                        "fill value for column '{}': array element {e} must be a finite number, string, or boolean",
                        column.name()
                    ),
                });
            }
            true
        }
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(wrong_kind(
            "fill",
            column,
            data,
            &format!(
                "{fill:?} does not apply to a {} column",
                data.kind().as_str()
            ),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Decimal, IntervalKeys, Labels, Sequence};

    fn decimals(values: Vec<Option<i128>>) -> TimeSeries {
        let times = (0..values.len() as i64).map(|i| i * 1000).collect();
        TimeSeries::new(
            "s",
            times,
            vec![
                Column::optional("d", DecimalColumn::from_options(values, 2).unwrap()),
                Column::optional("host", [Some("a"), None, Some("c"), None]),
                Column::optional("up", [None, Some(true), None, Some(false)]),
            ],
        )
        .unwrap()
    }

    fn text(s: &TimeSeries, name: &str) -> Vec<Option<String>> {
        let c = s.column(name).unwrap();
        match c.data() {
            ColumnData::Decimal(d) => d.iter().map(|v| v.map(|v| v.to_string())).collect(),
            ColumnData::String(t) => t.iter().map(|v| v.map(str::to_string)).collect(),
            ColumnData::Boolean(b) => b.iter().map(|v| v.map(|v| v.to_string())).collect(),
            ColumnData::Number(f) => f.iter().map(|v| v.map(|v| v.to_string())).collect(),
            ColumnData::Array(a) => a.iter().map(|v| v.map(|v| format!("{v:?}"))).collect(),
        }
    }

    fn strs(v: &[Option<&str>]) -> Vec<Option<String>> {
        v.iter().map(|s| s.map(str::to_string)).collect()
    }

    #[test]
    fn decimal_diff_and_cumulative_are_exact() {
        // 0.10, 0.30, gap, 0.20
        let s = decimals(vec![Some(10), Some(30), None, Some(20)]);
        let d = s.diff(&["d"], FirstRow::Keep).unwrap();
        assert_eq!(text(&d, "d"), strs(&[None, Some("0.20"), None, None]));
        let c = s.cumulative(&[("d", Reducer::Sum)]).unwrap();
        assert_eq!(
            text(&c, "d"),
            strs(&[Some("0.10"), Some("0.40"), Some("0.40"), Some("0.60")])
        );
        let c = s.cumulative(&[("d", Reducer::Max)]).unwrap();
        assert_eq!(
            text(&c, "d"),
            strs(&[Some("0.10"), Some("0.30"), Some("0.30"), Some("0.30")])
        );
        let c = s.cumulative(&[("d", Reducer::Count)]).unwrap();
        assert_eq!(
            text(&c, "d"),
            strs(&[Some("1"), Some("2"), Some("2"), Some("3")])
        );
        // rate and pct_change give numbers, via f64, so the same bits as a
        // number column of 0.1 and 0.3 (not exactly 2).
        let r = s.pct_change(&["d"], FirstRow::Keep).unwrap();
        let got = r.column("d").unwrap().numbers().unwrap().get(1).unwrap();
        assert_eq!(got.to_bits(), ((0.3f64 - 0.1) / 0.1).to_bits());
    }

    #[test]
    fn decimal_results_past_38_digits_are_errors() {
        let max = 10i128.pow(38) - 1;
        let s = decimals(vec![Some(max), Some(-max), Some(1), Some(1)]);
        let e = s.diff(&["d"], FirstRow::Keep).unwrap_err().to_string();
        assert!(e.contains("'d' at row 1 has more than 38 digits"), "{e}");
        let s = decimals(vec![Some(max), Some(1), None, None]);
        let e = s
            .cumulative(&[("d", Reducer::Sum)])
            .unwrap_err()
            .to_string();
        assert!(e.contains("at row 1"), "{e}");
    }

    #[test]
    fn shift_and_fill_work_on_every_kind() {
        let s = decimals(vec![Some(10), None, Some(20), None]);
        let sh = s.shift(&["d", "host", "up"], 1).unwrap();
        assert_eq!(
            text(&sh, "d"),
            strs(&[None, Some("0.10"), None, Some("0.20")])
        );
        assert_eq!(text(&sh, "host"), strs(&[None, Some("a"), None, Some("c")]));
        assert_eq!(text(&sh, "up"), strs(&[None, None, Some("true"), None]));
        let lead = s.shift(&["host"], -3).unwrap();
        assert_eq!(text(&lead, "host"), strs(&[None, None, None, None]));

        let f = s
            .fill(
                &[
                    (
                        "d",
                        Fill::Value(Value::Decimal(Decimal {
                            value: -5,
                            scale: 2,
                        })),
                    ),
                    ("host", Fill::Hold),
                    ("up", Fill::Bfill),
                ],
                &FillLimits::none(),
            )
            .unwrap();
        assert_eq!(
            text(&f, "d"),
            strs(&[Some("0.10"), Some("-0.05"), Some("0.20"), Some("-0.05")])
        );
        assert_eq!(
            text(&f, "host"),
            strs(&[Some("a"), Some("a"), Some("c"), Some("c")])
        );
        assert_eq!(
            text(&f, "up"),
            strs(&[Some("true"), Some("true"), Some("false"), Some("false")])
        );

        // fill_all: Zero fills decimals and skips text and true/false.
        let z = s.fill_all(Fill::Zero, &FillLimits::none()).unwrap();
        assert_eq!(
            text(&z, "d"),
            strs(&[Some("0.10"), Some("0.00"), Some("0.20"), Some("0.00")])
        );
        assert_eq!(text(&z, "host"), text(&s, "host"));
    }

    #[test]
    fn fill_refuses_what_cannot_apply() {
        let s = decimals(vec![Some(10), None, Some(20), None]);
        let none = FillLimits::none();
        for (name, fill, want) in [
            ("nope", Fill::Hold, "no column named 'nope'"),
            (
                "d",
                Fill::Linear,
                "Linear does not apply to a decimal column",
            ),
            ("host", Fill::Zero, "Zero does not apply to a string column"),
            (
                "up",
                Fill::Value(Value::Number(1.0)),
                "does not apply to a boolean",
            ),
            (
                "d",
                Fill::Value(Value::Decimal(Decimal { value: 1, scale: 3 })),
                "scale 2",
            ),
        ] {
            let e = s.fill(&[(name, fill)], &none).unwrap_err().to_string();
            assert!(e.contains(want), "{e}");
        }
        let twice = [("host", Fill::Hold), ("host", Fill::Bfill)];
        let e = s.fill(&twice, &none).unwrap_err().to_string();
        assert!(e.contains("'host' is named twice"), "{e}");
        let e = s
            .fill_all(Fill::Value(Value::Boolean(true)), &none)
            .unwrap_err();
        assert!(e.to_string().contains("per column"), "{e}");
        let e = s
            .fill_all(Fill::Hold, &FillLimits::none().max_gap("2 s"))
            .unwrap_err();
        assert!(matches!(e, PondError::InvalidDuration { .. }), "{e}");
    }

    #[test]
    fn other_errors_name_the_problem() {
        let s = decimals(vec![Some(1), Some(2), Some(3), Some(4)]);
        let e = s.diff(&[], FirstRow::Keep).unwrap_err().to_string();
        assert!(e.contains("diff: needs at least one column"), "{e}");
        let e = s.rate(&["host"], FirstRow::Keep).unwrap_err().to_string();
        assert!(
            e.contains("'host'") && e.contains("number or decimal"),
            "{e}"
        );
        let e = s.shift(&["time"], 1).unwrap_err().to_string();
        assert!(e.contains("no column named 'time'"), "{e}");
        let e = s
            .cumulative(&[("d", Reducer::Avg)])
            .unwrap_err()
            .to_string();
        assert!(e.contains("sum, max, min or count"), "{e}");
        let e = s
            .cumulative(&[("d", Reducer::Sum), ("d", Reducer::Max)])
            .unwrap_err()
            .to_string();
        assert!(e.contains("'d' is named twice"), "{e}");
        let e = s
            .cumulative_with("host", |a, b| a + b)
            .unwrap_err()
            .to_string();
        assert!(e.contains("needs a number column"), "{e}");
    }

    #[test]
    fn cumulative_with_folds_from_the_first_value() {
        let s = TimeSeries::new(
            "s",
            vec![0, 1, 2, 3],
            vec![Column::optional(
                "v",
                vec![None, Some(2.0), None, Some(5.0)],
            )],
        )
        .unwrap();
        let mut calls = 0;
        let r = s
            .cumulative_with("v", |a, b| {
                calls += 1;
                a * 10.0 + b
            })
            .unwrap();
        assert_eq!(calls, 1);
        let got: Vec<_> = r.column("v").unwrap().numbers().unwrap().iter().collect();
        assert_eq!(got, [None, Some(2.0), Some(2.0), Some(25.0)]);
        // A non-finite running value is a gap but still carried.
        let r = s.cumulative_with("v", |_, _| f64::INFINITY).unwrap();
        assert_eq!(r.column("v").unwrap().numbers().unwrap().get(3), None);
    }

    #[test]
    fn drop_keeps_interval_labels_in_step() {
        let keys = IntervalKeys {
            label: Labels::from(vec!["mon", "tue", "wed"]),
            begin: vec![0, 10, 20],
            end: vec![10, 20, 30],
        };
        let s =
            TimeSeries::from_intervals("i", keys, vec![Column::required("v", vec![1.0, 2.0, 4.0])])
                .unwrap();
        let d = s.diff(&["v"], FirstRow::Drop).unwrap();
        let crate::Key::Interval(k) = d.key() else {
            panic!()
        };
        let labels: Vec<_> = k.label.strings().unwrap().iter().collect();
        assert_eq!(labels, [Some("tue"), Some("wed")]);
        assert_eq!(k.begin, [10, 20]);
        let got: Vec<_> = d.column("v").unwrap().numbers().unwrap().iter().collect();
        assert_eq!(got, [Some(1.0), Some(2.0)]);
        // Number labels too, and an empty series drops nothing.
        let empty = s.row_range(0..0);
        assert_eq!(empty.diff(&["v"], FirstRow::Drop).unwrap().len(), 0);
        let agg = TimeSeries::new(
            "t",
            vec![0, 1000],
            vec![Column::required("v", vec![1.0, 2.0])],
        )
        .unwrap()
        .aggregate(
            &Sequence::every("1s").unwrap(),
            &[crate::Agg::of("v", Reducer::Sum)],
        )
        .unwrap();
        let d = agg.rate(&["v"], FirstRow::Drop).unwrap();
        let crate::Key::Interval(k) = d.key() else {
            panic!()
        };
        assert_eq!(k.label.numbers().unwrap(), [1000.0]);
        assert_eq!(d.column("v").unwrap().numbers().unwrap().get(0), Some(1.0));
    }

    #[test]
    fn a_fill_value_must_fit_the_column_precision() {
        // A Decimal128(5, 2) column, as read from a file: 999.99 at most.
        let narrow =
            DecimalColumn::with_type(vec![Some(1i128), None].into_iter().collect(), 5, 2).unwrap();
        let s = TimeSeries::new("s", vec![0, 1], vec![Column::optional("d", narrow)]).unwrap();
        let big = Fill::Value(Value::Decimal(Decimal {
            value: 123_456_789,
            scale: 2,
        }));
        let e = s
            .fill(&[("d", big)], &FillLimits::none())
            .unwrap_err()
            .to_string();
        assert!(e.contains("more than its 5 digits"), "{e}");
        let ok = Fill::Value(Value::Decimal(Decimal {
            value: 99_999,
            scale: 2,
        }));
        let f = s.fill(&[("d", ok)], &FillLimits::none()).unwrap();
        let mut bytes = Vec::new();
        f.write_ipc(&mut bytes).unwrap();
        assert!(TimeSeries::from_ipc_bytes("s", bytes, "time").is_ok());
    }

    #[test]
    fn sliced_rows_share_buffers_and_behave_like_copies() {
        use arrow_array::{DictionaryArray, types::Int32Type};
        let words: DictionaryArray<Int32Type> = vec![Some("x"), None, Some("y"), Some("x"), None]
            .into_iter()
            .collect();
        let s = TimeSeries::new(
            "s",
            vec![0, 1000, 2000, 3000, 4000],
            vec![
                Column::optional("n", vec![Some(1.0), None, Some(3.0), Some(4.0), None]),
                Column::optional(
                    "d",
                    DecimalColumn::from_options([Some(1), Some(2), None, Some(4), Some(5)], 1)
                        .unwrap(),
                ),
                Column::optional("t", StringColumn::dictionary(words).unwrap()),
                Column::optional("u", [Some("a"), Some("b"), None, Some("d"), Some("e")]),
                Column::optional("b", [Some(true), None, Some(false), Some(true), None]),
            ],
        )
        .unwrap();
        let cut = s.row_range(1..4);
        // The same as copying rows 1..4 one by one.
        let rows: Vec<Option<usize>> = (1..4).map(Some).collect();
        for (sliced, full) in cut.columns().iter().zip(s.columns()) {
            assert_eq!(sliced.data(), &full.data().take(&rows), "{}", sliced.name());
        }
        assert!(cut.column("t").unwrap().strings().unwrap().is_dictionary());
        // Survives Arrow out and back, and feeds aggregate.
        let mut bytes = Vec::new();
        cut.write_ipc(&mut bytes).unwrap();
        let back = TimeSeries::from_ipc_bytes("s", bytes, "time").unwrap();
        assert_eq!(back.columns(), cut.columns());
        let aggs = [
            crate::Agg::new("n", "n", Reducer::Sum),
            crate::Agg::new("d", "d", Reducer::Sum),
            crate::Agg::new("dmax", "d", Reducer::Max),
            crate::Agg::new("t", "t", Reducer::Last),
            crate::Agg::new("b", "b", Reducer::First),
        ];
        let m = cut
            .aggregate(&Sequence::every("1m").unwrap(), &aggs)
            .unwrap();
        assert_eq!(m.column("n").unwrap().numbers().unwrap().get(0), Some(7.0));
        assert_eq!(text(&m, "d"), strs(&[Some("0.6")]));
        assert_eq!(text(&m, "dmax"), strs(&[Some("0.4")]));
        assert_eq!(text(&m, "t"), strs(&[Some("x")]));
        assert_eq!(text(&m, "b"), strs(&[Some("false")]));
    }

    #[test]
    fn number_columns_with_gaps_compare_equal() {
        let a = Column::optional("v", vec![Some(1.0), None]);
        assert_eq!(a, a.clone());
        // A gap stored as an infinity equals one stored as NaN.
        assert_eq!(a, Column::optional_raw("v", vec![1.0, f64::INFINITY]));
        assert_ne!(
            Column::required("v", vec![0.0]),
            Column::required("v", vec![-0.0])
        );
    }
}
