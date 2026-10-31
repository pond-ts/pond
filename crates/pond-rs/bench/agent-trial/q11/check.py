"""Grade one step-4b trial output against pond-ts's answer (reference.mjs).

    python check.py <reference.json> <agent out.arrow>

Right answer: the same 20 symbols in the same order, each with the same
time (as epoch ms) and z within 1e-9 relative. Prints one JSON line:
{"right": bool, "bitwise": bool, "why": str}.
"""

import json
import sys

import pyarrow as pa


def ms(col):
    t = col.type
    if pa.types.is_timestamp(t):
        scale = {"s": 1000, "ms": 1, "us": 1e-3, "ns": 1e-6}[t.unit]
        return [None if v is None else v * scale for v in col.cast(pa.int64()).to_pylist()]
    return [None if v is None else float(v) for v in col.to_pylist()]


def grade(ref, out):
    for c in ("symbol", "time", "z"):
        if c not in out.column_names:
            return False, False, f"no {c} column; got {out.column_names}"
    if out.num_rows != len(ref):
        return False, False, f"{out.num_rows} rows, want {len(ref)}"
    syms = [str(s) for s in out["symbol"].to_pylist()]
    want = [r["symbol"] for r in ref]
    if syms != want:
        bad = next(i for i, (a, b) in enumerate(zip(syms, want)) if a != b)
        return False, False, f"row {bad}: symbol {syms[bad]} want {want[bad]}"
    times = ms(out["time"])
    zs = out["z"].to_pylist()
    bitwise = True
    for i, r in enumerate(ref):
        if times[i] != r["time"]:
            return False, False, f"row {i}: time {times[i]} want {r['time']}"
        if zs[i] is None:
            return False, False, f"row {i}: z missing"
        if zs[i] != r["z"]:
            bitwise = False
        if abs(zs[i] - r["z"]) > 1e-9 * max(1.0, abs(r["z"])):
            return False, False, f"row {i}: z {zs[i]} want {r['z']}"
    return True, bitwise, "ok"


if __name__ == "__main__":
    try:
        with pa.memory_map(sys.argv[2]) as src:
            out = pa.ipc.open_file(src).read_all()
        right, bitwise, why = grade(json.load(open(sys.argv[1])), out)
    except Exception as e:  # unreadable or missing output is a wrong answer
        right, bitwise, why = False, False, f"{type(e).__name__}: {e}"
    print(json.dumps({"right": right, "bitwise": bitwise, "why": why}))
