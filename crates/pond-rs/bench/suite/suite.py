"""Polars and pond-rs-from-Python sides of the six-engine benchmark suite.

    python suite.py polars  [rows] [case id]
    python suite.py pond-py [rows] [case id]

Same data and the same cases as `examples/suite.rs`; see README.md. Prints

    RESULT <tab> case id <tab> median ms <tab> rows out <tab> sum

where `sum` is the total of every present value in the result's number
columns. Timing: one warm-up call, then the median of 7.

The polars forms are the ones `bench/polars/*.py` uses for the same
operations, which were checked against pond's answers cell by cell, with one
difference: results keyed by an interval keep only its start time here, not
pond's three key columns.

Threads: set POLARS_MAX_THREADS and RAYON_NUM_THREADS before running; the
driver (`run.sh`) runs everything with both set to 1 and again unset.
"""

import statistics
import sys
import time

import numpy as np
import polars as pl

ENGINE = sys.argv[1]
ROWS = int(sys.argv[2]) if len(sys.argv) > 2 else 1_000_000
ONLY = sys.argv[3] if len(sys.argv) > 3 else None

i = np.arange(ROWS, dtype=np.int64)
HOSTS = [f"host-{h}" for h in range(8)]


def value(k):
    k = np.asarray(k, dtype=np.int64)
    return pl.Series(((k * 7919) % 10_007) / 8.0).set(pl.Series(k % 17 == 5), None)


def host(k):
    return pl.Series(np.array(HOSTS)[(np.asarray(k) // 90) % 8])


def frame(times):
    return pl.DataFrame({"time": pl.Series(times).set_sorted(), "v": value(i), "host": host(i)})


# Times are whole milliseconds. The time-window cases need a datetime column
# in polars; the grid and join cases use the integers, as bench/polars does.
even = frame(i * 1000)
even_dt = even.with_columns(pl.col("time").cast(pl.Datetime("ms")).set_sorted())
uneven = frame(i * 1000 + (i % 7) * 13)
repeats = frame((i - i // 10) * 1000)
other = pl.DataFrame({"time": pl.Series(i * 1500).set_sorted(), "w": value(i + 1), "tag": host(i + 1)})
wide = pl.DataFrame(
    {
        "time": pl.Series((i // 100) * 1000).set_sorted(),
        "host": pl.Series([f"h{((k % 100) * 37) % 100}" for k in range(ROWS)]),
        "v": value(i),
        "w": value(i + 3),
    }
)

v, w = pl.col("v"), pl.col("w")
STEP = 1000


def grid(df):
    t = df["time"]
    start = -(-t.min() // STEP) * STEP
    return pl.DataFrame({"time": pl.int_range(start, t.max() // STEP * STEP + 1, STEP, eager=True).set_sorted()})


def align_linear(df):
    # A straight line between the row at or before each grid time and the
    # row after it; a gap in either holds the earlier row's value (pond's
    # rule). Text holds the earlier row's.
    rows = df.select("time", "v", "host", pl.col("time").alias("t0"))
    g = grid(df)
    a = g.join_asof(rows, on="time", strategy="backward")
    b = g.join_asof(rows.rename({"v": "v1", "t0": "t1"}), on="time", strategy="forward")
    t, t0, t1 = pl.col("time"), pl.col("t0"), pl.col("t1")
    line = pl.when(t0 == t).then(v).otherwise(pl.coalesce(v + (pl.col("v1") - v) * (t - t0) / (t1 - t0), v)).alias("v")
    return a.with_columns(b["t1"], b["v1"]).select("time", line, "host")


def roll_grid(df):
    # group_by_dynamic adds windows past the last row; pond's grid stops there
    end = df["time"].max()
    return (
        df.group_by_dynamic("time", every="1s", period="5m", offset="-5m", closed="right", label="right")
        .agg(v.mean().alias("out"))
        .filter(pl.col("time") <= end)
    )


POLARS = {
    "agg_1m": lambda: even_dt.group_by_dynamic("time", every="1m").agg(v.mean().alias("out")),
    "roll_5m": lambda: even_dt.select("time", v.rolling_mean_by("time", "5m", closed="right").alias("out")),
    "roll_20": lambda: even.select("time", v.rolling_mean(20, min_samples=1).alias("out")),
    "roll_20_sd": lambda: even.select("time", v.rolling_std(20, min_samples=1, ddof=0).alias("out")),
    "roll_20_host": lambda: even.select("time", v.rolling_mean(20, min_samples=1).over("host").alias("out"), "host"),
    "roll_grid": lambda: roll_grid(even_dt),
    "diff": lambda: even.with_columns(v.diff()),
    "fill": lambda: even.with_columns(v.interpolate()),
    "cumsum": lambda: even.with_columns(v.cum_sum().forward_fill()),
    "filter": lambda: even.filter(v > 500),
    "add": lambda: wide.with_columns((v + w).alias("out")),
    "align_hold": lambda: grid(uneven).join_asof(uneven, on="time", strategy="backward"),
    "align_linear": lambda: align_linear(uneven),
    "dedupe": lambda: repeats.unique("time", keep="last", maintain_order=True),
    "join_left": lambda: even.join(other, on="time", how="left", maintain_order="left"),
    "pivot": lambda: wide.pivot(on="host", index="time", values="v", sort_columns=True),
}


def polars_check(out):
    total = 0.0
    for name, kind in out.schema.items():
        if kind == pl.Float64:
            total += out[name].sum()
    return out.height, total


def pond_cases():
    # The module is `pond` from 0.79 (the PyPI package `pond-timeseries`);
    # it was `pond_rs` before.
    try:
        import pond as pond_rs
    except ImportError:
        import pond_rs
    Sequence, TimeSeries, col = pond_rs.Sequence, pond_rs.TimeSeries, pond_rs.col

    def series(df, name):
        return TimeSeries(df.with_columns(pl.col("time").cast(pl.Datetime("ms"))), name=name, key="time")

    s_even, s_uneven, s_repeats = series(even, "even"), series(uneven, "uneven"), series(repeats, "repeats")
    s_other, s_wide = series(other, "other"), series(wide, "wide")
    minute, second = Sequence.every("1m"), Sequence.every("1s")
    avg, stdev = {"out": ("v", "avg")}, {"out": ("v", "stdev")}
    cases = {
        "agg_1m": lambda: s_even.aggregate(minute, avg),
        "roll_5m": lambda: s_even.rolling("5m", avg),
        "roll_20": lambda: s_even.rolling(20, avg),
        "roll_20_sd": lambda: s_even.rolling(20, stdev),
        "roll_20_host": lambda: s_even.partition_by("host").rolling(20, avg).collect(),
        "roll_grid": lambda: s_even.rolling("5m", avg, over=second),
        "diff": lambda: s_even.diff("v"),
        "fill": lambda: s_even.fill("linear"),
        "cumsum": lambda: s_even.cumulative({"v": "sum"}),
        "filter": lambda: s_even.filter(col("v") > 500),
        "add": lambda: s_wide.with_column("out", col("v") + col("w")),
        "align_hold": lambda: s_uneven.align(second),
        "align_linear": lambda: s_uneven.align(second, method="linear"),
        "dedupe": lambda: s_repeats.dedupe("last"),
        "join_left": lambda: s_even.join(s_other, how="left"),
        "pivot": lambda: s_wide.pivot_by_group("host", "v"),
    }

    def check(out):
        frame = out.to_polars()
        total = 0.0
        for name in out.columns:
            if frame.schema[name] == pl.Float64:
                total += frame[name].sum()
        return len(out), total

    return cases, check, getattr(pond_rs, "__version__", "")


if ENGINE == "polars":
    cases, check = POLARS, polars_check
    print(f"VERSION\tpolars\t{pl.__version__}\tthreads {pl.thread_pool_size()}")
elif ENGINE == "pond-py":
    cases, check, version = pond_cases()
    print(f"VERSION\tpond-py\t{version}")
else:
    sys.exit(f"unknown engine {ENGINE!r}: use polars or pond-py")

for name, f in cases.items():
    if ONLY and name != ONLY:
        continue
    try:
        rows, total = check(f())
        times = []
        for _ in range(7):
            start = time.perf_counter()
            f()
            times.append((time.perf_counter() - start) * 1000)
        print(f"RESULT\t{name}\t{statistics.median(times):.3f}\t{rows}\t{total!r}", flush=True)
    except Exception as error:  # one failing case must not hide the rest
        print(f"SKIP\t{name}\t{type(error).__name__}: {str(error)[:200]}", flush=True)
