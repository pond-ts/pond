//! One output column's sliding state for live `rolling` and `reduce`
//! (pond-ts `rollingStateFor`): a value enters with `add`, leaves with
//! `remove` (both with the event's index), and `snapshot` is the reducer
//! over what is inside.
//!
//! The number states are the batch `rolling` ones (`crate::rolling`), which
//! are pond-ts's step for step. On top, as pond-ts:
//!
//! - `sum`, `avg` and `stdev` move values of `2^960` and up (`2^480` for
//!   stdev) into an exact big-integer lane (pond-ts `overflow-lanes.ts`),
//!   so a huge value cannot leave the running total stuck at infinity
//!   after it leaves the window.
//! - Over a source whose evictions do not follow arrival order (a
//!   [`Reorder`](super::OrderingMode::Reorder) series), `min`, `max`,
//!   `first`, `last` and `difference` use states that remove any index
//!   (pond-ts [PND-LIVFIX]).
//! - Any column kind for `count`, `first`, `last`, `keep`, `unique`,
//!   `top<N>` and `samples`.

use std::collections::{BTreeMap, HashMap, VecDeque};

use num_bigint::BigInt;
use num_traits::{FromPrimitive, ToPrimitive};

use crate::column::{Scalar, Value};
use crate::elements::compare_scalars;
use crate::reducer::{Reducer, clamp_at_zero, percentile_of_sorted};
use crate::rolling::{
    DiffState, ExtremeState, STDEV_SPLIT, SUM_SPLIT, SortedState, StdevState, WindowState,
    WindowSum, lower_bound,
};

/// A number as a cell: non-finite becomes a gap (pond-ts `finiteOrMissing`).
pub(crate) fn number(v: f64) -> Option<Value> {
    v.is_finite().then_some(Value::Number(v))
}

/// A scalar as a hash key: numbers by bits with `-0` folded into `0`, as
/// JavaScript's `Set` and `Map` do.
#[derive(PartialEq, Eq, Hash, Clone)]
pub(crate) enum ScalarKey {
    Number(u64),
    String(String),
    Boolean(bool),
}

pub(crate) fn scalar_key(s: &Scalar) -> ScalarKey {
    match s {
        Scalar::Number(v) => ScalarKey::Number((v + 0.0).to_bits()),
        Scalar::String(v) => ScalarKey::String(v.clone()),
        Scalar::Boolean(v) => ScalarKey::Boolean(*v),
    }
}

/// `-0` written as `0`, as a `Set` or `Map` key comes back.
pub(crate) fn as_key(s: &Scalar) -> Scalar {
    match s {
        Scalar::Number(v) => Scalar::Number(v + 0.0),
        other => other.clone(),
    }
}

/// A cell's scalars, an array cell's elements flattened one level (pond-ts
/// `collectInto`).
pub(crate) fn scalars(v: &Value, mut f: impl FnMut(&Scalar)) {
    match v {
        Value::Number(x) => f(&Scalar::Number(*x)),
        Value::String(x) => f(&Scalar::String(x.clone())),
        Value::Boolean(x) => f(&Scalar::Boolean(*x)),
        Value::Array(items) => items.iter().for_each(f),
        Value::Decimal(_) => unreachable!("live series refuse decimal columns"),
    }
}

/// `2^e` exactly, for normal exponents.
fn pow2(e: i32) -> f64 {
    debug_assert!((-1022..=1023).contains(&e));
    f64::from_bits(((e + 1023) as u64) << 52)
}

/// A whole-number double as an exact big integer.
fn big_of(v: f64) -> BigInt {
    BigInt::from_f64(v).expect("a finite whole number")
}

/// JavaScript `Number(x)` for a big integer: the nearest double, ties to
/// even, `±Infinity` past the largest.
fn big_to_f64(x: &BigInt) -> f64 {
    x.to_f64()
        .unwrap_or(if x.sign() == num_bigint::Sign::Minus {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        })
}

/// pond-ts `LanedSum`: the drift-free running sum for values below
/// `SUM_SPLIT`, and an exact sum of the rest in units of `2^908` (every
/// double at or above `2^960` is a whole number of them).
#[derive(Default, Clone)]
pub(crate) struct LanedSum {
    small: WindowSum,
    big: BigInt,
    big_n: i64,
}

impl LanedSum {
    fn add(&mut self, v: f64) {
        if v < SUM_SPLIT && v > -SUM_SPLIT {
            self.small.add(v);
        } else {
            self.big += big_of(v * pow2(-908));
            self.big_n += 1;
        }
    }

    fn remove(&mut self, v: f64) {
        if v < SUM_SPLIT && v > -SUM_SPLIT {
            self.small.remove(v);
        } else {
            self.big -= big_of(v * pow2(-908));
            self.big_n -= 1;
        }
    }

    /// The window's sum; `±Infinity` only while it does not fit.
    fn total(&self) -> f64 {
        let small = self.small.hi;
        if self.big_n == 0 {
            small
        } else {
            small + big_to_f64(&self.big) * pow2(908)
        }
    }
}

/// pond-ts `StdevBigLane`: count, `Σu` and `Σu²` over the values of `2^480`
/// and up, in whole units `u = v / 2^428`.
#[derive(Default, Clone)]
pub(crate) struct StdevLane {
    n: i64,
    s1: BigInt,
    s2: BigInt,
}

impl StdevLane {
    fn add(&mut self, v: f64) {
        let u = big_of(v * pow2(-428));
        self.n += 1;
        self.s2 += &u * &u;
        self.s1 += u;
    }

    fn remove(&mut self, v: f64) {
        let u = big_of(v * pow2(-428));
        self.n -= 1;
        self.s2 -= &u * &u;
        self.s1 -= u;
    }
}

/// pond-ts `bigToScaledNumber`: `Number(x) · 2^exp`, shifting `x` down 64
/// bits at a time (rounding toward −∞, as JavaScript's `>>`) while it is
/// `2^1000` or more in size.
fn big_to_scaled(x: &BigInt, mut exp: i32) -> f64 {
    let limit = BigInt::from(1) << 1000u32;
    let mut x = x.clone();
    while x >= limit || x <= -&limit {
        x >>= 64u32;
        exp += 64;
    }
    big_to_f64(&x) * pow2(exp)
}

/// pond-ts `stdevWithBigLane`: the small lane (`n`, `mean`, `m2`) merged
/// with a non-empty big lane, worked out at scale `2^-600`.
fn stdev_with_big_lane(n: f64, mean: f64, m2: f64, big: &StdevLane) -> f64 {
    const SCALE: i32 = -600;
    let bn = BigInt::from(big.n);
    let big_n = big.n as f64;
    let big_mean = big_to_scaled(&big.s1, -172) / big_n;
    let big_m2 = big_to_scaled(&(&bn * &big.s2 - &big.s1 * &big.s1), -344) / big_n;
    if n == 0.0 {
        return (big_m2 / big_n).sqrt() * pow2(-SCALE);
    }
    let total = n + big_n;
    let d = big_mean - mean * pow2(SCALE);
    let merged = m2 * pow2(SCALE) * pow2(SCALE) + big_m2 + d * d * (n / total) * big_n;
    clamp_at_zero(merged / total).sqrt() * pow2(-SCALE)
}

/// What one `keep` value is counted under: numbers and text by value
/// (`-0` as `0`), an array cell by the event it came from (pond-ts counts
/// array objects, and each event's array is its own).
#[derive(PartialEq, Eq, Hash)]
pub(crate) enum KeepKey {
    Number(u64),
    String(String),
    Boolean(bool),
    Array(usize),
}

/// One output column's state. See the module docs.
pub(crate) enum LiveState {
    Count(i64),
    Sum(LanedSum),
    Avg(LanedSum, i64),
    Min(ExtremeState<false>),
    Max(ExtremeState<true>),
    /// `min` / `max` over a sorted window, for sources that evict out of
    /// arrival order (pond-ts `rollingSortedExtreme`).
    SortedExtreme {
        max: bool,
        sorted: Vec<f64>,
    },
    /// `first` / `last`: present values in arrival order, removed from the
    /// front (pond-ts `rollingOrderedEntries`).
    Ordered {
        last: bool,
        entries: VecDeque<(usize, Value)>,
    },
    /// `first` / `last` removing any index (pond-ts `rollingIndexedEntries`).
    Indexed {
        last: bool,
        entries: BTreeMap<usize, Value>,
    },
    Percentile(SortedState),
    Stdev(StdevState, StdevLane),
    Difference(DiffState),
    /// `difference` over a sorted window (pond-ts `rollingDifferenceSorted`).
    DifferenceSorted(Vec<f64>),
    Keep(HashMap<KeepKey, (Value, u64)>),
    Unique(HashMap<ScalarKey, (Scalar, u64)>),
    Top(usize, HashMap<ScalarKey, (Scalar, u64)>),
    /// Each event's scalars, by index (arrival order).
    Samples(BTreeMap<usize, Vec<Scalar>>),
}

impl LiveState {
    /// `sorted`: the source may evict out of arrival order.
    pub(crate) fn new(reducer: Reducer, sorted: bool) -> Self {
        match reducer {
            Reducer::Count => Self::Count(0),
            Reducer::Sum => Self::Sum(LanedSum::default()),
            Reducer::Avg => Self::Avg(LanedSum::default(), 0),
            Reducer::Min if sorted => Self::SortedExtreme {
                max: false,
                sorted: Vec::new(),
            },
            Reducer::Max if sorted => Self::SortedExtreme {
                max: true,
                sorted: Vec::new(),
            },
            Reducer::Min => Self::Min(ExtremeState::default()),
            Reducer::Max => Self::Max(ExtremeState::default()),
            Reducer::First | Reducer::Last if sorted => Self::Indexed {
                last: reducer == Reducer::Last,
                entries: BTreeMap::new(),
            },
            Reducer::First | Reducer::Last => Self::Ordered {
                last: reducer == Reducer::Last,
                entries: VecDeque::new(),
            },
            Reducer::Median => Self::Percentile(SortedState {
                sorted: Vec::new(),
                q: 50.0,
            }),
            Reducer::Percentile(q) => Self::Percentile(SortedState {
                sorted: Vec::new(),
                q,
            }),
            Reducer::Stdev => Self::Stdev(StdevState::default(), StdevLane::default()),
            Reducer::Difference if sorted => Self::DifferenceSorted(Vec::new()),
            Reducer::Difference => Self::Difference(DiffState::default()),
            Reducer::Keep => Self::Keep(HashMap::new()),
            Reducer::Unique => Self::Unique(HashMap::new()),
            Reducer::Top(n) => Self::Top(n, HashMap::new()),
            Reducer::Samples => Self::Samples(BTreeMap::new()),
        }
    }

    /// A present cell enters, as event `i`.
    pub(crate) fn add(&mut self, i: usize, v: &Value) {
        let x = || v.as_f64().expect("number column");
        match self {
            Self::Count(n) => *n += 1,
            Self::Sum(s) => s.add(x()),
            Self::Avg(s, n) => {
                *n += 1;
                s.add(x());
            }
            Self::Min(s) => s.add(i, x()),
            Self::Max(s) => s.add(i, x()),
            Self::SortedExtreme { sorted, .. } | Self::DifferenceSorted(sorted) => {
                let x = x();
                let at = lower_bound(sorted, x);
                sorted.insert(at, x);
            }
            Self::Ordered { entries, .. } => entries.push_back((i, v.clone())),
            Self::Indexed { entries, .. } => {
                entries.insert(i, v.clone());
            }
            Self::Percentile(s) => s.add(i, x()),
            Self::Stdev(w, big) => {
                let x = x();
                if x < STDEV_SPLIT && x > -STDEV_SPLIT {
                    w.add(i, x);
                } else {
                    big.add(x);
                }
            }
            Self::Difference(s) => s.add(i, x()),
            Self::Keep(counts) => {
                counts
                    .entry(keep_key(i, v))
                    .or_insert_with(|| (keep_value(v), 0))
                    .1 += 1;
            }
            Self::Unique(counts) | Self::Top(_, counts) => scalars(v, |s| {
                counts
                    .entry(scalar_key(s))
                    .or_insert_with(|| (as_key(s), 0))
                    .1 += 1;
            }),
            Self::Samples(items) => {
                let mut all = Vec::new();
                scalars(v, |s| all.push(s.clone()));
                if !all.is_empty() {
                    items.insert(i, all);
                }
            }
        }
    }

    /// A present cell leaves; `i` is the index it entered with.
    pub(crate) fn remove(&mut self, i: usize, v: &Value) {
        let x = || v.as_f64().expect("number column");
        match self {
            Self::Count(n) => *n -= 1,
            Self::Sum(s) => s.remove(x()),
            Self::Avg(s, n) => {
                *n -= 1;
                s.remove(x());
            }
            Self::Min(s) => s.remove(i, x()),
            Self::Max(s) => s.remove(i, x()),
            Self::SortedExtreme { sorted, .. } | Self::DifferenceSorted(sorted) => {
                let x = x();
                let at = lower_bound(sorted, x);
                if at < sorted.len() && sorted[at] == x {
                    sorted.remove(at);
                }
            }
            Self::Ordered { entries, .. } => {
                if entries.front().is_some_and(|e| e.0 == i) {
                    entries.pop_front();
                }
            }
            Self::Indexed { entries, .. } => {
                entries.remove(&i);
            }
            Self::Percentile(s) => s.remove(i, x()),
            Self::Stdev(w, big) => {
                let x = x();
                if x < STDEV_SPLIT && x > -STDEV_SPLIT {
                    w.remove(i, x);
                } else {
                    big.remove(x);
                }
            }
            Self::Difference(s) => s.remove(i, x()),
            Self::Keep(counts) => {
                let key = keep_key(i, v);
                if let Some(e) = counts.get_mut(&key) {
                    e.1 -= 1;
                    if e.1 == 0 {
                        counts.remove(&key);
                    }
                }
            }
            Self::Unique(counts) | Self::Top(_, counts) => scalars(v, |s| {
                let key = scalar_key(s);
                if let Some(e) = counts.get_mut(&key) {
                    if e.1 <= 1 {
                        counts.remove(&key);
                    } else {
                        e.1 -= 1;
                    }
                }
            }),
            Self::Samples(items) => {
                items.remove(&i);
            }
        }
    }

    /// The reducer over what is inside, as pond-ts reads it. Reading
    /// `stdev` may move its reference point (pond-ts does the same), which
    /// can change the last bit of later reads; see [`LiveState::peek`].
    pub(crate) fn snapshot(&mut self) -> Option<Value> {
        match self {
            Self::Stdev(w, big) => number(stdev_of(w, big)?),
            other => other.read(),
        }
    }

    /// The reducer over what is inside, leaving the state as it is.
    pub(crate) fn peek(&self) -> Option<Value> {
        match self {
            Self::Stdev(w, big) => number(stdev_of(&mut w.clone(), big)?),
            other => other.read(),
        }
    }

    /// What a pond-ts read does to the state, without building the value:
    /// only `stdev` changes when read.
    pub(crate) fn touch(&mut self) {
        if let Self::Stdev(w, big) = self {
            stdev_of(w, big);
        }
    }

    /// Every state but `stdev` (whose read is in `stdev_of`).
    fn read(&self) -> Option<Value> {
        match self {
            Self::Count(n) => number(*n as f64),
            Self::Sum(s) => number(s.total()),
            Self::Avg(s, n) => (*n != 0).then(|| s.total() / *n as f64).and_then(number),
            Self::Min(s) => s.0.front().and_then(|&(_, v)| number(v)),
            Self::Max(s) => s.0.front().and_then(|&(_, v)| number(v)),
            Self::SortedExtreme { max, sorted } => {
                if *max { sorted.last() } else { sorted.first() }.and_then(|&v| number(v))
            }
            Self::Ordered { last, entries } => if *last {
                entries.back()
            } else {
                entries.front()
            }
            .map(|e| e.1.clone()),
            Self::Indexed { last, entries } => if *last {
                entries.last_key_value()
            } else {
                entries.first_key_value()
            }
            .map(|e| e.1.clone()),
            Self::Percentile(s) => (!s.sorted.is_empty())
                .then(|| percentile_of_sorted(&s.sorted, s.q))
                .and_then(number),
            Self::Difference(s) => s.peek().and_then(number),
            Self::DifferenceSorted(sorted) => match (sorted.first(), sorted.last()) {
                (Some(lo), Some(hi)) => number(hi - lo),
                _ => None,
            },
            Self::Keep(counts) => {
                if counts.len() == 1 {
                    counts.values().next().map(|e| e.0.clone())
                } else {
                    None
                }
            }
            Self::Unique(counts) => {
                let mut out: Vec<Scalar> = counts.values().map(|e| e.0.clone()).collect();
                out.sort_by(compare_scalars);
                Some(Value::Array(out))
            }
            Self::Top(n, counts) => {
                let mut entries: Vec<&(Scalar, u64)> = counts.values().collect();
                entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| compare_scalars(&a.0, &b.0)));
                Some(Value::Array(
                    entries.iter().take(*n).map(|e| e.0.clone()).collect(),
                ))
            }
            Self::Samples(items) => Some(Value::Array(items.values().flatten().cloned().collect())),
            Self::Stdev(..) => unreachable!("read through stdev_of"),
        }
    }
}

/// pond-ts stdev `rollingState.snapshot()` (before `finiteOrMissing`).
fn stdev_of(w: &mut StdevState, big: &StdevLane) -> Option<f64> {
    if big.n != 0 {
        // pond-ts reads the mean before `m2()` may move the shift.
        let mean = w.mean();
        let m2 = w.m2();
        return Some(stdev_with_big_lane(w.n, mean, m2, big));
    }
    w.snapshot()
}

fn keep_key(i: usize, v: &Value) -> KeepKey {
    match v {
        Value::Number(x) => KeepKey::Number((x + 0.0).to_bits()),
        Value::String(s) => KeepKey::String(s.clone()),
        Value::Boolean(b) => KeepKey::Boolean(*b),
        Value::Array(_) => KeepKey::Array(i),
        Value::Decimal(_) => unreachable!("live series refuse decimal columns"),
    }
}

/// The value a `keep` key comes back as (`-0` as `0`, as a `Map` key).
fn keep_value(v: &Value) -> Value {
    match v {
        Value::Number(x) => Value::Number(x + 0.0),
        other => other.clone(),
    }
}
