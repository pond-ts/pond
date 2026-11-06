//! Timing of the `keep`, `difference`, `unique`, `top<N>` and `samples`
//! reducers in `aggregate`, `rolling` and `reduce`, beside `min` for scale,
//! on 1M rows one second apart:
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

mod common;

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

fn main() {
    let s = make();
    let cases = [
        ("min v", "v", Reducer::Min),
        ("keep v", "v", Reducer::Keep),
        ("difference v", "v", Reducer::Difference),
        ("keep host", "host", Reducer::Keep),
        ("keep d", "d", Reducer::Keep),
        ("difference d", "d", Reducer::Difference),
        ("unique v", "v", Reducer::Unique),
        ("unique host", "host", Reducer::Unique),
        ("top3 v", "v", Reducer::Top(3)),
        ("top3 host", "host", Reducer::Top(3)),
        ("samples v", "v", Reducer::Samples),
    ];
    let only: Option<String> = std::env::args().nth(1);
    let minute = Sequence::every("1m").unwrap();
    let second = Sequence::every("1s").unwrap();
    println!("| Reducer | agg 1m | agg 1s | rolling 5m | rolling 1d | reduce |");
    println!("| --- | --- | --- | --- | --- | --- |");
    for (name, column, reducer) in cases {
        if only.as_deref().is_some_and(|o| !name.starts_with(o)) {
            continue;
        }
        let aggs = [Agg::new("out", column, reducer)];
        // A list reducer's output grows with the window (`samples` over a
        // day is 86,400 values a row), so the 1-day window is left out.
        let lists = matches!(
            reducer,
            Reducer::Unique | Reducer::Top(_) | Reducer::Samples
        );
        let time = |col: &str, f: &dyn Fn() -> Box<dyn common::Dump>| {
            common::time_case(&format!("{name}, {col}"), 7, f)
        };
        let row = [
            Some(time("agg 1m", &|| {
                Box::new(s.aggregate(&minute, &aggs).unwrap())
            })),
            Some(time("agg 1s", &|| {
                Box::new(s.aggregate(&second, &aggs).unwrap())
            })),
            Some(time("rolling 5m", &|| {
                let out = s.rolling("5m", &aggs).unwrap();
                // samples over 5 minutes: ~280 values a row, too big to write out
                if matches!(reducer, Reducer::Samples) {
                    Box::new(common::ListDigest(out))
                } else {
                    Box::new(out)
                }
            })),
            (!lists).then(|| time("rolling 1d", &|| Box::new(s.rolling("1d", &aggs).unwrap()))),
            Some(time("reduce", &|| Box::new(s.reduce(&aggs).unwrap()))),
        ];
        let cells: Vec<String> = row
            .iter()
            .map(|ms| ms.map_or("-".into(), |ms| format!("{ms:.1} ms")))
            .collect();
        println!("| {name} | {} |", cells.join(" | "));
    }
}
