//! Timing for text and true/false columns against a number column of the
//! same shape: 1M rows 1 s apart, ~5% gaps, then `aggregate(every 1m:
//! count/first/last)`, `rolling('5m', last)`, and an Arrow IPC round trip.
//!
//!     cargo run --release -p pond-rs --example perf_text
//!
//! Cost: `count` / `first` / `last` on a text or true/false column run the
//! number kernels over each row's index (one O(N) pass to build it), then
//! gather the chosen rows (O(buckets) for `aggregate`, O(N) for `rolling`).

use std::time::Instant;

use pond_rs::{Agg, Column, Reducer, Sequence, TimeSeries};

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
    let mut num = Vec::with_capacity(ROWS);
    let mut text = Vec::with_capacity(ROWS);
    let mut flag = Vec::with_capacity(ROWS);
    for _ in 0..ROWS {
        let gap = next() < 0.05;
        let r = next();
        num.push((!gap).then_some(r));
        text.push((!gap).then(|| format!("host-{}", (r * 1000.0) as u32)));
        flag.push((!gap).then_some(r < 0.5));
    }
    let series = TimeSeries::new(
        "data",
        time,
        vec![
            Column::optional("num", num),
            Column::optional("text", text),
            Column::optional("flag", flag),
        ],
    )?;
    // The same text as a dictionary, as pond-ts writes low-cardinality text.
    let dict = {
        use pond_rs::arrow_array::{ArrayRef, DictionaryArray, RecordBatch, types::Int32Type};
        use std::sync::Arc;
        let batch = series.select(&["text"])?.to_arrow()?;
        let words: DictionaryArray<Int32Type> = batch
            .column(1)
            .as_any()
            .downcast_ref::<pond_rs::arrow_array::StringArray>()
            .unwrap()
            .iter()
            .collect();
        let b = RecordBatch::try_from_iter(vec![
            ("time", batch.column(0).clone()),
            ("text", Arc::new(words) as ArrayRef),
        ])
        .unwrap();
        TimeSeries::from_arrow("dict", &[b], "time")?
    };
    assert!(dict.column("text")?.strings()?.is_dictionary());

    let minute = Sequence::every("1m")?;
    println!("| column | aggregate 1m count/first/last | rolling 5m last | IPC write + read |");
    println!("| --- | --- | --- | --- |");
    for (label, s, name) in [
        ("number", &series, "num"),
        ("text", &series, "text"),
        ("text (dictionary)", &dict, "text"),
        ("true/false", &series, "flag"),
    ] {
        let aggs = [
            Agg::new("n", name, Reducer::Count),
            Agg::new("f", name, Reducer::First),
            Agg::new("l", name, Reducer::Last),
        ];
        let one = s.select(&[name])?;
        let agg = median_ms(|| {
            one.aggregate(&minute, &aggs).unwrap();
        });
        let roll = median_ms(|| {
            one.rolling("5m", &[Agg::of(name, Reducer::Last)]).unwrap();
        });
        let ipc = median_ms(|| {
            let mut bytes = Vec::new();
            one.write_ipc(&mut bytes).unwrap();
            TimeSeries::from_ipc_bytes("x", bytes, "time").unwrap();
        });
        println!("| {label} | {agg:.1} ms | {roll:.1} ms | {ipc:.1} ms |");
    }
    Ok(())
}
