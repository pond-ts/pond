"""Writes the R1a benchmark input as an Arrow IPC file.

One table, shared by every runner (pond-ts, polars, pond-rs), so all of them
read the same bytes:

  time   timestamp[ms, UTC]  1 s apart, starting 2026-03-03 00:00 New York
                             time, so 1M rows (~11.6 days) span the
                             2026-03-08 DST change
  c0..c3 float64             random walks, each with ~5% nulls placed
                             independently, plus three 10-minute outages
                             where all four are null (rows still present),
                             so some 1m buckets and 5m rolling windows hold
                             no values at all; one outage starts at the
                             DST change (2026-03-08 07:00 UTC)

Deterministic (fixed seed). Usage:
    python gen_data.py OUT.arrow [ROWS]
"""

import sys

import numpy as np
import pyarrow as pa

ROWS = int(sys.argv[2]) if len(sys.argv) > 2 else 1_000_000
START_MS = 1_772_514_000_000  # 2026-03-03T05:00:00Z = 00:00 America/New_York
GAP_RATE = 0.05
OUTAGE_ROWS = 600  # 10 minutes: longer than a 1m bucket and a 5m window
OUTAGE_STARTS = [200_000, 439_200, 700_000]  # 439_200 s after start = DST change

rng = np.random.default_rng(20261017)
time = pa.array(START_MS + np.arange(ROWS, dtype=np.int64) * 1000, pa.timestamp("ms", tz="UTC"))
columns = {"time": time}
for c in range(4):
    walk = 100.0 + np.cumsum(rng.normal(0.0, 0.1, ROWS))
    mask = rng.random(ROWS) < GAP_RATE
    for start in OUTAGE_STARTS:
        mask[start : start + OUTAGE_ROWS] = True
    columns[f"c{c}"] = pa.array(walk, pa.float64(), mask=mask)

table = pa.table(columns)
with pa.OSFile(sys.argv[1], "wb") as sink, pa.ipc.new_file(sink, table.schema) as writer:
    writer.write_table(table)
print(f"wrote {ROWS} rows to {sys.argv[1]}", file=sys.stderr)
