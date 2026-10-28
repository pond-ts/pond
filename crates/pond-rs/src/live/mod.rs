//! Live series: events pushed one batch at a time, and nodes built on them
//! that update as events arrive (pond-ts `LiveSeries`, `LiveView`,
//! `LiveAggregation`).
//!
//! **One owner, handles, outputs in order.** A [`LiveSeries`] owns every
//! node built from it. Building one (a view such as [`LiveSeries::filter`],
//! [`LiveSeries::map`], [`LiveSeries::diff`], [`LiveSeries::fill`] or
//! [`LiveSeries::window`], or [`LiveSeries::aggregate`]) returns a [`Node`] handle: `Copy`, `Send`, no
//! lifetime. Read a node through the owner with `live.get(node)?` (or
//! `live[node]`, which panics on a bad handle). Each push returns what it
//! caused, as [`Output`]s, in the order pond-ts's listeners would see them:
//! each event down the tree (a node's subscribers in the order they were
//! added), then the root's retention, `Batch` and `Evict`. Outputs are
//! opt-in: [`LiveSeries::watch`] a node for a kind, and pushes return only
//! what is watched. Nothing inside a push runs your code except the closures you
//! gave `filter`, `map` and `cumulative_with`, and nothing blocks.
//!
//! **A batch is all or nothing.** [`LiveSeries::push_many`] checks every
//! row, and the whole batch's order under the ordering mode, before storing
//! any of it; a bad row refuses the batch and nothing changes.
//!
//! **Ordering.** [`OrderingMode::Strict`] (the default) refuses an event
//! that starts before the latest one; [`OrderingMode::Drop`] skips it and
//! counts it in [`LiveStats::rejected`]; [`OrderingMode::Reorder`] stores it
//! in key order, refusing it only when it is older than the latest by more
//! than [`LiveOptions::grace_window`]. Views take such a late event at its
//! key position too; the ones that carry state (`diff`, `fill`,
//! `cumulative`, …) work in arrival order.
//!
//! **Retention.** [`LiveOptions::max_events`] and [`LiveOptions::max_age`]
//! (age measured back from the latest event's start; there is no clock)
//! evict the oldest events after each push; views on the series drop what
//! it drops.
//!
//! ```
//! use pond_rs::live::{LiveOptions, LiveSeries, Output, OutputKind};
//! use pond_rs::{Agg, ColumnDef, ColumnKind, Reducer, Sequence};
//!
//! let mut live = LiveSeries::with_options(
//!     "cpu",
//!     vec![
//!         ColumnDef::required("time", ColumnKind::Time),
//!         ColumnDef::optional("host", ColumnKind::String),
//!         ColumnDef::optional("load", ColumnKind::Number),
//!     ],
//!     LiveOptions::new().max_events(1000),
//! )?;
//! let busy = live.filter(live.root(), |e| e.number("load").ok().flatten() > Some(0.8))?;
//! let per_minute = live.aggregate(
//!     live.root(),
//!     &Sequence::every("1m")?,
//!     &[Agg::new("load_avg", "load", Reducer::Avg)],
//! )?;
//! live.watch(busy, OutputKind::Event)?;
//! live.watch(per_minute, OutputKind::Event)?;
//!
//! let out = live.push(0, [Some("a".into()), Some(0.9.into())])?;
//! assert!(matches!(&out[..], [Output::Event { .. }])); // busy saw it
//! live.push(30_000, [Some("b".into()), Some(0.5.into())])?;
//! let out = live.push(61_000, [Some("a".into()), Some(0.7.into())])?;
//! // The first minute closed: its average is out.
//! let Output::Event { event, .. } = &out[0] else { panic!() };
//! assert_eq!(event.number("load_avg")?, Some(0.7));
//! assert_eq!(live[busy].len(), 1);
//! assert_eq!(live[per_minute].len(), 1);
//! # Ok::<(), pond_rs::PondError>(())
//! ```
//!
//! Threads: the owner is `Send`; to share it, put it behind a lock, or
//! publish a [`LiveSeries::to_time_series`] snapshot after each push.

mod aggregation;
mod buffer;
mod event;
mod json;
mod view;
mod views;

#[cfg(test)]
mod tests;

use std::cmp::Ordering;
use std::marker::PhantomData;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

pub use aggregation::{AggregationStats, LiveAggregation};
pub use event::LiveEvent;
pub use view::LiveView;

use crate::column::{Scalar, Value};
use crate::duration::parse_duration;
use crate::error::{PondError, Result};
use crate::json::{RowFormat, invalid, parse, read_name, read_schema};
use crate::query::{EventKey, Label, compare_keys};
use crate::reducer::Agg;
use crate::sequence::Sequence;
use crate::series::{ColumnDef, ColumnKind, MAX_TIME_MS, TimeSeries};

use buffer::EventBuffer;
use event::LiveSchema;
use view::Step;

static NEXT_OWNER: AtomicU64 = AtomicU64::new(1);

/// What a series does with an event that starts before the latest one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum OrderingMode {
    /// Refuse it (the push fails, nothing is stored).
    #[default]
    Strict,
    /// Skip it and count it in [`LiveStats::rejected`].
    Drop,
    /// Store it in key order, within the grace window.
    Reorder,
}

/// How a [`LiveSeries`] orders and keeps events. Durations are pond-ts
/// duration strings (`"5s"`, `"1m"`), checked when the series is built.
#[derive(Debug, Clone, Default)]
pub struct LiveOptions {
    ordering: OrderingMode,
    grace_window: Option<String>,
    max_events: Option<usize>,
    max_age: Option<String>,
}

impl LiveOptions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn ordering(mut self, mode: OrderingMode) -> Self {
        self.ordering = mode;
        self
    }

    /// Under [`OrderingMode::Reorder`] only: how far before the latest
    /// event a late one may start. Without it any late event is stored.
    pub fn grace_window(mut self, duration: &str) -> Self {
        self.grace_window = Some(duration.to_string());
        self
    }

    /// Keep at most this many events.
    pub fn max_events(mut self, n: usize) -> Self {
        self.max_events = Some(n);
        self
    }

    /// Keep only events starting no more than this before the latest one.
    pub fn max_age(mut self, duration: &str) -> Self {
        self.max_age = Some(duration.to_string());
        self
    }
}

/// Counters for a [`LiveSeries`] (pond-ts `stats()`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LiveStats {
    /// Events stored, ever.
    pub ingested: u64,
    /// Events removed, by retention or [`LiveSeries::clear`], ever.
    pub evicted: u64,
    /// Late events skipped under [`OrderingMode::Drop`], ever.
    pub rejected: u64,
    /// Events held now.
    pub length: usize,
    /// Start of the oldest event held.
    pub earliest: Option<i64>,
    /// Start of the latest event held.
    pub latest: Option<i64>,
}

/// The kinds of [`Output`]. A series emits `Event`, `Batch` and `Evict`; a
/// view `Event` and `Evict`; an aggregation `Event` (a closed bucket),
/// `Bucket` and `Update`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OutputKind {
    Event,
    Batch,
    Evict,
    Bucket,
    Update,
}

const KINDS: usize = 5;

impl OutputKind {
    fn slot(self) -> usize {
        self as usize
    }
}

/// Something a push caused at a watched node.
#[derive(Debug, Clone, PartialEq)]
pub enum Output {
    /// The node took an event (an aggregation: closed a bucket).
    Event { node: NodeId, event: LiveEvent },
    /// The root took these events in one push.
    Batch {
        node: NodeId,
        events: Vec<LiveEvent>,
    },
    /// The node dropped these events.
    Evict {
        node: NodeId,
        events: Vec<LiveEvent>,
    },
    /// An aggregation's bucket as it now stands, after an event joined it.
    Bucket { node: NodeId, event: LiveEvent },
    /// An aggregation took an event (even one too late for any bucket).
    Update { node: NodeId },
}

impl Output {
    pub fn node(&self) -> NodeId {
        match self {
            Output::Event { node, .. }
            | Output::Batch { node, .. }
            | Output::Evict { node, .. }
            | Output::Bucket { node, .. }
            | Output::Update { node } => *node,
        }
    }

    pub fn kind(&self) -> OutputKind {
        match self {
            Output::Event { .. } => OutputKind::Event,
            Output::Batch { .. } => OutputKind::Batch,
            Output::Evict { .. } => OutputKind::Evict,
            Output::Bucket { .. } => OutputKind::Bucket,
            Output::Update { .. } => OutputKind::Update,
        }
    }
}

/// A node of some [`LiveSeries`], whatever its type: the root
/// ([`LiveSeries::root`]) or any [`Node`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct NodeId {
    owner: u64,
    index: u32,
}

/// A handle to a node of type `T` ([`LiveView`], [`LiveAggregation`]) in
/// the [`LiveSeries`] that built it. Read it with `live.get(node)` or
/// `live[node]`; build on it by passing it as a source.
pub struct Node<T> {
    id: NodeId,
    _type: PhantomData<fn() -> T>,
}

impl<T> Node<T> {
    pub fn id(self) -> NodeId {
        self.id
    }
}

impl<T> Clone for Node<T> {
    fn clone(&self) -> Self {
        *self
    }
}
impl<T> Copy for Node<T> {}
impl<T> PartialEq for Node<T> {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}
impl<T> Eq for Node<T> {}
impl<T> std::hash::Hash for Node<T> {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.id.hash(state);
    }
}
impl<T> std::fmt::Debug for Node<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Node({})", self.id.index)
    }
}
impl<T> From<Node<T>> for NodeId {
    fn from(node: Node<T>) -> Self {
        node.id
    }
}

/// The node types a [`Node`] can name.
pub trait NodeType: sealed::Sealed + Sized {}

mod sealed {
    use super::{LiveAggregation, LiveView};

    /// What a slot holds. Public only inside this private module, so
    /// callers outside the crate cannot name it.
    pub enum State {
        Root,
        View(LiveView),
        Aggregation(LiveAggregation),
        Removed,
    }

    pub trait Sealed {
        fn of(state: &State) -> Option<&Self>;
    }

    impl Sealed for LiveView {
        fn of(state: &State) -> Option<&Self> {
            match state {
                State::View(v) => Some(v),
                _ => None,
            }
        }
    }

    impl Sealed for LiveAggregation {
        fn of(state: &State) -> Option<&Self> {
            match state {
                State::Aggregation(a) => Some(a),
                _ => None,
            }
        }
    }
}

impl NodeType for LiveView {}
impl NodeType for LiveAggregation {}

use sealed::State;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Sub {
    Watch,
    Child(usize),
}

struct Slot {
    state: State,
    source: Option<usize>,
    subs: [Vec<Sub>; KINDS],
}

impl Slot {
    fn emits(&self) -> &'static [OutputKind] {
        match self.state {
            State::Root => &[OutputKind::Event, OutputKind::Batch, OutputKind::Evict],
            State::View(_) => &[OutputKind::Event, OutputKind::Evict],
            State::Aggregation(_) => &[OutputKind::Event, OutputKind::Bucket, OutputKind::Update],
            State::Removed => &[],
        }
    }

    fn has_subs(&self) -> bool {
        self.subs.iter().any(|s| !s.is_empty())
    }
}

/// A series that takes events as they arrive, and owns the nodes built on
/// it. See the [module docs](self).
pub struct LiveSeries {
    owner: u64,
    name: String,
    schema: Arc<LiveSchema>,
    ordering: OrderingMode,
    grace_ms: Option<i64>,
    max_events: Option<usize>,
    max_age_ms: Option<i64>,
    buffer: EventBuffer,
    ingested: u64,
    evicted: u64,
    rejected: u64,
    slots: Vec<Slot>,
}

impl std::fmt::Debug for LiveSeries {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveSeries")
            .field("name", &self.name)
            .field("len", &self.buffer.len())
            .field("nodes", &self.slots.len())
            .finish_non_exhaustive()
    }
}

const NEW: &str = "LiveSeries::new";

impl LiveSeries {
    /// An empty series with the default options (strict order, keep
    /// everything). The schema lists the key column first (`time`,
    /// `timeRange` or `interval`), then value columns: number, string,
    /// boolean or array.
    pub fn new(name: impl Into<String>, schema: Vec<ColumnDef>) -> Result<Self> {
        Self::with_options(name, schema, LiveOptions::default())
    }

    pub fn with_options(
        name: impl Into<String>,
        schema: Vec<ColumnDef>,
        options: LiveOptions,
    ) -> Result<Self> {
        let bad = |message: String| PondError::InvalidData { call: NEW, message };
        let grace_ms = options
            .grace_window
            .as_deref()
            .map(parse_duration)
            .transpose()?;
        if grace_ms.is_some() && options.ordering != OrderingMode::Reorder {
            return Err(bad(
                "grace_window is only valid with OrderingMode::Reorder".into()
            ));
        }
        let max_age_ms = options.max_age.as_deref().map(parse_duration).transpose()?;
        if let (Some(g), Some(a)) = (grace_ms, max_age_ms)
            && g > a
        {
            return Err(bad(format!(
                "grace_window ({g} ms) cannot exceed max_age ({a} ms): a late event accepted within grace would be evicted at once"
            )));
        }
        let Some(key) = schema.first() else {
            return Err(bad("the schema needs at least a key column".into()));
        };
        if !matches!(
            key.kind,
            ColumnKind::Time | ColumnKind::TimeRange | ColumnKind::Interval
        ) {
            return Err(bad(format!(
                "the first column is the key and must be time, timeRange or interval; '{}' is {}",
                key.name,
                key.kind.as_str()
            )));
        }
        for (c, def) in schema.iter().enumerate().skip(1) {
            if !matches!(
                def.kind,
                ColumnKind::Number | ColumnKind::String | ColumnKind::Boolean | ColumnKind::Array
            ) {
                return Err(bad(format!(
                    "column '{}' is {}; live value columns are number, string, boolean or array",
                    def.name,
                    def.kind.as_str()
                )));
            }
            if schema[..c].iter().any(|d| d.name == def.name) {
                return Err(bad(format!("two columns are named '{}'", def.name)));
            }
        }
        Ok(Self {
            owner: NEXT_OWNER.fetch_add(1, AtomicOrdering::Relaxed),
            name: name.into(),
            schema: LiveSchema::new(schema),
            ordering: options.ordering,
            grace_ms,
            max_events: options.max_events,
            max_age_ms,
            buffer: EventBuffer::default(),
            ingested: 0,
            evicted: 0,
            rejected: 0,
            slots: vec![Slot {
                state: State::Root,
                source: None,
                subs: Default::default(),
            }],
        })
    }

    /// Build a series from pond-ts JSON (`{"name", "schema", "rows"}`, as
    /// [`TimeSeries::from_json`] reads it; times as numbers or UTC text),
    /// pushing the rows as one batch under `options`.
    pub fn from_json(text: &str, options: LiveOptions) -> Result<Self> {
        const CALL: &str = "LiveSeries::from_json";
        let value = parse(CALL, text)?;
        let name = read_name(CALL, &value)?;
        let schema: Vec<ColumnDef> = read_schema(CALL, value.get("schema"))?
            .into_iter()
            .map(|(name, kind, required)| ColumnDef {
                name,
                kind,
                required,
            })
            .collect();
        let rows = value
            .get("rows")
            .and_then(|v| v.as_array())
            .ok_or_else(|| invalid(CALL, "expected \"rows\" as an array".into()))?;
        let mut live = Self::with_options(name, schema, options)?;
        let rows = json::json_rows(CALL, &live.schema.columns, rows)?;
        live.push_many(rows)?;
        Ok(live)
    }

    /// The root, to build on or watch.
    pub fn root(&self) -> NodeId {
        NodeId {
            owner: self.owner,
            index: 0,
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// The schema, key column first.
    pub fn schema(&self) -> &[ColumnDef] {
        &self.schema.columns
    }

    /// The grace window in ms, under [`OrderingMode::Reorder`] when set.
    pub fn grace_window_ms(&self) -> Option<i64> {
        self.grace_ms
    }

    // ── Pushing ─────────────────────────────────────────────────────

    /// Push one event: a key (an `i64` converts to a point in time) and one
    /// cell per value column, `None` for a gap. Returns the watched outputs.
    pub fn push(
        &mut self,
        key: impl Into<EventKey>,
        values: impl Into<Vec<Option<Value>>>,
    ) -> Result<Vec<Output>> {
        self.push_many([(key, values)])
    }

    /// Push a batch of events, in the order given. All or nothing: a bad
    /// row, or an order the mode refuses, fails the whole batch and nothing
    /// is stored.
    pub fn push_many<K, V>(&mut self, rows: impl IntoIterator<Item = (K, V)>) -> Result<Vec<Output>>
    where
        K: Into<EventKey>,
        V: Into<Vec<Option<Value>>>,
    {
        let events = rows
            .into_iter()
            .enumerate()
            .map(|(i, (key, values))| self.check_row(i, key.into(), values.into()))
            .collect::<Result<Vec<_>>>()?;
        let mut out = Vec::new();
        self.commit(events, &mut out)?;
        Ok(out)
    }

    /// Push rows written as pond-ts JSON: a JSON array of rows, each an
    /// array in schema order or an object keyed by column name, `null` for
    /// a gap. Keys as [`TimeSeries::from_json`] reads them (times as numbers
    /// or UTC text).
    pub fn push_json(&mut self, rows: &str) -> Result<Vec<Output>> {
        const CALL: &str = "LiveSeries::push_json";
        let value = parse(CALL, rows)?;
        let rows = value
            .as_array()
            .ok_or_else(|| invalid(CALL, "expected a JSON array of rows".into()))?;
        let rows = json::json_rows(CALL, &self.schema.columns, rows)?;
        self.push_many(rows)
    }

    /// Remove every event. Views on the series drop theirs; aggregations
    /// keep their buckets (as pond-ts).
    pub fn clear(&mut self) -> Vec<Output> {
        let n = self.buffer.len();
        let mut out = Vec::new();
        if n > 0 {
            self.evicted += n as u64;
            let evicted = self.buffer.evict(n, true);
            self.emit_evict(0, &evicted, &mut out);
        }
        out
    }

    fn check_row(
        &self,
        row: usize,
        key: EventKey,
        values: Vec<Option<Value>>,
    ) -> Result<LiveEvent> {
        const CALL: &str = "LiveSeries::push";
        let bad = |message: String| PondError::InvalidData {
            call: CALL,
            message: format!("row {row}: {message}"),
        };
        let defs = self.schema.values();
        if values.len() != defs.len() {
            return Err(bad(format!(
                "expected {} values after the key, got {}",
                defs.len(),
                values.len()
            )));
        }
        let key_kind = self.schema.columns[0].kind;
        if key.kind() != key_kind.as_str() {
            return Err(bad(format!(
                "the key is a {}, but this series is keyed by {}",
                key.kind(),
                key_kind.as_str()
            )));
        }
        for t in [key.begin(), key.end()] {
            if !(-MAX_TIME_MS..=MAX_TIME_MS).contains(&t) {
                return Err(bad(format!(
                    "time {t} ms is outside the supported range ±{MAX_TIME_MS} ms"
                )));
            }
        }
        if let (Some(label), Some(held)) = (key.label(), self.buffer.events.front())
            && matches!(label, Label::Number(_))
                != matches!(held.key().label(), Some(Label::Number(_)))
        {
            return Err(bad(
                "interval labels must all be numbers or all text, like the events held".into(),
            ));
        }
        for (def, cell) in defs.iter().zip(&values) {
            let Some(v) = cell else {
                if def.required {
                    return Err(bad(format!("column '{}' is required", def.name)));
                }
                continue;
            };
            let ok = match (def.kind, v) {
                (ColumnKind::Number, Value::Number(x)) => x.is_finite(),
                (ColumnKind::String, Value::String(_)) => true,
                (ColumnKind::Boolean, Value::Boolean(_)) => true,
                (ColumnKind::Array, Value::Array(items)) => items
                    .iter()
                    .all(|s| !matches!(s, Scalar::Number(x) if !x.is_finite())),
                _ => false,
            };
            if !ok {
                let want = match def.kind {
                    ColumnKind::Number => "a finite number",
                    ColumnKind::String => "text",
                    ColumnKind::Boolean => "true or false",
                    _ => "an array of finite numbers, text or true/false",
                };
                return Err(bad(format!("'{}': expected {want}, got {v:?}", def.name)));
            }
        }
        Ok(LiveEvent::new(Arc::clone(&self.schema), key, values))
    }

    /// The ordering check over a whole batch, as the inserts would run it,
    /// before any of it is stored ([PND-BATCHATOM]).
    fn check_order(&self, events: &[LiveEvent]) -> Result<()> {
        const CALL: &str = "LiveSeries::push";
        let mut last = self.buffer.last_key().cloned();
        for (i, event) in events.iter().enumerate() {
            let key = event.key();
            let Some(latest) = last
                .as_ref()
                .filter(|l| compare_keys(l, key) == Ordering::Greater)
            else {
                last = Some(key.clone());
                continue;
            };
            match self.ordering {
                OrderingMode::Strict => {
                    return Err(PondError::InvalidData {
                        call: CALL,
                        message: format!(
                            "row {i}: out-of-order event: starts at {} but the latest starts at {}",
                            key.begin(),
                            latest.begin()
                        ),
                    });
                }
                OrderingMode::Reorder => {
                    if let Some(grace) = self.grace_ms
                        && latest.begin() - key.begin() > grace
                    {
                        return Err(PondError::InvalidData {
                            call: CALL,
                            message: format!(
                                "row {i}: event at {} is outside the grace window (latest {}, grace {grace} ms)",
                                key.begin(),
                                latest.begin()
                            ),
                        });
                    }
                }
                OrderingMode::Drop => {}
            }
        }
        Ok(())
    }

    fn commit(&mut self, events: Vec<LiveEvent>, out: &mut Vec<Output>) -> Result<()> {
        if events.is_empty() {
            return Ok(());
        }
        self.check_order(&events)?;
        let want_batch = !self.slots[0].subs[OutputKind::Batch.slot()].is_empty();
        let mut added = Vec::new();
        let mut any = false;
        for event in events {
            let late = self
                .buffer
                .last_key()
                .is_some_and(|l| compare_keys(l, event.key()) == Ordering::Greater);
            if late && self.ordering == OrderingMode::Drop {
                self.rejected += 1;
                continue;
            }
            self.buffer.insert(event.clone());
            self.ingested += 1;
            any = true;
            self.emit_event(0, &event, out);
            if want_batch {
                added.push(event);
            }
        }
        if !any {
            return Ok(());
        }
        let evicted = self.apply_retention();
        if want_batch {
            self.emit(0, OutputKind::Batch, out, |node| Output::Batch {
                node,
                events: added.clone(),
            });
        }
        if !evicted.is_empty() {
            self.emit_evict(0, &evicted, out);
        }
        Ok(())
    }

    fn apply_retention(&mut self) -> Vec<LiveEvent> {
        let len = self.buffer.len();
        let mut n = self.max_events.map_or(0, |m| len.saturating_sub(m));
        if let (Some(age), Some(latest)) = (self.max_age_ms, self.buffer.events.back()) {
            let cutoff = latest.begin() - age;
            let mut i = n;
            while i < len && self.buffer.events[i].begin() < cutoff {
                i += 1;
            }
            n = n.max(i);
        }
        if n == 0 {
            return Vec::new();
        }
        self.evicted += n as u64;
        let keep = self.slots[0].subs[OutputKind::Evict.slot()].iter().len() > 0;
        self.buffer.evict(n, keep)
    }

    // ── Fan-out ─────────────────────────────────────────────────────

    /// Hand `make`'s output to each watcher of `node`'s `kind` (children
    /// are not reached this way).
    fn emit(
        &self,
        node: usize,
        kind: OutputKind,
        out: &mut Vec<Output>,
        make: impl Fn(NodeId) -> Output,
    ) {
        let id = self.id_of(node);
        for sub in &self.slots[node].subs[kind.slot()] {
            if *sub == Sub::Watch {
                out.push(make(id));
            }
        }
    }

    fn emit_event(&mut self, node: usize, event: &LiveEvent, out: &mut Vec<Output>) {
        let kind = OutputKind::Event.slot();
        let mut k = 0;
        while k < self.slots[node].subs[kind].len() {
            match self.slots[node].subs[kind][k] {
                Sub::Watch => out.push(Output::Event {
                    node: self.id_of(node),
                    event: event.clone(),
                }),
                Sub::Child(c) => self.deliver(c, event, out),
            }
            k += 1;
        }
    }

    fn emit_evict(&mut self, node: usize, evicted: &[LiveEvent], out: &mut Vec<Output>) {
        let kind = OutputKind::Evict.slot();
        let mut k = 0;
        while k < self.slots[node].subs[kind].len() {
            match self.slots[node].subs[kind][k] {
                Sub::Watch => out.push(Output::Evict {
                    node: self.id_of(node),
                    events: evicted.to_vec(),
                }),
                Sub::Child(c) => {
                    let follow = !self.slots[c].subs[kind].is_empty();
                    let State::View(view) = &mut self.slots[c].state else {
                        unreachable!("only views follow evictions")
                    };
                    let removed = view.mirror_evict(evicted, follow);
                    if !removed.is_empty() {
                        self.emit_evict(c, &removed, out);
                    }
                }
            }
            k += 1;
        }
    }

    /// One source event reaching child `c`.
    fn deliver(&mut self, c: usize, event: &LiveEvent, out: &mut Vec<Output>) {
        let want_bucket = !self.slots[c].subs[OutputKind::Bucket.slot()].is_empty();
        match &mut self.slots[c].state {
            State::View(view) => {
                if let Some(kept) = view.take(event) {
                    self.emit_event(c, &kept, out);
                }
            }
            State::Aggregation(agg) => {
                let done = agg.ingest(event, want_bucket);
                if let Some(bucket) = done.bucket {
                    self.emit(c, OutputKind::Bucket, out, |node| Output::Bucket {
                        node,
                        event: bucket.clone(),
                    });
                }
                for closed in &done.closed {
                    self.emit_event(c, closed, out);
                }
                self.emit(c, OutputKind::Update, out, |node| Output::Update { node });
            }
            State::Root | State::Removed => unreachable!("not a child"),
        }
    }

    fn id_of(&self, index: usize) -> NodeId {
        NodeId {
            owner: self.owner,
            index: index as u32,
        }
    }

    // ── Nodes ───────────────────────────────────────────────────────

    /// The slot index of a live node of this owner.
    fn slot_of(&self, call: &'static str, id: NodeId) -> Result<usize> {
        let bad = |message: &str| PondError::InvalidData {
            call,
            message: message.into(),
        };
        if id.owner != self.owner {
            return Err(bad("this node belongs to another LiveSeries"));
        }
        let i = id.index as usize;
        match self.slots.get(i) {
            Some(slot) if !matches!(slot.state, State::Removed) => Ok(i),
            Some(_) => Err(bad("this node was removed")),
            None => Err(bad("no such node")),
        }
    }

    /// The events a node holds now, to replay into a node built on it.
    fn held(&self, i: usize) -> Box<dyn Iterator<Item = &LiveEvent> + '_> {
        match &self.slots[i].state {
            State::Root => Box::new(self.buffer.events.iter()),
            State::View(v) => Box::new(v.buffer.events.iter()),
            State::Aggregation(a) => Box::new(a.events()),
            State::Removed => Box::new(std::iter::empty()),
        }
    }

    fn schema_of(&self, i: usize) -> Arc<LiveSchema> {
        match &self.slots[i].state {
            State::Root => Arc::clone(&self.schema),
            State::View(v) => Arc::clone(&v.schema),
            State::Aggregation(a) => a.schema_arc(),
            State::Removed => unreachable!("checked"),
        }
    }

    fn add_node<T>(&mut self, source: usize, state: State) -> Node<T> {
        let index = self.slots.len();
        let follows_evict = matches!(self.slots[source].state, State::Root | State::View(_))
            && matches!(state, State::View(_));
        self.slots.push(Slot {
            state,
            source: Some(source),
            subs: Default::default(),
        });
        self.slots[source].subs[OutputKind::Event.slot()].push(Sub::Child(index));
        if follows_evict {
            self.slots[source].subs[OutputKind::Evict.slot()].push(Sub::Child(index));
        }
        Node {
            id: self.id_of(index),
            _type: PhantomData,
        }
    }

    /// A view of the events of `from` that `keep` accepts. Built over what
    /// `from` holds now, then kept up to date; it drops what `from` evicts.
    pub fn filter<F>(&mut self, from: impl Into<NodeId>, mut keep: F) -> Result<Node<LiveView>>
    where
        F: FnMut(&LiveEvent) -> bool + Send + 'static,
    {
        let source = self.slot_of("LiveSeries::filter", from.into())?;
        let schema = self.schema_of(source);
        let step: Step = Box::new(move |e: &LiveEvent| keep(e).then(|| e.clone()));
        Ok(self.add_view(source, schema, step, None, self.window_ms_of(source)))
    }

    /// Fixed-length buckets (`sequence` must be [`Sequence::every`]) over
    /// the events of `from`, one column per mapping entry. Built over what
    /// `from` holds now. Under [`OrderingMode::Reorder`] with a grace
    /// window, a bucket stays open until the latest event is a grace
    /// window past its end. Evictions do not reach buckets.
    ///
    /// Reducers on text, true/false and array columns are limited to
    /// `count`, `first`, `last`, `keep`, `unique`, `top<N>` and `samples`
    /// (pond-ts answers `sum` with 0 and `avg` with gaps there).
    pub fn aggregate(
        &mut self,
        from: impl Into<NodeId>,
        sequence: &Sequence,
        mapping: &[Agg],
    ) -> Result<Node<LiveAggregation>> {
        const CALL: &str = "LiveSeries::aggregate";
        let source = self.slot_of(CALL, from.into())?;
        let step = sequence
            .fixed_step()
            .ok_or_else(|| PondError::Unsupported {
                call: CALL,
                message:
                    "calendar sequences have no fixed length; live aggregate takes Sequence::every"
                        .into(),
            })?;
        let grace = match self.slots[source].state {
            State::Root => self.grace_ms.unwrap_or(0),
            _ => 0,
        };
        let schema = self.schema_of(source);
        let agg = LiveAggregation::new(
            self.name.clone(),
            &schema.columns,
            step,
            grace,
            mapping,
            self.held(source),
        )?;
        Ok(self.add_node(source, State::Aggregation(agg)))
    }

    /// The node behind `node`; an error when it was removed or is another
    /// series' node.
    pub fn get<T: NodeType>(&self, node: Node<T>) -> Result<&T> {
        let i = self.slot_of("LiveSeries::get", node.id)?;
        Ok(T::of(&self.slots[i].state).expect("a Node<T> names a T"))
    }

    /// Return `kind` outputs of `node` from now on. Watching twice is the
    /// same as once; the kind must be one the node emits.
    pub fn watch(&mut self, node: impl Into<NodeId>, kind: OutputKind) -> Result<()> {
        const CALL: &str = "LiveSeries::watch";
        let i = self.slot_of(CALL, node.into())?;
        let slot = &mut self.slots[i];
        if !slot.emits().contains(&kind) {
            return Err(PondError::InvalidData {
                call: CALL,
                message: format!(
                    "this node never emits {kind:?} (it emits {:?})",
                    slot.emits()
                ),
            });
        }
        let subs = &mut slot.subs[kind.slot()];
        if !subs.contains(&Sub::Watch) {
            subs.push(Sub::Watch);
        }
        Ok(())
    }

    /// Stop returning `kind` outputs of `node`.
    pub fn unwatch(&mut self, node: impl Into<NodeId>, kind: OutputKind) -> Result<()> {
        let i = self.slot_of("LiveSeries::unwatch", node.into())?;
        self.slots[i].subs[kind.slot()].retain(|s| *s != Sub::Watch);
        Ok(())
    }

    /// Remove a node (pond-ts `dispose`): its handle stops working, and
    /// nodes built on it keep what they hold but get no more events. If a
    /// removed view's source is a view that nothing else uses (no watch, no
    /// node built on it), that view is detached too, and so on up (removing
    /// an aggregation does not walk up, as in pond-ts): it keeps its events
    /// and its handle still reads it, but it gets no more events. The root
    /// cannot be removed.
    pub fn remove(&mut self, node: impl Into<NodeId>) -> Result<()> {
        const CALL: &str = "LiveSeries::remove";
        let i = self.slot_of(CALL, node.into())?;
        if i == 0 {
            return Err(PondError::InvalidData {
                call: CALL,
                message: "the root cannot be removed; drop the LiveSeries".into(),
            });
        }
        let was_view = matches!(self.slots[i].state, State::View(_));
        let mut source = self.detach(i);
        self.slots[i].state = State::Removed;
        self.slots[i].subs = Default::default();
        // Only a view walks up (pond-ts `LiveView.dispose`); removing an
        // aggregation leaves its source as it is.
        if !was_view {
            return Ok(());
        }
        while let Some(s) = source {
            let slot = &self.slots[s];
            if !matches!(slot.state, State::View(_)) || slot.has_subs() {
                break;
            }
            source = self.detach(s);
        }
        Ok(())
    }

    /// Unsubscribe slot `i` from its source; the source.
    fn detach(&mut self, i: usize) -> Option<usize> {
        let s = self.slots[i].source.take()?;
        for subs in &mut self.slots[s].subs {
            subs.retain(|sub| *sub != Sub::Child(i));
        }
        Some(s)
    }

    // ── Reading ─────────────────────────────────────────────────────

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

    /// Latest start minus earliest start, ms (0 with fewer than two
    /// events).
    pub fn time_range(&self) -> i64 {
        self.buffer.time_range()
    }

    /// Events per second over [`LiveSeries::time_range`] (0 when that is
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
            earliest: self.buffer.events.front().map(LiveEvent::begin),
            latest: self.buffer.events.back().map(LiveEvent::begin),
        }
    }

    /// The events held, as a batch series (copied).
    pub fn to_time_series(&self) -> Result<TimeSeries> {
        self.buffer
            .snapshot("LiveSeries::to_time_series", &self.name, &self.schema)
    }

    /// The events held as pond-ts JSON ([`TimeSeries::to_json`]).
    pub fn to_json(&self, format: RowFormat) -> Result<String> {
        self.to_time_series()?.to_json(format)
    }
}

impl<T: NodeType> std::ops::Index<Node<T>> for LiveSeries {
    type Output = T;

    /// Panics when the node was removed or is another series' node; use
    /// [`LiveSeries::get`] to get an error instead.
    fn index(&self, node: Node<T>) -> &T {
        match self.get(node) {
            Ok(t) => t,
            Err(e) => panic!("{e}"),
        }
    }
}
