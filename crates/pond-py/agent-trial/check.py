"""Grade one run of the pond_rs docs trial.

    python check.py RUN_DIR

RUN_DIR holds the inputs (gen_data.py) and the four answers the prompt asks
for. Every expected answer is worked out here with plain pandas / Python,
not with pond_rs, so a misuse of the library shows up as a wrong answer.
Prints one line per task: right / wrong and why. Exit status 0 when all
four are right.
"""

import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd

TOL = 1e-9


def close(a, b):
    if a is None or b is None:
        return a is None and b is None
    return abs(a - b) <= TOL * max(1.0, abs(b))


def num(v):
    """A cell read as text: '' or nan is None."""
    if v is None:
        return None
    if isinstance(v, str):
        v = v.strip()
        if v == "" or v.lower() in ("nan", "none", "null"):
            return None
        return float(v)
    v = float(v)
    return None if math.isnan(v) else v


def read(path):
    return pd.read_csv(path, dtype=str, keep_default_na=False)


def cpu_sorted(run):
    df = pd.read_csv(run / "cpu.csv")
    df["time"] = pd.to_datetime(df["time"], utc=True)
    return df.sort_values(["time", "host"], kind="stable").reset_index(drop=True)


# --- task 1: per-host trailing 15-minute average ---


def expect_rolling(run):
    df = cpu_sorted(run)
    out = []
    for host, g in df.groupby("host", sort=False):
        g = g.set_index("time")
        avg = g["cpu"].rolling("15min", closed="right").mean()
        for t, v in avg.items():
            out.append((t, host, None if math.isnan(v) else float(v)))
    out.sort(key=lambda r: (r[0], r[1]))
    return out


def grade_rolling(run):
    want = expect_rolling(run)
    got = read(run / "rolling.csv")
    if list(got.columns) != ["time", "host", "cpu_avg"]:
        return False, f"columns {list(got.columns)}"
    if len(got) != len(want):
        return False, f"{len(got)} rows, want {len(want)}"
    times = pd.to_datetime(got["time"], utc=True)
    for i, (t, h, v) in enumerate(want):
        if times[i] != t or got["host"][i] != h:
            return False, f"row {i}: {got['time'][i]} {got['host'][i]}, want {t} {h}"
        if not close(num(got["cpu_avg"][i]), v):
            return False, f"row {i} ({t} {h}): cpu_avg {got['cpu_avg'][i]}, want {v}"
    return True, "ok"


# --- task 2: daily max and count per host, New York days ---


def expect_daily(run):
    df = cpu_sorted(run)
    df["day"] = df["time"].dt.tz_convert("America/New_York").dt.strftime("%Y-%m-%d")
    g = df.groupby(["day", "host"])["cpu"].agg(["max", "count"]).reset_index()
    return [(r.day, r.host, float(r.max), int(r.count)) for r in g.itertuples()]


def grade_daily(run):
    want = expect_daily(run)
    got = read(run / "daily.csv")
    if list(got.columns) != ["day", "host", "max", "count"]:
        return False, f"columns {list(got.columns)}"
    if len(got) != len(want):
        return False, f"{len(got)} rows, want {len(want)}: days {sorted(set(got['day']))}"
    for i, (d, h, m, c) in enumerate(want):
        row = got.iloc[i]
        if row["day"] != d or row["host"] != h:
            return False, f"row {i}: {row['day']} {row['host']}, want {d} {h}"
        if not close(num(row["max"]), m):
            return False, f"row {i} ({d} {h}): max {row['max']}, want {m}"
        if row["count"] != str(c):
            return False, f"row {i} ({d} {h}): count {row['count']!r}, want {c!r}"
    return True, "ok"


# --- task 3: RSI and Bollinger bands, last bar per symbol ---


def rsi_last(closes, period=14):
    d = np.diff(closes)
    gain = np.maximum(d, 0)
    loss = np.maximum(-d, 0)
    ag = gain[:period].mean()
    al = loss[:period].mean()
    for i in range(period, len(d)):
        ag = (ag * (period - 1) + gain[i]) / period
        al = (al * (period - 1) + loss[i]) / period
    return 100.0 if al == 0 else 100 - 100 / (1 + ag / al)


def expect_studies(run):
    bars = pd.read_csv(run / "bars.csv")
    out = []
    for sym, g in bars.groupby("symbol"):
        c = g["close"].to_numpy()
        last20 = c[-20:]
        mid = last20.mean()
        sd = last20.std(ddof=0)
        out.append((sym, rsi_last(c), mid + 2 * sd, mid - 2 * sd))
    return out


def grade_studies(run):
    want = expect_studies(run)
    got = read(run / "studies.csv")
    if list(got.columns) != ["symbol", "rsi", "bb_upper", "bb_lower"]:
        return False, f"columns {list(got.columns)}"
    if len(got) != len(want):
        return False, f"{len(got)} rows, want {len(want)}"
    for i, w in enumerate(want):
        row = got.iloc[i]
        if row["symbol"] != w[0]:
            return False, f"row {i}: symbol {row['symbol']}, want {w[0]}"
        for name, v in zip(("rsi", "bb_upper", "bb_lower"), w[1:]):
            # Printed values may be rounded; 1e-6 relative is plenty to tell
            # a right formula from a wrong one.
            g = num(row[name])
            if g is None or abs(g - v) > 1e-6 * max(1.0, abs(v)):
                return False, f"{w[0]} {name}: {row[name]}, want {v}"
    return True, "ok"


# --- task 4: live 30-minute buckets per host, reported as they close ---


def expect_live(run):
    df = cpu_sorted(run)
    step = 30 * 60 * 1000
    open_ = {}  # host -> [start, values]
    out = []
    for i, r in enumerate(df.itertuples()):
        t = int(r.time.value // 1_000_000)
        start = t - t % step
        b = open_.get(r.host)
        if b is not None and t >= b[0] + step:
            vals = [v for v in b[1] if v is not None]
            out.append((r.host, b[0], max(vals) if vals else None, i))
            b = None
        if b is None:
            b = open_[r.host] = [start, []]
        b[1].append(None if math.isnan(r.cpu) else float(r.cpu))
    return out


def grade_live(run):
    want = expect_live(run)
    got = read(run / "live.csv")
    if list(got.columns) != ["host", "start", "max", "closed_by"]:
        return False, f"columns {list(got.columns)}"
    if len(got) != len(want):
        return False, f"{len(got)} rows, want {len(want)}"
    for i, (h, s, m, c) in enumerate(want):
        row = got.iloc[i]
        if row["host"] != h or num(row["start"]) != s or num(row["closed_by"]) != c:
            return False, (
                f"row {i}: {row['host']} {row['start']} closed_by {row['closed_by']}, "
                f"want {h} {s} closed_by {c}"
            )
        if not close(num(row["max"]), m):
            return False, f"row {i} ({h} {s}): max {row['max']}, want {m}"
    return True, "ok"


TASKS = {
    "1 rolling": grade_rolling,
    "2 daily": grade_daily,
    "3 studies": grade_studies,
    "4 live": grade_live,
}

if __name__ == "__main__":
    run = Path(sys.argv[1])
    ok_all = True
    for name, grade in TASKS.items():
        try:
            ok, why = grade(run)
        except FileNotFoundError as e:
            ok, why = False, f"missing {Path(e.filename).name}"
        except Exception as e:  # a malformed answer is a wrong answer
            ok, why = False, f"{type(e).__name__}: {e}"
        ok_all &= ok
        print(f"task {name}: {'right' if ok else 'WRONG'} ({why})")
    sys.exit(0 if ok_all else 1)
