# `@pond-ts/charts` — streaming-first canvas charts

**Status:** planning note.

**Relationship to PLAN.md:** This RFC is strategic context, not a commitment.
[PLAN.md](../../PLAN.md) is the binding source of truth for what is actually
being built; phases adopted into PLAN are commitments, and the rest of this
document is forward-looking. See [CLAUDE.md → Strategic RFCs](../../CLAUDE.md)
for the layering.

**Authorship:** developed across multiple contributors. Each section below
carries inline attribution; this list is the index for cold readers.

| Section                                         | Contributor                    |
| ----------------------------------------------- | ------------------------------ |
| Origin friction note + canvas implementation    | gRPC experiment agent (Claude) |
| Strategic frame + scope discipline              | pjm17971                       |
| Original draft consolidation                    | pond-ts library agent (Claude) |
| Codex architectural review                      | Codex                          |
| Library agent response (architecture amendment) | pond-ts library agent (Claude) |

**Audience:** future pond-ts contributors implementing the chart-package
extraction; consumer-side dashboard authors deciding whether to wait for
this or invest in their own canvas primitive.

**Thesis:** `@pond-ts/charts` is not "another canvas chart library"; it is
**the visualization end of pond.** Other libraries don't bring a fully
typed streaming-aggregation pipeline to plug into; pond does. The package's
value is the seamless integration — `data → pond → charts` with zero
friction at scale (100k+ points × tens of series, streaming-append, no
pre-decimation required) — and that defines both the API center of gravity
and the architectural commitments below.

## Origins and authorship trail

This RFC consolidates and supersedes:

- **[`canvas-chart-primitive.md`](https://github.com/pjm17971/pond-grpc-experiment/blob/main/friction-notes/rfcs/canvas-chart-primitive.md)**
  in the gRPC experiment (gRPC experiment agent / Claude). The friction
  notes that surfaced the SVG cliff, the working canvas implementation,
  the 9 implementation traps, and the uPlot technique inventory. Still
  the canonical reference for the trap catalogue and the uPlot ROI
  ranking.
- **[pond-grpc-experiment#37](https://github.com/pjm17971/pond-grpc-experiment/pull/37)**
  (merged) — the working `CanvasChart.tsx` implementation. Survived 5×
  heap reduction and indefinite-runtime stability test (50 MB plateau
  vs OOM at 1–5 min on Recharts).
- A pjm17971 strategic-frame review (2026-05-10) reframing scale
  expectations, scoping the package to timeseries visualization (not
  generic viz), and identifying the layout-primitive shape as the
  differentiating value.
- A Codex architectural review (2026-05-10) flagging that the package
  should be treated as a small rendering engine with React as the
  shell — see "Codex review" section below.

## Strategic frame

> _Section by pjm17971 (2026-05-10), consolidated by the pond-ts library
> agent._

### The visualization end of pond

The package's headline pitch is the seamless integration with pond's data
pipeline. `<LineChart series={live.partitionBy('host').rolling('5m', m).collect()} />`
Just Works. Components accept pond types (`LiveSource`, `TimeSeries`,
`PartitionedTimeSeries`) directly and subscribe internally — consumers
don't wire reactivity by hand. Adapters that take `ChartSeries`-shaped
arrays exist as an escape hatch for non-pond data sources, but they're
not the public surface; the headline path is pond data flowing in
directly.

The competitive differentiator: other charting libraries don't bring a
typed streaming-aggregation engine to plug into. Pond does. The combination
is the moat.

### Scope: timeseries only

Pond's strong-type aggregation model produces shapes that fit several
visualization styles: line, band/envelope, bar, scatter, box. The package
covers all of these. It does **not** cover pie, treemap, sankey, or
generic visualization. _If it's not timeseries and it's not the viz end
of pond, we're not in that game._

### Beat uPlot on streaming

The gRPC experiment's per-host stride numbers should not anchor scale
expectations. Timeseries data is often dense (100k+ points × tens of
series), and the experiment decimated upstream of the chart and Recharts
still collapsed. The library has to handle the un-decimated case
natively.

The streaming-append shape is where a streaming-specific library can
credibly _exceed_ a general-purpose one. uPlot rebuilds-on-replace
because it's general-purpose; it doesn't know whether a `setData` call
is "ten random rows replaced" or "leftmost dropped + one tail appended."
Pond does know — the data update for a sliding window is structurally
`[old[1..n], newPoint]`. The library can build on that knowledge.

Several uPlot techniques the experiment's RFC marked as "skip — doesn't
pay back at our scale" become **v1 commitments** at the library's
target scale: typed-array data layout, pixel-bucket decimation, Path2D
caching across redraws, `getOuterIdxs` extension. The "our scale"
framing in the experiment's RFC was honest about the gRPC pipeline's
stride-decimated load, not about the library's target.

### Charting system, not chart

The library is composable layout primitives + a family of chart
components, not a single component. Multi-row charts, shared time axes,
multi-axis Y, overlay-in-row composition, pan/zoom, brush selection,
cursor sync — all foundational. The reference shape:

```tsx
<ChartContainer timeRange={range} onTimeRangeChange={setRange}>
  <ChartRow height={150}>
    <YAxis id="cpu" min={0} max={1} format=".0%" />
    <Charts>
      <BandChart axis="cpu" upper={...} lower={...} />
      <LineChart axis="cpu" series={...} />
    </Charts>
  </ChartRow>
  <ChartRow height={100}>
    <YAxis id="requests" />
    <Charts>
      <BarChart axis="requests" series={...} />
    </Charts>
  </ChartRow>
</ChartContainer>
```

`ChartContainer` owns the time axis, pan/zoom state, DPR + ResizeObserver
state, interaction state, the row registry, and cursor/brush state.
`ChartRow` owns Y-domain computation and axis layout. `<Charts>` is a
within-row composition slot. Multi-row charts share the time axis but
have independent Y.

[react-timeseries-charts](https://github.com/esnet/react-timeseries-charts)
is the proven shape — we copy the API and bring our canvas implementation
underneath rather than design from scratch.

## Motivation (the SVG cliff)

> _Section drawn from the gRPC experiment's RFC; numbers measured in
> [pond-grpc-experiment#37](https://github.com/pjm17971/pond-grpc-experiment/pull/37)._

Recharts (or any SVG-based chart) hits a hard wall the moment a streaming
source, multiple hosts, and non-trivial point counts compose:

| Per-render SVG node count at firehose × 10 hosts × 5min window |             |
| -------------------------------------------------------------- | ----------- |
| Per-host smoothed line (1500 points × scatter dot per point)   | ~30k        |
| Per-host ±σ band edges (10 hosts × 1500 polygon points)        | ~15k        |
| Per-host min/max envelope (20 hosts × 1500)                    | ~30k        |
| Anomaly Scatter circles                                        | ~1500–1700  |
| **Total per-chart**                                            | **~75–80k** |

Two failure modes at this scale:

1. **Renderer OOM.** SVG nodes are real DOM nodes; Chrome's renderer
   pushes past its memory budget around 75k retained per chart. Symptom:
   eval times out, tab crashes.
2. **Main-thread starvation.** Even when memory is fine, Recharts'
   reconcile cost grew faster than 1× linearly in points × series. At
   firehose rate the chart memo's _own_ work was 7–37 ms (well within
   budget) but the next paint took 1–5 seconds.

Working canvas implementation in PR #37: 1 `<canvas>` per chart, all
data drawn in one `useLayoutEffect` pass. **Heap went from "OOMs in 1
minute at firehose × 10 hosts" to "plateaus around 50 MB indefinitely"
with no other change.**

| Metric                  | Recharts    | Canvas                                     |
| ----------------------- | ----------- | ------------------------------------------ |
| Baseline used heap      | 166 MB      | **40 MB**                                  |
| DOM nodes (per chart)   | ~1,400      | **~5**                                     |
| SVG nodes (per chart)   | ~1,400      | **0**                                      |
| Sustained-load survival | 1–5 minutes | **indefinite (8+ min plateau, no growth)** |

The library version pays back across every dashboard inside the team
that hits the same fan-out × point-count regime.

## Component family (v1)

> _Original sketch by pjm17971; sequencing reduced after Codex review
> (see "Library agent response" below)._

Mapping pond's reducer outputs to visualization styles:

| Component      | Pond data source                                                              |
| -------------- | ----------------------------------------------------------------------------- |
| `LineChart`    | `series.rolling('5m', { cpu: 'avg' })`, `series.smooth('cpu', 'ema')`, etc.   |
| `BandChart`    | `series.baseline('cpu', { window: '2m', sigma: 2 })` (avg + sd → upper/lower) |
| `BarChart`     | `series.aggregate(Sequence.every('1m'), { count: 'count' })`                  |
| `ScatterChart` | `series.outliers('cpu', ...)`, `series.sample({ reservoir })`                 |
| `BoxChart`     | `series.rolling('5m', { p25: 'p25', p50: 'p50', p75: 'p75', p95: 'p95' })`    |

Each component is a thin canvas draw layer over the same data store and
viewport infrastructure (see "Codex review" + "Library agent response"
below). The component family scales by adding draw layers, not by
reimplementing the rendering engine.

## v1 implementation traps (catalogued from the gRPC experiment)

> _Section by gRPC experiment agent (Claude). Each trap is a real bug
> the experiment paid iteration time to find. Ports verbatim into the
> library implementation._

1. **Gap detection lives in the data layer (the adapter), not the
   renderer.** The chart honours explicit `value: undefined` markers;
   adapters with bucket-cadence context inject them at known-empty
   buckets.
2. **`Number.isFinite(value)`, not `value != null`.** NaN slips through
   `!= null` and `lineTo(NaN, NaN)` doesn't skip — canvas treats it as
   "rest pen here," visually bridging the surrounding defined points.
3. **Y-domain overrides should _widen_, not cap.** Auto-extend if data
   exceeds. Canvas clips to bounds where SVG silently overflowed; the
   override means "start at least this wide" rather than "render exactly
   this band."
4. **X-axis ticks anchor to wall-clock boundaries, not window
   fractions.** `Math.ceil(tStart / step) * step` so tick labels
   correspond to fixed wall-clock times that slide left as the window
   advances.
5. **No synchronous `setState` in `useLayoutEffect`.** ResizeObserver
   fires once after first layout — use that signal, not a synchronous
   read. Caught by `react-hooks/set-state-in-effect`.
6. **`React.memo` is required for streaming-data charts.** Pair with
   stable refs in the data layer; without that pairing the memo is
   useless.
7. **DPR scaling at draw time** via `ctx.setTransform(dpr, ...)`, not by
   doubling the line-drawing math. Setting `canvas.width` resets context
   state; do it once per resize.
8. **Pixel-density-based dot suppression** (uPlot's
   `idxs[1] - idxs[0] <= dim / (pointSpace * pxRatio)`), not a constant
   threshold. Auto-adapts on resize.
9. **Single `useLayoutEffect` drawing grid → bands → lines → dots →
   anomalies → axis labels** in one synchronous pass. Easier z-order,
   consistent canvas state, faster than multiple effects.

## uPlot technique inventory

> _Section by gRPC experiment agent (Claude). The "explicit skip" set
> needs reweighting at the library's target scale — see "Library agent
> response" below._

[uPlot](https://github.com/leeoniya/uPlot) is the fastest 2D-canvas
charting library in the JS ecosystem and an honest reference. Reading
its source ruthlessly without taking the dep:

### High-ROI ports (do these in v1)

1. **Px-align integer rounding for crisp 1-px lines.** Free legibility
   win on DPR=1 displays; invisible on Retina. `pxRoundGen` in
   `src/paths/utils.js:242–244`. ~5–10 LOC port.
2. **Rollover time-axis labels at boundary crossings.** Per-tick
   formatter prints `7/14 \n 7:28:30` (two-line) when a tick crosses a
   date boundary versus the prior tick. `src/opts.js:143–152`. ~10 LOC
   port.
3. **Pixel-density-based dot suppression** replacing constant threshold.
   `src/opts.js:750–761`. 1-line change.

### Now-v1 (was bookmarked v2; library scale changes the calculus)

4. **`closestIdx` for tooltip hit-testing.** Bookmarked v2 because
   tooltips are deferred, but the binary-search primitive itself is in
   v1 (used by pan/zoom snap, brush endpoints, cursor synchronisation).
   `src/utils.js:2–21`.
5. **Path2D caching across redraws.** Bookmarked v2 in the experiment's
   RFC; **v1 here**. At 100k+ points × tens of series the rebuild cost
   per frame is the dominant draw cost; caching is the architectural
   ceiling lift, not an optimization. `src/uPlot.js:1556–1567` (cache
   invalidation), `1608–1619` (cache check), `1656–1661` (style
   recompute).
6. **`getOuterIdxs` (extend by one each side).** Edge artifacts at
   panned windows. `src/uPlot.js:1583–1594`. Trivial port.

### Now-v1 (was "explicit skip"; reweighted)

7. **Typed arrays for data layout.** Marked skip in the experiment's RFC
   at 2,500-point scale; **v1 here** at 100k-point scale. Float64Array X
   - parallel Y columns; `Uint8Array` validity column. The shape change
     is internal — adapters convert from pond data to columnar buffers,
     so the public API isn't exposed to the typed-array shape.
8. **Decimation (pixel-bucket min/max accumulator).** Marked skip in
   the experiment's RFC because pond's upstream `aggregate(seq, ...)`
   pre-decimated. **v1 here**: the library can't assume the consumer
   pre-decimates; the chart owns its decimation grid. uPlot's bucket
   accumulator at `src/paths/linear.js:51–117` is the right shape.
9. **`Map<color, Path2D>` batching for multi-color paths.** Marked skip
   in the experiment's RFC because the dashboard had ~10 hosts.
   **Reconsider in v1** for the 30+-series case; lazy-port if profiling
   surfaces it.

### Still skip

- **Context-style cache.** Microsecond savings; not worth the
  bookkeeping at our cadence.
- **Convergence loop for axis padding.** Hardcoded padding works for
  percentage-formatted axes; reconsider only when raw bytes / large
  dynamic ranges become real.

## Wire-shape coupling posture

The package ships **before** Phase 4.5 milestone C with a loose typing
surface (accepts the experiment's proven `Map<key, RowArray>` shape via
internal adapter). When milestone C lands (`AggregateEmission` with
stable IDs), a tighter `fromAggregateEmission` overload is added; the
loose path stays for non-streaming use.

**v1 does not depend on milestone C.** Only the streaming-wire overload
does. This was a contradiction in the original PLAN entry; resolved
here.

---

## Codex architectural review

> _Posted by Codex (2026-05-10). Reproduced verbatim because the
> framing matters — the package should be a small rendering engine
> with React as the shell, not "React components that happen to use
> canvas." Several of these reframings are adopted into the library
> agent response below._

> My main technical reaction: the goals are good, but the implementation
> should be treated less like "React components that happen to use
> canvas" and more like a small rendering engine with React as the shell.
>
> A few concrete thoughts:
>
> 1. **Split the package into hard layers.** `@pond-ts/charts` should
>    probably have an internal pipeline like:
>
>    `pond source -> chart adapter -> typed-array store -> viewport/decimator -> canvas renderer -> React layout`
>
>    The React components should mostly configure and subscribe. The
>    expensive work should live in stable, non-React classes so streaming
>    updates do not cause object churn.
>
> 2. **Do not build the hot path on `toPoints()`.** `toPoints()`
>    currently allocates and freezes one object per event in
>    `TimeSeries.ts`. That is perfect for Recharts/Observable Plot
>    interop, but it is the wrong substrate for the stated 100k+ ×
>    tens-of-series goal.
>
>    For charts, add an adapter that walks `TimeSeries` / `LiveSource`
>    events directly into columnar buffers:
>
>    ```ts
>    x: Float64Array;
>    yByColumn: Map<string, Float64Array>;
>    validityByColumn: Uint8Array | bitset;
>    ```
>
>    Keep `toPoints()` as the escape hatch, not the internal
>    representation.
>
> 3. **Be careful with the "append-only Path2D is O(1)" claim.** Path2D
>    caching is useful, but only under stable scale conditions. If the
>    time range slides, zooms, resizes, or the Y domain changes,
>    screen-space paths are invalid. I would implement this as **chunked
>    Path2D caches**, not one growing path:
>    - ring buffer stores raw data
>    - chunks hold, say, 512–4096 points
>    - each chunk has cached paths keyed by `{ xScaleVersion,
yScaleVersion, dpr }`
>    - appending only rebuilds the active tail chunk
>    - pan/zoom/domain changes invalidate caches predictably
>
>    For live sliding windows, a later optimization can shift the
>    existing canvas bitmap left and draw only the tail, but v1 should
>    still have a clean full-redraw path.
>
> 4. **Make subscription use `useSyncExternalStore` semantics.** The
>    current React hook shape snapshots into state with throttling. For
>    charts, I'd avoid routing every frame through React state. Use
>    React for layout/config changes, and let the chart store schedule
>    canvas draws directly.
>
>    A shape like this feels right:
>
>    ```ts
>    const store = useChartStore(source, options);
>    useSyncExternalStore(store.subscribeMeta, store.getMetaSnapshot);
>    ```
>
>    React re-renders when dimensions/config/source identity changes.
>    Canvas redraws when data changes.
>
> 5. **Make "source adapters" first-class.** I'd define a small internal
>    interface before components:
>
>    ```ts
>    interface ChartDataSource {
>      schema: SeriesSchema;
>      subscribe(fn: (batch: ChartAppendBatch) => void): () => void;
>      snapshot(range?: TimeRangeLike): ChartSnapshot;
>    }
>    ```
>
>    Then implement adapters for:
>    - `TimeSeries`
>    - `LiveSource`
>    - `PartitionedTimeSeries`
>    - `Map<key, RowArray>` from the experiment
>    - later `AggregateEmission`
>
>    This contains the loose pre-Phase-4.5 wire shape without letting it
>    leak into every chart component.
>
> 6. **Resolve one PLAN contradiction.** Lines 3857–3860 say charts
>    depend on Phase 4.5 milestone C, but lines 4010–4014 say charts
>    ship before milestone C with loose typing. I'd rewrite that as:
>    "v1 does not depend on milestone C; the final streaming wire
>    overload does." Otherwise future-you will get two valid but
>    conflicting implementation readings.
> 7. **Keep layout declarative, rendering imperative.** The
>    react-timeseries-charts-style layout primitives are a good target.
>    I'd implement `ChartContainer` as the owner of:
>    - time scale
>    - DPR
>    - ResizeObserver state
>    - interaction state
>    - row registry
>    - cursor/brush state
>
>    Then `ChartRow` owns Y-domain computation and axis layout, while
>    `LineChart`, `BandChart`, etc. register draw layers into the row.
>    That gives you one ordered canvas pass per row without forcing
>    nested React children to paint independently.
>
> 8. **Decimation needs semantic hints.** Pixel-bucket min/max is right,
>    but the chart needs to know channel semantics:
>
>    ```ts
>    mode: 'line' | 'bar' | 'band' | 'scatter';
>    aggregation: 'avg' | 'minmax' | 'last' | 'none';
>    preserveSparse?: boolean;
>    ```
>
>    Continuous signals can decimate. Sparse anomaly markers should not.
>    Bands need paired lower/upper handling so the filled envelope does
>    not invert or lose spikes.
>
> 9. **Testing should include performance invariants, not only pixels.**
>    Storybook pixel hashes are good, but I'd add headless runtime
>    tests for:
>    - no heap growth after N append frames
>    - bounded draw time at fixed fixture size
>    - gap handling with `undefined` and `NaN`
>    - DPR resizing
>    - pan/zoom invalidation
>    - sparse marker preservation
>
>    Those tests will catch the failures that normal visual snapshots
>    miss.
>
> My strongest recommendation: start with a tiny internal rendering
> core before exposing the whole component family. Build
> `ChartContainer`, `ChartRow`, `YAxis`, `Charts`, and only `LineChart` +
> `BandChart` first, but build them on the final typed-array/chunked-
> cache architecture. Once that spine is right, `BarChart`,
> `ScatterChart`, and `BoxChart` become layer implementations rather
> than new systems.

---

## Library agent response (architecture amendment)

> _Section by pond-ts library agent (Claude), 2026-05-10. Adopting
> Codex's reframing across the board; the prior v1 commitments need
> updating to reflect the layered-engine architecture and the reduced
> initial component set._

Codex's framing is right. The prior writeup treated `@pond-ts/charts`
as React components that draw to canvas; the correct framing is "small
rendering engine, React is the shell." That changes the architecture,
the v1 component sequencing, and several of the prior-RFC commitments.
Adopting all 9 numbered points and the strongest recommendation, with
specific incorporations below.

### Architecture: hard layers (Codex 1)

The package is structured as a pipeline:

```
pond source
  → ChartDataSource adapter        (per-source-type; columnar buffers)
  → typed-array store              (Float64Array x, parallel Y, Uint8Array validity)
  → viewport / decimator           (pixel-bucket min/max with semantic hints)
  → chunked Path2D cache           (keyed by scale version + DPR)
  → canvas renderer                (single ordered draw pass per row)
  → React layout shell             (ChartContainer / ChartRow / YAxis / Charts)
```

The expensive work — adapter walks, buffer compaction, decimation,
path building, draw — lives in stable non-React classes. React
components are configurators and subscribers; they don't own data and
they don't drive draws. Streaming updates skip React state entirely.

### Internal data shape: columnar typed arrays from day one (Codex 2)

`toPoints()` is the escape hatch for non-pond consumers and Recharts /
Observable Plot interop, **not** the internal substrate. The chart-
side adapter walks `TimeSeries` / `LiveSource` events directly into:

```ts
type ChartBuffer = {
  x: Float64Array;
  yByColumn: Map<string, Float64Array>;
  validityByColumn: Map<string, Uint8Array>; // 1 = finite, 0 = gap
  // Append-only ring; head + length describe the live window.
  head: number;
  length: number;
  capacity: number;
};
```

This requires new adapter code in `@pond-ts/charts/adapters` that
walks `LiveSource.on('event' | 'evict')` (or `TimeSeries.events`) and
writes into the typed arrays — no `toPoints()` call on the hot path.
Per-event cost is O(1): one `Float64Array[i] = ...` per column, one
validity bit, one head advance. Eviction is O(1): tail advance.

`toPoints()` keeps its existing role for batch consumers and stays
unchanged.

**Spike result (2026-05-10).** The core columnar-store spike on branch
`codex/core-columnar-store-spike` validated this boundary with an internal
`ColumnarStore.toChartBuffer(...)` helper. On 1M rows, `toPoints()` took
~204ms, zero-copy chart-buffer extraction was effectively metadata-only
(~0.001ms), and copied typed arrays took ~5.9ms. That does not argue for
rewriting every core operator around columnar storage — the same spike found
bucketed `aggregate()` needs a planned fused operator shape before it is
runtime-ready — but it strongly supports keeping `toPoints()` as compatibility
export while chart adapters consume typed buffers directly.

### Path2D caching: chunked, scale-versioned (Codex 3)

The original "append-only Path2D is O(1)" claim was wrong. Path2D
operates in screen space; any time-range slide, zoom, resize, or
Y-domain change invalidates the cached path. Chunked caches are the
correct shape:

- The ring buffer stores raw data in **typed arrays** (above).
- A separate **chunk index** carves the buffer into 1024-point chunks
  (tunable; 512–4096 in literature).
- Each chunk holds a cache map keyed by
  `{ xScaleVersion, yScaleVersion, dpr }` → `Path2D`.
- Streaming append rebuilds the **active tail chunk** only; older
  chunks' caches stay valid as long as their scale-version key still
  matches the current viewport.
- Pan/zoom/domain changes bump scale versions; older chunks
  reconstruct their paths on next draw at the new key. Cache eviction
  is LRU-bounded so the working set stays bounded across long pan
  sessions.

The bitmap-shift optimization (translate the existing canvas left,
redraw only the tail) is a v1.1 lever; v1 has a clean full-redraw
path off the chunk cache.

### Subscription: `useSyncExternalStore` semantics (Codex 4)

Drawing does not flow through React state. The shape:

```ts
// React side — re-renders only on dimensions / config / source identity changes.
const store = useChartStore(source, options);
const meta = useSyncExternalStore(store.subscribeMeta, store.getMetaSnapshot);

// Canvas side — store schedules draws directly.
useLayoutEffect(() => store.bindCanvas(canvasRef.current), [canvasRef]);
```

`store.subscribeMeta` fires only when the chart's _shape_ changes
(dimensions, axis config, source identity). Data changes flow to the
canvas via the store's internal `requestAnimationFrame` scheduler;
React doesn't see them. This bypasses the throttling-into-React-state
pattern in `useSnapshot` for the chart's hot path.

`useSnapshot` stays the right primitive for non-chart consumers; the
charts package needs the bypass shape because the work-per-frame is
the canvas draw, not a React render.

### `ChartDataSource` interface as first-class (Codex 5)

Defined before any component:

```ts
interface ChartDataSource {
  readonly schema: SeriesSchema;
  subscribe(fn: (batch: ChartAppendBatch) => void): () => void;
  snapshot(range?: TimeRangeLike): ChartSnapshot;
}

type ChartAppendBatch = {
  appended: ChartBuffer; // typed-array slice
  evicted?: { count: number };
  scaleHints?: ScaleHints; // optional; for reservoir-style retro updates
};

type ChartSnapshot = ChartBuffer; // full read for new subscribers
```

Adapters in `@pond-ts/charts/adapters`:

- `fromTimeSeries(series)` — batch path, single snapshot, no
  subscription.
- `fromLiveSource(source)` — subscribes via `'event'` + `'evict'`,
  emits append batches.
- `fromLivePartitioned(p)` — multi-series with partition-key as the
  series identifier; each partition maps to its own column set.
- `fromTimeSeriesMap(map)` — the experiment's `Map<key, RowArray>`
  shape, kept as the loose pre-milestone-C escape hatch.
- `fromAggregateEmission(emission)` — added when Phase 4.5 milestone C
  lands; tighter typing than `fromLivePartitioned` because emissions
  carry stable IDs.

The interface contains the loose pre-milestone-C wire shape inside
`fromTimeSeriesMap` without letting it leak into every chart
component. Chart components only know `ChartDataSource`; they're
unaware of which adapter built it.

### PLAN contradiction resolved (Codex 6)

**v1 does not depend on Phase 4.5 milestone C.** Only the final
`fromAggregateEmission` overload does. The PLAN entry is being
shortened in this same pass; the contradiction is removed.

### Layout declarative, rendering imperative (Codex 7)

`ChartContainer` owns:

- Time scale (via `d3-scale`)
- DPR + canvas backing-buffer sizing
- ResizeObserver state
- Interaction state (pan / zoom / brush / hover)
- Row registry (which rows have registered themselves)
- Cursor / brush state for cross-row sync

`ChartRow` owns:

- Y-domain computation (auto-extending per the trap rule)
- Axis layout (left margin from formatted-label widths)
- The single canvas backing buffer for this row
- Draw-layer registry

`<LineChart>`, `<BandChart>`, etc. **register draw layers** into the
row via `useEffect`. They aren't React-rendered components in the
visual sense; they're configuration. The row's draw routine iterates
its registered layers in order in one `requestAnimationFrame` callback
per frame.

This gives one ordered canvas pass per row, consistent z-order, no
"each child paints independently" problem. The chart components
themselves render as `null` to the React tree once their layer is
registered — they don't produce DOM nodes.

### Decimation with semantic hints (Codex 8)

The viewport/decimator stage takes per-channel hints:

```ts
type DecimationHint = {
  mode: 'line' | 'bar' | 'band' | 'scatter';
  aggregation: 'avg' | 'minmax' | 'last' | 'none';
  preserveSparse?: boolean; // skip decimation entirely; render every point
};
```

Per-channel rules:

- **Line / continuous numeric:** `aggregation: 'minmax'` (preserves
  spikes) or `'avg'` (smoother). Default `'minmax'` for pond's `'min'`/
  `'max'` reducer outputs; `'avg'` for `'avg'`/`'p50'` outputs. The
  adapter sets the default; consumer can override.
- **Band:** paired lower/upper handling. Decimation operates on the
  pair as one channel — bucket holds `(min lower, max upper)` so the
  envelope never inverts and never loses spikes.
- **Bar:** `aggregation: 'last'` typically (each bar is already a
  bucket).
- **Scatter:** `preserveSparse: true` by default. Sparse markers (anomaly
  dots, reservoir samples) skip decimation entirely. The chart's own
  pixel-density-based dot suppression still applies on render.

The `<LineChart axis="cpu" series={...} aggregation="minmax">` prop
exposes this to the consumer; default values come from the adapter
based on the source's reducer kind where known.

### Test surface: performance invariants (Codex 9)

In addition to Storybook + canvas-pixel-hash visual regression:

- **Heap-growth invariant.** N append frames over a fixed-size buffer
  must show no heap growth. Pinned via `process.memoryUsage()` deltas
  in a vitest perf scenario.
- **Draw-time bound.** At fixed fixture (10k points × 10 series),
  draw must complete under a budget (target: 4 ms on a current
  MacBook Pro; CI threshold looser to absorb variance).
- **Gap handling.** Both `undefined` and `NaN` markers visually drop
  the line; pixel-hash tests pin both.
- **DPR resizing.** `devicePixelRatio` change (1 → 2 → 1.5) triggers
  cache invalidation and clean redraw without DOM-node churn.
- **Pan/zoom invalidation.** Scale version bump invalidates path
  caches but doesn't rebuild data buffers; pinned by counters in the
  store.
- **Sparse marker preservation.** Decimation under `preserveSparse:
true` doesn't drop markers; pinned by exact-count assertion across a
  range of viewport widths.

Storybook's role is "design surface + visual regression"; perf
invariants belong in headless vitest runs.

### v1 scope reduction (Codex's strongest recommendation)

The original v1 surface listed five chart components (`LineChart`,
`BandChart`, `BarChart`, `ScatterChart`, `BoxChart`). Adopted Codex's
reduction: **v1 ships the rendering spine + LineChart + BandChart
only.** The other three become v1.1 layer implementations once the
spine is proven.

**v1 surface:**

- Layout primitives: `ChartContainer`, `ChartRow`, `Charts`, `YAxis`
- Components: `LineChart`, `BandChart`
- Pan / zoom (controlled and uncontrolled), brush selection, cursor
  sync across rows
- `ChartDataSource` interface + adapters for `TimeSeries`,
  `LiveSource`, `PartitionedTimeSeries`, `Map<key, RowArray>`
- Internal: typed-array store, chunked Path2D cache, viewport/decimator
- SSR-safe (`'use client'` directive)
- Selective d3 imports (`d3-scale`, `d3-time-format`, `d3-array`,
  optional `d3-shape`)
- Storybook + canvas-pixel-hash visual regression
- Headless perf-invariant tests (above)

**v1.1 surface (after the spine ships):**

- `BarChart`, `ScatterChart`, `BoxChart` as draw-layer implementations
  on the same engine
- `fromAggregateEmission` adapter when Phase 4.5 milestone C lands
- Tooltip layer (HTML overlay; binary-search hit-testing via uPlot's
  `closestIdx` shape, ~50 LOC)
- Accessibility: offscreen `<table>` data fallback for keyboard / AT

**v2 (architectural ceiling lifts):**

- Bitmap-shift streaming optimization (translate canvas left, redraw
  tail only)
- Cross-chart linked tooltip / shared zoom
- OffscreenCanvas + Worker rendering for the multi-chart-per-page case

### Bundle target

`<30 KB` gzipped for the v1 spine including selective d3 imports and
the canvas engine. The original RFC's `<10 KB` figure was naive about
the d3 bring-along cost; `<30 KB` is realistic for a layered engine
with the four d3 sub-packages.

---

## Sequencing

This RFC supports the PLAN.md commitment: `@pond-ts/charts` extraction
earns its slot post-Phase 4.5 milestone C — but **v1 itself does not
require milestone C** per the resolved-contradiction note above. The
sequencing reason is bandwidth, not dependency: until milestone C is
in flight, the streaming-RFC work earns more leverage than chart
extraction.

When extraction begins, the v1 PR is roughly:

1. Package skeleton (`packages/charts/`) + d3 dependencies
2. `ChartDataSource` interface + four adapters
3. Typed-array store + chunked Path2D cache + viewport/decimator
4. `ChartContainer` + `ChartRow` + `YAxis` + `Charts` (the React shell)
5. `LineChart` + `BandChart` (the first two draw layers)
6. Pan / zoom / brush / cursor sync
7. SSR shim (`'use client'`)
8. Storybook + visual-regression tests
9. Headless perf-invariant tests
10. Bundle-size pin in CI

Estimated 2,000–3,000 LOC for the v1 spine. Working from the
gRPC experiment's PR #37, the trap catalogue, the uPlot inventory,
and Codex's architectural framing, this is "plumb known answers in"
rather than design from first principles.
