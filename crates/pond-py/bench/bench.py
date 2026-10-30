"""pond_rs (Python) against polars and pandas on the same frames.

Each case starts from a pyarrow table and ends with a frame of the library's
own kind, so getting data in and out is part of every number. Median of 7
runs after one warm-up, in milliseconds. Run with:

    python bench/bench.py            # 1M rows
    python bench/bench.py 100000     # another size

Prints a markdown table and checks pond_rs's answers against polars where
both compute the same thing.
"""

from __future__ import annotations

import statistics
import sys
import threading
import time

import numpy as np
import pandas as pd
import polars as pl
import pyarrow as pa

import pond_rs

N = int(sys.argv[1]) if len(sys.argv) > 1 else 1_000_000
HOSTS = 100
STAMP = pa.timestamp("ms", tz="UTC")
rng = np.random.default_rng(7)

table = pa.table(
    {
        "time": pa.array(np.arange(N, dtype=np.int64) * 1000).cast(STAMP),
        "cpu": pa.array(rng.normal(50, 10, N)),
        "mem": pa.array(rng.normal(70, 5, N)),
        "host": pa.array([f"h{i % HOSTS}" for i in range(N)]),
    }
)
numbers = table.select(["time", "cpu", "mem"])
pdf = table.to_pandas()
pnum = numbers.to_pandas()


def bench(f, runs=7):
    f()
    times = []
    for _ in range(runs):
        t0 = time.perf_counter()
        f()
        times.append((time.perf_counter() - t0) * 1000)
    return statistics.median(times)


def pond_series(t=numbers):
    return pond_rs.TimeSeries(t, name="s")


cases = {}

# Round trip: frame in, frame out, nothing done.
cases["Round trip (in + out)"] = (
    lambda: pond_series().to_pyarrow(),
    lambda: pl.from_arrow(numbers).to_arrow(),
    lambda: pa.Table.from_pandas(pa.Table.to_pandas(numbers)),
)

cases["Rolling 5-minute avg"] = (
    lambda: pond_series().rolling("5m", {"cpu": "avg", "mem": "avg"}).to_polars(),
    lambda: pl.from_arrow(numbers).with_columns(
        pl.col("cpu").rolling_mean_by("time", "5m", closed="right"),
        pl.col("mem").rolling_mean_by("time", "5m", closed="right"),
    ),
    lambda: pnum.rolling("5min", on="time")[["cpu", "mem"]].mean(),
)

cases["Aggregate into 1-minute buckets"] = (
    lambda: pond_series().aggregate("1m", {"cpu": "avg", "mem": "max"}).to_polars(),
    lambda: pl.from_arrow(numbers)
    .group_by_dynamic("time", every="1m")
    .agg(pl.col("cpu").mean(), pl.col("mem").max()),
    lambda: pnum.resample("1min", on="time").agg({"cpu": "mean", "mem": "max"}),
)

ny = pond_rs.Sequence.calendar("day", "America/New_York")
cases["Daily buckets in New York"] = (
    lambda: pond_series().aggregate(ny, {"cpu": "avg"}).to_polars(),
    lambda: pl.from_arrow(numbers)
    .with_columns(pl.col("time").dt.convert_time_zone("America/New_York"))
    .group_by_dynamic("time", every="1d")
    .agg(pl.col("cpu").mean()),
    lambda: pnum.assign(time=pnum["time"].dt.tz_convert("America/New_York"))
    .resample("1D", on="time")["cpu"]
    .mean(),
)

cases["diff"] = (
    lambda: pond_series().diff(["cpu", "mem"]).to_polars(),
    lambda: pl.from_arrow(numbers).with_columns(pl.col("cpu").diff(), pl.col("mem").diff()),
    lambda: pnum.assign(cpu=pnum["cpu"].diff(), mem=pnum["mem"].diff()),
)

cases[f"Rolling 5m per host ({HOSTS} hosts)"] = (
    lambda: pond_rs.TimeSeries(table)
    .partition_by("host")
    .rolling("5m", {"cpu": "avg"})
    .collect()
    .to_polars(),
    lambda: pl.from_arrow(table).with_columns(
        pl.col("cpu").rolling_mean_by("time", "5m", closed="right").over("host")
    ),
    lambda: pdf.groupby("host").rolling("5min", on="time")["cpu"].mean(),
)


def check():
    """pond_rs gives polars's numbers where both compute the same thing."""
    a = pond_series().rolling("5m", {"cpu": "avg"}).to_polars()["cpu"].to_numpy()
    b = (
        pl.from_arrow(numbers)
        .select(pl.col("cpu").rolling_mean_by("time", "5m", closed="right"))["cpu"]
        .to_numpy()
    )
    roll = float(np.max(np.abs(a - b)))
    a = pond_series().aggregate("1m", {"cpu": "avg"}).to_polars()["cpu"].to_numpy()
    b = pl.from_arrow(numbers).group_by_dynamic("time", every="1m").agg(pl.col("cpu").mean())["cpu"].to_numpy()
    agg = float(np.max(np.abs(a - b)))
    a = pond_series().aggregate(ny, {"cpu": "avg"}).to_polars()["cpu"].to_numpy()
    b = (
        pl.from_arrow(numbers)
        .with_columns(pl.col("time").dt.convert_time_zone("America/New_York"))
        .group_by_dynamic("time", every="1d")
        .agg(pl.col("cpu").mean())["cpu"]
        .to_numpy()
    )
    day = float(np.max(np.abs(a - b)))
    return roll, agg, day


def threads():
    """Four Python threads each running a rolling average: pond_rs lets go
    of Python's lock while it works, so they overlap."""
    s = pond_series()
    one = bench(lambda: s.rolling("5m", {"cpu": "avg"}), runs=5)

    def four():
        ts = [threading.Thread(target=lambda: s.rolling("5m", {"cpu": "avg"})) for _ in range(4)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()

    return one, bench(four, runs=5)


if __name__ == "__main__":
    print(f"{N:,} rows; pond_rs {pond_rs.__version__}, polars {pl.__version__}, pandas {pd.__version__}, pyarrow {pa.__version__}\n")
    print("| Case (ms) | pond_rs | polars | pandas |")
    print("|---|---:|---:|---:|")
    for name, fs in cases.items():
        cells = [f"{bench(f):.1f}" for f in fs]
        print(f"| {name} | " + " | ".join(cells) + " |")
    roll, agg, day = check()
    print(f"\nLargest difference from polars: rolling {roll:.2e}, 1-minute {agg:.2e}, New York days {day:.2e}")
    one, four = threads()
    print(f"One rolling call {one:.1f} ms; four at once from four Python threads {four:.1f} ms")
