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
the decimator, and the trading-time + categorical axes; the package is
**published** (`@pond-ts/charts` on npm, `private: false`), though the
decimator wave itself is landed on `main` but **unreleased** (CHANGELOG
`[Unreleased]`, pending the next version bump). Remaining: land built work,
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
- **[PND-DECIM]** — Decimator Phase 5: candlestick decimation with Tidal;
  Path2D cache only if the pan bench misses.
- **[PND-BOXPLT]** — Finish BoxPlot: ValueSeries widening, range-only mode,
  px `offset` for same-x pairs, line-only shape, join the cursor x-snap, and
  selection `id` via rect-containment `hitTest` (#508 item 5; Candlestick
  takes the same geometry helper).
- **[PND-LEGEND]** — `<Legend>` wave (#508 item 2, design sketch accepted):
  per-layer resolved swatches, zero-config placement, `theme.legend` slot,
  hover echo + id-gated select toggle. Sequenced behind
  tracker-label-by-`as` ([PND-CURSOR]).
- **[PND-ANROLE]** — Per-annotation colour as a theme role map
  (`theme.annotation.roles` + `role` prop on the three marks; #508 item 3;
  inline per-mark colour rejected).
- **[PND-YTICKS]** — `YAxis` height-derived tick density + explicit
  `tickCount` override (#508 item 4; the width-derived-x precedent). Small.
- **[PND-CURSOR]** — Cursor/readout polish backlog (scatter 2D-nearest,
  chip de-overlap, tracker-label-by-`as`, y-oriented region cursor,
  `pointercancel` clear-only fix).
- **[PND-AXES]** — Axis backlog (label align, relative time, custom ticks,
  scale variety) + the deferred value-axis naming follow-up.
- **[PND-VALAX]** — Value axis: widen Box/Candlestick x; grow the
  `ValueSeries` algebra only when a second consumer (geo) pulls.
- **[PND-THEME]** — `cssVarTheme` candle mapping (LOW; worked example + var
  naming convention, no new plumbing).
- **[PND-WIDTH]** — Responsive width/fill for `ChartContainer` (two
  consumers hit the explicit-px requirement).
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

### Core batch + React backlog

Plan: [PND_CORE_PLAN.md](docs/plans/PND_CORE_PLAN.md).

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
