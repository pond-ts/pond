//! Timing for the row-by-row operations on 1M rows 1 s apart, ~5% gaps
//! (runs of 1–4), one number column; same data as
//! `bench/rowwise_pond_ts.mjs` for the pond-ts side.
//!
//!     cargo run --release -p pond-rs --example perf_rowwise
//!
//! Cost: each op is one O(N) pass over the column (fill: one pass to find
//! runs, one to fill them), plus an O(N) copy of the key for `FirstRow::Drop`
//! and `slice`. `filter` is one pass to choose rows plus a copy of the kept
//! rows; `with_column` is one pass to check the new column.

mod common;

use pond_rs::{Change, Column, Fill, FillLimits, FirstRow, Reducer, TimeSeries};

fn main() -> pond_rs::Result<()> {
    const ROWS: usize = 1_000_000;
    // Same generator as bench/rowwise_pond_ts.mjs.
    let mut seed = 20261019u32;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        seed as f64 / 4294967296.0
    };
    let time: Vec<i64> = (0..ROWS as i64).map(|i| i * 1000).collect();
    let mut v = Vec::with_capacity(ROWS);
    let mut gap = 0;
    for i in 0..ROWS {
        if gap == 0 && next() < 0.02 {
            gap = 1 + (next() * 4.0) as usize;
        }
        if gap > 0 {
            gap -= 1;
            v.push(None);
        } else {
            v.push(Some((i % 1000) as f64 + next()));
        }
    }
    let s = TimeSeries::new("data", time, vec![Column::optional("v", v)])?;
    let gaps = s.column("v")?.data().missing_count();
    let sum: f64 = s.column("v")?.numbers()?.iter().flatten().sum();
    println!("{ROWS} rows, {gaps} gaps, sum {sum}");
    let none = FillLimits::none();
    let v_col = s.column("v")?.numbers()?.clone();
    let extra = Column::optional_raw("w", s.column("v")?.numbers()?.values().to_vec());
    type Case<'a> = (&'a str, Box<dyn Fn() -> TimeSeries + 'a>);
    let cases: Vec<Case> = vec![
        ("diff", Box::new(|| s.diff(&["v"]).unwrap())),
        (
            "diff drop",
            Box::new(|| {
                s.diff_with(&["v"], Change::default().first(FirstRow::Drop))
                    .unwrap()
            }),
        ),
        ("rate", Box::new(|| s.rate(&["v"]).unwrap())),
        ("pct_change", Box::new(|| s.pct_change(&["v"]).unwrap())),
        (
            "cumulative sum",
            Box::new(|| s.cumulative(&[("v", Reducer::Sum)]).unwrap()),
        ),
        ("shift 1", Box::new(|| s.shift(&["v"], 1).unwrap())),
        (
            "fill hold",
            Box::new(|| s.fill_all_with(Fill::Hold, &none).unwrap()),
        ),
        (
            "fill linear",
            Box::new(|| s.fill_all_with(Fill::Linear, &none).unwrap()),
        ),
        (
            "fill linear maxGap 3s",
            Box::new(|| {
                s.fill_all_with(Fill::Linear, &FillLimits::none().max_gap("3s"))
                    .unwrap()
            }),
        ),
        (
            "filter v > 500 (by name)",
            Box::new(|| {
                s.filter(|r| Ok(r.number("v")?.is_some_and(|x| x > 500.0)))
                    .unwrap()
            }),
        ),
        (
            "filter v > 500 (column fetched once)",
            Box::new(|| {
                s.filter(|r| Ok(v_col.get(r.index()).is_some_and(|x| x > 500.0)))
                    .unwrap()
            }),
        ),
        (
            "map_numbers v * 2",
            Box::new(|| s.map_numbers("v", |x| x * 2.0).unwrap()),
        ),
        (
            "with_column",
            Box::new(|| s.with_column(extra.clone()).unwrap()),
        ),
        ("slice middle half", Box::new(|| s.slice(250_000..750_000))),
    ];
    for (name, f) in cases {
        println!("| {name} | {:.1} ms |", common::time_case(name, 7, &f));
    }
    Ok(())
}
