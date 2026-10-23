//! The volume family (pond-ts `catalog/volume.ts`): on-balance volume,
//! the accumulation/distribution line, the price-volume trend, Chaikin
//! money flow, the Chaikin oscillator, the money flow index, Twiggs money
//! flow, the force index, ease of movement, the Klinger oscillator, the
//! volume oscillator, the trade volume index, the negative and positive
//! volume indexes, the market facilitation index, Shinohara's intensity
//! ratios and a trailing VWAP. (Anchored VWAP comes with the calendars.)

use super::MaType;
use super::averages::{OscillatorMode, oscillator_values, positive, shorter};
use super::kernels::{
    Ema, bar_range_values, clv, clv_values, cumulative_values, ema_values, js_max, js_min, js_sign,
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

study_options! {
    /// Options for [`TimeSeries::klinger`]: EMAs of 34 and 55 bars and a
    /// 13-bar signal; writes `kvo` and `kvoSignal` (the prefix and
    /// `Signal`).
    Klinger, prefix = "kvo", reads [high, low, close, volume] {
        /// The fast EMA's length in bars (default 34).
        fast: usize = 34,
        /// The slow EMA's length in bars, longer than `fast` (default 55).
        slow: usize = 55,
        /// The signal EMA's length in bars (default 13).
        signal: usize = 13,
    }
}

study_options! {
    /// Options for [`TimeSeries::volume_oscillator`]: simple averages of 5
    /// and 10 bars; writes `volOsc`.
    VolumeOscillator, output = "volOsc", reads [volume] {
        /// The fast average's length in bars (default 5).
        fast: usize = 5,
        /// The slow average's length in bars, longer than `fast` (default 10).
        slow: usize = 10,
        /// The averages' type (default simple).
        ma: MaType = MaType::Sma,
    }
}

study_options! {
    /// Options for [`TimeSeries::trade_volume_index`]: the instrument's
    /// minimum tick, which has no default; reads `column` (default
    /// `close`) and `volume`; writes `tvi`.
    TradeVolumeIndex(min_tick: f64), output = "tvi", reads [column, volume] {}
}

study_options! {
    /// Options for [`TimeSeries::negative_volume_index`]: starts at 1000;
    /// reads `column` (default `close`) and `volume`; writes `nvi`.
    NegativeVolumeIndex, output = "nvi", reads [column, volume] {
        /// The index's first value, a positive finite number (default 1000).
        start: f64 = 1000.0,
    }
}

study_options! {
    /// Options for [`TimeSeries::positive_volume_index`]: starts at 1000;
    /// reads `column` (default `close`) and `volume`; writes `pvi`.
    PositiveVolumeIndex, output = "pvi", reads [column, volume] {
        /// The index's first value, a positive finite number (default 1000).
        start: f64 = 1000.0,
    }
}

study_options! {
    /// Options for [`TimeSeries::market_facilitation_index`]: writes
    /// `bwmfi`.
    MarketFacilitationIndex, output = "bwmfi", reads [high, low, volume] {}
}

study_options! {
    /// Options for [`TimeSeries::shinohara_intensity_ratio`]: 26 bars;
    /// writes `sirStrong` and `sirWeak` (the prefix and `Strong` /
    /// `Weak`).
    ShinoharaIntensityRatio, prefix = "sir", reads [open, high, low, close] {
        /// The window in bars (default 26).
        period: usize = 26,
    }
}

study_options! {
    /// Options for [`TimeSeries::vwap`]: the window in bars, which has no
    /// default; writes `vwap`.
    Vwap(period: usize), output = "vwap", reads [high, low, close, volume] {}
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
                    crate::grid::js_number(scale)
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

    /// Klinger oscillator (pond-ts `klinger`): each bar's volume force
    /// (its volume, signed by whether `high + low + close` rose, scaled by
    /// how the bar's range compares with the range summed since the trend
    /// last turned), a `fast`-bar EMA of it less a `slow`-bar one, and a
    /// `signal`-bar EMA of that. The force starts on the second bar of
    /// each stretch with no gaps.
    pub fn klinger(&self, options: Klinger) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::klinger";
        positive(CALL, "fastPeriod", options.fast)?;
        positive(CALL, "slowPeriod", options.slow)?;
        positive(CALL, "signalPeriod", options.signal)?;
        shorter(CALL, "klinger", options.fast, options.slow)?;
        let prefix = options.name();
        let names = [prefix.to_string(), format!("{prefix}Signal")];
        self.free_names(CALL, &names)?;
        let [high, low, close, volume] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.close, &options.volume],
            ["high", "low", "close", "volume"],
        )?;
        let n = high.len();
        let mut force = vec![f64::NAN; n];
        // pond-ts `foldRows`: a gap in any column ends the stretch, and
        // the next one starts over.
        let (mut first, mut trend, mut cm, mut prev_hlc, mut prev_dm) = (true, 0.0, 0.0, 0.0, 0.0);
        for i in 0..n {
            let (h, l, c, v) = (high[i], low[i], close[i], volume[i]);
            if h.is_nan() || l.is_nan() || c.is_nan() || v.is_nan() {
                first = true;
                continue;
            }
            let hlc = h + l + c;
            let dm = h - l;
            if first {
                first = false;
                (trend, cm) = (0.0, 0.0);
            } else {
                let t = if hlc > prev_hlc { 1.0 } else { -1.0 };
                cm = if t == trend { cm + dm } else { prev_dm + dm };
                trend = t;
                force[i] = v * (2.0 * (dm / cm) - 2.0).abs() * t * 100.0;
            }
            (prev_hlc, prev_dm) = (hlc, dm);
        }
        let (fast, slow) = par::join(
            || ema_values(&force, options.fast),
            || ema_values(&force, options.slow),
        );
        let line: Vec<f64> = fast.iter().zip(&slow).map(|(f, s)| f - s).collect();
        let signal = ema_values(&line, options.signal);
        self.study_outputs(CALL, names.into_iter().zip([line, signal]))
    }

    /// Volume oscillator (pond-ts `volumeOscillator`): the price
    /// oscillator of the volume, in percent: a `fast`-bar average of the
    /// volume less a `slow`-bar one, as a percent of the slow one.
    pub fn volume_oscillator(&self, options: VolumeOscillator) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::volume_oscillator";
        shorter(CALL, "volumeOscillator", options.fast, options.slow)?;
        positive(CALL, "fastPeriod", options.fast)?;
        positive(CALL, "slowPeriod", options.slow)?;
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [volume] = self.price_columns(CALL, [&options.volume], ["volume"])?;
        let out = oscillator_values(
            &volume,
            options.fast,
            options.slow,
            options.ma,
            OscillatorMode::Percent,
        );
        self.study_output(CALL, output, out)
    }

    /// Trade volume index (pond-ts `tradeVolumeIndex`): the running total
    /// of the volume, added while the price last moved up by more than
    /// `min_tick`, taken away while it last moved down by more, left out
    /// before the first such move. Starts at 0 on the first bar with both
    /// a price and a volume; a gap after that makes every later total a
    /// gap.
    pub fn trade_volume_index(&self, options: TradeVolumeIndex) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::trade_volume_index";
        let tick = options.min_tick;
        if !tick.is_finite() || tick <= 0.0 {
            return Err(PondError::InvalidData {
                call: CALL,
                message: format!(
                    "tradeVolumeIndex minTick must be a positive finite number (the instrument's minimum tick); got {}",
                    crate::grid::js_number(tick)
                ),
            });
        }
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [close, volume] = self.price_columns(
            CALL,
            [&options.column, &options.volume],
            [super::DEFAULT_SOURCE, "volume"],
        )?;
        let n = close.len();
        let mut out = vec![f64::NAN; n];
        let (mut first, mut started) = (true, false);
        let (mut value, mut direction, mut prev) = (f64::NAN, 0.0, 0.0);
        for i in 0..n {
            let (c, v) = (close[i], volume[i]);
            if c.is_nan() || v.is_nan() {
                first = true;
                continue;
            }
            if first {
                first = false;
                // Only a leading gap moves the start; a later one ends
                // the total (the missed bar's volume is unknown).
                value = if started { f64::NAN } else { 0.0 };
                started = true;
                direction = 0.0;
            } else {
                let step = c - prev;
                if step > tick {
                    direction = 1.0;
                } else if step < -tick {
                    direction = -1.0;
                }
                value += direction * v;
            }
            out[i] = value;
            prev = c;
        }
        self.study_output(CALL, output, out)
    }

    /// Negative volume index (pond-ts `negativeVolumeIndex`): starts at
    /// `start` and compounds the price's return on each bar whose volume
    /// fell; holds otherwise. Starts over after a gap; a gap from a
    /// previous price of 0 on.
    pub fn negative_volume_index(&self, options: NegativeVolumeIndex) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::negative_volume_index";
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        volume_index_start(CALL, "negativeVolumeIndex", options.start)?;
        let [close, volume] = self.price_columns(
            CALL,
            [&options.column, &options.volume],
            [super::DEFAULT_SOURCE, "volume"],
        )?;
        let out = volume_index_values(&close, &volume, options.start, true);
        self.study_output(CALL, output, out)
    }

    /// Positive volume index (pond-ts `positiveVolumeIndex`): starts at
    /// `start` and compounds the price's return on each bar whose volume
    /// rose; holds otherwise. Starts over after a gap; a gap from a
    /// previous price of 0 on.
    pub fn positive_volume_index(&self, options: PositiveVolumeIndex) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::positive_volume_index";
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        volume_index_start(CALL, "positiveVolumeIndex", options.start)?;
        let [close, volume] = self.price_columns(
            CALL,
            [&options.column, &options.volume],
            [super::DEFAULT_SOURCE, "volume"],
        )?;
        let out = volume_index_values(&close, &volume, options.start, false);
        self.study_output(CALL, output, out)
    }

    /// Market facilitation index (pond-ts `marketFacilitationIndex`): the
    /// bar's range per unit of volume. A gap where the volume is 0.
    pub fn market_facilitation_index(
        &self,
        options: MarketFacilitationIndex,
    ) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::market_facilitation_index";
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [high, low, volume] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.volume],
            ["high", "low", "volume"],
        )?;
        let range = bar_range_values(&high, &low);
        let out = range
            .iter()
            .zip(volume.iter())
            .map(|(&r, &v)| if v == 0.0 { f64::NAN } else { r / v })
            .collect();
        self.study_output(CALL, output, out)
    }

    /// Shinohara intensity ratios (pond-ts `shinoharaIntensityRatio`):
    /// strong, the bars' highs above their opens over their lows below
    /// them; weak, the same against the previous close; each a `period`-bar
    /// average over a `period`-bar average, times 100. A gap where the
    /// lower average is 0.
    pub fn shinohara_intensity_ratio(
        &self,
        options: ShinoharaIntensityRatio,
    ) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::shinohara_intensity_ratio";
        positive(CALL, "period", options.period)?;
        let prefix = options.name();
        let names = [format!("{prefix}Strong"), format!("{prefix}Weak")];
        self.free_names(CALL, &names)?;
        let [open, high, low, close] = self.price_columns(
            CALL,
            [&options.open, &options.high, &options.low, &options.close],
            ["open", "high", "low", "close"],
        )?;
        let period = options.period;
        let (strong, weak) = par::join(
            || {
                let up: Vec<f64> = high.iter().zip(open.iter()).map(|(h, o)| h - o).collect();
                let down: Vec<f64> = open.iter().zip(low.iter()).map(|(o, l)| o - l).collect();
                intensity_ratio(&up, &down, period)
            },
            || {
                // Against the previous close: none on row 0.
                let prev = || std::iter::once(f64::NAN).chain(close.iter().copied());
                let up: Vec<f64> = high.iter().zip(prev()).map(|(h, c)| h - c).collect();
                let down: Vec<f64> = prev().zip(low.iter()).map(|(c, l)| c - l).collect();
                intensity_ratio(&up, &down, period)
            },
        );
        self.study_outputs(CALL, names.into_iter().zip([strong, weak]))
    }

    /// Volume-weighted average price over a trailing window (pond-ts
    /// `vwap`): the typical price `(high + low + close) / 3`, averaged over
    /// `period` bars weighted by volume. Bars whose weighted price is a gap
    /// are left out of both sums.
    pub fn vwap(&self, options: Vwap) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::vwap";
        positive(CALL, "period", options.period)?;
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [high, low, close, volume] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.close, &options.volume],
            ["high", "low", "close", "volume"],
        )?;
        let typical = typical_price_values(&high, &low, &close);
        let out = rolling_weighted_mean_values(&typical, &volume, options.period);
        self.study_output(CALL, output, out)
    }
}

/// Refuses a volume index's `start` that is not a positive finite number.
fn volume_index_start(call: &'static str, study: &str, start: f64) -> Result<()> {
    if !start.is_finite() || start <= 0.0 {
        return Err(PondError::InvalidData {
            call,
            message: format!("{study} start must be a positive finite number"),
        });
    }
    Ok(())
}

/// pond-ts `volumeIndex`: from `start` on the first bar of each stretch
/// with no gaps, the index compounds the price's return on bars whose
/// volume fell (`on_fall`) or rose (otherwise) and holds on the rest,
/// equal volumes included.
fn volume_index_values(close: &[f64], volume: &[f64], start: f64, on_fall: bool) -> Vec<f64> {
    let n = close.len();
    let mut out = vec![f64::NAN; n];
    let (mut first, mut value, mut prev_close, mut prev_volume) = (true, f64::NAN, 0.0, 0.0);
    for i in 0..n {
        let (c, v) = (close[i], volume[i]);
        if c.is_nan() || v.is_nan() {
            first = true;
            continue;
        }
        if first {
            first = false;
            value = start;
        } else if on_fall == (v < prev_volume) && v != prev_volume {
            value = if prev_close == 0.0 {
                f64::NAN
            } else {
                value * (1.0 + (c - prev_close) / prev_close)
            };
        }
        out[i] = value;
        (prev_close, prev_volume) = (c, v);
    }
    out
}

/// pond-ts's Shinohara `ratio`: `100 · mean(up) / mean(down)` over
/// `period` bars, a gap where the lower mean is 0.
fn intensity_ratio(up: &[f64], down: &[f64], period: usize) -> Vec<f64> {
    let (numerator, denominator) = par::join(
        || rolling_mean_values(up, period),
        || rolling_mean_values(down, period),
    );
    numerator
        .iter()
        .zip(&denominator)
        .map(|(&u, &d)| if d == 0.0 { f64::NAN } else { (100.0 * u) / d })
        .collect()
}

/// pond-ts `rollingWeightedMeanValues`: each window's sum of
/// `value · weight` over its sum of weights, leaving out the rows whose
/// product is a gap (or infinite) from both. Both sums are
/// [`rolling_mean_sd`]'s means of the same window, so their ratio is the
/// weighted mean.
fn rolling_weighted_mean_values(values: &[f64], weights: &[f64], period: usize) -> Vec<f64> {
    rolling_weighted_mean_chunked(values, weights, period, 1 << 16)
}

/// [`rolling_weighted_mean_values`], its row-by-row steps split into
/// stretches of `chunk` rows.
fn rolling_weighted_mean_chunked(
    values: &[f64],
    weights: &[f64],
    period: usize,
    chunk: usize,
) -> Vec<f64> {
    let n = values.len();
    let (mut product, mut masked) = (vec![0.0; n], vec![0.0; n]);
    par::fill_chunks(
        &mut product,
        &mut masked,
        chunk,
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
    par::fill_chunks(&mut numerator, &mut [], chunk, |start, numerator, _| {
        for (k, x) in numerator.iter_mut().enumerate() {
            *x /= denominator[start + k];
        }
    });
    numerator
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bars() -> TimeSeries {
        let price = |k: f64| (0..4).map(|i| 10.0 + k * f64::from(i)).collect::<Vec<_>>();
        TimeSeries::new(
            "s",
            (0..4).collect(),
            vec![
                crate::Column::required("open", price(0.5)),
                crate::Column::required("high", price(1.5)),
                crate::Column::required("low", price(0.2)),
                crate::Column::required("close", price(1.0)),
                crate::Column::required("volume", price(100.0)),
            ],
        )
        .unwrap()
    }

    fn message(r: Result<TimeSeries>) -> String {
        r.unwrap_err().to_string()
    }

    /// Ticks and starts that are not positive finite numbers are refused
    /// (JSON cases cannot carry an infinity or NaN), with the value
    /// written as JavaScript writes it.
    #[test]
    fn non_finite_ticks_and_starts_are_refused() {
        let s = bars();
        for (bad, text) in [
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
            (f64::NAN, "NaN"),
            (0.0, "0"),
        ] {
            let tvi = message(s.trade_volume_index(TradeVolumeIndex::new(bad)));
            assert!(
                tvi.ends_with(&format!("(the instrument's minimum tick); got {text}")),
                "{tvi}"
            );
            let nvi = message(s.negative_volume_index(NegativeVolumeIndex::default().start(bad)));
            assert!(nvi.contains("negativeVolumeIndex start"), "{nvi}");
            let pvi = message(s.positive_volume_index(PositiveVolumeIndex::default().start(bad)));
            assert!(pvi.contains("positiveVolumeIndex start"), "{pvi}");
        }
    }

    /// Which error wins when several apply, as in pond-ts.
    #[test]
    fn errors_come_in_pond_ts_order() {
        let s = bars();
        // The tick before the output name; the output name before the start.
        let tvi = message(s.trade_volume_index(TradeVolumeIndex::new(0.0).output("close")));
        assert!(tvi.contains("minTick"), "{tvi}");
        let nvi = message(
            s.negative_volume_index(NegativeVolumeIndex::default().start(0.0).output("close")),
        );
        assert!(nvi.contains("collides"), "{nvi}");
        // Klinger: the periods, then fast before slow.
        let kvo = message(s.klinger(Klinger::default().fast(0).slow(0)));
        assert!(kvo.contains("fastPeriod must be"), "{kvo}");
        let kvo = message(s.klinger(Klinger::default().fast(5).slow(4).signal(0)));
        assert!(kvo.contains("signalPeriod must be"), "{kvo}");
        // The volume oscillator: fast before slow, then the periods.
        let vo = message(s.volume_oscillator(VolumeOscillator::default().fast(0).slow(0)));
        assert!(vo.contains("volumeOscillator fastPeriod (0)"), "{vo}");
        let vo = message(s.volume_oscillator(VolumeOscillator::default().fast(0).slow(3)));
        assert!(vo.contains("fastPeriod must be"), "{vo}");
        // Periods before names, names before columns.
        let sir = message(
            s.shinohara_intensity_ratio(ShinoharaIntensityRatio::default().period(0).prefix("c")),
        );
        assert!(sir.contains("period must be"), "{sir}");
        let vwap = message(s.vwap(Vwap::new(3).output("close").volume("nope")));
        assert!(vwap.contains("collides"), "{vwap}");
    }

    /// Split into stretches of any size, the weighted mean has the same
    /// bits as in one piece.
    #[test]
    fn weighted_mean_in_stretches_matches_one_piece() {
        let mut x = 0x9E37_79B9_7F4A_7C15u64;
        let mut next = || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        let n = 5_000;
        let (mut values, mut weights) = (Vec::with_capacity(n), Vec::with_capacity(n));
        for i in 0..n {
            let (a, b) = (next(), next());
            values.push(match i {
                _ if (700..730).contains(&i) => f64::NAN,
                _ if i % 1_009 == 3 => f64::NAN,
                _ => (a % 2_001) as f64 / 1_000.0 - 1.0,
            });
            weights.push(match i {
                _ if i % 997 == 11 => f64::NAN,
                _ if (2_000..2_010).contains(&i) => 0.0,
                _ => 1_000.0 + (b % 900) as f64,
            });
        }
        for period in [1, 3, 20] {
            let want = rolling_weighted_mean_chunked(&values, &weights, period, n);
            assert!(want.iter().filter(|v| v.is_finite()).count() > 4_000);
            for chunk in [1, 2, 7, 64, 999] {
                let got = rolling_weighted_mean_chunked(&values, &weights, period, chunk);
                assert!(
                    want.iter()
                        .zip(&got)
                        .all(|(a, b)| a.to_bits() == b.to_bits()),
                    "period {period}, chunk {chunk}"
                );
            }
        }
    }
}
