"""Check pond-ts and polars agree on a workload's outputs.

    python compare.py <pond-prefix> <polars-prefix> <name>...

Reads <prefix>.<name>.arrow from each side. Keys (bucket start, or the event
time for rolling) must match exactly; a missing value must be missing on both
sides (pond writes a gap as NaN or null, polars as null); counts must match
exactly; every other value must agree within TOL, absolute. Prints the
largest difference per column and exits non-zero on any disagreement.

Rolling results are looser, because pond-ts's are off in a known way
([PND-ROLLSTD]): it keeps a running sum and stdev, updated as each value
enters and leaves the window, and the rounding error they build up is never
cleared. Two rules: rolling values must agree within ROLL_TOL (on dense
stretches of the 1M-row file pond-ts is up to ~5e-9 off an exact stdev and
~1e-9 off an exact average; polars ~1e-12), and up to ROLL_EXCEPTIONS of the
rows may miss that (they are counted in the output). Those are windows
draining to a few values before an outage, where the built-up error is large
next to a small stdev (worst seen: 0.000442 instead of 0.000354). A real
difference in what is computed, such as sample instead of population stdev,
moves every row by ~1e-3 and fails both rules.
"""

import math
import sys

import pyarrow as pa

TOL = 1e-9
ROLL_TOL = 1e-7
ROLL_EXCEPTIONS = 1e-4  # fraction of rows


def read(path):
    with pa.memory_map(path) as src:
        return pa.ipc.open_file(src).read_all()


def as_ms(col):
    """A key column as epoch milliseconds (float), whatever its Arrow type."""
    if pa.types.is_timestamp(col.type):
        assert col.type.unit == "ms", col.type
        return [None if v is None else float(v) for v in col.cast(pa.int64()).to_pylist()]
    return col.to_pylist()


def missing(v):
    return v is None or (isinstance(v, float) and math.isnan(v))


def compare(pond, polars, name):
    ok = True
    if pond.num_rows != polars.num_rows:
        print(f"{name}: row count pond-ts {pond.num_rows}, polars {polars.num_rows}")
        return False
    pond_key = "interval" if "interval" in pond.column_names else "time"
    pk, lk = as_ms(pond[pond_key]), as_ms(polars["time"])
    bad = [i for i, (a, b) in enumerate(zip(pk, lk)) if a != b]
    if bad:
        i = bad[0]
        print(f"{name}: {len(bad)} keys differ, first row {i}: {pk[i]} vs {lk[i]}")
        ok = False
    for col in polars.column_names:
        if col == "time":
            continue
        a, b = pond[col].to_pylist(), polars[col].to_pylist()
        worst, gaps, mismatched = 0.0, 0, 0
        for x, y in zip(a, b):
            if missing(x) or missing(y):
                gaps += 1
                if missing(x) != missing(y):
                    mismatched += 1
                continue
            d = abs(x - y)
            worst = max(worst, d)
            limit = (
                0.0
                if col.endswith("_count")
                else ROLL_TOL
                if name == "roll"
                else TOL
            )
            if d > limit:
                mismatched += 1
        allowed = int(len(a) * ROLL_EXCEPTIONS) if name == "roll" else 0
        if mismatched == 0:
            status = "ok"
        elif mismatched <= allowed:
            status = f"ok, {mismatched} rows past {ROLL_TOL} (pond-ts drift, [PND-ROLLSTD])"
        else:
            status = f"{mismatched} MISMATCHED"
        print(f"{name}.{col}: max |diff| {worst:.3e}, gaps {gaps}, {status}")
        ok = ok and mismatched <= allowed
    return ok


pond_prefix, polars_prefix, names = sys.argv[1], sys.argv[2], sys.argv[3:]
all_ok = True
for name in names:
    all_ok &= compare(
        read(f"{pond_prefix}.{name}.arrow"), read(f"{polars_prefix}.{name}.arrow"), name
    )
print("AGREE" if all_ok else "DISAGREE")
sys.exit(0 if all_ok else 1)
