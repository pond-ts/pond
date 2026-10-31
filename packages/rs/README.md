# @pond-ts/rs

pond-rs, the Rust port of pond-ts, compiled to WebAssembly and called with
pond-ts's method names and argument shapes. **Not published yet**: this is
steps J1, J1b, J2a and J2b of the bridge plan ([PND-RUST-R4] in `docs/plans/PND_RUST_PLAN.md`).

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
- **Durations** may be text (`'5m'`) or a whole number of ms (`60000`); a
  fractional number of ms, or one past ±8.64e15 ms, which pond-ts takes,
  is refused.
- **Not there yet:** a browser build (step J3). This build is for Node 20
  and later.
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
```
