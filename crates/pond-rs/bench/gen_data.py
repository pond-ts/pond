"""Writes the R1a benchmark input as an Arrow IPC file.

One table, shared by every runner (pond-ts, polars, pond-rs), so all of them
read the same bytes:

  time   timestamp[ms, UTC]  1 s apart, starting 2026-03-03 00:00 New York
                             time, so 1M rows (~11.6 days) span the
                             2026-03-08 DST change
  c0..c3 float64             random walks, each with ~5% nulls placed
                             independently

Deterministic (fixed seed). Usage:
    python gen_data.py OUT.arrow [ROWS]
"""

import sys

import numpy as np
import pyarrow as pa

ROWS = int(sys.argv[2]) if len(sys.argv) > 2 else 1_000_000
START_MS = 1_772_514_000_000  # 2026-03-03T05:00:00Z = 00:00 America/New_York
GAP_RATE = 0.05

rng = np.random.default_rng(20261017)
time = pa.array(START_MS + np.arange(ROWS, dtype=np.int64) * 1000, pa.timestamp("ms", tz="UTC"))
columns = {"time": time}
for c in range(4):
    walk = 100.0 + np.cumsum(rng.normal(0.0, 0.1, ROWS))
    mask = rng.random(ROWS) < GAP_RATE
    columns[f"c{c}"] = pa.array(walk, pa.float64(), mask=mask)

table = pa.table(columns)
with pa.OSFile(sys.argv[1], "wb") as sink, pa.ipc.new_file(sink, table.schema) as writer:
    writer.write_table(table)
print(f"wrote {ROWS} rows to {sys.argv[1]}", file=sys.stderr)
