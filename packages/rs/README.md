# @pond-ts/rs

pond-rs, the Rust port of pond-ts, compiled to WebAssembly and called with
pond-ts's method names and argument shapes. **Not published yet**: this is
steps J1 and J1b of the bridge plan ([PND-RUST-R4] in `docs/plans/PND_RUST_PLAN.md`).

```js
import { TimeSeries, Sequence } from '@pond-ts/rs';

const cpu = new TimeSeries({
  name: 'cpu',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'value', kind: 'number' },
  ],
  rows: [
    [0, 0.31],
    [60_000, 0.44],
    [120_000, 0.52],
  ],
});
const perTwoMinutes = cpu.aggregate(Sequence.every('2m'), { value: 'avg' });
console.log(perTwoMinutes.toJSON());

perTwoMinutes.free();
cpu.free();
```

## How it differs from pond-ts

- **Free what you make.** A series lives in WebAssembly memory, which
  JavaScript's garbage collector cannot see. Call `free()` when done. A
  finalizer frees forgotten series eventually, but WebAssembly memory never
  shrinks, so do not rely on it.
- **Times are milliseconds.** Rows take numbers for times; for times as text
  use `TimeSeries.fromJSON`. Range and interval keys in arguments are
  `{ time: t }`, `{ timeRange: [start, end] }` and
  `{ interval: [label, start, end] }`.
- **Functions work as in pond-ts** (`filter`, `find`, `some`, `every`,
  `mapColumns`, `scan`, `collapse`, `asInterval`), and may call the bridge
  themselves. If one throws, the rest of the rows are skipped and that same
  exception is rethrown. `mapColumns` on an array column is not supported
  yet.
- **Row lookups** (`at`, `bisect`, `nearest`, `find`, …) return `Event`s
  with only part of pond-ts's API: `get`, `data`, `key`, `type`, `begin`,
  `end`, `timeRange` (no `set`, `merge`, `select`, …). `Time`, `TimeRange`
  and `Interval` are likewise cut down (no `overlaps`, `contains`,
  `intersection`); `Time.parse` matches pond-ts.
- **Not there yet:** the financial studies and `LiveSeries` (step J2), and
  a browser build (step J3). This build is for Node 20 and later.
- One thread; at most ~3.8 GB of memory per process. Running out of memory
  stops the WebAssembly instance for good.

- **Error messages differ.** The bridge throws where pond-ts throws, but
  often a plain `Error` where pond-ts throws a `TypeError` or `RangeError`,
  and most messages are pond-rs's and some name its Rust API (for example
  `by_column:` or `Column::optional`).

Where pond-rs and pond-ts give different answers on purpose, the list is in
`crates/pond-rs/tests/core_parity.rs`.

## Building and testing

Needs Rust with the `wasm32-unknown-unknown` target and the wasm-bindgen CLI
at the version `crates/pond-wasm/Cargo.toml` pins:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129
./build.sh               # crates/pond-wasm -> pkg/
node test/parity.mjs     # pond-ts's core parity fixture through this package
node test/inputs.mjs     # cell checks, functions and other inputs the fixture misses
```
