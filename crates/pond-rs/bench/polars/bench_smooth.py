"""polars side of examples/perf_smooth.rs: 1M rows 1 s apart, `v` with a
gap every 17th row.

- EMA: `ewm_mean(adjust=False, ignore_nulls=True)`, gap rows kept as gaps
  (pond's EMA skips gaps and leaves them empty).
- moving average: `rolling_mean_by("time", "5m")`, pond's trailing window.
- baseline: rolling mean and population stdev, band 2 stdevs either side
  (gaps in the band where the stdev is 0, as pond).
- outliers: the rows outside a 1.5-stdev band.
- scan running sum: `fill_null(0).cum_sum()` (pond carries the sum
  through gaps).
- centred moving average keeping gaps: the general
  `DataFrame.rolling(period="5m", offset="-150s", closed="left")` (pond's
  `[t - 2.5m, t + 2.5m)`), gap rows left as gaps.
- sample: `gather_every(10, offset=9)` (pond keeps every tenth row from the
  tenth); `sample(1000, seed=1)` then sorted back into time order, as pond
  returns its reservoir. The picks differ from pond's (different random
  numbers), so that case's answer is checked only for shape.
- No polars counterpart: range keys, loess, a scan with a custom state (the
  "gain" case).
- Each case returns what pond returns (key and value columns, with the new
  column where pond puts it) and is checked against pond-rs's
  (`../check_outputs.py`).
"""

import numpy as np
import polars as pl

from common import run

ROWS = 1_000_000
i = np.arange(ROWS, dtype=np.int64)
big = pl.DataFrame(
    {
        "time": pl.Series(i * 1000).cast(pl.Datetime("ms")).set_sorted(),
        "v": pl.Series(((i * 7919) % 10_007) / 8.0).set(pl.Series(i % 17 == 5), None),
    }
)
v = pl.col("v")


def ema(**kw):
    e = v.ewm_mean(adjust=False, ignore_nulls=True, **kw)
    return big.with_columns(pl.when(v.is_not_null()).then(e).alias("out"))


def centered_skip():
    m = big.rolling("time", period="5m", offset="-150s", closed="left").agg(v.mean().alias("out"))
    return big.with_columns(pl.when(v.is_not_null()).then(m["out"]).alias("out"))


def band():
    avg = v.rolling_mean_by("time", "5m", closed="right")
    sd = v.rolling_std_by("time", "5m", closed="right", ddof=0)
    return avg.alias("avg"), sd.alias("sd")


def baseline():
    b = big.with_columns(*band())
    up = pl.when(pl.col("sd") > 0).then(pl.col("avg") + 2 * pl.col("sd"))
    lo = pl.when(pl.col("sd") > 0).then(pl.col("avg") - 2 * pl.col("sd"))
    return b.with_columns(up.alias("out"), lo.alias("lower"))


def outliers():
    b = big.with_columns(*band())
    far = (v - pl.col("avg")).abs() > 1.5 * pl.col("sd")
    return b.filter(far & (pl.col("sd") > 0)).drop("avg", "sd")


cases = [
    ("ema alpha 0.1", "out", lambda: ema(alpha=0.1)),
    ("ema span 20 min 20", "out", lambda: ema(span=20, min_samples=20)),
    (
        "moving average 5m",
        "out",
        lambda: big.with_columns(v.rolling_mean_by("time", "5m", closed="right").alias("out")),
    ),
    ("moving average 5m centered skip", "out", centered_skip),
    ("baseline 5m", "out", baseline),
    ("outliers 5m", "v", outliers),
    ("scan sum", "out", lambda: big.with_columns(v.fill_null(0).cum_sum().alias("out"))),
    ("sample stride 10", "v", lambda: big.gather_every(10, offset=9)),
    ("sample reservoir 1000", "v", lambda: big.sample(1000, seed=1).sort("time")),
]
for name, column, f in cases:
    run([(name, f)], column=column)
