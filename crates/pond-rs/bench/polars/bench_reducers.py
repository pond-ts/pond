"""polars side of examples/perf_reducers.rs: 1M rows 1 s apart, `v` numbers
in runs of 40 (gap every 17th row), `host` one of 8 names in runs of 90.

Columns: aggregate into 1-minute and 1-second buckets
(`group_by_dynamic`), a trailing 5-minute and 1-day rolling window, and one
reduce over the whole series. Each cell returns what pond returns and is
checked against pond-rs's (`../check_outputs.py`):

- buckets are keyed by interval (start, end, label = start), as pond keys
  them; every bucket is kept, including those whose values are all gaps
  (pond gives those a gap, or an empty list for the list reducers).
- rolling gives the time and `out`; reduce gives one row, `out`.

Built from polars expressions:

- difference (largest minus smallest): `max() - min()`; rolling: rolling
  max minus rolling min.
- keep (the value when every present value is the same, else a gap):
  `n_unique() == 1`; rolling on numbers: rolling max equals rolling min;
  on text the same, on each name's categorical code (polars has no
  rolling min / max of text; the general `DataFrame.rolling` with
  `n_unique` over a 1-day window, 86,400 rows, did not finish in 10 minutes).
- unique: sorted distinct present values. top3: the three most frequent
  present values, ties broken by value (smaller first), as pond does.
  In buckets both group by (bucket, value) first, the faster way in polars
  (top3 over 1 s buckets: ~150 ms instead of ~3 s); rolling: the general
  `DataFrame.rolling` with a list expression.
- samples: every present value as a list. Its 5-minute rolling answer (~280
  values a row, 1M rows) is too big to write out whole, so both sides write
  each row's list length, sum, first and last value instead.
- "-": not timed (pond-rs leaves out the 1-day window for list reducers).
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
STEP = {"1m": pl.duration(minutes=1), "1s": pl.duration(seconds=1)}
t = pl.col("time")


def interval(out, every):
    return out.select(
        t.alias("interval"), (t + STEP[every]).alias("intervalEnd"), "out", t.dt.epoch("ms").cast(pl.Float64).alias("intervalLabel")
    )


def present(c):
    return pl.col(c).drop_nulls()


def keep(c):
    p = present(c)
    return pl.when(p.n_unique() == 1).then(p.first())


def two_stage(c, every, red):
    # group by (bucket, value) first, then gather each bucket's values; a
    # bucket whose values are all gaps keeps a row (an empty list)
    b = t.dt.truncate(every).alias("time")
    if red == "unique":
        pairs = df.select(b, c).unique().sort("time", c)
        out = pairs.group_by("time", maintain_order=True).agg(pl.col(c).drop_nulls().alias("out"))
    else:
        counts = df.group_by(b, c).len().sort(["time", "len", c], descending=[False, True, False])
        out = counts.group_by("time", maintain_order=True).agg(pl.col(c).drop_nulls().head(3).alias("out"))
    return interval(out, every)


def roll(c, f, period):
    return getattr(pl.col(c), f)("time", period, closed="right")


def roll_keep(c, period):
    lo, hi = roll(c, "rolling_min_by", period), roll(c, "rolling_max_by", period)
    return pl.when(lo == hi).then(lo)


reducers = {
    "min": (lambda c: pl.col(c).min(), lambda c, p: df.select(t, roll(c, "rolling_min_by", p).alias("out"))),
    "keep": (keep, None),
    "difference": (
        lambda c: pl.col(c).max() - pl.col(c).min(),
        lambda c, p: df.select(t, (roll(c, "rolling_max_by", p) - roll(c, "rolling_min_by", p)).alias("out")),
    ),
    "unique": (
        lambda c: present(c).unique().sort(),
        lambda c, p: df.rolling("time", period=p, closed="right").agg(present(c).unique().sort().alias("out")),
    ),
    "top3": (None, None),
    "samples": (
        lambda c: present(c),
        lambda c, p: df.rolling("time", period=p, closed="right").agg(present(c).alias("out")),
    ),
}


def roll_keep_text(c, p):
    # polars has no rolling min / max of text: give each name a number
    # (its categorical code), and where the window's smallest and largest
    # numbers agree every present name is the same one, which is then the
    # last present name (carried forward to this row)
    code = pl.col("_code")
    lo = code.rolling_min_by("time", p, closed="right")
    hi = code.rolling_max_by("time", p, closed="right")
    return df.with_columns(pl.col(c).cast(pl.Categorical).to_physical().alias("_code")).select(
        t, pl.when(lo == hi).then(pl.col(c).forward_fill()).alias("out")
    )


def top3_expr(c):
    # the three most frequent present values, ties by value (smaller first):
    # runs of the sorted values (so in value order), then a stable sort by
    # run length. (A `value_counts` here is evaluated twice, once for the
    # rows and once for the sort keys, in different hash orders, so the
    # sort scrambles it; sorted runs come out the same both times.)
    runs = present(c).sort().rle()
    return runs.sort_by(runs.struct.field("len"), descending=True, maintain_order=True).struct.field("value").head(3)


def rolling_top3(c, p):
    return df.rolling("time", period=p, closed="right").agg(top3_expr(c).alias("out"))


def reduce_top3(c):
    counts = df.select(present(c).value_counts()).unnest(c).sort(["count", c], descending=[True, False]).head(3)
    return counts.select(pl.col(c).implode().alias("out"))


def digest(out):
    """Each row's list as its length, sum, first and last value."""
    o = pl.col("out")
    return out.select(
        "time",
        o.list.len().cast(pl.Float64).alias("len"),
        o.list.sum().alias("sum"),
        o.list.first().alias("first"),
        o.list.last().alias("last"),
    )


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
LISTS = ("unique", "top3", "samples")
only = sys.argv[1] if len(sys.argv) > 1 else None
print(f"# polars {pl.__version__}, threads {pl.thread_pool_size()}", file=sys.stderr)
print("| Reducer | agg 1m | agg 1s | rolling 5m | rolling 1d | reduce |")
print("| --- | --- | --- | --- | --- | --- |")
for name, col, red in cases:
    if only and not name.startswith(only):
        continue
    agg, rolling = reducers[red]
    if red == "keep":
        rolling = (lambda c, p: df.select(t, roll_keep(c, p).alias("out"))) if col == "v" else roll_keep_text  # noqa: E731
    if red == "top3":
        rolling = rolling_top3
    cells = []
    for every in ("1m", "1s"):
        if red in ("unique", "top3"):
            f = lambda: two_stage(col, every, red)  # noqa: E731
        else:
            f = lambda: interval(df.group_by_dynamic("time", every=every).agg(agg(col).alias("out")), every)  # noqa: E731
        cells.append(median_ms(f, name=f"{name}, agg {every}")[0])
    for period in ("5m", "1d"):
        if red in LISTS and period == "1d":
            cells.append(None)
            continue
        f = lambda: rolling(col, period)  # noqa: E731
        dump = digest if red == "samples" else None
        cells.append(median_ms(f, name=f"{name}, rolling {period}", dump=dump)[0])
    if red == "top3":
        f = lambda: reduce_top3(col)  # noqa: E731
    else:
        f = lambda: df.select((agg(col).implode() if red in LISTS else agg(col)).alias("out"))  # noqa: E731
    cells.append(median_ms(f, name=f"{name}, reduce")[0])
    print(f"| {name} | " + " | ".join("-" if c is None else f"{c:.1f} ms" for c in cells) + " |", flush=True)
