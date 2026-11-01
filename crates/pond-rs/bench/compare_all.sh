#!/usr/bin/env bash
# Every per-step benchmark (the R1b `examples/perf_*.rs` families) on
# pond-rs, pond-ts and polars, on this machine, several times over.
#
#   crates/pond-rs/bench/compare_all.sh [repeats] [family ...]
#
# Needs: the pond-ts build (`npm run build --workspace=pond-ts`), cargo, and
# Python with polars and numpy ($PYTHON, default python3). Writes one file
# per run under $OUT (default: a temp directory), named
# <family>/<engine>-r<repeat>.txt; `collect.py $OUT` turns them into tables.
# pond-rs and polars run twice each: one thread and every core.
# The R1a workloads (A, B) have their own runner, run.sh.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
PY="${PYTHON:-python3}"
REPEATS="${1:-3}"
START="${START:-1}" # first repeat number, to add repeats to an earlier run
shift || true
OUT="${OUT:-$(mktemp -d)}"
FAMILIES=("$@")
[ ${#FAMILIES[@]} -gt 0 ] || FAMILIES=(rowwise partition grid join rolling smooth reshape value_axis value_series reducers array json)

cargo build -q --release -p pond-rs --examples
TARGET="$(cargo metadata --format-version 1 --no-deps | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')"

{
  echo "date: $(date -u +%Y-%m-%dT%H:%MZ)"
  echo "cpu: $(lscpu | sed -n 's/^Model name: *//p'), $(nproc) cores"
  echo "node: $(node --version)"
  echo "rust: $(rustc --version)"
  echo "polars: $("$PY" -c 'import polars; print(polars.__version__)')"
  echo "commit: $(git -C "$here" rev-parse --short HEAD)"
} > "$OUT/machine.txt"

# family -> pond-rs example, pond-ts script, polars script ("" = none)
declare -A RS=([rowwise]=perf_rowwise [partition]=perf_partition [grid]=perf_grid [join]=perf_join
  [rolling]=perf_rolling [smooth]=perf_smooth [reshape]=perf_reshape [value_axis]=perf_value_axis
  [value_series]=perf_value_series [reducers]=perf_reducers [array]=perf_array [json]=perf_json)
declare -A TS=([rowwise]=rowwise_pond_ts.mjs [partition]=partition_pond_ts.mjs [grid]=grid_pond_ts.mjs
  [join]=join_pond_ts.mjs [rolling]=rolling_pond_ts.mjs [smooth]=smooth_pond_ts.mjs
  [reshape]=reshape_pond_ts.mjs [value_axis]=value_axis_pond_ts.mjs
  [value_series]=value_series_pond_ts.mjs [reducers]=reducers_pond_ts.mjs [array]=array_pond_ts.mjs
  [json]=json_pond_ts.mjs)
declare -A PL=([rowwise]=bench_rowwise.py [partition]=bench_partition.py [grid]=bench_grid.py
  [join]=bench_join.py [rolling]=bench_rolling.py [smooth]=bench_smooth.py [reshape]=bench_reshape.py
  [value_axis]=bench_value_axis.py [value_series]="" [reducers]=bench_reducers.py
  [array]=bench_array.py [json]=bench_json.py)

# A runner that fails (pond-ts can run out of heap) is reported and skipped.
try() {
  local out="$1"
  shift
  # a failed run's partial output is removed, so collect.py never counts it
  "$@" > "$out" || { echo "FAILED ($?): $*" >&2; rm -f "$out"; }
}

for r in $(seq "$START" "$REPEATS"); do
  for f in "${FAMILIES[@]}"; do
    mkdir -p "$OUT/$f"
    echo "# repeat $r: $f" >&2
    try "$OUT/$f/pond-rs-1t-r$r.txt" env RAYON_NUM_THREADS=1 "$TARGET/release/examples/${RS[$f]}"
    try "$OUT/$f/pond-rs-all-r$r.txt" "$TARGET/release/examples/${RS[$f]}"
    # rolling `samples` keeps ~280 values per row for 1M rows: past node's default heap
    try "$OUT/$f/pond-ts-r$r.txt" node --max-old-space-size=12288 "$here/${TS[$f]}"
    if [ -n "${PL[$f]}" ]; then
      try "$OUT/$f/polars-1t-r$r.txt" env -C "$here/polars" POLARS_MAX_THREADS=1 "$PY" -W ignore "${PL[$f]}"
      try "$OUT/$f/polars-all-r$r.txt" env -C "$here/polars" "$PY" -W ignore "${PL[$f]}"
    fi
  done
done
echo "results in $OUT" >&2
