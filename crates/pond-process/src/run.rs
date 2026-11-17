//! `run` (`run.ts`): one request in, one response out. The request names a
//! plan and what to hand back (columns or facts); the response carries
//! them with lineage, every node's timing, and what was skipped and why.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;

use serde_json::{Map, Value, json};

use crate::error::{ErrorKind, ProcessError, Result};
use crate::graph::{BoundGraph, Held, unit_of};
use crate::identity::{explain, spec_id, spec_of};
use crate::slots::expand_slots;

/// What a run hands back.
#[derive(Debug, Clone, Default)]
pub struct RunResult {
    /// The surfaced columns by name, NaN for a gap; `None` when nothing
    /// asked for columns.
    pub columns: Option<Vec<(String, Arc<Vec<f64>>)>>,
    /// Per surfaced node id, its columns with units.
    pub outputs: Map<String, Value>,
    /// One per fold selected.
    pub facts: Vec<Value>,
    /// Lineage text per id.
    pub explain: Map<String, Value>,
    /// What failed, under `collect` or `skip`.
    pub skipped: Vec<Value>,
    /// Every node resolved, in dependency order, with timing.
    pub nodes: Vec<Value>,
}

impl RunResult {
    /// The response as it crosses a wire (`toWire`): no column values,
    /// `hasSeries` saying whether any were asked for.
    pub fn to_wire(&self, name: Option<&str>) -> Value {
        let mut out = Map::new();
        out.insert("outputs".into(), Value::Object(self.outputs.clone()));
        out.insert("facts".into(), Value::Array(self.facts.clone()));
        out.insert("explain".into(), Value::Object(self.explain.clone()));
        out.insert("skipped".into(), Value::Array(self.skipped.clone()));
        out.insert("nodes".into(), Value::Array(self.nodes.clone()));
        if let Some(n) = name {
            out.insert("as".into(), json!(n));
        }
        out.insert("hasSeries".into(), json!(self.columns.is_some()));
        Value::Object(out)
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Policy {
    Throw,
    Skip,
    Collect,
}

/// The `reason` and `code` a failure adds to a skipped entry.
fn describe(e: &ProcessError, mut entry: Map<String, Value>) -> Value {
    entry.insert("reason".into(), json!(e.message));
    if let Some(code) = e.code() {
        entry.insert("code".into(), json!(code));
    }
    Value::Object(entry)
}

/// The id a selector's `on` names: an id string as given, or a spec's id.
fn ref_to_id(graph: &BoundGraph, on: &Value) -> Result<String> {
    match on {
        Value::String(s) => Ok(s.clone()),
        spec => spec_id(&graph.registry, spec, true),
    }
}

struct Normalized {
    plan: Vec<Value>,
    select: Vec<Value>,
    slot_of: HashMap<String, String>,
}

fn normalize(graph: &BoundGraph, request: &Value) -> Result<Normalized> {
    let Some(nodes) = request.get("nodes") else {
        let plan = request
            .get("plan")
            .or_else(|| request.get("process"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let select = request
            .get("select")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        return Ok(Normalized {
            plan,
            select,
            slot_of: HashMap::new(),
        });
    };
    let empty = Map::new();
    let expanded = expand_slots(nodes.as_object().unwrap_or(&empty), graph.columns())?;
    let mut slot_of = HashMap::new();
    for (slot, spec) in &expanded {
        let id = spec_id(&graph.registry, spec, true)?;
        slot_of.entry(id).or_insert_with(|| slot.clone());
    }
    let outputs = request
        .get("outputs")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let select = outputs
        .into_iter()
        .map(|(name, sel)| {
            let mut sel = sel.as_object().cloned().unwrap_or_default();
            if let Some(Value::String(on)) = sel.get("on")
                && let Some((_, spec)) = expanded.iter().find(|(s, _)| s == on)
            {
                sel.insert("on".into(), spec.clone());
            }
            sel.insert("name".into(), json!(name));
            Value::Object(sel)
        })
        .collect();
    Ok(Normalized {
        plan: expanded.into_iter().map(|(_, spec)| spec).collect(),
        select,
        slot_of,
    })
}

/// The spec as a skipped entry echoes it: `op`, `params` and `inputs`, as
/// given, absent keys left out.
fn echo(spec: &Value) -> Value {
    let mut out = Map::new();
    for key in ["op", "params", "inputs"] {
        if let Some(v) = spec.get(key) {
            out.insert(key.into(), v.clone());
        }
    }
    Value::Object(out)
}

struct Run<'g> {
    graph: &'g mut BoundGraph,
    policy: Policy,
    skipped: Vec<Value>,
    explain: Map<String, Value>,
    timings: Vec<Value>,
    timed: HashSet<String>,
    slot_of: HashMap<String, String>,
}

impl Run<'_> {
    fn fail(&mut self, e: ProcessError, entry: Map<String, Value>) -> Result<()> {
        if self.policy == Policy::Throw {
            return Err(e);
        }
        self.skipped.push(describe(&e, entry));
        Ok(())
    }

    fn explain_once(&mut self, id: &str, spec: &Value) -> Result<()> {
        if !self.explain.contains_key(id) {
            let text = explain(&self.graph.registry, spec)?;
            self.explain.insert(id.into(), json!(text));
        }
        Ok(())
    }

    /// The upstream ids (or raw column names) of a node, in input order.
    fn upstream_of(&mut self, spec: &Value, pull: bool) -> Result<Vec<String>> {
        let inputs = spec["inputs"].as_array().cloned().unwrap_or_default();
        let mut out = Vec::with_capacity(inputs.len());
        for input in &inputs {
            if let Some(name) = input.as_str() {
                out.push(name.to_string());
                continue;
            }
            let up = spec_id(&self.graph.registry, spec_of(input), true)?;
            if pull {
                self.warm(&up)?;
            } else {
                self.record(&up)?;
            }
            out.push(up);
        }
        Ok(out)
    }

    fn timing(&self, id: &str, pulled: bool, cached: bool, ms: f64, inputs: Vec<String>) -> Value {
        let mut t = Map::new();
        t.insert("id".into(), json!(id));
        if let Some(slot) = self.slot_of.get(id) {
            t.insert("slot".into(), json!(slot));
        }
        t.insert("pulled".into(), json!(pulled));
        t.insert("cached".into(), json!(cached));
        t.insert("ms".into(), crate::registry::number(ms));
        t.insert("inputs".into(), json!(inputs));
        Value::Object(t)
    }

    /// Pulls a node, its inputs first, recording how long its own compute
    /// took.
    fn warm(&mut self, id: &str) -> Result<()> {
        if !self.timed.insert(id.to_string()) {
            return Ok(());
        }
        let Some(spec) = self.graph.get(id).map(|c| c.spec.clone()) else {
            return Ok(());
        };
        self.explain_once(id, &spec)?;
        let upstream = self.upstream_of(&spec, true)?;
        let was_dirty = self.graph.is_dirty(id);
        let t0 = Instant::now();
        self.graph.pull(id)?;
        let ms = crate::context::js_round(t0.elapsed().as_secs_f64() * 1e6) / 1000.0;
        let t = self.timing(id, true, !was_dirty, ms, upstream);
        self.timings.push(t);
        Ok(())
    }

    /// Records a node nothing pulled, inputs first.
    fn record(&mut self, id: &str) -> Result<()> {
        if !self.timed.insert(id.to_string()) {
            return Ok(());
        }
        let Some(spec) = self.graph.get(id).map(|c| c.spec.clone()) else {
            return Ok(());
        };
        self.explain_once(id, &spec)?;
        let upstream = self.upstream_of(&spec, false)?;
        let cached = !self.graph.is_dirty(id);
        let t = self.timing(id, false, cached, 0.0, upstream);
        self.timings.push(t);
        Ok(())
    }
}

/// Runs a request against a bound graph.
///
/// The request is JSON, either `{ plan | process, select }` (nested specs)
/// or `{ nodes, outputs }` (slots), with `onError`: `"throw"` (the
/// default), `"skip"` or `"collect"`.
pub fn run(graph: &mut BoundGraph, request: &Value) -> Result<RunResult> {
    let policy = match request.get("onError").and_then(Value::as_str) {
        Some("skip") => Policy::Skip,
        Some("collect") => Policy::Collect,
        _ => Policy::Throw,
    };
    let normalized = match normalize(graph, request) {
        Ok(n) => n,
        Err(e) if policy != Policy::Throw => {
            return Ok(RunResult {
                skipped: vec![describe(&e, Map::new())],
                ..RunResult::default()
            });
        }
        Err(e) => return Err(e),
    };
    let mut r = Run {
        graph,
        policy,
        skipped: vec![],
        explain: Map::new(),
        timings: vec![],
        timed: HashSet::new(),
        slot_of: normalized.slot_of,
    };

    // Resolve the plan.
    let mut resolved: Vec<(String, Value)> = vec![];
    for spec in &normalized.plan {
        match r.graph.compile(spec) {
            Ok(id) => resolved.push((id, spec.clone())),
            Err(e) => {
                let mut entry = Map::new();
                entry.insert("spec".into(), echo(spec));
                r.fail(e, entry)?;
            }
        }
    }
    for (id, spec) in &resolved {
        let text = explain(&r.graph.registry, spec)?;
        r.explain.insert(id.clone(), json!(text));
    }

    // What the selection needs.
    let mut needed: Vec<String> = vec![];
    let mut selectors: Vec<(Value, String)> = vec![];
    for sel in &normalized.select {
        let on = sel.get("on").cloned().unwrap_or(Value::Null);
        let resolved_id = (|| -> Result<String> {
            let id = ref_to_id(r.graph, &on)?;
            if !on.is_string() && r.graph.get(&id).is_none() {
                let compiled = r.graph.compile(&on)?;
                resolved.push((compiled, on.clone()));
                let text = explain(&r.graph.registry, &on)?;
                r.explain.insert(id.clone(), json!(text));
            }
            Ok(id)
        })();
        let id = match resolved_id {
            Ok(id) => id,
            Err(e) => {
                let mut entry = Map::new();
                entry.insert("select".into(), sel.clone());
                r.fail(e, entry)?;
                continue;
            }
        };
        selectors.push((sel.clone(), id.clone()));
        let is_fold = r.graph.get(&id).is_some_and(|c| c.fold);
        if !is_fold && !needed.contains(&id) {
            needed.push(id);
        }
    }

    let mut outputs = Map::new();
    let mut drawn: Option<Vec<(String, Arc<Vec<f64>>)>> = None;
    if !needed.is_empty() {
        let mut columns: Vec<(String, Arc<Vec<f64>>)> = vec![];
        for id in &needed {
            let Some((spec, def)) = r.graph.get(id).map(|c| (c.spec.clone(), c.def.clone())) else {
                continue;
            };
            outputs.insert(id.clone(), json!([]));
            let declared = def.outputs().to_vec();
            for (sel, _) in selectors.iter().filter(|(_, sid)| sid == id) {
                let wanted = sel.get("output").map(crate::js::js_string);
                if let Some(w) = &wanted
                    && !declared.iter().any(|o| &o.id == w)
                {
                    let have = declared
                        .iter()
                        .map(|o| format!("'{}'", o.id))
                        .collect::<Vec<_>>()
                        .join(", ");
                    let op = spec["op"].as_str().unwrap_or_default();
                    let e = ProcessError::new(
                        ErrorKind::Process,
                        format!("'{op}' has no output '{w}' (has {have})"),
                    );
                    let mut entry = Map::new();
                    entry.insert("select".into(), sel.clone());
                    r.fail(e, entry)?;
                    continue;
                }
                let pulled = (|| -> Result<()> {
                    for (n, o) in declared.iter().enumerate() {
                        if wanted.as_ref().is_some_and(|w| w != &o.id) {
                            continue;
                        }
                        let name = format!("{id}{}", o.id);
                        if r.graph.get(id).is_none() {
                            return Err(ProcessError::new(
                                ErrorKind::Process,
                                format!("'{id}' is not in this plan"),
                            ));
                        }
                        r.warm(id)?;
                        let col = match &*r.graph.pull(id)? {
                            Held::Columns(cols) => cols[n].clone(),
                            Held::Fact(_) => unreachable!("a column node"),
                        };
                        if !columns.iter().any(|(c, _)| *c == name) {
                            columns.push((name.clone(), col));
                        }
                        let unit = unit_of(&r.graph.registry, &spec, &r.graph.units, n);
                        let mut info = Map::new();
                        info.insert("column".into(), json!(name));
                        info.insert("unit".into(), json!(unit));
                        if let Some(n) = sel.get("name") {
                            info.insert("name".into(), n.clone());
                        }
                        if let Some(Value::Array(list)) = outputs.get_mut(id) {
                            list.push(Value::Object(info));
                        }
                    }
                    Ok(())
                })();
                if let Err(e) = pulled {
                    let mut entry = Map::new();
                    entry.insert("select".into(), sel.clone());
                    r.fail(e, entry)?;
                }
            }
        }
        drawn = Some(columns);
    }

    // Facts, pulled from fold nodes like any other value.
    let mut facts = vec![];
    for (sel, id) in &selectors {
        let Some((spec, fold)) = r.graph.get(id).map(|c| (c.spec.clone(), c.fold)) else {
            let e = ProcessError::new(ErrorKind::Process, format!("'{id}' is not in this plan"));
            let mut entry = Map::new();
            entry.insert("select".into(), sel.clone());
            r.fail(e, entry)?;
            continue;
        };
        if !fold {
            continue;
        }
        let fact = (|| -> Result<Value> {
            r.warm(id)?;
            let mut body = match &*r.graph.pull(id)? {
                Held::Fact(Value::Object(m)) => m.clone(),
                _ => Map::new(),
            };
            for key in ["id", "name", "op", "unit"] {
                body.shift_remove(key);
            }
            body.insert("id".into(), json!(id));
            if let Some(n) = sel.get("name") {
                body.insert("name".into(), n.clone());
            }
            body.insert("op".into(), spec["op"].clone());
            body.insert(
                "unit".into(),
                json!(unit_of(&r.graph.registry, &spec, &r.graph.units, 0)),
            );
            Ok(Value::Object(body))
        })();
        match fact {
            Ok(f) => facts.push(f),
            Err(e) => {
                let mut entry = Map::new();
                entry.insert("select".into(), sel.clone());
                r.fail(e, entry)?;
            }
        }
    }

    for (id, _) in &resolved {
        r.record(id)?;
    }
    r.graph.enforce_budget();

    Ok(RunResult {
        columns: drawn,
        outputs,
        facts,
        explain: r.explain,
        skipped: r.skipped,
        nodes: r.timings,
    })
}
