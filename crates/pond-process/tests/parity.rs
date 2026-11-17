//! Checks the port against the answers `@pond-ts/process` wrote into
//! `packages/process/test/fixtures/parity.json` (regenerate it with
//! `node packages/process/scripts/parity/generate.mjs`).
//!
//! Ids, messages and lineage text must match character for character.
//! `describe()` is compared as JSON values, since only its contents matter
//! to a reader.

use std::sync::OnceLock;

use pond_process::{
    Def, ParamDef, Registry, SourceRef, basic_ops, explain, source_id, spec_id, summary_folds,
};
use serde_json::Value;

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
            .output_on("Lower", "inherit", &["width"]),
        Def::op("boom", "fixture", "Op code that throws.")
            .input("source")
            .output("", "inherit"),
        Def::op("short", "fixture", "Op code returning one row too few.")
            .input("source")
            .output("", "inherit"),
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

/// What the fixture records for a call: `{id}` or `{error: {code, name, message}}`.
fn outcome(result: pond_process::Result<String>) -> Value {
    match result {
        Ok(id) => serde_json::json!({ "id": id }),
        Err(e) => serde_json::json!({
            "error": { "code": e.code(), "name": e.code(), "message": e.message }
        }),
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
