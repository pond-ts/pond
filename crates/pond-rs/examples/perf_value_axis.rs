//! Timing for `by_column` and `rolling_by_column`. Same data as
//! `bench/value_axis_pond_ts.mjs` for the pond-ts side; both print a
//! checksum per case (present values across the number columns, and their
//! sum) so the answers can be compared.
//!
//!     cargo run --release -p pond-rs --example perf_value_axis
//!
//! Cost, for N rows, B bins, W rows per window and C centers: `by_column`
//! works out each row's bin (O(N), or O(N log B) for edges), sorts the rows
//! by bin with a counting sort (O(N + B)) and reduces each bin as
//! `aggregate` does. `rolling_by_column` walks two pointers along the axis
//! (O(N + C)) and keeps rolling window states, so most reducers cost O(1)
//! a row; median and percentiles keep a sorted window, O(W) a row.

use std::time::Instant;

use pond_rs::{Agg, Bins, Column, ColumnData, Reducer, Table, TimeSeries};

fn median_ms(mut f: impl FnMut() -> Table) -> (f64, Table) {
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

/// Present values across every number column, and their sum.
fn checksum(t: &Table) -> (usize, f64) {
    let (mut n, mut sum) = (0, 0.0);
    for c in t.columns() {
        if let ColumnData::Number(v) = c.data() {
            for x in v.iter().flatten() {
                n += 1;
                sum += x;
            }
        }
    }
    (n, sum)
}

fn value(i: usize) -> Option<f64> {
    (i % 17 != 5).then(|| ((i * 7919) % 10_007) as f64 / 8.0)
}

fn main() -> pond_rs::Result<()> {
    let only: Option<String> = std::env::args().nth(1);
    let rows = 1_000_000;
    // A distance that never goes down (0.01 a row, a gap every 23 rows)
    // and a power that goes up and down.
    let dist: Vec<Option<f64>> = (0..rows)
        .map(|i| (i % 23 != 7).then_some(i as f64 / 100.0))
        .collect();
    let watts: Vec<Option<f64>> = (0..rows).map(value).collect();
    let s = TimeSeries::new(
        "bench",
        (0..rows as i64).map(|i| i * 1000).collect(),
        vec![
            Column::optional("dist", dist),
            Column::optional("watts", watts),
        ],
    )?;
    let avg = [Agg::new("avg", "watts", Reducer::Avg)];
    let counts = [
        Agg::new("n", "watts", Reducer::Count),
        Agg::new("sum", "watts", Reducer::Sum),
        Agg::new("avg", "watts", Reducer::Avg),
    ];
    let spread = [
        Agg::new("p5", "watts", Reducer::Percentile(5.0)),
        Agg::new("p95", "watts", Reducer::Percentile(95.0)),
    ];
    let zones = Bins::edges_upper_inclusive([0.0, 200.0, 400.0, 600.0, 800.0, 1000.0, 1300.0]);
    let centers: Vec<f64> = (0..1000).map(|i| i as f64 * 10.0).collect();
    type Case<'a> = (&'a str, Box<dyn Fn() -> Table + 'a>);
    let cases: Vec<Case> = vec![
        (
            "by_column width 10, 1000 bins",
            Box::new(|| s.by_column("dist", &Bins::width(10.0), &counts).unwrap()),
        ),
        (
            "by_column 6 zones",
            Box::new(|| s.by_column("watts", &zones, &counts).unwrap()),
        ),
        (
            "by_column histogram, 1251 bins",
            Box::new(|| {
                s.by_column("watts", &Bins::width(1.0), &counts[..1])
                    .unwrap()
            }),
        ),
        (
            "by_column width 10, p5 p95",
            Box::new(|| s.by_column("dist", &Bins::width(10.0), &spread).unwrap()),
        ),
        (
            "rolling_by_column radius 0.5, avg",
            Box::new(|| s.rolling_by_column("dist", 0.5, &avg).unwrap()),
        ),
        (
            "rolling_by_column radius 0.5, p5 p95",
            Box::new(|| s.rolling_by_column("dist", 0.5, &spread).unwrap()),
        ),
        (
            "rolling_by_column radius 5, p5 p95",
            Box::new(|| s.rolling_by_column("dist", 5.0, &spread).unwrap()),
        ),
        (
            "rolling_by_column at 1000 centers, radius 5",
            Box::new(|| {
                s.rolling_by_column_at("dist", 5.0, &centers, &counts)
                    .unwrap()
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
        let (n, sum) = checksum(&out);
        println!("| {name} | {ms:.1} ms | {n} {sum:.6e} |");
    }
    Ok(())
}
