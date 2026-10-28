//! A view: a node that holds the events of its source a step lets through
//! (pond-ts `LiveView`): `filter`, `map`, `select`, `sample`, `window`,
//! `diff` / `rate` / `pct_change`, `fill` and `cumulative`.

use std::sync::Arc;

use crate::error::Result;
use crate::query::EventKey;
use crate::series::{ColumnDef, TimeSeries};

use super::buffer::EventBuffer;
use super::event::{LiveEvent, LiveSchema};

/// What a view does with each source event: the event it keeps, if any.
pub(crate) type Step = Box<dyn FnMut(&LiveEvent) -> Option<LiveEvent> + Send>;

/// How a `window` view trims itself after each event it takes.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Window {
    /// Keep the newest this many events.
    Rows(usize),
    /// Keep events starting no earlier than this many ms before the newest.
    Span(i64),
}

/// A view built from a [`LiveSeries`](super::LiveSeries) or another node:
/// the events of its source that pass its step, in key order, read through
/// the owner (`live.get(node)?` or `live[node]`).
///
/// It drops the events its source drops: when the source evicts (retention
/// or `clear`), the view removes every event that starts at or before the
/// last one evicted, and says so with its own `Evict` output. A `window`
/// view also trims itself after each event, silently (as pond-ts: no
/// `Evict` output, and views built on it keep what it trimmed). So a late
/// event older than a window's cutoff is trimmed at once but still handed
/// to views built on the window, which keep it.
///
/// A late event (one a [`Reorder`](super::OrderingMode::Reorder) source
/// accepts before its newest) goes into the view at its key's position.
/// Views that carry state (`diff`, `rate`, `pct_change`, `fill`,
/// `cumulative`, `sample`) work it out in arrival order: a late event's
/// change is against the event that arrived before it, not the one before
/// it in time.
pub struct LiveView {
    pub(crate) name: String,
    pub(crate) schema: Arc<LiveSchema>,
    pub(crate) buffer: EventBuffer,
    pub(crate) step: Step,
    pub(crate) window: Option<Window>,
    /// The window's length, for `event_rate`: set by `window(duration)`
    /// and kept by `filter`, `map` and `select` built on such a view.
    pub(crate) window_ms: Option<i64>,
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
    /// A view over `history` (its source's events now), trimmed once at
    /// the end as pond-ts does.
    pub(crate) fn new<'a>(
        name: String,
        schema: Arc<LiveSchema>,
        step: Step,
        history: impl Iterator<Item = &'a LiveEvent>,
        window: Option<Window>,
        window_ms: Option<i64>,
    ) -> Self {
        let mut view = Self {
            name,
            schema,
            buffer: EventBuffer::default(),
            step,
            window,
            window_ms,
        };
        for event in history {
            if let Some(kept) = (view.step)(event) {
                view.buffer.insert(kept);
            }
        }
        view.trim();
        view
    }

    /// Run the step on one source event; the event kept, now held (and
    /// handed on even if a window trims it straight away).
    pub(crate) fn take(&mut self, event: &LiveEvent) -> Option<LiveEvent> {
        let kept = (self.step)(event)?;
        self.buffer.insert(kept.clone());
        self.trim();
        Some(kept)
    }

    /// Apply the window, if any: drop the oldest events past it.
    fn trim(&mut self) {
        let events = &self.buffer.events;
        let n = match self.window {
            None => return,
            Some(Window::Rows(keep)) => events.len().saturating_sub(keep),
            Some(Window::Span(ms)) => match events.back() {
                None => 0,
                Some(last) => {
                    let cutoff = last.begin().saturating_sub(ms);
                    events.iter().take_while(|e| e.begin() < cutoff).count()
                }
            },
        };
        if n > 0 {
            self.buffer.evict(n, false);
        }
    }

    /// Mirror a source eviction: drop held events starting at or before
    /// the last evicted one. The events dropped, collected only when
    /// `keep` is set (something follows this view's evictions).
    pub(crate) fn mirror_evict(&mut self, evicted: &[LiveEvent], keep: bool) -> Vec<LiveEvent> {
        let Some(cutoff) = evicted.last().map(LiveEvent::begin) else {
            return Vec::new();
        };
        // Usually a few events at the front: count them rather than
        // search the whole buffer.
        let n = self
            .buffer
            .events
            .iter()
            .take_while(|e| e.begin() <= cutoff)
            .count();
        if n == 0 {
            return Vec::new();
        }
        self.buffer.evict(n, keep)
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

    /// Number of events held (pond-ts `count()`, the same as `len`).
    pub fn count(&self) -> usize {
        self.buffer.len()
    }

    /// Events per second over the window: `len / window seconds` (pond-ts
    /// `eventRate()`). Only for a `window(duration)` view and `filter`,
    /// `map` or `select` built on one; an error otherwise.
    pub fn event_rate(&self) -> Result<f64> {
        let ms = self
            .window_ms
            .ok_or_else(|| crate::error::PondError::InvalidData {
                call: "LiveView::event_rate",
                message: "needs a time window: build the view with window(duration) first \
                      (a window of rows has no length in time)"
                    .into(),
            })?;
        Ok(self.buffer.len() as f64 / (ms as f64 / 1000.0))
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
