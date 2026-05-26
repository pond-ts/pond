# Chart-extraction spike — friction notes

**Branch:** `feat/charting-spike-validation`
**Date:** 2026-05-26
**Context:** Phase 4.7 step 2 just shipped; pulling forward a slice of
step 8 ("chart-extraction alignment") to validate the substrate
actually serves the chart use case BEFORE steps 3–7 commit to design
choices that depend on it.

The whole strategic justification for the columnar substrate is
"where columnar pays back NOW: the browser" (per
`docs/rfcs/columnar-core.md`). Steps 3–7 are downstream of that
justification. If chart adapters can't actually consume the
substrate cleanly, the back-half of the roadmap is mis-targeted.

## What I added (spike scope)

Two new accessors on `TimeSeries`:

- `series.column(name): Column | undefined` — returns the underlying
  columnar value column (or `undefined` for non-existent / key
  column names).
- `series.keyColumn(): KeyColumn` — returns the underlying key column
  (a `TimeKeyColumn` / `TimeRangeKeyColumn` / `IntervalKeyColumn`).

Both are documented as **spike — shape not yet stable**. Step 8 may
rename / restructure based on consumer-agent friction reports. The
spike commits no public API.

`scripts/spike-chart.mjs` measures four access paths at N=1M rows:

| Path                                                 | Median / 1M rows |       Per-cell ns |
| ---------------------------------------------------- | ---------------: | ----------------: |
| (a) Row API `events[i].get('value')` (cached events) |          5.81 ms |            5.8 ns |
| (b) Columnar API, fresh-build + walk                 |         35.44 ms | (build dominates) |
| (c) Hoisted typed-array walk                         |      **0.62 ms** |        **0.6 ns** |
| (d) Build only (anchor)                              |         34.65 ms |           34.6 ns |

**Headline: ~9× speedup** on the per-frame walk vs. the row-API
path, after both are warm. At 0.62 ms / 1M points, a chart can
sustain 60 fps walking up to ~25 million points per render — well
into "no downsampling needed for typical dashboard data" territory.

## What worked

- **The API shape is reachable.** `series.column('cpu').values`
  returns a `Float64Array`. `series.keyColumn().begin` returns the
  time-axis buffer. No private-field reach-through; no awkward
  pre-materialization step.
- **Typed-array access skips event materialization entirely.**
  Pre-spike, a chart adapter would have called `series.events`
  somewhere in its initial render, paying ~30 ms at N=1M for the
  full event-array build. The columnar path never touches the
  event cache.
- **No new mental model for the chart author.** They learn one
  thing: "narrow on `column.kind`, then read `column.values`."
  Same shape as Arrow / Polars / Pandas at the consumer layer.
- **The substrate cost is amortized at build time, not per frame.**
  Build = 34.65 ms (once per series). Walk = 0.62 ms (every
  frame). Steady-state chart perf is decoupled from data volume.

## What surfaced as design questions for steps 3–8

These are the friction items the back-half of the roadmap should
absorb. None are blockers; all are predictable design decisions
that this spike makes concrete.

### 1. Kind/storage dispatch boilerplate

A chart adapter handling multiple column kinds writes:

```ts
const col = series.column('value');
if (col?.kind === 'number' && col.storage === 'packed') {
  drawLine(col.values);
} else if (col?.kind === 'number' && col.storage === 'chunked') {
  // iterate chunks, or call materialize first
} else if (col?.kind === 'boolean') {
  drawStateChanges(col.values, col.validity);
}
```

This dispatch is the same boilerplate every adapter will write. **Worth a typed
helper** at step 8 — something like:

```ts
series.numberValues(name): Float64Array | undefined;
series.booleanValues(name): { values: Uint8Array; validity?: ValidityBitmap } | undefined;
```

Decision deferred to step 8. The spike confirms the underlying access
is fast; the helper is sugar.

### 2. Validity-aware drawing

A chart skipping invalid cells needs the validity bitmap inline.
Today:

```ts
const col = series.column('value');
const xs = series.keyColumn().begin;
const ys = col.values;
const validity = col.validity;
for (let i = 0; i < ys.length; i += 1) {
  if (validity && !validity.isDefined(i)) {
    moveTo(xs[i], NaN); // gap
    continue;
  }
  lineTo(xs[i], ys[i]);
}
```

The `validity.isDefined(i)` call is a method dispatch per row.
Hot-path adapters will inline the bitmap check:
`(validity.bits[i >> 3] & (1 << (i & 7))) !== 0`. **Surface area
to consider for step 8**: expose `column.bits: Uint8Array` directly
on the column so adapters don't have to reach through `validity.bits`.
Currently they do, but the field is conventionally treated as
internal.

### 3. Range slicing for zoom / pan

A chart showing `[t1, t2]` of a large series needs the visible
window's typed arrays. Today the chart has options:

- `series.bisect(new Time(t1))` + `bisect(new Time(t2))` — gives row
  indices. Then `col.values.subarray(start, end)` — zero-copy view.
- `withRowSelection(...)` — materializing.

**Subarray-view path works today** for `Time` keys. For TimeRange /
Interval, `subarray` on `begin` + `end` separately, then `new
TimeRangeKeyColumn(beginView, endView, length)` to wrap. Or just
walk directly without wrapping (chart doesn't need a KeyColumn
instance; it needs the typed arrays).

**Worth a `series.window(t1, t2)` convenience** at step 8 that
returns `{ start: number, end: number }` row indices. The chart
adapter then `subarray`s. Documents the pattern.

### 4. Chunked columns at the boundary

PR #148 (1g) added chunked value columns. A chart adapter calling
`series.column('value')` on the output of `concatSorted(...)` gets a
`ChunkedFloat64Column`, which does NOT have `.values: Float64Array`.
Instead it has `.chunks: ReadonlyArray<Float64Column>`.

**Two solutions**:

- (a) Adapter handles chunked: walks chunks, then within-chunk
  values. Adapter complexity grows.
- (b) `series.materialize()` first — explicitly compact before
  rendering. Adds a copy cost but keeps adapter simple.

The current spike API would return the `ChunkedFloat64Column`
directly; the adapter has to dispatch on `storage === 'chunked'`
and handle the chunks path. **Step 8 should commit to one model.**
My recommendation: (b) for v1.0, with an opt-in (a) path for
adapters that want the zero-copy concat win.

### 5. Live updates (LiveSeries)

Out of scope for this spike. LiveSeries integration is step 7.
But: when LiveSeries lands columnar, the chart adapter's
update model needs definition. Subscribe to delta events?
Re-fetch typed arrays each render? Get a `ColumnarRingBuffer`
snapshot directly?

**Defer to step 7 + step 8 together.** Note in PLAN.md as a
joint design question.

### 6. Multi-column alignment

A chart shows multiple series (e.g. cpu + memory for several
hosts). Two patterns:

- **One TimeSeries with multiple value columns** — `series.column('cpu').values` and `series.column('memory').values` share the same time axis.
- **Multiple TimeSeries joined at chart layer** — chart aligns them.

The first pattern is the columnar substrate's natural shape.
**Verify the experiment agent (Option B) tests both patterns** —
multi-host dashboards usually use the second.

### 7. Public type re-exports for `Column` / `KeyColumn`

L2 review on the spike PR caught this. Callers can invoke
`series.column(name)` and `series.keyColumn()` today, but the
return types (`Column`, `KeyColumn`) aren't re-exported from
`pond-ts`'s top-level entrypoint — they live in
`packages/core/src/columnar/index.ts` which is framework-internal.
A typed call site looking like

```ts
import type { Column } from 'pond-ts';
function drawSeries(series: TimeSeries<MySchema>) {
  const col: Column | undefined = series.column('cpu');
  // ...
}
```

doesn't compile today because the type isn't exported.

For the spike this is fine — callers can use
`ReturnType<typeof series.column>` or skip the annotation entirely.
**Step 8 should commit to the public type surface** at the same
time it commits to the method surface. Re-export the relevant
columnar types from the top-level package, OR introduce a
chart-extraction-specific wrapper type that doesn't leak the full
substrate vocabulary.

### 8. Interval-keyed charts (heatmap-style)

Most chart libraries' API is point-shaped: `(x, y)` pairs.
Interval-keyed data — `(start, end, label, value)` per row —
doesn't fit. The substrate exposes `keyColumn().begin`,
`.end`, and `.labels` for `IntervalKeyColumn`. **Heatmap / gantt
adapters need them all.** Worth a worked example in the experiment.

## What the experiment agent (Option B) should test

Per the CLAUDE.md multi-agent-experiments pattern. Spawn a separate
`pond-ts-charts-experiment` agent. Task:

- Build an actual interactive chart (pan / zoom / range-select)
  on top of pond-ts current API (with the spike accessors).
- Measure render perf at N = 100k, 1M, 10M.
- Hit the chunked-column case (concat two TimeSeries → render).
- Hit the multi-column case (one TimeSeries with cpu + memory).
- Hit the interval-keyed case (a heatmap of tile labels).
- Write a friction report:
  - Which API methods the agent reached for (and how often).
  - Which methods the agent wished existed.
  - Gross perf cliffs (render budget exceeded? frame jank?).
  - Adapter-side workarounds for substrate gaps.

The friction report informs step-8 chart-extraction alignment.

## What this spike does NOT validate

- **Browser environment perf.** All measurement was Node. The
  typed-array path should be even better in the browser (V8 same,
  fewer cold-start hits). Confirm in the experiment agent.
- **Memory pressure on large series.** Spike runs N=1M at modest
  memory. The 10M / 100M scale is where heap growth + GC pauses
  start mattering. Experiment agent territory.
- **The actual chart API.** This is a spike on the EXTRACTION
  side. The chart consumer's API surface is `@pond-ts/charts`,
  which doesn't exist yet. Step 8 (or a separate charts package)
  commits that.

## Recommendation back to PLAN.md

Three items to log:

1. **Step 8 scope refinement** — the chart-extraction alignment
   includes the kind/storage dispatch helpers (item 1), the
   inline-validity-bitmap question (item 2), the range-window
   convenience (item 3), the chunked-column dispatch decision
   (item 4), and the public type re-exports (item 7). The
   substrate access pattern is validated; the helpers are the work.
2. **Step 7 + 8 joint design** — LiveSeries update model for
   charts (item 5). Both surfaces touch this; don't design in
   isolation.
3. **Multi-agent experiment** — spawn `pond-ts-charts-experiment`
   per CLAUDE.md. Real interactive chart, real friction report.
   Don't block step 3 on it; let it run in parallel.
