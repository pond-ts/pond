"""Check pond-rs gives exactly pond-ts's answers on a workload.

    python same.py <pond-ts-prefix> <pond-rs-prefix> <name>...

Reads <prefix>.<name>.arrow from each side. Same field names in the same
order, same row count, and every cell identical to the bit (so -0 is not 0);
a gap must be a gap on both sides (pond-ts writes a gap as NaN or null,
pond-rs as null). Keys compare as epoch milliseconds whatever their Arrow
type. Prints the number of differing cells per field and exits non-zero on
any.
"""

import math
import struct
import sys

import pyarrow as pa


def read(path):
    with pa.memory_map(path) as src:
        return pa.ipc.open_file(src).read_all()


def cells(col):
    if pa.types.is_timestamp(col.type):
        assert col.type.unit == "ms", col.type
        col = col.cast(pa.int64())
    out = []
    for v in col.to_pylist():
        if v is None or (isinstance(v, float) and math.isnan(v)):
            out.append(None)
        else:
            out.append(struct.pack("<d", float(v)))
    return out


def same(ts, rs, name):
    if ts.column_names != rs.column_names:
        print(f"{name}: fields differ: {ts.column_names} vs {rs.column_names}")
        return False
    if ts.num_rows != rs.num_rows:
        print(f"{name}: rows differ: {ts.num_rows} vs {rs.num_rows}")
        return False
    ok = True
    for col in ts.column_names:
        a, b = cells(ts[col]), cells(rs[col])
        bad = [i for i, (x, y) in enumerate(zip(a, b)) if x != y]
        if bad:
            i = bad[0]
            x = None if a[i] is None else struct.unpack("<d", a[i])[0]
            y = None if b[i] is None else struct.unpack("<d", b[i])[0]
            print(f"{name}.{col}: {len(bad)} cells differ, first row {i}: {x!r} vs {y!r}")
            ok = False
        else:
            print(f"{name}.{col}: identical ({ts.num_rows} rows)")
    return ok


ts_prefix, rs_prefix, names = sys.argv[1], sys.argv[2], sys.argv[3:]
all_ok = True
for name in names:
    all_ok &= same(read(f"{ts_prefix}.{name}.arrow"), read(f"{rs_prefix}.{name}.arrow"), name)
print("IDENTICAL" if all_ok else "DIFFERENT")
sys.exit(0 if all_ok else 1)
