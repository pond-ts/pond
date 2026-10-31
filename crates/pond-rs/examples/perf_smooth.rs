//! Timing for `smooth` (EMA, moving average, loess), `baseline`,
//! `outliers`, `scan` and `sample`. Same data as `bench/smooth_pond_ts.mjs`
//! for the pond-ts side; both print a checksum per case (present values in
//! the checked column and their sum) so the answers can be compared.
//! (`sample` by reservoir is random in pond-ts, so only its timing compares.)
//!
//!     cargo run --release -p pond-rs --example perf_smooth
//!
//! Cost, for N rows: EMA, `scan` and `sample` read each row once (O(N)).
//! The moving average, `baseline` and `outliers` slide a window that only
//! moves forward, as `rolling` does (O(N)); range keys whose middles run
//! backwards are sorted first (O(N log N)). Loess fits each row from its
//! k = span·N nearest values, so it costs O(N·k), which is O(N²) for a
//! fixed span, in both libraries; pond-rs spreads the rows over the cores.

mod common;

use std::time::Instant;

use pond_rs::{Alignment, Column, Rolling, Sample, Smooth, TimeRangeKeys, TimeSeries};

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

fn values(rows: usize) -> Vec<Option<f64>> {
    (0..rows)
        .map(|i| (i % 17 != 5).then(|| ((i * 7919) % 10_007) as f64 / 8.0))
        .collect()
}

fn make(rows: usize) -> TimeSeries {
    let time = (0..rows as i64).map(|i| i * 1000).collect();
    TimeSeries::new("bench", time, vec![Column::optional("v", values(rows))]).unwrap()
}

/// Time ranges 0 to 4 s long on a 1 s grid, so their middles run backwards
/// often.
fn ranges(rows: usize) -> TimeSeries {
    let begin: Vec<i64> = (0..rows as i64).map(|i| i * 1000).collect();
    let end = begin
        .iter()
        .enumerate()
        .map(|(i, b)| b + ((i * 37) % 5) as i64 * 1000)
        .collect();
    let keys = TimeRangeKeys { begin, end };
    TimeSeries::from_time_ranges("bench", keys, vec![Column::optional("v", values(rows))]).unwrap()
}

fn main() -> pond_rs::Result<()> {
    let only: Option<String> = std::env::args().nth(1);
    let big = make(1_000_000);
    let spans = ranges(1_000_000);
    let small = make(20_000);
    let tiny = make(5_000);
    let names = ["avg", "sd", "out", "lower"];
    type Case<'a> = (&'a str, &'a str, Box<dyn Fn() -> TimeSeries + 'a>);
    let cases: Vec<Case> = vec![
        (
            "ema alpha 0.1",
            "out",
            Box::new(|| big.smooth("v", &Smooth::ema(0.1).output("out")).unwrap()),
        ),
        (
            "ema span 20 min 20",
            "out",
            Box::new(|| {
                big.smooth("v", &Smooth::ema_span(20.0).min_samples(20).output("out"))
                    .unwrap()
            }),
        ),
        (
            "moving average 5m",
            "out",
            Box::new(|| {
                big.smooth("v", &Smooth::moving_average("5m").output("out"))
                    .unwrap()
            }),
        ),
        (
            "moving average 5m centered skip",
            "out",
            Box::new(|| {
                let m = Smooth::moving_average("5m")
                    .alignment(Alignment::Centered)
                    .skip_missing()
                    .output("out");
                big.smooth("v", &m).unwrap()
            }),
        ),
        (
            "moving average 5m, ranges",
            "out",
            Box::new(|| {
                spans
                    .smooth("v", &Smooth::moving_average("5m").output("out"))
                    .unwrap()
            }),
        ),
        (
            "loess 0.05, 20k rows",
            "out",
            Box::new(|| {
                small
                    .smooth("v", &Smooth::loess(0.05).output("out"))
                    .unwrap()
            }),
        ),
        (
            "loess 0.3, 5k rows",
            "out",
            Box::new(|| tiny.smooth("v", &Smooth::loess(0.3).output("out")).unwrap()),
        ),
        (
            "baseline 5m",
            "out",
            Box::new(|| {
                big.baseline_named("v", "5m", 2.0, Rolling::default(), names)
                    .unwrap()
            }),
        ),
        (
            "outliers 5m",
            "v",
            Box::new(|| big.outliers("v", "5m", 1.5, Rolling::default()).unwrap()),
        ),
        (
            "scan sum",
            "out",
            Box::new(|| {
                big.scan_to("v", "out", 0.0, |a, v, _| (a + v, a + v))
                    .unwrap()
            }),
        ),
        (
            "scan gain",
            "out",
            Box::new(|| {
                big.scan_to("v", "out", (None::<f64>, 0.0), |(r, g), v, _| match r {
                    None => ((Some(v), 0.0), 0.0),
                    Some(r) if v - r >= 300.0 => ((Some(v), g + v - r), g + v - r),
                    Some(r) if v - r <= -300.0 => ((Some(v), g), g),
                    Some(r) => ((Some(r), g), g),
                })
                .unwrap()
            }),
        ),
        (
            "sample stride 10",
            "v",
            Box::new(|| big.sample(Sample::Stride(10)).unwrap()),
        ),
        (
            "sample reservoir 1000",
            "v",
            Box::new(|| {
                big.sample(Sample::Reservoir {
                    size: 1000,
                    seed: 1,
                })
                .unwrap()
            }),
        ),
    ];
    println!("| Case | pond-rs | checksum |");
    println!("| --- | --- | --- |");
    for (name, column, f) in &cases {
        if only.as_deref().is_some_and(|o| !name.starts_with(o)) {
            continue;
        }
        let (ms, out) = median_ms(f);
        common::write_dump(name, &out);
        let (n, sum) = checksum(&out, column);
        println!("| {name} | {ms:.1} ms | {n} {sum:.6e} |");
    }
    Ok(())
}
