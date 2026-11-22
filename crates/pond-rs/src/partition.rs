//! `partition_by` / `group_by`: run operations on each entity (host,
//! symbol, device) of a series separately, so that a row's neighbours are
//! always rows of the same entity.
//!
//! Semantics follow pond-ts's `PartitionedTimeSeries` exactly, including two
//! details that decide row order:
//!
//! - Partitions are numbered in the order their first row appears.
//! - Putting partitions back together (pond-ts's `TimeSeries.concat`) sorts
//!   the rows by key and keeps the partition order for rows with the same
//!   key, so rows at a shared time come out partition by partition, not in
//!   their original order.
//!
//! pond-ts merges the partitions after every operation and splits them again
//! before the next. pond-rs keeps them apart and only redoes what that merge
//! and split would change: it drops partitions left empty, reorders them by
//! their first row, and splits again for real only when an operation changed
//! the values of a partition column.
//!
//! Cost: splitting is one pass that numbers each row's partition; no row
//! is copied until a partition is asked for ([`PartitionedSeries::iter`],
//! [`PartitionedSeries::get`], [`PartitionedSeries::map`]). The operations
//! that keep every row and only write number columns (`diff`, `rate`,
//! `pct_change`, `shift`, `cumulative`, `fill` and the row-by-row
//! `rolling` calls) never build the partitions as whole series: each
//! partition's rows of just the columns the operation reads are copied
//! out, the operation runs on those, and its results are written back to
//! the rows they came from. Text and other untouched columns are shared
//! with the source, not copied, and [`PartitionedSeries::collect`] then
//! has nothing to sort unless rows at one time are out of partition order.
//! Everything else goes through [`PartitionedSeries::map`]: one copy of
//! every column to split, and a sort and a copy to collect.

use std::collections::HashMap;
use std::hash::{BuildHasher, Hash, Hasher};
use std::sync::{Arc, OnceLock};

use crate::column::{ColumnData, Value};
use crate::duration::parse_duration;
use crate::error::{PondError, Result};
use crate::grid::{Align, Keep, Materialize};
use crate::par;
use crate::reducer::{Agg, Reducer};
use crate::rolling::{Alignment, Rolling, RollingOver};
use crate::rowwise::{Change, Fill, FillLimits};
use crate::sequence::Sequence;
use crate::series::{Column, ColumnKind, Key, Labels, TimeSeries};
use crate::smooth::{Sample, Smooth};

/// A partition key: one entry per partition column, `None` for a gap.
pub type PartitionKey = Vec<Option<Value>>;

/// A series split into partitions by the values of one or more columns:
/// [`TimeSeries::partition_by`]. Operations run on each partition
/// separately (on several cores with the `parallel` feature) and return
/// another `PartitionedSeries`; [`PartitionedSeries::collect`] puts the
/// rows back into one series.
///
/// ```
/// # use pond_rs::{Agg, Column, FirstRow, Reducer, TimeSeries, Value};
/// let s = TimeSeries::new("cpu", vec![0, 0, 1000, 1000], vec![
///     Column::required("host", vec!["a", "b", "a", "b"]),
///     Column::required("load", vec![1.0, 10.0, 3.0, 40.0]),
/// ])?;
/// let change = s.partition_by(&["host"])?.diff(&["load"])?.collect()?;
/// // Each host against its own previous row, not the row above.
/// assert_eq!(change.column("load")?.numbers()?.get(2), Some(2.0));
/// assert_eq!(change.column("load")?.numbers()?.get(3), Some(30.0));
///
/// let by_host = s.partition_by(&["host"])?;
/// let a = by_host.get(&[Some(Value::String("a".into()))]).unwrap();
/// assert_eq!(a.len(), 2);
/// # Ok::<(), pond_rs::PondError>(())
/// ```
#[derive(Debug, Clone)]
pub struct PartitionedSeries {
    by: Vec<String>,
    /// In partition order: the order their first rows appear in the
    /// series as one.
    parts: Parts,
    /// The order the last operation ran the partitions in, as indexes into
    /// `parts`; [`PartitionedSeries::collect`] merges in this order.
    /// pond-ts splits before an operation and merges right after it, so an
    /// operation that moves a partition's first row reorders the partitions
    /// for the next operation but not for its own merge.
    run_order: Vec<usize>,
    /// The series as one, while no operation has run: pond-ts's `collect`
    /// then returns its source unchanged, in its own row order.
    whole: Option<TimeSeries>,
    /// A zero-row series with the current columns, for when there are no
    /// partitions (pond-ts runs the operation on an empty series).
    empty: TimeSeries,
}

/// The partitions of a [`PartitionedSeries`].
#[derive(Debug, Clone)]
enum Parts {
    /// One series per partition.
    Made(Vec<(PartitionKey, TimeSeries)>),
    /// Rows of one series, not yet copied apart.
    Rows(Rows),
}

/// Partitions held as the rows of one series: partition `i` is the rows
/// `groups.rows[i]` of `base`. `base` is in the row order of the series
/// that was split (sorted by key), which is not always the order
/// [`PartitionedSeries::collect`] gives.
#[derive(Debug, Clone)]
struct Rows {
    base: TimeSeries,
    groups: Arc<Groups>,
    /// The partitions as series, copied out of `base` on first use.
    made: OnceLock<Vec<(PartitionKey, TimeSeries)>>,
    /// What the short cut that made `base` computed, partition by
    /// partition, kept so that making the partitions does not copy those
    /// columns out of `base` again.
    computed: Option<Arc<Computed>>,
}

/// Per-partition results a short cut wrote into a base series.
#[derive(Debug)]
struct Computed {
    /// One series per partition: its key and its result columns.
    parts: Vec<TimeSeries>,
    /// `(column of the base series, column of each of `parts`)` for every
    /// column of the base series that holds these results.
    columns: Vec<(usize, usize)>,
}

/// Which rows of a series belong to which partition.
#[derive(Debug)]
struct Groups {
    /// Each partition's key, in partition order (first-row order).
    keys: Vec<PartitionKey>,
    /// Each partition's rows, ascending.
    rows: Vec<Vec<usize>>,
    /// Each row's partition.
    part: Vec<u32>,
}

impl Rows {
    fn new(base: TimeSeries, groups: Arc<Groups>) -> Self {
        Rows {
            base,
            groups,
            made: OnceLock::new(),
            computed: None,
        }
    }

    /// The partitions as series. Cost: the first call copies every
    /// column of every row once, except the columns a short cut has just
    /// computed, which are taken from its per-partition results.
    fn made(&self) -> &[(PartitionKey, TimeSeries)] {
        if let Some(made) = self.made.get() {
            return made;
        }
        // Built before taking the cell, not inside `get_or_init`: the
        // copy runs on several cores, and a thread waiting on that work
        // may be handed another task that asks for the partitions, which
        // would then wait on a cell its own thread is filling. Two
        // callers at once may both build them; the first to finish is
        // kept.
        let series = match &self.computed {
            None => par::map(&self.groups.rows, |rows| self.base.take_rows(rows)),
            Some(computed) => {
                let parts: Vec<usize> = (0..self.groups.rows.len()).collect();
                par::map(&parts, |&i| self.part_from(computed, i))
            }
        };
        let made = self.groups.keys.iter().cloned().zip(series).collect();
        self.made.get_or_init(|| made)
    }

    /// Partition `i` as `base.take_rows` gives it, with the key and the
    /// columns `computed` holds taken from there instead (the same
    /// values: `base` was written from them).
    fn part_from(&self, computed: &Computed, i: usize) -> TimeSeries {
        let (base, rows, part) = (&self.base, &self.groups.rows[i], &computed.parts[i]);
        let picks = std::cell::OnceCell::new();
        let columns = base
            .columns()
            .iter()
            .enumerate()
            .map(
                |(c, column)| match computed.columns.iter().find(|&&(at, _)| at == c) {
                    Some(&(_, from)) => part.columns()[from].clone(),
                    None => {
                        let picks = picks.get_or_init(|| {
                            rows.iter()
                                .map(|&r| Some(r))
                                .collect::<Vec<Option<usize>>>()
                        });
                        Column::from_data(
                            column.name().to_string(),
                            column.data().take(picks),
                            column.is_required(),
                        )
                    }
                },
            )
            .collect();
        TimeSeries::from_parts(
            base.name().to_string(),
            base.key_name().to_string(),
            part.shared_key(),
            columns,
        )
    }

    /// What [`merge`] gives for the partitions in order, without making
    /// them. Cost: one pass over the keys; when no rows that share a key
    /// are out of partition order (the usual case) the key and the columns
    /// are shared with `base`, except a dictionary text column, which is
    /// copied out as plain text as [`merge`] does. Otherwise one copy of
    /// every column.
    fn collect(&self) -> TimeSeries {
        let base = &self.base;
        if self.groups.rows.len() == 1 {
            // One partition is every row, in order.
            return base.clone();
        }
        let order = self.groups.merge_order(base.key());
        let picks: Vec<(u32, u32)> = match &order {
            Some(order) => order.iter().map(|&i| (0, i as u32)).collect(),
            None => Vec::new(),
        };
        let columns = par::map(base.columns(), |c| {
            let dictionary = matches!(c.data(), ColumnData::String(s) if s.is_dictionary());
            let data = match &order {
                None if !dictionary => c.data().clone(),
                None => {
                    let all: Vec<(u32, u32)> = (0..base.len() as u32).map(|i| (0, i)).collect();
                    ColumnData::gather(&[c.data()], &all)
                }
                Some(_) => ColumnData::gather(&[c.data()], &picks),
            };
            Column::from_data(c.name().to_string(), data, c.is_required())
        });
        let key = match &order {
            None => base.shared_key(),
            Some(order) => Arc::new(base.key().take(order)),
        };
        TimeSeries::from_parts(
            base.name().to_string(),
            base.key_name().to_string(),
            key,
            columns,
        )
    }
}

impl Groups {
    /// The order [`merge`] puts the rows in, as row numbers: by key, rows
    /// with the same key in partition order, then row order. `None` when
    /// that is the row order they are already in.
    fn merge_order(&self, key: &Key) -> Option<Vec<usize>> {
        let (begin, end) = (key.begin(), key.end());
        let n = begin.len();
        let same = |i: usize| begin[i] == begin[i - 1] && end.is_none_or(|e| e[i] == e[i - 1]);
        let part = &self.part;
        if (1..n).all(|i| part[i] >= part[i - 1] || !same(i)) {
            return None;
        }
        let mut order: Vec<usize> = (0..n).collect();
        let mut from = 0;
        while from < n {
            let mut to = from + 1;
            while to < n && same(to) {
                to += 1;
            }
            // Stable: rows of one partition keep their order.
            order[from..to].sort_by_key(|&i| part[i]);
            from = to;
        }
        Some(order)
    }

    /// `f` on each partition's rows of `narrow`, or `None` if it fails
    /// anywhere or gives back anything but the same rows (a result that
    /// does not share its input's key).
    fn run<F>(&self, narrow: &TimeSeries, f: &F) -> Option<Vec<TimeSeries>>
    where
        F: Fn(&TimeSeries) -> Result<TimeSeries> + Sync + Send,
    {
        par::map(&self.rows, |rows| {
            let part = number_rows(narrow, rows);
            let out = f(&part).ok()?;
            Arc::ptr_eq(&part.shared_key(), &out.shared_key()).then_some(out)
        })
        .into_iter()
        .collect()
    }

    /// The number columns of `outs` (one result per partition, all with
    /// the same columns) as columns of `rows` rows, each value at the row
    /// it was computed for.
    fn scatter(&self, outs: &[TimeSeries], rows: usize) -> Vec<Column> {
        let columns: Vec<usize> = (0..outs[0].columns().len()).collect();
        par::map(&columns, |&c| {
            let mut values = vec![f64::NAN; rows];
            for (at, out) in self.rows.iter().zip(outs) {
                let ColumnData::Number(part) = out.columns()[c].data() else {
                    unreachable!("checked by same_number_columns");
                };
                for (&row, &v) in at.iter().zip(part.values()) {
                    values[row] = v;
                }
            }
            let head = &outs[0].columns()[c];
            Column::from_data(head.name().to_string(), values, head.is_required())
        })
    }
}

/// The rows at `rows` of a series whose value columns are all numbers:
/// [`TimeSeries::take_rows`] without its list of optional row numbers.
fn number_rows(series: &TimeSeries, rows: &[usize]) -> TimeSeries {
    let columns = series
        .columns()
        .iter()
        .map(|c| {
            let ColumnData::Number(values) = c.data() else {
                unreachable!("the short cuts pick number columns only");
            };
            let values = values.values();
            let picked: Vec<f64> = rows.iter().map(|&i| values[i]).collect();
            Column::from_data(c.name().to_string(), picked, c.is_required())
        })
        .collect();
    TimeSeries::from_parts(
        series.name().to_string(),
        series.key_name().to_string(),
        series.key().take(rows),
        columns,
    )
}

/// True when every series has the columns of the first (names and
/// required flags) and they are all number columns.
fn same_number_columns(series: &[TimeSeries]) -> bool {
    let head = series[0].columns();
    head.iter().all(|c| c.kind() == ColumnKind::Number)
        && series.iter().all(|s| {
            s.columns().len() == head.len()
                && s.columns().iter().zip(head).all(|(a, b)| {
                    a.kind() == ColumnKind::Number
                        && a.name() == b.name()
                        && a.is_required() == b.is_required()
                })
        })
}

impl TimeSeries {
    /// Split this series by the values of `columns` (one or more value
    /// columns of any kind). A gap is a value of its own: rows with no
    /// value form one partition. Numbers are compared by value (`0` and
    /// `-0` are one partition, as in pond-ts).
    pub fn partition_by(&self, columns: &[&str]) -> Result<PartitionedSeries> {
        const CALL: &str = "TimeSeries::partition_by";
        if columns.is_empty() {
            return Err(PondError::InvalidData {
                call: CALL,
                message: "needs at least one partition column".into(),
            });
        }
        let by: Vec<usize> = columns
            .iter()
            .map(|c| self.column_index(CALL, c))
            .collect::<Result<_>>()?;
        refuse_array_keys(CALL, self, &by)?;
        Ok(PartitionedSeries {
            by: columns.iter().map(|c| c.to_string()).collect(),
            run_order: Vec::new(),
            parts: split(self, &by),
            whole: Some(self.clone()),
            empty: self.row_range(0..0),
        })
    }

    /// The partitions of [`TimeSeries::partition_by`], each with its key,
    /// in the order their first row appears (pond-ts `groupBy`, which takes
    /// one column; this takes one or more).
    pub fn group_by(&self, columns: &[&str]) -> Result<Vec<(PartitionKey, TimeSeries)>> {
        Ok(self.partition_by(columns)?.into_groups())
    }
}

impl PartitionedSeries {
    /// The partition columns.
    pub fn by(&self) -> &[String] {
        &self.by
    }

    /// The number of partitions.
    pub fn len(&self) -> usize {
        match &self.parts {
            Parts::Made(parts) => parts.len(),
            Parts::Rows(rows) => rows.groups.rows.len(),
        }
    }

    /// `true` when there is nothing in it.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Each partition's key and rows, in partition order (pond-ts
    /// `toMap`).
    ///
    /// Cost: the partitions are copied out of the series on the first
    /// call that needs them (this one, [`PartitionedSeries::get`],
    /// [`PartitionedSeries::into_groups`] or [`PartitionedSeries::map`]):
    /// one copy of every column.
    pub fn iter(&self) -> impl ExactSizeIterator<Item = (&[Option<Value>], &TimeSeries)> {
        self.parts().iter().map(|(k, s)| (k.as_slice(), s))
    }

    /// The partition with this key, if there is one.
    pub fn get(&self, key: &[Option<Value>]) -> Option<&TimeSeries> {
        self.parts()
            .iter()
            .find(|(k, _)| k.as_slice() == key)
            .map(|(_, s)| s)
    }

    /// The partitions as owned `(key, series)` pairs.
    pub fn into_groups(self) -> Vec<(PartitionKey, TimeSeries)> {
        match self.parts {
            Parts::Made(parts) => parts,
            Parts::Rows(rows) => {
                rows.made();
                rows.made.into_inner().expect("just made")
            }
        }
    }

    /// The partitions as series, made on first use.
    fn parts(&self) -> &[(PartitionKey, TimeSeries)] {
        match &self.parts {
            Parts::Made(parts) => parts,
            Parts::Rows(rows) => rows.made(),
        }
    }

    /// All partitions as one series, sorted by key; rows with the same key
    /// keep partition order. Before any operation has run this is the
    /// original series, unchanged. An error if an operation gave different
    /// partitions different columns.
    pub fn collect(&self) -> Result<TimeSeries> {
        match (&self.whole, &self.parts) {
            (Some(whole), _) => Ok(whole.clone()),
            // Held as rows only after an operation that kept every row,
            // so the run order is the partition order.
            (None, Parts::Rows(rows)) => Ok(rows.collect()),
            (None, Parts::Made(parts)) => {
                let series: Vec<&TimeSeries> =
                    self.run_order.iter().map(|&i| &parts[i].1).collect();
                merge(&series, &self.empty)
            }
        }
    }

    /// Run `f` on each partition and stay partitioned. The partition
    /// columns must survive `f` (pond-ts throws otherwise). If `f` changes
    /// a partition column's values, the rows are split again by the new
    /// values, as pond-ts does.
    ///
    /// `f` runs on several cores with the `parallel` feature; each
    /// partition is still computed by one thread, so results are the same
    /// on any number. The first error, in partition order, is returned.
    pub fn map<F>(&self, f: F) -> Result<PartitionedSeries>
    where
        F: Fn(&TimeSeries) -> Result<TimeSeries> + Sync + Send,
    {
        let (parts, empty) = self.run(&f)?;
        let by_index: Vec<usize> = self
            .by
            .iter()
            .map(|c| empty.column_index("PartitionedSeries", c))
            .collect::<Result<_>>()?;
        // A step may turn a partition column into an array, which cannot
        // be a key (see `partition_by`).
        refuse_array_keys("PartitionedSeries", &empty, &by_index)?;
        // Every result must give the same columns, and keep the partition
        // columns (Codex review R06: positions found in the first result
        // were used unchecked on the rest, and a result missing one
        // panicked). The kept-key path below skips the merge, so check here.
        let full: Vec<&TimeSeries> = parts
            .iter()
            .map(|p| &p.1)
            .filter(|s| !s.is_empty())
            .collect();
        if full.len() > 1
            && let Some(why) = mismatch(&full)
        {
            return Err(PondError::InvalidData {
                call: "PartitionedSeries::map",
                message: format!(
                    "partitions came back with different columns ({why}); every partition must give the same columns"
                ),
            });
        }
        let mut unchanged = !self.is_empty();
        for (key, s) in &parts {
            let at: Vec<usize> = self
                .by
                .iter()
                .map(|c| s.column_index("PartitionedSeries::map", c))
                .collect::<Result<_>>()?;
            // With no partitions, any rows `f` made on the empty series
            // have no key yet, so they are always split.
            if unchanged && (at != by_index || !keeps_key(s, &at, key)) {
                unchanged = false;
            }
        }
        if !unchanged {
            // The values moved: split the merged rows again, as pond-ts
            // does, and collect gives those merged rows.
            let whole = merge(&series_of(&parts), &empty)?;
            return Ok(PartitionedSeries {
                by: self.by.clone(),
                parts: split(&whole, &by_index),
                run_order: Vec::new(),
                whole: Some(whole),
                empty,
            });
        }
        // What a merge and a fresh split would give: empty partitions gone,
        // the rest in the order their first rows now appear.
        let mut ran: Vec<Option<(PartitionKey, TimeSeries)>> = parts
            .into_iter()
            .filter(|(_, s)| !s.is_empty())
            .map(Some)
            .collect();
        let mut order: Vec<usize> = (0..ran.len()).collect();
        order.sort_by_key(|&i| first_key(&ran[i].as_ref().expect("not taken yet").1));
        let mut run_order = vec![0; ran.len()];
        for (at, &i) in order.iter().enumerate() {
            run_order[i] = at;
        }
        let parts = order
            .iter()
            .map(|&i| ran[i].take().expect("each taken once"))
            .collect();
        Ok(PartitionedSeries {
            by: self.by.clone(),
            parts: Parts::Made(parts),
            run_order,
            whole: None,
            empty,
        })
    }

    /// Run `f` on each partition and put the results back into one series
    /// (pond-ts `apply`). Unlike [`PartitionedSeries::map`], `f` may drop
    /// the partition columns.
    pub fn apply<F>(&self, f: F) -> Result<TimeSeries>
    where
        F: Fn(&TimeSeries) -> Result<TimeSeries> + Sync + Send,
    {
        let (parts, empty) = self.run(&f)?;
        merge(&series_of(&parts), &empty)
    }

    /// [`TimeSeries::diff`] on each partition.
    pub fn diff(&self, columns: &[&str]) -> Result<PartitionedSeries> {
        self.map_numbers(columns, |g| g.diff(columns))
    }

    /// [`TimeSeries::diff_with`] on each partition.
    pub fn diff_with(&self, columns: &[&str], options: Change) -> Result<PartitionedSeries> {
        self.map_change(columns, &options, |g| g.diff_with(columns, options.clone()))
    }

    /// [`TimeSeries::rate`] on each partition.
    pub fn rate(&self, columns: &[&str]) -> Result<PartitionedSeries> {
        self.map_numbers(columns, |g| g.rate(columns))
    }

    /// [`TimeSeries::rate_with`] on each partition.
    pub fn rate_with(&self, columns: &[&str], options: Change) -> Result<PartitionedSeries> {
        self.map_change(columns, &options, |g| g.rate_with(columns, options.clone()))
    }

    /// [`TimeSeries::pct_change`] on each partition.
    pub fn pct_change(&self, columns: &[&str]) -> Result<PartitionedSeries> {
        self.map_numbers(columns, |g| g.pct_change(columns))
    }

    /// [`TimeSeries::pct_change_with`] on each partition.
    pub fn pct_change_with(&self, columns: &[&str], options: Change) -> Result<PartitionedSeries> {
        self.map_change(columns, &options, |g| {
            g.pct_change_with(columns, options.clone())
        })
    }

    /// [`TimeSeries::shift`] on each partition.
    pub fn shift(&self, columns: &[&str], n: i64) -> Result<PartitionedSeries> {
        self.map_numbers(columns, |g| g.shift(columns, n))
    }

    /// [`TimeSeries::cumulative`] on each partition.
    pub fn cumulative<C: Into<crate::Cumulative> + Copy + Sync>(
        &self,
        spec: &[(&str, C)],
    ) -> Result<PartitionedSeries> {
        let columns: Vec<&str> = spec.iter().map(|&(name, _)| name).collect();
        self.map_numbers(&columns, |g| g.cumulative(spec))
    }

    /// [`TimeSeries::fill`] on each partition.
    pub fn fill(&self, spec: &[(&str, Fill)]) -> Result<PartitionedSeries> {
        let columns: Vec<&str> = spec.iter().map(|(name, _)| *name).collect();
        self.map_numbers(&columns, |g| g.fill(spec))
    }

    /// [`TimeSeries::fill_with`] on each partition.
    pub fn fill_with(
        &self,
        spec: &[(&str, Fill)],
        limits: &FillLimits,
    ) -> Result<PartitionedSeries> {
        let columns: Vec<&str> = spec.iter().map(|(name, _)| *name).collect();
        self.map_numbers(&columns, |g| g.fill_with(spec, limits))
    }

    /// [`TimeSeries::fill_all`] on each partition.
    pub fn fill_all(&self, fill: Fill) -> Result<PartitionedSeries> {
        self.fill_all_with(fill, &FillLimits::none())
    }

    /// [`TimeSeries::fill_all_with`] on each partition.
    pub fn fill_all_with(&self, fill: Fill, limits: &FillLimits) -> Result<PartitionedSeries> {
        let f = |g: &TimeSeries| g.fill_all_with(fill.clone(), limits);
        // The columns `fill_all` fills: those the strategy applies to.
        if let Parts::Rows(rows) = &self.parts {
            // `Hold` and `Bfill` find nothing to fill in a partition
            // column: within a partition it is all one value or all gaps.
            let constant = matches!(fill, Fill::Hold | Fill::Bfill);
            let filled: Vec<usize> = (0..rows.base.columns().len())
                .filter(|&c| {
                    let column = &rows.base.columns()[c];
                    crate::rowwise::fills(column, &fill)
                        && !(constant && self.by.iter().any(|b| b == column.name()))
                })
                .collect();
            if let Some(out) = self.on_numbers(&filled, &f) {
                return Ok(out);
            }
        }
        self.map(f)
    }

    /// [`TimeSeries::rolling`] on each partition. Only the outputs are
    /// kept, plus each partition column that no output is named after,
    /// carried through as a `first` output at the end (as pond-ts does), so
    /// the result stays partitioned.
    pub fn rolling(&self, window: &str, aggs: &[Agg]) -> Result<PartitionedSeries> {
        self.rolling_with(window, aggs, Rolling::default())
    }

    /// [`TimeSeries::rolling_with`] on each partition, carrying the
    /// partition columns as [`PartitionedSeries::rolling`] does. A row
    /// held back by [`Rolling::min_samples`] gets a gap there too, so, as
    /// in pond-ts, it moves to the partition with no value on the next
    /// split. With [`Rolling::append`] every source column is kept, the
    /// partition columns included, so nothing is carried.
    pub fn rolling_with(
        &self,
        window: &str,
        aggs: &[Agg],
        options: Rolling,
    ) -> Result<PartitionedSeries> {
        // A trailing window at least 1 ms long always holds its own row.
        let holds_row = options.alignment == Alignment::Trailing
            && parse_duration(window).is_ok_and(|ms| ms >= 1);
        if let Some(out) = self.roll_numbers(aggs, options, holds_row, |g, aggs| {
            g.rolling_with(window, aggs, options)
        }) {
            return Ok(out);
        }
        let aggs = self.rolling_outputs(aggs, options);
        self.map(|g| g.rolling_with(window, &aggs, options))
    }

    /// [`TimeSeries::rolling_rows`] on each partition, carrying the
    /// partition columns as [`PartitionedSeries::rolling_with`] does.
    pub fn rolling_rows(
        &self,
        rows: usize,
        aggs: &[Agg],
        options: Rolling,
    ) -> Result<PartitionedSeries> {
        // A row window always holds its own row.
        if let Some(out) = self.roll_numbers(aggs, options, true, |g, aggs| {
            g.rolling_rows(rows, aggs, options)
        }) {
            return Ok(out);
        }
        let aggs = self.rolling_outputs(aggs, options);
        self.map(|g| g.rolling_rows(rows, &aggs, options))
    }

    /// [`TimeSeries::rolling_over`] on each partition, carrying the
    /// partition columns as [`PartitionedSeries::aggregate`] does: a bucket
    /// whose window holds no rows, or fewer than
    /// [`RollingOver::min_samples`], gets a gap there.
    pub fn rolling_over(
        &self,
        sequence: &Sequence,
        window: &str,
        aggs: &[Agg],
        options: RollingOver,
    ) -> Result<PartitionedSeries> {
        let aggs = self.with_partition_outputs(aggs);
        self.map(|g| g.rolling_over(sequence, window, &aggs, options))
    }

    /// [`TimeSeries::aggregate`] on each partition, carrying the partition
    /// columns as [`PartitionedSeries::rolling`] does. A bucket with no rows
    /// gets a gap there, so pond-ts, and so pond-rs, moves such rows to the
    /// partition with no value on the next split.
    pub fn aggregate(&self, sequence: &Sequence, aggs: &[Agg]) -> Result<PartitionedSeries> {
        let aggs = self.with_partition_outputs(aggs);
        self.map(|g| g.aggregate(sequence, &aggs))
    }

    /// [`TimeSeries::align`] on each partition. A bucket before a
    /// partition's first row gets a gap in the partition columns too, so,
    /// as in pond-ts, such rows move to the partition with no value.
    pub fn align(&self, sequence: &Sequence, options: Align) -> Result<PartitionedSeries> {
        self.map(|g| g.align(sequence, options))
    }

    /// [`TimeSeries::materialize`] on each partition, with the partition
    /// columns filled in on empty buckets (pond-ts does the same), so every
    /// row stays in its partition.
    pub fn materialize(
        &self,
        sequence: &Sequence,
        options: Materialize,
    ) -> Result<PartitionedSeries> {
        let by = self.by.clone();
        self.map(move |g| {
            let out = g.materialize(sequence, options)?;
            if g.is_empty() {
                return Ok(out);
            }
            // Every row of a partition holds its key, so the key's column
            // is the first row's value on every output row.
            let first = vec![Some(0); out.len()];
            let mut columns = out.columns().to_vec();
            for name in &by {
                let at = out.column_index("materialize", name)?;
                let source = g.column(name)?;
                columns[at] = Column::from_data(name.clone(), source.data().take(&first), false);
            }
            Ok(out.with_value_columns(columns))
        })
    }

    /// [`TimeSeries::dedupe`] on each partition: rows are duplicates when
    /// they share the key and the partition values.
    pub fn dedupe(&self, keep: Keep) -> Result<PartitionedSeries> {
        self.map(|g| g.dedupe(keep.clone()))
    }

    /// [`TimeSeries::smooth`] on each partition: each one is smoothed on
    /// its own rows only.
    pub fn smooth(&self, column: &str, smooth: &Smooth) -> Result<PartitionedSeries> {
        self.map(|g| g.smooth(column, smooth))
    }

    /// [`TimeSeries::baseline`] on each partition.
    pub fn baseline(
        &self,
        column: &str,
        window: &str,
        sigma: f64,
        options: Rolling,
    ) -> Result<PartitionedSeries> {
        self.map(|g| g.baseline(column, window, sigma, options))
    }

    /// [`TimeSeries::baseline_named`] on each partition.
    pub fn baseline_named(
        &self,
        column: &str,
        window: &str,
        sigma: f64,
        options: Rolling,
        names: [&str; 4],
    ) -> Result<PartitionedSeries> {
        self.map(|g| g.baseline_named(column, window, sigma, options, names))
    }

    /// [`TimeSeries::outliers`] on each partition: a row is an outlier
    /// against its own partition's band. A partition left with no rows is
    /// dropped.
    pub fn outliers(
        &self,
        column: &str,
        window: &str,
        sigma: f64,
        options: Rolling,
    ) -> Result<PartitionedSeries> {
        self.map(|g| g.outliers(column, window, sigma, options))
    }

    /// [`TimeSeries::scan`] on each partition: every partition starts from
    /// its own copy of `init`, and `step`'s row index counts from 0 within
    /// the partition. `step` is `Fn` (not `FnMut`) because partitions may
    /// run on several cores.
    pub fn scan<A>(
        &self,
        column: &str,
        init: A,
        step: impl Fn(A, f64, usize) -> (A, f64) + Sync + Send,
    ) -> Result<PartitionedSeries>
    where
        A: Clone + Sync + Send,
    {
        self.map(|g| g.scan(column, init.clone(), &step))
    }

    /// [`TimeSeries::scan_to`] on each partition, as
    /// [`PartitionedSeries::scan`].
    pub fn scan_to<A>(
        &self,
        column: &str,
        output: &str,
        init: A,
        step: impl Fn(A, f64, usize) -> (A, f64) + Sync + Send,
    ) -> Result<PartitionedSeries>
    where
        A: Clone + Sync + Send,
    {
        self.map(|g| g.scan_to(column, output, init.clone(), &step))
    }

    /// [`TimeSeries::sample`] on each partition: a stride counts within
    /// each partition, and a reservoir samples each one separately. Each
    /// partition's reservoir gets its own seed, made from `seed` and the
    /// partition's place in partition order, so partitions pick
    /// independently and the same input and seed always give the same
    /// rows (pond-ts draws from `Math.random`, so its picks differ each
    /// run).
    pub fn sample(&self, how: Sample) -> Result<PartitionedSeries> {
        let Sample::Reservoir { size, seed } = how else {
            return self.map(|g| g.sample(how));
        };
        // `map` hands each partition's own series to the closure, so its
        // address finds its place.
        let place: HashMap<usize, u64> = self
            .parts()
            .iter()
            .enumerate()
            .map(|(i, (_, g))| (g as *const TimeSeries as usize, i as u64))
            .collect();
        self.map(|g| {
            let i = place
                .get(&(g as *const TimeSeries as usize))
                .copied()
                .unwrap_or(0);
            let seed = seed ^ i.wrapping_mul(0x9E37_79B9_7F4A_7C15);
            g.sample(Sample::Reservoir { size, seed })
        })
    }

    /// [`PartitionedSeries::map_numbers`] for `diff`, `rate` and
    /// `pct_change` with options: dropping the first row does not keep
    /// every row, so that goes straight to [`PartitionedSeries::map`].
    fn map_change<F>(&self, columns: &[&str], options: &Change, f: F) -> Result<PartitionedSeries>
    where
        F: Fn(&TimeSeries) -> Result<TimeSeries> + Sync + Send,
    {
        if options.drops_first() {
            self.map(f)
        } else {
            self.map_numbers(columns, f)
        }
    }

    /// `f` on each partition, for an operation that keeps every row and
    /// every column and only writes to the columns named (or adds new
    /// ones): the short cut of [`PartitionedSeries::on_numbers`] when it
    /// applies, otherwise [`PartitionedSeries::map`]. The result is the
    /// same either way.
    fn map_numbers<F>(&self, columns: &[&str], f: F) -> Result<PartitionedSeries>
    where
        F: Fn(&TimeSeries) -> Result<TimeSeries> + Sync + Send,
    {
        if let Parts::Rows(rows) = &self.parts {
            let named: Option<Vec<usize>> = columns
                .iter()
                .map(|name| rows.base.columns().iter().position(|c| c.name() == *name))
                .collect();
            if let Some(mut named) = named {
                named.sort_unstable();
                named.dedup();
                if let Some(out) = self.on_numbers(&named, &f) {
                    return Ok(out);
                }
            }
        }
        self.map(f)
    }

    /// `f` on each partition without building the partitions: `f` sees
    /// each partition's rows of only the columns at `columns` (ascending),
    /// and its results are written back to the rows they came from, the
    /// other columns shared with the source. For an `f` that reads and
    /// writes nothing but those columns and the key, this gives what
    /// [`PartitionedSeries::map`] gives.
    ///
    /// `None` (use `map`) unless the partitions are still held as rows,
    /// the columns are all number columns and none is a partition column,
    /// and `f` succeeds on every partition, keeps the rows, and gives back
    /// those columns (as numbers, with the same required flags in every
    /// partition) plus, possibly, new number columns after them. So an
    /// error always comes from `map`, worded for the whole series.
    ///
    /// Cost: one copy of the key and of the columns at `columns`, `f`,
    /// and one write of each result column. No other column is touched.
    fn on_numbers<F>(&self, columns: &[usize], f: &F) -> Option<PartitionedSeries>
    where
        F: Fn(&TimeSeries) -> Result<TimeSeries> + Sync + Send,
    {
        let Parts::Rows(rows) = &self.parts else {
            return None;
        };
        let base = &rows.base;
        let usable = |c: &usize| {
            let column = &base.columns()[*c];
            column.kind() == ColumnKind::Number && !self.by.iter().any(|b| b == column.name())
        };
        if rows.groups.rows.is_empty() || columns.is_empty() || !columns.iter().all(usable) {
            return None;
        }
        let narrow =
            base.with_value_columns(columns.iter().map(|&c| base.columns()[c].clone()).collect());
        let outs = rows.groups.run(&narrow, f)?;
        let head = outs[0].columns();
        let kept = head.len() >= columns.len()
            && head
                .iter()
                .zip(narrow.columns())
                .all(|(a, b)| a.name() == b.name());
        // A new column may not take a name the narrow series did not show
        // `f`: on the whole series that is an error.
        let clash = head[columns.len().min(head.len())..].iter().any(|new| {
            new.name() == base.key_name() || base.columns().iter().any(|c| c.name() == new.name())
        });
        if !kept || clash || !same_number_columns(&outs) {
            return None;
        }
        let mut written = rows.groups.scatter(&outs, base.len()).into_iter();
        let mut all = base.columns().to_vec();
        for &c in columns {
            all[c] = written.next().expect("one per column");
        }
        all.extend(written);
        // The narrow columns, then the new ones after every base column.
        let new = (columns.len()..head.len()).map(|k| base.columns().len() + k - columns.len());
        let places = columns.iter().copied().chain(new).zip(0..).collect();
        Some(self.kept(rows, base.with_value_columns(all), outs, places))
    }

    /// The row-by-row rolling call `f(partition, aggs)` without building
    /// the partitions, as [`PartitionedSeries::on_numbers`]: `f` sees only
    /// the number columns `aggs` read. The partition columns are not
    /// rolled: `first` of a partition column is the partition's own value
    /// on every row whose window holds a row and at least
    /// [`Rolling::min_samples`] rows, so those outputs are the source
    /// columns, with gaps on the other rows. `holds_row` says every window
    /// holds its own row; otherwise a count of the rows in each window is
    /// rolled as well to find out.
    ///
    /// `None` (use `map`) unless the partitions are still held as rows,
    /// the partition columns are text or true/false and no output is
    /// named after one, every source is a number column under a reducer
    /// that gives numbers, the call is not appending, and `f` succeeds on
    /// every partition.
    fn roll_numbers<F>(
        &self,
        aggs: &[Agg],
        options: Rolling,
        holds_row: bool,
        f: F,
    ) -> Option<PartitionedSeries>
    where
        F: Fn(&TimeSeries, &[Agg]) -> Result<TimeSeries> + Sync + Send,
    {
        let Parts::Rows(rows) = &self.parts else {
            return None;
        };
        let base = &rows.base;
        if rows.groups.rows.is_empty() || options.append {
            return None;
        }
        let at = |name: &str| base.columns().iter().position(|c| c.name() == name);
        let by: Vec<usize> = self.by.iter().map(|b| at(b)).collect::<Option<_>>()?;
        let carried = |c: &usize| {
            matches!(
                base.columns()[*c].kind(),
                ColumnKind::String | ColumnKind::Boolean
            )
        };
        if !by.iter().all(carried) || aggs.iter().any(|a| self.by.contains(&a.output)) {
            return None;
        }
        let mut sources = Vec::with_capacity(aggs.len());
        for agg in aggs {
            let c = at(&agg.source)?;
            if base.columns()[c].kind() != ColumnKind::Number || agg.reducer.gives_list() {
                return None;
            }
            sources.push(c);
        }
        sources.sort_unstable();
        sources.dedup();
        let mut columns: Vec<Column> = sources.iter().map(|&c| base.columns()[c].clone()).collect();
        // With the partition outputs after them the entries are never all
        // shorthand, so the outputs keep the order given.
        let mut narrow_aggs: Vec<Agg> = aggs
            .iter()
            .map(|a| Agg {
                shorthand: false,
                ..a.clone()
            })
            .collect();
        // Every window holds its own row, so only a minimum above one row
        // can hold a row back.
        let counted = !(holds_row && options.min_samples <= 1);
        if counted {
            // A column of ones under a name nothing else has: its rolling
            // count is the number of rows in each window.
            let mut name = String::from("rows");
            while name == base.key_name()
                || at(&name).is_some()
                || aggs.iter().any(|a| a.output == name)
            {
                name.push('_');
            }
            columns.push(Column::from_data(name.clone(), vec![1.0; base.len()], true));
            narrow_aggs.push(Agg::new(name.clone(), name, Reducer::Count));
        }
        let narrow = base.with_value_columns(columns);
        let outs = rows
            .groups
            .run(&narrow, &|g: &TimeSeries| f(g, &narrow_aggs))?;
        let head = outs[0].columns();
        let as_asked = head.len() == narrow_aggs.len()
            && head
                .iter()
                .zip(&narrow_aggs)
                .all(|(c, a)| c.name() == a.output);
        if !as_asked || !same_number_columns(&outs) {
            return None;
        }
        let mut written = rows.groups.scatter(&outs, base.len());
        // Rows whose window is empty or under the minimum: a gap in every
        // output, the partition columns included.
        let held: Option<Vec<bool>> = counted
            .then(|| written.pop().expect("the count is the last output"))
            .map(|count| {
                let ColumnData::Number(count) = count.data() else {
                    unreachable!("checked by same_number_columns");
                };
                count
                    .values()
                    .iter()
                    .map(|&n| !(n.is_finite() && n > 0.0))
                    .collect::<Vec<bool>>()
            })
            .filter(|held| held.contains(&true));
        let showing: Option<Vec<Option<usize>>> = held.as_ref().map(|held| {
            held.iter()
                .enumerate()
                .map(|(i, &h)| (!h).then_some(i))
                .collect()
        });
        for &c in &by {
            let column = &base.columns()[c];
            let data = match &showing {
                None => column.data().clone(),
                Some(showing) => column.data().take(showing),
            };
            written.push(Column::from_data(column.name().to_string(), data, false));
        }
        let rolled = base.with_value_columns(written);
        // A partition with a value in its key loses that value on a row
        // held back: `map` then merges and splits again.
        let moved =
            held.as_ref().is_some_and(|held| {
                let groups = &rows.groups;
                groups.rows.iter().zip(&groups.keys).any(|(at, key)| {
                    key.iter().any(Option::is_some) && at.iter().any(|&row| held[row])
                })
            });
        if !moved {
            // The outputs asked for come first, in both.
            let places = (0..aggs.len()).map(|k| (k, k)).collect();
            return Some(self.kept(rows, rolled, outs, places));
        }
        let empty = rolled.row_range(0..0);
        let whole = Rows::new(rolled, Arc::clone(&rows.groups)).collect();
        let by: Vec<usize> = (aggs.len()..aggs.len() + by.len()).collect();
        Some(PartitionedSeries {
            by: self.by.clone(),
            parts: split(&whole, &by),
            run_order: Vec::new(),
            whole: Some(whole),
            empty,
        })
    }

    /// The same partitions over `base`: the result of an operation that
    /// kept every row and left the partition columns as they were. What
    /// [`PartitionedSeries::map`] makes of such a result: no partition is
    /// empty, and they are already in first-row order. `parts` are the
    /// operation's per-partition results and `columns` says which column
    /// of `base` each of their columns was written to.
    fn kept(
        &self,
        rows: &Rows,
        base: TimeSeries,
        parts: Vec<TimeSeries>,
        columns: Vec<(usize, usize)>,
    ) -> PartitionedSeries {
        PartitionedSeries {
            by: self.by.clone(),
            run_order: (0..rows.groups.rows.len()).collect(),
            whole: None,
            empty: base.row_range(0..0),
            parts: Parts::Rows(Rows {
                computed: Some(Arc::new(Computed { parts, columns })),
                ..Rows::new(base, Arc::clone(&rows.groups))
            }),
        }
    }

    /// The aggs for a rolling call: as given when appending (the partition
    /// columns are kept anyway), otherwise with the partition columns
    /// carried as outputs.
    fn rolling_outputs(&self, aggs: &[Agg], options: Rolling) -> Vec<Agg> {
        if options.append {
            aggs.to_vec()
        } else {
            self.with_partition_outputs(aggs)
        }
    }

    fn with_partition_outputs(&self, aggs: &[Agg]) -> Vec<Agg> {
        let mut out = aggs.to_vec();
        for col in &self.by {
            if !aggs.iter().any(|a| &a.output == col) && !out.iter().any(|a| &a.output == col) {
                out.push(Agg::new(col.clone(), col.clone(), Reducer::First));
            }
        }
        out
    }

    /// `f` on every partition (or on the empty series when there are
    /// none), and a zero-row series with the result's columns.
    fn run<F>(&self, f: &F) -> Result<(Vec<(PartitionKey, TimeSeries)>, TimeSeries)>
    where
        F: Fn(&TimeSeries) -> Result<TimeSeries> + Sync + Send,
    {
        if self.is_empty() {
            let out = f(&self.empty)?;
            // pond-ts gives the operation's result on the empty series; it
            // has no rows to split, but keep any it made.
            let empty = out.row_range(0..0);
            let parts = if out.is_empty() {
                Vec::new()
            } else {
                vec![(Vec::new(), out)]
            };
            return Ok((parts, empty));
        }
        let made = self.parts();
        let results = par::map(made, |(_, s)| f(s));
        let mut parts = Vec::with_capacity(results.len());
        for ((key, _), out) in made.iter().zip(results) {
            parts.push((key.clone(), out?));
        }
        let empty = parts[0].1.row_range(0..0);
        Ok((parts, empty))
    }
}

/// Refuse an array column among the partition columns `by`. pond-ts keys
/// an array by its text (`String(arr)`), so `['a,b']` and `['a', 'b']`
/// would share a partition.
fn refuse_array_keys(call: &'static str, series: &TimeSeries, by: &[usize]) -> Result<()> {
    match by
        .iter()
        .find(|&&c| series.columns()[c].kind() == ColumnKind::Array)
    {
        Some(&c) => Err(PondError::WrongKind {
            call,
            column: series.columns()[c].name().to_string(),
            kind: "array",
            reason: "partitioning by an array column is not supported".into(),
        }),
        None => Ok(()),
    }
}

/// The rows of `series` grouped by the values of the columns at `by`, in
/// first-row order. Cost: one pass over the partition columns; no row is
/// copied.
fn split(series: &TimeSeries, by: &[usize]) -> Parts {
    // One number per row that is equal exactly when the rows' values in
    // every partition column are: the first column's value numbers, then
    // each further column folded in pairwise.
    let mut ids: Vec<u32> = Vec::new();
    for (at, &c) in by.iter().enumerate() {
        let next = value_ids(series.columns()[c].data());
        ids = if at == 0 {
            next
        } else {
            let mut pairs: HashMap<(u32, u32), u32> = HashMap::new();
            ids.iter()
                .zip(&next)
                .map(|(&a, &b)| {
                    let id = pairs.len() as u32;
                    *pairs.entry((a, b)).or_insert(id)
                })
                .collect()
        };
    }
    // The numbers are dense, so renumbering into first-row order is a
    // lookup table, not a hash.
    let mut number = vec![u32::MAX; ids.iter().max().map_or(0, |&m| m as usize + 1)];
    let mut rows: Vec<Vec<usize>> = Vec::new();
    let mut part = ids;
    for (i, id) in part.iter_mut().enumerate() {
        let slot = &mut number[*id as usize];
        if *slot == u32::MAX {
            *slot = rows.len() as u32;
            rows.push(Vec::new());
        }
        rows[*slot as usize].push(i);
        *id = *slot;
    }
    let keys = rows
        .iter()
        .map(|rows| {
            by.iter()
                .map(|&c| value_at(series.columns()[c].data(), rows[0]))
                .collect()
        })
        .collect();
    Parts::Rows(Rows::new(
        series.clone(),
        Arc::new(Groups { keys, rows, part }),
    ))
}

/// The hash for numbering a partition column's values: a multiply and a
/// rotate per 8 bytes and a mix at the end, started from a seed.
/// `HashMap`'s default hash is built to hold up against keys chosen to
/// collide and costs several times as much on short keys, and here it is
/// run once per row. The seed is drawn per call from the standard
/// library's random state, so which keys collide is still not
/// predictable from outside. The numbers given out do not depend on it.
#[derive(Clone)]
struct Seeded(u64);

impl Seeded {
    fn new() -> Self {
        Seeded(std::collections::hash_map::RandomState::new().hash_one(0u8))
    }
}

impl BuildHasher for Seeded {
    type Hasher = Mixer;
    fn build_hasher(&self) -> Mixer {
        Mixer(self.0)
    }
}

struct Mixer(u64);

impl Mixer {
    #[inline]
    fn word(&mut self, w: u64) {
        self.0 = (self.0.rotate_left(5) ^ w).wrapping_mul(0x517c_c1b7_2722_0a95);
    }
}

impl Hasher for Mixer {
    /// Whole 8-byte words, then the last 8 bytes again if any are left
    /// over. Under 8 bytes: the first and last 4 (overlapping), or the
    /// first, middle and last byte of 1 to 3. Fixed-size reads, so no
    /// call to copy a short tail. Two texts that read the same here are
    /// still told apart by the table's own comparison.
    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        let n = bytes.len();
        let four = |at: usize| {
            u64::from(u32::from_le_bytes(
                bytes[at..at + 4].try_into().expect("4 bytes"),
            ))
        };
        if n >= 8 {
            let mut chunks = bytes.chunks_exact(8);
            for chunk in &mut chunks {
                self.word(u64::from_le_bytes(chunk.try_into().expect("8 bytes")));
            }
            if !chunks.remainder().is_empty() {
                self.word(u64::from_le_bytes(
                    bytes[n - 8..].try_into().expect("8 bytes"),
                ));
            }
        } else if n >= 4 {
            self.word(four(0) | four(n - 4) << 32);
        } else if n > 0 {
            let (a, b, c) = (bytes[0], bytes[n / 2], bytes[n - 1]);
            self.word(u64::from(a) | u64::from(b) << 8 | u64::from(c) << 16);
        }
        self.word(n as u64);
    }
    #[inline]
    fn write_u8(&mut self, v: u8) {
        self.word(u64::from(v));
    }
    #[inline]
    fn write_u32(&mut self, v: u32) {
        self.word(u64::from(v));
    }
    #[inline]
    fn write_u64(&mut self, v: u64) {
        self.word(v);
    }
    #[inline]
    fn write_u128(&mut self, v: u128) {
        self.word(v as u64);
        self.word((v >> 64) as u64);
    }
    #[inline]
    fn write_usize(&mut self, v: usize) {
        self.word(v as u64);
    }
    /// The multiply leaves the low bits depending on the low bits of the
    /// last word only; the table is indexed by them, so mix the high bits
    /// down (the 64-bit finalizer of MurmurHash3).
    #[inline]
    fn finish(&self) -> u64 {
        let mut h = self.0;
        h ^= h >> 33;
        h = h.wrapping_mul(0xff51_afd7_ed55_8ccd);
        h ^= h >> 33;
        h = h.wrapping_mul(0xc4ce_b9fe_1a85_ec53);
        h ^ (h >> 33)
    }
}

/// A small integer per row that is equal exactly when the values are
/// (a gap is 0).
fn value_ids(data: &ColumnData) -> Vec<u32> {
    /// Text hashed as its bytes alone (`str` adds an end marker, a
    /// second round of the hash).
    #[derive(Clone, Copy, PartialEq, Eq)]
    struct Text<'a>(&'a str);
    impl Hash for Text<'_> {
        #[inline]
        fn hash<H: Hasher>(&self, state: &mut H) {
            state.write(self.0.as_bytes());
        }
    }
    fn ids<K: Hash + Eq + Copy>(values: impl Iterator<Item = Option<K>>) -> Vec<u32> {
        let mut seen: HashMap<K, u32, Seeded> = HashMap::with_hasher(Seeded::new());
        // Rows of one entity often come in runs: then the value of the
        // row before needs no lookup. Tried on the first rows, and kept up
        // only if it found a repeat on at least one in eight of them.
        const TRIAL: usize = 1024;
        let mut last: Option<(K, u32)> = None;
        let (mut tries, mut repeats, mut runs) = (0usize, 0usize, true);
        values
            .map(|v| {
                let Some(v) = v else { return 0 };
                if runs {
                    if let Some((same, id)) = last
                        && same == v
                    {
                        repeats += 1;
                        return id;
                    }
                    tries += 1;
                    runs = tries < TRIAL || repeats >= tries / 8;
                }
                let next = seen.len() as u32 + 1;
                let id = *seen.entry(v).or_insert(next);
                last = Some((v, id));
                id
            })
            .collect()
    }
    match data {
        // `+ 0.0` turns -0 into 0, so they are one partition.
        ColumnData::Number(c) => ids(c.iter().map(|v| v.map(|v| (v + 0.0).to_bits()))),
        ColumnData::Decimal(c) => ids(c.iter().map(|v| v.map(|d| d.value))),
        ColumnData::String(c) => ids(c.iter().map(|v| v.map(Text))),
        ColumnData::Boolean(c) => ids(c.iter()),
        ColumnData::Array(_) => unreachable!("partition_by refuses array columns"),
    }
}

fn value_at(data: &ColumnData, i: usize) -> Option<Value> {
    match data {
        ColumnData::Number(c) => c.get(i).map(|v| Value::Number(v + 0.0)),
        ColumnData::Decimal(c) => c.get(i).map(Value::Decimal),
        ColumnData::String(c) => c.get(i).map(|v| Value::String(v.to_string())),
        ColumnData::Boolean(c) => c.get(i).map(Value::Boolean),
        ColumnData::Array(_) => unreachable!("partition_by refuses array columns"),
    }
}

/// True when every row of `series` still has `key` in the partition
/// columns at `by`.
fn keeps_key(series: &TimeSeries, by: &[usize], key: &[Option<Value>]) -> bool {
    by.iter().zip(key).all(|(&c, want)| {
        let n = series.len();
        match (series.columns()[c].data(), want) {
            // `==` on numbers: -0 and 0 are one key.
            (ColumnData::Number(c), Some(Value::Number(v))) => (0..n).all(|i| c.get(i) == Some(*v)),
            (ColumnData::Decimal(c), Some(Value::Decimal(v))) => {
                (0..n).all(|i| c.get(i) == Some(*v))
            }
            (ColumnData::String(c), Some(Value::String(v))) => {
                (0..n).all(|i| c.get(i) == Some(v.as_str()))
            }
            (ColumnData::Boolean(c), Some(Value::Boolean(v))) => {
                (0..n).all(|i| c.get(i) == Some(*v))
            }
            (data, None) => data.missing_count() == n,
            _ => false,
        }
    })
}

fn first_key(series: &TimeSeries) -> (i64, i64) {
    let key = series.key();
    (key.begin()[0], key.end().map_or(0, |e| e[0]))
}

fn series_of(parts: &[(PartitionKey, TimeSeries)]) -> Vec<&TimeSeries> {
    parts.iter().map(|(_, s)| s).collect()
}

/// The partitions as one series: rows sorted by key, ties in partition
/// order then row order (pond-ts `TimeSeries.concat`).
fn merge(series: &[&TimeSeries], empty: &TimeSeries) -> Result<TimeSeries> {
    let series: Vec<&TimeSeries> = series.iter().copied().filter(|s| !s.is_empty()).collect();
    let Some(head) = series.first() else {
        return Ok(empty.clone());
    };
    if series.len() == 1 {
        return Ok((*head).clone());
    }
    if let Some(why) = mismatch(&series) {
        return Err(PondError::InvalidData {
            call: "PartitionedSeries",
            message: format!(
                "partitions came back with different columns ({why}); every partition must give the same columns"
            ),
        });
    }
    Ok(stack(head.name(), &series))
}

/// Why `series` cannot be stacked: the first difference from the first
/// series in key, column names, kinds, decimal scales or label kinds.
fn mismatch(series: &[&TimeSeries]) -> Option<String> {
    let head = series[0];
    for (i, s) in series.iter().enumerate().skip(1) {
        if s.key_name() != head.key_name() || s.key().kind() != head.key().kind() {
            return Some(format!(
                "series {i} is keyed by '{}' ({:?}), series 0 by '{}' ({:?})",
                s.key_name(),
                s.key().kind(),
                head.key_name(),
                head.key().kind()
            ));
        }
        if let (Key::Interval(a), Key::Interval(b)) = (head.key(), s.key())
            && std::mem::discriminant(&a.label) != std::mem::discriminant(&b.label)
        {
            return Some(format!(
                "series {i} has {} interval labels, series 0 {}",
                label_kind(&b.label),
                label_kind(&a.label)
            ));
        }
        if s.columns().len() != head.columns().len() {
            return Some(format!(
                "series {i} has {} columns, series 0 has {}",
                s.columns().len(),
                head.columns().len()
            ));
        }
        for (c, (a, b)) in head.columns().iter().zip(s.columns()).enumerate() {
            if a.name() != b.name() || a.kind() != b.kind() {
                return Some(format!(
                    "column {c} is '{}' ({:?}) in series {i} but '{}' ({:?}) in series 0",
                    b.name(),
                    b.kind(),
                    a.name(),
                    a.kind()
                ));
            }
            if let (ColumnData::Decimal(x), ColumnData::Decimal(y)) = (a.data(), b.data())
                && x.scale() != y.scale()
            {
                return Some(format!(
                    "decimal column '{}' has scale {} in series {i} but {} in series 0",
                    a.name(),
                    y.scale(),
                    x.scale()
                ));
            }
        }
    }
    None
}

fn label_kind(labels: &Labels) -> &'static str {
    match labels {
        Labels::Number(_) => "number",
        Labels::String(_) => "text",
    }
}

/// `series` (already checked by [`mismatch`]) as one series named `name`:
/// rows sorted by key, ties in series order then row order. A column is
/// required only when it is required in every input.
fn stack(name: &str, series: &[&TimeSeries]) -> TimeSeries {
    let head = series[0];
    let picks = merge_order(series);
    let keys: Vec<&Key> = series.iter().map(|s| s.key()).collect();
    let key = Key::gather(&keys, &picks);
    let columns: Vec<usize> = (0..head.columns().len()).collect();
    let columns = par::map(&columns, |&c| {
        let sources: Vec<&ColumnData> = series.iter().map(|s| s.columns()[c].data()).collect();
        let required = series.iter().all(|s| s.columns()[c].is_required());
        Column::from_data(
            head.columns()[c].name().to_string(),
            ColumnData::gather(&sources, &picks),
            required,
        )
    });
    TimeSeries::from_parts(name.to_string(), head.key_name().to_string(), key, columns)
}

impl TimeSeries {
    /// The rows of several series as one, sorted by key (pond-ts
    /// `TimeSeries.concat`): rows that share a key keep the order of
    /// `series`, then their order within it. The result takes the first
    /// series' name.
    ///
    /// Every series must have the same key (name and kind) and the same
    /// columns in the same order (name and kind; decimals also the same
    /// scale, interval labels the same kind). A column is required in the
    /// result only when it is required in every input.
    ///
    /// ```
    /// # use pond_rs::{Column, TimeSeries};
    /// let a = TimeSeries::new("cpu", vec![0, 2000], vec![Column::required("v", vec![1.0, 3.0])])?;
    /// let b = TimeSeries::new("cpu", vec![1000, 2000], vec![Column::required("v", vec![2.0, 4.0])])?;
    /// let both = TimeSeries::concat(&[&a, &b])?;
    /// assert_eq!(both.key().begin(), &[0, 1000, 2000, 2000]);
    /// assert_eq!(both.column("v")?.numbers()?.values(), &[1.0, 2.0, 3.0, 4.0]);
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn concat(series: &[&TimeSeries]) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::concat";
        let Some(head) = series.first() else {
            return Err(PondError::InvalidData {
                call: CALL,
                message: "needs at least one series".into(),
            });
        };
        if let Some(why) = mismatch(series) {
            return Err(PondError::InvalidData {
                call: CALL,
                message: format!("the series do not match: {why}"),
            });
        }
        if series.len() == 1 {
            return Ok((*head).clone());
        }
        Ok(stack(head.name(), series))
    }
}

/// The order to take rows in: by key (begin, then end), rows with the same
/// key in partition order, then row order. That is a stable sort of the
/// partitions laid one after another, done as a radix sort on the key
/// numbers (each pass is a stable counting sort), which costs a few passes
/// over the rows instead of a comparison sort's log N.
fn merge_order(series: &[&TimeSeries]) -> Vec<(u32, u32)> {
    let total: usize = series.iter().map(|s| s.len()).sum();
    let mut picks: Vec<(u32, u32)> = Vec::with_capacity(total);
    for (p, s) in series.iter().enumerate() {
        picks.extend((0..s.len() as u32).map(|r| (p as u32, r)));
    }
    // Flipping the sign bit makes unsigned order match signed order.
    let flat = |part: &dyn Fn(&Key) -> Option<&[i64]>| -> Option<Vec<u64>> {
        let mut out = Vec::with_capacity(total);
        for s in series {
            out.extend(part(s.key())?.iter().map(|&v| (v as u64) ^ (1 << 63)));
        }
        Some(out)
    };
    let mut order: Vec<u32> = (0..total as u32).collect();
    // Least significant first: end, then begin.
    if let Some(end) = flat(&|k| k.end()) {
        radix_sort(&mut order, &end);
    }
    radix_sort(
        &mut order,
        &flat(&|k| Some(k.begin())).expect("every key has a begin"),
    );
    order.into_iter().map(|i| picks[i as usize]).collect()
}

/// Stable sort of `order` (indexes into `keys`) by `keys`, 16 bits at a
/// time, skipping the 16-bit digits where every key is the same.
fn radix_sort(order: &mut Vec<u32>, keys: &[u64]) {
    let Some(&first) = keys.first() else {
        return;
    };
    let varying = keys.iter().fold(0, |acc, &k| acc | (k ^ first));
    let mut buf = vec![0u32; order.len()];
    for shift in (0..64).step_by(16) {
        if (varying >> shift) & 0xFFFF == 0 {
            continue;
        }
        let digit = |i: u32| ((keys[i as usize] >> shift) & 0xFFFF) as usize;
        let mut start = vec![0usize; 1 << 16];
        for &i in order.iter() {
            start[digit(i)] += 1;
        }
        let mut at = 0;
        for slot in start.iter_mut() {
            let count = *slot;
            *slot = at;
            at += count;
        }
        for &i in order.iter() {
            let d = digit(i);
            buf[start[d]] = i;
            start[d] += 1;
        }
        std::mem::swap(order, &mut buf);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::series::{MAX_TIME_MS, TimeRangeKeys};

    fn hosts() -> TimeSeries {
        TimeSeries::new(
            "h",
            vec![0, 0, 1000, 1000, 2000],
            vec![
                Column::optional(
                    "host",
                    vec![Some("b"), Some("a"), Some("a"), Some("b"), None],
                ),
                Column::optional(
                    "v",
                    vec![Some(1.0), Some(10.0), Some(12.0), None, Some(5.0)],
                ),
            ],
        )
        .unwrap()
    }

    #[test]
    fn splits_in_first_row_order_with_a_gap_partition() {
        let p = hosts().partition_by(&["host"]).unwrap();
        let keys: Vec<_> = p.iter().map(|(k, s)| (k.to_vec(), s.len())).collect();
        assert_eq!(
            keys,
            vec![
                (vec![Some(Value::String("b".into()))], 2),
                (vec![Some(Value::String("a".into()))], 2),
                (vec![None], 1),
            ]
        );
        // No operation yet: collect gives the input back as it was.
        assert_eq!(p.collect().unwrap(), hosts());
    }

    #[test]
    fn map_with_a_missing_partition_column_is_an_error() {
        // Codex review R06: column positions came from the first result
        // and were used unchecked on the rest, which panicked.
        let p = hosts().partition_by(&["host"]).unwrap();
        let first_keeps = |g: &TimeSeries| {
            if g.column("host").unwrap().strings().unwrap().get(0) == Some("b") {
                g.select(&["v", "host"])
            } else {
                g.select(&["v"])
            }
        };
        assert!(p.map(first_keeps).is_err());
        // Dropping the partition column everywhere is refused as before.
        assert!(p.map(|g| g.select(&["v"])).is_err());
    }

    #[test]
    fn merge_puts_ties_in_partition_order() {
        let p = hosts().partition_by(&["host"]).unwrap();
        let out = p.map(|g| Ok(g.clone())).unwrap().collect().unwrap();
        let hosts: Vec<_> = out
            .column("host")
            .unwrap()
            .strings()
            .unwrap()
            .iter()
            .collect();
        // At t=1000 the input has a then b; partition order is b then a.
        assert_eq!(
            hosts,
            vec![Some("b"), Some("a"), Some("b"), Some("a"), None]
        );
    }

    #[test]
    fn merge_order_is_a_stable_sort() {
        // Negative times, keys far apart (every 16-bit digit varies),
        // repeated keys within and across partitions, and time ranges with
        // the same begin and different ends.
        let mut x = 0x9e37_79b9_7f4a_7c15u64;
        let mut next = move || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        let pick = [
            -MAX_TIME_MS,
            -5_000_000_000_000,
            -1,
            0,
            1,
            7,
            1 << 40,
            MAX_TIME_MS - 2,
        ];
        for ranges in [false, true] {
            let parts: Vec<TimeSeries> = (0..6)
                .map(|_| {
                    let n = (next() % 40) as usize;
                    let mut keys: Vec<(i64, i64)> = (0..n)
                        .map(|_| {
                            let b = pick[(next() % 8) as usize];
                            let e = b.saturating_add((next() % 3) as i64);
                            (b, if ranges { e } else { b })
                        })
                        .collect();
                    keys.sort();
                    let (begin, end): (Vec<i64>, Vec<i64>) = keys.into_iter().unzip();
                    let cols = vec![Column::required("v", vec![0.0; begin.len()])];
                    if ranges {
                        TimeSeries::from_time_ranges("t", TimeRangeKeys { begin, end }, cols)
                    } else {
                        TimeSeries::new("t", begin, cols)
                    }
                    .unwrap()
                })
                .collect();
            let refs: Vec<&TimeSeries> = parts.iter().collect();
            let mut want: Vec<(u32, u32)> = Vec::new();
            for (p, s) in parts.iter().enumerate() {
                want.extend((0..s.len() as u32).map(|r| (p as u32, r)));
            }
            want.sort_by_key(|&(p, r)| {
                let k = parts[p as usize].key();
                (k.begin()[r as usize], k.end().map_or(0, |e| e[r as usize]))
            });
            assert_eq!(merge_order(&refs), want);
        }
    }

    #[test]
    fn negative_zero_is_zero() {
        let s = TimeSeries::new(
            "z",
            vec![0, 1],
            vec![Column::required("k", vec![0.0, -0.0])],
        )
        .unwrap();
        assert_eq!(s.partition_by(&["k"]).unwrap().len(), 1);
    }

    #[test]
    fn changed_partition_values_split_again() {
        let s = TimeSeries::new(
            "s",
            vec![0, 1, 2, 3],
            vec![Column::required("k", vec![1.0, 2.0, 1.0, 2.0])],
        )
        .unwrap();
        let p = s.partition_by(&["k"]).unwrap();
        // Map every key to 7: one partition afterwards.
        let q = p.map(|g| g.map_numbers("k", |_| 7.0)).unwrap();
        assert_eq!(q.len(), 1);
        assert_eq!(q.iter().next().unwrap().0, &[Some(Value::Number(7.0))]);
        assert_eq!(q.collect().unwrap().len(), 4);
    }

    #[test]
    fn errors() {
        let s = hosts();
        assert!(s.partition_by(&[]).is_err());
        assert!(matches!(
            s.partition_by(&["nope"]).unwrap_err(),
            PondError::UnknownColumn { .. }
        ));
        let p = s.partition_by(&["host"]).unwrap();
        // Dropping the partition column: an error staying partitioned, fine
        // when collecting straight away.
        assert!(p.map(|g| g.select(&["v"])).is_err());
        assert_eq!(p.apply(|g| g.select(&["v"])).unwrap().len(), 5);
        // A failing partition stops the call.
        let err = p
            .map(|g| {
                if g.len() == 1 {
                    g.select(&["zz"])
                } else {
                    Ok(g.clone())
                }
            })
            .unwrap_err();
        assert!(matches!(err, PondError::UnknownColumn { .. }));
    }

    #[test]
    fn different_columns_cannot_merge() {
        let p = hosts().partition_by(&["host"]).unwrap();
        let err = p
            .apply(|g| {
                if g.len() == 1 {
                    g.select(&["v"])
                } else {
                    g.select(&["host"])
                }
            })
            .unwrap_err();
        assert!(err.to_string().contains("different columns"), "{err}");
    }

    #[test]
    fn empty_series() {
        let s = hosts().row_range(0..0);
        let p = s.partition_by(&["host"]).unwrap();
        assert!(p.is_empty());
        let out = p.diff(&["v"]).unwrap().collect().unwrap();
        assert!(out.is_empty());
        assert_eq!(out.columns().len(), 2);
    }

    #[test]
    fn rows_made_from_an_empty_series_are_split() {
        // pond-ts runs the operation on the empty series and splits what
        // comes back; `map` can make rows from nothing.
        let p = hosts().row_range(0..0).partition_by(&["host"]).unwrap();
        let made = p.map(|_| Ok(hosts())).unwrap();
        assert_eq!(made.len(), 3);
        let a = made.get(&[Some(Value::String("a".into()))]).unwrap();
        assert_eq!(a.len(), 2);
        let d = made.diff(&["v"]).unwrap();
        let a = d.get(&[Some(Value::String("a".into()))]).unwrap();
        assert_eq!(a.column("v").unwrap().numbers().unwrap().get(1), Some(2.0));
    }

    #[test]
    fn group_by_gives_keys_and_series() {
        let groups = hosts().group_by(&["host"]).unwrap();
        assert_eq!(groups.len(), 3);
        assert_eq!(
            groups[1].1.column("v").unwrap().numbers().unwrap().get(1),
            Some(12.0)
        );
    }

    /// Partitions run on several threads; results are the same bits on
    /// one thread and on many.
    #[cfg(all(feature = "parallel", not(target_arch = "wasm32")))]
    #[test]
    fn same_bits_on_one_and_many_threads() {
        let mut x = 0x9e37_79b9_7f4a_7c15u64;
        let mut next = || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        let (symbols, bars) = (40, 300);
        let mut time = Vec::new();
        let mut sym = Vec::new();
        let mut v = Vec::new();
        for b in 0..bars {
            for s in 0..symbols {
                time.push(b as i64 * 60_000);
                sym.push(format!("s{s}"));
                let r = next();
                v.push((r % 13 != 0).then(|| (r % 100_003) as f64 / 7.0));
            }
        }
        let series = TimeSeries::new(
            "panel",
            time,
            vec![Column::required("sym", sym), Column::optional("v", v)],
        )
        .unwrap();
        let aggs = [
            Agg::of("v", Reducer::Avg),
            Agg::new("sd", "v", Reducer::Stdev),
        ];
        let run = |threads: usize| {
            rayon::ThreadPoolBuilder::new()
                .num_threads(threads)
                .build()
                .unwrap()
                .install(|| {
                    let p = series.partition_by(&["sym"]).unwrap();
                    let a = p.rolling("10m", &aggs).unwrap().collect().unwrap();
                    let b = p
                        .fill_all(Fill::Linear)
                        .unwrap()
                        .cumulative(&[("v", Reducer::Sum)])
                        .unwrap()
                        .collect()
                        .unwrap();
                    [a, b]
                        .iter()
                        .flat_map(|s| {
                            s.columns()
                                .iter()
                                .filter_map(|c| c.numbers().ok())
                                .flat_map(|c| c.values().iter().map(|v| v.to_bits()))
                                .collect::<Vec<u64>>()
                        })
                        .collect::<Vec<u64>>()
                })
        };
        let one = run(1);
        assert!(one.len() > 30_000);
        assert_eq!(one, run(4));
        assert_eq!(one, run(7));
    }

    /// Everything a caller can see of a series: name, key, and each
    /// column's name, kind, required flag and values, with numbers
    /// compared as raw bits (a gap stored as an infinity is not a gap
    /// stored as `NaN`), text by how it is held, decimals by precision.
    fn exact(a: &TimeSeries, b: &TimeSeries, what: &str) {
        assert_eq!(a.name(), b.name(), "{what}: name");
        assert_eq!(a.key_name(), b.key_name(), "{what}: key name");
        assert_eq!(a.key(), b.key(), "{what}: key");
        assert_eq!(a.schema(), b.schema(), "{what}: schema");
        for (x, y) in a.columns().iter().zip(b.columns()) {
            let name = x.name();
            match (x.data(), y.data()) {
                (ColumnData::Number(p), ColumnData::Number(q)) => {
                    let bits = |c: &crate::Float64Column| {
                        c.values().iter().map(|v| v.to_bits()).collect::<Vec<u64>>()
                    };
                    assert_eq!(bits(p), bits(q), "{what}: column {name}");
                    assert_eq!(p.all_finite(), q.all_finite(), "{what}: column {name}");
                }
                (ColumnData::String(p), ColumnData::String(q)) => {
                    assert_eq!(
                        p.is_dictionary(),
                        q.is_dictionary(),
                        "{what}: column {name} held as a dictionary"
                    );
                    assert_eq!(p, q, "{what}: column {name}");
                }
                (ColumnData::Decimal(p), ColumnData::Decimal(q)) => {
                    assert_eq!(p.precision(), q.precision(), "{what}: column {name}");
                    assert_eq!(p.scale(), q.scale(), "{what}: column {name}");
                    assert_eq!(p, q, "{what}: column {name}");
                }
                (p, q) => assert_eq!(p, q, "{what}: column {name}"),
            }
        }
    }

    /// `fast` (a short cut) against `slow` (the same operation through
    /// `map`): the collected series, then every partition, then the
    /// collected series again now the partitions are made.
    fn same(
        fast: &Result<PartitionedSeries>,
        slow: &Result<PartitionedSeries>,
        what: &str,
    ) -> Option<(PartitionedSeries, PartitionedSeries)> {
        let (fast, slow) = match (fast, slow) {
            (Ok(fast), Ok(slow)) => (fast, slow),
            (Err(fast), Err(slow)) => {
                assert_eq!(fast.to_string(), slow.to_string(), "{what}: error");
                return None;
            }
            (fast, slow) => panic!(
                "{what}: one failed and one did not: {:?} / {:?}",
                fast.as_ref().map(|_| ()),
                slow.as_ref().map(|_| ())
            ),
        };
        exact(
            &fast.collect().unwrap(),
            &slow.collect().unwrap(),
            &format!("{what}: collect"),
        );
        assert_eq!(fast.by(), slow.by(), "{what}: by");
        assert_eq!(fast.len(), slow.len(), "{what}: partitions");
        assert_eq!(fast.whole.is_some(), slow.whole.is_some(), "{what}: whole");
        assert_eq!(fast.run_order, slow.run_order, "{what}: run order");
        exact(&fast.empty, &slow.empty, &format!("{what}: empty"));
        for (i, ((ka, a), (kb, b))) in fast.iter().zip(slow.iter()).enumerate() {
            assert_eq!(ka, kb, "{what}: key of partition {i}");
            exact(a, b, &format!("{what}: partition {i}"));
        }
        exact(
            &fast.collect().unwrap(),
            &slow.collect().unwrap(),
            &format!("{what}: collect after iter"),
        );
        Some((fast.clone(), slow.clone()))
    }

    /// Panels to try the short cuts on: `(name, series, partition columns)`.
    fn panels() -> Vec<(&'static str, TimeSeries, Vec<&'static str>)> {
        use arrow_array::{DictionaryArray, types::Int32Type};
        let mut x = 0x2545_f491_4f6c_dd1du64;
        let mut next = move || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        let names = ["a", "b", "c", "d", "e"];
        // `shape` 0: rows at one time in a random partition order, gaps in
        // the partition column. 1: partitions interleaved in the same
        // order at every time. 2: runs of one partition, times all
        // different. 3: one partition. 4: no rows.
        let mut build = |shape: usize, rows: usize| -> TimeSeries {
            let mut time = Vec::new();
            let mut host = Vec::new();
            let mut t = 0i64;
            for i in 0..rows {
                let pick = match shape {
                    0 => (next() % 6) as usize,
                    1 => i % 4,
                    2 => (i / 7) % 3,
                    _ => 0,
                };
                match shape {
                    0 => t += (next() % 3 / 2) as i64 * 1000,
                    1 => t = (i / 4) as i64 * 1000,
                    _ => t += 1 + (next() % 5) as i64 * 500,
                }
                time.push(t);
                host.push(names.get(pick).copied());
            }
            let number = |next: &mut dyn FnMut() -> u64, gaps: u64| -> Vec<f64> {
                (0..rows)
                    .map(|_| {
                        let r = next();
                        match r % gaps {
                            0 => f64::NAN,
                            // A gap held as an infinity stays one.
                            1 if gaps > 3 => f64::INFINITY,
                            _ => (r % 100_003) as f64 / 7.0 - 5000.0,
                        }
                    })
                    .collect()
            };
            let v = number(&mut next, 9);
            let w = number(&mut next, 4);
            let whole: Vec<f64> = (0..rows).map(|_| (next() % 50) as f64).collect();
            let flag: Vec<Option<bool>> = (0..rows)
                .map(|i| (shape != 0 || i % 11 != 3).then_some(host[i].is_some_and(|h| h < "c")))
                .collect();
            let words: DictionaryArray<Int32Type> = (0..rows)
                .map(|_| {
                    let r = next() % 5;
                    (r != 0).then(|| ["x", "y", "z", "x"][r as usize - 1])
                })
                .collect();
            let exact_values = (0..rows).map(|_| {
                let r = next();
                (r % 6 != 0).then_some((r % 100_000) as i128 - 50_000)
            });
            let price = crate::DecimalColumn::with_type(exact_values.collect(), 12, 2).unwrap();
            let lists = crate::ArrayColumn::from_options((0..rows).map(|i| {
                (i % 5 != 0).then(|| vec![crate::Scalar::from(i as f64), crate::Scalar::from("t")])
            }));
            // In `dict` every partition's rows are one value (or gaps),
            // so it can be a partition column held as a dictionary.
            let dict: DictionaryArray<Int32Type> = host.iter().copied().collect();
            let columns = vec![
                Column::optional("host", host.clone()),
                Column::optional_raw("v", v),
                Column::optional("flag", flag),
                Column::from_data(
                    "words".into(),
                    crate::StringColumn::dictionary(words).unwrap(),
                    false,
                ),
                Column::optional_raw("w", w),
                Column::from_data("price".into(), price, false),
                Column::required("whole", whole),
                Column::from_data("lists".into(), lists, false),
                Column::from_data(
                    "dict".into(),
                    crate::StringColumn::dictionary(dict).unwrap(),
                    false,
                ),
            ];
            TimeSeries::new("panel", time, columns).unwrap()
        };
        let ranges = {
            let s = build(0, 60);
            let begin = s.key().begin().to_vec();
            let end = begin
                .iter()
                .enumerate()
                .map(|(i, b)| b + (i as i64 % 3) * 10);
            // Sorted by begin, then end, within each run of equal begins.
            let mut keys: Vec<(i64, i64)> = begin.iter().copied().zip(end).collect();
            keys.sort();
            let keys = TimeRangeKeys {
                begin: keys.iter().map(|k| k.0).collect(),
                end: keys.iter().map(|k| k.1).collect(),
            };
            TimeSeries::from_time_ranges("ranges", keys, s.columns().to_vec()).unwrap()
        };
        vec![
            ("ties", build(0, 300), vec!["host"]),
            ("interleaved", build(1, 240), vec!["host"]),
            ("runs", build(2, 200), vec!["host"]),
            ("one partition", build(3, 40), vec!["host"]),
            ("no rows", build(4, 0), vec!["host"]),
            ("two columns", build(0, 300), vec!["host", "flag"]),
            ("by a dictionary", build(0, 200), vec!["dict"]),
            ("by a number", build(0, 200), vec!["whole"]),
            ("by a decimal", build(1, 120), vec!["price"]),
            ("ranges", ranges, vec!["flag"]),
        ]
    }

    #[test]
    fn row_keeping_short_cuts_give_what_map_gives() {
        let linear = [("v", Fill::Linear)];
        let mixed = [("w", Fill::Hold), ("v", Fill::Value(Value::Number(-1.5)))];
        let text = [("words", Fill::Hold), ("v", Fill::Zero)];
        let caps = FillLimits::none().limit(2).max_gap("3s");
        type Op<'a> = (
            &'a str,
            Box<dyn Fn(&PartitionedSeries) -> Result<PartitionedSeries> + 'a>,
            Box<dyn Fn(&TimeSeries) -> Result<TimeSeries> + Sync + Send + 'a>,
        );
        let out = || Change::default().output("dv");
        let drop = || Change::default().first(crate::FirstRow::Drop);
        let ops: Vec<Op> = vec![
            (
                "diff",
                Box::new(|p| p.diff(&["v"])),
                Box::new(|g| g.diff(&["v"])),
            ),
            (
                "diff two",
                Box::new(|p| p.diff(&["w", "v"])),
                Box::new(|g| g.diff(&["w", "v"])),
            ),
            (
                "diff twice",
                Box::new(|p| p.diff(&["v", "v"])),
                Box::new(|g| g.diff(&["v", "v"])),
            ),
            (
                "diff to a new column",
                Box::new(|p| p.diff_with(&["v"], out())),
                Box::new(|g| g.diff_with(&["v"], out())),
            ),
            (
                "diff to a taken name",
                Box::new(|p| p.diff_with(&["v"], Change::default().output("words"))),
                Box::new(|g| g.diff_with(&["v"], Change::default().output("words"))),
            ),
            (
                "diff dropping the first row",
                Box::new(|p| p.diff_with(&["v"], drop())),
                Box::new(|g| g.diff_with(&["v"], drop())),
            ),
            (
                "diff of a decimal",
                Box::new(|p| p.diff(&["price"])),
                Box::new(|g| g.diff(&["price"])),
            ),
            (
                "diff of a partition column",
                Box::new(|p| p.diff(&["whole"])),
                Box::new(|g| g.diff(&["whole"])),
            ),
            (
                "diff of text",
                Box::new(|p| p.diff(&["words"])),
                Box::new(|g| g.diff(&["words"])),
            ),
            (
                "diff of nothing",
                Box::new(|p| p.diff(&[])),
                Box::new(|g| g.diff(&[])),
            ),
            (
                "diff of an unknown column",
                Box::new(|p| p.diff(&["v", "nope"])),
                Box::new(|g| g.diff(&["v", "nope"])),
            ),
            (
                "rate",
                Box::new(|p| p.rate(&["v"])),
                Box::new(|g| g.rate(&["v"])),
            ),
            (
                "rate to a new column",
                Box::new(|p| p.rate_with(&["w"], out())),
                Box::new(|g| g.rate_with(&["w"], out())),
            ),
            (
                "pct_change",
                Box::new(|p| p.pct_change(&["v", "w"])),
                Box::new(|g| g.pct_change(&["v", "w"])),
            ),
            (
                "pct_change to a new column",
                Box::new(|p| p.pct_change_with(&["v"], out())),
                Box::new(|g| g.pct_change_with(&["v"], out())),
            ),
            (
                "shift down",
                Box::new(|p| p.shift(&["v"], 2)),
                Box::new(|g| g.shift(&["v"], 2)),
            ),
            (
                "shift up",
                Box::new(|p| p.shift(&["w", "whole"], -1)),
                Box::new(|g| g.shift(&["w", "whole"], -1)),
            ),
            (
                "shift text",
                Box::new(|p| p.shift(&["words", "v"], 1)),
                Box::new(|g| g.shift(&["words", "v"], 1)),
            ),
            (
                "cumulative",
                Box::new(|p| p.cumulative(&[("v", Reducer::Sum), ("w", Reducer::Max)])),
                Box::new(|g| g.cumulative(&[("v", Reducer::Sum), ("w", Reducer::Max)])),
            ),
            (
                "cumulative twice",
                Box::new(|p| p.cumulative(&[("v", Reducer::Sum), ("v", Reducer::Max)])),
                Box::new(|g| g.cumulative(&[("v", Reducer::Sum), ("v", Reducer::Max)])),
            ),
            (
                "cumulative increase",
                Box::new(|p| p.cumulative(&[("v", crate::Cumulative::increase())])),
                Box::new(|g| g.cumulative(&[("v", crate::Cumulative::increase())])),
            ),
            (
                "fill linear",
                Box::new(|p| p.fill(&linear)),
                Box::new(|g| g.fill(&linear)),
            ),
            (
                "fill hold and value",
                Box::new(|p| p.fill(&mixed)),
                Box::new(|g| g.fill(&mixed)),
            ),
            (
                "fill text",
                Box::new(|p| p.fill(&text)),
                Box::new(|g| g.fill(&text)),
            ),
            (
                "fill with caps",
                Box::new(|p| p.fill_with(&linear, &caps)),
                Box::new(|g| g.fill_with(&linear, &caps)),
            ),
            (
                "fill with a bad cap",
                Box::new(|p| p.fill_with(&linear, &FillLimits::none().max_gap("soon"))),
                Box::new(|g| g.fill_with(&linear, &FillLimits::none().max_gap("soon"))),
            ),
            (
                "fill the required column",
                Box::new(|p| p.fill(&[("whole", Fill::Zero)])),
                Box::new(|g| g.fill(&[("whole", Fill::Zero)])),
            ),
            (
                "fill_all linear",
                Box::new(|p| p.fill_all(Fill::Linear)),
                Box::new(|g| g.fill_all(Fill::Linear)),
            ),
            (
                "fill_all linear with caps",
                Box::new(|p| p.fill_all_with(Fill::Linear, &caps)),
                Box::new(|g| g.fill_all_with(Fill::Linear, &caps)),
            ),
            (
                "fill_all hold",
                Box::new(|p| p.fill_all(Fill::Hold)),
                Box::new(|g| g.fill_all(Fill::Hold)),
            ),
            (
                "fill_all zero",
                Box::new(|p| p.fill_all(Fill::Zero)),
                Box::new(|g| g.fill_all(Fill::Zero)),
            ),
            (
                "fill_all value",
                Box::new(|p| p.fill_all(Fill::Value(Value::Number(1.0)))),
                Box::new(|g| g.fill_all(Fill::Value(Value::Number(1.0)))),
            ),
        ];
        let mut short_cuts = 0;
        for (panel, series, by) in panels() {
            let p = series.partition_by(&by).unwrap();
            for (name, fast, each) in &ops {
                let what = format!("{panel}: {name}");
                let quick = fast(&p);
                short_cuts += quick
                    .as_ref()
                    .is_ok_and(|q| q.whole.is_none() && matches!(q.parts, Parts::Rows(_)))
                    as usize;
                let Some((a, b)) = same(&quick, &p.map(each), &what) else {
                    continue;
                };
                // A second operation on each: a short cut on a short cut's
                // result, and `map` on it.
                same(
                    &a.fill_all(Fill::Linear),
                    &b.map(|g| g.fill_all(Fill::Linear)),
                    &format!("{what}, then fill"),
                );
                same(
                    &a.map(|g| g.shift(&["v"], 1)),
                    &b.map(|g| g.shift(&["v"], 1)),
                    &format!("{what}, then map"),
                );
                same(
                    &a.dedupe(Keep::First),
                    &b.dedupe(Keep::First),
                    &format!("{what}, then dedupe"),
                );
            }
        }
        // The short cuts did run (not everything fell back to `map`).
        assert!(short_cuts > 100, "{short_cuts}");
    }

    #[test]
    fn rolling_short_cuts_give_what_map_gives() {
        use crate::rolling::Alignment::{Centered, Leading, Trailing};
        let lists = [
            vec![Agg::new("out", "v", Reducer::Avg)],
            vec![
                Agg::of("w", Reducer::Stdev),
                Agg::of("v", Reducer::Last),
                Agg::of("whole", Reducer::Sum),
            ],
            vec![
                Agg::of("w", Reducer::Median),
                Agg::new("lo", "v", Reducer::Min),
                Agg::new("n", "v", Reducer::Count),
                Agg::new("d", "w", Reducer::Difference),
            ],
            vec![],
            // Not short cuts: text, decimal and list outputs, an output
            // named after a partition column, a partition column as a
            // source, and errors.
            vec![Agg::of("v", Reducer::Avg), Agg::of("words", Reducer::Last)],
            vec![Agg::new("p", "price", Reducer::Max)],
            vec![Agg::new("u", "v", Reducer::Unique)],
            vec![Agg::new("host", "v", Reducer::Avg)],
            vec![Agg::new("flag", "v", Reducer::Avg)],
            vec![Agg::new("n", "host", Reducer::Count)],
            vec![Agg::new("out", "nope", Reducer::Avg)],
            vec![
                Agg::new("out", "v", Reducer::Avg),
                Agg::new("out", "w", Reducer::Avg),
            ],
            vec![Agg::new("time", "v", Reducer::Avg)],
            vec![
                Agg::new("rows", "v", Reducer::Avg),
                Agg::new("rows_", "w", Reducer::Sum),
            ],
        ];
        let mut choices = Vec::new();
        for alignment in [Trailing, Leading, Centered] {
            for min_samples in [0, 1, 2, 4, 1000] {
                for append in [false, true] {
                    choices.push(Rolling {
                        alignment,
                        min_samples,
                        append,
                    });
                }
            }
        }
        let mut short_cuts = 0;
        for (panel, series, by) in panels() {
            let p = series.partition_by(&by).unwrap();
            for (l, aggs) in lists.iter().enumerate() {
                for options in &choices {
                    let options = *options;
                    let all = p.rolling_outputs(aggs, options);
                    let mut check =
                        |what: String,
                         fast: Result<PartitionedSeries>,
                         slow: Result<PartitionedSeries>| {
                            short_cuts += fast
                                .as_ref()
                                .is_ok_and(|q| matches!(q.parts, Parts::Rows(_)))
                                as usize;
                            if let Some((a, b)) = same(&fast, &slow, &what) {
                                same(
                                    &a.fill_all(Fill::Hold),
                                    &b.map(|g| g.fill_all(Fill::Hold)),
                                    &format!("{what}, then fill"),
                                );
                                let again = [Agg::new("again", "out", Reducer::Sum)];
                                same(
                                    &a.rolling_rows(2, &again, Rolling::default()),
                                    &b.map(|g| {
                                        g.rolling_rows(
                                            2,
                                            &b.rolling_outputs(&again, Rolling::default()),
                                            Rolling::default(),
                                        )
                                    }),
                                    &format!("{what}, then rolling"),
                                );
                            }
                        };
                    for rows in [0, 1, 3, 20] {
                        check(
                            format!("{panel}: {rows} rows, aggs {l}, {options:?}"),
                            p.rolling_rows(rows, aggs, options),
                            p.map(|g| g.rolling_rows(rows, &all, options)),
                        );
                    }
                    for window in ["0s", "1ms", "1s", "3s", "1h", "soon"] {
                        check(
                            format!("{panel}: {window}, aggs {l}, {options:?}"),
                            p.rolling_with(window, aggs, options),
                            p.map(|g| g.rolling_with(window, &all, options)),
                        );
                    }
                }
                let all = p.with_partition_outputs(aggs);
                same(
                    &p.rolling("2s", aggs),
                    &p.map(|g| g.rolling("2s", &all)),
                    &format!("{panel}: rolling, aggs {l}"),
                );
            }
        }
        assert!(short_cuts > 1000, "{short_cuts}");
    }

    #[test]
    fn collect_sorts_only_rows_out_of_partition_order() {
        // b before a at time 0, then a before b: the merge puts a's row
        // first at time 1000 only if partition order says so.
        let p = hosts().partition_by(&["host"]).unwrap();
        let Parts::Rows(rows) = &p.parts else {
            panic!("a fresh split is held as rows");
        };
        assert_eq!(
            rows.groups.merge_order(hosts().key()),
            Some(vec![0, 1, 3, 2, 4])
        );
        let d = p.diff(&["v"]).unwrap().collect().unwrap();
        let slow = p.map(|g| g.diff(&["v"])).unwrap().collect().unwrap();
        exact(&d, &slow, "diff");
        // In partition order already: nothing to sort.
        let s = TimeSeries::new(
            "s",
            vec![0, 0, 1000, 1000],
            vec![
                Column::required("host", vec!["a", "b", "a", "b"]),
                Column::required("v", vec![1.0, 2.0, 3.0, 4.0]),
            ],
        )
        .unwrap();
        let p = s.partition_by(&["host"]).unwrap();
        let Parts::Rows(rows) = &p.parts else {
            panic!("a fresh split is held as rows");
        };
        assert_eq!(rows.groups.merge_order(s.key()), None);
    }

    #[test]
    fn value_ids_number_values_in_first_seen_order() {
        let mut x = 0x9e37_79b9_7f4a_7c15u64;
        let mut next = move || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        // Texts of every length from 0 to 20 bytes, many sharing a start
        // or an end, in runs and scattered, with gaps.
        let mut words: Vec<String> = Vec::new();
        for len in 0..=20 {
            for k in 0..12u8 {
                let mut w: Vec<u8> = (0..len).map(|i| b'a' + (i as u8 % 7)).collect();
                if let Some(last) = w.last_mut() {
                    *last = b'A' + k;
                }
                if len > 9 && k % 2 == 0 {
                    w[0] = b'0' + k;
                }
                words.push(String::from_utf8(w).unwrap());
            }
        }
        for runs in [1, 3, 40] {
            let rows: Vec<Option<&str>> = (0..6000)
                .map(|i| {
                    let r = next();
                    let pick = if i % runs == 0 { r } else { r / 1000 * 1000 };
                    (r % 23 != 0).then(|| words[(pick % words.len() as u64) as usize].as_str())
                })
                .collect();
            let mut seen: Vec<&str> = Vec::new();
            let want: Vec<u32> = rows
                .iter()
                .map(|v| match v {
                    None => 0,
                    Some(v) => match seen.iter().position(|s| s == v) {
                        Some(at) => at as u32 + 1,
                        None => {
                            seen.push(v);
                            seen.len() as u32
                        }
                    },
                })
                .collect();
            assert_eq!(value_ids(&ColumnData::from(rows)), want, "runs of {runs}");
        }
        let numbers = vec![Some(0.0), Some(-0.0), None, Some(1.5), Some(0.0), Some(1.5)];
        assert_eq!(value_ids(&ColumnData::from(numbers)), [1, 1, 0, 2, 1, 2]);
        let flags = vec![Some(true), None, Some(false), Some(true)];
        assert_eq!(value_ids(&ColumnData::from(flags)), [1, 0, 2, 1]);
    }

    #[test]
    fn reservoir_and_scan_run_per_partition() {
        // Two hosts, 20 rows each, interleaved in time.
        let n = 40;
        let s = TimeSeries::new(
            "r",
            (0..n as i64).map(|i| i * 1000).collect(),
            vec![
                Column::required(
                    "host",
                    (0..n)
                        .map(|i| if i % 2 == 0 { "a" } else { "b" })
                        .collect::<Vec<_>>(),
                ),
                Column::required("v", (0..n).map(|i| i as f64).collect::<Vec<_>>()),
            ],
        )
        .unwrap();
        let p = s.partition_by(&["host"]).unwrap();
        let how = Sample::Reservoir { size: 5, seed: 3 };
        let picked = p.sample(how).unwrap();
        // Partitions are in first-row order after sampling: look them up.
        let v_of = |g: &TimeSeries| -> Vec<f64> {
            g.column("v")
                .unwrap()
                .numbers()
                .unwrap()
                .iter()
                .flatten()
                .collect()
        };
        let key = |h: &str| vec![Some(Value::String(h.into()))];
        let rows = [
            v_of(picked.get(&key("a")).unwrap()),
            v_of(picked.get(&key("b")).unwrap()),
        ];
        assert_eq!(picked.len(), 2);
        // Five from each partition, each from its own rows; the first
        // partition uses `seed` itself, and the second picks other
        // positions (its own seed). The same seed gives the same rows.
        assert!(rows.iter().all(|r| r.len() == 5));
        assert!(rows[0].iter().all(|v| (*v as usize).is_multiple_of(2)));
        assert!(rows[1].iter().all(|v| *v as usize % 2 == 1));
        let positions = |r: &[f64]| r.iter().map(|v| (*v as usize) / 2).collect::<Vec<_>>();
        let alone = v_of(&p.get(&key("a")).unwrap().sample(how).unwrap());
        assert_eq!(rows[0], alone);
        assert_ne!(positions(&rows[0]), positions(&rows[1]));
        assert_eq!(p.sample(how).unwrap().collect(), picked.collect());

        // A running count restarts in each partition, from its own `init`.
        let counted = p
            .scan_to("v", "k", 100.0, |acc, _, i| (acc + 1.0, acc + i as f64))
            .unwrap();
        for (_, g) in counted.iter() {
            let k: Vec<f64> = g
                .column("k")
                .unwrap()
                .numbers()
                .unwrap()
                .iter()
                .flatten()
                .collect();
            assert_eq!(
                k,
                (0..20).map(|i| 100.0 + 2.0 * i as f64).collect::<Vec<_>>()
            );
        }
    }
}
