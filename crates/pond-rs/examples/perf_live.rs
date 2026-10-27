//! Timing for the live layer: 1M events pushed into a `LiveSeries` (100 ms
//! apart; host text, cpu and mem numbers, ~2% gaps), with and without nodes
//! built on it; same data and steps as `bench/live_pond_ts.mjs` for the
//! pond-ts side.
//!
//!     cargo run --release -p pond-rs --example perf_live
//!
//! Cost per event: the row check (one pass over its cells), an append at the
//! tail (a late event under `reorder`: an insert, moving the events after
//! it), and per node one step: a filter's test, an aggregation's add to each
//! output column of the open bucket (plus a lookup in the open buckets,
//! O(log open)). Retention drops from the front, O(evicted). Watched outputs
//! add one shared event (two reference counts) per output; a watched
//! `Bucket` builds the bucket's snapshot each time.

use std::time::Instant;

use pond_rs::live::{LiveOptions, LiveSeries, OrderingMode, OutputKind};
use pond_rs::{Agg, ColumnDef, ColumnKind, Reducer, Sequence, Value};

/// Median of five timed runs after a warm-up. Each run gets its own copy of
/// the rows, made before the clock starts: a caller hands pond-rs rows it
/// built, as the pond-ts side's rows are built before its clock starts.
/// Dropping the series (freeing every event) is inside the time.
fn median_ms<T>(mut prepare: impl FnMut() -> T, mut f: impl FnMut(T)) -> f64 {
    f(prepare()); // warm-up
    let mut t: Vec<f64> = (0..5)
        .map(|_| {
            let input = prepare();
            let s = Instant::now();
            f(input);
            s.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    t.sort_by(|a, b| a.partial_cmp(b).unwrap());
    t[2]
}

type Row = (i64, Vec<Option<Value>>);

fn schema() -> Vec<ColumnDef> {
    vec![
        ColumnDef::required("time", ColumnKind::Time),
        ColumnDef::optional("host", ColumnKind::String),
        ColumnDef::optional("cpu", ColumnKind::Number),
        ColumnDef::optional("mem", ColumnKind::Number),
    ]
}

fn main() -> pond_rs::Result<()> {
    const N: usize = 1_000_000;
    // Same generator as bench/live_pond_ts.mjs.
    let mut seed = 20261027u32;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        seed as f64 / 4294967296.0
    };
    let hosts = ["a", "b", "c", "d"];
    let mut rows: Vec<Row> = Vec::with_capacity(N);
    let mut late: Vec<Row> = Vec::with_capacity(N);
    for i in 0..N {
        let host = hosts[i % 4];
        let cpu = if next() < 0.02 { None } else { Some(next()) };
        let mem = 100.0 + (i % 50) as f64;
        let t = i as i64 * 100;
        let row = vec![Some(host.into()), cpu.map(Value::Number), Some(mem.into())];
        rows.push((t, row.clone()));
        // ~5% of events up to 1 s late.
        let shift = if next() < 0.05 {
            (next() * 1000.0) as i64
        } else {
            0
        };
        late.push((t - shift, row));
    }
    let mapping = [
        Agg::new("cpu_avg", "cpu", Reducer::Avg),
        Agg::new("mem_max", "mem", Reducer::Max),
        Agg::new("n", "cpu", Reducer::Count),
    ];
    let minute = Sequence::every("1m")?;

    let one_by_one = |live: &mut LiveSeries, rows: Vec<Row>| -> usize {
        let mut outputs = 0;
        for (t, row) in rows {
            outputs += live.push(t, row).unwrap().len();
        }
        outputs
    };
    let busy = |e: &pond_rs::live::LiveEvent| e.number("cpu").ok().flatten() > Some(0.5);

    let mut report = Vec::new();
    let mut run = |name: &str, input: &Vec<Row>, f: &mut dyn FnMut(Vec<Row>)| {
        let ms = median_ms(|| input.clone(), f);
        println!("{name:<44} {ms:>9.1} ms");
        report.push(format!("\"{name}\": {ms:.2}"));
    };

    run("push one at a time", &rows, &mut |rows| {
        let mut live = LiveSeries::new("live", schema()).unwrap();
        one_by_one(&mut live, rows);
    });
    run("push_many, batches of 1000", &rows, &mut |rows| {
        let mut live = LiveSeries::new("live", schema()).unwrap();
        let mut rows = rows.into_iter();
        loop {
            let batch: Vec<Row> = rows.by_ref().take(1000).collect();
            if batch.is_empty() {
                break;
            }
            live.push_many(batch).unwrap();
        }
    });
    run("push one at a time, max_events 10k", &rows, &mut |rows| {
        let opts = LiveOptions::new().max_events(10_000);
        let mut live = LiveSeries::with_options("live", schema(), opts).unwrap();
        one_by_one(&mut live, rows);
    });
    run("reorder, 5% late within 1s, grace 2s", &late, &mut |rows| {
        let opts = LiveOptions::new()
            .ordering(OrderingMode::Reorder)
            .grace_window("2s");
        let mut live = LiveSeries::with_options("live", schema(), opts).unwrap();
        one_by_one(&mut live, rows);
    });
    run(
        "filter + aggregate 1m, nothing watched",
        &rows,
        &mut |rows| {
            let mut live = LiveSeries::new("live", schema()).unwrap();
            live.filter(live.root(), busy).unwrap();
            live.aggregate(live.root(), &minute, &mapping).unwrap();
            one_by_one(&mut live, rows);
        },
    );
    run(
        "filter + aggregate 1m, every output watched",
        &rows,
        &mut |rows| {
            let mut live = LiveSeries::new("live", schema()).unwrap();
            let f = live.filter(live.root(), busy).unwrap();
            let a = live.aggregate(live.root(), &minute, &mapping).unwrap();
            live.watch(live.root(), OutputKind::Event).unwrap();
            live.watch(live.root(), OutputKind::Batch).unwrap();
            live.watch(f, OutputKind::Event).unwrap();
            for k in [OutputKind::Event, OutputKind::Bucket, OutputKind::Update] {
                live.watch(a, k).unwrap();
            }
            let outputs = one_by_one(&mut live, rows);
            assert!(outputs > 3 * N);
        },
    );
    run("filter + aggregate on max_events 10k", &rows, &mut |rows| {
        let opts = LiveOptions::new().max_events(10_000);
        let mut live = LiveSeries::with_options("live", schema(), opts).unwrap();
        let f = live.filter(live.root(), busy).unwrap();
        live.aggregate(f, &minute, &mapping).unwrap();
        live.watch(f, OutputKind::Evict).unwrap();
        one_by_one(&mut live, rows);
    });
    println!("{{{}}}", report.join(", "));
    Ok(())
}
