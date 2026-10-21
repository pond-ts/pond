"""polars side of examples/perf_join.rs: joins on time.

pond's default join is an outer join that keeps one time column; polars
`how="full", coalesce=True` is the same shape, sorted by time after (pond
gives time order). `joinMany` is two chained joins. Time columns are
flagged sorted.
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
values = pl.Series(values, dtype=pl.Float64)
text = pl.Series([HOSTS[i % 8] for i in range(N)])


def make(time, col, txt, shift):
    k = len(time)
    idx = (np.arange(k) + shift) % N
    return pl.DataFrame(
        {
            "time": pl.Series(time, dtype=pl.Int64).set_sorted(),
            col: values.gather(idx),
            txt: text.gather(idx),
        }
    )


i = np.arange(N, dtype=np.int64)
a = make(i * 1000, "v", "host", 0)
b = make(i * 1500, "w", "tag", 1)
c = make(i * 1000, "x", "c_host", 2)
d = make(i * 1000, "y", "d_host", 3)
sparse = make(np.arange(10_000, dtype=np.int64) * 100_000, "w", "tag", 4)


def join(x, y, how, same_keys=False):
    if how == "full":
        out = x.join(y, on="time", how="full", coalesce=True, maintain_order="left_right")
        # rows only on the right come last; when both sides share every time
        # there are none, so the result is already in time order
        return out if same_keys else out.sort("time")
    return x.join(y, on="time", how=how, maintain_order="left")


run(
    [
        ("left join, 1M x 1M, 1/3 match", lambda: join(a, b, "left")),
        ("inner join, 1M x 1M", lambda: join(a, b, "inner")),
        ("outer join, 1M x 1M", lambda: join(a, b, "full")),
        ("left join, 1M x 10k sparse", lambda: join(a, sparse, "left")),
        ("outer join, same keys", lambda: join(a, c, "full", True)),
        ("joinMany 3 on same keys", lambda: join(join(a, c, "full", True), d, "full", True)),
    ]
)
