"""Polars counterpart to `perf-compare.py`.

pandas answers "how fast is the tool a practitioner would otherwise reach
for". Polars answers a sharper question: **how fast is this work when the
kernels are Rust?**

That makes it the most relevant external number this project has. The
Rust/WASM spike (`spikes/columnar-wasm/`) asked whether porting pond-ts's
substrate to Rust would pay; polars is that port, done by someone else,
against the same workload. Where polars is far ahead, a Rust core has
headroom to chase. Where it is close, the remaining gap is not about the
language.

**Conventions match `perf-compare.py` and `generate.py` exactly**, so all
three sides answer the same question:
  - `min_periods=period` (length-preserving warm-up, null head)
  - population standard deviation (`ddof=0`)
  - the same bollinger / z-score / envelope / percent-change formulas

Two places polars needs care to stay honest:

  - **`ddof`**: polars' `rolling_std` defaults to `ddof=1` (sample), pandas
    to `ddof=1` too, and the oracle pins `ddof=0` (population). Passed
    explicitly here rather than relying on a default.
  - **Laziness**: a polars expression builds a plan and does nothing. Timing
    `df.with_columns(...)` without collecting would measure plan
    construction. Everything here runs eagerly on a `DataFrame`, which is
    what the equivalent user code does, and the result is materialised.

Run:
    /tmp/pondvenv/bin/python packages/financial/scripts/oracle/perf-compare-polars.py
"""

import json
import os
import time

import numpy as np
import polars as pl

BARS = int(os.environ.get("PERF_BARS", 500_000))
REPEATS = int(os.environ.get("PERF_REPEATS", 15))
MINUTE_NS = 60_000_000_000


def make_bars(n: int) -> pl.DataFrame:
    """The same random-walk shape the other two benchmarks build. The exact
    values do not matter for timing, only the size and the distribution."""
    seed = 0x5EED
    opens = np.empty(n, dtype=np.float64)
    highs = np.empty(n, dtype=np.float64)
    lows = np.empty(n, dtype=np.float64)
    closes = np.empty(n, dtype=np.float64)
    vols = np.empty(n, dtype=np.float64)

    def rnd() -> float:
        nonlocal seed
        seed = (seed + 0x6D2B79F5) & 0xFFFFFFFF
        seed2 = (seed * 1103515245 + 12345) & 0x7FFFFFFF
        return seed2 / 0x7FFFFFFF

    price = 100.0
    for i in range(n):
        drift = (rnd() - 0.5) * 0.4
        o = price
        c = max(1.0, price + drift)
        opens[i] = o
        closes[i] = c
        highs[i] = max(o, c) + rnd() * 0.2
        lows[i] = min(o, c) - rnd() * 0.2
        vols[i] = int(rnd() * 10_000)
        price = c

    return pl.DataFrame(
        {
            "time": np.arange(n, dtype=np.int64) * MINUTE_NS,
            "open": opens,
            "high": highs,
            "low": lows,
            "close": closes,
            "volume": vols,
        }
    )


def bench(label: str, group: str, fn, repeats: int = REPEATS) -> dict:
    # No JIT to warm, but the first calls pay allocator and thread-pool
    # warm-up — polars runs multi-threaded, so its pool has to spin up.
    for _ in range(3):
        fn()
    samples = []
    for _ in range(repeats):
        start = time.perf_counter()
        fn()
        samples.append((time.perf_counter() - start) * 1000.0)
    samples.sort()
    return {
        "group": group,
        "label": label,
        "medianMs": round(samples[len(samples) // 2], 3),
        "minMs": round(samples[0], 3),
        "maxMs": round(samples[-1], 3),
    }


def main() -> None:
    df = make_bars(BARS)
    results = []

    # `select` on an eager DataFrame runs immediately and materialises, which
    # is the honest equivalent of the other two sides producing a column.
    def sma(period: int):
        return df.select(
            pl.col("close").rolling_mean(period, min_samples=period)
        )

    def ema(period: int):
        # `adjust=False` matches the oracle's ewm convention; the warm-up
        # head is then blanked so the column is length-preserving like ours.
        return df.select(
            pl.when(pl.int_range(pl.len()) >= period - 1)
            .then(pl.col("close").ewm_mean(span=period, adjust=False))
            .otherwise(None)
        )

    def bollinger(period: int, k: float = 2.0):
        middle = pl.col("close").rolling_mean(period, min_samples=period)
        # ddof=0 — population, matching the oracle. Polars defaults to 1.
        sd = pl.col("close").rolling_std(period, min_samples=period, ddof=0)
        return df.select(
            middle.alias("bbMiddle"),
            (middle + k * sd).alias("bbUpper"),
            (middle - k * sd).alias("bbLower"),
        )

    def zscore(period: int):
        middle = pl.col("close").rolling_mean(period, min_samples=period)
        sd = pl.col("close").rolling_std(period, min_samples=period, ddof=0)
        return df.select(((pl.col("close") - middle) / sd).alias("zscore"))

    def pct_change():
        return df.select((pl.col("close").pct_change() * 100.0).alias("pc"))

    def envelope(period: int, pct: float = 0.02):
        middle = pl.col("close").rolling_mean(period, min_samples=period)
        return df.select(
            middle.alias("envMiddle"),
            (middle * (1 + pct)).alias("envUpper"),
            (middle * (1 - pct)).alias("envLower"),
        )

    for label, fn in [
        ("sma(20)", lambda: sma(20)),
        ("sma(200)", lambda: sma(200)),
        ("ema(20)", lambda: ema(20)),
        ("bollinger(20)", lambda: bollinger(20)),
        ("zScore(20)", lambda: zscore(20)),
        ("percentChange()", lambda: pct_change()),
        ("envelope(20)", lambda: envelope(20)),
    ]:
        results.append(bench(label, "study", fn))

    def stack():
        m20 = pl.col("close").rolling_mean(20, min_samples=20)
        sd20 = pl.col("close").rolling_std(20, min_samples=20, ddof=0)
        return df.with_columns(
            m20.alias("sma20"),
            pl.col("close").rolling_mean(50, min_samples=50).alias("sma50"),
            pl.col("close").rolling_mean(200, min_samples=200).alias("sma200"),
            m20.alias("bbMiddle"),
            (m20 + 2.0 * sd20).alias("bbUpper"),
            (m20 - 2.0 * sd20).alias("bbLower"),
            ((pl.col("close") - m20) / sd20).alias("zscore"),
        )

    results.append(
        bench("stack: sma20+sma50+sma200+bollinger+zscore", "strategy", stack, 5)
    )

    close = df["close"]
    for label, fn in [
        ("close.minMax()", lambda: (close.min(), close.max())),
        ("close.mean()", lambda: close.mean()),
        ("close.stdev()", lambda: close.std(ddof=0)),
        ("close.median()", lambda: close.median()),
        ("close.percentile(95)", lambda: close.quantile(0.95)),
        (
            "volume.sum() + close.minMax()",
            lambda: (df["volume"].sum(), close.min(), close.max()),
        ),
    ]:
        results.append(bench(label, "summary", fn, 25))

    # Ingest: matched to pond's `fromColumns` over typed buffers — all
    # sides adopt numeric arrays rather than convert rows. Arrays are
    # prepared outside the timed body. MUST stay the last group, in the
    # same position as in perf-agent-queries.mjs — the vs-* printers zip
    # by index.
    arrays = {c: df[c].to_numpy() for c in df.columns}
    results.append(
        bench(
            "ingest: 6 numeric columns, typed adopt",
            "ingest",
            lambda: pl.DataFrame(arrays),
            25,
        )
    )

    print(
        json.dumps(
            {
                "bars": BARS,
                "polars": pl.__version__,
                "threads": pl.thread_pool_size(),
                "results": results,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
