//! Timing of the array-column calls (`array_contains` / `_any` / `_all`,
//! `array_aggregate`, `array_explode`) and of reading and writing an array
//! column as JSON rows, on 100k rows one second apart with a number column
//! alongside:
//!
//! - `typical`: text arrays of 0 to 6 words (from 20) and number arrays of
//!   0 to 8 values, a gap every tenth row.
//! - `single`: one element per array, the per-row cost floor.
//!
//!     cargo run --release -p pond-rs --example perf_array
//!
//! pond-ts's equivalent is the same calls on a `TimeSeries` built with
//! `fromJSON` (`arrayContains`, `arrayAggregate`, …).

use std::time::Instant;

use pond_rs::{ArrayOptions, Column, JsonOptions, Reducer, RowFormat, Scalar, TimeSeries};

const ROWS: usize = 100_000;

fn make(single: bool) -> TimeSeries {
    let time = (0..ROWS as i64).map(|i| i * 1000).collect();
    let words: Vec<String> = (0..20).map(|w| format!("w{w}")).collect();
    let tags: Vec<Option<Vec<Scalar>>> = (0..ROWS)
        .map(|i| {
            if i % 10 == 9 {
                return None;
            }
            let n = if single { 1 } else { i % 7 };
            Some(
                (0..n)
                    .map(|k| Scalar::from(words[(i * 7 + k * 3) % 20].as_str()))
                    .collect(),
            )
        })
        .collect();
    let nums: Vec<Option<Vec<Scalar>>> = (0..ROWS)
        .map(|i| {
            if i % 10 == 9 {
                return None;
            }
            let n = if single { 1 } else { i % 9 };
            Some(
                (0..n)
                    .map(|k| Scalar::from(((i * 31 + k * 17) % 1000) as f64 / 8.0))
                    .collect(),
            )
        })
        .collect();
    let v: Vec<f64> = (0..ROWS).map(|i| i as f64).collect();
    TimeSeries::new(
        "bench",
        time,
        vec![
            Column::optional("tags", tags),
            Column::optional("nums", nums),
            Column::required("v", v),
        ],
    )
    .unwrap()
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
    let keep = ArrayOptions::default();
    let number = ArrayOptions {
        kind: Some(pond_rs::ColumnKind::Number),
        ..ArrayOptions::default()
    };
    let pair = [Scalar::from("w1"), Scalar::from("w4")];
    let mut results = Vec::new();
    for (name, single) in [("typical", false), ("single", true)] {
        let s = make(single);
        let text = s.to_json(RowFormat::Array)?;
        let rows = [
            ("contains", time(|| s.array_contains("tags", "w3").unwrap())),
            (
                "containsAny",
                time(|| s.array_contains_any("tags", &pair).unwrap()),
            ),
            (
                "containsAll",
                time(|| s.array_contains_all("tags", &pair).unwrap()),
            ),
            (
                "aggregate count",
                time(|| s.array_aggregate("nums", Reducer::Count, &keep).unwrap()),
            ),
            (
                "aggregate avg",
                time(|| s.array_aggregate("nums", Reducer::Avg, &keep).unwrap()),
            ),
            (
                "aggregate median",
                time(|| s.array_aggregate("nums", Reducer::Median, &keep).unwrap()),
            ),
            (
                "aggregate first",
                time(|| s.array_aggregate("tags", Reducer::First, &keep).unwrap()),
            ),
            (
                "explode tags",
                time(|| s.array_explode("tags", &keep).unwrap()),
            ),
            (
                "explode nums",
                time(|| s.array_explode("nums", &number).unwrap()),
            ),
            ("toJSON", time(|| s.to_json(RowFormat::Array).unwrap())),
            (
                "fromJSON",
                time(|| TimeSeries::from_json(&text, &JsonOptions::new()).unwrap()),
            ),
        ];
        for (op, ms) in rows {
            println!("{name:8} {op:18} {ms:8.2} ms");
            results.push(format!("\"{name} {op}\": {ms:.2}"));
        }
    }
    println!("{{{}}}", results.join(", "));
    Ok(())
}
