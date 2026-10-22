"""Shared helpers for the polars side of the per-step pond-rs benchmarks.

Each `bench_*.py` here rebuilds the same data as the matching
`examples/perf_*.rs` (same generator, same values) and times the closest
polars call for each case. Output: one `| case | ms | check |` line per
case, the same shape the pond-rs and pond-ts runners print, so
`../collect.py` can line the three up.

Set `POLARS_MAX_THREADS=1` before running for the one-thread numbers (polars
reads it once, at import).

Set `BENCH_DUMP=<dir>` and each case also writes its warm-up answer there,
in the layout the Rust runners use (`examples/common/mod.rs`), so
`../check_outputs.py` can compare the two cell by cell. Untimed.
"""

import json
import math
import os
import sys
import time

import polars as pl


def _cell(x):
    if isinstance(x, float):
        if math.isnan(x):
            return None
        if math.isinf(x):
            return "inf" if x > 0 else "-inf"
    if isinstance(x, list):
        return [_cell(y) for y in x]
    return x


def frame_columns(df):
    """A frame as `[(name, values)]`: times as epoch milliseconds, NaN as a gap."""
    out = []
    for c in df.columns:
        s = df[c]
        if s.dtype == pl.Datetime or s.dtype == pl.Date:
            s = s.cast(pl.Datetime("ms")).dt.epoch("ms")
        out.append((c, [_cell(x) for x in s.to_list()]))
    return out


def slug(name):
    return "".join(ch if ch.isascii() and ch.isalnum() else "_" for ch in name)


def write_dump(name, out):
    """Write `out` as case `name`'s answer, when BENCH_DUMP is set."""
    d = os.environ.get("BENCH_DUMP")
    if not d:
        return
    os.makedirs(d, exist_ok=True)
    base = os.path.join(d, slug(name))
    if isinstance(out, pl.Series):
        out = out.to_frame()
    if type(out).__name__ in ("Table", "RecordBatch"):  # pyarrow
        out = pl.from_arrow(out)
    if isinstance(out, dict) and out and all(isinstance(v, pl.DataFrame) for v in out.values()):
        # partition_by(as_dict=True): parts one after another, by key
        keys = sorted(out, key=lambda k: "|".join(map(str, k if isinstance(k, tuple) else (k,))))
        parts = [
            out[k].select(pl.lit("|".join(map(str, k if isinstance(k, tuple) else (k,)))).alias("part"), pl.all())
            for k in keys
        ]
        out = pl.concat(parts)
    if isinstance(out, pl.DataFrame):
        cols = frame_columns(out)
    elif isinstance(out, list) and all(isinstance(c, tuple) for c in out):
        cols = out  # already [(name, values)]
    elif isinstance(out, str):
        with open(base + ".txt", "w") as f:
            f.write(out)
        return
    elif isinstance(out, (bytes, bytearray)):
        with open(base + ".arrow", "wb") as f:
            f.write(out)
        return
    else:
        raise TypeError(f"{name}: cannot dump {type(out).__name__}")
    with open(base + ".json", "w") as f:
        json.dump({"columns": [{"name": n, "values": v} for n, v in cols]}, f)


def xorshift(seed=20261019):
    """The xorshift32 generator the Rust and JavaScript runners use."""
    s = seed

    def nxt():
        nonlocal s
        s ^= (s << 13) & 0xFFFFFFFF
        s ^= s >> 17
        s ^= (s << 5) & 0xFFFFFFFF
        return s / 4294967296.0

    return nxt


def median_ms(f, runs=7, name=None, dump=None):
    """Median ms of `runs` calls after a warm-up call, whose answer is written
    as case `name` (passed through `dump` first, if given)."""
    a = time.perf_counter()
    out = f()  # warm-up; its result gives the checksum (and the dump)
    if time.perf_counter() - a > 2:
        runs = 3  # a case over 2 s (e.g. rolling top3 / samples) gets 3 timed runs
    if name is not None and os.environ.get("BENCH_DUMP"):
        write_dump(name, dump(out) if dump else out)
    t = []
    for _ in range(runs):
        a = time.perf_counter()
        f()
        t.append((time.perf_counter() - a) * 1000)
    t.sort()
    return t[len(t) // 2], out


def number_check(out, column=None):
    """Present numbers in every float column (or just `column`), and their sum."""
    if isinstance(out, pl.Series):
        out = out.to_frame()
    if type(out).__name__ in ("Table", "RecordBatch"):  # pyarrow
        out = pl.from_arrow(out)
    if isinstance(out, dict):
        return f"{len(out)} parts"
    if isinstance(out, list):
        return f"{len(out)} items"
    if isinstance(out, (str, bytes)):
        return f"{len(out)} bytes"
    if not isinstance(out, pl.DataFrame):
        return type(out).__name__
    n, total = 0, 0.0
    for c in [column] if column else out.columns:
        s = out[c]
        if s.dtype in (pl.Float64, pl.Float32):
            s = s.fill_nan(None).drop_nulls()
            n += len(s)
            total += float(s.sum())
    return f"{out.height} rows, {n} {total:.6e}"


def run(cases, only=None, column=None):
    only = only if only is not None else (sys.argv[1] if len(sys.argv) > 1 else None)
    print(f"# polars {pl.__version__}, threads {pl.thread_pool_size()}", file=sys.stderr)
    for name, f in cases:
        if only and not name.startswith(only):
            continue
        ms, out = median_ms(f, name=name)
        print(f"| {name} | {ms:.1f} ms | {number_check(out, column)} |", flush=True)
