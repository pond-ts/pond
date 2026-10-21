"""polars side of examples/perf_rolling.rs: 1M rows 1 s apart, `v` with a
gap every 17th row, `host` one of 8 names in runs of 90.

- time windows: `rolling_*_by("time", "5m", closed="right")`, pond's
  trailing `(t - 5m, t]`. polars has no leading or centred time window, so
  those cases have no polars number.
- row windows: `rolling_*(20)`; centred: `center=True`.
- pond's minimum counts rows in the window, polars' `min_samples` counts
  present values: not the same answer, so the "min" cases are left out.
- grid windows: `group_by_dynamic(every=1m or 1s, period=5m)`, windows
  ending at each grid time.
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
    return df.with_columns(f.alias("out"))


def grid(df, every):
    # group_by_dynamic adds windows past the last row; pond's grid stops at it
    end = df["time"].max()
    return (
        df.group_by_dynamic("time", every=every, period="5m", offset="-5m", closed="right", label="right")
        .agg(v.mean().alias("out"))
        .filter(pl.col("time") <= end)
    )


run(
    [
        ("time 5m avg trailing", lambda: by_time(big, v.rolling_mean_by("time", "5m", closed="right"))),
        ("rows 20 avg", lambda: by_time(big, v.rolling_mean(20, min_samples=1))),
        ("rows 20 stdev", lambda: by_time(big, v.rolling_std(20, min_samples=1, ddof=0))),
        ("rows 300 avg centered", lambda: by_time(big, v.rolling_mean(300, min_samples=1, center=True))),
        ("rows 20 avg by host", lambda: by_time(big, v.rolling_mean(20, min_samples=1).over("host"))),
        ("grid 1m, 5m avg, 100k rows", lambda: grid(small, "1m")),
        ("grid 1m, 5m avg, 1M rows", lambda: grid(big, "1m")),
        ("grid 1s, 5m avg, 1M rows", lambda: grid(big, "1s")),
    ],
    column="out",
)
