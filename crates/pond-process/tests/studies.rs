//! Checks the Rust study bridge ([`study_ops`]) against what
//! `@pond-ts/financial/process` wrote into
//! `packages/financial/test/fixtures/process-parity.json` (regenerate it
//! with `node packages/financial/scripts/parity/generate.mjs`).
//!
//! The study maths itself is checked bit for bit elsewhere (pond-rs's own
//! study parity); this checks the bridge on top: each op's `describe()`
//! entry, its spec id, and a run of every study through a [`Host`].

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use pond_process::{
    Host, ProcessError, Registry, RunResult, UNBRIDGED_STUDIES, spec_id, study_ops,
};
use pond_rs::{JsonOptions, TimeSeries};
use serde_json::{Map, Value, json};

fn fixture() -> &'static Value {
    static FIXTURE: OnceLock<Value> = OnceLock::new();
    FIXTURE.get_or_init(|| {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/financial/test/fixtures/process-parity.json"
        );
        let text = std::fs::read_to_string(path).expect("read process-parity.json");
        serde_json::from_str(&text).expect("parse process-parity.json")
    })
}

fn registry() -> Arc<Registry> {
    let mut registry = Registry::standard();
    for def in study_ops() {
        registry
            .define(def)
            .expect("a study op is a valid definition");
    }
    Arc::new(registry)
}

/// Every number as an `f64`, so `3` and `3.0` compare equal, and `-0` as
/// `0`, which is what `JSON.stringify` writes for it.
fn norm(v: &Value) -> Value {
    match v {
        Value::Number(n) => {
            let x = n.as_f64().unwrap();
            json!(if x == 0.0 { 0.0 } else { x })
        }
        Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), norm(v))).collect()),
        other => other.clone(),
    }
}

fn caught(e: &ProcessError) -> Value {
    json!({ "code": e.code(), "name": e.name(), "message": e.message })
}

/// The deterministic part of a response (`response` in `process.mjs`).
fn response(result: &RunResult) -> Value {
    let mut out = result.to_wire(None);
    for node in out["nodes"].as_array_mut().unwrap() {
        node.as_object_mut().unwrap().shift_remove("ms");
    }
    if let Some(columns) = &result.columns {
        let cells: Map<String, Value> = columns
            .iter()
            .map(|(name, col)| {
                let cells = col
                    .iter()
                    .map(|v| if v.is_finite() { json!(v) } else { Value::Null })
                    .collect();
                (name.clone(), Value::Array(cells))
            })
            .collect();
        out["columns"] = Value::Object(cells);
    }
    out
}

#[test]
fn unbridged_matches() {
    let want = fixture()["unbridged"].as_object().unwrap();
    assert_eq!(UNBRIDGED_STUDIES.len(), want.len());
    for (name, why) in UNBRIDGED_STUDIES {
        assert_eq!(want[*name].as_str(), Some(*why), "{name}");
    }
}

/// A `describe()` entry with the keys inside each param's own entry
/// sorted. Their order carries nothing and differs between TypeScript's
/// ops (each lists them as its author wrote them), while the order of the
/// params themselves is what a reader sees and must match.
fn sorted_param_keys(entry: &Value) -> Value {
    let mut out = entry.clone();
    if let Some(params) = out.get_mut("params").and_then(Value::as_object_mut) {
        for p in params.values_mut() {
            if let Value::Object(m) = p {
                m.sort_keys();
            }
        }
    }
    out
}

#[test]
fn describe_matches() {
    let want = fixture()["describe"].as_array().unwrap();
    let got = registry().describe();
    let names = |v: &[Value]| v.iter().map(|d| d["name"].clone()).collect::<Vec<_>>();
    assert_eq!(names(&got), names(want), "op names, in order");
    for (g, w) in got.iter().zip(want) {
        // As text, so the order of the params, and of every key outside a
        // param's own entry, counts too.
        assert_eq!(
            sorted_param_keys(&norm(g)).to_string(),
            sorted_param_keys(&norm(w)).to_string(),
            "describe of {}",
            w["name"]
        );
    }
}

#[test]
fn runs_match() {
    let registry = registry();
    let input = TimeSeries::from_json_value(&fixture()["input"], &JsonOptions::default())
        .expect("input series");
    let mut host = Host::new(registry.clone(), HashMap::new());
    host.add("d", Arc::new(input));
    // Columns with no numbers in them, which compare nothing but shape.
    let mut empty = vec![];
    for case in fixture()["runs"].as_array().unwrap() {
        let spec = &case["spec"];
        let label = spec.to_string();
        let id = match spec_id(&registry, spec, true) {
            Ok(id) => json!({ "id": id }),
            Err(e) => json!({ "error": caught(&e) }),
        };
        match case.get("id") {
            Some(want) => assert_eq!(&id["id"], want, "id of {label}"),
            None => assert_eq!(id["error"], case["error"], "id error of {label}"),
        }
        let request = json!({
            "from": "d",
            "process": [spec],
            "select": [{ "on": spec }],
            "onError": "collect",
            "assemble": false,
        });
        let got = match host.run(&request) {
            Ok(r) => json!({ "result": response(&r) }),
            Err(e) => json!({ "error": caught(&e) }),
        };
        match case.get("result") {
            Some(want) => {
                assert_eq!(norm(&got["result"]), norm(want), "run of {label}");
                for (name, cells) in want["columns"].as_object().into_iter().flatten() {
                    if cells.as_array().unwrap().iter().all(Value::is_null) {
                        empty.push(name.clone());
                    }
                }
            }
            None => assert_eq!(got["error"], case["error"], "run error of {label}"),
        }
    }
    // Only zigZag's default run: the bars never swing 5%, and a 1% run
    // covers its numbers.
    let zz = "p1:zigZag(high+low;deviation=5)";
    assert_eq!(
        empty,
        [
            format!("{zz}Pivot"),
            format!("{zz}Direction"),
            format!("{zz}Line")
        ],
        "every other column has numbers to compare"
    );
}
