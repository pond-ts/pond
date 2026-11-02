"""polars side of examples/perf_grid.rs: align, materialize, dedupe.

pond's grid over a series runs from the first bucket start at or after its
first row to the bucket holding its last row. Time columns are flagged
sorted (`set_sorted`), as they are after a polars `sort("time")`; without
the flag `unique` hashes every row (~100 ms instead of ~11 ms here). polars has no single call for this, so each case is
built from the nearest polars pieces:

- align hold: `join_asof(strategy="backward")` of the grid onto the rows.
- align linear: `join_asof` backward and forward, then a straight line.
- materialize last: `group_by_dynamic` last per bucket, left join onto the
  grid (so empty buckets stay, as pond keeps them).
- materialize nearest: `join_asof(strategy="nearest")`, then rows outside the
  bucket dropped.
- dedupe: `unique(subset=time, keep="last")`; by largest `v`: sorted so the
  earliest largest row comes first, then `keep="first"`.
- align and the panel align key rows by interval (start, end, label), as
  pond does, so polars adds the end and label columns.
- Each case's answer is checked against pond-rs's (`../check_outputs.py`).
- panel cases: the same per symbol (`by="symbol"` / grouping by symbol).
"""

import numpy as np
import polars as pl

from common import run, xorshift

nxt = xorshift()
N = 1_000_000
HOSTS = list("abcdefgh")
values = []
for i in range(N):
    r = nxt()
    values.append(np.floor(r * 1000) / 8 if r >= 0.02 else None)
text = [HOSTS[i % 8] for i in range(N)]
idx = np.arange(N, dtype=np.int64)


def make(time, k=N):
    return pl.DataFrame(
        {
            "time": pl.Series(time, dtype=pl.Int64).set_sorted(),
            "v": pl.Series(values[:k], dtype=pl.Float64),
            "host": text[:k],
        }
    )


dense = make(idx * 1000 + (idx % 7) * 13)
repeats = make((idx - idx // 10) * 1000)
i10 = np.arange(10_000, dtype=np.int64)
sparse = make((i10 * 1000 + (i10 % 7) * 13) * 100, 10_000)

SYM, BARS = 500, 1000
pt, ps, pv = [], [], []
for b in range(BARS):
    for s in range(SYM):
        pt.append(b * 60_000 + (s % 5) * 7_000)
        ps.append(f"s{s:03}")
        r = nxt()
        pv.append(np.floor(r * 1000) / 8 if r >= 0.02 else None)
panel = (
    pl.DataFrame({"time": pt, "symbol": ps, "v": pl.Series(pv, dtype=pl.Float64)})
    .with_row_index("i")
    .sort("time", "i", maintain_order=True)
    .drop("i")
    .with_columns(pl.col("time").set_sorted())
)


def grid(df, step):
    t = df["time"]
    start = -(-t.min() // step) * step
    return pl.DataFrame({"time": pl.int_range(start, t.max() // step * step + 1, step, eager=True).set_sorted()})


def interval(df, step, *cols):
    # pond's align keys rows by interval: [start, end), labelled by start
    t = pl.col("time")
    return df.select(
        t.alias("interval"), (t + step).alias("intervalEnd"), *cols, t.cast(pl.Float64).alias("intervalLabel")
    )


def align_hold(df, step):
    return interval(grid(df, step).join_asof(df, on="time", strategy="backward"), step, "v", "host")


def align_linear(df, step):
    # Straight line between the row at or before each grid time and the row
    # after it; a gap in either holds the earlier row's value (pond's rule).
    rows = df.select("time", "v", "host", pl.col("time").alias("t0"))
    g = grid(df, step)
    a = g.join_asof(rows, on="time", strategy="backward")
    b = g.join_asof(rows.rename({"v": "v1", "t0": "t1"}), on="time", strategy="forward")
    t, t0, t1 = pl.col("time"), pl.col("t0"), pl.col("t1")
    v0 = pl.col("v")
    line = (
        pl.when(t0 == t).then(v0).otherwise(pl.coalesce(v0 + (pl.col("v1") - v0) * (t - t0) / (t1 - t0), v0)).alias("v")
    )
    # text can't be drawn as a line: host holds the earlier row's
    return interval(a.with_columns(b["t1"], b["v1"]), step, line, "host")


def materialize_last(df, step):
    last = df.group_by_dynamic("time", every=f"{step}i").agg(pl.all().last())
    return grid(df, step).join(last, on="time", how="left")


def materialize_nearest(df, step):
    g = grid(df, step)
    near = g.join_asof(df.with_columns(pl.col("time").alias("row_time")), on="time", strategy="nearest")
    inside = (pl.col("row_time") >= pl.col("time")) & (pl.col("row_time") < pl.col("time") + step)
    return near.select("time", pl.when(inside).then(pl.col("v")).alias("v"), pl.when(inside).then(pl.col("host")).alias("host"))


def panel_grid(step):
    t = panel["time"]
    g = pl.int_range(t.min() // step * step, t.max() // step * step + 1, step, eager=True)
    # each symbol's own span, as pond's per-partition align does. Symbols in
    # the order they first appear, and a stable sort by time after: pond's
    # collect puts rows at the same time in that partition order.
    spans = panel.group_by("symbol", maintain_order=True).agg(
        (-(-pl.col("time").min() // step) * step).alias("a"), (pl.col("time").max() // step * step).alias("b")
    )
    return (
        spans.join(pl.DataFrame({"time": g}), how="cross")
        .filter(pl.col("time").is_between("a", "b"))
        .drop("a", "b")
        .sort("time", maintain_order=True)
    )


def panel_align(step):
    out = panel_grid(step).join_asof(panel, on="time", by="symbol", strategy="backward")
    return interval(out, step, "symbol", "v")


def panel_materialize(step):
    last = panel.group_by_dynamic("time", every=f"{step}i", group_by="symbol").agg(pl.all().last())
    return panel_grid(step).join(last, on=["symbol", "time"], how="left", maintain_order="left").select("time", "symbol", "v")


def dedupe_max(df):
    # keep, per time, the row with the largest v; on a tie the earliest such
    # row, and when every v is a gap the first row (pond's rule): largest v
    # first, gaps last, a stable sort, then the first row per time
    return df.sort("time", "v", descending=[False, True], nulls_last=True, maintain_order=True).unique(
        "time", keep="first", maintain_order=True
    )


S, M = 1000, 60_000
run(
    [
        ("align hold 1m (1M rows)", lambda: align_hold(dense, M)),
        ("align hold 1s (1M rows)", lambda: align_hold(dense, S)),
        ("align linear 1s (1M rows)", lambda: align_linear(dense, S)),
        ("align hold 1s (10k rows, 1M buckets)", lambda: align_hold(sparse, S)),
        ("materialize last 1s (1M rows)", lambda: materialize_last(dense, S)),
        ("materialize nearest 1m (1M rows)", lambda: materialize_nearest(dense, M)),
        ("materialize last 1s (10k rows, 1M buckets)", lambda: materialize_last(sparse, S)),
        ("dedupe last (1M rows, 10% repeats)", lambda: repeats.unique("time", keep="last", maintain_order=True)),
        ("dedupe max v (1M rows, 10% repeats)", lambda: dedupe_max(repeats)),
        ("panel: align 1m per symbol + collect", lambda: panel_align(M)),
        ("panel: materialize 1m per symbol + collect", lambda: panel_materialize(M)),
        (
            "panel: dedupe per symbol + collect",
            lambda: panel.unique(["symbol", "time"], keep="last", maintain_order=True),
        ),
    ]
)
