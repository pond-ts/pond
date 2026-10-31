//! Column reshaping and key changes: `select`, `rename`, `as_time`,
//! `as_time_range`, `as_interval` / `as_interval_with` and `offset_time`.
//! None of these copy value columns: the columns keep sharing their buffers
//! with the source series.

use crate::column::StringColumn;
use crate::error::{PondError, Result};
use crate::query::{EventKey, Label};
use crate::series::{IntervalKeys, Key, Labels, MAX_TIME_MS, TimeRangeKeys, TimeSeries};

/// Where [`TimeSeries::as_time`] places each row's new time within its
/// interval (pond-ts `asTime({ at })`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum At {
    /// The interval's start (pond-ts default).
    #[default]
    Begin,
    /// Halfway between start and end.
    Center,
    /// The interval's end.
    End,
}

impl TimeSeries {
    /// Keep the key and only the named value columns, in schema order (not
    /// argument order); a name given twice selects the column once
    /// (pond-ts `select(...names)`). An unknown name is an error. Selecting no
    /// names leaves only the key.
    ///
    /// ```
    /// # use pond_rs::{Column, TimeSeries};
    /// let s = TimeSeries::new("s", vec![0, 1000], vec![
    ///     Column::required("a", vec![1.0, 2.0]),
    ///     Column::required("b", vec![3.0, 4.0]),
    /// ])?;
    /// let only_b = s.select(&["b"])?;
    /// assert_eq!(only_b.columns().len(), 1);
    /// assert_eq!(only_b.columns()[0].name(), "b");
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn select(&self, names: &[&str]) -> Result<TimeSeries> {
        for name in names {
            self.column_index("select", name)?;
        }
        let columns = self
            .columns()
            .iter()
            .filter(|c| names.contains(&c.name()))
            .cloned()
            .collect();
        Ok(TimeSeries::from_parts(
            self.name().to_string(),
            self.key_name().to_string(),
            self.shared_key(),
            columns,
        ))
    }

    /// Rename value columns, each `(from, to)` pair at once, so two columns
    /// can swap names (pond-ts `rename({ from: to })`). Errors, as in
    /// pond-ts:
    ///
    /// - The key cannot be renamed.
    /// - Every `from` must be a value column.
    /// - No two columns may end up with the same name.
    /// - No column may take the key's name.
    ///
    /// Also an error, which pond-ts cannot express: the same `from` given
    /// twice.
    ///
    /// ```
    /// # use pond_rs::{Column, TimeSeries};
    /// let s = TimeSeries::new("s", vec![0], vec![Column::required("cpu", vec![0.5])])?;
    /// let renamed = s.rename(&[("cpu", "usage")])?;
    /// assert!(renamed.column("usage").is_ok());
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn rename(&self, renames: &[(&str, &str)]) -> Result<TimeSeries> {
        const CALL: &str = "rename";
        let invalid = |message: String| PondError::InvalidData {
            call: CALL,
            message,
        };
        let key_name = self.key_name();
        for (i, (from, _)) in renames.iter().enumerate() {
            if *from == key_name {
                return Err(invalid(format!(
                    "cannot rename the key column '{key_name}'"
                )));
            }
            if renames[..i].iter().any(|(earlier, _)| earlier == from) {
                return Err(invalid(format!("column '{from}' is renamed twice")));
            }
            self.column_index(CALL, from)?;
        }
        let new_name = |name: &str| -> String {
            renames
                .iter()
                .find(|(from, _)| *from == name)
                .map_or(name, |(_, to)| *to)
                .to_string()
        };
        let mut taken = vec![key_name.to_string()];
        let mut columns = Vec::with_capacity(self.columns().len());
        for column in self.columns() {
            let name = new_name(column.name());
            if taken.contains(&name) {
                return Err(invalid(format!(
                    "new name '{name}' is already taken by another column or the key"
                )));
            }
            taken.push(name.clone());
            let mut column = column.clone();
            column.name = name;
            columns.push(column);
        }
        Ok(TimeSeries::from_parts(
            self.name().to_string(),
            key_name.to_string(),
            self.shared_key(),
            columns,
        ))
    }

    /// Turn each row's key into a single time, named `"time"` (pond-ts
    /// `asTime({ at })`). A time-keyed series is returned with its key
    /// renamed to `"time"` and otherwise unchanged. A value column already
    /// named `"time"` is an error, as in pond-ts. For interval keys,
    /// [`At::Begin`] keeps rows in order. [`At::End`] or [`At::Center`] can
    /// reorder rows when intervals overlap; that is an error, as in pond-ts.
    ///
    /// pond-rs keeps times in whole milliseconds. An interval with an odd
    /// length in milliseconds has a centre on a half millisecond, where
    /// pond-ts would give e.g. `2499.5`. pond-rs returns an error there
    /// rather than a different answer.
    ///
    /// ```
    /// # use pond_rs::{Agg, At, Column, Reducer, Sequence, TimeSeries};
    /// let s = TimeSeries::new("s", vec![0, 30_000, 60_000], vec![
    ///     Column::required("v", vec![1.0, 2.0, 3.0]),
    /// ])?;
    /// let per_minute = s.aggregate(&Sequence::every("1m")?, &[Agg::of("v", Reducer::Sum)])?;
    /// let at_start = per_minute.as_time(At::Begin)?;
    /// assert_eq!(at_start.key_name(), "time");
    /// assert_eq!(at_start.key().begin(), &[0, 60_000]);
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn as_time(&self, at: At) -> Result<TimeSeries> {
        const CALL: &str = "as_time";
        if self.columns().iter().any(|c| c.name() == "time") {
            return Err(PondError::InvalidData {
                call: CALL,
                message: "a value column is already named 'time', the name the new key takes; rename it first".into(),
            });
        }
        let begin = self.key().begin();
        let time = match (self.key().end(), at) {
            // A time key is its own begin; `at` does not move it.
            (None, _) | (Some(_), At::Begin) => begin.to_vec(),
            (Some(end), At::End) => end.to_vec(),
            (Some(end), At::Center) => {
                let mut out = Vec::with_capacity(begin.len());
                for (i, (b, e)) in begin.iter().zip(end).enumerate() {
                    // Both are within ±MAX_TIME_MS (well inside i64), so
                    // the sum cannot overflow.
                    let sum = b + e;
                    if sum % 2 != 0 {
                        return Err(PondError::Unsupported {
                            call: CALL,
                            message: format!(
                                "the centre of row {i} ({b} to {e} ms) is half a millisecond; pond-rs keeps whole milliseconds. Use At::Begin or At::End"
                            ),
                        });
                    }
                    out.push(sum / 2);
                }
                out
            }
        };
        if at != At::Begin
            && let Some(i) = time.windows(2).position(|w| w[1] < w[0])
        {
            let name = if at == At::End { "End" } else { "Center" };
            return Err(PondError::InvalidData {
                call: CALL,
                message: format!(
                    "At::{name} puts row {} ({} ms) before row {i} ({} ms): the intervals overlap, so the rows would be out of order. Use At::Begin",
                    i + 1,
                    time[i + 1],
                    time[i]
                ),
            });
        }
        Ok(TimeSeries::from_parts(
            self.name().to_string(),
            "time".to_string(),
            Key::Time(time),
            self.columns().to_vec(),
        ))
    }
}

impl TimeSeries {
    /// Make each row's key a time range covering its current extent (a
    /// point in time `t` becomes `t..=t`; an interval drops its label),
    /// named `"timeRange"`, as pond-ts `asTimeRange()`. A value column
    /// already named `"timeRange"` is an error, as in pond-ts.
    pub fn as_time_range(&self) -> Result<TimeSeries> {
        self.check_free_key_name("as_time_range", "timeRange")?;
        let begin = self.key().begin().to_vec();
        let end = self
            .key()
            .end()
            .map_or_else(|| begin.clone(), <[i64]>::to_vec);
        Ok(TimeSeries::from_parts(
            self.name().to_string(),
            "timeRange".to_string(),
            Key::TimeRange(TimeRangeKeys { begin, end }),
            self.columns().to_vec(),
        ))
    }

    /// Make each row's key an interval over its current extent, every row
    /// labelled `label`, named `"interval"`, as pond-ts `asInterval(value)`.
    /// A value column already named `"interval"` is an error, as in pond-ts,
    /// and so is a number label that is `NaN` or infinite, as in pond-ts.
    ///
    /// ```
    /// # use pond_rs::{Column, Label, TimeSeries};
    /// let s = TimeSeries::new("s", vec![0, 1000], vec![
    ///     Column::required("v", vec![1.0, 2.0]),
    /// ])?;
    /// let i = s.as_interval("day")?;
    /// assert_eq!(i.key_name(), "interval");
    /// let by_start = s.as_interval_with(|range, _| range.begin())?;
    /// assert_eq!(by_start.at(1).unwrap().key().label(), Some(&Label::Number(1000.0)));
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn as_interval(&self, label: impl Into<Label>) -> Result<TimeSeries> {
        let label = label.into();
        self.make_intervals("as_interval", |_, _| label.clone())
    }

    /// Make each row's key an interval over its current extent, labelled by
    /// `label(range, row)`, as pond-ts `asInterval((range, index) => …)`.
    /// `range` is the row's extent as a time range. Every label must be of
    /// one kind (all numbers or all text) and numbers finite, as in pond-ts.
    pub fn as_interval_with<F, L>(&self, mut label: F) -> Result<TimeSeries>
    where
        F: FnMut(EventKey, usize) -> L,
        L: Into<Label>,
    {
        self.make_intervals("as_interval_with", |range, i| label(range, i).into())
    }

    fn make_intervals(
        &self,
        call: &'static str,
        mut label: impl FnMut(EventKey, usize) -> Label,
    ) -> Result<TimeSeries> {
        self.check_free_key_name(call, "interval")?;
        let begin = self.key().begin().to_vec();
        let end = self
            .key()
            .end()
            .map_or_else(|| begin.clone(), <[i64]>::to_vec);
        let mut numbers = Vec::new();
        let mut texts = Vec::new();
        for i in 0..begin.len() {
            let range =
                EventKey::time_range(begin[i], end[i]).expect("a key starts before it ends");
            let kind_error = |was: &str, now: &str| PondError::InvalidData {
                call,
                message: format!(
                    "the label at row {i} is {now} but earlier rows were {was}; interval labels must be one kind throughout"
                ),
            };
            match label(range, i) {
                Label::Number(v) if !texts.is_empty() => {
                    return Err(kind_error("text", &format!("the number {v}")));
                }
                Label::String(t) if !numbers.is_empty() => {
                    return Err(kind_error("numbers", &format!("the text {t:?}")));
                }
                Label::Number(v) if !v.is_finite() => {
                    return Err(PondError::InvalidData {
                        call,
                        message: format!(
                            "the label at row {i} is {v}; number labels must be finite"
                        ),
                    });
                }
                Label::Number(v) => numbers.push(v),
                Label::String(t) => texts.push(t),
            }
        }
        // An empty series gets text labels, as in pond-ts.
        let label = if numbers.is_empty() {
            Labels::String(StringColumn::from_options(texts.into_iter().map(Some)))
        } else {
            Labels::Number(numbers)
        };
        Ok(TimeSeries::from_parts(
            self.name().to_string(),
            "interval".to_string(),
            Key::Interval(IntervalKeys { label, begin, end }),
            self.columns().to_vec(),
        ))
    }

    /// Move every key by `by` (`"1m"`, `"-1h"`; see
    /// [`parse_duration`](crate::parse_duration), with a leading `-` for
    /// earlier), as pond-ts `offsetTime`. Both edges of a range or interval
    /// move; labels, the key kind and every value column stay. A zero offset
    /// returns the series unchanged. A key moved past ±[`MAX_TIME_MS`] is an
    /// error (pond-ts allows it).
    pub fn offset_time(&self, by: &str) -> Result<TimeSeries> {
        let ms = match by.strip_prefix('-') {
            Some(rest) => -crate::parse_duration(rest)?,
            None => crate::parse_duration(by)?,
        };
        self.offset_time_ms(ms)
    }

    /// [`offset_time`](TimeSeries::offset_time) by a number of milliseconds.
    pub fn offset_time_ms(&self, ms: i64) -> Result<TimeSeries> {
        if ms == 0 {
            return Ok(self.clone());
        }
        let shift = |v: &[i64]| -> Result<Vec<i64>> {
            v.iter()
                .map(|&t| {
                    t.checked_add(ms)
                        .filter(|m| (-MAX_TIME_MS..=MAX_TIME_MS).contains(m))
                        .ok_or_else(|| PondError::InvalidData {
                            call: "offset_time",
                            message: format!(
                                "moving {t} ms by {ms} ms leaves the supported range (±{MAX_TIME_MS} ms)"
                            ),
                        })
                })
                .collect()
        };
        let key = match self.key() {
            Key::Time(t) => Key::Time(shift(t)?),
            Key::TimeRange(k) => Key::TimeRange(TimeRangeKeys {
                begin: shift(&k.begin)?,
                end: shift(&k.end)?,
            }),
            Key::Interval(k) => Key::Interval(IntervalKeys {
                label: k.label.clone(),
                begin: shift(&k.begin)?,
                end: shift(&k.end)?,
            }),
        };
        Ok(TimeSeries::from_parts(
            self.name().to_string(),
            self.key_name().to_string(),
            key,
            self.columns().to_vec(),
        ))
    }

    fn check_free_key_name(&self, call: &'static str, key: &str) -> Result<()> {
        if self.columns().iter().any(|c| c.name() == key) {
            return Err(PondError::InvalidData {
                call,
                message: format!(
                    "a value column is already named '{key}', the name the new key takes; rename it first"
                ),
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Column, IntervalKeys};

    fn buckets(begin: Vec<i64>, end: Vec<i64>) -> TimeSeries {
        let n = begin.len();
        TimeSeries::from_intervals(
            "b",
            IntervalKeys {
                label: begin.clone().into(),
                begin,
                end,
            },
            vec![Column::required("v", vec![1.0; n])],
        )
        .unwrap()
    }

    #[test]
    fn odd_length_centre_is_refused_not_rounded() {
        let s = buckets(vec![0, 2000], vec![1000, 2999]);
        let err = s.as_time(At::Center).unwrap_err().to_string();
        assert!(err.contains("row 1"), "{err}");
        assert!(err.contains("half a millisecond"), "{err}");
        // Even lengths are fine.
        let s = buckets(vec![0, 2000], vec![1000, 3000]);
        assert_eq!(s.as_time(At::Center).unwrap().key().begin(), &[500, 2500]);
    }

    #[test]
    fn select_and_rename_share_buffers() {
        let s = TimeSeries::new(
            "s",
            vec![0, 1],
            vec![
                Column::required("a", vec![1.0, 2.0]),
                Column::required("b", vec![3.0, 4.0]),
            ],
        )
        .unwrap();
        let picked = s.select(&["b"]).unwrap();
        let renamed = s.rename(&[("a", "x")]).unwrap();
        let ptr = |s: &TimeSeries, i: usize| s.columns()[i].numbers().unwrap().values().as_ptr();
        assert_eq!(ptr(&picked, 0), ptr(&s, 1));
        assert_eq!(ptr(&renamed, 0), ptr(&s, 0));
    }

    #[test]
    fn as_time_names_a_time_key_time() {
        // A key read from Arrow keeps its field name; pond-ts renames it to
        // `time` here too.
        let s = TimeSeries::with_key(
            "test",
            "s".into(),
            "ts".into(),
            Key::Time(vec![0, 1000]),
            vec![Column::required("v", vec![1.0, 2.0])],
        )
        .unwrap();
        let t = s.as_time(At::End).unwrap();
        assert_eq!(t.key_name(), "time");
        assert_eq!(t.key().begin(), &[0, 1000]);
    }

    /// The parity fixture only checks that pond-ts and pond-rs both fail on
    /// its error cases (the messages differ), so pin each error's reason here.
    #[test]
    fn each_error_says_why() {
        let s = TimeSeries::new(
            "s",
            vec![0],
            vec![
                Column::required("a", vec![1.0]),
                Column::required("b", vec![2.0]),
            ],
        )
        .unwrap();
        let err = |r: Result<TimeSeries>| r.unwrap_err().to_string();
        assert!(err(s.select(&["zz"])).contains("no column named 'zz'"));
        assert!(err(s.rename(&[("time", "t")])).contains("cannot rename the key"));
        assert!(err(s.rename(&[("a", "b")])).contains("'b' is already taken"));
        assert!(err(s.rename(&[("a", "time")])).contains("'time' is already taken"));
        assert!(err(s.rename(&[("zz", "q")])).contains("no column named 'zz'"));
        let overlap = TimeSeries::from_intervals(
            "o",
            IntervalKeys {
                label: vec![0i64, 1000].into(),
                begin: vec![0, 1000],
                end: vec![5000, 2000],
            },
            vec![Column::required("v", vec![1.0, 2.0])],
        )
        .unwrap();
        assert!(err(overlap.as_time(At::End)).contains("intervals overlap"));
        assert!(err(overlap.as_time(At::Center)).contains("intervals overlap"));
        let clash = TimeSeries::from_intervals(
            "c",
            IntervalKeys {
                label: vec![0i64].into(),
                begin: vec![0],
                end: vec![1000],
            },
            vec![Column::required("time", vec![1.0])],
        )
        .unwrap();
        assert!(err(clash.as_time(At::Begin)).contains("already named 'time'"));
    }

    #[test]
    fn rename_rejects_a_source_given_twice() {
        let s = TimeSeries::new("s", vec![0], vec![Column::required("a", vec![1.0])]).unwrap();
        let err = s.rename(&[("a", "x"), ("a", "y")]).unwrap_err().to_string();
        assert!(err.contains("renamed twice"), "{err}");
    }

    #[test]
    fn key_changes_keep_extents_and_refuse_clashes() {
        let s = TimeSeries::new(
            "s",
            vec![0, 1000],
            vec![Column::required("v", vec![1.0, 2.0])],
        )
        .unwrap();
        let r = s.as_time_range().unwrap();
        assert_eq!(
            (r.key_name(), r.key().end().unwrap()),
            ("timeRange", &[0, 1000][..])
        );
        let i = s
            .as_interval_with(|_, i| if i == 0 { "a" } else { "b" })
            .unwrap();
        assert_eq!(
            i.at(1).unwrap().key(),
            EventKey::interval("b", 1000, 1000).unwrap()
        );
        assert!(
            s.as_interval_with(|_, i| if i == 0 { Label::from(1.0) } else { "b".into() })
                .is_err()
        );
        assert!(s.as_interval(f64::NAN).is_err());
        assert!(s.as_interval(f64::INFINITY).is_err());
        assert!(s.as_interval(f64::NEG_INFINITY).is_err());
        let clash = s.rename(&[("v", "interval")]).unwrap();
        assert!(clash.as_interval("x").is_err());
        let empty = s.slice(0..0).as_interval(5.0).unwrap();
        assert!(matches!(&empty.key(), Key::Interval(k) if k.label.strings().is_some()));
    }

    #[test]
    fn offset_time_moves_both_edges_and_checks_the_range() {
        let b = buckets(vec![0, 1000], vec![1000, 2000]);
        let moved = b.offset_time("-1s").unwrap();
        assert_eq!(moved.key().begin(), &[-1000, 0]);
        assert_eq!(moved.key().end().unwrap(), &[0, 1000]);
        assert_eq!(b.offset_time("-0s").unwrap().key().begin(), &[0, 1000]);
        assert!(b.offset_time("--1s").is_err());
        assert!(b.offset_time("1.5s").is_err());
        assert!(b.offset_time_ms(MAX_TIME_MS).is_err());
        assert!(b.offset_time_ms(i64::MIN).is_err());
    }
}
