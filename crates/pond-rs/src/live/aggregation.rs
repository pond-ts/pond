//! Buckets over a live source (pond-ts `LiveAggregation`): fixed-length
//! ones, or calendar ones (days, weeks, … in a time zone, so of varying
//! length).
//!
//! Each source event goes to the bucket its start falls in. A bucket closes
//! once the latest start seen (the watermark), less the source's grace
//! window, reaches its end; an event for a bucket that has already closed is
//! skipped. Each event gives, in order: the bucket it joined, as it now
//! stands (`Bucket`), then each bucket it closed, oldest first (`Event`),
//! then `Update`.
//!
//! The bucket states are ports of pond-ts's `bucketState` reducers, step
//! for step: they add values one at a time in arrival order (a plain
//! running sum, not the eight-lane sum batch `aggregate` uses), so the bits
//! are pond-ts's live ones.

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use crate::column::{Scalar, Value};
use crate::elements::compare_scalars;
use crate::error::{PondError, Result};
use crate::query::EventKey;
use crate::reducer::{Agg, Reducer, clamp_at_zero, percentile_of_sorted};
use crate::sequence::{CALENDAR_RANGE_MS, Sequence};
use crate::series::{ColumnDef, ColumnKind, MAX_TIME_MS, TimeSeries};

use super::buffer::series_of;
use super::event::{LiveEvent, LiveSchema};
use super::states::{ScalarKey, as_key, number, scalar_key, scalars};

const CALL: &str = "LiveSeries::aggregate";

struct Mapped {
    source: usize,
    reducer: Reducer,
}

struct Pending {
    end: i64,
    states: Vec<BucketState>,
}

/// Buckets over a live source: the closed ones, and the ones still open. Built with [`LiveSeries::aggregate`](super::LiveSeries::aggregate);
/// read through the owner.
pub struct LiveAggregation {
    name: String,
    schema: Arc<LiveSchema>,
    columns: Vec<Mapped>,
    grid: Grid,
    grace: i64,
    pending: BTreeMap<i64, Pending>,
    watermark: Option<i64>,
    closed: Vec<LiveEvent>,
    events_observed: u64,
}

impl std::fmt::Debug for LiveAggregation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveAggregation")
            .field("name", &self.name)
            .field("closed", &self.closed.len())
            .field("open", &self.pending.len())
            .finish_non_exhaustive()
    }
}

/// Counters for a [`LiveAggregation`] (pond-ts `stats()`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AggregationStats {
    /// Events added to a bucket (late ones skipped are not counted).
    pub events_observed: u64,
    pub buckets_closed: u64,
    pub open_buckets: usize,
    /// Start of the oldest open bucket.
    pub open_bucket_start: Option<i64>,
}

/// How events map to buckets.
enum Grid {
    Fixed {
        step: i64,
        anchor: i64,
    },
    /// The last bucket looked up is kept: events in the same bucket skip
    /// the time-zone arithmetic.
    Calendar {
        sequence: Sequence,
        last: Option<(i64, i64)>,
    },
}

impl Grid {
    fn bucket(&mut self, ts: i64) -> (i64, i64) {
        match self {
            &mut Grid::Fixed { step, anchor } => {
                bucket_of(ts, step, anchor).expect("edges checked in LiveAggregation::new")
            }
            Grid::Calendar { sequence, last } => {
                if let Some((start, end)) = *last
                    && (start..end).contains(&ts)
                {
                    return (start, end);
                }
                let bucket = sequence
                    .calendar_bucket(ts)
                    .expect("a calendar sequence")
                    .expect("LiveSeries::push keeps times inside CALENDAR_RANGE_MS");
                *last = Some(bucket);
                bucket
            }
        }
    }

    fn is_calendar(&self) -> bool {
        matches!(self, Grid::Calendar { .. })
    }
}

/// What one source event did: the bucket it joined (when wanted) and the
/// buckets it closed.
pub(crate) struct Ingested {
    pub(crate) bucket: Option<LiveEvent>,
    pub(crate) closed: Vec<LiveEvent>,
}

impl LiveAggregation {
    /// Check the mapping against the source schema and replay `history`.
    pub(crate) fn new(
        name: String,
        source: &[ColumnDef],
        sequence: &Sequence,
        grace: i64,
        mapping: &[Agg],
        history: impl Iterator<Item = LiveEvent>,
    ) -> Result<Self> {
        let (out_defs, plan) = plan_mapping(
            CALL,
            ColumnDef::required("time", ColumnKind::Interval),
            source,
            mapping,
        )?;
        let columns = plan
            .into_iter()
            .map(|(source, reducer)| Mapped { source, reducer })
            .collect();
        let grid = match sequence.fixed_step() {
            Some((step, anchor)) => {
                // Every bucket a supported time can fall in must have i64
                // edges; checked here at the extremes so `ingest` cannot
                // overflow.
                for t in [-MAX_TIME_MS, MAX_TIME_MS] {
                    if bucket_of(t, step, anchor).is_none() {
                        return Err(PondError::InvalidData {
                            call: CALL,
                            message: format!(
                                "step {step} ms with anchor {anchor} ms puts bucket edges outside the i64 range"
                            ),
                        });
                    }
                }
                Grid::Fixed { step, anchor }
            }
            None => Grid::Calendar {
                sequence: sequence.clone(),
                last: None,
            },
        };
        let mut agg = Self {
            name,
            schema: LiveSchema::new(out_defs),
            columns,
            grid,
            grace,
            pending: BTreeMap::new(),
            watermark: None,
            closed: Vec::new(),
            events_observed: 0,
        };
        let (lo, hi) = CALENDAR_RANGE_MS;
        for event in history {
            if agg.grid.is_calendar() && !(lo..hi).contains(&event.begin()) {
                return Err(PondError::InvalidData {
                    call: CALL,
                    message: format!(
                        "an event at {} ms is outside years -9997 to 9998 (UTC), the range a calendar aggregation takes",
                        event.begin()
                    ),
                });
            }
            agg.ingest(&event, false);
        }
        Ok(agg)
    }

    /// Add one source event. `want_bucket`: build the joined bucket's
    /// snapshot (only when something listens for it).
    pub(crate) fn ingest(&mut self, event: &LiveEvent, want_bucket: bool) -> Ingested {
        let ts = event.begin();
        let (start, end) = self.grid.bucket(ts);
        let watermark = self.watermark.map_or(ts, |w| w.max(ts));
        self.watermark = Some(watermark);
        let cutoff = watermark.saturating_sub(self.grace);
        let mut done = Ingested {
            bucket: None,
            closed: Vec::new(),
        };
        if end <= cutoff {
            return done;
        }
        self.events_observed += 1;
        let columns = &self.columns;
        let pending = self.pending.entry(start).or_insert_with(|| Pending {
            end,
            states: columns
                .iter()
                .map(|c| BucketState::new(c.reducer))
                .collect(),
        });
        for (state, c) in pending.states.iter_mut().zip(columns) {
            if let Some(v) = &event.values()[c.source] {
                state.add(v);
            }
        }
        if want_bucket {
            done.bucket = Some(self.bucket_event(start, end, &self.pending[&start].states));
        }
        // Close every bucket the cutoff has passed, oldest first.
        while let Some((&start, b)) = self.pending.first_key_value() {
            if b.end > cutoff {
                break;
            }
            let b = self.pending.remove(&start).expect("present");
            let closed = self.bucket_event(start, b.end, &b.states);
            self.closed.push(closed.clone());
            done.closed.push(closed);
        }
        done
    }

    fn bucket_event(&self, start: i64, end: i64, states: &[BucketState]) -> LiveEvent {
        let key = EventKey::interval(start, start, end).expect("start < end, finite label");
        LiveEvent::new(
            Arc::clone(&self.schema),
            key,
            states.iter().map(BucketState::snapshot).collect(),
        )
    }

    pub(crate) fn is_calendar(&self) -> bool {
        self.grid.is_calendar()
    }

    pub(crate) fn schema_arc(&self) -> Arc<LiveSchema> {
        Arc::clone(&self.schema)
    }

    /// The source's name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The output schema: `time` (interval keys labelled by their start),
    /// then one column per mapping entry, each allowing gaps.
    pub fn schema(&self) -> &[ColumnDef] {
        &self.schema.columns
    }

    /// Number of closed buckets.
    pub fn len(&self) -> usize {
        self.closed.len()
    }

    pub fn is_empty(&self) -> bool {
        self.closed.is_empty()
    }

    /// The closed bucket at `index`; negative positions count from the end.
    pub fn at(&self, index: i64) -> Option<&LiveEvent> {
        let i = if index < 0 {
            self.closed.len() as i64 + index
        } else {
            index
        };
        usize::try_from(i).ok().and_then(|i| self.closed.get(i))
    }

    /// The closed buckets, oldest first.
    pub fn events(&self) -> impl ExactSizeIterator<Item = &LiveEvent> {
        self.closed.iter()
    }

    /// Whether a bucket is still open.
    pub fn has_open_bucket(&self) -> bool {
        !self.pending.is_empty()
    }

    /// The closed buckets as a batch series.
    pub fn closed(&self) -> Result<TimeSeries> {
        series_of(
            "LiveAggregation::closed",
            &self.name,
            &self.schema,
            self.closed.iter(),
        )
    }

    /// The closed buckets, then the open ones as they stand.
    pub fn snapshot(&self) -> Result<TimeSeries> {
        let open: Vec<LiveEvent> = self
            .pending
            .iter()
            .map(|(&start, b)| self.bucket_event(start, b.end, &b.states))
            .collect();
        series_of(
            "LiveAggregation::snapshot",
            &self.name,
            &self.schema,
            self.closed.iter().chain(&open),
        )
    }

    pub fn stats(&self) -> AggregationStats {
        AggregationStats {
            events_observed: self.events_observed,
            buckets_closed: self.closed.len() as u64,
            open_buckets: self.pending.len(),
            open_bucket_start: self.pending.keys().next().copied(),
        }
    }
}

/// What [`plan_mapping`] gives: the output schema, and per output column
/// its source value column and reducer.
pub(super) type MappingPlan = (Vec<ColumnDef>, Vec<(usize, Reducer)>);

/// Check a mapping against a source schema (key column first): the
/// output schema (`key`, then one optional column per entry) and, per
/// entry, its source value column and reducer. Shared by `aggregate`,
/// `rolling` and `reduce`.
pub(super) fn plan_mapping(
    call: &'static str,
    key: ColumnDef,
    source: &[ColumnDef],
    mapping: &[Agg],
) -> Result<MappingPlan> {
    let values = &source[1..];
    let mut out_defs = vec![key];
    let mut columns = Vec::with_capacity(mapping.len());
    for agg in mapping {
        let reducer = agg.reducer();
        reducer.check(call)?;
        let i = values
            .iter()
            .position(|c| c.name == agg.source())
            .ok_or_else(|| PondError::UnknownColumn {
                call,
                column: agg.source().to_string(),
                available: values.iter().map(|c| c.name.clone()).collect(),
            })?;
        let kind = values[i].kind;
        if out_defs.iter().any(|d| d.name == agg.output()) {
            return Err(PondError::DuplicateOutput {
                call,
                column: agg.output().to_string(),
            });
        }
        let numeric = !matches!(
            reducer,
            Reducer::Count
                | Reducer::First
                | Reducer::Last
                | Reducer::Keep
                | Reducer::Unique
                | Reducer::Top(_)
                | Reducer::Samples
        );
        if numeric && kind != ColumnKind::Number {
            return Err(PondError::WrongKind {
                call,
                column: agg.source().to_string(),
                kind: kind.as_str(),
                reason: "this reducer needs a number column; string, boolean and array columns take count, first, last, keep, unique, top<N> or samples".into(),
            });
        }
        let out_kind = match reducer {
            Reducer::First | Reducer::Last | Reducer::Keep => kind,
            r if r.gives_list() => ColumnKind::Array,
            _ => ColumnKind::Number,
        };
        out_defs.push(ColumnDef::optional(agg.output(), out_kind));
        columns.push((i, reducer));
    }
    Ok((out_defs, columns))
}

/// The bucket `[start, end)` holding `ts`, worked out in i128 (as batch
/// `Sequence` does); `None` when an edge does not fit in an i64.
fn bucket_of(ts: i64, step: i64, anchor: i64) -> Option<(i64, i64)> {
    let (step, anchor) = (i128::from(step), i128::from(anchor));
    let start = (i128::from(ts) - anchor).div_euclid(step) * step + anchor;
    Some((
        i64::try_from(start).ok()?,
        i64::try_from(start + step).ok()?,
    ))
}

/// pond-ts `===` on two cells; array cells by their elements bit for bit
/// (pond-ts compares the array objects, so two equal arrays differ there).
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x == y,
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len()
                && x.iter().zip(y).all(|(p, q)| match (p, q) {
                    (Scalar::Number(p), Scalar::Number(q)) => p.to_bits() == q.to_bits(),
                    _ => p == q,
                })
        }
        _ => a == b,
    }
}

/// One output column's state for one bucket (pond-ts `bucketState`).
enum BucketState {
    Count(u64),
    Sum(f64),
    Avg {
        s: f64,
        n: u64,
    },
    Min(Option<f64>),
    Max(Option<f64>),
    First(Option<Value>),
    Last(Option<Value>),
    /// `median` and percentiles: every number, sorted at snapshot.
    Sorted {
        q: f64,
        values: Vec<f64>,
    },
    Stdev {
        n: f64,
        mean: f64,
        m2: f64,
    },
    Difference {
        lo: Option<f64>,
        hi: Option<f64>,
    },
    Keep {
        first: Option<Value>,
        same: bool,
    },
    Unique(HashMap<ScalarKey, Scalar>),
    Top {
        n: usize,
        counts: HashMap<ScalarKey, (Scalar, u64)>,
    },
    Samples(Vec<Scalar>),
}

impl BucketState {
    fn new(reducer: Reducer) -> Self {
        match reducer {
            Reducer::Count => Self::Count(0),
            Reducer::Sum => Self::Sum(0.0),
            Reducer::Avg => Self::Avg { s: 0.0, n: 0 },
            Reducer::Min => Self::Min(None),
            Reducer::Max => Self::Max(None),
            Reducer::First => Self::First(None),
            Reducer::Last => Self::Last(None),
            Reducer::Median => Self::Sorted {
                q: 50.0,
                values: Vec::new(),
            },
            Reducer::Percentile(q) => Self::Sorted {
                q,
                values: Vec::new(),
            },
            Reducer::Stdev => Self::Stdev {
                n: 0.0,
                mean: 0.0,
                m2: 0.0,
            },
            Reducer::Difference => Self::Difference { lo: None, hi: None },
            Reducer::Keep => Self::Keep {
                first: None,
                same: true,
            },
            Reducer::Unique => Self::Unique(HashMap::new()),
            Reducer::Top(n) => Self::Top {
                n,
                counts: HashMap::new(),
            },
            Reducer::Samples => Self::Samples(Vec::new()),
        }
    }

    /// Add one present cell.
    fn add(&mut self, v: &Value) {
        let x = v.as_f64();
        match self {
            Self::Count(n) => *n += 1,
            Self::Sum(s) => *s += x.expect("number column"),
            Self::Avg { s, n } => {
                *s += x.expect("number column");
                *n += 1;
            }
            Self::Min(lo) => {
                let x = x.expect("number column");
                if lo.is_none_or(|lo| x < lo) {
                    *lo = Some(x);
                }
            }
            Self::Max(hi) => {
                let x = x.expect("number column");
                if hi.is_none_or(|hi| x > hi) {
                    *hi = Some(x);
                }
            }
            Self::First(first) => {
                if first.is_none() {
                    *first = Some(v.clone());
                }
            }
            Self::Last(last) => *last = Some(v.clone()),
            Self::Sorted { values, .. } => values.push(x.expect("number column")),
            Self::Stdev { n, mean, m2 } => {
                let x = x.expect("number column");
                *n += 1.0;
                let delta = x - *mean;
                *mean += delta / *n;
                *m2 += delta * (x - *mean);
            }
            Self::Difference { lo, hi } => {
                let x = x.expect("number column");
                if lo.is_none_or(|lo| x < lo) {
                    *lo = Some(x);
                }
                if hi.is_none_or(|hi| x > hi) {
                    *hi = Some(x);
                }
            }
            Self::Keep { first, same: all } => match first {
                None => *first = Some(v.clone()),
                Some(f) => {
                    if !same(f, v) {
                        *all = false;
                    }
                }
            },
            Self::Unique(set) => scalars(v, |s| {
                set.entry(scalar_key(s)).or_insert_with(|| as_key(s));
            }),
            Self::Top { counts, .. } => scalars(v, |s| {
                counts
                    .entry(scalar_key(s))
                    .or_insert_with(|| (as_key(s), 0))
                    .1 += 1;
            }),
            Self::Samples(items) => scalars(v, |s| items.push(s.clone())),
        }
    }

    fn snapshot(&self) -> Option<Value> {
        match self {
            Self::Count(n) => number(*n as f64),
            Self::Sum(s) => number(*s),
            Self::Avg { s, n } => (*n != 0).then(|| s / *n as f64).and_then(number),
            Self::Min(v) | Self::Max(v) => v.and_then(number),
            Self::First(v) | Self::Last(v) => v.clone(),
            Self::Sorted { q, values } => {
                if values.is_empty() {
                    return None;
                }
                // JavaScript's `sort((a, b) => a - b)`: stable, `0` and `-0`
                // equal.
                let mut sorted = values.clone();
                sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
                number(percentile_of_sorted(&sorted, *q))
            }
            Self::Stdev { n, m2, .. } => (*n != 0.0)
                .then(|| clamp_at_zero(m2 / n).sqrt())
                .and_then(number),
            Self::Difference { lo, hi } => match (lo, hi) {
                (Some(lo), Some(hi)) => number(hi - lo),
                _ => None,
            },
            Self::Keep { first, same } => first.clone().filter(|_| *same),
            Self::Unique(set) => {
                let mut out: Vec<Scalar> = set.values().cloned().collect();
                out.sort_by(compare_scalars);
                Some(Value::Array(out))
            }
            Self::Top { n, counts } => {
                let mut entries: Vec<&(Scalar, u64)> = counts.values().collect();
                entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| compare_scalars(&a.0, &b.0)));
                Some(Value::Array(
                    entries.iter().take(*n).map(|e| e.0.clone()).collect(),
                ))
            }
            Self::Samples(items) => Some(Value::Array(items.clone())),
        }
    }
}
