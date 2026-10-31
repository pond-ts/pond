#!/usr/bin/env bash
# Sets up the R1a agent trial (see README.md) in a fresh directory.
#
#   crates/pond-rs/bench/agent-trial/setup.sh <trial-dir> <data.arrow> [runs per side]
#
# Makes <trial-dir>/runs/{pondrs,polars}-NN, each a Cargo project with the
# library already a dependency, data.arrow linked in, and attempt.sh, which
# logs every build-and-run to .attempts. The pond-rs agents get a copy of the
# crate's src/ and manifest only: tests/, examples/ and bench/ hold worked
# answers to this task.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
crate="$(cd "$here/../.." && pwd)"
T="$(mkdir -p "$1" && cd "$1" && pwd)"
DATA="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
RUNS="${3:-10}"
POLARS_VERSION=0.55.2
# polars 0.55.2 does not build with "ipc" unless "parquet" is also on.
# A trial can set its own features and project name (q11/ does).
POLARS_FEATURES="${POLARS_FEATURES:-\"lazy\", \"ipc\", \"parquet\", \"temporal\", \"timezones\", \"dynamic_group_by\", \"dtype-datetime\"}"
NAME="${NAME:-daily}"

mkdir -p "$T/pond-rs"
cp -r "$crate/src" "$T/pond-rs/"
# A standalone manifest: no workspace inheritance, no dev-dependencies.
sed -e '/\.workspace = true/d' -e 's/^description = .*/&\nedition = "2024"/' \
    -e '/^\[dev-dependencies\]/,$d' "$crate/Cargo.toml" > "$T/pond-rs/Cargo.toml"

for side in pondrs polars; do
  for i in $(seq -w 1 "$RUNS"); do
    d="$T/runs/$side-$i"
    mkdir -p "$d/src" "$d/.cargo"
    ln -sf "$DATA" "$d/data.arrow"
    if [ "$side" = pondrs ]; then
      dep="pond-rs = { path = \"$T/pond-rs\" }"
    else
      dep="polars = { version = \"=$POLARS_VERSION\", features = [$POLARS_FEATURES] }"
    fi
    printf '[package]\nname = "%s_%s_%s"\nversion = "0.1.0"\nedition = "2024"\n\n[dependencies]\n%s\n' \
      "$NAME" "$side" "$i" "$dep" > "$d/Cargo.toml"
    # One build directory per side, so dependencies compile once.
    printf '[build]\ntarget-dir = "%s"\n' "$T/target-$side" > "$d/.cargo/config.toml"
    echo 'fn main() {}' > "$d/src/main.rs"
    cat > "$d/attempt.sh" <<'SH'
#!/usr/bin/env bash
# Builds and runs your program: cargo run --release -- data.arrow out.arrow
cd "$(dirname "$0")"
rm -f out.arrow
start=$(date +%s)
cargo run --release -q -- data.arrow out.arrow > last_attempt.txt 2>&1; code=$?
echo "$(( $( [ -f .attempts ] && wc -l < .attempts || echo 0) + 1 )) exit=$code secs=$(( $(date +%s) - start ))" >> .attempts
cat last_attempt.txt; exit $code
SH
    chmod +x "$d/attempt.sh"
  done
done
echo "$T"
