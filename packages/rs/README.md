# @pond-ts/rs

pond-rs, the Rust port of pond-ts, compiled to WebAssembly and called with
pond-ts's method names and argument shapes, in Node and in browsers. It has
pond-ts's version number and is released with it on every pond-ts release
([PND-RUST-R4] in `docs/plans/PND_RUST_PLAN.md`). Docs:
<https://pond-ts.org/docs/pond-rs/javascript>.

```sh
npm install @pond-ts/rs
```

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

## Node and browsers

- **Node 20 or newer** (also Deno and Bun): `import` it; the WebAssembly is
  read and compiled while the import runs, so nothing needs awaiting.
- **Browsers**: the same import and the same API. The package fetches its
  `.wasm` file with a top-level `await`, so the import resolves once it is
  ready. The `node` export condition picks the loader (`wasm.node.js` or
  `wasm.browser.js`, through the `#wasm` entry of package.json `imports`).
  - **Vite**: `build: { target: 'es2022' }` (top-level `await`) and
    `optimizeDeps: { exclude: ['@pond-ts/rs'] }` (pre-bundling loses the
    `.wasm` file). `vite build` copies the `.wasm` into `dist/assets`.
  - **webpack 5, Parcel, Rollup**: they copy the file named by
    `new URL('./pkg/pond_wasm_bg.wasm', import.meta.url)` themselves.
  - **esbuild**: `--format=esm --target=es2022`, then copy
    `pkg/pond_wasm_bg.wasm` to `<outdir>/pkg/`.
  - **No bundler**: an import map with `"@pond-ts/rs"` pointing at this
    package's `index.js` and `"#wasm"` at its `wasm.browser.js`.
  - **CSP**: WebAssembly needs `'wasm-unsafe-eval'` in `script-src`.
    Without `'unsafe-eval'`, `toJSON()` takes its plain-loop fallback (same
    output); both are tested in headless Chromium.
- **Size**: `pkg/pond_wasm_bg.wasm` is 7.5 MB, 1.39 MB with brotli; the
  JS is ~88 KB (~19 KB brotli). Serve the `.wasm` as `application/wasm`.

## How it differs from pond-ts

- **Free what you make.** A series lives in WebAssembly memory, which
  JavaScript's garbage collector cannot see. Call `free()` when done. A
  finalizer frees forgotten series eventually, but WebAssembly memory never
  shrinks, so do not rely on it.
- **Times are milliseconds.** Rows take numbers for times; for times as text
  use `TimeSeries.fromJSON`. Range and interval keys in arguments are
  `{ time: t }`, `{ timeRange: [start, end] }` and
  `{ interval: [label, start, end] }`.
- **Expressions** (`col`, `lit`, `when`, exported here) work as pond-ts's
  and run inside pond-rs with no JavaScript call per row:
  `s.filter(col('v').gt(0))`. Accepted by `filter`, `find`, `some`,
  `every`, `mapColumns` and `withColumn`. On 1M rows a filter takes about
  14 ms against about 920 ms with a function (and 28 ms in pond-ts).
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
- **Financial studies** from pond-rs's catalog, with
  `@pond-ts/financial`'s names and options: `s.study('rsi', { period: 14 })`
  or the named method `s.rsi({ period: 14 })` (every study has one, as
  `@pond-ts/financial/fluent` mounts them), also on a `partitionBy` view.
  `studies()` / `studyInfo(name)` give pond-ts's catalog descriptors.
  Options a study does not have are ignored, as in pond-ts. On 1M bars,
  about 3-10x faster than `@pond-ts/financial` (`scripts/perf-studies.mjs`).
- **`TradingCalendar`** is cut down: `fromRules(rules, { from, to })`,
  `fromSessions`, `sessions()`, `length`, `timeZone`, the lookups
  (`sessionOn`, `isTradingDay`, `sessionContaining`, `isOpen`,
  `sessionsInRange`, `nextSession`, `previousSession`) and `tagSessions`;
  no `sessionSequence` / `barSequence`. Times are whole ms. Like a series,
  it lives in WebAssembly memory: call `free()`. Pass it to a session study
  as `sessions: calendar` (or a `Session[]` list, or `session: 'column'`
  after `tagSessions`). Lookups take a date only as `YYYY-MM-DD` text and
  throw on other text, where pond-ts compares any text with session dates
  as text and quietly finds nothing (or the wrong neighbour).
- **`toJSON()`** gives pond-ts's tree, `{ rowFormat: 'object' }` included,
  but its rows are not frozen. The key column is always named `time`,
  `timeRange` or `interval` (a custom key name in the schema is ignored),
  which shows in object rows. Column names pond-ts refuses as reserved
  (`__proto__`, `constructor`) are taken, and are plain fields of an object
  row. It builds rows with generated code (`new Function`); where that is
  not allowed (`--disallow-code-generation-from-strings`, a CSP without
  `'unsafe-eval'`) it falls back to a plain loop with the same output, about
  as fast as pond-ts's.
- **Durations** may be text (`'5m'`) or a whole number of ms (`60000`); a
  fractional number of ms, or one past ±8.64e15 ms, which pond-ts takes,
  is refused.
- One thread; at most ~3.8 GB of memory per process. Running out of memory
  stops the WebAssembly instance for good.

- **Error messages differ.** The bridge throws where pond-ts throws, but
  often a plain `Error` where pond-ts throws a `TypeError` or `RangeError`,
  and most messages are pond-rs's and some name its Rust API (for example
  `by_column:` or `Column::optional`).

Where pond-rs and pond-ts give different answers on purpose, the list is in
`crates/pond-rs/tests/core_parity.rs`.

## LiveSeries

`LiveSeries` and the nodes built on it have pond-ts's class names, methods
and argument shapes; the work runs inside pond-rs.

```js
import { LiveSeries, Sequence } from '@pond-ts/rs';

const live = new LiveSeries({
  name: 'cpu',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'cpu', kind: 'number' },
  ],
});
const avg = live.rolling('1m', { avg: { from: 'cpu', using: 'avg' } });
const perMinute = live.aggregate(Sequence.every('1m'), { cpu: 'max' });
const stop = perMinute.on('event', (bucket) => console.log(bucket.get('cpu')));

live.push([0, 0.31]);
live.pushMany([
  [30_000, 0.44],
  [61_000, 0.52],
]);
console.log(avg.value());

stop();
live.free();
```

- **Built:** `filter` (function or expression), `map`, `select`,
  `sample`, `window`, `diff` / `rate` / `pctChange`, `fill`, `cumulative`,
  `aggregate` (`closed`, `snapshot`, `hasOpenBucket`), `rolling` (one
  window, or several fused), `reduce`, and `partitionBy` with `collect`,
  `apply`, per-partition `rolling` and `toMap`. `on(type, fn)` returns an
  unsubscribe function; `dispose()` removes a node (a second `dispose()`,
  or `on()` after it, does nothing, as pond-ts).
- **`free()` the root** `LiveSeries`; that frees every node built on it.
  A finalizer frees a forgotten one eventually, also when its node
  functions refer to the series (they are held on the JavaScript side).
- **Listeners run after pond-rs has taken the push.** If one throws, the
  others still run and the first exception is rethrown. A push made from
  inside a listener waits until the current push is done.
- **Functions:** `filter` and `map` get the same `Event` as elsewhere in
  the bridge; `cumulative` functions get numbers (`(acc, value)`). If one
  throws, the push still completes, the outputs are delivered and its
  first exception is rethrown; a node built over history whose function
  throws is not added. During a push a function cannot use its own series
  at all, not even to read it (`live.length`): that is an error.
- **Fast path.** `push([t, n, …])` and `pushMany` with only numbers (and
  `undefined` for a gap) skip JSON; other rows go as JSON, which refuses
  `null` and `NaN` cells as pond-ts does. Both give the same result.
- **Differences:** a disposed node cannot be read (pond-ts leaves it
  readable); `pushJson` takes no `timeZone`; only the root series takes
  `push` / `pushMany` / `pushJson` / `clear` (pond-ts lets you push into
  or clear one partition's series); a node function cannot read its own
  series during a push; reducers are names only (pond-ts also takes a
  function as `using`); keys must be whole ms (pond-ts takes `0.5`);
  `apply(factory)` runs the factory once and repeats its chain for every
  partition, so it cannot branch on the partition; `cumulative` takes one
  function column; `toTimeSeries` takes no name; partitioned fused
  rolling `stats()` has no `windowsCount`; a `map` result cell of the
  wrong type is a gap; a `cumulative` result that is not a number is
  `NaN`.
- **Speed** (`scripts/perf-live.mjs`, 1M events): `push` about 6x faster
  than pond-ts, `pushMany` about 3x, a rolling average plus 1-minute
  buckets 2-5x, and about 1.4-2x with a listener on every rolling update
  (each output crosses back to JavaScript).

## Building and testing

Needs Rust with the `wasm32-unknown-unknown` target and the wasm-bindgen CLI
at the version `crates/pond-wasm/Cargo.toml` pins:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129
./build.sh               # crates/pond-wasm -> pkg/
node test/parity.mjs     # pond-ts's core parity fixture through this package
node test/inputs.mjs     # cell checks, functions and other inputs the fixture misses
node test/studies.mjs    # @pond-ts/financial's study, oracle, catalog and calendar fixtures
node test/live.mjs       # pond-ts's live parity fixture
node test/tojson.mjs     # toJSON against pond-ts's (npm run build --workspace=pond-ts first)
node test/browser.mjs    # the browser build in headless Chromium, with and without a strict CSP
```

`test/browser.mjs` needs the root devDependencies (`esbuild`, `playwright`)
and a Playwright Chromium (`npx playwright install chromium`, or
`CHROMIUM_PATH` pointing at another Chromium).

Publishing: the `Publish` workflow (`.github/workflows/release.yml`) builds
and tests this package on every `v*` tag and publishes it after the
workspaces. It is not an npm workspace, so the root `npm ci` / `npm run
verify` need no Rust; its version must equal pond-ts's (CI checks).
