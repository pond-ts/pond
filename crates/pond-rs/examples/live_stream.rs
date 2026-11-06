//! A live series: push events as they arrive, keep a rolling average and
//! per-minute buckets up to date, and read what each push caused.
//!
//! Run with `cargo run --example live_stream`.

use pond_rs::live::{LiveOptions, LiveSeries, Output, OutputKind};
use pond_rs::{Agg, ColumnDef, ColumnKind, Reducer, Sequence};

fn main() -> pond_rs::Result<()> {
    let mut live = LiveSeries::with_options(
        "cpu",
        vec![
            ColumnDef::required("time", ColumnKind::Time),
            ColumnDef::required("host", ColumnKind::String),
            ColumnDef::required("load", ColumnKind::Number),
        ],
        // Keep the last 10 minutes of events.
        LiveOptions::new().max_age("10m"),
    )?;

    // A 30-second rolling average, emitted after every event.
    let rolling = live.rolling(live.root(), "30s", &[Agg::new("avg", "load", Reducer::Avg)])?;
    // Per-minute buckets, emitted when a minute closes.
    let minutes = live.aggregate(
        live.root(),
        &Sequence::every("1m")?,
        &[Agg::new("peak", "load", Reducer::Max)],
    )?;
    live.watch(rolling, OutputKind::Event)?;
    live.watch(minutes, OutputKind::Event)?;

    let events = [
        (0, "a", 0.30),
        (15_000, "b", 0.70),
        (40_000, "a", 0.50),
        (61_000, "b", 0.90),
        (75_000, "a", 0.20),
        (125_000, "b", 0.40),
    ];
    for (time, host, load) in events {
        for output in live.push(time, [Some(host.into()), Some(load.into())])? {
            // Each output names the node it came from.
            if let Output::Event { node, event } = output {
                if node == rolling.id() {
                    println!("t={time:>6}  30s average {:?}", event.number("avg")?);
                } else if node == minutes.id() {
                    println!(
                        "t={time:>6}  minute closed, peak {:?}",
                        event.number("peak")?
                    );
                }
            }
        }
    }
    println!("{} closed minutes kept", live[minutes].len());
    Ok(())
}
