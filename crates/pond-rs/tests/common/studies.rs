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
];

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
                .wma(int("wmaPeriod", 10)),
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
        other => panic!("no pond-rs call for study '{other}'"),
    })
}
