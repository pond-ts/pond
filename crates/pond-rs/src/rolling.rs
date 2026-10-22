//! `TimeSeries::rolling` and its options: a window of time or of rows
//! around each row, or around each bucket of a sequence.
//!
//! The window states are ports of pond-ts's `rollingState`s (add a value as
//! it enters the window, remove it as it leaves), so results match pond-ts
//! bit for bit. `sum` / `avg` / `stdev` use pond-ts's double-double running
//! sums (`reducers/window-accumulators.ts`), which do not drift
//! ([PND-ROLLSTD]).

use std::collections::VecDeque;

use crate::column::ColumnData;
use crate::duration::parse_duration;
use crate::elements::Elements;
use crate::error::{PondError, Result};
use crate::reducer::{
    Agg, InputKind, Inputs, Reducer, check_source_kind, clamp_at_zero, input_kind, output_column,
    percentile_of_sorted,
};
use crate::reshape::At;
use crate::sequence::Sequence;
use crate::series::{Column, IntervalKeys, Key, TimeSeries};

const CALL: &str = "rolling";

/// pond-ts `SUM_SPLIT`: from this magnitude pond-ts moves a value into an
/// exact big-integer lane so a running sum cannot get stuck at infinity.
/// pond-rs does not have that lane yet and refuses such values instead.
const SUM_SPLIT: f64 = pow2(960);
/// pond-ts `STDEV_SPLIT`, the same idea for stdev.
const STDEV_SPLIT: f64 = pow2(480);

/// `2^e` exactly, for normal exponents.
const fn pow2(e: u64) -> f64 {
    f64::from_bits((e + 1023) << 52)
}

/// One column's window state: a value enters with `add`, leaves with
/// `remove`; `snapshot` is the reducer over what is inside. Only present
/// (finite) values reach a state.
trait WindowState {
    fn add(&mut self, row: usize, v: f64);
    fn remove(&mut self, row: usize, v: f64);
    /// `&mut`: the stdev state may move its reference point when read.
    fn snapshot(&mut self) -> Option<f64>;
}

#[derive(Default)]
struct CountState(i64);

impl WindowState for CountState {
    fn add(&mut self, _: usize, _: f64) {
        self.0 += 1;
    }
    fn remove(&mut self, _: usize, _: f64) {
        self.0 -= 1;
    }
    fn snapshot(&mut self) -> Option<f64> {
        Some(self.0 as f64)
    }
}

/// Dekker's split constant, 2^27 + 1.
const SPLIT: f64 = 134_217_729.0;

/// pond-ts `WindowSum`: a running sum held as `hi + lo` (double-double), so
/// rounding errors are kept rather than piling up. `hi` is the sum rounded
/// once; `n` resets the empty window to exactly 0.
#[derive(Default)]
struct WindowSum {
    hi: f64,
    lo: f64,
    n: i64,
}

impl WindowSum {
    fn add(&mut self, v: f64) {
        self.n += 1;
        self.acc(v);
    }
    fn remove(&mut self, v: f64) {
        self.n -= 1;
        if self.n == 0 {
            self.hi = 0.0;
            self.lo = 0.0;
            return;
        }
        self.acc(-v);
    }
    fn acc(&mut self, v: f64) {
        let h = self.hi;
        let s = h + v;
        let z = s - h;
        let e = h - (s - z) + (v - z) + self.lo;
        let t = s + e;
        self.lo = e - (t - s);
        self.hi = t;
    }
}

/// pond-ts `LanedSum` (small lane only; see [`SUM_SPLIT`]).
#[derive(Default)]
struct SumState(WindowSum);

impl WindowState for SumState {
    fn add(&mut self, _: usize, v: f64) {
        self.0.add(v);
    }
    fn remove(&mut self, _: usize, v: f64) {
        self.0.remove(v);
    }
    fn snapshot(&mut self) -> Option<f64> {
        Some(self.0.hi)
    }
}

/// pond-ts avg `rollingState`: running sum, then divide.
#[derive(Default)]
struct AvgState(WindowSum);

impl WindowState for AvgState {
    fn add(&mut self, _: usize, v: f64) {
        self.0.add(v);
    }
    fn remove(&mut self, _: usize, v: f64) {
        self.0.remove(v);
    }
    fn snapshot(&mut self) -> Option<f64> {
        (self.0.n != 0).then(|| self.0.hi / self.0.n as f64)
    }
}

/// pond-ts `rollingMonotoneDeque`: (row, value) pairs, front is the answer;
/// the earliest of equal values wins.
#[derive(Default)]
struct ExtremeState<const MAX: bool>(VecDeque<(usize, f64)>);

impl<const MAX: bool> WindowState for ExtremeState<MAX> {
    fn add(&mut self, row: usize, v: f64) {
        while let Some(&(_, back)) = self.0.back() {
            let keep = if MAX { back >= v } else { back <= v };
            if keep {
                break;
            }
            self.0.pop_back();
        }
        self.0.push_back((row, v));
    }
    fn remove(&mut self, row: usize, _: f64) {
        if self.0.front().is_some_and(|&(r, _)| r == row) {
            self.0.pop_front();
        }
    }
    fn snapshot(&mut self) -> Option<f64> {
        self.0.front().map(|&(_, v)| v)
    }
}

/// pond-ts `rollingOrderedEntries`: present values in arrival order.
struct OrderedState<const LAST: bool>(VecDeque<(usize, f64)>);

impl<const LAST: bool> WindowState for OrderedState<LAST> {
    fn add(&mut self, row: usize, v: f64) {
        self.0.push_back((row, v));
    }
    fn remove(&mut self, row: usize, _: f64) {
        if self.0.front().is_some_and(|&(r, _)| r == row) {
            self.0.pop_front();
        }
    }
    fn snapshot(&mut self) -> Option<f64> {
        if LAST { self.0.back() } else { self.0.front() }.map(|&(_, v)| v)
    }
}

/// pond-ts `rollingSortedArray` + `percentileOfSorted`.
struct SortedState {
    sorted: Vec<f64>,
    q: f64,
}

impl WindowState for SortedState {
    fn add(&mut self, _: usize, v: f64) {
        let at = lower_bound(&self.sorted, v);
        self.sorted.insert(at, v);
    }
    fn remove(&mut self, _: usize, v: f64) {
        let at = lower_bound(&self.sorted, v);
        if at < self.sorted.len() && self.sorted[at] == v {
            self.sorted.remove(at);
        }
    }
    fn snapshot(&mut self) -> Option<f64> {
        (!self.sorted.is_empty()).then(|| percentile_of_sorted(&self.sorted, self.q))
    }
}

/// pond-ts `difference` `rollingState`: two monotone deques give the
/// largest and smallest in O(1) a row, as pond-ts's do since
/// [PND-ROLLDIFF] (#799).
///
/// One case needs more: every value in the window is a zero. pond-ts's
/// answer then follows its old sorted window, a run of `0` and `-0`
/// inserted and removed at the front of the run (whichever zero leaves),
/// so the run behaves as a stack of signs; the answer is the bottom minus
/// the top, which can be `-0`. `zeros` is that stack. Otherwise one end is
/// not a zero and the sign of the other cannot change the result.
#[derive(Default)]
struct DiffState {
    max: ExtremeState<true>,
    min: ExtremeState<false>,
    zeros: VecDeque<f64>,
}

impl WindowState for DiffState {
    fn add(&mut self, row: usize, v: f64) {
        self.max.add(row, v);
        self.min.add(row, v);
        if v == 0.0 {
            self.zeros.push_front(v);
        }
    }
    fn remove(&mut self, row: usize, v: f64) {
        self.max.remove(row, v);
        self.min.remove(row, v);
        if v == 0.0 {
            self.zeros.pop_front();
        }
    }
    fn snapshot(&mut self) -> Option<f64> {
        let (hi, lo) = (self.max.snapshot()?, self.min.snapshot()?);
        if hi == 0.0 && lo == 0.0 {
            return Some(self.zeros.back()? - self.zeros.front()?);
        }
        Some(hi - lo)
    }
}

/// pond-ts `keep` `rollingState`, which counts each distinct value in a
/// `Map` and answers when one is left. One distinct value is the same as
/// the largest equal to the smallest, so two monotone deques answer it
/// without hashing. A `Map` key turns `-0` into `0`, so a window of zeros
/// gives `0` (`+ 0.0` does the same here).
#[derive(Default)]
struct KeepState {
    max: ExtremeState<true>,
    min: ExtremeState<false>,
}

impl WindowState for KeepState {
    fn add(&mut self, row: usize, v: f64) {
        self.max.add(row, v);
        self.min.add(row, v);
    }
    fn remove(&mut self, row: usize, v: f64) {
        self.max.remove(row, v);
        self.min.remove(row, v);
    }
    fn snapshot(&mut self) -> Option<f64> {
        let (hi, lo) = (self.max.snapshot()?, self.min.snapshot()?);
        (hi == lo).then_some(hi + 0.0)
    }
}

/// pond-ts `WindowStdev` (small lane only; see [`STDEV_SPLIT`]):
/// double-double `Σd` and `Σd²` of shifted values `d = v − k`, with `d` and
/// `d²` split exactly. The shift moves to the mean (an exact rewrite of the
/// sums) when the mean drifts about one stdev away. Same operations in the
/// same order as pond-ts, so the bits match.
#[derive(Default)]
struct StdevState {
    n: f64,
    k: f64,
    s1h: f64,
    s1l: f64,
    s2h: f64,
    s2l: f64,
}

impl StdevState {
    fn acc(&mut self, v: f64, sign: f64) {
        let k = self.k;
        let dh = v - k;
        let bb = dh - v;
        let dl = v - (dh - bb) + (-k - bb);
        let c = SPLIT * dh;
        let ah = c - (c - dh);
        let al = dh - ah;
        let p = dh * dh;
        let e = ah * ah - p + 2.0 * ah * al + al * al + 2.0 * dh * dl;
        let mut h = self.s1h;
        let mut x = sign * dh;
        let mut s = h + x;
        let mut z = s - h;
        let mut er = h - (s - z) + (x - z) + self.s1l + sign * dl;
        h = s + er;
        self.s1l = er - (h - s);
        self.s1h = h;
        h = self.s2h;
        x = sign * p;
        s = h + x;
        z = s - h;
        er = h - (s - z) + (x - z) + self.s2l + sign * e;
        h = s + er;
        self.s2l = er - (h - s);
        self.s2h = h;
    }

    fn m2(&mut self) -> f64 {
        let n = self.n;
        if n <= 1.0 {
            return 0.0;
        }
        let mut mh = self.s1h / n;
        let mut q = self.s1h * mh;
        if q > 0.5 * self.s2h {
            self.reshift(mh);
            mh = self.s1h / n;
            q = self.s1h * mh;
        }
        self.s2h - q + self.s2l - 2.0 * mh * self.s1l
    }

    fn reshift(&mut self, delta: f64) {
        let k = self.k;
        let n = self.n;
        let k_new = k + delta;
        let gh = k_new - k;
        let mut bb = gh - k_new;
        let gl = k_new - (gh - bb) + (-k - bb);
        let mut c = SPLIT * gh;
        let ah = c - (c - gh);
        let al = gh - ah;
        c = SPLIT * n;
        let bh = c - (c - n);
        let bl = n - bh;
        let nh = n * gh;
        let nl = ah * bh - nh + ah * bl + al * bh + al * bl + n * gl;
        let (s1h, s1l) = (self.s1h, self.s1l);
        let mut s = s1h - nh;
        bb = s - s1h;
        let mut e = s1h - (s - bb) + (-nh - bb) + s1l - nl;
        let u1h = s + e;
        let u1l = e - (u1h - s);
        s = s1h + u1h;
        bb = s - s1h;
        e = s1h - (s - bb) + (u1h - bb) + s1l + u1l;
        let th = s + e;
        let tl = e - (th - s);
        c = SPLIT * th;
        let ch = c - (c - th);
        let cl = th - ch;
        let ph = gh * th;
        let pl = ah * ch - ph + ah * cl + al * ch + al * cl + gh * tl + gl * th;
        let s2h = self.s2h;
        s = s2h - ph;
        bb = s - s2h;
        e = s2h - (s - bb) + (-ph - bb) + self.s2l - pl;
        let u2h = s + e;
        self.s2l = e - (u2h - s);
        self.s2h = u2h;
        self.s1h = u1h;
        self.s1l = u1l;
        self.k = k_new;
    }
}

impl WindowState for StdevState {
    fn add(&mut self, _: usize, v: f64) {
        if self.n == 0.0 {
            *self = Self {
                n: 1.0,
                k: v,
                ..Self::default()
            };
            return;
        }
        self.n += 1.0;
        self.acc(v, 1.0);
    }
    fn remove(&mut self, _: usize, v: f64) {
        if self.n <= 1.0 {
            *self = Self::default();
            return;
        }
        self.n -= 1.0;
        self.acc(v, -1.0);
    }
    fn snapshot(&mut self) -> Option<f64> {
        if self.n == 0.0 {
            return None;
        }
        if self.n == 1.0 {
            return Some(0.0);
        }
        let m2 = self.m2();
        Some(clamp_at_zero(m2 / self.n).sqrt())
    }
}

/// First index whose value is not below `v` (pond-ts `bisect`).
fn lower_bound(sorted: &[f64], v: f64) -> usize {
    sorted.partition_point(|&x| x < v)
}

/// One pass of a rolling window over a column: rows `enter` and `leave`,
/// and output rows are `emit`ted with the window as it then stands.
pub(crate) trait Window {
    fn enter(&mut self, row: usize);
    fn leave(&mut self, row: usize);
    fn emit(&mut self, rows: std::ops::Range<usize>);
}

/// Where a rolling window sits around each row (pond-ts `alignment`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Alignment {
    /// The window ends at the row: times in `(t - window, t]`, or the
    /// `n` rows ending at this one (pond-ts default).
    #[default]
    Trailing,
    /// The window starts at the row: times in `[t, t + window)`, or the
    /// `n` rows starting at this one.
    Leading,
    /// The window is centred on the row: times in
    /// `[t - window/2, t + window/2)`, or `n` rows around this one, one
    /// more after it than before when `n` is even.
    Centered,
}

/// Options for [`TimeSeries::rolling_with`] and
/// [`TimeSeries::rolling_rows`]. `Rolling::default()` is pond-ts's
/// default: a trailing window, every row given a value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Rolling {
    pub alignment: Alignment,
    /// A row whose window holds fewer rows than this gets a gap in every
    /// output column (pond-ts `minSamples`). Rows are counted whether or
    /// not their value is a gap. 0 (the default) gives every row a value.
    pub min_samples: usize,
}

/// Options for [`TimeSeries::rolling_over`]. `RollingOver::default()` is
/// pond-ts's default: a trailing window ending at each bucket's start,
/// over the series' own time range, every bucket given a value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RollingOver {
    pub alignment: Alignment,
    /// As [`Rolling::min_samples`], per bucket.
    pub min_samples: usize,
    /// The point of each bucket the window is placed at: its start, middle
    /// or end. Also picks which buckets are used, as in
    /// [`Align::sample`](crate::Align::sample).
    pub sample: At,
    /// As [`Align::range`](crate::Align::range).
    pub range: Option<(i64, i64)>,
}

/// How long a window is: a time span in ms, or a number of rows. Or the
/// windows themselves, one run of rows per output row, each starting and
/// ending no earlier than the one before (`rolling_by_column`).
#[derive(Clone, Copy)]
pub(crate) enum Span<'a> {
    Time(i64),
    Rows(usize),
    Windows(&'a [std::ops::Range<usize>]),
}

/// A row's place in time for a rolling window: whole ms (`i64`), or an
/// `f64` for anchors that can fall on a half millisecond (the middle of a
/// time range, which `smooth` uses).
pub(crate) trait Anchor: Copy + PartialEq {
    fn ms(self) -> f64;
}

impl Anchor for i64 {
    fn ms(self) -> f64 {
        // Keys are whole ms within ±8.64e15, so they convert exactly.
        self as f64
    }
}

impl Anchor for f64 {
    fn ms(self) -> f64 {
        self
    }
}

/// One rolling pass's windows: one per row of `times`.
#[derive(Clone, Copy)]
pub(crate) struct Frame<'a, T: Anchor = i64> {
    pub times: &'a [T],
    pub span: Span<'a>,
    pub alignment: Alignment,
    pub min_samples: usize,
}

impl<T: Anchor> Frame<'_, T> {
    /// The number of output rows.
    pub fn len(&self) -> usize {
        match self.span {
            Span::Windows(w) => w.len(),
            _ => self.times.len(),
        }
    }
}

/// Walk `frame`'s windows in row order, as pond-ts's rolling sweep does.
/// A time window is shared by the rows sharing a time; a row window is
/// per row. Each window's rows are a run `start..end` of rows that only
/// moves forward. The order rows enter and leave in is pond-ts's (it can
/// change the last bits of a running sum): a trailing or a row window
/// takes rows in before letting rows go; a leading or centred time window
/// lets rows go first. A window holding fewer than `min_samples` rows is
/// not emitted, so those rows keep the gap each output starts with.
pub(crate) fn walk<T: Anchor>(frame: &Frame<T>, w: &mut impl Window) {
    let times = frame.times;
    let rows = times.len();
    let (mut start, mut end) = (0usize, 0usize);
    let emit = |w: &mut _, out: std::ops::Range<usize>, start: usize, end: usize| {
        if end - start >= frame.min_samples {
            Window::emit(w, out);
        }
    };
    if let Span::Windows(windows) = frame.span {
        // Rows enter before rows leave, as pond-ts's `rollingByColumn`
        // sweep does.
        for (i, r) in windows.iter().enumerate() {
            while end < r.end {
                w.enter(end);
                end += 1;
            }
            while start < r.start {
                w.leave(start);
                start += 1;
            }
            emit(w, i..i + 1, start, end);
        }
        return;
    }
    if let Span::Rows(n) = frame.span {
        let left = (n - 1) / 2;
        let right = n - 1 - left;
        for i in 0..rows {
            let (lo, hi) = match frame.alignment {
                Alignment::Trailing => (i.saturating_sub(n - 1), i),
                Alignment::Leading => (i, i.saturating_add(n - 1).min(rows - 1)),
                Alignment::Centered => (
                    i.saturating_sub(left),
                    i.saturating_add(right).min(rows - 1),
                ),
            };
            while end <= hi {
                w.enter(end);
                end += 1;
            }
            while start < lo {
                w.leave(start);
                start += 1;
            }
            emit(w, i..i + 1, start, end);
        }
        return;
    }
    let Span::Time(window_ms) = frame.span else {
        unreachable!()
    };
    let window = window_ms as f64;
    let mut group_start = 0;
    while group_start < rows {
        let anchor = times[group_start];
        let mut group_end = group_start + 1;
        while group_end < rows && times[group_end] == anchor {
            group_end += 1;
        }
        // The edges are worked out in f64 exactly as pond-ts does. A
        // centred window an odd number of ms long has edges on a half
        // millisecond, which f64 rounds to even past 2^52 ms; computing them
        // another way would disagree with pond-ts there.
        let a = anchor.ms();
        let t = |row: usize| times[row].ms();
        match frame.alignment {
            Alignment::Trailing => {
                while end < rows && t(end) <= a {
                    w.enter(end);
                    end += 1;
                }
                let lower = a - window;
                while start < end && t(start) <= lower {
                    w.leave(start);
                    start += 1;
                }
            }
            Alignment::Leading | Alignment::Centered => {
                let (lower, upper) = if frame.alignment == Alignment::Leading {
                    (a, a + window)
                } else {
                    let half = window / 2.0;
                    (a - half, a + half)
                };
                while start < end && t(start) < lower {
                    w.leave(start);
                    start += 1;
                }
                while end < rows && t(end) < upper {
                    w.enter(end);
                    end += 1;
                }
            }
        }
        emit(w, group_start..group_end, start, end);
        group_start = group_end;
    }
}

/// A [`WindowState`] over `f64` values, skipping gaps (non-finite values).
struct Rolled<'a, S> {
    state: S,
    values: &'a [f64],
    out: Vec<f64>,
}

impl<S: WindowState> Window for Rolled<'_, S> {
    fn enter(&mut self, row: usize) {
        let v = self.values[row];
        if v.is_finite() {
            self.state.add(row, v);
        }
    }
    fn leave(&mut self, row: usize) {
        let v = self.values[row];
        if v.is_finite() {
            self.state.remove(row, v);
        }
    }
    fn emit(&mut self, rows: std::ops::Range<usize>) {
        // A non-finite result (an overflow) is a gap, as in pond-ts.
        let snap = self
            .state
            .snapshot()
            .filter(|v| v.is_finite())
            .unwrap_or(f64::NAN);
        self.out[rows].fill(snap);
    }
}

/// Run one column through `frame`'s windows with one reducer's state.
fn roll<S: WindowState, T: Anchor>(state: S, frame: &Frame<T>, values: &[f64]) -> Vec<f64> {
    let mut w = Rolled {
        state,
        values,
        out: vec![f64::NAN; frame.len()],
    };
    walk(frame, &mut w);
    w.out
}

pub(crate) fn roll_column<T: Anchor>(
    frame: &Frame<T>,
    values: &[f64],
    reducer: Reducer,
) -> Vec<f64> {
    match reducer {
        Reducer::Count => roll(CountState::default(), frame, values),
        Reducer::Sum => roll(SumState::default(), frame, values),
        Reducer::Avg => roll(AvgState::default(), frame, values),
        Reducer::Min => roll(ExtremeState::<false>(VecDeque::new()), frame, values),
        Reducer::Max => roll(ExtremeState::<true>(VecDeque::new()), frame, values),
        Reducer::First => roll(OrderedState::<false>(VecDeque::new()), frame, values),
        Reducer::Last => roll(OrderedState::<true>(VecDeque::new()), frame, values),
        Reducer::Median => roll(
            SortedState {
                sorted: Vec::new(),
                q: 50.0,
            },
            frame,
            values,
        ),
        Reducer::Percentile(q) => roll(
            SortedState {
                sorted: Vec::new(),
                q,
            },
            frame,
            values,
        ),
        Reducer::Stdev => roll(StdevState::default(), frame, values),
        Reducer::Difference => roll(DiffState::default(), frame, values),
        Reducer::Keep => roll(KeepState::default(), frame, values),
        Reducer::Unique | Reducer::Top(_) | Reducer::Samples => {
            unreachable!("list reducers run in elements.rs")
        }
    }
}

impl TimeSeries {
    /// For each row at time `t`, reduce the rows with time in
    /// `(t - window, t]`: a trailing window. Rows sharing a time share a
    /// window. A row keyed by a time range or an interval counts as its
    /// begin, as in pond-ts. The result keeps this series' keys; each mapping entry becomes
    /// a column that may have gaps.
    ///
    /// **Only the outputs are kept**, as in pond-ts: a source column is gone
    /// from the result unless an output carries it (add
    /// `Agg::new("close", "close", Reducer::Last)` to keep `close` beside
    /// its window stats). For the stats over the last window only, without
    /// a value per row, use [`TimeSeries::tail`] and
    /// [`TimeSeries::reduce`].
    ///
    /// ```
    /// use pond_rs::{Agg, Column, Reducer, TimeSeries};
    /// let s = TimeSeries::new("cpu", vec![0, 1_000, 2_000],
    ///     vec![Column::optional("v", [Some(1.0), None, Some(3.0)])])?;
    /// let r = s.rolling("2s", &[Agg::new("v_avg", "v", Reducer::Avg)])?;
    /// assert_eq!(r.column("v_avg")?.numbers()?.get(2), Some(3.0)); // (0s, 2s] holds only 3.0
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    ///
    /// Column order follows pond-ts: entries made with [`Agg::new`] keep the
    /// order given; when every entry is an [`Agg::of`] shorthand, columns
    /// come out in this series' schema order.
    ///
    /// Gaps: a gap is not a value. `count` counts present values, `sum` of
    /// none is 0, and the other reducers give a gap when the window has no
    /// present values.
    ///
    /// Text, true/false and array columns take `count` (a number column),
    /// `first`, `last` and `keep` (a column of the same kind), and `unique`,
    /// `top<N>` and `samples` (an array column, an empty list for a window
    /// with nothing present); any other reducer on them is an error. Decimal columns take every reducer:
    /// `first`, `last`, `min`, `max`, `keep`, `sum` and `difference` give
    /// exact decimals (`sum` and `difference` at precision 38, an error past
    /// it), the rest give numbers.
    ///
    /// Signed zeros follow pond-ts's window states: a window of zeros gives
    /// `keep` 0 whatever their signs, and `difference` can be `-0`: pond-ts
    /// keeps a window's zeros as a stack of signs and answers the bottom
    /// minus the top, so the sign depends on the order zeros came and went.
    pub fn rolling(&self, window: &str, aggs: &[Agg]) -> Result<TimeSeries> {
        self.rolling_with(window, aggs, Rolling::default())
    }

    /// [`TimeSeries::rolling`] with a choice of where the window sits
    /// ([`Alignment`]) and a minimum number of rows per window
    /// ([`Rolling::min_samples`]), as pond-ts
    /// `rolling(window, mapping, { alignment, minSamples })`. A leading
    /// window for a row at `t` holds the rows with time in
    /// `[t, t + window)`; a centred one, `[t - window/2, t + window/2)`.
    ///
    /// ```
    /// use pond_rs::{Agg, Alignment, Column, Reducer, Rolling, TimeSeries};
    /// let s = TimeSeries::new("cpu", vec![0, 1_000, 2_000],
    ///     vec![Column::required("v", vec![1.0, 2.0, 3.0])])?;
    /// let next = s.rolling_with("2s", &[Agg::new("v_sum", "v", Reducer::Sum)],
    ///     Rolling { alignment: Alignment::Leading, ..Rolling::default() })?;
    /// assert_eq!(next.column("v_sum")?.numbers()?.get(0), Some(3.0)); // [0s, 2s) holds 1 and 2
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn rolling_with(&self, window: &str, aggs: &[Agg], options: Rolling) -> Result<TimeSeries> {
        let window_ms = parse_duration(window)?;
        self.roll(Span::Time(window_ms), aggs, options)
    }

    /// For each row, reduce a window of `rows` rows, whatever their times
    /// (pond-ts `rolling({ count: rows }, mapping, options)`): the row and
    /// the `rows - 1` before it by default. This is the "N-bar" window of a
    /// trading study, which a time window gets wrong across weekends and
    /// overnight. Rows sharing a time do not share a window here. Near
    /// either end the window holds fewer rows; set
    /// [`Rolling::min_samples`] to `rows` to give those rows gaps instead.
    ///
    /// ```
    /// use pond_rs::{Agg, Column, Reducer, Rolling, TimeSeries};
    /// let s = TimeSeries::new("bars", vec![0, 60_000, 259_200_000],
    ///     vec![Column::required("close", vec![10.0, 12.0, 14.0])])?;
    /// let sma2 = s.rolling_rows(2, &[Agg::new("sma", "close", Reducer::Avg)],
    ///     Rolling { min_samples: 2, ..Rolling::default() })?;
    /// let sma = sma2.column("sma")?.numbers()?;
    /// assert_eq!((sma.get(0), sma.get(2)), (None, Some(13.0))); // across the weekend
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    ///
    /// `rows` must be at least 1.
    pub fn rolling_rows(&self, rows: usize, aggs: &[Agg], options: Rolling) -> Result<TimeSeries> {
        if rows == 0 {
            return Err(PondError::InvalidData {
                call: CALL,
                message: "a row window must hold at least 1 row".into(),
            });
        }
        self.roll(Span::Rows(rows), aggs, options)
    }

    fn roll(&self, span: Span, aggs: &[Agg], options: Rolling) -> Result<TimeSeries> {
        // Range- and interval-keyed rows are anchored at their begin, as in
        // pond-ts.
        let frame = Frame {
            times: self.key().begin(),
            span,
            alignment: options.alignment,
            min_samples: options.min_samples,
        };
        let plan = self.rolling_plan(aggs, self.key_name())?;
        let columns = self.roll_columns(CALL, &frame, &plan)?;
        Ok(TimeSeries::from_parts(
            self.name().to_string(),
            self.key_name().to_string(),
            self.shared_key(),
            columns,
        ))
    }

    /// Each entry of `plan` (a source column and its mapping entry) rolled
    /// through `frame`'s windows, one output column each.
    pub(crate) fn roll_columns(
        &self,
        call: &'static str,
        frame: &Frame,
        plan: &[(usize, &Agg)],
    ) -> Result<Vec<Column>> {
        for &(source, agg) in plan {
            check_magnitude(call, &self.columns()[source], agg.reducer)?;
        }
        let frame = *frame;
        let used: Vec<(usize, Reducer)> = plan
            .iter()
            .map(|&(source, agg)| (source, agg.reducer))
            .collect();
        let inputs = Inputs::build(self.columns(), &used);
        crate::par::map(plan, |&(source, agg)| {
            let data = self.columns()[source].data();
            if agg.reducer.gives_list() {
                let lists = Elements::new(data).roll(agg.reducer, &frame);
                return Ok(Column::from_data(agg.output.clone(), lists, false));
            }
            let kind = input_kind(data, agg.reducer);
            if let (ColumnData::Decimal(d), InputKind::ExactSum) = (data, kind) {
                return crate::decimal::rolling_sum(call, &agg.output, d, &frame);
            }
            let input = inputs.get(source, kind);
            if let (ColumnData::Decimal(d), Reducer::Difference) = (data, agg.reducer) {
                let lo = roll_column(&frame, &input.values, Reducer::Min);
                let hi = roll_column(&frame, &input.values, Reducer::Max);
                return crate::decimal::difference(call, &agg.output, d, input, &lo, &hi);
            }
            let out = roll_column(&frame, &input.values, agg.reducer);
            Ok(output_column(
                agg.output.clone(),
                data,
                agg.reducer,
                input,
                out,
            ))
        })
        .into_iter()
        .collect()
    }

    /// One row per bucket of `sequence`, holding the reducers over a window
    /// of `window` placed at the bucket (pond-ts
    /// `rolling(sequence, window, mapping, options)`): a smoothed line on a
    /// regular grid, such as a 5-minute average every minute. The window
    /// sits at each bucket's sample point ([`RollingOver::sample`], its
    /// start by default) as [`Alignment`] says, holding the rows whose
    /// time (or start, for time-range and interval keys) is in it.
    ///
    /// ```
    /// use pond_rs::{Agg, Column, Reducer, RollingOver, Sequence, TimeSeries};
    /// let s = TimeSeries::new("cpu", vec![0, 30_000, 60_000, 90_000],
    ///     vec![Column::required("v", vec![1.0, 2.0, 3.0, 4.0])])?;
    /// let r = s.rolling_over(&Sequence::every("1m")?, "1m",
    ///     &[Agg::new("v_avg", "v", Reducer::Avg)], RollingOver::default())?;
    /// assert_eq!(r.key().begin(), &[0, 60_000]);
    /// assert_eq!(r.column("v_avg")?.numbers()?.get(1), Some(2.5)); // (0s, 60s] holds 2 and 3
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    ///
    /// The result is keyed by the buckets (an interval labelled by its
    /// start, named `"interval"`). Buckets are picked as in
    /// [`TimeSeries::align`]: those whose sample point is in
    /// [`RollingOver::range`], by default the series' own range.
    ///
    /// Each window is reduced as [`TimeSeries::aggregate`] reduces a bucket,
    /// with the same reducers, kinds and rules (an empty window gives
    /// `count` 0, `sum` 0, an empty list for the list reducers, and gaps
    /// otherwise); columns come out in the order [`TimeSeries::rolling`]
    /// gives. An empty series with no range gives an empty result. An
    /// output named `"interval"` is an error.
    pub fn rolling_over(
        &self,
        sequence: &Sequence,
        window: &str,
        aggs: &[Agg],
        options: RollingOver,
    ) -> Result<TimeSeries> {
        let window_ms = parse_duration(window)?;
        let plan = self.rolling_plan(aggs, "interval")?;
        let buckets = match self.grid_range(CALL, options.range)? {
            None => crate::grid::no_buckets(),
            Some((begin, end)) => sequence.buckets_sampled(begin, end, options.sample)?,
        };
        let ranges = grid_windows(
            self.key().begin(),
            &buckets,
            options.sample,
            window_ms,
            options.alignment,
        );
        let plan: Vec<(&Agg, usize)> = plan
            .into_iter()
            .map(|(source, agg)| (agg, source))
            .collect();
        let mut columns = self.reduce_columns(CALL, &plan, &ranges)?;
        if ranges.iter().any(|r| r.len() < options.min_samples) {
            let keep: Vec<Option<usize>> = ranges
                .iter()
                .enumerate()
                .map(|(i, r)| (r.len() >= options.min_samples).then_some(i))
                .collect();
            for c in &mut columns {
                *c = Column::from_data(c.name().to_string(), c.data().take(&keep), false);
            }
        }
        Ok(TimeSeries::from_parts(
            self.name().to_string(),
            "interval".to_string(),
            Key::Interval(buckets),
            columns,
        ))
    }

    /// Check `aggs` for a rolling call and pair each with its source
    /// column, in output order: the order given, or this series' schema
    /// order when every entry is an [`Agg::of`] shorthand (pond-ts sorts
    /// those). `key` is the result's key name, which no output may take.
    fn rolling_plan<'a>(&self, aggs: &'a [Agg], key: &str) -> Result<Vec<(usize, &'a Agg)>> {
        let mut plan = Vec::with_capacity(aggs.len());
        for (i, agg) in aggs.iter().enumerate() {
            let source = self.column_index(CALL, &agg.source)?;
            agg.reducer.check(CALL)?;
            if agg.output == key || aggs[..i].iter().any(|a| a.output == agg.output) {
                return Err(PondError::DuplicateOutput {
                    call: CALL,
                    column: agg.output.clone(),
                });
            }
            check_source_kind(CALL, &self.columns()[source], agg.reducer)?;
            plan.push((source, agg));
        }
        if aggs.iter().all(|a| a.shorthand) {
            // Stable, so equal positions keep their given order.
            plan.sort_by_key(|&(source, _)| source);
        }
        Ok(plan)
    }
}

/// Each bucket's window as a run of rows. `starts` are the rows' start
/// times (sorted). The window sits at the bucket's sample point, and both
/// are worked out in f64 exactly as pond-ts does (`sampleTime` and
/// `anchorInWindow`), as in [`walk`].
fn grid_windows(
    starts: &[i64],
    buckets: &IntervalKeys,
    sample: At,
    window_ms: i64,
    alignment: Alignment,
) -> Vec<std::ops::Range<usize>> {
    let w = window_ms as f64;
    let t = |row: usize| starts[row] as f64;
    let n = starts.len();
    let (mut lo, mut hi) = (0usize, 0usize);
    buckets
        .begin
        .iter()
        .zip(&buckets.end)
        .map(|(&b, &e)| {
            let (b, e) = (b as f64, e as f64);
            let p = match sample {
                At::Begin => b,
                At::Center => b + (e - b) / 2.0,
                At::End => e,
            };
            // A row is in when `from <= t < to` (trailing: `from < t <= to`).
            let (from, to) = match alignment {
                Alignment::Trailing => (p - w, p),
                Alignment::Leading => (p, p + w),
                Alignment::Centered => (p - w / 2.0, p + w / 2.0),
            };
            let trailing = alignment == Alignment::Trailing;
            while lo < n && (t(lo) < from || (trailing && t(lo) == from)) {
                lo += 1;
            }
            hi = hi.max(lo);
            while hi < n && (t(hi) < to || (trailing && t(hi) == to)) {
                hi += 1;
            }
            lo..hi
        })
        .collect()
}

/// Refuse values pond-ts would route to its big-integer lanes.
pub(crate) fn check_magnitude(call: &'static str, column: &Column, reducer: Reducer) -> Result<()> {
    check_magnitude_in(call, column, reducer, None)
}

/// [`check_magnitude`] over only `rows` of the column (all rows when
/// `None`), naming the row as numbered in the column.
pub(crate) fn check_magnitude_in(
    call: &'static str,
    column: &Column,
    reducer: Reducer,
    rows: Option<&[u32]>,
) -> Result<()> {
    let split = match reducer {
        Reducer::Sum | Reducer::Avg => SUM_SPLIT,
        Reducer::Stdev => STDEV_SPLIT,
        _ => return Ok(()),
    };
    // Decimals reach the f64 kernels below 1e76 (38 digits, scale down to
    // -38), far under either split (2^480 is about 3e144).
    let Ok(values) = column.numbers().map(|c| c.values()) else {
        return Ok(());
    };
    let too_big = |&row: &usize| values[row].is_finite() && values[row].abs() >= split;
    let found = match rows {
        None => (0..values.len()).find(too_big),
        Some(rows) => rows.iter().map(|&r| r as usize).find(too_big),
    };
    match found {
        None => Ok(()),
        Some(row) => Err(PondError::Unsupported {
            call,
            message: format!(
                "column '{}' row {row} holds {:e}, too large for a rolling {:?} (limit {split:e})",
                column.name(),
                values[row],
                reducer
            ),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extreme_times_keep_their_own_row() {
        use crate::MAX_TIME_MS;
        for t in [-MAX_TIME_MS, MAX_TIME_MS] {
            let s = TimeSeries::new("s", vec![t], vec![Column::required("v", vec![7.0])]).unwrap();
            for window in ["1ms", "100000000d"] {
                let r = s
                    .rolling(window, &[Agg::new("n", "v", Reducer::Count)])
                    .unwrap();
                assert_eq!(
                    r.column("n").unwrap().numbers().unwrap().get(0),
                    Some(1.0),
                    "{t} {window}"
                );
            }
        }
        let too_early =
            TimeSeries::new("s", vec![i64::MIN], vec![Column::required("v", vec![7.0])]);
        assert!(too_early.is_err());
    }

    /// `DiffState` against a line-for-line port of pond-ts's sorted window,
    /// on windows full of zeros of both signs.
    #[test]
    fn difference_matches_the_sorted_window_bit_for_bit() {
        struct Sorted(Vec<f64>);
        impl WindowState for Sorted {
            fn add(&mut self, _: usize, v: f64) {
                let at = lower_bound(&self.0, v);
                self.0.insert(at, v);
            }
            fn remove(&mut self, _: usize, v: f64) {
                let at = lower_bound(&self.0, v);
                if at < self.0.len() && self.0[at] == v {
                    self.0.remove(at);
                }
            }
            fn snapshot(&mut self) -> Option<f64> {
                Some(self.0.last()? - self.0.first()?)
            }
        }
        let mut seed = 11u64;
        let mut next = || {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            seed >> 33
        };
        for _ in 0..300 {
            let n = 1 + next() as usize % 60;
            let mut t = 0;
            let times: Vec<i64> = (0..n)
                .map(|_| {
                    t += next() as i64 % 3;
                    t
                })
                .collect();
            let values: Vec<f64> = (0..n)
                .map(|_| [0.0, -0.0, 0.0, -0.0, 1.0, -2.0, f64::NAN][next() as usize % 7])
                .collect();
            let window = 1 + next() as i64 % 8;
            let frame = Frame {
                times: &times,
                span: Span::Time(window),
                alignment: Alignment::Trailing,
                min_samples: 0,
            };
            let want = roll(Sorted(Vec::new()), &frame, &values);
            let got = roll(DiffState::default(), &frame, &values);
            let bits = |xs: &[f64]| xs.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
            assert_eq!(bits(&got), bits(&want), "{times:?} {values:?} {window}");
        }
    }

    #[test]
    fn splits_are_the_pond_ts_powers_of_two() {
        assert_eq!(SUM_SPLIT, 2f64.powi(960));
        assert_eq!(STDEV_SPLIT, 2f64.powi(480));
    }
}
