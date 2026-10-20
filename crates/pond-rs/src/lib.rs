//! # pond-rs
//!
//! A native Rust implementation of [pond](https://github.com/pond-ts/pond),
//! the time series analytics library. See `docs/rfcs/pond-rs.md` in the
//! repository for the plan.
//!
//! **Status: R1b, in progress** (the rest of the batch core). What exists:
//! series keyed by time, by time ranges or by intervals labelled with
//! numbers or text, with number, exact decimal, text, true/false and array
//! columns (gaps allowed; see [`Column`] and [`ArrayColumn`]),
//! [`TimeSeries::rolling`] over a trailing time window, [`TimeSeries::aggregate`] into fixed-length buckets
//! ([`Sequence::every`]) or calendar buckets in a time zone
//! ([`Sequence::calendar`]), [`TimeSeries::select`] / `rename` / `as_time`,
//! row-by-row [`TimeSeries::diff`] / `rate` / `pct_change` / `shift` /
//! `cumulative` / `fill`, picking rows with [`TimeSeries::slice`] /
//! `filter` (a closure over each [`Row`]) and changing columns with
//! `with_column` / `map_numbers` and its siblings, running any of these per
//! entity with [`TimeSeries::partition_by`] (partitions on several cores),
//! putting a series on a grid with [`TimeSeries::align`] /
//! [`TimeSeries::materialize`] and collapsing repeated keys with
//! [`TimeSeries::dedupe`], putting series side by side with
//! [`TimeSeries::join`] / [`TimeSeries::join_many`],
//! the trailing window with [`TimeSeries::tail`] and a whole-series
//! [`TimeSeries::reduce`],
//! finding rows by key or test with [`TimeSeries::bisect`] /
//! `at_or_before` / `at_or_after` / `nearest` / `find` (keys as
//! [`EventKey`]), picking a time span with [`TimeSeries::within`] /
//! `overlapping` / `trim` / `before` / `after`,
//! changing the key with [`TimeSeries::as_time_range`] /
//! `as_interval` / `offset_time`,
//! pond-ts's JSON formats with [`TimeSeries::from_json`] /
//! [`TimeSeries::to_json`] (rows), `from_columns_json` /
//! `to_columns_json` (one array per column) and `from_points_json` /
//! `to_points_json` (wide points for charts),
//! working with array columns through [`TimeSeries::array_contains`] /
//! `array_aggregate` / `array_explode`,
//! reading times written as text with [`parse_time`] / [`parse_time_in`]
//! (as pond-ts `Time.parse`),
//! and Arrow in and out for every key kind ([`TimeSeries::read_ipc`] with
//! [`ArrowKey`], [`TimeSeries::write_ipc`]). Results match
//! pond-ts bit for bit; the parity
//! harness under `tests/` checks that against pond-ts's own output
//! (`packages/core/test/fixtures/parity.json`).
//!
//! **Threads.** With the `parallel` feature (on by default; not on wasm32),
//! the output columns of one `rolling` or `aggregate` call are computed on
//! several cores (rayon's pool; `RAYON_NUM_THREADS` sets its size). Each
//! column is still computed by one thread, in order, so results are the same
//! bits on any number of threads. Partitions of a [`PartitionedSeries`] run
//! on several cores the same way: each partition is computed by one thread.
//!
//! **Memory.** Columns hold their values in Arrow buffers. Reading a
//! gap-free `Float64` field, a `Utf8` / `Dictionary<Int32, Utf8>` field or a
//! `Boolean` field from a one-batch Arrow file uses the file's memory
//! (or a `Decimal128` field) without copying (which keeps the file's bytes in memory while the
//! column lives), and writing hands each column's buffer to Arrow.
//!
//! ```
//! use pond_rs::{Agg, Column, Reducer, Sequence, TimeSeries, parse_time_in};
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
//! assert_eq!(per_minute.column("load_n")?.numbers()?.get(0), Some(2.0)); // the gap is not counted
//!
//! // Calendar days in New York: the day clocks spring forward is 23 hours.
//! let days = Sequence::calendar("day", "America/New_York")?;
//! let day = parse_time_in("2026-03-08", "America/New_York")?; // its start, as epoch ms
//! let keys = days.buckets_overlapping(day, day)?;
//! assert_eq!(keys.end[0] - keys.begin[0], 23 * 3_600_000);
//! # Ok::<(), pond_rs::PondError>(())
//! ```
//!
//! **Latest state per entity, and results that are not a series.** A
//! ranked table (one row per symbol, sorted by score) is not a
//! [`TimeSeries`], which is always in time order with its key first. Reduce
//! each partition's last window with [`TimeSeries::tail`] and
//! [`TimeSeries::reduce`], then write the table with the re-exported
//! [`arrow_array`] and [`arrow_ipc`]:
//!
//! ```
//! use std::sync::Arc;
//! use pond_rs::arrow_array::{ArrayRef, Float64Array, RecordBatch, StringArray};
//! use pond_rs::{Agg, Column, Reducer, TimeSeries, Value};
//!
//! let bars = TimeSeries::new(
//!     "bars",
//!     vec![0, 0, 60_000, 60_000, 120_000, 120_000],
//!     vec![
//!         Column::required("symbol", vec!["A", "B", "A", "B", "A", "B"]),
//!         Column::required("close", vec![10.0, 50.0, 11.0, 50.0, 14.0, 49.0]),
//!     ],
//! )?;
//! let mut scores: Vec<(String, f64)> = Vec::new();
//! for (key, part) in bars.partition_by(&["symbol"])?.iter() {
//!     let symbol = key[0].as_ref().and_then(Value::as_str).unwrap_or("");
//!     let last = part.tail("2m")?.reduce(&[
//!         Agg::new("mean", "close", Reducer::Avg),
//!         Agg::new("close", "close", Reducer::Last),
//!     ])?;
//!     if let (Some(mean), Some(close)) = (last.number("mean")?, last.number("close")?) {
//!         scores.push((symbol.to_string(), close - mean));
//!     }
//! }
//! scores.sort_by(|a, b| b.1.abs().total_cmp(&a.1.abs()));
//! let table = RecordBatch::try_from_iter([
//!     ("symbol", Arc::new(StringArray::from_iter_values(scores.iter().map(|s| &s.0))) as ArrayRef),
//!     ("score", Arc::new(scores.iter().map(|s| s.1).collect::<Float64Array>()) as ArrayRef),
//! ])
//! .expect("columns of one length");
//! assert_eq!(table.num_rows(), 2);
//! // tail("2m") keeps rows after 0: A's mean is 12.5, its close 14.
//! assert_eq!(scores[0], ("A".to_string(), 1.5));
//! // Write it with arrow_ipc::writer::FileWriter, as TimeSeries::write_ipc does.
//! # Ok::<(), pond_rs::PondError>(())
//! ```

mod aggregate;
mod array;
mod arrow;
mod column;
mod decimal;
mod duration;
mod error;
mod grid;
mod join;
mod json;
mod json_columns;
mod json_text;
mod par;
mod partition;
mod query;
mod reducer;
mod reshape;
mod rolling;
mod rows;
mod rowwise;
mod sequence;
mod series;
mod span;
mod time_parse;

pub use aggregate::Reduced;
pub use array::ArrayOptions;
pub use arrow::ArrowKey;
pub use column::{
    ArrayColumn, BooleanColumn, ColumnData, Decimal, DecimalColumn, Float64Column, Scalar,
    StringColumn, Value,
};
pub use duration::parse_duration;
pub use error::{PondError, Result};
pub use grid::{Align, AlignMethod, Keep, Materialize, Pick};
pub use join::{Join, JoinType, OnConflict};
pub use json::{JsonOptions, KeyOrder, RowFormat};
pub use partition::{PartitionKey, PartitionedSeries};
pub use query::{EventKey, Label};
pub use reducer::{Agg, Reducer};
pub use reshape::At;
pub use rows::Row;
pub use rowwise::{Fill, FillLimits, FirstRow};
pub use sequence::{CalendarUnit, Sequence, tzdb_version};
pub use series::{
    Column, ColumnDef, ColumnKind, IntervalKeys, Key, Labels, MAX_TIME_MS, TimeRangeKeys,
    TimeSeries,
};
pub use time_parse::{parse_time, parse_time_in};

/// The version of this crate.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The Arrow crates pond-rs reads and writes, re-exported so callers use the
/// same versions.
pub use {arrow_array, arrow_ipc, arrow_schema, serde_json};
