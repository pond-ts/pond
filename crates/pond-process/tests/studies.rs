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

#[test]
fn describe_matches() {
    let want = fixture()["describe"].as_array().unwrap();
    let got = registry().describe();
    let names = |v: &[Value]| v.iter().map(|d| d["name"].clone()).collect::<Vec<_>>();
    assert_eq!(names(&got), names(want), "op names, in order");
    for (g, w) in got.iter().zip(want) {
        assert_eq!(norm(g), norm(w), "describe of {}", w["name"]);
    }
}

#[test]
fn runs_match() {
    let registry = registry();
    let input = TimeSeries::from_json_value(&fixture()["input"], &JsonOptions::default())
        .expect("input series");
    let mut host = Host::new(registry.clone(), HashMap::new());
    host.add("d", Arc::new(input));
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
            Some(want) => assert_eq!(norm(&got["result"]), norm(want), "run of {label}"),
            None => assert_eq!(got["error"], case["error"], "run error of {label}"),
        }
    }
}
