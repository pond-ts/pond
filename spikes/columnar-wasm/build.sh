#!/usr/bin/env bash
# Builds the columnar substrate to wasm32-unknown-unknown, twice:
#
#   pkg/pond_columnar.wasm       baseline wasm MVP (no SIMD)
#   pkg/pond_columnar.simd.wasm  +simd128
#
# Two binaries rather than one runtime-feature-detecting build because
# wasm has no runtime feature dispatch — SIMD is a *module-level*
# validation property. A module using v128 instructions fails to
# validate on an engine without SIMD, so shipping SIMD means shipping
# two artifacts and picking at load time. That packaging cost is part
# of the go/no-go, so the spike pays it up front.
#
# No wasm-pack, no wasm-bindgen, no npm postinstall — just cargo.
set -euo pipefail
cd "$(dirname "$0")"

TARGET=wasm32-unknown-unknown
OUT=pkg
mkdir -p "$OUT"

# -Zbuild-std would shrink this further but needs nightly; the spike
# stays on stable so the numbers reflect what we could actually ship.
COMMON_FLAGS="-C panic=abort"

echo "→ building baseline (wasm MVP)…"
RUSTFLAGS="$COMMON_FLAGS" \
  cargo build --release --target "$TARGET" --quiet
cp "target/$TARGET/release/pond_columnar.wasm" "$OUT/pond_columnar.wasm"

echo "→ building simd128…"
RUSTFLAGS="$COMMON_FLAGS -C target-feature=+simd128" \
  cargo build --release --target "$TARGET" --target-dir target-simd --quiet
cp "target-simd/$TARGET/release/pond_columnar.wasm" "$OUT/pond_columnar.simd.wasm"

echo "→ building opt-level=z (size datapoint)…"
RUSTFLAGS="$COMMON_FLAGS" \
  cargo build --profile small --target "$TARGET" --target-dir target-small --quiet
cp "target-small/$TARGET/small/pond_columnar.wasm" "$OUT/pond_columnar.small.wasm"

echo
echo "artifact sizes:"
for f in "$OUT"/*.wasm; do
  raw=$(wc -c <"$f" | tr -d ' ')
  gz=$(gzip -9 -c "$f" | wc -c | tr -d ' ')
  br=$(command -v brotli >/dev/null 2>&1 && brotli -q 11 -c "$f" | wc -c | tr -d ' ' || echo "n/a")
  printf "  %-34s %8s B raw  %8s B gzip  %8s B brotli\n" "$(basename "$f")" "$raw" "$gz" "$br"
done
