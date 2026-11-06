"""polars side of examples/perf_value_axis.rs: binning by a number column.

- width bins: `group_by(floor(x / width))`, then the bin's `start` / `end`.
- zones (edges, upper end inclusive): `cut(..., left_closed=False)`; every
  value here lies in 0..1300, so the open outer bins stay empty.
- percentiles: `quantile(q, "linear")`.
- Each case's answer is checked against pond-rs's (`../check_outputs.py`).
- No polars counterpart: `rolling_by_column` (a window over a float
  column; polars' `rolling_*_by` needs a time or integer column).
"""

import numpy as np
import polars as pl

from common import run

ROWS = 1_000_000
i = np.arange(ROWS, dtype=np.int64)
s = pl.DataFrame(
    {
        "time": pl.Series(i * 1000).set_sorted(),
        "dist": pl.Series(i / 100.0).set(pl.Series(i % 23 == 7), None),
        "watts": pl.Series(((i * 7919) % 10_007) / 8.0).set(pl.Series(i % 17 == 5), None),
    }
)
w = pl.col("watts")
counts = [w.count().cast(pl.Float64).alias("n"), w.sum().alias("sum"), w.mean().alias("avg")]
spread = [w.quantile(0.05, "linear").alias("p5"), w.quantile(0.95, "linear").alias("p95")]


def by_width(col, width, aggs):
    b = (pl.col(col) / width).floor()
    return (
        s.filter(pl.col(col).is_not_null())
        .group_by(b.alias("bin"))
        .agg(aggs)
        .sort("bin")
        .select((pl.col("bin") * width).alias("start"), ((pl.col("bin") + 1) * width).alias("end"), pl.exclude("bin"))
    )


def zones():
    edges = [0.0, 200.0, 400.0, 600.0, 800.0, 1000.0, 1300.0]
    z = w.cut(edges[1:-1], left_closed=False).alias("zone")
    out = s.filter(w.is_not_null()).group_by(z).agg(counts).sort("zone")
    return out.select(pl.Series("start", edges[:-1]), pl.Series("end", edges[1:]), pl.exclude("zone"))


run(
    [
        ("by_column width 10, 1000 bins", lambda: by_width("dist", 10.0, counts)),
        ("by_column 6 zones", zones),
        ("by_column histogram, 1251 bins", lambda: by_width("watts", 1.0, counts[:1])),
        ("by_column width 10, p5 p95", lambda: by_width("dist", 10.0, spread)),
    ]
)
