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
    let n = values.len();
    let mut mean = vec![f64::NAN; n];
    let mut sd = want_sd.then(|| vec![f64::NAN; n]);
    let (mut window_start, mut window_end) = (0usize, 0usize);
    let mut anchor = 0.0;
    let mut shifted_sum = 0.0;
    let mut count = 0usize;
    let mut spread = Spread::default();
    // `i % period == 0`, without a division per row.
    let mut next_rebuild = 0usize;

    for i in 0..n {
        let lo = (i + 1).saturating_sub(period);
        while window_end <= i {
            let x = values[window_end];
            if x.is_finite() {
                let y = x - anchor;
                shifted_sum += y;
                count += 1;
                if want_sd {
                    spread.add(y);
                }
            }
            window_end += 1;
        }
        while window_start < lo {
            let x = values[window_start];
            if x.is_finite() {
                let y = x - anchor;
                shifted_sum -= y;
                count -= 1;
                if want_sd {
                    spread.remove(y);
                }
            }
            window_start += 1;
        }

        if i == next_rebuild {
            next_rebuild += period;
            let at = values[i];
            anchor = if at.is_finite() { at } else { 0.0 };
            shifted_sum = 0.0;
            count = 0;
            spread = Spread::default();
            for &x in &values[window_start..window_end] {
                if !x.is_finite() {
                    continue;
                }
                let y = x - anchor;
                shifted_sum += y;
                count += 1;
                if want_sd {
                    spread.add(y);
                }
            }
        }

        if window_end - window_start < period || count == 0 {
            continue;
        }
        mean[i] = anchor + shifted_sum / count as f64;
        if let Some(sd) = sd.as_mut() {
            sd[i] = spread.sd();
        }
    }
    (mean, sd)
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

        since_anchor += 1;
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
    let seed_at = first + period - 1;
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
    let n = values.len();
    let mut out = vec![f64::NAN; n];
    let p = period as f64;
    let denominator = (p * (p + 1.0)) / 2.0;
    let mut sum = 0.0;
    let mut weighted = 0.0;
    let mut missing = 0usize;
    let mut next_rebuild = 0usize; // `i % period == 0`, as above

    for i in 0..n {
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
        }

        if i + 1 >= period && missing == 0 {
            out[i] = weighted / denominator;
        }
    }
    out
}

fn dema_values(values: &[f64], period: usize) -> Vec<f64> {
    let first = ema_values(values, period);
    let second = ema_values(&first, period);
    first
        .iter()
        .zip(&second)
        .map(|(&a, &b)| 2.0 * a - b)
        .collect()
}

fn tema_values(values: &[f64], period: usize) -> Vec<f64> {
    let first = ema_values(values, period);
    let second = ema_values(&first, period);
    let third = ema_values(&second, period);
    (0..values.len())
        .map(|i| 3.0 * first[i] - 3.0 * second[i] + third[i])
        .collect()
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
    let fast = wma_values(values, half);
    let slow = wma_values(values, period);
    let raw: Vec<f64> = fast.iter().zip(&slow).map(|(&f, &s)| 2.0 * f - s).collect();
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
    let seed_at = first + period;
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
