//! Grid operations: `align` and `materialize` put a series onto a
//! sequence's grid, and `dedupe` collapses rows that share a key.

use std::collections::HashMap;

use crate::column::ColumnData;
use crate::error::{PondError, Result};
use crate::reshape::At;
use crate::sequence::Sequence;
use crate::series::{Column, ColumnKind, IntervalKeys, Key, Labels, TimeSeries};

/// How [`TimeSeries::align`] fills each grid point.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AlignMethod {
    /// The latest row at or before the point (pond-ts default).
    #[default]
    Hold,
    /// Number columns are interpolated in a straight line between the rows
    /// either side of the point; every other column holds. Time-keyed
    /// series only.
    Linear,
}

/// Options for [`TimeSeries::align`]. `Align::default()` is pond-ts's
/// default: hold, sample each bucket at its start, over the series' own
/// time range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Align {
    pub method: AlignMethod,
    /// Which point of each bucket is sampled: its start, middle or end.
    pub sample: At,
    /// The closed range `[begin, end]` (epoch ms) whose buckets are used: a
    /// bucket is used when its sample point falls in it. `None`: the
    /// series' own range, from its first row's start to its latest end.
    pub range: Option<(i64, i64)>,
}

/// Which row [`TimeSeries::materialize`] takes from a bucket with several.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Pick {
    /// The first row in the bucket.
    First,
    /// The last row in the bucket (pond-ts default).
    #[default]
    Last,
    /// The row whose start is nearest the bucket's sample point; on a tie,
    /// the earlier row.
    Nearest,
}

/// Options for [`TimeSeries::materialize`]. `Materialize::default()` is
/// pond-ts's default: the last row of each bucket, the bucket's start as the
/// row's time, over the series' own time range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Materialize {
    pub pick: Pick,
    /// The row's time: each bucket's start, middle or end.
    pub sample: At,
    /// As [`Align::range`].
    pub range: Option<(i64, i64)>,
}

/// What [`TimeSeries::dedupe`] does with rows that share a key.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Keep {
    /// Keep the first of them.
    First,
    /// Keep the last of them (pond-ts default).
    #[default]
    Last,
    /// Return an error at the first key with more than one row.
    Error,
    /// Keep none of them.
    Drop,
    /// Keep the row with the smallest value in this number or decimal
    /// column. A gap loses to any value; on a tie, the earlier row.
    Min(String),
    /// As [`Keep::Min`], with the largest value.
    Max(String),
}

/// What one grid point takes from the source.
#[derive(Clone, Copy)]
enum Take {
    Nothing,
    Row(usize),
    /// Between two rows, `ratio` of the way from the first.
    Between(usize, usize, f64),
}

impl Take {
    /// The row a non-interpolated column reads.
    fn row(self) -> Option<usize> {
        match self {
            Take::Nothing => None,
            Take::Row(i) | Take::Between(i, _, _) => Some(i),
        }
    }
}

impl TimeSeries {
    /// One row per bucket of `sequence`, keyed by the bucket (an interval
    /// labelled by its start, named `"interval"`), holding each column's
    /// value at the bucket's sample point (pond-ts `align`). Every value
    /// column comes out optional, since a point before the first row has no
    /// value.
    ///
    /// ```
    /// use pond_rs::{Align, AlignMethod, Column, Sequence, TimeSeries};
    /// let s = TimeSeries::new("s", vec![0, 2_000], vec![Column::required("v", vec![1.0, 3.0])])?;
    /// let every_second = Sequence::every("1s")?;
    /// let held = s.align(&every_second, Align::default())?;
    /// assert_eq!(held.column("v")?.numbers()?.get(1), Some(1.0));
    /// let linear = s.align(&every_second, Align { method: AlignMethod::Linear, ..Align::default() })?;
    /// assert_eq!(linear.column("v")?.numbers()?.get(1), Some(2.0));
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    ///
    /// **Which buckets.** Those whose sample point ([`Align::sample`]) falls
    /// in [`Align::range`], by default the series' own range. Unlike
    /// [`TimeSeries::aggregate`], a bucket that starts before the range is
    /// not included at the default `At::Begin`.
    ///
    /// **Hold** takes the latest row at or before the sample point. With
    /// several rows at exactly that time, the first of them; several rows at
    /// an earlier time, the last of them (pond-ts's `atOrBefore`). For a
    /// series keyed by time ranges or intervals, a row counts when it
    /// starts strictly before the point (or is a zero-length interval at
    /// it, which pond-ts sorts before a time).
    ///
    /// **Linear** interpolates number columns between the last row before
    /// the point and the first row at or after it, as pond-ts does; a gap in
    /// either row holds the earlier row's value (or gap). A point with a row
    /// exactly at it takes that row. Before the first row there is no
    /// value; after the last, the last row holds. Decimal columns hold
    /// rather than interpolate, since a point between two decimals is not
    /// exact (pond-ts has no decimals). Only time-keyed series, as in
    /// pond-ts.
    ///
    /// An empty series gives an empty result. A value column named
    /// `"interval"` is an error, as in pond-ts. Across entities, align each
    /// with [`TimeSeries::partition_by`] first.
    pub fn align(&self, sequence: &Sequence, options: Align) -> Result<TimeSeries> {
        const CALL: &str = "align";
        self.check_new_key_name(CALL, "interval")?;
        let Some((begin, end)) = self.grid_range(CALL, options.range)? else {
            return Ok(self.empty_grid("interval", Key::Interval(no_buckets())));
        };
        if options.method == AlignMethod::Linear && !matches!(self.key(), Key::Time(_)) {
            return Err(PondError::Unsupported {
                call: CALL,
                message: "linear alignment needs a time-keyed series (pond-ts has the same limit); use AlignMethod::Hold".into(),
            });
        }
        let buckets = sequence.buckets_sampled(begin, end, options.sample)?;
        let points = sample_points(&buckets, options.sample);
        // Hold reads one row per point. Linear also needs the rows either
        // side; the plain rows are then only built if a column holds.
        let (takes, rows) = match options.method {
            AlignMethod::Hold => (Vec::new(), self.hold_rows(points)),
            AlignMethod::Linear => {
                let takes = self.linear_takes(points);
                let holds = self
                    .columns()
                    .iter()
                    .any(|c| !matches!(c.data(), ColumnData::Number(_)));
                let rows = if holds {
                    takes.iter().map(|t| t.row()).collect()
                } else {
                    Vec::new()
                };
                (takes, rows)
            }
        };
        let columns = self
            .columns()
            .iter()
            .map(|c| {
                let data = match c.data() {
                    ColumnData::Number(n) if options.method == AlignMethod::Linear => {
                        let v = n.values();
                        let present = |i: usize| n.get(i);
                        ColumnData::from(
                            takes
                                .iter()
                                .map(|t| match *t {
                                    Take::Nothing => f64::NAN,
                                    Take::Row(i) => v[i],
                                    Take::Between(p, q, ratio) => match (present(p), present(q)) {
                                        (Some(a), Some(b)) => a + (b - a) * ratio,
                                        _ => v[p],
                                    },
                                })
                                .collect::<Vec<f64>>(),
                        )
                    }
                    data => data.take(&rows),
                };
                Column::from_data(c.name().to_string(), data, false)
            })
            .collect();
        Ok(TimeSeries::from_parts(
            self.name().to_string(),
            "interval".to_string(),
            Key::Interval(buckets),
            columns,
        ))
    }

    /// One time-keyed row per bucket of `sequence`, taking one source row
    /// from the bucket, or gaps when the bucket has none (pond-ts
    /// `materialize`). The time is the bucket's sample point
    /// ([`Materialize::sample`]); the key is named `"time"`. A row belongs
    /// to the bucket holding its start: `begin <= start < end`. Every value
    /// column comes out optional. Unlike [`TimeSeries::align`] nothing is
    /// carried into an empty bucket; follow with
    /// [`TimeSeries::fill`] for that.
    ///
    /// ```
    /// use pond_rs::{Column, Materialize, Sequence, TimeSeries};
    /// let s = TimeSeries::new("s", vec![0, 400, 2_100], vec![Column::required("v", vec![1.0, 2.0, 3.0])])?;
    /// let grid = s.materialize(&Sequence::every("1s")?, Materialize::default())?;
    /// assert_eq!(grid.key().begin(), &[0, 1_000, 2_000]);
    /// assert_eq!(grid.column("v")?.numbers()?.get(0), Some(2.0)); // the last row in [0, 1000)
    /// assert_eq!(grid.column("v")?.numbers()?.get(1), None); // empty bucket
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    ///
    /// Buckets are chosen as in [`TimeSeries::align`]. pond-rs keeps whole
    /// milliseconds: with `At::Center` on buckets an odd number of
    /// milliseconds long, the time is on a half millisecond, which is an
    /// error here (pond-ts gives e.g. `1.5`). A value column named `"time"`
    /// is an error, as in pond-ts. With [`TimeSeries::partition_by`], the
    /// partition columns are filled in on empty buckets too.
    pub fn materialize(&self, sequence: &Sequence, options: Materialize) -> Result<TimeSeries> {
        const CALL: &str = "materialize";
        self.check_new_key_name(CALL, "time")?;
        let Some((begin, end)) = self.grid_range(CALL, options.range)? else {
            return Ok(self.empty_grid("time", Key::Time(vec![])));
        };
        let buckets = sequence.buckets_sampled(begin, end, options.sample)?;
        let mut time = Vec::with_capacity(buckets.begin.len());
        for (i, p2) in sample_points(&buckets, options.sample).enumerate() {
            if p2 % 2 != 0 {
                return Err(PondError::Unsupported {
                    call: CALL,
                    message: format!(
                        "the middle of bucket {i} ({} to {} ms) is half a millisecond; pond-rs keeps whole milliseconds. Use At::Begin or At::End, or a step of an even number of milliseconds",
                        buckets.begin[i], buckets.end[i]
                    ),
                });
            }
            time.push(i64::try_from(p2 / 2).map_err(|_| PondError::InvalidData {
                call: CALL,
                message: format!("bucket {i}'s time is out of range"),
            })?);
        }
        let starts = self.key().begin();
        let n = starts.len();
        let mut cursor = 0;
        let mut rows = Vec::with_capacity(time.len());
        for (i, p2) in sample_points(&buckets, options.sample).enumerate() {
            let (b, e) = (buckets.begin[i], buckets.end[i]);
            while cursor < n && starts[cursor] < b {
                cursor += 1;
            }
            let mut pick = None;
            match options.pick {
                Pick::First => {
                    if cursor < n && starts[cursor] < e {
                        pick = Some(cursor);
                    }
                }
                Pick::Last => {
                    let mut s = cursor;
                    while s < n && starts[s] < e {
                        pick = Some(s);
                        s += 1;
                    }
                }
                Pick::Nearest => {
                    let mut best = u128::MAX;
                    let mut s = cursor;
                    while s < n && starts[s] < e {
                        let d = (2 * i128::from(starts[s]) - p2).unsigned_abs();
                        if d < best {
                            pick = Some(s);
                            best = d;
                        }
                        s += 1;
                    }
                }
            }
            rows.push(pick);
        }
        let columns = self
            .columns()
            .iter()
            .map(|c| Column::from_data(c.name().to_string(), c.data().take(&rows), false))
            .collect();
        Ok(TimeSeries::from_parts(
            self.name().to_string(),
            "time".to_string(),
            Key::Time(time),
            columns,
        ))
    }

    /// Collapse rows that share a key (pond-ts `dedupe`). The key is the
    /// whole key: the time; a time range's start and end; an interval's
    /// start, end and label. [`Keep`] picks which row survives. The result
    /// keeps the rows' order and the schema.
    ///
    /// ```
    /// use pond_rs::{Column, Keep, TimeSeries};
    /// let s = TimeSeries::new("s", vec![0, 0, 1_000], vec![Column::required("v", vec![1.0, 2.0, 3.0])])?;
    /// let last = s.dedupe(Keep::Last)?;
    /// assert_eq!(last.column("v")?.numbers()?.values(), &[2.0, 3.0]);
    /// assert!(s.dedupe(Keep::Error).is_err());
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    ///
    /// For [`Keep::Min`] / [`Keep::Max`] the column must be a number or
    /// decimal column. pond-rs checks that up front; pond-ts looks at the
    /// column only when it meets a duplicate, and silently keeps the first
    /// row for a column it does not have. pond-ts also takes a closure that
    /// builds the surviving row; pond-rs does not have that yet. Across
    /// entities, dedupe each with [`TimeSeries::partition_by`] first.
    pub fn dedupe(&self, keep: Keep) -> Result<TimeSeries> {
        const CALL: &str = "dedupe";
        let by = match &keep {
            Keep::Min(c) | Keep::Max(c) => {
                let column = self.column_index(CALL, c)?;
                let kind = self.columns()[column].kind();
                if !matches!(kind, ColumnKind::Number | ColumnKind::Decimal) {
                    return Err(PondError::WrongKind {
                        call: CALL,
                        column: c.clone(),
                        kind: kind.as_str(),
                        reason: "Keep::Min and Keep::Max need a number or decimal column".into(),
                    });
                }
                Some(&self.columns()[column])
            }
            _ => None,
        };
        let mut kept = Vec::with_capacity(self.len());
        let mut repeated = false;
        let mut resolve = |group: &[usize]| -> Result<()> {
            if group.len() == 1 {
                kept.push(group[0]);
                return Ok(());
            }
            repeated = true;
            match &keep {
                Keep::First => kept.push(group[0]),
                Keep::Last => kept.push(group[group.len() - 1]),
                Keep::Drop => {}
                Keep::Error => {
                    return Err(PondError::InvalidData {
                        call: CALL,
                        message: format!(
                            "{} events at {}. Specify a different 'keep' policy or fix upstream.",
                            group.len(),
                            self.describe_key(group[0])
                        ),
                    });
                }
                Keep::Min(_) | Keep::Max(_) => {
                    let wants_min = matches!(keep, Keep::Min(_));
                    let column = by.expect("checked above");
                    kept.push(best_row(column.data(), group, wants_min));
                }
            }
            Ok(())
        };
        self.for_each_key_group(&mut resolve)?;
        if !repeated {
            return Ok(self.clone());
        }
        Ok(self.take_rows(&kept))
    }

    /// Each group of rows sharing a whole key, in the order its key first
    /// appears (pond-ts groups through a `Map`, which keeps that order).
    fn for_each_key_group(&self, visit: &mut impl FnMut(&[usize]) -> Result<()>) -> Result<()> {
        let key = self.key();
        let begin = key.begin();
        let end = key.end();
        let n = begin.len();
        let mut run = 0;
        let mut group = Vec::new();
        while run < n {
            // Rows are ordered by (begin, end), so equal ones are adjacent.
            let same = |i: usize| begin[i] == begin[run] && end.is_none_or(|e| e[i] == e[run]);
            let mut stop = run + 1;
            while stop < n && same(stop) {
                stop += 1;
            }
            match key {
                // Interval rows with the same span can differ in label, in
                // any order: group them by label, first appearance first.
                Key::Interval(k) if stop - run > 1 => {
                    let mut groups: Vec<Vec<usize>> = Vec::new();
                    let mut at: HashMap<LabelKey, usize> = HashMap::new();
                    for i in run..stop {
                        let g = *at.entry(LabelKey::of(&k.label, i)).or_insert_with(|| {
                            groups.push(Vec::new());
                            groups.len() - 1
                        });
                        groups[g].push(i);
                    }
                    for g in &groups {
                        visit(g)?;
                    }
                }
                _ => {
                    group.clear();
                    group.extend(run..stop);
                    visit(&group)?;
                }
            }
            run = stop;
        }
        Ok(())
    }

    /// A row's key as pond-ts's dedupe error names it.
    fn describe_key(&self, i: usize) -> String {
        match self.key() {
            Key::Time(t) => format!("{} ({})", iso_time(t[i]), t[i]),
            Key::TimeRange(k) => format!("key \"{}:{}\"", k.begin[i], k.end[i]),
            Key::Interval(k) => {
                let label = match &k.label {
                    Labels::Number(v) => js_number(v[i]),
                    Labels::String(c) => c.get(i).unwrap_or_default().to_string(),
                };
                format!("key \"{}:{}:{label}\"", k.begin[i], k.end[i])
            }
        }
    }

    /// A new key named `name` must not clash with a value column.
    fn check_new_key_name(&self, call: &'static str, name: &str) -> Result<()> {
        if self.columns().iter().any(|c| c.name() == name) {
            return Err(PondError::InvalidData {
                call,
                message: format!(
                    "a value column is already named '{name}', the name the new key takes; rename it first"
                ),
            });
        }
        Ok(())
    }

    /// The range a grid covers: the one given (checked), else the series'
    /// own, from its first start to its latest end. `None` for an empty
    /// series with no range given.
    pub(crate) fn grid_range(
        &self,
        call: &'static str,
        range: Option<(i64, i64)>,
    ) -> Result<Option<(i64, i64)>> {
        if let Some((begin, end)) = range {
            if end < begin {
                return Err(PondError::InvalidData {
                    call,
                    message: format!("range ends ({end}) before it begins ({begin})"),
                });
            }
            return Ok(Some((begin, end)));
        }
        if self.is_empty() {
            return Ok(None);
        }
        let key = self.key();
        let begin = key.begin();
        let end = match key.end() {
            None => begin[begin.len() - 1],
            Some(e) => *e.iter().max().expect("not empty"),
        };
        Ok(Some((begin[0], end)))
    }

    /// No rows: `key` and every value column, optional.
    fn empty_grid(&self, key_name: &str, key: Key) -> TimeSeries {
        let columns = self
            .columns()
            .iter()
            .map(|c| Column::from_data(c.name().to_string(), c.data().take(&[]), false))
            .collect();
        TimeSeries::from_parts(self.name().to_string(), key_name.to_string(), key, columns)
    }

    /// Hold: for each point (doubled ms), the row pond-ts `atOrBefore`
    /// gives.
    fn hold_rows(&self, points: impl Iterator<Item = i128>) -> Vec<Option<usize>> {
        let key = self.key();
        let begin = key.begin();
        let n = begin.len();
        // pond-ts orders keys by begin, then end, then kind name; so a row
        // sorts before the point at time `t` when it begins before `t`, or
        // is a zero-length interval at `t` ("interval" < "time").
        let zero_interval = |i: usize| match key {
            Key::Interval(k) => k.begin[i] == k.end[i],
            _ => false,
        };
        let is_time = matches!(key, Key::Time(_));
        let mut idx = 0;
        points
            .map(|p2| {
                while idx < n {
                    let b2 = 2 * i128::from(begin[idx]);
                    if b2 < p2 || (b2 == p2 && zero_interval(idx)) {
                        idx += 1;
                    } else {
                        break;
                    }
                }
                // Only a time key can equal a time, so only then is the row
                // at the point itself taken.
                if is_time && idx < n && 2 * i128::from(begin[idx]) == p2 {
                    Some(idx)
                } else {
                    idx.checked_sub(1)
                }
            })
            .collect()
    }

    /// Linear (time keys): pond-ts `alignLinearAt` with its cursor.
    fn linear_takes(&self, points: impl Iterator<Item = i128>) -> Vec<Take> {
        let begin = self.key().begin();
        let n = begin.len();
        let mut idx = 0;
        points
            .map(|p2| {
                while idx < n && 2 * i128::from(begin[idx]) < p2 {
                    idx += 1;
                }
                if idx < n && 2 * i128::from(begin[idx]) == p2 {
                    return Take::Row(idx);
                }
                if idx == 0 {
                    return Take::Nothing;
                }
                if idx == n {
                    return Take::Row(n - 1);
                }
                let (p, q) = (idx - 1, idx);
                // As pond-ts computes it, in f64.
                let t = p2 as f64 / 2.0;
                let (bp, bq) = (begin[p] as f64, begin[q] as f64);
                Take::Between(p, q, (t - bp) / (bq - bp))
            })
            .collect()
    }
}

/// Each bucket's sample point, doubled (so a middle is a whole number).
fn sample_points(buckets: &IntervalKeys, at: At) -> impl Iterator<Item = i128> + '_ {
    buckets
        .begin
        .iter()
        .zip(&buckets.end)
        .map(move |(&b, &e)| match at {
            At::Begin => 2 * i128::from(b),
            At::Center => i128::from(b) + i128::from(e),
            At::End => 2 * i128::from(e),
        })
}

pub(crate) fn no_buckets() -> IntervalKeys {
    IntervalKeys {
        label: Vec::<f64>::new().into(),
        begin: vec![],
        end: vec![],
    }
}

/// The row of `group` with the smallest (or largest) value; gaps lose, and
/// the earlier row wins a tie.
fn best_row(data: &ColumnData, group: &[usize], min: bool) -> usize {
    let better = |a: std::cmp::Ordering| {
        if min {
            a == std::cmp::Ordering::Less
        } else {
            a == std::cmp::Ordering::Greater
        }
    };
    let mut best = group[0];
    match data {
        ColumnData::Number(c) => {
            let mut best_v = c.get(best);
            for &i in &group[1..] {
                let Some(v) = c.get(i) else { continue };
                if best_v.is_none_or(|b| v.partial_cmp(&b).is_some_and(better)) {
                    best = i;
                    best_v = Some(v);
                }
            }
        }
        ColumnData::Decimal(c) => {
            let mut best_v = c.get(best).map(|d| d.value);
            for &i in &group[1..] {
                let Some(v) = c.get(i).map(|d| d.value) else {
                    continue;
                };
                if best_v.is_none_or(|b| better(v.cmp(&b))) {
                    best = i;
                    best_v = Some(v);
                }
            }
        }
        _ => unreachable!("checked to be number or decimal"),
    }
    best
}

/// An interval label as a hash key: number labels by value (so `-0` and
/// `0` are one label, as pond-ts's `String(value)` makes them), text as is.
#[derive(Hash, PartialEq, Eq)]
enum LabelKey {
    Number(u64),
    Text(Option<String>),
}

impl LabelKey {
    fn of(labels: &Labels, i: usize) -> Self {
        match labels {
            Labels::Number(v) => LabelKey::Number((v[i] + 0.0).to_bits()),
            Labels::String(c) => LabelKey::Text(c.get(i).map(str::to_string)),
        }
    }
}

/// JavaScript's `new Date(ms).toISOString()`, for any time a JavaScript
/// date holds (jiff stops at year 9999).
pub(crate) fn iso_time(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let in_day = ms.rem_euclid(86_400_000);
    // Days since 1970-01-01 to a proleptic Gregorian date (Howard
    // Hinnant's `civil_from_days`).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!(
            "{}{:06}",
            if year < 0 { '-' } else { '+' },
            year.unsigned_abs()
        )
    };
    format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1_000 % 60,
        in_day % 1_000
    )
}

/// JavaScript's `String(x)` for a finite number: the shortest digits that
/// read back as `x`, in plain form from 1e-6 up to 1e21 and exponent form
/// outside it.
pub(crate) fn js_number(x: f64) -> String {
    if x == 0.0 {
        return "0".into();
    }
    if !x.is_finite() {
        return if x.is_nan() {
            "NaN".into()
        } else if x > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        };
    }
    // Rust's `{:e}` gives the shortest round-trip digits, as JavaScript does.
    let sci = format!("{:e}", x.abs());
    let (mantissa, exp) = sci.split_once('e').expect("exponent form");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().expect("exponent") + 1; // point after n digits
    let sign = if x < 0.0 { "-" } else { "" };
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let exp = if e < 0 {
            format!("-{}", -e)
        } else {
            format!("+{e}")
        };
        if k == 1 {
            format!("{digits}e{exp}")
        } else {
            format!("{}.{}e{exp}", &digits[..1], &digits[1..])
        }
    };
    format!("{sign}{body}")
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::column::DecimalColumn;
    use crate::error::PondError;

    fn s(times: Vec<i64>, columns: Vec<Column>) -> TimeSeries {
        TimeSeries::new("s", times, columns).unwrap()
    }

    #[test]
    fn materialize_refuses_a_half_millisecond() {
        let x = s(vec![0, 5], vec![Column::required("v", vec![1.0, 2.0])]);
        let odd = Sequence::every_ms(3).unwrap();
        let centre = Materialize {
            sample: At::Center,
            ..Materialize::default()
        };
        let e = x.materialize(&odd, centre).unwrap_err();
        assert!(matches!(e, PondError::Unsupported { .. }), "{e}");
        assert!(e.to_string().contains("half a millisecond"), "{e}");
        // An even step has whole-millisecond middles.
        let even = Sequence::every_ms(4).unwrap();
        assert_eq!(x.materialize(&even, centre).unwrap().key().begin(), &[2]);
        // Align keeps the bucket as its key, so a half-millisecond point is fine.
        let aligned = x
            .align(
                &odd,
                Align {
                    sample: At::Center,
                    method: AlignMethod::Linear,
                    ..Align::default()
                },
            )
            .unwrap();
        // Points 1.5 and 4.5: 1 + 1 * 1.5/5 and 1 + 1 * 4.5/5.
        let v = aligned.column("v").unwrap().numbers().unwrap();
        assert_eq!(v.values(), &[1.3, 1.9]);
    }

    #[test]
    fn keep_min_max_need_a_number_or_decimal_column() {
        let x = s(
            vec![0, 0],
            vec![
                Column::required("v", vec![1.0, 2.0]),
                Column::required("t", vec!["a", "b"]),
            ],
        );
        let e = x.dedupe(Keep::Min("t".into())).unwrap_err();
        assert!(matches!(e, PondError::WrongKind { .. }), "{e}");
        let e = x.dedupe(Keep::Max("nope".into())).unwrap_err();
        assert!(matches!(e, PondError::UnknownColumn { .. }), "{e}");
        // Checked even when nothing repeats (pond-ts only checks on a repeat).
        let single = s(vec![0], vec![Column::required("t", vec!["a"])]);
        assert!(single.dedupe(Keep::Min("t".into())).is_err());
    }

    #[test]
    fn decimals_hold_under_linear_and_compare_exactly() {
        let d = DecimalColumn::from_values(vec![100, 300, 299], 2).unwrap();
        let x = s(vec![0, 2_000, 2_000], vec![Column::required("d", d)]);
        let aligned = x
            .align(
                &Sequence::every("1s").unwrap(),
                Align {
                    method: AlignMethod::Linear,
                    ..Align::default()
                },
            )
            .unwrap();
        let d = aligned.column("d").unwrap().decimals().unwrap();
        // 1000 is between rows: held, not interpolated. 2000 is a row.
        let got: Vec<i128> = d.iter().map(|v| v.unwrap().value).collect();
        assert_eq!(got, vec![100, 100, 300]);
        let min = x.dedupe(Keep::Min("d".into())).unwrap();
        let got: Vec<i128> = min
            .column("d")
            .unwrap()
            .decimals()
            .unwrap()
            .iter()
            .map(|v| v.unwrap().value)
            .collect();
        assert_eq!(got, vec![100, 299]);
    }

    #[test]
    fn dedupe_error_names_the_key_as_pond_ts_does() {
        let x = s(
            vec![7_700, 7_700],
            vec![Column::required("v", vec![1.0, 2.0])],
        );
        let e = x.dedupe(Keep::Error).unwrap_err().to_string();
        assert_eq!(
            e,
            "dedupe: 2 events at 1970-01-01T00:00:07.700Z (7700). \
             Specify a different 'keep' policy or fix upstream."
        );
        let keys = IntervalKeys {
            label: vec![1.5, 1.5].into(),
            begin: vec![0, 0],
            end: vec![10, 10],
        };
        let x = TimeSeries::from_intervals("i", keys, vec![]).unwrap();
        let e = x.dedupe(Keep::Error).unwrap_err().to_string();
        assert_eq!(
            e,
            "dedupe: 2 events at key \"0:10:1.5\". \
             Specify a different 'keep' policy or fix upstream."
        );
    }

    #[test]
    fn options_are_checked() {
        let x = s(vec![0], vec![Column::required("v", vec![1.0])]);
        let every = Sequence::every("1s").unwrap();
        let reversed = Align {
            range: Some((5, 0)),
            ..Align::default()
        };
        assert!(x.align(&every, reversed).is_err());
        // A range with no sample point in it gives no rows.
        let narrow = Materialize {
            range: Some((1, 999)),
            ..Materialize::default()
        };
        assert!(x.materialize(&every, narrow).unwrap().is_empty());
    }

    #[test]
    fn js_number_matches_javascript() {
        for (x, js) in [
            (1.0, "1"),
            (1.5, "1.5"),
            (-0.25, "-0.25"),
            (0.1 + 0.2, "0.30000000000000004"),
            (123456789.0, "123456789"),
            (1e21, "1e+21"),
            (1.5e21, "1.5e+21"),
            (1e20, "100000000000000000000"),
            (1e-6, "0.000001"),
            (1e-7, "1e-7"),
            (1.25e-7, "1.25e-7"),
            (-0.0, "0"),
            (5e-324, "5e-324"),
            (f64::MAX, "1.7976931348623157e+308"),
        ] {
            assert_eq!(js_number(x), js, "{x}");
        }
    }

    #[test]
    fn iso_time_matches_javascript() {
        assert_eq!(iso_time(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_time(-1), "1969-12-31T23:59:59.999Z");
        assert_eq!(iso_time(1_792_157_400_123), "2026-10-16T13:30:00.123Z");
        assert_eq!(
            iso_time(8_640_000_000_000_000),
            "+275760-09-13T00:00:00.000Z"
        );
        assert_eq!(iso_time(-62_198_755_200_000), "-000001-01-01T00:00:00.000Z");
        assert_eq!(iso_time(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(iso_time(-2_208_988_800_001), "1899-12-31T23:59:59.999Z");
        assert_eq!(iso_time(253_402_300_800_000), "+010000-01-01T00:00:00.000Z");
        assert_eq!(
            iso_time(-8_640_000_000_000_000),
            "-271821-04-20T00:00:00.000Z"
        );
    }
}
