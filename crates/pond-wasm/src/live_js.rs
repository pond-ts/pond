//! The JavaScript side of [`crate::live`]: live series in a table by id,
//! pushes (with number-only fast paths that send no JSON), builders and
//! readers, outputs as JavaScript values, and node functions calling back
//! into JavaScript.
//!
//! A JavaScript function given to a node runs inside the push. Its first
//! exception is kept and the push carries on (that event loses only that
//! node's value: a filter leaves it out, a map gives gaps); the push then
//! returns its outputs together with that exception, and the JavaScript
//! side hands the outputs to the listeners before rethrowing it, as the
//! Python bridge does. A function that calls back into its own series
//! gets an error (the series is busy), never a panic.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use js_sys::{Array, Object};
use pond_rs::live::{LiveEvent, Output};
use pond_rs::{ColumnDef, ColumnKind, EventKey, Label, TimeSeries, Value as Cell};
use serde_json::Value;
use wasm_bindgen::prelude::*;

use crate::live::{Class, Live, LiveFns, NoFns, Stats, number_cell, time_key};
use crate::{defs_js, err, literal, set, store};

/// A live series and the first exception one of its node functions threw
/// during the current call.
struct Owner {
    live: RefCell<Live>,
    thrown: Rc<RefCell<Option<JsValue>>>,
}

thread_local! {
    /// Every live series, by id. A freed slot is `None` and reused.
    static LIVES: RefCell<Vec<Option<Rc<Owner>>>> = const { RefCell::new(Vec::new()) };
    /// The one JavaScript function node functions are called through:
    /// `callback.call(seriesId, index, a, b)` runs that series' `fns[index]`.
    static CALLBACK: RefCell<Option<js_sys::Function>> = const { RefCell::new(None) };
}

/// Set the function node functions are called through (index.js does,
/// once). The functions themselves stay in JavaScript, held by their
/// series: kept here, wasm-bindgen's table would hold them (and any series
/// they refer to) for good.
#[wasm_bindgen]
pub fn live_set_callback(f: js_sys::Function) {
    CALLBACK.with(|c| *c.borrow_mut() = Some(f));
}

fn owner(id: u32) -> Result<Rc<Owner>, JsValue> {
    LIVES.with(|t| match t.borrow().get(id as usize) {
        Some(Some(o)) => Ok(Rc::clone(o)),
        _ => Err(err(format!("live series {id} was freed or never existed")).into()),
    })
}

const BUSY: &str = "this LiveSeries is in the middle of a call: a function given to one of \
                    its nodes (a filter, a map) cannot use the series itself";

/// Run `f` on live series `id`; an error (or a busy series) as a JS error.
fn with_live<T>(id: u32, f: impl FnOnce(&mut Live) -> Result<T, String>) -> Result<T, JsValue> {
    let o = owner(id)?;
    let mut l = o.live.try_borrow_mut().map_err(|_| err(BUSY.into()))?;
    f(&mut l).map_err(|e| err(e).into())
}

// The JavaScript functions are not thread-safe, but nothing here runs on
// another thread (see the `compile_error!` in lib.rs).

/// The functions one builder call passed: its `k`th is the series'
/// function `base + k` on the JavaScript side, called with the event's row
/// (`[key, ...cells]`) and its node's schema (a fold: with numbers).
struct JsFns {
    id: u32,
    base: u32,
    count: u32,
    thrown: Rc<RefCell<Option<JsValue>>>,
    /// The last schema seen and its JavaScript form.
    schema: RefCell<Option<(Vec<ColumnDef>, JsValue)>>,
}

// SAFETY: one thread only (see the `compile_error!` in lib.rs).
unsafe impl Send for JsFns {}
unsafe impl Sync for JsFns {}

impl JsFns {
    fn keep(&self, e: JsValue) {
        self.thrown.borrow_mut().get_or_insert(e);
    }

    fn schema_of(&self, e: &LiveEvent) -> JsValue {
        let mut cache = self.schema.borrow_mut();
        if let Some((defs, js)) = cache.as_ref()
            && defs[..] == e.schema()[..]
        {
            return js.clone();
        }
        let js: JsValue = defs_js(e.schema().iter().cloned()).into();
        *cache = Some((e.schema().to_vec(), js.clone()));
        js
    }

    /// Function `k` with `a` and `b`; an exception (or a bad `k`) as `Err`.
    fn invoke(&self, k: usize, a: &JsValue, b: &JsValue) -> Result<JsValue, JsValue> {
        if k >= self.count as usize {
            return Err(err(format!("argument function {k} is not a function")).into());
        }
        let index = JsValue::from(self.base + k as u32);
        CALLBACK.with(|c| match c.borrow().as_ref() {
            Some(f) => f.call3(&JsValue::from(self.id), &index, a, b),
            None => Err(err("live_set_callback was never called".into()).into()),
        })
    }

    /// `fn(row, schema)`, keeping an exception.
    fn call(&self, k: usize, e: &LiveEvent) -> Option<JsValue> {
        let schema = self.schema_of(e);
        match self.invoke(k, &event_row(e).into(), &schema) {
            Ok(v) => Some(v),
            Err(ex) => {
                self.keep(ex);
                None
            }
        }
    }
}

/// A JavaScript value as a cell of `def` (a value of the wrong type is a
/// gap, as the batch bridge's `mapColumns`).
fn js_cell(def: &ColumnDef, v: JsValue) -> Option<Cell> {
    match def.kind {
        ColumnKind::Number => v.as_f64().map(Cell::Number),
        ColumnKind::String => v.as_string().map(Cell::String),
        ColumnKind::Boolean => v.as_bool().map(Cell::Boolean),
        ColumnKind::Array if Array::is_array(&v) => Array::from(&v)
            .iter()
            .map(|x| crate::js_scalar(x).ok())
            .collect::<Option<Vec<_>>>()
            .map(Cell::Array),
        _ => None,
    }
}

impl LiveFns for JsFns {
    fn test(&self, k: usize, e: &LiveEvent) -> bool {
        self.call(k, e).is_some_and(|v| v.is_truthy())
    }
    fn map(&self, k: usize, e: &LiveEvent) -> Vec<Option<Cell>> {
        let defs = &e.schema()[1..];
        let gaps = || vec![None; defs.len()];
        let Some(out) = self.call(k, e) else {
            return gaps();
        };
        // The JavaScript side returns the new event's cells in schema order.
        if !Array::is_array(&out) {
            return gaps();
        }
        let cells = Array::from(&out);
        defs.iter()
            .enumerate()
            .map(|(i, d)| js_cell(d, cells.get(i as u32)))
            .collect()
    }
    fn fold(&self, k: usize, acc: f64, v: f64) -> f64 {
        match self.invoke(k, &acc.into(), &v.into()) {
            // As pond-ts stores whatever the function gives: a result that
            // is not a number is a gap.
            Ok(r) => r.as_f64().unwrap_or(f64::NAN),
            // The running value stays as it was before this event.
            Err(ex) => {
                self.keep(ex);
                acc
            }
        }
    }
    fn failed(&self) -> bool {
        self.thrown.borrow().is_some()
    }
}

fn key_js(key: &EventKey) -> JsValue {
    match key.kind() {
        "time" => JsValue::from_f64(key.begin() as f64),
        "timeRange" => Array::of2(
            &JsValue::from_f64(key.begin() as f64),
            &JsValue::from_f64(key.end() as f64),
        )
        .into(),
        _ => {
            let label = match key.label() {
                Some(Label::Number(v)) => JsValue::from_f64(*v),
                Some(Label::String(s)) => JsValue::from_str(s),
                None => JsValue::NULL,
            };
            Array::of3(
                &label,
                &JsValue::from_f64(key.begin() as f64),
                &JsValue::from_f64(key.end() as f64),
            )
            .into()
        }
    }
}

/// An event as `[key, ...cells]` (`null` for a gap).
fn event_row(e: &LiveEvent) -> Array {
    let row = Array::new_with_length(e.values().len() as u32 + 1);
    row.set(0, key_js(e.key()));
    for (i, v) in e.values().iter().enumerate() {
        row.set(i as u32 + 1, literal(v));
    }
    row
}

fn record(names: &[String], values: &[Option<Cell>]) -> JsValue {
    let o = Object::new();
    for (n, v) in names.iter().zip(values) {
        // pond-ts's `value()` gives `undefined` for a gap.
        let v = if v.is_some() {
            literal(v)
        } else {
            JsValue::UNDEFINED
        };
        set(&o, n, &v);
    }
    o.into()
}

fn kind_code(o: &Output) -> u32 {
    match o {
        Output::Event { .. } => 0,
        Output::Batch { .. } => 1,
        Output::Evict { .. } => 2,
        Output::Bucket { .. } => 3,
        Output::Update { .. } => 4,
    }
}

/// Outputs as one flat list: `handle, kind, payload` for each (kind 0..4
/// = event, batch, evict, bucket, update; payload a row, a list of rows,
/// a value record or `undefined`).
fn outputs_js(live: &Live, outs: Vec<Output>) -> Array {
    let list = Array::new();
    let mut names: HashMap<u32, Vec<String>> = HashMap::new();
    for o in outs {
        let Some(h) = live.handle_of(o.node()) else {
            continue;
        };
        list.push(&JsValue::from(h));
        list.push(&JsValue::from(kind_code(&o)));
        let payload: JsValue = match o {
            Output::Event { event, .. } | Output::Bucket { event, .. } => event_row(&event).into(),
            Output::Batch { events, .. } | Output::Evict { events, .. } => events
                .iter()
                .map(|e| JsValue::from(event_row(e)))
                .collect::<Array>()
                .into(),
            Output::Update { values: None, .. } => JsValue::UNDEFINED,
            Output::Update {
                values: Some(v), ..
            } => {
                let n = names
                    .entry(h)
                    .or_insert_with(|| live.value_names(h).unwrap_or_default());
                record(n, &v)
            }
        };
        list.push(&payload);
    }
    list
}

/// Outputs as numbers when every key and cell is one (a label a number, a
/// gap NaN; a NaN cell sends the outputs as JavaScript values instead):
/// `handle, kind, n` and then `n` events of the node's key width plus its
/// value columns (an `update`: `n` is 1 for values, then the values; 0 for
/// none). The JavaScript side reads widths from each node's schema. One
/// copy instead of a JavaScript array per event and cell.
fn outputs_f64(live: &Live, outs: &[Output]) -> Option<Vec<f64>> {
    fn cells(v: &mut Vec<f64>, values: &[Option<Cell>]) -> Option<()> {
        for c in values {
            v.push(match c {
                None => f64::NAN,
                Some(Cell::Number(x)) if !x.is_nan() => *x,
                _ => return None,
            });
        }
        Some(())
    }
    fn event(v: &mut Vec<f64>, e: &LiveEvent) -> Option<()> {
        let k = e.key();
        match k.kind() {
            "time" => v.push(k.begin() as f64),
            "timeRange" => v.extend([k.begin() as f64, k.end() as f64]),
            _ => match k.label() {
                Some(Label::Number(x)) if !x.is_nan() => {
                    v.extend([*x, k.begin() as f64, k.end() as f64])
                }
                _ => return None,
            },
        }
        cells(v, e.values())
    }
    let mut v = Vec::with_capacity(outs.len() * 6);
    for o in outs {
        v.push(live.handle_of(o.node())? as f64);
        v.push(kind_code(o) as f64);
        match o {
            Output::Event { event: e, .. } | Output::Bucket { event: e, .. } => {
                v.push(1.0);
                event(&mut v, e)?;
            }
            Output::Batch { events, .. } | Output::Evict { events, .. } => {
                v.push(events.len() as f64);
                for e in events {
                    event(&mut v, e)?;
                }
            }
            Output::Update { values: None, .. } => v.push(0.0),
            Output::Update {
                values: Some(values),
                ..
            } => {
                v.push(1.0);
                cells(&mut v, values)?;
            }
        }
    }
    Some(v)
}

/// A push's answer: `undefined` (nothing watched emitted), the outputs, or
/// `{ outputs, thrown }` when a node function threw during it.
fn finish(o: &Owner, l: &Live, r: pond_rs::Result<Vec<Output>>) -> Result<JsValue, JsValue> {
    let thrown = o.thrown.borrow_mut().take();
    let outs = match r {
        Ok(outs) => outs,
        Err(e) => return Err(thrown.unwrap_or_else(|| err(e.to_string()).into())),
    };
    if outs.is_empty() && thrown.is_none() {
        return Ok(JsValue::UNDEFINED);
    }
    let list: JsValue = match outputs_f64(l, &outs) {
        Some(v) => js_sys::Float64Array::from(&v[..]).into(),
        None => outputs_js(l, outs).into(),
    };
    Ok(match thrown {
        None => list,
        Some(t) => {
            let r = Object::new();
            set(&r, "outputs", &list);
            set(&r, "thrown", &t);
            r.into()
        }
    })
}

fn push_with(
    id: u32,
    f: impl FnOnce(&mut Live) -> Result<pond_rs::Result<Vec<Output>>, String>,
) -> Result<JsValue, JsValue> {
    let o = owner(id)?;
    let mut l = o.live.try_borrow_mut().map_err(|_| err(BUSY.into()))?;
    let r = f(&mut l).map_err(err)?;
    finish(&o, &l, r)
}

fn parse(text: &str, what: &str) -> Result<Value, JsValue> {
    serde_json::from_str(text).map_err(|e| err(format!("{what}: {e}")).into())
}

/// `new LiveSeries({ name, schema, ...options })`: the new series' id.
#[wasm_bindgen]
pub fn live_new(name: &str, schema: &str, options: &str) -> Result<u32, JsValue> {
    let live = Live::new(
        name,
        &parse(schema, "schema")?,
        &parse(options, "LiveSeries options")?,
    )
    .map_err(err)?;
    let o = Rc::new(Owner {
        live: RefCell::new(live),
        thrown: Rc::new(RefCell::new(None)),
    });
    Ok(LIVES.with(|t| {
        let mut t = t.borrow_mut();
        match t.iter().position(Option::is_none) {
            Some(i) => {
                t[i] = Some(o);
                i as u32
            }
            None => {
                t.push(Some(o));
                (t.len() - 1) as u32
            }
        }
    }))
}

/// Drop a live series and all its nodes. Safe to call twice.
#[wasm_bindgen]
pub fn live_free(id: u32) {
    // Taken out first: dropping the series drops the JavaScript functions
    // its nodes hold, outside the table's borrow.
    let gone = LIVES.with(|t| {
        t.borrow_mut()
            .get_mut(id as usize)
            .and_then(|slot| slot.take())
    });
    drop(gone);
}

/// How many live series are alive (for leak checks).
#[wasm_bindgen]
pub fn lives_alive() -> u32 {
    LIVES.with(|t| t.borrow().iter().filter(|s| s.is_some()).count() as u32)
}

/// Build `op(...args)` on node `h` (`args` as JSON, `{"fn": k}` for the
/// series' JavaScript function `base + k`, `k < count`):
/// `[handle, className]`. A node built over history whose function throws
/// is removed and the exception rethrown.
#[wasm_bindgen]
pub fn live_build(
    id: u32,
    h: u32,
    op: &str,
    args: &str,
    base: u32,
    count: u32,
) -> Result<Array, JsValue> {
    let args = parse(args, op)?;
    let list = args.as_array().map(Vec::as_slice).unwrap_or(&[]);
    let o = owner(id)?;
    let f: Arc<dyn LiveFns> = if count == 0 {
        Arc::new(NoFns)
    } else {
        Arc::new(JsFns {
            id,
            base,
            count,
            thrown: Rc::clone(&o.thrown),
            schema: RefCell::new(None),
        })
    };
    let mut l = o.live.try_borrow_mut().map_err(|_| err(BUSY.into()))?;
    let r = l.build(h, op, list, f);
    let thrown = o.thrown.borrow_mut().take();
    if let Some(t) = thrown {
        return Err(t);
    }
    let (node, class) = r.map_err(err)?;
    Ok(Array::of2(
        &JsValue::from(node),
        &JsValue::from_str(class.name()),
    ))
}

/// Watch (`on`) or stop watching an output kind of node `h`.
#[wasm_bindgen]
pub fn live_watch(id: u32, h: u32, kind: &str, on: bool) -> Result<(), JsValue> {
    with_live(id, |l| l.watch(h, kind, on))
}

/// pond-ts `dispose()` on node `h`.
#[wasm_bindgen]
pub fn live_remove(id: u32, h: u32) -> Result<(), JsValue> {
    with_live(id, |l| l.remove(h))
}

fn stats_js(s: Stats) -> JsValue {
    let o = Object::new();
    let n = |k: &str, v: f64| set(&o, k, &JsValue::from_f64(v));
    let opt = |k: &str, v: Option<i64>| {
        if let Some(v) = v {
            set(&o, k, &JsValue::from_f64(v as f64));
        }
    };
    match s {
        Stats::Series(s) => {
            n("ingested", s.ingested as f64);
            n("evicted", s.evicted as f64);
            n("rejected", s.rejected as f64);
            n("length", s.length as f64);
            opt("earliestTs", s.earliest);
            opt("latestTs", s.latest);
        }
        Stats::Aggregation(s) => {
            n("eventsObserved", s.events_observed as f64);
            n("bucketsClosed", s.buckets_closed as f64);
            n("openBuckets", s.open_buckets as f64);
            opt("openBucketStart", s.open_bucket_start);
        }
        Stats::Rolling(s, fused) => {
            n("eventsObserved", s.events_observed as f64);
            n("evictions", s.evictions as f64);
            n("emissions", s.emissions as f64);
            n("windowSize", s.window_size as f64);
            if fused {
                n("windowsCount", s.windows as f64);
            }
        }
        Stats::Reduce(s) => {
            n("eventsObserved", s.events_observed as f64);
            n("evictions", s.evictions as f64);
            n("emissions", s.emissions as f64);
            n("bufferSize", s.buffer_size as f64);
        }
        Stats::Partitioned(s) => {
            n("partitions", s.partitions as f64);
            n("eventsRouted", s.events_routed as f64);
        }
        Stats::PartitionRolling(s) => {
            n("partitions", s.partitions as f64);
            n("eventsObserved", s.events_observed as f64);
            n("emissions", s.emissions as f64);
            n("windowSize", s.window_size as f64);
        }
    }
    o.into()
}

/// Read node `h`: `length`, `at` (row `arg`, negative from the end; a row
/// or `undefined`), `schema`, `stats`, `value`, `count`, `hasOpenBucket`,
/// `toTimeSeries` / `closed` / `snapshot` (a batch series id), `toMap`
/// (`[[key, handle, className]]`), `replay` (a reduce's rows).
#[wasm_bindgen]
pub fn live_read(id: u32, h: u32, op: &str, arg: f64) -> Result<JsValue, JsValue> {
    with_live(id, |l| {
        Ok(match op {
            "length" => JsValue::from_f64(l.len(h)? as f64),
            "at" => match l.at(h, arg as i64)? {
                Some(e) => event_row(&e).into(),
                None => JsValue::UNDEFINED,
            },
            "schema" => defs_js(l.schema(h)?).into(),
            "stats" => stats_js(l.stats(h)?),
            "value" => {
                let (defs, values) = l.value(h)?;
                let names: Vec<String> = defs.into_iter().skip(1).map(|c| c.name).collect();
                record(&names, &values)
            }
            "count" => JsValue::from_f64(l.count(h)? as f64),
            "hasOpenBucket" => JsValue::from_bool(l.has_open_bucket(h)?),
            "toTimeSeries" | "closed" | "snapshot" => JsValue::from(store(l.series(h, op)?)),
            "toMap" => l
                .to_map(h)?
                .into_iter()
                .map(|(k, n, c)| -> JsValue {
                    Array::of3(
                        &JsValue::from_str(&k),
                        &JsValue::from(n),
                        &JsValue::from_str(c.name()),
                    )
                    .into()
                })
                .collect::<Array>()
                .into(),
            "replay" => l
                .reduce_events(h)?
                .iter()
                .map(|e| JsValue::from(event_row(e)))
                .collect::<Array>()
                .into(),
            "class" => JsValue::from_str(l.class(h).map(Class::name)?),
            other => return Err(format!("no live reader '{other}'")),
        })
    })
}

/// Whether the series takes the number-only fast path: a time key and
/// number value columns only.
#[wasm_bindgen]
pub fn live_numeric(id: u32) -> Result<bool, JsValue> {
    with_live(id, |l| Ok(l.numeric()))
}

/// Push rows written as JSON `[key, ...cells]` (see [`Live::rows`]); one
/// row pushes as pond-rs `push`, more as `push_many`.
#[wasm_bindgen]
pub fn live_push_rows(id: u32, rows: &str) -> Result<JsValue, JsValue> {
    let rows = parse(rows, "push")?;
    let list = rows.as_array().map(Vec::as_slice).unwrap_or(&[]);
    push_with(id, |l| {
        let mut rows = l.rows(list)?;
        Ok(if rows.len() == 1 {
            let (k, v) = rows.pop().expect("one row");
            l.live.push(k, v)
        } else {
            l.live.push_many(rows)
        })
    })
}

/// pond-ts `pushJson(rows)`: rows as pond-ts JSON text.
#[wasm_bindgen]
pub fn live_push_json(id: u32, text: &str) -> Result<JsValue, JsValue> {
    push_with(id, |l| Ok(l.live.push_json(text)))
}

/// pond-ts `clear()`.
#[wasm_bindgen]
pub fn live_clear(id: u32) -> Result<JsValue, JsValue> {
    push_with(id, |l| Ok(Ok(l.live.clear())))
}

fn push_numbers(id: u32, t: f64, cells: Vec<Option<Cell>>) -> Result<JsValue, JsValue> {
    push_with(id, |l| Ok(l.live.push(time_key(t)?, cells)))
}

/// Fast path: one event of a time key and one number column (NaN a gap).
#[wasm_bindgen]
pub fn live_push1(id: u32, t: f64, a: f64) -> Result<JsValue, JsValue> {
    push_numbers(id, t, vec![number_cell(a)])
}

/// Fast path: two number columns.
#[wasm_bindgen]
pub fn live_push2(id: u32, t: f64, a: f64, b: f64) -> Result<JsValue, JsValue> {
    push_numbers(id, t, vec![number_cell(a), number_cell(b)])
}

/// Fast path: three number columns.
#[wasm_bindgen]
pub fn live_push3(id: u32, t: f64, a: f64, b: f64, c: f64) -> Result<JsValue, JsValue> {
    push_numbers(id, t, vec![number_cell(a), number_cell(b), number_cell(c)])
}

/// Fast path: any number of number columns.
#[wasm_bindgen]
pub fn live_push_numbers(id: u32, t: f64, values: &[f64]) -> Result<JsValue, JsValue> {
    push_numbers(id, t, values.iter().map(|&v| number_cell(v)).collect())
}

/// Fast path for `pushMany`: `flat` holds `width` numbers per row, the
/// time then the cells (NaN a gap). Rows in time order with finite cells
/// go in as one batch series (pond-rs `push_series`: same checks, ordering,
/// retention and outputs as `push_many`, but no event built per row on a
/// bare series); anything else as `push_many` rows, which refuse an
/// infinite cell as pond-ts does.
#[wasm_bindgen]
pub fn live_push_many_numbers(id: u32, flat: &[f64], width: u32) -> Result<JsValue, JsValue> {
    let w = width as usize;
    push_with(id, |l| {
        if w == 0 || !flat.len().is_multiple_of(w) {
            return Err("pushMany: bad row width".into());
        }
        let n = flat.len() / w;
        let mut times = Vec::with_capacity(n);
        let mut ordered = true;
        let mut finite = true;
        for r in flat.chunks_exact(w) {
            let t = time_key(r[0])?.begin();
            ordered &= times.last().is_none_or(|&last| last <= t);
            finite &= r[1..].iter().all(|v| v.is_finite() || v.is_nan());
            times.push(t);
        }
        if ordered && finite {
            let defs = &l.live.schema()[1..];
            let columns = defs
                .iter()
                .enumerate()
                .map(|(c, d)| {
                    let v: Vec<f64> = flat.chunks_exact(w).map(|r| r[c + 1]).collect();
                    pond_rs::Column::optional(&d.name, pond_rs::Float64Column::from_values(v))
                })
                .collect();
            let series =
                TimeSeries::new(l.live.name(), times, columns).map_err(|e| e.to_string())?;
            return Ok(l.live.push_series(&series));
        }
        let rows = flat
            .chunks_exact(w)
            .map(|r| {
                Ok((
                    time_key(r[0])?,
                    r[1..].iter().map(|&v| number_cell(v)).collect::<Vec<_>>(),
                ))
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(l.live.push_many(rows))
    })
}
