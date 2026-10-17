//! # pond-rs
//!
//! A native Rust implementation of [pond](https://github.com/pond-ts/pond),
//! the time series analytics library. See `docs/rfcs/pond-rs.md` in the
//! repository for the plan.
//!
//! **Status: R1a, in progress.** What exists: time-keyed series of number
//! columns (gaps allowed), [`TimeSeries::rolling`] over a trailing time
//! window, [`TimeSeries::aggregate`] into fixed-length buckets
//! ([`Sequence::every`]) or calendar buckets in a time zone
//! ([`Sequence::calendar`]), and Arrow in and out
//! ([`TimeSeries::read_ipc`], [`TimeSeries::write_ipc`]). Results match
//! pond-ts bit for bit; the parity
//! harness under `tests/` checks that against pond-ts's own output
//! (`packages/core/test/fixtures/parity.json`).
//!
//! ```
//! use pond_rs::{Agg, Column, Reducer, Sequence, TimeSeries};
//!
//! let series = TimeSeries::new(
//!     "cpu",
//!     vec![0, 20_000, 40_000, 60_000, 80_000],
//!     vec![Column::optional("load", [Some(0.5), Some(0.7), None, Some(0.9), Some(0.4)])],
//! )?;
//! let per_minute = series.aggregate(
//!     &Sequence::every("1m")?,
//!     &[
//!         Agg::new("load_avg", "load", Reducer::Avg),
//!         Agg::new("load_n", "load", Reducer::Count),
//!     ],
//! )?;
//! assert_eq!(per_minute.len(), 2);
//! assert_eq!(per_minute.column("load_n").unwrap().get(0), Some(2.0)); // the gap is not counted
//!
//! // Calendar days in New York: the day clocks spring forward is 23 hours.
//! let days = Sequence::calendar("day", "America/New_York")?;
//! let keys = days.buckets_overlapping(1_772_946_000_000, 1_772_946_000_000)?; // 2026-03-08
//! assert_eq!(keys.end[0] - keys.begin[0], 23 * 3_600_000);
//! # Ok::<(), pond_rs::PondError>(())
//! ```

mod aggregate;
mod arrow;
mod column;
mod duration;
mod error;
mod reducer;
mod rolling;
mod sequence;
mod series;

pub use column::Float64Column;
pub use duration::parse_duration;
pub use error::{PondError, Result};
pub use reducer::{Agg, Reducer};
pub use sequence::{CalendarUnit, Sequence, tzdb_version};
pub use series::{Column, ColumnDef, ColumnKind, IntervalKeys, Key, MAX_TIME_MS, TimeSeries};

/// The version of this crate.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The Arrow crates pond-rs reads and writes, re-exported so callers use the
/// same versions.
pub use {arrow_array, arrow_schema};
