//! Running a partitioned node's shards at once
//! ([`PartitionOptions::threads`](super::PartitionOptions::threads)).
//!
//! A push routed a push at a time (see `partition.rs`) does three things
//! to the partitions: every row's `Event` in the push's order, then each
//! partition finishes (retention, `Batch`, `Evict`, settle) in the order
//! of its last row. All of a row's work happens in its partition's shard,
//! and so does a partition's finish, so each shard can do its own rows
//! and finishes beside the others. What a shard would hand outside itself
//! (an output, an event for a gathered series or partition rolling) it
//! writes down, marked by the row or finish it came from; the
//! owner then replays every mark in the push's order, which is the order
//! one thread makes them in.

use super::event::LiveEvent;
use super::net::Net;
use super::partition::Share;
use super::reduce::Place;
use super::{LiveSeries, NodeId, Output, OutputKind, Slot};

/// One partitioned node's partitions in one shard, during one push.
struct Shard<'a> {
    owner: u64,
    /// Indexed like the owner's slots; only this shard's are here.
    slots: Vec<Option<&'a mut Slot>>,
    reduces: &'a [usize],
    out: Vec<Output>,
    hands: Vec<Hand>,
    /// Where each row's or finish's work starts in `out` and `hands`, in
    /// the order done.
    marks: Vec<(usize, usize)>,
    /// The rows this shard takes, in order: the row's index in the push
    /// and its partition's slot.
    rows: Vec<(usize, usize)>,
    /// The partitions this shard finishes, in the push's finishing order:
    /// each partition's slot and its rows.
    closes: Vec<(usize, &'a [usize])>,
}

/// An event a shard hands to node `to` outside itself (from `from`), after
/// `at` of its outputs.
struct Hand {
    at: usize,
    to: usize,
    from: usize,
    event: LiveEvent,
    place: Option<Place>,
}

impl Net for Shard<'_> {
    #[inline]
    fn slot(&self, i: usize) -> &Slot {
        self.slots[i].as_deref().expect("a node of this shard")
    }

    #[inline]
    fn slot_mut(&mut self, i: usize) -> &mut Slot {
        self.slots[i].as_deref_mut().expect("a node of this shard")
    }

    #[inline]
    fn here(&self, i: usize) -> bool {
        self.slots.get(i).is_some_and(Option::is_some)
    }

    fn reduces(&self) -> &[usize] {
        self.reduces
    }

    fn node_id(&self, i: usize) -> NodeId {
        NodeId {
            owner: self.owner,
            index: i as u32,
        }
    }

    fn far(
        &mut self,
        c: usize,
        from: usize,
        event: &LiveEvent,
        place: Option<Place>,
        _hand_on: bool,
        out: &mut Vec<Output>,
    ) {
        self.hands.push(Hand {
            at: out.len(),
            to: c,
            from,
            event: event.clone(),
            place,
        });
    }
}

impl Shard<'_> {
    /// This shard's rows, then its finishes (`partition.rs` steps 2 and 3).
    fn run(&mut self, events: &[LiveEvent]) {
        let mut out = Vec::new();
        for k in 0..self.rows.len() {
            let (r, part) = self.rows[k];
            let event = &events[r];
            self.marks.push((out.len(), self.hands.len()));
            let place = Place {
                at: self.sub_series(part).buffer.position(event.key()),
                trimmed: 0,
            };
            self.emit_event(part, event, Some(place), &mut out);
            self.sub_series_mut(part).buffer.insert(event);
        }
        for k in 0..self.closes.len() {
            let (part, rows) = self.closes[k];
            self.marks.push((out.len(), self.hands.len()));
            let n = self.sub_series(part).retention_count();
            if !self.slot(part).subs[OutputKind::Batch.slot()].is_empty() {
                let added: Vec<LiveEvent> = rows.iter().map(|&r| events[r].clone()).collect();
                self.emit(part, OutputKind::Batch, &mut out, |node| Output::Batch {
                    node,
                    events: added.clone(),
                });
            }
            if n > 0 {
                self.evict_series(part, n, &mut out);
            }
            self.settle(part, &mut out);
        }
        self.out = out;
    }
}

impl LiveSeries {
    /// Steps 2 and 3 of routing a push (`partition.rs`) in partitioned
    /// node `p`'s shards, when it has them and the push is big enough;
    /// `false` when the push goes the one-thread way.
    pub(super) fn route_in_shards(
        &mut self,
        p: usize,
        events: &[LiveEvent],
        shares: &[Share],
        share_of: &[Option<usize>],
        close: &[usize],
        out: &mut Vec<Output>,
    ) -> bool {
        let pt = self.partitioned(p);
        let (Some(&(first, _)), count) = (pt.shards.first(), pt.shards.len()) else {
            return false;
        };
        let min = pt.parallel_min;
        if events.len() < min {
            return false;
        }
        let first = first as usize;
        let shard_of: Vec<usize> = shares
            .iter()
            .map(|s| self.slots[s.slot].shard as usize - first)
            .collect();
        if min > 0 {
            let mut busy = vec![false; count];
            for &s in &shard_of {
                busy[s] = true;
            }
            if busy.iter().filter(|&&b| b).count() < 2 {
                return false;
            }
        }

        let owner = self.owner;
        let n = self.slots.len();
        let reduces = &self.reduces;
        let mut shards: Vec<Shard> = (0..count)
            .map(|_| Shard {
                owner,
                slots: (0..n).map(|_| None).collect(),
                reduces,
                out: Vec::new(),
                hands: Vec::new(),
                marks: Vec::new(),
                rows: Vec::new(),
                closes: Vec::new(),
            })
            .collect();
        for (i, slot) in self.slots.iter_mut().enumerate() {
            let s = slot.shard as usize;
            if (first..first + count).contains(&s) {
                shards[s - first].slots[i] = Some(slot);
            }
        }
        for (r, share) in share_of.iter().enumerate() {
            if let &Some(s) = share {
                shards[shard_of[s]].rows.push((r, shares[s].slot));
            }
        }
        for &s in close {
            shards[shard_of[s]]
                .closes
                .push((shares[s].slot, &shares[s].rows));
        }
        #[cfg(feature = "parallel")]
        {
            use rayon::prelude::*;
            shards.par_iter_mut().for_each(|shard| shard.run(events));
        }
        #[cfg(not(feature = "parallel"))]
        for shard in &mut shards {
            shard.run(events);
        }
        let mut done: Vec<Done> = shards
            .into_iter()
            .map(|s| Done {
                out: s.out.into_iter(),
                hands: s.hands.into_iter(),
                marks: s.marks,
                next: 0,
                at: 0,
            })
            .collect();

        // Every row's work, then every finish, in the push's order.
        for share in share_of.iter().flatten() {
            self.replay(&mut done[shard_of[*share]], out);
        }
        for &s in close {
            self.replay(&mut done[shard_of[s]], out);
        }
        true
    }

    /// Replay a shard's next mark: its outputs, with what it handed out at
    /// the point it did.
    fn replay(&mut self, done: &mut Done, out: &mut Vec<Output>) {
        let (_, hands_from) = done.marks[done.next];
        done.next += 1;
        let (out_to, hands_to) = done
            .marks
            .get(done.next)
            .copied()
            .unwrap_or((usize::MAX, usize::MAX));
        let mut hand = hands_from;
        while hand < hands_to {
            let Some(next) = done.hands.next() else {
                break;
            };
            hand += 1;
            let at = next.at.min(out_to);
            while done.at < at {
                let Some(o) = done.out.next() else {
                    break;
                };
                out.push(o);
                done.at += 1;
            }
            self.deliver(next.to, next.from, &next.event, next.place, out);
        }
        while done.at < out_to {
            let Some(o) = done.out.next() else {
                break;
            };
            out.push(o);
            done.at += 1;
        }
    }
}

/// A shard's results, replayed mark by mark.
struct Done {
    out: std::vec::IntoIter<Output>,
    hands: std::vec::IntoIter<Hand>,
    marks: Vec<(usize, usize)>,
    /// The next mark to replay.
    next: usize,
    /// Outputs replayed so far.
    at: usize,
}
