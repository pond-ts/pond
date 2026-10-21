//! Timing for the R2 step 1 financial studies (`sma`, `ema`,
//! `moving_average` of every type, `rolling_stdev` / `min` / `max` /
//! `percentile`, `z_score`). Same data as `bench/studies_pond_ts.mjs` for
//! the `@pond-ts/financial` side; both print a checksum per case (present
//! values in the output and their sum) so the answers can be compared.
//!
//!     cargo run --release -p pond-rs --example perf_studies [name prefix]
//!
//! Cost, for N rows and period P: the mean / spread, weighted, Wilder,
//! exponential and z-score kernels read each row a constant number of
//! times, plus a rebuild of P rows every P rows (O(N)). Min / max keep a
//! queue of candidates (O(N)); the percentile goes through `rolling_rows`,
//! which keeps the window sorted (O(N·P) worst case).

use std::time::Instant;

use pond_rs::financial::{MaType, Study};
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

fn main() -> pond_rs::Result<()> {
    let only: Option<String> = std::env::args().nth(1);
    let dense = make(1_000_000, false);
    let gappy = make(1_000_000, true);
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
