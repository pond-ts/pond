//! Timing for `align`, `materialize` and `dedupe`. Same data as
//! `bench/grid_pond_ts.mjs` for the pond-ts side; both print a checksum per
//! case (rows, and the sum of the number column) so the answers can be
//! compared.
//!
//!     cargo run --release -p pond-rs --example perf_grid
//!     RAYON_NUM_THREADS=1 cargo run --release -p pond-rs --example perf_grid
//!
//! Cost, for N rows, B buckets and C columns: `align` and `materialize`
//! walk the rows once with a cursor while walking the buckets (O(N + B)),
//! then copy C columns of B rows (O(B·C)). `dedupe` walks the keys once to
//! group equal ones (O(N); interval keys hash labels within a run of equal
//! spans) and copies the kept rows (O(N·C)).

mod common;

use pond_rs::{Align, AlignMethod, Column, Keep, Materialize, Pick, Sequence, TimeSeries};

/// Rows, and the sum of `v` where present.
fn checksum(s: &TimeSeries) -> (usize, f64) {
    let v = s.column("v").unwrap().numbers().unwrap();
    (s.len(), v.iter().flatten().sum())
}

fn main() -> pond_rs::Result<()> {
    // Same generator as bench/grid_pond_ts.mjs.
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
    let make = |name: &str, time: Vec<i64>| {
        TimeSeries::new(
            name,
            time,
            vec![
                Column::optional("v", values.clone()),
                Column::required("host", text.clone()),
            ],
        )
    };
    // Dense: about one row a second, uneven.
    let dense = make(
        "dense",
        (0..n as i64).map(|i| i * 1000 + (i % 7) * 13).collect(),
    )?;
    // Every tenth row repeats the time before it.
    let repeats = make(
        "repeats",
        (0..n as i64).map(|i| (i - i / 10) * 1000).collect(),
    )?;
    // Sparse: 10k rows, one every 100 s, on a one-second grid.
    let sparse = TimeSeries::new(
        "sparse",
        (0..10_000)
            .map(|i| (i * 1000 + (i % 7) * 13) * 100)
            .collect(),
        vec![
            Column::optional("v", values[..10_000].to_vec()),
            Column::required("host", text[..10_000].to_vec()),
        ],
    )?;
    // The panel from perf_partition: 500 symbols x 1000 one-minute bars.
    let (symbols, bars) = (500usize, 1000usize);
    let mut panel_time = Vec::with_capacity(symbols * bars);
    let mut panel_sym = Vec::with_capacity(symbols * bars);
    let mut panel_v = Vec::with_capacity(symbols * bars);
    for b in 0..bars {
        for s in 0..symbols {
            panel_time.push(b as i64 * 60_000 + (s as i64 % 5) * 7_000);
            panel_sym.push(format!("s{s:03}"));
            let r = next();
            panel_v.push((r >= 0.02).then_some((r * 1000.0).floor() / 8.0));
        }
    }
    // Times within a bar differ by symbol, so sort by time keeping order.
    let mut order: Vec<usize> = (0..panel_time.len()).collect();
    order.sort_by_key(|&i| panel_time[i]);
    let panel = TimeSeries::new(
        "panel",
        order.iter().map(|&i| panel_time[i]).collect(),
        vec![
            Column::required(
                "symbol",
                order
                    .iter()
                    .map(|&i| panel_sym[i].clone())
                    .collect::<Vec<_>>(),
            ),
            Column::optional("v", order.iter().map(|&i| panel_v[i]).collect::<Vec<_>>()),
        ],
    )?;

    let minute = Sequence::every("1m")?;
    let second = Sequence::every("1s")?;
    let linear = Align {
        method: AlignMethod::Linear,
        ..Align::default()
    };
    let nearest = Materialize {
        pick: Pick::Nearest,
        ..Materialize::default()
    };
    type Case<'a> = (&'a str, Box<dyn Fn() -> TimeSeries + 'a>);
    let cases: Vec<Case> = vec![
        (
            "align hold 1m (1M rows)",
            Box::new(|| dense.align(&minute, Align::default()).unwrap()),
        ),
        (
            "align hold 1s (1M rows)",
            Box::new(|| dense.align(&second, Align::default()).unwrap()),
        ),
        (
            "align linear 1s (1M rows)",
            Box::new(|| dense.align(&second, linear).unwrap()),
        ),
        (
            "align hold 1s (10k rows, 1M buckets)",
            Box::new(|| sparse.align(&second, Align::default()).unwrap()),
        ),
        (
            "materialize last 1s (1M rows)",
            Box::new(|| dense.materialize(&second, Materialize::default()).unwrap()),
        ),
        (
            "materialize nearest 1m (1M rows)",
            Box::new(|| dense.materialize(&minute, nearest).unwrap()),
        ),
        (
            "materialize last 1s (10k rows, 1M buckets)",
            Box::new(|| sparse.materialize(&second, Materialize::default()).unwrap()),
        ),
        (
            "dedupe last (1M rows, 10% repeats)",
            Box::new(|| repeats.dedupe(Keep::Last).unwrap()),
        ),
        (
            "dedupe max v (1M rows, 10% repeats)",
            Box::new(|| repeats.dedupe(Keep::Max("v".into())).unwrap()),
        ),
        (
            "panel: align 1m per symbol + collect",
            Box::new(|| {
                panel
                    .partition_by(&["symbol"])
                    .unwrap()
                    .align(&minute, Align::default())
                    .unwrap()
                    .collect()
                    .unwrap()
            }),
        ),
        (
            "panel: materialize 1m per symbol + collect",
            Box::new(|| {
                panel
                    .partition_by(&["symbol"])
                    .unwrap()
                    .materialize(&minute, Materialize::default())
                    .unwrap()
                    .collect()
                    .unwrap()
            }),
        ),
        (
            "panel: dedupe per symbol + collect",
            Box::new(|| {
                panel
                    .partition_by(&["symbol"])
                    .unwrap()
                    .dedupe(Keep::Last)
                    .unwrap()
                    .collect()
                    .unwrap()
            }),
        ),
    ];
    for (name, f) in cases {
        let (rows, sum) = checksum(&f());
        println!(
            "| {name} | {:.1} ms | {rows} rows, sum {sum} |",
            common::time_case(name, 7, &f)
        );
    }
    Ok(())
}
