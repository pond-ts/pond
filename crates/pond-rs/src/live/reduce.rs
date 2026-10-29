//! A reduction over everything a live source holds now (pond-ts
//! `LiveReduce`).
//!
//! Each source event is added to the column states; each event the source
//! evicts (retention, `clear`, a view following its source) is removed
//! again. It emits at the end of each push, after retention, so its value
//! is the reduction over what the source holds once the push is done: one
//! event per push for [`Trigger::event`](super::Trigger::event) however
//! many rows the push had, keyed at the push's last event.

use std::collections::VecDeque;
use std::sync::Arc;

use crate::column::Value;
use crate::error::Result;
use crate::query::EventKey;
use crate::reducer::Agg;
use crate::series::ColumnDef;

use super::aggregation::plan_mapping;
use super::buffer::EventBuffer;
use super::event::{LiveEvent, LiveSchema};
use super::rolling::{Trigger, TriggerKind, clock_crossed};
use super::states::LiveState;

const CALL: &str = "LiveSeries::reduce";

/// Where an event went in its source, for a reduce that follows the
/// source's evictions: its position among the events the source holds, and
/// how many of the oldest the source dropped straight after without saying
/// so (a `window` view trimming itself).
#[derive(Debug, Clone, Copy)]
pub(crate) struct Place {
    pub(crate) at: usize,
    pub(crate) trimmed: usize,
}

/// A reduction over what a source holds now, read through the owner.
/// Built with [`LiveSeries::reduce`](super::LiveSeries::reduce).
pub struct LiveReduce {
    name: String,
    schema: Arc<LiveSchema>,
    columns: Vec<(usize, LiveState)>,
    /// The index each event the source (a series or a view) holds was
    /// added under, in the source's order. An evicted event is removed
    /// under its own index, whatever order the source drops events in.
    held: VecDeque<usize>,
    next: usize,
    trigger: TriggerKind,
    last_bucket: Option<i128>,
    since_emit: usize,
    /// The latest key since the last emission, waiting for the push to end.
    pending: Option<EventKey>,
    out: EventBuffer,
    events_observed: u64,
    evictions: u64,
    emissions: u64,
}

impl std::fmt::Debug for LiveReduce {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveReduce")
            .field("name", &self.name)
            .field("len", &self.out.len())
            .finish_non_exhaustive()
    }
}

/// Counters for a [`LiveReduce`] (pond-ts `stats()`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReduceStats {
    /// Source events added, including those replayed at build.
    pub events_observed: u64,
    /// Source events removed again (evicted by the source).
    pub evictions: u64,
    /// Events emitted.
    pub emissions: u64,
    /// Source events in the reduction now.
    pub buffer_size: u64,
}

impl LiveReduce {
    /// `sorted`: the source may evict out of arrival order. Replays
    /// `history` and emits for it once.
    pub(crate) fn new(
        name: String,
        source: &[ColumnDef],
        mapping: &[Agg],
        trigger: Trigger,
        sorted: bool,
        history: impl Iterator<Item = LiveEvent>,
    ) -> Result<Self> {
        trigger.check_key(CALL, source[0].kind)?;
        let (defs, plan) = plan_mapping(CALL, source[0].clone(), source, mapping)?;
        let schema = LiveSchema::new(defs);
        let mut reduce = Self {
            name,
            out: EventBuffer::new(Arc::clone(&schema)),
            schema,
            columns: plan
                .into_iter()
                .map(|(src, r)| (src, LiveState::new(r, sorted)))
                .collect(),
            held: VecDeque::new(),
            next: 0,
            trigger: trigger.0,
            last_bucket: None,
            since_emit: 0,
            pending: None,
            events_observed: 0,
            evictions: 0,
            emissions: 0,
        };
        for (at, event) in history.enumerate() {
            reduce.ingest(&event, Place { at, trimmed: 0 });
        }
        // pond-ts emits for the replay on a microtask, after the build;
        // here it goes straight into the kept events.
        reduce.settle(false);
        Ok(reduce)
    }

    /// Add one source event; `place` is where it went in the source.
    pub(crate) fn ingest(&mut self, event: &LiveEvent, place: Place) {
        self.events_observed += 1;
        let index = self.next;
        self.next += 1;
        self.held.insert(place.at, index);
        self.held.drain(..place.trimmed.min(self.held.len()));
        for (src, state) in &mut self.columns {
            if let Some(v) = &event.values()[*src] {
                state.add(index, v);
            }
        }
        if matches!(self.trigger, TriggerKind::Count(_)) {
            self.since_emit += 1;
        }
        self.pending = Some(event.key().clone());
    }

    /// The source dropped `events`, its oldest, in its order.
    pub(crate) fn evict(&mut self, events: &[LiveEvent]) {
        for event in events {
            let Some(index) = self.held.pop_front() else {
                return;
            };
            self.evictions += 1;
            for (src, state) in &mut self.columns {
                if let Some(v) = &event.values()[*src] {
                    state.remove(index, v);
                }
            }
        }
    }

    /// The end of a push: emit for what arrived during it (pond-ts
    /// `#flushPendingEmit`). Returns the emitted events when `hand_on`.
    pub(crate) fn settle(&mut self, hand_on: bool) -> Vec<LiveEvent> {
        let Some(key) = self.pending.take() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        match self.trigger {
            TriggerKind::Event => out.extend(self.emit(key, hand_on)),
            TriggerKind::Count(n) => {
                while self.since_emit >= n {
                    self.since_emit -= n;
                    out.extend(self.emit(key.clone(), hand_on));
                }
            }
            TriggerKind::Clock { step, anchor } => {
                if let Some(start) = clock_crossed(&mut self.last_bucket, key.begin(), step, anchor)
                {
                    out.extend(self.emit(EventKey::time(start), hand_on));
                }
            }
        }
        out
    }

    fn emit(&mut self, key: EventKey, hand_on: bool) -> Option<LiveEvent> {
        self.emissions += 1;
        let values: Vec<Option<Value>> = self.columns.iter_mut().map(|c| c.1.snapshot()).collect();
        if hand_on {
            let event = LiveEvent::new(Arc::clone(&self.schema), key, values);
            self.out.append_ref(&event);
            Some(event)
        } else {
            self.out.append(key, values);
            None
        }
    }

    pub(crate) fn has_pending(&self) -> bool {
        self.pending.is_some()
    }

    pub(crate) fn schema_arc(&self) -> Arc<LiveSchema> {
        Arc::clone(&self.schema)
    }

    pub(crate) fn kept(&self) -> &EventBuffer {
        &self.out
    }

    /// The source's name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The source's key column, then one column per mapping entry, each
    /// allowing gaps.
    pub fn schema(&self) -> &[ColumnDef] {
        &self.schema.columns
    }

    /// Number of events emitted (all are kept).
    pub fn len(&self) -> usize {
        self.out.len()
    }

    /// `true` when there is nothing in it.
    pub fn is_empty(&self) -> bool {
        self.out.len() == 0
    }

    /// The emitted event at `index`; negative positions count from the end.
    pub fn at(&self, index: i64) -> Option<LiveEvent> {
        self.out.at(index)
    }

    /// The emitted events, oldest first.
    pub fn events(&self) -> impl ExactSizeIterator<Item = LiveEvent> + '_ {
        self.out.iter()
    }

    /// Every column over what the source holds now, in schema order.
    /// Reading changes nothing (in pond-ts a read can move the last bit of
    /// a later `stdev`).
    pub fn value(&self) -> Vec<Option<Value>> {
        self.columns.iter().map(|c| c.1.peek()).collect()
    }

    /// Its counters (pond-ts `stats()`).
    pub fn stats(&self) -> ReduceStats {
        ReduceStats {
            events_observed: self.events_observed,
            evictions: self.evictions,
            emissions: self.emissions,
            buffer_size: self.events_observed - self.evictions,
        }
    }
}
