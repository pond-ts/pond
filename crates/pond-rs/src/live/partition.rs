//! Live partitions (pond-ts `LivePartitionedSeries` and
//! `LivePartitionedView`): [`LiveSeries::partition_by`] routes the root's
//! events into one [`SubSeries`] per value of a column, each with its own
//! ordering and retention; [`LiveSeries::per_partition`] describes a chain
//! of nodes to build on every partition; [`LiveSeries::collect`] and
//! [`LiveSeries::apply`] gather what the partitions (or their chains) emit
//! into one series.
//!
//! Routing follows pond-ts exactly, because the order of outputs depends
//! on it:
//! - On a root kept in column chunks (strict, keyed by time: the default)
//!   the partitions take a push before the root's own `Event` outputs.
//!   Each partition first appears (and is built) in the order of its first
//!   row; then every row's `Event` goes out in the push's order across
//!   partitions; then each partition finishes (retention, `Batch`, `Evict`,
//!   settle) in the order of its last row in the push.
//! - Otherwise each root event is routed when it reaches the partitioned
//!   node, as one push into its partition.

use std::collections::HashMap;
use std::marker::PhantomData;
use std::sync::Arc;

use crate::column::{Scalar, Value};
use crate::duration::parse_duration;
use crate::error::{PondError, Result};
use crate::grid::js_number;
use crate::query::{EventKey, compare_keys};
use crate::series::ColumnDef;

use super::event::{LiveEvent, LiveSchema};
use super::sealed::State;
use super::{LiveSeries, Node, NodeId, OrderingMode, Output, OutputKind, Slot, Sub, SubSeries};

/// A chain of nodes built on one partition: given the owner and the
/// partition, build and return the node whose events are the chain's
/// output.
pub(crate) type Recipe = Arc<dyn Fn(&mut LiveSeries, NodeId) -> Result<NodeId> + Send + Sync>;

/// Options for [`LiveSeries::partition_by`]. What is not set is taken
/// from the root (pond-ts inherits ordering, grace window and retention);
/// setting either retention limit replaces both.
#[derive(Debug, Clone, Default)]
pub struct PartitionOptions {
    groups: Option<Vec<String>>,
    ordering: Option<OrderingMode>,
    grace_window: Option<String>,
    max_events: Option<usize>,
    max_age: Option<String>,
}

impl PartitionOptions {
    pub fn new() -> Self {
        Self::default()
    }

    /// The partition values, declared up front: partitions are built for
    /// them at once, in this order, and a push with any other value is
    /// refused.
    pub fn groups(mut self, groups: &[&str]) -> Self {
        self.groups = Some(groups.iter().map(|g| g.to_string()).collect());
        self
    }

    pub fn ordering(mut self, mode: OrderingMode) -> Self {
        self.ordering = Some(mode);
        self
    }

    pub fn grace_window(mut self, duration: &str) -> Self {
        self.grace_window = Some(duration.into());
        self
    }

    /// Keep at most `n` events in each partition.
    pub fn max_events(mut self, n: usize) -> Self {
        self.max_events = Some(n);
        self
    }

    /// Keep each partition's events no older than `duration` before the
    /// latest event the root has routed (a quiet partition ages out too).
    pub fn max_age(mut self, duration: &str) -> Self {
        self.max_age = Some(duration.into());
        self
    }
}

/// Options for the series [`LiveSeries::collect`] and
/// [`LiveSeries::apply`] gather into. Ordering and grace window are taken
/// from the partitions unless set; retention is only what you set (it
/// keeps everything otherwise, as pond-ts).
#[derive(Debug, Clone, Default)]
pub struct CollectOptions {
    name: Option<String>,
    ordering: Option<OrderingMode>,
    grace_window: Option<String>,
    max_events: Option<usize>,
    max_age: Option<String>,
}

impl CollectOptions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn name(mut self, name: &str) -> Self {
        self.name = Some(name.into());
        self
    }

    pub fn ordering(mut self, mode: OrderingMode) -> Self {
        self.ordering = Some(mode);
        self
    }

    pub fn grace_window(mut self, duration: &str) -> Self {
        self.grace_window = Some(duration.into());
        self
    }

    pub fn max_events(mut self, n: usize) -> Self {
        self.max_events = Some(n);
        self
    }

    pub fn max_age(mut self, duration: &str) -> Self {
        self.max_age = Some(duration.into());
        self
    }
}

/// What a new partition gets: subscribed into a gathered series, or a
/// chain built on it whose output feeds one.
#[derive(Clone)]
pub(crate) enum Hook {
    Collect(usize),
    Apply {
        recipe: Recipe,
        target: usize,
    },
    /// Partition rolling `target` takes what the partition (or `recipe`
    /// built on it) emits.
    Rolling {
        recipe: Option<Recipe>,
        target: usize,
    },
}

impl Hook {
    pub(crate) fn target(&self) -> usize {
        match self {
            Hook::Collect(t) | Hook::Apply { target: t, .. } | Hook::Rolling { target: t, .. } => {
                *t
            }
        }
    }
}

/// The root's events split by the value of one column, one [`SubSeries`]
/// per value (pond-ts `LivePartitionedSeries`). Build on it with
/// [`LiveSeries::per_partition`], [`LiveSeries::collect`] and
/// [`LiveSeries::apply`]; read a partition with
/// [`LivePartitioned::partition`].
pub struct LivePartitioned {
    pub(crate) name: String,
    pub(crate) schema: Arc<LiveSchema>,
    column: String,
    /// The column's index among the value columns.
    by: usize,
    groups: Option<Vec<String>>,
    pub(crate) ordering: OrderingMode,
    pub(crate) grace_ms: Option<i64>,
    max_events: Option<usize>,
    max_age_ms: Option<i64>,
    /// Routed a push at a time (see the module docs).
    pub(crate) chunked: bool,
    keys: Vec<String>,
    parts: Vec<NodeId>,
    index: HashMap<String, usize>,
    pub(crate) hooks: Vec<Hook>,
    routed: u64,
    /// pond-ts sweeps every partition for age when the latest routed
    /// event has moved this far since the last sweep (`max_age / 8`).
    sweep_every: Option<i64>,
    watermark: Option<i64>,
    last_sweep: Option<i64>,
}

impl std::fmt::Debug for LivePartitioned {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LivePartitioned")
            .field("column", &self.column)
            .field("partitions", &self.keys)
            .finish_non_exhaustive()
    }
}

/// Counters for a [`LivePartitioned`] (pond-ts `stats()`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PartitionStats {
    /// Partitions built.
    pub partitions: usize,
    /// Root events routed to a partition, ever.
    pub events_routed: u64,
}

impl LivePartitioned {
    /// The column it partitions by.
    pub fn column(&self) -> &str {
        &self.column
    }

    /// The declared values, if any.
    pub fn groups(&self) -> Option<&[String]> {
        self.groups.as_deref()
    }

    /// The schema of each partition (the root's).
    pub fn schema(&self) -> &[ColumnDef] {
        &self.schema.columns
    }

    /// Partition values, in the order the partitions were built (declared
    /// order first). A row without a value goes to `" undefined"` (pond-ts's
    /// key, with its leading space); numbers are written as JavaScript
    /// writes them.
    pub fn keys(&self) -> &[String] {
        &self.keys
    }

    /// The partition for a value.
    pub fn partition(&self, key: &str) -> Option<Node<SubSeries>> {
        self.index.get(key).map(|&i| Node {
            id: self.parts[i],
            _type: PhantomData,
        })
    }

    /// Every partition with its value, in build order (pond-ts `toMap()`).
    pub fn partitions(&self) -> impl ExactSizeIterator<Item = (&str, Node<SubSeries>)> + '_ {
        self.keys.iter().zip(&self.parts).map(|(k, id)| {
            (
                k.as_str(),
                Node {
                    id: *id,
                    _type: PhantomData,
                },
            )
        })
    }

    pub fn stats(&self) -> PartitionStats {
        PartitionStats {
            partitions: self.keys.len(),
            events_routed: self.routed,
        }
    }

    /// The partition value of `event`, as pond-ts writes it (`String(v)`).
    pub(crate) fn key_of(&self, event: &LiveEvent) -> String {
        match &event.values()[self.by] {
            None => " undefined".into(),
            Some(Value::Number(x)) => js_number(*x),
            Some(Value::Decimal(d)) => d.to_string(),
            Some(Value::String(s)) => s.clone(),
            Some(Value::Boolean(b)) => b.to_string(),
            Some(Value::Array(items)) => items
                .iter()
                .map(|s| match s {
                    Scalar::Number(x) => js_number(*x),
                    Scalar::String(t) => t.clone(),
                    Scalar::Boolean(b) => b.to_string(),
                })
                .collect::<Vec<_>>()
                .join(","),
        }
    }

    fn slot_of(&self, key: &str) -> Option<usize> {
        self.index.get(key).map(|&i| self.parts[i].index as usize)
    }
}

/// A chain to build on every partition, not built yet (pond-ts
/// `LivePartitionedView`): [`LiveSeries::collect`] or
/// [`LiveSeries::apply`] builds it on each partition (and on partitions
/// that appear later), [`LiveSeries::partition_outputs`] on each partition
/// there is now.
pub struct PartitionedView {
    pub(crate) partitioned: usize,
    pub(crate) recipe: Recipe,
    pub(crate) schema: Arc<LiveSchema>,
}

impl std::fmt::Debug for PartitionedView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PartitionedView").finish_non_exhaustive()
    }
}

impl PartitionedView {
    /// The schema of the chain's output.
    pub fn schema(&self) -> &[ColumnDef] {
        &self.schema.columns
    }
}

/// One partition's share of a push routed a push at a time.
struct Share {
    slot: usize,
    rows: Vec<usize>,
}

impl LiveSeries {
    /// Split the root's events by the value of `column` (pond-ts
    /// `partitionBy`): each value gets its own [`SubSeries`], built when
    /// the value first arrives (or at once for declared
    /// [`PartitionOptions::groups`]), holding that value's events under its
    /// own ordering and retention. Built over what the root holds now.
    ///
    /// pond-rs builds partitions on the root only (pond-ts also on any
    /// series). A push the partitions would refuse (a value outside the
    /// declared groups, an event a stricter partition ordering refuses) is
    /// refused whole before anything is stored; pond-ts stores it in the
    /// root, delivers the rest and then throws.
    pub fn partition_by(
        &mut self,
        from: impl Into<NodeId>,
        column: &str,
        options: &PartitionOptions,
    ) -> Result<Node<LivePartitioned>> {
        const CALL: &str = "LiveSeries::partition_by";
        let bad = |message: String| PondError::InvalidData {
            call: CALL,
            message,
        };
        let source = self.slot_of(CALL, from.into())?;
        if source != 0 {
            return Err(bad(
                "partitions are built on the root series only (pond-rs)".into(),
            ));
        }
        let root = self.core();
        let schema = Arc::clone(&root.schema);
        let by = schema
            .value_index(column)
            .ok_or_else(|| PondError::UnknownColumn {
                call: CALL,
                column: column.into(),
                available: schema.values().iter().map(|c| c.name.clone()).collect(),
            })?;
        if let Some(groups) = &options.groups {
            if groups.is_empty() {
                return Err(bad("groups cannot be empty".into()));
            }
            for (i, g) in groups.iter().enumerate() {
                if groups[..i].contains(g) {
                    return Err(bad(format!("groups lists {g:?} twice")));
                }
            }
        }
        let ordering = options.ordering.unwrap_or(root.ordering);
        let grace_ms = match &options.grace_window {
            Some(g) => Some(parse_duration(g)?),
            None if ordering == OrderingMode::Reorder => root.grace_ms,
            None => None,
        };
        let (max_events, max_age_ms) = if options.max_events.is_some() || options.max_age.is_some()
        {
            (
                options.max_events,
                options.max_age.as_deref().map(parse_duration).transpose()?,
            )
        } else {
            (root.max_events, root.max_age_ms)
        };
        check_series_options(CALL, ordering, grace_ms, max_age_ms)?;
        let chunked = root.chunked && ordering == OrderingMode::Strict;
        let partitioned = LivePartitioned {
            name: root.name.clone(),
            schema,
            column: column.into(),
            by,
            groups: options.groups.clone(),
            ordering,
            grace_ms,
            max_events,
            max_age_ms,
            chunked,
            keys: Vec::new(),
            parts: Vec::new(),
            index: HashMap::new(),
            hooks: Vec::new(),
            routed: 0,
            sweep_every: max_age_ms.map(|a| (a / 8).max(1)),
            watermark: None,
            last_sweep: None,
        };
        // Declared partitions, then the root's history.
        let p = self.slots.len();
        self.slots.push(Slot {
            state: State::Partitioned(partitioned),
            source: Some(0),
            series: 0,
            subs: Default::default(),
        });
        if let Some(groups) = options.groups.clone() {
            for g in groups {
                self.spawn(p, g)?;
            }
        }
        let history: Vec<LiveEvent> = self.core().buffer.iter().collect();
        let mut out = Vec::new();
        if chunked {
            // pond-ts groups the history by partition, one push each.
            let mut shares: Vec<(String, Vec<LiveEvent>)> = Vec::new();
            for event in history {
                let key = self.partitioned(p).key_of(&event);
                match shares.iter_mut().find(|(k, _)| *k == key) {
                    Some((_, evs)) => evs.push(event),
                    None => shares.push((key, vec![event])),
                }
            }
            for (key, events) in shares {
                let part = self.ensure_partition(p, &key)?;
                self.partitioned_mut(p).routed += events.len() as u64;
                self.ingest_series(part, events, &mut out);
            }
            self.routers.push(p);
        } else {
            for event in &history {
                self.route_one(p, event, &mut out)?;
            }
            self.slots[0].subs[OutputKind::Event.slot()].push(Sub::Child(p));
        }
        self.take_failure()?;
        Ok(Node {
            id: self.id_of(p),
            _type: PhantomData,
        })
    }

    /// A chain to build on every partition of `from` (a partitioned series
    /// or another such chain): `build` gets the owner and one partition (or
    /// the previous chain's output on it), builds nodes on it with the
    /// usual methods, and returns the last (pond-ts's partitioned `fill`,
    /// `diff`, `rolling`, … are this with one step). Nothing is built until
    /// [`LiveSeries::collect`], [`LiveSeries::apply`] or
    /// [`LiveSeries::partition_outputs`]; `build` runs once now on an empty
    /// series to learn the output schema (and catch bad arguments), and
    /// again for every partition each of those builds on, so it must build
    /// the same chain every time.
    pub fn per_partition<F>(
        &mut self,
        from: impl Into<NodeId>,
        build: F,
    ) -> Result<Node<PartitionedView>>
    where
        F: Fn(&mut LiveSeries, NodeId) -> Result<NodeId> + Send + Sync + 'static,
    {
        const CALL: &str = "LiveSeries::per_partition";
        let (p, recipe) = self.chain_of(CALL, from.into(), Arc::new(build))?;
        let schema = self.stub_schema(p, &recipe)?;
        let index = self.slots.len();
        self.slots.push(Slot {
            state: State::PartitionedView(PartitionedView {
                partitioned: p,
                recipe,
                schema,
            }),
            source: None,
            series: 0,
            subs: Default::default(),
        });
        Ok(Node {
            id: self.id_of(index),
            _type: PhantomData,
        })
    }

    /// One series of everything the partitions of `from` take (a
    /// partitioned series), or everything their chains emit (a
    /// [`LiveSeries::per_partition`] chain, built now on each partition and
    /// on partitions that appear later). It starts with what they hold
    /// now, in time order, then takes each event as it is emitted. It only
    /// gathers: what a partition evicts stays (pond-ts `collect`).
    pub fn collect(
        &mut self,
        from: impl Into<NodeId>,
        options: &CollectOptions,
    ) -> Result<Node<SubSeries>> {
        const CALL: &str = "LiveSeries::collect";
        let from = self.slot_of(CALL, from.into())?;
        match &self.slots[from].state {
            State::Partitioned(_) => {}
            State::PartitionedView(v) => {
                let (p, recipe) = (v.partitioned, Arc::clone(&v.recipe));
                return self.apply_recipe(CALL, p, recipe, options);
            }
            _ => return Err(not_partitioned(CALL)),
        }
        let p = from;
        let schema = Arc::clone(&self.partitioned(p).schema);
        let target = self.gathering_series(CALL, p, schema, options)?;
        let mut history: Vec<LiveEvent> = Vec::new();
        for part in self.partitioned(p).parts.clone() {
            history.extend(self.series(part.index as usize).buffer.iter());
        }
        // A stable sort by start, as pond-ts.
        history.sort_by_key(|e| e.begin());
        let mut out = Vec::new();
        if !history.is_empty() {
            self.ingest_series(target, history, &mut out);
        }
        for part in self.partitioned(p).parts.clone() {
            self.subscribe(part.index as usize, target);
        }
        self.partitioned_mut(p).hooks.push(Hook::Collect(target));
        self.take_failure()?;
        Ok(self.series_node(target))
    }

    /// `build` run on every partition of `from` (a partitioned series or a
    /// [`LiveSeries::per_partition`] chain, which it continues), now and as
    /// partitions appear, with every output gathered into one series as in
    /// [`LiveSeries::collect`] (pond-ts `apply`).
    pub fn apply<F>(
        &mut self,
        from: impl Into<NodeId>,
        build: F,
        options: &CollectOptions,
    ) -> Result<Node<SubSeries>>
    where
        F: Fn(&mut LiveSeries, NodeId) -> Result<NodeId> + Send + Sync + 'static,
    {
        const CALL: &str = "LiveSeries::apply";
        let (p, recipe) = self.chain_of(CALL, from.into(), Arc::new(build))?;
        self.apply_recipe(CALL, p, recipe, options)
    }

    /// Build the chain `from` describes on each partition there is now, and
    /// return each output with its partition value (pond-ts's partitioned
    /// view `toMap()`). Partitions that appear later get nothing from this.
    pub fn partition_outputs(
        &mut self,
        from: Node<PartitionedView>,
    ) -> Result<Vec<(String, NodeId)>> {
        const CALL: &str = "LiveSeries::partition_outputs";
        let i = self.slot_of(CALL, from.id)?;
        let State::PartitionedView(v) = &self.slots[i].state else {
            unreachable!("a Node<PartitionedView>")
        };
        let (p, recipe) = (v.partitioned, Arc::clone(&v.recipe));
        let parts: Vec<(String, NodeId)> = {
            let pt = self.partitioned(p);
            pt.keys
                .iter()
                .cloned()
                .zip(pt.parts.iter().copied())
                .collect()
        };
        let mut outs = Vec::with_capacity(parts.len());
        for (key, part) in parts {
            outs.push((key, recipe(self, part)?));
        }
        Ok(outs)
    }

    fn apply_recipe(
        &mut self,
        call: &'static str,
        p: usize,
        recipe: Recipe,
        options: &CollectOptions,
    ) -> Result<Node<SubSeries>> {
        let schema = self.stub_schema(p, &recipe)?;
        let target = self.gathering_series(call, p, schema, options)?;
        let parts = self.partitioned(p).parts.clone();
        let mut outputs = Vec::with_capacity(parts.len());
        for part in parts {
            let o = recipe(self, part)?;
            outputs.push(self.slot_of(call, o)?);
        }
        let mut history: Vec<LiveEvent> = Vec::new();
        for &o in &outputs {
            history.extend(self.held(o));
        }
        history.sort_by_key(|e| e.begin());
        let mut out = Vec::new();
        if !history.is_empty() {
            self.ingest_series(target, history, &mut out);
        }
        for o in outputs {
            self.subscribe(o, target);
        }
        self.partitioned_mut(p)
            .hooks
            .push(Hook::Apply { recipe, target });
        self.take_failure()?;
        Ok(self.series_node(target))
    }

    /// The partitioned slot and the full chain for `from` followed by
    /// `then`.
    fn chain_of(&self, call: &'static str, from: NodeId, then: Recipe) -> Result<(usize, Recipe)> {
        let i = self.slot_of(call, from)?;
        match &self.slots[i].state {
            State::Partitioned(_) => Ok((i, then)),
            State::PartitionedView(v) => {
                let before = Arc::clone(&v.recipe);
                let recipe: Recipe = Arc::new(move |live: &mut LiveSeries, part: NodeId| {
                    let mid = before(live, part)?;
                    then(live, mid)
                });
                Ok((v.partitioned, recipe))
            }
            _ => Err(not_partitioned(call)),
        }
    }

    /// The output schema of `recipe`, from a run on an empty series with
    /// the partitions' schema (pond-ts's stub).
    pub(super) fn stub_schema(&self, p: usize, recipe: &Recipe) -> Result<Arc<LiveSchema>> {
        let pt = self.partitioned(p);
        let mut stub = LiveSeries::new(format!("{}/_stub", pt.name), pt.schema.columns.clone())?;
        let root = stub.root();
        let out = recipe(&mut stub, root)?;
        let i = stub.slot_of("LiveSeries::per_partition", out)?;
        Ok(stub.schema_of(i))
    }

    /// A new series that gathers from partitioned slot `p`.
    fn gathering_series(
        &mut self,
        call: &'static str,
        p: usize,
        schema: Arc<LiveSchema>,
        options: &CollectOptions,
    ) -> Result<usize> {
        let pt = self.partitioned(p);
        let ordering = options.ordering.unwrap_or(pt.ordering);
        let grace_ms = match &options.grace_window {
            Some(g) => Some(parse_duration(g)?),
            None => pt.grace_ms,
        }
        .filter(|_| ordering == OrderingMode::Reorder);
        let max_age_ms = options.max_age.as_deref().map(parse_duration).transpose()?;
        check_series_options(call, ordering, grace_ms, max_age_ms)?;
        let series = SubSeries::new(
            options.name.clone().unwrap_or_else(|| pt.name.clone()),
            schema,
            ordering,
            grace_ms,
            options.max_events,
            max_age_ms,
            false,
        );
        let index = self.slots.len();
        self.slots.push(Slot {
            state: State::Series(series),
            source: Some(p),
            series: index,
            subs: Default::default(),
        });
        Ok(index)
    }

    /// Have `target` (a series) take the events `source` emits.
    fn subscribe(&mut self, source: usize, target: usize) {
        self.slots[source].subs[OutputKind::Event.slot()].push(Sub::Child(target));
    }

    fn series_node(&self, i: usize) -> Node<SubSeries> {
        Node {
            id: self.id_of(i),
            _type: PhantomData,
        }
    }

    pub(super) fn partitioned(&self, p: usize) -> &LivePartitioned {
        match &self.slots[p].state {
            State::Partitioned(pt) => pt,
            _ => unreachable!("slot {p} is not partitioned"),
        }
    }

    pub(super) fn partitioned_mut(&mut self, p: usize) -> &mut LivePartitioned {
        match &mut self.slots[p].state {
            State::Partitioned(pt) => pt,
            _ => unreachable!("slot {p} is not partitioned"),
        }
    }

    /// The partition for `key`, built if new (groups were checked before
    /// the push).
    fn ensure_partition(&mut self, p: usize, key: &str) -> Result<usize> {
        match self.partitioned(p).slot_of(key) {
            Some(s) => Ok(s),
            None => self.spawn(p, key.to_string()),
        }
    }

    /// Build partition `key` and run the hooks on it, oldest first.
    fn spawn(&mut self, p: usize, key: String) -> Result<usize> {
        let pt = self.partitioned(p);
        let series = SubSeries::new(
            format!("{}/{key}", pt.name),
            Arc::clone(&pt.schema),
            pt.ordering,
            pt.grace_ms,
            pt.max_events,
            pt.max_age_ms,
            pt.chunked,
        );
        let hooks = pt.hooks.clone();
        let index = self.slots.len();
        self.slots.push(Slot {
            state: State::Series(series),
            source: Some(p),
            series: index,
            subs: Default::default(),
        });
        let id = self.id_of(index);
        let pt = self.partitioned_mut(p);
        pt.index.insert(key.clone(), pt.keys.len());
        pt.keys.push(key.clone());
        pt.parts.push(id);
        for hook in hooks {
            match hook {
                Hook::Collect(target) => self.subscribe(index, target),
                Hook::Apply { recipe, target } => {
                    let o = recipe(self, id)?;
                    let o = self.slot_of("LiveSeries::apply", o)?;
                    self.subscribe(o, target);
                }
                Hook::Rolling { recipe, target } => {
                    let feed = match recipe {
                        Some(r) => {
                            let o = r(self, id)?;
                            self.slot_of("LiveSeries::partition_rolling", o)?
                        }
                        None => index,
                    };
                    self.feed_rolling(target, feed, key.clone());
                }
            }
        }
        Ok(index)
    }

    /// One root event reaching partitioned slot `p` (not routed a push at
    /// a time): one push into its partition.
    pub(super) fn route_one(
        &mut self,
        p: usize,
        event: &LiveEvent,
        out: &mut Vec<Output>,
    ) -> Result<()> {
        let key = self.partitioned(p).key_of(event);
        let part = self.ensure_partition(p, &key)?;
        self.partitioned_mut(p).routed += 1;
        self.ingest_series(part, vec![event.clone()], out);
        self.advance_watermark(p, event.begin(), out);
        Ok(())
    }

    /// A push routed a push at a time to partitioned slot `p` (see the
    /// module docs).
    pub(super) fn route_push(
        &mut self,
        p: usize,
        events: &[LiveEvent],
        out: &mut Vec<Output>,
    ) -> Result<()> {
        // 1. Each partition's rows, partitions in order of first row
        //    (built here when new).
        let mut shares: Vec<Share> = Vec::new();
        let mut share_of: Vec<usize> = Vec::with_capacity(events.len());
        for (r, event) in events.iter().enumerate() {
            let key = self.partitioned(p).key_of(event);
            let slot = self.ensure_partition(p, &key)?;
            let s = match shares.iter().position(|s| s.slot == slot) {
                Some(s) => s,
                None => {
                    shares.push(Share {
                        slot,
                        rows: Vec::new(),
                    });
                    shares.len() - 1
                }
            };
            shares[s].rows.push(r);
            share_of.push(s);
        }
        let pt = self.partitioned_mut(p);
        pt.routed += events.len() as u64;
        for share in &shares {
            self.series_mut(share.slot).ingested += share.rows.len() as u64;
        }
        // 2. Every row's `Event`, in the push's order.
        for (r, event) in events.iter().enumerate() {
            let part = shares[share_of[r]].slot;
            let place = super::reduce::Place {
                at: self.series(part).buffer.position(event.key()),
                trimmed: 0,
            };
            self.emit_event(part, event, Some(place), out);
            self.series_mut(part).buffer.insert(event);
        }
        // 3. Each partition finishes, in order of its last row.
        let mut close: Vec<usize> = Vec::with_capacity(shares.len());
        for &s in share_of.iter().rev() {
            if !close.contains(&s) {
                close.push(s);
            }
        }
        for &s in close.iter().rev() {
            let share = &shares[s];
            let part = share.slot;
            let n = self.series(part).retention_count();
            if !self.slots[part].subs[OutputKind::Batch.slot()].is_empty() {
                let added: Vec<LiveEvent> = share.rows.iter().map(|&r| events[r].clone()).collect();
                self.emit(part, OutputKind::Batch, out, |node| Output::Batch {
                    node,
                    events: added.clone(),
                });
            }
            if n > 0 {
                self.evict_series(part, n, out);
            }
            self.settle(part, out);
        }
        if let Some(last) = events.last() {
            self.advance_watermark(p, last.begin(), out);
        }
        Ok(())
    }

    /// pond-ts's quiet-partition sweep: when the latest routed event has
    /// moved `max_age / 8` since the last sweep, every partition drops what
    /// is older than `max_age` before it.
    fn advance_watermark(&mut self, p: usize, begin: i64, out: &mut Vec<Output>) {
        let pt = self.partitioned_mut(p);
        let Some(every) = pt.sweep_every else {
            return;
        };
        let wm = pt.watermark.map_or(begin, |w| w.max(begin));
        pt.watermark = Some(wm);
        if pt.last_sweep.is_some_and(|last| wm - last < every) {
            return;
        }
        pt.last_sweep = Some(wm);
        let age = pt.max_age_ms.expect("a sweep needs max_age");
        let parts: Vec<usize> = pt.parts.iter().map(|id| id.index as usize).collect();
        for part in parts {
            let n = self.series(part).buffer.count_before(wm - age);
            if n == 0 {
                continue;
            }
            // pond-ts settles after a sweep only when something follows
            // the partition's evictions.
            let follows = !self.slots[part].subs[OutputKind::Evict.slot()].is_empty();
            self.evict_series(part, n, out);
            if follows {
                self.settle(part, out);
            }
        }
    }

    /// Before a push stores anything: what every partitioned node would
    /// refuse (pond-ts throws after storing it in the root).
    pub(super) fn check_partitions(&self, events: &[LiveEvent]) -> Result<()> {
        const CALL: &str = "LiveSeries::push";
        for slot in &self.slots {
            let State::Partitioned(pt) = &slot.state else {
                continue;
            };
            if slot.source.is_none() {
                continue;
            }
            let root = self.core();
            let mut root_last = root.buffer.last_key().cloned();
            let mut part_last: HashMap<String, Option<EventKey>> = HashMap::new();
            for (i, event) in events.iter().enumerate() {
                let key = event.key();
                let late = root_last
                    .as_ref()
                    .is_some_and(|l| compare_keys(l, key) == std::cmp::Ordering::Greater);
                if late && root.ordering == OrderingMode::Drop {
                    continue;
                }
                if !late {
                    root_last = Some(key.clone());
                }
                let value = pt.key_of(event);
                if let Some(groups) = &pt.groups
                    && !groups.contains(&value)
                {
                    let shown = if value == " undefined" {
                        "no value".to_string()
                    } else {
                        format!("{value:?}")
                    };
                    return Err(PondError::InvalidData {
                        call: CALL,
                        message: format!(
                            "row {i}: partition value {shown} for column '{}' is not in the declared groups {:?}",
                            pt.column, groups
                        ),
                    });
                }
                let last = part_last.entry(value.clone()).or_insert_with(|| {
                    pt.slot_of(&value).and_then(|s| match &self.slots[s].state {
                        State::Series(s) => s.buffer.last_key().cloned(),
                        _ => None,
                    })
                });
                let Some(latest) = last
                    .as_ref()
                    .filter(|l| compare_keys(l, key) == std::cmp::Ordering::Greater)
                else {
                    *last = Some(key.clone());
                    continue;
                };
                match pt.ordering {
                    OrderingMode::Strict => {
                        return Err(PondError::InvalidData {
                            call: CALL,
                            message: format!(
                                "row {i}: partition {value:?} keeps strict order and this event starts at {}, before its latest at {}",
                                key.begin(),
                                latest.begin()
                            ),
                        });
                    }
                    OrderingMode::Reorder => {
                        if let Some(grace) = pt.grace_ms
                            && latest.begin() - key.begin() > grace
                        {
                            return Err(PondError::InvalidData {
                                call: CALL,
                                message: format!(
                                    "row {i}: event at {} is outside partition {value:?}'s grace window (latest {}, grace {grace} ms)",
                                    key.begin(),
                                    latest.begin()
                                ),
                            });
                        }
                    }
                    OrderingMode::Drop => {}
                }
            }
        }
        Ok(())
    }
}

pub(super) fn not_partitioned(call: &'static str) -> PondError {
    PondError::InvalidData {
        call,
        message: "expected a partitioned series (partition_by) or a per_partition chain".into(),
    }
}

/// The checks `LiveSeries::with_options` makes on ordering, grace window
/// and age.
pub(super) fn check_series_options(
    call: &'static str,
    ordering: OrderingMode,
    grace_ms: Option<i64>,
    max_age_ms: Option<i64>,
) -> Result<()> {
    let bad = |message: String| PondError::InvalidData { call, message };
    if grace_ms.is_some() && ordering != OrderingMode::Reorder {
        return Err(bad(
            "grace_window is only valid with OrderingMode::Reorder".into()
        ));
    }
    if let (Some(g), Some(a)) = (grace_ms, max_age_ms)
        && g > a
    {
        return Err(bad(format!(
            "grace_window ({g} ms) cannot exceed max_age ({a} ms): a late event accepted within grace would be evicted at once"
        )));
    }
    Ok(())
}
