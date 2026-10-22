"""Compare the answers pond-rs and polars give, case by case.

    BENCH_DUMP=/tmp/rs target/release/examples/perf_rowwise
    BENCH_DUMP=/tmp/pl python polars/bench_rowwise.py
    python check_outputs.py /tmp/rs /tmp/pl

Each runner, with `BENCH_DUMP` set, writes every case's warm-up answer as
`<case>.json` (columns), `.txt` (JSON text it produced) or `.arrow` (Arrow
IPC bytes); see `examples/common/mod.rs`. For each case both sides wrote,
this requires:

- the same column names in the same order, and the same number of rows;
- numbers equal within 1e-9 of the larger magnitude (or of 1), and gaps in
  the same places (NaN counts as a gap);
- text, true/false, list cells and times exactly equal (list elements that
  are numbers within the same tolerance);
- `.txt`: both parse as JSON and hold the same rows (pond's `{..., "rows":
  [...]}` is compared by its `rows`);
- `.arrow`: read with polars, then compared as columns.

Cases only one side wrote are listed and do not fail the check (polars has
no counterpart for some). Exit status 1 if any compared case differs.
"""

import io
import json
import math
import sys
from pathlib import Path

TOL = 1e-9
# Random picks: the two libraries draw different random numbers, so only
# the shape is compared (columns, row count, times in order).
RANDOM = {"sample_reservoir_1000"}


def same_number(a, b):
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, str) or isinstance(b, str):
        return a == b
    if isinstance(a, bool) or isinstance(b, bool):
        return a == b
    return abs(a - b) <= TOL * max(1.0, abs(a), abs(b))


def same_cell(a, b):
    if isinstance(a, list) or isinstance(b, list):
        if not (isinstance(a, list) and isinstance(b, list)) or len(a) != len(b):
            return False
        return all(same_cell(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) or isinstance(b, dict):
        if not (isinstance(a, dict) and isinstance(b, dict)) or list(a) != list(b):
            return False
        return all(same_cell(a[k], b[k]) for k in a)
    if isinstance(a, (int, float)) and not isinstance(a, bool) or isinstance(b, (int, float)) and not isinstance(b, bool):
        if isinstance(a, float) and math.isnan(a):
            a = None
        if isinstance(b, float) and math.isnan(b):
            b = None
        return same_number(a, b)
    return a == b


def show(x):
    t = json.dumps(x)
    return t if len(t) < 80 else t[:77] + "..."


def compare_columns(a, b):
    """Differences between two `[(name, values)]` tables, as text lines."""
    na, nb = [n for n, _ in a], [n for n, _ in b]
    if na != nb:
        if len(na) > 8 and set(na) == set(nb):
            return ["same columns in a different order"]
        if len(na) > 8:
            return [f"columns differ: only pond-rs {sorted(set(na) - set(nb))[:5]}, only polars {sorted(set(nb) - set(na))[:5]}"]
        return [f"columns differ: pond-rs {na} vs polars {nb}"]
    out = []
    for (name, va), (_, vb) in zip(a, b):
        if len(va) != len(vb):
            out.append(f"{name}: {len(va)} rows vs {len(vb)}")
            continue
        bad = [i for i, (x, y) in enumerate(zip(va, vb)) if not same_cell(x, y)]
        if bad:
            i = bad[0]
            out.append(
                f"{name}: {len(bad)} of {len(va)} cells differ; first at row {i}: pond-rs {show(va[i])} vs polars {show(vb[i])}"
            )
    return out


def shape_only(a, b):
    na, nb = [n for n, _ in a], [n for n, _ in b]
    if na != nb:
        return [f"columns differ: pond-rs {na} vs polars {nb}"]
    if len(a[0][1]) != len(b[0][1]):
        return [f"{len(a[0][1])} rows vs {len(b[0][1])}"]
    t = b[0][1]
    if any(x > y for x, y in zip(t, t[1:])):
        return ["polars rows are not in time order"]
    return []


def load(path):
    if path.suffix == ".json":
        doc = json.loads(path.read_text())
        return "columns", [(c["name"], c["values"]) for c in doc["columns"]]
    if path.suffix == ".txt":
        doc = json.loads(path.read_text())
        if isinstance(doc, dict) and "rows" in doc:
            doc = doc["rows"]
        return "text", doc
    if path.suffix == ".arrow":
        import polars as pl

        sys.path.insert(0, str(Path(__file__).parent / "polars"))
        from common import frame_columns

        return "columns", frame_columns(pl.read_ipc(io.BytesIO(path.read_bytes())))
    raise ValueError(path)


def main():
    rs, pl_ = Path(sys.argv[1]), Path(sys.argv[2])
    a = {p.stem: p for p in rs.iterdir() if p.suffix in (".json", ".txt", ".arrow")}
    b = {p.stem: p for p in pl_.iterdir() if p.suffix in (".json", ".txt", ".arrow")}
    failed = 0
    for case in sorted(a.keys() & b.keys()):
        ka, va = load(a[case])
        kb, vb = load(b[case])
        if ka != kb:
            diffs = [f"pond-rs wrote {a[case].suffix}, polars {b[case].suffix}"]
        elif ka == "columns" and case in RANDOM:
            diffs = shape_only(va, vb)
        elif ka == "columns":
            diffs = compare_columns(va, vb)
        else:
            diffs = [] if same_cell(va, vb) else ["the JSON text holds different rows"]
        rows = len(va[0][1]) if ka == "columns" and va else (len(va) if isinstance(va, list) else 1)
        if diffs:
            failed += 1
            print(f"DIFFERS  {case} ({rows} rows)")
            for d in diffs:
                print(f"         {d}")
        else:
            print(f"same     {case} ({rows} rows)")
    for case in sorted(a.keys() - b.keys()):
        print(f"pond-rs only  {case}")
    for case in sorted(b.keys() - a.keys()):
        print(f"polars only   {case}")
    print(f"{failed} differing case(s)")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
