//! One door for both study harnesses: a pond-ts study call, written as its
//! name and its pond-ts options (JSON), made on a pond-rs series.

use pond_rs::financial::*;
use pond_rs::{Result, TimeSeries};
use serde_json::{Map, Value};

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
        "obv" | "priceVolumeTrend" | "forceIndex" => {
            vec![text("close", "close"), text("volume", "volume")]
        }
        "accumulationDistribution"
        | "chaikinMoneyFlow"
        | "chaikinOscillator"
        | "moneyFlowIndex"
        | "twiggsMoneyFlow" => vec![
            text("high", "high"),
            text("low", "low"),
            text("close", "close"),
            text("volume", "volume"),
        ],
        "easeOfMovement" | "marketFacilitationIndex" => vec![
            text("high", "high"),
            text("low", "low"),
            text("volume", "volume"),
        ],
        "klinger" | "vwap" | "sessionVwap" | "anchoredVwap" => vec![
            text("high", "high"),
            text("low", "low"),
            text("close", "close"),
            text("volume", "volume"),
        ],
        "volumeOscillator" => vec![text("volume", "volume")],
        "typicalPrice" | "weightedClose" | "pivotPoints" => vec![
            text("high", "high"),
            text("low", "low"),
            text("close", "close"),
        ],
        // pond-ts takes a `close` here and never reads it.
        "medianPrice" => vec![text("high", "high"), text("low", "low")],
        "averagePrice" | "balanceOfPower" => vec![
            text("open", "open"),
            text("high", "high"),
            text("low", "low"),
            text("close", "close"),
        ],
        "tradeVolumeIndex" | "negativeVolumeIndex" | "positiveVolumeIndex" => {
            vec![text("column", "close"), text("volume", "volume")]
        }
        "shinoharaIntensityRatio" => vec![
            text("open", "open"),
            text("high", "high"),
            text("low", "low"),
            text("close", "close"),
        ],
        _ => vec![text("column", "close")],
    }
}

/// Calls `study` on `series` with pond-ts `options`, through the catalog
/// runner. A `sessions` object is the fixture's way of writing a
/// calendar (see [`session_calendar`]); it goes in through `run_with`.
pub fn call_study(
    series: &TimeSeries,
    study: &str,
    options: &Map<String, Value>,
) -> Result<TimeSeries> {
    let d = catalog::study_descriptor(study)
        .unwrap_or_else(|| panic!("study '{study}' is not in the catalog"));
    if let Some(v @ Value::Object(_)) = options.get("sessions") {
        let calendar = session_calendar(v);
        let mut rest = options.clone();
        rest.remove("sessions");
        return d.run_with(series, &rest, SessionAnchor::from(&calendar));
    }
    d.run(series, options)
}

/// The calendar `{ rules, from, to }` stands for (the fixture's way of
/// writing a `TradingCalendar`).
pub fn session_calendar(v: &Value) -> TradingCalendar {
    let r = &v["rules"];
    let text = |key: &str| r[key].as_str().unwrap();
    let mut rules = SessionRules::new(text("timeZone"), text("open"), text("close"));
    for h in r["holidays"].as_array().into_iter().flatten() {
        rules = rules.holiday(h.as_str().unwrap());
    }
    assert!(
        r.get("weekmask").is_none() && r.get("breaks").is_none() && r.get("earlyCloses").is_none(),
        "session_calendar reads the zone, hours and holidays only"
    );
    TradingCalendar::from_rules(
        &rules,
        v["from"].as_str().unwrap(),
        v["to"].as_str().unwrap(),
    )
    .expect("fixture calendar")
}
