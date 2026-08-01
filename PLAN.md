# Plan

This document is the **roadmap of future work only**. Each work section below
gives a one-paragraph summary and a link to its breakout plan
(`docs/plans/PND_*_PLAN.md`), which carries the full context per task. Work is
broken into tasks named `[PND-XXXXXX]`.

Where everything else lives:

- **Breakout plans** — [docs/plans/](docs/plans/) (`PND_*_PLAN.md`, one per
  work section; the long write-ups live there, not here).
- **Strategic RFCs** — [docs/rfcs/](docs/rfcs/) (forward-looking context, not
  commitments; only tasks adopted here are commitments).
- **Shipped history** — [CHANGELOG.md](CHANGELOG.md) for releases;
  [docs/archive/](docs/archive/) for the frozen phase/wave logs that used to
  live in this file (design decisions, shipped milestone detail, walkbacks).
- **Evergreen rules** —
  [docs/notes/design-principles.md](docs/notes/design-principles.md) (design
  principles + semantics to preserve; these hold across all new work).

Maintenance: when a task completes, remove it here and record the outcome
(decision + reasoning) in its breakout plan; add new tasks with a `PND-` ID.
A lost session should never erase the current state of the project.

---

## Roadmap

### `@pond-ts/charts`

The canvas wave shipped the rendering spine, seven chart types, interactions,
the decimator (line/area/band M4 + viewport culling, **released in v0.49.0**),
and the trading-time + categorical axes; the package is **published**
(`@pond-ts/charts` on npm, `private: false`). Remaining: land built work,
Phase-2 RFC slices, and the M5 parity gate for the stable / estela-parity
milestone. Plan:
[PND_CHARTS_PLAN.md](docs/plans/PND_CHARTS_PLAN.md) · RFC:
[charts.md](docs/rfcs/charts.md).

- **[PND-CATAX]** — Land categorical axis Phase 1. Three PRs are built and
  verified on `feat/charts-categorical-axis` but not pushed; land with
  Layer-2 + Codex review, human gate on the `SelectInfo.mark` widening.
- **[PND-PARITY]** — M5 estela parity (the stable milestone; the package
  already publishes pre-parity). Faithful `DataChart` reproduction on real
  activity data, no regressions. Gates: statistical bands, theme tokens
  optional-with-default, shared axis-headroom policy.
- **[PND-SELECT]** — Selection Phase 2: multi-select widen + `selectionMode`,
  `LineChart.hitTest`, snap-follows-selection prop, theme-referenced dim.
  Breaking widen → human gate. RFC: [selection.md](docs/rfcs/selection.md).
- **[PND-DECIM]** — Decimator Phase 5 (finish-the-wave): candlestick + box
  decimation (Tidal-anchored), document the `three`-at-1M render floor
  (Path2D doesn't help pan), then the "large time series" how-to + release.
- **[PND-HOVCTX]** — Split cursor position out of the `ContainerFrame` context
  (external bench 2026-07 follow-up, profile-verified): cursor lives in
  `useState` on `ChartContainer` and is a frame field, so every mousemove
  rebuilds the frame and re-renders **all** context consumers (both `YAxis`,
  `Legend`, `Bar`/`Box`) even though only the SVG overlay moved — measured 4
  React commits/event, ~0.68 ms vs uPlot's 0.13 ms. A dedicated `CursorContext`
  ({cursorX,cursorY,cursorRowKey} — the per-move-varying fields; the cursor
  _time_ is derived locally per consumer) leaves the config consumers untouched
  on hover. This is why #524 (which stopped the _canvas_ repaint) left hover
  "still kind of slow".
- **[PND-BOXPLT]** — Finish BoxPlot: ValueSeries widening, range-only mode,
  px `offset` for same-x pairs, line-only shape, join the cursor x-snap, and
  selection `id` via rect-containment `hitTest` (#508 item 5; Candlestick
  takes the same geometry helper).
- **[PND-CURSOR]** — Cursor/readout polish backlog (scatter 2D-nearest,
  chip de-overlap, y-oriented region cursor, `pointercancel` clear-only
  fix).
- **[PND-AXES]** — Axis backlog (label align, custom ticks, scale variety) +
  the deferred value-axis naming follow-up. (Relative/elapsed time is done —
  `<ChartContainer origin>`.)
- **[PND-VALAX]** — Value axis: widen Box/Candlestick x; grow the
  `ValueSeries` algebra only when a second consumer (geo) pulls.
- **[PND-THEME]** — `cssVarTheme` candle mapping (LOW; worked example + var
  naming convention, no new plumbing).
- **[PND-WIDTH]** — Responsive width/fill for `ChartContainer` (two
  consumers hit the explicit-px requirement).
- **[PND-LIVELYR]** — Live-source-aware layer inputs (same report, ask #4):
  charts layers take only `TimeSeries`, forcing a fresh per-tick handle
  (`snapshot.partitionBy().toMap()`) per host. A `LiveView`-aware input — or
  a documented cheap-handle idiom for live charts — closes it. Overlaps
  [PND-PARITY] / the live layer.
- **[PND-ANNRFC]** — Write the short `docs/rfcs/annotations.md` design
  record the owner asked for (confirm still wanted).

### Docs site, landing, and API reference

The docs-site wave shipped P0–P1 and most of P2/P3 (Learn track, the
interaction and annotations reference sections, Axes/Layout/Chart-types, the
financial hub, and the in-site API reference for core + charts). Plan:
[PND_DOCS_PLAN.md](docs/plans/PND_DOCS_PLAN.md) · plan notes:
[charts-docs-site-plan-2026-07.md](docs/notes/charts-docs-site-plan-2026-07.md),
[core-and-landing-docs-plan-2026-07.md](docs/notes/core-and-landing-docs-plan-2026-07.md).

- **[PND-STORY]** — P2 finish: story-coverage fill for thin Storybook groups
  plus the prop-identity recipe (#464 landed only the tree scaffolding).
- **[PND-DOCP3]** — P3 remaining reference pages: Data adapters, Rendering &
  performance, Design philosophy ×2, Accessibility, Troubleshooting, RTC
  migration, the financial end-to-end guide.
- **[PND-GUIDES]** — P4 guides library: ops-dashboard, annotation workflows,
  value-axis guides + remaining recipes.
- **[PND-LAND]** — Landing-page story + remaining core concept pages beyond
  the transforms set.
- **[PND-APIREF]** — In-site API reference completion: `{@link}` resolution,
  react/fit/financial tranches, big-page ergonomics, missing class-level
  docstrings.
- **[PND-VSDOC]** — Give `creating.mdx` its `ValueSeries` section. PR #564
  restructured the ingest page around JSON / columnar / Arrow and
  deliberately skipped `ValueSeries` because its whole surface was
  `fromColumns` — "two-thirds empty". [PND-VSIO] filled the other
  two-thirds (`fromJSON` / `fromArrow` in, `toJSON` / `toColumns` /
  `toArrow` out), so the section now has content: one subsection per door
  shape, cross-linked to the deep dive.
- **[PND-OBSDOC]** — "Observing pond-ts in production" how-to: the
  documentation-backlog items (pushMany guidance, bench-honesty callout, GC
  snippet, no-NaN guarantee, tie semantics, latency pattern) as one MDX pass.

### Agent workloads — the defensible bench

[`docs/notes/agent-workloads-2026-07.md`](docs/notes/agent-workloads-2026-07.md)
distils a real derivatives-analytics catalog into six generic data shapes, six
practitioner personas, and twelve questions written the way an agent receives
them — each with the plan a process graph would compose, what it stresses, and
whether pond can do it today. Acceptance gate: **< 100 ms over 500k–1M points**.

The finding that reorders the roadmap: **the gaps are shape problems, not speed
problems.** Rolling studies, aggregation, calendars, histograms and folds — the
things these questions lean on hardest — pond already does well. What blocks
questions is missing _primitives_: unpivoting a wide row into a value-axis
series (a term structure is the object these people think in), tall→wide pivot,
and ranking across partitions.

- **[PND-SHIFTFRAME]** — **Shipped.** `rollingDeviationSd` in
  `packages/financial/src/kernels/rolling.ts`; `zScore` rewired onto it.
  Worst relative error against an exact reference over 200k rows:
  `1e15 + ((i%7)−3)` **1.0e+0 → 4.1e-15**, `1e9 + sin` **4.1e+0 → 4.9e-12**,
  benign random walk **3.9e-6 → 4.4e-11**. Three things the plan did not
  anticipate, all worth carrying forward:
  - **Welford needed shifting too.** The first cut shifted only the mean and
    left σ on the raw values, which improved the pathological case by three
    orders of magnitude and stopped there — `d = x − wMean` is the same
    subtraction of two near-equal large numbers. Welford is stable relative
    to the _conditioning_ of the problem, and raw large-magnitude values are
    what make it ill-conditioned. "Variance is translation-invariant so
    Welford is fine" was the wrong reading, and only an exact reference
    caught it.
  - **The fix cost `zScore` its parallelism.** The stable kernel returns a
    deviation, not a mean, so `withWorkers` no longer hooks it: the study
    went from the fastest accelerated one (2.44×) to sequential. Accepted —
    a 2.44× on an answer that could be 100% wrong is not a speedup — but it
    says a numerical class is not a full account of an operator. See
    [`docs/rfcs/numerical-classes.md`](docs/rfcs/numerical-classes.md), where
    this is now the tested case rather than the hypothetical one.

    It also cost a test canary, which is the more general lesson: four tests
    proved the parallel path had run by observing that `zScore` disagreed
    with the sequential answer. That only ever worked because the accelerated
    result was inferior, and it evaporated the moment that was fixed.
    Replaced with `parallelDispatches()`, an explicit count.

  - **A constant rebuild interval was wrong at both ends**, found by a Codex
    pass and fixed in `20639a4`. The kernel rebuilt its incremental state
    every 1024 rows. Too rarely for a short window — at `period 2`, where
    every non-flat window has `|z|` exactly 1, drift through ~500 turnovers
    reached **1.7e-6**, breaking the `<1e-9` claim outright. Too often for a
    long one — the rebuild is `O(period)`, so firing it on a row count made
    the kernel `O(N + N·period/1024)`: **81 ms at `period 100k`** against 7 ms
    at `period 20`, with the "flat in `period`" claim only ever tested to 1024. Rebuilding once per **window turnover** (`period` rows) fixes both
    with one rule, and is _faster_ — the magnitude heuristic it replaced was
    computing a `sqrt` on every row. Now 22.8–26.1 ns/row across `period` 2 to
    100k. The lesson for the next kernel: a threshold in rows is a threshold
    in the wrong unit when the work per row scales with a window.

- **[PND-AGENTBENCH]** — **Built and measured** —
  `packages/financial/scripts/perf-agent-bench.mjs`. Q11 (500 symbols × 1000
  bars, per-symbol `zScore`, rank across symbols) answers in **39 ms**, and
  **79 ms at 1M points** — both inside the 100 ms gate, so **pond is the client,
  not the viewer**: a resident panel answers a 7-question flurry in 266 ms
  against ~140–350 ms of round trips for the same questions, and that is before
  any caching. Two findings reorder what comes next:
  - **`withWorkers` does nothing here (1.00×)** — it partitions _within_ a
    series, and every partition is 1000 rows, far below `MIN_ROWS`. The panel
    shape wants parallelism _across_ partitions. Right idea, wrong axis.
  - **`partitionBy`+`toMap` is 43–44% of the time and it is serial.** The
    studies are only ~53%, so the Amdahl ceiling for partition-level
    parallelism is **2.0×**, not 8×. Making the split cheaper is worth as much
    as threading it, and is worth doing first.

  Remaining: a flurry variant driven through the process graph, to measure the
  content-addressed cache rather than infer it (repetition is 68% of the work in
  a realistic 21-from-7 session).

- **[PND-SPLITCOST]** — **Shipped.** `partitionBy`+`toMap` **18.1 → 12.7 ms**
  at 500×1000 (**25.2 → 12.4 ms** interleaved, **33.9 → 22.3 ms** at 1M), and
  `_distinctPartitionKeys` **4.9 → 1.0 ms** (9.2 → 1.2 interleaved). Two
  changes: a **dict-encoded fast path** (a dictionary-backed string column
  already carries an integer per row, so grouping indexes an array instead of
  building and hashing a key string per row — symbols are exactly what dict
  encoding is for) and a **two-pass fill** (count, then fill an exactly sized
  `Int32Array`, replacing a boxed push per row plus a copy per group).
  Benchmark: `packages/core/scripts/perf-partition.mjs`, which also covers the
  interleaved layout so the fast path is not measured only where it flatters.
  Q11 is now 36.5 ms with the split at 30% (was 43%). Remaining, unmeasured:
  the ~7 ms of `withRowSelection` + `TimeSeries` construction per group — a
  contiguous-range slice could avoid the gather where partitions happen to be
  consecutive.
- **[PND-UNPIVOT]** — Ingest a **long** value-axis result cleanly (tenor/strike
  as a key column). Narrowed by the ClickHouse boundary in §8 of the note:
  unpivot and pivot are `arrayZip`+`ARRAY JOIN` and conditional aggregation
  respectively, so they belong in the query — pond's job is to receive the long
  shape, not reshape a wide row in JS.
- **[PND-XSECT]** — Rank/reduce across partitions. `partitionBy` gets you
  per-symbol; nothing ranks across.

### Numerical classes (RFC — not adopted)

[`docs/rfcs/numerical-classes.md`](docs/rfcs/numerical-classes.md) argues that
accuracy under partitioning is a **property of an operator's form**, not a
measurement of a workload — prompted by a shipped `zScore` accuracy figure that
turned out to be an artifact of the author's own test data (a Codex pass found
a legal input giving **38% relative error** where the docs claimed 2.6e-6).

Three classes (exact / bounded / unbounded), a composition rule that makes them
survive arbitrary agent-assembled pipelines, and enforcement in the registry
alongside `unit` — because a docstring is not a control surface for an agent.
The unit of classification is the **11 kernels**, not the ~120 studies, so the
work is bounded and future studies inherit. Two consequences fall out before
any code: K7 (rolling regression) and K8 (bivariate moments) are `unbounded`,
and K6 (path-dependent state machines) is not partitionable at all.

Extended to the **whole** composable surface, not just the financial kernels:
core operators (`align`/`fill`/`aggregate`/`diff`/`pctChange`/…), the transforms
an agent reaches for when exploring visually (`byValue`, `byColumn` histograms),
and the folds that become facts. Two findings there stand independent of any
parallelism: **`pctChange` is unbounded and already shipped unflagged** (it
divides by the previous value), and a fourth idea is needed — **discretising**
operators (bins, ranks, crossings, `argmax`) turn _any_ upstream inexactness
into a categorical difference, so `bollinger` → "crossed the band" is discretely
unstable on `main` today from blocked summation alone, with no workers involved.

Not a commitment. Red-team it before anything commits to it.

### `@pond-ts/financial`

Calendar engine + trading-time axis + the first studies batch (10 studies,
pandas-oracle-verified) have shipped. Plan:
[PND_FINANCIAL_PLAN.md](docs/plans/PND_FINANCIAL_PLAN.md) · assessment:
[financial-indicators-assessment-2026-07.md](docs/notes/financial-indicators-assessment-2026-07.md).

- **[PND-STUDY]** — Studies Phase-1 breadth: RSI, MACD, ATR(+bands),
  stochastics, %R, Donchian, OBV, VWAP, HV, momentum/ROC — each with the
  TA-Lib + pandas oracle and a fluent method.
- **[PND-SFOLD]** — K6 stateful-fold kernel for Phase-3 studies
  (PSAR/SuperTrend); design when a consumer pulls.
- **[PND-TCAL]** — Trading-time deferred items: point-key slot widths on the
  discontinuous axis, exchange-tz tick grain, cursor timezone control,
  overnight sessions in `fromRules`.

### Live layer

Robustness debt plus the queued composition workstreams. Plan:
[PND_LIVE_PLAN.md](docs/plans/PND_LIVE_PLAN.md).

- **[PND-LIVFIX]** — **The standing live-correctness P1**: listener error
  isolation, re-entrancy, unbounded partitions, chained dispose, and the
  reorder+retention windowed-extrema bug. Confirmed wrong-answer behavior,
  not optimization.
- **[PND-LATE]** — Late-event propagation through stateful live transforms
  (needs a reorder-aware event payload; overlaps [PND-CHANGE]).
- **[PND-LJOIN]** — Live merge / join across sources.
- **[PND-LALIGN]** — Live `align` + `materialize` (bounded-lag design);
  prerequisite-or-sibling of [PND-LJOIN].
- **[PND-LDEDUP]** — Live dedupe converging on the batch `keep` shape.
- **[PND-BUFWIN]** — Buffer-as-window Tier 1 (`live.reduce` sugar,
  `timeRange`, `eventRate`, naming) + Tier 3 slicing later.
- **[PND-TRIG]** — Trigger taxonomy: `Trigger.any` composition; the
  `Trigger.idle` wall-clock RFC moment (gate on a second signal).
- **[PND-RESV]** — Live-side reservoir sampling; gated on [PND-CHANGE]'s
  exact-removal eviction channel.
- **[PND-TAPOBS]** — Evaluate `tap()` per-partition observer now that fused
  rolling shipped.

### Streaming semantics (Phase 4.5)

Adopted milestones A–D from [streaming.md](docs/rfcs/streaming.md): explicit
time, lateness, finality, keyed state, structured change metadata. B/C/D were
sequenced behind the columnar substrate, whose batch side is now complete.
Plan: [PND_STREAMING_PLAN.md](docs/plans/PND_STREAMING_PLAN.md).

- **[PND-CHANGE]** — Milestone A: `LiveChange` source-side change model
  (append/reorder/evict), internal-first, 5% perf budget. Foundational;
  unblocks [PND-RESV] and [PND-LATE].
- **[PND-REPAIR]** — Milestone B: capability-based late repair. Design-ready
  but driver-light by empirical test — wait for a consumer whose measurement
  style surfaces it.
- **[PND-FINAL]** — Milestone C: output finality (`append`/`upsert`),
  wire-safe `AggregateEmission`, stable output IDs. Prerequisite for
  [PND-SERVER].
- **[PND-KEYED]** — Milestone D: `keyBy/window/aggregate` builder with
  per-key grace, stable identity, `keyTtl`.

### Columnar substrate (remaining levers)

Batch columnar is complete; live columnar sits at a defensible
retention-boundary waypoint. Everything left is friction-gated with a named
consumer signal. Plan:
[PND_COLUMNAR_PLAN.md](docs/plans/PND_COLUMNAR_PLAN.md).

- **[PND-COLOUT]** — Column-native output (§A): removes the dominant
  emit-side allocation slice; spike plan exists.
- **[PND-COLBOOL]** — `boolean` / array value columns through the columnar
  ingest engine. `ingestColumnsToStore` takes `number` and `string` only, so
  a series carrying either kind exports through `toColumns` / `toArrow` but
  cannot come back — the round trip is a compile error on the columnar door
  and a throw on `ValueSeries.fromJSON`. On `TimeSeries` those kinds are
  ordinary (the row constructor takes them), so this bites more often than
  the `ValueSeries` case that surfaced it. The engine work is small — a
  `'boolean'` branch building a packed bitmap and an `'array'` branch over
  `arrayColumnFromArray`, plus the sort permutation for both — but it widens
  `RawColumns` and `fromColumns`' contract, so it wants its own PR.
  Friction-gated: no consumer has asked yet.
- **[PND-TSJSONT]** — narrow `TimeSeries.toJSON`'s return type on
  `rowFormat`, as `LiveSeries.toJSON` already does. Long blocked by the
  TS2394 cascade, which [PND-TSCOLS] isolated: the trigger is a
  key-remapped mapped type in a **method return position on `TimeSeries`**,
  and a method-level type parameter defers past it (the workaround
  `toColumns` now uses, written up on its doc comment). Unblocked, but it
  changes an existing public return type, so it needs its own decision.
  While in there: `toJSON()`'s **tuple** rows measure consistently _slower_
  than its object rows (25.9 ms vs 18.6 ms at 100k × 6) — the tuple path
  allocates a `.map()` plus a spread per row where the object path writes
  properties into one literal. Probably a free win.
- **[PND-REORD]** — Columnar reorder corral (§B): unearned, RFC context
  until a signal arrives.
- **[PND-LROLL]** — Live rolling columnar reducer state (Step 3C-live): the
  only lever for the gRPC ceiling; parked at 2.1× headroom.
- **[PND-PLANNR]** — Aggregate planner (step 5): friction-gated.
- **[PND-DICT]** — Dictionary/string reducer adaptation (step 6):
  friction-gated.
- **[PND-KERNEL]** — Kernel algorithm wins surfaced by the Rust/WASM spike
  (`spikes/columnar-wasm/`, report + benchmarks committed). The spike says
  **not now, not in this order** on porting the substrate (revised from an
  earlier "no-go" — see REPORT.md §9: a Rust core is worth 1.3–4.3× on the
  numeric kernel, and 2.2–2.6× end to end on the reduce family, but the
  TypeScript work below is 5–10× larger and comes first). The control
  experiment isolated four wins that are pure algorithm and land in
  TypeScript. Two have shipped:
  - **Quickselect for `reducePercentileColumn`** — measured 12.9× on
    `median`/`p95` at 1M rows.
  - **Blocked (8-accumulator) `sum`/`mean`** — 2.51× dense, 2.22× through a
    validity bitmap, **`close.mean()` 0.47 ms → 0.19 ms** end to end. The
    semantics decision this was blocked on is made and recorded in
    [blocked-summation.md](docs/notes/blocked-summation.md): reassociate
    above a 32-cell threshold, leave shorter runs bit-identical. Worth
    noting the direction — blocked summation is _more_ accurate than
    sequential (error grows as O((n/k)·ε + k·ε) rather than O(n·ε)), so the
    trade was speed **and** precision against reproducibility of the exact
    previous bits, not speed against accuracy.

  Remaining: a branchless finite guard for `allFinite: false` reductions,
  and blocking the guarded sum path (measured **1.84×**, deliberately not
  taken — after [PND-WCNAN] almost nothing lands there; see the note).

  **Correction: the 4-lane `Float64Column.minMax` is _not_ bit-identical**,
  as this entry previously claimed. `+0` and `-0` compare equal, so
  `lo <= x ? lo : x` keeps whichever the traversal reached first, and
  lane-parallel traversal reaches a different one — verified: 16 cells, all
  `1` except `values[1] = +0` and `values[4] = -0`, sequential gives `+0`
  and 4-lane gives `-0` (`===` equal, `Object.is` not — and vitest's `toBe`
  uses `Object.is`). `minMax` explicitly commits to matching
  `[col.min(), col.max()]` (PR #153), so the lane form would break that
  commitment on `±0` input for 1.27–1.50× on an operation already costing
  0.49 ms. Not worth it as scoped; if it is ever wanted, it needs a signed
  zero fixup in the combine, not a straight lane split.

  Acceptance benchmarks already exist in
  `spikes/columnar-wasm/bench/controls.mjs`; each control is checked against
  pond-ts's answer before it is timed.

- **[PND-NANREP]** — Audit whether the validity bitmap earns its keep on
  **numeric** columns. Measured on a 1M column with 4% missing, same values
  and same answer, varying only how "missing" is encoded: dense (no bitmap)
  0.936 ms, **bitmap 1.398 ms (1.49×)**, **NaN-in-buffer 1.118 ms (1.19×)** —
  so the bitmap representation costs ~25% more than NaN on a scan kernel.
  Worse, the two encodings now coexist in the hottest path: after
  [PND-STUDYBOX] one `sma(20)` converts bitmap→NaN (0.81 ms) and back
  NaN→bitmap (1.32 ms), **2.12 ms of pure representation churn, ~21% of the
  call**.

  What the bitmap genuinely earns: it is **irreplaceable for string / boolean /
  array columns** (no NaN to borrow), and it gives `count()` / `nullCount()` /
  `hasMissing()` an O(1) answer from the cached `definedCount` — though a NaN
  scheme could cache the same integer.

  What it buys on numeric columns is thinner than it looks: the ability to
  distinguish a _defined_ NaN from a gap. The reducer non-finite policy already
  treats both as missing, row intake rejects non-finite outright, `fromColumns`
  maps it to a gap, and `withColumn`'s typed door now does too — so a defined
  NaN only arises from an operator's own arithmetic overflow, and only shows up
  through `at(i)` / `scan()` on an `allFinite: false` column.

  Not a small change: it moves an observable semantic. Scope it as a design
  note first, with the `at(i)` behaviour on `allFinite: false` columns as the
  decision point. Ties to [PND-WCNAN], which already chose NaN-as-missing for
  typed intake.

- **[PND-AGENTQ]** — The measured shape of the current agent workload, kept as
  the standing acceptance benchmark:
  `packages/financial/scripts/perf-agent-queries.mjs` (500k 1-minute OHLCV
  bars, resident, per-query latency). Run it before and after anything
  touching studies, `rolling`, or the reducers.

  A 5-study strategy pass has gone **318 ms → 84 ms (3.78×)** across
  [PND-ROLLKERN] and [PND-STUDYBOX]; summary facts were already under 3 ms and
  are unchanged. Studies remain the dominant cost by an order of magnitude, so
  they stay the place effort belongs. Current: `bollinger(20)` 31.5 ms,
  `zScore(20)` 26.5 ms, `envelope(20)` 12.5 ms, `sma(20)` 10.5 ms,
  `percentChange()` 4.5 ms, `ema(20)` 3.9 ms.

  **Against the pandas oracle** (`scripts/perf-vs-oracle.mjs`, the timing
  counterpart to the correctness oracle): the strategy pass has gone from
  **5.6× slower than pandas to 1.64×**, and `median` / `percentile` are now
  _faster_ than pandas (0.98× / 0.85×) on the back of the quickselect change.
  Worst case is 2.39×. Two architectural differences explain most of what is
  left and are the honest next question: pandas tracks missing values as
  **inline NaN** in the same float64 buffer where pond-ts tests a **validity
  bit per cell**, and pandas mutates a frame in place where every pond-ts
  operation returns a new immutable series.

  Next candidates, in the order the numbers suggest: a `stdev` specialisation
  in the rolling kernel (now the dominant per-row cost in `bollinger` /
  `zScore`, and the one reducer deliberately left on the state path because its
  order-independent Welford delete is not worth duplicating carelessly);
  `ema`, which is now the only study that did not move because it composes on
  `smooth` rather than the rolling kernel; and re-asking the Rust question
  against this new baseline (`spikes/columnar-wasm/REPORT.md` §10).

- **[PND-BOXFREE]** — Element-wise operators box every cell. **`cumulative`,
  `diff`, `rate` and `pctChange` are done (4.0–7.1×); `fill`, `shift` and
  `mapColumns` remain.** They are column-native only in the
  sense of not materialising `Event`s: they still read each cell through the
  polymorphic `read(i)` into a `ReadonlyArray<number | undefined>` and rebuild
  via `float64ColumnFromArray`. Measured **~10–20× slower per column than a
  plain typed-array walk** (exact `diff` control: 9.9× on gappy data, 17.1×
  dense; `rate`/`fill`/`shift` fitted at 16–27×). At 1M rows × 4 columns
  `diff` costs ~294 ms against ~16 ms for the same work unboxed. This is the
  largest single performance finding from the Rust/WASM spike and has nothing
  to do with Rust — see `spikes/columnar-wasm/REPORT.md` §9.3. Each operator
  needs its own validity write, since the boxed array is currently how
  validity gets derived; [PND-IVLCOL] is the worked example of that shape.
- **[PND-COLAPI]** — Make the column-API augmentation bundle-safe (F-1,
  HIGH — methods tree-shake out of browser bundles) + validity-aware
  `toFloat64Array({ missing })` + `hasAnyDefined()`. Two consumers each.
- **[PND-WIRE]** — Protobuf columnar wire codec + `SeriesUpdate` streaming
  append; design settled, build when the binary WS feed consumer arrives.
- **[PND-INGEST]** — `fromColumns({ onOutOfOrder: 'throw'|'sort'|'clamp' })`;
  fold the day-old `sort` boolean into the enum.
- **[PND-TSVAR]** — `TimeSeries<S>` variance refactor (`toJSON` narrowing,
  `required: false` rows); try the extracted-serializer path first.
- **[PND-GATHER]** — Dashboard snapshot-cost queue:
  `partitionBy().toMap()` gather-only, `column.dropMissing()`, two doc
  nudges.
- **[PND-AUDIT]** — v2-audit P2 backlog (papercuts, parity matrix, CI TZ
  matrix + perf-in-CI, schema helpers, bundle re-pin).
- **[PND-CITYPE]** — Widen CI type-checking to `test/` (the v0.14.2 slip
  class); ~half a day of existing-error cleanup first.
- **[PND-PERF]** — Low-priority micro-perf leftovers from the original
  audit; address incrementally.
- **[PND-REACT]** — React remainders: `dt = 0` docs, dashboard-guide fixes,
  `useSyncExternalStore` migration.

### `@pond-ts/process` — declarative processing graph

A package that turns "compute these derived series" from imperative calls into
a declarative graph: plans arrive as data, a registry is the schema, identity is
content-addressed, and one request serves both a renderer and an LLM tool
caller. Design: [process.md](docs/rfcs/process.md) (RFC — context, not a
commitment). Task detail, and the measurements each task is sized against:
[PND_PROCESS_PLAN.md](docs/plans/PND_PROCESS_PLAN.md).

Ordering note: `PROCIDENT` blocks any interactive consumer, `PROCCOL` is a
force multiplier for both `PROCIDENT` and `PROCRANGE`, and `PROCRANGE` is
blocked by `PROCKERN` in `@pond-ts/financial`. The engine itself landed in
[#544](https://github.com/pond-ts/pond/pull/544) as a **WIP, unpublished**
package (`private: true`) so this can be worked in the open; `PROCSUB` owns
whether it stays one.

- **[PND-PROCIDENT]** — Decide how node identity is assigned, which decides
  cache lifetime. Content-addressed params accumulate by design (right for the
  MCP shape, where a repeated question should hit cache); params-as-Ins are
  bounded by the plan's shape (right for a UI, where a superseded slider
  position is worthless). Measured over a 200-position sweep: 200 nodes /
  310 MB of buffers versus 1 node / 6 MB — flat rather than linear in sweep
  length. The RFC's two consumers want opposite policies, so this is a design
  call, not a leak to patch; an earlier framing of this ticket blamed the graph
  for what was a plan-layer map. **Blocking for any interactive consumer.**
- **[PND-PROCCACHE]** — **Shipped**, and half of it turned out to be already
  built. `bind(…, { budgetBytes })` caps retained node values engine-wide,
  LRU, enforced after each run; `retainedBytes` / `evictions` observe it.
  60 distinct params × 200k rows: **147 → 26 MB rss** (5.6×), 60 nodes → 7,
  with repeats still hitting and no eviction churn.

  **The half not to rebuild:** the ticket wanted an op to declare which Ins
  key its result. `specId` is already content-addressed over op, params and
  inputs, so the same question hits the same node by construction — a per-op
  key would sit beside a correct one. What was genuinely missing is the
  capacity, and the ticket is right that it cannot be the op's: a per-op cap
  is a per-op promise and nothing supervises the total.

  **The open question is closed: bytes, not entries.** Entries are not the
  unit anyone has a limit in (one node over 1M rows outweighs fifty over
  5,000), and bytes only became knowable once [PND-PROCCOL] made node values
  columns. Eviction skips a node whose consumer still holds its outlet —
  dropping it frees nothing and forces a recompile.

- **[PND-PROCSEL]** — Selective per-Out invalidation already works: a
  bollinger-shaped node changing `stdDev` leaves `middle`'s version untouched
  and its consumer idle, because the op hands back the same instance. Document
  it, and let the registry declare which params each output depends on so the
  corpus gets it by declaration rather than by hand. Sharpens the RFC's "the
  cutoff cannot fire" — true for whole-series identity compares, false per-Out.
- **[PND-PROCCOL]** — **Shipped.** Node _column_ outputs were already packed;
  what stayed boxed was the **fold context**, which densified an
  `Array<number | undefined>` per input per version. `columnView` gives folds
  a zero-copy borrowed view, `FoldContext.numeric(role)` hands it over, and
  `FoldContext.values` became a **lazy getter** so an untouched role costs
  nothing. All four built-in folds migrated. 20 folds × 500k rows: warm run
  **606 → 383 ms**, heap at peak **35 → 25 MB**, rss **204 → 173 MB**.

  **The result is about fold shape, not representation, and the distinction
  is the reusable part.** Columnar is _not_ faster to read — a buffer walk
  reaches parity with a boxed array, and `Column.scan()` is **4.7× slower
  than either** because it takes a callback per cell. The 1.58× is the
  densify disappearing for folds that read a few cells: `last` reads **one**
  and was paying to densify 500,000. A whole-column fold gets the memory win
  and nothing else. Core's design principles recommend `scan` as the
  columnar read path, which is worth revisiting on this evidence.

  Also worth keeping: measuring `heapUsed` _after_ a `gc()` reported ~0 MB
  for both paths and said nothing, because the densified arrays are garbage
  the moment the fold returns. What costs pause time is garbage produced,
  not bytes retained — so the benchmark samples the heap before collecting.

- **[PND-PROCTERM]** — **Shipped**, though the win was not where the ticket
  looked. It framed this as the _terminal_ rebuilding a series so a
  reduction had a column to read — and that part was already handled: a
  facts-only request has an empty `needed` set and assembles nothing. The
  live cost was one layer down, in **every node's `compute`**, which widened
  the source with `appendColumn` per nested input so an op could call the
  corpus normally. A fold needs no series at all; the column it reads is
  already in its inputs.

  What made it expensive is a core gap: `appendColumn` **boxes a gapped
  column**, because core's `withColumn` takes values rather than a column —
  22.4 ms per column at 1M rows, and every rolling study is gapped. The
  costly path was the ordinary one. Exposing `withColumnAppended` would
  remove the fallback for column-producing ops too, which still pay it.

  20 folds × 500k rows: **383 → 129 ms** (2.96×), rss 173 → 113 MB; with
  [PND-PROCCOL] together, **606 → 129 ms**. The old 52×/441× figures were
  measured against a different baseline (whole-series assembly per
  reduction, at 1M rows) and are not comparable to these.

  Reductions read node values directly, and a renderer pulls
  per-study arrays. Sharp edge: the terminal must resolve the closure of every
  id a selector mentions, including `crossings`' `against` — assembling only
  the column-selectors yields a fact with no value rather than an error.

- **[PND-PROCJOIN]** — Make the join a node: n series in, one aligned column
  set out, alignment policy in the id (inner vs as-of changes the answer). This
  is what lets a cross-source spec exist at all — separate graphs cannot hold
  one, and hand-combining misaligned instruments silently pairs different
  dates. Needs no engine change; `Graph` has no per-graph boundary today.
- **[PND-PROCHIST]** — **Shipped.** `requiredHistory(registry, plan)` plus a
  per-op `OpDef.lookback`. On an 8-study stack over 500k rows with a 5,000-row
  display: **97 → 1.3 ms/tick, 75×** (10 → 773 ticks/sec), **zero truncated
  cells** at the derived tail and **exactly one** at a tail one row shorter —
  so the bound is tight rather than merely safe, which is the half of the
  acceptance bar that arithmetic alone would have passed.

  Two design calls worth keeping. Lookbacks **sum along a nested chain**
  (`sma(20)` over `sma(50)` is 69, not 50); a max under-provisions by exactly
  the amount that yields defined, plausible, truncated answers. And an
  undeclared lookback reports `known: false` naming the op instead of
  defaulting to zero — a missing declaration and an element-wise op are the
  same value with opposite meanings.

  **Interaction with [PND-PROCKERN], found by measuring rather than
  predicted:** a sliced tail agrees to ≤5.8e-13, _not_ bit-for-bit. Slicing
  builds a new shorter series, which re-indexes every row, and the rolling
  kernel pins its accumulator rebuilds to absolute row index. So PROCKERN's
  bit-identity covers **a range of the same column** — which is what
  PROCRANGE does — and does not extend to a re-indexed copy. Worth stating
  before PROCRANGE lands, because the two are easy to conflate.

- **[PND-PROCRANGE]** — **Mechanism shipped; the ceiling is not reached.**
  `setSourceFrom(series, changedFrom)` plus an opt-in `OpDef.runRange`.
  500k rows, 5 studies, 20 ticks: **209 → 55 ms/tick (4×)**, bit-identical to
  a from-scratch pass every tick.

  **The purity question resolved better than expected.** Rather than
  `markDirty()` carrying a payload and `compute` reading its own last output
  as state, the previous output is passed **as an argument** — so an op stays
  a pure function of declared inputs and `explain` keeps describing what a
  value depends on. The mutable part lives in the graph, which is a cache and
  was already stateful. No purity was traded.

  **Opt-in, and that is the safety property.** An incremental result must be
  bit-identical to a from-scratch one or answers depend on edit history —
  invisible to any test that only computes from scratch. True for
  [PND-PROCKERN]'s range-exact kernel; **false** for `median`, percentiles,
  `min`, `max`. Declaring nothing means full recomputes: correct, slower.

  **Remaining, and it is the larger half of the projected win:** 4× against a
  projected 26×/~7000×. The gap is in the _op_, not the graph — a `runRange`
  that copies the whole prefix out of `previous` before patching is O(n) per
  tick, which is what the plan meant by "reallocating its output array". This
  needs a **capacity-buffer contract** so an op can extend the previous column
  rather than rebuild it, on top of [PND-PROCCOL]'s packed values.

  **A correction to the plan's range formula.** It said an upstream dirty
  range `[a,b)` becomes `[a-lookback, b)`. For a **trailing** window a change
  at row `r` dirties output cells `[r, r+period)` — _forward_ — and since the
  graph always recomputes to the series end, `[changedFrom, length)` already
  covers it. Removing the backward widening fails no trailing-window test,
  which is how this was found. The widening is kept because it is what makes a
  **non-causal** op correct, and the graph cannot tell the two apart; there is
  now a centered-window test that fails without it.

- **[PND-PROCKERN]** — **Shipped**, and it turned out to be a correctness
  task wearing a performance task's clothes. `rollingMeanSdInto` in
  `packages/financial/src/kernels/ranged.ts` fills any `[lo, hi)` with the
  exact bits a full pass writes — a 100-row fill is **3964× cheaper** than
  recomputing the column and **bit-identical**, which is the ceiling
  [PND-PROCRANGE] can now aim at.

  **The finding that reorders PROCRANGE:** a ranged recompute on the old
  sweep differed on _every cell_ of the range (~1e-10 relative), because an
  accumulator carries rounding history from row 0. PROCRANGE's recorded "26×
  with identical results" was therefore not achievable as specified — the
  value would have depended on which ranges happened to be dirty, i.e. on
  edit history rather than data. Two callers with the same data would
  disagree. Fixed by rebuilding the accumulators every `period` rows and
  pinning the rebuilds to **absolute** row index, so a ranged sweep
  reconstructs the state a full sweep held; read-back is ≤ `2·period`.

  Three things came free, and one nearly went wrong:
  - **`withWorkers` is now bit-identical** to sequential for every study, at
    any magnitude. The whole per-study accuracy table collapses — chunk
    boundaries stopped existing rather than being characterised better.
  - **Everything got faster**: `bollinger(20)` **46.5 → 18.4 ms** (avg and σ
    fuse into one sweep instead of core running two reducers), `envelope`
    13.1 → 10.6, `sma` 6.7 → 6.2, the 5-study stack 58.3 → 49.9.
  - **Accuracy improved at every magnitude**, 3.6e-3 → 4.4e-16 at 1e15 —
    which retires the `bollinger` instability logged as debt below.
  - **The near-miss:** aligning the rebuilds _without_ also shifting the
    frame made large-magnitude σ **worse** (3.6e-3 → 1.7e-2), because
    rebuilding more often only re-does ill-conditioned arithmetic more
    often. Caught by measuring rather than reasoning. The two are one
    change, not two.

- **[PND-PROCREG]** — Plan rehydration across processes. Ids round-trip, a
  compiled graph does not; persisted views recompile from the stored plan.
  Deliberately no `fromJSON` yet. Two verified properties must become stated
  requirements: `specId` is invariant under param key order, and an omitted
  param collides with its explicit default.
- **[PND-PROCSCHEMA]** — The schema projection is the caller's contract. M2 found
  the recursive `$ref` was **not embeddable** — it resolves against the document
  root, so the projection silently dangled inside a tool's `input_schema`; fixed
  with `toJsonSchema({ base })`. Open: the projection carries no units, in either
  direction, so a caller cannot know `annualise` refuses a raw price without a
  `describe()` table in the prompt.
- **[PND-PROCSLOT]** — Caller-assigned **slots**, separating topology from value.
  Params are part of a node's id but do not change the shape, so the format uses
  one identity for two jobs. A slot (`bb`) is stable across a param edit and
  names a position; `specId` still keys the cache. Fixes `on` restating whole
  nested specs, makes refinement a patch, stops the pipeline view re-laying-out
  on a param change, and lets surfaced outputs carry the requester's own names
  — which is what a Tidal card is. Slots are an alias layer, not a replacement:
  M5's 2.811 ms return trip works _because_ the node persisted under its content
  id. Connections stay on the node (no full node editor is wanted); how a slot
  reference is disambiguated from a source column name is open.
- **[PND-PROCSOURCE]** — Harden the new opaque async-source boundary. The first
  slice (`defineSource`, `SourceRegistry`, `Host.runAsync`) keeps loaders and
  credentials host-side, preserves a bound graph across equal revisions, and
  coalesces concurrent calls for one source identity. Remaining:
  cancellation/freshness policy, source schema projection for remote composers,
  and a measured revision contract.
- **[PND-PROCSUB]** — Decide the substrate and packaging: the RFC concludes one
  package with the engine internal, while [#544](https://github.com/pond-ts/pond/pull/544)
  proposes publishing it. Evidence now favours keeping the graph (1.34–1.40× on
  MCP flurries at 1M rows; 1/N invalidation at N sources) with the honest
  caveat that the advantage is zero at a single source.
- **[PND-LIVESRC]** — Core-side: `LiveAggregation` does not satisfy
  `LiveSource<S>`, because its `on('event')` overload widens the listener's
  event type. Narrow the overload, or give the incremental operators their own
  named contract. Touches a public type — needs sign-off.
- **[PND-PROCPAR]** — Worker-thread parallelism. Two shapes; the **throughput**
  half has shipped and the **latency** half has not.

  **Shipped: `HostPool` (`@pond-ts/process/pool`)** — whole requests routed
  across workers, each holding a long-lived `Host`. No engine change: a plan
  is JSON, a registry is a module both isolates import, and a result's columns
  travel as transferable buffers. Measured
  (`packages/process/scripts/perf-pool.mjs`): **3.1–4.0× on distinct requests**
  at every size from 0.5 to 10 ms each — but **~0.01× on repeated ones**, where
  the in-process memo returns the same column for nothing and a pool ships
  every answer regardless. **Cache-hit rate decides it, not request size**; an
  earlier "crossover below 2 ms" reading was a warm-up artifact (one warm-up
  request per worker against a JIT-warm baseline — the same V8 tier cliff
  `blocked-summation.md` documents). Also measured: the same op writing a
  `Float64Array` rather than `new Array(n)` beats eight workers on the boxed
  version from a single thread, so op shape matters more than worker count.

  **Also open: parallel-scan kernels ([PND-SCANKERN], new).** The note's
  "sequential recurrences cannot be helped" was wrong. `y[i] = a·y[i-1] + b[i]`
  is the textbook parallel-scan case; measured (`spikes/parallel-scan/`) EMA
  over 2M rows goes **4.45 → 1.42 ms (3.14×)** with **99.91% of cells
  bit-identical** — a decaying recurrence's correction term underflows to zero
  a few hundred cells into each chunk, so most cells are literally the same
  arithmetic. Two barriers, no log-depth tree. Needs **no process-engine
  change** (raw workers over a `SharedArrayBuffer`), so it belongs to the
  kernels and is not blocked behind the injection seam. Costs: ~72 µs per
  barrier, so it needs work above ~150 µs and will not pay below ~100k rows;
  and SAB-backed (or copied) inputs. The prize is not `ema` — already 2.08 ms
  — but that the same reasoning reaches the operations that _are_ slow, and
  that "inherently sequential" is a far weaker claim than it looks.

  **Rolling windows partition — SHIPPED as [PND-SCANKERN].**
  `withWorkers` in `@pond-ts/financial/parallel` (Node-only, opt-in at ingest;
  studies stay synchronous via `Atomics.wait`, which is also why it is absent
  in browsers). One accelerator hook on `rollingColumns` serves `sma`,
  `envelope`, `bollinger` and `zScore`. Measured over 500k bars, 8 workers:
  1.83× / 1.32× / 1.86× / 2.45×, three-study stack 1.98×. Answers shift
  slightly — 3.9e-14 to 5.1e-13 for everything except **`zScore` at 2.6e-6
  across ~0.8% of cells**, which divides by a near-zero rolling σ; documented
  as the reason the opt-in is a choice rather than a default. Below 100k rows a
  registered series still runs sequentially, bit-identical. The bare kernel
  partitions 13.8× (`spikes/parallel-rolling/`); the gap to the shipped numbers
  is the arena copies and each study's own pointwise arithmetic, both of which
  stay on the main thread so that one hook can serve every study without a
  second copy of any study's logic. Remaining in this family: `ema` /
  `cumulative` via parallel scan (`spikes/parallel-scan/`, 3.14× measured,
  99.91% bit-identical), not yet wired to a study.

  **Remaining: the latency half** — split one composite query's nodes across
  workers (spike measured 2.42× on the 5-study stack, bit-identical). Blocked
  on an engine change the spike did not surface: a node's value can only be
  produced by its own `compute`, which is contractually pure, so a result
  computed in another isolate **has nowhere to land**. That injection seam, plus
  a ready-set scheduler over the compiled DAG and the financial studies as
  registry ops over shared rolling primitives (mean/std dedup → estimated ~15 ms
  critical path, polars-mt territory), is the rest of this ticket. Full
  assessment:
  [worker-threads-assessment-2026-07.md](docs/notes/worker-threads-assessment-2026-07.md).

### Process demo — composer / request / results

A three-panel web app where a prompt becomes a process plan, the plan resolves
against a bound dataset, and the result is charted — clicking a node in the
pipeline shows that node's output. It is a demo, but its primary job is to
**decide the library's shape**: six open tickets in the process section rest on
questions no argument settles, and each milestone here answers one. Plan:
[PND_PROCESS_DEMO_PLAN.md](docs/plans/PND_PROCESS_DEMO_PLAN.md).

Pinned before any code: the bound graph is **long-lived, wherever it lives** —
per-request construction is what is fatal, not any particular host. A long-lived
worker and a long-lived server prove different things (client-side execution and
an off-main-thread UI, versus the MCP shape with one cache shared across
sessions). The worker topology is **coupled to [PND-PROCCOL]**: crossing a
thread boundary costs 48.6 ms per 500k-value answer boxed versus 0.5 ms
transferred, so without columns a worker spends more time marshalling than
computing. `as` names an output rather than windowing it; `registry.toJsonSchema()`
is the agent's contract, not a hand-written prompt.

- **[PND-DEMOM0]** — The plan layer, headless: `bind`, registry, `specId`,
  `run`, `explain`, typed and tested. Decides [PND-PROCSUB] (does anything
  outside the plan layer still import the engine?) and [PND-PROCIDENT] (`run()`
  cannot be written without choosing how a param is identified).
- **[PND-DEMOM1]** — A long-lived host (worker or server) holding
  `Map<datasetId, BoundGraph>`, one seeded dataset, submit-and-return, still
  no UI. Response carries **per-node
  computed-vs-cached and a duration** — the architecture is invisible without
  it. Decides [PND-PROCTERM].
- **[PND-DEMOM2]** — Three panels, `raw` tabs only; agent composes plans from
  the registry schema. Decides [PND-PROCSCHEMA]: is the projection enough to
  compose valid plans unaided, and can the agent self-correct from `skipped`
  reasons? Landed as `apps/process-demo`, outside the root `workspaces` so a
  demo build never gates a release. The composer sits behind a seam: without
  `ANTHROPIC_API_KEY` it falls back to an offline keyword matcher that exercises
  every panel and **settles nothing about the registry**, and says so.
- **[PND-DEMOM3]** — Results charts via `@pond-ts/charts`, chosen by key kind
  (time → line, multi-output → band). Decided the remainder of [PND-PROCCOL],
  and **not as the fork it was framed as**: charts already traverses columnar,
  so the layers' `series` + `column` signature was fine — what was wrong was
  assembling on the producer side, where a `TimeSeries` cannot cross a wire.
  Landed `run({ assemble: false })` + `RunResult.columns`; the browser rebuilds
  with `TimeSeries.fromColumns`, which adopts buffers zero-copy. Drawing costs
  **transport, not compute** (5.72 MB for two studies at 150k rows vs 5 ms to
  encode) — a second argument for the worker topology. [PND-LIVELYR] did not
  bite.
- **[PND-DEMOM4]** — Pipeline graph with clickable nodes (React Flow + dagre),
  labelled by `explain` and badged cached/Nms; clicking shows that node's
  output. **Landed, and the "costs almost nothing" claim held** — clicking a
  node is one more `columns: true` selector on an id the response already
  names, including a _nested_ spec that never appears at the plan's top level.
  Two additions, both the response failing to describe its own graph:
  `NodeTiming.inputs` (the edges — underivable without reimplementing
  `specId`) and `NodeTiming.pulled` (`nodes` had reported only the subset a
  selector reached, so the view drew a plan with branches missing).

- **[PND-DEMOM5]** — Conversational refinement: follow-up prompts that adjust an
  existing plan. **Landed, and it decided [PND-PROCIDENT].** "smoother" → "try
  200 instead" → "back to how it was" returns in **2.811 ms against 75.071 ms
  cold**, the node a straight cache hit at 0.004 ms — because a
  content-addressed `sma(50)` is never invalidated by a detour, only unused.
  Three nodes resident afterwards is the bill, and the case for
  [PND-PROCCACHE]'s engine-wide budget. The capacity dial is deliberately not
  here: there is no node cache to tune yet, and rushing one to make a demo
  slider work would let the demo design the library.

### Ecosystem (Phase 6)

Adapters and deployment-shape packages, after the streaming milestones they
depend on. Plan:
[PND_ECOSYSTEM_PLAN.md](docs/plans/PND_ECOSYSTEM_PLAN.md).

- **[PND-SERVER]** — `@pond-ts/server` extraction from the gRPC experiment's
  aggregator shape (WS-snapshot-then-deltas, coalesce strategy, slow-client
  policy). Depends on [PND-FINAL] + [PND-KEYED].
- **[PND-NODE]** — Node stream adapters + third-party chart bridge helpers
  (`toRecharts`, `toObservablePlot`).
- **[PND-FITPUB]** — `@pond-ts/fit` first-publish pass: deliberate export
  list, units-preference home, then publish and hand estela the swap.

---

## Active experiments

Canonical roster (philosophy in CLAUDE.md; detail + queued coordination in
[PND_EXPERIMENTS_PLAN.md](docs/plans/PND_EXPERIMENTS_PLAN.md); full histories
in [docs/archive/experiments-2026.md](docs/archive/experiments-2026.md)):

| Track              | Agent  | Status / next                                                                     |
| ------------------ | ------ | --------------------------------------------------------------------------------- |
| Tidal (financial)  | Claude | Most active loop; drives [PND-STUDY] + charts friction; auto-woken on npm publish |
| estela (geo/power) | Claude | Waiting on [PND-FITPUB]; then adopts fit + charts from npm, deletes local copy    |
| Dashboard          | Claude | Next: adopt `@pond-ts/charts`, report gaps/perf vs its hand-rolled charts         |
| gRPC pipeline      | Claude | M3.5 realized; remaining: writeup + M5 extraction sweep (3 RFCs → [PND-SERVER])   |
| Webapp telemetry   | Codex  | In production; watch for friction reports                                         |
| Charts experiment  | Claude | First `@pond-ts/charts` package consumer; annotation dogfood, ongoing             |
| Robustness audits  | fresh  | Re-run as the available model improves; residue → [PND-LIVFIX], [PND-AUDIT]       |

---

## Cross-cutting work

These happen throughout rather than being scheduled:

- keep this roadmap current whenever a meaningful milestone lands (move
  completed tasks' outcomes into their breakout plan)
- keep the docs site aligned with shipped behavior
- add end-to-end examples whenever a major capability lands
- keep API reference generation working in CI
- expand tests alongside every new public API
- prefer benchmark-backed changes for performance-sensitive core refactors
