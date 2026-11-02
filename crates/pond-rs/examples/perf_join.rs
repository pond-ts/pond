//! Timing for `join` and `join_many`. Same data as `bench/join_pond_ts.mjs`
//! for the pond-ts side; both print a checksum per case (rows, and the sum
//! of every number column) so the answers can be compared.
//!
//!     cargo run --release -p pond-rs --example perf_join
//!
//! Cost, for N and M rows, R output rows and C columns: one walk over both
//! keys (O(N + M)), then each column either passes through (no copy) or is
//! gathered once (O(R) per column). Text labels on equal interval spans
//! also pay a Unicode collation compare.

mod common;

use std::time::Instant;

use pond_rs::{Column, Join, JoinType, TimeSeries};

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

/// Rows, and the sum of every number column where present.
fn checksum(s: &TimeSeries) -> (usize, f64) {
    let sum = s
        .columns()
        .iter()
        .filter_map(|c| c.numbers().ok())
        .map(|v| v.iter().flatten().sum::<f64>())
        .sum();
    (s.len(), sum)
}

type Case<'a> = Box<dyn Fn() -> TimeSeries + 'a>;

fn how(how: JoinType) -> Join {
    Join {
        how,
        ..Join::default()
    }
}

fn main() -> pond_rs::Result<()> {
    // Same generator as bench/join_pond_ts.mjs.
    let mut seed = 20261019u32;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        seed as f64 / 4294967296.0
    };
    let n = 1_000_000usize;
    let hosts = ["a", "b", "c", "d", "e", "f", "g", "h"];
    let mut values = Vec::with_capacity(n);
    let mut text = Vec::with_capacity(n);
    for i in 0..n {
        let r = next();
        values.push((r >= 0.02).then_some((r * 1000.0).floor() / 8.0));
        text.push(hosts[i % 8]);
    }
    let make = |name: &str, time: Vec<i64>, col: &str, txt: &str, shift: usize| {
        let k = time.len();
        let v: Vec<Option<f64>> = (0..k).map(|i| values[(i + shift) % n]).collect();
        let t: Vec<&str> = (0..k).map(|i| text[(i + shift) % n]).collect();
        TimeSeries::new(
            name,
            time,
            vec![Column::optional(col, v), Column::required(txt, t)],
        )
    };
    // a: one row a second. b: one every 1.5 s, so every third a-time
    // matches. c, d: a's times exactly. sparse: 10k rows 100 s apart.
    let a = make(
        "a",
        (0..n as i64).map(|i| i * 1000).collect(),
        "v",
        "host",
        0,
    )?;
    let b = make(
        "b",
        (0..n as i64).map(|i| i * 1500).collect(),
        "w",
        "tag",
        1,
    )?;
    let c = make(
        "c",
        (0..n as i64).map(|i| i * 1000).collect(),
        "x",
        "c_host",
        2,
    )?;
    let d = make(
        "d",
        (0..n as i64).map(|i| i * 1000).collect(),
        "y",
        "d_host",
        3,
    )?;
    let sparse = make(
        "s",
        (0..10_000).map(|i| i * 100_000).collect(),
        "w",
        "tag",
        4,
    )?;

    let cases: Vec<(&str, Case)> = vec![
        (
            "left join, 1M x 1M, 1/3 match",
            Box::new(|| a.join(&b, how(JoinType::Left)).unwrap()),
        ),
        (
            "inner join, 1M x 1M",
            Box::new(|| a.join(&b, how(JoinType::Inner)).unwrap()),
        ),
        (
            "outer join, 1M x 1M",
            Box::new(|| a.join(&b, how(JoinType::Outer)).unwrap()),
        ),
        (
            "left join, 1M x 10k sparse",
            Box::new(|| a.join(&sparse, how(JoinType::Left)).unwrap()),
        ),
        (
            "outer join, same keys",
            Box::new(|| a.join(&c, Join::default()).unwrap()),
        ),
        (
            "joinMany 3 on same keys",
            Box::new(|| TimeSeries::join_many(&[&a, &c, &d], Join::default()).unwrap()),
        ),
    ];
    let only = std::env::args().nth(1);
    for (name, f) in &cases {
        if only.as_deref().is_some_and(|o| !name.contains(o)) {
            continue;
        }
        let out = f();
        common::write_dump(name, &out);
        let (rows, sum) = checksum(&out);
        drop(out);
        let ms = median_ms(|| {
            std::hint::black_box(f());
        });
        println!("| {name} | {ms:.1} ms | {rows} rows, sum {sum} |");
    }
    Ok(())
}
