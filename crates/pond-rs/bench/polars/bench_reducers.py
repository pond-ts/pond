"""polars side of examples/perf_reducers.rs: 1M rows 1 s apart, `v` numbers
in runs of 40 (gap every 17th row), `host` one of 8 names in runs of 90.

Columns: aggregate into 1-minute and 1-second buckets
(`group_by_dynamic`), a trailing 5-minute and 1-day rolling window, and one
reduce over the whole series. Built from polars expressions:

- difference (largest minus smallest): `max() - min()`; rolling: rolling
  max minus rolling min.
- keep (the value when every present value is the same, else a gap):
  `n_unique() == 1`; rolling (numbers only): rolling max equals rolling min.
- unique: sorted distinct present values; top3: three most frequent
  (`value_counts`), ties in polars' order, which may differ from pond's.
  In buckets both group by (bucket, value) first, the faster way in polars;
  samples: every present value as a list.
- "-": polars has no rolling form of this reducer.

The pond-rs runner prints no checksums for this family, so these answers
are not cross-checked against pond's.
"""

import sys

import numpy as np
import polars as pl

from common import median_ms

ROWS = 1_000_000
i = np.arange(ROWS, dtype=np.int64)
raw = ((i // 40) * 7919 % 10_007) - 5000
df = pl.DataFrame(
    {
        "time": pl.Series(i * 1000).cast(pl.Datetime("ms")).set_sorted(),
        "v": pl.Series(raw / 100.0).set(pl.Series(i % 17 == 5), None),
        "host": pl.Series([f"host-{(k // 90) % 8}" for k in range(ROWS)]),
    }
)


def present(c):
    return pl.col(c).drop_nulls()


def keep(c):
    p = present(c)
    return pl.when(p.n_unique() == 1).then(p.first())


def top3(c):
    return present(c).value_counts(sort=True).struct.field(c).head(3)


def two_stage(c, every, red):
    # Faster than a list expression inside group_by_dynamic for these two
    # (top3 over 1 s buckets: ~150 ms instead of ~3 s): group by (bucket,
    # value) first, then gather each bucket's values.
    b = pl.col("time").dt.truncate(every).alias("time")
    rows = df.filter(pl.col(c).is_not_null())
    if red == "unique":
        pairs = rows.select(b, c).unique().sort("time", c)
        return pairs.group_by("time", maintain_order=True).agg(pl.col(c).alias("out"))
    counts = rows.group_by(b, c).len().sort("time", "len", descending=[False, True])
    return counts.group_by("time", maintain_order=True).agg(pl.col(c).head(3).alias("out"))


def roll(c, f, period):
    return getattr(pl.col(c), f)("time", period, closed="right")


def roll_keep(c, period):
    lo, hi = roll(c, "rolling_min_by", period), roll(c, "rolling_max_by", period)
    return pl.when(lo == hi).then(lo)


reducers = {
    "min": (lambda c: pl.col(c).min(), lambda c, p: roll(c, "rolling_min_by", p)),
    "keep": (keep, None),
    "difference": (
        lambda c: pl.col(c).max() - pl.col(c).min(),
        lambda c, p: roll(c, "rolling_max_by", p) - roll(c, "rolling_min_by", p),
    ),
    "unique": (lambda c: present(c).unique().sort(), None),
    "top3": (top3, None),
    "samples": (lambda c: present(c), None),
}
cases = [
    ("min v", "v", "min"),
    ("keep v", "v", "keep"),
    ("difference v", "v", "difference"),
    ("keep host", "host", "keep"),
    ("unique v", "v", "unique"),
    ("unique host", "host", "unique"),
    ("top3 v", "v", "top3"),
    ("top3 host", "host", "top3"),
    ("samples v", "v", "samples"),
]
only = sys.argv[1] if len(sys.argv) > 1 else None
print(f"# polars {pl.__version__}, threads {pl.thread_pool_size()}", file=sys.stderr)
print("| Reducer | agg 1m | agg 1s | rolling 5m | rolling 1d | reduce |")
print("| --- | --- | --- | --- | --- | --- |")
for name, col, red in cases:
    if only and not name.startswith(only):
        continue
    agg, rolling = reducers[red]
    if red == "keep" and col == "v":
        rolling = lambda c, p: roll_keep(c, p)  # noqa: E731
    cells = []
    for every in ("1m", "1s"):
        if red in ("unique", "top3"):
            f = lambda: two_stage(col, every, red)  # noqa: E731
        else:
            f = lambda: df.group_by_dynamic("time", every=every).agg(agg(col).alias("out"))  # noqa: E731
        cells.append(median_ms(f)[0])
    for period in ("5m", "1d"):
        if rolling is None:
            cells.append(None)
        else:
            f = lambda: df.with_columns(rolling(col, period).alias("out"))  # noqa: E731
            cells.append(median_ms(f)[0])
    cells.append(median_ms(lambda: df.select(agg(col).implode() if red in ("unique", "top3", "samples") else agg(col)))[0])
    print(f"| {name} | " + " | ".join("-" if c is None else f"{c:.1f} ms" for c in cells) + " |", flush=True)
