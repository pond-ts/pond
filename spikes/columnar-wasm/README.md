# columnar-wasm — Rust/WASM substrate spike

A working port of pond-ts's hot `Float64Column` kernels to Rust,
compiled to `wasm32-unknown-unknown`, benchmarked against the real
library in both Node and the browser.

**→ Read [REPORT.md](REPORT.md) for the findings and the go/no-go.**
Short version: no-go on the port, go on six TypeScript changes it
surfaced — the biggest being quickselect for `median`/`percentile`
(7.3–11.8×, one file). §6 is a follow-up on `aggregate`, the strongest
case for a port the spike found (2.66× end to end) — and still not one.

This directory is **not** part of the npm workspace. It doesn't build,
test, format, or ship with `npm run verify`; the root `format:check`
globs only `packages/*/{src,test}` and `website/`.

## Running it

Needs a Rust toolchain with the wasm target:

```bash
rustup target add wasm32-unknown-unknown
```

Then, from this directory:

```bash
./build.sh && node bench/node.mjs
```

`build.sh` emits three artifacts to `pkg/` — baseline (wasm MVP),
`+simd128`, and an `opt-level="z"` size datapoint — and prints their
raw/gzip sizes. `bench/node.mjs` runs the parity harness first and
**refuses to report timings if it fails**, then runs every sweep.

Other entry points:

```bash
node test/parity.mjs                    # 1,380 checks vs pond-ts
node bench/node.mjs --quick             # smaller sizes, ~1 min
node bench/node.mjs --json out.json     # machine-readable results
node bench/controls-node.mjs            # the algorithm-vs-language decomposition
node bench/aggregate.mjs                # the `aggregate` composite follow-up (§6)
node bench/interval-columnar.mjs        # prototype of the interval-keyed door (§6.6)
```

The benchmarks import pond-ts from `packages/core/dist`, so build the
workspace first if it's stale:

```bash
npm run build --workspace=pond-ts
```

### Browser

Serve the **repo root** (the page imports pond-ts's `dist` by absolute
path) and open the bench page:

```bash
python3 -m http.server 3399 --bind 127.0.0.1
```

Then visit `http://localhost:3399/spikes/columnar-wasm/bench/browser.html`
and click **Run benchmark**. It checks parity in-page before timing
anything, prints the raw JSON at the bottom, and leaves the results on
`window.__benchResults`.

There is a `columnar-wasm-bench` entry in `.claude/launch.json` for the
same thing.

## Layout

| path                          | what                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/lib.rs`                  | the kernels — reductions, `bin`/`binBy`, gather, validity ops                                                          |
| `build.sh`                    | `cargo build` → `pkg/*.wasm`, no wasm-pack or wasm-bindgen                                                             |
| `js/loader.mjs`               | isomorphic loader; SIMD feature probe; memory-growth-safe views                                                        |
| `js/wasm-column.mjs`          | `WasmFloat64Column` — resident and bridged modes                                                                       |
| `test/parity.mjs`             | bit-for-bit checks against the real `Float64Column`                                                                    |
| `bench/suite.mjs`             | case matrix + timing harness, shared by both hosts                                                                     |
| `bench/node.mjs`              | Node driver                                                                                                            |
| `bench/browser.html`          | browser driver                                                                                                         |
| `bench/controls.mjs`          | the same algorithms in plain JS — the control experiment                                                               |
| `bench/controls-node.mjs`     | runs the controls, prints the decomposition                                                                            |
| `bench/aggregate.mjs`         | the `aggregate` follow-up — three complete implementations, each producing an identical `TimeSeries`, timed end to end |
| `bench/interval-columnar.mjs` | working prototype of interval-keyed columnar construction, verified against `aggregate`'s output                       |
| `results-*.txt` / `.json`     | captured output backing the report's tables                                                                            |

## Three things worth stealing from here

**The parity harness is a usable oracle for the `Float64Column`
contract.** It covers cases the current test suite doesn't — Welford
overflow on `[MAX_VALUE, -MAX_VALUE, 1]`, `-0`, denormals, `allFinite`
set pessimistically, out-of-range gather indices, `binBy`'s inclusive
final edge.

**The control benchmarks are the acceptance test for the PRs the report
recommends.** Each JS control is checked against pond-ts's answer before
it's timed, so "is my quickselect right and is it actually faster" is
already answered.

**`interval-columnar.mjs` is most of an implementation, not a sketch.**
It assembles `IntervalKeyColumn` → `ColumnarStore.fromTrustedStore` →
`SeriesStore.fromTrustedStore` and verifies the result row by row against
`aggregate`'s own output. Lifting it into `aggregateInternal` is mostly
deletion — that function already lives in the module where the last
private hop is reachable.
