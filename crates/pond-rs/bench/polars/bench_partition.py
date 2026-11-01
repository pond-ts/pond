"""polars side of examples/perf_partition.rs: 500 symbols x 1000 one-minute
bars (500k rows, symbols interleaved, ~2% gaps).

pond's partition ops give back one series in time order; polars window
expressions (`.over("symbol")`) keep the input's row order, which is already
time order here, so no extra sort is needed to match "collect".

Each case's answer is checked against pond-rs's (`../check_outputs.py`).
"""

import polars as pl

from common import run, xorshift

SYMBOLS, BARS = 500, 1000
nxt = xorshift()
time, sym, close = [], [], []
walk = [100.0] * SYMBOLS
for b in range(BARS):
    for s in range(SYMBOLS):
        walk[s] += nxt() - 0.5
        time.append(b * 60_000)
        sym.append(f"s{s:03}")
        close.append(walk[s] if nxt() >= 0.02 else None)
df = pl.DataFrame(
    {
        "time": pl.Series(time, dtype=pl.Int64).cast(pl.Datetime("ms")),
        "symbol": sym,
        "close": pl.Series(close, dtype=pl.Float64),
    }
)
print(f"{df.height} rows, {df['close'].null_count()} gaps, sum {df['close'].sum()}")
c = pl.col("close")


def rolled():
    # pond's trailing window is (t - 60m, t]; polars closed="right" is the
    # same. The third output is pond's `last` reducer on `close`: the last
    # present close inside the window (a gap if none). polars has no
    # rolling "last present" by time, so: carry the last present close and
    # its time forward per symbol, and keep it while that time is inside
    # the window. Columns in pond's order (key, outputs, then the
    # partition column).
    t = pl.col("time")
    seen = pl.when(c.is_not_null()).then(t).forward_fill().over("symbol")
    last = pl.when(seen > t - pl.duration(minutes=60)).then(c.forward_fill().over("symbol"))
    return df.select(
        t,
        c.rolling_mean_by("time", "60m", closed="right").over("symbol").alias("mean"),
        c.rolling_std_by("time", "60m", closed="right", ddof=0).over("symbol").alias("sd"),
        last.alias("close"),
        "symbol",
    )


def q11():
    last = rolled().group_by("symbol").last()
    z = (
        last.filter(pl.col("sd") > 0)
        .with_columns(((c - pl.col("mean")) / pl.col("sd")).alias("z"))
        .drop_nulls("z")
        .sort(pl.col("z").abs(), descending=True)
        .head(20)
        .select("symbol", "z")
    )
    assert z.height == 20
    return z


run(
    [
        ("split", lambda: df.partition_by("symbol", as_dict=True)),
        ("diff + collect", lambda: df.with_columns(c.diff().over("symbol"))),
        ("fill linear + collect", lambda: df.with_columns(c.interpolate().over("symbol"))),
        ("rolling 60m mean/sd + collect", rolled),
        ("Q11: rolling 60m, last z per symbol, top 20", q11),
    ]
)
