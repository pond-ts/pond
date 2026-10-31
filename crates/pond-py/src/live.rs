//! `pond_rs.LiveSeries`: events pushed as they arrive, and nodes built on
//! them (filters, buckets, rolling windows, per-host partitions) that
//! update with every push.
//!
//! One `LiveSeries` owns every node built from it, as in pond-rs. Python
//! holds the owner behind a lock. A call waits for that lock with Python's
//! own lock released, so a push on one thread never stops the others from
//! running Python while it waits, and a function you gave a node (a filter)
//! can run while the push holds the series. Such a function must not use
//! the series itself: on the push's own thread that is an error; handing
//! the work to another thread and waiting for it would wait forever.

use std::cell::Cell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use pond_rs::live::{
    CollectOptions, History, LiveAggregation, LiveEvent, LiveOptions, LivePartitioned,
    LivePartitionedRolling, LiveReduce, LiveRolling, LiveSeries, LiveView, NodeId, OrderingMode,
    Output, OutputKind, PartitionOptions, PartitionedView, RollingOptions, RollingWindow,
    SubSeries, Trigger,
};
use pond_rs::{
    Agg, ColumnDef, ColumnKind, EventKey, Fill, FirstRow, Label, PondError, Reducer, Sample,
    Sequence, TimeSeries, Value,
};
use pyo3::exceptions::{PyKeyError, PyTypeError};
use pyo3::prelude::*;
use pyo3::types::{PyBool, PyDict, PyFloat, PyInt, PyList, PyString, PyTuple};

use crate::convert::{
    aggs, column_reducers, duration, err, event_key, names, refs, value, value_error, value_to_py,
};
use crate::sequence::PySequence;
use crate::series::{PyTimeSeries, schema_list};

// ---------------------------------------------------------------------------
// The owner, its lock, and errors from Python functions
// ---------------------------------------------------------------------------

/// The first exception a Python function given to a node raised during the
/// current call. Every function still runs for every event; only the first
/// exception is kept, to be raised when the call returns.
#[derive(Default)]
struct Raised {
    error: Mutex<Option<PyErr>>,
    /// Whether `error` holds one, read without the lock.
    set: AtomicBool,
}

impl Raised {
    fn failed(&self) -> bool {
        self.set.load(Ordering::SeqCst)
    }

    fn keep(&self, e: PyErr) {
        if let Ok(mut slot) = self.error.lock()
            && slot.is_none()
        {
            *slot = Some(e);
            self.set.store(true, Ordering::SeqCst);
        }
    }

    fn take(&self) -> Option<PyErr> {
        if !self.failed() {
            return None;
        }
        let e = self.error.lock().ok().and_then(|mut e| e.take());
        self.set.store(false, Ordering::SeqCst);
        e
    }
}

static NEXT_THREAD: AtomicU64 = AtomicU64::new(1);

thread_local! {
    static THREAD: Cell<u64> = const { Cell::new(0) };
}

fn this_thread() -> u64 {
    THREAD.with(|t| {
        if t.get() == 0 {
            t.set(NEXT_THREAD.fetch_add(1, Ordering::Relaxed));
        }
        t.get()
    })
}

/// What a node is, for the methods that only some nodes have.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum NodeKind {
    Root,
    Series,
    View,
    Aggregation,
    Rolling,
    Reduce,
    Partitioned,
    PartitionedView,
    PartitionRolling,
}

impl NodeKind {
    fn word(self) -> &'static str {
        match self {
            NodeKind::Root | NodeKind::Series => "series",
            NodeKind::View => "view",
            NodeKind::Aggregation => "aggregation",
            NodeKind::Rolling => "rolling",
            NodeKind::Reduce => "reduce",
            NodeKind::Partitioned => "partitioned",
            NodeKind::PartitionedView => "partitioned_view",
            NodeKind::PartitionRolling => "partition_rolling",
        }
    }

    fn partitioned(self) -> bool {
        matches!(self, NodeKind::Partitioned | NodeKind::PartitionedView)
    }
}

struct Shared {
    live: Mutex<LiveSeries>,
    /// The thread holding `live`, 0 when free.
    holder: AtomicU64,
    raised: Arc<Raised>,
    kinds: Mutex<HashMap<NodeId, NodeKind>>,
    /// Fixed when the series is made, so reading them needs no lock.
    root: NodeId,
    name: String,
    schema: Vec<ColumnDef>,
}

/// Clears `holder` however the work ends (a panic included).
struct Held<'a> {
    guard: MutexGuard<'a, LiveSeries>,
    holder: &'a AtomicU64,
}

impl Drop for Held<'_> {
    fn drop(&mut self) {
        self.holder.store(0, Ordering::SeqCst);
    }
}

impl Shared {
    /// Run `f` on the series, holding its lock with Python's lock released.
    /// Then raise the first exception a Python function raised meanwhile.
    fn with<R: Send>(
        &self,
        py: Python<'_>,
        f: impl FnOnce(&mut LiveSeries) -> R + Send,
    ) -> PyResult<R> {
        Self::raise(self.run(py, f))
    }

    /// `with` for short calls (one push, a count); see [`Shared::run_quick`].
    fn quick<R: Send>(
        &self,
        py: Python<'_>,
        f: impl FnOnce(&mut LiveSeries) -> R + Send,
    ) -> PyResult<R> {
        Self::raise(self.run_quick(py, f))
    }

    fn raise<R>(r: PyResult<(R, Option<PyErr>)>) -> PyResult<R> {
        match r? {
            (_, Some(e)) => Err(e),
            (r, None) => Ok(r),
        }
    }

    fn reentered(&self) -> PyResult<u64> {
        let me = this_thread();
        if self.holder.load(Ordering::SeqCst) == me {
            return Err(value_error(
                "this LiveSeries is in the middle of a call on this thread: a function given \
                 to one of its nodes (a filter, a map) cannot use the series itself",
            ));
        }
        Ok(me)
    }

    /// `f`'s result and the first exception a Python function raised
    /// while it ran (taken while the lock is held, so a call on another
    /// thread never picks up this call's error).
    fn run<R: Send>(
        &self,
        py: Python<'_>,
        f: impl FnOnce(&mut LiveSeries) -> R + Send,
    ) -> PyResult<(R, Option<PyErr>)> {
        let me = self.reentered()?;
        Ok(py.detach(|| {
            let guard = self.live.lock().unwrap_or_else(|p| p.into_inner());
            self.holder.store(me, Ordering::SeqCst);
            let mut held = Held {
                guard,
                holder: &self.holder,
            };
            let r = f(&mut held.guard);
            (r, self.raised.take())
        }))
    }

    /// `run` for short calls: when the lock is free, take it without
    /// releasing Python's lock, which costs more than such a call. When
    /// another thread holds it, wait as `run` does, with Python's lock
    /// released. No thread ever waits for this lock while holding
    /// Python's: a thread that finds it taken waits with Python's lock
    /// released, so the holder can always get Python's lock back (to run a
    /// node's function, or to return).
    fn run_quick<R: Send>(
        &self,
        py: Python<'_>,
        f: impl FnOnce(&mut LiveSeries) -> R + Send,
    ) -> PyResult<(R, Option<PyErr>)> {
        let me = self.reentered()?;
        let guard = match self.live.try_lock() {
            Ok(g) => g,
            Err(std::sync::TryLockError::Poisoned(p)) => p.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => return self.run(py, f),
        };
        self.holder.store(me, Ordering::SeqCst);
        let mut held = Held {
            guard,
            holder: &self.holder,
        };
        let r = f(&mut held.guard);
        let raised = self.raised.take();
        drop(held);
        Ok((r, raised))
    }

    /// A push's outputs. When a node's Python function raised during it,
    /// the exception is raised with the outputs (the push happened) as its
    /// `outputs` attribute.
    fn push_outputs<'py>(
        self: &Arc<Self>,
        py: Python<'py>,
        quick: bool,
        f: impl FnOnce(&mut LiveSeries) -> pond_rs::Result<Vec<Output>> + Send,
    ) -> PyResult<Bound<'py, PyList>> {
        let run = move |l: &mut LiveSeries| f(l).map(|o| Outs::of(l, o));
        let (outs, raised) = if quick {
            self.run_quick(py, run)?
        } else {
            self.run(py, run)?
        };
        let list = outputs_to_py(py, self, outs.map_err(err)?)?;
        match raised {
            Some(e) => {
                e.value(py).setattr("outputs", &list)?;
                Err(e)
            }
            None => Ok(list),
        }
    }

    fn kind_of(&self, id: NodeId) -> NodeKind {
        self.kinds
            .lock()
            .ok()
            .and_then(|k| k.get(&id).copied())
            .unwrap_or(NodeKind::Series)
    }

    fn node(self: &Arc<Self>, id: NodeId, kind: NodeKind) -> PyLiveNode {
        if let Ok(mut k) = self.kinds.lock() {
            k.entry(id).or_insert(kind);
        }
        PyLiveNode {
            shared: Arc::clone(self),
            id,
            kind,
        }
    }
}

// ---------------------------------------------------------------------------
// Events and outputs
// ---------------------------------------------------------------------------

fn key_to_py<'py>(py: Python<'py>, key: &EventKey) -> PyResult<Bound<'py, PyAny>> {
    Ok(match key.kind() {
        "time" => key.begin().into_pyobject(py)?.into_any(),
        "timeRange" => (key.begin(), key.end()).into_pyobject(py)?.into_any(),
        _ => {
            let label = match key.label() {
                Some(Label::Number(v)) => v.into_pyobject(py)?.into_any(),
                Some(Label::String(s)) => s.into_pyobject(py)?.into_any(),
                None => py.None().into_bound(py),
            };
            PyTuple::new(
                py,
                [
                    label,
                    key.begin().into_pyobject(py)?.into_any(),
                    key.end().into_pyobject(py)?.into_any(),
                ],
            )?
            .into_any()
        }
    })
}

/// One event of a live node: a key and a cell per value column, read by
/// column name (`event["cpu"]`), like a `Row`.
#[pyclass(name = "LiveEvent", module = "pond_rs", frozen)]
pub struct PyLiveEvent {
    event: LiveEvent,
}

impl PyLiveEvent {
    fn index(&self, column: &str) -> Option<usize> {
        self.event.schema()[1..]
            .iter()
            .position(|c| c.name == column)
    }
}

#[pymethods]
impl PyLiveEvent {
    /// The key: a time (epoch ms), `(begin, end)` or `(label, begin, end)`.
    #[getter]
    fn key<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        key_to_py(py, self.event.key())
    }

    /// The key's start, epoch milliseconds.
    #[getter]
    fn begin(&self) -> i64 {
        self.event.begin()
    }

    /// The key's end (its time, for a time key), epoch milliseconds.
    #[getter]
    fn end(&self) -> i64 {
        self.event.end()
    }

    fn __getitem__<'py>(&self, py: Python<'py>, column: &str) -> PyResult<Bound<'py, PyAny>> {
        match self.index(column) {
            Some(i) => value_to_py(py, self.event.values()[i].as_ref()),
            None => Err(PyKeyError::new_err(column.to_string())),
        }
    }

    /// The cell in `column`, or `default` when there is no such column.
    #[pyo3(signature = (column, default=None))]
    fn get<'py>(
        &self,
        py: Python<'py>,
        column: &str,
        default: Option<Bound<'py, PyAny>>,
    ) -> PyResult<Bound<'py, PyAny>> {
        match self.index(column) {
            Some(i) => value_to_py(py, self.event.values()[i].as_ref()),
            None => Ok(default.unwrap_or_else(|| py.None().into_bound(py))),
        }
    }

    /// The value column names, in schema order.
    fn keys(&self) -> Vec<String> {
        self.event.schema()[1..]
            .iter()
            .map(|c| c.name.clone())
            .collect()
    }

    /// `{column: cell}` for the value columns.
    fn to_dict<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyDict>> {
        let d = PyDict::new(py);
        for (c, v) in self.event.schema()[1..].iter().zip(self.event.values()) {
            d.set_item(&c.name, value_to_py(py, v.as_ref())?)?;
        }
        Ok(d)
    }

    fn __len__(&self) -> usize {
        self.event.values().len()
    }

    fn __repr__(&self, py: Python<'_>) -> PyResult<String> {
        Ok(format!(
            "LiveEvent({}, {})",
            self.key(py)?.repr()?,
            self.to_dict(py)?.repr()?
        ))
    }
}

fn events_to_py(py: Python<'_>, events: Vec<LiveEvent>) -> PyResult<Bound<'_, PyList>> {
    PyList::new(py, events.into_iter().map(|event| PyLiveEvent { event }))
}

/// Something a push caused at a watched node: `kind` is `"event"` (the node
/// took an event; an aggregation closed a bucket), `"batch"` (the series
/// took these events in one push), `"evict"` (the node dropped these),
/// `"bucket"` (an aggregation's open bucket as it now stands) or `"update"`
/// (a rolling window's values as they now stand; `None` for an
/// aggregation).
#[pyclass(name = "LiveOutput", module = "pond_rs", frozen)]
pub struct PyLiveOutput {
    #[pyo3(get)]
    node: Py<PyLiveNode>,
    #[pyo3(get)]
    kind: &'static str,
    /// For `event` and `bucket`.
    #[pyo3(get)]
    event: Option<Py<PyLiveEvent>>,
    /// For `batch` and `evict`.
    #[pyo3(get)]
    events: Option<Py<PyList>>,
    /// For `update`: `{column: value}`, or `None` from an aggregation.
    #[pyo3(get)]
    values: Option<Py<PyDict>>,
}

#[pymethods]
impl PyLiveOutput {
    fn __repr__(&self, py: Python<'_>) -> PyResult<String> {
        let node = self.node.bind(py).repr()?;
        let what = if let Some(e) = &self.event {
            e.bind(py).repr()?.to_string()
        } else if let Some(e) = &self.events {
            format!("{} events", e.bind(py).len())
        } else if let Some(v) = &self.values {
            v.bind(py).repr()?.to_string()
        } else {
            "None".into()
        };
        Ok(format!("LiveOutput({}, {node}, {what})", self.kind))
    }
}

fn kind_word(k: OutputKind) -> &'static str {
    match k {
        OutputKind::Event => "event",
        OutputKind::Batch => "batch",
        OutputKind::Evict => "evict",
        OutputKind::Bucket => "bucket",
        OutputKind::Update => "update",
    }
}

fn output_kind(word: &str) -> PyResult<OutputKind> {
    Ok(match word {
        "event" => OutputKind::Event,
        "batch" => OutputKind::Batch,
        "evict" => OutputKind::Evict,
        "bucket" => OutputKind::Bucket,
        "update" => OutputKind::Update,
        other => {
            return Err(value_error(format!(
                "an output kind is 'event', 'batch', 'evict', 'bucket' or 'update', got '{other}'"
            )));
        }
    })
}

/// The outputs of a call, with each one's value column names for
/// `update` records.
struct Outs {
    outputs: Vec<Output>,
    columns: HashMap<NodeId, Vec<String>>,
}

impl Outs {
    fn of(live: &LiveSeries, outputs: Vec<Output>) -> Self {
        let mut columns = HashMap::new();
        for o in &outputs {
            if let Output::Update {
                node,
                values: Some(_),
            } = o
                && !columns.contains_key(node)
                && let Ok(n) = live.node::<LiveRolling>(*node)
            {
                columns.insert(
                    *node,
                    live[n].schema()[1..]
                        .iter()
                        .map(|c| c.name.clone())
                        .collect(),
                );
            }
        }
        Outs { outputs, columns }
    }
}

fn outputs_to_py<'py>(
    py: Python<'py>,
    shared: &Arc<Shared>,
    outs: Outs,
) -> PyResult<Bound<'py, PyList>> {
    let list = PyList::empty(py);
    if outs.outputs.is_empty() {
        return Ok(list);
    }
    let mut nodes: HashMap<NodeId, Py<PyLiveNode>> = HashMap::new();
    for o in outs.outputs {
        let id = o.node();
        let node = match nodes.get(&id) {
            Some(n) => n.clone_ref(py),
            None => {
                let n = Py::new(py, shared.node(id, shared.kind_of(id)))?;
                nodes.insert(id, n.clone_ref(py));
                n
            }
        };
        let kind = kind_word(o.kind());
        let (mut event, mut events, mut values) = (None, None, None);
        match o {
            Output::Event { event: e, .. } | Output::Bucket { event: e, .. } => {
                event = Some(Py::new(py, PyLiveEvent { event: e })?);
            }
            Output::Batch { events: e, .. } | Output::Evict { events: e, .. } => {
                events = Some(events_to_py(py, e)?.unbind());
            }
            Output::Update { values: v, .. } => {
                if let Some(v) = v {
                    let d = PyDict::new(py);
                    let names = outs.columns.get(&id).cloned().unwrap_or_default();
                    for (n, cell) in names.iter().zip(&v) {
                        d.set_item(n, value_to_py(py, cell.as_ref())?)?;
                    }
                    values = Some(d.unbind());
                }
            }
        }
        list.append(PyLiveOutput {
            node,
            kind,
            event,
            events,
            values,
        })?;
    }
    Ok(list)
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

fn ordering(word: &str) -> PyResult<OrderingMode> {
    Ok(match word {
        "strict" => OrderingMode::Strict,
        "drop" => OrderingMode::Drop,
        "reorder" => OrderingMode::Reorder,
        other => {
            return Err(value_error(format!(
                "ordering must be 'strict', 'drop' or 'reorder', got '{other}'"
            )));
        }
    })
}

/// A trigger: `"event"` (after every event), a duration (`"1m"`, a
/// `timedelta`: when a clock bucket of that size ends), an `int` (every n
/// events), or a `Sequence` (when one of its buckets ends).
fn trigger(obj: &Bound<'_, PyAny>) -> PyResult<Trigger> {
    if let Ok(s) = obj.cast::<PyString>()
        && s.to_cow()? == "event"
    {
        return Ok(Trigger::event());
    }
    if obj.is_instance_of::<PyInt>() && !obj.is_instance_of::<PyBool>() {
        return Trigger::count(obj.extract()?).map_err(err);
    }
    if let Ok(s) = obj.cast::<PySequence>() {
        return Trigger::clock(&s.borrow().inner).map_err(err);
    }
    Trigger::every(&duration(obj, "trigger")?).map_err(err)
}

/// Whether a trigger is a clock (every / Sequence), which a rolling window
/// on partitions turns into one node over every partition.
fn is_clock(obj: &Bound<'_, PyAny>) -> PyResult<bool> {
    if let Ok(s) = obj.cast::<PyString>() {
        return Ok(s.to_cow()? != "event");
    }
    Ok(obj.is_instance_of::<PySequence>()
        || (!obj.is_instance_of::<PyInt>() && !obj.is_instance_of::<PyFloat>()))
}

/// History: `True` (keep every emission), `False` (keep none), or a dict
/// `{"max_events": n, "max_age": "5m"}`.
fn history(obj: &Bound<'_, PyAny>) -> PyResult<History> {
    if let Ok(b) = obj.cast::<PyBool>() {
        return Ok(if b.is_true() {
            History::All
        } else {
            History::Off
        });
    }
    let d = obj.cast::<PyDict>().map_err(|_| {
        PyTypeError::new_err("history is True, False or {\"max_events\": n, \"max_age\": \"5m\"}")
    })?;
    let mut max_events = None;
    let mut max_age = None;
    for (k, v) in d.iter() {
        match k.extract::<String>()?.as_str() {
            "max_events" | "maxEvents" => max_events = Some(v.extract::<usize>()?),
            "max_age" | "maxAge" => max_age = Some(duration(&v, "history max_age")?),
            other => {
                return Err(PyTypeError::new_err(format!(
                    "history takes max_events and max_age, not '{other}'"
                )));
            }
        }
    }
    Ok(History::Limit {
        max_events,
        max_age,
    })
}

fn rolling_options(
    min_samples: usize,
    trigger_obj: Option<&Bound<'_, PyAny>>,
    history_obj: Option<&Bound<'_, PyAny>>,
) -> PyResult<RollingOptions> {
    let mut o = RollingOptions::new().min_samples(min_samples);
    if let Some(t) = trigger_obj {
        o = o.trigger(trigger(t)?);
    }
    if let Some(h) = history_obj {
        o = o.history(history(h)?);
    }
    Ok(o)
}

/// Several windows: `{window: aggs}` or `{window: {"aggs": aggs,
/// "min_samples": n}}`.
fn windows(d: &Bound<'_, PyDict>) -> PyResult<Vec<RollingWindow>> {
    d.iter()
        .map(|(w, spec)| {
            let w = duration(&w, "rolling window")?;
            if let Ok(inner) = spec.cast::<PyDict>()
                && let Some(mapping) = inner.get_item("aggs")?
            {
                let mut rw = RollingWindow::new(&w, &aggs(&mapping)?);
                if let Some(n) = inner.get_item("min_samples")? {
                    rw = rw.min_samples(n.extract()?);
                }
                return Ok(rw);
            }
            Ok(RollingWindow::new(&w, &aggs(&spec)?))
        })
        .collect()
}

fn first_row(drop_first: bool) -> FirstRow {
    if drop_first {
        FirstRow::Drop
    } else {
        FirstRow::Keep
    }
}

// ---------------------------------------------------------------------------
// Steps: one node built on another, the same on a series or per partition
// ---------------------------------------------------------------------------

type Callable = Arc<Py<PyAny>>;

/// A node's schema and its values as they stand now.
type Values = (Vec<ColumnDef>, Vec<Option<Value>>);

#[derive(Clone)]
enum Step {
    Filter(Callable),
    FilterExpr(pond_rs::Expr),
    Map(Callable),
    Select(Vec<String>),
    Sample(usize),
    Window(String),
    WindowRows(usize),
    Diff(Vec<String>, FirstRow),
    Rate(Vec<String>, FirstRow),
    Pct(Vec<String>, FirstRow),
    Fill {
        spec: Option<Vec<(String, Fill)>>,
        all: Option<Fill>,
        limit: Option<usize>,
    },
    Cumulative(Vec<(String, Reducer)>),
    CumulativeWith(String, Callable),
    Aggregate(Sequence, Vec<Agg>, Option<String>),
    Rolling(String, Vec<Agg>, RollingOptions),
    RollingRows(usize, Vec<Agg>, RollingOptions),
    RollingWindows(Vec<RollingWindow>, RollingOptions),
    Reduce(Vec<Agg>, Trigger),
}

impl Step {
    fn kind(&self) -> NodeKind {
        match self {
            Step::Aggregate(..) => NodeKind::Aggregation,
            Step::Rolling(..) | Step::RollingRows(..) | Step::RollingWindows(..) => {
                NodeKind::Rolling
            }
            Step::Reduce(..) => NodeKind::Reduce,
            _ => NodeKind::View,
        }
    }
}

/// The Python function as a filter: an exception is kept (and raised when
/// the call returns) and the event is left out.
fn filter_fn(f: Callable, raised: Arc<Raised>) -> impl FnMut(&LiveEvent) -> bool + Send + 'static {
    move |e: &LiveEvent| {
        Python::attach(|py| {
            let ev = PyLiveEvent { event: e.clone() };
            match f.bind(py).call1((ev,)).and_then(|r| r.is_truthy()) {
                Ok(keep) => keep,
                Err(error) => {
                    raised.keep(error);
                    false
                }
            }
        })
    }
}

/// The new cells `f` returns for an event: a dict by column name (columns
/// left out keep their value) or a sequence in schema order.
fn map_cells(py: Python<'_>, f: &Py<PyAny>, e: &LiveEvent) -> PyResult<Vec<Option<Value>>> {
    let defs = &e.schema()[1..];
    let out = f.bind(py).call1((PyLiveEvent { event: e.clone() },))?;
    let mut cells = e.values().to_vec();
    if let Ok(d) = out.cast::<PyDict>() {
        for (k, v) in d.iter() {
            let name: String = k.extract()?;
            let i = defs.iter().position(|c| c.name == name).ok_or_else(|| {
                value_error(format!(
                    "map: the function returned unknown column '{name}'"
                ))
            })?;
            cells[i] = cell(&v, &defs[i], "map")?;
        }
    } else {
        let items: Vec<Bound<'_, PyAny>> = out.try_iter()?.collect::<PyResult<_>>()?;
        if items.len() != defs.len() {
            return Err(value_error(format!(
                "map: the function returned {} cells for {} value columns",
                items.len(),
                defs.len()
            )));
        }
        for (i, v) in items.iter().enumerate() {
            cells[i] = cell(v, &defs[i], "map")?;
        }
    }
    Ok(cells)
}

/// A cell for `def`: `None` (or a float NaN) is a gap; the kind must match.
fn cell(obj: &Bound<'_, PyAny>, def: &ColumnDef, what: &str) -> PyResult<Option<Value>> {
    if obj.is_none() {
        return Ok(None);
    }
    let v = value(obj, what)?;
    let fits = matches!(
        (&v, def.kind),
        (Value::Number(_), ColumnKind::Number)
            | (Value::String(_), ColumnKind::String)
            | (Value::Boolean(_), ColumnKind::Boolean)
            | (Value::Array(_), ColumnKind::Array)
    );
    if !fits {
        return Err(PyTypeError::new_err(format!(
            "{what}: column '{}' is {}, got {}",
            def.name,
            def.kind.as_str(),
            obj.get_type().name()?
        )));
    }
    Ok(Some(v))
}

fn map_fn(
    f: Callable,
    raised: Arc<Raised>,
) -> impl FnMut(&LiveEvent) -> Vec<Option<Value>> + Send + 'static {
    move |e: &LiveEvent| {
        let gaps = || vec![None; e.values().len()];
        Python::attach(|py| match map_cells(py, &f, e) {
            Ok(cells) => cells,
            Err(error) => {
                raised.keep(error);
                gaps()
            }
        })
    }
}

fn fold_fn(f: Callable, raised: Arc<Raised>) -> impl FnMut(f64, f64) -> f64 + Send + 'static {
    move |acc: f64, v: f64| {
        Python::attach(
            |py| match f.bind(py).call1((acc, v)).and_then(|r| r.extract::<f64>()) {
                Ok(x) => x,
                // The running value stays as it was before this event.
                Err(error) => {
                    raised.keep(error);
                    acc
                }
            },
        )
    }
}

fn build(
    live: &mut LiveSeries,
    from: NodeId,
    step: &Step,
    raised: &Arc<Raised>,
) -> pond_rs::Result<NodeId> {
    let r = Arc::clone(raised);
    Ok(match step {
        Step::Filter(f) => live.filter(from, filter_fn(Arc::clone(f), r))?.id(),
        Step::FilterExpr(e) => live.filter_expr(from, e)?.id(),
        Step::Map(f) => live.map(from, map_fn(Arc::clone(f), r))?.id(),
        Step::Select(cols) => live.select(from, &refs(cols))?.id(),
        Step::Sample(n) => live.sample(from, Sample::Stride(*n))?.id(),
        Step::Window(d) => live.window(from, d)?.id(),
        Step::WindowRows(n) => live.window_rows(from, *n)?.id(),
        Step::Diff(c, first) => live.diff_with(from, &refs(c), *first)?.id(),
        Step::Rate(c, first) => live.rate_with(from, &refs(c), *first)?.id(),
        Step::Pct(c, first) => live.pct_change_with(from, &refs(c), *first)?.id(),
        Step::Fill { spec, all, limit } => {
            let spec: Option<Vec<(&str, Fill)>> = spec
                .as_ref()
                .map(|s| s.iter().map(|(c, f)| (c.as_str(), f.clone())).collect());
            match (spec, all, limit) {
                (Some(s), _, None) => live.fill(from, &s)?.id(),
                (Some(s), _, Some(l)) => live.fill_with(from, &s, *l)?.id(),
                (None, Some(f), None) => live.fill_all(from, f.clone())?.id(),
                (None, Some(f), Some(l)) => live.fill_all_with(from, f.clone(), *l)?.id(),
                (None, None, _) => unreachable!("fill has a spec or a strategy"),
            }
        }
        Step::Cumulative(spec) => {
            let spec: Vec<(&str, Reducer)> = spec.iter().map(|(c, r)| (c.as_str(), *r)).collect();
            live.cumulative(from, &spec)?.id()
        }
        Step::CumulativeWith(c, f) => live
            .cumulative_with(from, c, fold_fn(Arc::clone(f), r))?
            .id(),
        Step::Aggregate(seq, mapping, grace) => live
            .aggregate_with(from, seq, mapping, grace.as_deref())?
            .id(),
        Step::Rolling(w, mapping, o) => live.rolling_with(from, w, mapping, o)?.id(),
        Step::RollingRows(n, mapping, o) => live.rolling_rows(from, *n, mapping, o)?.id(),
        Step::RollingWindows(ws, o) => live.rolling_windows(from, ws, o)?.id(),
        Step::Reduce(mapping, t) => live.reduce_with(from, mapping, *t)?.id(),
    })
}

/// Build `step` on `from`: directly, or on every partition (a chain the
/// partitioned node carries) when `from` is partitioned.
fn add_step(
    py: Python<'_>,
    shared: &Arc<Shared>,
    from: NodeId,
    from_kind: NodeKind,
    step: Step,
) -> PyResult<PyLiveNode> {
    let raised = Arc::clone(&shared.raised);
    // A node is built over what its source holds now, so a Python function
    // runs at once; if it raised, the node is removed again before the
    // error reaches Python (which would hold no handle to it).
    let undo = |live: &mut LiveSeries, id: NodeId, raised: &Raised| {
        if raised.failed() {
            let _ = live.remove(id);
        }
        id
    };
    if from_kind.partitioned() {
        let id = shared
            .with(py, move |live| {
                let r = Arc::clone(&raised);
                live.per_partition(from, move |live: &mut LiveSeries, part| {
                    build(live, part, &step, &r)
                })
                .map(|n| undo(live, n.id(), &raised))
            })?
            .map_err(err)?;
        return Ok(shared.node(id, NodeKind::PartitionedView));
    }
    let kind = step.kind();
    let id = shared
        .with(py, move |live| {
            build(live, from, &step, &raised).map(|id| undo(live, id, &raised))
        })?
        .map_err(err)?;
    Ok(shared.node(id, kind))
}

// ---------------------------------------------------------------------------
// Reading a node
// ---------------------------------------------------------------------------

/// A batch series of events (a rolling window's or a reduce's emissions,
/// which pond-rs keeps only as events).
fn events_series(
    name: &str,
    schema: &[ColumnDef],
    events: Vec<LiveEvent>,
) -> pond_rs::Result<TimeSeries> {
    let mut tmp = LiveSeries::new(name.to_string(), schema.to_vec())?;
    tmp.push_many(
        events
            .iter()
            .map(|e| (e.key().clone(), e.values().to_vec())),
    )?;
    tmp.to_time_series()
}

/// What a node holds, as a batch series.
fn snapshot(live: &LiveSeries, id: NodeId, kind: NodeKind) -> pond_rs::Result<TimeSeries> {
    match kind {
        NodeKind::Root => live.to_time_series(),
        NodeKind::Series => live[live.node::<SubSeries>(id)?].to_time_series(),
        NodeKind::View => live[live.node::<LiveView>(id)?].to_time_series(),
        NodeKind::Aggregation => live[live.node::<LiveAggregation>(id)?].closed(),
        NodeKind::Rolling => {
            let r = &live[live.node::<LiveRolling>(id)?];
            events_series(r.name(), r.schema(), r.events().collect())
        }
        NodeKind::Reduce => {
            let r = &live[live.node::<LiveReduce>(id)?];
            events_series(r.name(), r.schema(), r.events().collect())
        }
        NodeKind::PartitionRolling => {
            let r = &live[live.node::<LivePartitionedRolling>(id)?];
            events_series(r.name(), r.schema(), r.events().collect())
        }
        NodeKind::Partitioned | NodeKind::PartitionedView => Err(PondError::InvalidData {
            call: "LiveNode.to_series",
            message: "a partitioned node holds no series of its own: collect() it, or read \
                      partitions()"
                .into(),
        }),
    }
}

fn events_of(live: &LiveSeries, id: NodeId, kind: NodeKind) -> pond_rs::Result<Vec<LiveEvent>> {
    Ok(match kind {
        NodeKind::Root => live.events().collect(),
        NodeKind::Series => live[live.node::<SubSeries>(id)?].events().collect(),
        NodeKind::View => live[live.node::<LiveView>(id)?].events().collect(),
        NodeKind::Aggregation => live[live.node::<LiveAggregation>(id)?]
            .events()
            .cloned()
            .collect(),
        NodeKind::Rolling => live[live.node::<LiveRolling>(id)?].events().collect(),
        NodeKind::Reduce => live[live.node::<LiveReduce>(id)?].events().collect(),
        NodeKind::PartitionRolling => live[live.node::<LivePartitionedRolling>(id)?]
            .events()
            .collect(),
        NodeKind::Partitioned | NodeKind::PartitionedView => {
            return Err(PondError::InvalidData {
                call: "LiveNode.events",
                message: "a partitioned node holds no events of its own: collect() it, or read \
                          partitions()"
                    .into(),
            });
        }
    })
}

fn schema_of(live: &LiveSeries, id: NodeId, kind: NodeKind) -> pond_rs::Result<Vec<ColumnDef>> {
    Ok(match kind {
        NodeKind::Root => live.schema().to_vec(),
        NodeKind::Series => live.get(live.node::<SubSeries>(id)?)?.schema().to_vec(),
        NodeKind::View => live.get(live.node::<LiveView>(id)?)?.schema().to_vec(),
        NodeKind::Aggregation => live
            .get(live.node::<LiveAggregation>(id)?)?
            .schema()
            .to_vec(),
        NodeKind::Rolling => live.get(live.node::<LiveRolling>(id)?)?.schema().to_vec(),
        NodeKind::Reduce => live.get(live.node::<LiveReduce>(id)?)?.schema().to_vec(),
        NodeKind::Partitioned => live
            .get(live.node::<LivePartitioned>(id)?)?
            .schema()
            .to_vec(),
        NodeKind::PartitionedView => live
            .get(live.node::<PartitionedView>(id)?)?
            .schema()
            .to_vec(),
        NodeKind::PartitionRolling => live
            .get(live.node::<LivePartitionedRolling>(id)?)?
            .schema()
            .to_vec(),
    })
}

fn length_of(live: &LiveSeries, id: NodeId, kind: NodeKind) -> pond_rs::Result<usize> {
    Ok(match kind {
        NodeKind::Root => live.len(),
        NodeKind::Series => live.get(live.node::<SubSeries>(id)?)?.len(),
        NodeKind::View => live.get(live.node::<LiveView>(id)?)?.len(),
        NodeKind::Aggregation => live.get(live.node::<LiveAggregation>(id)?)?.len(),
        NodeKind::Rolling => live.get(live.node::<LiveRolling>(id)?)?.len(),
        NodeKind::Reduce => live.get(live.node::<LiveReduce>(id)?)?.len(),
        NodeKind::PartitionRolling => live.get(live.node::<LivePartitionedRolling>(id)?)?.len(),
        NodeKind::Partitioned => live.get(live.node::<LivePartitioned>(id)?)?.keys().len(),
        NodeKind::PartitionedView => 0,
    })
}

enum Stats {
    Series(pond_rs::live::LiveStats),
    Aggregation(pond_rs::live::AggregationStats),
    Rolling(pond_rs::live::RollingStats),
    Reduce(pond_rs::live::ReduceStats),
    Partitioned(pond_rs::live::PartitionStats),
    PartitionRolling(pond_rs::live::PartitionRollingStats),
    View(usize),
}

fn stats_of(live: &LiveSeries, id: NodeId, kind: NodeKind) -> pond_rs::Result<Stats> {
    Ok(match kind {
        NodeKind::Root => Stats::Series(live.stats()),
        NodeKind::Series => Stats::Series(live.get(live.node::<SubSeries>(id)?)?.stats()),
        NodeKind::View => Stats::View(live.get(live.node::<LiveView>(id)?)?.count()),
        NodeKind::Aggregation => {
            Stats::Aggregation(live.get(live.node::<LiveAggregation>(id)?)?.stats())
        }
        NodeKind::Rolling => Stats::Rolling(live.get(live.node::<LiveRolling>(id)?)?.stats()),
        NodeKind::Reduce => Stats::Reduce(live.get(live.node::<LiveReduce>(id)?)?.stats()),
        NodeKind::Partitioned => {
            Stats::Partitioned(live.get(live.node::<LivePartitioned>(id)?)?.stats())
        }
        NodeKind::PartitionRolling => {
            Stats::PartitionRolling(live.get(live.node::<LivePartitionedRolling>(id)?)?.stats())
        }
        NodeKind::PartitionedView => Stats::View(0),
    })
}

fn stats_to_py(py: Python<'_>, s: Stats) -> PyResult<Bound<'_, PyDict>> {
    let d = PyDict::new(py);
    match s {
        Stats::Series(s) => {
            d.set_item("ingested", s.ingested)?;
            d.set_item("evicted", s.evicted)?;
            d.set_item("rejected", s.rejected)?;
            d.set_item("length", s.length)?;
            d.set_item("earliest", s.earliest)?;
            d.set_item("latest", s.latest)?;
        }
        Stats::Aggregation(s) => {
            d.set_item("events_observed", s.events_observed)?;
            d.set_item("buckets_closed", s.buckets_closed)?;
            d.set_item("open_buckets", s.open_buckets)?;
            d.set_item("open_bucket_start", s.open_bucket_start)?;
        }
        Stats::Rolling(s) => {
            d.set_item("events_observed", s.events_observed)?;
            d.set_item("evictions", s.evictions)?;
            d.set_item("emissions", s.emissions)?;
            d.set_item("window_size", s.window_size)?;
            d.set_item("windows", s.windows)?;
        }
        Stats::Reduce(s) => {
            d.set_item("events_observed", s.events_observed)?;
            d.set_item("evictions", s.evictions)?;
            d.set_item("emissions", s.emissions)?;
            d.set_item("buffer_size", s.buffer_size)?;
        }
        Stats::Partitioned(s) => {
            d.set_item("partitions", s.partitions)?;
            d.set_item("events_routed", s.events_routed)?;
        }
        Stats::PartitionRolling(s) => {
            d.set_item("partitions", s.partitions)?;
            d.set_item("events_observed", s.events_observed)?;
            d.set_item("emissions", s.emissions)?;
            d.set_item("window_size", s.window_size)?;
        }
        Stats::View(count) => {
            d.set_item("count", count)?;
        }
    }
    Ok(d)
}

fn not_for(kind: NodeKind, what: &str, nodes: &str) -> PyErr {
    value_error(format!(
        "{what} is for {nodes} nodes; this is a {} node",
        kind.word()
    ))
}

// ---------------------------------------------------------------------------
// The node class
// ---------------------------------------------------------------------------

/// A node of a `LiveSeries`: a view (filter, map, diff, fill, window, …),
/// an aggregation, a rolling window, a reduce, a partition, or a
/// partitioned series and the chains built on it. Build more nodes on it
/// with the same methods as the series; read it with `len()`, `events()`,
/// `last()`, `to_series()` / `to_polars()`; `watch()` it to have each push
/// return what it emitted.
#[pyclass(name = "LiveNode", module = "pond_rs", frozen)]
pub struct PyLiveNode {
    shared: Arc<Shared>,
    id: NodeId,
    kind: NodeKind,
}

macro_rules! live_builders {
    ($t:ty) => {
        #[pymethods]
        impl $t {
            /// A view of the events `f(event)` accepts. Built over what this
            /// node holds now, then kept up to date. An exception in `f`
            /// leaves the event out and is raised when the call (the push)
            /// returns; the push itself has happened. `f` may be an `Expr`
            /// (`col("v") > 0`), which runs with no Python call per event.
            fn filter(&self, py: Python<'_>, f: Bound<'_, PyAny>) -> PyResult<PyLiveNode> {
                if let Some(e) = crate::expr::as_expr(&f) {
                    return self.step(py, Step::FilterExpr(e));
                }
                let f = callable(&f)?;
                self.step(py, Step::Filter(f))
            }

            /// Each event with new values: `f(event)` returns a dict of the
            /// columns to change, or every cell in schema order (`None` for
            /// a gap). Every value column of the view is optional.
            fn map(&self, py: Python<'_>, f: Bound<'_, PyAny>) -> PyResult<PyLiveNode> {
                let f = callable(&f)?;
                self.step(py, Step::Map(f))
            }

            /// The events with only these value columns.
            #[pyo3(signature = (*columns))]
            fn select(&self, py: Python<'_>, columns: Vec<String>) -> PyResult<PyLiveNode> {
                self.step(py, Step::Select(columns))
            }

            /// Every `stride`th event, counted from now.
            fn sample(&self, py: Python<'_>, stride: usize) -> PyResult<PyLiveNode> {
                self.step(py, Step::Sample(stride))
            }

            /// The events within a duration (`"5m"`, a `timedelta`) of the
            /// newest, or the newest `n` events (an `int`).
            fn window(&self, py: Python<'_>, size: Bound<'_, PyAny>) -> PyResult<PyLiveNode> {
                let step = if size.is_instance_of::<PyInt>() {
                    Step::WindowRows(size.extract()?)
                } else {
                    Step::Window(duration(&size, "window")?)
                };
                self.step(py, step)
            }

            /// Each event's value minus the previous one's, per column; the
            /// first event gets a gap (or is dropped with
            /// `drop_first=True`).
            #[pyo3(signature = (columns, *, drop_first=false))]
            fn diff(
                &self,
                py: Python<'_>,
                columns: Bound<'_, PyAny>,
                drop_first: bool,
            ) -> PyResult<PyLiveNode> {
                self.step(py, Step::Diff(names(&columns)?, first_row(drop_first)))
            }

            /// `diff` per second of key time.
            #[pyo3(signature = (columns, *, drop_first=false))]
            fn rate(
                &self,
                py: Python<'_>,
                columns: Bound<'_, PyAny>,
                drop_first: bool,
            ) -> PyResult<PyLiveNode> {
                self.step(py, Step::Rate(names(&columns)?, first_row(drop_first)))
            }

            /// The change as a fraction of the previous value.
            #[pyo3(signature = (columns, *, drop_first=false))]
            fn pct_change(
                &self,
                py: Python<'_>,
                columns: Bound<'_, PyAny>,
                drop_first: bool,
            ) -> PyResult<PyLiveNode> {
                self.step(py, Step::Pct(names(&columns)?, first_row(drop_first)))
            }

            /// Fill gaps as events arrive: `"hold"` (last value seen) or
            /// `"zero"` for every column, or `{column: strategy or value}`.
            /// `limit` fills at most that many gaps in a row.
            #[pyo3(signature = (strategy, *, limit=None))]
            fn fill(
                &self,
                py: Python<'_>,
                strategy: Bound<'_, PyAny>,
                limit: Option<usize>,
            ) -> PyResult<PyLiveNode> {
                let step = if let Ok(d) = strategy.cast::<PyDict>() {
                    let spec = d
                        .iter()
                        .map(|(k, v)| {
                            Ok((k.extract::<String>()?, crate::shared::fill_strategy(&v)?))
                        })
                        .collect::<PyResult<Vec<_>>>()?;
                    Step::Fill {
                        spec: Some(spec),
                        all: None,
                        limit,
                    }
                } else {
                    Step::Fill {
                        spec: None,
                        all: Some(crate::shared::fill_strategy(&strategy)?),
                        limit,
                    }
                };
                self.step(py, step)
            }

            /// Running totals: `{column: "sum" | "max" | "min" | "count"}`,
            /// or `{column: f}` for one column with your own
            /// `f(running, value)`.
            fn cumulative(&self, py: Python<'_>, spec: Bound<'_, PyDict>) -> PyResult<PyLiveNode> {
                let entries: Vec<(Bound<'_, PyAny>, Bound<'_, PyAny>)> = spec.iter().collect();
                if let [(k, v)] = &entries[..]
                    && v.is_callable()
                {
                    return self.step(py, Step::CumulativeWith(k.extract()?, callable(v)?));
                }
                self.step(py, Step::Cumulative(column_reducers(spec.as_any())?))
            }

            /// Buckets of a sequence (or a step such as `"1m"`): each
            /// bucket's reducers, emitted when it closes. `grace` keeps a
            /// bucket open until the latest event is that far past its end.
            #[pyo3(signature = (sequence, aggs, *, grace=None))]
            fn aggregate(
                &self,
                py: Python<'_>,
                sequence: Bound<'_, PyAny>,
                aggs: Bound<'_, PyAny>,
                grace: Option<Bound<'_, PyAny>>,
            ) -> PyResult<PyLiveNode> {
                let seq = crate::convert::sequence(&sequence)?;
                let grace = grace.map(|g| duration(&g, "grace")).transpose()?;
                self.step(
                    py,
                    Step::Aggregate(seq, crate::convert::aggs(&aggs)?, grace),
                )
            }

            /// A rolling window: a duration (`"5m"`), a count of events (an
            /// `int`), or several at once as `{window: aggs}`. Emits after
            /// each event, or on `trigger`: an `int` (every n events), a
            /// duration or `Sequence` (when a clock bucket ends). On a
            /// partitioned node a clock trigger (or several windows) makes
            /// one node emitting a row per partition together.
            #[pyo3(signature = (window, aggs=None, *, min_samples=0, trigger=None, history=None))]
            fn rolling(
                &self,
                py: Python<'_>,
                window: Bound<'_, PyAny>,
                aggs: Option<Bound<'_, PyAny>>,
                min_samples: usize,
                trigger: Option<Bound<'_, PyAny>>,
                history: Option<Bound<'_, PyAny>>,
            ) -> PyResult<PyLiveNode> {
                let options = rolling_options(min_samples, trigger.as_ref(), history.as_ref())?;
                let windows_form = window
                    .cast::<PyDict>()
                    .ok()
                    .map(|d| windows(&d))
                    .transpose()?;
                let clock = trigger
                    .as_ref()
                    .map(|t| is_clock(t))
                    .transpose()?
                    .unwrap_or(false);
                let mapping = match (&windows_form, &aggs) {
                    (Some(_), None) => Vec::new(),
                    (Some(_), Some(_)) => {
                        return Err(PyTypeError::new_err(
                            "rolling({window: aggs}) takes no separate aggs",
                        ));
                    }
                    (None, Some(a)) => crate::convert::aggs(a)?,
                    (None, None) => return Err(PyTypeError::new_err("rolling needs aggs")),
                };
                if self.node_kind().partitioned() && (windows_form.is_some() || clock) {
                    return self.partition_rolling(py, window, windows_form, mapping, options);
                }
                let step = match windows_form {
                    Some(ws) => Step::RollingWindows(ws, options),
                    None if window.is_instance_of::<PyInt>() => {
                        Step::RollingRows(window.extract()?, mapping, options)
                    }
                    None => Step::Rolling(duration(&window, "rolling window")?, mapping, options),
                };
                self.step(py, step)
            }

            /// Reducers over everything this node holds now, updated as
            /// events arrive and are evicted; emits once per push (or on
            /// `trigger`).
            #[pyo3(signature = (aggs, *, trigger=None))]
            fn reduce(
                &self,
                py: Python<'_>,
                aggs: Bound<'_, PyAny>,
                trigger: Option<Bound<'_, PyAny>>,
            ) -> PyResult<PyLiveNode> {
                let t = match &trigger {
                    Some(t) => self::trigger(t)?,
                    None => Trigger::event(),
                };
                self.step(py, Step::Reduce(crate::convert::aggs(&aggs)?, t))
            }
        }

        impl $t {
            fn partition_rolling(
                &self,
                py: Python<'_>,
                window: Bound<'_, PyAny>,
                windows_form: Option<Vec<RollingWindow>>,
                mapping: Vec<Agg>,
                options: RollingOptions,
            ) -> PyResult<PyLiveNode> {
                let from = self.node_id();
                let rows = window.is_instance_of::<PyInt>();
                let w = if windows_form.is_some() || rows {
                    String::new()
                } else {
                    duration(&window, "rolling window")?
                };
                let n: usize = if rows { window.extract()? } else { 0 };
                let shared = self.shared();
                let id = shared
                    .with(py, move |live| match windows_form {
                        Some(ws) => live
                            .partition_rolling_windows(from, &ws, &options)
                            .map(|n| n.id()),
                        None if rows => live
                            .partition_rolling_rows(from, n, &mapping, &options)
                            .map(|n| n.id()),
                        None => live
                            .partition_rolling(from, &w, &mapping, &options)
                            .map(|n| n.id()),
                    })?
                    .map_err(err)?;
                Ok(shared.node(id, NodeKind::PartitionRolling))
            }

            fn step(&self, py: Python<'_>, step: Step) -> PyResult<PyLiveNode> {
                add_step(py, self.shared(), self.node_id(), self.node_kind(), step)
            }
        }
    };
}

fn callable(f: &Bound<'_, PyAny>) -> PyResult<Callable> {
    if !f.is_callable() {
        return Err(PyTypeError::new_err(format!(
            "expected a function, got {}",
            f.get_type().name()?
        )));
    }
    Ok(Arc::new(f.clone().unbind()))
}

macro_rules! live_readers {
    ($t:ty) => {
        #[pymethods]
        impl $t {
            fn __len__(&self, py: Python<'_>) -> PyResult<usize> {
                let (id, kind) = (self.node_id(), self.node_kind());
                self.shared()
                    .quick(py, move |l| length_of(l, id, kind))?
                    .map_err(err)
            }

            /// The node's columns, key first: `[{"name", "kind", "required"}]`.
            #[getter]
            fn schema<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyList>> {
                let (id, kind) = (self.node_id(), self.node_kind());
                let s = self
                    .shared()
                    .with(py, move |l| schema_of(l, id, kind))?
                    .map_err(err)?;
                schema_list(py, s)
            }

            /// The value column names.
            #[getter]
            fn columns(&self, py: Python<'_>) -> PyResult<Vec<String>> {
                let (id, kind) = (self.node_id(), self.node_kind());
                let s = self
                    .shared()
                    .with(py, move |l| schema_of(l, id, kind))?
                    .map_err(err)?;
                Ok(s.into_iter().skip(1).map(|c| c.name).collect())
            }

            /// What the node is: "series", "view", "aggregation",
            /// "rolling", "reduce", "partitioned", "partitioned_view" or
            /// "partition_rolling".
            #[getter]
            fn kind(&self) -> &'static str {
                self.node_kind().word()
            }

            /// The events the node holds now (an aggregation: its closed
            /// buckets; a rolling window or reduce: what it emitted).
            fn events<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyList>> {
                let (id, kind) = (self.node_id(), self.node_kind());
                let e = self
                    .shared()
                    .with(py, move |l| events_of(l, id, kind))?
                    .map_err(err)?;
                events_to_py(py, e)
            }

            /// The last event held, or `None`.
            fn last(&self, py: Python<'_>) -> PyResult<Option<PyLiveEvent>> {
                let (id, kind) = (self.node_id(), self.node_kind());
                let e = self
                    .shared()
                    .with(py, move |l| events_of(l, id, kind).map(|mut e| e.pop()))?
                    .map_err(err)?;
                Ok(e.map(|event| PyLiveEvent { event }))
            }

            /// What the node holds as a batch `TimeSeries` (an aggregation:
            /// its closed buckets).
            fn to_series(&self, py: Python<'_>) -> PyResult<PyTimeSeries> {
                let (id, kind) = (self.node_id(), self.node_kind());
                self.shared()
                    .with(py, move |l| snapshot(l, id, kind))?
                    .map(PyTimeSeries::wrap)
                    .map_err(err)
            }

            /// `to_series()` as a pyarrow Table.
            fn to_pyarrow<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
                Bound::new(py, self.to_series(py)?)?.call_method0("to_pyarrow")
            }

            /// `to_series()` as a polars DataFrame.
            fn to_polars<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
                Bound::new(py, self.to_series(py)?)?.call_method0("to_polars")
            }

            /// `to_series()` as a pandas DataFrame.
            fn to_pandas<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
                Bound::new(py, self.to_series(py)?)?.call_method0("to_pandas")
            }

            /// Counters: a series' ingested / evicted / rejected / length /
            /// earliest / latest; an aggregation's buckets; a rolling
            /// window's emissions and window size; …
            fn stats<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyDict>> {
                let (id, kind) = (self.node_id(), self.node_kind());
                let s = self
                    .shared()
                    .with(py, move |l| stats_of(l, id, kind))?
                    .map_err(err)?;
                stats_to_py(py, s)
            }

            /// Have each push return this node's outputs of these kinds
            /// (all it emits when none are named): "event", "batch",
            /// "evict", "bucket", "update".
            #[pyo3(signature = (*kinds))]
            fn watch(&self, py: Python<'_>, kinds: Vec<String>) -> PyResult<()> {
                let id = self.node_id();
                let kinds = self.kinds_or_all(&kinds)?;
                self.shared()
                    .with(py, move |l| {
                        kinds.into_iter().try_for_each(|k| l.watch(id, k))
                    })?
                    .map_err(err)
            }

            /// Stop returning these kinds (all when none are named).
            #[pyo3(signature = (*kinds))]
            fn unwatch(&self, py: Python<'_>, kinds: Vec<String>) -> PyResult<()> {
                let id = self.node_id();
                let kinds = self.kinds_or_all(&kinds)?;
                self.shared()
                    .with(py, move |l| {
                        kinds.into_iter().try_for_each(|k| l.unwatch(id, k))
                    })?
                    .map_err(err)
            }
        }

        impl $t {
            fn kinds_or_all(&self, kinds: &[String]) -> PyResult<Vec<OutputKind>> {
                if self.node_kind().partitioned() {
                    return Err(value_error(
                        "a partitioned node emits nothing itself: watch a partition, the \
                         chain on one (partitions()), or what collect() gathers",
                    ));
                }
                if kinds.is_empty() {
                    return Ok(match self.node_kind() {
                        NodeKind::Root | NodeKind::Series => {
                            vec![OutputKind::Event, OutputKind::Batch, OutputKind::Evict]
                        }
                        NodeKind::View => vec![OutputKind::Event, OutputKind::Evict],
                        NodeKind::Aggregation => {
                            vec![OutputKind::Event, OutputKind::Bucket, OutputKind::Update]
                        }
                        NodeKind::Rolling => vec![OutputKind::Event, OutputKind::Update],
                        NodeKind::Reduce | NodeKind::PartitionRolling => vec![OutputKind::Event],
                        NodeKind::Partitioned | NodeKind::PartitionedView => unreachable!(),
                    });
                }
                kinds.iter().map(|k| output_kind(k)).collect()
            }
        }
    };
}

impl PyLiveNode {
    fn shared(&self) -> &Arc<Shared> {
        &self.shared
    }
    fn node_id(&self) -> NodeId {
        self.id
    }
    fn node_kind(&self) -> NodeKind {
        self.kind
    }
}

live_builders!(PyLiveNode);
live_readers!(PyLiveNode);

#[pymethods]
impl PyLiveNode {
    fn __repr__(&self) -> String {
        format!("LiveNode({})", self.kind.word())
    }

    fn __eq__(&self, other: &Bound<'_, PyAny>) -> bool {
        other
            .cast::<PyLiveNode>()
            .map(|o| o.get().id == self.id && Arc::ptr_eq(&o.get().shared, &self.shared))
            .unwrap_or(false)
    }

    fn __hash__(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        self.id.hash(&mut h);
        (Arc::as_ptr(&self.shared) as usize).hash(&mut h);
        h.finish()
    }

    /// A rolling window's or reduce's values as they stand now:
    /// `{column: value}`.
    fn value<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyDict>> {
        let (id, kind) = (self.id, self.kind);
        let got = self
            .shared
            .with(py, move |l| -> pond_rs::Result<Option<Values>> {
                Ok(match kind {
                    NodeKind::Rolling => {
                        let r = l.get(l.node::<LiveRolling>(id)?)?;
                        Some((r.schema().to_vec(), r.value()))
                    }
                    NodeKind::Reduce => {
                        let r = l.get(l.node::<LiveReduce>(id)?)?;
                        Some((r.schema().to_vec(), r.value()))
                    }
                    _ => None,
                })
            })?
            .map_err(err)?;
        let (schema, values) = got.ok_or_else(|| not_for(kind, "value()", "rolling and reduce"))?;
        let d = PyDict::new(py);
        for (c, v) in schema[1..].iter().zip(&values) {
            d.set_item(&c.name, value_to_py(py, v.as_ref())?)?;
        }
        Ok(d)
    }

    /// An aggregation's closed buckets and its open one, as a series.
    fn snapshot(&self, py: Python<'_>) -> PyResult<PyTimeSeries> {
        if self.kind != NodeKind::Aggregation {
            return Err(not_for(self.kind, "snapshot()", "aggregation"));
        }
        let id = self.id;
        self.shared
            .with(py, move |l| {
                l.get(l.node::<LiveAggregation>(id)?)?.snapshot()
            })?
            .map(PyTimeSeries::wrap)
            .map_err(err)
    }

    /// Whether an aggregation has a bucket still open.
    #[getter]
    fn has_open_bucket(&self, py: Python<'_>) -> PyResult<bool> {
        if self.kind != NodeKind::Aggregation {
            return Err(not_for(self.kind, "has_open_bucket", "aggregation"));
        }
        let id = self.id;
        self.shared
            .with(py, move |l| {
                l.get(l.node::<LiveAggregation>(id)?)
                    .map(|a| a.has_open_bucket())
            })?
            .map_err(err)
    }

    /// A partitioned series' partition values, in order of first arrival.
    fn keys(&self, py: Python<'_>) -> PyResult<Vec<String>> {
        if self.kind != NodeKind::Partitioned && self.kind != NodeKind::PartitionRolling {
            return Err(not_for(self.kind, "keys()", "partitioned"));
        }
        let (id, kind) = (self.id, self.kind);
        self.shared
            .with(py, move |l| -> pond_rs::Result<Vec<String>> {
                Ok(if kind == NodeKind::Partitioned {
                    l.get(l.node::<LivePartitioned>(id)?)?.keys().to_vec()
                } else {
                    l.get(l.node::<LivePartitionedRolling>(id)?)?
                        .keys()
                        .to_vec()
                })
            })?
            .map_err(err)
    }

    /// One partition (a series), by its value; `None` if it has not
    /// appeared.
    fn partition(&self, py: Python<'_>, key: &str) -> PyResult<Option<PyLiveNode>> {
        if self.kind != NodeKind::Partitioned {
            return Err(not_for(self.kind, "partition()", "partitioned"));
        }
        let id = self.id;
        let key = key.to_string();
        let found = self
            .shared
            .with(py, move |l| {
                l.get(l.node::<LivePartitioned>(id)?)
                    .map(|p| p.partition(&key).map(|n| n.id()))
            })?
            .map_err(err)?;
        Ok(found.map(|n| self.shared.node(n, NodeKind::Series)))
    }

    /// `{value: node}`: each partition (a partitioned series), or the
    /// chain's last node on each partition (a partitioned view, built now
    /// on every partition there is).
    fn partitions<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyDict>> {
        let (id, kind) = (self.id, self.kind);
        let found: Vec<(String, NodeId)> = match kind {
            NodeKind::Partitioned => self
                .shared
                .with(py, move |l| {
                    l.get(l.node::<LivePartitioned>(id)?).map(|p| {
                        p.partitions()
                            .map(|(k, n)| (k.to_string(), n.id()))
                            .collect()
                    })
                })?
                .map_err(err)?,
            NodeKind::PartitionedView => self
                .shared
                .with(py, move |l| {
                    let n = l.node::<PartitionedView>(id)?;
                    l.partition_outputs(n)
                })?
                .map_err(err)?,
            _ => return Err(not_for(kind, "partitions()", "partitioned")),
        };
        let d = PyDict::new(py);
        for (k, n) in found {
            let nk = if kind == NodeKind::Partitioned {
                NodeKind::Series
            } else {
                self.shared.kind_of_built(py, n)?
            };
            d.set_item(k, self.shared.node(n, nk))?;
        }
        Ok(d)
    }

    /// One series of everything the partitions take (or their chains
    /// emit), as events arrive; it starts with what they hold now.
    #[pyo3(signature = (*, name=None, ordering=None, grace_window=None, max_events=None, max_age=None))]
    fn collect(
        &self,
        py: Python<'_>,
        name: Option<String>,
        ordering: Option<&str>,
        grace_window: Option<Bound<'_, PyAny>>,
        max_events: Option<usize>,
        max_age: Option<Bound<'_, PyAny>>,
    ) -> PyResult<PyLiveNode> {
        if !self.kind.partitioned() {
            return Err(not_for(self.kind, "collect()", "partitioned"));
        }
        let mut o = CollectOptions::new();
        if let Some(n) = &name {
            o = o.name(n);
        }
        if let Some(w) = ordering {
            o = o.ordering(self::ordering(w)?);
        }
        if let Some(g) = grace_window {
            o = o.grace_window(&duration(&g, "grace_window")?);
        }
        if let Some(n) = max_events {
            o = o.max_events(n);
        }
        if let Some(a) = max_age {
            o = o.max_age(&duration(&a, "max_age")?);
        }
        let id = self.id;
        let n = self
            .shared
            .with(py, move |l| l.collect(id, &o).map(|n| n.id()))?
            .map_err(err)?;
        Ok(self.shared.node(n, NodeKind::Series))
    }

    /// Remove this node (pond-ts `dispose`): it stops working, and nodes
    /// built on it keep what they hold but get no more events. A view it
    /// came from that nothing else uses is detached too. Not the root.
    fn remove(&self, py: Python<'_>) -> PyResult<()> {
        let id = self.id;
        self.shared.with(py, move |l| l.remove(id))?.map_err(err)
    }
}

impl Shared {
    /// The kind of a node pond-rs built inside a chain (not through
    /// Python).
    fn kind_of_built(&self, py: Python<'_>, id: NodeId) -> PyResult<NodeKind> {
        if let Some(k) = self.kinds.lock().ok().and_then(|k| k.get(&id).copied()) {
            return Ok(k);
        }
        self.with(py, move |l| {
            if l.node::<LiveView>(id).is_ok() {
                NodeKind::View
            } else if l.node::<LiveAggregation>(id).is_ok() {
                NodeKind::Aggregation
            } else if l.node::<LiveRolling>(id).is_ok() {
                NodeKind::Rolling
            } else if l.node::<LiveReduce>(id).is_ok() {
                NodeKind::Reduce
            } else {
                NodeKind::Series
            }
        })
    }
}

// ---------------------------------------------------------------------------
// The series
// ---------------------------------------------------------------------------

/// A column definition from Python: `{"name", "kind", "required"?}` (what
/// `TimeSeries.schema` gives), or a `(name, kind)` / `(name, kind,
/// required)` tuple. A kind may end in `?` for an optional column. Value
/// columns are optional unless marked required.
fn column_def(obj: &Bound<'_, PyAny>, first: bool) -> PyResult<ColumnDef> {
    let (name, kind, required): (String, String, Option<bool>) = if let Ok(d) = obj.cast::<PyDict>()
    {
        let get = |k: &str| {
            d.get_item(k)?
                .ok_or_else(|| value_error(format!("a schema entry needs '{k}'")))
        };
        let required = match d.get_item("required")? {
            Some(r) => Some(r.extract()?),
            None => None,
        };
        (get("name")?.extract()?, get("kind")?.extract()?, required)
    } else {
        let t = obj.cast::<PyTuple>().map_err(|_| {
            PyTypeError::new_err(
                "a schema entry is {\"name\", \"kind\", \"required\"} or (name, kind[, required])",
            )
        })?;
        let required = if t.len() > 2 {
            Some(t.get_item(2)?.extract()?)
        } else {
            None
        };
        (
            t.get_item(0)?.extract()?,
            t.get_item(1)?.extract()?,
            required,
        )
    };
    let (kind, optional_mark) = match kind.strip_suffix('?') {
        Some(k) => (k.to_string(), true),
        None => (kind, false),
    };
    let kind = match kind.as_str() {
        "time" => ColumnKind::Time,
        "time_range" | "timeRange" => ColumnKind::TimeRange,
        "interval" => ColumnKind::Interval,
        other if !first => crate::convert::column_kind(other)?,
        other => {
            return Err(value_error(format!(
                "the first column is the key: 'time', 'time_range' or 'interval', got '{other}'"
            )));
        }
    };
    // The key is always required; a value column only when marked so.
    Ok(ColumnDef {
        name,
        kind,
        required: first || (required.unwrap_or(false) && !optional_mark),
    })
}

/// A schema: a list of entries, or `{name: kind}` (key first).
fn schema(obj: &Bound<'_, PyAny>) -> PyResult<Vec<ColumnDef>> {
    if let Ok(d) = obj.cast::<PyDict>() {
        return d
            .iter()
            .enumerate()
            .map(|(i, (k, v))| column_def(PyTuple::new(obj.py(), [k, v])?.as_any(), i == 0))
            .collect();
    }
    obj.try_iter()?
        .enumerate()
        .map(|(i, e)| column_def(&e?, i == 0))
        .collect()
}

/// A series that takes events as they arrive, and owns the nodes built on
/// it. `schema` is the key column then the value columns: `{"time":
/// "time", "host": "string", "cpu": "number"}`, a list of `(name, kind)`
/// tuples, or a `TimeSeries.schema`. Value columns may have gaps unless
/// marked required (`(name, kind, True)`).
#[pyclass(name = "LiveSeries", module = "pond_rs", frozen)]
pub struct PyLiveSeries {
    shared: Arc<Shared>,
}

impl PyLiveSeries {
    fn shared(&self) -> &Arc<Shared> {
        &self.shared
    }
    fn node_id(&self) -> NodeId {
        self.shared.root
    }
    fn node_kind(&self) -> NodeKind {
        NodeKind::Root
    }

    fn outputs<'py>(
        &self,
        py: Python<'py>,
        f: impl FnOnce(&mut LiveSeries) -> pond_rs::Result<Vec<Output>> + Send,
    ) -> PyResult<Bound<'py, PyList>> {
        self.shared.push_outputs(py, false, f)
    }

    fn row_values(
        &self,
        values: Option<&Bound<'_, PyAny>>,
        cells: Option<&Bound<'_, PyDict>>,
        defs: &[ColumnDef],
    ) -> PyResult<Vec<Option<Value>>> {
        let mut out: Vec<Option<Value>> = Vec::with_capacity(defs.len());
        out.resize_with(defs.len(), || None);
        let by_name = |out: &mut Vec<Option<Value>>, d: &Bound<'_, PyDict>| -> PyResult<()> {
            for (k, v) in d.iter() {
                let k = k
                    .cast_into::<PyString>()
                    .map_err(|_| PyTypeError::new_err("push: a column name is text"))?;
                let name = k.to_cow()?;
                let i = defs.iter().position(|c| c.name == *name).ok_or_else(|| {
                    value_error(format!(
                        "push: no value column '{name}' (columns: {})",
                        defs.iter()
                            .map(|c| c.name.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    ))
                })?;
                out[i] = push_cell(&v)?;
            }
            Ok(())
        };
        if let Some(v) = values {
            if let Ok(d) = v.cast::<PyDict>() {
                by_name(&mut out, d)?;
            } else if let Ok(l) = v.cast::<PyList>()
                && l.len() == defs.len()
            {
                for (i, item) in l.iter().enumerate() {
                    out[i] = push_cell(&item)?;
                }
            } else {
                let items: Vec<Bound<'_, PyAny>> = v.try_iter()?.collect::<PyResult<_>>()?;
                if items.len() != defs.len() {
                    return Err(value_error(format!(
                        "push: {} values for {} value columns",
                        items.len(),
                        defs.len()
                    )));
                }
                for (i, item) in items.iter().enumerate() {
                    out[i] = push_cell(item)?;
                }
            }
        }
        if let Some(d) = cells {
            by_name(&mut out, d)?;
        }
        Ok(out)
    }

    fn value_defs(&self) -> &[ColumnDef] {
        &self.shared.schema[1..]
    }

    fn key_def(&self) -> &ColumnDef {
        &self.shared.schema[0]
    }
}

/// `e` with "push_many row i: " in front of its message, same type.
fn at_row(py: Python<'_>, e: PyErr, i: usize) -> PyErr {
    let message = format!("push_many row {i}: {}", e.value(py));
    match e.get_type(py).call1((message,)) {
        Ok(v) => PyErr::from_value(v),
        Err(_) => e,
    }
}

/// A pushed cell: `None` is a gap; otherwise a number, text, bool or list
/// as the column's kind. (pond-rs checks kinds; this keeps a float NaN as
/// the number it is, which pond-rs refuses, as pond-ts does.)
fn push_cell(obj: &Bound<'_, PyAny>) -> PyResult<Option<Value>> {
    if obj.is_none() {
        return Ok(None);
    }
    if let Ok(f) = obj.cast_exact::<PyFloat>() {
        return Ok(Some(Value::Number(f.value())));
    }
    Ok(Some(value(obj, "push")?))
}

live_builders!(PyLiveSeries);
live_readers!(PyLiveSeries);

#[pymethods]
impl PyLiveSeries {
    #[new]
    #[pyo3(signature = (schema, *, name="live", ordering="strict", grace_window=None, max_events=None, max_age=None))]
    fn new(
        schema: Bound<'_, PyAny>,
        name: &str,
        ordering: &str,
        grace_window: Option<Bound<'_, PyAny>>,
        max_events: Option<usize>,
        max_age: Option<Bound<'_, PyAny>>,
    ) -> PyResult<Self> {
        let defs = self::schema(&schema)?;
        let mut o = LiveOptions::new().ordering(self::ordering(ordering)?);
        if let Some(g) = grace_window {
            o = o.grace_window(&duration(&g, "grace_window")?);
        }
        if let Some(n) = max_events {
            o = o.max_events(n);
        }
        if let Some(a) = max_age {
            o = o.max_age(&duration(&a, "max_age")?);
        }
        let live = LiveSeries::with_options(name.to_string(), defs, o).map_err(err)?;
        let root = live.root();
        let schema = live.schema().to_vec();
        let shared = Arc::new(Shared {
            live: Mutex::new(live),
            holder: AtomicU64::new(0),
            raised: Arc::new(Raised::default()),
            kinds: Mutex::new(HashMap::from([(root, NodeKind::Root)])),
            root,
            name: name.to_string(),
            schema,
        });
        Ok(PyLiveSeries { shared })
    }

    fn __repr__(&self, py: Python<'_>) -> PyResult<String> {
        let n = self.__len__(py)?;
        Ok(format!("LiveSeries('{}', {n} events)", self.shared.name))
    }

    /// The series' name.
    #[getter]
    fn name(&self) -> String {
        self.shared.name.clone()
    }

    /// The series itself as a node (its outputs carry this node).
    #[getter]
    fn root(&self) -> PyLiveNode {
        self.shared.node(self.node_id(), NodeKind::Root)
    }

    /// Push one event: a key (a time, `(begin, end)` or `(label, begin,
    /// end)`), then the values as a dict by column, a list in schema order,
    /// or keywords (`push(t, cpu=0.5, host="a")`). A column left out is a
    /// gap. Returns what the watched nodes emitted, in order.
    #[pyo3(signature = (key, values=None, /, **cells))]
    fn push<'py>(
        &self,
        py: Python<'py>,
        key: Bound<'py, PyAny>,
        values: Option<Bound<'py, PyAny>>,
        cells: Option<Bound<'py, PyDict>>,
    ) -> PyResult<Bound<'py, PyList>> {
        let key = event_key(&key, "push")?;
        let row = self.row_values(values.as_ref(), cells.as_ref(), self.value_defs())?;
        self.shared
            .push_outputs(py, true, move |l| l.push(key, row))
    }

    /// Push many events as one batch, all or nothing: each row a `(key,
    /// values)` pair (values a dict or a list in schema order) or a dict
    /// with the key column among the values.
    fn push_many<'py>(
        &self,
        py: Python<'py>,
        rows: Bound<'py, PyAny>,
    ) -> PyResult<Bound<'py, PyList>> {
        let defs = self.value_defs();
        let key_name = &self.key_def().name;
        let mut batch: Vec<(EventKey, Vec<Option<Value>>)> = Vec::new();
        for (i, row) in rows.try_iter()?.enumerate() {
            let row = row?;
            let read = || -> PyResult<(EventKey, Vec<Option<Value>>)> {
                if let Ok(t) = row.cast::<PyTuple>()
                    && t.len() == 2
                {
                    let (key, values) = (t.get_item(0)?, t.get_item(1)?);
                    return Ok((
                        event_key(&key, "key")?,
                        self.row_values(Some(&values), None, defs)?,
                    ));
                }
                if let Ok(d) = row.cast::<PyDict>() {
                    let key = d
                        .get_item(key_name)?
                        .ok_or_else(|| value_error(format!("no key column '{key_name}'")))?;
                    let rest = d.copy()?;
                    rest.del_item(key_name)?;
                    return Ok((
                        event_key(&key, "key")?,
                        self.row_values(Some(rest.as_any()), None, defs)?,
                    ));
                }
                let pair: Vec<Bound<'_, PyAny>> = row.try_iter()?.collect::<PyResult<_>>()?;
                let [key, values] = &pair[..] else {
                    return Err(PyTypeError::new_err(format!(
                        "a row is (key, values) or a dict with '{key_name}'"
                    )));
                };
                Ok((
                    event_key(key, "key")?,
                    self.row_values(Some(values), None, defs)?,
                ))
            };
            // The row's number goes into the message only when it fails.
            batch.push(read().map_err(|e| at_row(py, e, i))?);
        }
        self.outputs(py, move |l| l.push_many(batch))
    }

    /// Push a frame (a `TimeSeries`, pyarrow / polars / pandas, a dict of
    /// columns) as one batch, the fastest way in: it needs this series'
    /// key column and exactly its value columns. All or nothing. A NaN in
    /// a number column is a gap here (as in any `TimeSeries`), where
    /// `push` refuses a NaN cell.
    fn push_frame<'py>(
        &self,
        py: Python<'py>,
        data: Bound<'py, PyAny>,
    ) -> PyResult<Bound<'py, PyList>> {
        let series: Arc<TimeSeries> = if let Ok(s) = data.cast::<PyTimeSeries>() {
            Arc::clone(&s.get().inner)
        } else {
            let key = self.key_def().clone();
            let kwargs = PyDict::new(py);
            kwargs.set_item("key", &key.name)?;
            kwargs.set_item(
                "key_kind",
                match key.kind {
                    ColumnKind::TimeRange => "time_range",
                    ColumnKind::Interval => "interval",
                    _ => "time",
                },
            )?;
            let made = py.get_type::<PyTimeSeries>().call((data,), Some(&kwargs))?;
            Arc::clone(&made.cast::<PyTimeSeries>()?.get().inner)
        };
        self.outputs(py, move |l| l.push_series(&series))
    }

    /// Push rows written as pond-ts JSON (a JSON array of rows).
    fn push_json<'py>(&self, py: Python<'py>, rows: String) -> PyResult<Bound<'py, PyList>> {
        self.outputs(py, move |l| l.push_json(&rows))
    }

    /// Remove every event; views drop theirs.
    fn clear<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyList>> {
        self.outputs(py, |l| Ok(l.clear()))
    }

    /// Split events by the value of `column`: each value gets its own
    /// series (built when it first arrives, or now for `groups`), with its
    /// own ordering and retention when given. Build on it as on the series
    /// (each step runs per partition); `collect()` gathers the results.
    #[pyo3(signature = (column, *, groups=None, ordering=None, grace_window=None, max_events=None, max_age=None))]
    fn partition_by(
        &self,
        py: Python<'_>,
        column: String,
        groups: Option<Vec<String>>,
        ordering: Option<&str>,
        grace_window: Option<Bound<'_, PyAny>>,
        max_events: Option<usize>,
        max_age: Option<Bound<'_, PyAny>>,
    ) -> PyResult<PyLiveNode> {
        let mut o = PartitionOptions::new();
        if let Some(g) = &groups {
            o = o.groups(&refs(g));
        }
        if let Some(w) = ordering {
            o = o.ordering(self::ordering(w)?);
        }
        if let Some(g) = grace_window {
            o = o.grace_window(&duration(&g, "grace_window")?);
        }
        if let Some(n) = max_events {
            o = o.max_events(n);
        }
        if let Some(a) = max_age {
            o = o.max_age(&duration(&a, "max_age")?);
        }
        let from = self.node_id();
        let id = self
            .shared
            .with(py, move |l| {
                l.partition_by(from, &column, &o).map(|n| n.id())
            })?
            .map_err(err)?;
        Ok(self.shared.node(id, NodeKind::Partitioned))
    }
}

pub fn register(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<PyLiveSeries>()?;
    m.add_class::<PyLiveNode>()?;
    m.add_class::<PyLiveEvent>()?;
    m.add_class::<PyLiveOutput>()?;
    Ok(())
}
