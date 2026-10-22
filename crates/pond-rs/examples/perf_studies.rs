//! Timing for the R2 financial studies: step 1 (`sma`, `ema`,
//! `moving_average` of every type, `rolling_stdev` / `min` / `max` /
//! `percentile`, `z_score`) and step 2a, the moving-average family (at
//! pond-ts's defaults). Same data as `bench/studies_pond_ts.mjs` for
//! the `@pond-ts/financial` side; both print a checksum per case (present
//! values in the output and their sum) so the answers can be compared.
//!
//!     cargo run --release -p pond-rs --example perf_studies [name prefix]
//!
//! Cost, for N rows and period P: the mean / spread, weighted, Wilder,
//! exponential and z-score kernels read each row a constant number of
//! times, plus a rebuild of P rows every P rows (O(N)). Min / max keep a
//! queue of candidates (O(N)); the percentile goes through `rolling_rows`,
//! which keeps the window sorted (O(N·P) worst case). Every step 2a study
//! is a fixed number of those kernels plus O(N) arithmetic (guppy 12,
//! rainbow 10, Special K 12 averages), so O(N).
//! Mean / spread, WMA and min / max split rows across cores (same bits);
//! `RAYON_NUM_THREADS=1` times them on one.

use std::time::Instant;

use pond_rs::financial::*;
use pond_rs::{Column, TimeSeries};

fn median_ms(mut f: impl FnMut() -> TimeSeries) -> (f64, TimeSeries) {
    let out = f();
    let mut t: Vec<f64> = (0..7)
        .map(|_| {
            let s = Instant::now();
            std::hint::black_box(f());
            s.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    t.sort_by(f64::total_cmp);
    (t[3], out)
}

/// Present values in `column`, and their sum.
fn checksum(s: &TimeSeries, column: &str) -> (usize, f64) {
    let v = s.column(column).unwrap().numbers().unwrap();
    let present: Vec<f64> = v.iter().flatten().collect();
    (present.len(), present.iter().sum())
}

fn price(i: usize) -> f64 {
    100.0 + ((i * 7919) % 10_007) as f64 / 800.0
}

/// 1M bars a minute apart; `gappy` misses every 17th close.
fn make(rows: usize, gappy: bool) -> TimeSeries {
    let time = (0..rows as i64).map(|i| i * 60_000).collect();
    let close: Vec<Option<f64>> = (0..rows)
        .map(|i| (!gappy || i % 17 != 5).then(|| price(i)))
        .collect();
    TimeSeries::new("bench", time, vec![Column::optional("close", close)]).unwrap()
}

/// 1M price bars: high and low a varying spread either side of the close,
/// and an open (the next close).
fn make_bars(rows: usize) -> TimeSeries {
    let time = (0..rows as i64).map(|i| i * 60_000).collect();
    let spread = |i: usize| ((i * 31) % 97) as f64 / 100.0 + 0.1;
    let high: Vec<f64> = (0..rows).map(|i| price(i) + spread(i)).collect();
    let low: Vec<f64> = (0..rows).map(|i| price(i) - spread(i)).collect();
    let close: Vec<f64> = (0..rows).map(price).collect();
    let open: Vec<f64> = (0..rows).map(|i| price(i + 1)).collect();
    TimeSeries::new(
        "bars",
        time,
        vec![
            Column::required("high", high),
            Column::required("low", low),
            Column::required("close", close),
            Column::required("open", open),
        ],
    )
    .unwrap()
}

fn main() -> pond_rs::Result<()> {
    let only: Option<String> = std::env::args().nth(1);
    let dense = make(1_000_000, false);
    let gappy = make(1_000_000, true);
    let bars = make_bars(1_000_000);
    let p = Study::period;
    type Case<'a> = (String, &'a str, Box<dyn Fn() -> TimeSeries + 'a>);
    let mut cases: Vec<Case> = vec![
        (
            "sma 20".into(),
            "sma",
            Box::new(|| dense.sma(p(20)).unwrap()),
        ),
        (
            "sma 200".into(),
            "sma",
            Box::new(|| dense.sma(p(200)).unwrap()),
        ),
        (
            "sma 20 gaps".into(),
            "sma",
            Box::new(|| gappy.sma(p(20)).unwrap()),
        ),
        (
            "ema 20".into(),
            "ema",
            Box::new(|| dense.ema(p(20)).unwrap()),
        ),
        (
            "stdev 20".into(),
            "stdev",
            Box::new(|| dense.rolling_stdev(p(20)).unwrap()),
        ),
        (
            "min 20".into(),
            "min",
            Box::new(|| dense.rolling_min(p(20)).unwrap()),
        ),
        (
            "max 200".into(),
            "max",
            Box::new(|| dense.rolling_max(p(200)).unwrap()),
        ),
        (
            "p90 20".into(),
            "p90",
            Box::new(|| dense.rolling_percentile(90.0, p(20)).unwrap()),
        ),
        (
            "zscore 20".into(),
            "zscore",
            Box::new(|| dense.z_score(p(20)).unwrap()),
        ),
        (
            "zscore 20 gaps".into(),
            "zscore",
            Box::new(|| gappy.z_score(p(20)).unwrap()),
        ),
    ];
    for kind in MaType::ALL {
        let dense = &dense;
        cases.push((
            format!("ma {} 20", kind.as_str()),
            "ma",
            Box::new(move || dense.moving_average(kind, p(20)).unwrap()),
        ));
    }
    // R2 step 2a: the moving-average family, at pond-ts's defaults.
    let family: Vec<Case> = vec![
        (
            "macd".into(),
            "macdSignal",
            Box::new(|| dense.macd(Macd::default()).unwrap()),
        ),
        (
            "priceOsc".into(),
            "priceOsc",
            Box::new(|| dense.price_oscillator(PriceOscillator::default()).unwrap()),
        ),
        (
            "maCross".into(),
            "maCross",
            Box::new(|| {
                dense
                    .moving_average_cross(MovingAverageCross::default())
                    .unwrap()
            }),
        ),
        (
            "maDev 20".into(),
            "maDev",
            Box::new(|| dense.moving_average_deviation(MaType::Sma, p(20)).unwrap()),
        ),
        (
            "disparity 14".into(),
            "disparity",
            Box::new(|| dense.disparity_index(MaType::Sma, p(14)).unwrap()),
        ),
        (
            "dpo 20".into(),
            "dpo",
            Box::new(|| {
                dense
                    .detrended_price_oscillator(MaType::Sma, p(20))
                    .unwrap()
            }),
        ),
        (
            "guppy".into(),
            "gmmaL60",
            Box::new(|| dense.guppy(Guppy::default()).unwrap()),
        ),
        (
            "rainbow".into(),
            "rainbow10",
            Box::new(|| dense.rainbow(Rainbow::default()).unwrap()),
        ),
        (
            "rbo".into(),
            "rbo",
            Box::new(|| {
                dense
                    .rainbow_oscillator(RainbowOscillator::default())
                    .unwrap()
            }),
        ),
        (
            "trix".into(),
            "trixSignal",
            Box::new(|| dense.trix(Trix::default()).unwrap()),
        ),
        (
            "stc".into(),
            "stc",
            Box::new(|| {
                dense
                    .schaff_trend_cycle(SchaffTrendCycle::default())
                    .unwrap()
            }),
        ),
        (
            "coppock".into(),
            "coppock",
            Box::new(|| dense.coppock(Coppock::default()).unwrap()),
        ),
        (
            "kst".into(),
            "kstSignal",
            Box::new(|| dense.kst(Kst::default()).unwrap()),
        ),
        (
            "specialK".into(),
            "specialK",
            Box::new(|| dense.special_k(SpecialK::default()).unwrap()),
        ),
        (
            "pmo".into(),
            "pmoSignal",
            Box::new(|| {
                dense
                    .price_momentum_oscillator(PriceMomentumOscillator::default())
                    .unwrap()
            }),
        ),
    ];
    cases.extend(family);
    // R2 step 2b: the bands family, at pond-ts's defaults.
    let bands: Vec<Case> = vec![
        (
            "bollinger 20".into(),
            "bbUpper",
            Box::new(|| bars.bollinger(Bollinger::new(20)).unwrap()),
        ),
        (
            "bbWidth".into(),
            "bbWidth",
            Box::new(|| {
                bars.bollinger_bandwidth(BollingerBandwidth::default())
                    .unwrap()
            }),
        ),
        (
            "percentB".into(),
            "percentB",
            Box::new(|| {
                bars.bollinger_percent_b(BollingerPercentB::default())
                    .unwrap()
            }),
        ),
        (
            "keltner".into(),
            "kcUpper",
            Box::new(|| bars.keltner(Keltner::default()).unwrap()),
        ),
        (
            "starc".into(),
            "starcUpper",
            Box::new(|| bars.starc_bands(StarcBands::default()).unwrap()),
        ),
        (
            "atrBands".into(),
            "atrbUpper",
            Box::new(|| bars.atr_bands(AtrBands::default()).unwrap()),
        ),
        (
            "donchian".into(),
            "dcMiddle",
            Box::new(|| bars.donchian(Donchian::default()).unwrap()),
        ),
        (
            "highLowBands".into(),
            "hlbUpper",
            Box::new(|| bars.high_low_bands(HighLowBands::default()).unwrap()),
        ),
        (
            "primeBands".into(),
            "pnbUpper",
            Box::new(|| {
                bars.prime_number_bands(PrimeNumberBands::default())
                    .unwrap()
            }),
        ),
        (
            "envelope 20".into(),
            "envUpper",
            Box::new(|| bars.envelope(Envelope::new(20)).unwrap()),
        ),
    ];
    cases.extend(bands);
    // R2 step 2c part 1: momentum, at pond-ts's defaults.
    let momentum: Vec<Case> = vec![
        (
            "rsi".into(),
            "rsi",
            Box::new(|| bars.rsi(Study::period(14)).unwrap()),
        ),
        (
            "stochastic".into(),
            "stochD",
            Box::new(|| bars.stochastic(Stochastic::default()).unwrap()),
        ),
        (
            "smi".into(),
            "smiSignal",
            Box::new(|| {
                bars.stochastic_momentum_index(StochasticMomentumIndex::default())
                    .unwrap()
            }),
        ),
        (
            "stochRsi".into(),
            "stochRsiD",
            Box::new(|| bars.stochastic_rsi(StochasticRsi::default()).unwrap()),
        ),
        (
            "williamsR".into(),
            "williamsR",
            Box::new(|| bars.williams_r(WilliamsR::default()).unwrap()),
        ),
        (
            "cmo".into(),
            "cmo",
            Box::new(|| bars.chande_momentum(Study::period(14)).unwrap()),
        ),
        (
            "momentum".into(),
            "momentum",
            Box::new(|| bars.momentum(Study::period(10)).unwrap()),
        ),
        (
            "pctChange".into(),
            "pctChange",
            Box::new(|| bars.percent_change(PercentChange::default()).unwrap()),
        ),
        (
            "imi".into(),
            "imi",
            Box::new(|| {
                bars.intraday_momentum_index(IntradayMomentumIndex::default())
                    .unwrap()
            }),
        ),
        (
            "ao".into(),
            "ao",
            Box::new(|| {
                bars.awesome_oscillator(AwesomeOscillator::default())
                    .unwrap()
            }),
        ),
        (
            "uo".into(),
            "uo",
            Box::new(|| {
                bars.ultimate_oscillator(UltimateOscillator::default())
                    .unwrap()
            }),
        ),
    ];
    cases.extend(momentum);
    // R2 step 2c part 2.
    let momentum2: Vec<Case> = vec![
        (
            "cci".into(),
            "cci",
            Box::new(|| {
                bars.commodity_channel_index(CommodityChannelIndex::default())
                    .unwrap()
            }),
        ),
        (
            "fisher".into(),
            "fisher",
            Box::new(|| bars.fisher_transform(FisherTransform::default()).unwrap()),
        ),
        (
            "psy".into(),
            "psy",
            Box::new(|| bars.psychological_line(Study::period(12)).unwrap()),
        ),
        (
            "pgo".into(),
            "pgo",
            Box::new(|| {
                bars.pretty_good_oscillator(PrettyGoodOscillator::default())
                    .unwrap()
            }),
        ),
        (
            "pno".into(),
            "pno",
            Box::new(|| {
                bars.prime_number_oscillator(PrimeNumberOscillator::default())
                    .unwrap()
            }),
        ),
        (
            "qstick".into(),
            "qstick",
            Box::new(|| bars.qstick(Qstick::default()).unwrap()),
        ),
        (
            "rvi".into(),
            "rviSignal",
            Box::new(|| {
                bars.relative_vigor_index(RelativeVigorIndex::default())
                    .unwrap()
            }),
        ),
        (
            "cog".into(),
            "cog",
            Box::new(|| bars.center_of_gravity(Study::period(10)).unwrap()),
        ),
        (
            "cfo".into(),
            "cfo",
            Box::new(|| bars.chande_forecast_oscillator(Study::period(14)).unwrap()),
        ),
        (
            "tsi".into(),
            "tsiSignal",
            Box::new(|| {
                bars.true_strength_index(TrueStrengthIndex::default())
                    .unwrap()
            }),
        ),
    ];
    cases.extend(momentum2);
    println!("| Case | pond-rs | checksum |");
    println!("| --- | --- | --- |");
    for (name, column, f) in &cases {
        if only.as_deref().is_some_and(|o| !name.starts_with(o)) {
            continue;
        }
        let (ms, out) = median_ms(f);
        let (n, sum) = checksum(&out, column);
        println!("| {name} | {ms:.1} ms | {n} {sum:.6e} |");
    }
    Ok(())
}
