//! [`StudyDescriptor::run`]: a study call from its name and pond-ts's
//! options as JSON. An option left out keeps the options struct's own
//! default; where the Rust call takes the value directly (a [`Study`]
//! period, a moving-average type), the default comes from the descriptor.

use serde_json::{Map, Value};

use super::{ParamKind, StudyDescriptor};
use crate::error::{PondError, Result};
use crate::financial::*;
use crate::series::TimeSeries;

/// Largest bar count an option may give (2^53, JavaScript's exact range).
const MAX_BARS: f64 = 9_007_199_254_740_992.0;

struct Args<'a> {
    d: &'a StudyDescriptor,
    map: &'a Map<String, Value>,
}

impl<'a> Args<'a> {
    fn error(&self, message: String) -> PondError {
        PondError::InvalidData {
            call: self.d.name,
            message,
        }
    }

    /// The option, with `null` read as left out (pond-ts's `??`).
    fn get(&self, key: &str) -> Option<&'a Value> {
        self.map.get(key).filter(|v| !v.is_null())
    }

    fn number(&self, key: &str) -> Result<Option<f64>> {
        match self.get(key) {
            None => Ok(None),
            Some(v) => v
                .as_f64()
                .map(Some)
                .ok_or_else(|| self.error(format!("'{key}' must be a number; got {v}"))),
        }
    }

    /// A count of bars: a whole number, 0 or more.
    fn bars(&self, key: &str) -> Result<Option<usize>> {
        match self.number(key)? {
            None => Ok(None),
            Some(n) if n >= 0.0 && n.fract() == 0.0 && n <= MAX_BARS => Ok(Some(n as usize)),
            Some(n) => Err(self.error(format!(
                "'{key}' must be a whole number of bars, 0 or more; got {n}"
            ))),
        }
    }

    fn text(&self, key: &str) -> Result<Option<&'a str>> {
        match self.get(key) {
            None => Ok(None),
            Some(v) => v
                .as_str()
                .map(Some)
                .ok_or_else(|| self.error(format!("'{key}' must be a string; got {v}"))),
        }
    }

    fn missing(&self, key: &str) -> PondError {
        self.error(format!("'{key}' is required"))
    }

    fn required_number(&self, key: &str) -> Result<f64> {
        self.number(key)?.ok_or_else(|| self.missing(key))
    }

    fn required_bars(&self, key: &str) -> Result<usize> {
        self.bars(key)?.ok_or_else(|| self.missing(key))
    }

    fn required_text(&self, key: &str) -> Result<&'a str> {
        self.text(key)?.ok_or_else(|| self.missing(key))
    }

    fn ma(&self, key: &str) -> Result<Option<MaType>> {
        self.text(key)?.map(MaType::parse).transpose()
    }

    /// A moving-average type the Rust call takes directly: the option, or
    /// the descriptor's default.
    fn ma_or_default(&self, key: &str) -> Result<MaType> {
        match self.ma(key)? {
            Some(kind) => Ok(kind),
            None => match self.d.param(key).map(|p| p.kind) {
                Some(ParamKind::Enum {
                    default: Some(d), ..
                }) => MaType::parse(d),
                _ => Err(self.missing(key)),
            },
        }
    }

    /// The `period` a [`Study`] takes: the option, or the descriptor's
    /// default.
    fn period(&self) -> Result<usize> {
        match self.bars("period")? {
            Some(p) => Ok(p),
            None => self
                .d
                .param("period")
                .and_then(|p| p.default_number())
                .map(|p| p as usize)
                .ok_or_else(|| self.missing("period")),
        }
    }

    /// A [`Study`]: the period, `column` and `output`.
    fn study(&self) -> Result<Study> {
        let mut s = Study::period(self.period()?);
        if let Some(c) = self.text("column")? {
            s = s.column(c);
        }
        if let Some(o) = self.text("output")? {
            s = s.output(o);
        }
        Ok(s)
    }
}

/// `$o = $o.setter(value)` for each value that is `Some`.
macro_rules! set {
    ($o:ident; $($setter:ident = $value:expr),* $(,)?) => {
        $(
            if let Some(v) = $value {
                $o = $o.$setter(v);
            }
        )*
    };
}

/// Applies the column and naming options that are given.
macro_rules! names {
    ($a:ident, $o:ident; $($key:ident),* $(,)?) => {
        $(
            if let Some(v) = $a.text(stringify!($key))? {
                $o = $o.$key(v);
            }
        )*
    };
}

pub(super) fn run(
    d: &StudyDescriptor,
    series: &TimeSeries,
    map: &Map<String, Value>,
    given: Option<SessionAnchor<'_>>,
) -> Result<TimeSeries> {
    let a = Args { d, map };
    if given.is_some() && d.anchor != Some(super::StudyAnchor::Session) {
        return Err(a.error("takes no sessions".into()));
    }
    match d.name {
        // Moving averages.
        "sma" => series.sma(a.study()?),
        "ema" => series.ema(a.study()?),
        "movingAverage" => {
            // pond-ts checks the period before the type.
            let study = a.study()?;
            let kind = if a.bars("period")? == Some(0) {
                MaType::Sma
            } else {
                a.ma_or_default("type")?
            };
            series.moving_average(kind, study)
        }
        "macd" => {
            let mut o = Macd::default();
            set!(o; fast = a.bars("fastPeriod")?, slow = a.bars("slowPeriod")?,
                signal = a.bars("signalPeriod")?);
            names!(a, o; column, prefix);
            series.macd(o)
        }
        "movingAverageCross" => {
            let mut o = MovingAverageCross::default();
            set!(o; fast = a.bars("fastPeriod")?, slow = a.bars("slowPeriod")?,
                ma = a.ma("maType")?);
            names!(a, o; column, output);
            series.moving_average_cross(o)
        }
        "movingAverageDeviation" => {
            let study = a.study()?;
            series.moving_average_deviation(a.ma_or_default("maType")?, study)
        }
        "guppy" => {
            let mut o = Guppy::default();
            set!(o; ma = a.ma("type")?);
            names!(a, o; column, prefix);
            series.guppy(o)
        }
        "rainbow" => {
            let mut o = Rainbow::default();
            set!(o; period = a.bars("period")?, ma = a.ma("type")?);
            names!(a, o; column, prefix);
            series.rainbow(o)
        }
        "rainbowOscillator" => {
            let mut o = RainbowOscillator::default();
            set!(o; period = a.bars("period")?, lookback = a.bars("lookback")?,
                ma = a.ma("type")?);
            names!(a, o; column, prefix);
            series.rainbow_oscillator(o)
        }
        "trix" => {
            let mut o = Trix::default();
            set!(o; period = a.bars("period")?, signal = a.bars("signalPeriod")?);
            names!(a, o; column, prefix);
            series.trix(o)
        }
        "schaffTrendCycle" => {
            let mut o = SchaffTrendCycle::default();
            set!(o; fast = a.bars("fastPeriod")?, slow = a.bars("slowPeriod")?,
                cycle = a.bars("cyclePeriod")?);
            names!(a, o; column, output);
            series.schaff_trend_cycle(o)
        }
        "detrendedPriceOscillator" => {
            let study = a.study()?;
            series.detrended_price_oscillator(a.ma_or_default("maType")?, study)
        }
        "disparityIndex" => {
            let study = a.study()?;
            series.disparity_index(a.ma_or_default("maType")?, study)
        }
        "coppock" => {
            let mut o = Coppock::default();
            set!(o; long = a.bars("longPeriod")?, short = a.bars("shortPeriod")?,
                wma_period = a.bars("wmaPeriod")?);
            names!(a, o; column, output);
            series.coppock(o)
        }
        "kst" => {
            let mut o = Kst::default();
            set!(o; signal = a.bars("signalPeriod")?);
            names!(a, o; column, prefix);
            series.kst(o)
        }
        "specialK" => {
            let mut o = SpecialK::default();
            names!(a, o; column, output);
            series.special_k(o)
        }
        "priceOscillator" => {
            let mut o = PriceOscillator::default();
            set!(o; fast = a.bars("fastPeriod")?, slow = a.bars("slowPeriod")?,
                ma = a.ma("maType")?, mode = oscillator_mode(&a)?);
            names!(a, o; column, output);
            series.price_oscillator(o)
        }
        "priceMomentumOscillator" => {
            let mut o = PriceMomentumOscillator::default();
            names!(a, o; column, prefix);
            series.price_momentum_oscillator(o)
        }

        // Bands.
        "bollinger" => {
            let mut o = Bollinger::new(a.required_bars("period")?);
            set!(o; std_dev = a.number("stdDev")?);
            names!(a, o; column, prefix);
            series.bollinger(o)
        }
        "bollingerBandwidth" => {
            let mut o = BollingerBandwidth::default();
            set!(o; period = a.bars("period")?, std_dev = a.number("stdDev")?);
            names!(a, o; column, output);
            series.bollinger_bandwidth(o)
        }
        "bollingerPercentB" => {
            let mut o = BollingerPercentB::default();
            set!(o; period = a.bars("period")?, std_dev = a.number("stdDev")?);
            names!(a, o; column, output);
            series.bollinger_percent_b(o)
        }
        "keltner" => {
            let mut o = Keltner::default();
            set!(o; period = a.bars("period")?, atr_period = a.bars("atrPeriod")?,
                multiplier = a.number("multiplier")?, ma = a.ma("maType")?);
            names!(a, o; high, low, close, prefix);
            series.keltner(o)
        }
        "starcBands" => {
            let mut o = StarcBands::default();
            set!(o; period = a.bars("period")?, atr_period = a.bars("atrPeriod")?,
                multiplier = a.number("multiplier")?, ma = a.ma("maType")?);
            names!(a, o; high, low, close, prefix);
            series.starc_bands(o)
        }
        "atrBands" => {
            let mut o = AtrBands::default();
            set!(o; period = a.bars("period")?, multiplier = a.number("multiplier")?);
            names!(a, o; column, high, low, close, prefix);
            series.atr_bands(o)
        }
        "donchian" => {
            let mut o = Donchian::default();
            set!(o; period = a.bars("period")?);
            names!(a, o; high, low, prefix);
            series.donchian(o)
        }
        "highLowBands" => {
            let mut o = HighLowBands::default();
            set!(o; period = a.bars("period")?, percent = a.number("percent")?,
                ma = a.ma("maType")?);
            names!(a, o; high, low, prefix);
            series.high_low_bands(o)
        }
        "primeNumberBands" => {
            let mut o = PrimeNumberBands::default();
            names!(a, o; high, low, prefix);
            series.prime_number_bands(o)
        }
        "envelope" => {
            let mut o = Envelope::new(a.required_bars("period")?);
            set!(o; percent = a.number("percent")?, ma = a.ma("maType")?);
            names!(a, o; column, prefix);
            series.envelope(o)
        }

        // Momentum.
        "rsi" => series.rsi(a.study()?),
        "stochastic" => {
            let mut o = Stochastic::default();
            set!(o; k_period = a.bars("kPeriod")?, slowing = a.bars("slowing")?,
                d_period = a.bars("dPeriod")?);
            names!(a, o; high, low, close, prefix);
            series.stochastic(o)
        }
        "stochasticMomentumIndex" => {
            let mut o = StochasticMomentumIndex::default();
            set!(o; period = a.bars("period")?, long = a.bars("longPeriod")?,
                short = a.bars("shortPeriod")?, signal = a.bars("signalPeriod")?);
            names!(a, o; high, low, close, prefix);
            series.stochastic_momentum_index(o)
        }
        "stochasticRsi" => {
            let mut o = StochasticRsi::default();
            set!(o; rsi_period = a.bars("rsiPeriod")?, stoch_period = a.bars("stochPeriod")?,
                k_period = a.bars("kPeriod")?, d_period = a.bars("dPeriod")?);
            names!(a, o; column, prefix);
            series.stochastic_rsi(o)
        }
        "williamsR" => {
            let mut o = WilliamsR::default();
            set!(o; period = a.bars("period")?);
            names!(a, o; high, low, close, output);
            series.williams_r(o)
        }
        "chandeMomentum" => series.chande_momentum(a.study()?),
        "momentum" => series.momentum(a.study()?),
        "percentChange" => {
            let mut o = PercentChange::default();
            set!(o; periods = a.bars("periods")?);
            names!(a, o; column, output);
            series.percent_change(o)
        }
        "intradayMomentumIndex" => {
            let mut o = IntradayMomentumIndex::default();
            set!(o; period = a.bars("period")?);
            names!(a, o; open, close, output);
            series.intraday_momentum_index(o)
        }
        "awesomeOscillator" => {
            let mut o = AwesomeOscillator::default();
            set!(o; fast = a.bars("fastPeriod")?, slow = a.bars("slowPeriod")?);
            names!(a, o; high, low, output);
            series.awesome_oscillator(o)
        }
        "ultimateOscillator" => {
            let mut o = UltimateOscillator::default();
            set!(o; short = a.bars("shortPeriod")?, medium = a.bars("mediumPeriod")?,
                long = a.bars("longPeriod")?);
            names!(a, o; high, low, close, output);
            series.ultimate_oscillator(o)
        }
        "commodityChannelIndex" => {
            let mut o = CommodityChannelIndex::default();
            set!(o; period = a.bars("period")?);
            names!(a, o; high, low, close, output);
            series.commodity_channel_index(o)
        }
        "fisherTransform" => {
            let mut o = FisherTransform::default();
            set!(o; period = a.bars("period")?);
            names!(a, o; high, low, prefix);
            series.fisher_transform(o)
        }
        "psychologicalLine" => series.psychological_line(a.study()?),
        "prettyGoodOscillator" => {
            let mut o = PrettyGoodOscillator::default();
            set!(o; period = a.bars("period")?);
            names!(a, o; column, high, low, close, output);
            series.pretty_good_oscillator(o)
        }
        "primeNumberOscillator" => {
            let mut o = PrimeNumberOscillator::default();
            names!(a, o; column, output);
            series.prime_number_oscillator(o)
        }
        "qstick" => {
            let mut o = Qstick::default();
            set!(o; period = a.bars("period")?, ma = a.ma("maType")?);
            names!(a, o; open, close, output);
            series.qstick(o)
        }
        "relativeVigorIndex" => {
            let mut o = RelativeVigorIndex::default();
            set!(o; period = a.bars("period")?);
            names!(a, o; open, high, low, close, prefix);
            series.relative_vigor_index(o)
        }
        "centerOfGravity" => series.center_of_gravity(a.study()?),
        "chandeForecastOscillator" => series.chande_forecast_oscillator(a.study()?),
        "trueStrengthIndex" => {
            let mut o = TrueStrengthIndex::default();
            set!(o; long = a.bars("longPeriod")?, short = a.bars("shortPeriod")?,
                signal = a.bars("signalPeriod")?);
            names!(a, o; column, prefix);
            series.true_strength_index(o)
        }

        // Trend.
        "directionalMovement" => {
            let mut o = DirectionalMovement::default();
            set!(o; period = a.bars("period")?);
            names!(a, o; high, low, close, prefix);
            series.directional_movement(o)
        }
        "aroon" => {
            let mut o = Aroon::default();
            set!(o; period = a.bars("period")?);
            names!(a, o; high, low, prefix);
            series.aroon(o)
        }
        "vortex" => {
            let mut o = Vortex::default();
            set!(o; period = a.bars("period")?);
            names!(a, o; high, low, close, prefix);
            series.vortex(o)
        }
        "verticalHorizontalFilter" => series.vertical_horizontal_filter(a.study()?),
        "randomWalkIndex" => {
            let mut o = RandomWalkIndex::default();
            set!(o; period = a.bars("period")?);
            names!(a, o; high, low, close, prefix);
            series.random_walk_index(o)
        }
        "superTrend" => {
            let mut o = SuperTrend::default();
            set!(o; period = a.bars("period")?, multiplier = a.number("multiplier")?);
            names!(a, o; high, low, close, prefix);
            series.super_trend(o)
        }
        "parabolicSar" => {
            let mut o = ParabolicSar::default();
            set!(o; step = a.number("step")?, max_step = a.number("maxStep")?);
            names!(a, o; high, low, prefix);
            series.parabolic_sar(o)
        }
        "atrTrailingStop" => {
            let mut o = AtrTrailingStop::default();
            set!(o; period = a.bars("period")?, multiplier = a.number("multiplier")?);
            names!(a, o; high, low, close, prefix);
            series.atr_trailing_stop(o)
        }
        "zigZag" => {
            let mut o = ZigZag::default();
            set!(o; deviation = a.number("deviation")?);
            names!(a, o; high, low, prefix);
            series.zig_zag(o)
        }
        "ichimoku" => {
            let mut o = Ichimoku::default();
            set!(o; conversion = a.bars("conversionPeriod")?, base = a.bars("basePeriod")?,
                span_b = a.bars("spanBPeriod")?, displacement = a.bars("displacement")?);
            names!(a, o; high, low, close, prefix);
            series.ichimoku(o)
        }
        "elderImpulse" => {
            let mut o = ElderImpulse::default();
            set!(o; ema = a.bars("emaPeriod")?, fast = a.bars("fastPeriod")?,
                slow = a.bars("slowPeriod")?, signal = a.bars("signalPeriod")?);
            names!(a, o; column, output);
            series.elder_impulse(o)
        }
        "elderRay" => {
            let mut o = ElderRay::default();
            set!(o; period = a.bars("period")?);
            names!(a, o; high, low, close, prefix);
            series.elder_ray(o)
        }
        "trendIntensityIndex" => {
            let mut o = TrendIntensityIndex::default();
            set!(o; period = a.bars("period")?, ma_period = a.bars("maPeriod")?);
            names!(a, o; column, output);
            series.trend_intensity_index(o)
        }
        "ravi" => {
            let mut o = Ravi::default();
            set!(o; short = a.bars("shortPeriod")?, long = a.bars("longPeriod")?);
            names!(a, o; column, output);
            series.ravi(o)
        }
        "swingIndex" => {
            let mut o = SwingIndex::new(a.required_number("limit")?);
            names!(a, o; open, high, low, close, output);
            series.swing_index(o)
        }
        "accumulativeSwingIndex" => {
            let mut o = AccumulativeSwingIndex::new(a.required_number("limit")?);
            names!(a, o; open, high, low, close, output);
            series.accumulative_swing_index(o)
        }

        // Volatility.
        "atr" => {
            let mut o = Atr::default();
            set!(o; period = a.bars("period")?);
            names!(a, o; high, low, close, output);
            series.atr(o)
        }
        "historicalVolatility" => {
            let mut o = HistoricalVolatility::default();
            set!(o; period = a.bars("period")?, annualize = a.number("annualize")?);
            names!(a, o; column, output);
            series.historical_volatility(o)
        }
        "chaikinVolatility" => {
            let mut o = ChaikinVolatility::default();
            set!(o; period = a.bars("period")?, roc_period = a.bars("rocPeriod")?);
            names!(a, o; high, low, output);
            series.chaikin_volatility(o)
        }
        "massIndex" => {
            let mut o = MassIndex::default();
            set!(o; ema_period = a.bars("emaPeriod")?, sum_period = a.bars("sumPeriod")?);
            names!(a, o; high, low, output);
            series.mass_index(o)
        }
        "choppinessIndex" => {
            let mut o = ChoppinessIndex::default();
            set!(o; period = a.bars("period")?);
            names!(a, o; high, low, close, output);
            series.choppiness_index(o)
        }
        "gopalakrishnanRangeIndex" => {
            let mut o = GopalakrishnanRangeIndex::default();
            set!(o; period = a.bars("period")?);
            names!(a, o; high, low, output);
            series.gopalakrishnan_range_index(o)
        }
        "ulcerIndex" => series.ulcer_index(a.study()?),
        "relativeVolatilityIndex" => {
            let mut o = RelativeVolatilityIndex::default();
            set!(o; period = a.bars("period")?, stdev_period = a.bars("stdevPeriod")?);
            names!(a, o; column, output);
            series.relative_volatility_index(o)
        }

        // Volume.
        "obv" => {
            let mut o = Obv::default();
            names!(a, o; close, volume, output);
            series.obv(o)
        }
        "accumulationDistribution" => {
            let mut o = AccumulationDistribution::default();
            names!(a, o; high, low, close, volume, output);
            series.accumulation_distribution(o)
        }
        "priceVolumeTrend" => {
            let mut o = PriceVolumeTrend::default();
            names!(a, o; close, volume, output);
            series.price_volume_trend(o)
        }
        "chaikinMoneyFlow" => {
            let mut o = ChaikinMoneyFlow::default();
            set!(o; period = a.bars("period")?);
            names!(a, o; high, low, close, volume, output);
            series.chaikin_money_flow(o)
        }
        "chaikinOscillator" => {
            let mut o = ChaikinOscillator::default();
            set!(o; fast = a.bars("fastPeriod")?, slow = a.bars("slowPeriod")?);
            names!(a, o; high, low, close, volume, output);
            series.chaikin_oscillator(o)
        }
        "moneyFlowIndex" => {
            let mut o = MoneyFlowIndex::default();
            set!(o; period = a.bars("period")?);
            names!(a, o; high, low, close, volume, output);
            series.money_flow_index(o)
        }
        "twiggsMoneyFlow" => {
            let mut o = TwiggsMoneyFlow::default();
            set!(o; period = a.bars("period")?);
            names!(a, o; high, low, close, volume, output);
            series.twiggs_money_flow(o)
        }
        "forceIndex" => {
            let mut o = ForceIndex::default();
            set!(o; period = a.bars("period")?);
            names!(a, o; close, volume, output);
            series.force_index(o)
        }
        "easeOfMovement" => {
            let mut o = EaseOfMovement::default();
            let period = a.bars("period")?;
            set!(o; period = period, scale = a.number("scale")?);
            // pond-ts checks the period before the type.
            if period != Some(0) {
                set!(o; ma = a.ma("maType")?);
            }
            names!(a, o; high, low, volume, output);
            series.ease_of_movement(o)
        }
        "klinger" => {
            let mut o = Klinger::default();
            set!(o; fast = a.bars("fastPeriod")?, slow = a.bars("slowPeriod")?,
                signal = a.bars("signalPeriod")?);
            names!(a, o; high, low, close, volume, prefix);
            series.klinger(o)
        }
        "volumeOscillator" => {
            let mut o = VolumeOscillator::default();
            set!(o; fast = a.bars("fastPeriod")?, slow = a.bars("slowPeriod")?,
                ma = a.ma("maType")?);
            names!(a, o; volume, output);
            series.volume_oscillator(o)
        }
        "tradeVolumeIndex" => {
            let mut o = TradeVolumeIndex::new(a.required_number("minTick")?);
            names!(a, o; column, volume, output);
            series.trade_volume_index(o)
        }
        "negativeVolumeIndex" => {
            let mut o = NegativeVolumeIndex::default();
            set!(o; start = a.number("start")?);
            names!(a, o; column, volume, output);
            series.negative_volume_index(o)
        }
        "positiveVolumeIndex" => {
            let mut o = PositiveVolumeIndex::default();
            set!(o; start = a.number("start")?);
            names!(a, o; column, volume, output);
            series.positive_volume_index(o)
        }
        "marketFacilitationIndex" => {
            let mut o = MarketFacilitationIndex::default();
            names!(a, o; high, low, volume, output);
            series.market_facilitation_index(o)
        }
        "shinoharaIntensityRatio" => {
            let mut o = ShinoharaIntensityRatio::default();
            set!(o; period = a.bars("period")?);
            names!(a, o; open, high, low, close, prefix);
            series.shinohara_intensity_ratio(o)
        }
        "vwap" => {
            let mut o = Vwap::new(a.required_bars("period")?);
            names!(a, o; high, low, close, volume, output);
            series.vwap(o)
        }
        "anchoredVwap" => {
            let anchor = a.required_number("anchor")?;
            // Keys are whole milliseconds, so a fractional anchor is the
            // next whole one (`key < 40.5` is `key < 41`). Past i64 the
            // cast saturates, still before or after every key.
            let mut o = AnchoredVwap::new(anchor.ceil() as i64);
            names!(a, o; high, low, close, volume, output);
            series.anchored_vwap(o)
        }

        // Statistics.
        "linearRegression" => {
            let mut o = LinearRegression::default();
            set!(o; period = a.bars("period")?);
            names!(a, o; column, prefix);
            series.linear_regression(o)
        }
        "timeSeriesForecast" => series.time_series_forecast(a.study()?),
        "beta" => {
            let mut o = Beta::new(a.required_text("benchmark")?);
            set!(o; period = a.bars("period")?);
            names!(a, o; column, output);
            series.beta(o)
        }
        "correlation" => {
            let mut o = Correlation::new(a.required_text("benchmark")?);
            set!(o; period = a.bars("period")?);
            names!(a, o; column, output);
            series.correlation(o)
        }
        "priceRelative" => {
            let mut o = PriceRelative::new(a.required_text("benchmark")?);
            names!(a, o; column, output);
            series.price_relative(o)
        }
        "performanceIndex" => {
            let mut o = PerformanceIndex::new(a.required_text("benchmark")?);
            set!(o; period = a.bars("period")?);
            names!(a, o; column, output);
            series.performance_index(o)
        }
        "zScore" => series.z_score(a.study()?),
        "rollingStdev" => series.rolling_stdev(a.study()?),
        "rollingMin" => series.rolling_min(a.study()?),
        "rollingMax" => series.rolling_max(a.study()?),
        "rollingPercentile" => {
            let q = a.required_number("q")?;
            series.rolling_percentile(q, a.study()?)
        }

        // Price.
        "typicalPrice" => {
            let mut o = TypicalPrice::default();
            names!(a, o; high, low, close, output);
            series.typical_price(o)
        }
        "medianPrice" => {
            // `close` is on pond-ts's options but never read.
            a.text("close")?;
            let mut o = MedianPrice::default();
            names!(a, o; high, low, output);
            series.median_price(o)
        }
        "weightedClose" => {
            let mut o = WeightedClose::default();
            names!(a, o; high, low, close, output);
            series.weighted_close(o)
        }
        "averagePrice" => {
            let mut o = AveragePrice::default();
            names!(a, o; open, high, low, close, output);
            series.average_price(o)
        }
        "balanceOfPower" => {
            let mut o = BalanceOfPower::default();
            set!(o; period = a.bars("period")?, ma = a.ma("maType")?);
            names!(a, o; open, high, low, close, output);
            series.balance_of_power(o)
        }

        // Sessions.
        "sessionVwap" | "pivotPoints" => {
            let list;
            let anchor = match (given, a.get("sessions"), a.text("session")?) {
                (Some(anchor), None, None) => anchor,
                (None, Some(v), None) => {
                    list = session_list(&a, v)?;
                    SessionAnchor::from(&list)
                }
                (None, None, Some(column)) => SessionAnchor::column(column),
                (given, sessions, session) => {
                    let doors = [given.is_some(), sessions.is_some(), session.is_some()];
                    return Err(a.error(format!(
                        "{} needs exactly one of 'sessions' (a TradingCalendar or Session[]) or 'session' (the name of a session-id column, e.g. from TradingCalendar.tagSessions); got {}",
                        d.name,
                        if doors.contains(&true) { "both" } else { "neither" }
                    )));
                }
            };
            let stamped = match a.text("stamped")? {
                None => None,
                Some("open") => Some(Stamped::Open),
                Some("close") => Some(Stamped::Close),
                Some(other) => {
                    return Err(a.error(format!(
                        "{} 'stamped' must be 'open' or 'close'; got \"{other}\"",
                        d.name
                    )));
                }
            };
            if d.name == "sessionVwap" {
                let mut o = SessionVwap::new(anchor);
                set!(o; stamped = stamped);
                names!(a, o; high, low, close, volume, output);
                series.session_vwap(o)
            } else {
                let mut o = PivotPoints::new(anchor);
                set!(o; stamped = stamped, method = pivot_method(&a)?);
                names!(a, o; high, low, close, prefix);
                series.pivot_points(o)
            }
        }
        other => Err(a.error(format!("'{other}' is not a catalog study"))),
    }
}

fn oscillator_mode(a: &Args<'_>) -> Result<Option<OscillatorMode>> {
    match a.text("mode")? {
        None => Ok(None),
        Some("percent") => Ok(Some(OscillatorMode::Percent)),
        Some("absolute") => Ok(Some(OscillatorMode::Absolute)),
        Some(other) => Err(a.error(format!(
            "'mode' must be 'percent' or 'absolute'; got \"{other}\""
        ))),
    }
}

fn pivot_method(a: &Args<'_>) -> Result<Option<PivotMethod>> {
    match a.text("method")? {
        None => Ok(None),
        Some("standard") => Ok(Some(PivotMethod::Standard)),
        Some("fibonacci") => Ok(Some(PivotMethod::Fibonacci)),
        Some("woodie") => Ok(Some(PivotMethod::Woodie)),
        Some("camarilla") => Ok(Some(PivotMethod::Camarilla)),
        Some(other) => Err(a.error(format!(
            "'method' must be one of standard, fibonacci, woodie, camarilla; got \"{other}\""
        ))),
    }
}

/// A session list written as pond-ts `Session` objects: `date`, `open`,
/// `close` (epoch milliseconds) and optional `breaks` (`start`, `end`).
fn session_list(a: &Args<'_>, v: &Value) -> Result<Vec<Session>> {
    let bad = || {
        a.error(
            "'sessions' must be a list of sessions ({ date, open, close, breaks? }, times in epoch milliseconds)"
                .into(),
        )
    };
    // A whole number of milliseconds, however the JSON spells it: `100`,
    // `100.0` and `1e2` are one number to pond-ts, and Python or an agent
    // may write any of them (Codex review R09: only the first was read).
    let ms = |v: &Value| {
        v.as_i64()
            .or_else(|| {
                v.as_f64()
                    .filter(|x| x.fract() == 0.0 && x.abs() <= 9_007_199_254_740_992.0)
                    .map(|x| x as i64)
            })
            .ok_or_else(bad)
    };
    v.as_array()
        .ok_or_else(bad)?
        .iter()
        .map(|s| {
            let date = s.get("date").and_then(Value::as_str).ok_or_else(bad)?;
            let mut session = Session::new(
                date,
                ms(s.get("open").ok_or_else(bad)?)?,
                ms(s.get("close").ok_or_else(bad)?)?,
            );
            match s.get("breaks") {
                None => {}
                Some(Value::Array(breaks)) => {
                    for b in breaks {
                        session = session.with_break(
                            ms(b.get("start").ok_or_else(bad)?)?,
                            ms(b.get("end").ok_or_else(bad)?)?,
                        );
                    }
                }
                Some(_) => return Err(bad()),
            }
            Ok(session)
        })
        .collect()
}
