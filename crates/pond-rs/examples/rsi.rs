//! Technical-analysis studies on price bars: RSI and Bollinger bands.
//!
//! Run with `cargo run --example rsi`.

use pond_rs::financial::{Bollinger, Study};
use pond_rs::{Column, TimeSeries};

fn main() -> pond_rs::Result<()> {
    // Daily closes, one bar per day (epoch milliseconds).
    let closes = [
        44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61,
        46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45,
    ];
    let times: Vec<i64> = (0..closes.len() as i64).map(|i| i * 86_400_000).collect();
    let bars = TimeSeries::new(
        "bars",
        times,
        vec![Column::required("close", closes.to_vec())],
    )?;

    // Each study adds its columns and keeps every row; the first rows,
    // before a full window, are gaps.
    let out = bars.rsi(Study::period(14))?.bollinger(Bollinger::new(20))?;

    for row in out.rows().skip(19) {
        println!(
            "close {:>6.2}  rsi {:>6.2}  bands {:>6.2} .. {:>6.2}",
            row.number("close")?.unwrap_or(f64::NAN),
            row.number("rsi")?.unwrap_or(f64::NAN),
            row.number("bbLower")?.unwrap_or(f64::NAN),
            row.number("bbUpper")?.unwrap_or(f64::NAN),
        );
    }
    Ok(())
}
