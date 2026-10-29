//! Timing for the live layer: 1M events pushed into a `LiveSeries` (100 ms
//! apart; host text, cpu and mem numbers, ~2% gaps), with and without nodes
//! built on it; same data and steps as `bench/live_pond_ts.mjs` for the
//! pond-ts side.
//!
//!     cargo run --release -p pond-rs --example perf_live
//!
//! Cost per event: the row check (one pass over its cells), an append to
//! each stored column (a late event under `reorder`: an insert in each,
//! moving the cells after it), and per node one step: a filter's test, an
//! aggregation's add to each output column of the open bucket (plus a
//! lookup in the open buckets, O(log open)). Each view stores a copy of the
//! cells it keeps (a text cell allocates). Retention drops from the front,
//! O(evicted). Watched outputs add one shared event (two reference counts)
//! per output; a watched `Bucket` builds the bucket's snapshot each time.
//! The step 3 views (`map`, `select`, `sample`, `window`, `diff` / `rate` /
//! `pct_change`, `fill`, `cumulative`) each build at most one new event per
//! source event, O(columns); a time window trims from the front.
//! Step 4: a rolling window adds each event to every output column's state
//! and removes what leaves the window (sum / avg / count / stdev O(1), min
//! / max amortised O(1) with a monotonic queue, percentiles O(log w)), then
//! emits one event, kept unless `History` limits it; fused windows share
//! one buffer and each evicts from its own head. `reduce` adds each event
//! and removes each one the source evicts, then emits once per push.

use std::time::Instant;

use pond_rs::live::{
    CollectOptions, History, LiveOptions, LiveSeries, OrderingMode, OutputKind, PartitionOptions,
    RollingOptions, RollingWindow, Trigger,
};
use pond_rs::{
    Agg, Column, ColumnDef, ColumnKind, Fill, Float64Column, Reducer, Sample, Sequence,
    StringColumn, TimeSeries, Value,
};

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
    // ONLY=<text> times just the cases whose name contains it.
    let only = std::env::var("ONLY").unwrap_or_default();
    let wanted = |name: &str| name.contains(only.as_str());
    let mut run = |name: &str, input: &Vec<Row>, f: &mut dyn FnMut(Vec<Row>)| {
        if !wanted(name) {
            return;
        }
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
    // Step 3 views, each on a root that keeps 10k events (views mirror
    // its evictions), so memory stays flat as in a real dashboard.
    let capped = || {
        let opts = LiveOptions::new().max_events(10_000);
        LiveSeries::with_options("live", schema(), opts).unwrap()
    };
    run(
        "diff + rate + pct_change, max_events 10k",
        &rows,
        &mut |rows| {
            let mut live = capped();
            let root = live.root();
            live.diff(root, &["cpu"]).unwrap();
            live.rate(root, &["cpu"]).unwrap();
            live.pct_change(root, &["mem"]).unwrap();
            one_by_one(&mut live, rows);
        },
    );
    run(
        "fill hold + cumulative sum, max_events 10k",
        &rows,
        &mut |rows| {
            let mut live = capped();
            let root = live.root();
            live.fill_all(root, Fill::Hold).unwrap();
            live.cumulative(root, &[("cpu", Reducer::Sum)]).unwrap();
            one_by_one(&mut live, rows);
        },
    );
    run(
        "map + select + sample 10, max_events 10k",
        &rows,
        &mut |rows| {
            let mut live = capped();
            let root = live.root();
            live.map(root, |e| {
                let mut v = e.values().to_vec();
                if let Some(Value::Number(x)) = v[1] {
                    v[1] = Some(Value::Number(x * 2.0));
                }
                v
            })
            .unwrap();
            live.select(root, &["cpu"]).unwrap();
            live.sample(root, Sample::Stride(10)).unwrap();
            one_by_one(&mut live, rows);
        },
    );
    run("window 1000 rows + window 30s", &rows, &mut |rows| {
        let mut live = capped();
        let root = live.root();
        live.window_rows(root, 1000).unwrap();
        live.window(root, "30s").unwrap();
        one_by_one(&mut live, rows);
    });
    run(
        "reorder 5% late: diff + fill + window 30s",
        &late,
        &mut |rows| {
            let opts = LiveOptions::new()
                .ordering(OrderingMode::Reorder)
                .grace_window("2s")
                .max_events(10_000);
            let mut live = LiveSeries::with_options("live", schema(), opts).unwrap();
            let root = live.root();
            live.diff(root, &["cpu"]).unwrap();
            live.fill_all(root, Fill::Hold).unwrap();
            live.window(root, "30s").unwrap();
            one_by_one(&mut live, rows);
        },
    );
    // Step 4: rolling windows and reduce, on a root keeping 10k events.
    run(
        "rolling 30s avg + max + stdev, max_events 10k",
        &rows,
        &mut |rows| {
            let mut live = capped();
            let root = live.root();
            let m = [
                Agg::new("cpu_avg", "cpu", Reducer::Avg),
                Agg::new("mem_max", "mem", Reducer::Max),
                Agg::new("cpu_sd", "cpu", Reducer::Stdev),
            ];
            live.rolling(root, "30s", &m).unwrap();
            one_by_one(&mut live, rows);
        },
    );
    run(
        "rolling 100 rows avg, history off, update watched",
        &rows,
        &mut |rows| {
            let mut live = capped();
            let root = live.root();
            let opts = RollingOptions::new().history(History::Off);
            let r = live
                .rolling_rows(root, 100, &[Agg::of("cpu", Reducer::Avg)], &opts)
                .unwrap();
            live.watch(r, OutputKind::Update).unwrap();
            one_by_one(&mut live, rows);
        },
    );
    run(
        "fused rolling 1m + 5m + 15m avg, max_events 10k",
        &rows,
        &mut |rows| {
            let mut live = capped();
            let root = live.root();
            let windows = [
                RollingWindow::new("1m", &[Agg::new("cpu_1m", "cpu", Reducer::Avg)]),
                RollingWindow::new("5m", &[Agg::new("cpu_5m", "cpu", Reducer::Avg)]),
                RollingWindow::new("15m", &[Agg::new("cpu_15m", "cpu", Reducer::Avg)]),
            ];
            live.rolling_windows(root, &windows, &RollingOptions::new())
                .unwrap();
            one_by_one(&mut live, rows);
        },
    );
    run(
        "reduce avg + max + count, max_events 10k",
        &rows,
        &mut |rows| {
            let mut live = capped();
            let root = live.root();
            live.reduce(root, &mapping).unwrap();
            one_by_one(&mut live, rows);
        },
    );
    // Step 5: calendar buckets (the last bucket is kept, so only an event
    // in a new day does time-zone arithmetic).
    let ny_day = Sequence::calendar("day", "America/New_York")?;
    run(
        "aggregate daily New York, max_events 10k",
        &rows,
        &mut |rows| {
            let mut live = capped();
            let root = live.root();
            live.aggregate(root, &ny_day, &mapping).unwrap();
            one_by_one(&mut live, rows);
        },
    );
    // Step 6: partitions. 1000 hosts is the gRPC experiment's shape.
    let rows1k: Vec<Row> = rows
        .iter()
        .enumerate()
        .map(|(i, (t, row))| {
            let mut row = row.clone();
            row[0] = Some(Value::String(format!("h{}", i % 1000)));
            (*t, row)
        })
        .collect();
    let batches = |live: &mut LiveSeries, rows: Vec<Row>| {
        let mut rows = rows.into_iter();
        loop {
            let batch: Vec<Row> = rows.by_ref().take(1000).collect();
            if batch.is_empty() {
                break;
            }
            live.push_many(batch).unwrap();
        }
    };
    let none = PartitionOptions::new();
    let all = CollectOptions::new();
    run(
        "partition 4 hosts + collect, max_events 10k",
        &rows,
        &mut |rows| {
            let mut live = capped();
            let p = live.partition_by(live.root(), "host", &none).unwrap();
            live.collect(p, &all).unwrap();
            one_by_one(&mut live, rows);
        },
    );
    run(
        "partition 4 hosts: diff + fill each, collect",
        &rows,
        &mut |rows| {
            let mut live = capped();
            let p = live.partition_by(live.root(), "host", &none).unwrap();
            let chain = live
                .per_partition(p, |live, part| {
                    let d = live.diff(part, &["cpu"])?;
                    Ok(live.fill_all(d, Fill::Hold)?.id())
                })
                .unwrap();
            live.collect(chain, &all).unwrap();
            one_by_one(&mut live, rows);
        },
    );
    let every = |d: &str| RollingOptions::new().trigger(Trigger::every(d).unwrap());
    run(
        "partition 4 hosts: fused 1m + 5m every 1m",
        &rows,
        &mut |rows| {
            let mut live = capped();
            let p = live.partition_by(live.root(), "host", &none).unwrap();
            let windows = [
                RollingWindow::new("1m", &[Agg::new("cpu_1m", "cpu", Reducer::Avg)]),
                RollingWindow::new("5m", &[Agg::new("mem_5m", "mem", Reducer::Max)]),
            ];
            live.partition_rolling_windows(p, &windows, &every("1m"))
                .unwrap();
            one_by_one(&mut live, rows);
        },
    );
    let hundred = PartitionOptions::new().max_events(100);
    let avg = [Agg::of("cpu", Reducer::Avg)];
    run(
        "partition 1000 hosts, batches of 1000: rolling",
        &rows1k,
        &mut |rows| {
            let mut live = capped();
            let p = live.partition_by(live.root(), "host", &hundred).unwrap();
            let m = avg.clone();
            let chain = live
                .per_partition(p, move |live, part| Ok(live.rolling(part, "30s", &m)?.id()))
                .unwrap();
            live.collect(chain, &all).unwrap();
            batches(&mut live, rows);
        },
    );
    run(
        "partition 1000 hosts, batches of 1000: sync",
        &rows1k,
        &mut |rows| {
            let mut live = capped();
            let p = live.partition_by(live.root(), "host", &hundred).unwrap();
            live.partition_rolling(p, "30s", &avg, &every("10s"))
                .unwrap();
            batches(&mut live, rows);
        },
    );
    // Hosts declared up front (`groups`): each row is checked against
    // them before the push is stored.
    let names: Vec<String> = (0..1000).map(|i| format!("h{i}")).collect();
    let names: Vec<&str> = names.iter().map(String::as_str).collect();
    let declared = PartitionOptions::new().groups(&names).max_events(100);
    run(
        "partition 1000 declared hosts, batches of 1000: rolling",
        &rows1k,
        &mut |rows| {
            let mut live = capped();
            let p = live.partition_by(live.root(), "host", &declared).unwrap();
            let m = avg.clone();
            let chain = live
                .per_partition(p, move |live, part| Ok(live.rolling(part, "30s", &m)?.id()))
                .unwrap();
            live.collect(chain, &all).unwrap();
            batches(&mut live, rows);
        },
    );
    // The same rows as 1,000-row batch series, built before the clock: data
    // that already comes in columns (an Arrow chunk, a JSON read) pushed
    // with `push_series`, against `push_many` of the rows above.
    let chunks: Vec<TimeSeries> = rows.chunks(1000).map(chunk_series).collect();
    let mut run_chunks = |name: &str, f: &mut dyn FnMut(Vec<TimeSeries>)| {
        if !wanted(name) {
            return;
        }
        let ms = median_ms(|| chunks.clone(), f);
        println!("{name:<44} {ms:>9.1} ms");
        report.push(format!("\"{name}\": {ms:.2}"));
    };
    run_chunks("push_series, batches of 1000", &mut |chunks| {
        let mut live = LiveSeries::new("live", schema()).unwrap();
        for chunk in &chunks {
            live.push_series(chunk).unwrap();
        }
    });
    run_chunks(
        "push_series, batches of 1000: filter + aggregate 1m",
        &mut |chunks| {
            let mut live = LiveSeries::new("live", schema()).unwrap();
            live.filter(live.root(), busy).unwrap();
            live.aggregate(live.root(), &minute, &mapping).unwrap();
            for chunk in &chunks {
                live.push_series(chunk).unwrap();
            }
        },
    );
    println!("{{{}}}", report.join(", "));
    Ok(())
}

/// Rows as a batch series (host text, cpu and mem numbers).
fn chunk_series(rows: &[Row]) -> TimeSeries {
    let number = |i: usize| {
        Float64Column::from_options(rows.iter().map(|r| match r.1[i] {
            Some(Value::Number(x)) => Some(x),
            _ => None,
        }))
    };
    let host = StringColumn::from_options(rows.iter().map(|r| match &r.1[0] {
        Some(Value::String(s)) => Some(s.as_str()),
        _ => None,
    }));
    TimeSeries::new(
        "chunk",
        rows.iter().map(|r| r.0).collect(),
        vec![
            Column::optional("host", host),
            Column::optional("cpu", number(1)),
            Column::optional("mem", number(2)),
        ],
    )
    .unwrap()
}
