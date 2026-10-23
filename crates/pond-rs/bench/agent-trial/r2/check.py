"""Grade one R2 step-5 trial output against pond-ts's answer (reference.mjs).

    python check.py <reference.json> <agent out.arrow>

Right answer: the same rows in the same order, equal times (as epoch ms),
and rsi / bbUpper / bbLower / vwap each within 1e-9 relative, with nulls in
the same places. Prints one JSON line: {"right": bool, "bitwise": bool,
"why": str}.
"""

import json
import sys

import pyarrow as pa

COLUMNS = ("rsi", "bbUpper", "bbLower", "vwap")


def ms(col):
    t = col.type
    if pa.types.is_timestamp(t):
        scale = {"s": 1000, "ms": 1, "us": 1e-3, "ns": 1e-6}[t.unit]
        return [None if v is None else v * scale for v in col.cast(pa.int64()).to_pylist()]
    return [None if v is None else float(v) for v in col.to_pylist()]


def grade(ref, out):
    for c in ("time",) + COLUMNS:
        if c not in out.column_names:
            return False, False, f"no {c} column; got {out.column_names}"
    n = len(ref["time"])
    if out.num_rows != n:
        return False, False, f"{out.num_rows} rows, want {n}"
    if ms(out["time"]) != ref["time"]:
        return False, False, "times differ"
    bitwise = True
    for c in COLUMNS:
        got = out[c].to_pylist()
        for i, (g, w) in enumerate(zip(got, ref[c])):
            # A NaN for "no value" is accepted as a null.
            if g is not None and g != g:
                g = None
            if (g is None) != (w is None):
                return False, False, f"{c}[{i}]: {g} want {w}"
            if g is None:
                continue
            if g != w:
                bitwise = False
            if abs(g - w) > 1e-9 * max(1.0, abs(w)):
                return False, False, f"{c}[{i}]: {g} want {w}"
    return True, bitwise, "ok"


if __name__ == "__main__":
    ref = json.load(open(sys.argv[1]))
    try:
        out = pa.ipc.open_file(sys.argv[2]).read_all()
    except Exception as e:  # noqa: BLE001 - any unreadable output is wrong
        print(json.dumps({"right": False, "bitwise": False, "why": f"unreadable: {e}"}))
        sys.exit(0)
    right, bitwise, why = grade(ref, out)
    print(json.dumps({"right": right, "bitwise": bitwise, "why": why}))
