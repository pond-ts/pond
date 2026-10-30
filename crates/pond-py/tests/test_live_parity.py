"""pond_rs.LiveSeries (Python) against pond-ts's live layer.

The committed fixture `packages/core/test/fixtures/live-parity.json` (the
same one the Rust `tests/live_parity.rs` reads): each case is a scripted
session on one live series, with pushes, nodes built at given points,
removals, and for each step the outputs pond-ts dispatched, in order. Here
every case runs through the Python API, and every output, every node's
final rows, values and counters must match pond-ts, cell by cell (`-0`
differs from `0`).

The two nodes and one push pond-rs refuses on purpose are the same as in
the Rust test, with the same reasons.
"""

from __future__ import annotations

import json

import pytest
from test_core_parity import REPO, cell_number, compare_cell

from pond_rs import LiveSeries, Sequence

FIXTURE = json.loads((REPO / "packages/core/test/fixtures/live-parity.json").read_text())

# Nodes pond-ts builds that pond-rs refuses on purpose (see the Rust test).
REFUSED = {("aggregate-bad-mapping", "b"), ("diff-rate-pct", "bad")}
# A push pond-ts stores in the root and then throws on; pond-rs refuses it
# whole.
PUSH_REFUSED_WHOLE = {("partition-groups", 6)}

KINDS_OF = {
    "LiveSeries": ["event", "batch", "evict"],
    "LiveView": ["event", "evict"],
    "LiveAggregation": ["event", "bucket", "update"],
    "LiveRollingAggregation": ["event", "update"],
    "LiveFusedRolling": ["event"],
    "LiveReduce": ["event"],
    "LivePartitionedFusedRolling": ["event"],
    "LivePartitionedSyncRolling": ["event"],
    "LivePartitionedSeries": [],
    "LivePartitionedView": [],
}


# ---------------------------------------------------------------------------
# Fixture values to Python, and back
# ---------------------------------------------------------------------------


def py_cell(v):
    if v is None or isinstance(v, (str, bool)):
        return v
    if isinstance(v, list):
        return [py_cell(x) for x in v]
    return cell_number(v)


def py_key(k):
    if isinstance(k, list):
        return tuple(k)
    if isinstance(k, dict):  # a tagged number: NaN time
        return cell_number(k)
    return k


def py_row(row):
    return (py_key(row[0]), [py_cell(c) for c in row[1:]])


def key_json(k):
    return list(k) if isinstance(k, tuple) else k


def event_json(e) -> list:
    return [key_json(e.key), *[e[c] for c in e.keys()]]


def row_json(r) -> list:
    return [key_json(r.key), *r.to_dict().values()]


def output_json(o, names) -> dict:
    if o.kind in ("event", "bucket"):
        payload = event_json(o.event)
    elif o.kind in ("batch", "evict"):
        payload = [event_json(e) for e in o.events]
    else:
        payload = o.values
    return {"node": names[o.node], "kind": o.kind, "payload": payload}


def compare_payload(e, a):
    if isinstance(e, dict) and "f64" not in e:
        if not isinstance(a, dict) or list(e) != list(a):
            return f"expected columns {list(e)}, got {a!r}"
        for k in e:
            why = compare_cell(e[k], a[k], None)
            if why:
                return f"{k}: {why}"
        return None
    if e is None or a is None:
        return None if e is a else f"expected {e!r}, got {a!r}"
    return compare_cell(e, a, None)


def compare_outputs(expected, actual):
    for i, (e, a) in enumerate(zip(expected, actual)):
        if (e["node"], e["kind"]) != (a["node"], a["kind"]):
            return f"output {i}: expected {e['node']}/{e['kind']}, got {a['node']}/{a['kind']}"
        why = compare_payload(e["payload"], a["payload"])
        if why:
            return f"output {i} ({e['node']}/{e['kind']}): {why}"
    if len(expected) != len(actual):
        return f"expected {len(expected)} outputs, got {len(actual)}"
    return None


def compare_rows(what, expected, actual):
    if len(expected) != len(actual):
        return f"{what}: expected {len(expected)} rows, got {len(actual)}"
    for i, (e, a) in enumerate(zip(expected, actual)):
        why = compare_cell(e, a, None)
        if why:
            return f"{what} row {i}: {why}"
    return None


# ---------------------------------------------------------------------------
# Fixture specs to Python calls
# ---------------------------------------------------------------------------


def schema_of(defs):
    return [(d["name"], d["kind"], d.get("required", True)) for d in defs]


def retention(o: dict, kw: dict):
    for k, v in o.items():
        if k == "maxEvents":
            kw["max_events"] = v
        elif k == "maxAge":
            kw["max_age"] = v
        else:
            kw[f"unknown_{k}"] = v  # pond-ts refuses it; so does Python


def options_of(o):
    kw = {}
    for k, v in (o or {}).items():
        if k == "ordering":
            kw["ordering"] = v
        elif k == "graceWindow":
            kw["grace_window"] = v
        elif k == "retention":
            retention(v, kw)
        elif k == "groups":
            kw["groups"] = [v] if isinstance(v, str) else v
        elif k == "name":
            kw["name"] = v
        else:
            kw[f"unknown_{k}"] = v
    return kw


def predicate(spec):
    spec = spec["fn"]
    if "missing" in spec:
        col = spec["missing"]
        return lambda e: e[col] is None
    col = spec["column"]

    def test(e):
        v = e[col]
        if v is None:
            return False
        if "gt" in spec:
            return isinstance(v, float) and v > spec["gt"]
        want = spec["eq"]
        if isinstance(v, bool) or isinstance(want, bool):
            return isinstance(v, bool) and isinstance(want, bool) and v == want
        if isinstance(v, float):
            return not isinstance(want, str) and v == float(want)
        return v == want

    return test


def mapper(spec):
    spec = spec["map"]
    col, mul, add = spec["column"], spec["mul"], spec["add"]

    def f(e):
        v = e[col]
        return {col: v * mul + add} if isinstance(v, float) else {}

    return f


def sequence_of(spec):
    seq = spec["sequence"]
    if "every" in seq:
        return Sequence.every(seq["every"])
    return Sequence.calendar(seq["calendar"], seq["timeZone"], week_starts_on=seq.get("weekStartsOn"))


def trigger_of(spec):
    if spec == "event":
        return "event"
    if "every" in spec:
        return spec["every"]
    if "count" in spec:
        return spec["count"]
    return sequence_of(spec["clock"])


def rolling_kw(o):
    kw = {}
    for k, v in (o or {}).items():
        if k == "minSamples":
            kw["min_samples"] = v
        elif k == "trigger":
            kw["trigger"] = trigger_of(v)
        elif k == "history":
            kw["history"] = v
        else:
            raise AssertionError(f"rolling option {k}")
    return kw


def windows_of(spec):
    out = {}
    for w, m in spec.items():
        inner = m.get("mapping")
        if isinstance(inner, dict) and "from" not in inner:
            out[w] = {"aggs": inner, **({"min_samples": m["minSamples"]} if "minSamples" in m else {})}
        else:
            out[w] = m
    return out


def build(node, op, args):
    """`op` built on `node` (a series, a node, or a partitioned node)."""
    if op == "filter":
        return node.filter(predicate(args[0]))
    if op == "map":
        return node.map(mapper(args[0]))
    if op == "select":
        cols = [c for a in args for c in ([a] if isinstance(a, str) else a)]
        return node.select(*cols)
    if op == "sample":
        return node.sample(max(0, args[0]["stride"]))
    if op == "window":
        return node.window(args[0])
    if op in ("diff", "rate", "pctChange"):
        drop = len(args) > 1 and args[1].get("drop") is True
        method = {"diff": node.diff, "rate": node.rate, "pctChange": node.pct_change}[op]
        return method(args[0], drop_first=drop)
    if op == "fill":
        limit = args[1].get("limit") if len(args) > 1 else None
        strategy = args[0] if isinstance(args[0], str) else {k: py_cell(v) for k, v in args[0].items()}
        return node.fill(strategy, limit=limit)
    if op == "cumulative":
        return node.cumulative(args[0])
    if op == "rolling":
        if isinstance(args[0], dict):
            return node.rolling(windows_of(args[0]), **rolling_kw(args[1] if len(args) > 1 else None))
        return node.rolling(args[0], args[1], **rolling_kw(args[2] if len(args) > 2 else None))
    if op == "reduce":
        o = args[1] if len(args) > 1 else {}
        kw = {"trigger": trigger_of(o["trigger"])} if "trigger" in o else {}
        return node.reduce(args[0], **kw)
    if op == "aggregate":
        return node.aggregate(sequence_of(args[0]), args[1])
    if op == "aggregateWith":
        return node.aggregate(sequence_of(args[0]), args[1], grace=args[2].get("grace"))
    raise AssertionError(f"op {op}")


# ---------------------------------------------------------------------------
# The runner
# ---------------------------------------------------------------------------


def node_rows(node) -> list:
    return [event_json(e) for e in node.events()]


def compare_series(what, state, node, refused_rows):
    rows = [r for r in state["rows"] if r not in refused_rows]
    why = compare_rows(what, rows, [row_json(r) for r in node.to_series()])
    why = why or compare_rows(what, rows, node_rows(node))
    if why:
        return why
    st = node.stats()
    got = {
        "ingested": st["ingested"] + len(refused_rows),
        "evicted": st["evicted"],
        "rejected": st["rejected"],
        "length": st["length"] + len(refused_rows),
    }
    if st["earliest"] is not None:
        got["earliestTs"] = st["earliest"]
        got["latestTs"] = st["latest"]
    if got != state["stats"]:
        return f"{what}: stats {got} vs {state['stats']}"
    return None


def compare_partitions(what, state, got):
    want = state["partitions"]
    if [k for k, _ in want] != list(got):
        return f"{what}: partitions {list(got)}, pond-ts {[k for k, _ in want]}"
    for k, rows in want:
        why = compare_rows(f"{what}[{k}]", rows, node_rows(got[k]))
        if why:
            return why
    return None


def same_schema(defs, schema):
    return [(d["name"], d["kind"], d.get("required", True)) for d in defs] == [
        (c["name"], c["kind"], c["required"]) for c in schema
    ]


def run_case(case):
    try:
        live = LiveSeries(schema_of(case["schema"]), name=case["name"], **options_of(case.get("options")))
    except Exception as e:  # noqa: BLE001 - any refusal
        if case.get("error"):
            return None
        return f"root: {e}"
    if case.get("error"):
        return f"pond-ts refused the root ({case['error']['message']}), pond-rs built it"
    finals = case["final"]
    nodes = {"root": live.root}
    names = {live.root: "root"}
    partitioned = set()
    refused = set()
    refused_rows = []
    if case.get("watch") is not False:
        live.watch(*KINDS_OF[finals["root"]["class"]])
    for s, step in enumerate(case["steps"]):
        outputs = []
        error = None
        try:
            if "push" in step or "pushMany" in step:
                rows = [py_row(r) for r in step.get("push", step.get("pushMany"))]
                if len(rows) == 1 and "push" in step:
                    outputs = live.push(rows[0][0], rows[0][1])
                else:
                    outputs = live.push_many(rows)
            elif "pushJson" in step:
                outputs = live.push_json(json.dumps(step["pushJson"]))
            elif "clear" in step:
                outputs = live.clear()
            elif "dispose" in step:
                nodes[step["dispose"]].remove()
            else:
                spec = step["node"]
                source = nodes[spec["from"]]
                op, args = spec["op"], spec["args"]
                try:
                    if op == "partitionBy":
                        made = live.partition_by(args[0], **options_of(args[1] if len(args) > 1 else None))
                    elif op == "partition":
                        made = source.partition(args[0])
                        assert made is not None, "no such partition"
                    elif op == "collect":
                        made = source.collect(**options_of(args[0] if args else None))
                    elif op == "apply":
                        chain = source
                        for st in args[0]["chain"]:
                            chain = build(chain, st[0], st[1:])
                        made = chain.collect(**options_of(args[1] if len(args) > 1 else None))
                    else:
                        made = build(source, op, args)
                except Exception:
                    if (case["name"], spec["id"]) in REFUSED:
                        refused.add(spec["id"])
                        continue
                    raise
                if (case["name"], spec["id"]) in REFUSED:
                    return f"step {s}: pond-rs should refuse node {spec['id']}"
                nodes[spec["id"]] = made
                names[made] = spec["id"]
                if made.kind in ("partitioned", "partitioned_view"):
                    partitioned.add(spec["id"])
                if spec.get("watch") is not False:
                    made.watch(*KINDS_OF[finals[spec["id"]]["class"]])
                    # A reduce built over history emits at the build, into
                    # its events; pond-ts emits the same event just after.
                    if made.kind == "reduce":
                        outputs = [
                            {"node": spec["id"], "kind": "event", "payload": event_json(e)} for e in made.events()
                        ]
        except Exception as e:  # noqa: BLE001 - compared with pond-ts's error
            error = e
        if error is not None and step.get("error") and (case["name"], s) in PUSH_REFUSED_WHOLE:
            refused_rows += step.get("push", step.get("pushMany"))
        if error is not None and not step.get("error"):
            return f"step {s}: pond-rs failed: {error!r}"
        if error is None and step.get("error"):
            return f"step {s}: pond-ts failed ({step['error']['message']}), pond-rs did not"
        actual = [o if isinstance(o, dict) else output_json(o, names) for o in outputs]
        expected = [o for o in step["outputs"] + step.get("deferred", []) if o["node"] not in refused]
        why = compare_outputs(expected, actual)
        if why:
            return f"step {s}: {why}"
    for nid, state in finals.items():
        if nid in refused:
            continue
        node = nodes[nid]
        what = f"final {nid}"
        if state.get("disposed"):
            if node.kind in ("series", "partitioned", "partitioned_view"):
                continue
            try:
                len(node)
            except Exception:  # noqa: BLE001 - removed
                continue
            return f"{what}: should be removed"
        if not same_schema(state["schema"], node.schema):
            return f"{what}: schema {node.schema}"
        kind = node.kind
        cls = state["class"]
        if kind == "series":
            why = compare_series(what, state, node, refused_rows if nid == "root" else [])
        elif kind == "partitioned" or kind == "partitioned_view":
            why = compare_partitions(what, state, node.partitions())
        elif kind == "partition_rolling":
            why = compare_rows(what, state["rows"], node_rows(node))
        elif kind == "view":
            why = compare_rows(what, state["rows"], [row_json(r) for r in node.to_series()])
            why = why or compare_rows(what, state["rows"], node_rows(node))
        elif kind in ("rolling", "reduce"):
            why = compare_rows(what, state["rows"], node_rows(node))
            why = why or compare_payload(state["value"], node.value())
            why = why and f"{what}: {why}"
        elif kind == "aggregation":
            why = compare_rows(what, state["closed"], [row_json(r) for r in node.to_series()])
            why = why or compare_rows(what, state["closed"], node_rows(node))
            why = why or compare_rows(what, state["snapshot"], [row_json(r) for r in node.snapshot()])
            if not why and node.has_open_bucket != state["hasOpenBucket"]:
                why = f"{what}: has_open_bucket"
            st = node.stats()
            got = {
                "eventsObserved": st["events_observed"],
                "bucketsClosed": st["buckets_closed"],
                "openBuckets": st["open_buckets"],
            }
            if st["open_bucket_start"] is not None:
                got["openBucketStart"] = st["open_bucket_start"]
            if not why and got != state["stats"]:
                why = f"{what}: stats {got} vs {state['stats']}"
        else:
            why = f"{what}: unexpected kind {kind} ({cls})"
        if why:
            return why
    return None


CASES = FIXTURE["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_case_matches_pond_ts(case):
    why = run_case(case)
    assert why is None, f"{case['name']}: {why}"


def test_every_case_runs():
    # No case is skipped: every one the Rust test runs, Python runs.
    assert len(CASES) >= 70
