//! One door for both study harnesses: a pond-ts study call, written as its
//! name and its pond-ts options (JSON), made on a pond-rs series.

use pond_rs::financial::*;
use pond_rs::{Result, TimeSeries};
use serde_json::{Map, Value};

/// Studies [`call_study`] knows.
pub const STUDIES: &[&str] = &[
    "sma",
    "ema",
    "movingAverage",
    "rollingStdev",
    "rollingMin",
    "rollingMax",
    "rollingPercentile",
    "zScore",
    "macd",
    "priceOscillator",
    "movingAverageCross",
    "movingAverageDeviation",
    "disparityIndex",
    "detrendedPriceOscillator",
    "guppy",
    "rainbow",
    "rainbowOscillator",
    "trix",
    "schaffTrendCycle",
    "coppock",
    "kst",
    "specialK",
    "priceMomentumOscillator",
    "bollinger",
    "bollingerBandwidth",
    "bollingerPercentB",
    "keltner",
    "starcBands",
    "atrBands",
    "donchian",
    "highLowBands",
    "primeNumberBands",
    "envelope",
    "rsi",
    "stochastic",
    "stochasticMomentumIndex",
    "stochasticRsi",
    "williamsR",
    "chandeMomentum",
    "momentum",
    "percentChange",
    "intradayMomentumIndex",
    "awesomeOscillator",
    "ultimateOscillator",
    "commodityChannelIndex",
    "fisherTransform",
    "psychologicalLine",
    "prettyGoodOscillator",
    "primeNumberOscillator",
    "qstick",
    "relativeVigorIndex",
    "centerOfGravity",
    "chandeForecastOscillator",
    "trueStrengthIndex",
    "directionalMovement",
    "aroon",
    "vortex",
    "verticalHorizontalFilter",
    "randomWalkIndex",
    "superTrend",
    "parabolicSar",
    "atrTrailingStop",
    "zigZag",
    "ichimoku",
    "elderImpulse",
    "elderRay",
    "trendIntensityIndex",
    "ravi",
    "swingIndex",
    "accumulativeSwingIndex",
    "atr",
    "historicalVolatility",
    "chaikinVolatility",
    "massIndex",
    "choppinessIndex",
    "gopalakrishnanRangeIndex",
    "ulcerIndex",
    "relativeVolatilityIndex",
];

/// The columns `study` reads with these options: `column` (default
/// `close`), or the price columns it takes (atrBands' `column` defaults to
/// its `close`).
pub fn sources(study: &str, options: &Map<String, Value>) -> Vec<String> {
    let text = |key: &str, default: &str| {
        options
            .get(key)
            .map_or(default, |v| v.as_str().unwrap())
            .to_string()
    };
    match study {
        "keltner" | "starcBands" => vec![
            text("high", "high"),
            text("low", "low"),
            text("close", "close"),
        ],
        "atrBands" | "prettyGoodOscillator" => {
            let close = text("close", "close");
            vec![
                text("column", &close),
                text("high", "high"),
                text("low", "low"),
                close,
            ]
        }
        "stochastic"
        | "stochasticMomentumIndex"
        | "williamsR"
        | "ultimateOscillator"
        | "commodityChannelIndex"
        | "directionalMovement"
        | "vortex"
        | "randomWalkIndex"
        | "superTrend"
        | "atrTrailingStop"
        | "ichimoku"
        | "elderRay"
        | "atr"
        | "choppinessIndex" => vec![
            text("high", "high"),
            text("low", "low"),
            text("close", "close"),
        ],
        "intradayMomentumIndex" | "qstick" => vec![text("open", "open"), text("close", "close")],
        "awesomeOscillator" | "fisherTransform" => vec![text("high", "high"), text("low", "low")],
        "relativeVigorIndex" => vec![
            text("open", "open"),
            text("high", "high"),
            text("low", "low"),
            text("close", "close"),
        ],
        "swingIndex" | "accumulativeSwingIndex" => vec![
            text("open", "open"),
            text("high", "high"),
            text("low", "low"),
            text("close", "close"),
        ],
        "donchian"
        | "highLowBands"
        | "primeNumberBands"
        | "aroon"
        | "parabolicSar"
        | "zigZag"
        | "chaikinVolatility"
        | "massIndex"
        | "gopalakrishnanRangeIndex" => {
            vec![text("high", "high"), text("low", "low")]
        }
        _ => vec![text("column", "close")],
    }
}

/// Options pond-ts reads as bar counts.
const PERIODS: &[&str] = &[
    "period",
    "fastPeriod",
    "slowPeriod",
    "signalPeriod",
    "cyclePeriod",
    "lookback",
    "longPeriod",
    "shortPeriod",
    "wmaPeriod",
    "atrPeriod",
    "kPeriod",
    "dPeriod",
    "slowing",
    "rsiPeriod",
    "stochPeriod",
    "periods",
    "mediumPeriod",
    "emaPeriod",
    "maPeriod",
    "conversionPeriod",
    "basePeriod",
    "spanBPeriod",
    "displacement",
    "rocPeriod",
    "sumPeriod",
    "stdevPeriod",
];

/// Calls `study` on `series` with pond-ts `options`. `None` when Rust
/// cannot express the call (a period that is negative or not whole, an
/// unknown `mode`): pond-ts must refuse those. Panics on a study not in
/// [`STUDIES`].
pub fn call_study(
    series: &TimeSeries,
    study: &str,
    options: &Map<String, Value>,
) -> Option<Result<TimeSeries>> {
    for key in PERIODS {
        if let Some(v) = options.get(*key) {
            let v = v.as_f64().unwrap();
            if v < 0.0 || v.fract() != 0.0 {
                return None;
            }
        }
    }
    let int = |key: &str, default: usize| {
        options
            .get(key)
            .map_or(default, |v| v.as_f64().unwrap() as usize)
    };
    let text = |key: &str| options.get(key).map(|v| v.as_str().unwrap());
    let int_required = |key: &str| options.get(key).map(|v| v.as_f64().unwrap() as usize);
    let num = |key: &str, default: f64| options.get(key).map_or(default, |v| v.as_f64().unwrap());
    // Applies the price columns a study reads.
    macro_rules! reads {
        ($options:expr, $($src:ident),*) => {{
            let mut o = $options;
            $(
                if let Some(c) = text(stringify!($src)) {
                    o = o.$src(c);
                }
            )*
            o
        }};
    }
    // An unknown moving-average name can't reach a study in Rust (`MaType`
    // is an enum), so pond-ts's error for it is not something to compare.
    if ["type", "maType"]
        .iter()
        .any(|k| text(k).is_some_and(|name| MaType::parse(name).is_err()))
    {
        return None;
    }
    let ma = |key: &str, default: &str| MaType::parse(text(key).unwrap_or(default));
    let mode = match text("mode") {
        None | Some("percent") => OscillatorMode::Percent,
        Some("absolute") => OscillatorMode::Absolute,
        Some(_) => return None,
    };
    let study_of = |default: usize| {
        let mut s = Study::period(int("period", default));
        if let Some(c) = text("column") {
            s = s.column(c);
        }
        if let Some(o) = text("output") {
            s = s.output(o);
        }
        s
    };
    // Applies `column` and the naming option to an options struct.
    // Applies only the naming option (for studies with no `column`).
    macro_rules! name_only {
        ($options:expr, $naming:ident) => {{
            let mut o = $options;
            if let Some(n) = text(stringify!($naming)) {
                o = o.$naming(n);
            }
            o
        }};
    }
    macro_rules! named {
        ($options:expr, $naming:ident) => {{
            let mut o = $options;
            if let Some(c) = text("column") {
                o = o.column(c);
            }
            if let Some(n) = text(stringify!($naming)) {
                o = o.$naming(n);
            }
            o
        }};
    }
    Some(match study {
        "sma" => series.sma(study_of(0)),
        "ema" => series.ema(study_of(0)),
        "movingAverage" => {
            // pond-ts checks the period before the type.
            if int("period", 0) == 0 {
                series.moving_average(MaType::Sma, study_of(0))
            } else {
                ma("type", "sma").and_then(|kind| series.moving_average(kind, study_of(0)))
            }
        }
        "rollingStdev" => series.rolling_stdev(study_of(0)),
        "rollingMin" => series.rolling_min(study_of(0)),
        "rollingMax" => series.rolling_max(study_of(0)),
        "rollingPercentile" => {
            series.rolling_percentile(options["q"].as_f64().unwrap(), study_of(0))
        }
        "zScore" => series.z_score(study_of(0)),
        "macd" => series.macd(named!(
            Macd::default()
                .fast(int("fastPeriod", 12))
                .slow(int("slowPeriod", 26))
                .signal(int("signalPeriod", 9)),
            prefix
        )),
        "priceOscillator" => ma("maType", "ema").and_then(|kind| {
            series.price_oscillator(named!(
                PriceOscillator::default()
                    .fast(int("fastPeriod", 12))
                    .slow(int("slowPeriod", 26))
                    .ma(kind)
                    .mode(mode),
                output
            ))
        }),
        "movingAverageCross" => ma("maType", "sma").and_then(|kind| {
            series.moving_average_cross(named!(
                MovingAverageCross::default()
                    .fast(int("fastPeriod", 10))
                    .slow(int("slowPeriod", 30))
                    .ma(kind),
                output
            ))
        }),
        "movingAverageDeviation" => {
            ma("maType", "sma").and_then(|kind| series.moving_average_deviation(kind, study_of(20)))
        }
        "disparityIndex" => {
            ma("maType", "sma").and_then(|kind| series.disparity_index(kind, study_of(14)))
        }
        "detrendedPriceOscillator" => ma("maType", "sma")
            .and_then(|kind| series.detrended_price_oscillator(kind, study_of(20))),
        "guppy" => ma("type", "ema")
            .and_then(|kind| series.guppy(named!(Guppy::default().ma(kind), prefix))),
        "rainbow" => ma("type", "sma").and_then(|kind| {
            series.rainbow(named!(
                Rainbow::default().period(int("period", 2)).ma(kind),
                prefix
            ))
        }),
        "rainbowOscillator" => ma("type", "sma").and_then(|kind| {
            series.rainbow_oscillator(named!(
                RainbowOscillator::default()
                    .period(int("period", 2))
                    .lookback(int("lookback", 10))
                    .ma(kind),
                prefix
            ))
        }),
        "trix" => series.trix(named!(
            Trix::default()
                .period(int("period", 15))
                .signal(int("signalPeriod", 9)),
            prefix
        )),
        "schaffTrendCycle" => series.schaff_trend_cycle(named!(
            SchaffTrendCycle::default()
                .fast(int("fastPeriod", 23))
                .slow(int("slowPeriod", 50))
                .cycle(int("cyclePeriod", 10)),
            output
        )),
        "coppock" => series.coppock(named!(
            Coppock::default()
                .long(int("longPeriod", 14))
                .short(int("shortPeriod", 11))
                .wma_period(int("wmaPeriod", 10)),
            output
        )),
        "kst" => series.kst(named!(
            Kst::default().signal(int("signalPeriod", 9)),
            prefix
        )),
        "specialK" => series.special_k(named!(SpecialK::default(), output)),
        "priceMomentumOscillator" => {
            series.price_momentum_oscillator(named!(PriceMomentumOscillator::default(), prefix))
        }
        // pond-ts has no default period for these two: a call without one
        // has no Rust spelling (it must throw in pond-ts).
        "bollinger" => series.bollinger(named!(
            Bollinger::new(int_required("period")?).std_dev(num("stdDev", 2.0)),
            prefix
        )),
        "bollingerBandwidth" => series.bollinger_bandwidth(named!(
            BollingerBandwidth::default()
                .period(int("period", 20))
                .std_dev(num("stdDev", 2.0)),
            output
        )),
        "bollingerPercentB" => series.bollinger_percent_b(named!(
            BollingerPercentB::default()
                .period(int("period", 20))
                .std_dev(num("stdDev", 2.0)),
            output
        )),
        "keltner" => ma("maType", "ema").and_then(|kind| {
            series.keltner(reads!(
                name_only!(
                    Keltner::default()
                        .period(int("period", 20))
                        .atr_period(int("atrPeriod", 10))
                        .multiplier(num("multiplier", 2.0))
                        .ma(kind),
                    prefix
                ),
                high,
                low,
                close
            ))
        }),
        "starcBands" => ma("maType", "sma").and_then(|kind| {
            series.starc_bands(reads!(
                name_only!(
                    StarcBands::default()
                        .period(int("period", 20))
                        .atr_period(int("atrPeriod", 15))
                        .multiplier(num("multiplier", 2.0))
                        .ma(kind),
                    prefix
                ),
                high,
                low,
                close
            ))
        }),
        "atrBands" => series.atr_bands(reads!(
            named!(
                AtrBands::default()
                    .period(int("period", 14))
                    .multiplier(num("multiplier", 2.0)),
                prefix
            ),
            high,
            low,
            close
        )),
        "donchian" => series.donchian(reads!(
            name_only!(Donchian::default().period(int("period", 20)), prefix),
            high,
            low
        )),
        "highLowBands" => ma("maType", "trima").and_then(|kind| {
            series.high_low_bands(reads!(
                name_only!(
                    HighLowBands::default()
                        .period(int("period", 10))
                        .percent(num("percent", 1.0))
                        .ma(kind),
                    prefix
                ),
                high,
                low
            ))
        }),
        "primeNumberBands" => series.prime_number_bands(reads!(
            name_only!(PrimeNumberBands::default(), prefix),
            high,
            low
        )),
        "envelope" => {
            let period = int_required("period")?;
            ma("maType", "sma").and_then(|kind| {
                series.envelope(named!(
                    Envelope::new(period).percent(num("percent", 2.5)).ma(kind),
                    prefix
                ))
            })
        }
        "rsi" => series.rsi(study_of(14)),
        "chandeMomentum" => series.chande_momentum(study_of(14)),
        "momentum" => series.momentum(study_of(10)),
        "percentChange" => series.percent_change(named!(
            PercentChange::default().periods(int("periods", 1)),
            output
        )),
        "stochastic" => series.stochastic(reads!(
            name_only!(
                Stochastic::default()
                    .k_period(int("kPeriod", 14))
                    .slowing(int("slowing", 3))
                    .d_period(int("dPeriod", 3)),
                prefix
            ),
            high,
            low,
            close
        )),
        "stochasticMomentumIndex" => series.stochastic_momentum_index(reads!(
            name_only!(
                StochasticMomentumIndex::default()
                    .period(int("period", 13))
                    .long(int("longPeriod", 25))
                    .short(int("shortPeriod", 2))
                    .signal(int("signalPeriod", 3)),
                prefix
            ),
            high,
            low,
            close
        )),
        "stochasticRsi" => series.stochastic_rsi(named!(
            StochasticRsi::default()
                .rsi_period(int("rsiPeriod", 14))
                .stoch_period(int("stochPeriod", 14))
                .k_period(int("kPeriod", 3))
                .d_period(int("dPeriod", 3)),
            prefix
        )),
        "williamsR" => series.williams_r(reads!(
            name_only!(WilliamsR::default().period(int("period", 14)), output),
            high,
            low,
            close
        )),
        "intradayMomentumIndex" => series.intraday_momentum_index(reads!(
            name_only!(
                IntradayMomentumIndex::default().period(int("period", 14)),
                output
            ),
            open,
            close
        )),
        "awesomeOscillator" => series.awesome_oscillator(reads!(
            name_only!(
                AwesomeOscillator::default()
                    .fast(int("fastPeriod", 5))
                    .slow(int("slowPeriod", 34)),
                output
            ),
            high,
            low
        )),
        "ultimateOscillator" => series.ultimate_oscillator(reads!(
            name_only!(
                UltimateOscillator::default()
                    .short(int("shortPeriod", 7))
                    .medium(int("mediumPeriod", 14))
                    .long(int("longPeriod", 28)),
                output
            ),
            high,
            low,
            close
        )),
        "commodityChannelIndex" => series.commodity_channel_index(reads!(
            name_only!(
                CommodityChannelIndex::default().period(int("period", 20)),
                output
            ),
            high,
            low,
            close
        )),
        "fisherTransform" => series.fisher_transform(reads!(
            name_only!(FisherTransform::default().period(int("period", 10)), prefix),
            high,
            low
        )),
        "psychologicalLine" => series.psychological_line(study_of(12)),
        "prettyGoodOscillator" => series.pretty_good_oscillator(reads!(
            named!(
                PrettyGoodOscillator::default().period(int("period", 14)),
                output
            ),
            high,
            low,
            close
        )),
        "primeNumberOscillator" => {
            series.prime_number_oscillator(named!(PrimeNumberOscillator::default(), output))
        }
        "qstick" => ma("maType", "sma").and_then(|kind| {
            series.qstick(reads!(
                name_only!(Qstick::default().period(int("period", 8)).ma(kind), output),
                open,
                close
            ))
        }),
        "relativeVigorIndex" => series.relative_vigor_index(reads!(
            name_only!(
                RelativeVigorIndex::default().period(int("period", 10)),
                prefix
            ),
            open,
            high,
            low,
            close
        )),
        "centerOfGravity" => series.center_of_gravity(study_of(10)),
        "chandeForecastOscillator" => series.chande_forecast_oscillator(study_of(14)),
        "trueStrengthIndex" => series.true_strength_index(named!(
            TrueStrengthIndex::default()
                .long(int("longPeriod", 25))
                .short(int("shortPeriod", 13))
                .signal(int("signalPeriod", 7)),
            prefix
        )),
        "directionalMovement" => series.directional_movement(reads!(
            name_only!(
                DirectionalMovement::default().period(int("period", 14)),
                prefix
            ),
            high,
            low,
            close
        )),
        "aroon" => series.aroon(reads!(
            name_only!(Aroon::default().period(int("period", 25)), prefix),
            high,
            low
        )),
        "vortex" => series.vortex(reads!(
            name_only!(Vortex::default().period(int("period", 14)), prefix),
            high,
            low,
            close
        )),
        "verticalHorizontalFilter" => series.vertical_horizontal_filter(study_of(28)),
        "randomWalkIndex" => series.random_walk_index(reads!(
            name_only!(RandomWalkIndex::default().period(int("period", 14)), prefix),
            high,
            low,
            close
        )),
        "superTrend" => series.super_trend(reads!(
            name_only!(
                SuperTrend::default()
                    .period(int("period", 10))
                    .multiplier(num("multiplier", 3.0)),
                prefix
            ),
            high,
            low,
            close
        )),
        "parabolicSar" => series.parabolic_sar(reads!(
            name_only!(
                ParabolicSar::default()
                    .step(num("step", 0.02))
                    .max_step(num("maxStep", 0.2)),
                prefix
            ),
            high,
            low
        )),
        "atrTrailingStop" => series.atr_trailing_stop(reads!(
            name_only!(
                AtrTrailingStop::default()
                    .period(int("period", 14))
                    .multiplier(num("multiplier", 3.0)),
                prefix
            ),
            high,
            low,
            close
        )),
        "zigZag" => series.zig_zag(reads!(
            name_only!(ZigZag::default().deviation(num("deviation", 5.0)), prefix),
            high,
            low
        )),
        "ichimoku" => series.ichimoku(reads!(
            name_only!(
                Ichimoku::default()
                    .conversion(int("conversionPeriod", 9))
                    .base(int("basePeriod", 26))
                    .span_b(int("spanBPeriod", 52))
                    .displacement(int("displacement", 26)),
                prefix
            ),
            high,
            low,
            close
        )),
        "elderImpulse" => series.elder_impulse(named!(
            ElderImpulse::default()
                .ema(int("emaPeriod", 13))
                .fast(int("fastPeriod", 12))
                .slow(int("slowPeriod", 26))
                .signal(int("signalPeriod", 9)),
            output
        )),
        "elderRay" => series.elder_ray(reads!(
            name_only!(ElderRay::default().period(int("period", 13)), prefix),
            high,
            low,
            close
        )),
        "trendIntensityIndex" => series.trend_intensity_index(named!(
            TrendIntensityIndex::default()
                .period(int("period", 30))
                .ma_period(int("maPeriod", 60)),
            output
        )),
        "ravi" => series.ravi(named!(
            Ravi::default()
                .short(int("shortPeriod", 7))
                .long(int("longPeriod", 65)),
            output
        )),
        // pond-ts requires `limit`; a Rust call cannot leave it out.
        "swingIndex" => {
            let limit = options.get("limit")?.as_f64().unwrap();
            series.swing_index(reads!(
                name_only!(SwingIndex::new(limit), output),
                open,
                high,
                low,
                close
            ))
        }
        "accumulativeSwingIndex" => {
            let limit = options.get("limit")?.as_f64().unwrap();
            series.accumulative_swing_index(reads!(
                name_only!(AccumulativeSwingIndex::new(limit), output),
                open,
                high,
                low,
                close
            ))
        }
        "atr" => series.atr(reads!(
            name_only!(Atr::default().period(int("period", 14)), output),
            high,
            low,
            close
        )),
        "historicalVolatility" => series.historical_volatility(named!(
            HistoricalVolatility::default()
                .period(int("period", 20))
                .annualize(num("annualize", 252.0)),
            output
        )),
        "chaikinVolatility" => series.chaikin_volatility(reads!(
            name_only!(
                ChaikinVolatility::default()
                    .period(int("period", 10))
                    .roc_period(int("rocPeriod", 10)),
                output
            ),
            high,
            low
        )),
        "massIndex" => series.mass_index(reads!(
            name_only!(
                MassIndex::default()
                    .ema(int("emaPeriod", 9))
                    .sum(int("sumPeriod", 25)),
                output
            ),
            high,
            low
        )),
        "choppinessIndex" => series.choppiness_index(reads!(
            name_only!(ChoppinessIndex::default().period(int("period", 14)), output),
            high,
            low,
            close
        )),
        "gopalakrishnanRangeIndex" => series.gopalakrishnan_range_index(reads!(
            name_only!(
                GopalakrishnanRangeIndex::default().period(int("period", 10)),
                output
            ),
            high,
            low
        )),
        "ulcerIndex" => series.ulcer_index(study_of(14)),
        "relativeVolatilityIndex" => series.relative_volatility_index(named!(
            RelativeVolatilityIndex::default()
                .period(int("period", 14))
                .stdev(int("stdevPeriod", 10)),
            output
        )),
        other => panic!("no pond-rs call for study '{other}'"),
    })
}
