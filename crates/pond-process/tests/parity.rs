//! Checks the port against the answers `@pond-ts/process` wrote into
//! `packages/process/test/fixtures/parity.json` (regenerate it with
//! `node packages/process/scripts/parity/generate.mjs`).
//!
//! Ids, messages and lineage text must match character for character.
//! `describe()` is compared as JSON values, since only its contents matter
//! to a reader.

use std::collections::HashMap;
use std::future::Future;
use std::pin::pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::task::{Context, Poll, Waker};

use pond_process::{
    Def, Host, LoadedSource, ParamDef, ProcessError, Registry, RunResult, SourceRef,
    SourceRegistry, basic_ops, explain, source_id, spec_id, summary_folds,
};
use pond_rs::{JsonOptions, TimeSeries};
use serde_json::{Map, Value, json};

fn fixture() -> &'static Value {
    static FIXTURE: OnceLock<Value> = OnceLock::new();
    FIXTURE.get_or_init(|| {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/process/test/fixtures/parity.json"
        );
        let text = std::fs::read_to_string(path).expect("read parity.json");
        serde_json::from_str(&text).expect("parse parity.json")
    })
}

/// The four ops the fixture defines for itself (`fixtureOps` in
/// `cases.mjs`), the way a consumer would define its own.
fn fixture_ops() -> Vec<Def> {
    vec![
        Def::op(
            "annualise",
            "fixture",
            "Annualised vol in percent from a daily variance.",
        )
        .param("days", ParamDef::int(252.0).min(1.0).max(366.0))
        .typed_input("variance", "variance")
        .output("", "%")
        .run(|ctx| {
            let days = ctx.number("days");
            Ok(vec![
                ctx.input("variance")
                    .iter()
                    .map(|v| (v * days).sqrt() * 100.0)
                    .collect(),
            ])
        })
        .label(|p, inputs| {
            format!(
                "annualised({}) {inputs}",
                pond_process::js::js_string(&p["days"])
            )
        }),
        Def::op("band", "fixture", "source ± width.")
            .param("width", ParamDef::num(1.0).min(0.0))
            .input("source")
            .output_on("Upper", "inherit", &["width"])
            .output_on("Mid", "inherit", &[])
            .output_on("Lower", "inherit", &["width"])
            .run(|ctx| {
                let v = ctx.input("source");
                let w = ctx.number("width");
                Ok(vec![
                    v.iter().map(|x| x + w).collect(),
                    v.to_vec(),
                    v.iter().map(|x| x - w).collect(),
                ])
            }),
        Def::op("boom", "fixture", "Op code that throws.")
            .input("source")
            .output("", "inherit")
            .run(|_| Err("boom: op code failed".into())),
        Def::op("short", "fixture", "Op code returning one row too few.")
            .input("source")
            .output("", "inherit")
            .run(|ctx| Ok(vec![ctx.input("source").iter().skip(1).copied().collect()])),
    ]
}

fn registry(name: &str) -> Registry {
    let mut r = Registry::standard();
    if name == "all" {
        for def in basic_ops()
            .into_iter()
            .chain(summary_folds())
            .chain(fixture_ops())
        {
            r.define(def).expect("define");
        }
    }
    r
}

/// A thrown error as the fixture records it.
fn caught(e: &ProcessError) -> Value {
    json!({ "code": e.code(), "name": e.name(), "message": e.message })
}

/// What the fixture records for a call: `{id}` or `{error: {code, name, message}}`.
fn outcome(result: pond_process::Result<String>) -> Value {
    match result {
        Ok(id) => serde_json::json!({ "id": id }),
        Err(e) => json!({ "error": caught(&e) }),
    }
}

#[test]
fn describe_matches() {
    for name in ["standard", "all"] {
        let want = fixture()["describe"][name].as_array().unwrap();
        let got = registry(name).describe();
        assert_eq!(got.len(), want.len(), "{name}: op count");
        for (g, w) in got.iter().zip(want) {
            assert_eq!(g, w, "{name}: describe of {}", w["name"]);
        }
    }
}

#[test]
fn spec_ids_errors_and_explain_match() {
    let reg = registry("all");
    for case in fixture()["ids"].as_array().unwrap() {
        let spec = &case["spec"];
        assert_eq!(
            outcome(spec_id(&reg, spec, true)),
            case["strict"],
            "strict id of {spec}"
        );
        assert_eq!(
            outcome(spec_id(&reg, spec, false)),
            case["lenient"],
            "lenient id of {spec}"
        );
        match case.get("explain") {
            Some(want) => assert_eq!(
                explain(&reg, spec).expect("explain"),
                want.as_str().unwrap(),
                "explain of {spec}"
            ),
            None => assert!(case["strict"].get("error").is_some()),
        }
    }
}

#[test]
fn source_ids_match() {
    for case in fixture()["sourceIds"].as_array().unwrap() {
        let r = SourceRef {
            source: case["ref"]["source"].as_str().unwrap().into(),
            params: case["ref"]["params"].as_object().unwrap().clone(),
        };
        assert_eq!(source_id(&r), case["id"].as_str().unwrap());
    }
}

#[test]
fn definition_mistakes_are_caught_when_defined() {
    let mut r = Registry::new();
    let err = r
        .define(Def::op("x", "f", "s").input("source"))
        .unwrap_err();
    assert_eq!(err.message, "op 'x' declares no outputs");
    let err = r
        .define(
            Def::op("x", "f", "s")
                .param("n", ParamDef::int(0.0).min(1.0))
                .input("source")
                .output("", "inherit"),
        )
        .unwrap_err();
    assert_eq!(
        err.message,
        "definition 'x' has an invalid default for 'n': x.n=0 is below minimum 1"
    );
    let err = r
        .define(
            Def::op("x", "f", "s")
                .param(
                    "n",
                    ParamDef::num(5.0).min(0.0).max(10.0).suggest(1.0, 20.0),
                )
                .input("source")
                .output("", "inherit"),
        )
        .unwrap_err();
    assert_eq!(
        err.message,
        "x.n suggest [1, 20] escapes the legal range [0, 10]"
    );
}

// ── sessions ──────────────────────────────────────────────────────────

/// Every number as an `f64`, so `3` and `3.0` compare equal: JavaScript
/// has one number type, and the fixture went through `JSON.stringify`.
fn norm(v: &Value) -> Value {
    match v {
        Value::Number(n) => json!(n.as_f64().unwrap()),
        Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), norm(v))).collect()),
        other => other.clone(),
    }
}

/// Polls a future to the end. The fixture's loaders never wait on
/// anything, so there is nothing to wake.
fn block_on<F: Future>(f: F) -> F::Output {
    let mut f = pin!(f);
    let mut cx = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(out) = f.as_mut().poll(&mut cx) {
            return out;
        }
    }
}

fn input(name: &str) -> Arc<TimeSeries> {
    let json = &fixture()["inputs"][name];
    Arc::new(TimeSeries::from_json_value(json, &JsonOptions::default()).expect("input series"))
}

/// The deterministic part of a response (`response` in `cases.mjs`).
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

fn run_session(session: &Value) -> Vec<Value> {
    let units: HashMap<String, String> = session
        .get("units")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap().into()))
                .collect()
        })
        .unwrap_or_default();
    let mut host = Host::new(
        Arc::new(registry(session["registry"].as_str().unwrap())),
        units,
    );
    if let Some(b) = session.get("budgetBytes").and_then(Value::as_u64) {
        host = host.with_budget_bytes(b as usize);
    }
    if let Some(n) = session.get("maxSources").and_then(Value::as_u64) {
        host = host.with_max_sources(n as usize);
    }
    // feed input -> (revision, input name)
    let revisions: Arc<Mutex<HashMap<String, (u32, String)>>> = Arc::default();
    if let Some(feeds) = session.get("feeds").and_then(Value::as_object) {
        for k in feeds.keys() {
            revisions.lock().unwrap().insert(k.clone(), (1, k.clone()));
        }
        let revs = revisions.clone();
        host = host.with_sources(SourceRegistry::new().define(
            "feed",
            Arc::new(
                move |params: &Map<String, Value>, _previous: Option<&LoadedSource>| {
                    let which = params
                        .get("input")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let found = revs.lock().unwrap().get(&which).cloned();
                    Box::pin(async move {
                        if which == "broken" {
                            return Err(ProcessError::thrown("feed is down"));
                        }
                        let (revision, name) = found.expect("a known feed");
                        Ok(LoadedSource {
                            value: input(&name),
                            revision: format!("r{revision}"),
                        })
                    })
                },
            ),
        ));
    }
    let mut results = vec![];
    for step in session["steps"].as_array().unwrap() {
        let s = |k: &str| step.get(k).and_then(Value::as_str);
        let result = if let Some(id) = s("add") {
            host.add(id, input(s("input").unwrap()));
            Value::Null
        } else if let Some(id) = s("remove") {
            json!({ "removed": host.remove(id) })
        } else if let Some(id) = s("has") {
            json!({ "has": host.has(id) })
        } else if let Some(feed) = s("revise") {
            let mut revs = revisions.lock().unwrap();
            let entry = revs.get_mut(feed).unwrap();
            *entry = (entry.0 + 1, s("input").unwrap().into());
            Value::Null
        } else if step.get("datasets").is_some() {
            let list: Vec<Value> = host
                .datasets()
                .into_iter()
                .map(|d| json!({ "id": d.id, "rows": d.rows, "columns": d.columns, "nodes": d.nodes }))
                .collect();
            json!({ "datasets": list })
        } else {
            let ran = match step.get("run") {
                Some(req) => host.run(req),
                None => block_on(host.run_async(&step["runAsync"])),
            };
            match ran {
                Ok(r) => json!({ "result": response(&r) }),
                Err(e) => json!({ "error": caught(&e) }),
            }
        };
        results.push(result);
    }
    results
}

#[test]
fn sessions_match() {
    let mut failures = vec![];
    for session in fixture()["sessions"].as_array().unwrap() {
        let name = session["name"].as_str().unwrap();
        let got = run_session(session);
        let want = session["results"].as_array().unwrap();
        assert_eq!(got.len(), want.len(), "{name}: step count");
        for (i, (g, w)) in got.iter().zip(want).enumerate() {
            if norm(g) != norm(w) {
                failures.push(format!(
                    "{name}, step {i}:\n  step: {}\n  want: {}\n  got:  {}",
                    session["steps"][i], w, g
                ));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} steps differ:\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}
