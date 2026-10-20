//! Picking rows by time span, and the span a series covers: `within`,
//! `contained_by`, `overlapping`, `trim`, `before` / `after`, and
//! `time_range` / `overlaps` / `contains` / `intersection`, as in pond-ts.
//!
//! Spans are inclusive at both ends, as in pond-ts: a row at 9000 is within
//! 2000..=9000, and a range ending at 2000 overlaps one starting at 2000. A
//! span is given as an [`EventKey`]; a point in time (a plain `i64`) is the
//! zero-length span at that time, and an interval's label is ignored.
//!
//! ```
//! # use pond_rs::{Column, EventKey, TimeSeries};
//! let s = TimeSeries::new("cpu", vec![0, 1000, 2500, 4000], vec![
//!     Column::required("v", vec![1.0, 2.0, 3.0, 4.0]),
//! ])?;
//! assert_eq!(s.within(1000, 2500)?.len(), 2);
//! assert_eq!(s.before(2500).len(), 2); // ends strictly before 2500
//! assert_eq!(s.after(2500).len(), 1); // starts strictly after 2500
//! let span = s.time_range().expect("not empty");
//! assert_eq!((span.begin(), span.end()), (0, 4000));
//! assert!(s.overlaps(EventKey::time_range(4000, 9000)?));
//! # Ok::<(), pond_rs::PondError>(())
//! ```

use crate::error::Result;
use crate::query::EventKey;
use crate::series::{IntervalKeys, Key, TimeRangeKeys, TimeSeries};

impl TimeSeries {
    /// The rows that lie wholly inside `begin..=end`, as pond-ts
    /// `within(begin, end)`: each row starts at or after `begin` and ends at
    /// or before `end`. An error when `begin > end`, as in pond-ts.
    pub fn within(&self, begin: i64, end: i64) -> Result<TimeSeries> {
        Ok(self.contained_by(EventKey::time_range(begin, end)?))
    }

    /// The rows that lie wholly inside `range`, as pond-ts `containedBy`
    /// (and `within(range)`).
    pub fn contained_by(&self, range: impl Into<EventKey>) -> TimeSeries {
        let r = range.into();
        self.keep_rows((r.begin(), r.end()), |b, e| b >= r.begin() && e <= r.end())
    }

    /// The rows that overlap `range` at all, as pond-ts `overlapping`.
    /// Their keys are kept as they are; see [`TimeSeries::trim`] to clip
    /// them.
    pub fn overlapping(&self, range: impl Into<EventKey>) -> TimeSeries {
        let r = range.into();
        self.keep_rows((r.begin(), r.end()), |b, e| b <= r.end() && r.begin() <= e)
    }

    /// The rows that overlap `range`, with time-range and interval keys
    /// clipped to it (an interval keeps its label), as pond-ts `trim`.
    /// Point-in-time keys are kept as they are. Clipping can bring two keys
    /// to the same start in the wrong end order; the rows are then
    /// re-sorted (stably) by start, then end.
    pub fn trim(&self, range: impl Into<EventKey>) -> TimeSeries {
        let r = range.into();
        let kept = self.overlapping(r.clone());
        let Some(ends) = kept.key().end() else {
            return kept; // point-in-time keys are not clipped
        };
        let begin: Vec<i64> = kept
            .key()
            .begin()
            .iter()
            .map(|&b| b.max(r.begin()))
            .collect();
        let end: Vec<i64> = ends.iter().map(|&e| e.min(r.end())).collect();
        let key = match kept.key() {
            Key::TimeRange(_) => Key::TimeRange(TimeRangeKeys { begin, end }),
            Key::Interval(k) => Key::Interval(IntervalKeys {
                label: k.label.clone(),
                begin,
                end,
            }),
            Key::Time(_) => unreachable!("handled above"),
        };
        let clipped = TimeSeries::from_parts(
            kept.name().to_string(),
            kept.key_name().to_string(),
            key,
            kept.columns().to_vec(),
        );
        let (b, e) = (clipped.key().begin(), clipped.key().end().expect("ranged"));
        if (1..b.len()).all(|i| (b[i - 1], e[i - 1]) <= (b[i], e[i])) {
            return clipped;
        }
        let mut order: Vec<usize> = (0..b.len()).collect();
        order.sort_by_key(|&i| (b[i], e[i])); // stable
        clipped.take_rows(&order)
    }

    /// The rows that end strictly before `boundary`'s start, as pond-ts
    /// `before`.
    pub fn before(&self, boundary: impl Into<EventKey>) -> TimeSeries {
        let limit = boundary.into().begin();
        self.keep_rows((i64::MIN, limit.saturating_sub(1)), |_, e| e < limit)
    }

    /// The rows that start strictly after `boundary`'s start, as pond-ts
    /// `after` (which also reads the boundary's start, not its end).
    pub fn after(&self, boundary: impl Into<EventKey>) -> TimeSeries {
        let limit = boundary.into().begin();
        self.keep_rows((limit.saturating_add(1), i64::MAX), |b, _| b > limit)
    }

    /// The span the series covers, as a time range: the first start to the
    /// latest end (a long early row can end after the last one), as pond-ts
    /// `timeRange`. `None` for an empty series.
    pub fn time_range(&self) -> Option<EventKey> {
        let begin = *self.key().begin().first()?;
        let end = match self.key().end() {
            Some(e) => *e.iter().max()?,
            None => *self.key().begin().last()?,
        };
        Some(EventKey::time_range(begin, end).expect("begin <= every end"))
    }

    /// Whether the series' span overlaps `other`, as pond-ts `overlaps`.
    /// `false` for an empty series. To test against another series, pass
    /// its [`time_range`](TimeSeries::time_range):
    /// `b.time_range().is_some_and(|r| a.overlaps(r))`, as pond-ts gives
    /// `false` when either is empty.
    pub fn overlaps(&self, other: impl Into<EventKey>) -> bool {
        let o = other.into();
        self.time_range()
            .is_some_and(|r| r.begin() <= o.end() && o.begin() <= r.end())
    }

    /// Whether the series' span wholly contains `other`, as pond-ts
    /// `contains`. `false` for an empty series.
    pub fn contains(&self, other: impl Into<EventKey>) -> bool {
        let o = other.into();
        self.time_range()
            .is_some_and(|r| o.begin() >= r.begin() && o.end() <= r.end())
    }

    /// The part of the series' span that `other` covers, as a time range, as
    /// pond-ts `intersection`. `None` when they do not overlap or the series
    /// is empty.
    pub fn intersection(&self, other: impl Into<EventKey>) -> Option<EventKey> {
        let o = other.into();
        let r = self.time_range()?;
        if !(r.begin() <= o.end() && o.begin() <= r.end()) {
            return None;
        }
        EventKey::time_range(r.begin().max(o.begin()), r.end().min(o.end())).ok()
    }

    /// The rows whose `(begin, end)` pass `keep`, in order. For points in
    /// time, `keep` must be the same test as "the time is in `times`"
    /// (inclusive), which is then found by binary search: O(log N), sharing
    /// memory. Other keys are walked once.
    fn keep_rows(&self, times: (i64, i64), keep: impl Fn(i64, i64) -> bool) -> TimeSeries {
        let begin = self.key().begin();
        let Some(end) = self.key().end() else {
            let (lo, hi) = times;
            let start = begin.partition_point(|&t| t < lo);
            let stop = begin.partition_point(|&t| t <= hi).max(start);
            debug_assert!(begin[start..stop].iter().all(|&t| keep(t, t)));
            return self.row_range(start..stop);
        };
        let rows: Vec<usize> = (0..begin.len())
            .filter(|&i| keep(begin[i], end[i]))
            .collect();
        if rows.len() == self.len() {
            return self.clone();
        }
        // A run of rows (the usual case for time keys) shares memory.
        if let (Some(&first), Some(&last)) = (rows.first(), rows.last())
            && last - first + 1 == rows.len()
        {
            return self.row_range(first..last + 1);
        }
        self.take_rows(&rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Column;

    fn ranges() -> TimeSeries {
        TimeSeries::from_parts(
            "r".into(),
            "timeRange".into(),
            Key::TimeRange(TimeRangeKeys {
                begin: vec![0, 2, 4],
                end: vec![10, 5, 6],
            }),
            vec![Column::required("v", vec![1.0, 2.0, 3.0])],
        )
    }

    #[test]
    fn trim_reorders_keys_clipping_brought_together() {
        let t = ranges().trim(EventKey::time_range(3, 20).unwrap());
        assert_eq!(t.key().begin(), &[3, 3, 4]);
        assert_eq!(t.key().end().unwrap(), &[5, 10, 6]);
        assert_eq!(t.column("v").unwrap().numbers().unwrap().get(0), Some(2.0));
    }

    #[test]
    fn spans_are_inclusive() {
        let s = TimeSeries::new(
            "t",
            vec![0, 1000, 2000],
            vec![Column::required("v", vec![1.0, 2.0, 3.0])],
        )
        .unwrap();
        assert_eq!(s.within(1000, 2000).unwrap().len(), 2);
        assert_eq!(s.overlapping(2000).len(), 1);
        assert!(s.within(2, 1).is_err());
        assert!(s.overlaps(EventKey::time_range(2000, 3000).unwrap()));
        assert!(!s.overlaps(EventKey::time_range(2001, 3000).unwrap()));
        assert!(s.contains(EventKey::time_range(0, 2000).unwrap()));
        let none = s.slice(0..0);
        assert!(none.time_range().is_none() && !none.overlaps(0) && !none.contains(0));
        assert!(none.intersection(0).is_none());
    }

    #[test]
    fn time_range_takes_the_latest_end() {
        let r = ranges().time_range().unwrap();
        assert_eq!((r.begin(), r.end(), r.kind()), (0, 10, "timeRange"));
    }
}
