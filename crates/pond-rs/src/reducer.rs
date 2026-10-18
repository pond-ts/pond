//! Reducers (`avg`, `sum`, …) and the mapping entries that use them.
//!
//! The kernels here are ports of pond-ts's, step for step, because parity
//! with pond-ts is checked bit for bit: the order values are added in decides
//! the last bits of a sum. Each kernel names the pond-ts function it follows.

use std::borrow::Cow;
use std::str::FromStr;

use crate::column::ColumnData;
use crate::error::PondError;
use crate::series::Column;

/// A built-in reducer.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Reducer {
    /// Number of present (non-missing) values.
    Count,
    /// Sum of present values; 0 when there are none.
    Sum,
    /// Mean of present values; missing when there are none. `"mean"` parses
    /// to this too.
    Avg,
    Min,
    Max,
    /// First present value.
    First,
    /// Last present value.
    Last,
    /// 50th percentile, interpolated.
    Median,
    /// Population standard deviation (divides by n).
    Stdev,
    /// Percentile `q` in `[0, 100]`, linear interpolation between ranks
    /// (`"p95"`).
    Percentile(f64),
}

impl Reducer {
    /// Refuse a reducer no result can come from: a percentile outside
    /// `[0, 100]` (or NaN). [`Reducer::parse`] never builds one, but the
    /// variant is public.
    pub(crate) fn check(self, call: &'static str) -> crate::error::Result<()> {
        match self {
            Reducer::Percentile(q) if !(0.0..=100.0).contains(&q) => Err(PondError::InvalidData {
                call,
                message: format!("percentile must be in [0, 100], got {q}"),
            }),
            _ => Ok(()),
        }
    }
    /// Parse a pond-ts reducer name: `count`, `sum`, `avg`, `mean`, `min`,
    /// `max`, `first`, `last`, `median`, `stdev`, `p<q>`.
    pub fn parse(name: &str) -> Result<Self, PondError> {
        name.parse()
    }
}

impl FromStr for Reducer {
    type Err = PondError;

    fn from_str(name: &str) -> Result<Self, PondError> {
        Ok(match name {
            "count" => Reducer::Count,
            "sum" => Reducer::Sum,
            "avg" | "mean" => Reducer::Avg,
            "min" => Reducer::Min,
            "max" => Reducer::Max,
            "first" => Reducer::First,
            "last" => Reducer::Last,
            "median" => Reducer::Median,
            "stdev" => Reducer::Stdev,
            "difference" | "keep" | "samples" | "unique" => {
                return Err(PondError::UnsupportedReducer {
                    name: name.to_string(),
                });
            }
            _ => {
                if let Some(q) = parse_percentile(name) {
                    Reducer::Percentile(q)
                } else if is_top_n(name) {
                    return Err(PondError::UnsupportedReducer {
                        name: name.to_string(),
                    });
                } else {
                    return Err(PondError::UnknownReducer {
                        name: name.to_string(),
                    });
                }
            }
        })
    }
}

/// JS `Math.max(0, x)`: a NaN stays NaN (Rust's `f64::max` would drop it and
/// give 0), and `-0` becomes `+0`. A NaN variance then becomes a gap, as in
/// pond-ts.
pub(crate) fn clamp_at_zero(x: f64) -> f64 {
    if x.is_nan() || x > 0.0 { x } else { 0.0 }
}

/// pond-ts `parsePercentile`: `p` then a number in `[0, 100]`. pond-ts reads
/// the number with JS `Number`, which also takes surrounding spaces and hex;
/// those spellings are rejected here.
fn parse_percentile(name: &str) -> Option<f64> {
    let rest = name.strip_prefix('p')?;
    if rest.is_empty() {
        return None;
    }
    let q: f64 = rest.parse().ok()?;
    (0.0..=100.0).contains(&q).then_some(q)
}

/// pond-ts `top<N>` (a reducer pond-rs does not have yet).
fn is_top_n(name: &str) -> bool {
    name.strip_prefix("top")
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// One mapping entry: write `reducer(source)` to the output column `output`.
#[derive(Debug, Clone, PartialEq)]
pub struct Agg {
    pub(crate) output: String,
    pub(crate) source: String,
    pub(crate) reducer: Reducer,
    /// Built with [`Agg::of`] (output named after its source). Decides
    /// column order in `rolling`; see [`crate::TimeSeries::rolling`].
    pub(crate) shorthand: bool,
}

impl Agg {
    /// Reduce `source` into a column of the same name: pond-ts's shorthand
    /// mapping `{ cpu: 'avg' }`.
    ///
    /// In `rolling`, a list made only of `Agg::of` entries is put into schema
    /// order, as pond-ts does; a single [`Agg::new`] entry in the list keeps
    /// the whole list in the order given.
    pub fn of(source: impl Into<String>, reducer: Reducer) -> Self {
        let source = source.into();
        Self {
            output: source.clone(),
            source,
            reducer,
            shorthand: true,
        }
    }

    /// Reduce `source` into a column named `output`: pond-ts's
    /// `{ cpu_avg: { from: 'cpu', using: 'avg' } }`.
    pub fn new(output: impl Into<String>, source: impl Into<String>, reducer: Reducer) -> Self {
        Self {
            output: output.into(),
            source: source.into(),
            reducer,
            shorthand: false,
        }
    }

    pub fn output(&self) -> &str {
        &self.output
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    pub fn reducer(&self) -> Reducer {
        self.reducer
    }
}

// ---------------------------------------------------------------------------
// Range kernels: reduce `values[start..end]`, skipping gaps. These are the
// `reduceColumnRange` kernels pond-ts's columnar `aggregate` uses.
// ---------------------------------------------------------------------------

/// pond-ts `BLOCKED_MIN`: from this many values, sums use eight lanes.
const BLOCKED_MIN: usize = 32;

#[inline]
fn finite(v: f64) -> bool {
    v.is_finite()
}

/// pond-ts `blockedSumFinite`: eight running sums, combined in order, then
/// the tail. A gap adds `+0` to its lane (which turns a `-0` lane into `+0`,
/// exactly as in pond-ts).
fn blocked_sum_finite(values: &[f64]) -> f64 {
    let mut a = [0.0f64; 8];
    let lim = values.len() / 8 * 8;
    for chunk in values[..lim].chunks_exact(8) {
        for (lane, &v) in a.iter_mut().zip(chunk) {
            *lane += if finite(v) { v } else { 0.0 };
        }
    }
    let mut s = a[0] + a[1] + a[2] + a[3] + a[4] + a[5] + a[6] + a[7];
    for &v in &values[lim..] {
        if finite(v) {
            s += v;
        }
    }
    s
}

/// pond-ts `sumRange` (the gap-skipping form; with no gaps it gives the same
/// bits as the plain form).
pub(crate) fn sum_range(values: &[f64]) -> f64 {
    if values.len() >= BLOCKED_MIN {
        return blocked_sum_finite(values);
    }
    let mut s = 0.0;
    for &v in values {
        if finite(v) {
            s += v;
        }
    }
    s
}

fn count_finite(values: &[f64]) -> usize {
    values.iter().filter(|v| v.is_finite()).count()
}

/// pond-ts `avgRange`.
pub(crate) fn avg_range(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    if values.len() >= BLOCKED_MIN {
        let n = count_finite(values);
        return (n != 0).then(|| blocked_sum_finite(values) / n as f64);
    }
    let mut s = 0.0;
    let mut n = 0usize;
    for &v in values {
        if finite(v) {
            s += v;
            n += 1;
        }
    }
    (n != 0).then(|| s / n as f64)
}

/// pond-ts `minRange`: the first of equal values wins (`v < lo`).
pub(crate) fn min_range(values: &[f64]) -> Option<f64> {
    let mut lo: Option<f64> = None;
    for &v in values {
        if finite(v) && lo.is_none_or(|lo| v < lo) {
            lo = Some(v);
        }
    }
    lo
}

/// pond-ts `maxRange`.
pub(crate) fn max_range(values: &[f64]) -> Option<f64> {
    let mut hi: Option<f64> = None;
    for &v in values {
        if finite(v) && hi.is_none_or(|hi| v > hi) {
            hi = Some(v);
        }
    }
    hi
}

/// pond-ts `stdevRange`: Welford's recurrence over present values.
pub(crate) fn stdev_range(values: &[f64]) -> Option<f64> {
    let mut n = 0.0f64;
    let mut mean = 0.0f64;
    let mut m2 = 0.0f64;
    for &v in values {
        if !finite(v) {
            continue;
        }
        n += 1.0;
        let delta = v - mean;
        mean += delta / n;
        m2 += delta * (v - mean);
    }
    (n != 0.0).then(|| clamp_at_zero(m2 / n).sqrt())
}

/// pond-ts `percentileOfSorted`.
pub(crate) fn percentile_of_sorted(sorted: &[f64], q: f64) -> f64 {
    let rank = (q / 100.0) * (sorted.len() - 1) as f64;
    let lo = rank.floor();
    let hi = rank.ceil();
    let (l, h) = (sorted[lo as usize], sorted[hi as usize]);
    if lo == hi {
        return l;
    }
    l + (h - l) * (rank - lo)
}

/// pond-ts `SELECT_INSERTION_THRESHOLD`.
const SELECT_INSERTION_THRESHOLD: usize = 16;

/// pond-ts `quickselect`, line for line: which of two equal values (`0` and
/// `-0`) ends up at rank `k` depends on the exact swaps.
fn quickselect(a: &mut [f64], k: usize, lo: usize, hi: usize) -> f64 {
    // Indices can step one below `left` (j -= 1 past 0), so work in isize.
    let mut left = lo as isize;
    let mut right = hi as isize;
    let k = k as isize;
    let at = |a: &[f64], i: isize| a[i as usize];
    while left < right {
        if ((right - left) as usize) < SELECT_INSERTION_THRESHOLD {
            for i in (left + 1)..=right {
                let v = at(a, i);
                let mut j = i - 1;
                while j >= left && at(a, j) > v {
                    a[(j + 1) as usize] = at(a, j);
                    j -= 1;
                }
                a[(j + 1) as usize] = v;
            }
            return at(a, k);
        }
        let mid = (left + right) >> 1;
        if at(a, mid) < at(a, left) {
            a.swap(mid as usize, left as usize);
        }
        if at(a, right) < at(a, left) {
            a.swap(right as usize, left as usize);
        }
        if at(a, right) < at(a, mid) {
            a.swap(right as usize, mid as usize);
        }
        let pivot = at(a, mid);
        let mut i = left;
        let mut j = right;
        while i <= j {
            while at(a, i) < pivot {
                i += 1;
            }
            while at(a, j) > pivot {
                j -= 1;
            }
            if i <= j {
                a.swap(i as usize, j as usize);
                i += 1;
                j -= 1;
            }
        }
        if k <= j {
            right = j;
        } else if k >= i {
            left = i;
        } else {
            return at(a, k);
        }
    }
    at(a, k)
}

/// pond-ts `reducePercentileColumnRange` / `percentileOfUnsorted`.
pub(crate) fn percentile_range(values: &[f64], q: f64) -> Option<f64> {
    let mut dense: Vec<f64> = values.iter().copied().filter(|v| v.is_finite()).collect();
    let k = dense.len();
    if k == 0 {
        return None;
    }
    let rank = (q / 100.0) * (k - 1) as f64;
    let lo = rank.floor();
    let hi = rank.ceil();
    if lo == hi {
        return Some(quickselect(&mut dense, lo as usize, 0, k - 1));
    }
    let v_hi = quickselect(&mut dense, hi as usize, 0, k - 1);
    let v_lo = quickselect(&mut dense, lo as usize, 0, hi as usize);
    Some(v_lo + (v_hi - v_lo) * (rank - lo))
}

/// First present value (pond-ts aggregate's boundary scan).
pub(crate) fn first_range(values: &[f64]) -> Option<f64> {
    values.iter().copied().find(|v| v.is_finite())
}

/// Last present value.
pub(crate) fn last_range(values: &[f64]) -> Option<f64> {
    values.iter().rev().copied().find(|v| v.is_finite())
}

/// Reduce one range. A non-finite result (an overflowing sum) is a gap, as
/// in pond-ts (`finiteOrMissing`).
pub(crate) fn reduce_range(reducer: Reducer, values: &[f64]) -> Option<f64> {
    let out = match reducer {
        Reducer::Count => Some(count_finite(values) as f64),
        Reducer::Sum => Some(sum_range(values)),
        Reducer::Avg => avg_range(values),
        Reducer::Min => min_range(values),
        Reducer::Max => max_range(values),
        Reducer::First => first_range(values),
        Reducer::Last => last_range(values),
        Reducer::Median => percentile_range(values, 50.0),
        Reducer::Stdev => stdev_range(values),
        Reducer::Percentile(q) => percentile_range(values, q),
    };
    out.filter(|v| v.is_finite())
}

// ---------------------------------------------------------------------------
// Text and true/false sources. They take `count`, `first` and `last` only
// (pond-ts's types allow the same set, plus reducers pond-rs does not have
// yet). The kernels above run over each row's number where the row has a
// value and NaN where it has none; `first` / `last` then give the row whose
// value to take.
// ---------------------------------------------------------------------------

/// Refuse a reducer that needs numbers on a text or true/false column.
/// pond-ts's types refuse it too; at run time pond-ts answers anyway (`sum`
/// gives 0, `avg` and `max` give gaps), where pond-rs returns this error.
pub(crate) fn check_source_kind(
    call: &'static str,
    column: &Column,
    reducer: Reducer,
) -> Result<(), PondError> {
    match (column.data(), reducer) {
        (ColumnData::Number(_), _) | (_, Reducer::Count | Reducer::First | Reducer::Last) => Ok(()),
        (data, _) => Err(PondError::WrongKind {
            call,
            column: column.name().to_string(),
            kind: data.kind_name(),
            reason: format!(
                "{} needs a number column; string and boolean columns take count, first or last",
                reducer_name(reducer)
            ),
        }),
    }
}

/// pond-ts's name for a reducer.
fn reducer_name(reducer: Reducer) -> String {
    match reducer {
        Reducer::Count => "count".into(),
        Reducer::Sum => "sum".into(),
        Reducer::Avg => "avg".into(),
        Reducer::Min => "min".into(),
        Reducer::Max => "max".into(),
        Reducer::First => "first".into(),
        Reducer::Last => "last".into(),
        Reducer::Median => "median".into(),
        Reducer::Stdev => "stdev".into(),
        Reducer::Percentile(q) => format!("p{q}"),
    }
}

/// [`kernel_input`] for each column in `used`, built once per column (a
/// mapping often reduces one column several ways); `None` for the rest.
pub(crate) fn kernel_inputs<'a>(
    columns: &'a [Column],
    used: &[usize],
) -> Vec<Option<Cow<'a, [f64]>>> {
    let mut out: Vec<Option<Cow<'a, [f64]>>> = columns.iter().map(|_| None).collect();
    for &c in used {
        if out[c].is_none() {
            out[c] = Some(kernel_input(columns[c].data()));
        }
    }
    out
}

/// What the kernels run over: a number column's values, or for any other
/// kind each row's number where it has a value (NaN where it has none).
fn kernel_input(data: &ColumnData) -> Cow<'_, [f64]> {
    match data {
        ColumnData::Number(c) => Cow::Borrowed(c.values()),
        other => Cow::Owned(match other.arrow_nulls() {
            None => (0..other.len()).map(|i| i as f64).collect(),
            Some(nulls) => nulls
                .iter()
                .enumerate()
                .map(|(i, valid)| if valid { i as f64 } else { f64::NAN })
                .collect(),
        }),
    }
}

/// The output column for `out`, the kernel results for a `source` column.
/// Always optional (an empty window or bucket is a gap).
pub(crate) fn output_column(
    name: String,
    source: &ColumnData,
    reducer: Reducer,
    out: Vec<f64>,
) -> Column {
    let rows = || -> Vec<Option<usize>> {
        out.iter()
            .map(|&v| v.is_finite().then_some(v as usize))
            .collect()
    };
    match (source, reducer) {
        (ColumnData::Number(_), _) | (_, Reducer::Count) => Column::optional_raw(name, out),
        (ColumnData::String(c), _) => Column::from_data(name, c.take(&rows()), false),
        (ColumnData::Boolean(c), _) => Column::from_data(name, c.take(&rows()), false),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn clamp_at_zero_is_js_math_max() {
        assert!(clamp_at_zero(f64::NAN).is_nan());
        assert_eq!(clamp_at_zero(-0.0).to_bits(), 0.0f64.to_bits());
        assert_eq!(clamp_at_zero(-1.0), 0.0);
        assert_eq!(clamp_at_zero(2.0), 2.0);
    }

    #[test]
    fn percentile_out_of_range_is_an_error_not_a_panic() {
        use crate::{Agg, Column, Sequence, TimeSeries};
        let s =
            TimeSeries::new("s", vec![0, 1], vec![Column::required("a", vec![1.0, 2.0])]).unwrap();
        for q in [150.0, -10.0, f64::NAN] {
            let aggs = [Agg::of("a", Reducer::Percentile(q))];
            assert!(s.rolling("1s", &aggs).is_err(), "rolling p{q}");
            assert!(
                s.aggregate(&Sequence::every("1s").unwrap(), &aggs).is_err(),
                "aggregate p{q}"
            );
        }
    }

    use super::*;

    #[test]
    fn parses_names() {
        assert_eq!(Reducer::parse("mean"), Ok(Reducer::Avg));
        assert_eq!(Reducer::parse("p95"), Ok(Reducer::Percentile(95.0)));
        assert_eq!(Reducer::parse("p0"), Ok(Reducer::Percentile(0.0)));
        assert!(matches!(
            Reducer::parse("p101"),
            Err(PondError::UnknownReducer { .. })
        ));
        assert!(matches!(
            Reducer::parse("p"),
            Err(PondError::UnknownReducer { .. })
        ));
        assert!(matches!(
            Reducer::parse("bogus"),
            Err(PondError::UnknownReducer { .. })
        ));
        assert!(matches!(
            Reducer::parse("top3"),
            Err(PondError::UnsupportedReducer { .. })
        ));
        assert!(matches!(
            Reducer::parse("unique"),
            Err(PondError::UnsupportedReducer { .. })
        ));
    }

    #[test]
    fn percentile_matches_a_full_sort() {
        // Many sizes, both sides of the insertion-sort threshold.
        let mut seed = 7u64;
        for n in 1..80usize {
            let values: Vec<f64> = (0..n)
                .map(|_| {
                    seed = seed
                        .wrapping_mul(6364136223846793005)
                        .wrapping_add(1442695040888963407);
                    ((seed >> 33) % 50) as f64 - 25.0
                })
                .collect();
            let mut sorted = values.clone();
            sorted.sort_by(f64::total_cmp);
            for q in [0.0, 10.0, 50.0, 90.0, 95.0, 100.0] {
                assert_eq!(
                    percentile_range(&values, q),
                    Some(percentile_of_sorted(&sorted, q)),
                    "n={n} q={q}"
                );
            }
        }
    }

    #[test]
    fn blocked_sum_adds_lanes_in_order() {
        // 40 values: 5 rounds of 8 lanes. The lanes see 1e16 then 1s; a
        // straight left-to-right sum would lose the 1s differently.
        let mut values = vec![1.0; 40];
        values[0] = 1e16;
        let lanes: f64 = {
            let mut a = [0.0f64; 8];
            for (i, v) in values.iter().enumerate() {
                a[i % 8] += v;
            }
            a.iter().sum()
        };
        assert_eq!(sum_range(&values), lanes);
    }
}
