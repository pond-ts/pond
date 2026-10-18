//! Column reshaping: `select`, `rename`, and `as_time` (interval keys to
//! time keys). None of these copy value columns: the columns keep sharing
//! their buffers with the source series.

use crate::error::{PondError, Result};
use crate::series::{Key, TimeSeries};

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
            self.key().clone(),
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
    /// assert!(renamed.column("usage").is_some());
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
            self.key().clone(),
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
        let time = match self.key() {
            Key::Time(t) => t.clone(),
            Key::Interval(k) => match at {
                At::Begin => k.begin.clone(),
                At::End => k.end.clone(),
                At::Center => {
                    let mut out = Vec::with_capacity(k.begin.len());
                    for (i, (b, e)) in k.begin.iter().zip(&k.end).enumerate() {
                        // Both are within ±MAX_TIME_MS (well inside i64), so
                        // the sum cannot overflow.
                        let sum = b + e;
                        if sum % 2 != 0 {
                            return Err(PondError::Unsupported {
                                call: CALL,
                                message: format!(
                                    "the centre of row {i} ([{b}, {e}) ms) is half a millisecond; pond-rs keeps whole milliseconds. Use At::Begin or At::End"
                                ),
                            });
                        }
                        out.push(sum / 2);
                    }
                    out
                }
            },
        };
        if at != At::Begin {
            if let Some(i) = time.windows(2).position(|w| w[1] < w[0]) {
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
        }
        Ok(TimeSeries::from_parts(
            self.name().to_string(),
            "time".to_string(),
            Key::Time(time),
            self.columns().to_vec(),
        ))
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
                label: begin.clone(),
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
        let ptr = |s: &TimeSeries, i: usize| s.columns()[i].data().values().as_ptr();
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
                label: vec![0, 1000],
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
                label: vec![0],
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
}
