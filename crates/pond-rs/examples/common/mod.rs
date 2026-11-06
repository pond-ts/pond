//! Shared by the `perf_*` examples: timing, and writing each case's answer
//! out so `bench/check_outputs.py` can compare it with polars'.
//!
//! Set `BENCH_DUMP=<dir>` and every timed case also writes the result of
//! its warm-up run to `<dir>/<case>.json` (or `.txt` for text, `.arrow` for
//! Arrow IPC bytes). The write happens before the timed runs, so it is not
//! timed. Unset, nothing is written.
//!
//! The JSON is `{"columns": [{"name": …, "values": […]}, …]}`, laid out as
//! `TimeSeries::to_arrow` lays out its fields: the key first (`time`, then
//! `timeEnd` for range and interval keys), value columns in order, and an
//! interval key's label last (`timeLabel`). Gaps are `null`; infinities are
//! the strings `"inf"` / `"-inf"`; array cells are lists.

#![allow(dead_code)]

use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;

use pond_rs::{
    Column, ColumnData, Key, Labels, PartitionedSeries, Reduced, Scalar, Table, TimeSeries,
};
use serde_json::{Value as J, json};

/// What a case's answer is written as.
pub enum Dumped {
    /// A table of columns (see the module docs).
    Columns(Vec<(String, Vec<J>)>),
    /// Text (JSON the case produced).
    Text(String),
    /// Arrow IPC file bytes.
    Ipc(Vec<u8>),
}

pub trait Dump {
    fn dump(&self) -> Dumped;
}

fn number(x: Option<f64>) -> J {
    match x {
        None => J::Null,
        Some(x) if x.is_nan() => J::Null,
        Some(x) if x == f64::INFINITY => json!("inf"),
        Some(x) if x == f64::NEG_INFINITY => json!("-inf"),
        Some(x) => json!(x),
    }
}

fn scalar(s: &Scalar) -> J {
    match s {
        Scalar::Number(x) => number(Some(*x)),
        Scalar::String(t) => json!(t),
        Scalar::Boolean(b) => json!(b),
    }
}

/// One column's cells as JSON values.
pub fn cells(c: &Column) -> Vec<J> {
    match c.data() {
        ColumnData::Number(v) => v.iter().map(number).collect(),
        ColumnData::Decimal(v) => v.iter().map(|d| number(d.map(|d| d.to_f64()))).collect(),
        ColumnData::String(v) => v.iter().map(|s| s.map_or(J::Null, |s| json!(s))).collect(),
        ColumnData::Boolean(v) => v.iter().map(|b| b.map_or(J::Null, |b| json!(b))).collect(),
        ColumnData::Array(v) => v
            .iter()
            .map(|a| a.map_or(J::Null, |a| J::Array(a.iter().map(scalar).collect())))
            .collect(),
    }
}

fn times(t: &[i64]) -> Vec<J> {
    t.iter().map(|&x| json!(x)).collect()
}

/// A series as columns: key, values, then an interval key's label.
pub fn series_columns(s: &TimeSeries) -> Vec<(String, Vec<J>)> {
    let k = s.key_name().to_string();
    let mut out = Vec::new();
    let mut label = None;
    match s.key() {
        Key::Time(t) => out.push((k.clone(), times(t))),
        Key::TimeRange(r) => {
            out.push((k.clone(), times(&r.begin)));
            out.push((format!("{k}End"), times(&r.end)));
        }
        Key::Interval(i) => {
            out.push((k.clone(), times(&i.begin)));
            out.push((format!("{k}End"), times(&i.end)));
            label = Some(match &i.label {
                Labels::Number(v) => v.iter().map(|&x| number(Some(x))).collect(),
                Labels::String(v) => v.iter().map(|s| s.map_or(J::Null, |s| json!(s))).collect(),
            });
        }
    }
    for c in s.columns() {
        out.push((c.name().to_string(), cells(c)));
    }
    if let Some(label) = label {
        out.push((format!("{k}Label"), label));
    }
    out
}

impl Dump for TimeSeries {
    fn dump(&self) -> Dumped {
        Dumped::Columns(series_columns(self))
    }
}

impl Dump for Table {
    fn dump(&self) -> Dumped {
        Dumped::Columns(
            self.columns()
                .iter()
                .map(|c| (c.name().to_string(), cells(c)))
                .collect(),
        )
    }
}

/// The partitions one after another, ordered by their key (as text), each
/// with a leading `part` column naming its key.
impl Dump for PartitionedSeries {
    fn dump(&self) -> Dumped {
        let mut parts: Vec<(String, &TimeSeries)> = self
            .iter()
            .map(|(key, s)| {
                let names: Vec<String> = key
                    .iter()
                    .map(|v| match v {
                        Some(pond_rs::Value::String(t)) => t.clone(),
                        Some(v) => format!("{v:?}"),
                        None => "null".into(),
                    })
                    .collect();
                (names.join("|"), s)
            })
            .collect();
        parts.sort_by(|a, b| a.0.cmp(&b.0));
        let mut out: Vec<(String, Vec<J>)> = vec![("part".into(), Vec::new())];
        for (key, s) in parts {
            let cols = series_columns(s);
            if out.len() == 1 {
                out.extend(cols.iter().map(|(n, _)| (n.clone(), Vec::new())));
            }
            out[0].1.extend(std::iter::repeat_n(json!(key), s.len()));
            for (slot, (_, v)) in out[1..].iter_mut().zip(cols) {
                slot.1.extend(v);
            }
        }
        Dumped::Columns(out)
    }
}

/// One row: each output as a column.
impl Dump for Reduced {
    fn dump(&self) -> Dumped {
        Dumped::Columns(
            self.columns()
                .iter()
                .map(|c| (c.name().to_string(), cells(c)))
                .collect(),
        )
    }
}

/// A series whose list column `out` is too big to write whole: each row's
/// list as its length, sum (numbers), first and last element.
pub struct ListDigest(pub TimeSeries);

impl Dump for ListDigest {
    fn dump(&self) -> Dumped {
        let s = &self.0;
        let mut cols = vec![(
            s.key_name().to_string(),
            match s.key() {
                Key::Time(t) => times(t),
                _ => panic!("ListDigest needs a time key"),
            },
        )];
        let lists = s.column("out").unwrap().arrays().unwrap();
        let rows: Vec<Option<&[Scalar]>> = lists.iter().collect();
        let len = rows
            .iter()
            .map(|r| number(r.map(|r| r.len() as f64)))
            .collect();
        let sum = rows
            .iter()
            .map(|r| number(r.map(|r| r.iter().filter_map(Scalar::as_f64).sum())))
            .collect();
        let first = rows
            .iter()
            .map(|r| r.and_then(|r| r.first()).map_or(J::Null, scalar))
            .collect();
        let last = rows
            .iter()
            .map(|r| r.and_then(|r| r.last()).map_or(J::Null, scalar))
            .collect();
        cols.push(("len".into(), len));
        cols.push(("sum".into(), sum));
        cols.push(("first".into(), first));
        cols.push(("last".into(), last));
        Dumped::Columns(cols)
    }
}

/// Arrow IPC file bytes of the batch.
impl Dump for arrow_array::RecordBatch {
    fn dump(&self) -> Dumped {
        let mut out = Vec::new();
        let mut w = arrow_ipc::writer::FileWriter::try_new(&mut out, &self.schema()).unwrap();
        w.write(self).unwrap();
        w.finish().unwrap();
        drop(w);
        Dumped::Ipc(out)
    }
}

/// Arrow IPC file bytes.
impl Dump for Vec<u8> {
    fn dump(&self) -> Dumped {
        Dumped::Ipc(self.clone())
    }
}

impl Dump for String {
    fn dump(&self) -> Dumped {
        Dumped::Text(self.clone())
    }
}

impl Dump for Box<dyn Dump + '_> {
    fn dump(&self) -> Dumped {
        (**self).dump()
    }
}

impl Dump for Dumped {
    fn dump(&self) -> Dumped {
        match self {
            Dumped::Columns(c) => Dumped::Columns(c.clone()),
            Dumped::Text(t) => Dumped::Text(t.clone()),
            Dumped::Ipc(b) => Dumped::Ipc(b.clone()),
        }
    }
}

/// The dump directory, if `BENCH_DUMP` is set.
pub fn dump_dir() -> Option<PathBuf> {
    std::env::var_os("BENCH_DUMP").map(PathBuf::from)
}

/// A case name as a file name: letters and digits kept, the rest `_`.
pub fn slug(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

/// Write `out` as case `name`'s answer, when `BENCH_DUMP` is set.
pub fn write_dump(name: &str, out: &dyn Dump) {
    let Some(dir) = dump_dir() else { return };
    std::fs::create_dir_all(&dir).unwrap();
    let base = dir.join(slug(name));
    match out.dump() {
        Dumped::Columns(cols) => {
            let f = std::fs::File::create(base.with_extension("json")).unwrap();
            let mut w = std::io::BufWriter::new(f);
            write!(w, "{{\"columns\":[").unwrap();
            for (i, (name, values)) in cols.iter().enumerate() {
                if i > 0 {
                    write!(w, ",").unwrap();
                }
                write!(w, "{{\"name\":{},\"values\":", json!(name)).unwrap();
                serde_json::to_writer(&mut w, values).unwrap();
                write!(w, "}}").unwrap();
            }
            write!(w, "]}}").unwrap();
        }
        Dumped::Text(t) => std::fs::write(base.with_extension("txt"), t).unwrap(),
        Dumped::Ipc(b) => std::fs::write(base.with_extension("arrow"), b).unwrap(),
    }
}

/// Run `f` once to warm up (writing its answer as case `name` when
/// `BENCH_DUMP` is set), then `runs` timed times; the median in ms.
pub fn time_case<T: Dump>(name: &str, runs: usize, mut f: impl FnMut() -> T) -> f64 {
    let out = f();
    write_dump(name, &out);
    drop(out);
    let mut t: Vec<f64> = (0..runs)
        .map(|_| {
            let s = Instant::now();
            std::hint::black_box(f());
            s.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    t.sort_by(f64::total_cmp);
    t[t.len() / 2]
}
