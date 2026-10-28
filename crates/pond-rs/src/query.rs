//! Finding rows by position, by key and by a test: `at`, `bisect`,
//! `includes_key`, `at_or_before` / `at_or_after`, `nearest`, and `find` /
//! `some` / `every`, as in pond-ts.
//!
//! A key to look for is an [`EventKey`]: a point in time (a plain `i64`
//! converts), a time range or a labelled interval. Keys compare as pond-ts
//! compares them: by start, then end, then kind (interval, then time, then
//! time range), then, between two intervals, by label (numbers before text,
//! text in the same order as JavaScript's `localeCompare`).
//!
//! ```
//! # use pond_rs::{Column, EventKey, TimeSeries};
//! let s = TimeSeries::new("cpu", vec![0, 1000, 2500, 4000], vec![
//!     Column::required("v", vec![1.0, 2.0, 3.0, 4.0]),
//! ])?;
//! assert_eq!(s.bisect(2000), 2); // where 2000 would go
//! assert!(s.includes_key(2500));
//! assert_eq!(s.at_or_before(2000).map(|r| r.begin()), Some(1000));
//! assert_eq!(s.at_or_after(2000).map(|r| r.begin()), Some(2500));
//! assert_eq!(s.nearest(3300).map(|r| r.begin()), Some(4000));
//! assert_eq!(s.at(-1).map(|r| r.begin()), Some(4000));
//! let busy = s.find(|r| Ok(r.number("v")? > Some(2.5)))?;
//! assert_eq!(busy.map(|r| r.index()), Some(2));
//! # Ok::<(), pond_rs::PondError>(())
//! ```

use std::cmp::Ordering;

use icu_collator::CollatorBorrowed;

use crate::error::{PondError, Result};
use crate::join::root_collator;
use crate::rows::Row;
use crate::series::{Key, Labels, TimeSeries};

/// One interval label: a number or text, as pond-ts allows. (A whole
/// column of them is [`Labels`](crate::Labels).)
#[derive(Debug, Clone, PartialEq)]
pub enum Label {
    /// A number label. Must be finite.
    Number(f64),
    /// A text label.
    String(String),
}

impl From<f64> for Label {
    fn from(v: f64) -> Self {
        Label::Number(v)
    }
}

/// Exact for whole numbers up to 2^53.
impl From<i64> for Label {
    fn from(v: i64) -> Self {
        Label::Number(v as f64)
    }
}

impl From<&str> for Label {
    fn from(v: &str) -> Self {
        Label::String(v.to_string())
    }
}

impl From<String> for Label {
    fn from(v: String) -> Self {
        Label::String(v)
    }
}

/// One key: a point in time, a time range or a labelled interval, in
/// epoch milliseconds, as pond-ts `Time` / `TimeRange` / `Interval`. Used to
/// look rows up ([`TimeSeries::bisect`] and friends) and given by
/// [`Row::key`]. A plain `i64` converts to a point in time. (A series'
/// whole key column is a [`Key`](crate::Key).)
#[derive(Debug, Clone, PartialEq)]
pub struct EventKey {
    begin: i64,
    end: i64,
    label: Option<Label>,
    kind: KeyKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum KeyKind {
    // In pond-ts's order: kind names compared with `localeCompare`.
    Interval,
    Time,
    TimeRange,
}

impl EventKey {
    /// A point in time.
    pub fn time(at: i64) -> Self {
        Self {
            begin: at,
            end: at,
            label: None,
            kind: KeyKind::Time,
        }
    }

    /// A time range from `begin` to `end`. An error when `begin > end`, as
    /// in pond-ts.
    pub fn time_range(begin: i64, end: i64) -> Result<Self> {
        check_order("EventKey::time_range", begin, end)?;
        Ok(Self {
            begin,
            end,
            label: None,
            kind: KeyKind::TimeRange,
        })
    }

    /// An interval from `begin` to `end`, labelled `label`. An error when
    /// `begin > end`, as in pond-ts, or when a number label is not finite
    /// (pond-rs labels are finite; pond-ts does not check).
    pub fn interval(label: impl Into<Label>, begin: i64, end: i64) -> Result<Self> {
        const CALL: &str = "EventKey::interval";
        check_order(CALL, begin, end)?;
        let label = label.into();
        if let Label::Number(v) = label
            && !v.is_finite()
        {
            return Err(PondError::InvalidData {
                call: CALL,
                message: format!("a label must be finite, got {v}"),
            });
        }
        Ok(Self {
            begin,
            end,
            label: Some(label),
            kind: KeyKind::Interval,
        })
    }

    /// The start, in epoch milliseconds.
    pub fn begin(&self) -> i64 {
        self.begin
    }

    /// The end, in epoch milliseconds (the start, for a point in time).
    pub fn end(&self) -> i64 {
        self.end
    }

    /// The label of an interval; `None` for other kinds.
    pub fn label(&self) -> Option<&Label> {
        self.label.as_ref()
    }

    /// `"time"`, `"timeRange"` or `"interval"`, as pond-ts `type()`.
    pub fn kind(&self) -> &'static str {
        match self.kind {
            KeyKind::Time => "time",
            KeyKind::TimeRange => "timeRange",
            KeyKind::Interval => "interval",
        }
    }
}

impl From<i64> for EventKey {
    fn from(at: i64) -> Self {
        EventKey::time(at)
    }
}

fn check_order(call: &'static str, begin: i64, end: i64) -> Result<()> {
    if begin > end {
        return Err(PondError::InvalidData {
            call,
            message: format!("start must be <= end, got {begin} > {end}"),
        });
    }
    Ok(())
}

/// Two keys in pond-ts's order (`a.compare(b)`): start, then end, then kind,
/// then (two intervals) label: numbers before text, text by the root
/// collator as JavaScript's `localeCompare`.
#[cfg(feature = "live")]
pub(crate) fn compare_keys(a: &EventKey, b: &EventKey) -> Ordering {
    let c = a
        .begin
        .cmp(&b.begin)
        .then(a.end.cmp(&b.end))
        .then(a.kind.cmp(&b.kind));
    if c != Ordering::Equal {
        return c;
    }
    match (&a.label, &b.label) {
        (Some(Label::Number(x)), Some(Label::Number(y))) => {
            x.partial_cmp(y).unwrap_or(Ordering::Equal)
        }
        (Some(Label::Number(_)), Some(Label::String(_))) => Ordering::Less,
        (Some(Label::String(_)), Some(Label::Number(_))) => Ordering::Greater,
        (Some(Label::String(x)), Some(Label::String(y))) if x != y => root_collator().compare(x, y),
        _ => Ordering::Equal,
    }
}

/// pond-ts `a.equals(b)`: same kind, start and end, and for intervals the
/// same label (`===`).
#[cfg(feature = "live")]
pub(crate) fn keys_equal(a: &EventKey, b: &EventKey) -> bool {
    a.kind == b.kind && a.begin == b.begin && a.end == b.end && a.label == b.label
}

/// Compares a series' rows with one key, as pond-ts `keyAt(i).compare(key)`.
struct KeyCompare<'a> {
    key: &'a Key,
    query: &'a EventKey,
    collator: Option<CollatorBorrowed<'static>>,
}

impl<'a> KeyCompare<'a> {
    fn new(key: &'a Key, query: &'a EventKey) -> Self {
        Self {
            key,
            query,
            collator: None,
        }
    }

    fn kind(&self) -> KeyKind {
        match self.key {
            Key::Time(_) => KeyKind::Time,
            Key::TimeRange(_) => KeyKind::TimeRange,
            Key::Interval(_) => KeyKind::Interval,
        }
    }

    /// Row `i` against the query.
    fn cmp(&mut self, i: usize) -> Ordering {
        let q = self.query;
        let begin = self.key.begin()[i];
        let end = self.key.end().map_or(begin, |e| e[i]);
        let c = begin
            .cmp(&q.begin)
            .then(end.cmp(&q.end))
            .then(self.kind().cmp(&q.kind));
        if c != Ordering::Equal {
            return c;
        }
        let (Key::Interval(k), Some(ql)) = (self.key, &q.label) else {
            return c;
        };
        match (&k.label, ql) {
            // Labels are finite, so this is a total order.
            (Labels::Number(a), Label::Number(b)) => a[i].partial_cmp(b).unwrap_or(Ordering::Equal),
            // Numbers sort before text.
            (Labels::Number(_), Label::String(_)) => Ordering::Less,
            (Labels::String(_), Label::Number(_)) => Ordering::Greater,
            (Labels::String(a), Label::String(b)) => {
                let a = a.get(i).unwrap_or("");
                if a == b {
                    return Ordering::Equal;
                }
                self.collator
                    .get_or_insert_with(root_collator)
                    .compare(a, b)
            }
        }
    }

    /// Row `i` is the query exactly, as pond-ts `keyAt(i).equals(key)`:
    /// same kind, start and end, and for intervals the same label (`===`,
    /// so text must match byte for byte).
    fn equals(&self, i: usize) -> bool {
        let q = self.query;
        let begin = self.key.begin()[i];
        let end = self.key.end().map_or(begin, |e| e[i]);
        if self.kind() != q.kind || begin != q.begin || end != q.end {
            return false;
        }
        match (self.key, &q.label) {
            (Key::Interval(k), Some(ql)) => match (&k.label, ql) {
                (Labels::Number(a), Label::Number(b)) => a[i] == *b,
                (Labels::String(a), Label::String(b)) => a.get(i) == Some(b.as_str()),
                _ => false,
            },
            _ => true,
        }
    }

    /// The first row not before the query: pond-ts's binary search, step
    /// for step, so rows out of label order land where pond-ts lands.
    fn bisect(&mut self) -> usize {
        let (mut low, mut high) = (0, self.key.len());
        while low < high {
            let mid = (low + high) >> 1;
            if self.cmp(mid) == Ordering::Less {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        low
    }
}

impl TimeSeries {
    /// The row at `index`; negative positions count from the end (`-1` is
    /// the last row), as pond-ts `at` and JavaScript's `Array.prototype.at`.
    /// `None` past either end.
    pub fn at(&self, index: i64) -> Option<Row<'_>> {
        let n = self.len() as i64;
        let i = if index < 0 { n + index } else { index };
        if i < 0 || i >= n {
            return None;
        }
        self.row(i as usize)
    }

    /// Where `key` would go: the first row whose key is not before it (so
    /// before any rows equal to it), as pond-ts `bisect`. The length of the
    /// series when every row is before it. O(log N).
    pub fn bisect(&self, key: impl Into<EventKey>) -> usize {
        let key = key.into();
        KeyCompare::new(self.key(), &key).bisect()
    }

    /// Whether a row has exactly `key`, as pond-ts `includesKey`. Only the
    /// row [`bisect`](TimeSeries::bisect) lands on is checked, as in
    /// pond-ts.
    pub fn includes_key(&self, key: impl Into<EventKey>) -> bool {
        let key = key.into();
        let mut c = KeyCompare::new(self.key(), &key);
        let i = c.bisect();
        i < self.len() && c.equals(i)
    }

    /// The row with exactly `key`, else the last row before it, as pond-ts
    /// `atOrBefore`. `None` when every row is after it.
    pub fn at_or_before(&self, key: impl Into<EventKey>) -> Option<Row<'_>> {
        let key = key.into();
        let mut c = KeyCompare::new(self.key(), &key);
        let i = c.bisect();
        if i < self.len() && c.equals(i) {
            return self.row(i);
        }
        i.checked_sub(1).and_then(|i| self.row(i))
    }

    /// The first row not before `key` (the row
    /// [`bisect`](TimeSeries::bisect) gives), as pond-ts `atOrAfter`. `None`
    /// when every row is before it.
    pub fn at_or_after(&self, key: impl Into<EventKey>) -> Option<Row<'_>> {
        self.row(self.bisect(key))
    }

    /// The row whose start is closest to `key`'s start, as pond-ts
    /// `nearest`; a tie goes to the earlier row. A key outside the series
    /// gives the first or last row. `None` only for an empty series.
    pub fn nearest(&self, key: impl Into<EventKey>) -> Option<Row<'_>> {
        let n = self.len();
        if n == 0 {
            return None;
        }
        let key = key.into();
        let i = KeyCompare::new(self.key(), &key).bisect();
        if i == 0 {
            return self.row(0);
        }
        if i >= n {
            return self.row(n - 1);
        }
        let begin = self.key().begin();
        let target = key.begin as i128;
        let (before, after) = (begin[i - 1] as i128, begin[i] as i128);
        self.row(if target - before <= after - target {
            i - 1
        } else {
            i
        })
    }

    /// The first row for which `test` returns `Ok(true)`, as pond-ts
    /// `find`. An error from `test` stops the walk and is returned.
    pub fn find<F>(&self, mut test: F) -> Result<Option<Row<'_>>>
    where
        F: FnMut(&Row<'_>) -> Result<bool>,
    {
        for row in self.rows() {
            if test(&row)? {
                return Ok(Some(row));
            }
        }
        Ok(None)
    }

    /// Whether `test` returns `Ok(true)` for some row, as pond-ts `some`
    /// (`false` for an empty series). Stops at the first match.
    pub fn some<F>(&self, test: F) -> Result<bool>
    where
        F: FnMut(&Row<'_>) -> Result<bool>,
    {
        Ok(self.find(test)?.is_some())
    }

    /// Whether `test` returns `Ok(true)` for every row, as pond-ts `every`
    /// (`true` for an empty series). Stops at the first row that fails.
    pub fn every<F>(&self, mut test: F) -> Result<bool>
    where
        F: FnMut(&Row<'_>) -> Result<bool>,
    {
        for row in self.rows() {
            if !test(&row)? {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

impl Row<'_> {
    /// The row's key, as pond-ts `event.key()`.
    pub fn key(&self) -> EventKey {
        let key = self.series().key();
        let i = self.index();
        let (begin, end) = (self.begin(), self.end());
        match key {
            Key::Time(_) => EventKey::time(begin),
            Key::TimeRange(_) => EventKey {
                begin,
                end,
                label: None,
                kind: KeyKind::TimeRange,
            },
            Key::Interval(k) => EventKey {
                begin,
                end,
                label: Some(match &k.label {
                    Labels::Number(v) => Label::Number(v[i]),
                    Labels::String(s) => Label::String(s.get(i).unwrap_or("").to_string()),
                }),
                kind: KeyKind::Interval,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Column;
    use crate::series::{IntervalKeys, TimeRangeKeys};

    fn times() -> TimeSeries {
        TimeSeries::new(
            "t",
            vec![0, 1000, 1000, 2500],
            vec![Column::required("v", vec![1.0, 2.0, 3.0, 4.0])],
        )
        .unwrap()
    }

    #[test]
    fn bisect_lands_before_equal_rows() {
        let s = times();
        assert_eq!(s.bisect(-5), 0);
        assert_eq!(s.bisect(1000), 1);
        assert_eq!(s.bisect(1001), 3);
        assert_eq!(s.bisect(9000), 4);
    }

    #[test]
    fn at_counts_back_from_the_end() {
        let s = times();
        assert_eq!(s.at(0).map(|r| r.index()), Some(0));
        assert_eq!(s.at(-1).map(|r| r.index()), Some(3));
        assert_eq!(s.at(-4).map(|r| r.index()), Some(0));
        assert!(s.at(-5).is_none());
        assert!(s.at(4).is_none());
        assert!(s.at(i64::MIN).is_none());
    }

    #[test]
    fn nearest_ties_go_to_the_earlier_row() {
        let s = times();
        assert_eq!(s.nearest(500).map(|r| r.index()), Some(0));
        assert_eq!(s.nearest(501).map(|r| r.index()), Some(1));
        assert_eq!(s.nearest(-100).map(|r| r.index()), Some(0));
        assert_eq!(s.nearest(1 << 40).map(|r| r.index()), Some(3));
        assert!(s.slice(0..0).nearest(0).is_none());
    }

    #[test]
    fn a_range_key_is_not_a_time_key() {
        let s = times();
        // Same start and end, other kind: never equal; a time sorts before
        // a time range.
        let r = EventKey::time_range(1000, 1000).unwrap();
        assert!(!s.includes_key(r.clone()));
        assert_eq!(s.bisect(r), 3);
        assert!(EventKey::time_range(2, 1).is_err());
        assert!(EventKey::interval(f64::NAN, 0, 1).is_err());
    }

    #[test]
    fn interval_labels_order_numbers_before_text() {
        let s = TimeSeries::from_parts(
            "i".into(),
            "interval".into(),
            Key::Interval(IntervalKeys {
                label: vec!["a", "B", "b"].into(),
                begin: vec![0, 0, 0],
                end: vec![10, 10, 10],
            }),
            vec![],
        );
        let k = |l: &str| EventKey::interval(l, 0, 10).unwrap();
        assert_eq!(s.bisect(EventKey::interval(5.0, 0, 10).unwrap()), 0);
        assert_eq!(s.bisect(k("b")), 1); // root collation: b < B
        assert!(s.includes_key(k("B")));
        assert_eq!(s.at(1).unwrap().key(), k("B"));
        let r = TimeSeries::from_parts(
            "r".into(),
            "timeRange".into(),
            Key::TimeRange(TimeRangeKeys {
                begin: vec![0],
                end: vec![5],
            }),
            vec![],
        );
        assert_eq!(r.at(0).unwrap().key(), EventKey::time_range(0, 5).unwrap());
        assert_eq!(r.at(0).unwrap().key().kind(), "timeRange");
    }

    #[test]
    fn row_key_gives_time_and_number_labelled_keys() {
        let t = times().at(1).unwrap().key();
        assert_eq!(
            (t.clone(), t.kind(), t.label()),
            (EventKey::time(1000), "time", None)
        );
        let n = TimeSeries::from_parts(
            "n".into(),
            "interval".into(),
            Key::Interval(IntervalKeys {
                label: vec![0.0, 5000.0].into(),
                begin: vec![0, 5000],
                end: vec![5000, 10000],
            }),
            vec![],
        );
        let k = n.at(-1).unwrap().key();
        assert_eq!(k, EventKey::interval(5000.0, 5000, 10000).unwrap());
        assert_eq!(k.label(), Some(&Label::Number(5000.0)));
        assert!(n.includes_key(k));
    }

    #[test]
    fn find_some_every_stop_early_and_pass_errors() {
        let s = times();
        let mut seen = 0;
        let hit = s
            .find(|r| {
                seen += 1;
                Ok(r.number("v")? == Some(2.0))
            })
            .unwrap();
        assert_eq!((hit.map(|r| r.index()), seen), (Some(1), 2));
        assert!(s.some(|r| Ok(r.begin() == 2500)).unwrap());
        assert!(!s.every(|r| Ok(r.begin() > 0)).unwrap());
        assert!(s.slice(0..0).every(|_| Ok(false)).unwrap());
        assert!(!s.slice(0..0).some(|_| Ok(true)).unwrap());
        assert!(s.find(|r| r.number("nope").map(|_| true)).is_err());
    }
}
