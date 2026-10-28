//! How events move through the nodes, written once for two places it
//! runs: the whole owner on one thread, and one shard of a partitioned
//! node's partitions (see `shard.rs`), which may run beside other shards.
//!
//! A shard holds only its own nodes. What it would hand to a node outside
//! it (a gathered series, partition rolling) it writes down instead, and the owner replays those in the
//! order one thread would have made them.

use super::event::LiveEvent;
use super::reduce::Place;
use super::rolling::After;
use super::sealed::State;
use super::{NodeId, Output, OutputKind, Slot, Sub, SubSeries};

pub(super) trait Net {
    fn slot(&self, i: usize) -> &Slot;
    fn slot_mut(&mut self, i: usize) -> &mut Slot;
    /// Whether node `i` is in this net (every node is, for the owner).
    fn here(&self, i: usize) -> bool;
    /// Every reduce, oldest first.
    fn reduces(&self) -> &[usize];
    fn node_id(&self, i: usize) -> NodeId;
    /// One event for a node of the partition layer (a partitioned node, a
    /// gathered series, partition rolling) or a node outside this net.
    fn far(
        &mut self,
        c: usize,
        from: usize,
        event: &LiveEvent,
        place: Option<Place>,
        hand_on: bool,
        out: &mut Vec<Output>,
    );

    fn sub_series(&self, i: usize) -> &SubSeries {
        match &self.slot(i).state {
            State::Series(s) => s,
            _ => unreachable!("slot {i} is not a series"),
        }
    }

    fn sub_series_mut(&mut self, i: usize) -> &mut SubSeries {
        match &mut self.slot_mut(i).state {
            State::Series(s) => s,
            _ => unreachable!("slot {i} is not a series"),
        }
    }

    /// The end of a push into series `series` (pond-ts's settle hook,
    /// [PND-REDUCETICK]): each reduce below it emits for what reached it,
    /// oldest node first.
    fn settle(&mut self, series: usize, out: &mut Vec<Output>) {
        for k in 0..self.reduces().len() {
            let i = self.reduces()[k];
            if !self.here(i) || self.slot(i).series != series {
                continue;
            }
            let hand_on = !self.slot(i).subs[OutputKind::Event.slot()].is_empty();
            let State::Reduce(r) = &mut self.slot_mut(i).state else {
                continue;
            };
            if !r.has_pending() {
                continue;
            }
            for event in r.settle(hand_on) {
                self.emit_event(i, &event, None, out);
            }
        }
    }

    /// Drop series `i`'s oldest `n` events (n > 0) and tell what follows.
    fn evict_series(&mut self, i: usize, n: usize, out: &mut Vec<Output>) {
        let keep = self.wants_evicted(i);
        let series = self.sub_series_mut(i);
        series.evicted += n as u64;
        let cutoff = series.buffer.begin_at(n - 1);
        let evicted = series.buffer.evict(n, keep);
        self.emit_evict(i, cutoff, &evicted, out);
    }

    /// Whether something needs the events `node` evicts: a watcher, or a
    /// reduce removing them (a view only needs where they end).
    fn wants_evicted(&self, node: usize) -> bool {
        self.slot(node).subs[OutputKind::Evict.slot()]
            .iter()
            .any(|sub| match sub {
                Sub::Watch => true,
                Sub::Child(c) => self.here(*c) && matches!(self.slot(*c).state, State::Reduce(_)),
            })
    }

    /// Hand `make`'s output to each watcher of `node`'s `kind` (children
    /// are not reached this way).
    fn emit(
        &self,
        node: usize,
        kind: OutputKind,
        out: &mut Vec<Output>,
        make: impl Fn(NodeId) -> Output,
    ) {
        let id = self.node_id(node);
        for sub in &self.slot(node).subs[kind.slot()] {
            if *sub == Sub::Watch {
                out.push(make(id));
            }
        }
    }

    /// `node` took `event` (at `place` among the events it holds, for a
    /// series or a view): hand it to watchers and to the nodes built on it.
    fn emit_event(
        &mut self,
        node: usize,
        event: &LiveEvent,
        place: Option<Place>,
        out: &mut Vec<Output>,
    ) {
        let kind = OutputKind::Event.slot();
        let mut k = 0;
        while k < self.slot(node).subs[kind].len() {
            match self.slot(node).subs[kind][k] {
                Sub::Watch => out.push(Output::Event {
                    node: self.node_id(node),
                    event: event.clone(),
                }),
                Sub::Child(c) if self.here(c) => self.deliver(c, node, event, place, out),
                Sub::Child(c) => self.far(c, node, event, place, false, out),
            }
            k += 1;
        }
    }

    /// `node` dropped events, the last starting at `cutoff`; `evicted`
    /// holds them when `node` watches its evictions (empty otherwise).
    fn emit_evict(
        &mut self,
        node: usize,
        cutoff: i64,
        evicted: &[LiveEvent],
        out: &mut Vec<Output>,
    ) {
        let kind = OutputKind::Evict.slot();
        let mut k = 0;
        while k < self.slot(node).subs[kind].len() {
            match self.slot(node).subs[kind][k] {
                Sub::Watch => out.push(Output::Evict {
                    node: self.node_id(node),
                    events: evicted.to_vec(),
                }),
                Sub::Child(c) => {
                    let keep = self.wants_evicted(c);
                    match &mut self.slot_mut(c).state {
                        State::View(view) => {
                            let (last, removed) = view.mirror_evict(cutoff, keep);
                            if let Some(last) = last {
                                self.emit_evict(c, last, &removed, out);
                            }
                        }
                        State::Reduce(reduce) => reduce.evict(evicted),
                        _ => unreachable!("only views and reduces follow evictions"),
                    }
                }
            }
            k += 1;
        }
    }

    /// One event from `from` reaching child `c` (at `place` in `from`).
    fn deliver(
        &mut self,
        c: usize,
        from: usize,
        event: &LiveEvent,
        place: Option<Place>,
        out: &mut Vec<Output>,
    ) {
        let subs = &self.slot(c).subs;
        let want_bucket = !subs[OutputKind::Bucket.slot()].is_empty();
        let want_update = !subs[OutputKind::Update.slot()].is_empty();
        let hand_on = !subs[OutputKind::Event.slot()].is_empty();
        match &mut self.slot_mut(c).state {
            State::View(view) => {
                if let Some((Some(kept), place)) = view.take(event, hand_on) {
                    self.emit_event(c, &kept, Some(place), out);
                }
            }
            State::Rolling(rolling) => {
                let after = if want_update {
                    After::Record
                } else {
                    After::Touch
                };
                let rolled = rolling.ingest(event, hand_on, after);
                if let Some(emitted) = rolled.event {
                    self.emit_event(c, &emitted, None, out);
                }
                if let Some(values) = rolled.update {
                    self.emit(c, OutputKind::Update, out, |node| Output::Update {
                        node,
                        values: Some(values.clone()),
                    });
                }
            }
            State::Reduce(reduce) => {
                reduce.ingest(event, place.expect("a reduce's source places its events"))
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
                    self.emit_event(c, closed, None, out);
                }
                self.emit(c, OutputKind::Update, out, |node| Output::Update {
                    node,
                    values: None,
                });
            }
            State::PartitionRolling(_) | State::Partitioned(_) | State::Series(_) => {
                self.far(c, from, event, place, hand_on, out)
            }
            State::PartitionedView(_) | State::Removed => unreachable!("never a child"),
        }
    }
}
