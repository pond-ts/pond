"""polars side of examples/perf_reshape.rs.

- concat: `pl.concat(parts).sort("time")` (pond's concat gives one series
  in time order; the parts interleave).
- collapse: `v + w` as a new column, dropping `v` and `w` (or keeping them).
- pivot: `DataFrame.pivot(on="host", index="time", values="v")`; one row per
  cell needs no aggregate, two use `mean` / the last present value (pond's
  `last` skips gaps; polars' `"last"` does not).
- pivot columns are named and ordered as pond's (`h0_v`, `h1_v`, `h10_v`,
  …: sorted by name).
- Each case's answer is checked against pond-rs's (`../check_outputs.py`).
- pond's collapse calls a function once a row; polars adds two columns in
  one vectorised step. Same answer, different kind of work.
"""

import numpy as np
import polars as pl

from common import run


def value(i):
    i = np.asarray(i, dtype=np.int64)
    return pl.Series(((i * 7919) % 10_007) / 8.0).set(pl.Series(i % 17 == 5), None)


def long(rows, hosts, copies):
    per = hosts * copies
    i = np.arange(rows, dtype=np.int64)
    host = ((i % per) // copies * 37) % hosts
    return pl.DataFrame(
        {
            "time": pl.Series((i // per) * 1000).set_sorted(),
            "host": pl.Series([f"h{h}" for h in host]),
            "v": value(i),
            "w": value(i + 3),
        }
    )


def parts(n, rows):
    i = np.arange(rows, dtype=np.int64)
    return [pl.DataFrame({"time": pl.Series((i * n + p) * 1000).set_sorted(), "v": value(i * n + p)}) for p in range(n)]


wide = long(1_000_000, 100, 1)
twice = long(1_000_000, 100, 2)
few = long(1_000_000, 4, 1)
ten = parts(10, 100_000)
many = parts(1000, 1000)
v, w = pl.col("v"), pl.col("w")


def pivot(df, agg=None):
    # pond names the columns `<group>_<value column>`, sorted by name
    out = df.pivot(on="host", index="time", values="v", aggregate_function=agg, sort_columns=True)
    return out.rename(lambda c: c if c == "time" else f"{c}_v")


run(
    [
        ("concat 10 x 100k", lambda: pl.concat(ten).sort("time")),
        ("concat 1000 x 1k", lambda: pl.concat(many).sort("time")),
        ("collapse sum", lambda: wide.select("time", "host", (v + w).alias("out"))),
        ("collapse_keep sum", lambda: wide.with_columns((v + w).alias("out"))),
        ("pivot 100 hosts", lambda: pivot(wide)),
        ("pivot 4 hosts", lambda: pivot(few)),
        ("pivot 100 hosts x2 avg", lambda: pivot(twice, "mean")),
        ("pivot 100 hosts x2 last", lambda: pivot(twice, pl.element().drop_nulls().last())),
    ]
)
