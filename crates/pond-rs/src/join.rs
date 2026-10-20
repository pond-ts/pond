//! `join` and `join_many`: put the columns of several series side by side,
//! matching rows by key (pond-ts `join` / `TimeSeries.joinMany`).

use std::cmp::Ordering;

use icu_collator::options::CollatorOptions;
use icu_collator::{Collator, CollatorBorrowed};

use crate::Column;
use crate::error::{PondError, Result};
use crate::series::{Key, Labels, TimeSeries};
use arrow_array::UInt32Array;

/// Which rows a [`TimeSeries::join`] keeps (pond-ts `type`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum JoinType {
    /// Only keys found on both sides.
    Inner,
    /// Every row of the left series.
    Left,
    /// Every row of the right series.
    Right,
    /// Every row of either series (the default, as in pond-ts).
    #[default]
    Outer,
}

/// What to do when a value column name appears in more than one series
/// (pond-ts `onConflict`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum OnConflict {
    /// A repeated name is an error (the default, as in pond-ts).
    #[default]
    Error,
    /// Rename each repeated column to `<prefix>_<name>`, one prefix per
    /// series in order. Columns whose name is not repeated keep it. The
    /// number of prefixes is only checked when some name is repeated, as
    /// in pond-ts.
    Prefix(Vec<String>),
}

/// Options for [`TimeSeries::join`] and [`TimeSeries::join_many`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Join {
    pub how: JoinType,
    pub on_conflict: OnConflict,
}

impl TimeSeries {
    /// This series' columns and `other`'s side by side, matching rows by key
    /// (pond-ts `join`). The key and the series name come from `self`; then
    /// `self`'s value columns, then `other`'s, all optional, since a row
    /// may be missing on either side.
    ///
    /// ```
    /// use pond_rs::{Column, Join, JoinType, TimeSeries};
    /// let cpu = TimeSeries::new("cpu", vec![0, 1_000, 2_000], vec![Column::required("cpu", vec![0.5, 0.6, 0.7])])?;
    /// let mem = TimeSeries::new("mem", vec![1_000, 2_000, 3_000], vec![Column::required("mem", vec![40.0, 41.0, 42.0])])?;
    /// let both = cpu.join(&mem, Join { how: JoinType::Inner, ..Join::default() })?;
    /// assert_eq!(both.key().begin(), &[1_000, 2_000]);
    /// let all = cpu.join(&mem, Join::default())?; // outer
    /// assert_eq!(all.len(), 4);
    /// assert_eq!(all.column("mem")?.numbers()?.get(0), None);
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    ///
    /// As in pond-ts:
    /// - Both series must have the same kind of key (time, time range or
    ///   interval); the key names may differ.
    /// - Keys compare by begin, then end, then (intervals) label, with
    ///   number labels before text and text labels compared the way
    ///   JavaScript's `localeCompare` does under the root or English
    ///   locale (so `"a" < "B"`, and the two ways of writing `é` are the
    ///   same label). Node follows the machine's default locale, so pond-ts
    ///   run under another locale can order text labels differently.
    /// - Equal keys pair **one to one** in order: a key `a` times on the
    ///   left and `b` times on the right gives `min(a, b)` matched rows and
    ///   `|a − b|` one-sided rows, not `a × b`.
    /// - A matched row keeps the left key.
    /// - A value column name on both sides is an error unless
    ///   [`OnConflict::Prefix`] renames it.
    ///
    /// Columns are shared, not copied, when every row of their side lands
    /// in the output once and in order with nothing in between: always the
    /// left side of a `Left` join and the right side of a `Right` join, and
    /// both sides when the keys match one for one. To bring across only
    /// the columns you need, [`TimeSeries::select`] the other side first.
    pub fn join(&self, other: &TimeSeries, options: Join) -> Result<TimeSeries> {
        let prepared = prepare(&[self, other], &options.on_conflict)?;
        let (left, right) = match &prepared {
            Some(p) => (&p[0], &p[1]),
            None => (self, other),
        };
        join_two(left, right, options.how)
    }

    /// Several series joined left to right, as repeated [`TimeSeries::join`]
    /// with `how` (pond-ts `TimeSeries.joinMany`). Repeated column names are
    /// found across all of them first, so [`OnConflict::Prefix`] takes one
    /// prefix per series. One series is returned unchanged. An empty list is
    /// an error.
    ///
    /// ```
    /// use pond_rs::{Column, Join, TimeSeries};
    /// let a = TimeSeries::new("a", vec![0, 1_000], vec![Column::required("a", vec![1.0, 2.0])])?;
    /// let b = TimeSeries::new("b", vec![0, 1_000], vec![Column::required("b", vec![3.0, 4.0])])?;
    /// let c = TimeSeries::new("c", vec![0, 1_000], vec![Column::required("c", vec![5.0, 6.0])])?;
    /// let wide = TimeSeries::join_many(&[&a, &b, &c], Join::default())?;
    /// assert_eq!(wide.columns().len(), 3);
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn join_many(series: &[&TimeSeries], options: Join) -> Result<TimeSeries> {
        let Some((first, rest)) = series.split_first() else {
            return Err(PondError::InvalidData {
                call: "join_many",
                message: "needs at least one series".into(),
            });
        };
        let prepared = prepare(series, &options.on_conflict)?;
        let all: Vec<&TimeSeries> = match &prepared {
            Some(p) => p.iter().collect(),
            None => std::iter::once(*first)
                .chain(rest.iter().copied())
                .collect(),
        };
        let mut joined = all[0].clone();
        for next in &all[1..] {
            joined = join_two(&joined, next, options.how)?;
        }
        Ok(joined)
    }
}

/// Apply the conflict policy: `None` when no name repeats (the series are
/// used as given), else the renamed series. As pond-ts
/// `prepareSeriesForJoin`.
fn prepare(series: &[&TimeSeries], on_conflict: &OnConflict) -> Result<Option<Vec<TimeSeries>>> {
    const CALL: &str = "join";
    // A name is repeated when more than one series has it.
    let mut seen: Vec<&str> = Vec::new();
    let mut repeated: Vec<&str> = Vec::new();
    for s in series {
        for c in s.columns() {
            let name = c.name();
            if seen.contains(&name) {
                if !repeated.contains(&name) {
                    repeated.push(name);
                }
            } else {
                seen.push(name);
            }
        }
    }
    if repeated.is_empty() {
        return Ok(None);
    }
    repeated.sort_unstable();
    let prefixes = match on_conflict {
        OnConflict::Error => {
            return Err(PondError::InvalidData {
                call: CALL,
                message: format!(
                    "cannot join series with duplicate column names: {}; rename one side or use OnConflict::Prefix",
                    repeated.join(", ")
                ),
            });
        }
        OnConflict::Prefix(p) => p,
    };
    if prefixes.len() != series.len() {
        return Err(PondError::InvalidData {
            call: CALL,
            message: format!(
                "prefix conflict handling requires exactly {} prefixes",
                series.len()
            ),
        });
    }
    let renamed = series
        .iter()
        .zip(prefixes)
        .map(|(s, prefix)| {
            let names: Vec<(String, String)> = s
                .columns()
                .iter()
                .map(|c| c.name())
                .filter(|n| repeated.contains(n))
                .map(|n| (n.to_string(), format!("{prefix}_{n}")))
                .collect();
            let renames: Vec<(&str, &str)> = names
                .iter()
                .map(|(a, b)| (a.as_str(), b.as_str()))
                .collect();
            s.rename(&renames)
        })
        .collect::<Result<Vec<_>>>()?;
    // Prefixes may still collide (two series given the same prefix).
    let mut names: Vec<&str> = Vec::new();
    let mut still: Vec<&str> = Vec::new();
    for s in &renamed {
        for c in s.columns() {
            if names.contains(&c.name()) {
                still.push(c.name());
            } else {
                names.push(c.name());
            }
        }
    }
    if !still.is_empty() {
        still.sort_unstable();
        still.dedup();
        return Err(PondError::InvalidData {
            call: CALL,
            message: format!(
                "prefix conflict handling still produced duplicate column names: {}",
                still.join(", ")
            ),
        });
    }
    Ok(Some(renamed))
}

fn key_kind(key: &Key) -> &'static str {
    match key {
        Key::Time(_) => "time",
        Key::TimeRange(_) => "timeRange",
        Key::Interval(_) => "interval",
    }
}

/// The two-series join, after conflicts are settled.
fn join_two(left: &TimeSeries, right: &TimeSeries, how: JoinType) -> Result<TimeSeries> {
    const CALL: &str = "join";
    let (lk, rk) = (left.key(), right.key());
    if key_kind(lk) != key_kind(rk) {
        return Err(PondError::InvalidData {
            call: CALL,
            message: format!(
                "cannot join series with different key kinds ({} and {})",
                key_kind(lk),
                key_kind(rk)
            ),
        });
    }
    // pond-ts refuses a value column named like the output key.
    let key_name = left.key_name();
    if right.columns().iter().any(|c| c.name() == key_name) {
        return Err(PondError::InvalidData {
            call: CALL,
            message: format!(
                "the right series has a value column named '{key_name}', the left key's name; rename it first"
            ),
        });
    }

    if lk.len().max(rk.len()) >= NONE as usize {
        return Err(PondError::Unsupported {
            call: CALL,
            message: format!("a side has {} rows or more", NONE),
        });
    }
    let (picks, left_only, right_only) = match_rows(lk, rk, how);
    let (n, m, len) = (lk.len(), rk.len(), picks.len());
    // A side passes through when all its rows are in the output, in order,
    // with no row of the other side alone between them.
    let left_identity = len == n && right_only == 0;
    let right_identity = len == m && left_only == 0;

    let key = if left_identity {
        lk.clone()
    } else {
        output_key(lk, rk, &picks)?
    };
    let side = |s: &TimeSeries, identity: bool, pick: fn(Pair) -> u32| {
        // Arrow row numbers for the side (null: no row), built once and
        // only if a column is gathered.
        let mut indices: Option<UInt32Array> = None;
        s.columns()
            .iter()
            .map(|c| {
                let data = if identity {
                    c.data().clone()
                } else {
                    let idx = indices.get_or_insert_with(|| {
                        picks
                            .iter()
                            .map(|&p| Some(pick(p)).filter(|&i| i != NONE))
                            .collect()
                    });
                    c.data().take_indices(idx)
                };
                Column::from_data(c.name().to_string(), data, false)
            })
            .collect::<Vec<_>>()
    };
    let mut columns = side(left, left_identity, |p| p.l);
    columns.extend(side(right, right_identity, |p| p.r));
    Ok(TimeSeries::from_parts(
        left.name().to_string(),
        key_name.to_string(),
        key,
        columns,
    ))
}

/// One output row: the left row, the right row, or both. Row numbers are
/// held as `u32` (`NONE` for no row), a quarter of two `Option<usize>`:
/// at a million rows the smaller vector is measurably faster to fill.
#[derive(Clone, Copy)]
struct Pair {
    l: u32,
    r: u32,
}

const NONE: u32 = u32::MAX;

impl Pair {
    fn both(i: usize, j: usize) -> Self {
        Pair {
            l: i as u32,
            r: j as u32,
        }
    }
    fn left_only(i: usize) -> Self {
        Pair {
            l: i as u32,
            r: NONE,
        }
    }
    fn right_only(j: usize) -> Self {
        Pair {
            l: NONE,
            r: j as u32,
        }
    }
    fn left(self) -> Option<usize> {
        (self.l != NONE).then_some(self.l as usize)
    }
}

/// Walk both keys once, pairing equal keys one to one in order. Returns the
/// output rows and how many came from only the left and only the right.
fn match_rows(lk: &Key, rk: &Key, how: JoinType) -> (Vec<Pair>, usize, usize) {
    let (n, m) = (lk.len(), rk.len());
    match (lk, rk) {
        // Time keys: a plain integer compare the optimiser can inline.
        (Key::Time(l), Key::Time(r)) => walk(n, m, how, |i, j| l[i].cmp(&r[j])),
        _ => {
            let mut order = KeyOrder::new(lk, rk);
            walk(n, m, how, |i, j| order.cmp(i, j))
        }
    }
}

fn walk(
    n: usize,
    m: usize,
    how: JoinType,
    mut compare: impl FnMut(usize, usize) -> Ordering,
) -> (Vec<Pair>, usize, usize) {
    let keep_left = matches!(how, JoinType::Left | JoinType::Outer);
    let keep_right = matches!(how, JoinType::Right | JoinType::Outer);
    let mut picks = Vec::with_capacity(match how {
        JoinType::Left => n,
        JoinType::Right => m,
        JoinType::Inner => n.min(m),
        JoinType::Outer => n + m,
    });
    let (mut i, mut j) = (0, 0);
    let (mut left_only, mut right_only) = (0, 0);
    while i < n && j < m {
        match compare(i, j) {
            Ordering::Equal => {
                picks.push(Pair::both(i, j));
                i += 1;
                j += 1;
            }
            Ordering::Less => {
                if keep_left {
                    picks.push(Pair::left_only(i));
                    left_only += 1;
                }
                i += 1;
            }
            Ordering::Greater => {
                if keep_right {
                    picks.push(Pair::right_only(j));
                    right_only += 1;
                }
                j += 1;
            }
        }
    }
    if keep_left {
        left_only += n - i;
        picks.extend((i..n).map(Pair::left_only));
    }
    if keep_right {
        right_only += m - j;
        picks.extend((j..m).map(Pair::right_only));
    }
    (picks, left_only, right_only)
}

/// pond-ts's key order across two keys of one kind: begin, then end, then
/// (intervals) label.
struct KeyOrder<'a> {
    lb: &'a [i64],
    rb: &'a [i64],
    ends: Option<(&'a [i64], &'a [i64])>,
    labels: Option<(&'a Labels, &'a Labels)>,
    collator: Option<CollatorBorrowed<'static>>,
}

impl<'a> KeyOrder<'a> {
    fn new(lk: &'a Key, rk: &'a Key) -> Self {
        let labels = match (lk, rk) {
            (Key::Interval(l), Key::Interval(r)) => Some((&l.label, &r.label)),
            _ => None,
        };
        Self {
            lb: lk.begin(),
            rb: rk.begin(),
            ends: lk.end().zip(rk.end()),
            labels,
            collator: None,
        }
    }

    fn cmp(&mut self, i: usize, j: usize) -> Ordering {
        let c = self.lb[i].cmp(&self.rb[j]);
        if c != Ordering::Equal {
            return c;
        }
        let Some((le, re)) = self.ends else {
            return Ordering::Equal;
        };
        let c = le[i].cmp(&re[j]);
        if c != Ordering::Equal {
            return c;
        }
        let Some((ll, rl)) = self.labels else {
            return Ordering::Equal;
        };
        match (ll, rl) {
            // Labels are finite, so this is a total order.
            (Labels::Number(a), Labels::Number(b)) => {
                a[i].partial_cmp(&b[j]).unwrap_or(Ordering::Equal)
            }
            // Numbers sort before text.
            (Labels::Number(_), Labels::String(_)) => Ordering::Less,
            (Labels::String(_), Labels::Number(_)) => Ordering::Greater,
            (Labels::String(a), Labels::String(b)) => {
                let (a, b) = (a.get(i).unwrap_or(""), b.get(j).unwrap_or(""));
                if a == b {
                    return Ordering::Equal;
                }
                self.collator
                    .get_or_insert_with(root_collator)
                    .compare(a, b)
            }
        }
    }
}

/// The CLDR root collation at its default strength: what Node's
/// `String.prototype.localeCompare` uses with no locale given when the
/// machine's default locale is root or English (en-US tailors nothing).
pub(crate) fn root_collator() -> CollatorBorrowed<'static> {
    Collator::try_new(Default::default(), CollatorOptions::default())
        .expect("the root collation is compiled in")
}

/// The output key, row by row from whichever side has the row (the left
/// one when both do).
fn output_key(lk: &Key, rk: &Key, picks: &[Pair]) -> Result<Key> {
    let pick = |l: &[i64], r: &[i64]| -> Vec<i64> {
        picks
            .iter()
            .map(|p| match p.left() {
                Some(i) => l[i],
                None => r[p.r as usize],
            })
            .collect()
    };
    match (lk, rk) {
        (Key::Time(l), Key::Time(r)) => Ok(Key::Time(pick(l, r))),
        (Key::TimeRange(l), Key::TimeRange(r)) => Ok(Key::TimeRange(crate::TimeRangeKeys {
            begin: pick(&l.begin, &r.begin),
            end: pick(&l.end, &r.end),
        })),
        (Key::Interval(l), Key::Interval(r)) => {
            let from_left = picks.iter().filter(|p| p.l != NONE).count();
            // Number and text labels never match, so rows from both sides
            // with different label kinds only come from an outer join.
            if from_left != 0
                && from_left != picks.len()
                && matches!(l.label, Labels::Number(_)) != matches!(r.label, Labels::Number(_))
            {
                let kind = |k: &Labels| match k {
                    Labels::Number(_) => "number",
                    Labels::String(_) => "string",
                };
                return Err(PondError::InvalidData {
                    call: "join",
                    message: format!(
                        "cannot combine interval keys with {} labels and interval keys with {} labels; an interval-keyed series must use one label type throughout",
                        kind(&l.label),
                        kind(&r.label)
                    ),
                });
            }
            // (source, row): 0 is the left key, 1 the right. A one-sided
            // result takes its label kind from that side, as in pond-ts.
            let picks: Vec<(u32, u32)> = picks
                .iter()
                .map(|p| if p.l != NONE { (0, p.l) } else { (1, p.r) })
                .collect();
            let sources: [&Key; 2] = [lk, rk];
            // pond-ts checks "all from the left" first, so an empty result
            // keeps the left label kind.
            if from_left == 0 && !picks.is_empty() {
                let rows: Vec<(u32, u32)> = picks.iter().map(|&(_, r)| (0, r)).collect();
                return Ok(Key::gather(&[rk], &rows));
            }
            Ok(Key::gather(&sources, &picks))
        }
        _ => unreachable!("key kinds were checked"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::column::DecimalColumn;
    use std::sync::Arc;

    fn s(name: &str, times: Vec<i64>, col: &str, v: Vec<f64>) -> TimeSeries {
        TimeSeries::new(name, times, vec![Column::required(col, v)]).unwrap()
    }

    #[test]
    fn a_kept_side_shares_its_columns() {
        let left = s("l", vec![0, 1, 2], "a", vec![1.0, 2.0, 3.0]);
        let right = s("r", vec![1, 5], "b", vec![4.0, 5.0]);
        let ptr =
            |t: &TimeSeries, c: &str| t.column(c).unwrap().numbers().unwrap().values().as_ptr();
        let out = left
            .join(
                &right,
                Join {
                    how: JoinType::Left,
                    ..Join::default()
                },
            )
            .unwrap();
        assert_eq!(ptr(&out, "a"), ptr(&left, "a"));
        let out = left
            .join(
                &right,
                Join {
                    how: JoinType::Right,
                    ..Join::default()
                },
            )
            .unwrap();
        assert_eq!(ptr(&out, "b"), ptr(&right, "b"));
        // Same keys one for one: both sides pass through.
        let same = s("m", vec![0, 1, 2], "c", vec![7.0, 8.0, 9.0]);
        let out = left.join(&same, Join::default()).unwrap();
        assert_eq!(ptr(&out, "a"), ptr(&left, "a"));
        assert_eq!(ptr(&out, "c"), ptr(&same, "c"));
        // Values are optional on output even when passed through.
        assert!(out.schema().iter().skip(1).all(|c| !c.required));
    }

    #[test]
    fn decimal_columns_are_gathered_exactly() {
        let left = s("l", vec![0, 2], "a", vec![1.0, 2.0]);
        let d = DecimalColumn::from_options([Some(12_345), None, Some(-7)], 2).unwrap();
        let right = TimeSeries::new("r", vec![1, 2, 3], vec![Column::optional("d", d)]).unwrap();
        let out = left.join(&right, Join::default()).unwrap();
        assert_eq!(out.key().begin(), &[0, 1, 2, 3]);
        let got: Vec<Option<String>> = (0..4)
            .map(|i| {
                out.column("d")
                    .unwrap()
                    .decimals()
                    .unwrap()
                    .get(i)
                    .map(|x| x.to_string())
            })
            .collect();
        assert_eq!(
            got,
            [None, Some("123.45".into()), None, Some("-0.07".into())]
        );
    }

    #[test]
    fn a_value_column_named_like_the_left_key_is_refused() {
        // Only Arrow input can give a key another name.
        use arrow_array::{Float64Array, RecordBatch, TimestampMillisecondArray};
        use arrow_schema::{DataType, Field, Schema, TimeUnit};
        let schema = Arc::new(Schema::new(vec![
            Field::new(
                "ts",
                DataType::Timestamp(TimeUnit::Millisecond, None),
                false,
            ),
            Field::new("v", DataType::Float64, false),
        ]));
        let batch = RecordBatch::try_new(
            schema,
            vec![
                Arc::new(TimestampMillisecondArray::from(vec![0, 1])),
                Arc::new(Float64Array::from(vec![1.0, 2.0])),
            ],
        )
        .unwrap();
        let left = TimeSeries::from_arrow("l", &[batch], "ts").unwrap();
        let right = s("r", vec![0], "ts", vec![9.0]);
        let e = left.join(&right, Join::default()).unwrap_err().to_string();
        assert!(e.contains("named 'ts'"), "{e}");
        // The other way round the key is `time`, so nothing clashes.
        assert_eq!(
            right.join(&left, Join::default()).unwrap().key_name(),
            "time"
        );
    }

    #[test]
    fn an_empty_interval_join_keeps_the_left_label_kind() {
        let one = |label: Labels| {
            let keys = crate::IntervalKeys {
                label,
                begin: vec![0],
                end: vec![10],
            };
            TimeSeries::from_intervals("i", keys, vec![]).unwrap()
        };
        let text = one(vec!["x"].into());
        let number = one(vec![5.0].into());
        let inner = Join {
            how: JoinType::Inner,
            ..Join::default()
        };
        let is_text = |t: &TimeSeries| match t.key() {
            Key::Interval(k) => matches!(k.label, Labels::String(_)),
            _ => unreachable!(),
        };
        let out = text.join(&number, inner.clone()).unwrap();
        assert_eq!(out.len(), 0);
        assert!(is_text(&out));
        let out = number.join(&text, inner).unwrap();
        assert_eq!(out.len(), 0);
        assert!(!is_text(&out));
    }

    #[test]
    fn join_many_needs_a_series() {
        assert!(TimeSeries::join_many(&[], Join::default()).is_err());
    }

    #[test]
    fn labels_compare_as_javascript_locale_compare() {
        let c = root_collator();
        assert_eq!(c.compare("a", "B"), Ordering::Less);
        assert_eq!(c.compare("B", "b"), Ordering::Greater);
        assert_eq!(c.compare("\u{e9}", "e\u{301}"), Ordering::Equal);
        assert_eq!(c.compare("_", "1"), Ordering::Less);
        assert_eq!(c.compare("1", "a"), Ordering::Less);
    }
}
