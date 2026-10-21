"""Shared helpers for the polars side of the per-step pond-rs benchmarks.

Each `bench_*.py` here rebuilds the same data as the matching
`examples/perf_*.rs` (same generator, same values) and times the closest
polars call for each case. Output: one `| case | ms | check |` line per
case, the same shape the pond-rs and pond-ts runners print, so
`../collect.py` can line the three up.

Set `POLARS_MAX_THREADS=1` before running for the one-thread numbers (polars
reads it once, at import).
"""

import json
import os
import sys
import time

import polars as pl


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


def median_ms(f, runs=7):
    out = f()  # warm-up; its result gives the checksum
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
        ms, out = median_ms(f)
        print(f"| {name} | {ms:.1f} ms | {number_check(out, column)} |", flush=True)
