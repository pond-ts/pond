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

use std::collections::HashMap;

use crate::column::{ColumnData, Value};
use crate::error::{PondError, Result};
use crate::grid::{Align, Keep, Materialize};
use crate::par;
use crate::reducer::{Agg, Reducer};
use crate::rolling::{Rolling, RollingOver};
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
    parts: Vec<(PartitionKey, TimeSeries)>,
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
        self.parts.len()
    }

    pub fn is_empty(&self) -> bool {
        self.parts.is_empty()
    }

    /// Each partition's key and rows, in partition order (pond-ts
    /// `toMap`).
    pub fn iter(&self) -> impl ExactSizeIterator<Item = (&[Option<Value>], &TimeSeries)> {
        self.parts.iter().map(|(k, s)| (k.as_slice(), s))
    }

    /// The partition with this key, if there is one.
    pub fn get(&self, key: &[Option<Value>]) -> Option<&TimeSeries> {
        self.parts
            .iter()
            .find(|(k, _)| k.as_slice() == key)
            .map(|(_, s)| s)
    }

    /// The partitions as owned `(key, series)` pairs.
    pub fn into_groups(self) -> Vec<(PartitionKey, TimeSeries)> {
        self.parts
    }

    /// All partitions as one series, sorted by key; rows with the same key
    /// keep partition order. Before any operation has run this is the
    /// original series, unchanged. An error if an operation gave different
    /// partitions different columns.
    pub fn collect(&self) -> Result<TimeSeries> {
        match &self.whole {
            Some(whole) => Ok(whole.clone()),
            None => {
                let series: Vec<&TimeSeries> =
                    self.run_order.iter().map(|&i| &self.parts[i].1).collect();
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
        // With no partitions, any rows `f` made on the empty series have no
        // key yet, so they are always split.
        let unchanged =
            !self.parts.is_empty() && parts.iter().all(|(key, s)| keeps_key(s, &by_index, key));
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
            parts,
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
        self.map(|g| g.diff(columns))
    }

    /// [`TimeSeries::diff_with`] on each partition.
    pub fn diff_with(&self, columns: &[&str], options: Change) -> Result<PartitionedSeries> {
        self.map(|g| g.diff_with(columns, options.clone()))
    }

    /// [`TimeSeries::rate`] on each partition.
    pub fn rate(&self, columns: &[&str]) -> Result<PartitionedSeries> {
        self.map(|g| g.rate(columns))
    }

    /// [`TimeSeries::rate_with`] on each partition.
    pub fn rate_with(&self, columns: &[&str], options: Change) -> Result<PartitionedSeries> {
        self.map(|g| g.rate_with(columns, options.clone()))
    }

    /// [`TimeSeries::pct_change`] on each partition.
    pub fn pct_change(&self, columns: &[&str]) -> Result<PartitionedSeries> {
        self.map(|g| g.pct_change(columns))
    }

    /// [`TimeSeries::pct_change_with`] on each partition.
    pub fn pct_change_with(&self, columns: &[&str], options: Change) -> Result<PartitionedSeries> {
        self.map(|g| g.pct_change_with(columns, options.clone()))
    }

    /// [`TimeSeries::shift`] on each partition.
    pub fn shift(&self, columns: &[&str], n: i64) -> Result<PartitionedSeries> {
        self.map(|g| g.shift(columns, n))
    }

    /// [`TimeSeries::cumulative`] on each partition.
    pub fn cumulative(&self, spec: &[(&str, Reducer)]) -> Result<PartitionedSeries> {
        self.map(|g| g.cumulative(spec))
    }

    /// [`TimeSeries::fill`] on each partition.
    pub fn fill(&self, spec: &[(&str, Fill)]) -> Result<PartitionedSeries> {
        self.map(|g| g.fill(spec))
    }

    /// [`TimeSeries::fill_with`] on each partition.
    pub fn fill_with(
        &self,
        spec: &[(&str, Fill)],
        limits: &FillLimits,
    ) -> Result<PartitionedSeries> {
        self.map(|g| g.fill_with(spec, limits))
    }

    /// [`TimeSeries::fill_all`] on each partition.
    pub fn fill_all(&self, fill: Fill) -> Result<PartitionedSeries> {
        self.map(|g| g.fill_all(fill.clone()))
    }

    /// [`TimeSeries::fill_all_with`] on each partition.
    pub fn fill_all_with(&self, fill: Fill, limits: &FillLimits) -> Result<PartitionedSeries> {
        self.map(|g| g.fill_all_with(fill.clone(), limits))
    }

    /// [`TimeSeries::rolling`] on each partition. Only the outputs are
    /// kept, plus each partition column that no output is named after,
    /// carried through as a `first` output at the end (as pond-ts does), so
    /// the result stays partitioned.
    pub fn rolling(&self, window: &str, aggs: &[Agg]) -> Result<PartitionedSeries> {
        let aggs = self.with_partition_outputs(aggs);
        self.map(|g| g.rolling(window, &aggs))
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
            .parts
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
        if self.parts.is_empty() {
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
        let results = par::map(&self.parts, |(_, s)| f(s));
        let mut parts = Vec::with_capacity(results.len());
        for ((key, _), out) in self.parts.iter().zip(results) {
            parts.push((key.clone(), out?));
        }
        let empty = parts[0].1.row_range(0..0);
        Ok((parts, empty))
    }
}

/// The rows of `series` grouped by the values of the columns at `by`, in
/// first-row order.
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

fn split(series: &TimeSeries, by: &[usize]) -> Vec<(PartitionKey, TimeSeries)> {
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
    let mut part = vec![u32::MAX; ids.iter().max().map_or(0, |&m| m as usize + 1)];
    let mut rows: Vec<Vec<usize>> = Vec::new();
    for (i, &id) in ids.iter().enumerate() {
        let slot = &mut part[id as usize];
        if *slot == u32::MAX {
            *slot = rows.len() as u32;
            rows.push(Vec::new());
        }
        rows[*slot as usize].push(i);
    }
    par::map(&rows, |rows| {
        let key = by
            .iter()
            .map(|&c| value_at(series.columns()[c].data(), rows[0]))
            .collect();
        (key, series.take_rows(rows))
    })
}

/// A small integer per row that is equal exactly when the values are
/// (a gap is 0).
fn value_ids(data: &ColumnData) -> Vec<u32> {
    fn ids<K: std::hash::Hash + Eq>(values: impl Iterator<Item = Option<K>>) -> Vec<u32> {
        let mut seen: HashMap<K, u32> = HashMap::new();
        values
            .map(|v| match v {
                None => 0,
                Some(v) => {
                    let next = seen.len() as u32 + 1;
                    *seen.entry(v).or_insert(next)
                }
            })
            .collect()
    }
    match data {
        // `+ 0.0` turns -0 into 0, so they are one partition.
        ColumnData::Number(c) => ids(c.iter().map(|v| v.map(|v| (v + 0.0).to_bits()))),
        ColumnData::Decimal(c) => ids(c.iter().map(|v| v.map(|d| d.value))),
        ColumnData::String(c) => ids(c.iter()),
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
        if let (Key::Interval(a), Key::Interval(b)) = (head.key(), s.key()) {
            if std::mem::discriminant(&a.label) != std::mem::discriminant(&b.label) {
                return Some(format!(
                    "series {i} has {} interval labels, series 0 {}",
                    label_kind(&b.label),
                    label_kind(&a.label)
                ));
            }
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
            if let (ColumnData::Decimal(x), ColumnData::Decimal(y)) = (a.data(), b.data()) {
                if x.scale() != y.scale() {
                    return Some(format!(
                        "decimal column '{}' has scale {} in series {i} but {} in series 0",
                        a.name(),
                        y.scale(),
                        x.scale()
                    ));
                }
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
        assert!(rows[0].iter().all(|v| *v as usize % 2 == 0));
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
