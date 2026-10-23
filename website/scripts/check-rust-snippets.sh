#!/usr/bin/env bash
# Compile and run every ```rust block in the pond-rs docs pages against the
# crate in this checkout, so the examples cannot drift from the code.
# Each block must be a whole program (`fn main`). A failed assert fails it.
#
#   website/scripts/check-rust-snippets.sh
#   POND_RS_DIR=/path/to/crates/pond-rs website/scripts/check-rust-snippets.sh
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
work="${SNIPPET_DIR:-$(mktemp -d)}"
# POND_RS_DIR: check against another checkout of the crate (e.g. an open PR).
crate="${POND_RS_DIR:-$repo/crates/pond-rs}"
mkdir -p "$work/src/bin"
rm -f "$work"/src/bin/*.rs
cat > "$work/Cargo.toml" <<TOML
[package]
name = "pond-rs-doc-snippets"
version = "0.0.0"
edition = "2024"
publish = false
[dependencies]
pond-rs = { path = "$crate" }
serde_json = "1"
[workspace]
TOML
python3 - "$repo/website/docs/pond-rs" "$work/src/bin" <<'PY'
import pathlib, re, sys
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
n = 0
for page in sorted(src.glob("*.mdx")):
    text = page.read_text()
    for i, block in enumerate(re.findall(r"```rust[^\n]*\n(.*?)```", text, re.S)):
        if "fn main" not in block:
            sys.exit(f"{page.name} block {i + 1}: not a whole program (no fn main)")
        (out / f"{page.stem.replace('-', '_')}_{i + 1}.rs").write_text(block)
        n += 1
print(f"{n} snippets")
PY
cd "$work"
# No debug info: dozens of binaries with it fill a small disk.
export CARGO_PROFILE_DEV_DEBUG="${CARGO_PROFILE_DEV_DEBUG:-0}"
cargo build --quiet --bins
fail=0
for bin in src/bin/*.rs; do
  name="$(basename "$bin" .rs)"
  if cargo run --quiet --bin "$name" > /dev/null; then echo "ok   $name"; else echo "FAIL $name"; fail=1; fi
done
exit $fail
