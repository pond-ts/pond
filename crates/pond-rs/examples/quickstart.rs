//! Build a series, roll a window over it and bucket it by calendar day in
//! a time zone.
//!
//! Run with `cargo run --example quickstart`.

use pond_rs::{Agg, Column, Reducer, Sequence, TimeSeries, parse_time_in};

fn main() -> pond_rs::Result<()> {
    // One reading every 6 hours across New York's spring-forward weekend.
    let start = parse_time_in("2026-03-07", "America/New_York")?;
    let times: Vec<i64> = (0..12).map(|i| start + i * 6 * 3_600_000).collect();
    let load = [0.4, 0.5, 0.9, 0.7, 0.3, 0.2, 0.8, 0.6, 0.5, 0.4, 0.7, 0.9];
    let cpu = TimeSeries::new("cpu", times, vec![Column::required("load", load.to_vec())])?;

    // A trailing 12-hour average next to each reading.
    let smoothed = cpu.rolling("12h", &[Agg::new("load_12h", "load", Reducer::Avg)])?;
    let averages = smoothed.column("load_12h")?.numbers()?;
    println!(
        "12h average at the last reading: {:?}",
        averages.get(averages.len() - 1)
    );

    // Calendar days in New York: 8 March 2026 is 23 hours long.
    let daily = cpu.aggregate(
        &Sequence::calendar("day", "America/New_York")?,
        &[
            Agg::new("peak", "load", Reducer::Max),
            Agg::new("readings", "load", Reducer::Count),
        ],
    )?;
    for row in daily.rows() {
        let hours = (row.end() - row.begin()) / 3_600_000;
        println!(
            "day of {hours}h: peak {:?} over {:?} readings",
            row.number("peak")?,
            row.number("readings")?
        );
    }
    Ok(())
}
