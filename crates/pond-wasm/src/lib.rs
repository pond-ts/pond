//! pond-rs for JavaScript: the WebAssembly half of the `@pond-ts/rs` npm
//! package (`packages/rs`), which wraps these exports in pond-ts-shaped
//! classes.
//!
//! Series live in WebAssembly memory, in a table indexed by a number the
//! JavaScript side holds; `series_free` drops one. Every export returns a
//! JavaScript exception for bad input rather than stopping the instance: a
//! Rust panic in WebAssembly aborts the whole module.

pub mod dispatch;

use std::cell::RefCell;

use dispatch::{Outcome, Res};
use js_sys::{Array, Float64Array, Object, Reflect};
use pond_rs::Value as Literal;
use pond_rs::{
    ArrowKey, Column, ColumnData, ColumnKind, IntervalKeys, JsonOptions, Key, Labels, RowFormat,
    Scalar, TimeRangeKeys, TimeSeries,
};
use serde_json::Value;
use wasm_bindgen::prelude::*;

thread_local! {
    /// Every live series, by id. A freed slot is `None` and reused.
    static SERIES: RefCell<Vec<Option<TimeSeries>>> = const { RefCell::new(Vec::new()) };
}

fn store(s: TimeSeries) -> u32 {
    SERIES.with(|t| {
        let mut t = t.borrow_mut();
        match t.iter().position(Option::is_none) {
            Some(i) => {
                t[i] = Some(s);
                i as u32
            }
            None => {
                t.push(Some(s));
                (t.len() - 1) as u32
            }
        }
    })
}

fn with<T>(id: u32, f: impl FnOnce(&TimeSeries) -> Res<T>) -> Res<T> {
    SERIES.with(|t| {
        let t = t.borrow();
        match t.get(id as usize) {
            Some(Some(s)) => f(s),
            _ => Err(format!("series {id} was freed or never existed")),
        }
    })
}

fn err(e: String) -> JsError {
    JsError::new(&e)
}

/// Drop a series. Safe to call twice.
#[wasm_bindgen]
pub fn series_free(id: u32) {
    SERIES.with(|t| {
        if let Some(slot) = t.borrow_mut().get_mut(id as usize) {
            *slot = None;
        }
    });
}

/// How many series are alive (for leak checks).
#[wasm_bindgen]
pub fn series_alive() -> u32 {
    SERIES.with(|t| t.borrow().iter().filter(|s| s.is_some()).count() as u32)
}

/// The number of rows.
#[wasm_bindgen]
pub fn series_len(id: u32) -> Result<u32, JsError> {
    with(id, |s| Ok(s.len() as u32)).map_err(err)
}

/// Build a series from columns. `key_kind` is `time`, `timeRange` or
/// `interval`; `begin` holds the times (or starts) in ms, `end` the ends,
/// `labels` the interval labels (numbers or text). `schema` is the pond-ts
/// schema as JSON, key first; `columns` one entry per value column: a
/// `Float64Array` for numbers (NaN for a gap), else an array of cells
/// (`null` for a gap).
#[wasm_bindgen]
pub fn series_from_columns(
    name: &str,
    schema: &str,
    begin: Vec<f64>,
    end: Option<Vec<f64>>,
    labels: JsValue,
    columns: Array,
) -> Result<u32, JsError> {
    from_columns(name, schema, begin, end, labels, columns)
        .map(store)
        .map_err(err)
}

fn whole_ms(v: Vec<f64>) -> Res<Vec<i64>> {
    v.into_iter()
        .map(|t| {
            if t.fract() == 0.0 && t.abs() <= 8.64e15 {
                Ok(t as i64)
            } else {
                Err(format!(
                    "key times must be whole ms within ±8.64e15, got {t}"
                ))
            }
        })
        .collect()
}

fn from_columns(
    name: &str,
    schema: &str,
    begin: Vec<f64>,
    end: Option<Vec<f64>>,
    labels: JsValue,
    columns: Array,
) -> Res<TimeSeries> {
    let schema: Value = serde_json::from_str(schema).map_err(|e| format!("schema: {e}"))?;
    let defs = schema
        .as_array()
        .ok_or("schema must be a list of columns")?;
    let (key, defs) = defs.split_first().ok_or("schema needs a key column")?;
    if defs.len() != columns.length() as usize {
        return Err(format!(
            "schema has {} value columns but {} were given",
            defs.len(),
            columns.length()
        ));
    }
    let cols = defs
        .iter()
        .zip(columns.iter())
        .map(|(def, col)| column(def, col, begin.len()))
        .collect::<Res<Vec<_>>>()?;
    let begin = whole_ms(begin)?;
    let r = match key["kind"].as_str() {
        Some("time") => TimeSeries::new(name, begin, cols),
        Some("timeRange") => {
            let end = whole_ms(end.ok_or("a timeRange key needs ends")?)?;
            TimeSeries::from_time_ranges(name, TimeRangeKeys { begin, end }, cols)
        }
        Some("interval") => {
            let end = whole_ms(end.ok_or("an interval key needs ends")?)?;
            let labels = Array::from(&labels);
            let label: Labels = if labels.iter().all(|l| l.is_string()) {
                labels
                    .iter()
                    .map(|l| l.as_string().unwrap_or_default())
                    .collect::<Vec<_>>()
                    .into()
            } else {
                labels
                    .iter()
                    .map(|l| l.as_f64().ok_or("interval labels are numbers or text"))
                    .collect::<Result<Vec<_>, _>>()?
                    .into()
            };
            TimeSeries::from_intervals(name, IntervalKeys { label, begin, end }, cols)
        }
        _ => return Err(format!("unknown key kind {}", key["kind"])),
    };
    r.map_err(|e| e.to_string())
}

fn column(def: &Value, col: JsValue, rows: usize) -> Res<Column> {
    let name = def["name"].as_str().ok_or("a column needs a name")?;
    let kind = def["kind"].as_str().unwrap_or("number");
    let cells = || Array::from(&col);
    let data: ColumnData = match kind {
        "number" => {
            let v = if col.is_instance_of::<Float64Array>() {
                Float64Array::from(col).to_vec()
            } else {
                cells()
                    .iter()
                    .map(|c| c.as_f64().unwrap_or(f64::NAN))
                    .collect()
            };
            if v.len() != rows {
                return Err(format!(
                    "column '{name}' has {} rows, key has {rows}",
                    v.len()
                ));
            }
            pond_rs::Float64Column::from_values(v).into()
        }
        "string" => cells()
            .iter()
            .map(|c| c.as_string())
            .collect::<Vec<_>>()
            .into(),
        "boolean" => cells()
            .iter()
            .map(|c| c.as_bool())
            .collect::<Vec<_>>()
            .into(),
        "array" => cells()
            .iter()
            .map(|c| {
                if c.is_null() || c.is_undefined() {
                    Ok(None)
                } else {
                    Array::from(&c)
                        .iter()
                        .map(js_scalar)
                        .collect::<Res<_>>()
                        .map(Some)
                }
            })
            .collect::<Res<Vec<Option<Vec<Scalar>>>>>()?
            .into(),
        other => return Err(format!("column '{name}': unknown kind '{other}'")),
    };
    Ok(if def["required"].as_bool() == Some(false) {
        Column::optional(name, data)
    } else {
        Column::required(name, data)
    })
}

fn js_scalar(v: JsValue) -> Res<Scalar> {
    if let Some(n) = v.as_f64() {
        Ok(Scalar::Number(n))
    } else if let Some(s) = v.as_string() {
        Ok(Scalar::String(s))
    } else if let Some(b) = v.as_bool() {
        Ok(Scalar::Boolean(b))
    } else {
        Err("array elements must be numbers, text or true/false".into())
    }
}

/// Read pond-ts `toJSON()` text (times as numbers or text).
#[wasm_bindgen]
pub fn series_from_json(text: &str, time_zone: Option<String>) -> Result<u32, JsError> {
    let mut o = JsonOptions::new();
    if let Some(z) = time_zone {
        o = o.time_zone(z);
    }
    TimeSeries::from_json(text, &o)
        .map(store)
        .map_err(|e| err(e.to_string()))
}

/// pond-ts `toJSON()` text.
#[wasm_bindgen]
pub fn series_to_json_text(id: u32) -> Result<String, JsError> {
    with(id, |s| {
        s.to_json(RowFormat::default()).map_err(|e| e.to_string())
    })
    .map_err(err)
}

/// Read an Arrow IPC file. `key` names the key field and its kind:
/// `time`, `timeRange` or `interval`.
#[wasm_bindgen]
pub fn series_from_arrow(
    name: &str,
    bytes: Vec<u8>,
    key: &str,
    key_kind: Option<String>,
) -> Result<u32, JsError> {
    let key = match key_kind.as_deref() {
        None | Some("time") => ArrowKey::Time(key.into()),
        Some("timeRange") => ArrowKey::TimeRange(key.into()),
        Some("interval") => ArrowKey::Interval(key.into()),
        Some(other) => return Err(err(format!("unknown key kind '{other}'"))),
    };
    TimeSeries::from_ipc_bytes(name, bytes, key)
        .map(store)
        .map_err(|e| err(e.to_string()))
}

/// The series as an Arrow IPC file.
#[wasm_bindgen]
pub fn series_to_arrow(id: u32) -> Result<Vec<u8>, JsError> {
    with(id, |s| {
        let mut out = Vec::new();
        s.write_ipc(&mut out).map_err(|e| e.to_string())?;
        Ok(out)
    })
    .map_err(err)
}

/// One number column as a `Float64Array` (NaN for a gap).
#[wasm_bindgen]
pub fn series_numbers(id: u32, column: &str) -> Result<Float64Array, JsError> {
    with(id, |s| {
        let c = s.column(column).map_err(|e| e.to_string())?;
        let n = c.numbers().map_err(|e| e.to_string())?;
        Ok(Float64Array::from(n.values()))
    })
    .map_err(err)
}

/// The key's times (or starts) in ms.
#[wasm_bindgen]
pub fn series_times(id: u32) -> Result<Float64Array, JsError> {
    with(id, |s| {
        let t: Vec<f64> = s.key().begin().iter().map(|&t| t as f64).collect();
        Ok(Float64Array::from(&t[..]))
    })
    .map_err(err)
}

fn set(o: &Object, k: &str, v: &JsValue) {
    let _ = Reflect::set(o, &JsValue::from_str(k), v);
}

fn literal(v: &Option<Literal>) -> JsValue {
    match v {
        None => JsValue::NULL,
        Some(Literal::Number(x)) => JsValue::from_f64(*x),
        Some(Literal::Decimal(d)) => JsValue::from_str(&d.to_string()),
        Some(Literal::String(s)) => JsValue::from_str(s),
        Some(Literal::Boolean(b)) => JsValue::from_bool(*b),
        Some(Literal::Array(a)) => a
            .iter()
            .map(|e| match e {
                Scalar::Number(x) => JsValue::from_f64(*x),
                Scalar::String(s) => JsValue::from_str(s),
                Scalar::Boolean(b) => JsValue::from_bool(*b),
            })
            .collect::<Array>()
            .into(),
    }
}

/// The series as a pond-ts `toJSON()` object, numbers kept as numbers
/// (so `-0` and `NaN` survive, unlike JSON text).
#[wasm_bindgen]
pub fn series_to_object(id: u32) -> Result<JsValue, JsError> {
    with(id, |s| Ok(to_object(s))).map_err(err)
}

fn to_object(s: &TimeSeries) -> JsValue {
    let o = Object::new();
    set(&o, "name", &JsValue::from_str(s.name()));
    let schema: Array = s
        .schema()
        .into_iter()
        .map(|def| {
            let d = Object::new();
            set(&d, "name", &JsValue::from_str(&def.name));
            set(&d, "kind", &JsValue::from_str(def.kind.as_str()));
            let is_key = matches!(
                def.kind,
                ColumnKind::Time | ColumnKind::TimeRange | ColumnKind::Interval
            );
            if !is_key && !def.required {
                set(&d, "required", &JsValue::FALSE);
            }
            JsValue::from(d)
        })
        .collect();
    set(&o, "schema", &schema);
    let rows = Array::new_with_length(s.len() as u32);
    for i in 0..s.len() {
        let row = Array::new();
        row.push(&match s.key() {
            Key::Time(t) => JsValue::from_f64(t[i] as f64),
            Key::TimeRange(k) => Array::of2(
                &JsValue::from_f64(k.begin[i] as f64),
                &JsValue::from_f64(k.end[i] as f64),
            )
            .into(),
            Key::Interval(k) => {
                let label = match &k.label {
                    Labels::Number(v) => JsValue::from_f64(v[i]),
                    Labels::String(c) => c.get(i).map_or(JsValue::NULL, JsValue::from_str),
                };
                Array::of3(
                    &label,
                    &JsValue::from_f64(k.begin[i] as f64),
                    &JsValue::from_f64(k.end[i] as f64),
                )
                .into()
            }
        });
        for c in s.columns() {
            row.push(&literal(&dispatch::cell(c.data(), i)));
        }
        rows.set(i as u32, row.into());
    }
    set(&o, "rows", &rows);
    o.into()
}

fn record(cells: &[(String, Option<Literal>)]) -> JsValue {
    let o = Object::new();
    for (k, v) in cells {
        set(&o, k, &literal(v));
    }
    o.into()
}

/// Run a pond-ts method on a series. `args` is the argument list as JSON
/// (see [`dispatch`]). Returns `{ series: id }`, `{ groups: [[key, id]] }`,
/// `{ record: {…} }` or `{ records: [{…}] }`.
#[wasm_bindgen]
pub fn series_call(id: u32, op: &str, args: &str) -> Result<JsValue, JsError> {
    let args: Value = serde_json::from_str(args).map_err(|e| err(format!("{op}: {e}")))?;
    let list = args.as_array().map(Vec::as_slice).unwrap_or(&[]);
    let resolve = |v: &Value| -> Res<TimeSeries> {
        let other = v["series"]
            .as_u64()
            .ok_or_else(|| format!("{op}: expected a series, got {v}"))?;
        with(other as u32, |s| Ok(s.clone()))
    };
    let outcome = with(id, |s| dispatch::call(s, op, list, &resolve)).map_err(err)?;
    let o = Object::new();
    match outcome {
        Outcome::Series(s) => set(&o, "series", &JsValue::from(store(s))),
        Outcome::Groups(groups) => {
            let list: Array = groups
                .into_iter()
                .map(|(k, s)| {
                    JsValue::from(Array::of2(&JsValue::from_str(&k), &JsValue::from(store(s))))
                })
                .collect();
            set(&o, "groups", &list);
        }
        Outcome::Record(cells) => set(&o, "record", &record(&cells)),
        Outcome::Records(rows) => {
            let list: Array = rows.iter().map(|r| record(r)).collect();
            set(&o, "records", &list);
        }
    }
    Ok(o.into())
}

/// The pond-ts methods `series_call` runs.
#[wasm_bindgen]
pub fn supported_methods() -> Array {
    dispatch::OPS.iter().map(|s| JsValue::from_str(s)).collect()
}

/// The pond-ts methods a `partitionBy` step runs.
#[wasm_bindgen]
pub fn partitioned_methods() -> Array {
    dispatch::PARTITIONED_OPS
        .iter()
        .map(|s| JsValue::from_str(s))
        .collect()
}

/// The pond-rs version this build carries.
#[wasm_bindgen]
pub fn pond_rs_version() -> String {
    pond_rs::VERSION.to_string()
}
