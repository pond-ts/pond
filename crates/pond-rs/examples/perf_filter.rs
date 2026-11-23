//! Timing for `filter` on 1M rows: how the cost moves with how many rows
//! are kept, how they are spread, and what kind of column is copied.
//!
//!     cargo run --release -p pond-rs --example perf_filter [rows]
//!
//! RAYON_NUM_THREADS=1 for one core: by default a filter that keeps
//! 131,072 rows or more copies the key and each column on a core of its
//! own.
//!
//! Cost: the test is one pass over the tested column, several values at a
//! time, into a mask of one bit per row. Each column is then copied from
//! the mask; there is no list of row numbers.
//! - Key, numbers, decimals, dictionary keys: one step per eight rows (a
//!   table gives the places of the kept ones), whatever the mix of kept
//!   and dropped rows. 64 rows all dropped are skipped; all kept are one
//!   copy.
//! - Text: one step per stretch of kept rows, plus its bytes, plus Arrow's
//!   check of the finished column.
//! - True/false values, and the marks for gaps: one step per stretch.
//! - Arrays: by row number.
//!
//! The first case is the six-engine suite's (`bench/suite`): `v > 500` on
//! its `even` series.

use std::sync::Arc;
use std::time::Instant;

use pond_rs::arrow_array::types::Int32Type;
use pond_rs::arrow_array::{ArrayRef, DictionaryArray, RecordBatch, StringArray};
use pond_rs::{ArrayColumn, Column, DecimalColumn, Scalar, TimeSeries, col};

fn median_ms(mut f: impl FnMut() -> TimeSeries) -> (f64, usize) {
    let kept = f().len(); // warm-up
    let mut t: Vec<f64> = (0..9)
        .map(|_| {
            let s = Instant::now();
            std::hint::black_box(f());
            s.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    t.sort_by(f64::total_cmp);
    (t[4], kept)
}

fn value(i: usize) -> Option<f64> {
    (i % 17 != 5).then(|| ((i * 7919) % 10_007) as f64 / 8.0)
}

fn main() -> pond_rs::Result<()> {
    let rows: usize = std::env::args()
        .nth(1)
        .map_or(1_000_000, |s| s.parse().expect("rows"));
    let time: Vec<i64> = (0..rows as i64).map(|i| i * 1000).collect();
    let names: Vec<String> = (0..8).map(|h| format!("host-{h}")).collect();
    let v = || Column::optional("v", (0..rows).map(value).collect::<Vec<_>>());
    let host = || {
        Column::required(
            "host",
            (0..rows)
                .map(|i| names[(i / 90) % 8].as_str())
                .collect::<Vec<_>>(),
        )
    };
    let with = |name: &str, extra: Vec<Column>| {
        let mut columns = vec![v()];
        columns.extend(extra);
        TimeSeries::new(name, time.clone(), columns)
    };

    // The suite's series: a number column with a gap every 17 rows, and
    // text.
    let even = with("even", vec![host()])?;
    // The same, with the tested value switching every 1,000 rows.
    let blocks = TimeSeries::new(
        "blocks",
        time.clone(),
        vec![
            Column::required(
                "v",
                (0..rows)
                    .map(|i| ((i / 1000) % 2 * 1000) as f64)
                    .collect::<Vec<f64>>(),
            ),
            host(),
        ],
    )?;
    let over = |k: f64| col("v").gt(k);

    println!("How many rows are kept, and how they are spread (key, v, text):");
    for (label, s, k) in [
        ("56% kept, stretches of ~3 (the suite's case)", &even, 500.0),
        ("none kept (the test alone)", &even, 2000.0),
        ("1% kept", &even, 1238.0),
        ("93% kept (all but the gaps and 1%)", &even, 12.5),
        ("50% kept, stretches of 1,000", &blocks, 500.0),
    ] {
        let (ms, kept) = median_ms(|| s.filter_expr(&over(k)).unwrap());
        println!("  {label:<46} {ms:>7.3} ms   {kept} rows");
    }

    // One more column of each kind, next to the key and `v`.
    let dictionary = {
        let batch = even.to_arrow()?;
        let words: DictionaryArray<Int32Type> = batch
            .column(2)
            .as_any()
            .downcast_ref::<StringArray>()
            .expect("text")
            .iter()
            .collect();
        let b = RecordBatch::try_from_iter(vec![
            ("time", batch.column(0).clone()),
            ("v", batch.column(1).clone()),
            ("host", Arc::new(words) as ArrayRef),
        ])
        .expect("a batch");
        TimeSeries::from_arrow("dictionary", &[b], "time")?
    };
    assert!(dictionary.column("host")?.strings()?.is_dictionary());
    let kinds = [
        ("no other column", with("none", vec![])?),
        (
            "number, no gaps",
            with(
                "number",
                vec![Column::required(
                    "w",
                    (0..rows).map(|i| i as f64).collect::<Vec<f64>>(),
                )],
            )?,
        ),
        ("text", with("text", vec![host()])?),
        ("text held as a dictionary", dictionary),
        (
            "true/false, with gaps",
            with(
                "flags",
                vec![Column::optional(
                    "b",
                    (0..rows)
                        .map(|i| (i % 9 != 0).then_some(i % 3 == 0))
                        .collect::<Vec<_>>(),
                )],
            )?,
        ),
        (
            "decimal, with gaps",
            with(
                "decimal",
                vec![Column::optional(
                    "m",
                    DecimalColumn::from_options(
                        (0..rows).map(|i| (i % 9 != 0).then_some(i as i128 * 125)),
                        2,
                    )?,
                )],
            )?,
        ),
        (
            "array (one number per row)",
            with(
                "array",
                vec![Column::required(
                    "a",
                    ArrayColumn::from_options(
                        (0..rows).map(|i| Some(vec![Scalar::Number(i as f64)])),
                    ),
                )],
            )?,
        ),
    ];
    println!("v > 500 (56% kept) with the key, v and one more column:");
    for (label, s) in &kinds {
        let (ms, _) = median_ms(|| s.filter_expr(&over(500.0)).unwrap());
        println!("  {label:<46} {ms:>7.3} ms");
    }

    // The same rule as a closure: the test is a call per row, the copy is
    // the same.
    let vc = even.column("v")?.numbers()?.clone();
    let (ms, kept) = median_ms(|| {
        even.filter(|r| Ok(vc.get(r.index()).is_some_and(|x| x > 500.0)))
            .unwrap()
    });
    println!("v > 500 as a closure (key, v, text):");
    println!("  {:<46} {ms:>7.3} ms   {kept} rows", "filter(|row| ...)");
    Ok(())
}
