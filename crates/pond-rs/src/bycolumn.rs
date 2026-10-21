//! `by_column` and `rolling_by_column`: reducing rows grouped by the value
//! of a number column (a distance, a power) instead of by time. A
//! histogram, per-kilometre splits, time in heart-rate zones, or a band of
//! percentiles along a route.

use std::ops::Range;

use arrow_array::UInt32Array;

use crate::column::ColumnData;
use crate::error::{PondError, Result};
use crate::reducer::{Agg, check_source_kind};
use crate::rolling::{Alignment, Frame, Span};
use crate::series::{Column, Key, TimeSeries};

/// How [`TimeSeries::by_column`] cuts a number column into bins (pond-ts
/// `{ width, origin }` or `{ edges, inclusive }`).
#[derive(Debug, Clone, PartialEq)]
pub enum Bins {
    /// Bins `width` wide with edges at `origin + i * width`: bin `i` holds
    /// the values in `[origin + i * width, origin + (i + 1) * width)`.
    /// Every bin from the lowest one holding a value to the highest is
    /// given, empty ones included.
    Width { width: f64, origin: f64 },
    /// Explicit edges `e0 < e1 < … < en`, giving `n` bins, all of them
    /// given. Bin `i` holds `[e_i, e_i+1)`; with `upper_inclusive` it
    /// holds `(e_i, e_i+1]` instead (a value on an edge belongs to the bin
    /// below, as in power and heart-rate zones). Either way the lowest
    /// edge is in bin 0, so with `upper_inclusive` bin 0 is
    /// `[e0, e1]`.
    Edges {
        edges: Vec<f64>,
        upper_inclusive: bool,
    },
}

impl Bins {
    /// Bins `width` wide, edges at whole multiples of `width`.
    pub fn width(width: f64) -> Self {
        Bins::Width { width, origin: 0.0 }
    }

    /// Bins `width` wide, edges at `origin + i * width`.
    pub fn width_from(width: f64, origin: f64) -> Self {
        Bins::Width { width, origin }
    }

    /// Bins between `edges`, each holding its lower edge.
    pub fn edges(edges: impl Into<Vec<f64>>) -> Self {
        Bins::Edges {
            edges: edges.into(),
            upper_inclusive: false,
        }
    }

    /// Bins between `edges`, each holding its upper edge (and bin 0 its
    /// lower edge too).
    pub fn edges_upper_inclusive(edges: impl Into<Vec<f64>>) -> Self {
        Bins::Edges {
            edges: edges.into(),
            upper_inclusive: true,
        }
    }
}

/// Columns of equal length without a key: what [`TimeSeries::by_column`]
/// and [`TimeSeries::rolling_by_column`] give (pond-ts gives an array of
/// records). Read a column by name, as on a series.
#[derive(Debug, Clone)]
pub struct Table {
    columns: Vec<Column>,
    rows: usize,
}

impl Table {
    /// The number of rows.
    pub fn len(&self) -> usize {
        self.rows
    }

    /// True when there are no rows.
    pub fn is_empty(&self) -> bool {
        self.rows == 0
    }

    /// Every column, in order.
    pub fn columns(&self) -> &[Column] {
        &self.columns
    }

    /// The column called `name`.
    pub fn column(&self, name: &str) -> Result<&Column> {
        self.columns
            .iter()
            .find(|c| c.name() == name)
            .ok_or_else(|| PondError::UnknownColumn {
                call: "Table::column",
                column: name.to_string(),
                available: self.columns.iter().map(|c| c.name().to_string()).collect(),
            })
    }
}

/// pond-ts caps a width binning at this many bins.
const MAX_WIDTH_BINS: f64 = 1_000_000.0;

/// The largest whole number an f64 holds exactly, pond-ts's
/// `Number.isSafeInteger` bound.
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

impl TimeSeries {
    /// Group the rows into bins by the value of the number column `column`
    /// and reduce each bin (pond-ts `byColumn(column, bins, mapping)`): a
    /// histogram, splits per kilometre, or time spent in each power zone.
    /// One row per bin, in order, with the bin's range as columns `start`
    /// and `end`, then one column per entry of `aggs`, in the order given.
    ///
    /// ```
    /// use pond_rs::{Agg, Bins, Column, Reducer, TimeSeries};
    /// let s = TimeSeries::new("ride", vec![0, 1_000, 2_000, 3_000], vec![
    ///     Column::required("watts", vec![90.0, 150.0, 210.0, 160.0]),
    /// ])?;
    /// let zones = s.by_column("watts", &Bins::edges([0.0, 100.0, 200.0, 300.0]),
    ///     &[Agg::new("rows", "watts", Reducer::Count)])?;
    /// assert_eq!(zones.column("start")?.numbers()?.values(), &[0.0, 100.0, 200.0]);
    /// assert_eq!(zones.column("rows")?.numbers()?.values(), &[1.0, 2.0, 1.0]);
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    ///
    /// A row whose value in `column` is a gap, or outside the edges, is in
    /// no bin. Rows reach a bin's reducers in row order, and each bin is
    /// reduced as [`TimeSeries::aggregate`] reduces a bucket, with the same
    /// reducers, kinds and rules; an empty bin gives `count` 0, `sum` 0,
    /// an empty list for the list reducers, and gaps otherwise. With
    /// [`Bins::Width`], bins run from the lowest holding a row to the
    /// highest, so no row at all gives no bins.
    ///
    /// Errors, as in pond-ts: `column` not a number column; an output named
    /// `start` or `end`; a width that is not a positive finite number or
    /// an origin that is not finite; fewer than two edges, an edge that is
    /// not finite, or edges not strictly rising; and a width binning that
    /// gives more than a million bins or bins too narrow for f64 to tell
    /// their edges apart.
    pub fn by_column(&self, column: &str, bins: &Bins, aggs: &[Agg]) -> Result<Table> {
        const CALL: &str = "by_column";
        let (_, values) = self.number_source(CALL, column)?;
        let plan = self.value_axis_plan(CALL, aggs, &["start", "end"])?;
        // Each row's bin, counted from the lowest; NONE for a row in no bin.
        const NONE: u32 = u32::MAX;
        let (bin_of, first, count): (Vec<u32>, f64, usize) = match bins {
            Bins::Edges {
                edges,
                upper_inclusive,
            } => {
                check_edges(CALL, edges)?;
                let last = edges.len() - 1;
                let bin_of = values
                    .iter()
                    .map(|&v| {
                        if !v.is_finite() {
                            return NONE;
                        }
                        edge_bin(edges, v, *upper_inclusive).map_or(NONE, |b| b as u32)
                    })
                    .collect();
                (bin_of, 0.0, last)
            }
            &Bins::Width { width, origin } => {
                if !width.is_finite() || width <= 0.0 {
                    return Err(invalid(CALL, "width must be a positive finite number"));
                }
                if !origin.is_finite() {
                    return Err(invalid(CALL, "origin must be finite"));
                }
                let raw: Vec<f64> = values
                    .iter()
                    .map(|&v| {
                        if v.is_finite() {
                            width_bin(v, width, origin)
                        } else {
                            f64::NAN
                        }
                    })
                    .collect();
                // The lowest and highest bin. (A bin can be -0 only with
                // origin 0, where its edges come out the same.)
                let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
                for &b in raw.iter().filter(|b| !b.is_nan()) {
                    if b < lo {
                        lo = b;
                    }
                    if b > hi {
                        hi = b;
                    }
                }
                if lo > hi {
                    (vec![NONE; values.len()], 0.0, 0)
                } else {
                    if !(lo.abs() <= MAX_SAFE && hi.abs() <= MAX_SAFE) {
                        return Err(invalid(
                            CALL,
                            "the data range and width give a bin number past 2^53; use a larger width",
                        ));
                    }
                    let count = hi - lo + 1.0;
                    if count > MAX_WIDTH_BINS {
                        return Err(invalid(
                            CALL,
                            &format!(
                                "width gives {count} bins (more than {MAX_WIDTH_BINS}); use a larger width or edges"
                            ),
                        ));
                    }
                    let bin_of = raw
                        .iter()
                        .map(|&b| if b.is_nan() { NONE } else { (b - lo) as u32 })
                        .collect();
                    (bin_of, lo, count as usize)
                }
            }
        };
        // Each bin's range, checked as pond-ts checks it.
        let mut starts = Vec::with_capacity(count);
        let mut ends = Vec::with_capacity(count);
        for b in 0..count {
            let (start, end) = match bins {
                Bins::Edges { edges, .. } => (edges[b], edges[b + 1]),
                &Bins::Width { width, origin } => {
                    let i = first + b as f64;
                    (origin + i * width, origin + (i + 1.0) * width)
                }
            };
            if !start.is_finite() || !end.is_finite() || end <= start {
                return Err(invalid(
                    CALL,
                    &format!(
                        "bin [{start}, {end}) is not a range f64 can hold; use a larger width or edges"
                    ),
                ));
            }
            starts.push(start);
            ends.push(end);
        }
        // The rows of each bin, bin after bin, in row order (a counting
        // sort).
        let mut first_row = vec![0u32; count + 1];
        for &b in bin_of.iter().filter(|&&b| b != NONE) {
            first_row[b as usize + 1] += 1;
        }
        for b in 0..count {
            first_row[b + 1] += first_row[b];
        }
        let mut next = first_row.clone();
        let mut order = vec![0u32; first_row[count] as usize];
        for (row, &b) in bin_of.iter().enumerate() {
            if b != NONE {
                order[next[b as usize] as usize] = row as u32;
                next[b as usize] += 1;
            }
        }
        let ranges: Vec<Range<usize>> = (0..count)
            .map(|b| first_row[b] as usize..first_row[b + 1] as usize)
            .collect();
        let (holder, plan) = self.holder(&plan, &order);
        let plan: Vec<(&Agg, usize)> = plan.iter().map(|&(s, a)| (a, s)).collect();
        let reduced = holder.reduce_columns(CALL, &plan, &ranges)?;
        let mut columns = vec![
            Column::required("start", starts),
            Column::required("end", ends),
        ];
        columns.extend(reduced);
        Ok(Table {
            columns,
            rows: count,
        })
    }

    /// For each row, reduce the rows whose value in the number column
    /// `column` is within `radius` of its own (pond-ts
    /// `rollingByColumn(column, { radius }, mapping)`): a rolling window
    /// along a distance or another rising axis instead of time, such as a
    /// band of speed percentiles along a route. One output row per row of
    /// this series, with one column per entry of `aggs`, in the order
    /// given.
    ///
    /// ```
    /// use pond_rs::{Agg, Column, Reducer, TimeSeries};
    /// let s = TimeSeries::new("run", vec![0, 1_000, 2_000, 3_000], vec![
    ///     Column::required("km", vec![0.0, 0.4, 1.1, 1.3]),
    ///     Column::required("pace", vec![300.0, 310.0, 290.0, 280.0]),
    /// ])?;
    /// let band = s.rolling_by_column("km", 0.5, &[Agg::new("pace", "pace", Reducer::Avg)])?;
    /// // Row 1 (0.4 km) sees 0 km and 0.4 km; row 2 (1.1 km) sees 1.1 and 1.3.
    /// assert_eq!(band.column("pace")?.numbers()?.values(), &[305.0, 305.0, 285.0, 285.0]);
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    ///
    /// The window around a value `x` holds the rows with values in
    /// `[x - radius, x + radius]`. `column` must never go down, ignoring
    /// gaps; a row whose value is a gap is in no window and gets each
    /// reducer's empty value (`count` 0, `sum` 0, an empty list for the
    /// list reducers, a gap otherwise). Each window is reduced as
    /// [`TimeSeries::rolling`] reduces a window, with the same reducers,
    /// kinds and rules. `radius` must be a positive finite number.
    pub fn rolling_by_column(&self, column: &str, radius: f64, aggs: &[Agg]) -> Result<Table> {
        self.roll_by_column(column, radius, None, aggs)
    }

    /// [`TimeSeries::rolling_by_column`] with windows around `centers`
    /// instead of around each row (pond-ts
    /// `rollingByColumn(column, { radius, at })`): one output row per
    /// center, such as the points of a chart's grid. `centers` must be
    /// finite and never go down; a center with no rows within `radius`
    /// gets each reducer's empty value.
    pub fn rolling_by_column_at(
        &self,
        column: &str,
        radius: f64,
        centers: &[f64],
        aggs: &[Agg],
    ) -> Result<Table> {
        self.roll_by_column(column, radius, Some(centers), aggs)
    }

    fn roll_by_column(
        &self,
        column: &str,
        radius: f64,
        centers: Option<&[f64]>,
        aggs: &[Agg],
    ) -> Result<Table> {
        const CALL: &str = "rolling_by_column";
        let (_, values) = self.number_source(CALL, column)?;
        if !radius.is_finite() || radius <= 0.0 {
            return Err(invalid(CALL, "radius must be a positive finite number"));
        }
        let plan = self.value_axis_plan(CALL, aggs, &[])?;
        // The rows with a value, in order; that order must not go down.
        let mut rows = Vec::with_capacity(values.len());
        let mut axis = Vec::with_capacity(values.len());
        for (row, &v) in values.iter().enumerate() {
            if !v.is_finite() {
                continue;
            }
            if let Some(&prev) = axis.last()
                && v < prev
            {
                return Err(invalid(
                    CALL,
                    &format!("column '{column}' must not go down; row {row} ({v}) is below {prev}"),
                ));
            }
            rows.push(row as u32);
            axis.push(v);
        }
        if let Some(centers) = centers {
            for (k, &c) in centers.iter().enumerate() {
                if !c.is_finite() {
                    return Err(invalid(CALL, &format!("center {k} ({c}) is not finite")));
                }
                if k > 0 && c < centers[k - 1] {
                    return Err(invalid(CALL, "centers must not go down"));
                }
            }
        }
        // Each window as a run of the rows with a value, worked out with
        // pond-ts's comparisons: in while `value <= center + radius`, out
        // while `value < center - radius`.
        let mut windows = Vec::with_capacity(centers.map_or(axis.len(), <[f64]>::len));
        let (mut lo, mut hi) = (0usize, 0usize);
        let mut place = |c: f64| {
            let (from, to) = (c - radius, c + radius);
            while hi < axis.len() && axis[hi] <= to {
                hi += 1;
            }
            while lo < hi && axis[lo] < from {
                lo += 1;
            }
            lo..hi
        };
        match centers {
            Some(centers) => windows.extend(centers.iter().map(|&c| place(c))),
            None => windows.extend(axis.iter().map(|&c| place(c))),
        }
        let (holder, plan) = self.holder(&plan, &rows);
        let rolled = holder.roll_columns(CALL, &windows_frame(&windows), &plan)?;
        let columns = if centers.is_none() && rows.len() < values.len() {
            // Rows without a value take each reducer's empty value, from a
            // window that holds nothing.
            let nothing = [Range { start: 0, end: 0 }];
            let empty = holder.roll_columns(CALL, &windows_frame(&nothing), &plan)?;
            let mut placed = 0u32;
            let picks: Vec<(u32, u32)> = values
                .iter()
                .map(|v| {
                    if v.is_finite() {
                        placed += 1;
                        (0, placed - 1)
                    } else {
                        (1, 0)
                    }
                })
                .collect();
            rolled
                .iter()
                .zip(&empty)
                .map(|(r, e)| {
                    let data = ColumnData::gather(&[r.data(), e.data()], &picks);
                    Column::from_data(r.name().to_string(), data, false)
                })
                .collect()
        } else {
            rolled
        };
        let rows = match centers {
            Some(_) => windows.len(),
            None => values.len(),
        };
        Ok(Table { columns, rows })
    }

    /// Check `aggs` for `by_column` / `rolling_by_column` and pair each
    /// with its source column, in the order given. No two outputs may
    /// share a name, nor take one of `reserved`.
    fn value_axis_plan<'a>(
        &self,
        call: &'static str,
        aggs: &'a [Agg],
        reserved: &[&str],
    ) -> Result<Vec<(usize, &'a Agg)>> {
        let mut plan = Vec::with_capacity(aggs.len());
        for (i, agg) in aggs.iter().enumerate() {
            let source = self.column_index(call, &agg.source)?;
            agg.reducer.check(call)?;
            if reserved.contains(&agg.output.as_str())
                || aggs[..i].iter().any(|a| a.output == agg.output)
            {
                return Err(PondError::DuplicateOutput {
                    call,
                    column: agg.output.clone(),
                });
            }
            check_source_kind(call, &self.columns()[source], agg.reducer)?;
            plan.push((source, agg));
        }
        Ok(plan)
    }

    /// A series of just the `rows` of the columns `plan` reads, and `plan`
    /// pointed at them.
    fn holder<'a>(
        &self,
        plan: &[(usize, &'a Agg)],
        rows: &[u32],
    ) -> (TimeSeries, Vec<(usize, &'a Agg)>) {
        let indices = UInt32Array::from(rows.to_vec());
        let mut sources: Vec<usize> = Vec::new();
        let plan = plan
            .iter()
            .map(|&(source, agg)| {
                let at = sources
                    .iter()
                    .position(|&s| s == source)
                    .unwrap_or_else(|| {
                        sources.push(source);
                        sources.len() - 1
                    });
                (at, agg)
            })
            .collect();
        let columns = sources
            .iter()
            .map(|&s| {
                let c = &self.columns()[s];
                Column::from_data(c.name().to_string(), c.data().take_indices(&indices), false)
            })
            .collect();
        let holder = TimeSeries::from_parts(
            self.name().to_string(),
            "time".to_string(),
            Key::Time(vec![0; rows.len()]),
            columns,
        );
        (holder, plan)
    }
}

/// A rolling frame of explicit windows, one output row each.
fn windows_frame(windows: &[Range<usize>]) -> Frame<'_> {
    Frame {
        times: &[],
        span: Span::Windows(windows),
        alignment: Alignment::default(),
        min_samples: 0,
    }
}

fn invalid(call: &'static str, message: &str) -> PondError {
    PondError::InvalidData {
        call,
        message: message.to_string(),
    }
}

fn check_edges(call: &'static str, edges: &[f64]) -> Result<()> {
    if edges.len() < 2 {
        return Err(invalid(call, "edges must have at least 2 entries"));
    }
    for (i, &e) in edges.iter().enumerate() {
        if !e.is_finite() {
            return Err(invalid(call, &format!("edge {i} ({e}) is not finite")));
        }
        if i > 0 && e <= edges[i - 1] {
            return Err(invalid(call, "edges must be strictly rising"));
        }
    }
    Ok(())
}

/// The bin of `v` among `edges`, or `None` outside them, by pond-ts's
/// binary search.
fn edge_bin(edges: &[f64], v: f64, upper_inclusive: bool) -> Option<usize> {
    let last = edges.len() - 1;
    let (mut lo, mut hi) = (0usize, last);
    if upper_inclusive {
        if v < edges[0] || v > edges[last] {
            return None;
        }
        // The last edge strictly below `v`, so a value on an inner edge
        // goes to the bin below.
        while lo < hi {
            let mid = (lo + hi).div_ceil(2);
            if edges[mid] < v {
                lo = mid
            } else {
                hi = mid - 1
            }
        }
    } else {
        if v < edges[0] || v >= edges[last] {
            return None;
        }
        while lo < hi {
            let mid = (lo + hi).div_ceil(2);
            if edges[mid] <= v {
                lo = mid
            } else {
                hi = mid - 1
            }
        }
    }
    Some(lo)
}

/// The width bin of `v`, as pond-ts works it out: `floor((v - origin) /
/// width)`, then moved by at most a few steps so that `v` lies in
/// `[origin + bin * width, origin + (bin + 1) * width)` (division and
/// multiplication round differently).
fn width_bin(v: f64, width: f64, origin: f64) -> f64 {
    let mut bin = ((v - origin) / width).floor();
    let mut guard = 0;
    while v < origin + bin * width && guard < 4 {
        guard += 1;
        bin -= 1.0;
    }
    // The second loop shares the counter, as in pond-ts.
    while v >= origin + (bin + 1.0) * width && guard < 4 {
        guard += 1;
        bin += 1.0;
    }
    bin
}
