# Adding a study

A study is a pure function that **appends one or more columns** to a bar
`TimeSeries` and returns the widened series. Studies are thin assemblies over
the shared kernel — they add vocabulary, not new math. Follow this checklist so
every study lands consistent, composable, and **verified**.

The worked references are `moving-average.ts` (`sma`/`ema`), `bollinger.ts`
(multi-column family), `rolling-stat.ts` (shared-body single reducers),
`z-score.ts`, `envelope.ts`, and `percent-change.ts`.

## The checklist

### 1. Write the study — `studies/<name>.ts`

- A pure `(series, options) => series` function, generic over the schema `S`
  and (for the type-precise appended column) the output name:
  `export function foo<S extends SeriesSchema, const Output extends string = 'foo'>(...)`.
- **Every study takes `column`** (the source field, **default `'close'`** via
  `DEFAULT_SOURCE`) **and `output`** (the appended column name; a multi-column
  study takes a `prefix` and appends `${prefix}Middle` / `Upper` / `Lower`).
  Never hard-code `'close'` — a study must run over any numeric column,
  including another study's output.
- **Periods are bar counts**, not durations. Validate with `assertPeriod`.
- **Warm-up is length-preserving**: emit `undefined` for the first `period − 1`
  rows, keep the row count (so the study lines up on the source's time axis).
  You get this for free from the kernel (`minSamples: period`).
- **Compose on the kernel** (`kernels/rolling.ts`), don't hand-roll loops:
  - `rollingValues(series, column, reducer, period)` — one count-window reducer.
  - `rollingColumns(series, specs, period)` — several reducers in **one** pass
    (e.g. Bollinger's avg + stdev, z-score's mean + stdev).
  - `columnValues(series, column)` — a raw column as an array (for arithmetic
    like percent-change / the z-score numerator).
  - `emaValues(series, column, period)` — a span-EMA as an array.
- Guard the output name(s) with `assertNoColumn` before doing work.
- Append with `series.withColumn(output, values)` (it appends an **optional**
  number column — required for the `undefined` warm-up to survive a later
  strict-intake rebuild). Let the return type **infer** from `withColumn`
  (avoids TS2742); don't annotate it by hand.

### 2. Export it — `index.ts`

Export the function and its options type from the package barrel.

### 3. Add the fluent method — `fluent.ts`

Add the method to the `declare module 'pond-ts'` interface **and** mount it on
`TimeSeries.prototype` (delegating to the standalone function bound to `this`).
The declared return type must match the standalone function's (`AppendOpt<S,
Output>` for a single column, the triple-nested form for a `prefix` family).

### 4. Add a pandas oracle case — **required, not optional**

**A study does not merge without an oracle case.** This is the gate that lets us
trust the numbers (see `../../scripts/oracle/README.md`).

1. In `scripts/oracle/generate.py`, add a function computing the reference
   values with **pandas** (later: TA-Lib for named indicators), and a case in
   the `cases` list. **Match our conventions exactly** — the oracle only helps
   if it does: population stdev (`ddof=0`), `ewm(adjust=False)` for EMA, linear
   `quantile` for percentiles, `× 100` for percent — see the oracle README's
   table. The expected column **names must equal the study's default output**
   (a name mismatch reads all-null and the test passes _vacuously_).
2. Regenerate the fixture (a throwaway venv — see the oracle README).
3. Add a `case` for the study to the dispatch in `test/study-oracle.test.ts`
   (the `default` throws, so a missing dispatch fails loudly, never silently).

### 5. Add unit tests — `test/studies.test.ts`

The oracle pins the **values**; unit-test what it doesn't: validation throws,
default output / `prefix` naming, and edge handling (e.g. σ = 0 → `undefined`,
warm-up shape, `period > length`). Aim for a real assertion, not just
"doesn't throw."

### 6. CHANGELOG

Add the study under `## [Unreleased] → Added` in the root `CHANGELOG.md`.

## Performance: the kernel touches data, studies never do

Market-scale series are the normal case for this package — assume **1M bars**,
not 10k. The studies stay fast by construction, not by per-study tuning, and
the rules below are what keep that true. They exist because we shipped the
slow versions first: the original kernel read rolled results via
`rolled.events` and `event.data()`, which cost ~400 ms of pure Event/object
allocation per 1M rows — ~50× the entire rolling scan — and core's
`smooth('ema')` rebuilt every row through strict intake (PR #536 removed
both; `sma()` went 569 → 56 ms, `ema()` 603 → 2.5 ms).

- **Studies contain no data loop.** A study is options-validation + kernel
  calls + `withColumn`. If you are writing `for`, `.map`, or `.events` in a
  `studies/*.ts` file, stop — the loop belongs in `kernels/`, where it is
  shared, benchmarked, and written against the column API.
- **Kernels read columns, never events.** `series.events` materializes an
  `Event` plus a data object per row; at 1M rows that costs more than most
  whole-series scans. Bulk reads go through `series.column(name)` (see
  `readNumericColumn` in `kernels/rolling.ts`) — and per-cell arithmetic over
  those arrays is fine; it's the Event materialization that kills, not the
  loop.
- **Stay on core's columnar fast paths.** The kernel earns its speed by
  hitting them: count-window `rolling` runs its typed fast path when **every
  mapped reducer is a built-in name with a numeric output** (a single
  custom-function reducer sends the whole call to the generic sweep), and
  `smooth('ema')` runs its typed fast path on packed numeric sources. If a
  new study needs a shape those don't cover (e.g. a per-bar stateful fold —
  PSAR/SuperTrend), the answer is a **new kernel helper backed by a new core
  fast path** ([PND-SFOLD]), never a bespoke event loop in the study.
- **Touching a kernel means running the bench.** Compose-only studies inherit
  kernel performance and need no benchmark of their own. Any change to
  `kernels/*.ts` — or a new kernel helper — runs
  `scripts/perf-studies.mjs` before/after at the 1M scale and puts the table
  in the commit message (the root CLAUDE.md perf-check procedure applies to
  kernels even though studies themselves are exempt as pure delegators).
  Current reference points at 1M bars: `ema()` ≈ 2.5 ms, `sma()` ≈ 56 ms,
  `bollinger()` ≈ 162 ms, hand-rolled `Float64Array` floor ≈ 1.6–1.9 ms.
  A new kernel helper landing an order of magnitude off these numbers is a
  design smell, not a tuning task.

## Why the discipline

Studies are a **vocabulary package**: named, parameterized wrappers over a small
kernel. Keeping them thin (compose, don't re-implement), uniformly shaped
(`column`/`output`, bar-count periods, length-preserving warm-up), and
**oracle-verified** is what makes the corpus trustworthy and cheap to extend —
each new study is a short, testable assembly, and its numbers are checked
against an independent reference before anyone relies on them. The same
thinness is the performance model: because no study owns a data loop, a
kernel or core fast-path improvement speeds up every study at once (PR #536
needed zero study changes), and a slow study is by definition a kernel or
core bug — file it there, don't fork the study.
