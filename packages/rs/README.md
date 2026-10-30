# @pond-ts/rs

pond-rs, the Rust port of pond-ts, compiled to WebAssembly and called with
pond-ts's method names and argument shapes. **Not published yet**: this is
step J1 of the bridge plan ([PND-RUST-R4] in `docs/plans/PND_RUST_PLAN.md`).

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
- **No callbacks yet.** `filter`, `mapColumns`, `scan`, `collapse` and
  `asInterval` with a function come in step J1b.
- **Not there yet:** row lookups (`at`, `bisect`, …), the financial studies
  and `LiveSeries` (step J2), and a browser build (step J3). This build is
  for Node 20 and later.
- One thread; at most ~3.8 GB of memory per process. Running out of memory
  stops the WebAssembly instance for good.

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
```
