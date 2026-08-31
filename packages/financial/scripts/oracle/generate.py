#!/usr/bin/env python3
"""Oracle for @pond-ts/financial studies.

Computes reference indicator values with **pandas** (the de-facto numerical
reference — the open-source stand-in for MATLAB here) and writes a golden JSON
that the vitest suite asserts our TypeScript studies against. Independent
implementation → agreement is a real cross-check.

Conventions are pinned to match @pond-ts/financial exactly (and TA-Lib where
noted) — an oracle only helps if its conventions line up:

  - SMA        close.rolling(n).mean()
  - EMA        close.ewm(span=n, adjust=False).mean()  (recursive, first-value
               seed — NOT pandas' adjust=True default), first n-1 rows masked to
               match our length-preserving `minSamples: n` warm-up.
  - Bollinger  middle = SMA(n); band = middle +/- k * rolling(n).std(ddof=0)
               (POPULATION stdev — TA-Lib's convention, not pandas' ddof=1
               default).

The input series is deterministic (sines + drift, no RNG) so regeneration is
reproducible. Realistic enough to exercise the studies; deliberately never flat,
so the sigma=0 band -> undefined case (separately unit-tested) doesn't arise.

Regenerate (CI never runs this — the JSON is committed):

    python3 -m venv .venv
    .venv/bin/pip install pandas
    .venv/bin/python packages/financial/scripts/oracle/generate.py

Phase-2 named indicators (RSI/MACD/ATR/stochastics) will add TA-Lib alongside
pandas here, documenting any definition delta (bar-for-bar vendor parity is a
non-goal).
"""

import json
import math
import pathlib

import pandas as pd

try:  # optional: the industry cross-check for the named indicators
    import numpy as np
    import talib
except ImportError:  # pragma: no cover - pandas-only venv
    talib = None

N = 80
# Deterministic close series — two sines + a slow drift.
closes = [
    round(100 + 0.15 * i + 6 * math.sin(i / 9) + 2 * math.sin(i / 3.3), 4)
    for i in range(N)
]
s = pd.Series(closes, dtype="float64")


def col(series: pd.Series) -> list:
    """A pandas Series -> JSON list; NaN / non-finite (missing) -> null."""
    return [
        None if (pd.isna(x) or not math.isfinite(float(x))) else float(x)
        for x in series
    ]


def sma(n: int) -> dict:
    return {"sma": col(s.rolling(n).mean())}


def ema(n: int) -> dict:
    e = s.ewm(span=n, adjust=False).mean()
    e.iloc[: n - 1] = math.nan  # our length-preserving warm-up (minSamples: n)
    return {"ema": col(e)}


def bollinger(n: int, k: float) -> dict:
    mid = s.rolling(n).mean()
    sd = s.rolling(n).std(ddof=0)  # population — matches us + TA-Lib
    return {
        "bbMiddle": col(mid),
        "bbUpper": col(mid + k * sd),
        "bbLower": col(mid - k * sd),
    }


def rolling_stdev(n: int) -> dict:
    return {"stdev": col(s.rolling(n).std(ddof=0))}  # population


def rolling_min(n: int) -> dict:
    return {"min": col(s.rolling(n).min())}


def rolling_max(n: int) -> dict:
    return {"max": col(s.rolling(n).max())}


def rolling_percentile(n: int, q: float) -> dict:
    # linear interpolation (pandas default) == our p{q} reducer.
    return {f"p{q}": col(s.rolling(n).quantile(q / 100))}


def zscore(n: int) -> dict:
    m = s.rolling(n).mean()
    sd = s.rolling(n).std(ddof=0)
    return {"zscore": col((s - m) / sd)}


def envelope(n: int, percent: float) -> dict:
    mid = s.rolling(n).mean()
    f = percent / 100
    return {
        "envMiddle": col(mid),
        "envUpper": col(mid * (1 + f)),
        "envLower": col(mid * (1 - f)),
    }


def envelope_ema(n: int, percent: float) -> dict:
    # maType: 'ema' — centre line is a span-EMA (adjust=False), first n-1 masked
    # (our length-preserving warm-up). Validates the emaValues kernel helper.
    mid = s.ewm(span=n, adjust=False).mean()
    mid.iloc[: n - 1] = math.nan
    f = percent / 100
    return {
        "envMiddle": col(mid),
        "envUpper": col(mid * (1 + f)),
        "envLower": col(mid * (1 - f)),
    }


def percent_change(periods: int) -> dict:
    return {"pctChange": col(s.pct_change(periods) * 100)}


def rsi(n: int) -> dict:
    """Wilder's RSI, as TA-Lib defines it.

    The seed is the definition, not a warm-up detail. Wilder averages the
    FIRST n differences arithmetically and only then runs the recursion
    avg[i] = (avg[i-1]*(n-1) + x[i]) / n. A plain first-sample-seeded EMA of
    the same alpha (1/n) is a DIFFERENT indicator: on this very input it
    lands up to 7.03 RSI points away and is still 0.15 out at bar 79.

    Computed in pandas here (so the fixture regenerates without the C
    library) and asserted against TA-Lib below when it is installed.
    """
    d = s.diff()
    up = d.clip(lower=0)
    dn = (-d).clip(lower=0)
    ag = pd.Series(math.nan, index=s.index, dtype="float64")
    al = pd.Series(math.nan, index=s.index, dtype="float64")
    ag.iloc[n] = up.iloc[1 : n + 1].mean()
    al.iloc[n] = dn.iloc[1 : n + 1].mean()
    for i in range(n + 1, len(s)):
        ag.iloc[i] = (ag.iloc[i - 1] * (n - 1) + up.iloc[i]) / n
        al.iloc[i] = (al.iloc[i - 1] * (n - 1) + dn.iloc[i]) / n
    r = 100 - 100 / (1 + ag / al)

    if talib is not None:
        ref = pd.Series(talib.RSI(np.asarray(closes, dtype=float), timeperiod=n))
        # Compare the WARM-UPS before the values. `nanmax(abs(a - b))` is blind
        # to any index where only one side is NaN — the difference there is
        # itself NaN and gets skipped — so a series emitting one bar earlier
        # than TA-Lib, with an arbitrarily wrong value in that slot, would pass
        # at 0.0. Which is precisely the off-by-one this assert exists to
        # catch, so it has to be checked as a mask, not a magnitude.
        assert list(r.isna()) == list(ref.isna()), (
            f"RSI({n}) warm-up differs from TA-Lib: "
            f"ours first valid {r.first_valid_index()}, "
            f"TA-Lib {ref.first_valid_index()}"
        )
        delta = float(np.nanmax(np.abs(r - ref)))
        assert delta < 1e-9, f"RSI({n}) disagrees with TA-Lib by {delta}"
        print(f"  rsi({n}): matches TA-Lib to {delta:.3g} (warm-ups identical)")
    else:
        print(f"  rsi({n}): pandas only - TA-Lib not installed, cross-check SKIPPED")

    return {"rsi": col(r)}


cases = [
    {"study": "sma", "params": {"period": 20}, "expected": sma(20)},
    {"study": "sma", "params": {"period": 5}, "expected": sma(5)},
    {"study": "ema", "params": {"period": 12}, "expected": ema(12)},
    {"study": "ema", "params": {"period": 26}, "expected": ema(26)},
    {
        "study": "bollinger",
        "params": {"period": 20, "stdDev": 2},
        "expected": bollinger(20, 2),
    },
    {"study": "rollingStdev", "params": {"period": 20}, "expected": rolling_stdev(20)},
    {"study": "rollingMin", "params": {"period": 20}, "expected": rolling_min(20)},
    {"study": "rollingMax", "params": {"period": 20}, "expected": rolling_max(20)},
    {
        "study": "rollingPercentile",
        "params": {"period": 20, "q": 90},
        "expected": rolling_percentile(20, 90),
    },
    {"study": "zScore", "params": {"period": 20}, "expected": zscore(20)},
    {
        "study": "envelope",
        "params": {"period": 20, "percent": 2.5},
        "expected": envelope(20, 2.5),
    },
    {
        "study": "envelope",
        "params": {"period": 20, "percent": 2.5, "maType": "ema"},
        "expected": envelope_ema(20, 2.5),
    },
    {
        "study": "percentChange",
        "params": {"periods": 1},
        "expected": percent_change(1),
    },
    {
        "study": "percentChange",
        "params": {"periods": 5},
        "expected": percent_change(5),
    },
    {"study": "rsi", "params": {"period": 14}, "expected": rsi(14)},
    {"study": "rsi", "params": {"period": 5}, "expected": rsi(5)},
]

out = {
    "meta": {
        "generator": "packages/financial/scripts/oracle/generate.py",
        "oracle": (
            f"pandas {pd.__version__}"
            + (f" + TA-Lib {talib.__version__}" if talib is not None else "")
        ),
        "conventions": {
            "sma": "close.rolling(n).mean()",
            "ema": "close.ewm(span=n, adjust=False).mean(); first n-1 masked",
            "bollingerStd": "rolling(n).std(ddof=0) [population]",
            "rsi": (
                "Wilder: seed = mean of first n diffs, then "
                "(prev*(n-1) + x)/n; cross-checked against TA-Lib"
            ),
        },
    },
    "input": {"closes": closes},
    "cases": cases,
}

path = (
    pathlib.Path(__file__).resolve().parents[2]
    / "test"
    / "fixtures"
    / "study-oracle.json"
)
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(out, indent=2) + "\n")
print(f"wrote {path.relative_to(pathlib.Path.cwd())} ({N} bars, {len(cases)} cases)")
