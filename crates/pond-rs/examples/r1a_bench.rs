//! pond-rs side of the R1a benchmark: Arrow IPC in → compute → Arrow IPC out.
//!
//!     cargo run --release -p pond-rs --example r1a_bench -- <A|B> <data.arrow> [runs] [dump-prefix]
//!
//! Same workloads and output line as `bench/pond_ts.mjs` and
//! `bench/polars_bench.py`: median read / compute / write ms over `runs`
//! timed runs (after one warm-up), and memory for one run: on Linux, the
//! peak resident size during the warm-up minus the size just before it (the
//! peak is reset first through `/proc/self/clear_refs`); `null` elsewhere. With a dump
//! prefix the warm-up's outputs are written to `<prefix>.<name>.arrow`.
//! Single-threaded.

use std::time::Instant;

use pond_rs::{Agg, Reducer, Sequence, TimeSeries};

const COLS: [&str; 4] = ["c0", "c1", "c2", "c3"];

fn mapping(reducers: &[(&str, Reducer)]) -> Vec<Agg> {
    COLS.iter()
        .flat_map(|c| {
            reducers
                .iter()
                .map(move |(name, r)| Agg::new(format!("{c}_{name}"), *c, *r))
        })
        .collect()
}

fn compute(
    workload: &str,
    series: &TimeSeries,
) -> pond_rs::Result<Vec<(&'static str, TimeSeries)>> {
    let agg = mapping(&[
        ("avg", Reducer::Avg),
        ("min", Reducer::Min),
        ("max", Reducer::Max),
        ("count", Reducer::Count),
    ]);
    match workload {
        "A" => Ok(vec![
            ("agg", series.aggregate(&Sequence::every("1m")?, &agg)?),
            (
                "roll",
                series.rolling(
                    "5m",
                    &mapping(&[("avg", Reducer::Avg), ("stdev", Reducer::Stdev)]),
                )?,
            ),
        ]),
        "B" => Ok(vec![(
            "agg",
            series.aggregate(&Sequence::calendar("day", "America/New_York")?, &agg)?,
        )]),
        other => panic!("unknown workload {other}"),
    }
}

struct Run {
    read: f64,
    compute: f64,
    write: f64,
    out: Vec<(&'static str, TimeSeries)>,
    ipc: Vec<(&'static str, Vec<u8>)>,
}

fn once(workload: &str, path: &str) -> pond_rs::Result<Run> {
    let bytes = std::fs::read(path).expect("read input");
    let ms = |t: Instant| t.elapsed().as_secs_f64() * 1000.0;
    let t = Instant::now();
    let series = TimeSeries::from_ipc_bytes("data", bytes, "time")?;
    let read = ms(t);
    let t = Instant::now();
    let out = compute(workload, &series)?;
    let compute = ms(t);
    let t = Instant::now();
    let mut ipc = Vec::new();
    for (name, s) in &out {
        let mut buf = Vec::new();
        s.write_ipc(&mut buf)?;
        ipc.push((*name, buf));
    }
    let write = ms(t);
    Ok(Run {
        read,
        compute,
        write,
        out,
        ipc,
    })
}

/// A `/proc/self/status` field, MB (Linux only).
fn status_mb(field: &str) -> Option<f64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let kb = status
        .lines()
        .find_map(|l| l.strip_prefix(field))?
        .trim()
        .trim_end_matches("kB")
        .trim()
        .parse::<f64>()
        .ok()?;
    Some(kb / 1024.0)
}

/// Reset the peak resident size to the current one and return the current
/// one, MB (Linux; `None` elsewhere). After this, `VmHWM` is the peak since
/// now, not since the process started.
fn reset_peak_mb() -> Option<f64> {
    std::fs::write("/proc/self/clear_refs", "5").ok()?;
    status_mb("VmRSS:")
}

fn median(mut xs: Vec<f64>) -> f64 {
    xs.sort_by(f64::total_cmp);
    xs[xs.len() / 2]
}

fn main() -> pond_rs::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let workload = args.first().expect("workload A or B").as_str();
    let path = args.get(1).expect("data.arrow").as_str();
    let runs: usize = args.get(2).map_or(7, |r| r.parse().expect("runs"));

    let base = reset_peak_mb();
    let warm = once(workload, path)?;
    let run_mem = base.zip(status_mb("VmHWM:")).map(|(b, p)| p - b);
    if let Some(prefix) = args.get(3) {
        for (name, bytes) in &warm.ipc {
            std::fs::write(format!("{prefix}.{name}.arrow"), bytes).expect("write dump");
        }
    }
    let output_mb = warm.ipc.iter().map(|(_, b)| b.len()).sum::<usize>() as f64 / 1048576.0;
    let rows: Vec<String> = warm
        .out
        .iter()
        .map(|(n, s)| format!("\"{n}\": {}", s.len()))
        .collect();
    // Every runner keeps only these numbers from the warm-up and frees the
    // rest before the timed runs, so each starts from the same state.
    drop(warm);

    let mut timings = Vec::new();
    for _ in 0..runs {
        let r = once(workload, path)?;
        timings.push((r.read, r.compute, r.write));
    }
    let pick = |f: fn(&(f64, f64, f64)) -> f64| median(timings.iter().map(f).collect());
    let input_mb = std::fs::metadata(path).map_or(0.0, |m| m.len() as f64 / 1048576.0);
    println!(
        "{{\"engine\": \"pond-rs\", \"threads\": 1, \"workload\": \"{workload}\", \"runs\": {runs}, \
         \"read_ms\": {:.1}, \"compute_ms\": {:.1}, \"write_ms\": {:.1}, \"total_ms\": {:.1}, \
         \"run_mem_mb\": {}, \"input_mb\": {input_mb:.1}, \"output_mb\": {output_mb:.1}, \
         \"output_rows\": {{{}}}}}",
        pick(|t| t.0),
        pick(|t| t.1),
        pick(|t| t.2),
        pick(|t| t.0 + t.1 + t.2),
        run_mem.map_or("null".into(), |m| format!("{m:.0}")),
        rows.join(", ")
    );
    Ok(())
}
