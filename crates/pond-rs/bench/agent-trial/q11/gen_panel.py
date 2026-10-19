"""Writes the step-4b agent-trial input (Q11 panel) as an Arrow IPC file.

  time    timestamp[ms, UTC]  one-minute bars from 2026-10-16 13:30 UTC
                              (09:30 New York), 1000 bars
  symbol  utf8                500 symbols s000..s499, rows ordered by time
                              with the symbols interleaved
  close   float64             a random walk per symbol, each symbol with
                              its own volatility

Two things make "the trailing 60 minutes" differ from "the last 60 rows":
  - ~3% of rows are missing entirely (no row for that symbol and minute);
  - 40 symbols are halted for 30 minutes shortly before the end (no rows),
    then reopen with a jump.
And ~2% of rows have no close (row present, close null), including some
symbols' last row.

Deterministic (fixed seed). Usage:
    python gen_panel.py OUT.arrow
"""

import sys

import numpy as np
import pyarrow as pa

SYMBOLS, BARS = 500, 1000
START_MS = 1_792_157_400_000  # 2026-10-16T13:30:00Z = 09:30 America/New_York
DROP_RATE = 0.03
NULL_RATE = 0.02
HALTED = 40
HALT = (965, 995)  # bars with no rows for halted symbols

rng = np.random.default_rng(20261019)
vol = rng.uniform(0.02, 0.5, SYMBOLS)
steps = rng.normal(0.0, 1.0, (BARS, SYMBOLS)) * vol
halted = rng.choice(SYMBOLS, HALTED, replace=False)
jump = rng.uniform(4.0, 10.0, HALTED) * rng.choice([-1.0, 1.0], HALTED)
steps[HALT[1], halted] += jump * vol[halted]
close = 100.0 + np.cumsum(steps, axis=0)

present = rng.random((BARS, SYMBOLS)) >= DROP_RATE
present[HALT[0] : HALT[1], halted] = False
null = rng.random((BARS, SYMBOLS)) < NULL_RATE

bar, sym = np.nonzero(present)  # row-major: ordered by time, then symbol
names = np.array([f"s{s:03d}" for s in range(SYMBOLS)])
table = pa.table(
    {
        "time": pa.array(START_MS + bar.astype(np.int64) * 60_000, pa.timestamp("ms", tz="UTC")),
        "symbol": pa.array(names[sym], pa.utf8()),
        "close": pa.array(close[bar, sym], pa.float64(), mask=null[bar, sym]),
    }
)
with pa.OSFile(sys.argv[1], "wb") as sink:
    with pa.ipc.new_file(sink, table.schema) as writer:
        writer.write_table(table)
print(f"{table.num_rows} rows, {table['close'].null_count} null closes, halted {sorted(names[halted])[:5]}...")
