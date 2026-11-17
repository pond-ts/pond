//! Spec ids and lineage text, as `identity.ts` writes them.
//!
//! An id is at once a column name, a cache key and a citation, so it must
//! match `@pond-ts/process` character for character: `p1:op(inputs;params)`,
//! params sorted and written after defaults, separators escaped. A spec that
//! does not validate can still be named (`p1?:…`, params written with their
//! type), and that name can never equal a valid one.

use serde_json::{Map, Value};

use crate::error::{ErrorKind, ProcessError, Result};
use crate::js::{js_string, js_typeof, json_stringify, utf16_cmp};
use crate::registry::{Def, Registry};

const VERSION: &str = "p1";
const UNVALIDATED: &str = "?";
const MALFORMED: &str = "!malformed";

/// Escapes the characters ids are built from (`\ ; , ( ) = +`), so a string
/// param cannot forge one.
pub(crate) fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | ';' | ',' | '(' | ')' | '=' | '+') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// `esc` of `typeof:String(v)`, used only inside an unvalidated id so that
/// `"20"` and `20` stay two ids.
fn typed_esc(v: &Value) -> String {
    esc(&format!("{}:{}", js_typeof(v), js_string(v)))
}

/// The spec's `op` as JavaScript would print `spec.op`.
fn op_text(spec: &Value) -> String {
    spec.get("op").map_or_else(|| "undefined".into(), js_string)
}

/// The registry entry for `spec.op`, if it names one.
fn op_def<'r>(registry: &'r Registry, spec: &Value) -> Option<&'r Def> {
    let name = spec.get("op")?.as_str()?;
    registry.get(name).ok().map(|d| d.as_ref())
}

fn is_param_bag(v: &Value) -> bool {
    v.is_object()
}

/// A nested spec (`{op…}`) or a picked output (`{from…, output}`).
fn is_spec_like(v: &Value) -> bool {
    v.as_object()
        .is_some_and(|o| o.contains_key("op") || o.contains_key("from"))
}

/// The spec inside an input, unwrapping a picked output.
pub(crate) fn spec_of(input: &Value) -> &Value {
    input.get("from").unwrap_or(input)
}

/// True for a picked output.
pub(crate) fn is_picked(input: &Value) -> bool {
    input.as_object().is_some_and(|o| o.contains_key("from"))
}

/// The id of a spec, given as JSON.
///
/// With `validate` true, an unknown op, a bad param, a wrong input count or
/// a malformed input is an error. With `validate` false nothing fails: a
/// broken spec gets a `p1?:` id that says what it held.
pub fn spec_id(registry: &Registry, spec: &Value, validate: bool) -> Result<String> {
    Ok(build(registry, spec, !validate)?.0)
}

fn build(registry: &Registry, spec: &Value, lenient: bool) -> Result<(String, bool)> {
    let mut unvalidated = false;
    let op_name = op_text(spec);

    let op = if lenient {
        op_def(registry, spec)
    } else {
        Some(registry.get(&op_name)?.as_ref())
    };
    if op.is_none() {
        unvalidated = true;
    }

    let inputs_value = spec.get("inputs");
    if let Some(op) = op
        && let Err(e) = registry.check_arity(op, inputs_value)
    {
        if !lenient {
            return Err(e);
        }
        unvalidated = true;
    }

    let raw_inputs: Vec<Value> = match inputs_value {
        Some(Value::Array(items)) => items.clone(),
        None => {
            unvalidated = true;
            vec![]
        }
        Some(other) => {
            unvalidated = true;
            let mut wrapped = Map::new();
            wrapped.insert(MALFORMED.into(), other.clone());
            vec![Value::Object(wrapped)]
        }
    };
    let mut tokens = Vec::with_capacity(raw_inputs.len());
    for input in &raw_inputs {
        if let Value::String(s) = input {
            tokens.push(esc(s));
        } else if is_spec_like(input) {
            let (id, bad) = build(registry, spec_of(input), lenient)?;
            if bad {
                unvalidated = true;
            }
            tokens.push(if is_picked(input) {
                let output = input
                    .get("output")
                    .map_or_else(|| "undefined".into(), js_string);
                format!("{id}#{}", esc(&output))
            } else {
                id
            });
        } else {
            if !lenient {
                return Err(ProcessError::new(
                    ErrorKind::Process,
                    format!(
                        "input of '{op_name}' must be a column name or a spec, got {}",
                        json_stringify(input)
                    ),
                ));
            }
            unvalidated = true;
            tokens.push(match input.get(MALFORMED) {
                Some(m) if input.is_object() => {
                    esc(&format!("{MALFORMED}:{}:{}", js_typeof(m), js_string(m)))
                }
                _ => typed_esc(input),
            });
        }
    }

    let params = spec.get("params");
    let mut entries: Vec<(String, Value)> = match op {
        None => match params {
            Some(p) if !is_param_bag(p) => {
                unvalidated = true;
                vec![(MALFORMED.into(), p.clone())]
            }
            Some(Value::Object(m)) => m.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
            _ => vec![],
        },
        Some(op) => match params {
            Some(p) if !is_param_bag(p) => {
                if !lenient {
                    return Err(ProcessError::new(
                        ErrorKind::Param,
                        format!(
                            "{op_name} params must be an object, got {}",
                            json_stringify(p)
                        ),
                    ));
                }
                unvalidated = true;
                vec![(MALFORMED.into(), p.clone())]
            }
            _ => {
                let given = params.and_then(Value::as_object);
                let resolved = match registry.resolve_params(op, given, true) {
                    Ok(r) => r,
                    Err(e) => {
                        if !lenient {
                            return Err(e);
                        }
                        unvalidated = true;
                        registry.resolve_params(op, given, false)?
                    }
                };
                resolved.into_iter().collect()
            }
        },
    };

    entries.sort_by(|(a, _), (b, _)| utf16_cmp(a, b));
    let p = entries
        .iter()
        .map(|(k, v)| {
            if unvalidated {
                format!("{}={}", esc(k), typed_esc(v))
            } else {
                format!("{k}={}", esc(&js_string(v)))
            }
        })
        .collect::<Vec<_>>()
        .join(",");
    let mark = if unvalidated { UNVALIDATED } else { "" };
    Ok((
        format!("{VERSION}{mark}:{op_name}({};{p})", tokens.join("+")),
        unvalidated,
    ))
}

/// Human lineage for a valid spec (`"latest Lower of band(width=2) of close"`).
pub fn explain(registry: &Registry, spec: &Value) -> Result<String> {
    let op = registry.get(&op_text(spec))?;
    let params =
        registry.resolve_params(op, spec.get("params").and_then(Value::as_object), true)?;
    let inputs = match spec.get("inputs") {
        Some(Value::Array(items)) => items
            .iter()
            .map(|i| {
                if let Value::String(s) = i {
                    return Ok(s.clone());
                }
                let base = explain(registry, spec_of(i))?;
                Ok(if is_picked(i) {
                    let output = i
                        .get("output")
                        .map_or_else(|| "undefined".into(), js_string);
                    format!("{output} of {base}")
                } else {
                    base
                })
            })
            .collect::<Result<Vec<_>>>()?
            .join(", "),
        _ => String::new(),
    };
    if let Some(label) = &op.label {
        return Ok(label(&params, &inputs));
    }
    let p = params
        .iter()
        .map(|(k, v)| format!("{k}={}", js_string(v)))
        .collect::<Vec<_>>()
        .join(", ");
    Ok(if p.is_empty() {
        format!("{} of {inputs}", op.name)
    } else {
        format!("{}({p}) of {inputs}", op.name)
    })
}
