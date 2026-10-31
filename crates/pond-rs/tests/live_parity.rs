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

/// Operators pond-rs's live layer builds so far.
#[cfg(feature = "live")]
const SUPPORTED_OPS: &[&str] = &[
    "filter",
    "aggregateWith",
    "aggregate",
    "map",
    "select",
    "sample",
    "window",
    "diff",
    "rate",
    "pctChange",
    "fill",
    "cumulative",
    "rolling",
    "reduce",
    "partitionBy",
    "partition",
    "collect",
    "apply",
    "partitionClockRolling",
];

/// Nodes pond-ts builds that pond-rs refuses on purpose, as `(case, node,
/// why)`. pond-rs must refuse them; their outputs and state are not
/// compared.
#[cfg(feature = "live")]
const REFUSED: &[(&str, &str, &str)] = &[
    (
        "aggregate-bad-mapping",
        "b",
        "avg on a text column: pond-ts gives gaps, pond-rs refuses it as batch \
         aggregate does ([PND-KINDREDUCE])",
    ),
    (
        "diff-rate-pct",
        "bad",
        "diff on a text column: pond-ts gives gaps, pond-rs refuses it as batch \
         diff (and batch pond-ts) do",
    ),
];

/// Pushes pond-ts stores in the root and then throws on, which pond-rs
/// refuses whole, as `(case, step, why)`. The root's final rows and counts
/// are compared without them.
#[cfg(feature = "live")]
const PUSH_REFUSED_WHOLE: &[(&str, usize, &str)] = &[(
    "partition-groups",
    6,
    "a value outside the declared groups: pond-ts stores the row in the root, \
     then throws while routing it",
)];

/// Every operator the fixture uses, so a new pond-ts case for an op pond-rs
/// has no plan for fails here instead of being skipped quietly.
const KNOWN_OPS: &[&str] = &[
    "filter",
    "aggregateWith",
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
    // `rolling` on a partitioned series with a clock trigger: one
    // synchronised node over every partition, not a chain per partition.
    "partitionClockRolling",
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
    #[cfg_attr(not(feature = "live"), allow(dead_code))]
    options: Option<Map<String, Value>>,
    /// `false`: pond-ts attached no listeners to the root.
    #[serde(default)]
    watch: Option<bool>,
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
    #[cfg_attr(not(feature = "live"), allow(dead_code))]
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

/// A cell: null, text, true/false, a number, a tagged `f64`, or an array
/// of those (no gaps or nested arrays inside).
fn check_cell(cell: &Value) -> Result<(), String> {
    match cell {
        Value::Null | Value::String(_) | Value::Bool(_) | Value::Number(_) => Ok(()),
        Value::Array(items) => items.iter().try_for_each(|e| match e {
            Value::Null | Value::Array(_) => Err(format!("not an array element: {e}")),
            _ => check_cell(e),
        }),
        Value::Object(_) => common::cell_number(cell)
            .map(|_| ())
            .ok_or_else(|| format!("not a cell: {cell}")),
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
#[cfg(feature = "live")]
fn run_case(case: &Case) -> Result<(), String> {
    runner::run_case(case).map_err(|why| format!("{}: {why}", case.name))
}

fn ops_of(case: &Case) -> BTreeSet<&str> {
    let partitioned = partitioned_ids(case);
    case.steps
        .iter()
        .filter_map(|s| s.node.as_ref())
        .map(|n| {
            if is_partition_clock_rolling(n, &partitioned) {
                "partitionClockRolling"
            } else {
                n.op.as_str()
            }
        })
        .collect()
}

/// Nodes that are partitioned series or per-partition chains on one
/// (pond-ts `LivePartitionedSeries` / `LivePartitionedView`).
fn partitioned_ids(case: &Case) -> BTreeSet<&str> {
    let mut ids = BTreeSet::new();
    for n in case.steps.iter().filter_map(|s| s.node.as_ref()) {
        let chained = ids.contains(n.from.as_str())
            && !matches!(n.op.as_str(), "collect" | "apply" | "partition")
            && !is_partition_clock_rolling(n, &ids);
        if n.op == "partitionBy" || chained {
            ids.insert(n.id.as_str());
        }
    }
    ids
}

/// pond-ts's partitioned `rolling` that builds one synchronised node over
/// every partition: a clock trigger, or the keyed (several windows) form,
/// which needs one.
fn is_partition_clock_rolling(n: &NodeSpec, partitioned: &BTreeSet<&str>) -> bool {
    n.op == "rolling"
        && partitioned.contains(n.from.as_str())
        && (n.args[0].is_object()
            || n.args
                .iter()
                .any(|a| a.get("trigger").is_some_and(|t| t.get("every").is_some())))
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
        if case.watch == Some(false) {
            unwatched.insert("root");
        }
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
                class == "LiveSeries" || class == "LiveAggregation",
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
    assert!(
        fixture.cases.iter().any(|c| c.watch == Some(false)),
        "an unwatched root"
    );
}

#[cfg(feature = "live")]
#[test]
fn supported_cases_match_pond_ts() {
    let fixture = load();
    let supported: BTreeSet<&str> = SUPPORTED_OPS.iter().copied().collect();
    let mut ran = 0;
    let mut failures = Vec::new();
    for case in &fixture.cases {
        if !ops_of(case).is_subset(&supported) {
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

#[cfg(feature = "live")]
mod runner {
    use super::*;
    use pond_rs::PondError;
    use pond_rs::live::{
        CollectOptions, History, LiveAggregation, LiveEvent, LiveOptions, LivePartitioned,
        LivePartitionedRolling, LiveReduce, LiveRolling, LiveSeries, LiveStats, LiveView, Node,
        NodeId, OrderingMode, Output as RsOutput, OutputKind, PartitionOptions, PartitionedView,
        RollingOptions, RollingWindow, SubSeries, Trigger,
    };
    use pond_rs::{
        Agg, ColumnDef as RsColumnDef, ColumnKind, EventKey, Fill, FirstRow, Label, Reducer,
        Sample, Scalar, Sequence, TimeSeries, Value as RsValue,
    };
    use std::collections::HashMap;

    #[derive(Clone, Copy)]
    enum Handle {
        Root,
        View(Node<LiveView>),
        Agg(Node<LiveAggregation>),
        Rolling(Node<LiveRolling>),
        Reduce(Node<LiveReduce>),
        Series(Node<SubSeries>),
        Partitioned(Node<LivePartitioned>),
        PView(Node<PartitionedView>),
        PRolling(Node<LivePartitionedRolling>),
    }

    fn kind_of(name: &str) -> ColumnKind {
        match name {
            "time" => ColumnKind::Time,
            "timeRange" => ColumnKind::TimeRange,
            "interval" => ColumnKind::Interval,
            "number" => ColumnKind::Number,
            "string" => ColumnKind::String,
            "boolean" => ColumnKind::Boolean,
            "array" => ColumnKind::Array,
            other => panic!("unknown kind {other}"),
        }
    }

    fn schema_of(defs: &[ColumnDef]) -> Vec<RsColumnDef> {
        defs.iter()
            .map(|d| RsColumnDef {
                name: d.name.clone(),
                kind: kind_of(&d.kind),
                required: d.required != Some(false),
            })
            .collect()
    }

    fn options_of(map: &Option<Map<String, Value>>) -> LiveOptions {
        let mut o = LiveOptions::new();
        let Some(map) = map else { return o };
        for (k, v) in map {
            match k.as_str() {
                "ordering" => {
                    o = o.ordering(match v.as_str().unwrap() {
                        "strict" => OrderingMode::Strict,
                        "drop" => OrderingMode::Drop,
                        "reorder" => OrderingMode::Reorder,
                        other => panic!("ordering {other}"),
                    })
                }
                "graceWindow" => o = o.grace_window(v.as_str().unwrap()),
                "retention" => {
                    for (rk, rv) in v.as_object().unwrap() {
                        match rk.as_str() {
                            "maxEvents" => o = o.max_events(rv.as_u64().unwrap() as usize),
                            "maxAge" => o = o.max_age(rv.as_str().unwrap()),
                            other => panic!("retention {other}"),
                        }
                    }
                }
                other => panic!("option {other}"),
            }
        }
        o
    }

    /// A row key; `None` for one Rust's key type cannot hold (a NaN time),
    /// which the push then refuses.
    fn key_of(kind: ColumnKind, v: &Value) -> Option<EventKey> {
        let ms = |v: &Value| v.as_i64();
        Some(match kind {
            ColumnKind::Time => EventKey::time(ms(v)?),
            ColumnKind::TimeRange => {
                let a = v.as_array()?;
                EventKey::time_range(ms(&a[0])?, ms(&a[1])?).ok()?
            }
            _ => {
                let a = v.as_array()?;
                let label = match &a[0] {
                    Value::String(s) => Label::String(s.clone()),
                    n => Label::Number(n.as_f64()?),
                };
                EventKey::interval(label, ms(&a[1])?, ms(&a[2])?).ok()?
            }
        })
    }

    fn cell_of(v: &Value) -> Option<RsValue> {
        match v {
            Value::Null => None,
            Value::String(s) => Some(RsValue::String(s.clone())),
            Value::Bool(b) => Some(RsValue::Boolean(*b)),
            Value::Array(items) => Some(RsValue::Array(
                items
                    .iter()
                    .map(|e| match e {
                        Value::String(s) => Scalar::String(s.clone()),
                        Value::Bool(b) => Scalar::Boolean(*b),
                        n => Scalar::Number(common::cell_number(n).unwrap()),
                    })
                    .collect(),
            )),
            n => Some(RsValue::Number(common::cell_number(n).unwrap())),
        }
    }

    type Rows = Vec<(EventKey, Vec<Option<RsValue>>)>;

    fn rows_of(kind: ColumnKind, rows: &[Vec<Value>]) -> Result<Rows, String> {
        rows.iter()
            .map(|r| {
                let key = key_of(kind, &r[0]).ok_or(format!("no Rust key for {}", r[0]))?;
                Ok((key, r[1..].iter().map(cell_of).collect()))
            })
            .collect()
    }

    fn number_json(v: f64) -> Value {
        if v == 0.0 && v.is_sign_negative() {
            serde_json::json!({"f64": "-0"})
        } else if v.is_nan() {
            serde_json::json!({"f64": "NaN"})
        } else if v.is_infinite() {
            serde_json::json!({"f64": if v > 0.0 { "inf" } else { "-inf" }})
        } else {
            serde_json::json!(v)
        }
    }

    fn key_json(key: &EventKey) -> Value {
        match key.kind() {
            "time" => serde_json::json!(key.begin()),
            "timeRange" => serde_json::json!([key.begin(), key.end()]),
            _ => {
                let label = match key.label().unwrap() {
                    Label::Number(v) => serde_json::json!(v),
                    Label::String(s) => serde_json::json!(s),
                };
                serde_json::json!([label, key.begin(), key.end()])
            }
        }
    }

    fn value_json(v: Option<&RsValue>) -> Value {
        match v {
            None => Value::Null,
            Some(RsValue::Number(x)) => number_json(*x),
            Some(RsValue::String(s)) => serde_json::json!(s),
            Some(RsValue::Boolean(b)) => serde_json::json!(b),
            Some(RsValue::Array(items)) => Value::Array(
                items
                    .iter()
                    .map(|e| match e {
                        Scalar::Number(x) => number_json(*x),
                        Scalar::String(s) => serde_json::json!(s),
                        Scalar::Boolean(b) => serde_json::json!(b),
                    })
                    .collect(),
            ),
            Some(other) => panic!("unexpected cell {other:?}"),
        }
    }

    fn event_json(e: &LiveEvent) -> Value {
        let mut row = vec![key_json(e.key())];
        row.extend(e.values().iter().map(|v| value_json(v.as_ref())));
        Value::Array(row)
    }

    /// A batch series' rows, read back through its columns.
    fn series_rows(ts: &TimeSeries) -> Vec<Value> {
        ts.rows()
            .map(|r| {
                let mut row = vec![key_json(&r.key())];
                for col in ts.columns() {
                    let name = col.name();
                    row.push(match col.kind() {
                        ColumnKind::Number => {
                            r.number(name).unwrap().map_or(Value::Null, number_json)
                        }
                        ColumnKind::String => r
                            .string(name)
                            .unwrap()
                            .map_or(Value::Null, |s| serde_json::json!(s)),
                        ColumnKind::Boolean => r
                            .boolean(name)
                            .unwrap()
                            .map_or(Value::Null, |b| serde_json::json!(b)),
                        _ => value_json(
                            r.array(name)
                                .unwrap()
                                .map(|a| RsValue::Array(a.to_vec()))
                                .as_ref(),
                        ),
                    });
                }
                Value::Array(row)
            })
            .collect()
    }

    fn compare_partitions(
        what: &str,
        state: &Final,
        got: &[(String, Vec<Value>)],
    ) -> Result<(), String> {
        let want = state.partitions.as_ref().unwrap();
        let keys = |v: &mut dyn Iterator<Item = &String>| v.cloned().collect::<Vec<_>>();
        let (wk, gk) = (
            keys(&mut want.iter().map(|(k, _)| k)),
            keys(&mut got.iter().map(|(k, _)| k)),
        );
        if wk != gk {
            return Err(format!("{what}: partitions {gk:?}, pond-ts {wk:?}"));
        }
        for ((k, rows), (_, held)) in want.iter().zip(got) {
            compare_rows(&format!("{what}[{k}]"), rows, held)?;
        }
        Ok(())
    }

    fn compare_rows(what: &str, expected: &[Vec<Value>], actual: &[Value]) -> Result<(), String> {
        if expected.len() != actual.len() {
            return Err(format!(
                "{what}: expected {} rows, got {}",
                expected.len(),
                actual.len()
            ));
        }
        for (i, (e, a)) in expected.iter().zip(actual).enumerate() {
            compare_payload(&Value::Array(e.clone()), a)
                .map_err(|w| format!("{what} row {i}: {w}"))?;
        }
        Ok(())
    }

    fn predicate(spec: &Value) -> impl FnMut(&LiveEvent) -> bool + Send + 'static {
        let spec = spec["fn"].clone();
        move |e: &LiveEvent| {
            if let Some(col) = spec.get("missing").and_then(Value::as_str) {
                return e.value(col).unwrap().is_none();
            }
            let col = spec["column"].as_str().unwrap();
            let Some(v) = e.value(col).unwrap() else {
                return false;
            };
            if let Some(gt) = spec.get("gt") {
                return v.as_f64().is_some_and(|x| x > gt.as_f64().unwrap());
            }
            match (v, &spec["eq"]) {
                (RsValue::String(s), Value::String(t)) => s == t,
                (RsValue::Number(x), n) => Some(*x) == n.as_f64(),
                (RsValue::Boolean(b), Value::Bool(c)) => b == c,
                _ => false,
            }
        }
    }

    fn sequence_of(spec: &Value) -> Sequence {
        let seq = &spec["sequence"];
        if let Some(every) = seq.get("every") {
            Sequence::every(every.as_str().unwrap()).unwrap()
        } else {
            let calendar = Sequence::calendar(
                seq["calendar"].as_str().unwrap(),
                seq["timeZone"].as_str().unwrap(),
            )
            .unwrap();
            match seq.get("weekStartsOn").and_then(Value::as_i64) {
                Some(day) => calendar.with_week_start(day as i8).unwrap(),
                None => calendar,
            }
        }
    }

    fn mapping_of(spec: &Value) -> Vec<Agg> {
        spec.as_object()
            .unwrap()
            .iter()
            .map(|(out, v)| match v {
                Value::String(r) => Agg::new(out, out, Reducer::parse(r).unwrap()),
                _ => Agg::new(
                    out,
                    v["from"].as_str().unwrap(),
                    Reducer::parse(v["using"].as_str().unwrap()).unwrap(),
                ),
            })
            .collect()
    }

    /// A column list: one name or a list of names.
    fn names_of(v: &Value) -> Vec<String> {
        match v {
            Value::String(s) => vec![s.clone()],
            v => v
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_str().unwrap().to_string())
                .collect(),
        }
    }

    fn fill_of(v: &Value) -> Fill {
        match v.as_str() {
            Some("hold") => Fill::Hold,
            Some("zero") => Fill::Zero,
            Some("bfill") => Fill::Bfill,
            Some("linear") => Fill::Linear,
            _ => Fill::Value(cell_of(v).unwrap()),
        }
    }

    /// The `map` spec the fixture uses: `column` becomes `v * mul + add`.
    fn mapper(spec: &Value) -> impl FnMut(&LiveEvent) -> Vec<Option<RsValue>> + Send + 'static {
        let spec = spec["map"].clone();
        let column = spec["column"].as_str().unwrap().to_string();
        let (mul, add) = (spec["mul"].as_f64().unwrap(), spec["add"].as_f64().unwrap());
        move |e: &LiveEvent| {
            let at = e.schema()[1..]
                .iter()
                .position(|c| c.name == column)
                .unwrap();
            let mut values = e.values().to_vec();
            if let Some(RsValue::Number(v)) = values[at] {
                values[at] = Some(RsValue::Number(v * mul + add));
            }
            values
        }
    }

    fn refs(v: &[String]) -> Vec<&str> {
        v.iter().map(String::as_str).collect()
    }

    fn build_view(
        live: &mut LiveSeries,
        from: NodeId,
        op: &str,
        args: &[Value],
    ) -> pond_rs::Result<Node<LiveView>> {
        let strs = |v: &Value| names_of(v);
        let first = |o: Option<&Value>| {
            if o.is_some_and(|o| o["drop"] == Value::Bool(true)) {
                FirstRow::Drop
            } else {
                FirstRow::Keep
            }
        };
        match op {
            "filter" if args[0]["fn"].get("expr").is_some() => {
                let e = pond_rs::Expr::from_value(&args[0]["fn"]["expr"]).expect("a tree");
                live.filter_expr(from, &e)
            }
            "filter" => live.filter(from, predicate(&args[0])),
            "map" => live.map(from, mapper(&args[0])),
            "select" => {
                let names: Vec<String> = args.iter().flat_map(strs).collect();
                live.select(from, &refs(&names))
            }
            "sample" => {
                let n = args[0]["stride"].as_i64().unwrap();
                live.sample(from, Sample::Stride(n.max(0) as usize))
            }
            "window" => match &args[0] {
                Value::String(d) => live.window(from, d),
                n => live.window_rows(from, n.as_u64().unwrap() as usize),
            },
            "diff" | "rate" | "pctChange" => {
                let cols = strs(&args[0]);
                let first = first(args.get(1));
                match op {
                    "diff" => live.diff_with(from, &refs(&cols), first),
                    "rate" => live.rate_with(from, &refs(&cols), first),
                    _ => live.pct_change_with(from, &refs(&cols), first),
                }
            }
            "fill" => {
                let limit = args
                    .get(1)
                    .and_then(|o| o.get("limit"))
                    .map(|l| l.as_u64().unwrap() as usize);
                match &args[0] {
                    Value::String(_) => {
                        let fill = fill_of(&args[0]);
                        match limit {
                            Some(l) => live.fill_all_with(from, fill, l),
                            None => live.fill_all(from, fill),
                        }
                    }
                    spec => {
                        let spec: Vec<(String, Fill)> = spec
                            .as_object()
                            .unwrap()
                            .iter()
                            .map(|(k, v)| (k.clone(), fill_of(v)))
                            .collect();
                        let spec: Vec<(&str, Fill)> =
                            spec.iter().map(|(k, f)| (k.as_str(), f.clone())).collect();
                        match limit {
                            Some(l) => live.fill_with(from, &spec, l),
                            None => live.fill(from, &spec),
                        }
                    }
                }
            }
            "cumulative" => {
                let spec: Vec<(&str, Reducer)> = args[0]
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(k, v)| (k.as_str(), Reducer::parse(v.as_str().unwrap()).unwrap()))
                    .collect();
                live.cumulative(from, &spec)
            }
            other => panic!("op {other}"),
        }
    }

    /// A trigger as the fixture writes it (`live.mjs` `decodeTrigger`).
    fn trigger_of(spec: &Value) -> pond_rs::Result<Trigger> {
        if spec == "event" {
            return Ok(Trigger::event());
        }
        if let Some(d) = spec.get("every") {
            return Trigger::every(d.as_str().unwrap());
        }
        if let Some(n) = spec.get("count") {
            return Trigger::count(n.as_u64().unwrap() as usize);
        }
        Trigger::clock(&sequence_of(&spec["clock"]))
    }

    /// Rolling / reduce options: `minSamples`, `trigger`, `history`. A
    /// negative `minSamples` has no Rust form (`usize`); pond-ts refuses it
    /// too, so it is an error here.
    fn rolling_options(spec: Option<&Value>) -> Result<RollingOptions, String> {
        let mut o = RollingOptions::new();
        let Some(spec) = spec else { return Ok(o) };
        for (k, v) in spec.as_object().unwrap() {
            match k.as_str() {
                "minSamples" => {
                    let n = v.as_i64().unwrap();
                    if n < 0 {
                        return Err(format!("minSamples {n}: no usize"));
                    }
                    o = o.min_samples(n as usize);
                }
                "trigger" => o = o.trigger(trigger_of(v).map_err(|e| e.to_string())?),
                "history" => {
                    o = o.history(match v {
                        Value::Bool(true) => History::All,
                        Value::Bool(false) => History::Off,
                        v => History::Limit {
                            max_events: v.get("maxEvents").map(|n| n.as_u64().unwrap() as usize),
                            max_age: v.get("maxAge").map(|d| d.as_str().unwrap().to_string()),
                        },
                    })
                }
                other => panic!("rolling option {other}"),
            }
        }
        Ok(o)
    }

    /// `rolling(window, mapping, options?)`, or the keyed (fused) form
    /// `rolling({ window: mapping | { mapping, minSamples } }, options?)`.
    fn build_rolling(
        live: &mut LiveSeries,
        from: NodeId,
        args: &[Value],
    ) -> Result<Node<LiveRolling>, String> {
        let err = |e: pond_rs::PondError| e.to_string();
        match &args[0] {
            Value::Object(windows) => {
                let options = rolling_options(args.get(1))?;
                let windows: Vec<RollingWindow> = windows
                    .iter()
                    .map(|(w, m)| match m.get("mapping") {
                        Some(inner) if inner.get("from").is_none() => {
                            let mut rw = RollingWindow::new(w, &mapping_of(inner));
                            if let Some(n) = m.get("minSamples") {
                                rw = rw.min_samples(n.as_u64().unwrap() as usize);
                            }
                            rw
                        }
                        _ => RollingWindow::new(w, &mapping_of(m)),
                    })
                    .collect();
                live.rolling_windows(from, &windows, &options).map_err(err)
            }
            Value::String(w) => {
                let options = rolling_options(args.get(2))?;
                live.rolling_with(from, w, &mapping_of(&args[1]), &options)
                    .map_err(err)
            }
            n => {
                let options = rolling_options(args.get(2))?;
                live.rolling_rows(
                    from,
                    n.as_u64().unwrap() as usize,
                    &mapping_of(&args[1]),
                    &options,
                )
                .map_err(err)
            }
        }
    }

    fn build_reduce(
        live: &mut LiveSeries,
        from: NodeId,
        args: &[Value],
    ) -> Result<Node<LiveReduce>, String> {
        let trigger = match args.get(1).and_then(|o| o.get("trigger")) {
            Some(t) => trigger_of(t).map_err(|e| e.to_string())?,
            None => Trigger::event(),
        };
        live.reduce_with(from, &mapping_of(&args[0]), trigger)
            .map_err(|e| e.to_string())
    }

    /// A value record (`{ column: cell }`) in schema order.
    fn record_json(names: &[String], values: &[Option<RsValue>]) -> Value {
        Value::Object(
            names
                .iter()
                .zip(values)
                .map(|(n, v)| (n.clone(), value_json(v.as_ref())))
                .collect(),
        )
    }

    fn kind_name(k: OutputKind) -> &'static str {
        match k {
            OutputKind::Event => "event",
            OutputKind::Batch => "batch",
            OutputKind::Evict => "evict",
            OutputKind::Bucket => "bucket",
            OutputKind::Update => "update",
        }
    }

    fn output_json(
        o: &RsOutput,
        names: &HashMap<NodeId, String>,
        columns: &HashMap<NodeId, Vec<String>>,
    ) -> Output {
        let payload = match o {
            RsOutput::Event { event, .. } | RsOutput::Bucket { event, .. } => event_json(event),
            RsOutput::Batch { events, .. } | RsOutput::Evict { events, .. } => {
                Value::Array(events.iter().map(event_json).collect())
            }
            RsOutput::Update { values: None, .. } => Value::Null,
            RsOutput::Update {
                node,
                values: Some(values),
            } => record_json(&columns[node], values),
        };
        Output {
            node: names[&o.node()].clone(),
            kind: kind_name(o.kind()).into(),
            payload,
        }
    }

    fn watch(live: &mut LiveSeries, id: NodeId, class: &str) -> Result<(), String> {
        for kind in kinds_of(class) {
            let k = match *kind {
                "event" => OutputKind::Event,
                "batch" => OutputKind::Batch,
                "evict" => OutputKind::Evict,
                "bucket" => OutputKind::Bucket,
                _ => OutputKind::Update,
            };
            live.watch(id, k).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn ordering_of(v: &Value) -> OrderingMode {
        match v.as_str().unwrap() {
            "strict" => OrderingMode::Strict,
            "drop" => OrderingMode::Drop,
            "reorder" => OrderingMode::Reorder,
            other => panic!("unknown ordering {other}"),
        }
    }

    /// pond-ts `partitionBy` options. pond-rs's options are a typed
    /// builder, so an unknown option cannot be written; it is refused here,
    /// as pond-ts refuses it.
    fn partition_options(v: Option<&Value>) -> Result<PartitionOptions, String> {
        let mut o = PartitionOptions::new();
        for (k, v) in v.and_then(|v| v.as_object()).into_iter().flatten() {
            match k.as_str() {
                "groups" => o = o.groups(&refs(&names_of(v))),
                "ordering" => o = o.ordering(ordering_of(v)),
                "graceWindow" => o = o.grace_window(v.as_str().unwrap()),
                "retention" => {
                    for (rk, rv) in v.as_object().unwrap() {
                        match rk.as_str() {
                            "maxEvents" => o = o.max_events(rv.as_u64().unwrap() as usize),
                            "maxAge" => o = o.max_age(rv.as_str().unwrap()),
                            other => return Err(format!("unknown retention option {other}")),
                        }
                    }
                }
                other => return Err(format!("unknown option {other}")),
            }
        }
        Ok(o)
    }

    /// pond-ts `collect` / `apply` options.
    fn collect_options(v: Option<&Value>) -> Result<CollectOptions, String> {
        let mut o = CollectOptions::new();
        for (k, v) in v.and_then(|v| v.as_object()).into_iter().flatten() {
            match k.as_str() {
                "name" => o = o.name(v.as_str().unwrap()),
                "ordering" => o = o.ordering(ordering_of(v)),
                "graceWindow" => o = o.grace_window(v.as_str().unwrap()),
                "retention" => {
                    for (rk, rv) in v.as_object().unwrap() {
                        match rk.as_str() {
                            "maxEvents" => o = o.max_events(rv.as_u64().unwrap() as usize),
                            "maxAge" => o = o.max_age(rv.as_str().unwrap()),
                            other => return Err(format!("unknown retention option {other}")),
                        }
                    }
                }
                other => return Err(format!("unknown option {other}")),
            }
        }
        Ok(o)
    }

    /// One step of a chain built on each partition (pond-ts's partitioned
    /// sugar, or a step of an `apply` chain).
    fn build_step(
        live: &mut LiveSeries,
        from: NodeId,
        op: &str,
        args: &[Value],
    ) -> pond_rs::Result<NodeId> {
        let wrap = |message: String| PondError::InvalidData {
            call: "live_parity",
            message,
        };
        match op {
            "rolling" => build_rolling(live, from, args)
                .map(|n| n.id())
                .map_err(wrap),
            "reduce" => build_reduce(live, from, args).map(|n| n.id()).map_err(wrap),
            _ => build_view(live, from, op, args).map(|n| n.id()),
        }
    }

    /// pond-ts's partitioned `rolling` with a clock trigger (or keyed).
    fn build_partition_rolling(
        live: &mut LiveSeries,
        from: NodeId,
        args: &[Value],
    ) -> Result<Node<LivePartitionedRolling>, String> {
        let err = |e: pond_rs::PondError| e.to_string();
        match &args[0] {
            Value::Object(windows) => {
                let options = rolling_options(args.get(1))?;
                let windows: Vec<RollingWindow> = windows
                    .iter()
                    .map(|(w, m)| match m.get("mapping") {
                        Some(inner) if inner.get("from").is_none() => {
                            let mut rw = RollingWindow::new(w, &mapping_of(inner));
                            if let Some(n) = m.get("minSamples") {
                                rw = rw.min_samples(n.as_u64().unwrap() as usize);
                            }
                            rw
                        }
                        _ => RollingWindow::new(w, &mapping_of(m)),
                    })
                    .collect();
                live.partition_rolling_windows(from, &windows, &options)
                    .map_err(err)
            }
            Value::String(w) => {
                let options = rolling_options(args.get(2))?;
                live.partition_rolling(from, w, &mapping_of(&args[1]), &options)
                    .map_err(err)
            }
            n => {
                let options = rolling_options(args.get(2))?;
                live.partition_rolling_rows(
                    from,
                    n.as_u64().unwrap() as usize,
                    &mapping_of(&args[1]),
                    &options,
                )
                .map_err(err)
            }
        }
    }

    /// pond-ts `apply`'s `{ chain: [[op, ...args], ...] }`.
    fn chain_recipe(
        spec: &Value,
    ) -> impl Fn(&mut LiveSeries, NodeId) -> pond_rs::Result<NodeId> + Send + Sync + 'static {
        let steps: Vec<(String, Vec<Value>)> = spec["chain"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| {
                let s = s.as_array().unwrap();
                (s[0].as_str().unwrap().to_string(), s[1..].to_vec())
            })
            .collect();
        move |live: &mut LiveSeries, mut node: NodeId| {
            for (op, args) in &steps {
                node = build_step(live, node, op, args)?;
            }
            Ok(node)
        }
    }

    /// The events a node holds, whatever it is.
    fn held_of(live: &LiveSeries, id: NodeId) -> Result<Vec<Value>, String> {
        if let Ok(n) = live.node::<LiveView>(id) {
            return Ok(live[n].events().map(|e| event_json(&e)).collect());
        }
        if let Ok(n) = live.node::<LiveRolling>(id) {
            return Ok(live[n].events().map(|e| event_json(&e)).collect());
        }
        if let Ok(n) = live.node::<LiveReduce>(id) {
            return Ok(live[n].events().map(|e| event_json(&e)).collect());
        }
        if let Ok(n) = live.node::<SubSeries>(id) {
            return Ok(live[n].events().map(|e| event_json(&e)).collect());
        }
        Err("a chain output pond-rs cannot read".into())
    }

    /// A series' rows (as a batch series and as events) and counters.
    fn compare_series(
        what: &str,
        state: &Final,
        ts: &TimeSeries,
        held: &[Value],
        st: LiveStats,
        refused_rows: &[Value],
    ) -> Result<(), String> {
        // Rows pond-ts stored before it threw, pond-rs refused whole.
        let rows: Vec<Vec<Value>> = state
            .rows
            .as_ref()
            .unwrap()
            .iter()
            .filter(|r| !refused_rows.contains(&Value::Array(r.to_vec())))
            .cloned()
            .collect();
        compare_rows(what, &rows, &series_rows(ts))?;
        compare_rows(what, &rows, held)?;
        let mut got = serde_json::json!({
            "ingested": st.ingested + refused_rows.len() as u64, "evicted": st.evicted,
            "rejected": st.rejected, "length": st.length + refused_rows.len(),
        });
        if let (Some(a), Some(b)) = (st.earliest, st.latest) {
            got["earliestTs"] = a.into();
            got["latestTs"] = b.into();
        }
        let want = Value::Object(state.stats.clone().unwrap());
        if got != want {
            return Err(format!("{what}: stats {got} vs {want}"));
        }
        Ok(())
    }

    pub(super) fn run_case(case: &Case) -> Result<(), String> {
        let schema = schema_of(&case.schema);
        let key_kind = schema[0].kind;
        let built = LiveSeries::with_options(case.name.clone(), schema, options_of(&case.options));
        let mut live = match (built, &case.error) {
            (Err(_), Some(_)) => return Ok(()),
            (Ok(_), Some(e)) => {
                return Err(format!(
                    "pond-ts refused the root ({}), pond-rs built it",
                    e.message
                ));
            }
            (Err(e), None) => return Err(format!("root: {e}")),
            (Ok(live), None) => live,
        };
        let finals = case.r#final.as_ref().unwrap();
        let class = |id: &str| finals[id].class.clone();
        let mut handles: HashMap<String, Handle> = HashMap::from([("root".into(), Handle::Root)]);
        let mut names: HashMap<NodeId, String> = HashMap::from([(live.root(), "root".into())]);
        // Value column names per node, for `update` records.
        let mut columns: HashMap<NodeId, Vec<String>> = HashMap::new();
        let mut refused: BTreeSet<String> = BTreeSet::new();
        let root = live.root();
        if case.watch != Some(false) {
            watch(&mut live, root, &class("root"))?;
        }
        let id_of = |h: Handle, live: &LiveSeries| match h {
            Handle::Root => live.root(),
            Handle::View(n) => n.id(),
            Handle::Agg(n) => n.id(),
            Handle::Rolling(n) => n.id(),
            Handle::Reduce(n) => n.id(),
            Handle::Series(n) => n.id(),
            Handle::Partitioned(n) => n.id(),
            Handle::PView(n) => n.id(),
            Handle::PRolling(n) => n.id(),
        };
        let partitioned_ids = partitioned_ids(case);
        // Rows of a push pond-ts stored in the root before throwing, which
        // pond-rs refused whole.
        let mut refused_rows: Vec<Value> = Vec::new();
        for (s, step) in case.steps.iter().enumerate() {
            let result: Result<Vec<RsOutput>, String> = if let Some(rows) =
                step.push.as_ref().or(step.push_many.as_ref())
            {
                rows_of(key_kind, rows)
                    .and_then(|rows| live.push_many(rows).map_err(|e| e.to_string()))
            } else if let Some(rows) = &step.push_json {
                live.push_json(&serde_json::to_string(rows).unwrap())
                    .map_err(|e| e.to_string())
            } else if step.clear.is_some() {
                Ok(live.clear())
            } else if let Some(id) = &step.dispose {
                let h = handles[id.as_str()];
                live.remove(id_of(h, &live))
                    .map(|_| Vec::new())
                    .map_err(|e| e.to_string())
            } else {
                let spec = step.node.as_ref().unwrap();
                let source = handles[spec.from.as_str()];
                let from = id_of(source, &live);
                let partitioned = matches!(source, Handle::Partitioned(_) | Handle::PView(_));
                let made = match spec.op.as_str() {
                    _ if is_partition_clock_rolling(spec, &partitioned_ids) => {
                        build_partition_rolling(&mut live, from, &spec.args).map(Handle::PRolling)
                    }
                    "partitionBy" => partition_options(spec.args.get(1)).and_then(|o| {
                        live.partition_by(from, spec.args[0].as_str().unwrap(), &o)
                            .map(Handle::Partitioned)
                            .map_err(|e| e.to_string())
                    }),
                    "partition" => {
                        let Handle::Partitioned(p) = source else {
                            return Err(format!("step {s}: partition of a non-partitioned node"));
                        };
                        live[p]
                            .partition(spec.args[0].as_str().unwrap())
                            .map(Handle::Series)
                            .ok_or_else(|| "no such partition".to_string())
                    }
                    "collect" => collect_options(spec.args.first()).and_then(|o| {
                        live.collect(from, &o)
                            .map(Handle::Series)
                            .map_err(|e| e.to_string())
                    }),
                    "apply" => collect_options(spec.args.get(1)).and_then(|o| {
                        live.apply(from, chain_recipe(&spec.args[0]), &o)
                            .map(Handle::Series)
                            .map_err(|e| e.to_string())
                    }),
                    op if partitioned => {
                        let (op, args) = (op.to_string(), spec.args.clone());
                        live.per_partition(from, move |live: &mut LiveSeries, part| {
                            build_step(live, part, &op, &args)
                        })
                        .map(Handle::PView)
                        .map_err(|e| e.to_string())
                    }
                    "aggregate" => live
                        .aggregate(
                            from,
                            &sequence_of(&spec.args[0]),
                            &mapping_of(&spec.args[1]),
                        )
                        .map(Handle::Agg)
                        .map_err(|e| e.to_string()),
                    "aggregateWith" => live
                        .aggregate_with(
                            from,
                            &sequence_of(&spec.args[0]),
                            &mapping_of(&spec.args[1]),
                            spec.args[2]["grace"].as_str(),
                        )
                        .map(Handle::Agg)
                        .map_err(|e| e.to_string()),
                    "rolling" => build_rolling(&mut live, from, &spec.args).map(Handle::Rolling),
                    "reduce" => build_reduce(&mut live, from, &spec.args).map(Handle::Reduce),
                    op => build_view(&mut live, from, op, &spec.args)
                        .map(Handle::View)
                        .map_err(|e| e.to_string()),
                };
                let deviation = REFUSED
                    .iter()
                    .any(|(c, n, _)| *c == case.name && *n == spec.id);
                match made {
                    Err(_) if deviation => {
                        refused.insert(spec.id.clone());
                        Ok(Vec::new())
                    }
                    Ok(_) if deviation => {
                        return Err(format!("step {s}: pond-rs should refuse node {}", spec.id));
                    }
                    Err(e) => Err(e),
                    Ok(h) => {
                        handles.insert(spec.id.clone(), h);
                        let id = id_of(h, &live);
                        names.insert(id, spec.id.clone());
                        let schema = match h {
                            Handle::Rolling(n) => live[n].schema().to_vec(),
                            _ => Vec::new(),
                        };
                        columns.insert(id, schema.iter().skip(1).map(|c| c.name.clone()).collect());
                        if spec.watch != Some(false) {
                            watch(&mut live, id, &class(&spec.id))?;
                        }
                        // A reduce built over history emits for it at the
                        // build, into its events; pond-ts emits the same
                        // event just after (the step's `deferred`).
                        let replayed: Vec<RsOutput> = match h {
                            Handle::Reduce(n) if spec.watch != Some(false) => live[n]
                                .events()
                                .map(|event| RsOutput::Event { node: id, event })
                                .collect(),
                            _ => Vec::new(),
                        };
                        Ok(replayed)
                    }
                }
            };
            if result.is_err()
                && step.error.is_some()
                && PUSH_REFUSED_WHOLE
                    .iter()
                    .any(|(c, k, _)| *c == case.name && *k == s)
            {
                let rows = step.push.as_ref().or(step.push_many.as_ref()).unwrap();
                refused_rows.extend(rows.iter().map(|r| Value::Array(r.clone())));
            }
            match (&result, &step.error) {
                (Err(e), None) => return Err(format!("step {s}: pond-rs failed: {e}")),
                (Ok(_), Some(e)) => {
                    return Err(format!(
                        "step {s}: pond-ts failed ({}), pond-rs did not",
                        e.message
                    ));
                }
                _ => {}
            }
            let actual: Vec<Output> = result
                .unwrap_or_default()
                .iter()
                .map(|o| output_json(o, &names, &columns))
                .collect();
            let expected: Vec<Output> = step
                .all_outputs()
                .filter(|o| !refused.contains(&o.node))
                .cloned()
                .collect();
            compare_outputs(&expected, &actual).map_err(|w| format!("step {s}: {w}"))?;
        }
        for (id, state) in finals {
            if refused.contains(id) {
                continue;
            }
            let h = handles[id.as_str()];
            let what = format!("final {id}");
            if state.disposed == Some(true) {
                let gone = match h {
                    Handle::View(n) => live.get(n).is_err(),
                    Handle::Agg(n) => live.get(n).is_err(),
                    Handle::Rolling(n) => live.get(n).is_err(),
                    Handle::Reduce(n) => live.get(n).is_err(),
                    Handle::PRolling(n) => live.get(n).is_err(),
                    Handle::Root
                    | Handle::Series(_)
                    | Handle::Partitioned(_)
                    | Handle::PView(_) => false,
                };
                if !gone {
                    return Err(format!("{what}: should be removed"));
                }
                continue;
            }
            let schema = match h {
                Handle::Root => live.schema().to_vec(),
                Handle::View(n) => live.get(n).map_err(|e| e.to_string())?.schema().to_vec(),
                Handle::Agg(n) => live.get(n).map_err(|e| e.to_string())?.schema().to_vec(),
                Handle::Rolling(n) => live.get(n).map_err(|e| e.to_string())?.schema().to_vec(),
                Handle::Reduce(n) => live.get(n).map_err(|e| e.to_string())?.schema().to_vec(),
                Handle::Series(n) => live.get(n).map_err(|e| e.to_string())?.schema().to_vec(),
                Handle::Partitioned(n) => live.get(n).map_err(|e| e.to_string())?.schema().to_vec(),
                Handle::PView(n) => live.get(n).map_err(|e| e.to_string())?.schema().to_vec(),
                Handle::PRolling(n) => live.get(n).map_err(|e| e.to_string())?.schema().to_vec(),
            };
            if schema != schema_of(state.schema.as_ref().unwrap()) {
                return Err(format!("{what}: schema {schema:?}"));
            }
            match h {
                Handle::Root => {
                    let ts = live.to_time_series().map_err(|e| e.to_string())?;
                    let held: Vec<Value> = live.events().map(|e| event_json(&e)).collect();
                    compare_series(&what, state, &ts, &held, live.stats(), &refused_rows)?;
                }
                Handle::Series(n) => {
                    let series = &live[n];
                    let ts = series.to_time_series().map_err(|e| e.to_string())?;
                    let held: Vec<Value> = series.events().map(|e| event_json(&e)).collect();
                    compare_series(&what, state, &ts, &held, series.stats(), &[])?;
                }
                Handle::Partitioned(n) => {
                    let got: Vec<(String, Vec<Value>)> = live[n]
                        .partitions()
                        .map(|(k, part)| {
                            (
                                k.to_string(),
                                live[part].events().map(|e| event_json(&e)).collect(),
                            )
                        })
                        .collect();
                    compare_partitions(&what, state, &got)?;
                }
                Handle::PRolling(n) => {
                    let held: Vec<Value> = live[n].events().map(|e| event_json(&e)).collect();
                    compare_rows(&what, state.rows.as_ref().unwrap(), &held)?;
                }
                Handle::PView(n) => {
                    let outputs = live.partition_outputs(n).map_err(|e| e.to_string())?;
                    let mut got = Vec::new();
                    for (k, id) in outputs {
                        got.push((k, held_of(&live, id)?));
                    }
                    compare_partitions(&what, state, &got)?;
                }
                Handle::View(n) => {
                    let view = &live[n];
                    let ts = view.to_time_series().map_err(|e| e.to_string())?;
                    compare_rows(&what, state.rows.as_ref().unwrap(), &series_rows(&ts))?;
                    let held: Vec<Value> = view.events().map(|e| event_json(&e)).collect();
                    compare_rows(&what, state.rows.as_ref().unwrap(), &held)?;
                }
                Handle::Rolling(n) => {
                    let r = &live[n];
                    let held: Vec<Value> = r.events().map(|e| event_json(&e)).collect();
                    compare_rows(&what, state.rows.as_ref().unwrap(), &held)?;
                    let names: Vec<String> =
                        r.schema().iter().skip(1).map(|c| c.name.clone()).collect();
                    let got = record_json(&names, &r.value());
                    compare_payload(&Value::Object(state.value.clone().unwrap()), &got)
                        .map_err(|w| format!("{what} value: {w}"))?;
                }
                Handle::Reduce(n) => {
                    let r = &live[n];
                    let held: Vec<Value> = r.events().map(|e| event_json(&e)).collect();
                    compare_rows(&what, state.rows.as_ref().unwrap(), &held)?;
                    let names: Vec<String> =
                        r.schema().iter().skip(1).map(|c| c.name.clone()).collect();
                    let got = record_json(&names, &r.value());
                    compare_payload(&Value::Object(state.value.clone().unwrap()), &got)
                        .map_err(|w| format!("{what} value: {w}"))?;
                }
                Handle::Agg(n) => {
                    let agg = &live[n];
                    let closed = agg.closed().map_err(|e| e.to_string())?;
                    compare_rows(&what, state.closed.as_ref().unwrap(), &series_rows(&closed))?;
                    let held: Vec<Value> = agg.events().map(event_json).collect();
                    compare_rows(&what, state.closed.as_ref().unwrap(), &held)?;
                    let snap = agg.snapshot().map_err(|e| e.to_string())?;
                    compare_rows(&what, state.snapshot.as_ref().unwrap(), &series_rows(&snap))?;
                    if Some(agg.has_open_bucket()) != state.has_open_bucket {
                        return Err(format!("{what}: has_open_bucket"));
                    }
                    let st = agg.stats();
                    let mut got = serde_json::json!({
                        "eventsObserved": st.events_observed,
                        "bucketsClosed": st.buckets_closed,
                        "openBuckets": st.open_buckets,
                    });
                    if let Some(start) = st.open_bucket_start {
                        got["openBucketStart"] = start.into();
                    }
                    let want = Value::Object(state.stats.clone().unwrap());
                    if got != want {
                        return Err(format!("{what}: stats {got} vs {want}"));
                    }
                }
            }
        }
        Ok(())
    }
}
