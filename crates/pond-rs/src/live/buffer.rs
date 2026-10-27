//! The events a series or view holds, oldest first and in key order, and
//! the lookups pond-ts offers on them (`at`, `bisect`, `at_or_before`, …),
//! shared by [`LiveSeries`](super::LiveSeries) and
//! [`LiveView`](super::LiveView).

use std::cmp::Ordering;
use std::collections::VecDeque;
use std::sync::Arc;

use crate::column::{ArrayColumn, BooleanColumn, ColumnData, Float64Column, StringColumn, Value};
use crate::error::Result;
use crate::query::{EventKey, Label, compare_keys, keys_equal};
use crate::series::{Column, ColumnKind, IntervalKeys, Key, Labels, TimeRangeKeys, TimeSeries};

use super::event::{LiveEvent, LiveSchema};

#[derive(Debug, Default)]
pub(crate) struct EventBuffer {
    pub(crate) events: VecDeque<LiveEvent>,
}

impl EventBuffer {
    pub(crate) fn len(&self) -> usize {
        self.events.len()
    }

    pub(crate) fn last_key(&self) -> Option<&EventKey> {
        self.events.back().map(LiveEvent::key)
    }

    /// Append at the tail, or (a key before the tail's) at the last place
    /// that keeps the buffer in key order, after any equal keys.
    pub(crate) fn insert(&mut self, event: LiveEvent) {
        let in_order = self
            .last_key()
            .is_none_or(|last| compare_keys(last, event.key()) != Ordering::Greater);
        if in_order {
            self.events.push_back(event);
            return;
        }
        let at = self
            .events
            .partition_point(|e| compare_keys(e.key(), event.key()) != Ordering::Greater);
        self.events.insert(at, event);
    }

    /// Remove the oldest `n` events, returning them when `keep` is set.
    pub(crate) fn evict(&mut self, n: usize, keep: bool) -> Vec<LiveEvent> {
        if keep {
            self.events.drain(..n).collect()
        } else {
            self.events.drain(..n);
            Vec::new()
        }
    }

    pub(crate) fn at(&self, index: i64) -> Option<&LiveEvent> {
        let i = if index < 0 {
            self.events.len() as i64 + index
        } else {
            index
        };
        usize::try_from(i).ok().and_then(|i| self.events.get(i))
    }

    pub(crate) fn bisect(&self, key: &EventKey) -> usize {
        self.events
            .partition_point(|e| compare_keys(e.key(), key) == Ordering::Less)
    }

    pub(crate) fn includes_key(&self, key: &EventKey) -> bool {
        self.events
            .get(self.bisect(key))
            .is_some_and(|e| keys_equal(e.key(), key))
    }

    pub(crate) fn at_or_before(&self, key: &EventKey) -> Option<&LiveEvent> {
        let i = self.bisect(key);
        match self.events.get(i) {
            Some(e) if keys_equal(e.key(), key) => Some(e),
            _ if i == 0 => None,
            _ => self.events.get(i - 1),
        }
    }

    pub(crate) fn at_or_after(&self, key: &EventKey) -> Option<&LiveEvent> {
        self.events.get(self.bisect(key))
    }

    /// Last start minus first start, ms; 0 with fewer than two events.
    pub(crate) fn time_range(&self) -> i64 {
        match (self.events.front(), self.events.back()) {
            (Some(a), Some(b)) if self.events.len() >= 2 => b.begin() - a.begin(),
            _ => 0,
        }
    }

    /// Events per second over [`EventBuffer::time_range`]; 0 when that
    /// is 0.
    pub(crate) fn event_rate(&self) -> f64 {
        let span = self.time_range();
        if span == 0 {
            return 0.0;
        }
        self.events.len() as f64 / span as f64 * 1000.0
    }

    pub(crate) fn snapshot(
        &self,
        call: &'static str,
        name: &str,
        schema: &Arc<LiveSchema>,
    ) -> Result<TimeSeries> {
        series_of(call, name, schema, self.events.iter())
    }
}

/// A batch series holding `events`, which are in key order.
pub(crate) fn series_of<'a>(
    call: &'static str,
    name: &str,
    schema: &LiveSchema,
    events: impl Iterator<Item = &'a LiveEvent> + Clone,
) -> Result<TimeSeries> {
    let key_def = &schema.columns[0];
    let begin: Vec<i64> = events.clone().map(LiveEvent::begin).collect();
    let end = || events.clone().map(LiveEvent::end).collect::<Vec<i64>>();
    let key = match key_def.kind {
        ColumnKind::Time => Key::Time(begin),
        ColumnKind::TimeRange => Key::TimeRange(TimeRangeKeys { begin, end: end() }),
        _ => {
            let labels: Vec<&Label> = events
                .clone()
                .map(|e| e.key().label().expect("interval keys have labels"))
                .collect();
            let label = if labels.iter().all(|l| matches!(l, Label::Number(_))) {
                Labels::Number(
                    labels
                        .iter()
                        .map(|l| match l {
                            Label::Number(v) => *v,
                            Label::String(_) => unreachable!("checked"),
                        })
                        .collect(),
                )
            } else {
                // Pushes refuse a label of the other kind, so these are all
                // text.
                Labels::String(StringColumn::from_options(labels.iter().map(|l| match l {
                    Label::String(s) => Some(s.as_str()),
                    Label::Number(_) => None,
                })))
            };
            Key::Interval(IntervalKeys {
                label,
                begin,
                end: end(),
            })
        }
    };
    let columns = schema
        .values()
        .iter()
        .enumerate()
        .map(|(c, def)| {
            let cells = events.clone().map(move |e| e.values()[c].as_ref());
            let data: ColumnData = match def.kind {
                ColumnKind::Number => Float64Column::from_options(cells.map(|v| match v {
                    Some(Value::Number(x)) => Some(*x),
                    _ => None,
                }))
                .into(),
                ColumnKind::String => StringColumn::from_options(cells.map(|v| match v {
                    Some(Value::String(x)) => Some(x.as_str()),
                    _ => None,
                }))
                .into(),
                ColumnKind::Boolean => BooleanColumn::from_options(cells.map(|v| match v {
                    Some(Value::Boolean(x)) => Some(*x),
                    _ => None,
                }))
                .into(),
                _ => ArrayColumn::from_options(cells.map(|v| match v {
                    Some(Value::Array(x)) => Some(x.clone()),
                    _ => None,
                }))
                .into(),
            };
            Column::from_data(def.name.clone(), data, def.required)
        })
        .collect();
    TimeSeries::with_key(call, name.to_string(), key_def.name.clone(), key, columns)
}
