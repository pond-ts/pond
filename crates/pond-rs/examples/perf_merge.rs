//! Timing for putting partitions back together ([PND-RSPARTMERGE]): 1M rows
//! one second apart, 100 hosts taking turns (`host = i % 100`), so every
//! partition interleaves with every other.
//!
//!     cargo run --release -p pond-rs --example perf_merge [rows] [hosts]
//!     RAYON_NUM_THREADS=1 cargo run --release -p pond-rs --example perf_merge
//!
//! Cases: `concat` of the 100 partitions (the merge alone, plus one copy of
//! each column), and a per-host 1-minute `aggregate`, whose empty buckets
//! give gaps in `host`, so the result is merged and split again (pond-ts
//! does the same). Cost of the merge, for N rows in P partitions: one pass,
//! about log2(P) key comparisons per row.
//!
//! Median of 9 after one warm-up, in ms.

use std::time::Instant;

use pond_rs::{Agg, Column, Reducer, Sequence, TimeSeries};

fn median(mut f: impl FnMut() -> usize) -> f64 {
    f();
    let mut t: Vec<f64> = (0..9)
        .map(|_| {
            let s = Instant::now();
            std::hint::black_box(f());
            s.elapsed().as_secs_f64() * 1e3
        })
        .collect();
    t.sort_by(f64::total_cmp);
    t[4]
}

fn main() -> pond_rs::Result<()> {
    let mut args = std::env::args().skip(1);
    let rows: usize = args.next().map_or(1_000_000, |s| s.parse().expect("rows"));
    let hosts: usize = args.next().map_or(100, |s| s.parse().expect("hosts"));
    let names: Vec<String> = (0..hosts).map(|h| format!("h{h}")).collect();
    let series = TimeSeries::new(
        "s",
        (0..rows as i64).map(|i| i * 1000).collect(),
        vec![
            Column::required(
                "cpu",
                (0..rows)
                    .map(|i| ((i * 7919) % 10_007) as f64 / 8.0)
                    .collect::<Vec<f64>>(),
            ),
            Column::required(
                "host",
                (0..rows)
                    .map(|i| names[i % hosts].as_str())
                    .collect::<Vec<_>>(),
            ),
        ],
    )?;
    let p = series.partition_by(&["host"])?;
    let parts: Vec<TimeSeries> = p.iter().map(|(_, s)| s.clone()).collect();
    let refs: Vec<&TimeSeries> = parts.iter().collect();
    let minute = Sequence::every("1m")?;
    let avg = [Agg::of("cpu", Reducer::Avg)];
    println!(
        "concat     {:8.2} ms",
        median(|| TimeSeries::concat(&refs).unwrap().len())
    );
    println!(
        "aggregate  {:8.2} ms",
        median(|| p.aggregate(&minute, &avg).unwrap().collect().unwrap().len())
    );
    Ok(())
}
