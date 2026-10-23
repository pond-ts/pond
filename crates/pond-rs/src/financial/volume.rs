//! The volume family (pond-ts `catalog/volume.ts`), part 1: on-balance
//! volume, the accumulation/distribution line, the price-volume trend,
//! Chaikin money flow, the Chaikin oscillator, the money flow index,
//! Twiggs money flow, the force index and ease of movement.

use super::MaType;
use super::averages::{positive, shorter};
use super::kernels::{
    Ema, clv, clv_values, cumulative_values, ema_values, js_max, js_min, js_sign,
    median_price_values, money_flow_volume_values, moving_average_values, percent_change_values,
    rolling_mean_sd, rolling_mean_values, typical_price_values, wilder_values_from,
};
use crate::error::{PondError, Result};
use crate::par;
use crate::series::TimeSeries;

study_options! {
    /// Options for [`TimeSeries::obv`]: writes `obv`.
    Obv, output = "obv", reads [close, volume] {}
}

study_options! {
    /// Options for [`TimeSeries::accumulation_distribution`]: writes `ad`.
    AccumulationDistribution, output = "ad", reads [high, low, close, volume] {}
}

study_options! {
    /// Options for [`TimeSeries::price_volume_trend`]: writes `pvt`.
    PriceVolumeTrend, output = "pvt", reads [close, volume] {}
}

study_options! {
    /// Options for [`TimeSeries::chaikin_money_flow`]: 20 bars; writes
    /// `cmf`.
    ChaikinMoneyFlow, output = "cmf", reads [high, low, close, volume] {
        /// The window in bars (default 20).
        period: usize = 20,
    }
}

study_options! {
    /// Options for [`TimeSeries::chaikin_oscillator`]: a 3-bar EMA of the
    /// accumulation/distribution line less a 10-bar one; writes
    /// `chaikinOsc`.
    ChaikinOscillator, output = "chaikinOsc", reads [high, low, close, volume] {
        /// The fast EMA's length in bars (default 3).
        fast: usize = 3,
        /// The slow EMA's length in bars, longer than `fast` (default 10).
        slow: usize = 10,
    }
}

study_options! {
    /// Options for [`TimeSeries::money_flow_index`]: 14 bars; writes `mfi`.
    MoneyFlowIndex, output = "mfi", reads [high, low, close, volume] {
        /// The window in bars (default 14).
        period: usize = 14,
    }
}

study_options! {
    /// Options for [`TimeSeries::twiggs_money_flow`]: 21 bars; writes
    /// `tmf`.
    TwiggsMoneyFlow, output = "tmf", reads [high, low, close, volume] {
        /// The Wilder smoothing's length in bars (default 21).
        period: usize = 21,
    }
}

study_options! {
    /// Options for [`TimeSeries::force_index`]: a 13-bar EMA; writes
    /// `force`.
    ForceIndex, output = "force", reads [close, volume] {
        /// The EMA's length in bars (default 13).
        period: usize = 13,
    }
}

study_options! {
    /// Options for [`TimeSeries::ease_of_movement`]: a 14-bar simple
    /// average, the volume scaled by 1e8; writes `eom`.
    EaseOfMovement, output = "eom", reads [high, low, volume] {
        /// The average's length in bars (default 14).
        period: usize = 14,
        /// The average's type (default simple).
        ma: MaType = MaType::Sma,
        /// What the volume is divided by, a positive finite number
        /// (default 100,000,000).
        scale: f64 = 100_000_000.0,
    }
}

/// The volume family.
impl TimeSeries {
    /// On-balance volume (pond-ts `obv`): the running total of the volume,
    /// added when the close rises, taken away when it falls, left out when
    /// it is unchanged. Starts at the first bar with both a close and a
    /// volume (that bar's volume); a gap after that makes every later
    /// total a gap.
    pub fn obv(&self, options: Obv) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::obv";
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [close, volume] =
            self.price_columns(CALL, [&options.close, &options.volume], ["close", "volume"])?;
        let n = close.len();
        let first = (0..n)
            .find(|&i| !close[i].is_nan() && !volume[i].is_nan())
            .unwrap_or(n);
        // pond-ts signs the volumes, then totals them from the first that
        // is not a gap (row `first`, whose volume is not); one pass here,
        // the same additions in the same order.
        let mut out = vec![f64::NAN; n];
        if first < n {
            let mut sum = 0.0;
            sum += volume[first];
            out[first] = sum;
            for i in first + 1..n {
                sum += js_sign(close[i] - close[i - 1]) * volume[i];
                out[i] = sum;
            }
        }
        self.study_output(CALL, output, out)
    }

    /// Accumulation/distribution line (pond-ts `accumulationDistribution`):
    /// the running total of each bar's volume times where its close sits in
    /// the bar (-1 at the low, +1 at the high; 0 for a bar with no range).
    /// Starts at the first bar that is not a gap; a gap after that makes
    /// every later total a gap.
    pub fn accumulation_distribution(
        &self,
        options: AccumulationDistribution,
    ) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::accumulation_distribution";
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [high, low, close, volume] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.close, &options.volume],
            ["high", "low", "close", "volume"],
        )?;
        let flow = money_flow_volume_values(&high, &low, &close, &volume);
        self.study_output(CALL, output, cumulative_values(&flow))
    }

    /// Price-volume trend (pond-ts `priceVolumeTrend`): the running total
    /// of each bar's volume times its close's fractional change. Starts at
    /// the second bar; a gap (or a close of 0 before a change) makes every
    /// later total a gap.
    pub fn price_volume_trend(&self, options: PriceVolumeTrend) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::price_volume_trend";
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [close, volume] =
            self.price_columns(CALL, [&options.close, &options.volume], ["close", "volume"])?;
        let mut terms = percent_change_values(&close, 1);
        for (t, v) in terms.iter_mut().zip(volume.iter()) {
            *t = (*t / 100.0) * v;
        }
        self.study_output(CALL, output, cumulative_values(&terms))
    }

    /// Chaikin money flow (pond-ts `chaikinMoneyFlow`): where the close
    /// sits in its bar (-1 to +1), averaged over `period` bars weighted by
    /// volume. Bars whose weighted value is a gap are left out of both
    /// sums; a gap where none are left or the volumes sum to 0.
    pub fn chaikin_money_flow(&self, options: ChaikinMoneyFlow) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::chaikin_money_flow";
        positive(CALL, "period", options.period)?;
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [high, low, close, volume] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.close, &options.volume],
            ["high", "low", "close", "volume"],
        )?;
        let clv = clv_values(&high, &low, &close);
        let out = rolling_weighted_mean_values(&clv, &volume, options.period);
        self.study_output(CALL, output, out)
    }

    /// Chaikin oscillator (pond-ts `chaikinOscillator`): a `fast`-bar EMA
    /// of the accumulation/distribution line less a `slow`-bar one.
    pub fn chaikin_oscillator(&self, options: ChaikinOscillator) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::chaikin_oscillator";
        positive(CALL, "fastPeriod", options.fast)?;
        positive(CALL, "slowPeriod", options.slow)?;
        shorter(CALL, "chaikinOscillator", options.fast, options.slow)?;
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [high, low, close, volume] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.close, &options.volume],
            ["high", "low", "close", "volume"],
        )?;
        let ad = cumulative_values(&money_flow_volume_values(&high, &low, &close, &volume));
        let (fast, slow) = par::join(
            || ema_values(&ad, options.fast),
            || ema_values(&ad, options.slow),
        );
        let out = fast.iter().zip(&slow).map(|(f, s)| f - s).collect();
        self.study_output(CALL, output, out)
    }

    /// Money flow index (pond-ts `moneyFlowIndex`): the typical price times
    /// volume, split by whether the typical price rose or fell, each side
    /// averaged over `period` bars; the rising share, 0 to 100. A gap
    /// where a window holds a gap and where both sides are 0.
    pub fn money_flow_index(&self, options: MoneyFlowIndex) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::money_flow_index";
        positive(CALL, "period", options.period)?;
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [high, low, close, volume] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.close, &options.volume],
            ["high", "low", "close", "volume"],
        )?;
        let typical = typical_price_values(&high, &low, &close);
        let n = typical.len();
        let mut rising = vec![f64::NAN; n];
        let mut falling = vec![f64::NAN; n];
        for i in 1..n {
            let d = typical[i] - typical[i - 1];
            let flow = typical[i] * volume[i];
            if (d + flow).is_nan() {
                continue;
            }
            rising[i] = if d > 0.0 { flow } else { 0.0 };
            falling[i] = if d < 0.0 { flow } else { 0.0 };
        }
        let (up, down) = par::join(
            || rolling_mean_values(&rising, options.period),
            || rolling_mean_values(&falling, options.period),
        );
        let out = up
            .iter()
            .zip(&down)
            .map(|(&u, &d)| {
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

    /// Twiggs money flow (pond-ts `twiggsMoneyFlow`): Chaikin's money flow
    /// on the true high and low (the bar widened to the last close), the
    /// flow and its volume each Wilder-smoothed over `period` bars from
    /// the second bar on, then divided. A gap where the smoothed volume is
    /// 0; a gap in the middle makes every later value a gap.
    pub fn twiggs_money_flow(&self, options: TwiggsMoneyFlow) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::twiggs_money_flow";
        positive(CALL, "period", options.period)?;
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [close, volume, high, low] = self.price_columns(
            CALL,
            [&options.close, &options.volume, &options.high, &options.low],
            ["close", "volume", "high", "low"],
        )?;
        // Chaikin's flow on the true bounds, and its volume where the flow
        // is not a gap, in one pass (the same operations as pond-ts's
        // three).
        let n = close.len();
        let mut flow = vec![f64::NAN; n];
        let mut weight = vec![f64::NAN; n];
        for i in 1..n {
            let h = js_max(high[i], close[i - 1]);
            let l = js_min(low[i], close[i - 1]);
            let f = clv(h, l, close[i]) * volume[i];
            flow[i] = f;
            weight[i] = if f.is_nan() { f64::NAN } else { volume[i] };
        }
        let (numerator, denominator) = par::join(
            || wilder_values_from(&flow, options.period, 1),
            || wilder_values_from(&weight, options.period, 1),
        );
        let out = numerator
            .iter()
            .zip(&denominator)
            .map(|(&f, &d)| if d == 0.0 { f64::NAN } else { f / d })
            .collect();
        self.study_output(CALL, output, out)
    }

    /// Force index (pond-ts `forceIndex`): each bar's close change times
    /// its volume, as a `period`-bar EMA.
    pub fn force_index(&self, options: ForceIndex) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::force_index";
        positive(CALL, "period", options.period)?;
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [close, volume] =
            self.price_columns(CALL, [&options.close, &options.volume], ["close", "volume"])?;
        // The raw force and its EMA in one pass (row 0 has no change).
        let mut ema = Ema::period(options.period);
        let out = (0..close.len())
            .map(|i| {
                if i == 0 {
                    ema.push(f64::NAN)
                } else {
                    ema.push((close[i] - close[i - 1]) * volume[i])
                }
            })
            .collect();
        self.study_output(CALL, output, out)
    }

    /// Ease of movement (pond-ts `easeOfMovement`): how far the bar's
    /// midpoint moved, times its range, per `volume / scale`, averaged
    /// over `period` bars with the `ma` type. A gap on a bar with no range
    /// or no volume.
    pub fn ease_of_movement(&self, options: EaseOfMovement) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::ease_of_movement";
        positive(CALL, "period", options.period)?;
        let scale = options.scale;
        if !scale.is_finite() || scale <= 0.0 {
            return Err(PondError::InvalidData {
                call: CALL,
                message: format!(
                    "easeOfMovement scale must be a positive finite number, got {}",
                    if scale.is_nan() {
                        "NaN".to_string()
                    } else if scale.is_infinite() {
                        if scale > 0.0 { "Infinity" } else { "-Infinity" }.to_string()
                    } else {
                        crate::grid::js_number(scale)
                    }
                ),
            });
        }
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [high, low, volume] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.volume],
            ["high", "low", "volume"],
        )?;
        let mid = median_price_values(&high, &low);
        let mut raw = vec![f64::NAN; mid.len()];
        for i in 1..raw.len() {
            let range = high[i] - low[i];
            let v = volume[i];
            if range == 0.0 || v == 0.0 {
                continue;
            }
            raw[i] = ((mid[i] - mid[i - 1]) * range * scale) / v;
        }
        let out = moving_average_values(&raw, options.period, options.ma);
        self.study_output(CALL, output, out)
    }
}

/// pond-ts `rollingWeightedMeanValues`: each window's sum of
/// `value · weight` over its sum of weights, leaving out the rows whose
/// product is a gap (or infinite) from both. Both sums are
/// [`rolling_mean_sd`]'s means of the same window, so their ratio is the
/// weighted mean.
fn rolling_weighted_mean_values(values: &[f64], weights: &[f64], period: usize) -> Vec<f64> {
    const CHUNK: usize = 1 << 16;
    let n = values.len();
    let (mut product, mut masked) = (vec![0.0; n], vec![0.0; n]);
    par::fill_chunks(
        &mut product,
        &mut masked,
        CHUNK,
        |start, product, masked| {
            for (k, (p, m)) in product.iter_mut().zip(masked).enumerate() {
                let w = weights[start + k];
                *p = values[start + k] * w;
                *m = if p.is_finite() { w } else { f64::NAN };
            }
        },
    );
    let (mut numerator, denominator) = par::join(
        || rolling_mean_sd(&product, period, false).0,
        || rolling_mean_sd(&masked, period, false).0,
    );
    par::fill_chunks(&mut numerator, &mut [], CHUNK, |start, numerator, _| {
        for (k, x) in numerator.iter_mut().enumerate() {
            *x /= denominator[start + k];
        }
    });
    numerator
}
