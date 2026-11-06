"""Write the trial's input files into a folder (default: this one).

    python gen_data.py [DIR]

- cpu.csv: CPU readings, every 5 minutes for hosts a, b and c from
  2026-03-06 to 2026-03-10 (New York's clocks go forward on 2026-03-08).
  Header time,host,cpu; time is ISO text in UTC; some cpu cells are empty.
  Rows are shuffled within each day, as a log collected from several
  machines might be.
- bars.csv: one-minute price bars for two symbols over two days,
  header time,symbol,open,high,low,close,volume, sorted by time then symbol.

Fixed seed, so every run writes the same files.
"""

import csv
import datetime as dt
import random
import sys
from pathlib import Path

out = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent)
rng = random.Random(20261102)

start = dt.datetime(2026, 3, 6, tzinfo=dt.timezone.utc)
rows = []
for i in range(5 * 24 * 12):
    t = start + dt.timedelta(minutes=5 * i)
    for host, base in (("a", 30.0), ("b", 50.0), ("c", 70.0)):
        cpu = round(base + 20 * rng.random(), 2)
        rows.append((t, host, "" if rng.random() < 0.05 else cpu))
# Shuffle within each UTC day.
by_day = {}
for r in rows:
    by_day.setdefault(r[0].date(), []).append(r)
with open(out / "cpu.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["time", "host", "cpu"])
    for day in sorted(by_day):
        part = by_day[day]
        rng.shuffle(part)
        for t, host, cpu in part:
            w.writerow([t.strftime("%Y-%m-%dT%H:%M:%SZ"), host, cpu])

bstart = dt.datetime(2024, 3, 7, 14, 30, tzinfo=dt.timezone.utc)
price = {"AAA": 100.0, "BBB": 20.0}
with open(out / "bars.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["time", "symbol", "open", "high", "low", "close", "volume"])
    for i in range(2 * 390):
        t = bstart + dt.timedelta(minutes=i)
        for sym in ("AAA", "BBB"):
            o = price[sym]
            c = round(o * (1 + rng.gauss(0, 0.002)), 4)
            h = round(max(o, c) * (1 + abs(rng.gauss(0, 0.001))), 4)
            lo = round(min(o, c) * (1 - abs(rng.gauss(0, 0.001))), 4)
            v = rng.randint(100, 5000)
            price[sym] = c
            w.writerow([t.strftime("%Y-%m-%dT%H:%M:%SZ"), sym, o, h, lo, c, v])
