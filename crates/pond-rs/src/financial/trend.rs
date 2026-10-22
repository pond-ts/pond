//! The trend family (pond-ts `catalog/trend.ts`), part 1: directional
//! movement, Aroon, the vortex indicator, the vertical horizontal filter,
//! the random walk index, SuperTrend, the parabolic SAR and the ATR
//! trailing stop.

use super::Study;
use super::averages::positive;
use super::bands::{positive_finite, suffixed};
use super::kernels::{
    self, js_max, js_min, mean_values_reads_from, rolling_extreme, rolling_mean_values,
    rolling_mean_values_into, wilder_values,
};
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

#[cfg(test)]
mod tests {
    use super::*;

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
