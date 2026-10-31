"""Writes the R2 step-5 agent-trial input as an Arrow IPC file.

  time    timestamp[ms, UTC]  one-minute bars, bar open time, 04:00-20:00
                              New York (pre-market, regular hours and
                              after-hours) on the ten weekdays 2024-03-04
                              to 2024-03-15. The US clock change
                              (2024-03-10) moves the 09:30 open from 14:30
                              to 13:30 UTC.
  open, high, low, close   float64  a random walk in cents
  volume  float64             heavier in regular hours

No missing rows or values. Deterministic (fixed seed). Usage:
    python gen_bars.py OUT.arrow
"""

import sys
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import numpy as np
import pyarrow as pa

NY = ZoneInfo("America/New_York")
rng = np.random.default_rng(20261023)

times = []
day = date(2024, 3, 4)
while day <= date(2024, 3, 15):
    if day.weekday() < 5:
        start = datetime(day.year, day.month, day.day, 4, 0, tzinfo=NY)
        for k in range(16 * 60):
            t = (start + timedelta(minutes=k)).astimezone(timezone.utc)
            times.append(int(t.timestamp() * 1000))
    day += timedelta(days=1)
n = len(times)
local_minute = np.array(
    [(datetime.fromtimestamp(t / 1000, NY).hour * 60 + datetime.fromtimestamp(t / 1000, NY).minute) for t in times]
)
regular = (local_minute >= 570) & (local_minute < 960)

step = rng.normal(0.0, 0.06, n) * np.where(regular, 1.0, 0.4)
close = np.round(180.0 + np.cumsum(step), 2)
open_ = np.round(np.concatenate([[180.0], close[:-1]]) + rng.normal(0, 0.01, n), 2)
high = np.round(np.maximum(open_, close) + np.abs(rng.normal(0, 0.04, n)), 2)
low = np.round(np.minimum(open_, close) - np.abs(rng.normal(0, 0.04, n)), 2)
volume = np.round(np.where(regular, rng.uniform(2_000, 30_000, n), rng.uniform(50, 2_000, n)))

# RSI is undefined on a perfectly flat 14-bar window; keep the data clear of one.
flat = np.convolve((np.diff(close) == 0).astype(int), np.ones(14, int), "valid")
assert flat.max() < 14

table = pa.table(
    {
        "time": pa.array(times, pa.timestamp("ms", tz="UTC")),
        "open": pa.array(open_, pa.float64()),
        "high": pa.array(high, pa.float64()),
        "low": pa.array(low, pa.float64()),
        "close": pa.array(close, pa.float64()),
        "volume": pa.array(volume, pa.float64()),
    }
)
with pa.OSFile(sys.argv[1], "wb") as sink:
    with pa.ipc.new_file(sink, table.schema) as writer:
        writer.write_table(table)
print(f"{n} rows, {int(regular.sum())} in regular hours")
