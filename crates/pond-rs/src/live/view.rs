//! A view: a node that holds the events of its source a step lets through
//! (pond-ts `LiveView`). Step 2 builds `filter`; `map`, `select`, `sample`,
//! `window` and the row-by-row views come in step 3.

use std::sync::Arc;

use crate::error::Result;
use crate::query::EventKey;
use crate::series::{ColumnDef, TimeSeries};

use super::buffer::EventBuffer;
use super::event::{LiveEvent, LiveSchema};

/// What a view does with each source event: the event it keeps, if any.
pub(crate) type Step = Box<dyn FnMut(&LiveEvent) -> Option<LiveEvent> + Send>;

/// A view built from a [`LiveSeries`](super::LiveSeries) or another node:
/// the events of its source that pass its step, in key order, read through
/// the owner (`live.get(node)?` or `live[node]`).
///
/// It drops the events its source drops: when the source evicts (retention
/// or `clear`), the view removes every event that starts at or before the
/// last one evicted, and says so with its own `Evict` output.
pub struct LiveView {
    pub(crate) name: String,
    pub(crate) schema: Arc<LiveSchema>,
    pub(crate) buffer: EventBuffer,
    pub(crate) step: Step,
}

impl std::fmt::Debug for LiveView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveView")
            .field("name", &self.name)
            .field("len", &self.buffer.len())
            .finish_non_exhaustive()
    }
}

impl LiveView {
    pub(crate) fn new<'a>(
        name: String,
        schema: Arc<LiveSchema>,
        mut step: Step,
        history: impl Iterator<Item = &'a LiveEvent>,
    ) -> Self {
        let mut buffer = EventBuffer::default();
        for event in history {
            if let Some(kept) = step(event) {
                buffer.insert(kept);
            }
        }
        Self {
            name,
            schema,
            buffer,
            step,
        }
    }

    /// Run the step on one source event; the event kept, now held.
    pub(crate) fn take(&mut self, event: &LiveEvent) -> Option<LiveEvent> {
        let kept = (self.step)(event)?;
        self.buffer.insert(kept.clone());
        Some(kept)
    }

    /// Mirror a source eviction: drop held events starting at or before
    /// the last evicted one. The events dropped.
    pub(crate) fn mirror_evict(&mut self, evicted: &[LiveEvent]) -> Vec<LiveEvent> {
        let Some(cutoff) = evicted.last().map(LiveEvent::begin) else {
            return Vec::new();
        };
        let n = self.buffer.events.partition_point(|e| e.begin() <= cutoff);
        self.buffer.evict(n, true)
    }

    /// The source's name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The schema, key column first.
    pub fn schema(&self) -> &[ColumnDef] {
        &self.schema.columns
    }

    /// Number of events held.
    pub fn len(&self) -> usize {
        self.buffer.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buffer.len() == 0
    }

    /// The event at `index`; negative positions count from the end.
    pub fn at(&self, index: i64) -> Option<&LiveEvent> {
        self.buffer.at(index)
    }

    pub fn first(&self) -> Option<&LiveEvent> {
        self.buffer.at(0)
    }

    pub fn last(&self) -> Option<&LiveEvent> {
        self.buffer.at(-1)
    }

    /// Every event held, oldest first.
    pub fn events(&self) -> impl ExactSizeIterator<Item = &LiveEvent> {
        self.buffer.events.iter()
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
    pub fn at_or_before(&self, key: impl Into<EventKey>) -> Option<&LiveEvent> {
        self.buffer.at_or_before(&key.into())
    }

    /// The event with this key, or the nearest one after it.
    pub fn at_or_after(&self, key: impl Into<EventKey>) -> Option<&LiveEvent> {
        self.buffer.at_or_after(&key.into())
    }

    /// The first event `test` accepts.
    pub fn find(&self, mut test: impl FnMut(&LiveEvent) -> bool) -> Option<&LiveEvent> {
        self.buffer.events.iter().find(|e| test(e))
    }

    /// Whether `test` accepts some event (`false` when empty).
    pub fn some(&self, test: impl FnMut(&LiveEvent) -> bool) -> bool {
        self.buffer.events.iter().any(test)
    }

    /// Whether `test` accepts every event (`true` when empty).
    pub fn every(&self, test: impl FnMut(&LiveEvent) -> bool) -> bool {
        self.buffer.events.iter().all(test)
    }

    /// The events held, as a batch series named after the source.
    pub fn to_time_series(&self) -> Result<TimeSeries> {
        self.buffer
            .snapshot("LiveView::to_time_series", &self.name, &self.schema)
    }
}
