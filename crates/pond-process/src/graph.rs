//! A bound graph (`graph.ts`): one dataset plus every node compiled
//! against it, each node's value kept until the data changes or the byte
//! budget drops it.
//!
//! Differences from `@pond-ts/process`, none of which change an answer:
//! no joins (several sources behind one node), and no ranged recompute
//! (`setSourceFrom` / `runRange`); a data change recomputes whole.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use pond_rs::{ColumnKind, TimeSeries};
use serde_json::Value;

use crate::context::OpContext;
use crate::error::{ErrorKind, ProcessError, Result};
use crate::identity::{is_picked, spec_id, spec_of};
use crate::registry::{Def, Params, Registry};

/// What a computed node holds.
#[derive(Debug, Clone)]
pub(crate) enum Held {
    /// One column per declared output, NaN for a gap.
    Columns(Vec<Arc<Vec<f64>>>),
    /// A fold's fact.
    Fact(Value),
}

/// One input of a compiled node.
#[derive(Debug, Clone)]
struct Bound {
    /// The column name the op reads: a raw column, or the upstream
    /// output's column name.
    column: String,
    /// For a nested input: the upstream id and which of its outputs.
    nested: Option<(String, usize)>,
}

#[derive(Debug, Clone)]
enum State {
    /// Never computed.
    Fresh,
    /// Computed (or failed) against data generation `gen`. A failure is
    /// kept and handed back until the data changes, as a pond node keeps
    /// its error.
    Done {
        generation: u64,
        result: std::result::Result<Arc<Held>, ProcessError>,
    },
}

/// One compiled spec.
#[derive(Debug, Clone)]
pub(crate) struct Compiled {
    pub id: String,
    pub spec: Value,
    pub params: Params,
    pub def: Arc<Def>,
    pub fold: bool,
    bound: Vec<Bound>,
    upstream: Vec<String>,
    dependents: HashSet<String>,
    state: State,
    /// The last value computed successfully; what the byte budget counts.
    kept: Option<Arc<Held>>,
}

/// Where a raw column's numbers live.
#[derive(Debug, Clone)]
enum Raw {
    /// A number column of the bound series, read in place.
    Column(usize),
    /// Converted once from a boolean or other column.
    Converted(Arc<Vec<f64>>),
}

/// One node `prepare` computed: its job index, result and milliseconds.
type Finished = (usize, Result<Arc<Held>>, f64);

/// One input as `compute` reads it.
enum Input {
    Column(usize),
    Held(Arc<Vec<f64>>),
}

/// One dataset and the nodes compiled against it.
#[derive(Debug)]
pub struct BoundGraph {
    pub(crate) registry: Arc<Registry>,
    pub(crate) units: Arc<HashMap<String, String>>,
    budget_bytes: Option<usize>,
    /// Threads `prepare` may use; 1 computes nothing ahead of `pull`.
    threads: usize,
    parallel_min_rows: usize,
    /// The most steps one wave of the last `prepare` held (tests read it).
    pub(crate) widest_wave: usize,
    /// Nodes `prepare` computed in this run, with how long each took, so
    /// the run reports them as computed (not cached) with their own time.
    prepared: HashMap<String, f64>,
    series: Arc<TimeSeries>,
    columns: Vec<String>,
    /// How each raw column is read: a number column in place, anything
    /// else converted once (`numbers_of`).
    raw: HashMap<String, Raw>,
    generation: u64,
    nodes: HashMap<String, Compiled>,
    /// Compile order, for `ids`.
    order: Vec<String>,
    /// Least recently used first.
    lru: Vec<String>,
    evicted: usize,
}

/// A column's cells as numbers: NaN for a gap, 1/0 for true/false, NaN
/// for anything that is not a number (`readNumbers` in `basic-ops.ts`).
fn numbers_of(column: &pond_rs::Column, rows: usize) -> Vec<f64> {
    match column.kind() {
        ColumnKind::Number => column
            .numbers()
            .map(|c| c.values().to_vec())
            .unwrap_or_default(),
        ColumnKind::Boolean => {
            let c = column.booleans().expect("a boolean column");
            (0..rows)
                .map(|i| match c.get(i) {
                    Some(true) => 1.0,
                    Some(false) => 0.0,
                    None => f64::NAN,
                })
                .collect()
        }
        _ => vec![f64::NAN; rows],
    }
}

impl BoundGraph {
    /// Binds `series`. `budget_bytes` caps what node values may hold, LRU.
    pub fn new(
        series: Arc<TimeSeries>,
        registry: Arc<Registry>,
        units: Arc<HashMap<String, String>>,
        budget_bytes: Option<usize>,
    ) -> Self {
        let mut graph = BoundGraph {
            registry,
            units,
            budget_bytes,
            threads: 1,
            parallel_min_rows: 0,
            widest_wave: 0,
            prepared: HashMap::new(),
            series: series.clone(),
            columns: vec![],
            raw: HashMap::new(),
            generation: 0,
            nodes: HashMap::new(),
            order: vec![],
            lru: vec![],
            evicted: 0,
        };
        graph.load(series);
        graph
    }

    fn load(&mut self, series: Arc<TimeSeries>) {
        self.columns = series
            .columns()
            .iter()
            .map(|c| c.name().to_string())
            .collect();
        self.raw = series
            .columns()
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let raw = if c.kind() == ColumnKind::Number {
                    Raw::Column(i)
                } else {
                    Raw::Converted(Arc::new(numbers_of(c, series.len())))
                };
                (c.name().to_string(), raw)
            })
            .collect();
        self.series = series;
    }

    /// Replaces the data. Every node recomputes on its next pull.
    pub fn set_source(&mut self, series: Arc<TimeSeries>) {
        self.load(series);
        self.generation += 1;
    }

    /// The bound data.
    pub fn series(&self) -> &Arc<TimeSeries> {
        &self.series
    }

    /// The value column names.
    pub fn columns(&self) -> &[String] {
        &self.columns
    }

    /// Ids compiled now, in compile order.
    pub fn ids(&self) -> Vec<String> {
        self.order.clone()
    }

    /// How many nodes the budget has dropped.
    pub fn evictions(&self) -> usize {
        self.evicted
    }

    fn touch(&mut self, id: &str) {
        self.lru.retain(|x| x != id);
        self.lru.push(id.to_string());
    }

    /// A compiled node, marking it recently used.
    pub(crate) fn get(&mut self, id: &str) -> Option<&Compiled> {
        if self.nodes.contains_key(id) {
            self.touch(id);
        }
        self.nodes.get(id)
    }

    /// Whether a node will recompute on its next pull.
    pub(crate) fn is_dirty(&self, id: &str) -> bool {
        match self.nodes.get(id).map(|c| &c.state) {
            Some(State::Done { generation, .. }) => *generation != self.generation,
            _ => true,
        }
    }

    fn forget(&mut self, id: &str) {
        let Some(compiled) = self.nodes.remove(id) else {
            return;
        };
        self.order.retain(|x| x != id);
        self.lru.retain(|x| x != id);
        for up in &compiled.upstream {
            if let Some(u) = self.nodes.get_mut(up) {
                u.dependents.remove(id);
            }
        }
    }

    /// Every raw input in the spec's whole closure must be a column.
    fn check_raw_inputs(&self, spec: &Value) -> Result<()> {
        let op_name = spec.get("op").and_then(Value::as_str).unwrap_or_default();
        let def = self.registry.get(op_name)?;
        let inputs = spec
            .get("inputs")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for (i, raw) in inputs.iter().enumerate() {
            let Some(name) = raw.as_str() else {
                self.check_raw_inputs(spec_of(raw))?;
                continue;
            };
            if self.columns.iter().any(|c| c == name) {
                continue;
            }
            let role = def
                .inputs
                .get(i)
                .map_or_else(|| i.to_string(), |d| d.role.clone());
            let have = if self.columns.is_empty() {
                "none".to_string()
            } else {
                self.columns
                    .iter()
                    .map(|c| format!("'{c}'"))
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            return Err(ProcessError::new(
                ErrorKind::UnknownColumn,
                format!(
                    "'{op_name}' names '{name}' for input '{role}', which is not a column of the bound series — columns are {have}"
                ),
            ));
        }
        Ok(())
    }

    /// Compiles a spec and its inputs into nodes, memoized by id. Returns
    /// the id.
    pub(crate) fn compile(&mut self, spec: &Value) -> Result<String> {
        let id = spec_id(&self.registry, spec, true)?;
        if self.nodes.contains_key(&id) {
            // Re-checked when warm too: new data may have dropped a column.
            if let Err(e) = self.check_raw_inputs(spec) {
                self.forget(&id);
                return Err(e);
            }
            self.touch(&id);
            return Ok(id);
        }
        let registry = self.registry.clone();
        let op_name = spec["op"].as_str().unwrap_or_default();
        let def = registry.get(op_name)?.clone();
        let params =
            registry.resolve_params(&def, spec.get("params").and_then(Value::as_object), true)?;
        registry.check_arity(&def, spec.get("inputs"))?;
        self.check_raw_inputs(spec)?;
        let inputs = spec["inputs"].as_array().cloned().unwrap_or_default();

        // Typed inputs: an op may demand a unit its input must carry.
        for (i, input_def) in def.inputs.iter().enumerate() {
            let Some(want) = &input_def.unit else {
                continue;
            };
            let raw = &inputs[i];
            let got = match raw.as_str() {
                Some(name) => self.units.get(name).cloned(),
                None => {
                    let from = spec_of(raw);
                    let up = registry.get(from["op"].as_str().unwrap_or_default())?;
                    let index = if is_picked(raw) {
                        let output = raw
                            .get("output")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        match up.outputs().iter().position(|o| o.id == output) {
                            Some(n) => n,
                            // Named by the binding pass below.
                            None => continue,
                        }
                    } else {
                        0
                    };
                    unit_of(&registry, from, &self.units, index)
                }
            };
            if got.as_deref() != Some(want.as_str()) {
                let name = match raw.as_str() {
                    Some(n) => n.to_string(),
                    None => {
                        let mut n = spec_id(&registry, spec_of(raw), true)?;
                        if is_picked(raw) {
                            n.push('#');
                            n.push_str(&crate::js::js_string(&raw["output"]));
                        }
                        n
                    }
                };
                return Err(ProcessError::new(
                    ErrorKind::Unit,
                    format!(
                        "{op_name} needs a '{want}' input for '{}', but '{name}' is '{}'",
                        input_def.role,
                        got.as_deref().unwrap_or("unitless")
                    ),
                ));
            }
        }

        // Bind each input.
        let mut bound = Vec::with_capacity(inputs.len());
        for (i, raw) in inputs.iter().enumerate() {
            let role = &def.inputs[i].role;
            if let Some(name) = raw.as_str() {
                bound.push(Bound {
                    column: name.to_string(),
                    nested: None,
                });
                continue;
            }
            let from = spec_of(raw);
            let from_op = from["op"].as_str().unwrap_or_default();
            let up_def = registry.get(from_op)?;
            if up_def.is_fold() {
                return Err(ProcessError::new(
                    ErrorKind::Process,
                    format!(
                        "'{from_op}' produces a fact, not a series, so it cannot be the '{role}' input of '{op_name}' — surface it in outputs instead"
                    ),
                ));
            }
            let declared = up_def.outputs();
            let index = if is_picked(raw) {
                let output = crate::js::js_string(&raw["output"]);
                match declared.iter().position(|o| o.id == output) {
                    Some(n) => n,
                    None => {
                        let have = declared
                            .iter()
                            .map(|o| format!("'{}'", o.id))
                            .collect::<Vec<_>>()
                            .join(", ");
                        return Err(ProcessError::new(
                            ErrorKind::Process,
                            format!("'{from_op}' has no output '{output}' (has {have})"),
                        ));
                    }
                }
            } else {
                0
            };
            let up_id = self.compile(from)?;
            bound.push(Bound {
                column: format!("{up_id}{}", declared[index].id),
                nested: Some((up_id, index)),
            });
        }

        let upstream: Vec<String> = bound
            .iter()
            .filter_map(|b| b.nested.as_ref().map(|n| n.0.clone()))
            .collect();
        for up in &upstream {
            if let Some(u) = self.nodes.get_mut(up) {
                u.dependents.insert(id.clone());
            }
        }
        let fold = def.is_fold();
        self.nodes.insert(
            id.clone(),
            Compiled {
                id: id.clone(),
                spec: spec.clone(),
                params,
                def,
                fold,
                bound,
                upstream,
                dependents: HashSet::new(),
                state: State::Fresh,
                kept: None,
            },
        );
        self.order.push(id.clone());
        self.touch(&id);
        Ok(id)
    }

    /// Lets [`BoundGraph::prepare`] compute independent nodes on up to
    /// `threads` threads, once the bound series has at least `min_rows`
    /// rows. Below that, starting the threads costs more than they save.
    pub(crate) fn set_threads(&mut self, threads: usize, min_rows: usize) {
        self.threads = threads.max(1);
        self.parallel_min_rows = min_rows;
    }

    /// How long `prepare` took to compute `id` in this run, if it did.
    pub(crate) fn take_prepared(&mut self, id: &str) -> Option<f64> {
        self.prepared.remove(id)
    }

    /// Computes every stale node `ids` depend on, and `ids` themselves,
    /// ahead of the run's own pulls, independent nodes at the same time on
    /// up to `threads` threads. A node computes only once everything it
    /// reads is ready, and not at all when something it reads failed, as
    /// in [`BoundGraph::pull`]; each node's code is the same and sees the
    /// same inputs, so every answer is the same as on one thread. The
    /// run's pulls then find each node done.
    ///
    /// One thing differs from one thread: under `onError: "throw"` a run
    /// stops at its first failure, and nodes it never reached stay
    /// uncomputed; here they are computed, so a later run reports them as
    /// cached.
    pub(crate) fn prepare(&mut self, ids: &[String]) {
        self.prepared.clear();
        self.widest_wave = 0;
        if self.threads < 2 || self.series.len() < self.parallel_min_rows {
            return;
        }
        // Stale nodes in dependency order, inputs first.
        let mut order: Vec<String> = vec![];
        let mut seen: HashSet<String> = HashSet::new();
        fn visit(g: &BoundGraph, id: &str, seen: &mut HashSet<String>, order: &mut Vec<String>) {
            if !seen.insert(id.to_string()) || !g.is_dirty(id) {
                return;
            }
            let Some(node) = g.nodes.get(id) else { return };
            for b in &node.bound {
                if let Some((up, _)) = &b.nested {
                    visit(g, up, seen, order);
                }
            }
            order.push(id.to_string());
        }
        for id in ids {
            visit(self, id, &mut seen, &mut order);
        }
        // Each node's level: one past the deepest stale input.
        let mut level: HashMap<String, usize> = HashMap::new();
        for id in &order {
            let l = self.nodes[id]
                .bound
                .iter()
                .filter_map(|b| b.nested.as_ref().and_then(|(up, _)| level.get(up)))
                .map(|l| l + 1)
                .max()
                .unwrap_or(0);
            level.insert(id.clone(), l);
        }
        let depth = level.values().max().map_or(0, |l| l + 1);
        for l in 0..depth {
            let wave: Vec<&String> = order.iter().filter(|id| level[*id] == l).collect();
            // Inputs for each node whose upstream all succeeded.
            let mut jobs: Vec<(String, Vec<Input>)> = vec![];
            'nodes: for id in wave {
                let mut inputs = vec![];
                for b in &self.nodes[id].bound {
                    match &b.nested {
                        None => inputs.push(match &self.raw[&b.column] {
                            Raw::Column(i) => Input::Column(*i),
                            Raw::Converted(v) => Input::Held(v.clone()),
                        }),
                        Some((up, index)) => match &self.nodes[up].state {
                            State::Done {
                                generation,
                                result: Ok(held),
                            } if *generation == self.generation => match &**held {
                                Held::Columns(cols) => {
                                    inputs.push(Input::Held(cols[*index].clone()))
                                }
                                Held::Fact(_) => unreachable!("a fold is never an input"),
                            },
                            _ => continue 'nodes,
                        },
                    }
                }
                jobs.push((id.clone(), inputs));
            }
            self.widest_wave = self.widest_wave.max(jobs.len());
            let next = std::sync::atomic::AtomicUsize::new(0);
            let done: std::sync::Mutex<Vec<Finished>> = std::sync::Mutex::new(vec![]);
            let work = || {
                loop {
                    let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let Some((id, inputs)) = jobs.get(i) else {
                        break;
                    };
                    let t0 = std::time::Instant::now();
                    let result = compute(&self.nodes[id], inputs, &self.series).map(Arc::new);
                    let ms = t0.elapsed().as_secs_f64() * 1e3;
                    done.lock()
                        .expect("no worker panicked")
                        .push((i, result, ms));
                }
            };
            if jobs.len() < 2 {
                // One step alone: no thread to start.
                work();
            } else {
                std::thread::scope(|scope| {
                    for _ in 0..self.threads.min(jobs.len()) {
                        scope.spawn(work);
                    }
                });
            }
            let generation = self.generation;
            for (i, result, ms) in done.into_inner().expect("no worker panicked") {
                let id = &jobs[i].0;
                let node = self.nodes.get_mut(id).expect("still compiled");
                if let Ok(held) = &result {
                    node.kept = Some(held.clone());
                }
                node.state = State::Done { generation, result };
                self.prepared.insert(id.clone(), ms);
            }
        }
    }

    /// Brings a node up to date and returns its value, or the error it
    /// (or something upstream of it) failed with.
    pub(crate) fn pull(&mut self, id: &str) -> Result<Arc<Held>> {
        let node = self.nodes.get(id).ok_or_else(|| {
            ProcessError::new(ErrorKind::Process, format!("'{id}' is not in this plan"))
        })?;
        if let State::Done { generation, result } = &node.state
            && *generation == self.generation
        {
            return result.clone();
        }
        let bound = node.bound.clone();
        // Upstream first. A failure there leaves this node as it was.
        let mut inputs: Vec<Input> = Vec::with_capacity(bound.len());
        for b in &bound {
            match &b.nested {
                None => inputs.push(match &self.raw[&b.column] {
                    Raw::Column(i) => Input::Column(*i),
                    Raw::Converted(v) => Input::Held(v.clone()),
                }),
                Some((up, index)) => match &*self.pull(up)? {
                    Held::Columns(cols) => inputs.push(Input::Held(cols[*index].clone())),
                    Held::Fact(_) => unreachable!("a fold is never an input"),
                },
            }
        }
        let node = &self.nodes[id];
        let result = compute(node, &inputs, &self.series).map(Arc::new);
        let generation = self.generation;
        let node = self.nodes.get_mut(id).expect("still compiled");
        if let Ok(held) = &result {
            node.kept = Some(held.clone());
        }
        node.state = State::Done {
            generation,
            result: result.clone(),
        };
        result
    }

    fn bytes_of(&self, compiled: &Compiled) -> usize {
        match compiled.kept.as_deref() {
            Some(Held::Columns(cols)) => cols.iter().map(|c| c.len() * 8).sum(),
            _ => 0,
        }
    }

    /// Bytes held across every node value.
    pub fn retained_bytes(&self) -> usize {
        self.nodes.values().map(|c| self.bytes_of(c)).sum()
    }

    /// Drops least-recently-used nodes until inside the byte budget,
    /// skipping any node another node still reads.
    pub(crate) fn enforce_budget(&mut self) {
        let Some(budget) = self.budget_bytes else {
            return;
        };
        let mut total = self.retained_bytes();
        let mut progress = true;
        while progress && total > budget {
            progress = false;
            for id in self.lru.clone() {
                if total <= budget {
                    break;
                }
                let Some(compiled) = self.nodes.get(&id) else {
                    continue;
                };
                if !compiled.dependents.is_empty() {
                    continue;
                }
                total -= self.bytes_of(compiled);
                self.forget(&id);
                self.evicted += 1;
                progress = true;
            }
        }
    }
}

/// Runs one node's op or fold over its inputs.
fn compute(node: &Compiled, inputs: &[Input], series: &TimeSeries) -> Result<Held> {
    let def = &node.def;
    let roles: Vec<String> = def.inputs.iter().map(|i| i.role.clone()).collect();
    let times = series.key().begin();
    let ctx = OpContext {
        roles: &roles,
        inputs: inputs
            .iter()
            .map(|input| match input {
                Input::Column(i) => series.columns()[*i]
                    .numbers()
                    .expect("a number column")
                    .values(),
                Input::Held(v) => v.as_slice(),
            })
            .collect(),
        params: &node.params,
        id: &node.id,
        times,
        series,
    };
    if node.fold {
        let fold = def
            .fold
            .as_ref()
            .ok_or_else(|| ProcessError::thrown(format!("fold '{}' has no code", def.name)))?;
        return fold(&ctx).map(Held::Fact);
    }
    let run = def
        .run
        .as_ref()
        .ok_or_else(|| ProcessError::thrown(format!("op '{}' has no code", def.name)))?;
    let produced = run(&ctx)?;
    let declared = def.outputs();
    if produced.len() != declared.len() {
        return Err(ProcessError::new(
            ErrorKind::Process,
            format!(
                "op '{}' declares {} output(s) but returned {} for '{}'",
                def.name,
                declared.len(),
                produced.len(),
                node.id
            ),
        ));
    }
    let length = times.len();
    let mut columns = Vec::with_capacity(produced.len());
    for (n, col) in produced.into_iter().enumerate() {
        if col.len() != length {
            let key = if declared[n].id.is_empty() {
                "value"
            } else {
                declared[n].id.as_str()
            };
            return Err(ProcessError::new(
                ErrorKind::Process,
                format!(
                    "op '{}' returned {} row(s) for output '{key}' of '{}', expected {length} — an output must match the bound series length, with warm-up as gaps",
                    def.name,
                    col.len(),
                    node.id
                ),
            ));
        }
        columns.push(Arc::new(col));
    }
    Ok(Held::Columns(columns))
}

/// The unit of output `index` of a spec: declared, or input 0's
/// (`unitOf` in `identity.ts`). `None` is unitless.
pub(crate) fn unit_of(
    registry: &Registry,
    spec: &Value,
    units: &HashMap<String, String>,
    index: usize,
) -> Option<String> {
    let def = registry.get(spec["op"].as_str().unwrap_or_default()).ok()?;
    let declared = match &def.shape {
        crate::registry::Shape::Fold { unit } => unit.clone(),
        crate::registry::Shape::Op { outputs } => outputs
            .get(index)
            .map_or_else(|| "inherit".into(), |o| o.unit.clone()),
    };
    if declared != "inherit" {
        return Some(declared);
    }
    let src = spec.get("inputs")?.as_array()?.first()?;
    if let Some(name) = src.as_str() {
        return units.get(name).cloned();
    }
    let upstream = spec_of(src);
    let index = if is_picked(src) {
        let up = registry
            .get(upstream["op"].as_str().unwrap_or_default())
            .ok()?;
        let output = crate::js::js_string(&src["output"]);
        up.outputs()
            .iter()
            .position(|o| o.id == output)
            .unwrap_or(0)
    } else {
        0
    };
    unit_of(registry, upstream, units, index)
}
