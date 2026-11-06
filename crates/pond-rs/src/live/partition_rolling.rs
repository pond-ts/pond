//! Rolling windows kept per partition and emitted together on a clock
//! (pond-ts `LivePartitionedSyncRolling` and `LivePartitionedFusedRolling`,
//! what a partitioned `rolling(…, { trigger: Trigger.every(…) })` builds).
//!
//! Each partition keeps its own windows. When any partition's event crosses
//! into a new clock bucket, every partition known so far emits one row,
//! keyed at that bucket's start: `[time, <partition column>, …columns]`,
//! partitions in the order they first sent an event (declared groups
//! first). A quiet partition's windows are first caught up to the event
//! that crossed.

use std::collections::HashMap;
use std::marker::PhantomData;
use std::sync::Arc;

use crate::column::Value;
use crate::duration::parse_duration;
use crate::error::{PondError, Result};
use crate::query::EventKey;
use crate::reducer::Agg;
use crate::series::{ColumnDef, ColumnKind};

use super::buffer::EventBuffer;
use super::event::{LiveEvent, LiveSchema};
use super::partition::{Hook, Recipe};
use super::rolling::{Keep, Span, TriggerKind, clock_crossed};
use super::sealed::State;
use super::{
    History, LiveRolling, LiveSeries, Node, NodeId, OutputKind, RollingOptions, RollingWindow,
    Slot, Sub,
};

/// The windows each partition keeps.
#[derive(Clone)]
enum Shape {
    Single { span: Span, mapping: Vec<Agg> },
    Fused(Vec<RollingWindow>),
}

/// Rolling windows per partition, emitted together on a clock. Built with
/// [`LiveSeries::partition_rolling`] and its siblings; read through the
/// owner.
pub struct LivePartitionedRolling {
    name: String,
    schema: Arc<LiveSchema>,
    shape: Shape,
    min_samples: usize,
    /// The schema the windows read (a partition's, or a chain's output).
    input: Vec<ColumnDef>,
    keys: Vec<String>,
    windows: Vec<LiveRolling>,
    index: HashMap<String, usize>,
    /// Each slot that feeds it: a position in `feed_keys`.
    pub(crate) feeds: HashMap<usize, usize>,
    /// Per feed, its partition value and its window once made (a window is
    /// made when the first event arrives, as pond-ts, which sets the order
    /// partitions emit in).
    feed_keys: Vec<(String, Option<usize>)>,
    step: i64,
    anchor: i64,
    last_bucket: Option<i128>,
    out: EventBuffer,
    keep: Keep,
    events_observed: u64,
    emissions: u64,
}

impl std::fmt::Debug for LivePartitionedRolling {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LivePartitionedRolling")
            .field("name", &self.name)
            .field("partitions", &self.keys)
            .field("len", &self.out.len())
            .finish_non_exhaustive()
    }
}

/// Counters for a [`LivePartitionedRolling`] (pond-ts `stats()`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PartitionRollingStats {
    /// Partitions with windows.
    pub partitions: usize,
    /// Events taken, including those replayed at build.
    pub events_observed: u64,
    /// Rows emitted (one per partition per tick).
    pub emissions: u64,
    /// Source events held by the fullest partition.
    pub window_size: usize,
}

impl LivePartitionedRolling {
    fn window(&self) -> LiveRolling {
        const CALL: &str = "LiveSeries::partition_rolling";
        let options = RollingOptions::new()
            .min_samples(self.min_samples)
            .history(History::Off);
        let built = match &self.shape {
            Shape::Single { span, mapping } => LiveRolling::single(
                CALL,
                self.name.clone(),
                &self.input,
                *span,
                mapping,
                &options,
            ),
            Shape::Fused(windows) => {
                LiveRolling::fused(CALL, self.name.clone(), &self.input, windows, &options)
            }
        };
        built.expect("checked when the node was built")
    }

    fn ensure(&mut self, key: &str) -> usize {
        if let Some(&i) = self.index.get(key) {
            return i;
        }
        let w = self.window();
        self.index.insert(key.to_string(), self.keys.len());
        self.keys.push(key.to_string());
        self.windows.push(w);
        self.keys.len() - 1
    }

    /// The window of feed `f`, made on its first event.
    fn window_of(&mut self, f: usize) -> usize {
        match self.feed_keys[f].1 {
            Some(w) => w,
            None => {
                let w = self.ensure(&self.feed_keys[f].0.clone());
                self.feed_keys[f].1 = Some(w);
                w
            }
        }
    }

    /// Take `event` from feed `f` (see `feeds`); the rows a tick emitted,
    /// if it crossed into a new bucket (built only when `hand_on`).
    pub(crate) fn ingest(&mut self, f: usize, event: &LiveEvent, hand_on: bool) -> Vec<LiveEvent> {
        self.events_observed += 1;
        let i = self.window_of(f);
        self.windows[i].take(event);
        let ts = event.begin();
        let Some(start) = clock_crossed(&mut self.last_bucket, ts, self.step, self.anchor) else {
            return Vec::new();
        };
        let mut emitted = Vec::new();
        for p in 0..self.windows.len() {
            self.windows[p].advance(ts);
            self.emissions += 1;
            let key = EventKey::time(start);
            let partition = Some(Value::String(self.keys[p].clone()));
            if hand_on {
                let mut values = Vec::with_capacity(self.schema.columns.len() - 1);
                values.push(partition);
                values.extend(self.windows[p].values());
                let event = LiveEvent::new(Arc::clone(&self.schema), key, values);
                if self.keep.on() {
                    self.out.append_ref(&event);
                }
                emitted.push(event);
            } else if self.keep.on() {
                // Straight into storage, no event built.
                self.out.append_values(
                    key,
                    std::iter::once(partition).chain(self.windows[p].snapshots()),
                );
            } else {
                self.windows[p].snapshots().for_each(drop);
            }
        }
        if self.keep.on() {
            self.keep.apply(&mut self.out);
        }
        emitted
    }

    pub(crate) fn schema_arc(&self) -> Arc<LiveSchema> {
        Arc::clone(&self.schema)
    }

    pub(crate) fn kept(&self) -> &EventBuffer {
        &self.out
    }

    /// The partitioned series' name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// `time`, the partition column (text: the partition value, as pond-ts
    /// writes it), then one column per mapping entry.
    pub fn schema(&self) -> &[ColumnDef] {
        &self.schema.columns
    }

    /// Partition values with windows, in emitting order.
    pub fn keys(&self) -> &[String] {
        &self.keys
    }

    /// Rows kept (per the `history` option).
    pub fn len(&self) -> usize {
        self.out.len()
    }

    /// `true` when there is nothing in it.
    pub fn is_empty(&self) -> bool {
        self.out.len() == 0
    }

    /// The row at `index`; negative positions count from the end.
    pub fn at(&self, index: i64) -> Option<LiveEvent> {
        self.out.at(index)
    }

    /// Every row kept, oldest first.
    pub fn events(&self) -> impl ExactSizeIterator<Item = LiveEvent> + '_ {
        self.out.iter()
    }

    /// Its counters (pond-ts `stats()`).
    pub fn stats(&self) -> PartitionRollingStats {
        PartitionRollingStats {
            partitions: self.keys.len(),
            events_observed: self.events_observed,
            emissions: self.emissions,
            window_size: self.windows.iter().map(|w| w.held_len()).max().unwrap_or(0),
        }
    }
}

impl LiveSeries {
    /// A rolling window of time over every partition of `from` (a
    /// partitioned series or a [`LiveSeries::per_partition`] chain), each
    /// partition with its own window, all emitting together when the clock
    /// trigger in `options` fires (pond-ts's partitioned `rolling` with
    /// `Trigger.every`): one row per partition, keyed at the bucket start.
    /// For an event or count trigger, build a rolling window per partition
    /// with [`LiveSeries::per_partition`] instead.
    pub fn partition_rolling(
        &mut self,
        from: impl Into<NodeId>,
        window: &str,
        mapping: &[Agg],
        options: &RollingOptions,
    ) -> Result<Node<LivePartitionedRolling>> {
        const CALL: &str = "LiveSeries::partition_rolling";
        let span = Span::Time(parse_duration(window)?);
        let shape = Shape::Single {
            span,
            mapping: mapping.to_vec(),
        };
        self.add_partition_rolling(CALL, from.into(), shape, options)
    }

    /// [`LiveSeries::partition_rolling`] over each partition's last `rows`
    /// events (at least 1).
    pub fn partition_rolling_rows(
        &mut self,
        from: impl Into<NodeId>,
        rows: usize,
        mapping: &[Agg],
        options: &RollingOptions,
    ) -> Result<Node<LivePartitionedRolling>> {
        const CALL: &str = "LiveSeries::partition_rolling_rows";
        if rows == 0 {
            return Err(PondError::InvalidData {
                call: CALL,
                message: "a window of rows needs at least one row".into(),
            });
        }
        let shape = Shape::Single {
            span: Span::Rows(rows),
            mapping: mapping.to_vec(),
        };
        self.add_partition_rolling(CALL, from.into(), shape, options)
    }

    /// Several windows of time per partition, emitted together on the
    /// clock (pond-ts's partitioned keyed `rolling({ "1m": …, "5m": … })`,
    /// which needs a clock trigger).
    pub fn partition_rolling_windows(
        &mut self,
        from: impl Into<NodeId>,
        windows: &[RollingWindow],
        options: &RollingOptions,
    ) -> Result<Node<LivePartitionedRolling>> {
        const CALL: &str = "LiveSeries::partition_rolling_windows";
        let shape = Shape::Fused(windows.to_vec());
        self.add_partition_rolling(CALL, from.into(), shape, options)
    }

    fn add_partition_rolling(
        &mut self,
        call: &'static str,
        from: NodeId,
        shape: Shape,
        options: &RollingOptions,
    ) -> Result<Node<LivePartitionedRolling>> {
        let (p, recipe) = self.partition_source(call, from)?;
        let TriggerKind::Clock { step, anchor } = options.trigger.0 else {
            return Err(PondError::InvalidData {
                call,
                message: "partition rolling emits on a clock (Trigger::every); for an event \
                          or count trigger, build a rolling window per partition with \
                          per_partition"
                    .into(),
            });
        };
        let input = match &recipe {
            None => self.partitioned(p).schema.columns.clone(),
            Some(r) => self.stub_schema(p, r)?.columns.clone(),
        };
        options.trigger.check_key(call, input[0].kind)?;
        let by = self.partitioned(p).column().to_string();
        let name = self.partitioned(p).name.clone();
        let min_samples = options.min_samples;
        // Built once to check the mapping and learn the columns.
        let template = {
            let options = RollingOptions::new().min_samples(min_samples);
            match &shape {
                Shape::Single { span, mapping } => {
                    LiveRolling::single(call, name.clone(), &input, *span, mapping, &options)
                }
                Shape::Fused(windows) => {
                    LiveRolling::fused(call, name.clone(), &input, windows, &options)
                }
            }
        }?;
        if by == "time" {
            return Err(PondError::DuplicateOutput { call, column: by });
        }
        let mut defs = vec![
            ColumnDef {
                name: "time".into(),
                kind: ColumnKind::Time,
                required: true,
            },
            ColumnDef {
                name: by.clone(),
                kind: ColumnKind::String,
                required: false,
            },
        ];
        for def in &template.schema()[1..] {
            if def.name == by || def.name == "time" {
                return Err(PondError::DuplicateOutput {
                    call,
                    column: def.name.clone(),
                });
            }
            defs.push(ColumnDef {
                required: false,
                ..def.clone()
            });
        }
        let schema = LiveSchema::new(defs);
        let mut node = LivePartitionedRolling {
            name,
            out: EventBuffer::new(Arc::clone(&schema)),
            schema,
            shape,
            min_samples,
            input,
            keys: Vec::new(),
            windows: Vec::new(),
            index: HashMap::new(),
            feeds: HashMap::new(),
            feed_keys: Vec::new(),
            step,
            anchor,
            last_bucket: None,
            keep: Keep::of(call, &options.history)?,
            events_observed: 0,
            emissions: 0,
        };
        if let Some(groups) = self.partitioned(p).groups() {
            for g in groups {
                node.ensure(g);
            }
        }
        let index = self.slots.len();
        self.slots.push(Slot {
            state: State::PartitionRolling(Box::new(node)),
            source: Some(p),
            series: self.slots[p].series,
            subs: Default::default(),
        });
        // Each partition's feed (the partition, or the chain built on it),
        // what they hold replayed in time order, then subscribed.
        let parts: Vec<(String, NodeId)> = self
            .partitioned(p)
            .partitions()
            .map(|(k, n)| (k.to_string(), n.id()))
            .collect();
        let mut feeds = Vec::with_capacity(parts.len());
        for (key, part) in parts {
            let feed = match &recipe {
                None => part,
                Some(r) => r(self, part)?,
            };
            feeds.push((key, self.slot_of(call, feed)?));
        }
        let mut history: Vec<(usize, LiveEvent)> = Vec::new();
        for (k, &(_, feed)) in feeds.iter().enumerate() {
            history.extend(self.held(feed).map(|e| (k, e)));
        }
        history.sort_by_key(|(_, e)| e.begin());
        // Feeds are registered first (in partition order), windows are made
        // as the replay reaches each feed's first event.
        for (key, feed) in feeds {
            self.feed_rolling(index, feed, key);
        }
        let State::PartitionRolling(node) = &mut self.slots[index].state else {
            unreachable!()
        };
        for (k, event) in &history {
            node.ingest(*k, event, false);
        }
        self.partitioned_mut(p).hooks.push(Hook::Rolling {
            recipe,
            target: index,
        });
        Ok(Node {
            id: self.id_of(index),
            _type: PhantomData,
        })
    }

    /// Have partition rolling `target` take what `feed` (partition `key`'s
    /// feed) emits.
    pub(super) fn feed_rolling(&mut self, target: usize, feed: usize, key: String) {
        let State::PartitionRolling(node) = &mut self.slots[target].state else {
            unreachable!("slot {target} is not partition rolling")
        };
        node.feeds.insert(feed, node.feed_keys.len());
        node.feed_keys.push((key, None));
        self.slots[feed].subs[OutputKind::Event.slot()].push(Sub::Child(target));
    }

    /// `from` as a partitioned slot, and the chain to run on each partition
    /// first (a [`LiveSeries::per_partition`] chain), if any.
    pub(super) fn partition_source(
        &self,
        call: &'static str,
        from: NodeId,
    ) -> Result<(usize, Option<Recipe>)> {
        let i = self.slot_of(call, from)?;
        match &self.slots[i].state {
            State::Partitioned(_) => Ok((i, None)),
            State::PartitionedView(v) => Ok((v.partitioned, Some(Arc::clone(&v.recipe)))),
            _ => Err(super::partition::not_partitioned(call)),
        }
    }
}
