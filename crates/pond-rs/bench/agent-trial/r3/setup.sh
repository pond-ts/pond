#!/usr/bin/env bash
# Sets up the R3 step 7 agent trial (see README.md) in a fresh directory.
#
#   crates/pond-rs/bench/agent-trial/r3/setup.sh <trial-dir> <events.csv> [runs per side]
#
# Makes <trial-dir>/runs/{pondrs,plain}-NN, each a Cargo project with
# events.csv linked in and attempt.sh, which logs every build-and-run to
# .attempts. pond-rs runs get the crate as a dependency (a copy of its src/
# and manifest only: tests/, examples/ and bench/ hold worked answers);
# plain runs get no dependencies. One build directory per side, so pond-rs
# compiles once (build it before starting agents). Each run's prompt is written to prompt.txt
# beside it.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
crate="$(cd "$here/../../.." && pwd)"
T="$(mkdir -p "$1" && cd "$1" && pwd)"
DATA="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
RUNS="${3:-10}"

mkdir -p "$T/pond-rs"
cp -r "$crate/src" "$T/pond-rs/"
sed -e '/\.workspace = true/d' -e 's/^description = .*/&\nedition = "2024"/' \
    -e '/^\[dev-dependencies\]/,$d' "$crate/Cargo.toml" > "$T/pond-rs/Cargo.toml"

for side in pondrs plain; do
  for i in $(seq -w 1 "$RUNS"); do
    d="$T/runs/$side-$i"
    mkdir -p "$d/src" "$d/.cargo"
    ln -sf "$DATA" "$d/events.csv"
    if [ "$side" = pondrs ]; then
      deps="pond-rs = { path = \"$T/pond-rs\" }"
      lib="pond-rs crate's live layer (\`pond_rs::live\`)"
      dep=" with that dependency in \`Cargo.toml\` (you may add other dependencies if you need them)."
      src="the library's source code ($T/pond-rs) and "
    else
      deps=""
      lib="Rust standard library only (no other crates)"
      dep="."
      src=""
    fi
    printf '[package]\nname = "r3_%s_%s"\nversion = "0.1.0"\nedition = "2024"\n\n[dependencies]\n%s\n' \
      "$side" "$i" "$deps" > "$d/Cargo.toml"
    printf '[build]\ntarget-dir = "%s"\n' "$T/target-$side" > "$d/.cargo/config.toml"
    echo 'fn main() {}' > "$d/src/main.rs"
    cat > "$d/attempt.sh" <<'SH'
#!/usr/bin/env bash
# Builds and runs your program: cargo run --release -- events.csv out.csv
cd "$(dirname "$0")"
rm -f out.csv
start=$(date +%s)
cargo run --release -q -- events.csv out.csv > last_attempt.txt 2>&1; code=$?
echo "$(( $( [ -f .attempts ] && wc -l < .attempts || echo 0) + 1 )) exit=$code secs=$(( $(date +%s) - start ))" >> .attempts
cat last_attempt.txt; exit $code
SH
    chmod +x "$d/attempt.sh"
    python3 - "$here/prompt.txt" "$d/prompt.txt" "$d" "$lib" "$dep" "$src" <<'PY'
import sys
p, out, d, lib, dep, src = sys.argv[1:]
t = open(p).read().replace("{DIR}", d).replace("{LIB}", lib).replace("{DEP}", dep).replace("{SRC}", src)
open(out, "w").write(t)
PY
  done
done
echo "$T"
