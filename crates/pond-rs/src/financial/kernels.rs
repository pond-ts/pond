//! The number kernels the studies share, ported line for line from
//! `@pond-ts/financial`'s `src/kernels/` so they give the same bits: the same
//! operations in the same order, no fused multiply-add, and `x * x` where
//! pond-ts writes `x ** 2` (V8 and fdlibm both compute that as `x * x`).
//!
//! Every kernel reads a column as `f64` with gaps as `NaN` and returns one
//! value per row, `NaN` for "no value".

use super::MaType;

/// A column's numbers with every gap (any non-finite value) as `NaN`, as
/// pond-ts's `columnValues` reads it.
pub(crate) fn gaps_as_nan(values: &[f64]) -> Vec<f64> {
    values
        .iter()
        .map(|&v| if v.is_finite() { v } else { f64::NAN })
        .collect()
}

/// Welford's running mean and spread, in a frame shifted by an anchor.
#[derive(Default)]
struct Spread {
    n: f64,
    mean: f64,
    m2: f64,
}

impl Spread {
    fn add(&mut self, y: f64) {
        self.n += 1.0;
        let d = y - self.mean;
        self.mean += d / self.n;
        self.m2 += d * (y - self.mean);
    }

    fn remove(&mut self, y: f64) {
        if self.n <= 1.0 {
            *self = Spread::default();
        } else {
            let mean_with = self.mean;
            self.n -= 1.0;
            if self.n == 1.0 {
                self.mean = mean_with * 2.0 - y;
                self.m2 = 0.0;
            } else {
                self.mean = mean_with - (y - mean_with) / self.n;
                self.m2 -= (y - self.mean) * (y - mean_with);
                if self.m2 < 0.0 {
                    self.m2 = 0.0;
                }
            }
        }
    }

    /// Population standard deviation; `NaN` with no values.
    fn sd(&self) -> f64 {
        if self.n == 0.0 {
            f64::NAN
        } else {
            let var = self.m2 / self.n;
            (if var > 0.0 { var } else { 0.0 }).sqrt()
        }
    }
}

/// pond-ts `rollingMeanSdInto` over the whole column: the mean (and, when
/// `want_sd`, the population standard deviation) of the finite values in
/// each `period`-row window. A row gets a value once its window spans
/// `period` rows and holds at least one finite value.
///
/// The sums are kept relative to an anchor and thrown away and rebuilt
/// every `period` rows (at `i % period == 0`), so rounding cannot build up
/// and values near 1e15 keep their low bits. O(N): the rebuild costs
/// `period` once every `period` rows.
pub(crate) fn rolling_mean_sd(
    values: &[f64],
    period: usize,
    want_sd: bool,
) -> (Vec<f64>, Option<Vec<f64>>) {
    if want_sd {
        let (mean, sd) = mean_sd::<true>(values, period);
        (mean, Some(sd))
    } else {
        (mean_sd::<false>(values, period).0, None)
    }
}

/// Rows per stretch when a kernel runs on several cores: big enough that
/// the `period` rows each stretch re-reads cost nothing.
fn chunk_rows(period: usize) -> usize {
    (1 << 16).max(period.saturating_mul(8))
}

fn mean_sd<const SD: bool>(values: &[f64], period: usize) -> (Vec<f64>, Vec<f64>) {
    mean_sd_chunked::<SD>(values, period, chunk_rows(period))
}

/// Zeroed buffers: the system hands out zero pages lazily, so the threads
/// filling the stretches take the page faults in parallel.
fn mean_sd_chunked<const SD: bool>(
    values: &[f64],
    period: usize,
    chunk: usize,
) -> (Vec<f64>, Vec<f64>) {
    let n = values.len();
    let mut mean = vec![0.0; n];
    let mut sd = if SD { vec![0.0; n] } else { Vec::new() };
    crate::par::fill_chunks(&mut mean, &mut sd, chunk, |start, mean, sd| {
        mean_sd_into::<SD>(values, period, start, mean, sd)
    });
    (mean, sd)
}

/// [`rolling_mean_sd`] for rows `start..start + mean.len()`, written to
/// `mean` (and `sd`). Every row from `start` on gets exactly the bits the
/// whole-column sweep gives it: the sums are thrown away and rebuilt from
/// the window at every row that is a multiple of `period`, so the sweep
/// can begin at the last such row at or before `start` (pond-ts's
/// `rollingReadBack` relies on the same property).
///
/// Between rebuilds each row adds its own value and, once `period` rows
/// have passed, drops the value leaving the window: the same additions and
/// removals, in the same order, as pond-ts's two `while` loops.
fn mean_sd_into<const SD: bool>(
    values: &[f64],
    period: usize,
    start: usize,
    mean: &mut [f64],
    sd: &mut [f64],
) {
    let end = start + mean.len();
    let first = start / period * period;
    let mut anchor = 0.0;
    let mut shifted_sum = 0.0;
    let mut count = 0usize;
    let mut spread = Spread::default();
    // `i % period == 0`, without a division per row.
    let mut next_rebuild = first;

    for i in first..end {
        if i == next_rebuild {
            // Whatever this row would add and drop is thrown away here.
            next_rebuild += period;
            let at = values[i];
            anchor = if at.is_finite() { at } else { 0.0 };
            shifted_sum = 0.0;
            count = 0;
            spread = Spread::default();
            for &x in &values[(i + 1).saturating_sub(period)..=i] {
                if !x.is_finite() {
                    continue;
                }
                let y = x - anchor;
                shifted_sum += y;
                count += 1;
                if SD {
                    spread.add(y);
                }
            }
        } else {
            let x = values[i];
            if x.is_finite() {
                let y = x - anchor;
                shifted_sum += y;
                count += 1;
                if SD {
                    spread.add(y);
                }
            }
            if i >= period {
                let x = values[i - period];
                if x.is_finite() {
                    let y = x - anchor;
                    shifted_sum -= y;
                    count -= 1;
                    if SD {
                        spread.remove(y);
                    }
                }
            }
        }

        if i < start {
            continue;
        }
        let k = i - start;
        // The window spans `min(i + 1, period)` rows.
        if i + 1 < period || count == 0 {
            mean[k] = f64::NAN;
            if SD {
                sd[k] = f64::NAN;
            }
            continue;
        }
        mean[k] = anchor + shifted_sum / count as f64;
        if SD {
            sd[k] = spread.sd();
        }
    }
}

/// pond-ts `rollingMeanValues`: [`rolling_mean_sd`]'s mean, but a gap
/// wherever the window holds a gap or is not yet full.
pub(crate) fn rolling_mean_values(values: &[f64], period: usize) -> Vec<f64> {
    let (mut out, _) = rolling_mean_sd(values, period, false);
    let mut missing = 0usize;
    for i in 0..values.len() {
        if !values[i].is_finite() {
            missing += 1;
        }
        if i >= period && !values[i - period].is_finite() {
            missing -= 1;
        }
        if i + 1 < period || missing > 0 {
            out[i] = f64::NAN;
        }
    }
    out
}

/// pond-ts `rollingDeviationSd`, for the z-score: each value's distance
/// from its window mean, and the window's population standard deviation.
/// Shifted and rebuilt like [`rolling_mean_sd`], but the anchor moves to
/// the current value once `period` rows have passed since the last one and
/// the current value is finite.
pub(crate) fn rolling_deviation_sd(values: &[f64], period: usize) -> (Vec<f64>, Vec<f64>) {
    let n = values.len();
    let mut deviation = vec![f64::NAN; n];
    let mut sd = vec![f64::NAN; n];
    let (mut window_start, mut window_end) = (0usize, 0usize);
    let mut anchor = 0.0;
    let mut shifted_sum = 0.0;
    let mut count = 0usize;
    let mut spread = Spread::default();
    let mut since_anchor = period;

    for i in 0..n {
        let lo = (i + 1).saturating_sub(period);
        while window_end <= i {
            let x = values[window_end];
            if x.is_finite() {
                let y = x - anchor;
                shifted_sum += y;
                count += 1;
                spread.add(y);
            }
            window_end += 1;
        }
        while window_start < lo {
            let x = values[window_start];
            if x.is_finite() {
                let y = x - anchor;
                shifted_sum -= y;
                count -= 1;
                spread.remove(y);
            }
            window_start += 1;
        }

        since_anchor = since_anchor.saturating_add(1);
        let x = values[i];
        if x.is_finite() && since_anchor >= period {
            anchor = x;
            since_anchor = 0;
            shifted_sum = 0.0;
            count = 0;
            spread = Spread::default();
            for &w in &values[window_start..window_end] {
                if !w.is_finite() {
                    continue;
                }
                let y = w - anchor;
                shifted_sum += y;
                count += 1;
                spread.add(y);
            }
        }

        if window_end - window_start < period || count == 0 || spread.n == 0.0 {
            continue;
        }
        deviation[i] = x - anchor - shifted_sum / count as f64;
        sd[i] = spread.sd();
    }
    (deviation, sd)
}

/// pond-ts `wilderValues` (Wilder's smoothing, the `smma` type): skip
/// leading gaps, seed with the mean of the first `period` values, then
/// `avg = (avg * (period - 1) + x) / period`. A later gap makes every value
/// after it a gap.
pub(crate) fn wilder_values(values: &[f64], period: usize) -> Vec<f64> {
    let n = values.len();
    let mut out = vec![f64::NAN; n];
    let first = values.iter().position(|v| !v.is_nan()).unwrap_or(n);
    let seed_at = first.saturating_add(period - 1);
    if seed_at >= n {
        return out;
    }
    let p = period as f64;
    let mut sum = 0.0;
    for &v in &values[first..=seed_at] {
        sum += v;
    }
    let mut avg = sum / p;
    out[seed_at] = avg;
    for i in seed_at + 1..n {
        avg = (avg * (p - 1.0) + values[i]) / p;
        out[i] = avg;
    }
    out
}

/// pond-ts `alphaEmaValues`: an exponential average that skips gaps
/// (a gap row gets a gap and leaves the average as it was), starting from
/// the first value, with a gap until `min_samples` values have been read.
pub(crate) fn alpha_ema_values(values: &[f64], alpha: f64, min_samples: usize) -> Vec<f64> {
    let mut out = vec![f64::NAN; values.len()];
    let mut previous = 0.0;
    let mut seeded = false;
    let mut seen = 0usize;
    for (i, &raw) in values.iter().enumerate() {
        if !raw.is_finite() {
            continue;
        }
        previous = if seeded {
            alpha * raw + (1.0 - alpha) * previous
        } else {
            raw
        };
        seeded = true;
        seen += 1;
        if seen >= min_samples {
            out[i] = previous;
        }
    }
    out
}

/// The `period`-bar EMA: alpha `2 / (period + 1)`, a gap until `period`
/// values have been read.
pub(crate) fn ema_values(values: &[f64], period: usize) -> Vec<f64> {
    alpha_ema_values(values, 2.0 / (period as f64 + 1.0), period)
}

/// pond-ts `wmaValues`: weights 1..=period, newest heaviest. A gap wherever
/// the window holds a gap or is not yet full. Kept as a running sum and a
/// running weighted sum, rebuilt every `period` rows like
/// [`rolling_mean_sd`].
pub(crate) fn wma_values(values: &[f64], period: usize) -> Vec<f64> {
    wma_chunked(values, period, chunk_rows(period))
}

fn wma_chunked(values: &[f64], period: usize, chunk: usize) -> Vec<f64> {
    let mut out = vec![0.0; values.len()];
    crate::par::fill_chunks(&mut out, &mut [], chunk, |start, out, _| {
        wma_into(values, period, start, out)
    });
    out
}

/// [`wma_values`] for rows `start..start + out.len()`; like
/// [`mean_sd_into`], it can begin at the last multiple of `period` at or
/// before `start`, where every sum is rebuilt from the window.
fn wma_into(values: &[f64], period: usize, start: usize, out: &mut [f64]) {
    let end = start + out.len();
    let first = start / period * period;
    let p = period as f64;
    let denominator = (p * (p + 1.0)) / 2.0;
    let mut sum = 0.0;
    let mut weighted = 0.0;
    let mut missing = 0usize;
    let mut next_rebuild = first; // `i % period == 0`, as above

    for i in first..end {
        if i == next_rebuild {
            next_rebuild += period;
            // `low` can be negative in pond-ts; the weight is `k - low + 1`.
            let low = i as f64 - p + 1.0;
            sum = 0.0;
            weighted = 0.0;
            missing = 0;
            let from = (i + 1).saturating_sub(period);
            for (k, &x) in values.iter().enumerate().take(i + 1).skip(from) {
                if !x.is_finite() {
                    missing += 1;
                    continue;
                }
                sum += x;
                weighted += (k as f64 - low + 1.0) * x;
            }
        } else {
            let entering = values[i];
            weighted = weighted - sum + p * (if entering.is_finite() { entering } else { 0.0 });
            if entering.is_finite() {
                sum += entering;
            } else {
                missing += 1;
            }
            if i >= period {
                let leaving = values[i - period];
                if leaving.is_finite() {
                    sum -= leaving;
                } else {
                    missing -= 1;
                }
            }
        }

        if i >= start {
            out[i - start] = if i + 1 >= period && missing == 0 {
                weighted / denominator
            } else {
                f64::NAN
            };
        }
    }
}

fn dema_values(values: &[f64], period: usize) -> Vec<f64> {
    let first = ema_values(values, period);
    let mut out = ema_values(&first, period);
    // In place: one fresh buffer fewer (getting fresh memory from the
    // system is a real share of the cost at 1M rows).
    for (o, &a) in out.iter_mut().zip(&first) {
        *o = 2.0 * a - *o;
    }
    out
}

fn tema_values(values: &[f64], period: usize) -> Vec<f64> {
    let first = ema_values(values, period);
    let second = ema_values(&first, period);
    let mut out = ema_values(&second, period);
    for ((o, &a), &b) in out.iter_mut().zip(&first).zip(&second) {
        *o += 3.0 * a - 3.0 * b; // (3a - 3b) + o, as pond-ts adds it
    }
    out
}

/// An SMA of an SMA whose two lengths add up to `period + 1`.
fn trima_values(values: &[f64], period: usize) -> Vec<f64> {
    let (first, second) = if period % 2 == 1 {
        (period.div_ceil(2), period.div_ceil(2))
    } else {
        (period / 2 + 1, period / 2)
    };
    rolling_mean_values(&rolling_mean_values(values, first), second)
}

/// `wma(2 * wma(period / 2) - wma(period), round(sqrt(period)))`.
fn hull_values(values: &[f64], period: usize) -> Vec<f64> {
    let half = (period / 2).max(1);
    // JavaScript's Math.round rounds halves up; a square root of a whole
    // number is never exactly a half, so `round` gives the same.
    let root = ((period as f64).sqrt().round() as usize).max(1);
    let mut raw = wma_values(values, half);
    let slow = wma_values(values, period);
    for (r, &s) in raw.iter_mut().zip(&slow) {
        *r = 2.0 * *r - s;
    }
    wma_values(&raw, root)
}

/// Kaufman's adaptive average (fast 2, slow 30), seeded on the value before
/// the first full efficiency window. A gap after the first value makes
/// every later value a gap, as in pond-ts.
fn kama_values(values: &[f64], period: usize) -> Vec<f64> {
    const SLOW: f64 = 2.0 / (30.0 + 1.0);
    const DIFF: f64 = 2.0 / (2.0 + 1.0) - SLOW;
    let n = values.len();
    let mut out = vec![f64::NAN; n];
    let first = values.iter().position(|v| v.is_finite()).unwrap_or(n);
    let seed_at = first.saturating_add(period);
    if seed_at >= n {
        return out;
    }
    let mut sum = 0.0;
    for i in first + 1..=seed_at {
        sum += (values[i] - values[i - 1]).abs();
    }
    let mut previous = values[seed_at - 1];
    for i in seed_at..n {
        if i > seed_at {
            sum += (values[i] - values[i - 1]).abs()
                - (values[i - period] - values[i - period - 1]).abs();
        }
        let change = (values[i] - values[i - period]).abs();
        let efficiency = if sum == 0.0 { 1.0 } else { change / sum };
        let c = efficiency * DIFF + SLOW;
        let constant = c * c;
        previous += constant * (values[i] - previous);
        out[i] = previous;
    }
    out
}

/// An EMA of `2x - x[lag]`, `lag = (period - 1) / 2`, to cancel the
/// average's lag.
fn zlema_values(values: &[f64], period: usize) -> Vec<f64> {
    let lag = (period - 1) / 2;
    let mut shifted = vec![f64::NAN; values.len()];
    for i in lag..values.len() {
        shifted[i] = 2.0 * values[i] - values[i - lag];
    }
    ema_values(&shifted, period)
}

/// pond-ts `movingAverageValues`, for every type but `sma` and `ema` read
/// straight from a column (those go through [`rolling_mean_sd`] and
/// [`ema_values`] without the full-window mask; see `moving_average`).
pub(crate) fn moving_average_values(values: &[f64], period: usize, kind: MaType) -> Vec<f64> {
    match kind {
        MaType::Sma => rolling_mean_values(values, period),
        MaType::Ema => ema_values(values, period),
        MaType::Wma => wma_values(values, period),
        MaType::Smma => wilder_values(values, period),
        MaType::Dema => dema_values(values, period),
        MaType::Tema => tema_values(values, period),
        MaType::Trima => trima_values(values, period),
        MaType::Hull => hull_values(values, period),
        MaType::Kama => kama_values(values, period),
        MaType::Zlema => zlema_values(values, period),
    }
}

/// The lowest (or, with `MAX`, highest) finite value in each `period`-row
/// window, as core `rolling({ count: period }, min | max, { minSamples:
/// period })` gives it: a gap until `period` rows have passed, and where
/// the window holds no finite value. Of equal values the earliest wins, so
/// a window of `-0` then `0` gives `-0` for both.
///
/// A queue of candidate rows (each better than every later one in the
/// queue), so O(N) whatever the period.
pub(crate) fn rolling_extreme<const MAX: bool>(values: &[f64], period: usize) -> Vec<f64> {
    extreme_chunked::<MAX>(values, period, chunk_rows(period))
}

fn extreme_chunked<const MAX: bool>(values: &[f64], period: usize, chunk: usize) -> Vec<f64> {
    let mut out = vec![0.0; values.len()];
    crate::par::fill_chunks(&mut out, &mut [], chunk, |start, out, _| {
        extreme_into::<MAX>(values, period, start, out)
    });
    out
}

/// [`rolling_extreme`] for rows `start..start + out.len()`, reading from
/// the first row of `start`'s window (a lowest value is exact, so where
/// the sweep begins cannot change it).
fn extreme_into<const MAX: bool>(values: &[f64], period: usize, start: usize, out: &mut [f64]) {
    let end = start + out.len();
    let from = (start + 1).saturating_sub(period);
    // The queue never holds more than one window, nor more rows than are read.
    let mut queue = std::collections::VecDeque::with_capacity(period.min(end - from));
    // `a` beats `b` strictly: a later equal value never pushes out an
    // earlier one.
    let beats = |a: f64, b: f64| if MAX { a > b } else { a < b };
    for i in from..end {
        let x = values[i];
        if x.is_finite() {
            while queue.back().is_some_and(|&j: &usize| beats(x, values[j])) {
                queue.pop_back();
            }
            queue.push_back(i);
        }
        if queue.front().is_some_and(|&j| i - j >= period) {
            queue.pop_front();
        }
        if i >= start {
            out[i - start] = match queue.front() {
                Some(&j) if i + 1 >= period => values[j],
                _ => f64::NAN,
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Noisy input with gaps, runs of gaps, signed zeros, stored
    /// infinities (read as gaps) and values near 1e15, where a sum that kept its history would drift.
    fn noisy(n: usize) -> Vec<f64> {
        let mut x = 0x9E37_79B9_7F4A_7C15u64;
        (0..n)
            .map(|i| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                let r = (x % 1_000_003) as f64 / 7.0;
                match i {
                    _ if (300..340).contains(&i) => f64::NAN,
                    _ if x % 23 == 0 => f64::NAN,
                    _ if x % 97 == 0 => -0.0,
                    _ if i % 1000 == 999 => 0.0,
                    _ if i % 701 == 700 => f64::INFINITY,
                    _ if i % 977 == 976 => f64::NEG_INFINITY,
                    _ if (2000..2600).contains(&i) => 1e15 + r,
                    _ => r - 70_000.0,
                }
            })
            .collect()
    }

    fn same_bits(a: &[f64], b: &[f64]) -> bool {
        a.len() == b.len()
            && a.iter()
                .zip(b)
                .all(|(x, y)| x.to_bits() == y.to_bits() || (x.is_nan() && y.is_nan()))
    }

    /// Cut into stretches of any size, a column comes out with the same
    /// bits as in one sweep: what makes running the stretches on several
    /// cores safe.
    #[test]
    fn stretches_give_the_same_bits_as_one_sweep() {
        let values = noisy(3_000);
        let n = values.len();
        for period in [1, 2, 3, 7, 20, 64, 500, 3_001] {
            let mean = mean_sd_chunked::<false>(&values, period, n).0;
            let (sd_mean, sd) = mean_sd_chunked::<true>(&values, period, n);
            let wma = wma_chunked(&values, period, n);
            let min = extreme_chunked::<false>(&values, period, n);
            let max = extreme_chunked::<true>(&values, period, n);
            for chunk in [1, 2, 3, 5, 19, 64, 999, 2_999] {
                let label = format!("period {period}, stretch {chunk}");
                assert!(
                    same_bits(&mean, &mean_sd_chunked::<false>(&values, period, chunk).0),
                    "mean {label}"
                );
                let (m, s) = mean_sd_chunked::<true>(&values, period, chunk);
                assert!(same_bits(&sd_mean, &m) && same_bits(&sd, &s), "sd {label}");
                assert!(
                    same_bits(&wma, &wma_chunked(&values, period, chunk)),
                    "wma {label}"
                );
                assert!(
                    same_bits(&min, &extreme_chunked::<false>(&values, period, chunk)),
                    "min {label}"
                );
                assert!(
                    same_bits(&max, &extreme_chunked::<true>(&values, period, chunk)),
                    "max {label}"
                );
            }
        }
    }
}
