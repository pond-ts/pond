//! Timing for `by_value` and `ValueSeries`: the projection, nearest-row and
//! slice lookups, and JSON in and out. Same data as
//! `bench/value_series_pond_ts.mjs` for the pond-ts side; both print a
//! checksum per case so the answers can be compared.
//!
//!     cargo run --release -p pond-rs --example perf_value_series
//!
//! Cost, for N rows and C columns: `by_value` checks the axis once (O(N))
//! and shares every column's memory (no copy); `nearest_index` and
//! `slice_by_value` are binary searches (O(log N)), and a slice shares
//! memory too (O(C)). JSON in and out is O(N·C), as for `TimeSeries`.

use std::time::Instant;

use pond_rs::{Column, KeyOrder, RowFormat, TimeSeries, ValueSeries};

fn median_ms(mut f: impl FnMut() -> f64) -> (f64, f64) {
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

/// Rows, the axis sum and the watts sum.
fn checksum(v: &ValueSeries) -> f64 {
    let watts: f64 = v
        .column("watts")
        .unwrap()
        .numbers()
        .unwrap()
        .iter()
        .flatten()
        .sum();
    v.len() as f64 + v.axis().iter().sum::<f64>() + watts
}

fn main() -> pond_rs::Result<()> {
    let only: Option<String> = std::env::args().nth(1);
    let rows = 1_000_000;
    let zones = ["easy", "steady", "tempo", "hard", "max"];
    let s = TimeSeries::new(
        "bench",
        (0..rows as i64).map(|i| i * 1000).collect(),
        vec![
            Column::required(
                "dist",
                (0..rows)
                    .map(|i| (i / 3) as f64 / 100.0)
                    .collect::<Vec<_>>(),
            ),
            Column::optional(
                "watts",
                (0..rows)
                    .map(|i| (i % 17 != 5).then(|| ((i * 7919) % 10_007) as f64 / 8.0))
                    .collect::<Vec<_>>(),
            ),
            Column::required(
                "zone",
                (0..rows).map(|i| zones[(i / 50) % 5]).collect::<Vec<_>>(),
            ),
        ],
    )?;
    let v = s.by_value("dist")?;
    let small = v.slice_by_value(0.0, 1000.0); // 300k rows, for JSON
    let rows_json = small.to_json(RowFormat::Array)?;
    let columns_json = small.to_columns_json()?;
    let probes: Vec<f64> = (0..1_000_000usize)
        .map(|i| ((i * 7919) % 333_400) as f64 / 100.0)
        .collect();
    type Case<'a> = (&'a str, Box<dyn Fn() -> f64 + 'a>);
    let cases: Vec<Case> = vec![
        (
            "by_value, 1M rows",
            Box::new(|| checksum(&s.by_value("dist").unwrap())),
        ),
        (
            "nearest_index, 1M probes",
            Box::new(|| {
                probes
                    .iter()
                    .map(|&p| v.nearest_index(p).unwrap() as f64)
                    .sum()
            }),
        ),
        (
            "slice_by_value, 100k slices",
            Box::new(|| {
                probes[..100_000]
                    .iter()
                    .map(|&p| v.slice_by_value(p, p + 5.0).len() as f64)
                    .sum()
            }),
        ),
        (
            "to_json rows, 300k",
            Box::new(|| small.to_json(RowFormat::Array).unwrap().len() as f64),
        ),
        (
            "from_json rows, 300k",
            Box::new(|| checksum(&ValueSeries::from_json(&rows_json, KeyOrder::Strict).unwrap())),
        ),
        (
            "to_columns_json, 300k",
            Box::new(|| small.to_columns_json().unwrap().len() as f64),
        ),
        (
            "from_columns_json, 300k",
            Box::new(|| {
                checksum(&ValueSeries::from_columns_json(&columns_json, KeyOrder::Strict).unwrap())
            }),
        ),
    ];
    println!("| Case | pond-rs | checksum |");
    println!("| --- | --- | --- |");
    for (name, f) in &cases {
        if only.as_deref().is_some_and(|o| !name.starts_with(o)) {
            continue;
        }
        let (ms, out) = median_ms(f);
        println!("| {name} | {ms:.1} ms | {out:.6e} |");
    }
    Ok(())
}
