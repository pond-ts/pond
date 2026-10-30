# pond-rs

[![crates.io](https://img.shields.io/crates/v/pond-rs.svg)](https://crates.io/crates/pond-rs)
[![docs.rs](https://img.shields.io/docsrs/pond-rs)](https://docs.rs/pond-rs)
[![MIT licensed](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Time series analytics for Rust.

- **Rolling windows** over a span of time or a count of rows.
- **Buckets** of fixed length, or calendar days, weeks, months in any time
  zone (a daylight-saving day is 23 or 25 hours, as it should be).
- **Per entity**: run any operation per host, symbol or user, on several
  cores.
- **Joins, alignment, reshaping**: line series up on a grid, pivot, dedupe,
  histograms.
- **109 technical-analysis studies** (RSI, MACD, Bollinger, VWAP,
  Ichimoku, …), each checked against a pandas / TA-Lib oracle, plus
  trading calendars.
- **Live series** that take events as they arrive and keep filters,
  rolling windows, bucket aggregations and partitions up to date.
- **Arrow IPC and JSON** in and out; columns read from Arrow without
  copying.

pond-rs is the Rust implementation of [pond](https://pond-ts.org). It gives
the same results as the TypeScript packages, bit for bit: a parity harness
checks every operation against output written by pond-ts.

## Install

```toml
[dependencies]
pond-rs = "0.1"
```

The library is imported as `pond_rs`. It needs Rust 1.88 or newer.

## Example

```rust
use pond_rs::{Agg, Column, Reducer, Sequence, TimeSeries, parse_time_in};

fn main() -> pond_rs::Result<()> {
    // Readings every 6 hours across New York's spring-forward weekend.
    let start = parse_time_in("2026-03-07", "America/New_York")?;
    let times: Vec<i64> = (0..12).map(|i| start + i * 6 * 3_600_000).collect();
    let load = vec![0.4, 0.5, 0.9, 0.7, 0.3, 0.2, 0.8, 0.6, 0.5, 0.4, 0.7, 0.9];
    let cpu = TimeSeries::new("cpu", times, vec![Column::required("load", load)])?;

    // One row per calendar day in New York.
    let daily = cpu.aggregate(
        &Sequence::calendar("day", "America/New_York")?,
        &[Agg::new("peak", "load", Reducer::Max)],
    )?;
    for row in daily.rows() {
        let hours = (row.end() - row.begin()) / 3_600_000;
        println!("{hours}h day, peak {:?}", row.number("peak")?); // 24h, 23h, 24h
    }
    Ok(())
}
```

More in [`examples/`](examples): `quickstart`, `rsi` (finance studies) and
`live_stream` (live series). Run one with `cargo run --example rsi`.

## Cargo features

| Feature    | Default | What it does                                                                                              |
| ---------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `parallel` | on      | Output columns, partitions and loess rows run on several cores (rayon). Same results on any thread count. |
| `live`     | on      | The `live` module: series that take events as they arrive.                                                |

`default-features = false` leaves the batch core and the finance studies, on
one thread. The crate also builds for `wasm32-unknown-unknown` (one thread).

## Documentation

- API reference: [docs.rs/pond-rs](https://docs.rs/pond-rs)
- Guide: [pond-ts.org/docs/pond-rs](https://pond-ts.org/docs/pond-rs/getting-started)
- Coming from pond-ts, pandas or polars: the guide's comparison pages.

## Versions

pond-rs is before 1.0: a minor version (0.1 to 0.2) may change the API.
Each release notes the pond-ts version its results are checked against.

## License

MIT. See [LICENSE](LICENSE).
