"""Check pond-ts and polars agree on a workload's outputs.

    python compare.py <pond-prefix> <polars-prefix> <name>...

Reads <prefix>.<name>.arrow from each side. Keys (bucket start, or the event
time for rolling) must match exactly; a missing value must be missing on both
sides (pond writes a gap as NaN or null, polars as null); counts must match
exactly; every other value must agree within TOL, absolute. Prints the
largest difference per column and exits non-zero on any disagreement.

Rolling results used to get a looser rule because pond-ts's running sums
drifted ([PND-ROLLSTD]); since PR #766 pond-ts rolling is within ~1e-12 of
polars, so the same TOL applies to everything.
"""

import math
import sys

import pyarrow as pa

TOL = 1e-9


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
            limit = 0.0 if col.endswith("_count") else TOL
            if d > limit:
                mismatched += 1
        status = "ok" if mismatched == 0 else f"{mismatched} MISMATCHED"
        print(f"{name}.{col}: max |diff| {worst:.3e}, gaps {gaps}, {status}")
        ok = ok and mismatched == 0
    return ok


pond_prefix, polars_prefix, names = sys.argv[1], sys.argv[2], sys.argv[3:]
all_ok = True
for name in names:
    all_ok &= compare(
        read(f"{pond_prefix}.{name}.arrow"), read(f"{polars_prefix}.{name}.arrow"), name
    )
print("AGREE" if all_ok else "DISAGREE")
sys.exit(0 if all_ok else 1)
