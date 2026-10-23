//! The trend family (pond-ts `catalog/trend.ts`): directional movement,
//! Aroon, the vortex indicator, the vertical horizontal filter, the random
//! walk index, SuperTrend, the parabolic SAR, the ATR trailing stop,
//! ZigZag, Ichimoku, Elder's impulse system and ray, the trend intensity
//! index, RAVI and Wilder's swing index (and its running total).

use super::averages::{MACD_SCRATCH, positive, shorter};
use super::bands::{positive_finite, suffixed};
use super::kernels::{
    self, js_max, js_min, mean_values_reads_from, rolling_extreme, rolling_mean_values,
    rolling_mean_values_into, wilder_values,
};
use super::kernels::{Ema, ma_column, rolling_extremes_strict};
use super::{MaType, Study};
use crate::error::{PondError, Result};
use crate::par;
use crate::series::TimeSeries;

study_options! {
    /// Options for [`TimeSeries::directional_movement`]: Wilder's system
    /// over 14 bars; writes `dmiPlusDi`, `dmiMinusDi`, `dmiDx`, `dmiAdx`
    /// and `dmiAdxr`.
    DirectionalMovement, prefix = "dmi", reads [high, low, close] {
        /// The smoothing length in bars (default 14).
        period: usize = 14,
    }
}

study_options! {
    /// Options for [`TimeSeries::aroon`]: a 25-bar window; writes
    /// `aroonUp`, `aroonDown` and `aroonOsc`.
    Aroon, prefix = "aroon", reads [high, low] {
        /// The window in bars (default 25).
        period: usize = 25,
    }
}

study_options! {
    /// Options for [`TimeSeries::vortex`]: 14 bars; writes `viPlus` and
    /// `viMinus`.
    Vortex, prefix = "vi", reads [high, low, close] {
        /// The window in bars (default 14).
        period: usize = 14,
    }
}

study_options! {
    /// Options for [`TimeSeries::random_walk_index`]: horizons of 2 to 14
    /// bars; writes `rwiHigh` and `rwiLow`.
    RandomWalkIndex, prefix = "rwi", reads [high, low, close] {
        /// The longest horizon in bars, at least 2 (default 14).
        period: usize = 14,
    }
}

study_options! {
    /// Options for [`TimeSeries::super_trend`]: a 10-bar ATR, bands 3 ATRs
    /// from the median price; writes `st` (the prefix itself) and
    /// `stTrend`.
    SuperTrend, prefix = "st", reads [high, low, close] {
        /// The ATR's length in bars (default 10).
        period: usize = 10,
        /// The band's distance in ATRs (default 3).
        multiplier: f64 = 3.0,
    }
}

study_options! {
    /// Options for [`TimeSeries::parabolic_sar`]: acceleration from 0.02 in
    /// steps of 0.02 up to 0.2; writes `psar` (the prefix itself) and
    /// `psarTrend`.
    ParabolicSar, prefix = "psar", reads [high, low] {
        /// The acceleration factor's start and step (default 0.02).
        step: f64 = 0.02,
        /// The acceleration factor's ceiling (default 0.2).
        max_step: f64 = 0.2,
    }
}

study_options! {
    /// Options for [`TimeSeries::atr_trailing_stop`]: a 14-bar ATR, the
    /// stop 3 ATRs from the close; writes `ats` (the prefix itself) and
    /// `atsTrend`.
    AtrTrailingStop, prefix = "ats", reads [high, low, close] {
        /// The ATR's length in bars (default 14).
        period: usize = 14,
        /// The stop's distance in ATRs (default 3).
        multiplier: f64 = 3.0,
    }
}

impl TimeSeries {
    /// Wilder's directional movement system (pond-ts
    /// `directionalMovement`): +DI and -DI (the smoothed up and down moves
    /// as percents of the average true range), DX (their normalised
    /// difference), ADX (DX smoothed) and ADXR (the mean of ADX now and
    /// `period - 1` bars back).
    pub fn directional_movement(&self, options: DirectionalMovement) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::directional_movement";
        positive(CALL, "period", options.period)?;
        let names = suffixed(options.name(), ["PlusDi", "MinusDi", "Dx", "Adx", "Adxr"]);
        self.free_names(CALL, &names)?;
        let [high, low, close] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.close],
            ["high", "low", "close"],
        )?;
        let period = options.period;
        let (range, (plus, minus)) = par::join(
            || kernels::atr_values(&high, &low, &close, period),
            || smoothed_directional_movement(&high, &low, period),
        );
        // +DI, -DI and DX are row by row, so stretches of rows run on
        // separate cores; ADX (Wilder's average of DX) runs in order.
        let n = high.len();
        let (mut di_plus, mut di_minus, mut dx) = (vec![0.0; n], vec![0.0; n], vec![0.0; n]);
        par::fill_chunks3(
            &mut di_plus,
            &mut di_minus,
            &mut dx,
            1 << 14,
            |start, a, b, c| {
                for k in 0..a.len() {
                    let i = start + k;
                    let p = (100.0 * plus[i]) / range[i];
                    let m = (100.0 * minus[i]) / range[i];
                    let total = p + m;
                    a[k] = p;
                    b[k] = m;
                    c[k] = if total == 0.0 {
                        0.0
                    } else {
                        (100.0 * (p - m).abs()) / total
                    };
                }
            },
        );
        let adx = wilder_values(&dx, period);
        let back = period - 1;
        let mut adxr = vec![0.0; n];
        par::fill_chunks(&mut adxr, &mut [], 1 << 14, |start, out, _| {
            for (k, slot) in out.iter_mut().enumerate() {
                let i = start + k;
                *slot = if i < back {
                    f64::NAN
                } else {
                    (adx[i] + adx[i - back]) / 2.0
                };
            }
        });
        self.study_outputs(
            CALL,
            names.into_iter().zip([di_plus, di_minus, dx, adx, adxr]),
        )
    }

    /// Aroon (pond-ts `aroon`): how recently the window's highest high and
    /// lowest low printed, as percents (100 for this bar, 0 for `period`
    /// bars back), and their difference. The window is `period + 1` bars;
    /// of equal extremes the latest counts.
    pub fn aroon(&self, options: Aroon) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::aroon";
        positive(CALL, "period", options.period)?;
        let names = suffixed(options.name(), ["Up", "Down", "Osc"]);
        self.free_names(CALL, &names)?;
        let [high, low] =
            self.price_columns(CALL, [&options.high, &options.low], ["high", "low"])?;
        let period = options.period;
        let (up, down) = par::join(
            || aroon_values::<true>(&high, period),
            || aroon_values::<false>(&low, period),
        );
        let osc = up.iter().zip(&down).map(|(u, d)| u - d).collect();
        self.study_outputs(CALL, names.into_iter().zip([up, down, osc]))
    }

    /// Vortex indicator (pond-ts `vortex`): the window means of
    /// `|high - previous low|` (VI+) and `|low - previous high|` (VI-), each
    /// over the window mean of the true range; a gap where that is 0.
    pub fn vortex(&self, options: Vortex) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::vortex";
        positive(CALL, "period", options.period)?;
        let names = suffixed(options.name(), ["Plus", "Minus"]);
        self.free_names(CALL, &names)?;
        let [high, low, close] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.close],
            ["high", "low", "close"],
        )?;
        let n = high.len();
        let period = options.period;
        let moved = |a: &[f64], b: &[f64]| -> Vec<f64> {
            (0..n)
                .map(|i| {
                    if i == 0 {
                        f64::NAN
                    } else {
                        (a[i] - b[i - 1]).abs()
                    }
                })
                .collect()
        };
        let ((mean_plus, mean_minus), mean_range) = par::join(
            || {
                par::join(
                    || rolling_mean_values(&moved(&high, &low), period),
                    || rolling_mean_values(&moved(&low, &high), period),
                )
            },
            || rolling_mean_values(&kernels::true_range_values(&high, &low, &close), period),
        );
        let (mut plus, mut minus) = (vec![f64::NAN; n], vec![f64::NAN; n]);
        for i in 0..n {
            let range = mean_range[i];
            if range != 0.0 {
                plus[i] = mean_plus[i] / range;
                minus[i] = mean_minus[i] / range;
            }
        }
        self.study_outputs(CALL, names.into_iter().zip([plus, minus]))
    }

    /// Vertical horizontal filter (pond-ts `verticalHorizontalFilter`),
    /// output `vhf`: the window's range (highest minus lowest, skipping
    /// gaps) over the sum of its bar-to-bar moves. pond-ts's default period
    /// is 28.
    pub fn vertical_horizontal_filter(&self, study: Study) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::vertical_horizontal_filter";
        let (values, output) = self.study_input(CALL, &study, "vhf")?;
        let period = study.period;
        let (highest, (lowest, mean_change)) = par::join(
            || rolling_extreme::<true>(&values, period),
            || {
                par::join(
                    || rolling_extreme::<false>(&values, period),
                    || {
                        let change: Vec<f64> = kernels::deltas(&values).map(f64::abs).collect();
                        rolling_mean_values(&change, period)
                    },
                )
            },
        );
        let p = period as f64;
        let out = (0..values.len())
            .map(|i| (highest[i] - lowest[i]) / (mean_change[i] * p))
            .collect();
        self.study_output(CALL, output, out)
    }

    /// Random walk index (pond-ts `randomWalkIndex`): over horizons `n`
    /// from 2 to `period`, the largest of `(high - low n bars back)` and of
    /// `(high n bars back - low)`, each over the `n`-bar mean true range
    /// times `√n`. A gap at any horizon gives a gap.
    pub fn random_walk_index(&self, options: RandomWalkIndex) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::random_walk_index";
        positive(CALL, "period", options.period)?;
        if options.period < 2 {
            return Err(PondError::InvalidData {
                call: CALL,
                message: format!(
                    "randomWalkIndex period must be at least 2 (the horizons are 2 … period); got {}",
                    options.period
                ),
            });
        }
        let names = suffixed(options.name(), ["High", "Low"]);
        self.free_names(CALL, &names)?;
        let [high, low, close] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.close],
            ["high", "low", "close"],
        )?;
        let true_range = kernels::true_range_values(&high, &low, &close);
        let n = high.len();
        let (mut rwi_high, mut rwi_low) = (vec![0.0; n], vec![0.0; n]);
        // Each row's maximum over the horizons stands alone, and the order
        // of a JS `Math.max` fold does not change its answer, so stretches
        // of rows run on separate cores.
        par::fill_chunks(&mut rwi_high, &mut rwi_low, 1 << 14, |start, hi, lo| {
            random_walk_into(&high, &low, &true_range, options.period, start, hi, lo)
        });
        self.study_outputs(CALL, names.into_iter().zip([rwi_high, rwi_low]))
    }

    /// SuperTrend (pond-ts `superTrend`): bands `multiplier` ATRs above
    /// and below the median price that only tighten while the close stays
    /// inside them; the line is the lower band in an up trend and the upper
    /// band in a down trend, and the trend (`1` / `-1`) flips when the
    /// close crosses the line. Each run of rows without a gap starts again
    /// (in a down trend).
    pub fn super_trend(&self, options: SuperTrend) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::super_trend";
        positive(CALL, "period", options.period)?;
        positive_finite(CALL, "superTrend multiplier", options.multiplier)?;
        let names = [
            options.name().to_string(),
            format!("{}Trend", options.name()),
        ];
        self.free_names(CALL, &names)?;
        let [high, low, close] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.close],
            ["high", "low", "close"],
        )?;
        let atr = kernels::atr_values(&high, &low, &close, options.period);
        let k = options.multiplier;
        let (mut upper, mut lower, mut up, mut prev_close) = (f64::NAN, f64::NAN, false, f64::NAN);
        let (line, trend) = fold_rows([&high, &low, &close, &atr], |run, [h, l, c, a]| {
            let mid = (h + l) / 2.0;
            let half_width = k * a;
            let basic_upper = mid + half_width;
            let basic_lower = mid - half_width;
            if run == 1 {
                (upper, lower, up) = (basic_upper, basic_lower, false);
            } else {
                if basic_upper < upper || prev_close > upper {
                    upper = basic_upper;
                }
                if basic_lower > lower || prev_close < lower {
                    lower = basic_lower;
                }
                // `!(c < lower)`, not `c >= lower`: a NaN band keeps an up
                // trend, as in pond-ts.
                #[allow(clippy::neg_cmp_op_on_partial_ord)]
                let stays_up = !(c < lower);
                up = if up { stays_up } else { c > upper };
            }
            prev_close = c;
            (if up { lower } else { upper }, if up { 1.0 } else { -1.0 })
        });
        self.study_outputs(CALL, names.into_iter().zip([line, trend]))
    }

    /// Wilder's parabolic stop-and-reverse (pond-ts `parabolicSar`): a
    /// stop that accelerates toward the trend's extreme by `step` each new
    /// extreme, up to `max_step`, and flips side when price crosses it; the
    /// trend is `1` / `-1`. Each run of rows without a gap starts again,
    /// its first bar giving a gap.
    pub fn parabolic_sar(&self, options: ParabolicSar) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::parabolic_sar";
        let (step, max_step) = (options.step, options.max_step);
        positive_finite(CALL, "parabolicSar step", step)?;
        positive_finite(CALL, "parabolicSar maxStep", max_step)?;
        if max_step < step {
            return Err(PondError::InvalidData {
                call: CALL,
                message: format!(
                    "parabolicSar maxStep ({}) must be at least step ({})",
                    crate::grid::js_number(max_step),
                    crate::grid::js_number(step)
                ),
            });
        }
        let names = [
            options.name().to_string(),
            format!("{}Trend", options.name()),
        ];
        self.free_names(CALL, &names)?;
        let [high, low] =
            self.price_columns(CALL, [&options.high, &options.low], ["high", "low"])?;
        let mut state = Sar {
            step,
            max_step,
            long: true,
            sar: f64::NAN,
            ep: f64::NAN,
            af: step,
            prev_high: f64::NAN,
            prev_low: f64::NAN,
        };
        let (sar, trend) = fold_rows([&high, &low], |run, [h, l]| state.step(run, h, l));
        self.study_outputs(CALL, names.into_iter().zip([sar, trend]))
    }

    /// ATR trailing stop (pond-ts `atrTrailingStop`): a stop `multiplier`
    /// ATRs from the close that only ratchets toward price while the close
    /// stays on its side, and jumps to the other side when the close
    /// crosses it; the trend is `1` / `-1`. Each run of rows without a gap
    /// starts again, long.
    pub fn atr_trailing_stop(&self, options: AtrTrailingStop) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::atr_trailing_stop";
        positive(CALL, "period", options.period)?;
        positive_finite(CALL, "atrTrailingStop multiplier", options.multiplier)?;
        let names = [
            options.name().to_string(),
            format!("{}Trend", options.name()),
        ];
        self.free_names(CALL, &names)?;
        let [high, low, close] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.close],
            ["high", "low", "close"],
        )?;
        let atr = kernels::atr_values(&high, &low, &close, options.period);
        let k = options.multiplier;
        let (mut stop, mut long, mut prev_close) = (f64::NAN, true, f64::NAN);
        let (stops, trend) = fold_rows([&close, &atr], |run, [c, a]| {
            let distance = k * a;
            if run == 1 {
                (stop, long) = (c - distance, true);
            } else {
                let prev = stop;
                if c > prev && prev_close > prev {
                    stop = js_max(prev, c - distance);
                } else if c < prev && prev_close < prev {
                    stop = js_min(prev, c + distance);
                } else if c > prev {
                    (stop, long) = (c - distance, true);
                } else {
                    (stop, long) = (c + distance, false);
                }
            }
            prev_close = c;
            (stop, if long { 1.0 } else { -1.0 })
        });
        self.study_outputs(CALL, names.into_iter().zip([stops, trend]))
    }
}

/// pond-ts `foldRows` with two outputs: `step(run, row)` for each row
/// with no gap (`NaN`) in any input, where `run` counts the rows since
/// the last gap (1 on the first); a gap row gets gaps. A step returning a
/// gap leaves one.
fn fold_rows<const N: usize>(
    inputs: [&[f64]; N],
    mut step: impl FnMut(usize, [f64; N]) -> (f64, f64),
) -> (Vec<f64>, Vec<f64>) {
    let n = inputs.first().map_or(0, |c| c.len());
    let (mut a, mut b) = (vec![f64::NAN; n], vec![f64::NAN; n]);
    let mut run = 0;
    for i in 0..n {
        let row = inputs.map(|c| c[i]);
        if row.iter().any(|v| v.is_nan()) {
            run = 0;
            continue;
        }
        run += 1;
        (a[i], b[i]) = step(run, row);
    }
    (a, b)
}

/// pond-ts `directionalMovementValues` (each bar's up move: the high's
/// rise, when it beats the low's fall and is positive, else 0; and down
/// move: the low's fall, likewise; a gap on row 0 and where either change
/// is a gap), each smoothed with pond-ts `wilderValues(values, period, 1)`.
/// The two moves have their gaps on the same rows, so both averages start
/// on the same row and run side by side in one pass, with the same
/// operations in the same order (same bits) and no column in between.
fn smoothed_directional_movement(high: &[f64], low: &[f64], period: usize) -> (Vec<f64>, Vec<f64>) {
    let n = high.len();
    let (mut plus, mut minus) = (vec![f64::NAN; n], vec![f64::NAN; n]);
    let moves = |i: usize| {
        let up = high[i] - high[i - 1];
        let dn = low[i - 1] - low[i];
        if up.is_nan() || dn.is_nan() {
            (f64::NAN, f64::NAN)
        } else {
            (
                if up > dn && up > 0.0 { up } else { 0.0 },
                if dn > up && dn > 0.0 { dn } else { 0.0 },
            )
        }
    };
    let first = (1..n).find(|&i| !moves(i).0.is_nan()).unwrap_or(n);
    let seed_at = first.saturating_add(period - 1);
    if seed_at >= n {
        return (plus, minus);
    }
    let p = period as f64;
    let (mut up_avg, mut down_avg) = (0.0, 0.0);
    for i in first..=seed_at {
        let (u, d) = moves(i);
        up_avg += u;
        down_avg += d;
    }
    up_avg /= p;
    down_avg /= p;
    (plus[seed_at], minus[seed_at]) = (up_avg, down_avg);
    for i in seed_at + 1..n {
        let (u, d) = moves(i);
        up_avg = (up_avg * (p - 1.0) + u) / p;
        down_avg = (down_avg * (p - 1.0) + d) / p;
        (plus[i], minus[i]) = (up_avg, down_avg);
    }
    (plus, minus)
}

/// Aroon up (or, without `MAX`, down): pond-ts `barsSinceExtremeValues`
/// (bars since the highest, or lowest, value of the `period + 1`-bar
/// window, the latest of equal ones; a gap until the window is full and
/// wherever it holds a non-finite value) as `100 * (period - since) /
/// period`, written in the same pass. A queue of candidate rows, O(N).
fn aroon_values<const MAX: bool>(values: &[f64], period: usize) -> Vec<f64> {
    let p = period as f64;
    let n = values.len();
    let mut out = vec![f64::NAN; n];
    let mut queue = std::collections::VecDeque::new();
    let mut missing = 0usize;
    for i in 0..n {
        let value = values[i];
        if i > period && !values[i - period - 1].is_finite() {
            missing -= 1;
        }
        if !value.is_finite() {
            missing += 1;
        }
        while queue.front().is_some_and(|&j| j + period < i) {
            queue.pop_front();
        }
        if value.is_finite() {
            while let Some(&j) = queue.back() {
                let back: f64 = values[j];
                if if MAX { back <= value } else { back >= value } {
                    queue.pop_back();
                } else {
                    break;
                }
            }
            queue.push_back(i);
        }
        if i >= period && missing == 0 {
            let since = (i - queue[0]) as f64;
            out[i] = (100.0 * (p - since)) / p;
        }
    }
    out
}

/// The random walk index for rows `start..start + high_out.len()`. Each
/// row's maximum over the horizons stands alone, and the order of a JS
/// `Math.max` fold does not change its answer, so stretches of rows can
/// run on separate cores.
fn random_walk_into(
    high: &[f64],
    low: &[f64],
    true_range: &[f64],
    period: usize,
    start: usize,
    high_out: &mut [f64],
    low_out: &mut [f64],
) {
    // A horizon as long as the series leaves every row without a value
    // (`i < horizon`), and a gap in the running maximum stays: every row is
    // a gap. pond-ts walks all `period` horizons to get there.
    if period >= high.len() {
        high_out.fill(f64::NAN);
        low_out.fill(f64::NAN);
        return;
    }
    high_out.fill(f64::NEG_INFINITY);
    low_out.fill(f64::NEG_INFINITY);
    let mut mean = vec![0.0; high_out.len()];
    for horizon in 2..=period {
        let from = mean_values_reads_from(start, horizon);
        rolling_mean_values_into(&true_range[from..], horizon, start - from, &mut mean);
        let scale = (horizon as f64).sqrt();
        for k in 0..high_out.len() {
            let i = start + k;
            let denominator = mean[k] * scale;
            let blank = i < horizon || denominator == 0.0;
            let (term_high, term_low) = if blank {
                (f64::NAN, f64::NAN)
            } else {
                (
                    (high[i] - low[i - horizon]) / denominator,
                    (high[i - horizon] - low[i]) / denominator,
                )
            };
            high_out[k] = js_max(high_out[k], term_high);
            low_out[k] = js_max(low_out[k], term_low);
        }
    }
}

/// The parabolic SAR's state, as pond-ts's `sarStep` keeps it.
struct Sar {
    step: f64,
    max_step: f64,
    long: bool,
    sar: f64,
    ep: f64,
    af: f64,
    prev_high: f64,
    prev_low: f64,
}

impl Sar {
    /// One bar of pond-ts's `sarStep`: the stop for this bar and the trend.
    fn step(&mut self, run: usize, new_high: f64, new_low: f64) -> (f64, f64) {
        if run == 1 {
            (self.prev_high, self.prev_low) = (new_high, new_low);
            return (f64::NAN, f64::NAN);
        }
        if run == 2 {
            let diff_plus = new_high - self.prev_high;
            let diff_minus = self.prev_low - new_low;
            self.long = !(diff_minus > 0.0 && diff_minus > diff_plus);
            self.af = self.step;
            if self.long {
                (self.ep, self.sar) = (new_high, self.prev_low);
            } else {
                (self.ep, self.sar) = (new_low, self.prev_high);
            }
            (self.prev_high, self.prev_low) = (new_high, new_low);
        }
        let (prev_high, prev_low) = (self.prev_high, self.prev_low);
        let out;
        if self.long {
            if new_low <= self.sar {
                self.long = false;
                let mut sar = self.ep;
                if sar < prev_high {
                    sar = prev_high;
                }
                if sar < new_high {
                    sar = new_high;
                }
                out = sar;
                self.af = self.step;
                self.ep = new_low;
                sar += self.af * (self.ep - sar);
                if sar < prev_high {
                    sar = prev_high;
                }
                if sar < new_high {
                    sar = new_high;
                }
                self.sar = sar;
            } else {
                out = self.sar;
                if new_high > self.ep {
                    self.ep = new_high;
                    self.af = js_min(self.af + self.step, self.max_step);
                }
                let mut sar = self.sar + self.af * (self.ep - self.sar);
                if sar > prev_low {
                    sar = prev_low;
                }
                if sar > new_low {
                    sar = new_low;
                }
                self.sar = sar;
            }
        } else if new_high >= self.sar {
            self.long = true;
            let mut sar = self.ep;
            if sar > prev_low {
                sar = prev_low;
            }
            if sar > new_low {
                sar = new_low;
            }
            out = sar;
            self.af = self.step;
            self.ep = new_high;
            sar += self.af * (self.ep - sar);
            if sar > prev_low {
                sar = prev_low;
            }
            if sar > new_low {
                sar = new_low;
            }
            self.sar = sar;
        } else {
            out = self.sar;
            if new_low < self.ep {
                self.ep = new_low;
                self.af = js_min(self.af + self.step, self.max_step);
            }
            let mut sar = self.sar + self.af * (self.ep - self.sar);
            if sar < prev_high {
                sar = prev_high;
            }
            if sar < new_high {
                sar = new_high;
            }
            self.sar = sar;
        }
        (self.prev_high, self.prev_low) = (new_high, new_low);
        (out, if self.long { 1.0 } else { -1.0 })
    }
}

study_options! {
    /// Options for [`TimeSeries::zig_zag`]: legs that end on a 5% reversal;
    /// writes `zzPivot`, `zzDirection` and `zzLine`.
    ZigZag, prefix = "zz", reads [high, low] {
        /// The reversal threshold, in percent of the leg's extreme
        /// (default 5).
        deviation: f64 = 5.0,
    }
}

study_options! {
    /// Options for [`TimeSeries::ichimoku`]: windows of 9, 26 and 52 bars;
    /// writes `ichiTenkan`, `ichiKijun`, `ichiSenkouA`, `ichiSenkouB` and
    /// `ichiChikou`.
    Ichimoku, prefix = "ichi", reads [high, low, close] {
        /// The Tenkan-sen (conversion line) window in bars (default 9).
        conversion: usize = 9,
        /// The Kijun-sen (base line) window in bars (default 26).
        base: usize = 26,
        /// The Senkou span B window in bars (default 52).
        span_b: usize = 52,
        /// How many bars a chart shifts the spans forward and the Chikou
        /// span back (default 26). It changes no value the study writes
        /// (the columns stay on the bar they are computed from); it is
        /// checked, and [`Ichimoku::offsets`] reports it.
        displacement: usize = 26,
    }
}

impl Ichimoku {
    /// pond-ts `ichimokuOffsets`: each column [`TimeSeries::ichimoku`]
    /// writes with these options, and how many bars a chart shifts it:
    /// `0` for Tenkan and Kijun, `+displacement` for the two Senkou spans
    /// (drawn ahead), `-displacement` for the Chikou span (drawn back).
    pub fn offsets(&self) -> Result<[(String, i64); 5]> {
        positive(
            "Ichimoku::offsets",
            "ichimokuOffsets displacement",
            self.displacement,
        )?;
        let d = self.displacement as i64;
        let [tenkan, kijun, a, b, chikou] = suffixed(self.name(), ICHIMOKU_SUFFIXES);
        Ok([(tenkan, 0), (kijun, 0), (a, d), (b, d), (chikou, -d)])
    }
}

/// The columns [`TimeSeries::ichimoku`] writes, after the prefix.
const ICHIMOKU_SUFFIXES: [&str; 5] = ["Tenkan", "Kijun", "SenkouA", "SenkouB", "Chikou"];

study_options! {
    /// Options for [`TimeSeries::elder_impulse`]: a 13-bar EMA and the
    /// 12 / 26 / 9 MACD histogram; writes `impulse`.
    ElderImpulse, output = "impulse" {
        /// The trend EMA in bars (default 13).
        ema: usize = 13,
        /// The MACD's fast EMA in bars (default 12).
        fast: usize = 12,
        /// The MACD's slow EMA in bars (default 26).
        slow: usize = 26,
        /// The MACD's signal EMA in bars (default 9).
        signal: usize = 9,
    }
}

study_options! {
    /// Options for [`TimeSeries::elder_ray`]: a 13-bar EMA of the close;
    /// writes `elderBull` and `elderBear`.
    ElderRay, prefix = "elder", reads [high, low, close] {
        /// The EMA in bars (default 13).
        period: usize = 13,
    }
}

study_options! {
    /// Options for [`TimeSeries::trend_intensity_index`]: deviations from a
    /// 60-bar average, over 30 bars; writes `tii`.
    TrendIntensityIndex, output = "tii" {
        /// How many bars of deviations count (default 30).
        period: usize = 30,
        /// The average the deviations are from, in bars (default 60).
        ma_period: usize = 60,
    }
}

study_options! {
    /// Options for [`TimeSeries::ravi`]: 7- and 65-bar simple averages;
    /// writes `ravi`.
    Ravi, output = "ravi" {
        /// The short average in bars (default 7).
        short: usize = 7,
        /// The long average in bars (default 65).
        long: usize = 65,
    }
}

study_options! {
    /// Options for [`TimeSeries::swing_index`]: writes `si`. The limit
    /// move has no default (pond-ts requires it too): it is a fact about
    /// the instrument.
    SwingIndex(limit: f64), output = "si", reads [open, high, low, close] {}
}

study_options! {
    /// Options for [`TimeSeries::accumulative_swing_index`]: writes `asi`.
    /// The limit move has no default, as for [`SwingIndex`].
    AccumulativeSwingIndex(limit: f64), output = "asi", reads [open, high, low, close] {}
}

/// The prefix pond-ts's `elderImpulse` computes its MACD under; a series
/// that already has one of those columns is refused, as in pond-ts.
const ELDER_SCRATCH: &str = "__elderMacd__";

/// The trend family, part 2.
impl TimeSeries {
    /// ZigZag (pond-ts `zigZag`): the path reduced to swings of at least
    /// `deviation` percent. `Pivot` holds each confirmed pivot's price on
    /// the pivot's own bar (a gap elsewhere); `Direction` is `1` on a
    /// rising leg and `-1` on a falling one; `Line` joins the pivots with
    /// straight lines (a gap on the last, unconfirmed leg). A later bar can
    /// confirm an earlier pivot, so the columns change as rows are added.
    /// Each run of rows without a gap starts again, and no leg crosses a
    /// gap.
    pub fn zig_zag(&self, options: ZigZag) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::zig_zag";
        let deviation = options.deviation;
        if !deviation.is_finite() || deviation <= 0.0 {
            return Err(PondError::InvalidData {
                call: CALL,
                message: "zigZag deviation must be a positive finite number (percent)".into(),
            });
        }
        let names = suffixed(options.name(), ["Pivot", "Direction", "Line"]);
        self.free_names(CALL, &names)?;
        let [high, low] =
            self.price_columns(CALL, [&options.high, &options.low], ["high", "low"])?;
        let (pivot, direction, line) = zig_zag_values(&high, &low, deviation / 100.0);
        self.study_outputs(CALL, names.into_iter().zip([pivot, direction, line]))
    }

    /// Ichimoku Kinko Hyo (pond-ts `ichimoku`): the midpoints of the
    /// highest high and lowest low over the conversion, base and span B
    /// windows (`Tenkan`, `Kijun`, `SenkouB`), the mean of the first two
    /// (`SenkouA`) and the close (`Chikou`). A window holding a gap in
    /// either the highs or the lows gives a gap. Every column stays on the
    /// bar it is computed from; [`Ichimoku::offsets`] gives the shifts a
    /// chart applies.
    pub fn ichimoku(&self, options: Ichimoku) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::ichimoku";
        positive(CALL, "ichimoku conversionPeriod", options.conversion)?;
        positive(CALL, "ichimoku basePeriod", options.base)?;
        positive(CALL, "ichimoku spanBPeriod", options.span_b)?;
        positive(CALL, "ichimoku displacement", options.displacement)?;
        let names = suffixed(options.name(), ICHIMOKU_SUFFIXES);
        self.free_names(CALL, &names)?;
        let [high, low, close] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.close],
            ["high", "low", "close"],
        )?;
        let (tenkan, (kijun, senkou_b)) = par::join(
            || midpoint_values(&high, &low, options.conversion),
            || {
                par::join(
                    || midpoint_values(&high, &low, options.base),
                    || midpoint_values(&high, &low, options.span_b),
                )
            },
        );
        let senkou_a = tenkan
            .iter()
            .zip(&kijun)
            .map(|(t, k)| (t + k) / 2.0)
            .collect();
        let chikou = close.into_owned();
        self.study_outputs(
            CALL,
            names
                .into_iter()
                .zip([tenkan, kijun, senkou_a, senkou_b, chikou]),
        )
    }

    /// Elder's impulse system (pond-ts `elderImpulse`): `1` where both the
    /// EMA and the MACD histogram rose from the bar before, `-1` where both
    /// fell, `0` otherwise; a gap on row 0 and where either is a gap on
    /// this bar or the one before.
    pub fn elder_impulse(&self, options: ElderImpulse) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::elder_impulse";
        positive(CALL, "emaPeriod", options.ema)?;
        positive(CALL, "fastPeriod", options.fast)?;
        positive(CALL, "slowPeriod", options.slow)?;
        positive(CALL, "signalPeriod", options.signal)?;
        shorter(CALL, "elderImpulse", options.fast, options.slow)?;
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let values = self.study_source(CALL, options.source())?;
        // pond-ts runs `macd` under a scratch prefix, which refuses a
        // series holding any of its columns.
        self.free_names(
            CALL,
            &[
                format!("{ELDER_SCRATCH}Line"),
                format!("{ELDER_SCRATCH}Signal"),
                format!("{ELDER_SCRATCH}Hist"),
                MACD_SCRATCH.to_string(),
            ],
        )?;
        let (trend, hist) = par::join(
            || kernels::ema_values(&values, options.ema),
            || macd_hist(&values, options.fast, options.slow, options.signal),
        );
        let n = values.len();
        let mut out = vec![f64::NAN; n];
        for i in 1..n {
            let (e, e_prev, h, h_prev) = (trend[i], trend[i - 1], hist[i], hist[i - 1]);
            if e.is_nan() || e_prev.is_nan() || h.is_nan() || h_prev.is_nan() {
                continue;
            }
            out[i] = if e > e_prev && h > h_prev {
                1.0
            } else if e < e_prev && h < h_prev {
                -1.0
            } else {
                0.0
            };
        }
        self.study_outputs(CALL, [(output, out)])
    }

    /// Elder ray (pond-ts `elderRay`): bull power `high - EMA(close)` and
    /// bear power `low - EMA(close)`.
    pub fn elder_ray(&self, options: ElderRay) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::elder_ray";
        positive(CALL, "period", options.period)?;
        let names = suffixed(options.name(), ["Bull", "Bear"]);
        self.free_names(CALL, &names)?;
        // pond-ts reads the close first (through its EMA), then the high
        // and low: with two bad columns, the close's error wins.
        let [close] = self.price_columns(CALL, [&options.close], ["close"])?;
        let [high, low] =
            self.price_columns(CALL, [&options.high, &options.low], ["high", "low"])?;
        let ema = kernels::ema_values(&close, options.period);
        let bull = high.iter().zip(&ema).map(|(h, e)| h - e).collect();
        let bear = low.iter().zip(&ema).map(|(l, e)| l - e).collect();
        self.study_outputs(CALL, names.into_iter().zip([bull, bear]))
    }

    /// Trend intensity index (pond-ts `trendIntensityIndex`): of the last
    /// `period` deviations of the value from its `ma_period`-bar simple
    /// average, the share above it, `100 * up / (up + down)`. A gap where
    /// every deviation is 0.
    pub fn trend_intensity_index(&self, options: TrendIntensityIndex) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::trend_intensity_index";
        positive(CALL, "period", options.period)?;
        positive(CALL, "maPeriod", options.ma_period)?;
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let values = self.study_source(CALL, options.source())?;
        let average = ma_column(&values, options.ma_period, MaType::Sma);
        let (up, down): (Vec<f64>, Vec<f64>) = values
            .iter()
            .zip(&average)
            .map(|(v, a)| {
                let deviation = v - a;
                (js_max(deviation, 0.0), js_max(-deviation, 0.0))
            })
            .unzip();
        let (up_mean, down_mean) = par::join(
            || rolling_mean_values(&up, options.period),
            || rolling_mean_values(&down, options.period),
        );
        let out = up_mean
            .iter()
            .zip(&down_mean)
            .map(|(u, d)| {
                let total = u + d;
                if total == 0.0 {
                    f64::NAN
                } else {
                    (100.0 * u) / total
                }
            })
            .collect();
        self.study_output(CALL, output, out)
    }

    /// RAVI (pond-ts `ravi`): how far apart a short and a long simple
    /// average are, `100 * |short - long| / long`; a gap where the long
    /// average is 0.
    pub fn ravi(&self, options: Ravi) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::ravi";
        positive(CALL, "shortPeriod", options.short)?;
        positive(CALL, "longPeriod", options.long)?;
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let values = self.study_source(CALL, options.source())?;
        let (short, long) = par::join(
            || ma_column(&values, options.short, MaType::Sma),
            || ma_column(&values, options.long, MaType::Sma),
        );
        let out = short
            .iter()
            .zip(&long)
            .map(|(&s, &slow)| {
                if slow == 0.0 {
                    f64::NAN
                } else {
                    (100.0 * (s - slow).abs()) / slow
                }
            })
            .collect();
        self.study_output(CALL, output, out)
    }

    /// Wilder's swing index (pond-ts `swingIndex`): one bar's change, with
    /// its body and the last bar's, over a true-range-like span, scaled by
    /// its gap from the last close over the instrument's `limit` move
    /// (which bounds it to -100 … 100). A gap on row 0 and where the span
    /// is 0.
    pub fn swing_index(&self, options: SwingIndex) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::swing_index";
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let out = self.swing_values(
            CALL,
            "swingIndex",
            options.limit,
            [&options.open, &options.high, &options.low, &options.close],
        )?;
        self.study_output(CALL, output, out)
    }

    /// Wilder's accumulative swing index (pond-ts
    /// `accumulativeSwingIndex`): the running total of
    /// [`TimeSeries::swing_index`], from its first value; a gap after it
    /// makes every later total a gap.
    pub fn accumulative_swing_index(&self, options: AccumulativeSwingIndex) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::accumulative_swing_index";
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let swings = self.swing_values(
            CALL,
            "accumulativeSwingIndex",
            options.limit,
            [&options.open, &options.high, &options.low, &options.close],
        )?;
        self.study_output(CALL, output, cumulative_values(&swings))
    }

    /// The swing index of the `open`, `high`, `low` and `close` columns,
    /// after checking `limit` (pond-ts `swingValues`).
    fn swing_values(
        &self,
        call: &'static str,
        study: &str,
        limit: f64,
        names: [&Option<String>; 4],
    ) -> Result<Vec<f64>> {
        if !limit.is_finite() || limit <= 0.0 {
            return Err(PondError::InvalidData {
                call,
                message: format!(
                    "{study} limit must be a positive finite number (the instrument's limit move); got {}",
                    crate::grid::js_number(limit)
                ),
            });
        }
        let [open, high, low, close] =
            self.price_columns(call, names, ["open", "high", "low", "close"])?;
        Ok(swing_index_values(&open, &high, &low, &close, limit))
    }
}

/// pond-ts's zigZag machine (`zigZagStep`, then the pass that fills the
/// legs): the pivot, direction and line columns for `high` and `low` with
/// the reversal threshold `threshold` (`deviation / 100`).
fn zig_zag_values(high: &[f64], low: &[f64], threshold: f64) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let n = high.len();
    let mut pivot = vec![f64::NAN; n];
    // The machine's state, as pond-ts's `ZigZagState` (an index of `None`
    // is pond-ts's `-1`).
    let mut dir = 0i8;
    let (mut ext_val, mut ext_idx) = (f64::NAN, 0usize);
    let (mut ctr_val, mut ctr_idx): (f64, Option<usize>) = (f64::NAN, None);
    // Each run of rows without a gap, by its last row.
    let mut segment_end: Vec<usize> = Vec::new();
    // Confirmed pivots: row, price, the direction of the leg starting
    // there, and the run it is in.
    let mut pivots: Vec<(usize, f64, i8, usize)> = Vec::new();
    let mut run = 0usize;
    for i in 0..n {
        let (h, l) = (high[i], low[i]);
        if h.is_nan() || l.is_nan() {
            run = 0;
            continue;
        }
        run += 1;
        if run == 1 {
            segment_end.push(i);
            dir = 0;
            (ext_val, ext_idx) = (h, i);
            (ctr_val, ctr_idx) = (l, Some(i));
            continue;
        }
        let segment = segment_end.len() - 1;
        segment_end[segment] = i;
        let mut confirm = |row: usize, value: f64, dir_after: i8| {
            pivots.push((row, value, dir_after, segment));
            pivot[row] = value;
        };
        if dir == 0 {
            if h > ext_val {
                (ext_val, ext_idx) = (h, i);
            }
            let ctr = ctr_idx.expect("set while seeding");
            let ctr = if l < ctr_val {
                ctr_val = l;
                i
            } else {
                ctr
            };
            ctr_idx = Some(ctr);
            let gap = ext_val - ctr_val;
            if ext_idx > ctr {
                // The high came after the low: a rise from the trough.
                if gap >= threshold * ctr_val {
                    confirm(ctr, ctr_val, 1);
                    dir = 1;
                    ctr_idx = None;
                }
            } else if ctr > ext_idx && gap >= threshold * ext_val {
                // The low came after the high: a fall from the peak.
                confirm(ext_idx, ext_val, -1);
                dir = -1;
                (ext_val, ext_idx) = (ctr_val, ctr);
                ctr_idx = None;
            }
            continue;
        }
        if dir == 1 {
            if h > ext_val {
                (ext_val, ext_idx) = (h, i);
                ctr_idx = None;
                continue;
            }
            if ctr_idx.is_none() || l < ctr_val {
                (ctr_val, ctr_idx) = (l, Some(i));
            }
            if ext_val - ctr_val >= threshold * ext_val {
                confirm(ext_idx, ext_val, -1);
                dir = -1;
                (ext_val, ext_idx) = (ctr_val, ctr_idx.expect("just set"));
                ctr_idx = None;
            }
            continue;
        }
        if l < ext_val {
            (ext_val, ext_idx) = (l, i);
            ctr_idx = None;
            continue;
        }
        if ctr_idx.is_none() || h > ctr_val {
            (ctr_val, ctr_idx) = (h, Some(i));
        }
        if ctr_val - ext_val >= threshold * ext_val {
            confirm(ext_idx, ext_val, 1);
            dir = 1;
            (ext_val, ext_idx) = (ctr_val, ctr_idx.expect("just set"));
            ctr_idx = None;
        }
    }
    // The legs: each pivot's leg runs to the next pivot of the same run
    // (owning `[start, stop)`), or, for the last, unconfirmed leg, to the
    // run's last row (direction only).
    let mut direction = vec![f64::NAN; n];
    let mut line = vec![f64::NAN; n];
    for (k, &(start, from, leg_dir, segment)) in pivots.iter().enumerate() {
        let next = pivots.get(k + 1).filter(|p| p.3 == segment);
        let stop = next.map_or(segment_end[segment], |p| p.0);
        direction[start..stop].fill(f64::from(leg_dir));
        match next {
            Some(&(_, to, _, _)) => {
                let span = (stop - start) as f64;
                line[start] = from;
                line[stop] = to;
                for (j, slot) in line.iter_mut().enumerate().take(stop).skip(start + 1) {
                    *slot = from + ((to - from) * (j - start) as f64) / span;
                }
            }
            None => direction[stop] = f64::from(leg_dir),
        }
    }
    (pivot, direction, line)
}

/// pond-ts ichimoku's `midpointValues`: `(highest high + lowest low) / 2`
/// over each `period`-bar window, with pond-ts `rollingBarExtremesValues`'
/// strict rule (a gap in either column anywhere in the window gives a gap;
/// of equal values the latest wins).
fn midpoint_values(high: &[f64], low: &[f64], period: usize) -> Vec<f64> {
    let ((highest, _), (_, lowest)) = par::join(
        || rolling_extremes_strict(high, period),
        || rolling_extremes_strict(low, period),
    );
    highest
        .iter()
        .zip(&lowest)
        .map(|(h, l)| (h + l) / 2.0)
        .collect()
}

/// The MACD histogram, as [`TimeSeries::macd`] computes it.
fn macd_hist(values: &[f64], fast: usize, slow: usize, signal: usize) -> Vec<f64> {
    let (mut fast, mut slow) = (Ema::period(fast), Ema::period(slow));
    let mut signal_ema = Ema::period(signal);
    values
        .iter()
        .map(|&v| {
            let line = fast.push(v) - slow.push(v);
            line - signal_ema.push(line)
        })
        .collect()
}

/// pond-ts `swingIndexValues`.
fn swing_index_values(
    open: &[f64],
    high: &[f64],
    low: &[f64],
    close: &[f64],
    limit: f64,
) -> Vec<f64> {
    let n = close.len();
    let mut out = vec![f64::NAN; n];
    for i in 1..n {
        let (prev_close, prev_open) = (close[i - 1], open[i - 1]);
        let (c, o, h, l) = (close[i], open[i], high[i], low[i]);
        let a = (h - prev_close).abs();
        let b = (l - prev_close).abs();
        let d = (h - l).abs();
        let yesterday_body = 0.25 * (prev_close - prev_open).abs();
        // Ties go to the earlier branch (A, then B, then D).
        let r = if a >= b && a >= d {
            a - 0.5 * b + yesterday_body
        } else if b >= a && b >= d {
            b - 0.5 * a + yesterday_body
        } else {
            d + yesterday_body
        };
        let k = js_max(a, b);
        let numerator = c - prev_close + 0.5 * (c - o) + 0.25 * (prev_close - prev_open);
        out[i] = if r == 0.0 {
            f64::NAN
        } else {
            ((50.0 * numerator) / r) * (k / limit)
        };
    }
    out
}

/// pond-ts `cumulativeValues`: the running sum from the first value that
/// is not a gap (gaps before it stay gaps; a later gap makes every later
/// sum a gap).
fn cumulative_values(values: &[f64]) -> Vec<f64> {
    let first = values
        .iter()
        .position(|v| !v.is_nan())
        .unwrap_or(values.len());
    let mut out = vec![f64::NAN; values.len()];
    let mut sum = 0.0;
    for (slot, &v) in out.iter_mut().zip(values).skip(first) {
        sum += v;
        *slot = sum;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Limits and deviations that are not positive finite numbers are
    /// refused (JSON cases cannot carry an infinity or NaN).
    #[test]
    fn non_finite_limits_and_deviations_are_refused() {
        let price = |k: f64| (0..4).map(|i| 10.0 + k * f64::from(i)).collect::<Vec<_>>();
        let series = TimeSeries::new(
            "s",
            (0..4).collect(),
            vec![
                crate::Column::required("open", price(0.5)),
                crate::Column::required("high", price(1.5)),
                crate::Column::required("low", price(0.2)),
                crate::Column::required("close", price(1.0)),
            ],
        )
        .unwrap();
        for bad in [f64::INFINITY, f64::NEG_INFINITY, f64::NAN, 0.0, -1.0] {
            let si = series.swing_index(SwingIndex::new(bad)).unwrap_err();
            assert!(si.to_string().contains("swingIndex limit"), "{si}");
            let asi = series
                .accumulative_swing_index(AccumulativeSwingIndex::new(bad))
                .unwrap_err();
            assert!(
                asi.to_string().contains("accumulativeSwingIndex limit"),
                "{asi}"
            );
            let zz = series
                .zig_zag(ZigZag::default().deviation(bad))
                .unwrap_err();
            assert!(zz.to_string().contains("zigZag deviation"), "{zz}");
        }
        assert!(series.swing_index(SwingIndex::new(1.0)).is_ok());
    }

    /// Elder ray reads the close before the high and low, as pond-ts: with
    /// both missing, the error names the close.
    #[test]
    fn elder_ray_reads_close_first() {
        let series = TimeSeries::new(
            "s",
            (0..3).collect(),
            vec![crate::Column::required("low", vec![1.0, 2.0, 3.0])],
        )
        .unwrap();
        let err = series
            .elder_ray(ElderRay::default())
            .unwrap_err()
            .to_string();
        assert!(err.contains("close") && !err.contains("high"), "{err}");
    }

    /// A period as long as the series gives all gaps at once (the horizon
    /// loop is skipped); one bar shorter still gives the last row a value.
    #[test]
    fn random_walk_period_past_the_series_is_all_gaps() {
        let n = 40;
        let col = |name: &str, f: fn(usize) -> f64| {
            crate::series::Column::required(name, (0..n).map(f).collect::<Vec<f64>>())
        };
        let series = TimeSeries::new(
            "bars",
            (0..n as i64).collect(),
            vec![
                col("high", |i| 10.0 + (i % 7) as f64),
                col("low", |i| 8.0 - (i % 3) as f64),
                col("close", |i| 9.0 + (i % 5) as f64 / 2.0),
            ],
        )
        .unwrap();
        let last_two = |period: usize| {
            let out = series
                .random_walk_index(RandomWalkIndex::default().period(period))
                .unwrap();
            let cols = out.columns();
            cols[cols.len() - 2..]
                .iter()
                .map(|c| c.numbers().unwrap().iter().collect::<Vec<_>>())
                .collect::<Vec<_>>()
        };
        let shorter = last_two(n - 1);
        assert!(
            shorter
                .iter()
                .all(|c| c[n - 1].is_some() && c[n - 2].is_none())
        );
        for period in [n, n + 1, 1_000_000_000_000] {
            assert!(
                last_two(period).iter().flatten().all(Option::is_none),
                "{period}"
            );
        }
    }

    /// Stretches started anywhere give the bits of one sweep, on bars with
    /// gaps, flat runs and a large offset.
    #[test]
    fn random_walk_stretches_give_the_same_bits_as_one_sweep() {
        let n = 3_000;
        let wave = |i: usize, k: usize| match i % 97 {
            5 => f64::NAN,
            20..=40 => 1e9,
            _ => 1e9 + ((i * k) % 101) as f64 / 7.0,
        };
        let high: Vec<f64> = (0..n).map(|i| wave(i, 7919) + 3.0).collect();
        let low: Vec<f64> = (0..n).map(|i| wave(i, 6007) - 3.0).collect();
        let close: Vec<f64> = (0..n).map(|i| wave(i, 3001)).collect();
        let true_range = kernels::true_range_values(&high, &low, &close);
        let bits = |v: &[f64]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        for period in [2, 3, 14, 50] {
            let (mut hi, mut lo) = (vec![0.0; n], vec![0.0; n]);
            random_walk_into(&high, &low, &true_range, period, 0, &mut hi, &mut lo);
            for chunk in [1, 7, 64, 1000] {
                let (mut hi2, mut lo2) = (vec![0.0; n], vec![0.0; n]);
                for start in (0..n).step_by(chunk) {
                    let e = (start + chunk).min(n);
                    random_walk_into(
                        &high,
                        &low,
                        &true_range,
                        period,
                        start,
                        &mut hi2[start..e],
                        &mut lo2[start..e],
                    );
                }
                assert_eq!(bits(&hi), bits(&hi2), "high {period} {chunk}");
                assert_eq!(bits(&lo), bits(&lo2), "low {period} {chunk}");
            }
        }
    }
}
