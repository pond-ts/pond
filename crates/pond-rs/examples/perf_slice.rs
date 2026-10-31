//! Compute-only timing of workload A's shape (no Arrow in or out yet):
//! 1M rows 1 s apart, 4 number columns with ~5% gaps, then
//! `aggregate(every 1m: avg/min/max/count)` and `rolling('5m', avg/stdev)`.
//!
//!     cargo run --release -p pond-rs --example perf_slice
//!
//! The full workload, Arrow included, is `crates/pond-rs/bench/`.

use std::time::Instant;

use pond_rs::{Agg, Column, Reducer, Sequence, TimeSeries};

fn main() -> pond_rs::Result<()> {
    const ROWS: usize = 1_000_000;
    let mut seed = 20261017u64;
    let mut next = || {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (seed >> 11) as f64 / (1u64 << 53) as f64
    };
    let time: Vec<i64> = (0..ROWS as i64)
        .map(|i| 1_772_514_000_000 + i * 1000)
        .collect();
    let columns = (0..4)
        .map(|c| {
            let mut walk = 100.0;
            let values = (0..ROWS).map(|_| {
                walk += next() - 0.5;
                (next() >= 0.05).then_some(walk)
            });
            Column::optional(format!("c{c}"), values.collect::<Vec<_>>())
        })
        .collect();
    let series = TimeSeries::new("data", time, columns)?;

    let names = ["c0", "c1", "c2", "c3"];
    let agg: Vec<Agg> = names
        .iter()
        .flat_map(|c| {
            [Reducer::Avg, Reducer::Min, Reducer::Max, Reducer::Count]
                .map(|r| Agg::new(format!("{c}_{r:?}"), *c, r))
        })
        .collect();
    let roll: Vec<Agg> = names
        .iter()
        .flat_map(|c| [Reducer::Avg, Reducer::Stdev].map(|r| Agg::new(format!("{c}_{r:?}"), *c, r)))
        .collect();
    let every = Sequence::every("1m")?;

    let median = |mut xs: Vec<f64>| {
        xs.sort_by(f64::total_cmp);
        xs[xs.len() / 2]
    };
    let mut agg_ms = Vec::new();
    let mut roll_ms = Vec::new();
    for _ in 0..8 {
        let t = Instant::now();
        let a = series.aggregate(&every, &agg)?;
        agg_ms.push(t.elapsed().as_secs_f64() * 1e3);
        let t = Instant::now();
        let r = series.rolling("5m", &roll)?;
        roll_ms.push(t.elapsed().as_secs_f64() * 1e3);
        assert_eq!((a.len(), r.len()), (16_667, ROWS));
    }
    println!(
        "aggregate {:.1} ms, rolling {:.1} ms, total {:.1} ms (median of 8)",
        median(agg_ms.clone()),
        median(roll_ms.clone()),
        median(agg_ms.iter().zip(&roll_ms).map(|(a, r)| a + r).collect())
    );
    if std::env::var("PROBE").is_ok() {
        for r in [
            Reducer::Count,
            Reducer::Avg,
            Reducer::Stdev,
            Reducer::Min,
            Reducer::Median,
        ] {
            let one = [Agg::new("o", "c0", r)];
            let t = Instant::now();
            series.rolling("5m", &one)?;
            println!(
                "rolling {r:?} one column: {:.1} ms",
                t.elapsed().as_secs_f64() * 1e3
            );
        }
    }
    Ok(())
}
