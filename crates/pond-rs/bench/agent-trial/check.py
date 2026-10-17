"""Grade one trial output against the pond-ts answer for workload B.

    python check.py <reference pond_B.agg.arrow> <agent out.arrow>

Right answer: one row per New York calendar day, in order, with day_start equal
to pond-ts's bucket start (as epoch ms), counts equal, and avg/min/max within
1e-9 relative. Prints one JSON line: {"right": bool, "bitwise": bool, "why": str}.
"""

import json
import math
import sys

import pyarrow as pa

COLS = [f"c{i}_{r}" for i in range(4) for r in ("avg", "min", "max", "count")]


def read(path):
    with pa.memory_map(path) as src:
        return pa.ipc.open_file(src).read_all()


def ms(col):
    t = col.type
    if pa.types.is_timestamp(t):
        scale = {"s": 1000, "ms": 1, "us": 1e-3, "ns": 1e-6}[t.unit]
        return [None if v is None else v * scale for v in col.cast(pa.int64()).to_pylist()]
    if pa.types.is_date(t):
        return None
    return [None if v is None else float(v) for v in col.to_pylist()]


def nums(col):
    return [None if v is None or (isinstance(v, float) and math.isnan(v)) else float(v) for v in col.to_pylist()]


def grade(ref, out):
    if "day_start" not in out.column_names:
        return False, False, f"no day_start column; got {out.column_names}"
    missing = [c for c in COLS if c not in out.column_names]
    if missing:
        return False, False, f"missing columns {missing}"
    if out.num_rows != ref.num_rows:
        return False, False, f"{out.num_rows} rows, want {ref.num_rows}"
    starts = ms(out["day_start"])
    if starts is None:
        return False, False, f"day_start is {out['day_start'].type}, not an instant"
    want = [float(v) for v in ref["interval"].to_pylist()]
    if starts != want:
        bad = next(i for i, (a, b) in enumerate(zip(starts, want)) if a != b)
        return False, False, f"day_start row {bad}: {starts[bad]} want {want[bad]}"
    bitwise = True
    for c in COLS:
        a, b = nums(out[c]), nums(ref[c])
        for i, (x, y) in enumerate(zip(a, b)):
            if (x is None) != (y is None):
                return False, False, f"{c} row {i}: {x} want {y}"
            if x is None:
                continue
            if x != y:
                bitwise = False
            tol = 0 if c.endswith("count") else 1e-9 * max(1.0, abs(y))
            if abs(x - y) > tol:
                return False, False, f"{c} row {i}: {x} want {y}"
    return True, bitwise, "ok"


if __name__ == "__main__":
    try:
        right, bitwise, why = grade(read(sys.argv[1]), read(sys.argv[2]))
    except Exception as e:  # unreadable or missing output is a wrong answer
        right, bitwise, why = False, False, f"{type(e).__name__}: {e}"
    print(json.dumps({"right": right, "bitwise": bitwise, "why": why}))
