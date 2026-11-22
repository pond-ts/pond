//! One Rust measurement: `measure <market|telemetry> <rows> <runs>
//! <request.json>`. The Rust half of
//! `packages/financial/scripts/measure/run.mjs`; makes the same data as
//! `workloads.mjs` (the same 32-bit generator, the same arithmetic in the
//! same order), runs the request through a fresh [`Host`] `runs` times and
//! once more warm, and prints one JSON line.
//!
//! With `ask` in place of `<runs>` it runs the request once and prints the
//! wire response without timings, or the error: the agent trial's tool
//! (`bench/agent-trial/`).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use pond_process::{Host, Registry, basic_ops, study_ops, summary_folds};
use pond_rs::{Column, TimeSeries};
use serde_json::{Value, json};

/// mulberry32, as `generator` in `workloads.mjs`.
struct Generator(u32);

impl Generator {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let s = self.0;
        let mut t = (s ^ (s >> 15)).wrapping_mul(1 | s);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

type Columns = (Vec<i64>, Vec<(&'static str, Vec<f64>)>);

fn market(n: usize) -> Columns {
    let mut rnd = Generator(0x5eed);
    let (mut time, mut open, mut high, mut low, mut close, mut volume) = (
        Vec::with_capacity(n),
        Vec::with_capacity(n),
        Vec::with_capacity(n),
        Vec::with_capacity(n),
        Vec::with_capacity(n),
        Vec::with_capacity(n),
    );
    let mut price: f64 = 100.0;
    for i in 0..n {
        let drift = (rnd.next() - 0.5) * 0.04 * price;
        let o = price;
        let c = f64::max(1.0, price + drift);
        time.push(i as i64 * 86_400_000);
        open.push(o);
        close.push(c);
        high.push(o.max(c) + rnd.next() * 0.01 * price);
        low.push(o.min(c) - rnd.next() * 0.01 * price);
        volume.push((rnd.next() * 1_000_000.0).floor());
        price = c;
    }
    (
        time,
        vec![
            ("open", open),
            ("high", high),
            ("low", low),
            ("close", close),
            ("volume", volume),
        ],
    )
}

// `min(max(..))`, not `clamp`, to read as `workloads.mjs` does.
#[allow(clippy::manual_clamp)]
fn telemetry(n: usize) -> Columns {
    let mut rnd = Generator(0x7e1e);
    let (mut time, mut cpus, mut mems, mut latency, mut requests, mut errors) = (
        Vec::with_capacity(n),
        Vec::with_capacity(n),
        Vec::with_capacity(n),
        Vec::with_capacity(n),
        Vec::with_capacity(n),
        Vec::with_capacity(n),
    );
    let (mut cpu, mut mem): (f64, f64) = (40.0, 60.0);
    for i in 0..n {
        cpu = f64::min(100.0, f64::max(0.0, cpu + (rnd.next() - 0.5) * 4.0));
        mem = f64::min(100.0, f64::max(0.0, mem + (rnd.next() - 0.5) * 0.5));
        let spike = if rnd.next() < 0.001 {
            400.0 * rnd.next()
        } else {
            0.0
        };
        time.push(i as i64 * 1_000);
        cpus.push(cpu);
        mems.push(mem);
        latency.push(20.0 + rnd.next() * 10.0 + spike);
        requests.push(100.0 + (rnd.next() * 900.0).floor());
        errors.push((rnd.next() * rnd.next() * 10.0).floor());
    }
    (
        time,
        vec![
            ("cpu", cpus),
            ("mem", mems),
            ("latency", latency),
            ("requests", requests),
            ("errors", errors),
        ],
    )
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1e3
}

/// The process's memory peak, in MB (Linux; 0 elsewhere).
fn peak_rss_mb() -> f64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("VmHWM:"))
                .and_then(|l| l.split_whitespace().nth(1)?.parse::<f64>().ok())
        })
        .map_or(0.0, |kb| kb / 1024.0)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let [_, workload, rows, runs, request] = &args[..] else {
        eprintln!("usage: measure <market|telemetry> <rows> <runs> <request.json>");
        std::process::exit(2);
    };
    let rows: usize = rows.parse().expect("rows");
    let ask = runs == "ask";
    let runs: usize = if ask { 1 } else { runs.parse().expect("runs") };
    let request: Value =
        serde_json::from_str(&std::fs::read_to_string(request).expect("read request"))
            .expect("parse request");

    let mut registry = Registry::standard();
    for def in basic_ops()
        .into_iter()
        .chain(summary_folds())
        .chain(study_ops())
    {
        registry.define(def).expect("define");
    }
    let registry = Arc::new(registry);

    let t = Instant::now();
    let (time, columns) = match workload.as_str() {
        "market" => market(rows),
        "telemetry" => telemetry(rows),
        other => panic!("unknown workload '{other}'"),
    };
    let generate_ms = ms(t);

    let t = Instant::now();
    let columns = columns
        .into_iter()
        .map(|(name, values)| Column::optional_raw(name, values))
        .collect();
    let series = Arc::new(TimeSeries::new(workload.as_str(), time, columns).expect("series"));
    let load_ms = ms(t);

    if ask {
        let mut host = Host::new(registry.clone(), HashMap::new());
        host.add("d", series.clone());
        let out = match host.run(&request) {
            Ok(result) => {
                let mut wire = result.to_wire(None);
                for node in wire["nodes"].as_array_mut().into_iter().flatten() {
                    if let Some(node) = node.as_object_mut() {
                        node.remove("ms");
                    }
                }
                wire
            }
            Err(e) => json!({ "error": e.to_string() }),
        };
        println!("{}", serde_json::to_string_pretty(&out).expect("json"));
        return;
    }

    // THREADS sets how many steps may run at once (default 1).
    let threads: usize = std::env::var("THREADS")
        .ok()
        .and_then(|t| t.parse().ok())
        .unwrap_or(1);
    // MIN_ROWS moves the row count below which threads are not used.
    let min_rows: usize = std::env::var("MIN_ROWS")
        .ok()
        .and_then(|t| t.parse().ok())
        .unwrap_or(pond_process::PARALLEL_MIN_ROWS);
    let mut cold = vec![];
    let mut host = None;
    let mut result = None;
    for _ in 0..runs {
        // Drop the last run's host first, as the TypeScript side lets its
        // last host go: two graphs alive at once would double the peak.
        drop(host.take());
        drop(result.take());
        let mut h = Host::new(registry.clone(), HashMap::new())
            .with_threads(threads)
            .with_parallel_min_rows(min_rows);
        h.add("d", series.clone());
        let t = Instant::now();
        result = Some(h.run(&request).expect("run"));
        cold.push(ms(t));
        host = Some(h);
    }
    let mut host = host.expect("at least one run");
    let t = Instant::now();
    host.run(&request).expect("warm run");
    let warm_ms = ms(t);

    let wire = result.expect("a result").to_wire(None);
    println!(
        "{}",
        json!({
            "language": "rust",
            "workload": workload,
            "rows": rows,
            "generateMs": generate_ms,
            "loadMs": load_ms,
            "coldMs": cold,
            "warmMs": warm_ms,
            "peakRssMb": peak_rss_mb(),
            "retainedMb": host.graph_for("d").expect("graph").retained_bytes() as f64 / 1_048_576.0,
            "nodes": wire["nodes"].as_array().unwrap().iter().map(|n| json!([n["id"], n["ms"]])).collect::<Vec<_>>(),
            "facts": wire["facts"],
            "skipped": wire["skipped"],
        })
    );
}
