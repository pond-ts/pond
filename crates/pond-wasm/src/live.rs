//! pond-ts's `LiveSeries` on pond-rs's live layer, with pond-ts's argument
//! shapes. Plain Rust (the JavaScript side is in `lib.rs`), so it runs and is
//! tested natively too.
//!
//! One [`Live`] owns a pond-rs `LiveSeries` and every node built on it.
//! JavaScript names a node by a handle, a small number (pond-rs's `NodeId`
//! cannot cross), and knows each node's pond-ts class ([`Class`]), which
//! fixes the methods and output kinds it has. Builders arrive as a method
//! name and its arguments as JSON (as [`crate::dispatch`]); a function
//! argument is `{"fn": k}`, called through [`LiveFns`].

use std::collections::HashMap;
use std::sync::Arc;

use pond_rs::live::{
    CollectOptions, History, LiveAggregation, LiveEvent, LiveOptions, LivePartitioned,
    LivePartitionedRolling, LiveReduce, LiveRolling, LiveSeries, LiveView, NodeId, NodeType,
    OrderingMode, OutputKind, PartitionOptions, PartitionedView, RollingOptions, RollingWindow,
    SubSeries, Trigger,
};
use pond_rs::{
    ColumnDef, ColumnKind, EventKey, FirstRow, PondError, Reducer, Sample, Scalar, TimeSeries,
    Value as Cell,
};
use serde_json::Value;

use crate::callbacks::{expr_ref, fn_ref};
use crate::dispatch::{
    Res, column_names, decode_f64, duration, fill_strategy, mapping, opt_count, pond, sequence,
    whole_number,
};

/// The functions a node was given, by position. A function that throws is
/// remembered by the implementation and costs only that event's value
/// from that node (a filter leaves the event out, a map gives gaps, a
/// running fold keeps its value); every function keeps running.
pub trait LiveFns: Send + Sync + 'static {
    /// `filter(fn)`: keep the event?
    fn test(&self, k: usize, e: &LiveEvent) -> bool;
    /// `map(fn)`: the event's new cells, in schema order.
    fn map(&self, k: usize, e: &LiveEvent) -> Vec<Option<Cell>>;
    /// `cumulative({ column: fn })`: the next running value.
    fn fold(&self, k: usize, acc: f64, v: f64) -> f64;
    /// Whether a function has thrown since the caller last took the error.
    fn failed(&self) -> bool;
}

/// No functions: for calls that pass none.
pub struct NoFns;

impl LiveFns for NoFns {
    fn test(&self, _: usize, _: &LiveEvent) -> bool {
        false
    }
    fn map(&self, _: usize, e: &LiveEvent) -> Vec<Option<Cell>> {
        vec![None; e.values().len()]
    }
    fn fold(&self, _: usize, acc: f64, _: f64) -> f64 {
        acc
    }
    fn failed(&self) -> bool {
        false
    }
}

/// A node's pond-ts class: its constructor name in pond-ts, which fixes the
/// methods and output kinds the JavaScript object has.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Class {
    Series,
    View,
    Aggregation,
    RollingAggregation,
    FusedRolling,
    Reduce,
    PartitionedSeries,
    PartitionedView,
    PartitionedFusedRolling,
    PartitionedSyncRolling,
}

impl Class {
    /// pond-ts's class name.
    pub fn name(self) -> &'static str {
        match self {
            Class::Series => "LiveSeries",
            Class::View => "LiveView",
            Class::Aggregation => "LiveAggregation",
            Class::RollingAggregation => "LiveRollingAggregation",
            Class::FusedRolling => "LiveFusedRolling",
            Class::Reduce => "LiveReduce",
            Class::PartitionedSeries => "LivePartitionedSeries",
            Class::PartitionedView => "LivePartitionedView",
            Class::PartitionedFusedRolling => "LivePartitionedFusedRolling",
            Class::PartitionedSyncRolling => "LivePartitionedSyncRolling",
        }
    }

    fn partitioned(self) -> bool {
        matches!(self, Class::PartitionedSeries | Class::PartitionedView)
    }
}

#[derive(Clone, Copy)]
struct Entry {
    id: NodeId,
    class: Class,
    /// For a partitioned view: the class of its chain's last node.
    end: Class,
}

/// A live series and its nodes, by handle (the root is handle 0).
pub struct Live {
    pub live: LiveSeries,
    nodes: Vec<Entry>,
    handles: HashMap<NodeId, u32>,
    /// The last node [`Live::handle_of`] found.
    last: std::cell::Cell<Option<(NodeId, u32)>>,
}

/// Counters, in pond-ts's `stats()` shape for each class.
pub enum Stats {
    Series(pond_rs::live::LiveStats),
    Aggregation(pond_rs::live::AggregationStats),
    Rolling(pond_rs::live::RollingStats, bool),
    Reduce(pond_rs::live::ReduceStats),
    Partitioned(pond_rs::live::PartitionStats),
    PartitionRolling(pond_rs::live::PartitionRollingStats),
}

fn invalid(message: String) -> PondError {
    PondError::InvalidData {
        call: "@pond-ts/rs",
        message,
    }
}

fn ordering(op: &str, v: &Value) -> Res<OrderingMode> {
    Ok(match v.as_str() {
        Some("strict") => OrderingMode::Strict,
        Some("drop") => OrderingMode::Drop,
        Some("reorder") => OrderingMode::Reorder,
        _ => {
            return Err(format!(
                "{op}: ordering must be 'strict', 'drop' or 'reorder', got {v}"
            ));
        }
    })
}

fn dur(op: &str, field: &str, v: &Value) -> Res<String> {
    duration(v)?.ok_or_else(|| format!("{op}: {field} must be a duration, got {v}"))
}

/// The options a series, a partition or a collected series share:
/// `ordering`, `graceWindow`, `retention: { maxEvents, maxAge }`.
/// `strict` refuses other keys (pond-ts's `partitionBy` / `collect` do).
trait SeriesOptions: Sized {
    fn set_ordering(self, m: OrderingMode) -> Self;
    fn set_grace(self, d: &str) -> Self;
    fn set_max_events(self, n: usize) -> Self;
    fn set_max_age(self, d: &str) -> Self;
    /// `name` (collect) and `groups` (partitionBy): the options and
    /// whether `key` is one this kind of options takes.
    fn extra(self, _key: &str, _v: &Value) -> Res<(Self, bool)> {
        Ok((self, false))
    }

    fn read(mut self, op: &str, o: &Value, strict: bool) -> Res<Self> {
        let Some(map) = o.as_object() else {
            return match o {
                Value::Null => Ok(self),
                _ => Err(format!("{op}: options must be an object, got {o}")),
            };
        };
        for (k, v) in map {
            self = match k.as_str() {
                "ordering" => self.set_ordering(ordering(op, v)?),
                "graceWindow" => self.set_grace(&dur(op, "graceWindow", v)?),
                "retention" => {
                    for (rk, rv) in v.as_object().into_iter().flatten() {
                        self = match rk.as_str() {
                            "maxEvents" => self.set_max_events(
                                whole_number(rv)
                                    .and_then(|n| usize::try_from(n).ok())
                                    .ok_or_else(|| {
                                        format!("{op}: retention.maxEvents must be a whole number, got {rv}")
                                    })?,
                            ),
                            "maxAge" => self.set_max_age(&dur(op, "retention.maxAge", rv)?),
                            other if strict => {
                                return Err(format!("{op}: unknown retention option '{other}'"));
                            }
                            _ => self,
                        };
                    }
                    self
                }
                other => match self.extra(other, v)? {
                    (o, true) => o,
                    _ if strict => return Err(format!("{op}: unknown option '{other}'")),
                    (o, false) => o,
                },
            };
        }
        Ok(self)
    }
}

impl SeriesOptions for LiveOptions {
    fn set_ordering(self, m: OrderingMode) -> Self {
        self.ordering(m)
    }
    fn set_grace(self, d: &str) -> Self {
        self.grace_window(d)
    }
    fn set_max_events(self, n: usize) -> Self {
        self.max_events(n)
    }
    fn set_max_age(self, d: &str) -> Self {
        self.max_age(d)
    }
}

impl SeriesOptions for PartitionOptions {
    fn set_ordering(self, m: OrderingMode) -> Self {
        self.ordering(m)
    }
    fn set_grace(self, d: &str) -> Self {
        self.grace_window(d)
    }
    fn set_max_events(self, n: usize) -> Self {
        self.max_events(n)
    }
    fn set_max_age(self, d: &str) -> Self {
        self.max_age(d)
    }
    fn extra(self, key: &str, v: &Value) -> Res<(Self, bool)> {
        if key != "groups" {
            return Ok((self, false));
        }
        let g = column_names(v)
            .ok_or_else(|| format!("partitionBy: groups must be text values, got {v}"))?;
        Ok((self.groups(&g), true))
    }
}

impl SeriesOptions for CollectOptions {
    fn set_ordering(self, m: OrderingMode) -> Self {
        self.ordering(m)
    }
    fn set_grace(self, d: &str) -> Self {
        self.grace_window(d)
    }
    fn set_max_events(self, n: usize) -> Self {
        self.max_events(n)
    }
    fn set_max_age(self, d: &str) -> Self {
        self.max_age(d)
    }
    fn extra(self, key: &str, v: &Value) -> Res<(Self, bool)> {
        if key != "name" {
            return Ok((self, false));
        }
        let n = v
            .as_str()
            .ok_or_else(|| format!("collect: name must be text, got {v}"))?;
        Ok((self.name(n), true))
    }
}

fn column_kind(k: &str, first: bool) -> Res<ColumnKind> {
    Ok(match (k, first) {
        ("time", true) => ColumnKind::Time,
        ("timeRange", true) => ColumnKind::TimeRange,
        ("interval", true) => ColumnKind::Interval,
        (_, true) => {
            return Err(format!(
                "the first schema column is the key: time, timeRange or interval, got '{k}'"
            ));
        }
        ("number", _) => ColumnKind::Number,
        ("string", _) => ColumnKind::String,
        ("boolean", _) => ColumnKind::Boolean,
        ("array", _) => ColumnKind::Array,
        (other, _) => return Err(format!("unknown column kind '{other}'")),
    })
}

/// A pond-ts schema: `[{ name, kind, required? }]`, key first; a value
/// column is required unless `required: false` (as pond-ts).
pub fn schema_of(v: &Value) -> Res<Vec<ColumnDef>> {
    let list = v.as_array().ok_or("schema must be a list of columns")?;
    list.iter()
        .enumerate()
        .map(|(i, d)| {
            let name = d["name"].as_str().ok_or("a schema column needs a name")?;
            let kind = column_kind(d["kind"].as_str().unwrap_or("number"), i == 0)?;
            Ok(ColumnDef {
                name: name.to_string(),
                kind,
                required: i == 0 || d["required"].as_bool() != Some(false),
            })
        })
        .collect()
}

/// A trigger, as the JavaScript `Trigger` writes it: `"event"`,
/// `{ every: d }`, `{ count: n }` or `{ clock: <sequence> }`.
fn trigger(op: &str, v: &Value) -> Res<Trigger> {
    if v == "event" {
        return Ok(Trigger::event());
    }
    if let Some(d) = v.get("every") {
        return pond(Trigger::every(&dur(op, "trigger", d)?));
    }
    if let Some(n) = v.get("count") {
        let n = whole_number(n)
            .and_then(|n| usize::try_from(n).ok())
            .ok_or_else(|| format!("{op}: a count trigger needs a whole number, got {n}"))?;
        return pond(Trigger::count(n));
    }
    if let Some(s) = v.get("clock") {
        return pond(Trigger::clock(&sequence(s)?));
    }
    Err(format!(
        "{op}: trigger must be Trigger.event(), .every(d), .count(n) or .clock(sequence), got {v}"
    ))
}

/// Whether a trigger fires on the clock (`every`, `clock`): pond-ts's
/// partitioned `rolling` then builds one node over every partition.
fn is_clock(o: &Value) -> bool {
    let t = &o["trigger"];
    t.get("every").is_some() || t.get("clock").is_some()
}

fn history(op: &str, v: &Value) -> Res<History> {
    Ok(match v {
        Value::Bool(true) => History::All,
        Value::Bool(false) => History::Off,
        Value::Object(o) => History::Limit {
            max_events: match o.get("maxEvents") {
                None => None,
                Some(n) => Some(
                    whole_number(n)
                        .and_then(|n| usize::try_from(n).ok())
                        .ok_or_else(|| format!("{op}: history.maxEvents must be a whole number"))?,
                ),
            },
            max_age: match o.get("maxAge") {
                None => None,
                Some(d) => Some(dur(op, "history.maxAge", d)?),
            },
        },
        other => {
            return Err(format!(
                "{op}: history must be true, false or {{ maxEvents, maxAge }}, got {other}"
            ));
        }
    })
}

fn rolling_options(op: &str, o: &Value) -> Res<RollingOptions> {
    if !matches!(o, Value::Null | Value::Object(_)) {
        return Err(format!("{op}: options must be an object, got {o}"));
    }
    let mut r = RollingOptions::new();
    if let Some(n) = opt_count(op, o, "minSamples")? {
        r = r.min_samples(n);
    }
    if !o["trigger"].is_null() {
        r = r.trigger(trigger(op, &o["trigger"])?);
    }
    if !o["history"].is_null() {
        r = r.history(history(op, &o["history"])?);
    }
    Ok(r)
}

/// The keyed form `{ window: mapping | { mapping, minSamples } }`.
fn windows(op: &str, v: &serde_json::Map<String, Value>) -> Res<Vec<RollingWindow>> {
    v.iter()
        .map(|(w, m)| {
            let w = dur(op, "a window", &Value::String(w.clone()))?;
            match m.get("mapping") {
                // `mapping` is a column name when its value is `{ from, using }`.
                Some(inner) if inner.get("from").is_none() => {
                    let mut rw = RollingWindow::new(&w, &mapping(op, inner)?);
                    if let Some(n) = opt_count(op, m, "minSamples")? {
                        rw = rw.min_samples(n);
                    }
                    Ok(rw)
                }
                _ => Ok(RollingWindow::new(&w, &mapping(op, m)?)),
            }
        })
        .collect()
}

/// A window size: a duration (text) or a count of events (a number), as
/// pond-ts's live `RollingWindow`.
enum Size {
    Time(String),
    Rows(usize),
}

fn size(op: &str, v: &Value) -> Res<Size> {
    match v {
        Value::String(d) => Ok(Size::Time(d.clone())),
        v => whole_number(v)
            .and_then(|n| usize::try_from(n).ok())
            .map(Size::Rows)
            .ok_or_else(|| {
                format!("{op}: window must be a duration or a whole number of events, got {v}")
            }),
    }
}

fn names(op: &str, v: &Value) -> Res<Vec<String>> {
    column_names(v)
        .map(|n| n.into_iter().map(str::to_string).collect())
        .ok_or_else(|| format!("{op}: expected a column name or a list of them, got {v}"))
}

fn refs(v: &[String]) -> Vec<&str> {
    v.iter().map(String::as_str).collect()
}

fn get(args: &[Value], i: usize) -> &Value {
    const NULL: Value = Value::Null;
    args.get(i).unwrap_or(&NULL)
}

/// The class `op` builds on a single (not partitioned) node.
fn step_class(op: &str, args: &[Value]) -> Class {
    match op {
        "aggregate" => Class::Aggregation,
        "rolling" if get(args, 0).is_object() => Class::FusedRolling,
        "rolling" => Class::RollingAggregation,
        "reduce" => Class::Reduce,
        _ => Class::View,
    }
}

/// `{ fn: k }`: the function's position.
fn function(op: &str, v: &Value) -> Res<usize> {
    fn_ref(v).ok_or_else(|| format!("{op}: expected a function or an expression, got {v}"))
}

/// Build `op(...args)` on `from`, a single node. Used directly and inside
/// per-partition chains.
fn build_node(
    live: &mut LiveSeries,
    from: NodeId,
    op: &str,
    args: &[Value],
    fns: &Arc<dyn LiveFns>,
) -> Res<NodeId> {
    let a0 = get(args, 0);
    let first = |o: &Value| {
        if o["drop"] == Value::Bool(true) {
            FirstRow::Drop
        } else {
            FirstRow::Keep
        }
    };
    let id = match op {
        "filter" => match expr_ref(a0) {
            Some(e) => pond(live.filter_expr(from, &e?))?.id(),
            None => {
                let (k, f) = (function(op, a0)?, Arc::clone(fns));
                pond(live.filter(from, move |e: &LiveEvent| f.test(k, e)))?.id()
            }
        },
        "map" => {
            let (k, f) = (function(op, a0)?, Arc::clone(fns));
            pond(live.map(from, move |e: &LiveEvent| f.map(k, e)))?.id()
        }
        "select" => {
            let mut cols = Vec::new();
            for a in args {
                cols.extend(names(op, a)?);
            }
            pond(live.select(from, &refs(&cols)))?.id()
        }
        "sample" => {
            let n = whole_number(&a0["stride"])
                .ok_or_else(|| format!("sample: expected {{ stride: n }}, got {a0}"))?;
            pond(live.sample(from, Sample::Stride(n.max(0) as usize)))?.id()
        }
        "window" => match size(op, a0)? {
            Size::Time(d) => pond(live.window(from, &d))?.id(),
            Size::Rows(n) => pond(live.window_rows(from, n))?.id(),
        },
        "diff" | "rate" | "pctChange" => {
            let cols = names(op, a0)?;
            let first = first(get(args, 1));
            pond(match op {
                "diff" => live.diff_with(from, &refs(&cols), first),
                "rate" => live.rate_with(from, &refs(&cols), first),
                _ => live.pct_change_with(from, &refs(&cols), first),
            })?
            .id()
        }
        "fill" => {
            let limit = opt_count(op, get(args, 1), "limit")?;
            match a0 {
                Value::Object(map) => {
                    let spec = map
                        .iter()
                        .map(|(c, v)| Ok((c.as_str(), fill_strategy(v)?)))
                        .collect::<Res<Vec<_>>>()?;
                    pond(match limit {
                        Some(l) => live.fill_with(from, &spec, l),
                        None => live.fill(from, &spec),
                    })?
                    .id()
                }
                v => {
                    let f = fill_strategy(v)?;
                    pond(match limit {
                        Some(l) => live.fill_all_with(from, f, l),
                        None => live.fill_all(from, f),
                    })?
                    .id()
                }
            }
        }
        "cumulative" => {
            let map = a0
                .as_object()
                .ok_or_else(|| format!("cumulative: expected {{ column: reducer }}, got {a0}"))?;
            if let [(column, f)] = &map.iter().collect::<Vec<_>>()[..]
                && fn_ref(f).is_some()
            {
                let (k, f) = (function(op, f)?, Arc::clone(fns));
                pond(live.cumulative_with(from, column, move |acc, v| f.fold(k, acc, v)))?.id()
            } else {
                let spec = map
                    .iter()
                    .map(|(c, r)| match r.as_str() {
                        Some(r) => Ok((c.as_str(), pond(Reducer::parse(r))?)),
                        None if fn_ref(r).is_some() => Err(format!(
                            "cumulative: a function for '{c}' must be the only column \
                             (@pond-ts/rs runs one function column per cumulative)"
                        )),
                        None => Err(format!("cumulative: '{c}' needs a reducer name, got {r}")),
                    })
                    .collect::<Res<Vec<_>>>()?;
                pond(live.cumulative(from, &spec))?.id()
            }
        }
        "aggregate" => {
            let seq = sequence(a0)?;
            let aggs = mapping(op, get(args, 1))?;
            let o = get(args, 2);
            let grace = match &o["grace"] {
                Value::Null => None,
                g => Some(dur(op, "grace", g)?),
            };
            pond(live.aggregate_with(from, &seq, &aggs, grace.as_deref()))?.id()
        }
        "rolling" => match a0 {
            Value::Object(ws) => {
                let o = rolling_options(op, get(args, 1))?;
                pond(live.rolling_windows(from, &windows(op, ws)?, &o))?.id()
            }
            w => {
                let aggs = mapping(op, get(args, 1))?;
                let o = rolling_options(op, get(args, 2))?;
                match size(op, w)? {
                    Size::Time(d) => pond(live.rolling_with(from, &d, &aggs, &o))?.id(),
                    Size::Rows(n) => pond(live.rolling_rows(from, n, &aggs, &o))?.id(),
                }
            }
        },
        "reduce" => {
            let aggs = mapping(op, a0)?;
            let o = get(args, 1);
            let t = match &o["trigger"] {
                Value::Null => Trigger::event(),
                t => trigger(op, t)?,
            };
            pond(live.reduce_with(from, &aggs, t))?.id()
        }
        other => return Err(format!("no live method '{other}'")),
    };
    Ok(id)
}

/// A chain of `[op, ...args]` steps, built on each partition.
fn chain(steps: &Value) -> Res<Vec<(String, Vec<Value>)>> {
    steps
        .as_array()
        .ok_or("apply: expected a chain of steps")?
        .iter()
        .map(|s| match s.as_array().map(Vec::as_slice) {
            Some([Value::String(op), rest @ ..]) => Ok((op.clone(), rest.to_vec())),
            _ => Err(format!("apply: a step is [method, ...arguments], got {s}")),
        })
        .collect()
}

/// The JSON of a pushed row's cell: `null` a gap, a number (or `{"f64":
/// …}`), text, true/false or a list of them. `{"null": true}` is a `null`
/// the caller wrote, which pond-ts refuses as a cell.
fn push_cell(def: &ColumnDef, v: &Value) -> Res<Option<Cell>> {
    let bad = || {
        format!(
            "push: column '{}' expects {}, got {v}",
            def.name,
            def.kind.as_str()
        )
    };
    Ok(Some(match v {
        Value::Null => return Ok(None),
        Value::String(s) => Cell::String(s.clone()),
        Value::Bool(b) => Cell::Boolean(*b),
        Value::Array(items) => Cell::Array(
            items
                .iter()
                .map(|e| crate::dispatch::scalar(e).map_err(|_| bad()))
                .collect::<Res<Vec<Scalar>>>()?,
        ),
        v => Cell::Number(decode_f64(v).ok_or_else(bad)?),
    }))
}

/// A row to push.
pub type Row = (EventKey, Vec<Option<Cell>>);

impl Live {
    /// `new LiveSeries({ name, schema, ordering, graceWindow, retention })`.
    pub fn new(name: &str, schema: &Value, options: &Value) -> Res<Live> {
        let defs = schema_of(schema)?;
        let o = LiveOptions::new().read("LiveSeries", options, false)?;
        let live = pond(LiveSeries::with_options(name.to_string(), defs, o))?;
        let root = live.root();
        Ok(Live {
            live,
            nodes: vec![Entry {
                id: root,
                class: Class::Series,
                end: Class::Series,
            }],
            handles: HashMap::from([(root, 0)]),
            last: std::cell::Cell::new(None),
        })
    }

    fn entry(&self, h: u32) -> Res<Entry> {
        self.nodes
            .get(h as usize)
            .copied()
            .ok_or_else(|| format!("no live node {h}"))
    }

    /// The handle of `id`, registering it as `class` if it has none.
    fn register(&mut self, id: NodeId, class: Class, end: Class) -> u32 {
        if let Some(&h) = self.handles.get(&id) {
            return h;
        }
        let h = self.nodes.len() as u32;
        self.nodes.push(Entry { id, class, end });
        self.handles.insert(id, h);
        h
    }

    /// The handle of a node outputs name (every watched node has one).
    pub fn handle_of(&self, id: NodeId) -> Option<u32> {
        // A push's outputs mostly come from one node: skip the hash.
        if let Some((last, h)) = self.last.get()
            && last == id
        {
            return Some(h);
        }
        let h = self.handles.get(&id).copied()?;
        self.last.set(Some((id, h)));
        Some(h)
    }

    /// The class of node `h`.
    pub fn class(&self, h: u32) -> Res<Class> {
        self.entry(h).map(|e| e.class)
    }

    /// Build `op(...args)` on node `h`: the new node's handle and class.
    /// A node built over history whose function threw (`fns.failed()`) is
    /// removed again, and the error is the caller's to raise.
    pub fn build(
        &mut self,
        h: u32,
        op: &str,
        args: &[Value],
        fns: Arc<dyn LiveFns>,
    ) -> Res<(u32, Class)> {
        let from = self.entry(h)?;
        let a0 = get(args, 0);
        let (id, class, end) = match (op, from.class) {
            ("partitionBy", Class::Series) => {
                let column = a0
                    .as_str()
                    .ok_or_else(|| format!("partitionBy: expected a column name, got {a0}"))?;
                let o = PartitionOptions::new().read(op, get(args, 1), true)?;
                let id = pond(self.live.partition_by(from.id, column, &o))?.id();
                (id, Class::PartitionedSeries, Class::Series)
            }
            ("collect", c) if c.partitioned() => {
                let o = CollectOptions::new().read(op, a0, true)?;
                let id = pond(self.live.collect(from.id, &o))?.id();
                (id, Class::Series, Class::Series)
            }
            ("apply", c) if c.partitioned() => {
                let steps = chain(a0)?;
                let o = CollectOptions::new().read(op, get(args, 1), true)?;
                let f = Arc::clone(&fns);
                let recipe = move |live: &mut LiveSeries, mut node: NodeId| {
                    for (op, args) in &steps {
                        node = build_node(live, node, op, args, &f).map_err(invalid)?;
                    }
                    Ok(node)
                };
                let id = pond(self.live.apply(from.id, recipe, &o))?.id();
                (id, Class::Series, Class::Series)
            }
            ("rolling", c) if c.partitioned() && (a0.is_object() || is_clock(get(args, 2))) => {
                let (id, class) = self.partition_rolling(from.id, args)?;
                (id, class, class)
            }
            (_, c) if c.partitioned() => {
                if matches!(op, "partitionBy" | "collect" | "apply") {
                    return Err(format!("{op}: not on a partitioned node"));
                }
                let (step_op, step_args, f) = (op.to_string(), args.to_vec(), Arc::clone(&fns));
                let id = pond(self.live.per_partition(
                    from.id,
                    move |live: &mut LiveSeries, part| {
                        build_node(live, part, &step_op, &step_args, &f).map_err(invalid)
                    },
                ))?
                .id();
                (id, Class::PartitionedView, step_class(op, args))
            }
            ("partitionBy" | "collect" | "apply", _) => {
                return Err(format!("{op}: not on a {}", from.class.name()));
            }
            (_, Class::PartitionedFusedRolling | Class::PartitionedSyncRolling) => {
                return Err(format!(
                    "{op}: nothing builds on a {} in @pond-ts/rs",
                    from.class.name()
                ));
            }
            _ => {
                let id = build_node(&mut self.live, from.id, op, args, &fns)?;
                let class = step_class(op, args);
                (id, class, class)
            }
        };
        if fns.failed() {
            let _ = self.live.remove(id);
        }
        Ok((self.register(id, class, end), class))
    }

    fn partition_rolling(&mut self, from: NodeId, args: &[Value]) -> Res<(NodeId, Class)> {
        let op = "rolling";
        Ok(match get(args, 0) {
            Value::Object(ws) => {
                let o = rolling_options(op, get(args, 1))?;
                let id = pond(
                    self.live
                        .partition_rolling_windows(from, &windows(op, ws)?, &o),
                )?;
                (id.id(), Class::PartitionedFusedRolling)
            }
            w => {
                let aggs = mapping(op, get(args, 1))?;
                let o = rolling_options(op, get(args, 2))?;
                let id = match size(op, w)? {
                    Size::Time(d) => pond(self.live.partition_rolling(from, &d, &aggs, &o))?,
                    Size::Rows(n) => pond(self.live.partition_rolling_rows(from, n, &aggs, &o))?,
                };
                (id.id(), Class::PartitionedSyncRolling)
            }
        })
    }

    /// Watch (`on`) or unwatch output `kind` of node `h`.
    pub fn watch(&mut self, h: u32, kind: &str, on: bool) -> Res<()> {
        let id = self.entry(h)?.id;
        let k = match kind {
            "event" => OutputKind::Event,
            "batch" => OutputKind::Batch,
            "evict" => OutputKind::Evict,
            "bucket" => OutputKind::Bucket,
            "update" => OutputKind::Update,
            other => return Err(format!("no output kind '{other}'")),
        };
        pond(if on {
            self.live.watch(id, k)
        } else {
            self.live.unwatch(id, k)
        })
    }

    /// pond-ts `dispose()`.
    pub fn remove(&mut self, h: u32) -> Res<()> {
        let id = self.entry(h)?.id;
        pond(self.live.remove(id))
    }

    fn is_root(&self, e: &Entry) -> bool {
        e.id == self.live.root()
    }

    fn not_for(e: &Entry, what: &str) -> String {
        format!("{what}: a {} has no such method", e.class.name())
    }

    /// Node `id` as a `T`.
    fn node<T: NodeType>(&self, id: NodeId) -> Res<&T> {
        pond(self.live.node::<T>(id).and_then(|n| self.live.get(n)))
    }

    /// The node's schema, key first.
    pub fn schema(&self, h: u32) -> Res<Vec<ColumnDef>> {
        let e = self.entry(h)?;
        let id = e.id;
        Ok(match e.class {
            _ if self.is_root(&e) => self.live.schema().to_vec(),
            Class::Series => self.node::<SubSeries>(id)?.schema().to_vec(),
            Class::View => self.node::<LiveView>(id)?.schema().to_vec(),
            Class::Aggregation => self.node::<LiveAggregation>(id)?.schema().to_vec(),
            Class::RollingAggregation | Class::FusedRolling => {
                self.node::<LiveRolling>(id)?.schema().to_vec()
            }
            Class::Reduce => self.node::<LiveReduce>(id)?.schema().to_vec(),
            Class::PartitionedSeries => self.node::<LivePartitioned>(id)?.schema().to_vec(),
            Class::PartitionedView => self.node::<PartitionedView>(id)?.schema().to_vec(),
            Class::PartitionedFusedRolling | Class::PartitionedSyncRolling => {
                self.node::<LivePartitionedRolling>(id)?.schema().to_vec()
            }
        })
    }

    /// How many events the node holds (an aggregation: closed buckets; a
    /// rolling window or reduce: what it emitted and keeps).
    pub fn len(&self, h: u32) -> Res<usize> {
        let e = self.entry(h)?;
        let id = e.id;
        Ok(match e.class {
            _ if self.is_root(&e) => self.live.len(),
            Class::Series => self.node::<SubSeries>(id)?.len(),
            Class::View => self.node::<LiveView>(id)?.len(),
            Class::Aggregation => self.node::<LiveAggregation>(id)?.len(),
            Class::RollingAggregation | Class::FusedRolling => self.node::<LiveRolling>(id)?.len(),
            Class::Reduce => self.node::<LiveReduce>(id)?.len(),
            Class::PartitionedFusedRolling | Class::PartitionedSyncRolling => {
                self.node::<LivePartitionedRolling>(id)?.len()
            }
            Class::PartitionedSeries | Class::PartitionedView => {
                return Err(Self::not_for(&e, "length"));
            }
        })
    }

    /// The event at `i` (negative counts from the end), or none.
    pub fn at(&self, h: u32, i: i64) -> Res<Option<LiveEvent>> {
        let e = self.entry(h)?;
        let id = e.id;
        Ok(match e.class {
            _ if self.is_root(&e) => self.live.at(i),
            Class::Series => self.node::<SubSeries>(id)?.at(i),
            Class::View => self.node::<LiveView>(id)?.at(i),
            Class::Aggregation => self.node::<LiveAggregation>(id)?.at(i).cloned(),
            Class::RollingAggregation | Class::FusedRolling => self.node::<LiveRolling>(id)?.at(i),
            Class::Reduce => self.node::<LiveReduce>(id)?.at(i),
            Class::PartitionedFusedRolling | Class::PartitionedSyncRolling => {
                self.node::<LivePartitionedRolling>(id)?.at(i)
            }
            Class::PartitionedSeries | Class::PartitionedView => {
                return Err(Self::not_for(&e, "at"));
            }
        })
    }

    /// Every event a reduce holds (to replay what it emitted when built).
    pub fn reduce_events(&self, h: u32) -> Res<Vec<LiveEvent>> {
        let e = self.entry(h)?;
        if e.class != Class::Reduce {
            return Ok(Vec::new());
        }
        Ok(self.node::<LiveReduce>(e.id)?.events().collect())
    }

    /// pond-ts `stats()`.
    pub fn stats(&self, h: u32) -> Res<Stats> {
        let e = self.entry(h)?;
        let id = e.id;
        Ok(match e.class {
            _ if self.is_root(&e) => Stats::Series(self.live.stats()),
            Class::Series => Stats::Series(self.node::<SubSeries>(id)?.stats()),
            Class::Aggregation => Stats::Aggregation(self.node::<LiveAggregation>(id)?.stats()),
            Class::RollingAggregation | Class::FusedRolling => Stats::Rolling(
                self.node::<LiveRolling>(id)?.stats(),
                e.class == Class::FusedRolling,
            ),
            Class::Reduce => Stats::Reduce(self.node::<LiveReduce>(id)?.stats()),
            Class::PartitionedSeries => {
                Stats::Partitioned(self.node::<LivePartitioned>(id)?.stats())
            }
            Class::PartitionedFusedRolling | Class::PartitionedSyncRolling => {
                Stats::PartitionRolling(self.node::<LivePartitionedRolling>(id)?.stats())
            }
            Class::View | Class::PartitionedView => return Err(Self::not_for(&e, "stats")),
        })
    }

    /// A rolling window's or a reduce's value columns as they stand now.
    pub fn value(&self, h: u32) -> Res<(Vec<ColumnDef>, Vec<Option<Cell>>)> {
        let e = self.entry(h)?;
        Ok(match e.class {
            Class::RollingAggregation | Class::FusedRolling => {
                let n = self.node::<LiveRolling>(e.id)?;
                (n.schema().to_vec(), n.value())
            }
            Class::Reduce => {
                let n = self.node::<LiveReduce>(e.id)?;
                (n.schema().to_vec(), n.value())
            }
            _ => return Err(Self::not_for(&e, "value")),
        })
    }

    /// A count for a view (pond-ts `count()`).
    pub fn count(&self, h: u32) -> Res<usize> {
        let e = self.entry(h)?;
        if e.class != Class::View {
            return Err(Self::not_for(&e, "count"));
        }
        Ok(self.node::<LiveView>(e.id)?.count())
    }

    /// An aggregation's open-bucket flag.
    pub fn has_open_bucket(&self, h: u32) -> Res<bool> {
        let e = self.entry(h)?;
        if e.class != Class::Aggregation {
            return Err(Self::not_for(&e, "hasOpenBucket"));
        }
        Ok(self.node::<LiveAggregation>(e.id)?.has_open_bucket())
    }

    /// `toTimeSeries()` (a series or view), `closed()` / `snapshot()` (an
    /// aggregation).
    pub fn series(&self, h: u32, what: &str) -> Res<TimeSeries> {
        let e = self.entry(h)?;
        pond(match (what, e.class) {
            ("toTimeSeries", _) if self.is_root(&e) => self.live.to_time_series(),
            ("toTimeSeries", Class::Series) => self.node::<SubSeries>(e.id)?.to_time_series(),
            ("toTimeSeries", Class::View) => self.node::<LiveView>(e.id)?.to_time_series(),
            ("closed", Class::Aggregation) => self.node::<LiveAggregation>(e.id)?.closed(),
            ("snapshot", Class::Aggregation) => self.node::<LiveAggregation>(e.id)?.snapshot(),
            _ => return Err(Self::not_for(&e, what)),
        })
    }

    /// pond-ts `toMap()` on a partitioned node: each partition value with
    /// its node's handle and class (a partitioned view builds its chain on
    /// every partition there is now).
    pub fn to_map(&mut self, h: u32) -> Res<Vec<(String, u32, Class)>> {
        let e = self.entry(h)?;
        let found: Vec<(String, NodeId)> = match e.class {
            Class::PartitionedSeries => self
                .node::<LivePartitioned>(e.id)?
                .partitions()
                .map(|(k, n)| (k.to_string(), n.id()))
                .collect(),
            Class::PartitionedView => {
                let n = pond(self.live.node::<PartitionedView>(e.id))?;
                pond(self.live.partition_outputs(n))?
            }
            _ => return Err(Self::not_for(&e, "toMap")),
        };
        let class = if e.class == Class::PartitionedSeries {
            Class::Series
        } else {
            e.end
        };
        Ok(found
            .into_iter()
            .map(|(k, id)| {
                let h = self.register(id, class, class);
                (k, h, self.nodes[h as usize].class)
            })
            .collect())
    }

    /// Value column names of node `h`, for `update` records.
    pub fn value_names(&self, h: u32) -> Res<Vec<String>> {
        Ok(self
            .schema(h)?
            .into_iter()
            .skip(1)
            .map(|c| c.name)
            .collect())
    }

    /// Rows as JSON (`[key, ...cells]`, see [`push_cell`]) for a push.
    pub fn rows(&self, rows: &[Value]) -> Res<Vec<Row>> {
        let defs = self.live.schema();
        rows.iter()
            .map(|r| {
                let r = r.as_array().ok_or("push: a row is [key, ...values]")?;
                if r.len() != defs.len() {
                    return Err(format!(
                        "push: expected {} values, got {}",
                        defs.len(),
                        r.len()
                    ));
                }
                let key = crate::dispatch::event_key(&r[0])?;
                let cells = defs[1..]
                    .iter()
                    .zip(&r[1..])
                    .map(|(d, v)| {
                        if v.get("null").is_some() {
                            return Err(format!(
                                "push: column '{}' got null; a gap is undefined",
                                d.name
                            ));
                        }
                        push_cell(d, v)
                    })
                    .collect::<Res<Vec<_>>>()?;
                Ok((key, cells))
            })
            .collect()
    }

    /// Whether every value column is a number and the key a time (the
    /// number-only fast path).
    pub fn numeric(&self) -> bool {
        let s = self.live.schema();
        s[0].kind == ColumnKind::Time && s[1..].iter().all(|c| c.kind == ColumnKind::Number)
    }
}

/// A time in ms as a key: whole ms within JavaScript's date range.
pub fn time_key(t: f64) -> Res<EventKey> {
    if t.fract() == 0.0 && t.abs() <= 8.64e15 {
        Ok(EventKey::time(t as i64))
    } else {
        Err(format!(
            "push: a time key must be whole ms within ±8.64e15, got {t}"
        ))
    }
}

/// A number cell of the fast path: NaN marks a gap (the JavaScript side
/// sends a NaN the caller wrote through the JSON path instead).
pub fn number_cell(v: f64) -> Option<Cell> {
    if v.is_nan() {
        None
    } else {
        Some(Cell::Number(v))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn schema() -> Value {
        json!([
            {"name": "time", "kind": "time"},
            {"name": "host", "kind": "string", "required": false},
            {"name": "cpu", "kind": "number", "required": false}
        ])
    }

    fn fns() -> Arc<dyn LiveFns> {
        Arc::new(NoFns)
    }

    #[test]
    fn builds_and_reads_by_handle() {
        let mut l = Live::new("s", &schema(), &json!({"retention": {"maxEvents": 5}})).unwrap();
        let (agg, class) = l
            .build(
                0,
                "aggregate",
                &[json!({"sequence": {"every": "1s"}}), json!({"cpu": "sum"})],
                fns(),
            )
            .unwrap();
        assert_eq!(class, Class::Aggregation);
        let rows = l
            .rows(&[
                json!([0, "a", 1]),
                json!([500, "b", 2]),
                json!([1000, null, 3]),
            ])
            .unwrap();
        l.live.push_many(rows).unwrap();
        assert_eq!(l.len(0).unwrap(), 3);
        assert_eq!(l.len(agg).unwrap(), 1);
        assert!(l.has_open_bucket(agg).unwrap());
        let (p, class) = l.build(0, "partitionBy", &[json!("host")], fns()).unwrap();
        assert_eq!(class, Class::PartitionedSeries);
        let map = l.to_map(p).unwrap();
        assert_eq!(
            map.iter().map(|(k, _, _)| k.as_str()).collect::<Vec<_>>(),
            ["a", "b", " undefined"]
        );
        assert!(l.len(p).is_err());
    }

    #[test]
    fn refuses_what_pond_ts_refuses() {
        let mut l = Live::new("s", &schema(), &Value::Null).unwrap();
        let bad = l.build(
            0,
            "partitionBy",
            &[json!("host"), json!({"nope": 1})],
            fns(),
        );
        assert!(bad.unwrap_err().contains("unknown option"));
        assert!(l.rows(&[json!([0, {"null": true}, 1])]).is_err());
        assert!(l.rows(&[json!([0, "a"])]).is_err());
        assert!(time_key(0.5).is_err());
        assert!(
            l.build(
                0,
                "rolling",
                &[
                    json!("5s"),
                    json!({"cpu": "avg"}),
                    json!({"minSamples": -1})
                ],
                fns()
            )
            .is_err()
        );
        assert!(Live::new("s", &json!([{"name": "v", "kind": "number"}]), &Value::Null).is_err());
    }

    #[test]
    fn partitioned_steps_pick_pond_ts_classes() {
        let mut l = Live::new("s", &schema(), &Value::Null).unwrap();
        let (p, _) = l.build(0, "partitionBy", &[json!("host")], fns()).unwrap();
        let every = json!({"trigger": {"every": "5s"}});
        let cases = [
            (
                vec![json!("5s"), json!({"cpu": "avg"})],
                Class::PartitionedView,
            ),
            (
                vec![json!("5s"), json!({"cpu": "avg"}), every.clone()],
                Class::PartitionedSyncRolling,
            ),
            (
                vec![json!({"2s": {"cpu": "max"}}), every],
                Class::PartitionedFusedRolling,
            ),
        ];
        for (args, want) in cases {
            assert_eq!(l.build(p, "rolling", &args, fns()).unwrap().1, want);
        }
        let (v, _) = l.build(p, "fill", &[json!("hold")], fns()).unwrap();
        let (c, class) = l.build(v, "collect", &[], fns()).unwrap();
        assert_eq!(class, Class::Series);
        assert_eq!(l.len(c).unwrap(), 0);
    }
}
