//! The reducers that give a list: `unique`, `top<N>` and `samples`.
//!
//! pond-ts runs them over each bucket or window's values with an array
//! column's lists flattened one level, so a bucket of `["a", "b"]` and
//! `["b"]` holds `a`, `b`, `b`. Here every element is given an id first:
//! numbers, text and true/false values become small whole numbers, so
//! counting and sorting in the reducers never compares text.
//!
//! - `unique`: the distinct values, sorted numbers first, then text, then
//!   true/false (pond-ts `compareScalars`). Numbers compare as JavaScript's
//!   `Set` does, so `0` and `-0` are one value, written `0`.
//! - `top<N>`: the N most frequent values, ties in the `unique` order.
//! - `samples`: every value in arrival order, duplicates and `-0` kept.
//!
//! An empty bucket or window gives an empty list (a value, not a gap), as
//! in pond-ts.

use std::cmp::{Ordering, Reverse};
use std::collections::{BTreeSet, HashMap};
use std::ops::Range;
use std::sync::Arc;

use arrow_array::{Float64Array, ListArray};
use arrow_buffer::OffsetBuffer;
use arrow_schema::{DataType, Field};

use crate::column::{ArrayColumn, Cell, ColumnData, Scalar};
use crate::reducer::Reducer;
use crate::rolling::{Frame, Window, walk};

/// A source column's elements, row by row, as ids.
pub(crate) struct Elements {
    /// Row `r`'s elements are `items[offsets[r]..offsets[r + 1]]`.
    offsets: Vec<usize>,
    /// Exact ids: `0` and `-0` differ (for `samples`).
    items: Vec<u32>,
    /// The value of each exact id.
    exact: Vec<Scalar>,
    /// Each exact id's distinct id: `0` and `-0` share one. Distinct ids
    /// are numbered in `unique` order, so sorting ids sorts values.
    distinct_of: Vec<u32>,
    /// The value of each distinct id (`0`, never `-0`).
    distinct: Vec<Scalar>,
}

/// A borrowed element as a hash key: numbers by their bits.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Key<'a> {
    Number(u64),
    Text(&'a str),
    Boolean(bool),
}

impl Key<'_> {
    fn of(e: &Scalar) -> Key<'_> {
        match e {
            Scalar::Number(v) => Key::Number(v.to_bits()),
            Scalar::String(s) => Key::Text(s),
            Scalar::Boolean(b) => Key::Boolean(*b),
        }
    }
}

/// pond-ts `compareScalars`: numbers, then text, then true/false; within a
/// kind JavaScript's `<`, which orders text by UTF-16 code units (not by
/// UTF-8 bytes: `"\u{FFFF}"` comes after `"😀"`).
pub(crate) fn compare_scalars(a: &Scalar, b: &Scalar) -> Ordering {
    match (a, b) {
        (Scalar::Number(x), Scalar::Number(y)) => x.partial_cmp(y).expect("finite"),
        (Scalar::String(x), Scalar::String(y)) => x.encode_utf16().cmp(y.encode_utf16()),
        (Scalar::Boolean(x), Scalar::Boolean(y)) => x.cmp(y),
        _ => kind_rank(a).cmp(&kind_rank(b)),
    }
}

fn kind_rank(e: &Scalar) -> u8 {
    match e {
        Scalar::Number(_) => 0,
        Scalar::String(_) => 1,
        Scalar::Boolean(_) => 2,
    }
}

/// One list per row range (an `aggregate` bucket, or `reduce`'s one): the
/// reducer over the range's rows of `data`.
///
/// Cost: `samples` of a number or decimal column copies the present values
/// once into an Arrow list ([`samples_list`]) and builds no cell. Every
/// other case gives each element an id first ([`Elements::new`]) and makes
/// one cell per range.
pub(crate) fn reduce_ranges(
    data: &ColumnData,
    reducer: Reducer,
    ranges: &[Range<usize>],
) -> ArrayColumn {
    if reducer == Reducer::Samples
        && let Some(lists) = samples_list(data, ranges)
    {
        return lists;
    }
    Elements::new(data).reduce_ranges(reducer, ranges)
}

/// `samples` over each row range of a number or decimal column: the
/// range's present values in row order (`-0` kept; a decimal as its nearest
/// `f64`), as an Arrow list of numbers. `None` for a column of another
/// kind, when no range holds a value (a column with no elements is not
/// kept as a list of numbers), or when the lists would hold more items
/// than an Arrow list can.
fn samples_list(data: &ColumnData, ranges: &[Range<usize>]) -> Option<ArrayColumn> {
    let rows: usize = ranges.iter().map(|r| r.len()).sum();
    if rows > i32::MAX as usize {
        return None;
    }
    let mut items: Vec<f64> = Vec::with_capacity(rows);
    let mut offsets: Vec<i32> = Vec::with_capacity(ranges.len() + 1);
    offsets.push(0);
    match data {
        ColumnData::Number(c) => {
            let v = c.values();
            for r in ranges {
                if c.all_finite() {
                    items.extend_from_slice(&v[r.clone()]);
                } else {
                    items.extend(v[r.clone()].iter().copied().filter(|x| x.is_finite()));
                }
                offsets.push(items.len() as i32);
            }
        }
        ColumnData::Decimal(c) => {
            let v = c.to_f64s();
            let nulls = c.nulls();
            for r in ranges {
                match nulls {
                    None => items.extend_from_slice(&v[r.clone()]),
                    Some(n) => items.extend(r.clone().filter(|&i| n.is_valid(i)).map(|i| v[i])),
                }
                offsets.push(items.len() as i32);
            }
        }
        _ => return None,
    }
    if items.is_empty() {
        return None;
    }
    let item = Arc::new(Field::new_list_field(DataType::Float64, false));
    Some(ArrayColumn::from_list(ListArray::new(
        item,
        OffsetBuffer::new(offsets.into()),
        Arc::new(Float64Array::new(items.into(), None)),
        None,
    )))
}

impl Elements {
    /// Every present value of `data`, an array's elements one by one. A
    /// decimal is read as its nearest `f64`.
    pub(crate) fn new(data: &ColumnData) -> Self {
        let mut b = Builder::default();
        match data {
            ColumnData::Number(c) => {
                for v in c.values() {
                    if v.is_finite() {
                        b.push(Key::Number(v.to_bits()), || Scalar::Number(*v));
                    }
                    b.end_row();
                }
            }
            ColumnData::Decimal(c) => {
                let present = |i: usize| c.nulls().is_none_or(|n| n.is_valid(i));
                for (i, v) in c.to_f64s().into_iter().enumerate() {
                    if present(i) {
                        b.push(Key::Number(v.to_bits()), || Scalar::Number(v));
                    }
                    b.end_row();
                }
            }
            ColumnData::String(c) => {
                for s in c.iter() {
                    if let Some(s) = s {
                        b.push(Key::Text(s), || Scalar::String(s.to_string()));
                    }
                    b.end_row();
                }
            }
            ColumnData::Boolean(c) => {
                for v in c.iter() {
                    if let Some(v) = v {
                        b.push(Key::Boolean(v), || Scalar::Boolean(v));
                    }
                    b.end_row();
                }
            }
            ColumnData::Array(c) => {
                for cell in c.iter() {
                    for e in cell.unwrap_or(&[]) {
                        b.push(Key::of(e), || e.clone());
                    }
                    b.end_row();
                }
            }
        }
        b.finish()
    }

    fn row_items(&self, rows: Range<usize>) -> &[u32] {
        &self.items[self.offsets[rows.start]..self.offsets[rows.end]]
    }

    /// The reducer over the rows in `rows` (pond-ts `reduce` / bucket
    /// state; the two agree), as ids into `lists`' table. `seen` (one
    /// count per distinct id, left all zero) and `found` are scratch.
    fn reduce(
        &self,
        reducer: Reducer,
        rows: Range<usize>,
        seen: &mut [u32],
        found: &mut Vec<u32>,
        lists: &mut Lists<'_>,
    ) -> Cell {
        let items = self.row_items(rows);
        found.clear();
        match reducer {
            Reducer::Samples => return lists.cell(items),
            Reducer::Unique => {
                for &id in items {
                    let d = self.distinct_of[id as usize];
                    if seen[d as usize] == 0 {
                        seen[d as usize] = 1;
                        found.push(d);
                    }
                }
                found.sort_unstable();
            }
            Reducer::Top(n) => {
                for &id in items {
                    let d = self.distinct_of[id as usize];
                    if seen[d as usize] == 0 {
                        found.push(d);
                    }
                    seen[d as usize] += 1;
                }
                found.sort_unstable_by_key(|&d| (Reverse(seen[d as usize]), d));
                found.truncate(n);
            }
            _ => unreachable!("not a list reducer"),
        }
        for &id in items {
            seen[self.distinct_of[id as usize] as usize] = 0;
        }
        lists.cell(found)
    }

    /// One list per row range (an `aggregate` bucket, or `reduce`'s one).
    pub(crate) fn reduce_ranges(&self, reducer: Reducer, ranges: &[Range<usize>]) -> ArrayColumn {
        let mut seen = vec![0u32; self.distinct.len()];
        let mut found = Vec::new();
        let mut lists = Lists::new(self, reducer);
        ArrayColumn::from_cells(
            ranges
                .iter()
                .map(|r| Some(self.reduce(reducer, r.clone(), &mut seen, &mut found, &mut lists)))
                .collect(),
        )
    }

    /// One list per row of a rolling window (see `TimeSeries::rolling`).
    pub(crate) fn roll(&self, reducer: Reducer, frame: &Frame) -> ArrayColumn {
        let mut w = RollingLists {
            elements: self,
            reducer,
            counts: vec![0; self.distinct.len()],
            present: BTreeSet::new(),
            by_count: BTreeSet::new(),
            start: 0,
            end: 0,
            ids: Vec::new(),
            lists: Lists::new(self, reducer),
            out: vec![None; frame.len()],
        };
        walk(frame, &mut w);
        ArrayColumn::from_cells(w.out)
    }
}

/// Makes the output lists from ids. Neighbouring buckets and windows often
/// give the same list (a host that reports for a while), so a list equal
/// to the one before shares its memory instead of copying the values.
struct Lists<'a> {
    table: &'a [Scalar],
    last_ids: Vec<u32>,
    last: Option<Cell>,
}

impl<'a> Lists<'a> {
    fn new(elements: &'a Elements, reducer: Reducer) -> Self {
        Self {
            // `samples` keeps `-0`, so it reads the exact values.
            table: if reducer == Reducer::Samples {
                &elements.exact
            } else {
                &elements.distinct
            },
            last_ids: Vec::new(),
            last: None,
        }
    }

    fn cell(&mut self, ids: &[u32]) -> Cell {
        if let Some(last) = &self.last
            && self.last_ids == ids
        {
            return last.clone();
        }
        let cell: Cell = ids
            .iter()
            .map(|&id| self.table[id as usize].clone())
            .collect();
        self.last_ids.clear();
        self.last_ids.extend_from_slice(ids);
        self.last = Some(cell.clone());
        cell
    }
}

#[derive(Default)]
struct Builder<'a> {
    offsets: Vec<usize>,
    items: Vec<u32>,
    ids: HashMap<Key<'a>, u32>,
    exact: Vec<Scalar>,
    /// The last element pushed: runs of one value skip the hash.
    last: Option<(Key<'a>, u32)>,
}

impl<'a> Builder<'a> {
    fn push(&mut self, key: Key<'a>, value: impl FnOnce() -> Scalar) {
        if self.offsets.is_empty() {
            self.offsets.push(0);
        }
        let id = match self.last {
            Some((k, id)) if k == key => id,
            _ => {
                let exact = &mut self.exact;
                let id = *self.ids.entry(key).or_insert_with(|| {
                    exact.push(value());
                    (exact.len() - 1) as u32
                });
                self.last = Some((key, id));
                id
            }
        };
        self.items.push(id);
    }

    fn end_row(&mut self) {
        if self.offsets.is_empty() {
            self.offsets.push(0);
        }
        self.offsets.push(self.items.len());
    }

    fn finish(mut self) -> Elements {
        if self.offsets.is_empty() {
            self.offsets.push(0);
        }
        // Distinct values: `-0` is `0`, as a JavaScript `Set` or `Map` key.
        let canonical = |e: &Scalar| match e {
            Scalar::Number(v) => Scalar::Number(v + 0.0),
            other => other.clone(),
        };
        let mut order: Vec<u32> = (0..self.exact.len() as u32).collect();
        order.sort_by(|&a, &b| {
            compare_scalars(
                &canonical(&self.exact[a as usize]),
                &canonical(&self.exact[b as usize]),
            )
        });
        let mut distinct: Vec<Scalar> = Vec::new();
        let mut distinct_of = vec![0u32; self.exact.len()];
        for id in order {
            let value = canonical(&self.exact[id as usize]);
            if distinct.last() != Some(&value) {
                distinct.push(value);
            }
            distinct_of[id as usize] = (distinct.len() - 1) as u32;
        }
        Elements {
            offsets: self.offsets,
            items: self.items,
            exact: self.exact,
            distinct_of,
            distinct,
        }
    }
}

/// The window state for all three reducers. The window is always a
/// contiguous run of rows, `start..end`, so `samples` reads its elements
/// straight from that run; `unique` keeps the distinct ids present and
/// `top` the ids ordered by count.
struct RollingLists<'a> {
    elements: &'a Elements,
    reducer: Reducer,
    counts: Vec<u32>,
    present: BTreeSet<u32>,
    by_count: BTreeSet<(Reverse<u32>, u32)>,
    start: usize,
    end: usize,
    /// Scratch for the ids of the list being made.
    ids: Vec<u32>,
    lists: Lists<'a>,
    out: Vec<Option<Cell>>,
}

impl RollingLists<'_> {
    fn change(&mut self, row: usize, up: bool) {
        if self.reducer == Reducer::Samples {
            return;
        }
        let top = matches!(self.reducer, Reducer::Top(_));
        for &id in self.elements.row_items(row..row + 1) {
            let d = self.elements.distinct_of[id as usize];
            let c = &mut self.counts[d as usize];
            let old = *c;
            *c = if up { old + 1 } else { old - 1 };
            let new = *c;
            if top {
                if old > 0 {
                    self.by_count.remove(&(Reverse(old), d));
                }
                if new > 0 {
                    self.by_count.insert((Reverse(new), d));
                }
            } else if old == 0 {
                self.present.insert(d);
            } else if new == 0 {
                self.present.remove(&d);
            }
        }
    }
}

impl Window for RollingLists<'_> {
    fn enter(&mut self, row: usize) {
        self.end = row + 1;
        self.change(row, true);
    }
    fn leave(&mut self, row: usize) {
        self.start = row + 1;
        self.change(row, false);
    }
    fn emit(&mut self, rows: Range<usize>) {
        let e = self.elements;
        let cell = match self.reducer {
            Reducer::Samples => self.lists.cell(e.row_items(self.start..self.end)),
            Reducer::Unique => {
                self.ids.clear();
                self.ids.extend(self.present.iter());
                self.lists.cell(&self.ids)
            }
            Reducer::Top(n) => {
                self.ids.clear();
                self.ids
                    .extend(self.by_count.iter().take(n).map(|&(_, d)| d));
                self.lists.cell(&self.ids)
            }
            _ => unreachable!("not a list reducer"),
        };
        for r in rows {
            self.out[r] = Some(cell.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The rolling states give what the range kernels give on each
    /// window's rows, on columns of every kind with repeats and zeros.
    #[test]
    fn rolling_matches_the_range_kernels() {
        let mut seed = 5u64;
        let mut next = move || {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (seed >> 33) as usize
        };
        let pool = [
            Scalar::Number(0.0),
            Scalar::Number(-0.0),
            Scalar::Number(2.5),
            Scalar::String("b".into()),
            Scalar::String("a".into()),
            Scalar::Boolean(true),
        ];
        for _ in 0..200 {
            let n = next() % 40;
            let mut t = 0i64;
            let times: Vec<i64> = (0..n)
                .map(|_| {
                    t += (next() % 3) as i64;
                    t
                })
                .collect();
            let cells: Vec<Option<Vec<Scalar>>> = (0..n)
                .map(|_| {
                    (next() % 5 != 0)
                        .then(|| (0..next() % 4).map(|_| pool[next() % 6].clone()).collect())
                })
                .collect();
            let numbers: Vec<Option<f64>> = (0..n)
                .map(|_| (next() % 4 != 0).then(|| [0.0, -0.0, 1.0][next() % 3]))
                .collect();
            let window = 1 + (next() % 5) as i64;
            for data in [
                ColumnData::Array(ArrayColumn::from_options(cells)),
                ColumnData::from(numbers),
            ] {
                let e = Elements::new(&data);
                // Each row's window: rows with time in (t - window, t].
                let ranges: Vec<Range<usize>> = times
                    .iter()
                    .map(|&at| {
                        let lo = times.partition_point(|&u| u <= at - window);
                        lo..times.partition_point(|&u| u <= at)
                    })
                    .collect();
                for reducer in [Reducer::Unique, Reducer::Top(2), Reducer::Samples] {
                    let frame = Frame {
                        times: &times,
                        span: crate::rolling::Span::Time(window),
                        alignment: crate::rolling::Alignment::Trailing,
                        min_samples: 0,
                    };
                    let got = e.roll(reducer, &frame);
                    let want = e.reduce_ranges(reducer, &ranges);
                    assert_eq!(got, want, "{reducer:?} {times:?} {window}");
                }
            }
        }
    }

    /// `samples` written straight to a list gives what the id path gives.
    #[test]
    fn samples_lists_match_the_id_path() {
        let numbers: Vec<Option<f64>> = (0..60)
            .map(|i| (i % 7 != 3).then(|| [0.0, -0.0, 1.5, -2.0][i % 4]))
            .collect();
        let full: Vec<f64> = (0..60).map(|i| f64::from(i % 5) - 2.0).collect();
        let decimals: Vec<Option<i128>> = (0..60)
            .map(|i| (i % 5 != 1).then_some(i as i128 * 37 - 900))
            .collect();
        let exact: Vec<Option<i128>> = (0..60).map(|i| Some(i as i128)).collect();
        let columns = [
            ColumnData::from(numbers),
            ColumnData::from(full),
            crate::DecimalColumn::from_options(decimals, 2)
                .unwrap()
                .into(),
            crate::DecimalColumn::from_options(exact, 0).unwrap().into(),
        ];
        // Buckets, one bucket, single rows, empty and overlapping ranges.
        let layouts: Vec<Vec<Range<usize>>> = vec![
            (0..6).map(|b| b * 10..b * 10 + 10).collect(),
            std::iter::once(0..60).collect(),
            (0..60).map(|r| r..r + 1).collect(),
            vec![3..4, 3..3, 0..20, 10..30, 59..60, 60..60],
            vec![],
        ];
        for data in &columns {
            for ranges in &layouts {
                let want = Elements::new(data).reduce_ranges(Reducer::Samples, ranges);
                let got = reduce_ranges(data, Reducer::Samples, ranges);
                assert_eq!(got.missing_count(), 0);
                assert_eq!(got.first_bad_element(), None);
                assert_eq!(got, want);
                assert_eq!(
                    got.list_view().is_some(),
                    want.iter().flatten().any(|c| !c.is_empty())
                );
            }
        }
        // No value anywhere: empty lists, not kept as a list of numbers.
        let gaps = ColumnData::from(vec![None::<f64>; 4]);
        assert!(samples_list(&gaps, &[0..2, 2..4]).is_none());
        let got = reduce_ranges(&gaps, Reducer::Samples, &[0..2, 2..4]);
        assert_eq!(got.get(0), Some(&[][..]));
        // Text goes the id path.
        let text = ColumnData::from(vec!["a", "b"]);
        assert!(samples_list(&text, &[0..1, 1..2]).is_none());
    }

    #[test]
    fn text_sorts_by_utf16_units() {
        let s = |x: &str| Scalar::String(x.into());
        assert_eq!(compare_scalars(&s("😀"), &s("\u{FFFF}")), Ordering::Less);
        assert_eq!(compare_scalars(&s("B"), &s("a")), Ordering::Less);
        assert_eq!(
            compare_scalars(&Scalar::Boolean(false), &s("z")),
            Ordering::Greater
        );
    }
}
