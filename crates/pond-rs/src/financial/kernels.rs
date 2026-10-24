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
/// wherever the window holds a gap or is not yet full. Split across cores
/// like it, same bits.
pub(crate) fn rolling_mean_values(values: &[f64], period: usize) -> Vec<f64> {
    rolling_mean_values_chunked(values, period, chunk_rows(period))
}

fn rolling_mean_values_chunked(values: &[f64], period: usize, chunk: usize) -> Vec<f64> {
    let mut out = vec![0.0; values.len()];
    crate::par::fill_chunks(&mut out, &mut [], chunk, |start, out, _| {
        rolling_mean_values_into(values, period, start, out)
    });
    out
}

/// [`rolling_mean_values`] for rows `start..start + out.len()`. Reads rows
/// from [`mean_values_reads_from`]`(start, period)` on, so a caller may
/// pass `values` with the rows before that cut off (and `start` shifted
/// down to match): that cut is a multiple of `period`, so the rows where
/// the sums are rebuilt stay the same.
pub(crate) fn rolling_mean_values_into(
    values: &[f64],
    period: usize,
    start: usize,
    out: &mut [f64],
) {
    mean_sd_into::<false>(values, period, start, out, &mut []);
    // Gaps in the window [i + 1 - period, i].
    let from = (start + 1).saturating_sub(period);
    let mut missing = values[from..start]
        .iter()
        .filter(|v| !v.is_finite())
        .count();
    for (k, o) in out.iter_mut().enumerate() {
        let i = start + k;
        if !values[i].is_finite() {
            missing += 1;
        }
        if i + 1 < period || missing > 0 {
            *o = f64::NAN;
        }
        if i + 1 >= period && !values[i + 1 - period].is_finite() {
            missing -= 1;
        }
    }
}

/// The first row [`rolling_mean_values_into`] reads for rows from
/// `start`: the window before the last rebuild row at or before `start`,
/// rounded down to a multiple of `period`.
pub(crate) fn mean_values_reads_from(start: usize, period: usize) -> usize {
    (start / period * period + 1).saturating_sub(period) / period * period
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
    wilder_values_from(values, period, 0)
}

/// [`wilder_values`] reading from row `start` on (pond-ts `wilderValues`'
/// `start`): rows before it are skipped like leading gaps.
pub(crate) fn wilder_values_from(values: &[f64], period: usize, start: usize) -> Vec<f64> {
    let n = values.len();
    let mut out = vec![f64::NAN; n];
    let first = values
        .iter()
        .skip(start)
        .position(|v| !v.is_nan())
        .map_or(n, |k| k + start);
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
    let mut ema = Ema::new(alpha, min_samples);
    values.iter().map(|&raw| ema.push(raw)).collect()
}

/// The `period`-bar EMA: alpha `2 / (period + 1)`, a gap until `period`
/// values have been read.
pub(crate) fn ema_values(values: &[f64], period: usize) -> Vec<f64> {
    alpha_ema_values(values, 2.0 / (period as f64 + 1.0), period)
}

/// [`alpha_ema_values`] one row at a time, so studies that chain several
/// averages can run them in one pass over the rows (no column in between,
/// and the chains overlap in the processor). The same operations in the
/// same order, so the same bits.
#[derive(Debug, Clone)]
pub(crate) struct Ema {
    alpha: f64,
    min_samples: usize,
    previous: f64,
    seeded: bool,
    seen: usize,
}

impl Ema {
    pub(crate) fn new(alpha: f64, min_samples: usize) -> Self {
        Self {
            alpha,
            min_samples,
            previous: 0.0,
            seeded: false,
            seen: 0,
        }
    }

    /// The `period`-bar EMA ([`ema_values`]).
    pub(crate) fn period(period: usize) -> Self {
        Self::new(2.0 / (period as f64 + 1.0), period)
    }

    /// Reads the next row's value and gives that row's average.
    #[inline]
    pub(crate) fn push(&mut self, raw: f64) -> f64 {
        if !raw.is_finite() {
            return f64::NAN;
        }
        self.previous = if self.seeded {
            self.alpha * raw + (1.0 - self.alpha) * self.previous
        } else {
            raw
        };
        self.seeded = true;
        self.seen += 1;
        if self.seen >= self.min_samples {
            self.previous
        } else {
            f64::NAN
        }
    }
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
    // One pass: the second EMA reads the first row by row.
    let mut e1 = Ema::period(period);
    let mut e2 = e1.clone();
    values
        .iter()
        .map(|&v| {
            let a = e1.push(v);
            2.0 * a - e2.push(a)
        })
        .collect()
}

fn tema_values(values: &[f64], period: usize) -> Vec<f64> {
    let mut e1 = Ema::period(period);
    let (mut e2, mut e3) = (e1.clone(), e1.clone());
    values
        .iter()
        .map(|&v| {
            let a = e1.push(v);
            let b = e2.push(a);
            // (3a - 3b) + c, as pond-ts adds it.
            e3.push(b) + (3.0 * a - 3.0 * b)
        })
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

/// The moving average a study takes from a column (pond-ts
/// `movingAverageColumn`): `Sma` keeps [`rolling_mean_sd`]'s row-counting
/// window, so it is exactly `sma()`; every other type is
/// [`moving_average_values`].
pub(crate) fn ma_column(values: &[f64], period: usize, kind: MaType) -> Vec<f64> {
    match kind {
        MaType::Sma => rolling_mean_sd(values, period, false).0,
        other => moving_average_values(values, period, other),
    }
}

/// pond-ts `percentChangeValues`: the percent change from `periods` rows
/// back, `(value / previous - 1) * 100`; a gap for the first `periods`
/// rows and where the earlier value is zero or a gap.
pub(crate) fn percent_change_values(values: &[f64], periods: usize) -> Vec<f64> {
    (0..values.len())
        .map(|i| percent_change_at(values, periods, i))
        .collect()
}

/// Row `i` of [`percent_change_values`].
pub(crate) fn percent_change_at(values: &[f64], periods: usize, i: usize) -> f64 {
    if i < periods {
        return f64::NAN;
    }
    percent_change(values[i - periods], values[i])
}

/// `(value / previous - 1) * 100`, or a gap when `previous` is zero.
#[inline]
pub(crate) fn percent_change(previous: f64, value: f64) -> f64 {
    if previous == 0.0 {
        f64::NAN
    } else {
        (value / previous - 1.0) * 100.0
    }
}

/// pond-ts `rollingExtremesValues`: the highest and lowest of each
/// `period`-row window, a gap until the window is full and wherever it
/// holds a gap (the strict rule for a derived input). Of equal values the
/// latest wins (only `-0` and `0` can tell).
///
/// pond-ts keeps a queue of candidates; this gives the same values by
/// van Herk / Gil-Werman blocks: cut the rows into blocks of `period`,
/// keep each block's running best from its start (`prefix`) and from its
/// end (`suffix`); a window is then one block's suffix and the next one's
/// prefix. Three comparisons a row whatever the data, and a stretch of
/// rows needs only its own blocks, so stretches run on separate cores.
pub(crate) fn rolling_extremes_strict(values: &[f64], period: usize) -> (Vec<f64>, Vec<f64>) {
    extremes_strict_chunked(values, period, chunk_rows(period))
}

fn extremes_strict_chunked(values: &[f64], period: usize, chunk: usize) -> (Vec<f64>, Vec<f64>) {
    let n = values.len();
    let mut highest = vec![0.0; n];
    let mut lowest = vec![0.0; n];
    crate::par::fill_chunks(&mut highest, &mut lowest, chunk, |start, high, low| {
        extremes_strict_into(values, period, start, high, low)
    });
    (highest, lowest)
}

fn extremes_strict_into(
    values: &[f64],
    period: usize,
    start: usize,
    high: &mut [f64],
    low: &mut [f64],
) {
    let end = start + high.len();
    // The first window this stretch reads starts here; blocks are aligned
    // to multiples of `period` from row 0.
    let from = (start + 1).saturating_sub(period);
    let base = from / period * period;
    let len = end - base;
    // Running bests within each block: from its start (`pre_*`) and from
    // its end (`suf_*`). Later rows win ties.
    let (mut pre_hi, mut pre_lo) = (vec![0.0; len], vec![0.0; len]);
    let (mut suf_hi, mut suf_lo) = (vec![0.0; len], vec![0.0; len]);
    for block in (base..end).step_by(period) {
        let stop = block.saturating_add(period).min(end);
        let (mut h, mut l) = (values[block], values[block]);
        for i in block..stop {
            let v = values[i];
            if v >= h {
                h = v;
            }
            if v <= l {
                l = v;
            }
            pre_hi[i - base] = h;
            pre_lo[i - base] = l;
        }
        let (mut h, mut l) = (values[stop - 1], values[stop - 1]);
        for i in (block..stop).rev() {
            let v = values[i];
            if v > h {
                h = v;
            }
            if v < l {
                l = v;
            }
            suf_hi[i - base] = h;
            suf_lo[i - base] = l;
        }
    }
    // Gaps in the current window [i + 1 - period, i].
    let mut missing = values[from..start]
        .iter()
        .filter(|v| !v.is_finite())
        .count();
    for i in start..end {
        if !values[i].is_finite() {
            missing += 1;
        }
        let k = i - start;
        if i + 1 < period || missing > 0 {
            high[k] = f64::NAN;
            low[k] = f64::NAN;
        } else {
            // The window is the suffix of `first`'s block and the prefix of
            // `i`'s (the same block, read twice, when `first` starts one).
            // The suffix part is earlier, so the prefix wins ties.
            let first = i + 1 - period;
            let (ph, pl) = (pre_hi[i - base], pre_lo[i - base]);
            let (sh, sl) = (suf_hi[first - base], suf_lo[first - base]);
            high[k] = if sh > ph { sh } else { ph };
            low[k] = if sl < pl { sl } else { pl };
        }
        if i + 1 >= period && !values[i + 1 - period].is_finite() {
            missing -= 1;
        }
    }
}

/// pond-ts `percentOfRangeValues`: where `value` sits in `[lowest,
/// highest]`, 0 to 100; a gap for an empty range.
#[inline]
pub(crate) fn percent_of_range(highest: f64, lowest: f64, value: f64) -> f64 {
    let range = highest - lowest;
    if range == 0.0 {
        f64::NAN
    } else {
        (100.0 * (value - lowest)) / range
    }
}

/// The Schaff trend cycle's step, in one pass: [`percent_of_range`] of
/// each value over its window's highest and lowest, then pond-ts's
/// `foldRows` half-smoothing of that: within each run of values, the
/// first is kept as it is and each later one moves halfway from the
/// previous output toward it. A gap row gets a gap and starts a new run.
pub(crate) fn stochastic_half_smooth(highest: &[f64], lowest: &[f64], values: &[f64]) -> Vec<f64> {
    let mut out = vec![0.0; values.len()];
    let mut previous = f64::NAN;
    let mut run = 0usize;
    for (i, o) in out.iter_mut().enumerate() {
        let raw = percent_of_range(highest[i], lowest[i], values[i]);
        if raw.is_nan() {
            run = 0;
            *o = f64::NAN;
            continue;
        }
        run += 1;
        previous = if run == 1 {
            raw
        } else {
            previous + 0.5 * (raw - previous)
        };
        *o = previous;
    }
    out
}

/// JS `Math.sign(x)`: a NaN gives NaN and a zero keeps its sign (Rust's
/// `f64::signum` gives 1 for `+0`).
pub(crate) fn js_sign(x: f64) -> f64 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        x
    }
}

/// pond-ts `cumulativeValues`: the running total, a gap until the first
/// value that is not a gap; a gap after that makes every later total a
/// gap.
pub(crate) fn cumulative_values(values: &[f64]) -> Vec<f64> {
    let first = values
        .iter()
        .position(|v| !v.is_nan())
        .unwrap_or(values.len());
    let mut out = vec![f64::NAN; values.len()];
    let mut sum = 0.0;
    for (o, &v) in out[first..].iter_mut().zip(&values[first..]) {
        sum += v;
        *o = sum;
    }
    out
}

/// pond-ts `clvValues`: where the close sits in its bar, from -1 (the
/// low) to +1 (the high); 0 for a bar with no range and a close.
pub(crate) fn clv_values(high: &[f64], low: &[f64], close: &[f64]) -> Vec<f64> {
    (0..high.len())
        .map(|i| clv(high[i], low[i], close[i]))
        .collect()
}

/// One row of [`clv_values`].
#[inline]
pub(crate) fn clv(high: f64, low: f64, close: f64) -> f64 {
    let range = high - low;
    if range == 0.0 {
        if close.is_nan() { f64::NAN } else { 0.0 }
    } else {
        (2.0 * close - high - low) / range
    }
}

/// pond-ts `moneyFlowVolumeValues`: [`clv_values`] times the volume.
pub(crate) fn money_flow_volume_values(
    high: &[f64],
    low: &[f64],
    close: &[f64],
    volume: &[f64],
) -> Vec<f64> {
    let mut clv = clv_values(high, low, close);
    for (c, v) in clv.iter_mut().zip(volume) {
        *c *= v;
    }
    clv
}

/// JS `Math.max(a, b)`: a NaN gives NaN, and `+0` beats `-0` (Rust's
/// `f64::max` drops a NaN and may pick either zero).
pub(crate) fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b || (a == b && b.is_sign_negative()) {
        a
    } else {
        b
    }
}

/// JS `Math.min(a, b)`: a NaN gives NaN, and `-0` beats `+0`.
pub(crate) fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b || (a == b && a.is_sign_negative()) {
        a
    } else {
        b
    }
}

/// JS `Math.log`: V8 computes it with fdlibm's `__ieee754_log` (its
/// `base::ieee754::log`), which can differ from the system's `f64::ln` in
/// the last bit. This is that routine, step for step.
#[allow(clippy::excessive_precision)] // fdlibm's constants, as written there
pub(crate) fn js_log(x: f64) -> f64 {
    const LN2_HI: f64 = 6.931_471_803_691_238_164_90e-01;
    const LN2_LO: f64 = 1.908_214_929_270_587_700_02e-10;
    const TWO54: f64 = 1.801_439_850_948_198_400_00e+16;
    const LG1: f64 = 6.666_666_666_666_735_130e-01;
    const LG2: f64 = 3.999_999_999_940_941_908e-01;
    const LG3: f64 = 2.857_142_874_366_239_149e-01;
    const LG4: f64 = 2.222_219_843_214_978_396e-01;
    const LG5: f64 = 1.818_357_216_161_805_012e-01;
    const LG6: f64 = 1.531_383_769_920_937_332e-01;
    const LG7: f64 = 1.479_819_860_511_658_591e-01;
    let high = |v: f64| (v.to_bits() >> 32) as i32;
    let mut x = x;
    let mut hx = high(x);
    let lx = x.to_bits() as u32;
    let mut k: i32 = 0;
    if hx < 0x0010_0000 {
        // Below 2^-1022: zero, negative or subnormal.
        if ((hx & 0x7fff_ffff) as u32 | lx) == 0 {
            return f64::NEG_INFINITY;
        }
        if hx < 0 {
            return f64::NAN;
        }
        k -= 54;
        x *= TWO54;
        hx = high(x);
    }
    if hx >= 0x7ff0_0000 {
        return x + x;
    }
    k += (hx >> 20) - 1023;
    hx &= 0x000f_ffff;
    let i = (hx + 0x95f64) & 0x0010_0000;
    // Normalize x or x / 2: replace the high word.
    let top = (hx | (i ^ 0x3ff0_0000)) as u32 as u64;
    x = f64::from_bits((top << 32) | (x.to_bits() & 0xffff_ffff));
    k += i >> 20;
    let f = x - 1.0;
    if (0x000f_ffff & (2 + hx)) < 3 {
        // |f| < 2^-20.
        if f == 0.0 {
            if k == 0 {
                return 0.0;
            }
            let dk = k as f64;
            return dk * LN2_HI + dk * LN2_LO;
        }
        let r = f * f * (0.5 - 0.333_333_333_333_333_33 * f);
        if k == 0 {
            return f - r;
        }
        let dk = k as f64;
        return dk * LN2_HI - ((r - dk * LN2_LO) - f);
    }
    let s = f / (2.0 + f);
    let dk = k as f64;
    let z = s * s;
    let mut i = hx - 0x6147a;
    let w = z * z;
    let j = 0x6b851 - hx;
    let t1 = w * (LG2 + w * (LG4 + w * LG6));
    let t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
    i |= j;
    let r = t2 + t1;
    if i > 0 {
        let hfsq = 0.5 * f * f;
        if k == 0 {
            f - (hfsq - s * (hfsq + r))
        } else {
            dk * LN2_HI - ((hfsq - (s * (hfsq + r) + dk * LN2_LO)) - f)
        }
    } else if k == 0 {
        f - s * (f - r)
    } else {
        dk * LN2_HI - ((s * (f - r) - dk * LN2_LO) - f)
    }
}

/// JS `Math.log10`: V8's `base::ieee754::log10`, fdlibm's
/// `__ieee754_log10` (scale to `[1, 2)`, then
/// `k·log10(2) + log(x)/ln(10)` in split constants), step for step on top
/// of [`js_log`]. The system `log10` can differ in the last bit.
// fdlibm's constants, as written there (`IVLN10` is `1 / ln 10`).
#[allow(clippy::excessive_precision, clippy::approx_constant)]
pub(crate) fn js_log10(x: f64) -> f64 {
    const TWO54: f64 = 1.801_439_850_948_198_400_00e+16;
    const IVLN10: f64 = 4.342_944_819_032_518_166_68e-01;
    const LOG10_2HI: f64 = 3.010_299_956_636_117_713_06e-01;
    const LOG10_2LO: f64 = 3.694_239_077_158_930_786_16e-13;
    let high = |v: f64| (v.to_bits() >> 32) as i32;
    let mut x = x;
    let mut hx = high(x);
    let lx = x.to_bits() as u32;
    let mut k: i32 = 0;
    if hx < 0x0010_0000 {
        // Below 2^-1022: zero, negative or subnormal.
        if ((hx & 0x7fff_ffff) as u32 | lx) == 0 {
            return f64::NEG_INFINITY;
        }
        if hx < 0 {
            return f64::NAN;
        }
        k -= 54;
        x *= TWO54;
        hx = high(x);
    }
    if hx >= 0x7ff0_0000 {
        return x + x;
    }
    k += (hx >> 20) - 1023;
    let i = ((k as u32) & 0x8000_0000) >> 31;
    let top = ((hx & 0x000f_ffff) as u32 | ((0x3ff - i) << 20)) as u64;
    let y = f64::from(k + i as i32);
    x = f64::from_bits((top << 32) | (x.to_bits() & 0xffff_ffff));
    let z = y * LOG10_2LO + IVLN10 * js_log(x);
    z + y * LOG10_2HI
}

/// JS `Math.atan`: V8's `base::ieee754::atan`, fdlibm's `atan` (reduce to
/// one of five intervals, then an odd polynomial), step for step. The
/// system `atan` can differ in the last bit.
#[allow(clippy::excessive_precision, clippy::approx_constant)] // fdlibm's constants
pub(crate) fn js_atan(x: f64) -> f64 {
    const ATANHI: [f64; 4] = [
        4.636_476_090_008_060_935_15e-01,
        7.853_981_633_974_482_789_99e-01,
        9.827_937_232_473_290_540_82e-01,
        1.570_796_326_794_896_558_00e+00,
    ];
    const ATANLO: [f64; 4] = [
        2.269_877_745_296_168_709_24e-17,
        3.061_616_997_868_383_017_93e-17,
        1.390_331_103_123_099_845_16e-17,
        6.123_233_995_736_766_035_87e-17,
    ];
    const AT: [f64; 11] = [
        3.333_333_333_333_293_180_27e-01,
        -1.999_999_999_987_648_324_76e-01,
        1.428_571_427_250_346_637_11e-01,
        -1.111_111_040_546_235_578_80e-01,
        9.090_887_133_436_506_561_96e-02,
        -7.691_876_205_044_829_994_95e-02,
        6.661_073_137_387_531_206_69e-02,
        -5.833_570_133_790_573_486_45e-02,
        4.976_877_994_615_932_360_17e-02,
        -3.653_157_274_421_691_552_70e-02,
        1.628_582_011_536_578_236_23e-02,
    ];
    let hx = (x.to_bits() >> 32) as i32;
    let ix = hx & 0x7fff_ffff;
    let mut x = x;
    let id: i32;
    if ix >= 0x4410_0000 {
        // |x| >= 2^66, or NaN.
        if x.is_nan() {
            return x + x;
        }
        return if hx > 0 {
            ATANHI[3] + ATANLO[3]
        } else {
            -ATANHI[3] - ATANLO[3]
        };
    }
    if ix < 0x3fdc_0000 {
        // |x| < 0.4375.
        if ix < 0x3e40_0000 {
            // |x| < 2^-27.
            return x;
        }
        id = -1;
    } else {
        x = x.abs();
        if ix < 0x3ff3_0000 {
            if ix < 0x3fe6_0000 {
                id = 0;
                x = (2.0 * x - 1.0) / (2.0 + x);
            } else {
                id = 1;
                x = (x - 1.0) / (x + 1.0);
            }
        } else if ix < 0x4003_8000 {
            id = 2;
            x = (x - 1.5) / (1.0 + 1.5 * x);
        } else {
            id = 3;
            x = -1.0 / x;
        }
    }
    let z = x * x;
    let w = z * z;
    let s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
    let s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
    if id < 0 {
        return x - x * (s1 + s2);
    }
    let id = id as usize;
    let z = ATANHI[id] - ((x * (s1 + s2) - ATANLO[id]) - x);
    if hx < 0 { -z } else { z }
}

/// pond-ts `barRangeValues`: `high - low` for every row.
pub(crate) fn bar_range_values(high: &[f64], low: &[f64]) -> Vec<f64> {
    high.iter().zip(low).map(|(h, l)| h - l).collect()
}

/// pond-ts `trueRangeValues`: [`true_range_at`] for every row.
pub(crate) fn true_range_values(high: &[f64], low: &[f64], close: &[f64]) -> Vec<f64> {
    (0..high.len())
        .map(|i| true_range_at(high, low, close, i))
        .collect()
}

/// One change split into its rise (`d` when above zero, else 0) and its
/// fall (`-d` when below zero, else 0); a gap in both where `d` is a gap.
pub(crate) fn leg(d: f64) -> (f64, f64) {
    if d.is_nan() {
        (d, d)
    } else {
        (
            if d > 0.0 { d } else { 0.0 },
            if d < 0.0 { -d } else { 0.0 },
        )
    }
}

/// pond-ts `upDownLegValues`: [`leg`] for every change, in one pass.
pub(crate) fn up_down_legs(deltas: impl ExactSizeIterator<Item = f64>) -> (Vec<f64>, Vec<f64>) {
    let mut up = Vec::with_capacity(deltas.len());
    let mut down = Vec::with_capacity(deltas.len());
    for d in deltas {
        let (u, w) = leg(d);
        up.push(u);
        down.push(w);
    }
    (up, down)
}

/// Row-to-row change: a gap on row 0, then `v[i] - v[i - 1]`.
pub(crate) fn deltas(values: &[f64]) -> impl ExactSizeIterator<Item = f64> + '_ {
    (0..values.len()).map(|i| {
        if i == 0 {
            f64::NAN
        } else {
            values[i] - values[i - 1]
        }
    })
}

/// pond-ts `trueRangeValues` at row `i`: the largest of the bar's range
/// and the gaps from the previous close; `NaN` on row 0 and wherever an
/// input is missing.
fn true_range_at(high: &[f64], low: &[f64], close: &[f64], i: usize) -> f64 {
    if i == 0 {
        return f64::NAN;
    }
    let previous = close[i - 1];
    js_max(
        js_max(high[i] - low[i], (high[i] - previous).abs()),
        (low[i] - previous).abs(),
    )
}

/// pond-ts `atrValues`: Wilder's smoothing ([`wilder_values`]) of the
/// true range, taking each row's true range as it goes rather than
/// building the column first (same values, one pass).
pub(crate) fn atr_values(high: &[f64], low: &[f64], close: &[f64], period: usize) -> Vec<f64> {
    let n = high.len();
    let mut out = vec![f64::NAN; n];
    let range = |i: usize| true_range_at(high, low, close, i);
    let first = (1..n).find(|&i| !range(i).is_nan()).unwrap_or(n);
    let seed_at = first.saturating_add(period - 1);
    if seed_at >= n {
        return out;
    }
    let p = period as f64;
    let mut sum = 0.0;
    for i in first..=seed_at {
        sum += range(i);
    }
    let mut avg = sum / p;
    out[seed_at] = avg;
    for (i, slot) in out.iter_mut().enumerate().skip(seed_at + 1) {
        avg = (avg * (p - 1.0) + range(i)) / p;
        *slot = avg;
    }
    out
}

/// pond-ts `typicalPriceValues`: `(high + low + close) / 3`.
pub(crate) fn typical_price_values(high: &[f64], low: &[f64], close: &[f64]) -> Vec<f64> {
    (0..high.len())
        .map(|i| (high[i] + low[i] + close[i]) / 3.0)
        .collect()
}

/// pond-ts `medianPriceValues`: `(high + low) / 2`.
pub(crate) fn median_price_values(high: &[f64], low: &[f64]) -> Vec<f64> {
    high.iter().zip(low).map(|(h, l)| (h + l) / 2.0).collect()
}

/// pond-ts `MAX_PRIME_INPUT` (`Number.MAX_SAFE_INTEGER`).
const MAX_PRIME_INPUT: u64 = (1 << 53) - 1;

/// pond-ts `isPrime`, for a whole number up to [`MAX_PRIME_INPUT`].
fn is_prime(n: u64) -> bool {
    if n < 2 {
        return false;
    }
    if n < 4 {
        return true;
    }
    if n % 2 == 0 || n % 3 == 0 {
        return false;
    }
    let mut f = 5u64;
    while f * f <= n {
        if n % f == 0 || n % (f + 2) == 0 {
            return false;
        }
        f += 6;
    }
    true
}

/// pond-ts `primeAtOrAbove`: the smallest prime `>= x`; `NaN` outside
/// `[2, MAX_PRIME_INPUT]` or when no prime up to that limit qualifies.
#[cfg(test)]
pub(crate) fn prime_at_or_above(x: f64) -> f64 {
    if !x.is_finite() || x < 2.0 || x > MAX_PRIME_INPUT as f64 {
        return f64::NAN;
    }
    prime_from(x.ceil() as u64)
}

/// The smallest prime `>= n` (`n` at least 2), or `NaN` past
/// [`MAX_PRIME_INPUT`].
fn prime_from(n: u64) -> f64 {
    (n..=MAX_PRIME_INPUT)
        .find(|&n| is_prime(n))
        .map_or(f64::NAN, |n| n as f64)
}

/// pond-ts `primeAtOrBelow`: the largest prime `<= x`; `NaN` outside
/// `[2, MAX_PRIME_INPUT]`.
#[cfg(test)]
pub(crate) fn prime_at_or_below(x: f64) -> f64 {
    if !x.is_finite() || x < 2.0 || x > MAX_PRIME_INPUT as f64 {
        return f64::NAN;
    }
    prime_to(x.floor() as u64)
}

/// The largest prime `<= n` (`n` at least 2).
fn prime_to(n: u64) -> f64 {
    (2..=n)
        .rev()
        .find(|&n| is_prime(n))
        .map_or(f64::NAN, |n| n as f64)
}

/// pond-ts `nearestPrime`: the prime nearest `x`, the lower one on a tie;
/// a gap outside the prime ladder (both sides are gaps there, and a
/// comparison with a gap picks the upper one, as in pond-ts).
#[cfg(test)]
pub(crate) fn nearest_prime(x: f64) -> f64 {
    let below = prime_at_or_below(x);
    let above = prime_at_or_above(x);
    if x - below <= above - x { below } else { above }
}

/// Remembers recent prime searches, keyed by the whole number a search
/// starts from. Prices revisit the same few whole numbers row after row,
/// so most rows find their prime here rather than by trial division. The
/// answers are those of pond-ts `primeAtOrAbove`, `primeAtOrBelow` and
/// `nearestPrime` (the test-only functions above are their line-by-line
/// port, kept as the reference a test checks the memo against).
pub(crate) struct PrimeMemo {
    above: Vec<(u64, f64)>,
    below: Vec<(u64, f64)>,
}

/// `x.floor()` for `x` in `[2, MAX_PRIME_INPUT]`, by truncation to a
/// signed integer: one instruction, where `floor` and `ceil` are library
/// calls on x86 cores without SSE4.1 (Rust's default target) and a cast
/// straight to unsigned takes several. Exact, as every whole number in
/// that range is a double.
#[inline]
fn whole_part(x: f64) -> u64 {
    x as i64 as u64
}

/// Slots in each [`PrimeMemo`] table (a power of two).
const PRIME_MEMO_SLOTS: usize = 1024;

impl PrimeMemo {
    pub(crate) fn new() -> Self {
        // No search starts below 2, so key 0 marks an empty slot.
        PrimeMemo {
            above: vec![(0, 0.0); PRIME_MEMO_SLOTS],
            below: vec![(0, 0.0); PRIME_MEMO_SLOTS],
        }
    }

    /// pond-ts `primeAtOrAbove`: the smallest prime `>= x`; `NaN` outside
    /// `[2, MAX_PRIME_INPUT]` or when no prime up to that limit qualifies.
    pub(crate) fn at_or_above(&mut self, x: f64) -> f64 {
        if !x.is_finite() || x < 2.0 || x > MAX_PRIME_INPUT as f64 {
            return f64::NAN;
        }
        let n = whole_part(x);
        let n = n + u64::from((n as i64 as f64) < x);
        let slot = &mut self.above[n as usize & (PRIME_MEMO_SLOTS - 1)];
        if slot.0 != n {
            *slot = (n, prime_from(n));
        }
        slot.1
    }

    /// pond-ts `primeAtOrBelow`: the largest prime `<= x`; `NaN` outside
    /// `[2, MAX_PRIME_INPUT]`.
    pub(crate) fn at_or_below(&mut self, x: f64) -> f64 {
        if !x.is_finite() || x < 2.0 || x > MAX_PRIME_INPUT as f64 {
            return f64::NAN;
        }
        let n = whole_part(x);
        let slot = &mut self.below[n as usize & (PRIME_MEMO_SLOTS - 1)];
        if slot.0 != n {
            *slot = (n, prime_to(n));
        }
        slot.1
    }

    /// pond-ts `nearestPrime`: the prime nearest `x`, the lower one on a
    /// tie; a gap outside the prime ladder.
    pub(crate) fn nearest(&mut self, x: f64) -> f64 {
        let below = self.at_or_below(x);
        let above = self.at_or_above(x);
        if x - below <= above - x { below } else { above }
    }
}

/// pond-ts `rollingMeanAbsDevValues`: each full, gap-free window's mean
/// distance from its own mean (a gap elsewhere). O(N·period); rows stand
/// alone once the means are known, so stretches run on separate cores.
pub(crate) fn rolling_mean_abs_dev_values(values: &[f64], period: usize) -> Vec<f64> {
    let mean = rolling_mean_values(values, period);
    let p = period as f64;
    let mut out = vec![0.0; values.len()];
    crate::par::fill_chunks(&mut out, &mut [], 1 << 14, |start, out, _| {
        for (k, o) in out.iter_mut().enumerate() {
            let i = start + k;
            let m = mean[i];
            if m.is_nan() {
                *o = f64::NAN;
                continue;
            }
            let mut sum = 0.0;
            for &v in &values[i + 1 - period..=i] {
                sum += (v - m).abs();
            }
            *o = sum / p;
        }
    });
    out
}

/// pond-ts `symmetricWeightedValues`: the 4-bar symmetric weighted mean
/// (weights 1, 2, 2, 1 from the current bar back, over 6); a gap for the
/// first 3 rows, and a gap in the window gives a gap.
pub(crate) fn symmetric_weighted_values(values: &[f64]) -> Vec<f64> {
    const WEIGHTS: [f64; 4] = [1.0, 2.0, 2.0, 1.0];
    (0..values.len())
        .map(|i| {
            if i < 3 {
                return f64::NAN;
            }
            let mut sum = 0.0;
            for (k, w) in WEIGHTS.iter().enumerate() {
                sum += w * values[i - k];
            }
            sum / 6.0
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// JS `Math.max`: NaN wins, `+0` beats `-0` in either order.
    #[test]
    fn js_max_matches_math_max() {
        assert!(js_max(f64::NAN, 1.0).is_nan());
        assert!(js_max(1.0, f64::NAN).is_nan());
        for (a, b) in [(-0.0, 0.0), (0.0, -0.0)] {
            let m = js_max(a, b);
            assert!(m == 0.0 && m.is_sign_positive(), "{a:?} {b:?}");
        }
        assert!(js_max(-0.0, -0.0).is_sign_negative());
        assert_eq!(js_max(-1.0, 2.0), 2.0);
        assert_eq!(js_max(3.0, 2.0), 3.0);
    }

    /// JS `Math.min`: NaN wins, `-0` beats `+0` in either order.
    #[test]
    fn js_min_matches_math_min() {
        assert!(js_min(f64::NAN, 1.0).is_nan());
        assert!(js_min(1.0, f64::NAN).is_nan());
        for (a, b) in [(-0.0, 0.0), (0.0, -0.0)] {
            let m = js_min(a, b);
            assert!(m == 0.0 && m.is_sign_negative(), "{a:?} {b:?}");
        }
        assert!(js_min(0.0, 0.0).is_sign_positive());
        assert_eq!(js_min(-1.0, 2.0), -1.0);
        assert_eq!(js_min(3.0, 2.0), 2.0);
    }

    /// A `-0` change is neither a rise nor a fall: both legs are `+0`, as
    /// pond-ts's `d > 0 ? d : 0` gives.
    #[test]
    fn up_down_legs_split_changes() {
        let (up, down) = up_down_legs([f64::NAN, 2.0, -3.0, -0.0, 0.0].into_iter());
        assert!(up[0].is_nan() && down[0].is_nan());
        assert_eq!((up[1], down[1]), (2.0, 0.0));
        assert_eq!((up[2], down[2]), (0.0, 3.0));
        for i in 3..5 {
            assert!(up[i] == 0.0 && up[i].is_sign_positive(), "up {i}");
            assert!(down[i] == 0.0 && down[i].is_sign_positive(), "down {i}");
        }
    }

    /// `js_log` gives V8's `Math.log` bits. Checked against node on 2M
    /// values (0 differ; the system `ln` differed on 2%); these are inputs
    /// where the system `ln` is one bit off V8.
    #[test]
    fn js_log_matches_v8() {
        for (x, expected) in [
            (0x3fe3b61b4e436ffe_u64, 0xbfdf02b8973ca408_u64),
            (0x40a3452893a2f8c3, 0x401f3e0aa9bcec18),
            (0x40aa9d835d743864, 0x4020445c3465a0be),
            (0x4004c8faecb2f9c3, 0x3fee8dabc63fc0b2),
            (0x3fd804e64e9be505, 0xbfef5c6c4963f868),
            (0x3fe73b191af10b2e, 0xbfd47f0d84498a5a),
        ] {
            assert_eq!(js_log(f64::from_bits(x)).to_bits(), expected, "{x:#x}");
        }
        assert_eq!(js_log(1.0).to_bits(), 0.0f64.to_bits());
        assert_eq!(js_log(0.0), f64::NEG_INFINITY);
        assert_eq!(js_log(-0.0), f64::NEG_INFINITY);
        assert!(js_log(-1.0).is_nan() && js_log(f64::NAN).is_nan());
        assert_eq!(js_log(f64::INFINITY), f64::INFINITY);
        assert_eq!(js_log(5e-324), -744.4400719213812);
        assert_eq!(js_log(2.0), std::f64::consts::LN_2);
    }

    /// `js_log10` gives V8's `Math.log10` bits. Checked against node on 2M
    /// values (0 differ; the system `log10` differed on 4,111); these are
    /// prices where the system `log10` is one bit off V8, and values below
    /// 1 where scaling into `[1, 2)` instead would be.
    #[test]
    fn js_log10_matches_v8() {
        for (x, expected) in [
            (0x404ef9ee80000000_u64, 0x3ffcac468e0d0b52_u64),
            (0x4064a807be000000, 0x4001bec2419b9366),
            (0x403b436b40000000, 0x3ff6f82200bcfc2f),
            (0x405b9defe8000000, 0x4000588be50e726e),
            (0x4057a2b9f0000000, 0x3fff9c2b9e709c57),
            (0x405a704df0000000, 0x400031c426e5334b),
            // Below 1, where fdlibm scales into [0.5, 1) rather than [1, 2).
            (0x3febbc6400000000, 0xbfafcc94a77f77ce),
            (0x3fe3d46a80000000, 0xbfca9a435e71c76b),
            (0x3fe286c600000000, 0xbfce61bb91084ed2),
        ] {
            assert_eq!(js_log10(f64::from_bits(x)).to_bits(), expected, "{x:#x}");
        }
        for (x, expected) in [(1.0, 0.0), (10.0, 1.0), (1000.0, 3.0), (1e308, 308.0)] {
            assert_eq!(js_log10(x).to_bits(), f64::to_bits(expected), "{x}");
        }
        assert_eq!(js_log10(0.0), f64::NEG_INFINITY);
        assert_eq!(js_log10(-0.0), f64::NEG_INFINITY);
        assert!(js_log10(-1.0).is_nan() && js_log10(f64::NAN).is_nan());
        assert_eq!(js_log10(f64::INFINITY), f64::INFINITY);
        assert_eq!(js_log10(5e-324), -323.3062153431158);
    }

    /// `js_atan` gives V8's `Math.atan` bits. Checked against node on 2M
    /// values (0 differ; the system `atan` differed on 29,361); these are
    /// inputs in each of fdlibm's intervals where the system `atan` is one
    /// bit off V8.
    #[test]
    fn js_atan_matches_v8() {
        for (x, expected) in [
            (0x3fcbab5a00000000_u64, 0x3fcb4003cbbac7f8_u64),
            (0xbfdeb92200000000, 0xbfdca4d3ef311f1c),
            (0xbfe70c2380000000, 0xbfe3f93f458db796),
            (0x4003874940000000, 0x3ff2e96fea2df3ba),
            (0x4003dd66c0000000, 0x3ff301d3c840404a),
            (0xc007239c20000000, 0xbff3ce8b7be24ba8),
        ] {
            assert_eq!(js_atan(f64::from_bits(x)).to_bits(), expected, "{x:#x}");
        }
        assert_eq!(js_atan(0.0).to_bits(), 0.0f64.to_bits());
        assert_eq!(js_atan(-0.0).to_bits(), (-0.0f64).to_bits());
        assert_eq!(js_atan(1.0), std::f64::consts::FRAC_PI_4);
        assert_eq!(js_atan(f64::INFINITY), std::f64::consts::FRAC_PI_2);
        assert_eq!(js_atan(f64::NEG_INFINITY), -std::f64::consts::FRAC_PI_2);
        assert!(js_atan(f64::NAN).is_nan());
        assert_eq!(js_atan(1e-9), 1e-9);
    }

    /// The prime ladder against trial division, and its edges.
    #[test]
    fn primes_match_trial_division() {
        let slow = |n: u64| n >= 2 && (2..n).take_while(|d| d * d <= n).all(|d| n % d != 0);
        for n in 0..5_000 {
            assert_eq!(is_prime(n), slow(n), "{n}");
        }
        assert_eq!(prime_at_or_above(2.0), 2.0);
        assert_eq!(prime_at_or_above(7.5), 11.0);
        assert_eq!(prime_at_or_below(7.5), 7.0);
        assert_eq!(prime_at_or_below(2.5), 2.0);
        assert!(prime_at_or_below(1.99).is_nan());
        assert!(prime_at_or_above(f64::INFINITY).is_nan());
        // The largest prime below 2^53 is 2^53 - 111; above it, none qualify.
        let largest = ((1u64 << 53) - 111) as f64;
        assert_eq!(prime_at_or_below(((1u64 << 53) - 1) as f64), largest);
        assert_eq!(prime_at_or_above(largest - 1.0), largest);
        assert!(prime_at_or_above(largest + 1.0).is_nan());
        assert!(prime_at_or_above((1u64 << 53) as f64).is_nan());
    }

    /// The memo gives the plain searches' answers, through slot clashes
    /// (keys 1024 apart), revisits, large values and off the ladder.
    #[test]
    fn prime_memo_matches_the_plain_searches() {
        let mut memo = PrimeMemo::new();
        let mut x = 0x9E37_79B9_7F4A_7C15u64;
        let largest = ((1u64 << 53) - 111) as f64;
        let mut values = vec![
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
            -0.0,
            -3.0,
            100.99999999999999,
            101.00000000000001,
            0.0,
            1.99,
            2.0,
            2.5,
            3.0,
            4.0,
            4_294_967_311.0,
            largest - 1.0,
            largest,
            largest + 1.0,
            ((1u64 << 53) - 1) as f64,
        ];
        for _ in 0..5_000 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let base = [100.0, 1124.0, 2148.0, 65_521.0][(x % 4) as usize];
            values.push(base + (x >> 40) as f64 % 50.0 / 4.0);
        }
        // Twice over, so the second pass reads remembered answers.
        for &v in values.iter().chain(&values) {
            let bits = |a: f64| if a.is_nan() { u64::MAX } else { a.to_bits() };
            assert_eq!(bits(memo.at_or_above(v)), bits(prime_at_or_above(v)), "{v}");
            assert_eq!(bits(memo.at_or_below(v)), bits(prime_at_or_below(v)), "{v}");
            assert_eq!(bits(memo.nearest(v)), bits(nearest_prime(v)), "{v}");
        }
    }

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
            let masked = rolling_mean_values_chunked(&values, period, n);
            let min = extreme_chunked::<false>(&values, period, n);
            let max = extreme_chunked::<true>(&values, period, n);
            for chunk in [1, 2, 3, 5, 19, 64, 999, 2_999] {
                let label = format!("period {period}, stretch {chunk}");
                assert!(
                    same_bits(&mean, &mean_sd_chunked::<false>(&values, period, chunk).0),
                    "mean {label}"
                );
                assert!(
                    same_bits(
                        &masked,
                        &rolling_mean_values_chunked(&values, period, chunk)
                    ),
                    "masked mean {label}"
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

    /// pond-ts `rollingExtremesValues` as written there (a queue of
    /// candidates; later equal values push earlier ones out).
    fn strict_extremes_queue(values: &[f64], period: usize) -> (Vec<f64>, Vec<f64>) {
        let n = values.len();
        let (mut highest, mut lowest) = (vec![f64::NAN; n], vec![f64::NAN; n]);
        let (mut maxq, mut minq) = (
            std::collections::VecDeque::new(),
            std::collections::VecDeque::new(),
        );
        let mut missing = 0usize;
        for (i, &value) in values.iter().enumerate() {
            if i >= period && !values[i - period].is_finite() {
                missing -= 1;
            }
            if !value.is_finite() {
                missing += 1;
            }
            while maxq.front().is_some_and(|&j: &usize| j + period <= i) {
                maxq.pop_front();
            }
            while minq.front().is_some_and(|&j: &usize| j + period <= i) {
                minq.pop_front();
            }
            if value.is_finite() {
                while maxq.back().is_some_and(|&j| values[j] <= value) {
                    maxq.pop_back();
                }
                maxq.push_back(i);
                while minq.back().is_some_and(|&j| values[j] >= value) {
                    minq.pop_back();
                }
                minq.push_back(i);
            }
            if i + 1 >= period && missing == 0 {
                highest[i] = values[maxq[0]];
                lowest[i] = values[minq[0]];
            }
        }
        (highest, lowest)
    }

    /// The block version gives pond-ts's queue values, signed zeros
    /// included, cut into stretches of any size.
    #[test]
    fn strict_extremes_match_the_queue() {
        // Gaps and runs of gaps, infinities, and long runs of -0 / 0 ties.
        let mut values = noisy(3_000);
        for (i, v) in values.iter_mut().enumerate() {
            // Zeros of both signs among larger values (ties for the
            // lowest), then among smaller ones (ties for the highest).
            let zero = || if i % 3 == 0 { -0.0 } else { 0.0 };
            if (1_200..1_500).contains(&i) {
                *v = if i % 3 == 0 || i % 5 == 0 {
                    zero()
                } else {
                    1.0
                };
            } else if (1_500..1_800).contains(&i) {
                *v = if i % 3 == 0 || i % 5 == 0 {
                    zero()
                } else {
                    -1.0
                };
            }
        }
        for period in [1, 2, 3, 7, 20, 64, 500, 3_001] {
            let (want_hi, want_lo) = strict_extremes_queue(&values, period);
            for chunk in [1, 2, 3, 5, 19, 64, 999, 3_000] {
                let (hi, lo) = extremes_strict_chunked(&values, period, chunk);
                let label = format!("period {period}, stretch {chunk}");
                assert!(same_bits(&want_hi, &hi), "highest {label}");
                assert!(same_bits(&want_lo, &lo), "lowest {label}");
            }
        }
    }
}
