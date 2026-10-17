#!/usr/bin/env bash
# R1a baseline: pond-ts and polars on the same Arrow file, workloads A and B.
#
#   crates/pond-rs/bench/run.sh [runs]
#
# Needs: the pond-ts build (`npm run build --workspace=pond-ts`), Node with the
# repo's node_modules (apache-arrow), and Python with polars, pyarrow, numpy
# ($PYTHON, default python3). Writes data and outputs under $BENCH_DIR
# (default: a temp directory) and prints one JSON line per run.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
PY="${PYTHON:-python3}"
RUNS="${1:-7}"
DIR="${BENCH_DIR:-$(mktemp -d)}"
DATA="$DIR/data.arrow"

[ -f "$DATA" ] || "$PY" "$here/gen_data.py" "$DATA"
echo "# cores: $(nproc), data: $DATA" >&2

for W in A B; do
  node "$here/pond_ts.mjs" "$W" "$DATA" "$RUNS" "$DIR/pond_$W"
  POLARS_MAX_THREADS=1 "$PY" "$here/polars_bench.py" "$W" "$DATA" "$RUNS" "$DIR/polars_$W"
  "$PY" "$here/polars_bench.py" "$W" "$DATA" "$RUNS"
done

"$PY" "$here/compare.py" "$DIR/pond_A" "$DIR/polars_A" agg roll >&2
"$PY" "$here/compare.py" "$DIR/pond_B" "$DIR/polars_B" agg >&2
