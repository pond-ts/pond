//! A series inside the owner: the root, a partition of
//! [`LiveSeries::partition_by`](super::LiveSeries::partition_by), or what
//! [`LiveSeries::collect`](super::LiveSeries::collect) /
//! [`LiveSeries::apply`](super::LiveSeries::apply) gather (pond-ts
//! `LiveSeries`, all of them).

use std::sync::Arc;

use crate::error::Result;
use crate::query::EventKey;
use crate::series::{ColumnDef, TimeSeries};

use super::buffer::EventBuffer;
use super::event::{LiveEvent, LiveSchema};
use super::{LiveStats, OrderingMode};

/// A live series held by a [`LiveSeries`](super::LiveSeries) owner: a
/// partition, or the series `collect` and `apply` gather into. It takes
/// events from its source (not from pushes), keeps them under its own
/// ordering and retention, and anything built on it updates as they
/// arrive. Read it through the owner (`live[node]`).
pub struct SubSeries {
    pub(crate) name: String,
    pub(crate) schema: Arc<LiveSchema>,
    pub(crate) ordering: OrderingMode,
    pub(crate) grace_ms: Option<i64>,
    pub(crate) max_events: Option<usize>,
    pub(crate) max_age_ms: Option<i64>,
    pub(crate) buffer: EventBuffer,
    pub(crate) ingested: u64,
    pub(crate) evicted: u64,
    pub(crate) rejected: u64,
    /// pond-ts keeps a strict, time-keyed series fed by pushes (the root,
    /// and partitions of one) in column chunks: a batch is stored whole
    /// before any listener runs, and partitions built on it are handed the
    /// batch before the series' own `event` listeners.
    pub(crate) chunked: bool,
}

impl std::fmt::Debug for SubSeries {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SubSeries")
            .field("name", &self.name)
            .field("len", &self.buffer.len())
            .finish_non_exhaustive()
    }
}

impl SubSeries {
    pub(crate) fn new(
        name: String,
        schema: Arc<LiveSchema>,
        ordering: OrderingMode,
        grace_ms: Option<i64>,
        max_events: Option<usize>,
        max_age_ms: Option<i64>,
        chunked: bool,
    ) -> Self {
        Self {
            name,
            buffer: EventBuffer::new(Arc::clone(&schema)),
            schema,
            ordering,
            grace_ms,
            max_events,
            max_age_ms,
            ingested: 0,
            evicted: 0,
            rejected: 0,
            chunked,
        }
    }

    /// How many of the oldest events retention drops now.
    pub(crate) fn retention_count(&self) -> usize {
        let len = self.buffer.len();
        let mut n = self.max_events.map_or(0, |m| len.saturating_sub(m));
        if let (Some(age), Some(latest)) = (self.max_age_ms, self.buffer.back_begin()) {
            n = n.max(self.buffer.count_before(latest - age));
        }
        n
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// The schema, key column first.
    pub fn schema(&self) -> &[ColumnDef] {
        &self.schema.columns
    }

    /// The ordering mode it keeps events in.
    pub fn ordering(&self) -> OrderingMode {
        self.ordering
    }

    /// The grace window in ms, under [`OrderingMode::Reorder`] when set.
    pub fn grace_window_ms(&self) -> Option<i64> {
        self.grace_ms
    }

    /// Number of events held.
    pub fn len(&self) -> usize {
        self.buffer.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buffer.len() == 0
    }

    /// The event at `index`; negative positions count from the end. Built
    /// from the stored cells (a copy).
    pub fn at(&self, index: i64) -> Option<LiveEvent> {
        self.buffer.at(index)
    }

    pub fn first(&self) -> Option<LiveEvent> {
        self.buffer.at(0)
    }

    pub fn last(&self) -> Option<LiveEvent> {
        self.buffer.at(-1)
    }

    /// Every event held, oldest first, each built from the stored cells.
    pub fn events(&self) -> impl ExactSizeIterator<Item = LiveEvent> + '_ {
        self.buffer.iter()
    }

    /// Where `key` would go: the first event not before it.
    pub fn bisect(&self, key: impl Into<EventKey>) -> usize {
        self.buffer.bisect(&key.into())
    }

    /// Whether an event has exactly this key.
    pub fn includes_key(&self, key: impl Into<EventKey>) -> bool {
        self.buffer.includes_key(&key.into())
    }

    /// The event with this key, or the nearest one before it.
    pub fn at_or_before(&self, key: impl Into<EventKey>) -> Option<LiveEvent> {
        self.buffer.at_or_before(&key.into())
    }

    /// The event with this key, or the nearest one after it.
    pub fn at_or_after(&self, key: impl Into<EventKey>) -> Option<LiveEvent> {
        self.buffer.at_or_after(&key.into())
    }

    /// The first event `test` accepts.
    pub fn find(&self, mut test: impl FnMut(&LiveEvent) -> bool) -> Option<LiveEvent> {
        self.buffer.iter().find(|e| test(e))
    }

    /// Whether `test` accepts some event (`false` when empty).
    pub fn some(&self, mut test: impl FnMut(&LiveEvent) -> bool) -> bool {
        self.buffer.iter().any(|e| test(&e))
    }

    /// Whether `test` accepts every event (`true` when empty).
    pub fn every(&self, mut test: impl FnMut(&LiveEvent) -> bool) -> bool {
        self.buffer.iter().all(|e| test(&e))
    }

    /// Latest start minus earliest start, ms (0 with fewer than two
    /// events).
    pub fn time_range(&self) -> i64 {
        self.buffer.time_range()
    }

    /// Events per second over [`SubSeries::time_range`] (0 when that is
    /// 0).
    pub fn event_rate(&self) -> f64 {
        self.buffer.event_rate()
    }

    pub fn stats(&self) -> LiveStats {
        LiveStats {
            ingested: self.ingested,
            evicted: self.evicted,
            rejected: self.rejected,
            length: self.buffer.len(),
            earliest: self.buffer.front_begin(),
            latest: self.buffer.back_begin(),
        }
    }

    /// The events held, as a batch series (copied).
    pub fn to_time_series(&self) -> Result<TimeSeries> {
        self.buffer
            .snapshot("LiveSeries::to_time_series", &self.name)
    }
}
