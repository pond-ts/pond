//! `TimeSeries::rolling`: a trailing time window ending at each row.
//!
//! The window states are ports of pond-ts's `rollingState`s (add a value as
//! it enters the window, remove it as it leaves), so results match pond-ts
//! bit for bit, including where pond-ts's running sums have built up rounding
//! error ([PND-ROLLSTD]).

use std::collections::VecDeque;

use crate::duration::parse_duration;
use crate::error::{PondError, Result};
use crate::reducer::{Agg, Reducer, percentile_of_sorted};
use crate::series::{Column, TimeSeries};

const CALL: &str = "rolling";

/// pond-ts `SUM_SPLIT`: from this magnitude pond-ts moves a value into an
/// exact big-integer lane so a running sum cannot get stuck at infinity.
/// pond-rs does not have that lane yet and refuses such values instead.
const SUM_SPLIT: f64 = pow2(960);
/// pond-ts `STDEV_SPLIT`, the same idea for stdev.
const STDEV_SPLIT: f64 = pow2(480);

/// `2^e` exactly, for normal exponents.
const fn pow2(e: u64) -> f64 {
    f64::from_bits((e + 1023) << 52)
}

/// One column's window state: a value enters with `add`, leaves with
/// `remove`; `snapshot` is the reducer over what is inside. Only present
/// (finite) values reach a state.
trait WindowState {
    fn add(&mut self, row: usize, v: f64);
    fn remove(&mut self, row: usize, v: f64);
    fn snapshot(&self) -> Option<f64>;
}

#[derive(Default)]
struct CountState(i64);

impl WindowState for CountState {
    fn add(&mut self, _: usize, _: f64) {
        self.0 += 1;
    }
    fn remove(&mut self, _: usize, _: f64) {
        self.0 -= 1;
    }
    fn snapshot(&self) -> Option<f64> {
        Some(self.0 as f64)
    }
}

/// pond-ts `LanedSum` (small lane only; see [`SUM_SPLIT`]).
#[derive(Default)]
struct SumState(f64);

impl WindowState for SumState {
    fn add(&mut self, _: usize, v: f64) {
        self.0 += v;
    }
    fn remove(&mut self, _: usize, v: f64) {
        self.0 -= v;
    }
    fn snapshot(&self) -> Option<f64> {
        Some(self.0)
    }
}

/// pond-ts avg `rollingState`: running sum, then divide.
#[derive(Default)]
struct AvgState {
    sum: f64,
    n: i64,
}

impl WindowState for AvgState {
    fn add(&mut self, _: usize, v: f64) {
        self.n += 1;
        self.sum += v;
    }
    fn remove(&mut self, _: usize, v: f64) {
        self.n -= 1;
        self.sum -= v;
    }
    fn snapshot(&self) -> Option<f64> {
        (self.n != 0).then(|| self.sum / self.n as f64)
    }
}

/// pond-ts `rollingMonotoneDeque`: (row, value) pairs, front is the answer;
/// the earliest of equal values wins.
struct ExtremeState<const MAX: bool>(VecDeque<(usize, f64)>);

impl<const MAX: bool> WindowState for ExtremeState<MAX> {
    fn add(&mut self, row: usize, v: f64) {
        while let Some(&(_, back)) = self.0.back() {
            let keep = if MAX { back >= v } else { back <= v };
            if keep {
                break;
            }
            self.0.pop_back();
        }
        self.0.push_back((row, v));
    }
    fn remove(&mut self, row: usize, _: f64) {
        if self.0.front().is_some_and(|&(r, _)| r == row) {
            self.0.pop_front();
        }
    }
    fn snapshot(&self) -> Option<f64> {
        self.0.front().map(|&(_, v)| v)
    }
}

/// pond-ts `rollingOrderedEntries`: present values in arrival order.
struct OrderedState<const LAST: bool>(VecDeque<(usize, f64)>);

impl<const LAST: bool> WindowState for OrderedState<LAST> {
    fn add(&mut self, row: usize, v: f64) {
        self.0.push_back((row, v));
    }
    fn remove(&mut self, row: usize, _: f64) {
        if self.0.front().is_some_and(|&(r, _)| r == row) {
            self.0.pop_front();
        }
    }
    fn snapshot(&self) -> Option<f64> {
        if LAST { self.0.back() } else { self.0.front() }.map(|&(_, v)| v)
    }
}

/// pond-ts `rollingSortedArray` + `percentileOfSorted`.
struct SortedState {
    sorted: Vec<f64>,
    q: f64,
}

impl WindowState for SortedState {
    fn add(&mut self, _: usize, v: f64) {
        let at = lower_bound(&self.sorted, v);
        self.sorted.insert(at, v);
    }
    fn remove(&mut self, _: usize, v: f64) {
        let at = lower_bound(&self.sorted, v);
        if at < self.sorted.len() && self.sorted[at] == v {
            self.sorted.remove(at);
        }
    }
    fn snapshot(&self) -> Option<f64> {
        (!self.sorted.is_empty()).then(|| percentile_of_sorted(&self.sorted, self.q))
    }
}

/// pond-ts stdev `rollingState`: Welford add/remove (small lane only; see
/// [`STDEV_SPLIT`]).
#[derive(Default)]
struct StdevState {
    n: f64,
    mean: f64,
    m2: f64,
}

impl WindowState for StdevState {
    fn add(&mut self, _: usize, v: f64) {
        self.n += 1.0;
        let delta = v - self.mean;
        self.mean += delta / self.n;
        self.m2 += delta * (v - self.mean);
    }
    fn remove(&mut self, _: usize, v: f64) {
        if self.n <= 1.0 {
            *self = Self::default();
            return;
        }
        let mean_with = self.mean;
        self.n -= 1.0;
        if self.n == 1.0 {
            self.mean = mean_with * 2.0 - v; // the one survivor
            self.m2 = 0.0;
            return;
        }
        self.mean = mean_with - (v - mean_with) / self.n;
        self.m2 -= (v - self.mean) * (v - mean_with);
        if self.m2 < 0.0 {
            self.m2 = 0.0;
        }
    }
    fn snapshot(&self) -> Option<f64> {
        (self.n != 0.0).then(|| (self.m2 / self.n).max(0.0).sqrt())
    }
}

/// First index whose value is not below `v` (pond-ts `bisect`).
fn lower_bound(sorted: &[f64], v: f64) -> usize {
    sorted.partition_point(|&x| x < v)
}

/// Run one column through pond-ts's trailing time window: each group of
/// rows sharing a time `t` sees the rows with time in `(t - window, t]`.
/// Rows enter before rows leave, as in pond-ts.
fn roll<S: WindowState>(mut state: S, times: &[i64], values: &[f64], window_ms: i64) -> Vec<f64> {
    let rows = times.len();
    let mut out = vec![f64::NAN; rows];
    let (mut window_start, mut window_end) = (0usize, 0usize);
    let mut group_start = 0;
    while group_start < rows {
        let anchor = times[group_start];
        let mut group_end = group_start + 1;
        while group_end < rows && times[group_end] == anchor {
            group_end += 1;
        }
        while window_end < rows && times[window_end] <= anchor {
            let v = values[window_end];
            if v.is_finite() {
                state.add(window_end, v);
            }
            window_end += 1;
        }
        let lower = anchor - window_ms;
        while window_start < window_end && times[window_start] <= lower {
            let v = values[window_start];
            if v.is_finite() {
                state.remove(window_start, v);
            }
            window_start += 1;
        }
        // A non-finite result (an overflow) is a gap, as in pond-ts.
        let snap = state
            .snapshot()
            .filter(|v| v.is_finite())
            .unwrap_or(f64::NAN);
        out[group_start..group_end].fill(snap);
        group_start = group_end;
    }
    out
}

fn roll_column(times: &[i64], values: &[f64], window_ms: i64, reducer: Reducer) -> Vec<f64> {
    match reducer {
        Reducer::Count => roll(CountState::default(), times, values, window_ms),
        Reducer::Sum => roll(SumState::default(), times, values, window_ms),
        Reducer::Avg => roll(AvgState::default(), times, values, window_ms),
        Reducer::Min => roll(
            ExtremeState::<false>(VecDeque::new()),
            times,
            values,
            window_ms,
        ),
        Reducer::Max => roll(
            ExtremeState::<true>(VecDeque::new()),
            times,
            values,
            window_ms,
        ),
        Reducer::First => roll(
            OrderedState::<false>(VecDeque::new()),
            times,
            values,
            window_ms,
        ),
        Reducer::Last => roll(
            OrderedState::<true>(VecDeque::new()),
            times,
            values,
            window_ms,
        ),
        Reducer::Median => roll(
            SortedState {
                sorted: Vec::new(),
                q: 50.0,
            },
            times,
            values,
            window_ms,
        ),
        Reducer::Percentile(q) => roll(
            SortedState {
                sorted: Vec::new(),
                q,
            },
            times,
            values,
            window_ms,
        ),
        Reducer::Stdev => roll(StdevState::default(), times, values, window_ms),
    }
}

impl TimeSeries {
    /// For each row at time `t`, reduce the rows with time in
    /// `(t - window, t]`: a trailing window. Rows sharing a time share a
    /// window. The result keeps this series' keys; each mapping entry becomes
    /// a column that may have gaps.
    ///
    /// ```
    /// use pond_rs::{Agg, Column, Reducer, TimeSeries};
    /// let s = TimeSeries::new("cpu", vec![0, 1_000, 2_000],
    ///     vec![Column::optional("v", [Some(1.0), None, Some(3.0)])])?;
    /// let r = s.rolling("2s", &[Agg::new("v_avg", "v", Reducer::Avg)])?;
    /// assert_eq!(r.column("v_avg").unwrap().get(2), Some(3.0)); // (0s, 2s] holds only 3.0
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    ///
    /// Column order follows pond-ts: entries made with [`Agg::new`] keep the
    /// order given; when every entry is an [`Agg::of`] shorthand, columns
    /// come out in this series' schema order.
    ///
    /// Gaps: a gap is not a value. `count` counts present values, `sum` of
    /// none is 0, and the other reducers give a gap when the window has no
    /// present values.
    pub fn rolling(&self, window: &str, aggs: &[Agg]) -> Result<TimeSeries> {
        let window_ms = parse_duration(window)?;
        let times = match self.key() {
            crate::series::Key::Time(t) => t,
            crate::series::Key::Interval(_) => {
                return Err(PondError::Unsupported {
                    call: CALL,
                    message: "rolling over an interval-keyed series".into(),
                });
            }
        };
        let mut plan = Vec::with_capacity(aggs.len());
        for (i, agg) in aggs.iter().enumerate() {
            let source = self.column_index(CALL, &agg.source)?;
            if agg.output == self.key_name() || aggs[..i].iter().any(|a| a.output == agg.output) {
                return Err(PondError::DuplicateOutput {
                    call: CALL,
                    column: agg.output.clone(),
                });
            }
            check_magnitude(&self.columns()[source], agg.reducer)?;
            plan.push((source, agg));
        }
        if aggs.iter().all(|a| a.shorthand) {
            // Stable, so equal positions keep their given order.
            plan.sort_by_key(|&(source, _)| source);
        }
        let columns = plan
            .iter()
            .map(|&(source, agg)| {
                let values = self.columns()[source].data().values();
                Column::optional_raw(
                    agg.output.clone(),
                    roll_column(times, values, window_ms, agg.reducer),
                )
            })
            .collect();
        Ok(TimeSeries::from_parts(
            self.name().to_string(),
            self.key_name().to_string(),
            self.key().clone(),
            columns,
        ))
    }
}

/// Refuse values pond-ts would route to its big-integer lanes.
fn check_magnitude(column: &Column, reducer: Reducer) -> Result<()> {
    let split = match reducer {
        Reducer::Sum | Reducer::Avg => SUM_SPLIT,
        Reducer::Stdev => STDEV_SPLIT,
        _ => return Ok(()),
    };
    match column
        .data()
        .values()
        .iter()
        .position(|v| v.is_finite() && v.abs() >= split)
    {
        None => Ok(()),
        Some(row) => Err(PondError::Unsupported {
            call: CALL,
            message: format!(
                "column '{}' row {row} holds {:e}, too large for a rolling {:?} (limit {split:e})",
                column.name(),
                column.data().values()[row],
                reducer
            ),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_are_the_pond_ts_powers_of_two() {
        assert_eq!(SUM_SPLIT, 2f64.powi(960));
        assert_eq!(STDEV_SPLIT, 2f64.powi(480));
    }
}
