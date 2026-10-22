//! The volatility family (pond-ts `catalog/volatility.ts`): the average
//! true range, historical volatility, Chaikin volatility, the mass index,
//! the choppiness index, the Gopalakrishnan range index, the ulcer index
//! and the relative volatility index.

use super::Study;
use super::averages::positive;
use super::kernels::{
    self, js_log, js_log10, percent_change_values, rolling_extreme, rolling_mean_sd,
    rolling_mean_values, wilder_values,
};
use crate::error::{PondError, Result};
use crate::par;
use crate::series::TimeSeries;

study_options! {
    /// Options for [`TimeSeries::atr`]: Wilder's average true range over
    /// 14 bars; writes `atr`.
    Atr, output = "atr", reads [high, low, close] {
        /// The smoothing length in bars (default 14).
        period: usize = 14,
    }
}

study_options! {
    /// Options for [`TimeSeries::historical_volatility`]: the spread of 20
    /// log returns, annualised over 252 bars a year; writes `hv`.
    HistoricalVolatility, output = "hv" {
        /// The window in returns (default 20).
        period: usize = 20,
        /// Bars per year: the spread is scaled by its square root
        /// (default 252, trading days).
        annualize: f64 = 252.0,
    }
}

study_options! {
    /// Options for [`TimeSeries::chaikin_volatility`]: a 10-bar EMA of the
    /// bar range and its percent change over 10 bars; writes `chaikinVol`.
    ChaikinVolatility, output = "chaikinVol", reads [high, low] {
        /// The EMA's length in bars (default 10).
        period: usize = 10,
        /// How many bars back the change is taken from (default 10).
        roc_period: usize = 10,
    }
}

study_options! {
    /// Options for [`TimeSeries::mass_index`]: a 9-bar single and double
    /// EMA of the bar range, their ratio summed over 25 bars; writes
    /// `mass`.
    MassIndex, output = "mass", reads [high, low] {
        /// The EMAs' length in bars (default 9).
        ema: usize = 9,
        /// How many ratios are summed (default 25).
        sum: usize = 25,
    }
}

study_options! {
    /// Options for [`TimeSeries::choppiness_index`]: 14 bars; writes
    /// `chop`.
    ChoppinessIndex, output = "chop", reads [high, low, close] {
        /// The window in bars, at least 2 (default 14).
        period: usize = 14,
    }
}

study_options! {
    /// Options for [`TimeSeries::gopalakrishnan_range_index`]: 10 bars;
    /// writes `gapo`.
    GopalakrishnanRangeIndex, output = "gapo", reads [high, low] {
        /// The window in bars, at least 2 (default 10).
        period: usize = 10,
    }
}

study_options! {
    /// Options for [`TimeSeries::relative_volatility_index`]: a 10-bar
    /// spread routed by the bar's direction, Wilder-smoothed over 14 bars;
    /// writes `relVol`.
    RelativeVolatilityIndex, output = "relVol" {
        /// The Wilder smoothing's length in bars (default 14).
        period: usize = 14,
        /// The spread's window in bars (default 10).
        stdev: usize = 10,
    }
}

/// The volatility family.
impl TimeSeries {
    /// Average true range (pond-ts `atr`): Wilder's smoothing of the true
    /// range (the bar's range widened to the last close). A gap on row 0
    /// and until `period` true ranges have been read; a gap in the middle
    /// of the series makes every later value a gap.
    pub fn atr(&self, options: Atr) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::atr";
        positive(CALL, "period", options.period)?;
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [high, low, close] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.close],
            ["high", "low", "close"],
        )?;
        let out = kernels::atr_values(&high, &low, &close, options.period);
        self.study_output(CALL, output, out)
    }

    /// Historical volatility (pond-ts `historicalVolatility`): the
    /// population standard deviation of `period` log returns, times the
    /// square root of `annualize`. Each return sits on the bar it ends on;
    /// a price that is not above zero gives a gap for both returns it
    /// touches. Leading gaps in the returns are skipped, so the first value
    /// waits for `period` real returns.
    pub fn historical_volatility(&self, options: HistoricalVolatility) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::historical_volatility";
        positive(CALL, "period", options.period)?;
        let annualize = options.annualize;
        if !annualize.is_finite() || annualize <= 0.0 {
            return Err(PondError::InvalidData {
                call: CALL,
                message: "historicalVolatility annualize must be a positive number (bars per year)"
                    .into(),
            });
        }
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let values = self.study_source(CALL, options.source())?;
        let out = historical_volatility_values(&values, options.period, annualize);
        self.study_output(CALL, output, out)
    }

    /// Chaikin volatility (pond-ts `chaikinVolatility`): the percent change
    /// over `roc_period` bars of a `period`-bar EMA of the bar range
    /// (`high - low`). The EMA skips leading gaps; a gap where the earlier
    /// average is zero or a gap.
    pub fn chaikin_volatility(&self, options: ChaikinVolatility) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::chaikin_volatility";
        positive(CALL, "period", options.period)?;
        positive(CALL, "rocPeriod", options.roc_period)?;
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [high, low] =
            self.price_columns(CALL, [&options.high, &options.low], ["high", "low"])?;
        let smoothed = kernels::ema_values(&bar_range(&high, &low), options.period);
        let out = percent_change_values(&smoothed, options.roc_period);
        self.study_output(CALL, output, out)
    }

    /// Mass index (pond-ts `massIndex`): the ratio of a single to a double
    /// `ema`-bar EMA of the bar range, summed over the last `sum` bars. A
    /// gap until the double EMA has warmed up and `sum` ratios are
    /// present, and wherever the window holds a gap.
    pub fn mass_index(&self, options: MassIndex) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::mass_index";
        positive(CALL, "emaPeriod", options.ema)?;
        positive(CALL, "sumPeriod", options.sum)?;
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [high, low] =
            self.price_columns(CALL, [&options.high, &options.low], ["high", "low"])?;
        let single = kernels::ema_values(&bar_range(&high, &low), options.ema);
        let double = kernels::ema_values(&single, options.ema);
        let ratio: Vec<f64> = single.iter().zip(&double).map(|(s, d)| s / d).collect();
        let sum = options.sum as f64;
        let out = rolling_mean_values(&ratio, options.sum)
            .into_iter()
            .map(|m| m * sum)
            .collect();
        self.study_output(CALL, output, out)
    }

    /// Choppiness index (pond-ts `choppinessIndex`): `100 *
    /// log10(sum of true ranges / (highest high - lowest low)) /
    /// log10(period)` over `period` bars. The true-range sum needs every
    /// bar in the window; the highest high and lowest low skip gaps (as
    /// pond-ts). A gap where the window is flat or the sum is 0.
    pub fn choppiness_index(&self, options: ChoppinessIndex) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::choppiness_index";
        let period = options.period;
        positive(CALL, "period", period)?;
        at_least_two(CALL, "choppinessIndex", "log10", period)?;
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [high, low, close] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.close],
            ["high", "low", "close"],
        )?;
        let (mean_true_range, (highest, lowest)) = par::join(
            || rolling_mean_values(&kernels::true_range_values(&high, &low, &close), period),
            || {
                par::join(
                    || rolling_extreme::<true>(&high, period),
                    || rolling_extreme::<false>(&low, period),
                )
            },
        );
        let p = period as f64;
        let log_period = js_log10(p);
        let out = (0..mean_true_range.len())
            .map(|i| {
                let span = highest[i] - lowest[i];
                let sum = mean_true_range[i] * p;
                if span > 0.0 && sum > 0.0 {
                    (100.0 * js_log10(sum / span)) / log_period
                } else {
                    f64::NAN
                }
            })
            .collect();
        self.study_output(CALL, output, out)
    }

    /// Gopalakrishnan range index (pond-ts `gopalakrishnanRangeIndex`):
    /// `ln(highest high - lowest low) / ln(period)` over `period` bars (the
    /// extremes skip gaps); a gap where the span is not above zero.
    pub fn gopalakrishnan_range_index(
        &self,
        options: GopalakrishnanRangeIndex,
    ) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::gopalakrishnan_range_index";
        let period = options.period;
        positive(CALL, "period", period)?;
        at_least_two(CALL, "gopalakrishnanRangeIndex", "ln", period)?;
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [high, low] =
            self.price_columns(CALL, [&options.high, &options.low], ["high", "low"])?;
        let (highest, lowest) = par::join(
            || rolling_extreme::<true>(&high, period),
            || rolling_extreme::<false>(&low, period),
        );
        let log_period = js_log(period as f64);
        let out = highest
            .iter()
            .zip(&lowest)
            .map(|(h, l)| {
                let span = h - l;
                if span > 0.0 {
                    js_log(span) / log_period
                } else {
                    f64::NAN
                }
            })
            .collect();
        self.study_output(CALL, output, out)
    }

    /// Ulcer index (pond-ts `ulcerIndex`): the root mean square of the
    /// percent drawdowns from the highest value of the last `period` bars,
    /// over `period` bars (pond-ts default 14). Exactly 0 over a window
    /// with no drawdown; a gap until `period` drawdowns are present and
    /// wherever the window holds a gap.
    pub fn ulcer_index(&self, study: Study) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::ulcer_index";
        let (values, output) = self.study_input(CALL, &study, "ulcer")?;
        let out = ulcer_values(&values, study.period);
        self.study_output(CALL, output, out)
    }

    /// Relative volatility index (pond-ts `relativeVolatilityIndex`):
    /// RSI's arithmetic on the `stdev`-bar standard deviation instead of the
    /// change, routed to the up leg on a rise and the down leg otherwise
    /// (an unchanged value counts as down), each leg Wilder-smoothed over
    /// `period` bars: `100 * up / (up + down)`.
    pub fn relative_volatility_index(
        &self,
        options: RelativeVolatilityIndex,
    ) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::relative_volatility_index";
        positive(CALL, "period", options.period)?;
        positive(CALL, "stdevPeriod", options.stdev)?;
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let values = self.study_source(CALL, options.source())?;
        let out = relative_volatility_values(&values, options.period, options.stdev);
        self.study_output(CALL, output, out)
    }
}

/// pond-ts's `period < 2` check for a study normalised by a logarithm of
/// the period.
fn at_least_two(call: &'static str, study: &str, log: &str, period: usize) -> Result<()> {
    if period < 2 {
        return Err(PondError::InvalidData {
            call,
            message: format!(
                "{study} period must be at least 2 (the reading is normalised by {log}(period), which is 0 at 1)"
            ),
        });
    }
    Ok(())
}

/// pond-ts `barRangeValues`: `high - low` for every row.
fn bar_range(high: &[f64], low: &[f64]) -> Vec<f64> {
    high.iter().zip(low).map(|(h, l)| h - l).collect()
}

/// pond-ts `historicalVolatility` after its checks.
fn historical_volatility_values(values: &[f64], period: usize, annualize: f64) -> Vec<f64> {
    let n = values.len();
    let mut out = vec![f64::NAN; n];
    if n < 2 {
        return out;
    }
    // `returns[j]` runs from bar `j` to bar `j + 1`.
    let returns: Vec<f64> = values
        .windows(2)
        .map(|w| {
            let (a, b) = (w[0], w[1]);
            if a > 0.0 && b > 0.0 {
                js_log(b / a)
            } else {
                f64::NAN
            }
        })
        .collect();
    let first = returns
        .iter()
        .position(|r| r.is_finite())
        .unwrap_or(returns.len());
    if returns.len() - first < period {
        return out;
    }
    let (_, sd) = rolling_mean_sd(&returns[first..], period, true);
    let scale = annualize.sqrt();
    for (m, s) in sd.expect("asked for the spread").into_iter().enumerate() {
        out[first + m + 1] = s * scale;
    }
    out
}

/// pond-ts `ulcerIndex` after its checks.
fn ulcer_values(values: &[f64], period: usize) -> Vec<f64> {
    let peak = rolling_extreme::<true>(values, period);
    let squared: Vec<f64> = values
        .iter()
        .zip(&peak)
        .map(|(v, p)| {
            let drawdown = (100.0 * (v - p)) / p;
            drawdown * drawdown
        })
        .collect();
    let mean = rolling_mean_values(&squared, period);
    // A window with no drawdown reads exactly 0 (the running mean cannot
    // give that on its own); a gap counts as a drawdown, so its window
    // stays a gap.
    let mut contributing = 0usize;
    (0..values.len())
        .map(|i| {
            if squared[i] != 0.0 {
                contributing += 1;
            }
            if i >= period && squared[i - period] != 0.0 {
                contributing -= 1;
            }
            if contributing == 0 && mean[i].is_finite() {
                0.0
            } else {
                mean[i].sqrt()
            }
        })
        .collect()
}

/// pond-ts `relativeVolatilityIndex` after its checks.
fn relative_volatility_values(values: &[f64], period: usize, stdev: usize) -> Vec<f64> {
    let (_, sigma) = rolling_mean_sd(values, stdev, true);
    let sigma = sigma.expect("asked for the spread");
    let n = values.len();
    let (mut up, mut down) = (vec![f64::NAN; n], vec![f64::NAN; n]);
    for i in 1..n {
        let (s, delta) = (sigma[i], values[i] - values[i - 1]);
        if s.is_nan() || delta.is_nan() {
            continue;
        }
        (up[i], down[i]) = if delta > 0.0 { (s, 0.0) } else { (0.0, s) };
    }
    let (up, down) = par::join(
        || wilder_values(&up, period),
        || wilder_values(&down, period),
    );
    up.iter()
        .zip(&down)
        .map(|(u, d)| (100.0 * u) / (u + d))
        .collect()
}
