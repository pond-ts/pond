"""polars side of examples/perf_rolling.rs: 1M rows 1 s apart, `v` with a
gap every 17th row, `host` one of 8 names in runs of 90.

Every case returns what pond returns (the key and `out`; `host` too when
split by host) and is checked against pond-rs's (`../check_outputs.py`).

- trailing time windows: `rolling_mean_by("time", "5m", closed="right")`,
  pond's `(t - 5m, t]`.
- leading `[t, t + 5m)` and centred `[t - 2.5m, t + 2.5m)` time windows:
  polars' `rolling_*_by` only looks back, so these use the general
  `DataFrame.rolling(period="5m", offset=…, closed="left")`.
- row windows: `rolling_*(20, min_samples=1)`. Centred over an even count:
  polars puts the extra row before the centre, pond after (149 before and
  150 after for 300 rows), so the column is reversed, rolled centred and
  reversed back.
- minimum rows: pond's minimum counts rows in the window, gaps included;
  polars' `min_samples` counts present values. So rows: a gap for the first
  19 rows; time: a rolling count of rows (`rolling_sum_by` of ones) must
  reach 300.
- grid windows: `group_by_dynamic(every=1m or 1s, period=5m)`, windows
  ending at each grid time, keyed by interval as pond keys them.
"""

import numpy as np
import polars as pl

from common import run


def make(rows):
    i = np.arange(rows, dtype=np.int64)
    v = pl.Series(((i * 7919) % 10_007) / 8.0).set(pl.Series(i % 17 == 5), None)
    return pl.DataFrame(
        {
            "time": pl.Series(i * 1000).cast(pl.Datetime("ms")).set_sorted(),
            "v": v,
            "host": pl.Series([f"host-{(k // 90) % 8}" for k in range(rows)]),
        }
    )


big = make(1_000_000)
small = make(100_000)
v = pl.col("v")


def by_time(df, f):
    return df.select("time", f.alias("out"))


def general(df, offset, f):
    # leading and centred windows, [t + offset, t + offset + 5m)
    return df.rolling("time", period="5m", offset=offset, closed="left").agg(f.alias("out"))


def rows_min(df, n):
    return df.select("time", pl.when(pl.int_range(pl.len()) >= n - 1).then(v.rolling_mean(n, min_samples=1)).alias("out"))


def time_min(df, n):
    rows = pl.repeat(1.0, pl.len()).rolling_sum_by("time", "5m", closed="right")
    return df.select("time", pl.when(rows >= n).then(v.rolling_mean_by("time", "5m", closed="right")).alias("out"))


def grid(df, every):
    # group_by_dynamic adds windows past the last row; pond's grid stops at it
    end = df["time"].max()
    step = pl.duration(minutes=1) if every == "1m" else pl.duration(seconds=1)
    t = pl.col("time")
    return (
        df.group_by_dynamic("time", every=every, period="5m", offset="-5m", closed="right", label="right")
        .agg(v.mean().alias("out"))
        .filter(t <= end)
        .select(t.alias("interval"), (t + step).alias("intervalEnd"), "out", t.dt.epoch("ms").cast(pl.Float64).alias("intervalLabel"))
    )


run(
    [
        ("time 5m avg trailing", lambda: by_time(big, v.rolling_mean_by("time", "5m", closed="right"))),
        ("time 5m avg leading", lambda: general(big, "0s", v.mean())),
        ("time 5m avg centered", lambda: general(big, "-150s", v.mean())),
        ("time 5m stdev centered", lambda: general(big, "-150s", v.std(ddof=0))),
        ("time 5m avg min 300", lambda: time_min(big, 300)),
        ("rows 20 avg", lambda: by_time(big, v.rolling_mean(20, min_samples=1))),
        ("rows 20 avg min 20", lambda: rows_min(big, 20)),
        ("rows 20 stdev", lambda: by_time(big, v.rolling_std(20, min_samples=1, ddof=0))),
        (
            "rows 300 avg centered",
            lambda: by_time(big, v.reverse().rolling_mean(300, min_samples=1, center=True).reverse()),
        ),
        (
            "rows 20 avg by host",
            lambda: big.select("time", v.rolling_mean(20, min_samples=1).over("host").alias("out"), "host"),
        ),
        ("grid 1m, 5m avg, 100k rows", lambda: grid(small, "1m")),
        ("grid 1m, 5m avg, 1M rows", lambda: grid(big, "1m")),
        ("grid 1s, 5m avg, 1M rows", lambda: grid(big, "1s")),
    ],
    column="out",
)
