"""pond_rs (Python) against pond-ts's own output for the core operations.

The same fixture the Rust crate's `tests/core_parity.rs` reads:
`packages/core/test/fixtures/parity.json`, written by pond-ts. Every case
builds its input series from a pyarrow table (the door Python users come
in by), runs the operation through the Python API with keyword options,
reads the result back out as a pyarrow table, and compares it cell by cell
with what pond-ts gave. A pond-ts error must be an error here too.

The known differences between pond-rs and pond-ts are the Rust harness's,
listed in the same place and checked the same way.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pyarrow as pa
import pytest

import pond_rs
from pond_rs import TimeSeries

REPO = Path(__file__).resolve().parents[3]
FIXTURE = json.loads((REPO / "packages/core/test/fixtures/parity.json").read_text())


# ---------------------------------------------------------------------------
# Fixture values
# ---------------------------------------------------------------------------


def num(v):
    """A fixture number, with the tags for -0 / NaN / infinities."""
    if isinstance(v, dict) and "f64" in v:
        return {"-0": -0.0, "NaN": math.nan, "inf": math.inf, "-inf": -math.inf}[v["f64"]]
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise TypeError(f"a number, got {v!r}")
    return float(v)


def cell_number(v):
    """A cell as a number, or None for anything else (null, text, …)."""
    if isinstance(v, dict) and "f64" in v:
        return num(v)
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    return None


def element(v):
    """One array element."""
    if isinstance(v, (str, bool)):
        return v
    return num(v)


def decoded(v):
    """A fixture cell as a Python value (arrays element by element)."""
    if v is None:
        return None
    if isinstance(v, list):
        return [element(e) for e in v]
    if isinstance(v, (str, bool)):
        return v
    return num(v)


def arrow_type(kind, cells):
    if kind == "number":
        return pa.float64()
    if kind == "string":
        return pa.string()
    if kind == "boolean":
        return pa.bool_()
    elements = [e for c in cells if c is not None for e in c]
    if all(isinstance(e, bool) for e in elements) and elements:
        return pa.list_(pa.bool_())
    if all(isinstance(e, str) for e in elements) and elements:
        return pa.list_(pa.string())
    if all(isinstance(e, float) for e in elements):
        return pa.list_(pa.float64())
    return None  # mixed kinds: Arrow lists hold one


def to_series(json_series) -> TimeSeries:
    """A fixture input series, built from a pyarrow table (or, where its
    arrays mix kinds, which an Arrow list cannot hold, from a dict)."""
    schema = json_series["schema"]
    rows = json_series["rows"]
    key = schema[0]
    kind = key["kind"]
    assert kind in ("time", "timeRange", "interval")
    stamp = pa.timestamp("ms", tz="UTC")
    fields, arrays = [], []
    name = key["name"]
    if kind == "time":
        fields.append(pa.field(name, stamp, nullable=False))
        arrays.append(pa.array([r[0] for r in rows], pa.int64()).cast(stamp))
    else:
        offset = 0 if kind == "timeRange" else 1
        for p, suffix in ((offset, ""), (offset + 1, "End")):
            fields.append(pa.field(name + suffix, stamp, nullable=False))
            arrays.append(pa.array([r[0][p] for r in rows], pa.int64()).cast(stamp))
    mixed = False
    for c, d in enumerate(schema[1:], start=1):
        cells = [decoded(r[c]) for r in rows]
        t = arrow_type(d["kind"], cells)
        if t is None:
            mixed = True
            break
        required = d.get("required", True)
        fields.append(pa.field(d["name"], t, nullable=not required))
        arrays.append(pa.array(cells, t))
    if kind == "interval":
        labels = [r[0][0] for r in rows]
        if labels and all(isinstance(l, str) for l in labels):
            t = pa.string()
        else:
            labels = [num(l) for l in labels]
            t = pa.float64()
        fields.append(pa.field(name + "Label", t, nullable=False))
        arrays.append(pa.array(labels, t))
    key_kind = {"time": "time", "timeRange": "time_range", "interval": "interval"}[kind]
    if not mixed:
        table = pa.Table.from_arrays(arrays, schema=pa.schema(fields))
        return TimeSeries(table, name=json_series["name"], key=name, key_kind=key_kind)
    data = {}
    if kind == "time":
        data[name] = [r[0] for r in rows]
    elif kind == "timeRange":
        data[name] = [tuple(r[0]) for r in rows]
    else:
        data[name] = [(r[0][0] if isinstance(r[0][0], str) else num(r[0][0]), r[0][1], r[0][2]) for r in rows]
    for c, d in enumerate(schema[1:], start=1):
        data[d["name"]] = [decoded(r[c]) for r in rows]
    s = TimeSeries(data, name=json_series["name"], key=name, key_kind=key_kind)
    # A dict column is required when it has no gaps; match the schema.
    assert [x["required"] for x in s.schema[1:]] == [
        d.get("required", True) for d in schema[1:]
    ], f"{json_series['name']}: dict input cannot carry its schema's required flags"
    return s


INPUTS: dict[str, TimeSeries] = {}


def series(name) -> TimeSeries:
    if name not in INPUTS:
        INPUTS[name] = to_series(FIXTURE["inputs"][name])
    return INPUTS[name]


# ---------------------------------------------------------------------------
# Results, as comparable Python values
# ---------------------------------------------------------------------------


def outcome_series(s: TimeSeries):
    """A series as `{"name", "schema", "rows"}`, read through to_pyarrow
    (pond_rs's Arrow output) where Arrow can hold its columns."""
    schema = []
    for d in s.schema:
        entry = {"name": d["name"], "kind": d["kind"]}
        if d["kind"] not in ("time", "timeRange", "interval") and not d["required"]:
            entry["required"] = False
        schema.append(entry)
    n = len(s)
    try:
        table = s.to_pyarrow()
    except pond_rs.PondError:
        # Arrays mixing kinds cannot be Arrow lists; read the columns.
        table = None
    key = s.key_name

    def ints(col):
        return table.column(col).cast(pa.int64()).to_pylist()

    if table is not None:
        cols = [table.column(c).to_pylist() for c in s.columns]
        if s.key_kind == "time":
            keys = ints(key)
        elif s.key_kind == "time_range":
            keys = [list(p) for p in zip(ints(key), ints(key + "End"))]
        else:
            labels = table.column(key + "Label").to_pylist()
            keys = [[l, b, e] for l, b, e in zip(labels, ints(key), ints(key + "End"))]
    else:
        cols = [s.column(c) for c in s.columns]
        keys = []
        for row in s:
            k = row.key
            keys.append(list(k) if isinstance(k, tuple) else k)
    rows = [[keys[i]] + [c[i] for c in cols] for i in range(n)]
    return ("series", {"name": s.name, "schema": schema, "rows": rows})


def js_number(v: float) -> str:
    assert v == 0 or 1e-6 <= abs(v) < 1e21, f"no JavaScript exponent form here: {v}"
    if v == math.trunc(v):
        return str(int(v))
    return repr(v)


def partition_key(key, missing: str) -> str:
    """A partition key as pond-ts writes it: `String(value)` for one column
    (`missing` for a gap), `JSON.stringify` of the values for several."""

    def text(v):
        if isinstance(v, bool):
            return "true" if v else "false"
        if isinstance(v, float):
            return js_number(v)
        return str(v)

    if not isinstance(key, tuple):
        return missing if key is None else text(key)
    parts = []
    for v in key:
        if v is None:
            parts.append("null")
        elif isinstance(v, str):
            parts.append(json.dumps(v, ensure_ascii=False))
        else:
            parts.append(text(v))
    return "[" + ",".join(parts) + "]"


def groups_outcome(d, missing):
    return ("groups", [(partition_key(k, missing), outcome_series(s)[1]) for k, s in d.items()])


# ---------------------------------------------------------------------------
# Comparison (the Rust harness's rules)
# ---------------------------------------------------------------------------


def same_number(e: float, a: float, tolerance) -> bool:
    if e == 0 and a == 0 and math.copysign(1, e) != math.copysign(1, a):
        return False
    if tolerance is not None and math.isfinite(e) and math.isfinite(a):
        return abs(e - a) <= tolerance
    if math.isnan(e) and math.isnan(a):
        return True
    return e == a


def compare_cell(e, a, tolerance):
    en, an = cell_number(e), (None if isinstance(a, bool) else a if isinstance(a, float) else (float(a) if isinstance(a, int) else None))
    if en is not None and an is not None:
        if not same_number(en, an, tolerance):
            return f"expected {e!r}, got {a!r}"
        return None
    if isinstance(e, list) and isinstance(a, list):
        if len(e) != len(a):
            return f"expected {e!r}, got {a!r}"
        for x, y in zip(e, a):
            why = compare_cell(x, y, tolerance)
            if why:
                return f"in {a!r}: {why}"
        return None
    if e == a and type(e) is type(a):
        return None
    if e == a and not isinstance(e, bool) and not isinstance(a, bool):
        return None
    return f"expected {e!r}, got {a!r}"


def same_key(e, a) -> bool:
    if isinstance(e, list) and isinstance(a, list):
        return len(e) == len(a) and all(same_key(x, y) for x, y in zip(e, a))
    en = cell_number(e)
    an = cell_number(a)
    if en is not None and an is not None:
        return en == an and (en != 0 or math.copysign(1, en) == math.copysign(1, an))
    return e == a


def compare_series(e, a, tolerance):
    if e["name"] != a["name"]:
        return f"series name differs: expected {e['name']!r}, got {a['name']!r}"
    norm = [{k: v for k, v in d.items() if not (k == "required" and v is not False)} for d in e["schema"]]
    if norm != a["schema"]:
        return f"schema differs: expected {norm}, got {a['schema']}"
    if len(e["rows"]) != len(a["rows"]):
        return f"row count differs: expected {len(e['rows'])}, got {len(a['rows'])}"
    for r, (er, ar) in enumerate(zip(e["rows"], a["rows"])):
        if not same_key(er[0], ar[0]):
            return f"row {r}: key differs: expected {er[0]!r}, got {ar[0]!r}"
        for c, (x, y) in enumerate(zip(er[1:], ar[1:]), start=1):
            why = compare_cell(x, y, tolerance)
            if why:
                return f"row {r} column {e['schema'][c]['name']!r}: {why}"
    return None


def compare_record(e: dict, a: dict, tolerance):
    if list(e) != list(a):
        return f"expected outputs {list(e)}, got {list(a)}"
    for name, cell in e.items():
        why = compare_cell(cell, a[name], tolerance)
        if why:
            return f"output {name!r}: {why}"
    return None


def check(case, actual):
    """None when pond_rs agrees with pond-ts on this case, else why not."""
    kinds = [k for k in ("expected", "groups", "reduced", "records", "error") if case.get(k) is not None]
    assert len(kinds) == 1, f"{case['id']}: exactly one outcome"
    want = kinds[0]
    tol = case.get("tolerance")
    if want == "error":
        if isinstance(actual, Exception):
            return None
        e = case["error"]
        return f"pond-ts throws ({e['name']}: {e['message']}), pond_rs succeeded"
    if isinstance(actual, Exception):
        return f"pond-ts succeeds, pond_rs raised {type(actual).__name__}: {actual}"
    shape, value = actual
    if want == "expected" and shape == "series":
        return compare_series(case["expected"], value, tol)
    if want == "groups" and shape == "groups":
        if len(case["groups"]) != len(value):
            return f"expected {len(case['groups'])} groups, got {len(value)}"
        for (ek, es), (ak, as_) in zip(case["groups"], value):
            if ek != ak:
                return f"expected key {ek!r}, got {ak!r}"
            why = compare_series(es, as_, tol)
            if why:
                return f"group {ek!r}: {why}"
        return None
    if want == "reduced" and shape == "record":
        return compare_record(case["reduced"], value, tol)
    if want == "records" and shape == "records":
        if len(case["records"]) != len(value):
            return f"expected {len(case['records'])} records, got {len(value)}"
        for i, (er, ar) in enumerate(zip(case["records"], value)):
            why = compare_record(er, ar, tol)
            if why:
                return f"record {i}: {why}"
        return None
    return "pond-ts and pond_rs give different result shapes"


# ---------------------------------------------------------------------------
# Fixture arguments to Python calls
# ---------------------------------------------------------------------------


def sequence(spec):
    seq = spec["sequence"]
    if "every" in seq:
        return pond_rs.Sequence.every(seq["every"])
    return pond_rs.Sequence.calendar(
        seq["calendar"], seq["timeZone"], week_starts_on=seq.get("weekStartsOn")
    )


def aggs(mapping):
    """pond-ts `{out: 'avg'}` / `{out: {from, using}}` as the Python
    mapping, using the tuple form for the long one."""
    return {
        out: spec if isinstance(spec, str) else (spec["from"], spec["using"])
        for out, spec in mapping.items()
    }


def whole(v):
    """An option count: an int when whole, else as given (pond_rs then
    refuses it, as pond-ts does)."""
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def rolling_kwargs(o):
    o = o or {}
    kw = {}
    if "alignment" in o:
        kw["alignment"] = o["alignment"]
    if "minSamples" in o:
        kw["min_samples"] = whole(o["minSamples"])
    if o.get("append"):
        kw["append"] = True
    return kw


def range_arg(o):
    r = o.get("range")
    if r is None:
        return None
    if isinstance(r, (int, float)):
        return r
    return (r["start"], r["end"])


def grid_kwargs(o, first):
    kw = {}
    if first[0] in o:
        kw[first[1]] = o[first[0]]
    if "sample" in o:
        kw["sample"] = o["sample"]
    if o.get("range") is not None:
        kw["range"] = range_arg(o)
    return kw


def fill_value(v):
    if isinstance(v, list):
        return [element(e) for e in v]
    if isinstance(v, dict):
        return num(v)
    return v


def event_key(arg):
    if isinstance(arg, list) and len(arg) == 2:
        return (arg[0], arg[1])
    if isinstance(arg, list) and len(arg) == 3:
        label = arg[0] if isinstance(arg[0], str) else num(arg[0])
        return (label, arg[1], arg[2])
    if isinstance(arg, dict):
        for k in ("time", "timeRange", "interval"):
            if k in arg:
                return event_key(arg[k])
    return arg


def kind_of(s: TimeSeries, column):
    for d in s.schema:
        if d["name"] == column:
            return d["kind"]
    raise KeyError(column)


def number(s, row, column):
    """`row.number(column)` as in the Rust harness: an error unless a
    number column."""
    if kind_of(s, column) != "number":
        raise TypeError(f"{column} is not a number column")
    return row[column]


def text(s, row, column):
    if kind_of(s, column) != "string":
        raise TypeError(f"{column} is not a string column")
    return row[column]


def boolean(s, row, column):
    if kind_of(s, column) != "boolean":
        raise TypeError(f"{column} is not a boolean column")
    return row[column]


def row_test(spec, s):
    """A filter / find test spec (cases.mjs `closure`) as a Python
    function of a row."""

    def test(row):
        if "column" in spec:
            c = spec["column"]
            if isinstance(spec.get("gt"), (int, float)) and not isinstance(spec.get("gt"), bool):
                v = number(s, row, c)
                return v is not None and v > spec["gt"]
            if isinstance(spec.get("eq"), bool):
                return boolean(s, row, c) == spec["eq"]
            if isinstance(spec.get("eq"), str):
                return text(s, row, c) == spec["eq"]
            raise AssertionError(f"unknown filter spec {spec}")
        if "missing" in spec:
            return number(s, row, spec["missing"]) is None
        if "everyNth" in spec:
            return row.index % spec["everyNth"] == 0
        if "beginAtLeast" in spec:
            return row.begin >= spec["beginAtLeast"]
        if "endAtMost" in spec:
            return row.end <= spec["endAtMost"]
        raise AssertionError(f"unknown filter spec {spec}")

    return test


def js_div(x: float, y: float) -> float:
    """IEEE division, as Rust and JavaScript divide (Python raises on 0)."""
    try:
        return x / y
    except ZeroDivisionError:
        if math.isnan(x) or x == 0:
            return math.nan
        return math.copysign(math.inf, x) * math.copysign(1, y)


def scan_step(spec):
    kind = spec["scan"]
    if kind == "sum":
        return lambda a, v, i: (a + v, a + v)
    if kind == "index":
        return lambda a, v, i: (a + 1.0, v * i - a)
    if kind == "nonfinite":
        return lambda a, v, i: (a + 1.0, js_div(v, math.fmod(a, 3.0)))
    if kind == "gain":
        band = spec["band"]

        def gain(state, v, i):
            reference, g = state
            if reference is None:
                return ((v, 0.0), 0.0)
            if v - reference >= band:
                return ((v, g + v - reference), g + v - reference)
            if v - reference <= -band:
                return ((v, g), g)
            return ((reference, g), g)

        return gain
    raise AssertionError(f"unknown scan spec {spec}")


def scan_init(spec, arg):
    return (None, 0.0) if spec["scan"] == "gain" else num(arg)


def collapse_fn(spec, s):
    keys = spec["keys"]
    how = spec["collapse"]

    def numbers(row):
        vals = [number(s, row, k) for k in keys]
        return None if any(v is None for v in vals) else vals

    def f(row):
        if how == "sum":
            v = numbers(row)
            if v is None:
                return None
            total = 0.0
            for x in v:
                total += x
            return total
        if how == "ratio":
            v = numbers(row)
            return None if v is None else js_div(v[0], v[1])
        if how == "gt":
            v = numbers(row)
            return None if v is None else v[0] > v[1]
        if how == "join":
            v = [text(s, row, k) for k in keys]
            return None if any(x is None for x in v) else "|".join(v)
        if how == "none":
            return None
        if how == "nan":
            return math.nan
        if how == "nanOrText":
            return "x" if numbers(row) is not None else math.nan
        raise AssertionError(f"unknown collapse spec {spec}")

    return f


def as_interval_fn(spec):
    def f(row):
        if spec == "rangeBegin":
            return float(row.begin)
        if spec == "rangeEnd":
            return float(row.end)
        if spec == "rowLabel":
            return f"row{row.index}"
        if spec == "mixedLabel":
            return 1.0 if row.index == 0 else "b"
        raise AssertionError(f"unknown asInterval closure {spec}")

    return f


def shared_op(target, op, args):
    """The ops a series and a partitioned series share, as Python calls.
    `None` for any other op."""
    if op == "rolling":
        if isinstance(args[0], str):
            return target.rolling(args[0], aggs(args[1]), **rolling_kwargs(args[2] if len(args) > 2 else None))
        if isinstance(args[0], dict) and "count" in args[0]:
            return target.rolling(whole(args[0]["count"]), aggs(args[1]), **rolling_kwargs(args[2] if len(args) > 2 else None))
        o = args[3] if len(args) > 3 else {}
        kw = rolling_kwargs(o)
        kw.update(grid_kwargs(o or {}, ("sample", "sample")))
        return target.rolling(args[1], aggs(args[2]), over=sequence(args[0]), **kw)
    if op == "aggregate":
        return target.aggregate(sequence(args[0]), aggs(args[1]))
    if op in ("diff", "rate", "pctChange"):
        o = args[1] if len(args) > 1 else {}
        kw = {}
        if o.get("drop") is True:
            kw["drop_first"] = True
        if "output" in o:
            kw["output"] = o["output"]
        method = {"diff": target.diff, "rate": target.rate, "pctChange": target.pct_change}[op]
        return method(args[0], **kw)
    if op == "cumulative":
        return target.cumulative(args[0])
    if op == "shift":
        return target.shift(args[0], whole(args[1]))
    if op == "fill":
        o = args[1] if len(args) > 1 else {}
        kw = {}
        if "limit" in o:
            kw["limit"] = whole(o["limit"])
        if "maxGap" in o:
            kw["max_gap"] = o["maxGap"]
        strategy = args[0]
        if isinstance(strategy, dict) and "f64" not in strategy:
            strategy = {c: fill_value(v) for c, v in strategy.items()}
        else:
            strategy = fill_value(strategy)
        return target.fill(strategy, **kw)
    if op == "align":
        o = args[1] if len(args) > 1 else {}
        return target.align(sequence(args[0]), **grid_kwargs(o, ("method", "method")))
    if op == "materialize":
        o = args[1] if len(args) > 1 else {}
        return target.materialize(sequence(args[0]), **grid_kwargs(o, ("select", "pick")))
    if op == "dedupe":
        keep = (args[0] if args else {}).get("keep")
        if isinstance(keep, dict):
            (how, column), = keep.items()
            keep = (how, column)
        return target.dedupe(keep)
    if op == "smooth":
        o = args[2]
        kw = {}
        for js, py in (("alpha", "alpha"), ("span", "span"), ("window", "window"), ("warmup", "warmup"),
                       ("minSamples", "min_samples"), ("alignment", "alignment"), ("missing", "missing"),
                       ("output", "output")):
            if js in o:
                kw[py] = whole(o[js]) if py in ("warmup", "min_samples") else o[js]
        return target.smooth(args[0], args[1], **kw)
    if op in ("baseline", "outliers"):
        o = args[1]
        kw = rolling_kwargs(o)
        kw.pop("append", None)
        if op == "outliers":
            return target.outliers(args[0], o["window"], o["sigma"], **kw)
        if o.get("names") is not None:
            kw["names"] = o["names"]
        return target.baseline(args[0], o["window"], o["sigma"], **kw)
    if op == "scan":
        spec = args[1]["fn"]
        kw = {}
        if len(args) > 3 and "output" in args[3]:
            kw["output"] = args[3]["output"]
        return target.scan(args[0], scan_step(spec), scan_init(spec, args[2]), **kw)
    if op == "sample":
        o = args[0]
        if "stride" in o:
            return target.sample(stride=whole(o["stride"]))
        return target.sample(reservoir=whole(o["reservoir"]["size"]))
    return None


def run(case):
    """Run one case; ("series" | "groups" | "record" | "records", value)."""
    s = series(case["input"])
    op, args = case["op"], case["args"]
    result = shared_op(s, op, args)
    if result is not None:
        return outcome_series(result)
    if op in ("byColumn", "rollingByColumn"):
        column, spec, mapping = args[0], args[1], aggs(args[2])
        if op == "byColumn":
            if "edges" in spec:
                table = s.by_column(column, mapping, edges=spec["edges"], upper_inclusive=spec.get("inclusive") == "(]")
            else:
                table = s.by_column(column, mapping, width=spec["width"], origin=spec.get("origin", 0))
        else:
            table = s.rolling_by_column(column, spec["radius"], mapping, at=spec.get("at"))
        names = list(table)
        n = len(table[names[0]]) if names else 0
        return ("records", [{k: table[k][i] for k in names} for i in range(n)])
    if op == "reduce":
        return ("record", s.reduce(aggs(args[0])))
    if op == "partitionBy":
        view = s.partition_by(args[0])
        for step in args[1]:
            view = shared_op(view, step[0], step[1:])
            assert view is not None, f"no partitioned {step[0]}"
        if args[2] == "collect":
            return outcome_series(view.collect())
        return groups_outcome(view.to_dict(), " undefined")
    if op == "groupBy":
        return groups_outcome(s.group_by(args[0]), "undefined")
    if op == "mapColumns":
        if not args[0]:
            raise pond_rs.PondError("map needs a column")  # stand-in: pond_rs maps one column per call
        out = s
        for column, mapper in args[0].items():
            m = mapper["fn"]
            if m == "upper":
                f = lambda v: v.upper()  # noqa: E731
            elif m == "not":
                f = lambda v: not v  # noqa: E731
            else:
                mul, add = m["mul"], m["add"]
                f = lambda v, mul=mul, add=add: v * mul + add  # noqa: E731
            out = out.map(column, f)
        got = outcome_series(out)
        if case["id"] == "mapColumns-overflow":
            # pond-ts keeps a mapped column marked required even when the
            # mapping leaves a gap ([PND-MAPREQ]); pond-rs makes it
            # optional. Check that, then compare as pond-ts has it.
            assert got[1]["schema"][1].get("required") is False
            del got[1]["schema"][1]["required"]
        return got
    single = {
        "tail": lambda: s.tail(args[0]),
        "overlapping": lambda: s.overlapping(event_key(args[0])),
        "containedBy": lambda: s.contained_by(event_key(args[0])),
        "trim": lambda: s.trim(event_key(args[0])),
        "before": lambda: s.before(event_key(args[0])),
        "after": lambda: s.after(event_key(args[0])),
        "within": lambda: s.within(args[0], args[1]),
        "asTimeRange": lambda: s.as_time_range(),
        "offsetTime": lambda: s.offset_time(args[0]),
        "arrayContains": lambda: s.array_contains(args[0], element(args[1])),
        "arrayContainsAll": lambda: s.array_contains_all(args[0], [element(e) for e in args[1]]),
        "arrayContainsAny": lambda: s.array_contains_any(args[0], [element(e) for e in args[1]]),
        "select": lambda: s.select(*args),
        "rename": lambda: s.rename(args[0]),
        "asTime": lambda: s.as_time((args[0] if args else {}).get("at", "begin")),
        "slice": lambda: s.slice(*args),
        "filter": lambda: s.filter(row_test(args[0]["fn"], s)),
        "withColumn": lambda: s.with_column(args[0], [cell_number(v) for v in args[1]]),
        "collapse": lambda: s.collapse(args[0], args[1], collapse_fn(args[2]["fn"], s), keep=bool(len(args) > 3 and args[3].get("append"))),
        "concat": lambda: TimeSeries.concat([s] + [series(a["series"]) for a in args[0]]),
        "join": lambda: s.join(series(args[0]["series"]), **join_kwargs(args[1] if len(args) > 1 else None)),
        "joinMany": lambda: TimeSeries.join_many([s] + [series(a["series"]) for a in args[0]], **join_kwargs(args[1] if len(args) > 1 else None)),
    }
    if op in single:
        return outcome_series(single[op]())
    if op == "asInterval":
        a = args[0]
        if isinstance(a, dict) and "fn" in a:
            return outcome_series(s.as_interval(as_interval_fn(a["fn"])))
        return outcome_series(s.as_interval(a if isinstance(a, str) else num(a)))
    if op in ("arrayAggregate", "arrayExplode"):
        o = args[2 if op == "arrayAggregate" else 1] if len(args) > (2 if op == "arrayAggregate" else 1) else {}
        kw = {}
        if "as" in o:
            kw["output"] = o["as"]
        if "kind" in o:
            kw["kind"] = o["kind"]
        if op == "arrayAggregate":
            return outcome_series(s.array_aggregate(args[0], args[1], **kw))
        return outcome_series(s.array_explode(args[0], **kw))
    if op == "pivotByGroup":
        o = args[2] if len(args) > 2 else {}
        kw = {}
        if "aggregate" in o:
            kw["aggregate"] = o["aggregate"]
        if "groups" in o:
            kw["groups"] = o["groups"]
        return outcome_series(s.pivot_by_group(args[0], args[1], **kw))
    raise AssertionError(f"no Python call for op {op!r}")


def join_kwargs(o):
    o = o or {}
    kw = {}
    if "type" in o:
        kw["how"] = o["type"]
    if "onConflict" in o:
        kw["on_conflict"] = o["onConflict"]
    if "prefixes" in o:
        kw["prefixes"] = o["prefixes"]
    return kw


# ---------------------------------------------------------------------------
# The known differences (the Rust harness's list)
# ---------------------------------------------------------------------------

EMPTY_BACKWARDS = {"span-overlapping-emptyHosts-8", "span-trim-emptyHosts-8"}
KIND_FROM_ELEMENTS = {
    "arrayAggregate-nums-first": "arrayAggregate-nums-first-number",
    "arrayExplode-nums": "arrayExplode-nums-number",
}
REFUSED = {"smooth-ema-text", "smooth-ema-unknown", "baseline-text", "partition-smooth-text"}
CASES = {c["id"]: c for c in FIXTURE["cases"]}


# Cases where pond-ts throws and Python itself refuses the argument before
# pond-rs sees it (a fractional count where an int is needed): these may
# raise TypeError / OverflowError. Every other expected error must be a
# pond_rs.PondError, so a harness mistake (a wrong keyword, a missing
# fixture key) cannot pass as a matching error.
PYTHON_TYPE_ERRORS = {
    "error-shift-fraction",
    "smooth-ema-warmup-neg",
    "smooth-ema-warmup-frac",
    "smooth-ema-minSamples-frac",
    "sample-stride-frac",
    "sample-reservoir-frac",
}


def attempt(case):
    try:
        return run(case)
    except pond_rs.PondError as e:
        return e
    except (TypeError, OverflowError) as e:
        if case["id"] in PYTHON_TYPE_ERRORS:
            return e
        raise


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=[c["id"] for c in FIXTURE["cases"]])
def test_core_case(case):
    actual = attempt(case)
    cid = case["id"]
    if cid in EMPTY_BACKWARDS:
        # pond-ts never builds the range on an empty series; pond-rs
        # checks a key when it is built.
        assert isinstance(actual, Exception), "pond_rs should refuse the key"
        return
    if cid in KIND_FROM_ELEMENTS:
        # pond-rs takes array elements' kind; pond-ts needs kind: 'number'.
        assert case.get("error") is not None
        why = check(CASES[KIND_FROM_ELEMENTS[cid]], actual)
        assert why is None, why
        return
    if cid in REFUSED:
        assert case.get("expected") is not None
        assert isinstance(actual, Exception), "pond_rs should refuse"
        return
    if case["op"] == "collapse" and case.get("expected") is not None:
        # [PND-COLLAPSEREQ]: pond-ts marks collapse's output required even
        # with gaps; pond-rs marks it optional then.
        case = json.loads(json.dumps(case))
        exp = case["expected"]
        at = next(i for i, c in enumerate(exp["schema"]) if c["name"] == case["args"][1])
        if any(r[at] is None for r in exp["rows"]):
            assert "required" not in exp["schema"][at], "pond-ts fixed [PND-COLLAPSEREQ]"
            exp["schema"][at]["required"] = False
    why = check(case, actual)
    assert why is None, why


# ---------------------------------------------------------------------------
# Row lookups and time parsing
# ---------------------------------------------------------------------------


def run_query(q):
    s = series(q["input"])
    op, arg = q["op"], q["arg"]
    pos = lambda r: None if r is None else r.index  # noqa: E731
    if op == "at":
        return pos(s.at(arg))
    if op in ("find", "some", "every"):
        test = row_test(arg, s)
        r = getattr(s, op)(test)
        return pos(r) if op == "find" else r
    if op == "timeRange":
        r = s.time_range()
        return None if r is None else list(r)
    key = event_key(arg)
    if op == "intersection":
        r = s.intersection(key)
        return None if r is None else list(r)
    if op in ("overlaps", "contains", "bisect"):
        return getattr(s, op)(key)
    if op == "includesKey":
        return s.includes_key(key)
    if op in ("atOrBefore", "atOrAfter", "nearest"):
        return pos(getattr(s, {"atOrBefore": "at_or_before", "atOrAfter": "at_or_after"}.get(op, op))(key))
    raise AssertionError(f"unknown query op {op}")


def test_row_lookups_match_pond_ts():
    failures = []
    for q in FIXTURE["queries"]:
        try:
            got = run_query(q)
            err = None
        except pond_rs.PondError as e:
            got, err = None, e
        want_error = q.get("error") is not None
        want = None if want_error else q.get("expected")
        if err is not None:
            # Known difference: on an empty series pond-ts `nearest` returns
            # before building the key; pond-rs checks a key when built.
            ok = want_error or (
                want is None and q["op"] == "nearest" and len(series(q["input"])) == 0 and isinstance(q["arg"], list)
            )
        else:
            ok = not want_error and got == want and type(got) is type(want) if isinstance(want, bool) else (not want_error and got == want)
        if not ok:
            failures.append(f"{q['input']}.{q['op']}({q['arg']}): pond_rs {err or got!r}, pond-ts {q.get('error') or want!r}")
    assert not failures, f"{len(failures)} of {len(FIXTURE['queries'])} differ:\n" + "\n".join(failures[:50])


def test_times_parse_as_pond_ts():
    failures = []
    for c in FIXTURE["timeParse"]:
        try:
            got = pond_rs.parse_time(c["input"], c["timeZone"])
        except pond_rs.PondError:
            got = None
        if got != c.get("expected"):
            failures.append(f"{c['input']!r} in {c['timeZone']}: pond_rs {got}, pond-ts {c.get('expected', c.get('error'))}")
    assert not failures, "\n".join(failures)


def test_every_case_ran_once():
    """Coverage: the fixture holds no op this harness does not call."""
    known = {
        "rolling", "aggregate", "diff", "rate", "pctChange", "cumulative", "shift", "fill",
        "select", "rename", "asTime", "slice", "filter", "mapColumns", "withColumn",
        "partitionBy", "groupBy", "align", "materialize", "dedupe", "join", "joinMany",
        "tail", "reduce", "overlapping", "containedBy", "trim", "before", "after", "within",
        "asTimeRange", "asInterval", "offsetTime", "arrayContains", "arrayContainsAll",
        "arrayContainsAny", "arrayAggregate", "arrayExplode", "smooth", "baseline",
        "outliers", "scan", "sample", "concat", "collapse", "pivotByGroup", "byColumn",
        "rollingByColumn",
    }
    ops = {c["op"] for c in FIXTURE["cases"]}
    assert ops <= known, f"new ops in the fixture: {ops - known}"
