//! Timing of the `keep` and `difference` reducers in `aggregate`, `rolling`
//! and `reduce`, beside `min` (a reducer with the same cost shape) for
//! scale, on 1M rows one second apart:
//!
//! - `v`: numbers with a gap every 17th row and runs of equal values (so
//!   `keep` finds some), `host`: text, one of 8 names, changing every 90
//!   rows, `d`: the same numbers as exact decimals (scale 2).
//! - Buckets of one minute (60 rows) and of one second (1 row: the
//!   per-bucket cost floor); windows of 5 minutes and of 1 day (86,400
//!   rows, to show how window size counts).
//!
//!     cargo run --release -p pond-rs --example perf_reducers
//!
//! pond-ts's equivalent is the same calls on a `TimeSeries` built from the
//! same rows (`aggregate(Sequence.every('1m'), { v: 'keep' })`, …).

use std::time::Instant;

use pond_rs::{Agg, Column, DecimalColumn, Reducer, Sequence, TimeSeries};

const ROWS: usize = 1_000_000;

fn make() -> TimeSeries {
    let time = (0..ROWS as i64).map(|i| i * 1000).collect();
    let raw = |i: usize| ((i / 40) * 7919 % 10_007) as i128 - 5000;
    let v: Vec<Option<f64>> = (0..ROWS)
        .map(|i| (i % 17 != 5).then(|| raw(i) as f64 / 100.0))
        .collect();
    let d: Vec<Option<i128>> = (0..ROWS).map(|i| (i % 17 != 5).then(|| raw(i))).collect();
    let names: Vec<String> = (0..8).map(|h| format!("host-{h}")).collect();
    let host: Vec<Option<&str>> = (0..ROWS)
        .map(|i| Some(names[(i / 90) % 8].as_str()))
        .collect();
    TimeSeries::new(
        "bench",
        time,
        vec![
            Column::optional("v", v),
            Column::optional("host", host),
            Column::optional("d", DecimalColumn::from_options(d, 2).unwrap()),
        ],
    )
    .unwrap()
}

fn median(mut xs: Vec<f64>) -> f64 {
    xs.sort_by(f64::total_cmp);
    xs[xs.len() / 2]
}

fn time<T>(mut f: impl FnMut() -> T) -> f64 {
    f();
    median(
        (0..7)
            .map(|_| {
                let t = Instant::now();
                std::hint::black_box(f());
                t.elapsed().as_secs_f64() * 1e3
            })
            .collect(),
    )
}

fn main() {
    let s = make();
    let cases = [
        ("min v", "v", Reducer::Min),
        ("keep v", "v", Reducer::Keep),
        ("difference v", "v", Reducer::Difference),
        ("keep host", "host", Reducer::Keep),
        ("keep d", "d", Reducer::Keep),
        ("difference d", "d", Reducer::Difference),
    ];
    let minute = Sequence::every("1m").unwrap();
    let second = Sequence::every("1s").unwrap();
    println!("| Reducer | agg 1m | agg 1s | rolling 5m | rolling 1d | reduce |");
    println!("| --- | --- | --- | --- | --- | --- |");
    for (name, column, reducer) in cases {
        let aggs = [Agg::new("out", column, reducer)];
        let row = [
            time(|| s.aggregate(&minute, &aggs).unwrap()),
            time(|| s.aggregate(&second, &aggs).unwrap()),
            time(|| s.rolling("5m", &aggs).unwrap()),
            time(|| s.rolling("1d", &aggs).unwrap()),
            time(|| s.reduce(&aggs).unwrap()),
        ];
        let cells: Vec<String> = row.iter().map(|ms| format!("{ms:.1} ms")).collect();
        println!("| {name} | {} |", cells.join(" | "));
    }
}
