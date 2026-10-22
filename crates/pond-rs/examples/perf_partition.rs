//! Timing for `partition_by` on the agent panel shape ([PND-AGENTBENCH]
//! Q11): 500 symbols × 1000 one-minute bars in one series, rows ordered by
//! time with the symbols interleaved, ~2% gaps. Same data as
//! `bench/partition_pond_ts.mjs` for the pond-ts side.
//!
//!     cargo run --release -p pond-rs --example perf_partition
//!     RAYON_NUM_THREADS=1 cargo run --release -p pond-rs --example perf_partition
//!
//! Cost, for N rows in P partitions of N/P rows: the split is one pass to
//! number each row's key and one copy of the rows (O(N)); each operation is
//! its own cost per partition, run on several cores; collecting is a sort
//! of P already-sorted runs (O(N log P)) and one copy.

use std::time::Instant;

use pond_rs::{Agg, Column, Fill, Reducer, TimeSeries};

fn median_ms(mut f: impl FnMut()) -> f64 {
    f();
    let mut t: Vec<f64> = (0..7)
        .map(|_| {
            let s = Instant::now();
            f();
            s.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    t.sort_by(|a, b| a.partial_cmp(b).unwrap());
    t[3]
}

fn main() -> pond_rs::Result<()> {
    let (symbols, bars) = (500usize, 1000usize);
    // Same generator as bench/partition_pond_ts.mjs.
    let mut seed = 20261019u32;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        seed as f64 / 4294967296.0
    };
    let mut time = Vec::with_capacity(symbols * bars);
    let mut sym = Vec::with_capacity(symbols * bars);
    let mut close = Vec::with_capacity(symbols * bars);
    let mut walk = vec![100.0f64; symbols];
    for b in 0..bars {
        for (s, w) in walk.iter_mut().enumerate() {
            *w += next() - 0.5;
            time.push(b as i64 * 60_000);
            sym.push(format!("s{s:03}"));
            close.push((next() >= 0.02).then_some(*w));
        }
    }
    let series = TimeSeries::new(
        "panel",
        time,
        vec![
            Column::required("symbol", sym),
            Column::optional("close", close),
        ],
    )?;
    let sum: f64 = series.column("close")?.numbers()?.iter().flatten().sum();
    println!(
        "{} rows, {} gaps, sum {sum}",
        series.len(),
        series.column("close")?.data().missing_count()
    );
    let stats = [
        Agg::new("mean", "close", Reducer::Avg),
        Agg::new("sd", "close", Reducer::Stdev),
        Agg::of("close", Reducer::Last),
    ];
    type Case<'a> = (&'a str, Box<dyn Fn() + 'a>);
    let cases: Vec<Case> = vec![
        (
            "split",
            Box::new(|| drop(series.partition_by(&["symbol"]).unwrap())),
        ),
        (
            "diff + collect",
            Box::new(|| {
                drop(
                    series
                        .partition_by(&["symbol"])
                        .unwrap()
                        .diff(&["close"])
                        .unwrap()
                        .collect()
                        .unwrap(),
                )
            }),
        ),
        (
            "fill linear + collect",
            Box::new(|| {
                drop(
                    series
                        .partition_by(&["symbol"])
                        .unwrap()
                        .fill_all(Fill::Linear)
                        .unwrap()
                        .collect()
                        .unwrap(),
                )
            }),
        ),
        (
            "rolling 60m mean/sd + collect",
            Box::new(|| {
                drop(
                    series
                        .partition_by(&["symbol"])
                        .unwrap()
                        .rolling("60m", &stats)
                        .unwrap()
                        .collect()
                        .unwrap(),
                )
            }),
        ),
        (
            "Q11: rolling 60m, last z per symbol, top 20",
            Box::new(|| {
                let p = series.partition_by(&["symbol"]).unwrap();
                let rolled = p.rolling("60m", &stats).unwrap();
                let mut z: Vec<(String, f64)> = rolled
                    .iter()
                    .filter_map(|(key, s)| {
                        let last = s.len() - 1;
                        let get = |c: &str| s.column(c).unwrap().numbers().unwrap().get(last);
                        let (x, m, sd) = (get("close")?, get("mean")?, get("sd")?);
                        let name = match &key[0] {
                            Some(pond_rs::Value::String(n)) => n.clone(),
                            _ => return None,
                        };
                        (sd > 0.0).then(|| (name, (x - m) / sd))
                    })
                    .collect();
                z.sort_by(|a, b| b.1.abs().total_cmp(&a.1.abs()));
                z.truncate(20);
                assert_eq!(z.len(), 20);
            }),
        ),
    ];
    for (name, f) in cases {
        println!("| {name} | {:.1} ms |", median_ms(&f));
    }
    Ok(())
}
