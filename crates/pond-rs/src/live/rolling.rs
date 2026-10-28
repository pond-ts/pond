//! Rolling windows over a live source (pond-ts `LiveRollingAggregation`
//! and `LiveFusedRolling`), and the [`Trigger`]s that pace them and
//! [`LiveReduce`](super::LiveReduce).
//!
//! A rolling window takes every event of its source, in arrival order: it
//! adds the event's values to each output column's state, drops the
//! oldest events that left the window, and, when its trigger fires, emits
//! one event with every column as it now stands. Window states are
//! `states.rs`, the same as pond-ts's `rollingStateFor`, so results match
//! pond-ts bit for bit.

use std::collections::VecDeque;
use std::sync::Arc;

use crate::column::Value;
use crate::duration::parse_duration;
use crate::error::{PondError, Result};
use crate::query::EventKey;
use crate::reducer::Agg;
use crate::sequence::Sequence;
use crate::series::{ColumnDef, ColumnKind};

use super::aggregation::plan_mapping;
use super::buffer::{Cells, EventBuffer};
use super::event::{LiveEvent, LiveSchema};
use super::states::LiveState;

/// When a [`LiveRolling`] or [`LiveReduce`](super::LiveReduce) emits
/// (pond-ts `Trigger`). The default is [`Trigger::event`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Trigger(pub(crate) TriggerKind);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum TriggerKind {
    #[default]
    Event,
    Clock {
        step: i64,
        anchor: i64,
    },
    Count(usize),
}

impl Trigger {
    /// Emit for every source event, keyed at that event's key.
    pub fn event() -> Self {
        Self(TriggerKind::Event)
    }

    /// Emit when an event crosses into a new bucket of
    /// `Sequence::every(duration)`, keyed at that bucket's start. The first
    /// event only sets the bucket; an event that skips several buckets
    /// emits once. Nothing is emitted for a stretch with no events.
    pub fn every(duration: &str) -> Result<Self> {
        Self::clock(&Sequence::every(duration)?)
    }

    /// As [`Trigger::every`], with the buckets of a fixed-step sequence
    /// (anchored where it is anchored). Calendar sequences have no fixed
    /// step and are refused.
    pub fn clock(sequence: &Sequence) -> Result<Self> {
        let (step, anchor) = sequence
            .fixed_step()
            .ok_or_else(|| PondError::Unsupported {
                call: "Trigger::clock",
                message: "a clock trigger needs a fixed-step sequence (Sequence::every); \
                      calendar sequences have no constant spacing"
                    .into(),
            })?;
        Ok(Self(TriggerKind::Clock { step, anchor }))
    }

    /// Emit every `n` source events (the first on the `n`th), keyed at the
    /// event that made it `n`. `n` is at least 1.
    pub fn count(n: usize) -> Result<Self> {
        if n == 0 {
            return Err(PondError::InvalidData {
                call: "Trigger::count",
                message: "count needs n of at least 1".into(),
            });
        }
        Ok(Self(TriggerKind::Count(n)))
    }

    /// A clock trigger keys its events at bucket starts, which are points
    /// in time: refused over a source keyed by ranges or intervals.
    pub(crate) fn check_key(self, call: &'static str, key: ColumnKind) -> Result<()> {
        if matches!(self.0, TriggerKind::Clock { .. }) && key != ColumnKind::Time {
            return Err(PondError::Unsupported {
                call,
                message: format!(
                    "a clock trigger emits at points in time; this source is keyed by {}",
                    key.as_str()
                ),
            });
        }
        Ok(())
    }
}

/// The bucket of a clock trigger that `ts` falls in, and its start
/// (pond-ts `bucketIndexFor` / `boundaryTimestampFor`), worked out exactly.
pub(crate) fn clock_bucket(ts: i64, step: i64, anchor: i64) -> (i128, i64) {
    let (step, anchor) = (i128::from(step), i128::from(anchor));
    let idx = (i128::from(ts) - anchor).div_euclid(step);
    let start = idx * step + anchor;
    (idx, i64::try_from(start).unwrap_or(ts))
}

/// pond-ts `#emitClock`: the first event only records its bucket; a later
/// one in a newer bucket returns that bucket's start.
pub(crate) fn clock_crossed(
    last: &mut Option<i128>,
    ts: i64,
    step: i64,
    anchor: i64,
) -> Option<i64> {
    let (idx, start) = clock_bucket(ts, step, anchor);
    match *last {
        None => {
            *last = Some(idx);
            None
        }
        Some(prev) if idx > prev => {
            *last = Some(idx);
            Some(start)
        }
        Some(_) => None,
    }
}

/// How many emitted events a [`LiveRolling`] keeps to read back (pond-ts
/// `history`). Events are emitted to watchers and nodes built on it
/// whatever this says.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum History {
    /// Keep every one (the default).
    #[default]
    All,
    /// Keep none: `len` stays 0.
    Off,
    /// Keep at most `max_events` (at least 1), and only those starting no
    /// more than `max_age` (a duration such as `"5m"`) before the newest.
    Limit {
        max_events: Option<usize>,
        max_age: Option<String>,
    },
}

/// Options for [`LiveSeries::rolling_with`](super::LiveSeries::rolling_with),
/// [`LiveSeries::rolling_rows`](super::LiveSeries::rolling_rows) and
/// [`LiveSeries::rolling_windows`](super::LiveSeries::rolling_windows).
#[derive(Debug, Clone, Default)]
pub struct RollingOptions {
    pub(crate) min_samples: usize,
    pub(crate) trigger: Trigger,
    pub(crate) history: History,
}

impl RollingOptions {
    pub fn new() -> Self {
        Self::default()
    }

    /// While a window holds fewer events than this (gaps count), every
    /// column emits a gap. Default 0.
    pub fn min_samples(mut self, n: usize) -> Self {
        self.min_samples = n;
        self
    }

    pub fn trigger(mut self, trigger: Trigger) -> Self {
        self.trigger = trigger;
        self
    }

    pub fn history(mut self, history: History) -> Self {
        self.history = history;
        self
    }
}

/// One window of a fused rolling ([`LiveSeries::rolling_windows`](super::LiveSeries::rolling_windows)):
/// a time span and the columns worked out over it.
#[derive(Debug, Clone)]
pub struct RollingWindow {
    window: String,
    mapping: Vec<Agg>,
    min_samples: Option<usize>,
}

impl RollingWindow {
    /// `window` is a duration such as `"1m"`.
    pub fn new(window: &str, mapping: &[Agg]) -> Self {
        Self {
            window: window.to_string(),
            mapping: mapping.to_vec(),
            min_samples: None,
        }
    }

    /// This window's own [`RollingOptions::min_samples`].
    pub fn min_samples(mut self, n: usize) -> Self {
        self.min_samples = Some(n);
        self
    }
}

/// How a window's length is measured.
#[derive(Debug, Clone, Copy)]
pub(crate) enum Span {
    Time(i64),
    Rows(usize),
}

/// One output column: where its source values are kept, and its state.
struct Column {
    store: usize,
    source: usize,
    state: LiveState,
}

/// One window: its span, columns and warm-up, and (fused) the index of the
/// oldest event still in it.
struct Window {
    span: Span,
    columns: Vec<Column>,
    min_samples: usize,
    head: usize,
}

/// The resolved `history` option.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Keep {
    on: bool,
    max_events: usize,
    max_age: Option<i64>,
}

impl Keep {
    pub(crate) fn on(&self) -> bool {
        self.on
    }

    pub(crate) fn of(call: &'static str, history: &History) -> Result<Self> {
        Ok(match history {
            History::All => Self {
                on: true,
                max_events: usize::MAX,
                max_age: None,
            },
            History::Off => Self {
                on: false,
                max_events: 0,
                max_age: None,
            },
            History::Limit {
                max_events,
                max_age,
            } => {
                if *max_events == Some(0) {
                    return Err(PondError::InvalidData {
                        call,
                        message: "history max_events must be at least 1 (use History::Off \
                                  to keep none)"
                            .into(),
                    });
                }
                Self {
                    on: true,
                    max_events: max_events.unwrap_or(usize::MAX),
                    max_age: max_age.as_deref().map(parse_duration).transpose()?,
                }
            }
        })
    }

    /// pond-ts `applyHistoryRetention`, after each emitted event.
    pub(crate) fn apply(&self, out: &mut EventBuffer) {
        let len = out.len();
        let mut n = len.saturating_sub(self.max_events);
        if let (Some(age), Some(latest)) = (self.max_age, out.back_begin()) {
            let cutoff = latest.saturating_sub(age);
            while n < len && out.begin_at(n) < cutoff {
                n += 1;
            }
        }
        if n > 0 {
            out.evict(n, false);
        }
    }
}

/// What follows a source event: nothing (replaying history at build), the
/// read pond-ts makes for its `update` listeners with none listening (which
/// a stdev can act on), or that read, kept as the value record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum After {
    Replay,
    Touch,
    Record,
}

/// What one source event did to a rolling window: the event it emitted
/// (when one was, and something takes it), and its value record (when
/// wanted).
pub(crate) struct Rolled {
    pub(crate) event: Option<LiveEvent>,
    pub(crate) update: Option<Vec<Option<Value>>>,
}

/// A rolling window, or several over one source (fused), read through the
/// owner. Built with [`LiveSeries::rolling`](super::LiveSeries::rolling)
/// and its siblings.
///
/// Its events are keyed at the source event that made the trigger fire
/// (or, for a clock trigger, at the bucket start), with the source's key
/// column, then one column per mapping entry. A late event (one a
/// [`Reorder`](super::OrderingMode::Reorder) source takes before its newest)
/// is added as the newest arrival: a time window measures back from its
/// start, so it can hold events newer than itself.
pub struct LiveRolling {
    name: String,
    schema: Arc<LiveSchema>,
    windows: Vec<Window>,
    fused: bool,
    /// The source events held: start times, and the values of each source
    /// column some window reads.
    starts: VecDeque<i64>,
    stores: Vec<Cells>,
    /// The source column each store holds.
    stored: Vec<usize>,
    /// Index of the next event to arrive.
    next: usize,
    trigger: TriggerKind,
    last_bucket: Option<i128>,
    since_emit: usize,
    out: EventBuffer,
    keep: Keep,
    events_observed: u64,
    evictions: u64,
    emissions: u64,
}

impl std::fmt::Debug for LiveRolling {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveRolling")
            .field("name", &self.name)
            .field("windows", &self.windows.len())
            .field("len", &self.out.len())
            .finish_non_exhaustive()
    }
}

/// Counters for a [`LiveRolling`] (pond-ts `stats()`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RollingStats {
    /// Source events taken, including those replayed at build.
    pub events_observed: u64,
    /// Source events that left every window.
    pub evictions: u64,
    /// Events emitted.
    pub emissions: u64,
    /// Source events held now (for fused windows, as many as the longest
    /// window needs).
    pub window_size: usize,
    /// Number of windows (1 unless fused).
    pub windows: usize,
}

impl LiveRolling {
    /// One window (`span`) over `source` (key column first).
    pub(crate) fn single(
        call: &'static str,
        name: String,
        source: &[ColumnDef],
        span: Span,
        mapping: &[Agg],
        options: &RollingOptions,
    ) -> Result<Self> {
        options.trigger.check_key(call, source[0].kind)?;
        let (defs, plan) = plan_mapping(call, source[0].clone(), source, mapping)?;
        let mut rolling = Self::empty(call, name, defs, options)?;
        let columns = rolling.columns(source, &plan, false);
        rolling.windows.push(Window {
            span,
            columns,
            min_samples: options.min_samples,
            head: 0,
        });
        Ok(rolling)
    }

    /// Several time windows over `source`, emitted together.
    pub(crate) fn fused(
        call: &'static str,
        name: String,
        source: &[ColumnDef],
        windows: &[RollingWindow],
        options: &RollingOptions,
    ) -> Result<Self> {
        options.trigger.check_key(call, source[0].kind)?;
        if windows.is_empty() {
            return Err(PondError::InvalidData {
                call,
                message: "fused rolling needs at least one window".into(),
            });
        }
        let mut defs = vec![source[0].clone()];
        let mut planned = Vec::with_capacity(windows.len());
        for w in windows {
            let ms = parse_duration(&w.window)?;
            let (window_defs, plan) = plan_mapping(call, source[0].clone(), source, &w.mapping)?;
            for def in &window_defs[1..] {
                if defs.iter().any(|d| d.name == def.name) {
                    return Err(PondError::DuplicateOutput {
                        call,
                        column: def.name.clone(),
                    });
                }
                defs.push(def.clone());
            }
            planned.push((ms, plan, w.min_samples.unwrap_or(options.min_samples)));
        }
        let mut rolling = Self::empty(call, name, defs, options)?;
        rolling.fused = true;
        for (ms, plan, min_samples) in planned {
            let columns = rolling.columns(source, &plan, false);
            rolling.windows.push(Window {
                span: Span::Time(ms),
                columns,
                min_samples,
                head: 0,
            });
        }
        Ok(rolling)
    }

    fn empty(
        call: &'static str,
        name: String,
        defs: Vec<ColumnDef>,
        options: &RollingOptions,
    ) -> Result<Self> {
        let schema = LiveSchema::new(defs);
        Ok(Self {
            name,
            out: EventBuffer::new(Arc::clone(&schema)),
            schema,
            windows: Vec::new(),
            fused: false,
            starts: VecDeque::new(),
            stores: Vec::new(),
            stored: Vec::new(),
            next: 0,
            trigger: options.trigger.0,
            last_bucket: None,
            since_emit: 0,
            keep: Keep::of(call, &options.history)?,
            events_observed: 0,
            evictions: 0,
            emissions: 0,
        })
    }

    /// The states for `plan`, each source column stored once.
    fn columns(
        &mut self,
        source: &[ColumnDef],
        plan: &[(usize, crate::reducer::Reducer)],
        sorted: bool,
    ) -> Vec<Column> {
        plan.iter()
            .map(|&(src, reducer)| {
                let store = match self.stored.iter().position(|&s| s == src) {
                    Some(store) => store,
                    None => {
                        self.stores.push(Cells::new(source[src + 1].kind));
                        self.stored.push(src);
                        self.stores.len() - 1
                    }
                };
                Column {
                    store,
                    source: src,
                    state: LiveState::new(reducer, sorted),
                }
            })
            .collect()
    }

    /// Take a source event. `hand_on`: something takes this node's events
    /// (build the emitted event); `want_update`: something watches its
    /// `Update` (build the value record).
    pub(crate) fn ingest(&mut self, event: &LiveEvent, hand_on: bool, after: After) -> Rolled {
        self.events_observed += 1;
        let ts = event.begin();
        let index = self.next;
        self.next += 1;
        self.starts.push_back(ts);
        for (store, &src) in self.stores.iter_mut().zip(&self.stored) {
            store.push(event.values()[src].as_ref());
        }
        if self.fused {
            self.ingest_fused(event, index, ts);
        } else {
            self.ingest_single(event, index, ts);
        }
        let key = match self.trigger {
            TriggerKind::Event => Some(event.key().clone()),
            TriggerKind::Count(n) => {
                self.since_emit += 1;
                (self.since_emit >= n).then(|| {
                    self.since_emit = 0;
                    event.key().clone()
                })
            }
            TriggerKind::Clock { step, anchor } => {
                clock_crossed(&mut self.last_bucket, ts, step, anchor).map(EventKey::time)
            }
        };
        let event = key.and_then(|key| self.emit(key, hand_on));
        let update = match after {
            _ if self.fused => None,
            After::Replay => None,
            After::Record => Some(self.record(true)),
            After::Touch => {
                // pond-ts reads `value()` after every event even with
                // nothing listening, and a stdev read can move its
                // reference point.
                if !self.warming(&self.windows[0]) {
                    self.windows[0]
                        .columns
                        .iter_mut()
                        .for_each(|c| c.state.touch());
                }
                None
            }
        };
        Rolled { event, update }
    }

    /// pond-ts `LiveRollingAggregation.#ingest`: add, then drop what left.
    fn ingest_single(&mut self, event: &LiveEvent, index: usize, ts: i64) {
        for c in &mut self.windows[0].columns {
            if let Some(v) = &event.values()[c.source] {
                c.state.add(index, v);
            }
        }
        self.evict_single(ts);
    }

    /// Drop what has left the single window, measured back from `ts`.
    fn evict_single(&mut self, ts: i64) {
        let w = &mut self.windows[0];
        loop {
            let len = self.starts.len();
            let out = match w.span {
                Span::Time(ms) => len > 0 && self.starts[0] < ts.saturating_sub(ms),
                Span::Rows(n) => len > n,
            };
            if !out {
                break;
            }
            let front = self.next - len;
            for c in &mut w.columns {
                if let Some(v) = self.stores[c.store].get(0) {
                    c.state.remove(front, &v);
                }
            }
            self.starts.pop_front();
            self.stores.iter_mut().for_each(|s| s.drop_front(1));
            self.evictions += 1;
        }
    }

    /// pond-ts `LiveFusedRolling.#ingest`: per window, drop what left, then
    /// add; then forget events no window holds.
    fn ingest_fused(&mut self, event: &LiveEvent, index: usize, ts: i64) {
        let front = self.next - self.starts.len();
        for w in &mut self.windows {
            let Span::Time(ms) = w.span else {
                unreachable!("fused windows are time windows")
            };
            let cutoff = ts.saturating_sub(ms);
            while w.head < index && self.starts[w.head - front] < cutoff {
                for c in &mut w.columns {
                    if let Some(v) = self.stores[c.store].get(w.head - front) {
                        c.state.remove(w.head, &v);
                    }
                }
                w.head += 1;
            }
            for c in &mut w.columns {
                if let Some(v) = &event.values()[c.source] {
                    c.state.add(index, v);
                }
            }
        }
        let oldest = self.windows.iter().map(|w| w.head).min().unwrap_or(index);
        let n = oldest - front;
        if n > 0 {
            self.starts.drain(..n);
            self.stores.iter_mut().for_each(|s| s.drop_front(n));
            self.evictions += n as u64;
        }
    }

    /// Take a source event without emitting: one partition's windows in
    /// synchronised partition rolling (pond-ts `LivePartitionedSyncRolling`
    /// / `LivePartitionedFusedRolling` `ingest`, which add and drop as
    /// [`LiveRolling`] does).
    pub(crate) fn take(&mut self, event: &LiveEvent) {
        self.events_observed += 1;
        let ts = event.begin();
        let index = self.next;
        self.next += 1;
        self.starts.push_back(ts);
        for (store, &src) in self.stores.iter_mut().zip(&self.stored) {
            store.push(event.values()[src].as_ref());
        }
        if self.fused {
            self.ingest_fused(event, index, ts);
        } else {
            self.ingest_single(event, index, ts);
        }
    }

    /// Drop what has left the windows by `ts`, adding nothing (a
    /// synchronised tick catching up a quiet partition).
    pub(crate) fn advance(&mut self, ts: i64) {
        if !self.fused {
            self.evict_single(ts);
            return;
        }
        let front = self.next - self.starts.len();
        for w in &mut self.windows {
            let Span::Time(ms) = w.span else {
                unreachable!("fused windows are time windows")
            };
            let cutoff = ts.saturating_sub(ms);
            while w.head < self.next && self.starts[w.head - front] < cutoff {
                for c in &mut w.columns {
                    if let Some(v) = self.stores[c.store].get(w.head - front) {
                        c.state.remove(w.head, &v);
                    }
                }
                w.head += 1;
            }
        }
        let oldest = self.windows.iter().map(|w| w.head).min().unwrap_or(self.next);
        let n = oldest - front;
        if n > 0 {
            self.starts.drain(..n);
            self.stores.iter_mut().for_each(|s| s.drop_front(n));
            self.evictions += n as u64;
        }
    }

    /// Every column now (gaps while warming up), as a tick reads it.
    pub(crate) fn values(&mut self) -> Vec<Option<Value>> {
        self.record(true)
    }

    /// Source events held now.
    pub(crate) fn held_len(&self) -> usize {
        self.starts.len()
    }

    /// Whether window `w` is still warming up (fewer events than
    /// `min_samples`).
    fn warming(&self, w: &Window) -> bool {
        let size = if self.fused {
            self.next - w.head
        } else {
            self.starts.len()
        };
        size < w.min_samples
    }

    /// Every column as it now stands (pond-ts reads, which a stdev may
    /// act on), gaps while warming up.
    fn record(&mut self, mutate: bool) -> Vec<Option<Value>> {
        let mut out = Vec::with_capacity(self.schema.columns.len() - 1);
        for wi in 0..self.windows.len() {
            let warm = self.warming(&self.windows[wi]);
            for c in &mut self.windows[wi].columns {
                out.push(if warm {
                    None
                } else if mutate {
                    c.state.snapshot()
                } else {
                    c.state.peek()
                });
            }
        }
        out
    }

    /// Emit one event at `key`: keep it (per `history`), and return it when
    /// something takes it.
    fn emit(&mut self, key: EventKey, hand_on: bool) -> Option<LiveEvent> {
        self.emissions += 1;
        let values = self.record(true);
        let event = if hand_on {
            let event = LiveEvent::new(Arc::clone(&self.schema), key, values);
            if self.keep.on {
                self.out.append_ref(&event);
            }
            Some(event)
        } else {
            if self.keep.on {
                self.out.append(key, values);
            }
            None
        };
        if self.keep.on {
            self.keep.apply(&mut self.out);
        }
        event
    }

    pub(crate) fn schema_arc(&self) -> Arc<LiveSchema> {
        Arc::clone(&self.schema)
    }

    pub(crate) fn is_fused(&self) -> bool {
        self.fused
    }

    pub(crate) fn kept(&self) -> &EventBuffer {
        &self.out
    }

    /// The source's name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The source's key column, then one column per mapping entry (fused:
    /// each window's in turn), each allowing gaps.
    pub fn schema(&self) -> &[ColumnDef] {
        &self.schema.columns
    }

    /// Number of emitted events kept.
    pub fn len(&self) -> usize {
        self.out.len()
    }

    pub fn is_empty(&self) -> bool {
        self.out.len() == 0
    }

    /// The kept event at `index`; negative positions count from the end.
    pub fn at(&self, index: i64) -> Option<LiveEvent> {
        self.out.at(index)
    }

    /// The kept events, oldest first.
    pub fn events(&self) -> impl ExactSizeIterator<Item = LiveEvent> + '_ {
        self.out.iter()
    }

    /// Every column as it stands now, in schema order (gaps while warming
    /// up). Reading changes nothing (in pond-ts a read can move the last
    /// bit of a later `stdev`).
    pub fn value(&self) -> Vec<Option<Value>> {
        let mut out = Vec::with_capacity(self.schema.columns.len() - 1);
        for w in &self.windows {
            let warm = self.warming(w);
            out.extend(
                w.columns
                    .iter()
                    .map(|c| if warm { None } else { c.state.peek() }),
            );
        }
        out
    }

    /// Source events in the window now (fused: in the longest).
    pub fn window_size(&self) -> usize {
        self.starts.len()
    }

    pub fn stats(&self) -> RollingStats {
        RollingStats {
            events_observed: self.events_observed,
            evictions: self.evictions,
            emissions: self.emissions,
            window_size: self.starts.len(),
            windows: self.windows.len(),
        }
    }
}
