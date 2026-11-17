//! Slot requests (`slots.ts`): nodes named by the caller, wired by name,
//! expanded into the nested specs they stand for.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use crate::error::{ErrorKind, ProcessError, Result};

fn slot_error(message: String) -> ProcessError {
    ProcessError::new(ErrorKind::Slot, message)
}

fn quoted(values: &[&str]) -> String {
    if values.is_empty() {
        "none".into()
    } else {
        values
            .iter()
            .map(|v| format!("'{v}'"))
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// Expands `{ name: { op, in, params } }` into one spec per slot, in the
/// order the slots were written. `columns` are the bound series' value
/// columns.
pub fn expand_slots(
    slots: &Map<String, Value>,
    columns: &[String],
) -> Result<Vec<(String, Value)>> {
    let names: Vec<&str> = slots.keys().map(String::as_str).collect();
    for name in &names {
        if columns.iter().any(|c| c == name) {
            return Err(slot_error(format!(
                "slot '{name}' collides with a source column of the same name — rename the slot, or an input naming '{name}' would be ambiguous"
            )));
        }
    }
    let mut done: HashMap<String, Value> = HashMap::new();
    let mut visiting: Vec<String> = Vec::new();
    for name in &names {
        expand(name, slots, columns, &names, &mut done, &mut visiting)?;
    }
    Ok(names
        .iter()
        .map(|n| ((*n).to_string(), done[*n].clone()))
        .collect())
}

fn expand(
    name: &str,
    slots: &Map<String, Value>,
    columns: &[String],
    names: &[&str],
    done: &mut HashMap<String, Value>,
    visiting: &mut Vec<String>,
) -> Result<Value> {
    if let Some(spec) = done.get(name) {
        return Ok(spec.clone());
    }
    if let Some(at) = visiting.iter().position(|v| v == name) {
        let mut path: Vec<&str> = visiting[at..].iter().map(String::as_str).collect();
        path.push(name);
        return Err(slot_error(format!("slot cycle: {}", path.join(" → "))));
    }
    let def = &slots[name];
    visiting.push(name.to_string());
    let refs: Vec<Value> = def
        .get("in")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut inputs = Vec::with_capacity(refs.len());
    for r in &refs {
        let text = r
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| crate::js::js_string(r));
        if slots.contains_key(&text) {
            inputs.push(expand(&text, slots, columns, names, done, visiting)?);
            continue;
        }
        if columns.contains(&text) {
            inputs.push(Value::String(text));
            continue;
        }
        // `bb#Lower`: one named output of a multi-output slot.
        if let Some(hash) = text.rfind('#')
            && hash > 0
            && slots.contains_key(&text[..hash])
        {
            let from = expand(&text[..hash], slots, columns, names, done, visiting)?;
            inputs.push(json!({ "from": from, "output": &text[hash + 1..] }));
            continue;
        }
        let hint = guess(&text)
            .filter(|(slot, _)| slots.contains_key(*slot))
            .map(|(slot, out)| {
                format!(" — to read one output of slot '{slot}', write '{slot}#{out}'")
            })
            .unwrap_or_default();
        let columns: Vec<&str> = columns.iter().map(String::as_str).collect();
        return Err(slot_error(format!(
            "slot '{name}' names '{text}', which is neither a slot nor a column{hint} — slots are {}; columns are {}",
            quoted(names),
            quoted(&columns)
        )));
    }
    visiting.pop();
    let mut spec = Map::new();
    spec.insert("op".into(), def.get("op").cloned().unwrap_or(Value::Null));
    if let Some(p) = def.get("params") {
        spec.insert("params".into(), p.clone());
    }
    spec.insert("inputs".into(), Value::Array(inputs));
    let spec = Value::Object(spec);
    done.insert(name.to_string(), spec.clone());
    Ok(spec)
}

/// `/^(.+)[.:/](.+)$/`: the last `.`, `:` or `/` with text on both sides
/// (the first group is greedy).
fn guess(text: &str) -> Option<(&str, &str)> {
    let at = text.rfind(['.', ':', '/'])?;
    let (head, tail) = (&text[..at], &text[at + 1..]);
    (!head.is_empty() && !tail.is_empty()).then_some((head, tail))
}
