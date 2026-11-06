"""pond_rs (Python) against pond-ts for the JSON wire formats, value
series, and the Arrow files pond-ts writes. The same fixture sections and
known differences as the Rust crate's `tests/core_parity.rs`."""

from __future__ import annotations

import json

import pyarrow as pa
import pyarrow.ipc

import pond_rs
from pond_rs import TimeSeries, ValueSeries

from test_core_parity import FIXTURE, REPO, compare_series, decoded, outcome_series, to_series


def same_json(a, b) -> bool:
    """JSON numbers compare by value (1 and 1.0 match), objects by entries."""
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return float(a) == float(b)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(same_json(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(same_json(v, b[k]) for k, v in a.items())
    return a == b


def ordering(options):
    return (options or {}).get("ordering", "strict")


def judge(label, refused, expected, got, failures):
    if refused:
        if not isinstance(got, Exception):
            failures.append(f"{label}: expected pond_rs to refuse it (a known difference)")
        return
    if expected is not None and not isinstance(got, Exception):
        why = compare_series(expected, outcome_series(got)[1], None)
        if why:
            failures.append(f"{label}: {why}")
    elif expected is not None:
        failures.append(f"{label}: pond-ts reads it, pond_rs raised {got}")
    elif not isinstance(got, Exception):
        failures.append(f"{label}: pond-ts throws, pond_rs read it")


def attempt(f):
    try:
        return f()
    except pond_rs.PondError as e:
        return e


def mark_gaps_optional(expected):
    """pond-ts keeps a column with gaps marked required when reading
    columns JSON; pond-rs marks it optional (a known difference)."""
    if expected is None:
        return None
    e = json.loads(json.dumps(expected))
    for c, d in enumerate(e["schema"][1:], start=1):
        if "required" not in d and any(r[c] is None for r in e["rows"]):
            d["required"] = False
    return e


def test_row_json_matches_pond_ts():
    failures = []
    for case in FIXTURE["json"]["toJSON"]:
        s = to_series(FIXTURE["inputs"][case["input"]])
        got = json.loads(s.to_json(case["rowFormat"]))
        if not same_json(case["expected"], got):
            failures.append(f"toJSON {case['input']} ({case['rowFormat']}): expected {case['expected']}, got {got}")
    refused = {"fractionKey", "farKey"}  # pond-rs times are whole ms within range
    for case in FIXTURE["json"]["fromJSON"]:
        o = case.get("options") or {}
        got = attempt(lambda: TimeSeries.from_json(json.dumps(case["payload"]), time_zone=o.get("timeZone"), order=ordering(o)))
        judge(f"fromJSON {case['id']}", case["id"] in refused, case.get("expected"), got, failures)
    assert not failures, "\n".join(failures)


def test_columns_and_points_json_match_pond_ts():
    cases = FIXTURE["columnsJson"]
    failures = []
    for kind, method in (("toColumns", "to_columns_json"), ("toPoints", "to_points_json")):
        for case in cases[kind]:
            s = to_series(FIXTURE["inputs"][case["input"]])
            got = attempt(lambda: json.loads(getattr(s, method)()))
            want = case.get("expected")
            if want is None:
                if not isinstance(got, Exception):
                    failures.append(f"{kind} {case['input']}: pond-ts throws, pond_rs wrote it")
            elif isinstance(got, Exception) or not same_json(want, got):
                failures.append(f"{kind} {case['input']}: expected {want}, got {got}")
    columns_refused = {"numberAsText", "numberAsBool", "textAsNumber", "keyAsText", "keyAsBool", "fractionKey", "farKey", "noName"}
    for case in cases["fromColumns"]:
        got = attempt(lambda: TimeSeries.from_columns_json(json.dumps(case["payload"]), order=ordering(case.get("options"))))
        refused = case["id"] in columns_refused
        judge(f"fromColumns {case['id']}", refused, None if refused else mark_gaps_optional(case.get("expected")), got, failures)
    points_refused = {"fractionTs", "farTs", "tsColumn"}
    for case in cases["fromPoints"]:
        got = attempt(lambda: TimeSeries.from_points_json(json.dumps(case["points"]), "p", case["schema"]))
        judge(f"fromPoints {case['id']}", case["id"] in points_refused, case.get("expected"), got, failures)
    assert not failures, "\n".join(failures)


def value_outcome(v: ValueSeries):
    schema = []
    for i, d in enumerate(v.schema):
        entry = {"name": d["name"], "kind": d["kind"]}
        if i > 0 and not d["required"]:
            entry["required"] = False
        schema.append(entry)
    try:
        table = v.to_pyarrow()
        cols = [table.column(v.axis_name).to_pylist()] + [table.column(c).to_pylist() for c in v.columns]
    except pond_rs.PondError:
        # Arrays mixing kinds cannot be Arrow lists; read the columns.
        cols = [v.axis()] + [v.column(c) for c in v.columns]
    return {"name": v.name, "schema": schema, "rows": [list(r) for r in zip(*cols)] if cols[0] else []}


def test_value_series_match_pond_ts():
    vs = FIXTURE["valueSeries"]
    failures = []
    for case in vs["byValue"]:
        label = f"byValue {case['input']}.{case['axis']}"
        source = FIXTURE["inputs"].get(case["input"]) or vs["sources"][case["input"]]
        got = attempt(lambda: to_series(source).by_value(case["axis"]))
        if case.get("expected") is None:
            if not isinstance(got, Exception):
                failures.append(f"{label}: pond-ts throws, pond_rs succeeded")
            continue
        if isinstance(got, Exception):
            failures.append(f"{label}: pond-ts succeeds, pond_rs raised {got}")
            continue
        why = compare_series(case["expected"], value_outcome(got), None)
        if why:
            failures.append(f"{label}: {why}")
        for wire, text in (("toJSON", got.to_json()), ("toObjects", got.to_json("object")), ("toColumns", got.to_columns_json())):
            if not same_json(case[wire], json.loads(text)):
                failures.append(f"{label} {wire}: expected {case[wire]}, got {text}")
        for probe, want in case["nearest"]:
            have = got.nearest_index(decoded(probe))
            if have != want:
                failures.append(f"{label} nearest({probe}): expected {want}, got {have}")
        for lo, hi, want in case["slices"]:
            why = compare_series(want, value_outcome(got.slice_by_value(decoded(lo), decoded(hi))), None)
            if why:
                failures.append(f"{label} slice({lo}, {hi}): {why}")
    for case in vs["fromJSON"]:
        got = attempt(lambda: ValueSeries.from_json(json.dumps(case["payload"]), order=ordering(case.get("options"))))
        _judge_value(f"ValueSeries.fromJSON {case['id']}", case.get("expected"), got, failures)
    for case in vs["fromColumns"]:
        got = attempt(lambda: ValueSeries.from_columns_json(json.dumps(case["payload"]), order=ordering(case.get("options"))))
        _judge_value(f"ValueSeries.fromColumns {case['id']}", mark_gaps_optional(case.get("expected")), got, failures)
    assert not failures, "\n".join(failures)


def _judge_value(label, expected, got, failures):
    if expected is not None and not isinstance(got, Exception):
        why = compare_series(expected, value_outcome(got), None)
        if why:
            failures.append(f"{label}: {why}")
    elif expected is not None:
        failures.append(f"{label}: pond-ts reads it, pond_rs raised {got}")
    elif not isinstance(got, Exception):
        failures.append(f"{label}: pond-ts throws, pond_rs read it")


def test_value_series_arrow_match_pond_ts():
    """ValueSeries from the Arrow files pond-ts reads, through pyarrow."""
    cases = json.loads((REPO / "packages/core/test/fixtures/parity-value-arrow.json").read_text())
    failures = []
    for case in cases:
        table = pa.ipc.open_file(pa.BufferReader(bytes.fromhex(case["ipc"]))).read_all()
        got = attempt(lambda: ValueSeries.from_arrow(table, case["axis"], name="va"))
        cid = case["id"]
        if cid in ("timestampAxis", "boolValues"):
            # pond-ts reads a timestamp axis as its raw count (pond-rs
            # refuses it) and refuses a bool value field (pond-rs reads it).
            ok = isinstance(got, Exception) if cid == "timestampAxis" else not isinstance(got, Exception)
            if not ok:
                failures.append(f"{cid}: expected the known difference")
            continue
        expected = case.get("expected")
        if expected is not None:
            expected = json.loads(json.dumps(expected))
            for d in expected["schema"][1:]:
                if table.schema.field(d["name"]).nullable:
                    d.setdefault("required", False)
        _judge_value(cid, expected, got, failures)
    assert not failures, "\n".join(failures)


def test_reads_the_pond_ts_arrow_exports():
    for name, file, key, kind in (
        ("noisy", "parity-export.arrow", "time", "time"),
        ("mixed", "parity-export-mixed.arrow", "time", "time"),
        ("ranges", "parity-export-ranges.arrow", "timeRange", "time_range"),
        ("labelled", "parity-export-labelled.arrow", "interval", "interval"),
    ):
        path = REPO / "packages/core/test/fixtures" / file
        s = TimeSeries.read_ipc(path, name=name, key=key, key_kind=kind)
        why = compare_series(FIXTURE["inputs"][name], outcome_series(s)[1], None)
        assert why is None, f"{file}: {why}"
        again = TimeSeries.read_ipc(s.write_ipc(), name=name, key=key, key_kind=kind)
        why = compare_series(FIXTURE["inputs"][name], outcome_series(again)[1], None)
        assert why is None, f"{file} rewritten by pond_rs: {why}"
        # And through pyarrow: the file read by pyarrow, handed over.
        table = pa.ipc.open_file(str(path)).read_all()
        via = TimeSeries(table, name=name, key=key, key_kind=kind)
        why = compare_series(FIXTURE["inputs"][name], outcome_series(via)[1], None)
        assert why is None, f"{file} through pyarrow: {why}"
    exported = REPO / "packages/core/test/fixtures/parity-export-value.arrow"
    table = pa.ipc.open_file(str(exported)).read_all()
    v = ValueSeries.from_arrow(table, "strike", name="vexport")
    why = compare_series(FIXTURE["valueSeries"]["arrowExport"], value_outcome(v), None)
    assert why is None, f"parity-export-value.arrow: {why}"
