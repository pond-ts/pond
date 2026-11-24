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
//!   copy. When the mask's kept rows come 16 or more to a stretch on
//!   average, 64 rows whose kept rows come in three stretches or fewer,
//!   of eight rows or more on average, are a copy per stretch. The rest
//!   are one step per eight rows (a table gives the places of the kept
//!   ones) whatever their mix, or one step per kept row when few are
//!   kept. A decimal has no table: its rows go a stretch at a time from
//!   six rows a stretch, and one at a time otherwise.
//! - Numbers, decimals and dictionary keys, when the columns are copied
//!   one after another and eight or more of them are the faster for it (a
//!   decimal column counting as two): by a list made once. With more than
//!   four rows in five kept that is a list of stretches (a copy per
//!   stretch), which pays from 8 rows a stretch on average, and always for
//!   decimals. With fewer kept it is a list of rows (a step per kept row),
//!   which pays until the stretches reach 32 rows on average (16 for
//!   decimals).
//! - Text: stretch by stretch when the kept rows come 32 or more to a
//!   stretch on average (a step per stretch, plus its bytes); otherwise by
//!   Arrow's kernel and its list of the kept rows (a step per kept row or
//!   per stretch, plus the bytes).
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
//! its `even` series. That series, like the stretches of one length, is a
//! pattern that repeats, and work that goes a stretch at a time was
//! measured at up to 2.8 times the cost on stretches of random length as
//! on a repeating mask with the same rows and the same number of
//! stretches (PND_RUST_PLAN.md, "Why a rule can win on a mask that
//! repeats"). So the copies that branch on the mask look faster on it
//! than they are on rows kept with no pattern. The two groups of lines on
//! rows kept at random and on stretches of random length are the ones to
//! judge a change by.

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

/// A tested column of values 0 to 999 from a pseudo-random generator
/// (xorshift64): `v > k` keeps each row or not with no tie to its
/// neighbours.
fn random_values(rows: usize) -> Column {
    let mut x = 0x2545_f491_4f6c_dd1du64;
    Column::required(
        "v",
        (0..rows)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                (x % 1000) as f64
            })
            .collect::<Vec<f64>>(),
    )
}

/// A tested column whose kept rows (1000) and dropped rows (0) come in
/// stretches of random length: `kept` rows on average, then `dropped` on
/// average, and so on.
fn runs(rows: usize, kept: f64, dropped: f64) -> Column {
    let mut x = 0x9e37_79b9_7f4a_7c15u64;
    let mut keep = true;
    Column::required(
        "v",
        (0..rows)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                let u = (x >> 11) as f64 / (1u64 << 53) as f64;
                let mean = if keep { kept } else { dropped };
                if u * mean < 1.0 {
                    keep = !keep;
                }
                if keep { 1000.0 } else { 0.0 }
            })
            .collect::<Vec<f64>>(),
    )
}

/// `count` number columns with no gaps.
fn number_columns(rows: usize, count: usize) -> Vec<Column> {
    let column = |c: usize| {
        Column::required(
            format!("w{c}"),
            (0..rows).map(|i| (i + c) as f64).collect::<Vec<f64>>(),
        )
    };
    (0..count).map(column).collect()
}

/// `count` columns of 6-byte text: eight strings, each for 90 rows on end.
fn text_columns(rows: usize, count: usize) -> Vec<Column> {
    let column = |c: usize| {
        let names: Vec<String> = (0..8).map(|h| format!("{c}ost-{h}")).collect();
        Column::required(
            format!("t{c}"),
            (0..rows)
                .map(|i| names[(i / 90 + c) % 8].as_str())
                .collect::<Vec<_>>(),
        )
    };
    (0..count).map(column).collect()
}

/// `count` decimal columns, with a gap every nine rows when `gaps`.
fn decimal_columns(rows: usize, count: usize, gaps: bool) -> pond_rs::Result<Vec<Column>> {
    let column = |c: usize| {
        let values = (0..rows)
            .map(|i| (!gaps || !(i + c).is_multiple_of(9)).then_some((i + c) as i128 * 125));
        Ok(Column::optional(
            format!("m{c}"),
            DecimalColumn::from_options(values, 2)?,
        ))
    };
    (0..count).map(column).collect()
}

/// `count` true/false columns with a gap every nine rows: two sets of bits
/// each, the values and the marks for gaps.
fn flag_columns(rows: usize, count: usize) -> Vec<Column> {
    let column = |c: usize| {
        Column::optional(
            format!("b{c}"),
            (0..rows)
                .map(|i| (!(i + c).is_multiple_of(9)).then_some((i + c).is_multiple_of(3)))
                .collect::<Vec<_>>(),
        )
    };
    (0..count).map(column).collect()
}

/// `s` with each text column held as a dictionary: per row a small number
/// that names one of a short list of strings.
fn as_dictionaries(s: &TimeSeries) -> pond_rs::Result<TimeSeries> {
    let batch = s.to_arrow()?;
    let schema = batch.schema();
    let columns = batch.columns().iter().zip(schema.fields()).map(|(a, f)| {
        let a = match a.as_any().downcast_ref::<StringArray>() {
            Some(text) => Arc::new(text.iter().collect::<DictionaryArray<Int32Type>>()) as ArrayRef,
            None => a.clone(),
        };
        (f.name().clone(), a)
    });
    let b = RecordBatch::try_from_iter(columns).expect("a batch");
    TimeSeries::from_arrow(s.name(), &[b], schema.field(0).name().as_str())
}

/// `perf_filter <rows> bars`: the tables the rules' bars are judged on.
/// Each group sweeps the rows to a stretch across one bar, on stretches of
/// random length (or rows kept at random), for a table that the rule in
/// question decides. To set a bar, time a build that always goes one way
/// against a build that always goes the other on these lines, on each kind
/// of machine: the bars in `row_filter.rs` say where they were set.
fn bars(rows: usize) -> pond_rs::Result<()> {
    let key = || -> Vec<i64> { (0..rows as i64).map(|i| i * 1000).collect() };
    let test = col("v").gt(500.0);
    let table = |tested: Column, extra: &[Column]| {
        let mut columns = vec![tested];
        columns.extend(extra.iter().cloned());
        TimeSeries::new("s", key(), columns)
    };
    let wide: [(&str, Vec<Column>); 4] = [
        ("8 numbers", number_columns(rows, 8)),
        ("32 numbers", number_columns(rows, 32)),
        ("4 decimals", decimal_columns(rows, 4, false)?),
        ("16 decimals", decimal_columns(rows, 16, false)?),
    ];
    println!("Most rows kept (1.2 dropped between stretches), by the rows to a stretch:");
    for kept in [6.0, 8.0, 12.0, 16.0, 24.0, 32.0, 48.0, 64.0] {
        for (what, extra) in &wide {
            let s = table(runs(rows, kept, 1.2), extra)?;
            time(&format!("{what}, {kept} kept, 1.2 dropped"), &s, &test);
        }
    }
    println!("Half the rows kept, by the rows to a stretch:");
    for kept in [2.0, 4.0, 8.0, 16.0, 24.0, 32.0, 48.0] {
        for (what, extra) in &wide {
            let s = table(runs(rows, kept, kept), extra)?;
            time(&format!("{what}, {kept} kept, {kept} dropped"), &s, &test);
        }
    }
    let bits: [(&str, Vec<Column>); 3] = [
        ("4 true/false", flag_columns(rows, 4)),
        ("16 true/false", flag_columns(rows, 16)),
        ("8 decimals with gaps", decimal_columns(rows, 8, true)?),
    ];
    println!("True/false values and marks for gaps, rows kept one or a few at a time:");
    for (share, k) in [
        ("5%", 949.5),
        ("10%", 899.5),
        ("25%", 749.5),
        ("50%", 499.5),
    ] {
        for (what, extra) in &bits {
            let s = table(random_values(rows), extra)?;
            time(&format!("{what}, {share} kept"), &s, &col("v").gt(k));
        }
    }
    for (kept, dropped) in [(2.0, 2.0), (3.0, 3.0), (4.0, 12.0), (8.0, 8.0)] {
        for (what, extra) in &bits {
            let s = table(runs(rows, kept, dropped), extra)?;
            time(
                &format!("{what}, {kept} kept, {dropped} dropped"),
                &s,
                &test,
            );
        }
    }
    let text: [(&str, Vec<Column>); 2] = [
        ("1 text", text_columns(rows, 1)),
        ("4 texts", text_columns(rows, 4)),
    ];
    println!("Text, by the rows to a stretch:");
    for (share, k) in [("25%", 749.5), ("50%", 499.5)] {
        for (what, extra) in &text {
            let s = table(random_values(rows), extra)?;
            time(&format!("{what}, {share} kept"), &s, &col("v").gt(k));
        }
    }
    for kept in [2.0, 4.0, 8.0, 16.0, 24.0, 32.0, 48.0, 64.0] {
        for (what, extra) in &text {
            let s = table(runs(rows, kept, kept), extra)?;
            time(&format!("{what}, {kept} kept, {kept} dropped"), &s, &test);
        }
    }
    println!("Dictionary columns:");
    for count in [2, 8] {
        let random = as_dictionaries(&table(random_values(rows), &text_columns(rows, count))?)?;
        for (share, k) in [("10%", 899.5), ("50%", 499.5), ("85%", 149.5)] {
            time(
                &format!("{count} dictionaries, {share} kept"),
                &random,
                &col("v").gt(k),
            );
        }
        for (kept, dropped) in [(16.0, 16.0), (64.0, 64.0), (64.0, 1.5)] {
            let s = as_dictionaries(&table(
                runs(rows, kept, dropped),
                &text_columns(rows, count),
            )?)?;
            time(
                &format!("{count} dictionaries, {kept} kept, {dropped} dropped"),
                &s,
                &test,
            );
        }
    }
    Ok(())
}

fn main() -> pond_rs::Result<()> {
    let rows: usize = std::env::args()
        .nth(1)
        .map_or(1_000_000, |s| s.parse().expect("rows"));
    if std::env::args().nth(2).as_deref() == Some("bars") {
        return bars(rows);
    }
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
    let dictionary = as_dictionaries(&even)?;
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

    // No pattern for the processor to learn: each row kept or not by a
    // pseudo-random number, then stretches of random length. Beside the
    // key and the tested column, each table has the columns it is named
    // for.
    type Extra = Box<dyn Fn() -> pond_rs::Result<Vec<Column>>>;
    let numbers = |count: usize| -> Extra { Box::new(move || Ok(number_columns(rows, count))) };
    let texts = |count: usize| -> Extra { Box::new(move || Ok(text_columns(rows, count))) };
    let decimals = |count: usize| -> Extra {
        Box::new(move || {
            let column = |c: usize| {
                let values = (0..rows).map(|i| (i + c) as i128 * 125).collect();
                Ok(Column::required(
                    format!("m{c}"),
                    DecimalColumn::from_values(values, 2)?,
                ))
            };
            (0..count).map(column).collect()
        })
    };
    let tables: [(&str, Extra); 6] = [
        ("1 text", texts(1)),
        ("4 texts", texts(4)),
        ("1 number", numbers(1)),
        ("7 numbers", numbers(7)),
        ("31 numbers", numbers(31)),
        ("4 decimals", decimals(4)),
    ];
    println!("Rows kept at random, by the share kept (key, v and the columns named):");
    for (what, extra) in &tables {
        let mut columns = vec![random_values(rows)];
        columns.extend(extra()?);
        let s = TimeSeries::new("s", time_key(rows), columns)?;
        for (share, k) in [
            ("5%", 949.5),
            ("25%", 749.5),
            ("50%", 499.5),
            ("85%", 149.5),
            ("97%", 29.5),
        ] {
            time(&format!("{what}, {share} kept"), &s, &over(k));
        }
    }
    println!("Stretches of random length, by the rows kept and dropped on average (the same):");
    for (kept, dropped) in [
        (4.0, 30.0),
        (8.0, 8.0),
        (32.0, 32.0),
        (200.0, 200.0),
        (6.0, 1.2),
        (12.0, 1.2),
        (60.0, 1.5),
    ] {
        for (what, extra) in &tables {
            let mut columns = vec![runs(rows, kept, dropped)];
            columns.extend(extra()?);
            let s = TimeSeries::new("s", time_key(rows), columns)?;
            time(
                &format!("{what}, {kept} kept, {dropped} dropped"),
                &s,
                &over(500.0),
            );
        }
    }

    // Tables the lines above have at most one column of: several
    // true/false columns (each is two sets of bits, its values and its
    // marks for gaps), several dictionary columns, and text beside numbers.
    let wide: Vec<(String, TimeSeries)> = {
        let table = |extra: Vec<Column>| {
            let mut columns = vec![random_values(rows)];
            columns.extend(extra);
            TimeSeries::new("s", time_key(rows), columns)
        };
        let mut wide = Vec::new();
        for count in [4, 16] {
            wide.push((
                format!("{count} true/false"),
                table(flag_columns(rows, count))?,
            ));
        }
        for count in [2, 8] {
            let s = as_dictionaries(&table(text_columns(rows, count))?)?;
            assert!(s.column("t0")?.strings()?.is_dictionary());
            wide.push((format!("{count} dictionaries"), s));
        }
        for (text, number) in [(1, 6), (4, 3)] {
            let mut extra = text_columns(rows, text);
            extra.extend(number_columns(rows, number));
            wide.push((format!("{text} text, {number} numbers"), table(extra)?));
        }
        wide
    };
    println!(
        "More kinds of table, rows kept at random (key, v and the columns named; the \
         true/false ones have gaps):"
    );
    for (what, s) in &wide {
        for (share, k) in [
            ("5%", 949.5),
            ("25%", 749.5),
            ("50%", 499.5),
            ("85%", 149.5),
        ] {
            time(&format!("{what}, {share} kept"), s, &over(k));
        }
    }

    // Every line so far tests `v > k`: one number column against a
    // constant, which `filter` tests straight into its mask. Any other test
    // is worked out row by row first, so the same rows cost more to choose
    // and what the copy costs is a smaller share of the whole. A change to
    // the copy is to be judged on both.
    println!("The same rows by a test of two parts (v > k and v < 1e300):");
    let both = |k: f64| col("v").gt(k).and(col("v").lt(1e300));
    time(
        "56% kept, stretches of ~3 (the suite's case)",
        &even,
        &both(500.0),
    );
    time("none kept (the test alone)", &even, &both(2000.0));
    for (what, s) in &wide {
        for (share, k) in [("25%", 749.5), ("85%", 149.5)] {
            time(&format!("{what}, {share} kept"), s, &both(k));
        }
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
