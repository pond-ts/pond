//! Timing for decimal columns against a number column of the same values:
//! 1M rows 1 s apart, ~5% gaps, prices with 2 decimal places, then
//! `aggregate(every 1m)` and `rolling('5m')` with exact reducers (`sum`,
//! `min`, `max`, `first`/`last`) and one float reducer (`avg`).
//!
//!     cargo run --release -p pond-rs --example perf_decimal
//!
//! Cost: `sum` is one O(N) pass with 256-bit running sums. `min` / `max`
//! sort the distinct values once (O(N log N)) and run the number kernels
//! on each row's rank; `first` / `last` run on row indexes then gather.
//! `avg` converts each value to `f64` once (O(N)) and runs the number
//! kernel.

use std::time::Instant;

use pond_rs::{Agg, Column, DecimalColumn, Reducer, Sequence, TimeSeries};

fn median_ms(mut f: impl FnMut()) -> f64 {
    f(); // warm-up
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
    const ROWS: usize = 1_000_000;
    let mut seed = 20261018u64;
    let mut next = || {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (seed >> 11) as f64 / (1u64 << 53) as f64
    };
    let time: Vec<i64> = (0..ROWS as i64)
        .map(|i| 1_772_514_000_000 + i * 1000)
        .collect();
    // Prices in cents around 100.00, as a random walk.
    let mut cents = 10_000i128;
    let mut raw = Vec::with_capacity(ROWS);
    for _ in 0..ROWS {
        cents += (next() * 21.0) as i128 - 10;
        raw.push((next() >= 0.05).then_some(cents));
    }
    let num: Vec<Option<f64>> = raw.iter().map(|v| v.map(|c| c as f64 / 100.0)).collect();
    let series = TimeSeries::new(
        "data",
        time,
        vec![
            Column::optional("num", num),
            Column::optional("dec", DecimalColumn::from_options(raw, 2)?),
        ],
    )?;

    let minute = Sequence::every("1m")?;
    println!(
        "| reducers | number agg 1m | decimal agg 1m | number rolling 5m | decimal rolling 5m |"
    );
    println!("| --- | --- | --- | --- | --- |");
    for (label, reducers) in [
        ("sum", vec![Reducer::Sum]),
        ("min + max", vec![Reducer::Min, Reducer::Max]),
        ("first + last", vec![Reducer::First, Reducer::Last]),
        ("avg", vec![Reducer::Avg]),
    ] {
        let mut row = format!("| {label} |");
        let mut cells = Vec::new();
        for (kind, name) in [
            ("agg", "num"),
            ("agg", "dec"),
            ("roll", "num"),
            ("roll", "dec"),
        ] {
            let aggs: Vec<Agg> = reducers
                .iter()
                .enumerate()
                .map(|(i, &r)| Agg::new(format!("o{i}"), name, r))
                .collect();
            let one = series.select(&[name])?;
            cells.push(median_ms(|| {
                if kind == "agg" {
                    one.aggregate(&minute, &aggs).unwrap();
                } else {
                    one.rolling("5m", &aggs).unwrap();
                }
            }));
        }
        for c in cells {
            row += &format!(" {c:.1} ms |");
        }
        println!("{row}");
    }
    Ok(())
}
