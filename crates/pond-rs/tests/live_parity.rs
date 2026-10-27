//! pond-rs live layer against pond-ts: the committed fixture
//! `packages/core/test/fixtures/live-parity.json` (written by
//! `packages/core/scripts/parity/live.mjs`, kept fresh by
//! `live-parity-fixture.test.ts`; the format is described at the top of
//! `live.mjs`). Each case is a scripted session on one root `LiveSeries`:
//! pushes, operators built at a given point, disposals, and for each step
//! the outputs pond-ts dispatched, in order.
//!
//! [PND-RUST-R3] step 1 adds only the fixture and this loader. The live layer
//! arrives from step 2 on; each step adds the ops it builds to
//! [`SUPPORTED_OPS`] and a branch to [`run_case`], and from then on every
//! case that uses only supported ops must match pond-ts output for output.

mod common;

use common::{ColumnDef, compare_cell, repo_path};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};

const FIXTURE: &str = "packages/core/test/fixtures/live-parity.json";

/// Operators pond-rs's live layer builds so far (none until R3 step 2).
const SUPPORTED_OPS: &[&str] = &[];

/// Every operator the fixture uses, so a new pond-ts case for an op pond-rs
/// has no plan for fails here instead of being skipped quietly.
const KNOWN_OPS: &[&str] = &[
    "filter",
    "map",
    "select",
    "sample",
    "window",
    "diff",
    "rate",
    "pctChange",
    "fill",
    "cumulative",
    "aggregate",
    "rolling",
    "reduce",
    "partitionBy",
    "partition",
    "collect",
    "apply",
];

const KINDS: &[&str] = &["event", "batch", "evict", "bucket", "update"];

/// The output kinds each pond-ts live class emits (its `on(...)` types).
fn kinds_of(class: &str) -> &'static [&'static str] {
    match class {
        "LiveSeries" => &["event", "batch", "evict"],
        "LiveView" => &["event", "evict"],
        "LiveAggregation" => &["event", "bucket", "update"],
        "LiveRollingAggregation" => &["event", "update"],
        "LiveFusedRolling"
        | "LiveReduce"
        | "LivePartitionedFusedRolling"
        | "LivePartitionedSyncRolling" => &["event"],
        "LivePartitionedSeries" | "LivePartitionedView" => &[],
        other => panic!("unknown live class {other}"),
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture {
    meta: Value,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    name: String,
    schema: Vec<ColumnDef>,
    #[serde(default)]
    #[allow(dead_code)] // read by the runner from R3 step 2
    options: Option<Map<String, Value>>,
    /// The root could not be built (then `steps` is empty).
    #[serde(default)]
    error: Option<ErrorJson>,
    steps: Vec<Step>,
    #[serde(default)]
    r#final: Option<BTreeMap<String, Final>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ErrorJson {
    name: String,
    message: String,
}

/// One call on the session. Exactly one of the action fields is set.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Step {
    #[serde(default)]
    push: Option<Vec<Vec<Value>>>,
    #[serde(default)]
    push_many: Option<Vec<Vec<Value>>>,
    #[serde(default)]
    push_json: Option<Vec<Vec<Value>>>,
    #[serde(default)]
    clear: Option<bool>,
    #[serde(default)]
    node: Option<NodeSpec>,
    #[serde(default)]
    dispose: Option<String>,
    outputs: Vec<Output>,
    /// Emitted from a microtask after the call returned (a `reduce` built
    /// over history replays it this way).
    #[serde(default)]
    deferred: Option<Vec<Output>>,
    #[serde(default)]
    error: Option<ErrorJson>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NodeSpec {
    id: String,
    op: String,
    from: String,
    #[allow(dead_code)] // read by the runner from R3 step 2
    args: Vec<Value>,
    /// `false`: pond-ts attached no listeners to this node.
    #[serde(default)]
    watch: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
struct Output {
    node: String,
    kind: String,
    payload: Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Final {
    /// pond-ts class name; fixes the output kinds and state fields.
    class: String,
    #[serde(default)]
    disposed: Option<bool>,
    #[serde(default)]
    schema: Option<Vec<ColumnDef>>,
    #[serde(default)]
    rows: Option<Vec<Vec<Value>>>,
    #[serde(default)]
    stats: Option<Map<String, Value>>,
    #[serde(default)]
    closed: Option<Vec<Vec<Value>>>,
    #[serde(default)]
    snapshot: Option<Vec<Vec<Value>>>,
    #[serde(default)]
    has_open_bucket: Option<bool>,
    #[serde(default)]
    value: Option<Map<String, Value>>,
    #[serde(default)]
    partitions: Option<Vec<(String, Vec<Vec<Value>>)>>,
}

fn load() -> Fixture {
    let path = repo_path(FIXTURE);
    let text = std::fs::read_to_string(&path).expect("live parity fixture");
    serde_json::from_str(&text).expect("live parity fixture parses")
}

impl Step {
    fn action(&self) -> &'static str {
        let set = [
            ("push", self.push.is_some()),
            ("pushMany", self.push_many.is_some()),
            ("pushJson", self.push_json.is_some()),
            ("clear", self.clear.is_some()),
            ("node", self.node.is_some()),
            ("dispose", self.dispose.is_some()),
        ];
        let named: Vec<_> = set.iter().filter(|(_, on)| *on).collect();
        assert_eq!(named.len(), 1, "a step names exactly one action: {self:?}");
        named[0].0
    }

    fn all_outputs(&self) -> impl Iterator<Item = &Output> {
        self.outputs.iter().chain(self.deferred.iter().flatten())
    }
}

/// A cell: null, text, true/false, a number, or a tagged `f64`.
fn check_cell(cell: &Value) -> Result<(), String> {
    match cell {
        Value::Null | Value::String(_) | Value::Bool(_) | Value::Number(_) => Ok(()),
        Value::Object(_) => common::cell_number(cell)
            .map(|_| ())
            .ok_or_else(|| format!("not a cell: {cell}")),
        _ => Err(format!("not a cell: {cell}")),
    }
}

/// An event: `[key, ...cells]`, key a number or `[begin, end]` /
/// `[label, begin, end]`.
fn check_event(event: &Value) -> Result<(), String> {
    let row = event
        .as_array()
        .ok_or(format!("event not a list: {event}"))?;
    let key = row.first().ok_or("empty event")?;
    let key_ok = key.is_number()
        || key
            .as_array()
            .is_some_and(|k| (k.len() == 2 || k.len() == 3) && k[k.len() - 1].is_number());
    if !key_ok {
        return Err(format!("bad key {key}"));
    }
    row[1..].iter().try_for_each(check_cell)
}

fn check_payload(out: &Output) -> Result<(), String> {
    match out.kind.as_str() {
        "event" | "bucket" => check_event(&out.payload),
        "batch" | "evict" => out
            .payload
            .as_array()
            .ok_or("batch / evict carry a list".to_string())?
            .iter()
            .try_for_each(check_event),
        "update" => match &out.payload {
            Value::Null => Ok(()),
            Value::Object(record) => record.values().try_for_each(check_cell),
            other => Err(format!("bad update payload {other}")),
        },
        other => Err(format!("unknown kind {other}")),
    }
}

/// A payload: an event, a list of events, a value record or `null`.
fn compare_payload(expected: &Value, actual: &Value) -> Result<(), String> {
    match (expected, actual) {
        (Value::Object(e), Value::Object(a)) if common::cell_number(expected).is_none() => {
            let (ek, ak): (Vec<_>, Vec<_>) = (e.keys().collect(), a.keys().collect());
            if ek != ak {
                return Err(format!("expected columns {ek:?}, got {ak:?}"));
            }
            e.iter().try_for_each(|(k, v)| {
                compare_cell(v, &a[k], None).map_err(|why| format!("{k}: {why}"))
            })
        }
        _ => compare_cell(expected, actual, None),
    }
}

/// Outputs must agree in count, order, node, kind and payload (cells by
/// bits: `-0` differs from `0`, any NaN matches any NaN).
fn compare_outputs(expected: &[Output], actual: &[Output]) -> Result<(), String> {
    for (i, (e, a)) in expected.iter().zip(actual).enumerate() {
        if e.node != a.node || e.kind != a.kind {
            return Err(format!(
                "output {i}: expected {}/{}, got {}/{}",
                e.node, e.kind, a.node, a.kind
            ));
        }
        compare_payload(&e.payload, &a.payload)
            .map_err(|why| format!("output {i} ({}/{}): {why}", e.node, e.kind))?;
    }
    if expected.len() != actual.len() {
        return Err(format!(
            "expected {} outputs, got {}",
            expected.len(),
            actual.len()
        ));
    }
    Ok(())
}

/// Run one case through pond-rs's live layer and compare every step.
/// Filled in from R3 step 2 on.
fn run_case(case: &Case) -> Result<(), String> {
    Err(format!("{}: no live layer yet", case.name))
}

fn ops_of(case: &Case) -> BTreeSet<&str> {
    case.steps
        .iter()
        .filter_map(|s| s.node.as_ref())
        .map(|n| n.op.as_str())
        .collect()
}

#[test]
fn fixture_is_well_formed() {
    let fixture = load();
    assert!(fixture.meta.is_object());
    assert!(fixture.cases.len() >= 40, "{} cases", fixture.cases.len());
    let mut names = BTreeSet::new();
    let mut actions = BTreeSet::new();
    let mut kinds = BTreeSet::new();
    let mut deferred = 0;
    for case in &fixture.cases {
        assert!(names.insert(case.name.as_str()), "duplicate {}", case.name);
        assert!(case.schema.len() >= 2, "{}: schema", case.name);
        if let Some(err) = &case.error {
            assert!(!err.name.is_empty() && !err.message.is_empty());
            assert!(case.steps.is_empty() && case.r#final.is_none());
            continue;
        }
        let finals = case.r#final.as_ref().expect("final");
        let mut live: BTreeSet<&str> = BTreeSet::from(["root"]);
        let mut unwatched: BTreeSet<&str> = BTreeSet::new();
        for step in &case.steps {
            actions.insert(step.action());
            if let Some(node) = &step.node {
                assert!(KNOWN_OPS.contains(&node.op.as_str()), "op {}", node.op);
                assert!(
                    live.contains(node.from.as_str()),
                    "{}: {} built from unknown {}",
                    case.name,
                    node.id,
                    node.from
                );
                // A node that failed to build never exists.
                if step.error.is_none() {
                    assert!(live.insert(node.id.as_str()), "{}: dup id", case.name);
                    if node.watch == Some(false) {
                        unwatched.insert(node.id.as_str());
                    }
                }
            }
            if let Some(id) = &step.dispose {
                assert!(live.contains(id.as_str()), "{}: dispose {id}", case.name);
            }
            for row in [&step.push, &step.push_many, &step.push_json]
                .into_iter()
                .flatten()
                .flatten()
            {
                row.iter()
                    .skip(1)
                    .try_for_each(check_cell)
                    .unwrap_or_else(|e| panic!("{}: row {e}", case.name));
            }
            deferred += step.deferred.iter().flatten().count();
            for out in step.all_outputs() {
                assert!(KINDS.contains(&out.kind.as_str()));
                kinds.insert(out.kind.as_str());
                assert!(
                    live.contains(out.node.as_str()),
                    "{}: output from unknown node {}",
                    case.name,
                    out.node
                );
                check_payload(out).unwrap_or_else(|e| panic!("{}: {e}", case.name));
            }
        }
        let built: BTreeSet<&str> = finals.keys().map(String::as_str).collect();
        assert_eq!(built, live, "{}: final covers every node", case.name);
        // Each output is a kind its node's class emits; unwatched nodes
        // emit nothing (nothing listened).
        for out in case.steps.iter().flat_map(Step::all_outputs) {
            let class = &finals[&out.node].class;
            assert!(
                kinds_of(class).contains(&out.kind.as_str()),
                "{}: {} ({class}) emitted {}",
                case.name,
                out.node,
                out.kind
            );
            assert!(!unwatched.contains(out.node.as_str()), "{}", case.name);
        }
        for (id, state) in finals {
            let class = state.class.as_str();
            kinds_of(class); // a known class
            if state.disposed == Some(true) {
                continue;
            }
            // The state fields each class records.
            let (rows, buckets, parts) = (
                state.rows.is_some(),
                state.closed.is_some() && state.snapshot.is_some(),
                state.partitions.is_some(),
            );
            let expect = match class {
                "LiveAggregation" => (false, true, false),
                "LivePartitionedSeries" | "LivePartitionedView" => (false, false, true),
                _ => (true, false, false),
            };
            assert_eq!((rows, buckets, parts), expect, "{}: {id} fields", case.name);
            let has_value = matches!(
                class,
                "LiveRollingAggregation" | "LiveFusedRolling" | "LiveReduce"
            );
            assert_eq!(state.value.is_some(), has_value, "{}: {id}", case.name);
            assert_eq!(
                state.stats.is_some(),
                class == "LiveSeries",
                "{}: {id} stats",
                case.name
            );
            assert!(state.schema.is_some(), "{}: {id} schema", case.name);
            let rows = [&state.rows, &state.closed, &state.snapshot];
            for row in rows.into_iter().flatten().flatten() {
                check_event(&Value::Array(row.clone()))
                    .unwrap_or_else(|e| panic!("{}: {id}: {e}", case.name));
            }
            for (_, rows) in state.partitions.iter().flatten() {
                for row in rows {
                    check_event(&Value::Array(row.clone())).unwrap();
                }
            }
            if state.closed.is_some() {
                assert!(state.has_open_bucket.is_some());
            }
            for cell in state.value.iter().flat_map(|v| v.values()) {
                check_cell(cell).unwrap();
            }
        }
    }
    // The fixture exercises every action, output kind and operator, and a
    // reduce replay.
    for action in ["push", "pushMany", "pushJson", "clear", "node", "dispose"] {
        assert!(actions.contains(action), "no {action} step");
    }
    assert_eq!(kinds, KINDS.iter().copied().collect(), "output kinds");
    let used: BTreeSet<&str> = fixture.cases.iter().flat_map(ops_of).collect();
    assert_eq!(used, KNOWN_OPS.iter().copied().collect(), "operators");
    assert!(deferred > 0, "a reduce replay");
    assert!(
        fixture
            .cases
            .iter()
            .flat_map(|c| &c.steps)
            .any(|s| s.node.as_ref().is_some_and(|n| n.watch == Some(false))),
        "an unwatched node"
    );
}

#[test]
fn supported_cases_match_pond_ts() {
    let fixture = load();
    let supported: BTreeSet<&str> = SUPPORTED_OPS.iter().copied().collect();
    let mut ran = 0;
    let mut failures = Vec::new();
    for case in &fixture.cases {
        if !ops_of(case).is_subset(&supported) || SUPPORTED_OPS.is_empty() {
            continue;
        }
        ran += 1;
        if let Err(why) = run_case(case) {
            failures.push(why);
        }
    }
    eprintln!(
        "live parity: {ran} of {} cases run (ops built: {})",
        fixture.cases.len(),
        SUPPORTED_OPS.len()
    );
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn compare_outputs_checks_order_and_bits() {
    let out = |node: &str, kind: &str, payload: Value| Output {
        node: node.into(),
        kind: kind.into(),
        payload,
    };
    let a = out("root", "event", serde_json::json!([0, 1.0]));
    let b = out("f", "event", serde_json::json!([0, 1.0]));
    assert!(compare_outputs(&[a.clone(), b.clone()], &[a.clone(), b.clone()]).is_ok());
    assert!(compare_outputs(&[a.clone(), b.clone()], &[b.clone(), a.clone()]).is_err());
    assert!(compare_outputs(std::slice::from_ref(&a), &[a.clone(), b.clone()]).is_err());
    let rec = |v: Value| out("r", "update", serde_json::json!({ "cpu": v }));
    assert!(compare_outputs(&[rec(1.into())], &[rec(1.0.into())]).is_ok());
    assert!(compare_outputs(&[rec(1.into())], &[rec(2.into())]).is_err());
    let zero = out("root", "event", serde_json::json!([0, 0]));
    let neg = out("root", "event", serde_json::json!([0, {"f64": "-0"}]));
    assert!(compare_outputs(&[zero], &[neg]).is_err());
}
