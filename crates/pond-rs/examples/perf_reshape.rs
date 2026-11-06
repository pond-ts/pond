//! Timing for `concat`, `collapse` and `pivot_by_group`. Same data as
//! `bench/reshape_pond_ts.mjs` for the pond-ts side; both print a checksum
//! per case (present values across the number columns, and their sum) so
//! the answers can be compared.
//!
//!     cargo run --release -p pond-rs --example perf_reshape
//!
//! Cost, for N rows: `concat` of N rows sorts their keys (a radix sort, a
//! few passes over N) and copies each column once (O(N)). `collapse` calls
//! the closure once a row (O(N)). `pivot_by_group` names each distinct
//! group once (a hash lookup a row), places rows with a counting sort over
//! the T × G cells for T times and G groups (O(N + T·G)), and reduces only
//! the cells with two or more rows.

mod common;

use std::time::Instant;

use pond_rs::{Column, ColumnData, Pivot, Reducer, Scalar, TimeSeries};

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

/// Present values across every number column, and their sum.
fn checksum(s: &TimeSeries) -> (usize, f64) {
    let (mut n, mut sum) = (0, 0.0);
    for c in s.columns() {
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

/// `rows` rows, `hosts` hosts reporting at each time (`copies` rows per
/// host and time), hosts listed in a scrambled order.
fn long(rows: usize, hosts: usize, copies: usize) -> TimeSeries {
    let per_time = hosts * copies;
    let time = (0..rows).map(|i| (i / per_time) as i64 * 1000).collect();
    let host: Vec<String> = (0..rows)
        .map(|i| format!("h{}", ((i % per_time) / copies * 37) % hosts))
        .collect();
    TimeSeries::new(
        "bench",
        time,
        vec![
            Column::required("host", host),
            Column::optional("v", (0..rows).map(value).collect::<Vec<_>>()),
            Column::optional("w", (0..rows).map(|i| value(i + 3)).collect::<Vec<_>>()),
        ],
    )
    .unwrap()
}

/// `parts` series of `rows` rows each, times interleaved across them.
fn parts(parts: usize, rows: usize) -> Vec<TimeSeries> {
    (0..parts)
        .map(|p| {
            let time = (0..rows).map(|i| (i * parts + p) as i64 * 1000).collect();
            TimeSeries::new(
                "bench",
                time,
                vec![Column::optional(
                    "v",
                    (0..rows).map(|i| value(i * parts + p)).collect::<Vec<_>>(),
                )],
            )
            .unwrap()
        })
        .collect()
}

fn main() -> pond_rs::Result<()> {
    let only: Option<String> = std::env::args().nth(1);
    let wide = long(1_000_000, 100, 1);
    let twice = long(1_000_000, 100, 2);
    let few = long(1_000_000, 4, 1);
    let ten = parts(10, 100_000);
    let ten_refs: Vec<&TimeSeries> = ten.iter().collect();
    let many = parts(1000, 1000);
    let many_refs: Vec<&TimeSeries> = many.iter().collect();
    let sum = |r: &pond_rs::Row<'_>| {
        Ok(match (r.number("v")?, r.number("w")?) {
            (Some(a), Some(b)) => Some(Scalar::Number(a + b)),
            _ => None,
        })
    };
    type Case<'a> = (&'a str, Box<dyn Fn() -> TimeSeries + 'a>);
    let cases: Vec<Case> = vec![
        (
            "concat 10 x 100k",
            Box::new(|| TimeSeries::concat(&ten_refs).unwrap()),
        ),
        (
            "concat 1000 x 1k",
            Box::new(|| TimeSeries::concat(&many_refs).unwrap()),
        ),
        (
            "collapse sum",
            Box::new(|| wide.collapse(&["v", "w"], "out", sum).unwrap()),
        ),
        (
            "collapse_keep sum",
            Box::new(|| wide.collapse_keep(&["v", "w"], "out", sum).unwrap()),
        ),
        (
            "pivot 100 hosts",
            Box::new(|| wide.pivot_by_group("host", "v", &Pivot::default()).unwrap()),
        ),
        (
            "pivot 4 hosts",
            Box::new(|| few.pivot_by_group("host", "v", &Pivot::default()).unwrap()),
        ),
        (
            "pivot 100 hosts x2 avg",
            Box::new(|| {
                twice
                    .pivot_by_group("host", "v", &Pivot::default().aggregate(Reducer::Avg))
                    .unwrap()
            }),
        ),
        (
            "pivot 100 hosts x2 last",
            Box::new(|| {
                twice
                    .pivot_by_group("host", "v", &Pivot::default().aggregate(Reducer::Last))
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
        common::write_dump(name, &out);
        let (n, sum) = checksum(&out);
        println!("| {name} | {ms:.1} ms | {n} {sum:.6e} |");
    }
    Ok(())
}
