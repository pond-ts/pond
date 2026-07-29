# Polars as a columnar core — assessed and declined (2026-07)

**Question.** Could `polars` back pond-ts's columnar substrate? Its whole
premise is the Arrow memory layout, which looks like an interesting
intersection with the substrate's concerns.

**Answer: not as the core.** But the Arrow instinct behind the question is
right, and better than it first appears — the intersection point already
exists and is not something a dependency would buy.

Recorded so a future session does not re-litigate it. The measurements
behind it are in
[`docs/plans/PND_COLUMNAR_PLAN.md`](../plans/PND_COLUMNAR_PLAN.md) and
`packages/financial/scripts/perf-vs-polars.mjs`.

## Why not as the core

### 1. It cannot reach the browser

`nodejs-polars` is a native N-API addon. `@pond-ts/charts` and
`@pond-ts/react` ship to browsers. So polars could only ever be a
**Node-only backend**, which means two implementations of every operator
that have to stay bit-identical.

The Rust/WASM spike is a catalogue of what that costs. Every one of these
was a silent wrong answer, found only because the parity harness asserted
bit-equality rather than closeness:

- `Math.max(0, NaN)` propagates NaN; Rust's `f64::max` ignores it and
  returns `0`. Welford overflows to NaN on `[MAX_VALUE, -MAX_VALUE, 1]`,
  so `stdev` differed on real input.
- An `f64`-only ABI cannot express `number | undefined`, because `NaN` is a
  reachable _result_ of `stdev`, not just a sentinel.
- `Float64Array.prototype.sort()` orders `-0` before `+0`; the row path's
  comparator treats them as equal. The two paths disagreed on signed zero.

A second engine multiplies that surface rather than adding to it.

### 2. It would make the hot path _slower_

Measured, 500k 1-minute OHLCV bars, single-threaded (the per-core
comparison — polars defaults to all cores; `< 1.00×` means pond-ts wins):

| query                 | pond-ts  | polars st |           |
| --------------------- | -------- | --------- | --------- |
| 5-study strategy pass | 64.32 ms | 77.35 ms  | **0.83×** |
| `ema(20)`             | 2.08 ms  | 6.33 ms   | **0.33×** |
| `bollinger(20)`       | 23.23 ms | 43.16 ms  | **0.54×** |
| `zScore(20)`          | 17.83 ms | 18.37 ms  | **0.97×** |
| `close.mean()`        | 0.47 ms  | 0.05 ms   | 8.98×     |
| `close.stdev()`       | 2.52 ms  | 0.31 ms   | 8.16×     |

polars wins 4–9× on **whole-column reductions** and loses on **composite
studies**. The agent workload this library is currently driven by is
composites; every summary fact is already under 3 ms. Adopting polars
wholesale would trade the fast path for the cheap one.

### 3. Its semantics are not ours

pond-ts's studies are pinned bar-for-bar against a pandas oracle, with
conventions chosen deliberately (`ddof=0`, `ewm(adjust=False)`, linear
quantile interpolation, the reducer non-finite policy that treats
`NaN`/`±Inf` as missing). polars has its own answers to each — nulls
distinct from NaN, a different `ddof` default, its own quantile
interpolation. Adopting it means either breaking the oracle or translating
at every boundary, and the translation layer is where drift hides.

## The Arrow intersection already exists

The premise worth keeping is right, and stronger than the question assumed.

pond-ts's validity bitmap is `bits[i >> 3] & (1 << (i & 7))` — **LSB-first,
one bit per value. That is Arrow's validity layout exactly.** Numeric values
are a contiguous `Float64Array`. A `Float64Column` _is_ an Arrow array in
memory, today, with no conversion and no dependency.

So the intersection is not something to acquire. What is missing is the
**doors**:

- **Zero-copy export** ([PND-TOARROW]) — hand columns to polars, DuckDB or
  arrow-js for heavy compute without pond-ts depending on any of them.
  Users who want a 9× `mean` can have it; users who don't pay nothing.
- **Zero-copy import on the null path** ([PND-ARROWNULL]) — `fromArrow`
  already adopts the values buffer when `nullCount === 0`, but falls back to
  a per-element `get()` walk when there are nulls, despite the bitmaps being
  byte-identical.

That keeps pond-ts what it is good at — time-series semantics, the study
vocabulary, the immutable typed API — and makes "bring your own compute
engine" a buffer handoff rather than a re-ingest.

## What polars is genuinely worth here

**A yardstick, and it already earned its keep.** It corrected the Rust/WASM
spike's central conclusion. The spike measured dense `sum` at exactly 1.00×
against a hand-written Rust kernel and read that as "there is nothing here".
Both sides were running scalar sequential accumulation, so of course they
tied. polars does the same reduction ~9× faster, which shows the headroom
was never the language — it is vectorisation and reassociation.

That reading has since been acted on and confirmed. Blocked summation
shipped in TypeScript ([blocked-summation.md](blocked-summation.md)) and
took `close.mean()` from 0.47 ms to **0.19 ms**, closing the gap to polars
from 8.98× to ~3.8× with no Rust involved. The residue is genuine wide
SIMD, which is exactly what WASM cannot deliver — its `simd128` is 2-wide
`f64` and measured **1.00×** across every kernel in the spike.

**A possible optional sidecar, later.** If a workload ever demands bulk scan
throughput that vectorised TypeScript cannot reach, a Node-only sidecar
_behind the Arrow door_ is the shape — an opt-in accelerator over shared
buffers, not a core. Nothing measured so far demands it.

## Also worth noting: threads

polars at 10 threads takes the strategy pass to 18.95 ms — 3.39× ahead of
pond-ts. Nothing in pond-ts is parallel. For a load-once / query-many agent
workload on a multi-core box that is a real structural gap, and it is
independent of any kernel or language choice. Not currently a task; recorded
because it is the one axis where the gap is not closeable by the work
already planned.
