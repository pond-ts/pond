#!/usr/bin/env bash
# Build crates/pond-wasm to WebAssembly and generate the JS glue in pkg/.
# Needs: rustup target wasm32-unknown-unknown, and wasm-bindgen-cli at the
# version crates/pond-wasm/Cargo.toml pins (cargo install wasm-bindgen-cli
# --version 0.2.129).
#
# One glue for every platform: wasm-bindgen's `web` target, an ES module
# with an explicit init. wasm.node.js inits it synchronously from the file;
# wasm.browser.js fetches it with a top-level await (package.json `imports`
# picks one by the `node` condition).
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd ../.. && pwd)
TARGET_DIR=${CARGO_TARGET_DIR:-$ROOT/target}
cargo build --manifest-path "$ROOT/Cargo.toml" -p pond-wasm --lib \
  --target wasm32-unknown-unknown --profile wasm-release
rm -rf pkg
wasm-bindgen --target web --out-dir pkg \
  "$TARGET_DIR/wasm32-unknown-unknown/wasm-release/pond_wasm.wasm"
