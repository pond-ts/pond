//! # pond-rs
//!
//! Time series analytics for Rust: rolling windows, time and calendar
//! buckets (time-zone and daylight-saving aware), joins, per-entity
//! partitions, 109 technical-analysis studies, trading calendars, and live
//! series that update as events arrive. Arrow and JSON in and out.
//!
//! pond-rs is the Rust implementation of [pond](https://pond-ts.org). The
//! TypeScript packages (`pond-ts`, `@pond-ts/financial`) and this crate
//! give the same results, bit for bit: a parity harness checks every
//! operation against output written by pond-ts. Pick the language that
//! fits the program; the numbers do not change.
//!
//! ```toml
//! [dependencies]
//! pond-rs = "0.1"
//! ```
//!
//! ## Where to start
//!
//! | You want to… | Start at |
//! |---|---|
//! | Build a series, or read one from Arrow or JSON | [`TimeSeries::new`], [`TimeSeries::read_ipc`], [`TimeSeries::from_json`] |
//! | Roll a window over it | [`TimeSeries::rolling`], [`TimeSeries::rolling_with`] |
//! | Bucket it by minute, day, month… in a time zone | [`TimeSeries::aggregate`] with [`Sequence::every`] or [`Sequence::calendar`] |
//! | Do the same per host, symbol or user | [`TimeSeries::partition_by`] |
//! | Line several series up | [`TimeSeries::join`], [`TimeSeries::align`], [`TimeSeries::materialize`] |
//! | Compute RSI, Bollinger bands, VWAP… | [`financial`] |
//! | Process events as they arrive | [`live`] (the `live` feature) |
//!
//! ## What is in the crate
//!
//! - **Series.** A [`TimeSeries`] is keyed by time, by time ranges or by
//!   intervals labelled with numbers or text. Value columns hold numbers,
//!   exact decimals, text, true/false values or arrays, and may have gaps
//!   ([`Column`], [`ColumnData`]). Keys are always in order.
//! - **Windows and buckets.** [`TimeSeries::rolling`] over a span of time or
//!   a count of rows (trailing, leading or centred), [`TimeSeries::aggregate`]
//!   into fixed-length or calendar buckets, [`TimeSeries::reduce`] over the
//!   whole series, with the built-in [`Reducer`]s (count, sum, avg, min,
//!   max, percentiles, stdev, unique, top, …).
//! - **Row by row.** [`TimeSeries::diff`], `rate`, `pct_change`, `shift`,
//!   `cumulative`, `fill`; [`TimeSeries::smooth`] (EMA, moving average,
//!   loess), [`TimeSeries::baseline`] and `outliers`, a fold of your own
//!   with [`TimeSeries::scan`].
//! - **Picking rows.** [`TimeSeries::filter`], `slice`, `within`, `trim`,
//!   `before`, `after`, `tail`, and lookups by key: [`TimeSeries::bisect`],
//!   `at_or_before`, `nearest`, `find`.
//! - **Reshaping.** [`TimeSeries::join`] / `join_many`, `concat`,
//!   `pivot_by_group`, `collapse`, `dedupe`, `align`, `materialize`;
//!   histograms with [`TimeSeries::by_column`]; rows keyed by a number
//!   column instead of time with [`TimeSeries::by_value`] ([`ValueSeries`]).
//! - **Per entity.** [`TimeSeries::partition_by`] runs any of the above per
//!   group, on several cores.
//! - **In and out.** Arrow IPC files and record batches
//!   ([`TimeSeries::read_ipc`], [`TimeSeries::write_ipc`],
//!   [`TimeSeries::to_arrow`]); pond's JSON formats (rows, columns,
//!   chart points); times written as text with [`parse_time`] /
//!   [`parse_time_in`].
//! - **Finance.** [`financial`]: 109 studies (moving averages, bands,
//!   momentum, trend, volatility, volume, statistics, price, per session),
//!   each checked against a pandas / TA-Lib oracle, trading calendars, and a
//!   [`catalog`](financial::catalog) describing every study for menus and
//!   agents.
//! - **Live.** [`live`]: a [`LiveSeries`](live::LiveSeries) takes events as
//!   they arrive and keeps filters, rolling windows, bucket aggregations and
//!   per-entity partitions up to date, returning what each push caused.
//!
//! Every call returns [`Result`]; a [`PondError`] names the call and the
//! column, so the input can be fixed without reading pond-rs source.
//!
//! ## Cargo features
//!
//! | Feature | Default | What it does |
//! |---|---|---|
//! | `parallel` | on | Independent output columns, partitions and loess rows run on several cores (rayon). Results are the same bits either way. Does nothing on wasm32. |
//! | `live` | on | The [`live`] module. |
//!
//! With `default-features = false` you get the batch core and
//! [`financial`], on one thread.
//!
//! ## Threads and memory
//!
//! **Threads.** With the `parallel` feature (on by default; not on wasm32),
//! the output columns of one `rolling` or `aggregate` call are computed on
//! several cores (rayon's pool; `RAYON_NUM_THREADS` sets its size). Each
//! column is still computed by one thread, in order, so results are the same
//! bits on any number of threads. Partitions of a [`PartitionedSeries`] run
//! on several cores the same way: each partition is computed by one thread.
//! Loess fits each row on its own, so its rows are spread over the cores.
//!
//! **Memory.** Columns hold their values in Arrow buffers. Reading a
//! gap-free `Float64` field, a `Utf8` / `Dictionary<Int32, Utf8>` field or a
//! `Boolean` field from a one-batch Arrow file uses the file's memory
//! (or a `Decimal128` field) uses the file's memory without copying (the
//! file's bytes stay in memory while the column lives), and writing hands
//! each column's buffer to Arrow.
//!
//! ## Example
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
//! ## Results that are not a series
//!
//! **Latest state per entity.** A
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

#![warn(missing_docs)]
#![cfg_attr(docsrs, feature(doc_cfg))]

mod aggregate;
mod array;
mod arrow;
mod bycolumn;
mod column;
mod decimal;
mod duration;
mod elements;
mod error;
mod expr;
mod expr_ops;
pub mod financial;
mod grid;
mod join;
mod json;
mod json_columns;
mod json_text;
#[cfg(feature = "live")]
pub mod live;
mod par;
mod partition;
mod pivot;
mod query;
mod reducer;
mod reshape;
mod rolling;
mod rows;
mod rowwise;
mod sequence;
mod series;
mod smooth;
mod span;
mod time_parse;
mod value_series;

pub use aggregate::Reduced;
pub use array::ArrayOptions;
pub use arrow::ArrowKey;
pub use bycolumn::{Bins, Table};
pub use column::{
    ArrayColumn, BooleanColumn, ColumnData, Decimal, DecimalColumn, Float64Column, Scalar,
    StringColumn, Value,
};
pub use duration::parse_duration;
pub use error::{PondError, Result};
pub use expr::{Expr, Literal, col, lit, when};
pub use grid::{Align, AlignMethod, Keep, Materialize, Pick};
pub use join::{Join, JoinType, OnConflict};
pub use json::{JsonOptions, KeyOrder, RowFormat};
pub use partition::{PartitionKey, PartitionedSeries};
pub use pivot::Pivot;
pub use query::{EventKey, Label};
pub use reducer::{Agg, Reducer};
pub use reshape::At;
pub use rolling::{Alignment, Rolling, RollingOver};
pub use rows::Row;
pub use rowwise::{Change, Fill, FillLimits, FirstRow};
pub use sequence::{CalendarUnit, Sequence, tzdb_version};
pub use series::{
    Column, ColumnDef, ColumnKind, IntervalKeys, Key, Labels, MAX_TIME_MS, TimeRangeKeys,
    TimeSeries,
};
pub use smooth::{Sample, Smooth};
pub use time_parse::{parse_time, parse_time_in};
pub use value_series::ValueSeries;

// The README's example, run as a doctest so it cannot drift.
#[cfg(doctest)]
#[doc = include_str!("../README.md")]
struct ReadmeDoctests;

/// The version of this crate.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The Arrow crates pond-rs reads and writes, re-exported so callers use the
/// same versions.
pub use {arrow_array, arrow_ipc, arrow_schema, serde_json};
