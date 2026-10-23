//! pond-rs's study catalog against `@pond-ts/financial/catalog`: the
//! committed fixture `packages/financial/test/fixtures/catalog-parity.json`
//! (written by `packages/financial/scripts/parity/generate.mjs`, kept fresh
//! by `catalog-parity.test.ts`). Every descriptor must equal pond-ts's, and
//! each is run against its study as pond-ts's `catalog.test.ts` does.

mod common;

use common::repo_path;
use pond_rs::financial::catalog::{
    ParamKind, STUDIES, STUDY_FAMILIES, StudyDescriptor, StudyNaming, study_descriptor,
};
use pond_rs::{Column, TimeSeries};
use serde_json::{Map, Value, json};

const FIXTURE: &str = "packages/financial/test/fixtures/catalog-parity.json";

fn fixture() -> Value {
    let text = std::fs::read_to_string(repo_path(FIXTURE)).expect("catalog fixture");
    serde_json::from_str(&text).expect("catalog fixture parses")
}

/// The catalog test's 120 bars, with a session id stepping every 20.
fn bars(fixture: &Value) -> TimeSeries {
    let rows = fixture["bars"].as_array().unwrap();
    let col = |i: usize| -> Vec<f64> { rows.iter().map(|r| r[i].as_f64().unwrap()).collect() };
    let names = ["open", "high", "low", "close", "volume", "sess"];
    TimeSeries::new(
        "bars",
        rows.iter().map(|r| r[0].as_i64().unwrap()).collect(),
        names
            .iter()
            .enumerate()
            .map(|(i, name)| Column::required(*name, col(i + 1)))
            .collect(),
    )
    .unwrap()
}

fn names(s: &TimeSeries) -> Vec<String> {
    s.columns().iter().map(|c| c.name().to_string()).collect()
}

fn values(s: &TimeSeries, name: &str) -> Vec<Option<f64>> {
    s.column(name).unwrap().numbers().unwrap().iter().collect()
}

/// The smallest options that run the study (pond-ts `minimalOptions`).
fn minimal(d: &StudyDescriptor) -> Map<String, Value> {
    let mut o = Map::new();
    for input in d.inputs {
        // A required column (a benchmark) must differ from the source.
        if input.default.is_none() {
            o.insert(input.role.into(), json!("open"));
        }
    }
    for p in d.params {
        if p.optional {
            continue;
        }
        match p.kind {
            ParamKind::Number {
                default: None,
                example: Some(e),
                ..
            } => {
                o.insert(p.name.into(), json!(e));
            }
            ParamKind::Enum {
                default: None,
                example: Some(e),
                ..
            } => {
                o.insert(p.name.into(), json!(e));
            }
            _ => {}
        }
    }
    match d.anchor {
        Some(pond_rs::financial::catalog::StudyAnchor::Session) => {
            o.insert("session".into(), json!("sess"));
        }
        Some(pond_rs::financial::catalog::StudyAnchor::Time) => {
            o.insert("anchor".into(), json!(10 * 60_000));
        }
        None => {}
    }
    o
}

fn param_value(kind: ParamKind) -> Option<Value> {
    match kind {
        ParamKind::Number {
            default, example, ..
        } => default.or(example).map(|v| json!(v)),
        ParamKind::Enum {
            default, example, ..
        } => default.or(example).map(|v| json!(v)),
    }
}

/// Every default stated (pond-ts `explicitOptions`).
fn explicit(d: &StudyDescriptor) -> Map<String, Value> {
    let mut o = minimal(d);
    for input in d.inputs {
        if let Some(def) = input.default {
            o.insert(input.role.into(), json!(def));
        }
    }
    for p in d.params {
        if p.requires.is_some_and(|r| !o.contains_key(r)) {
            continue;
        }
        let default = match p.kind {
            ParamKind::Number { default, .. } => default.map(|v| json!(v)),
            ParamKind::Enum { default, .. } => default.map(|v| json!(v)),
        };
        if let Some(v) = default {
            o.insert(p.name.into(), v);
        }
    }
    let (key, name) = match d.naming {
        StudyNaming::Output(n) => ("output", n),
        StudyNaming::Prefix(n) => ("prefix", n),
    };
    o.insert(key.into(), json!(name));
    o
}

#[test]
fn descriptors_match_pond_ts() {
    let fixture = fixture();
    let want = fixture["studies"].as_array().unwrap();
    let got: Vec<&str> = STUDIES.iter().map(|d| d.name).collect();
    let want_names: Vec<&str> = want.iter().map(|d| d["name"].as_str().unwrap()).collect();
    assert_eq!(got, want_names, "catalog order");
    for (d, want) in STUDIES.iter().zip(want) {
        assert_eq!(d.to_json(), *want, "{}", d.name);
        // Options order (an object compares without it).
        let order: Vec<&str> = want["params"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let mine: Vec<&str> = d.params.iter().map(|p| p.name).collect();
        assert_eq!(mine, order, "{} params order", d.name);
    }
    let families: Vec<&str> = STUDY_FAMILIES.iter().map(|f| f.as_str()).collect();
    assert_eq!(json!(families), fixture["families"]);
}

#[test]
fn lookup_by_name() {
    assert_eq!(
        study_descriptor("atr").unwrap().family.as_str(),
        "volatility"
    );
    assert!(study_descriptor("nope").is_none());
}

#[test]
fn every_study_appends_its_columns_and_uses_its_defaults() {
    let bars = bars(&fixture());
    let before = names(&bars);
    for d in STUDIES {
        let implicit = d
            .run(&bars, &minimal(d))
            .unwrap_or_else(|e| panic!("{}: {e}", d.name));
        let after = names(&implicit);
        assert_eq!(after[..before.len()], before[..], "{}", d.name);
        assert_eq!(after[before.len()..], d.output_names()[..], "{}", d.name);
        let stated = d
            .run(&bars, &explicit(d))
            .unwrap_or_else(|e| panic!("{} explicit: {e}", d.name));
        for name in d.output_names() {
            let (a, b) = (values(&implicit, &name), values(&stated, &name));
            // Bit for bit: `None` and NaN-free, so `==` on Option<f64>.
            assert_eq!(a, b, "{} {name}: stated defaults differ", d.name);
            // Nothing passes on all-gap columns (specialK's warm-up is
            // longer than 120 bars, in pond-ts too).
            let any = a.iter().any(Option::is_some);
            assert_eq!(any, d.name != "specialK", "{} {name}", d.name);
        }
    }
}

#[test]
fn every_menu_value_bound_and_suggestion_runs() {
    let bars = bars(&fixture());
    for d in STUDIES {
        for p in d.params {
            let mut base = minimal(d);
            if let Some(r) = p.requires {
                let dep = d.param(r).unwrap();
                base.insert(r.into(), param_value(dep.kind).unwrap());
            }
            let run = |value: Value| {
                let mut o = base.clone();
                o.insert(p.name.into(), value);
                d.run(&bars, &o)
            };
            match p.kind {
                ParamKind::Enum { of, .. } => {
                    for v in of {
                        run(json!(v)).unwrap_or_else(|e| panic!("{} {}={v}: {e}", d.name, p.name));
                    }
                }
                ParamKind::Number {
                    example,
                    min,
                    max,
                    suggest,
                    ..
                } => {
                    if p.optional {
                        run(json!(example.unwrap())).unwrap();
                    }
                    for v in suggest.into_iter().flat_map(|(lo, hi)| [lo, hi]) {
                        run(json!(v)).unwrap_or_else(|e| {
                            panic!("{} {} at suggest {v}: {e}", d.name, p.name)
                        });
                    }
                    if let Some(m) = min {
                        run(json!(m))
                            .unwrap_or_else(|e| panic!("{} {} at min: {e}", d.name, p.name));
                        assert!(
                            run(json!(m - 1.0)).is_err(),
                            "{} {} below min",
                            d.name,
                            p.name
                        );
                    }
                    if let Some(m) = max {
                        run(json!(m))
                            .unwrap_or_else(|e| panic!("{} {} at max: {e}", d.name, p.name));
                        assert!(
                            run(json!(m + 1.0)).is_err(),
                            "{} {} above max",
                            d.name,
                            p.name
                        );
                    }
                }
            }
        }
    }
}

/// Options an agent could get wrong come back as errors, never a panic.
#[test]
fn bad_options_are_errors() {
    let bars = bars(&fixture());
    for d in STUDIES {
        for p in d.params {
            for v in [
                json!(1.0e15),
                json!(-1),
                json!(2.5),
                json!("x"),
                json!(null),
            ] {
                let mut o = minimal(d);
                o.insert(p.name.into(), v);
                let _ = d.run(&bars, &o);
            }
        }
        for input in d.inputs {
            let mut o = minimal(d);
            o.insert(input.role.into(), json!(3));
            assert!(
                d.run(&bars, &o).is_err(),
                "{} {} as a number",
                d.name,
                input.role
            );
        }
    }
    let sma = study_descriptor("sma").unwrap();
    let err = sma.run(&bars, &Map::new()).unwrap_err().to_string();
    assert!(err.contains("'period' is required"), "{err}");
    let err = sma
        .run(&bars, json!({ "period": 2.5 }).as_object().unwrap())
        .unwrap_err()
        .to_string();
    assert!(err.contains("whole number"), "{err}");
    // `null` is left out, as pond-ts's `??` reads it.
    let rsi = study_descriptor("rsi").unwrap();
    let with_null = rsi
        .run(&bars, json!({ "period": null }).as_object().unwrap())
        .unwrap();
    let without = rsi.run(&bars, &Map::new()).unwrap();
    assert_eq!(values(&with_null, "rsi"), values(&without, "rsi"));
}
