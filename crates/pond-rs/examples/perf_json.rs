//! Timing of the JSON doors, on the workloads of pond-ts's
//! `scripts/perf-to-json.mjs` and `perf-to-columns.mjs`, end to end (text
//! in, text out): `to_json` (both row formats) and `from_json` of that text,
//! `to_columns_json` / `from_columns_json`, and `to_points_json` /
//! `from_points_json` (time keys only).
//!
//!     cargo run --release -p pond-rs --example perf_json
//!
//! pond-ts's equivalent is `JSON.stringify(series.toJSON())` and
//! `TimeSeries.fromJSON(JSON.parse(text))`, and likewise for `toColumns` /
//! `fromColumns` and `toPoints` / `fromPoints`.

use std::time::Instant;

use pond_rs::{Agg, Column, JsonOptions, KeyOrder, Reducer, RowFormat, Sequence, TimeSeries};

const SYMBOLS: [&str; 4] = ["AAPL", "MSFT", "NVDA", "AMZN"];
const NUMERIC: [&str; 5] = ["open", "high", "low", "close", "volume"];

fn make(rows: usize, strings: bool, sparse: bool) -> TimeSeries {
    let time = (0..rows as i64).map(|i| i * 1000).collect();
    let mut columns: Vec<Column> = NUMERIC
        .iter()
        .map(|name| {
            let values: Vec<Option<f64>> = (0..rows)
                .map(|i| (!(sparse && i % 10 == 0)).then_some((i % 100) as f64 / 7.0))
                .collect();
            if sparse {
                Column::optional(*name, values)
            } else {
                Column::required(*name, values.into_iter().flatten().collect::<Vec<_>>())
            }
        })
        .collect();
    if strings {
        let s: Vec<&str> = (0..rows).map(|i| SYMBOLS[i % 4]).collect();
        columns.push(Column::required("symbol", s));
    }
    TimeSeries::new("bench", time, columns).unwrap()
}

fn median(mut xs: Vec<f64>) -> f64 {
    xs.sort_by(f64::total_cmp);
    xs[xs.len() / 2]
}

fn time<T>(mut f: impl FnMut() -> T) -> f64 {
    f();
    median(
        (0..9)
            .map(|_| {
                let t = Instant::now();
                std::hint::black_box(f());
                t.elapsed().as_secs_f64() * 1e3
            })
            .collect(),
    )
}

fn main() -> pond_rs::Result<()> {
    let wide = TimeSeries::new(
        "wide",
        (0..10_000i64).map(|i| i * 1000).collect(),
        (0..40)
            .map(|c| {
                Column::required(
                    format!("c{c}"),
                    (0..10_000)
                        .map(|i| ((i + c) % 97) as f64)
                        .collect::<Vec<_>>(),
                )
            })
            .collect(),
    )?;
    let bucketed = make(100_000, false, false).aggregate(
        &Sequence::every("1m")?,
        &[
            Agg::new("close", "close", Reducer::Avg),
            Agg::new("volume", "volume", Reducer::Sum),
        ],
    )?;
    let cases = [
        ("dense numeric (100k x 6)", make(100_000, false, false)),
        (
            "with a string column (100k x 7)",
            make(100_000, true, false),
        ),
        ("~10% gaps (100k x 6)", make(100_000, false, true)),
        ("wide (10k x 41)", wide),
        ("per-element floor (1k x 6)", make(1_000, false, false)),
        ("interval key (1667 x 3)", bucketed),
    ];
    for (label, s) in &cases {
        let tuple = time(|| s.to_json(RowFormat::Array).unwrap());
        let object = time(|| s.to_json(RowFormat::Object).unwrap());
        let text = s.to_json(RowFormat::Array)?;
        let read = time(|| TimeSeries::from_json(&text, &JsonOptions::new()).unwrap());
        println!(
            "{label}: to_json tuple {tuple:.2} ms, object {object:.2} ms, from_json {read:.2} ms"
        );
        let columns = s.to_columns_json()?;
        let to_columns = time(|| s.to_columns_json().unwrap());
        let from_columns =
            time(|| TimeSeries::from_columns_json(&columns, KeyOrder::Strict).unwrap());
        println!("  to_columns_json {to_columns:.2} ms, from_columns_json {from_columns:.2} ms");
        if s.key().end().is_none() {
            let points = s.to_points_json()?;
            let schema = s.schema();
            let to_points = time(|| s.to_points_json().unwrap());
            let from_points = time(|| TimeSeries::from_points_json(&points, "p", &schema).unwrap());
            println!("  to_points_json {to_points:.2} ms, from_points_json {from_points:.2} ms");
        }
    }
    Ok(())
}
