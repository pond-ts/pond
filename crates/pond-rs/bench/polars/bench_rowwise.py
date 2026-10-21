"""polars side of examples/perf_rowwise.rs: 1M rows 1 s apart, ~5% gaps."""

import numpy as np
import polars as pl

from common import run, xorshift

ROWS = 1_000_000
nxt = xorshift()
v = [None] * ROWS
gap = 0
for i in range(ROWS):
    if gap == 0 and nxt() < 0.02:
        gap = 1 + int(nxt() * 4)
    if gap > 0:
        gap -= 1
    else:
        v[i] = (i % 1000) + nxt()
df = pl.DataFrame(
    {
        "time": pl.Series(np.arange(ROWS, dtype=np.int64) * 1000).cast(pl.Datetime("ms")),
        "v": pl.Series(v, dtype=pl.Float64),
    }
)
print(f"{ROWS} rows, {df['v'].null_count()} gaps, sum {df['v'].sum()}")
extra = df["v"].fill_null(float("nan")).alias("w")
v_ = pl.col("v")
secs = pl.col("time").diff().dt.total_milliseconds() / 1000

run(
    [
        ("diff", lambda: df.with_columns(v_.diff())),
        ("diff drop", lambda: df.with_columns(v_.diff()).slice(1)),
        ("rate", lambda: df.with_columns(v_.diff() / secs)),
        ("pct_change", lambda: df.with_columns(v_.pct_change())),
        ("cumulative sum", lambda: df.with_columns(v_.cum_sum())),
        ("shift 1", lambda: df.with_columns(v_.shift(1))),
        ("fill hold", lambda: df.with_columns(v_.forward_fill())),
        ("fill linear", lambda: df.with_columns(v_.interpolate())),
        ("filter v > 500 (by name)", lambda: df.filter(v_ > 500)),
        ("map_numbers v * 2", lambda: df.with_columns(v_ * 2)),
        ("with_column", lambda: df.with_columns(extra)),
        ("slice middle half", lambda: df.slice(250_000, 500_000)),
    ]
)
