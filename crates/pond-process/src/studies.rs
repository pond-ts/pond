//! The study catalog as ops: the port of `@pond-ts/financial/process`.
//!
//! Every study in pond-rs's catalog (`pond_rs::financial::catalog`) becomes
//! an op with the same params, input roles, outputs and units as the
//! TypeScript bridge gives it, so a plan naming `sma` or `bollinger` gets
//! the same id, the same `describe()` entry and the same numbers in either
//! language. The rules are the bridge's own:
//!
//! - column inputs become input roles, in the catalog's order;
//! - a param with no default takes its catalog `example` as the default;
//! - an `optional` param is left out, with any param that `requires` it;
//! - output columns are named by the spec id;
//! - on a multi-output study a bare suffix becomes `"value"`;
//! - the studies the bridge cannot express are left out
//!   ([`UNBRIDGED_STUDIES`]), and so are the session studies, which need a
//!   calendar this port does not take yet.

use pond_rs::financial::catalog::{
    ParamKind, STUDIES, StudyAnchor, StudyDescriptor, StudyNaming, StudyOutput,
};
use pond_rs::{Column, TimeSeries};
use serde_json::{Map, json};

use crate::context::OpContext;
use crate::error::ProcessError;
use crate::registry::{Def, ParamDef};

/// Studies the bridge cannot express, and why: the same list, word for
/// word, as `UNBRIDGED_STUDIES` in `@pond-ts/financial/process`.
pub const UNBRIDGED_STUDIES: &[(&str, &str)] = &[
    (
        "anchoredVwap",
        "its anchor is an instant, and a process param can only be a number, a fixed choice or a flag",
    ),
    (
        "swingIndex",
        "its `limit` is the instrument's limit move, which has no honest default and process cannot require",
    ),
    (
        "accumulativeSwingIndex",
        "its `limit` is the instrument's limit move, which has no honest default and process cannot require",
    ),
    (
        "tradeVolumeIndex",
        "its `minTick` is the instrument's tick size, which has no honest default and process cannot require",
    ),
];

fn unbridged(name: &str) -> Option<&'static str> {
    UNBRIDGED_STUDIES
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, why)| *why)
}

fn outlet_id(d: &StudyDescriptor, o: &StudyOutput) -> &'static str {
    if d.outputs.len() > 1 && o.id.is_empty() {
        "value"
    } else {
        o.id
    }
}

fn to_param(kind: &ParamKind) -> ParamDef {
    match *kind {
        ParamKind::Number {
            integer,
            default,
            example,
            min,
            max,
            suggest,
        } => {
            let d = default
                .or(example)
                .expect("a catalog number param has a default or an example");
            let mut p = if integer {
                ParamDef::int(d)
            } else {
                ParamDef::num(d)
            };
            if let Some(v) = min {
                p = p.min(v);
            }
            if let Some(v) = max {
                p = p.max(v);
            }
            if let Some((lo, hi)) = suggest {
                p = p.suggest(lo, hi);
            }
            p
        }
        ParamKind::Enum {
            of,
            default,
            example,
        } => {
            let d = default
                .or(example)
                .expect("a catalog menu param has a default or an example");
            ParamDef::choice(d, of)
        }
    }
}

/// The params the bridge keeps, in the catalog's order.
fn kept_params(d: &StudyDescriptor) -> Vec<(&'static str, ParamDef)> {
    let dropped: Vec<&str> = d
        .params
        .iter()
        .filter(|p| p.optional)
        .map(|p| p.name)
        .collect();
    d.params
        .iter()
        .filter(|p| !dropped.contains(&p.name))
        .filter(|p| p.requires.is_none_or(|r| !dropped.contains(&r)))
        .map(|p| (p.name, to_param(&p.kind)))
        .collect()
}

/// Runs one study on the op's inputs. The inputs become a series whose
/// columns are named by role, so the study is told `"high": "high"`.
fn run_study(
    d: &'static StudyDescriptor,
    keys: &[&'static str],
    ctx: &OpContext,
) -> Result<Vec<Vec<f64>>, ProcessError> {
    let columns = d
        .inputs
        .iter()
        .map(|i| Column::optional_raw(i.role, ctx.input(i.role).to_vec()))
        .collect();
    let series = TimeSeries::new("in", ctx.times.to_vec(), columns)
        .map_err(|e| ProcessError::thrown(e.to_string()))?;
    let mut options = Map::new();
    for key in keys {
        if let Some(v) = ctx.params.get(*key) {
            options.insert((*key).into(), v.clone());
        }
    }
    for i in d.inputs {
        options.insert(i.role.into(), json!(i.role));
    }
    let names: Vec<String> = match d.naming {
        StudyNaming::Output(_) => {
            options.insert("output".into(), json!(ctx.id));
            vec![ctx.id.to_string()]
        }
        StudyNaming::Prefix(_) => {
            options.insert("prefix".into(), json!(ctx.id));
            d.outputs
                .iter()
                .map(|o| format!("{}{}", ctx.id, o.id))
                .collect()
        }
    };
    let out = d
        .run(&series, &options)
        .map_err(|e| ProcessError::thrown(e.to_string()))?;
    names
        .iter()
        .map(|name| {
            let col = out
                .column(name)
                .map_err(|e| ProcessError::thrown(e.to_string()))?;
            let numbers = col
                .numbers()
                .map_err(|e| ProcessError::thrown(e.to_string()))?;
            Ok(numbers.values().to_vec())
        })
        .collect()
}

/// One study as an op. Fails for an unbridged study or a session study.
pub fn study_op(d: &'static StudyDescriptor) -> Result<Def, ProcessError> {
    if let Some(why) = unbridged(d.name) {
        return Err(ProcessError::thrown(format!("{}: {why}", d.name)));
    }
    if d.anchor == Some(StudyAnchor::Session) {
        return Err(ProcessError::thrown(format!(
            "{} needs sessions, which the Rust bridge does not take yet",
            d.name
        )));
    }
    let params = kept_params(d);
    let keys: Vec<&'static str> = params.iter().map(|(k, _)| *k).collect();
    let mut def = Def::op(d.name, d.family.as_str(), d.summary);
    for (key, p) in params {
        def = def.param(key, p);
    }
    for i in d.inputs {
        def = def.input(i.role);
    }
    for o in d.outputs {
        def = def.output(outlet_id(d, o), o.unit.as_str());
    }
    Ok(def.run(move |ctx| run_study(d, &keys, ctx)))
}

/// Every bridgeable study as an op, in catalog order: the same list
/// `studyOps()` gives in TypeScript when no sessions are passed.
pub fn study_ops() -> Vec<Def> {
    STUDIES
        .iter()
        .filter(|d| unbridged(d.name).is_none() && d.anchor != Some(StudyAnchor::Session))
        .map(|d| study_op(d).expect("filtered to bridgeable studies"))
        .collect()
}
