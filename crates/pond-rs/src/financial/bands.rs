//! The bands family (pond-ts `catalog/bands.ts`): a centre line and an
//! envelope around it, drawn from a moving average, the standard deviation,
//! the average true range, the window's high and low, or primes.

use super::MaType;
use super::averages::positive;
use super::kernels::{self, ma_column, moving_average_values, rolling_extreme, rolling_mean_sd};
use crate::error::{PondError, Result};
use crate::par;
use crate::series::TimeSeries;

study_options! {
    /// Options for [`TimeSeries::bollinger`]: a `period`-bar average with
    /// bands `std_dev` standard deviations away (default 2); writes
    /// `bbMiddle`, `bbUpper` and `bbLower`. pond-ts has no default period,
    /// so this takes one.
    ///
    /// ```
    /// use pond_rs::financial::Bollinger;
    /// let wide = Bollinger::new(20).std_dev(2.5).prefix("wide");
    /// ```
    Bollinger(period: usize), prefix = "bb" {
        /// The bands' distance in standard deviations (default 2).
        std_dev: f64 = 2.0,
    }
}

study_options! {
    /// Options for [`TimeSeries::bollinger_bandwidth`]: 20 bars and 2
    /// standard deviations; writes `bbWidth`.
    BollingerBandwidth, output = "bbWidth" {
        /// The window in bars (default 20).
        period: usize = 20,
        /// The bands' distance in standard deviations (default 2).
        std_dev: f64 = 2.0,
    }
}

study_options! {
    /// Options for [`TimeSeries::bollinger_percent_b`]: 20 bars and 2
    /// standard deviations; writes `percentB`.
    BollingerPercentB, output = "percentB" {
        /// The window in bars (default 20).
        period: usize = 20,
        /// The bands' distance in standard deviations (default 2).
        std_dev: f64 = 2.0,
    }
}

study_options! {
    /// Options for [`TimeSeries::keltner`]: a 20-bar `Ema` of the typical
    /// price with bands 2 × the 10-bar average true range away; writes
    /// `kcMiddle`, `kcUpper` and `kcLower`.
    Keltner, prefix = "kc", reads [high, low, close] {
        /// The centre's length in bars (default 20).
        period: usize = 20,
        /// The average true range's length in bars (default 10).
        atr_period: usize = 10,
        /// How many average true ranges the bands sit from the centre (default 2).
        multiplier: f64 = 2.0,
        /// The centre's kind of moving average (default `Ema`).
        ma: MaType = MaType::Ema,
    }
}

study_options! {
    /// Options for [`TimeSeries::starc_bands`]: a 20-bar `Sma` of the close
    /// with bands 2 × the 15-bar average true range away; writes
    /// `starcMiddle`, `starcUpper` and `starcLower`.
    StarcBands, prefix = "starc", reads [high, low, close] {
        /// The centre's length in bars (default 20).
        period: usize = 20,
        /// The average true range's length in bars (default 15).
        atr_period: usize = 15,
        /// How many average true ranges the bands sit from the centre (default 2).
        multiplier: f64 = 2.0,
        /// The centre's kind of moving average (default `Sma`).
        ma: MaType = MaType::Sma,
    }
}

study_options! {
    /// Options for [`TimeSeries::atr_bands`]: bands 2 × the 14-bar average
    /// true range either side of `column`, which defaults to the close
    /// column the true range reads; writes `atrbUpper` and `atrbLower`.
    AtrBands, prefix = "atrb", reads [column, high, low, close] {
        /// The average true range's length in bars (default 14).
        period: usize = 14,
        /// How many average true ranges the bands sit from the column (default 2).
        multiplier: f64 = 2.0,
    }
}

study_options! {
    /// Options for [`TimeSeries::donchian`]: the highest high and lowest
    /// low of 20 bars; writes `dcUpper`, `dcLower` and `dcMiddle`.
    Donchian, prefix = "dc", reads [high, low] {
        /// The window in bars (default 20).
        period: usize = 20,
    }
}

study_options! {
    /// Options for [`TimeSeries::high_low_bands`]: a 10-bar `Trima` of the
    /// median price with bands 1% either side; writes `hlbMiddle`,
    /// `hlbUpper` and `hlbLower`.
    HighLowBands, prefix = "hlb", reads [high, low] {
        /// The centre's length in bars (default 10).
        period: usize = 10,
        /// The bands' distance as a percent of the centre (default 1).
        percent: f64 = 1.0,
        /// The centre's kind of moving average (default `Trima`).
        ma: MaType = MaType::Trima,
    }
}

study_options! {
    /// Options for [`TimeSeries::prime_number_bands`]: writes `pnbUpper`
    /// and `pnbLower`.
    PrimeNumberBands, prefix = "pnb", reads [high, low] {}
}

study_options! {
    /// Options for [`TimeSeries::envelope`]: a `period`-bar `Sma` with
    /// bands 2.5% either side; writes `envMiddle`, `envUpper` and
    /// `envLower`. pond-ts has no default period, so this takes one.
    Envelope(period: usize), prefix = "env" {
        /// The bands' distance as a percent of the centre (default 2.5).
        percent: f64 = 2.5,
        /// The centre's kind of moving average (default `Sma`).
        ma: MaType = MaType::Sma,
    }
}

impl TimeSeries {
    /// Bollinger bands (pond-ts `bollinger`): the `period`-bar mean of the
    /// column and bands `std_dev` population standard deviations either
    /// side, as `{prefix}Middle`, `{prefix}Upper` and `{prefix}Lower`.
    pub fn bollinger(&self, options: Bollinger) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::bollinger";
        positive(CALL, "period", options.period)?;
        positive_finite(CALL, "bollinger stdDev", options.std_dev)?;
        let names = suffixed(options.name(), ["Middle", "Upper", "Lower"]);
        self.free_names(CALL, &names)?;
        let values = self.study_source(CALL, options.source())?;
        let (middle, sd) = mean_and_sd(&values, options.period);
        let (upper, lower) = bands(&middle, &sd, options.std_dev);
        self.study_outputs(CALL, names.into_iter().zip([middle, upper, lower]))
    }

    /// Bollinger bandwidth (pond-ts `bollingerBandwidth`), output `bbWidth`:
    /// the gap between the bands as a percent of the middle; a gap where
    /// the middle is zero.
    pub fn bollinger_bandwidth(&self, options: BollingerBandwidth) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::bollinger_bandwidth";
        positive(CALL, "period", options.period)?;
        positive_finite(CALL, "bollingerBandwidth stdDev", options.std_dev)?;
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let values = self.study_source(CALL, options.source())?;
        let (middle, sd) = mean_and_sd(&values, options.period);
        let k = options.std_dev;
        let out = middle
            .iter()
            .zip(&sd)
            .map(|(&m, &d)| {
                let upper = m + k * d;
                let lower = m + -k * d;
                if m == 0.0 {
                    f64::NAN
                } else {
                    (100.0 * (upper - lower)) / m
                }
            })
            .collect();
        self.study_output(CALL, output, out)
    }

    /// Bollinger %B (pond-ts `bollingerPercentB`), output `percentB`: where
    /// the value sits between the bands (0 at the lower, 1 at the upper); a
    /// gap where the standard deviation is zero.
    pub fn bollinger_percent_b(&self, options: BollingerPercentB) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::bollinger_percent_b";
        positive(CALL, "period", options.period)?;
        positive_finite(CALL, "bollingerPercentB stdDev", options.std_dev)?;
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let values = self.study_source(CALL, options.source())?;
        let (middle, sd) = mean_and_sd(&values, options.period);
        let k = options.std_dev;
        let out = (0..values.len())
            .map(|i| {
                let (m, d) = (middle[i], sd[i]);
                let upper = m + k * d;
                let lower = m + -k * d;
                if d == 0.0 {
                    f64::NAN
                } else {
                    (values[i] - lower) / (upper - lower)
                }
            })
            .collect();
        self.study_output(CALL, output, out)
    }

    /// Keltner channels (pond-ts `keltner`): a moving average of the
    /// typical price `(high + low + close) / 3` with bands `multiplier`
    /// average true ranges either side.
    pub fn keltner(&self, options: Keltner) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::keltner";
        positive(CALL, "period", options.period)?;
        positive(CALL, "atrPeriod", options.atr_period)?;
        positive_finite(CALL, "keltner multiplier", options.multiplier)?;
        let names = suffixed(options.name(), ["Middle", "Upper", "Lower"]);
        self.free_names(CALL, &names)?;
        let [high, low, close] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.close],
            ["high", "low", "close"],
        )?;
        let (middle, atr) = par::join(
            || {
                let typical = kernels::typical_price_values(&high, &low, &close);
                moving_average_values(&typical, options.period, options.ma)
            },
            || kernels::atr_values(&high, &low, &close, options.atr_period),
        );
        let (upper, lower) = bands(&middle, &atr, options.multiplier);
        self.study_outputs(CALL, names.into_iter().zip([middle, upper, lower]))
    }

    /// STARC bands (pond-ts `starcBands`): a moving average of the close
    /// with bands `multiplier` average true ranges either side.
    pub fn starc_bands(&self, options: StarcBands) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::starc_bands";
        positive(CALL, "period", options.period)?;
        positive(CALL, "atrPeriod", options.atr_period)?;
        positive_finite(CALL, "starcBands multiplier", options.multiplier)?;
        let names = suffixed(options.name(), ["Middle", "Upper", "Lower"]);
        self.free_names(CALL, &names)?;
        let [high, low, close] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.close],
            ["high", "low", "close"],
        )?;
        let (middle, atr) = par::join(
            || ma_column(&close, options.period, options.ma),
            || kernels::atr_values(&high, &low, &close, options.atr_period),
        );
        let (upper, lower) = bands(&middle, &atr, options.multiplier);
        self.study_outputs(CALL, names.into_iter().zip([middle, upper, lower]))
    }

    /// ATR bands (pond-ts `atrBands`): bands `multiplier` average true
    /// ranges either side of `column` (default: the close column).
    pub fn atr_bands(&self, options: AtrBands) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::atr_bands";
        positive(CALL, "period", options.period)?;
        positive_finite(CALL, "atrBands multiplier", options.multiplier)?;
        let names = suffixed(options.name(), ["Upper", "Lower"]);
        self.free_names(CALL, &names)?;
        let [high, low, close] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.close],
            ["high", "low", "close"],
        )?;
        let column = (options.column.as_deref())
            .unwrap_or_else(|| options.close.as_deref().unwrap_or("close"));
        let field = self.study_source(CALL, column)?;
        let atr = kernels::atr_values(&high, &low, &close, options.period);
        let (upper, lower) = bands(&field, &atr, options.multiplier);
        self.study_outputs(CALL, names.into_iter().zip([upper, lower]))
    }

    /// Donchian channels (pond-ts `donchian`): the highest high and lowest
    /// low of the last `period` bars and the midpoint between them, as
    /// `{prefix}Upper`, `{prefix}Lower` and `{prefix}Middle`.
    pub fn donchian(&self, options: Donchian) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::donchian";
        positive(CALL, "period", options.period)?;
        let names = suffixed(options.name(), ["Upper", "Lower", "Middle"]);
        self.free_names(CALL, &names)?;
        let high = self.study_source(CALL, options.high.as_deref().unwrap_or("high"))?;
        let low = self.study_source(CALL, options.low.as_deref().unwrap_or("low"))?;
        let (highest, lowest) = par::join(
            || rolling_extreme::<true>(&high, options.period),
            || rolling_extreme::<false>(&low, options.period),
        );
        let middle = highest
            .iter()
            .zip(&lowest)
            .map(|(h, l)| (h + l) / 2.0)
            .collect();
        self.study_outputs(CALL, names.into_iter().zip([highest, lowest, middle]))
    }

    /// High-low bands (pond-ts `highLowBands`): a moving average of the
    /// median price `(high + low) / 2` with bands `percent`% either side.
    pub fn high_low_bands(&self, options: HighLowBands) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::high_low_bands";
        positive(CALL, "period", options.period)?;
        positive_finite(CALL, "highLowBands percent", options.percent)?;
        let names = suffixed(options.name(), ["Middle", "Upper", "Lower"]);
        self.free_names(CALL, &names)?;
        let high = self.study_source(CALL, options.high.as_deref().unwrap_or("high"))?;
        let low = self.study_source(CALL, options.low.as_deref().unwrap_or("low"))?;
        let median = kernels::median_price_values(&high, &low);
        let middle = moving_average_values(&median, options.period, options.ma);
        let (upper, lower) = scaled(&middle, options.percent);
        self.study_outputs(CALL, names.into_iter().zip([middle, upper, lower]))
    }

    /// Prime number bands (pond-ts `primeNumberBands`): the smallest prime
    /// at or above each high and the largest at or below each low; a gap
    /// below 2 or above 2^53 − 1.
    pub fn prime_number_bands(&self, options: PrimeNumberBands) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::prime_number_bands";
        let names = suffixed(options.name(), ["Upper", "Lower"]);
        self.free_names(CALL, &names)?;
        let high = self.study_source(CALL, options.high.as_deref().unwrap_or("high"))?;
        let low = self.study_source(CALL, options.low.as_deref().unwrap_or("low"))?;
        let mut upper = vec![0.0; high.len()];
        let mut lower = vec![0.0; high.len()];
        // Each row stands alone, so stretches of rows can run on any core.
        par::fill_chunks(&mut upper, &mut lower, 1 << 14, |start, upper, lower| {
            for (k, (u, l)) in upper.iter_mut().zip(lower.iter_mut()).enumerate() {
                *u = kernels::prime_at_or_above(high[start + k]);
                *l = kernels::prime_at_or_below(low[start + k]);
            }
        });
        self.study_outputs(CALL, names.into_iter().zip([upper, lower]))
    }

    /// Moving-average envelope (pond-ts `envelope`): a moving average of
    /// the column with bands `percent`% either side.
    pub fn envelope(&self, options: Envelope) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::envelope";
        positive(CALL, "period", options.period)?;
        positive_finite(CALL, "envelope percent", options.percent)?;
        let names = suffixed(options.name(), ["Middle", "Upper", "Lower"]);
        self.free_names(CALL, &names)?;
        let values = self.study_source(CALL, options.source())?;
        let middle = ma_column(&values, options.period, options.ma);
        let (upper, lower) = scaled(&middle, options.percent);
        self.study_outputs(CALL, names.into_iter().zip([middle, upper, lower]))
    }
}

/// The window mean and population standard deviation (pond-ts
/// `rollingColumns` with `avg` and `stdev`, which takes the range-exact
/// path).
fn mean_and_sd(values: &[f64], period: usize) -> (Vec<f64>, Vec<f64>) {
    let (mean, sd) = rolling_mean_sd(values, period, true);
    (mean, sd.expect("asked for the spread"))
}

/// `centre ± k × width`, as pond-ts writes it: `centre + sign * k * width`.
fn bands(centre: &[f64], width: &[f64], k: f64) -> (Vec<f64>, Vec<f64>) {
    let mut upper = vec![0.0; centre.len()];
    let mut lower = vec![0.0; centre.len()];
    par::fill_chunks(&mut upper, &mut lower, 1 << 16, |start, upper, lower| {
        for (j, (u, l)) in upper.iter_mut().zip(lower.iter_mut()).enumerate() {
            let (c, w) = (centre[start + j], width[start + j]);
            *u = c + k * w;
            *l = c + -k * w;
        }
    });
    (upper, lower)
}

/// `centre × (1 ± percent / 100)`.
fn scaled(centre: &[f64], percent: f64) -> (Vec<f64>, Vec<f64>) {
    let f = percent / 100.0;
    let (up, down) = (1.0 + f, 1.0 - f);
    let mut upper = vec![0.0; centre.len()];
    let mut lower = vec![0.0; centre.len()];
    par::fill_chunks(&mut upper, &mut lower, 1 << 16, |start, upper, lower| {
        for (j, (u, l)) in upper.iter_mut().zip(lower.iter_mut()).enumerate() {
            *u = centre[start + j] * up;
            *l = centre[start + j] * down;
        }
    });
    (upper, lower)
}

/// `prefix` plus each suffix.
pub(super) fn suffixed<const N: usize>(prefix: &str, suffixes: [&str; N]) -> [String; N] {
    suffixes.map(|s| format!("{prefix}{s}"))
}

/// pond-ts's check on a multiplier or percent: finite and above zero.
pub(super) fn positive_finite(call: &'static str, what: &str, value: f64) -> Result<()> {
    if !value.is_finite() || value <= 0.0 {
        return Err(PondError::InvalidData {
            call,
            message: format!("{what} must be a positive finite number"),
        });
    }
    Ok(())
}
