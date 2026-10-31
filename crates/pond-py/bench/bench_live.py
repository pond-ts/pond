"""pond_rs.LiveSeries (Python): events pushed as they arrive, against the
same work written in plain Python.

The work: a 1-minute rolling average of `cpu` (updated on every event) and
1-minute buckets of avg / max (closed as time passes), on events 10 ms
apart. pond_rs takes the events four ways: one `push(t, cpu=c)` call per
event, `push_many` batches of 1,000 `(t, [c])` rows, `push_frame` with
10,000-row pyarrow tables, and `push_frame` into a series with nothing
built on it (storage only). Plain Python does the same work with a deque
and a dict, one event at a time. The rows, tables and lists are made before timing. Median of 5
runs after a warm-up, in milliseconds. Run with:

    python bench/bench_live.py            # 200,000 events
    python bench/bench_live.py 1000000    # another count

Checks that both sides end with the same rolling average and buckets.
"""

from __future__ import annotations

import statistics
import sys
import time
from collections import deque

import numpy as np
import pyarrow as pa

import pond_rs

N = int(sys.argv[1]) if len(sys.argv) > 1 else 200_000
STEP = 10
MINUTE = 60_000
rng = np.random.default_rng(7)
times = (np.arange(N, dtype=np.int64) * STEP).tolist()
cpus = rng.normal(50, 10, N).tolist()
SCHEMA = {"time": "time", "cpu": "number"}


def bench(f, runs=5):
    f()
    out = []
    for _ in range(runs):
        t0 = time.perf_counter()
        f()
        out.append((time.perf_counter() - t0) * 1000)
    return statistics.median(out)


def pipeline():
    live = pond_rs.LiveSeries(SCHEMA, max_age="2m")
    roll = live.rolling("1m", {"avg": ("cpu", "avg")})
    agg = live.aggregate("1m", {"avg": ("cpu", "avg"), "max": ("cpu", "max")})
    return live, roll, agg


def pond_push():
    live, roll, agg = pipeline()
    push = live.push
    for t, c in zip(times, cpus):
        push(t, cpu=c)
    return roll, agg


rows = [(t, [c]) for t, c in zip(times, cpus)]


def pond_push_many(batch=1_000):
    live, roll, agg = pipeline()
    for i in range(0, N, batch):
        live.push_many(rows[i : i + batch])
    return roll, agg


tables = [
    pa.table({"time": pa.array(times[i : i + 10_000], pa.int64()), "cpu": cpus[i : i + 10_000]})
    for i in range(0, N, 10_000)
]


def pond_push_frame():
    live, roll, agg = pipeline()
    for t in tables:
        live.push_frame(t)
    return roll, agg


def pond_store_only():
    live = pond_rs.LiveSeries(SCHEMA, max_age="2m")
    for t in tables:
        live.push_frame(t)
    return live


def plain_python():
    window = deque()
    total = 0.0
    buckets = []
    start, s, n, hi = None, 0.0, 0, -np.inf
    avg = None
    for t, c in zip(times, cpus):
        window.append((t, c))
        total += c
        while window[0][0] < t - MINUTE:
            total -= window.popleft()[1]
        avg = total / len(window)
        b = t - t % MINUTE
        if start is not None and b != start:
            buckets.append((start, s / n, hi))
            s, n, hi = 0.0, 0, -np.inf
        start = b
        s, n, hi = s + c, n + 1, max(hi, c)
    return avg, buckets


cases = {
    "push(), one call per event": pond_push,
    "push_many, 1,000-row batches": pond_push_many,
    "push_frame, 10,000-row tables": pond_push_frame,
    "push_frame, nothing built (storage only)": pond_store_only,
    "plain Python (deque + dict)": plain_python,
}

results = {name: bench(f) for name, f in cases.items()}

# The same answers.
avg, buckets = plain_python()
for f in (pond_push, pond_push_many, pond_push_frame):
    roll, agg = f()
    assert abs(roll.value()["avg"] - avg) < 1e-9, (roll.value(), avg)
    closed = [(e.begin, e["avg"], e["max"]) for e in agg.events()]
    assert len(closed) == len(buckets)
    assert all(a[0] == b[0] and abs(a[1] - b[1]) < 1e-9 and a[2] == b[2] for a, b in zip(closed, buckets))

print(f"{N:,} events, 10 ms apart; rolling 1m avg + 1m buckets (avg, max)\n")
print("| How the events go in | ms | events per second |")
print("|---|---:|---:|")
for name, ms in results.items():
    print(f"| {name} | {ms:,.1f} | {N / ms * 1000:,.0f} |")
