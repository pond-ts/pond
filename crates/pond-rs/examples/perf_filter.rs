//! Timing for `filter` on 1M rows: how the cost moves with how many rows
//! are kept, how they are spread, what kind of column is copied, what its
//! text is like and how many columns there are.
//!
//!     cargo run --release -p pond-rs --example perf_filter [rows]
//!
//! RAYON_NUM_THREADS=1 for one core: by default a filter that keeps
//! 131,072 rows or more copies the key and each column on a core of its
//! own.
//!
//! Cost: the test is one pass over the tested column, several values at a
//! time, into a mask of one bit per row. The key and each column are then
//! copied by the mask:
//! - Key, numbers, decimals, dictionary keys: straight from the mask, 64
//!   rows at a time. 64 rows all dropped are skipped and all kept are one
//!   copy; rows in stretches of six or more are a copy per stretch; the
//!   rest are one step per eight rows (a table gives the places of the
//!   kept ones) whatever their mix, or one step per kept row when few are
//!   kept and for decimals.
//! - Numbers, decimals and dictionary keys, when the columns are copied
//!   one after another and there are eight or more of them: by a list made
//!   once, of the kept rows when they are scattered (a step per kept row),
//!   or of their stretches when nearly all rows are kept and come 40 or
//!   more to a stretch (a copy per stretch).
//! - Text: stretch by stretch when the kept rows come 32 or more to a
//!   stretch on average (a step per stretch, plus its bytes); otherwise by
//!   Arrow's kernel (a step per kept row or per stretch, plus the bytes).
//! - True/false values, and the marks for gaps: one step per stretch.
//! - Arrays: by row number.
//!
//! A line that ends in a count of page faults had its output memory handed
//! over fresh by the system on every call, which costs about 0.2 ms per MB
//! on an M1. Whether that happens depends on what the allocator has kept
//! from earlier calls, not on `filter`: compare such a line only with
//! another that shows the same count. (Counted on Linux only.)
//!
//! The first case is the six-engine suite's (`bench/suite`): `v > 500` on
//! its `even` series.

use std::sync::Arc;
use std::time::Instant;

use pond_rs::arrow_array::types::Int32Type;
use pond_rs::arrow_array::{ArrayRef, DictionaryArray, RecordBatch, StringArray};
use pond_rs::{ArrayColumn, Column, DecimalColumn, Expr, Scalar, TimeSeries, col};

/// Page faults this process has taken so far that needed no disk (Linux's
/// `minflt`); 0 where `/proc` is not there to read.
fn page_faults() -> u64 {
    let stat = std::fs::read_to_string("/proc/self/stat").unwrap_or_default();
    // The fields after the program's name, which is in brackets and may
    // hold spaces.
    let fields = stat.rsplit(')').next().unwrap_or_default();
    fields
        .split_whitespace()
        .nth(7)
        .and_then(|x| x.parse().ok())
        .unwrap_or(0)
}

/// The median of nine calls in ms, what the first call gave, and page
/// faults per call.
fn median_ms<T>(mut f: impl FnMut() -> T) -> (f64, T, u64) {
    let first = f(); // warm-up
    // And once more while `first` is held: the timed calls each need room
    // for a second result, and the first of them would otherwise be the
    // one to take it fresh from the system.
    std::hint::black_box(f());
    let before = page_faults();
    let mut t: Vec<f64> = (0..9)
        .map(|_| {
            let s = Instant::now();
            std::hint::black_box(f());
            s.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    let faults = (page_faults() - before) / 9;
    t.sort_by(f64::total_cmp);
    (t[4], first, faults)
}

/// One line of the report.
fn line(label: &str, (ms, kept, faults): (f64, usize, u64)) {
    let note = if faults >= 100 {
        format!("   {faults} page faults a call")
    } else {
        String::new()
    };
    println!("  {label:<46} {ms:>7.3} ms   {kept} rows{note}");
}

/// Time `s.filter_expr(test)` and print a line for it.
fn time(label: &str, s: &TimeSeries, test: &Expr) {
    let (ms, kept, faults) = median_ms(|| s.filter_expr(test).unwrap());
    line(label, (ms, kept.len(), faults));
}

fn value(i: usize) -> Option<f64> {
    (i % 17 != 5).then(|| ((i * 7919) % 10_007) as f64 / 8.0)
}

/// A tested column that keeps `len` rows, drops `len`, and so on.
fn stretches(rows: usize, len: usize) -> Column {
    Column::required(
        "v",
        (0..rows)
            .map(|i| ((i / len) % 2 * 1000) as f64)
            .collect::<Vec<f64>>(),
    )
}

/// A tested column that drops one row after every `kept`.
fn holes(rows: usize, kept: usize) -> Column {
    Column::required(
        "v",
        (0..rows)
            .map(|i| if i % (kept + 1) == kept { 0.0 } else { 1000.0 })
            .collect::<Vec<f64>>(),
    )
}

fn main() -> pond_rs::Result<()> {
    let rows: usize = std::env::args()
        .nth(1)
        .map_or(1_000_000, |s| s.parse().expect("rows"));
    let time_key = |n: usize| -> Vec<i64> { (0..n as i64).map(|i| i * 1000).collect() };
    let names: Vec<String> = (0..8).map(|h| format!("host-{h}")).collect();
    let v = |n: usize| Column::optional("v", (0..n).map(value).collect::<Vec<_>>());
    let host = || {
        Column::required(
            "host",
            (0..rows)
                .map(|i| names[(i / 90) % 8].as_str())
                .collect::<Vec<_>>(),
        )
    };
    let with = |name: &str, extra: Vec<Column>| {
        let mut columns = vec![v(rows)];
        columns.extend(extra);
        TimeSeries::new(name, time_key(rows), columns)
    };
    let over = |k: f64| col("v").gt(k);

    // The suite's series: a number column with a gap every 17 rows, and
    // text.
    let even = with("even", vec![host()])?;
    // The same, with the tested value switching every 1,000 rows.
    let blocks = TimeSeries::new(
        "blocks",
        time_key(rows),
        vec![stretches(rows, 1000), host()],
    )?;

    // The suite's series with a gap in the text every 11 rows.
    let gappy = with(
        "gappy",
        vec![Column::optional(
            "host",
            (0..rows)
                .map(|i| (i % 11 != 3).then(|| names[(i / 90) % 8].as_str()))
                .collect::<Vec<_>>(),
        )],
    )?;

    println!("How many rows are kept, and how they are spread (key, v, text):");
    for (label, s, k) in [
        ("56% kept, stretches of ~3 (the suite's case)", &even, 500.0),
        ("none kept (the test alone)", &even, 2000.0),
        ("1% kept", &even, 1238.0),
        ("93% kept (all but the gaps and 1%)", &even, 12.5),
        ("50% kept, stretches of 1,000", &blocks, 500.0),
        ("56% kept, gaps in the text", &gappy, 500.0),
        ("93% kept, gaps in the text", &gappy, 12.5),
    ] {
        time(label, s, &over(k));
    }

    println!("Half the rows kept, in stretches of one length (key, v, text):");
    for len in [1, 4, 8, 16, 32, 64, 256] {
        let s = TimeSeries::new("s", time_key(rows), vec![stretches(rows, len), host()])?;
        time(&format!("stretches of {len}"), &s, &over(500.0));
    }

    // The suite's rows as 1,000 series of 1,000 rows: what a call costs
    // apart from its rows.
    let small = (0..rows / 1000)
        .map(|p| {
            let at = p * 1000..(p + 1) * 1000;
            let key: Vec<i64> = at.clone().map(|i| i as i64 * 1000).collect();
            let v = Column::optional("v", at.clone().map(value).collect::<Vec<_>>());
            let host = at.map(|i| names[(i / 90) % 8].as_str()).collect::<Vec<_>>();
            TimeSeries::new("small", key, vec![v, Column::required("host", host)])
        })
        .collect::<pond_rs::Result<Vec<_>>>()?;
    println!(
        "The same rows as {} series of 1,000 rows (key, v, text):",
        small.len()
    );
    let test = over(500.0);
    line(
        "56% kept, a call per series",
        median_ms(|| {
            let kept = small.iter().map(|s| s.filter_expr(&test).unwrap().len());
            kept.sum::<usize>()
        }),
    );

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
        time(label, s, &over(500.0));
    }

    // Text of other lengths, and in letters that take more than one byte
    // (the host names above are 6 bytes of plain ASCII). At most 100 MB of
    // text, so the long ones have fewer rows.
    type Make = Box<dyn Fn(usize) -> String>;
    let letters = |from: &'static str, n: usize| -> Make {
        let count = from.chars().count();
        Box::new(move |i| from.chars().cycle().skip(i % count).take(n).collect())
    };
    let shapes: [(&str, Make); 6] = [
        (
            "24 bytes, ASCII",
            Box::new(|i| format!("{:0>24}", i % 100_000)),
        ),
        (
            "120 bytes, ASCII",
            Box::new(|i| format!("{:0>120}", i % 100_000)),
        ),
        (
            "400 bytes, ASCII",
            Box::new(|i| format!("{:0>400}", i % 100_000)),
        ),
        ("12 bytes, 6 letters of 2 bytes", letters("éàüñøß", 6)),
        ("24 bytes, 12 letters of 2 bytes", letters("éàüñøß", 12)),
        (
            "60 bytes, 20 letters of 3 bytes",
            letters("日本語のテキスト", 20),
        ),
    ];
    println!(
        "Text of other lengths and letters (key, v, text): 56% kept, then stretches of 1,000:"
    );
    for (label, make) in &shapes {
        let n = rows.min(100_000_000 / make(0).len());
        let text = || Column::required("t", (0..n).map(make).collect::<Vec<String>>());
        let scattered = TimeSeries::new("s", time_key(n), vec![v(n), text()])?;
        time(label, &scattered, &over(500.0));
        let long = TimeSeries::new("s", time_key(n), vec![stretches(n, 1000), text()])?;
        time(&format!("{label}, stretches"), &long, &over(500.0));
    }

    // More number columns. On one core these are copied one after another,
    // and from eight (seven more beside `v`) by a list of the kept rows.
    println!(
        "More number columns beside the key and v: 56% kept, 25% kept, stretches of 1,000, \
         and all but one row in 257:"
    );
    for extra in [1, 3, 5, 7, 15, 31] {
        let more = || {
            (0..extra).map(|c| {
                Column::required(
                    format!("w{c}"),
                    (0..rows).map(|i| (i + c) as f64).collect::<Vec<f64>>(),
                )
            })
        };
        let mut columns = vec![v(rows)];
        columns.extend(more());
        let scattered = TimeSeries::new("s", time_key(rows), columns)?;
        time(&format!("{extra} more, 56% kept"), &scattered, &over(500.0));
        time(&format!("{extra} more, 25% kept"), &scattered, &over(918.0));
        let mut columns = vec![stretches(rows, 1000)];
        columns.extend(more());
        let long = TimeSeries::new("s", time_key(rows), columns)?;
        time(
            &format!("{extra} more, stretches of 1,000"),
            &long,
            &over(500.0),
        );
        let mut columns = vec![holes(rows, 256)];
        columns.extend(more());
        let nearly_all = TimeSeries::new("s", time_key(rows), columns)?;
        time(
            &format!("{extra} more, one row in 257 dropped"),
            &nearly_all,
            &over(500.0),
        );
    }

    // Decimal columns: 16 bytes a value, twice a number's.
    println!("Decimal columns beside the key and v: 10%, 45% and 93% kept:");
    for (count, gaps) in [(8, false), (16, false), (16, true)] {
        let mut columns = vec![v(rows)];
        for c in 0..count {
            let values = (0..rows).map(|i| (!gaps || i % 9 != 0).then_some((i + c) as i128 * 125));
            columns.push(Column::optional(
                format!("m{c}"),
                DecimalColumn::from_options(values, 2)?,
            ));
        }
        let s = TimeSeries::new("s", time_key(rows), columns)?;
        let note = if gaps { ", with gaps" } else { "" };
        time(
            &format!("{count} decimals{note}, 10% kept"),
            &s,
            &over(1118.0),
        );
        time(
            &format!("{count} decimals{note}, 45% kept"),
            &s,
            &over(653.0),
        );
        time(
            &format!("{count} decimals{note}, 93% kept"),
            &s,
            &over(12.5),
        );
    }

    // The same rule as a closure: the test is a call per row, the copy is
    // the same.
    let vc = even.column("v")?.numbers()?.clone();
    let (ms, kept, faults) = median_ms(|| {
        even.filter(|r| Ok(vc.get(r.index()).is_some_and(|x| x > 500.0)))
            .unwrap()
    });
    println!("v > 500 as a closure (key, v, text):");
    line("filter(|row| ...)", (ms, kept.len(), faults));
    Ok(())
}
