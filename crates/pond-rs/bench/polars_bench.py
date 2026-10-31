"""Polars side of the R1a baseline: Arrow IPC in -> compute -> Arrow IPC out.

    python polars_bench.py <workload A|B> <data.arrow> [runs] [dump-prefix]

Same shape and output as pond_ts.mjs (including how memory is measured). Thread count comes from
POLARS_MAX_THREADS (set it to 1 for the single-thread run); it is read back
from polars and reported, not assumed.
"""

import gc
import io
import json
import statistics
import sys
import time

import polars as pl

workload, path = sys.argv[1], sys.argv[2]
RUNS = int(sys.argv[3]) if len(sys.argv) > 3 else 7
DUMP = sys.argv[4] if len(sys.argv) > 4 else None
COLS = ["c0", "c1", "c2", "c3"]

# Same reducers as pond-ts. pond `count` counts present (non-missing) cells,
# like polars `count`; pond `stdev` is the population stdev, so ddof=0.
AGG = [
    e
    for c in COLS
    for e in (
        pl.col(c).mean().alias(f"{c}_avg"),
        pl.col(c).min().alias(f"{c}_min"),
        pl.col(c).max().alias(f"{c}_max"),
        pl.col(c).count().cast(pl.Float64).alias(f"{c}_count"),
    )
]


def compute(df):
    if workload == "A":
        # pond buckets are [begin, end) labelled by begin: closed/label left.
        agg = df.group_by_dynamic(
            "time", every="1m", closed="left", label="left"
        ).agg(AGG)
        # pond trailing rolling windows are (t - 5m, t]: closed right.
        roll = df.select(
            "time",
            *[
                e
                for c in COLS
                for e in (
                    pl.col(c)
                    .rolling_mean_by("time", window_size="5m", closed="right")
                    .alias(f"{c}_avg"),
                    pl.col(c)
                    .rolling_std_by(
                        "time", window_size="5m", closed="right", ddof=0
                    )
                    .alias(f"{c}_stdev"),
                )
            ],
        )
        return {"agg": agg, "roll": roll}
    if workload == "B":
        # Local calendar days in New York: 23h on the daylight-saving day.
        local = df.with_columns(
            pl.col("time").dt.convert_time_zone("America/New_York")
        )
        agg = local.group_by_dynamic(
            "time", every="1d", closed="left", label="left"
        ).agg(AGG)
        return {"agg": agg}
    raise SystemExit(f"unknown workload {workload}")


def to_ipc(df):
    buf = io.BytesIO()
    df.write_ipc(buf)
    return buf.getvalue()


def once():
    with open(path, "rb") as f:
        raw = f.read()
    t0 = time.perf_counter()
    df = pl.read_ipc(io.BytesIO(raw))
    t1 = time.perf_counter()
    out = compute(df)
    t2 = time.perf_counter()
    ipc = {k: to_ipc(v) for k, v in out.items()}
    t3 = time.perf_counter()
    return {
        "read": (t1 - t0) * 1e3,
        "compute": (t2 - t1) * 1e3,
        "write": (t3 - t2) * 1e3,
        "out": out,
        "ipc": ipc,
    }


def status_mb(field):
    with open("/proc/self/status") as f:
        line = next(l for l in f if l.startswith(field))
    return float(line[len(field):].split()[0]) / 1024


def reset_peak_mb():
    """Linux only: reset the peak resident size to the current one and return
    the current one, MB. None elsewhere. Same method in all three runners."""
    try:
        with open("/proc/self/clear_refs", "w") as f:
            f.write("5")
        return status_mb("VmRSS:")
    except OSError:
        return None


base_mb = reset_peak_mb()
warm = once()
run_mem_mb = None if base_mb is None else status_mb("VmHWM:") - base_mb
if DUMP:
    for k, b in warm["ipc"].items():
        with open(f"{DUMP}.{k}.arrow", "wb") as f:
            f.write(b)
rows = {k: v.height for k, v in warm["out"].items()}
output_mb = sum(len(b) for b in warm["ipc"].values()) / 2**20
# Keep only these numbers from the warm-up and free the rest before the
# timed runs, as every runner does, so each starts from the same state.
del warm
gc.collect()
timings = [
    {k: v for k, v in once().items() if k in ("read", "compute", "write")}
    for _ in range(RUNS)
]
med = lambda key: statistics.median(t[key] for t in timings)  # noqa: E731
total = statistics.median(t["read"] + t["compute"] + t["write"] for t in timings)
print(
    json.dumps(
        {
            "engine": "polars " + pl.__version__,
            "threads": pl.thread_pool_size(),
            "workload": workload,
            "runs": RUNS,
            "read_ms": round(med("read"), 1),
            "compute_ms": round(med("compute"), 1),
            "write_ms": round(med("write"), 1),
            "total_ms": round(total, 1),
            "run_mem_mb": None if run_mem_mb is None else round(run_mem_mb),
            "input_mb": round(len(open(path, "rb").read()) / 2**20, 1),
            "output_mb": round(output_mb, 1),
            "output_rows": rows,
        }
    )
)
