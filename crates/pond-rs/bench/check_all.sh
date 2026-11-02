#!/usr/bin/env bash
# Check that pond-rs and polars give the same answers on every case
# compare_all.sh times: each runner writes its answers ($BENCH_DUMP, see
# examples/common/mod.rs), then check_outputs.py compares them cell by cell.
#
#   crates/pond-rs/bench/check_all.sh [family ...]
#
# Needs cargo and Python with polars and numpy ($PYTHON, default python3).
# Writes the answers under $OUT (default: a temp directory); they take a few
# GB. Exit status 1 if any family has a case that differs.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
PY="${PYTHON:-python3}"
OUT="${OUT:-$(mktemp -d)}"
FAMILIES=("$@")
[ ${#FAMILIES[@]} -gt 0 ] || FAMILIES=(rowwise partition grid join rolling smooth reshape value_axis reducers array json)

cargo build -q --release -p pond-rs --examples
TARGET="$(cargo metadata --format-version 1 --no-deps | "$PY" -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')"

status=0
for f in "${FAMILIES[@]}"; do
  echo "# $f" >&2
  rm -rf "$OUT/pond-rs/$f" "$OUT/polars/$f"
  BENCH_DUMP="$OUT/pond-rs/$f" "$TARGET/release/examples/perf_$f" > /dev/null || status=1
  (cd "$here/polars" && BENCH_DUMP="$OUT/polars/$f" "$PY" -W ignore "bench_$f.py" > /dev/null) || status=1
  echo "## $f"
  "$PY" "$here/check_outputs.py" "$OUT/pond-rs/$f" "$OUT/polars/$f" || status=1
done
echo "answers in $OUT" >&2
exit $status
