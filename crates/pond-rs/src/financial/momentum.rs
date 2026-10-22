//! The momentum family (pond-ts `catalog/momentum.ts`): RSI, the
//! stochastics, Williams %R, Chande momentum, momentum, percent change,
//! the intraday momentum index, the awesome and ultimate oscillators, CCI,
//! the Fisher transform, the psychological line, the pretty good and prime
//! number oscillators, QStick, the relative vigor index, centre of gravity,
//! the Chande forecast oscillator and the true strength index.

use super::averages::{positive, shorter};
use super::kernels::{
    self, Ema, deltas, js_log, js_min, leg, moving_average_values, percent_of_range,
    rolling_extreme, rolling_extremes_strict, rolling_mean_values, symmetric_weighted_values,
    up_down_legs,
};
use super::regression::{linear_regression_values, regression_at};
use super::{MaType, Study};
use crate::error::{PondError, Result};
use crate::par;
use crate::series::TimeSeries;

study_options! {
    /// Options for [`TimeSeries::stochastic`]: %K over 14 bars, slowed by
    /// a 3-bar average, and %D a 3-bar average of %K; writes `stochK` and
    /// `stochD`.
    Stochastic, prefix = "stoch", reads [high, low, close] {
        /// The high-low window in bars (default 14).
        k_period: usize = 14,
        /// The average that slows %K, in bars (default 3).
        slowing: usize = 3,
        /// The average of %K that gives %D, in bars (default 3).
        d_period: usize = 3,
    }
}

study_options! {
    /// Options for [`TimeSeries::stochastic_momentum_index`]: a 13-bar
    /// high-low window, smoothed by EMAs of 25 then 2 bars, with a 3-bar
    /// EMA signal; writes `smi` (the prefix itself) and `smiSignal`.
    StochasticMomentumIndex, prefix = "smi", reads [high, low, close] {
        /// The high-low window in bars (default 13).
        period: usize = 13,
        /// The first smoothing EMA in bars (default 25).
        long: usize = 25,
        /// The second smoothing EMA in bars (default 2).
        short: usize = 2,
        /// The signal EMA in bars (default 3).
        signal: usize = 3,
    }
}

study_options! {
    /// Options for [`TimeSeries::stochastic_rsi`]: a 14-bar RSI placed in
    /// its 14-bar range, %K a 3-bar average of that and %D a 3-bar average
    /// of %K; writes `stochRsiK` and `stochRsiD`.
    StochasticRsi, prefix = "stochRsi" {
        /// The RSI's length in bars (default 14).
        rsi_period: usize = 14,
        /// The window the RSI is ranked in, in bars (default 14).
        stoch_period: usize = 14,
        /// The average that gives %K, in bars (default 3).
        k_period: usize = 3,
        /// The average of %K that gives %D, in bars (default 3).
        d_period: usize = 3,
    }
}

study_options! {
    /// Options for [`TimeSeries::williams_r`]: 14 bars; writes `williamsR`.
    WilliamsR, output = "williamsR", reads [high, low, close] {
        /// The high-low window in bars (default 14).
        period: usize = 14,
    }
}

study_options! {
    /// Options for [`TimeSeries::percent_change`]: the change from one bar
    /// back; writes `pctChange`.
    PercentChange, output = "pctChange" {
        /// How many bars back to compare with (default 1).
        periods: usize = 1,
    }
}

study_options! {
    /// Options for [`TimeSeries::intraday_momentum_index`]: 14 bars;
    /// writes `imi`.
    IntradayMomentumIndex, output = "imi", reads [open, close] {
        /// The window in bars (default 14).
        period: usize = 14,
    }
}

study_options! {
    /// Options for [`TimeSeries::awesome_oscillator`]: 5- and 34-bar
    /// averages of the median price; writes `ao`.
    AwesomeOscillator, output = "ao", reads [high, low] {
        /// The fast average in bars (default 5).
        fast: usize = 5,
        /// The slow average in bars (default 34); must be longer than `fast`.
        slow: usize = 34,
    }
}

study_options! {
    /// Options for [`TimeSeries::ultimate_oscillator`]: 7, 14 and 28 bars,
    /// weighted 4, 2 and 1; writes `uo`.
    UltimateOscillator, output = "uo", reads [high, low, close] {
        /// The short window in bars (default 7).
        short: usize = 7,
        /// The medium window in bars (default 14).
        medium: usize = 14,
        /// The long window in bars (default 28).
        long: usize = 28,
    }
}

/// The scratch column pond-ts's `stochasticRsi` writes its RSI to (so a
/// series that has it is refused there).
const STOCH_RSI_SCRATCH: &str = "__stochRsiRsi__";

study_options! {
    /// Options for [`TimeSeries::commodity_channel_index`]: 20 bars of the
    /// typical price; writes `cci`.
    CommodityChannelIndex, output = "cci", reads [high, low, close] {
        /// The window in bars (default 20).
        period: usize = 20,
    }
}

study_options! {
    /// Options for [`TimeSeries::fisher_transform`]: the median price's
    /// place in its 10-bar range; writes `fisher` (the prefix itself) and
    /// `fisherSignal`.
    FisherTransform, prefix = "fisher", reads [high, low] {
        /// The high-low window in bars (default 10).
        period: usize = 10,
    }
}

study_options! {
    /// Options for [`TimeSeries::pretty_good_oscillator`]: 14 bars; writes
    /// `pgo`. `column` (the price measured) defaults to the `close`
    /// setting, so moving `close` moves both, as in pond-ts.
    PrettyGoodOscillator, output = "pgo", reads [column, high, low, close] {
        /// The window in bars (default 14).
        period: usize = 14,
    }
}

study_options! {
    /// Options for [`TimeSeries::prime_number_oscillator`]: writes `pno`.
    PrimeNumberOscillator, output = "pno" {}
}

study_options! {
    /// Options for [`TimeSeries::qstick`]: an 8-bar simple average of the
    /// candle body; writes `qstick`.
    Qstick, output = "qstick", reads [open, close] {
        /// The average's length in bars (default 8).
        period: usize = 8,
        /// The moving-average type (default simple).
        ma: MaType = MaType::Sma,
    }
}

study_options! {
    /// Options for [`TimeSeries::relative_vigor_index`]: 10 bars; writes
    /// `rvi` (the prefix itself) and `rviSignal`.
    RelativeVigorIndex, prefix = "rvi", reads [open, high, low, close] {
        /// The window in bars (default 10).
        period: usize = 10,
    }
}

study_options! {
    /// Options for [`TimeSeries::true_strength_index`]: changes smoothed by
    /// EMAs of 25 then 13 bars, with a 7-bar EMA signal; writes `tsi` (the
    /// prefix itself) and `tsiSignal`.
    TrueStrengthIndex, prefix = "tsi" {
        /// The first smoothing EMA in bars (default 25).
        long: usize = 25,
        /// The second smoothing EMA in bars (default 13).
        short: usize = 13,
        /// The signal EMA in bars (default 7).
        signal: usize = 7,
    }
}

impl TimeSeries {
    /// Relative strength index (pond-ts `rsi`), output `rsi`: Wilder's
    /// averages of the rises and falls, as `100 - 100 / (1 + rise / fall)`;
    /// 100 where nothing fell, a gap where nothing moved. pond-ts's default
    /// period is 14.
    pub fn rsi(&self, study: Study) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::rsi";
        let (values, output) = self.study_input(CALL, &study, "rsi")?;
        let out = rsi_values(&values, study.period);
        self.study_output(CALL, output, out)
    }

    /// Stochastic oscillator (pond-ts `stochastic`): where the close sits
    /// in the `k_period` bars' high-low range, averaged over `slowing`
    /// bars (%K), and %K averaged over `d_period` bars (%D).
    pub fn stochastic(&self, options: Stochastic) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::stochastic";
        positive(CALL, "kPeriod", options.k_period)?;
        positive(CALL, "slowing", options.slowing)?;
        positive(CALL, "dPeriod", options.d_period)?;
        let names = [
            format!("{}K", options.name()),
            format!("{}D", options.name()),
        ];
        self.free_names(CALL, &names)?;
        let [high, low, close] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.close],
            ["high", "low", "close"],
        )?;
        let (highest, lowest) = par::join(
            || rolling_extreme::<true>(&high, options.k_period),
            || rolling_extreme::<false>(&low, options.k_period),
        );
        let fast_k: Vec<f64> = (0..close.len())
            .map(|i| percent_of_range(highest[i], lowest[i], close[i]))
            .collect();
        let k = rolling_mean_values(&fast_k, options.slowing);
        let d = rolling_mean_values(&k, options.d_period);
        self.study_outputs(CALL, names.into_iter().zip([k, d]))
    }

    /// Stochastic momentum index (pond-ts `stochasticMomentumIndex`): the
    /// close's distance from the middle of the `period` bars' high-low
    /// range, as a percent of half that range, each smoothed by an EMA of
    /// `long` then `short` bars; the signal is an EMA of `signal` bars.
    pub fn stochastic_momentum_index(
        &self,
        options: StochasticMomentumIndex,
    ) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::stochastic_momentum_index";
        positive(CALL, "period", options.period)?;
        positive(CALL, "longPeriod", options.long)?;
        positive(CALL, "shortPeriod", options.short)?;
        positive(CALL, "signalPeriod", options.signal)?;
        let names = [
            options.name().to_string(),
            format!("{}Signal", options.name()),
        ];
        self.free_names(CALL, &names)?;
        let [high, low, close] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.close],
            ["high", "low", "close"],
        )?;
        let (highest, lowest) = par::join(
            || rolling_extreme::<true>(&high, options.period),
            || rolling_extreme::<false>(&low, options.period),
        );
        // The five EMAs run row by row in one pass (no column in between,
        // and the chains overlap in the processor): the same operations in
        // the same order as pond-ts's column-at-a-time EMAs, so the same bits.
        let ema = Ema::period;
        let (mut num_long, mut num_short) = (ema(options.long), ema(options.short));
        let (mut den_long, mut den_short) = (ema(options.long), ema(options.short));
        let mut signal_ema = ema(options.signal);
        let n = close.len();
        let mut line = Vec::with_capacity(n);
        let mut signal = Vec::with_capacity(n);
        for i in 0..n {
            let numerator =
                num_short.push(num_long.push(close[i] - (highest[i] + lowest[i]) / 2.0));
            let half_range = if close[i].is_finite() {
                (highest[i] - lowest[i]) / 2.0
            } else {
                f64::NAN
            };
            let denominator = den_short.push(den_long.push(half_range));
            let value = if denominator == 0.0 {
                f64::NAN
            } else {
                (100.0 * numerator) / denominator
            };
            line.push(value);
            signal.push(signal_ema.push(value));
        }
        self.study_outputs(CALL, names.into_iter().zip([line, signal]))
    }

    /// Stochastic RSI (pond-ts `stochasticRsi`): where the RSI sits in its
    /// `stoch_period` bars' range, averaged over `k_period` bars (%K), and
    /// %K averaged over `d_period` bars (%D).
    pub fn stochastic_rsi(&self, options: StochasticRsi) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::stochastic_rsi";
        positive(CALL, "rsiPeriod", options.rsi_period)?;
        positive(CALL, "stochPeriod", options.stoch_period)?;
        positive(CALL, "kPeriod", options.k_period)?;
        positive(CALL, "dPeriod", options.d_period)?;
        let names = [
            format!("{}K", options.name()),
            format!("{}D", options.name()),
        ];
        self.free_names(CALL, &names)?;
        // pond-ts writes the RSI to a scratch column first.
        self.free_names(CALL, &[STOCH_RSI_SCRATCH])?;
        let values = self.study_source(CALL, options.source())?;
        let rsi = rsi_values(&values, options.rsi_period);
        let (highest, lowest) = rolling_extremes_strict(&rsi, options.stoch_period);
        let fast_k: Vec<f64> = (0..rsi.len())
            .map(|i| percent_of_range(highest[i], lowest[i], rsi[i]))
            .collect();
        let k = rolling_mean_values(&fast_k, options.k_period);
        let d = rolling_mean_values(&k, options.d_period);
        self.study_outputs(CALL, names.into_iter().zip([k, d]))
    }

    /// Williams %R (pond-ts `williamsR`), output `williamsR`: where the
    /// close sits in the `period` bars' high-low range, from -100 (the
    /// low) to 0 (the high).
    pub fn williams_r(&self, options: WilliamsR) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::williams_r";
        positive(CALL, "period", options.period)?;
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [high, low, close] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.close],
            ["high", "low", "close"],
        )?;
        let (highest, lowest) = par::join(
            || rolling_extreme::<true>(&high, options.period),
            || rolling_extreme::<false>(&low, options.period),
        );
        let out = (0..close.len())
            .map(|i| percent_of_range(highest[i], lowest[i], close[i]) - 100.0)
            .collect();
        self.study_output(CALL, output, out)
    }

    /// Chande momentum oscillator (pond-ts `chandeMomentum`), output `cmo`:
    /// `100 * (rises - falls) / (rises + falls)` over the window, from the
    /// window means of each. pond-ts's default period is 14.
    pub fn chande_momentum(&self, study: Study) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::chande_momentum";
        let (values, output) = self.study_input(CALL, &study, "cmo")?;
        let (up, down) = up_down_legs(deltas(&values));
        let (up, down) = par::join(
            || rolling_mean_values(&up, study.period),
            || rolling_mean_values(&down, study.period),
        );
        let out = up
            .iter()
            .zip(&down)
            .map(|(&u, &d)| (100.0 * (u - d)) / (u + d))
            .collect();
        self.study_output(CALL, output, out)
    }

    /// Momentum (pond-ts `momentum`), output `momentum`: the value minus
    /// the value `period` bars back. pond-ts's default period is 10.
    pub fn momentum(&self, study: Study) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::momentum";
        let (values, output) = self.study_input(CALL, &study, "momentum")?;
        let p = study.period;
        let out = (0..values.len())
            .map(|i| {
                if i < p {
                    f64::NAN
                } else {
                    values[i] - values[i - p]
                }
            })
            .collect();
        self.study_output(CALL, output, out)
    }

    /// Percent change (pond-ts `percentChange`), output `pctChange`: the
    /// change from `periods` bars back, as a percent of that value; a gap
    /// where it is zero.
    pub fn percent_change(&self, options: PercentChange) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::percent_change";
        if options.periods == 0 {
            return Err(PondError::InvalidData {
                call: CALL,
                message: "percentChange periods must be a positive integer".into(),
            });
        }
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let values = self.study_source(CALL, options.source())?;
        let out = kernels::percent_change_values(&values, options.periods);
        self.study_output(CALL, output, out)
    }

    /// Intraday momentum index (pond-ts `intradayMomentumIndex`), output
    /// `imi`: the RSI idea on each bar's body (close minus open): the
    /// window mean of rising bodies as a percent of both.
    pub fn intraday_momentum_index(&self, options: IntradayMomentumIndex) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::intraday_momentum_index";
        positive(CALL, "period", options.period)?;
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [open, close] =
            self.price_columns(CALL, [&options.open, &options.close], ["open", "close"])?;
        let (up, down) = up_down_legs(close.iter().zip(open.iter()).map(|(c, o)| c - o));
        let (up, down) = par::join(
            || rolling_mean_values(&up, options.period),
            || rolling_mean_values(&down, options.period),
        );
        let out = up
            .iter()
            .zip(&down)
            .map(|(&u, &d)| (100.0 * u) / (u + d))
            .collect();
        self.study_output(CALL, output, out)
    }

    /// Awesome oscillator (pond-ts `awesomeOscillator`), output `ao`: the
    /// `fast`-bar average of the median price `(high + low) / 2` minus the
    /// `slow`-bar one.
    pub fn awesome_oscillator(&self, options: AwesomeOscillator) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::awesome_oscillator";
        positive(CALL, "fastPeriod", options.fast)?;
        positive(CALL, "slowPeriod", options.slow)?;
        shorter(CALL, "awesomeOscillator", options.fast, options.slow)?;
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [high, low] =
            self.price_columns(CALL, [&options.high, &options.low], ["high", "low"])?;
        let median = kernels::median_price_values(&high, &low);
        let (fast, slow) = par::join(
            || rolling_mean_values(&median, options.fast),
            || rolling_mean_values(&median, options.slow),
        );
        let out = fast.iter().zip(&slow).map(|(f, s)| f - s).collect();
        self.study_output(CALL, output, out)
    }

    /// Ultimate oscillator (pond-ts `ultimateOscillator`), output `uo`:
    /// buying pressure (close minus the lower of the low and the last
    /// close) over the true range, averaged over three windows and
    /// weighted 4, 2 and 1, as a percent.
    pub fn ultimate_oscillator(&self, options: UltimateOscillator) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::ultimate_oscillator";
        positive(CALL, "shortPeriod", options.short)?;
        positive(CALL, "mediumPeriod", options.medium)?;
        positive(CALL, "longPeriod", options.long)?;
        if !(options.short < options.medium && options.medium < options.long) {
            return Err(PondError::InvalidData {
                call: CALL,
                message: "ultimateOscillator periods must be strictly increasing: shortPeriod < mediumPeriod < longPeriod (the 4/2/1 weights are positional)".into(),
            });
        }
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [high, low, close] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.close],
            ["high", "low", "close"],
        )?;
        let true_range = kernels::true_range_values(&high, &low, &close);
        let buying: Vec<f64> = (0..close.len())
            .map(|i| {
                if i == 0 {
                    f64::NAN
                } else {
                    close[i] - js_min(low[i], close[i - 1])
                }
            })
            .collect();
        let legs = par::map(&[options.short, options.medium, options.long], |&n| {
            par::join(
                || rolling_mean_values(&buying, n),
                || rolling_mean_values(&true_range, n),
            )
        });
        let out = (0..close.len())
            .map(|i| {
                let mut weighted = 0.0;
                for (k, (bp, tr)) in legs.iter().enumerate() {
                    let tr = tr[i];
                    let ratio = if tr == 0.0 { f64::NAN } else { bp[i] / tr };
                    weighted += [4.0, 2.0, 1.0][k] * ratio;
                }
                (100.0 * weighted) / 7.0
            })
            .collect();
        self.study_output(CALL, output, out)
    }

    /// Commodity channel index (pond-ts `commodityChannelIndex`), output
    /// `cci`: the typical price's distance from its `period`-bar mean, over
    /// 0.015 times the window's mean absolute deviation. A window with no
    /// deviation gives a gap.
    pub fn commodity_channel_index(&self, options: CommodityChannelIndex) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::commodity_channel_index";
        positive(CALL, "period", options.period)?;
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [high, low, close] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.close],
            ["high", "low", "close"],
        )?;
        let typical = kernels::typical_price_values(&high, &low, &close);
        let (mean, deviation) = par::join(
            || rolling_mean_values(&typical, options.period),
            || kernels::rolling_mean_abs_dev_values(&typical, options.period),
        );
        let out = (0..typical.len())
            .map(|i| (typical[i] - mean[i]) / (0.015 * deviation[i]))
            .collect();
        self.study_output(CALL, output, out)
    }

    /// Fisher transform (pond-ts `fisherTransform`): the median price's
    /// place in its `period`-bar range, rescaled to -1..1, smoothed and
    /// clamped, then `0.5 ln((1 + x) / (1 - x))` smoothed; the signal is
    /// the previous bar's value. Each run of rows without a gap starts
    /// again from zero.
    pub fn fisher_transform(&self, options: FisherTransform) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::fisher_transform";
        positive(CALL, "period", options.period)?;
        let names = [
            options.name().to_string(),
            format!("{}Signal", options.name()),
        ];
        self.free_names(CALL, &names)?;
        let [high, low] =
            self.price_columns(CALL, [&options.high, &options.low], ["high", "low"])?;
        let price = kernels::median_price_values(&high, &low);
        let (highest, lowest) = rolling_extremes_strict(&price, options.period);
        let n = price.len();
        let (mut line, mut signal) = (vec![f64::NAN; n], vec![f64::NAN; n]);
        // pond-ts's `foldRows`: `run` counts the rows since the last gap.
        let (mut run, mut value, mut fish) = (0usize, 0.0, 0.0);
        for i in 0..n {
            let x = percent_of_range(highest[i], lowest[i], price[i]) / 50.0 - 1.0;
            if x.is_nan() {
                run = 0;
                continue;
            }
            run += 1;
            if run == 1 {
                (value, fish) = (0.0, 0.0);
            }
            // Ehlers' clamp: tested at 0.99, replaced by 0.999.
            let mut v = 0.33 * x + 0.67 * value;
            if v > 0.99 {
                v = 0.999;
            } else if v < -0.99 {
                v = -0.999;
            }
            value = v;
            let next = 0.5 * js_log((1.0 + v) / (1.0 - v)) + 0.5 * fish;
            line[i] = next;
            if run >= 2 {
                signal[i] = fish;
            }
            fish = next;
        }
        self.study_outputs(CALL, names.into_iter().zip([line, signal]))
    }

    /// Psychological line (pond-ts `psychologicalLine`), output `psy`: the
    /// percent of the last `period` bars that closed above the bar before.
    /// pond-ts's default period is 12.
    pub fn psychological_line(&self, study: Study) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::psychological_line";
        let (values, output) = self.study_input(CALL, &study, "psy")?;
        let up: Vec<f64> = deltas(&values)
            .map(|d| {
                if d.is_nan() {
                    f64::NAN
                } else if d > 0.0 {
                    1.0
                } else {
                    0.0
                }
            })
            .collect();
        let out = rolling_mean_values(&up, study.period)
            .into_iter()
            .map(|f| 100.0 * f)
            .collect();
        self.study_output(CALL, output, out)
    }

    /// Pretty good oscillator (pond-ts `prettyGoodOscillator`), output
    /// `pgo`: the column's distance from its `period`-bar mean, in
    /// `period`-bar EMAs of the true range.
    pub fn pretty_good_oscillator(&self, options: PrettyGoodOscillator) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::pretty_good_oscillator";
        positive(CALL, "period", options.period)?;
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let close_name = options.close.as_deref().unwrap_or("close");
        let field = self.study_source(CALL, options.column.as_deref().unwrap_or(close_name))?;
        let [high, low, close] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.close],
            ["high", "low", "close"],
        )?;
        let (average, range) = par::join(
            || kernels::ma_column(&field, options.period, MaType::Sma),
            || {
                kernels::ema_values(
                    &kernels::true_range_values(&high, &low, &close),
                    options.period,
                )
            },
        );
        let out = (0..field.len())
            .map(|i| {
                let d = range[i];
                if d == 0.0 {
                    f64::NAN
                } else {
                    (field[i] - average[i]) / d
                }
            })
            .collect();
        self.study_output(CALL, output, out)
    }

    /// Prime number oscillator (pond-ts `primeNumberOscillator`), output
    /// `pno`: the column minus the prime nearest it (the lower prime on a
    /// tie); a gap below 2 or past 2^53 - 1.
    pub fn prime_number_oscillator(&self, options: PrimeNumberOscillator) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::prime_number_oscillator";
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let values = self.study_source(CALL, options.source())?;
        let mut out = vec![0.0; values.len()];
        // Each row stands alone, so stretches of rows can run on any core.
        par::fill_chunks(&mut out, &mut [], 1 << 14, |start, out, _| {
            for (k, o) in out.iter_mut().enumerate() {
                let v = values[start + k];
                *o = v - kernels::nearest_prime(v);
            }
        });
        self.study_output(CALL, output, out)
    }

    /// QStick (pond-ts `qstick`), output `qstick`: a `period`-bar moving
    /// average of the candle body, close minus open.
    pub fn qstick(&self, options: Qstick) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::qstick";
        positive(CALL, "period", options.period)?;
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [open, close] =
            self.price_columns(CALL, [&options.open, &options.close], ["open", "close"])?;
        let body: Vec<f64> = close.iter().zip(open.iter()).map(|(c, o)| c - o).collect();
        let out = moving_average_values(&body, options.period, options.ma);
        self.study_output(CALL, output, out)
    }

    /// Relative vigor index (pond-ts `relativeVigorIndex`): the 4-bar
    /// symmetric weighted body (close minus open) over the same of the
    /// range (high minus low), each averaged over `period` bars; the
    /// signal is the 4-bar symmetric weighted mean of the index.
    pub fn relative_vigor_index(&self, options: RelativeVigorIndex) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::relative_vigor_index";
        positive(CALL, "period", options.period)?;
        let names = [
            options.name().to_string(),
            format!("{}Signal", options.name()),
        ];
        self.free_names(CALL, &names)?;
        let [open, high, low, close] = self.price_columns(
            CALL,
            [&options.open, &options.high, &options.low, &options.close],
            ["open", "high", "low", "close"],
        )?;
        let n = close.len();
        let (numerator, denominator) = par::join(
            || {
                let body: Vec<f64> = (0..n).map(|i| close[i] - open[i]).collect();
                rolling_mean_values(&symmetric_weighted_values(&body), options.period)
            },
            || {
                let range: Vec<f64> = (0..n).map(|i| high[i] - low[i]).collect();
                rolling_mean_values(&symmetric_weighted_values(&range), options.period)
            },
        );
        let index: Vec<f64> = numerator
            .iter()
            .zip(&denominator)
            .map(|(&u, &d)| if d == 0.0 { f64::NAN } else { u / d })
            .collect();
        let signal = symmetric_weighted_values(&index);
        self.study_outputs(CALL, names.into_iter().zip([index, signal]))
    }

    /// Centre of gravity (pond-ts `centerOfGravity`), output `cog`: where
    /// the window's values balance, in bars, from the window's weighted and
    /// plain means; a gap where the mean is 0. pond-ts's default period is
    /// 10.
    pub fn center_of_gravity(&self, study: Study) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::center_of_gravity";
        let (values, output) = self.study_input(CALL, &study, "cog")?;
        let (weighted, mean) = par::join(
            || moving_average_values(&values, study.period, MaType::Wma),
            || rolling_mean_values(&values, study.period),
        );
        let p1 = study.period as f64 + 1.0;
        let out = weighted
            .iter()
            .zip(&mean)
            .map(|(&w, &m)| {
                if m == 0.0 {
                    f64::NAN
                } else {
                    p1 * (w / (2.0 * m) - 1.0)
                }
            })
            .collect();
        self.study_output(CALL, output, out)
    }

    /// Chande forecast oscillator (pond-ts `chandeForecastOscillator`),
    /// output `cfo`: the value's distance from its `period`-bar linear
    /// regression's forecast, as a percent of the value; a gap where the
    /// value is 0. The period must be at least 2. pond-ts's default period
    /// is 14.
    pub fn chande_forecast_oscillator(&self, study: Study) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::chande_forecast_oscillator";
        if study.period == 1 {
            return Err(PondError::InvalidData {
                call: CALL,
                message: "chandeForecastOscillator period must be at least 2 (a one-bar window has no slope: the regression denominator n²(n²−1)/12 is 0 at n = 1)".into(),
            });
        }
        let (values, output) = self.study_input(CALL, &study, "cfo")?;
        let fit = linear_regression_values(&values, study.period);
        let forecast = regression_at(&fit, study.period as f64);
        let out = values
            .iter()
            .zip(&forecast)
            .map(|(&v, &f)| {
                if v == 0.0 {
                    f64::NAN
                } else {
                    (100.0 * (v - f)) / v
                }
            })
            .collect();
        self.study_output(CALL, output, out)
    }

    /// True strength index (pond-ts `trueStrengthIndex`): each change and
    /// its size, each smoothed by an EMA of `long` then `short` bars, as
    /// `100 * change / size`; the signal is an EMA of `signal` bars.
    pub fn true_strength_index(&self, options: TrueStrengthIndex) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::true_strength_index";
        positive(CALL, "longPeriod", options.long)?;
        positive(CALL, "shortPeriod", options.short)?;
        positive(CALL, "signalPeriod", options.signal)?;
        let names = [
            options.name().to_string(),
            format!("{}Signal", options.name()),
        ];
        self.free_names(CALL, &names)?;
        let values = self.study_source(CALL, options.source())?;
        // The five EMAs run row by row in one pass, as in
        // `stochastic_momentum_index`: the same operations in the same
        // order as pond-ts's column-at-a-time EMAs, so the same bits.
        let ema = Ema::period;
        let (mut num_long, mut num_short) = (ema(options.long), ema(options.short));
        let (mut den_long, mut den_short) = (ema(options.long), ema(options.short));
        let mut signal_ema = ema(options.signal);
        let n = values.len();
        let mut line = Vec::with_capacity(n);
        let mut signal = Vec::with_capacity(n);
        for d in deltas(&values) {
            let numerator = num_short.push(num_long.push(d));
            let denominator = den_short.push(den_long.push(d.abs()));
            let value = (100.0 * numerator) / denominator;
            line.push(value);
            signal.push(signal_ema.push(value));
        }
        self.study_outputs(CALL, names.into_iter().zip([line, signal]))
    }
}

/// pond-ts `rsi`'s values: Wilder's averages of the rises and falls.
fn rsi_values(values: &[f64], period: usize) -> Vec<f64> {
    // pond-ts runs Wilder's average (`wilderValues`) over the rises and
    // over the falls. Both have their gaps on the same rows, so they start
    // on the same row; here they run side by side in one pass with the same
    // operations in the same order (same bits), and no column in between.
    let n = values.len();
    let mut out = vec![f64::NAN; n];
    let change = |i: usize| values[i] - values[i - 1];
    let first = (1..n).find(|&i| !change(i).is_nan()).unwrap_or(n);
    let seed_at = first.saturating_add(period - 1);
    if seed_at >= n {
        return out;
    }
    let rsi = |g: f64, l: f64| {
        if l == 0.0 {
            if g == 0.0 { f64::NAN } else { 100.0 }
        } else {
            100.0 - 100.0 / (1.0 + g / l)
        }
    };
    let p = period as f64;
    let (mut gain, mut loss) = (0.0, 0.0);
    for i in first..=seed_at {
        let (u, d) = leg(change(i));
        gain += u;
        loss += d;
    }
    gain /= p;
    loss /= p;
    out[seed_at] = rsi(gain, loss);
    for (i, slot) in out.iter_mut().enumerate().skip(seed_at + 1) {
        let (u, d) = leg(change(i));
        gain = (gain * (p - 1.0) + u) / p;
        loss = (loss * (p - 1.0) + d) / p;
        *slot = rsi(gain, loss);
    }
    out
}
