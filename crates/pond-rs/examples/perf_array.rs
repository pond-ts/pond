//! Timing of the array-column calls (`array_contains` / `_any` / `_all`,
//! `array_aggregate`, `array_explode`) and of reading and writing an array
//! column as JSON rows and as Arrow lists, on 100k rows one second apart with a number column
//! alongside:
//!
//! - `typical`: text arrays of 0 to 6 words (from 20) and number arrays of
//!   0 to 8 values, a gap every tenth row.
//! - `single`: one element per array, the per-row cost floor.
//!
//!     cargo run --release -p pond-rs --example perf_array
//!
//! pond-ts's equivalent is the same calls on a `TimeSeries` built with
//! `fromJSON` (`arrayContains`, `arrayAggregate`, …). pond-ts has no Arrow
//! form for arrays, so the Arrow rows have nothing to compare with there;
//! they time the time key with the `nums` and `tags` columns
//! (`select` keeps the key). The `object` JSON rows are the form polars
//! writes and reads (one object per row), for the polars comparison.

mod common;

use pond_rs::{ArrayOptions, Column, JsonOptions, Reducer, RowFormat, Scalar, TimeSeries};

const ROWS: usize = 100_000;

type Case<'a> = (&'a str, Box<dyn Fn() -> Box<dyn common::Dump> + 'a>);

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
        let objects = s.to_json(RowFormat::Object)?;
        let time = |op: &str, f: &dyn Fn() -> Box<dyn common::Dump>| {
            common::time_case(&format!("{name} {op}"), 9, f)
        };
        let lists = s.select(&["tags", "nums"])?;
        let batch = lists.to_arrow()?;
        let mut ipc = Vec::new();
        lists.write_ipc(&mut ipc)?;
        let cases: Vec<Case> = vec![
            (
                "contains",
                Box::new(|| Box::new(s.array_contains("tags", "w3").unwrap())),
            ),
            (
                "containsAny",
                Box::new(|| Box::new(s.array_contains_any("tags", &pair).unwrap())),
            ),
            (
                "containsAll",
                Box::new(|| Box::new(s.array_contains_all("tags", &pair).unwrap())),
            ),
            (
                "aggregate count",
                Box::new(|| Box::new(s.array_aggregate("nums", Reducer::Count, &keep).unwrap())),
            ),
            (
                "aggregate avg",
                Box::new(|| Box::new(s.array_aggregate("nums", Reducer::Avg, &keep).unwrap())),
            ),
            (
                "aggregate median",
                Box::new(|| Box::new(s.array_aggregate("nums", Reducer::Median, &keep).unwrap())),
            ),
            (
                "aggregate first",
                Box::new(|| Box::new(s.array_aggregate("tags", Reducer::First, &keep).unwrap())),
            ),
            (
                "explode tags",
                Box::new(|| Box::new(s.array_explode("tags", &keep).unwrap())),
            ),
            (
                "explode nums",
                Box::new(|| Box::new(s.array_explode("nums", &number).unwrap())),
            ),
            (
                "toJSON",
                Box::new(|| Box::new(s.to_json(RowFormat::Array).unwrap())),
            ),
            (
                "fromJSON",
                Box::new(|| Box::new(TimeSeries::from_json(&text, &JsonOptions::new()).unwrap())),
            ),
            (
                "toJSON object",
                Box::new(|| Box::new(s.to_json(RowFormat::Object).unwrap())),
            ),
            (
                "fromJSON object",
                Box::new(|| {
                    Box::new(TimeSeries::from_json(&objects, &JsonOptions::new()).unwrap())
                }),
            ),
            ("toArrow", Box::new(|| Box::new(lists.to_arrow().unwrap()))),
            (
                "fromArrow",
                Box::new(|| {
                    Box::new(
                        TimeSeries::from_arrow("b", std::slice::from_ref(&batch), "time").unwrap(),
                    )
                }),
            ),
            (
                "writeIpc",
                Box::new(|| {
                    let mut out = Vec::with_capacity(ipc.len());
                    lists.write_ipc(&mut out).unwrap();
                    Box::new(out)
                }),
            ),
            (
                "readIpc",
                Box::new(|| {
                    Box::new(TimeSeries::from_ipc_bytes("b", ipc.clone(), "time").unwrap())
                }),
            ),
        ];
        let rows: Vec<(&str, f64)> = cases
            .iter()
            .map(|(op, f)| (*op, time(op, f.as_ref())))
            .collect();
        for (op, ms) in rows {
            println!("{name:8} {op:18} {ms:8.2} ms");
            results.push(format!("\"{name} {op}\": {ms:.2}"));
        }
    }
    println!("{{{}}}", results.join(", "));
    Ok(())
}
