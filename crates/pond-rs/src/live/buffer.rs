//! The events a series or view holds, oldest first and in key order, and
//! the lookups pond-ts offers on them (`at`, `bisect`, `at_or_before`, …),
//! shared by [`LiveSeries`](super::LiveSeries) and
//! [`LiveView`](super::LiveView).
//!
//! Stored by column, not as one object per event: a start time per event
//! (plus an end and a label for range and interval keys), and one array per
//! value column. A number cell is 8 bytes (a gap is NaN, which a live
//! number column never holds otherwise), a true/false cell 1 byte. Reading
//! an event builds a [`LiveEvent`] from its cells.

use std::cmp::Ordering;
use std::collections::VecDeque;
use std::sync::Arc;

use crate::column::{
    ArrayColumn, BooleanColumn, ColumnData, Float64Column, Scalar, StringColumn, Value,
};
use crate::error::Result;
use crate::query::{EventKey, Label, compare_keys, keys_equal};
use crate::series::{Column, ColumnKind, IntervalKeys, Key, Labels, TimeRangeKeys, TimeSeries};

use super::event::{LiveEvent, LiveSchema};

/// One value column's cells, oldest first.
#[derive(Debug)]
pub(crate) enum Cells {
    /// NaN for a gap.
    Number(VecDeque<f64>),
    String(VecDeque<Option<String>>),
    Boolean(VecDeque<Option<bool>>),
    Array(VecDeque<Option<Vec<Scalar>>>),
}

impl Cells {
    pub(crate) fn new(kind: ColumnKind) -> Self {
        match kind {
            ColumnKind::Number => Cells::Number(VecDeque::new()),
            ColumnKind::String => Cells::String(VecDeque::new()),
            ColumnKind::Boolean => Cells::Boolean(VecDeque::new()),
            ColumnKind::Array => Cells::Array(VecDeque::new()),
            other => unreachable!("live value columns are never {}", other.as_str()),
        }
    }

    pub(crate) fn get(&self, i: usize) -> Option<Value> {
        match self {
            Cells::Number(c) => Some(c[i]).filter(|v| !v.is_nan()).map(Value::Number),
            Cells::String(c) => c[i].clone().map(Value::String),
            Cells::Boolean(c) => c[i].map(Value::Boolean),
            Cells::Array(c) => c[i].clone().map(Value::Array),
        }
    }

    /// Add a copy of `cell` at the end.
    pub(crate) fn push(&mut self, cell: Option<&Value>) {
        let at = self.len();
        self.insert_ref(at, cell);
    }

    pub(crate) fn len(&self) -> usize {
        match self {
            Cells::Number(c) => c.len(),
            Cells::String(c) => c.len(),
            Cells::Boolean(c) => c.len(),
            Cells::Array(c) => c.len(),
        }
    }

    /// Put a copy of `cell` at `at` (the end when `at` is the length).
    fn insert_ref(&mut self, at: usize, cell: Option<&Value>) {
        match (self, cell) {
            (Cells::Number(c), Some(Value::Number(v))) => put(c, at, *v),
            (Cells::Number(c), None) => put(c, at, f64::NAN),
            (Cells::String(c), Some(Value::String(v))) => put(c, at, Some(v.clone())),
            (Cells::String(c), None) => put(c, at, None),
            (Cells::Boolean(c), Some(Value::Boolean(v))) => put(c, at, Some(*v)),
            (Cells::Boolean(c), None) => put(c, at, None),
            (Cells::Array(c), Some(Value::Array(v))) => put(c, at, Some(v.clone())),
            (Cells::Array(c), None) => put(c, at, None),
            (_, Some(v)) => unreachable!("a cell of the wrong kind reached storage: {v:?}"),
        }
    }

    /// Put `cell` at `at` (the end when `at` is the length).
    fn insert(&mut self, at: usize, cell: Option<Value>) {
        match (self, cell) {
            (Cells::Number(c), Some(Value::Number(v))) => put(c, at, v),
            (Cells::Number(c), None) => put(c, at, f64::NAN),
            (Cells::String(c), Some(Value::String(v))) => put(c, at, Some(v)),
            (Cells::String(c), None) => put(c, at, None),
            (Cells::Boolean(c), Some(Value::Boolean(v))) => put(c, at, Some(v)),
            (Cells::Boolean(c), None) => put(c, at, None),
            (Cells::Array(c), Some(Value::Array(v))) => put(c, at, Some(v)),
            (Cells::Array(c), None) => put(c, at, None),
            (_, Some(v)) => unreachable!("a cell of the wrong kind reached storage: {v:?}"),
        }
    }

    pub(crate) fn drop_front(&mut self, n: usize) {
        match self {
            Cells::Number(c) => drop_front(c, n),
            Cells::String(c) => drop_front(c, n),
            Cells::Boolean(c) => drop_front(c, n),
            Cells::Array(c) => drop_front(c, n),
        }
    }

    fn column(&self, name: &str, required: bool) -> Column {
        let data: ColumnData = match self {
            Cells::Number(c) => {
                Float64Column::from_options(c.iter().map(|v| Some(*v).filter(|v| !v.is_nan())))
                    .into()
            }
            Cells::String(c) => StringColumn::from_options(c.iter().map(Option::as_deref)).into(),
            Cells::Boolean(c) => BooleanColumn::from_options(c.iter().copied()).into(),
            Cells::Array(c) => ArrayColumn::from_options(c.iter().cloned()).into(),
        };
        Column::from_data(name.to_string(), data, required)
    }
}

/// Put `v` at `at`: a push at the end, an insert before it.
fn put<T>(c: &mut VecDeque<T>, at: usize, v: T) {
    if at == c.len() {
        c.push_back(v);
    } else {
        c.insert(at, v);
    }
}

/// Drop the first `n` (one at a time is the common case, after each push).
fn drop_front<T>(c: &mut VecDeque<T>, n: usize) {
    if n == 1 {
        c.pop_front();
    } else {
        c.drain(..n);
    }
}

#[derive(Debug)]
pub(crate) struct EventBuffer {
    schema: Arc<LiveSchema>,
    begin: VecDeque<i64>,
    /// Range and interval keys only.
    end: Option<VecDeque<i64>>,
    /// Interval keys only.
    labels: Option<VecDeque<Label>>,
    cells: Vec<Cells>,
    /// The newest key (the key order's last), kept so the order check on
    /// each push does not rebuild it.
    tail: Option<EventKey>,
}

impl EventBuffer {
    pub(crate) fn new(schema: Arc<LiveSchema>) -> Self {
        let key = schema.columns[0].kind;
        let ranged = key != ColumnKind::Time;
        Self {
            begin: VecDeque::new(),
            end: ranged.then(VecDeque::new),
            labels: (key == ColumnKind::Interval).then(VecDeque::new),
            cells: schema.values().iter().map(|d| Cells::new(d.kind)).collect(),
            tail: None,
            schema,
        }
    }

    pub(crate) fn len(&self) -> usize {
        self.begin.len()
    }

    pub(crate) fn last_key(&self) -> Option<&EventKey> {
        self.tail.as_ref()
    }

    /// The label of the oldest event (interval keys).
    pub(crate) fn front_label(&self) -> Option<&Label> {
        self.labels.as_ref().and_then(VecDeque::front)
    }

    pub(crate) fn front_begin(&self) -> Option<i64> {
        self.begin.front().copied()
    }

    pub(crate) fn back_begin(&self) -> Option<i64> {
        self.begin.back().copied()
    }

    /// The start of the event at `i`.
    pub(crate) fn begin_at(&self, i: usize) -> i64 {
        self.begin[i]
    }

    /// The cell of value column `column` in the event at `i` (a copy; a
    /// number copies nothing else).
    pub(crate) fn cell(&self, column: usize, i: usize) -> Option<Value> {
        self.cells[column].get(i)
    }

    fn key_at(&self, i: usize) -> EventKey {
        let begin = self.begin[i];
        match (&self.end, &self.labels) {
            (None, _) => EventKey::time(begin),
            (Some(end), None) => {
                EventKey::time_range(begin, end[i]).expect("stored keys are valid")
            }
            (Some(end), Some(labels)) => {
                EventKey::interval(labels[i].clone(), begin, end[i]).expect("stored keys are valid")
            }
        }
    }

    fn event_at(&self, i: usize) -> LiveEvent {
        LiveEvent::new(
            Arc::clone(&self.schema),
            self.key_at(i),
            self.cells.iter().map(|c| c.get(i)).collect(),
        )
    }

    /// Append at the tail, or (a key before the tail's) at the last place
    /// that keeps the buffer in key order, after any equal keys. Copies the
    /// cells. Returns the position it went to.
    pub(crate) fn insert(&mut self, event: &LiveEvent) -> usize {
        let at = self.place(event.key());
        for (cells, cell) in self.cells.iter_mut().zip(event.values()) {
            cells.insert_ref(at, cell.as_ref());
        }
        at
    }

    /// [`EventBuffer::insert`], moving the cells out of `event` when
    /// nothing else holds it.
    pub(crate) fn insert_owned(&mut self, event: LiveEvent) -> usize {
        if event.is_shared() {
            return self.insert(&event);
        }
        let (key, values) = event.into_parts();
        self.insert_cells(key, values)
    }

    /// [`EventBuffer::insert`] of a key and its cells, moved in.
    pub(crate) fn insert_cells(&mut self, key: EventKey, values: Vec<Option<Value>>) -> usize {
        let at = self.place(&key);
        for (cells, cell) in self.cells.iter_mut().zip(values) {
            cells.insert(at, cell);
        }
        at
    }

    /// Where [`EventBuffer::insert`] would put `key`, without storing it.
    pub(crate) fn position(&self, key: &EventKey) -> usize {
        let in_order = self
            .tail
            .as_ref()
            .is_none_or(|last| compare_keys(last, key) != Ordering::Greater);
        if in_order {
            self.len()
        } else {
            self.partition_point(|k| compare_keys(k, key) != Ordering::Greater)
        }
    }

    /// Add an event at the end whatever its key, its cells as `values`
    /// yields them (one per value column, in schema order): for outputs
    /// kept in the order they were made (rolling and reduce), never
    /// searched by key.
    pub(crate) fn append_values(
        &mut self,
        key: EventKey,
        values: impl Iterator<Item = Option<Value>>,
    ) {
        let at = self.len();
        self.push_key(&key);
        for (cells, cell) in self.cells.iter_mut().zip(values) {
            cells.insert(at, cell);
        }
        debug_assert!(self.cells.iter().all(|c| c.len() == at + 1));
        self.tail = Some(key);
    }

    /// [`EventBuffer::append_values`], copying an event's cells.
    pub(crate) fn append_ref(&mut self, event: &LiveEvent) {
        self.push_key(event.key());
        for (cells, cell) in self.cells.iter_mut().zip(event.values()) {
            cells.push(cell.as_ref());
        }
        self.tail = Some(event.key().clone());
    }

    fn push_key(&mut self, key: &EventKey) {
        self.begin.push_back(key.begin());
        if let Some(end) = &mut self.end {
            end.push_back(key.end());
        }
        if let Some(labels) = &mut self.labels {
            labels.push_back(key.label().expect("interval keys have labels").clone());
        }
    }

    /// Store `key` where it goes in key order; its position, for the cells.
    fn place(&mut self, key: &EventKey) -> usize {
        let in_order = self
            .tail
            .as_ref()
            .is_none_or(|last| compare_keys(last, key) != Ordering::Greater);
        let at = if in_order {
            self.len()
        } else {
            self.partition_point(|k| compare_keys(k, key) != Ordering::Greater)
        };
        put(&mut self.begin, at, key.begin());
        if let Some(end) = &mut self.end {
            put(end, at, key.end());
        }
        if let Some(labels) = &mut self.labels {
            put(
                labels,
                at,
                key.label().expect("interval keys have labels").clone(),
            );
        }
        if in_order {
            self.tail = Some(key.clone());
        }
        at
    }

    /// Remove the oldest `n` events, returning them when `keep` is set.
    pub(crate) fn evict(&mut self, n: usize, keep: bool) -> Vec<LiveEvent> {
        let n = n.min(self.len());
        let out = if keep {
            (0..n).map(|i| self.event_at(i)).collect()
        } else {
            Vec::new()
        };
        drop_front(&mut self.begin, n);
        if let Some(end) = &mut self.end {
            drop_front(end, n);
        }
        if let Some(labels) = &mut self.labels {
            drop_front(labels, n);
        }
        for c in &mut self.cells {
            c.drop_front(n);
        }
        if self.begin.is_empty() {
            self.tail = None;
        }
        out
    }

    /// The number of oldest events starting before `cutoff`.
    pub(crate) fn count_before(&self, cutoff: i64) -> usize {
        self.begin.partition_point(|&b| b < cutoff)
    }

    /// The number of oldest events starting at or before `cutoff`.
    pub(crate) fn count_through(&self, cutoff: i64) -> usize {
        self.begin.partition_point(|&b| b <= cutoff)
    }

    pub(crate) fn at(&self, index: i64) -> Option<LiveEvent> {
        let i = if index < 0 {
            self.len() as i64 + index
        } else {
            index
        };
        usize::try_from(i)
            .ok()
            .filter(|&i| i < self.len())
            .map(|i| self.event_at(i))
    }

    /// Every event, oldest first, each built from its cells.
    pub(crate) fn iter(&self) -> impl ExactSizeIterator<Item = LiveEvent> + '_ {
        (0..self.len()).map(|i| self.event_at(i))
    }

    /// The first position whose key `pred` rejects (keys are in order).
    fn partition_point(&self, mut pred: impl FnMut(&EventKey) -> bool) -> usize {
        let (mut lo, mut hi) = (0, self.len());
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            if pred(&self.key_at(mid)) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        lo
    }

    pub(crate) fn bisect(&self, key: &EventKey) -> usize {
        self.partition_point(|k| compare_keys(k, key) == Ordering::Less)
    }

    pub(crate) fn includes_key(&self, key: &EventKey) -> bool {
        let i = self.bisect(key);
        i < self.len() && keys_equal(&self.key_at(i), key)
    }

    pub(crate) fn at_or_before(&self, key: &EventKey) -> Option<LiveEvent> {
        let i = self.bisect(key);
        if i < self.len() && keys_equal(&self.key_at(i), key) {
            return Some(self.event_at(i));
        }
        (i > 0).then(|| self.event_at(i - 1))
    }

    pub(crate) fn at_or_after(&self, key: &EventKey) -> Option<LiveEvent> {
        let i = self.bisect(key);
        (i < self.len()).then(|| self.event_at(i))
    }

    /// Last start minus first start, ms; 0 with fewer than two events.
    pub(crate) fn time_range(&self) -> i64 {
        match (self.begin.front(), self.begin.back()) {
            (Some(a), Some(b)) if self.len() >= 2 => b - a,
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
        self.len() as f64 / span as f64 * 1000.0
    }

    /// The events held as a batch series, built column by column.
    pub(crate) fn snapshot(&self, call: &'static str, name: &str) -> Result<TimeSeries> {
        let key_def = &self.schema.columns[0];
        let begin: Vec<i64> = self.begin.iter().copied().collect();
        let end = || -> Vec<i64> { self.end.iter().flatten().copied().collect() };
        let key = match &self.labels {
            None if self.end.is_none() => Key::Time(begin),
            None => Key::TimeRange(TimeRangeKeys { begin, end: end() }),
            Some(labels) => Key::Interval(IntervalKeys {
                label: labels_of(labels.iter()),
                begin,
                end: end(),
            }),
        };
        let columns = self
            .schema
            .values()
            .iter()
            .zip(&self.cells)
            .map(|(def, cells)| cells.column(&def.name, def.required))
            .collect();
        TimeSeries::with_key(call, name.to_string(), key_def.name.clone(), key, columns)
    }
}

/// Interval labels as a batch label column: numbers when every label is a
/// number, text otherwise (pushes refuse a mix).
fn labels_of<'a>(labels: impl Iterator<Item = &'a Label> + Clone) -> Labels {
    if labels.clone().all(|l| matches!(l, Label::Number(_))) {
        Labels::Number(
            labels
                .map(|l| match l {
                    Label::Number(v) => *v,
                    Label::String(_) => unreachable!("checked"),
                })
                .collect(),
        )
    } else {
        Labels::String(StringColumn::from_options(labels.map(|l| match l {
            Label::String(s) => Some(s.as_str()),
            Label::Number(_) => None,
        })))
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
        _ => Key::Interval(IntervalKeys {
            label: labels_of(
                events
                    .clone()
                    .map(|e| e.key().label().expect("interval keys have labels")),
            ),
            begin,
            end: end(),
        }),
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
