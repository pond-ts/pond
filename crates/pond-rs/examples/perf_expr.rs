//! Timing for column expressions ([PND-EXPR]) against the same rule as a
//! Rust closure, on 1M rows; same data and cases as pond-ts's
//! `packages/core/scripts/perf-expr.mjs` (~2% of `v` missing in short
//! runs, `w` = 1..13, a text column with 7 values).
//!
//!     cargo run --release -p pond-rs --example perf_expr
//!
//! Cost: O(N × nodes) per expression (one pass per operation; a literal
//! side is used as is, not spread to a column); `filter_expr` then copies
//! the kept rows; `find_expr` / `some_expr` look at growing stretches and
//! stop at the first answer.

use std::time::Instant;

use pond_rs::{Column, TimeSeries, col};

fn median_ms(mut f: impl FnMut()) -> f64 {
    f(); // warm-up
    let mut t: Vec<f64> = (0..9)
        .map(|_| {
            let s = Instant::now();
            f();
            s.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    t.sort_by(|a, b| a.partial_cmp(b).unwrap());
    t[4]
}

fn main() -> pond_rs::Result<()> {
    const ROWS: usize = 1_000_000;
    // Same generator as perf-expr.mjs.
    let mut seed = 20261031u32;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        seed as f64 / 4294967296.0
    };
    let (mut v, mut w, mut host) = (Vec::new(), Vec::new(), Vec::new());
    let mut gap = 0;
    for i in 0..ROWS {
        if gap == 0 && next() < 0.02 {
            gap = 1 + (next() * 4.0) as usize;
        }
        w.push((i % 13 + 1) as f64);
        host.push(format!("h{}", i % 7));
        if gap > 0 {
            gap -= 1;
            v.push(None);
        } else {
            v.push(Some((i % 1000) as f64 - 500.0 + next()));
        }
    }
    let s = TimeSeries::new(
        "data",
        (0..ROWS as i64).map(|i| i * 1000).collect(),
        vec![
            Column::optional("v", v),
            Column::required("w", w),
            Column::optional(
                "host",
                host.iter().map(|h| Some(h.as_str())).collect::<Vec<_>>(),
            ),
        ],
    )?;
    let vc = s.column("v")?.numbers()?.clone();
    let wc = s.column("w")?.numbers()?.clone();
    let hc = s.column("host")?.strings()?.clone();
    let gt = |x: Option<f64>, k: f64| x.is_some_and(|x| x > k);
    type Case<'a> = (&'a str, Box<dyn Fn() + 'a>, Box<dyn Fn() + 'a>);
    let cases: Vec<Case> = vec![
        (
            "filter v > 0",
            Box::new(|| drop(s.filter(|r| Ok(gt(vc.get(r.index()), 0.0))).unwrap())),
            Box::new(|| drop(s.filter_expr(&col("v").gt(0)).unwrap())),
        ),
        (
            "filter v / w > 10 and host = h3",
            Box::new(|| {
                drop(
                    s.filter(|r| {
                        let i = r.index();
                        let q = vc.get(i).zip(wc.get(i)).map(|(a, b)| a / b);
                        Ok(gt(q, 10.0) && hc.get(i) == Some("h3"))
                    })
                    .unwrap(),
                )
            }),
            Box::new(|| {
                drop(
                    s.filter_expr(&col("v").div(col("w")).gt(10).and(col("host").eq("h3")))
                        .unwrap(),
                )
            }),
        ),
        (
            "filter sparse (v > 499.9)",
            Box::new(|| drop(s.filter(|r| Ok(gt(vc.get(r.index()), 499.9))).unwrap())),
            Box::new(|| drop(s.filter_expr(&col("v").gt(499.9)).unwrap())),
        ),
        (
            "some (no match: scans all)",
            Box::new(|| assert!(!s.some(|r| Ok(gt(vc.get(r.index()), 1e9))).unwrap())),
            Box::new(|| assert!(!s.some_expr(&col("v").gt(1e9)).unwrap())),
        ),
        (
            "find (match near the start)",
            Box::new(|| {
                assert!(
                    s.find(|r| Ok(gt(vc.get(r.index()), 400.0)))
                        .unwrap()
                        .is_some()
                )
            }),
            Box::new(|| assert!(s.find_expr(&col("v").gt(400)).unwrap().is_some())),
        ),
        (
            "map v * 1.8 + 32",
            Box::new(|| drop(s.map_numbers("v", |x| x * 1.8 + 32.0).unwrap())),
            Box::new(|| drop(s.map_expr("v", &col("v").mul(1.8).add(32)).unwrap())),
        ),
        (
            "with column v / w",
            Box::new(|| {
                let r: Vec<f64> = vc
                    .values()
                    .iter()
                    .zip(wc.values())
                    .map(|(a, b)| a / b)
                    .collect();
                drop(s.with_column(Column::optional_raw("r", r)).unwrap())
            }),
            Box::new(|| drop(s.with_column_expr("r", &col("v").div(col("w"))).unwrap())),
        ),
    ];
    println!("| case | closure ms | expression ms |");
    println!("| --- | --- | --- |");
    for (label, f, e) in &cases {
        println!("| {label} | {:.2} | {:.2} |", median_ms(f), median_ms(e));
    }
    Ok(())
}
