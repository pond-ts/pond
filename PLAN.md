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
- **[PND-OBSDOC]** — "Observing pond-ts in production" how-to: the
  documentation-backlog items (pushMany guidance, bench-honesty callout, GC
  snippet, no-NaN guarantee, tie semantics, latency pattern) as one MDX pass.

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
