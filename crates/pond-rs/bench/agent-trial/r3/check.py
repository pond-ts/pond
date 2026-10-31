"""Grade one R3 step 7 trial output against the pond-ts answer.

    python3 check.py <expected.csv from reference.mjs> <agent out.csv>

Right answer: the same header and the same rows in the same order; host,
start, count and closed_by equal; avg and max within 1e-9 relative, empty in
the same places. Prints one JSON line: {"right": bool, "bitwise": bool,
"why": str}.
"""

import csv
import json
import sys


def rows(path):
    with open(path, newline="") as f:
        return list(csv.reader(f))


def main():
    exp, got = rows(sys.argv[1]), rows(sys.argv[2])
    bitwise = True

    def verdict(right, why):
        print(json.dumps({"right": right, "bitwise": right and bitwise, "why": why}))

    if not got or [c.strip() for c in got[0]] != exp[0]:
        return verdict(False, f"header {got[0] if got else None}")
    got = [r for r in got[1:] if r]
    exp = exp[1:]
    if len(got) != len(exp):
        return verdict(False, f"{len(got)} rows, want {len(exp)}")
    for i, (e, g) in enumerate(zip(exp, got)):
        g = [c.strip() for c in g]
        if len(g) != 6:
            return verdict(False, f"row {i}: {len(g)} fields")
        try:
            same = (
                g[0] == e[0]
                and int(float(g[1])) == int(e[1])
                and int(float(g[4])) == int(e[4])
                and int(float(g[5])) == int(e[5])
            )
        except ValueError:
            same = False
        if not same:
            return verdict(False, f"row {i}: {g} want {e}")
        for k in (2, 3):
            if (g[k] == "") != (e[k] == ""):
                return verdict(False, f"row {i} col {k}: {g[k]!r} want {e[k]!r}")
            if e[k] == "":
                continue
            a, b = float(g[k]), float(e[k])
            if abs(a - b) > 1e-9 * max(abs(b), 1e-300):
                return verdict(False, f"row {i} col {k}: {a} want {b}")
            if a != b:
                bitwise = False
    verdict(True, "")


main()
