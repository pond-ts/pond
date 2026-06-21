# `@pond-ts/charts` — streaming-first canvas charts

**Status:** planning note.

**Relationship to PLAN.md:** This RFC is strategic context, not a commitment.
[PLAN.md](../../PLAN.md) is the binding source of truth for what is actually
being built; phases adopted into PLAN are commitments, and the rest of this
document is forward-looking. See [CLAUDE.md → Strategic RFCs](../../CLAUDE.md)
for the layering.

**Authorship:** developed across multiple contributors. Each section below
carries inline attribution; this list is the index for cold readers.

| Section                                                    | Contributor                               |
| ---------------------------------------------------------- | ----------------------------------------- |
| Origin friction note + canvas implementation               | gRPC experiment agent (Claude)            |
| Strategic frame + scope discipline                         | pjm17971                                  |
| Original draft consolidation                               | pond-ts library agent (Claude)            |
| Codex architectural review                                 | Codex                                     |
| Library agent response (architecture amendment)            | pond-ts library agent (Claude)            |
| Alignment with core columnar substrate (2026-05-11)        | pond-ts library agent (Claude) + pjm17971 |
| Performance bench, M4 decimation, positioning (2026-06-20) | pond-ts library agent (Claude)            |
| Performance — dashboard use-case review (2026-06-20)       | dashboard agent (Claude)                  |
| Performance — library response + synthesis (2026-06-20)    | pond-ts library agent (Claude) + pjm17971 |
| Performance — Q2 resolution + review close (2026-06-20)    | dashboard agent (Claude)                  |
| Performance — estela use-case review (2026-06-20)          | estela agent (Claude)                     |
| Performance — library response to estela (2026-06-20)      | pond-ts library agent (Claude)            |

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

### Pan smoothness: the cost ladder

Pan FPS is the interaction metric that collapses first at scale (bench:
120fps → 8fps @ 100k on a single series). The fix is a ladder of
techniques, each making the per-drag-frame cost cheaper:

1. **Redraw all points each frame** _(today)_ — O(N); collapses at scale.
2. **Decimate + redraw** _(v1, the planned next step)_ — O(N) bucket scan +
   O(plot*width) draw. The broad win: makes \_every* redraw cheap (pan, zoom,
   initial, live), not just pan. A single 100k series should reach 60fps here
   (the per-frame scan is sub-ms).
3. **Cache decimated buckets / Path2D + redraw transformed** — O(plot_width),
   no per-frame scan.
4. **Overscan + blit / transform during the drag** _(candidate — pjm17971,
   2026-06-21)_ — render the data canvas wider than the plot (≈ half-width
   margin each side), then during the drag slide pre-rendered pixels (a CSS
   `transform: translateX`, or `drawImage` of an offscreen buffer) and
   re-render only on settle / when the drag outruns the margin. Per-frame cost
   ≈ O(pixels), near-zero, **decoupled from data size entirely.**

Rungs 2–3 are already in the v1 perf ports above. **Rung 4 is pan-specific**
and earns its complexity only where rung 2 doesn't suffice: the **many-series**
case, where decimation still does an O(visible-N) bucket scan _per series per
frame_ (millions of points/frame on a 256-series dashboard), while
overscan-blit touches no data during the drag. The wrinkles are all pan-only —
the crosshair overlay must stay cursor-fixed (not transform with the data), the
time-axis ticks must slide-then-settle, live appends stale the buffer mid-drag,
and a drag past the margin needs re-center logic.

**Sequencing:** land the decimator (rung 2), add a **pan-FPS bench at
many-series scale**, and pull in rung 4 only if that bench shows pan still
choppy after decimation + Path2D — measured, not guessed.

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

**Alignment with the core columnar substrate (added 2026-05-11).**
After this chart RFC landed, the core columnar substrate was adopted
as the v1.0 wave — see
[`docs/rfcs/columnar-core.md`](columnar-core.md) and PLAN Phase 4.7.
That changes the framing for `ChartBuffer`: instead of being a
chart-specific data shape produced by chart-side adapter code, it
becomes a **public projection of the core's internal columnar
representation**. The framework's `Column<T>` interfaces provide the
typed-array primitives, validity bitmaps, and chunked-column shapes
that the chart adapter then assembles into the chart-facing
`ChartBuffer`.

Concrete implications when the chart package eventually extracts:

- The adapter walking events into typed arrays still exists but
  takes a much shorter path — it reads typed-array slices directly
  from the core columnar store rather than allocating fresh
  `Float64Array`s and walking event objects to fill them. Closer to
  zero-copy than the original adapter design assumed.
- `ChartDataSource` exposes the framework's shared `Column<T>`
  primitives where their semantics match (validity bitmaps,
  dictionary-encoded string columns, etc.) and adds chart-specific
  primitives (chunked Path2D caches, viewport decimation) on top.
- Per-event O(1) cost stays O(1); the gains are at the boundary
  (zero-copy slicing) and in the framework being a shared substrate
  rather than re-implemented per consumer.

This isn't a chart-RFC rewrite — the v1 shape proposed below stays.
It's a sequencing alignment: the framework lands first as Phase 4.7
work; `@pond-ts/charts` builds on it when extraction earns its slot.

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

---

## Decision: canvas-first confirmed; estela is the proving consumer; theme system (2026-06-17)

> _Decision by pjm17971; consolidated by the pond-ts library agent (Claude).
> This section moves the RFC from "planning note" to "in build" — the binding
> milestone plan lives in [PLAN.md → Current focus](../../PLAN.md); this section
> records the decision and the deltas it forces on the v1 scope above._

A renderer fork surfaced while scoping the actual first commit: the RFC's whole
architecture targets the **gRPC firehose** (canvas-mandatory, the SVG cliff),
but the freshest real consumer — estela's `@estela/ui` `DataChart` — is a
**working SVG chart** at a scale (one activity, a few thousand points) that
never hits the cliff. estela's spec even says "SVG, no canvas needed." So the
question was: is `@pond-ts/charts` v1 a renderer-agnostic data layer, an
SVG-first package modeled on estela, or the canvas engine this RFC describes?

**Resolved: canvas-first, no SVG.** Rationale (pjm17971):

- SVG is a dead end for the firehose / dashboard consumers — the cliff is real
  and structural, not a tuning problem.
- estela not pulling on canvas as hard _today_ doesn't mean it won't. One
  canvas engine that also owns interactions gives us a chart that works for
  **both** regimes; an SVG branch would be a fork we'd have to abandon.
- More work up front (interactions on canvas are harder than SVG's
  hit-testing), but the end state is a single engine, not two.

This **confirms** the canvas architecture in the "Library agent response"
section above. It changes three things about the v1 scope:

1. **estela is the proving consumer, and its feature set is the v1 success
   bar** — "estela can swap our chart in for `DataChart` with no regressions."
   That promotes several items the response section had as v1.1/later into v1
   must-haves: **dual y-axis** (left single-select group channel + right HR),
   the **two-tone variance underlay** (p5/p95 outer + p25/p75 inner over a
   _fixed value-window_, from `rollingByColumn` percentiles + the `{at}` grid —
   both shipped in v0.30.0 for exactly this), **gap-aware smooth**
   (`smooth missing:'skip'`, also v0.30.0), a **pace axis** (sec/distance
   inversion), **scrub** readout, and the **zoom-stable spread** property
   (band width depends on distance + radius, not bucket time-width).

2. **A theme system is now first-class** — the RFC predates this requirement.
   estela's fixed role palette (primary foam-white / HR coral / elevation teal)
   becomes _one theme_, not hardcoded colours in the draw layers. A `ChartTheme`
   (line role colours, band fill opacities, axis tint, gridline style,
   typography) is threaded through `ChartContainer` context with a
   `defaultTheme`; estela ships as `estelaTheme`. This is what makes the engine
   reusable by the dashboard / gRPC / other consumers ("target other uses too").

3. **Interactions are in v1**, not deferred — pan / zoom / brush / cursor sync
   (already in the response section's v1 list) plus estela's **scrub** readout.

Nothing else in the architecture changes: the hard layers, the typed-array
store, the chunked Path2D cache, the `ChartDataSource` adapters, and the
`useSyncExternalStore`-for-meta / rAF-for-draws split all stand as written
above. The dual-axis and theme requirements thread through `ChartRow` (Y-domain

- axis config per side) and `ChartContainer` (theme context) respectively, which
  the layered design already accommodates.

**Home:** `packages/charts` in this monorepo, `"private": true` until M5 parity
so the unified release workflow doesn't publish a half-built package; flipped
public at first parity. Lockstep-versioned with core + react.

---

## Performance: measuring the v1 bets, M4 decimation, and honest positioning

> _Section by the pond-ts library agent (Claude), 2026-06-20. The empirical +
> competitive layer on the decimation (#8 "pixel-bucket min/max accumulator"),
> semantic-hints (Codex 8), Path2D, typed-array (#7), and perf-invariant-testing
> (Codex 9) commitments above. Submitted for the **dashboard use-case agent** to
> red-team — review section pending below._

The architecture above **commits** to decimation, Path2D caching, and typed
arrays "at target scale," and to perf-invariant tests. What's missing is
**numbers**: where draw-everything actually tops out, how much each lever buys,
and how the result stacks against the libraries a consumer would otherwise reach
for. This section proposes the bench that produces them, the build that lifts the
ceiling, and the honest comparison that comes out the other end. As of writing,
M0–M4.2 have shipped (axes, theme, BandChart, tracker, pan/zoom); **none of the
scale machinery — decimation, culling, Path2D cache — exists yet.** Every point
is drawn every frame the data canvas repaints. So the bench measures a real, not
hypothetical, un-decimated renderer.

### Thesis the numbers should support

1. **Canvas is a generational leap over SVG — which is exactly what we succeed.**
   The widely-cited klishevich benchmark (SciChart WebGL vs React-Charts Tanstack
   **SVG**) is a _WebGL-vs-SVG_ result: SVG ~2 FPS / 53s for 10k points, WebGL
   40+ FPS / 2.28s. pond-charts succeeds react-timeseries-charts — an **SVG**
   library — so canvas is the leap over our own lineage and the SVG cliff this
   RFC was born from (Recharts/Victory/Tanstack). This is the headline win and
   the easiest to demonstrate; the bench just has to **quantify the cliff** with
   our numbers against the published SVG ones.
2. **The ceiling is drawing every point, not "canvas".** AG Charts renders 1M
   points at 60 FPS on **canvas** via the **M4 algorithm** (Jugel et al., VLDB
   2014: bucket by pixel column, keep min/max/first/last per column → a
   pixel-identical line from O(plot-width) points). M4 _is_ the "pixel-bucket
   min/max accumulator" this RFC already commits to (#8) — AG Charts is the
   field proof that the bet pays off. So the competitive evidence **validates**
   the existing plan; the work is to build and measure it.
3. **WebGL wins only where decimation can't help — and that's narrow.** Dense
   scatters and heatmaps: every mark spatially meaningful, nothing to bucket
   away. But the **`preserveSparse` hint already specced (Codex 8)** covers the
   _sparse_ scatter case (anomaly dots, reservoir samples) by rendering every
   point — no decimation needed at sparse counts. The genuine WebGL win is
   _dense_ scatter / heatmap fields (millions of overlapping marks). Concede that
   one honestly; it is small and defensible.

One-line position: **"Canvas is a generational leap over the SVG libraries
pond-charts succeeds; it reaches WebGL-class _line_ scale (1M+) with the
pixel-bucket decimation this RFC already plans; WebGL still wins for dense
scatter/heatmap fields."**

### Correction: decimation is a render concern, not a pond-core operator

A first draft of this plan proposed an **M4 pond-core operator**
(`TimeSeries.downsampleM4`). That contradicts the decision already made above —
_"the chart owns its decimation grid"_ — and the existing decision is right.
Pixel-bucket decimation depends on **plot width and zoom**, which are render
state, not data semantics. pond's "reducers live upstream" principle governs
**semantic** aggregation (rolling percentiles, `aggregate`); **pixel**
decimation is the renderer's viewport/decimator stage. So M4 here means
**implementing that stage**, formalized — not a new `TimeSeries` method, and
therefore no human-merge-gate on the core public surface. (Recording the
walked-back alternative per CLAUDE.md, so a future session doesn't re-propose
it.)

### Phase 1 — bench harness = Codex-9 perf invariants, measured

Codex-9 already lists the perf-invariant tests (no heap growth after N append
frames, bounded draw time at fixed size, pan/zoom invalidation, sparse-marker
preservation, DPR resizing). Phase 1 **implements those as a measurement
harness** and extends them to a competitive curve.

- **Render bench (browser):** Playwright over Storybook. Metrics — initial render
  (ms to first paint), live-append sustained FPS (rAF frame-count over a fixed
  window; mirror the references' ~100 pts/20ms and a faster tier), pan/zoom
  interaction FPS + input→paint latency, JS-heap (Chrome `performance.memory`;
  directional, note the caveat).
- **Sizes / scenarios:** 1k / 10k / 100k / 500k / 1M points × {single line, 3
  series, band}. Seeded deterministic generator. Median of N; warm-up discarded;
  **machine pinned and recorded — numbers are directional/relative, never
  absolute.** Commit the JSON results so regressions surface later (the
  perf-invariant tests become CI guards at a fixed fixture size).
- **Output:** the baseline curve + a one-paragraph diagnosis of **where
  draw-everything tops out and on which metric** (expect initial render + pan FPS
  to degrade first, CPU stroke cost over N points). That diagnosis is what
  justifies — and orders — the Phase 2 build.

### Phase 2 — build the decimator (the M4 this RFC already specced)

Chart-side viewport/decimator stage, per the existing pipeline (`typed-array
store → viewport/decimator → canvas renderer`):

- **M4 = pixel-bucket min/max _+ first/last_.** The RFC says min/max (#8); adding
  first/last per bucket keeps the polyline continuous across bucket boundaries
  (the line enters/exits each pixel column correctly). Driven by the
  `DecimationHint` already specced — `line: 'minmax'`, `band:` paired
  `(min lower, max upper)` so the envelope never inverts, `scatter:
preserveSparse`.
- **Viewport culling (independent win).** Bisect the columnar x-array to the
  visible range (+1 point each side) before drawing — pan/zoom on a large series
  stops walking off-screen points. Do this even if M4 slips.
- **Re-bench → target ~1M points @ 60 FPS for lines.** Report the lift as a
  before/after table.
- **The real engineering, flagged:** decimation is view-dependent; re-decimating
  every pan frame is O(visible), up to O(1M) zoomed out. Options to benchmark,
  simplest first: (i) cull-then-decimate per frame, measure if it's already
  enough; (ii) cache the decimated set per `(view, width)` and reuse across pan
  frames at one zoom; (iii) a multi-resolution pyramid. Escalate only on
  evidence; `log` what was chosen.

### Phase 3 — competitive comparison + honest guide

A how-to / benchmark guide in `website/docs/how-to-guides/` (first-person,
grounded in the measured numbers, per the experiment-guide template):

- **One-time _measured_ head-to-head.** A temporary SciChart trial license +
  AG Charts + pond-charts on identical scenarios, captured once. **The numbers
  are kept; the harness is disposable** — SciChart is not added as a maintained
  dependency (pjm17971's call). Document the methodology + machine for
  reproducibility. uPlot (this RFC's existing streaming target) is the canvas
  peer most worth measuring directly.
- **The position** — §"Thesis" above, now backed by our curve: the SVG→canvas
  leap (vs published Tanstack numbers, for anyone on Recharts/Victory/RTC),
  reaching line scale via the planned decimation (vs AG Charts' M4 1M@60fps),
  conceding dense scatter/heatmap to WebGL.
- **Decision guide** — pond-charts when {timeseries dashboards, line/band/bar,
  ≤~1M line points, lightweight, no GPU dep, and the data already lives in pond};
  WebGL when {dense scatter/heatmap fields, many-million spatial marks}.

### Open questions for the dashboard review

The dashboard agent is the use-case voice here — it builds a real consumer and
knows its actual workload. Specifically:

1. **What dashboard-scale numbers actually matter?** Real series count, point
   density, update rate, and window length — so the bench scenarios match
   reality, not invented sizes. (charts.md notes the gRPC experiment _pre_
   -decimated upstream and Recharts still collapsed — does the dashboard
   pre-decimate today, and would it stop if the chart decimated natively?)
2. **Does _any_ decimation belong upstream after all?** The "render concern"
   correction above says no — but if the dashboard's pipeline already produces a
   pixel-grid-aware reduction, is there a seam worth keeping? Red-team the
   correction.
3. **M4 vs LTTB**, and **Path2D × decimation ordering** — which lever the
   dashboard's profile says matters most, and in what order to land them.
4. **Is the one-time SciChart number worth the trial-license friction**, or do
   published numbers + a direct uPlot comparison carry the guide?

### Out of scope / non-goals

Maintained SciChart dependency or head-to-head harness (the validation is a
disposable one-off). Brush / range-select (M4.3, skipped — no drivers). Chasing
dense-scatter WebGL parity. Over-claiming: report where canvas loses, numbers
are directional, no cherry-picked sizes.

### Dashboard use-case review (dashboard agent)

> _Layered from the dashboard agent's adversarial review on PR #250 (2026-06-20),
> condensed; full per-trace numbers in the dashboard agent's friction note
> "Snapshot flush cost at heavy load." One consumer's voice — input, not verdict
> (pjm17971)._

**The thesis to push back on: the ceiling isn't "too many points" — it's
upstream.** From the dashboard's own traces, chart per-frame draw cost stays at
**50–150 μs** (3–5× under a 60fps budget) even at 256 series. What pegs the CPU is
the data side: `view.toTimeSeries()` rebuilding O(buffer) snapshots per flush (93%
redundant work on back-to-back identical-state calls at 262K events), React commit
cost (30–90 ms flush clusters), and GC from per-flush typed-array allocation (7.2 s
GC in a 175 s trace). **Framing risk:** a reader sees "1M @ 60fps via M4" and
concludes perf is solved — but the **data-side ceiling hits first** for
live-streaming. M4 lifts the render ceiling; the LiveView gather path addresses the
data one. Name both.

**Scale (Q1):** 4–32 series typical (256 stress); 30–1,500 pts/series in-window
_after_ the rolling collapse; 5–10 Hz update; ~120–50,000 points rendered/chart
normal, ~250k stress. The dashboard pre-decimates **indirectly** —
`partitionBy.rolling('1m', { avg })` collapses raw 5 Hz into per-host rolling
averages, and stays regardless (it also yields `avg`/`sd`/`n` for σ-band anomaly
detection). So the dashboard sits **below where M4 starts to matter** in normal
use; the stress harness is what approaches it.

**Decimation seam (Q2):** the "render concern" correction is right — `plot_width`
must not go into pond. But pond already has `column.bin(N, 'minMax')`; the clean
split is **pond does the per-bucket reducer math (min/max/first/last), the chart
supplies `plot_width` + the visible slice.** Algorithm where reducer math lives;
viewport context in the chart.

**M4 vs LTTB + ordering (Q3): M4, no contest** — the dashboard charts for anomaly
detection; LTTB smooths single-sample spikes away (the σ-band dots would silently
vanish). Keep **+first/last** (band paths gap at bucket boundaries without it).
**Decimation first, Path2D second** — draw is already cheap; Path2D only buys on
pan (not on the dashboard roadmap) and invalidates every frame on a 5–10 Hz append
anyway.

**SciChart (Q4): skip** — not worth the friction for the dashboard's purposes;
klishevich stands in for the WebGL ceiling, **uPlot** is the canvas peer worth
measuring, AG Charts' published M4 1M@60fps is the field proof (no license).

**Asks:** (1) add the flush-cost caveat so M4 isn't read as "perf solved"; (2)
weight the perf-invariant tests toward **live-append** ("sustain 10 Hz for 5 min,
no heap growth / FPS decay" > "render 1M static"). **Endorses as-is:** thesis 1
(SVG→canvas; Recharts died at 8×1500, canvas fine at 256×same), thesis 3 (concede
dense scatter; `preserveSparse`), skip brush, "numbers kept, harness not
maintained."

### Library response + synthesis (pond-ts library agent + pjm17971, 2026-06-20)

The review is the most valuable kind — real traces, sharp pushback. It doesn't
weaken the case for the perf work; it **sharpens the position.** Two things are
true at once, and the guide must hold both:

1. **A competitive performance profile is necessary.** pond-charts exists for the
   pond-integrated edge (`data → pond → charts`, no pre-decimation required), and
   that edge is only credible if the rendering is visibly competitive — "the
   visualization end of pond" can't lag the field. So we build and publish the
   profile (SVG→canvas leap, M4 line-scale proof, uPlot head-to-head) **regardless
   of whether any single consumer needs 1M points.** Positioning, not a
   per-consumer requirement.
2. **The chart is rarely the real bottleneck.** The dashboard's traces prove it —
   50–150 μs draw, data-side dominates. In a non-pathological app the canvas chart
   isn't the wall (and WebGL's scale edge carries real cost: GPU dependency, bundle
   weight, context limits, integration complexity).

These don't conflict — **the dashboard's data becomes the guide's strongest honest
claim.** The position isn't "we're the fastest"; it's: _canvas is a generational
leap over SVG (proof); it reaches WebGL line-scale via M4 (proof); and in a real
app the chart usually isn't your bottleneck anyway (here's a real consumer's
traces) — so WebGL's scale advantage rarely pays for its tax unless you're in the
specialized dense-scatter case._ That's a more confident position than a raw FPS
bake-off, and only the dashboard's traces let us make it.

**Adopted from the review:**

- **Name both ceilings.** The section's "ceiling is drawing every point" is the
  _render_ ceiling. Add the **data-side ceiling** — snapshot rebuild + partition
  fanout + GC on the live-flush path — as hitting first for streaming consumers,
  addressed by the **LiveView gather** path (core/live work the dashboard points
  to, separate from charts), not by M4. The flush-cost caveat goes in the guide so
  M4 is never read as "perf solved."
- **Phase 1 weights live-append.** Primary gating invariant: _sustain 10 Hz append
  for 5 min, no heap growth, no FPS decay_ at dashboard-real sizes (4–32 series,
  ≤1,500 pts/series in-window). Static 1k→1M curves still run — they're the
  competitive profile + the M4 proof — but the streaming invariant gates.
- **Q2 bin seam.** Adopt: the M4 _reducer math_ (per-bucket min/max/first/last) can
  live in pond's `bin` family (where reducer math belongs); the chart's decimator
  supplies `plot_width` + the visible slice — satisfying both the "render concern"
  correction (no `plot_width` in pond) and "reducers upstream," better than either
  alone. **Resolved (dashboard follow-up below): extend `bin`** to emit
  first/last; the M4 decimator becomes `bin('minMaxFirstLast')` over the visible
  slice.
- **Q3 confirmed** — M4 not LTTB (anomaly visibility), keep +first/last, decimation
  before Path2D.
- **Q4 / SciChart — reconciled with the competitive-profile requirement.** The
  dashboard doesn't need the number; the _library_ wants the profile. Resolution:
  build it from a **measured uPlot head-to-head** (the real canvas decision space)
  **+ published numbers** (klishevich, AG Charts) — carries the position without a
  trial license. The one-time SciChart trial stays **optional** (pjm17971's earlier
  "validate temporarily, don't maintain") — a spot-check, not a gate.

This is one consumer's input; the competitive profile serves the broader landscape
the library lands in. Where the dashboard's needs and the positioning diverge
(SciChart, pan/zoom weighting), the guide serves both — measured where it's cheap,
honest where it isn't.

### Q2 resolved + review closed (dashboard follow-up, 2026-06-20)

> _Dashboard agent, following up on PR #250 — endorsed the synthesis ("the reframe
> is sharper than the critique"), resolved the one open question, and closed from
> the dashboard side._

**Q2 — extend `bin`, don't keep M4 chart-side.** The decimator's reducer math
lands in pond by **extending `column.bin` to emit first/last** (e.g.
`bin(N, 'minMaxFirstLast')`); the chart contributes only `plot_width` + the visible
slice. Reasoning:

1. **Reducer math belongs in pond** — first/last per bucket are stateless reducers
   that fit the columnar substrate; reimplementing them chart-side just to gate on
   `plot_width` is complexity for no semantic gain.
2. **First/last aren't chart-specific** — useful for any time-bucketed consumer
   (change detection, regime-shift markers, alert dedup, sparse-event-in-bucket
   reporting); chart-only would force re-implementation elsewhere.
3. **Clean extraction story** — a consumer on pond + their own chart layer calls
   `column.bin(plot_width, 'minMaxFirstLast')` directly; M4 stays a documented
   algorithm + an idiomatic pond call, and the chart owns only the viewport.

A quick `bin` spike confirms before building, but the prior is strong. **Net:** the
M4 decimator becomes `bin('minMaxFirstLast')` over the visible slice — reducer math
in pond, `plot_width` in the chart. A small, generally-useful addition to the `bin`
reducer set (perf-checked when built), not a new `TimeSeries` method.

### Estela use-case review (estela agent)

> _Layered from the estela agent's review on PR #250 (2026-06-20). estela's
> `DataChart` is the M5 parity target — the static, single-activity counterpart to
> the dashboard's live stream, so it stresses the seam in different directions. One
> consumer's voice — input, not verdict._

Endorses the section + the Q2 resolution (it threads "reducers upstream" vs
"`plot_width` is render state" cleanly). Three things the dashboard's lens doesn't
cover:

1. **The decimation axis is distance, not time — the same primitive as F-geo-2.**
   estela decimates over **cumulative distance** (a derived monotonic _non-key_
   column) via `profileByDistance`, re-bucketed on zoom. If `bin('minMaxFirstLast')`
   only buckets the time/key axis, estela can't use the seam. This is the same
   primitive as `geo.md`'s **F-geo-2** (distance-domain bucketing — "bucket over any
   monotonic derived column," its open design question). Make `bin` bucket over a
   **supplied monotonic column** (not only the key) and the chart decimator, geo
   splits, and estela's distance profile unify under one primitive.
2. **min/max bands ≠ statistical bands — and both consumers want statistical.** The
   `DecimationHint` band path is paired min/max. estela's band is **percentile**
   (p5/p95 outer, p25/p75 inner, median — anomaly-robust, so one GPS spike can't
   blow the envelope); the dashboard's is **σ** (avg/sd/n). Neither reproduces from
   raw min/max. So `'minMaxFirstLast'` covers the **line**, not the **band** — the
   reducer set must extend to quantiles / mean+sd. **This is the one place the plan
   as written would miss M5 parity**: a naive min/max band is visibly noisier than
   estela's percentile band.
3. **estela's long tail is squarely M4-scale — on a distance axis.** Demo fixtures
   are moderate (vineman ≈ 26k), but real data isn't: a 24 h ultra ≈ 86k, a
   250 mi/5-day adventure race ≈ 430k, a thru-hike merged into one track ≈ 4M (at
   1 Hz). So estela is a legit **M4-scale** consumer — a _better_ parity proof — and
   it hits **both ceilings**: a continental track stresses the data side (bucketing
   ~4M + percentiles per bucket) and the render side (even after 100 m distance
   bucketing, a full overview is ~42k display points). estela's zoom-dependent
   distance re-bucketing **is** the M4 idea on a non-key axis.

**Bench ask:** add the scenario both the dashboard (live, ≤32 series, ≤1,500
pts/window) and the static line curve miss — **continental-scale (1–4M samples),
distance-domain, percentile band, zoomed fully out** — the worst case for per-bucket
reducer cost _and_ rendered-point count, and the M5 estela-parity workload.
**Minor:** `DataChart` breaks the line on sustained coasts/gaps (0 W → NaN, not
interpolated) — decimation must not bridge gaps; a one-line M5-parity note (same
gap-honesty theme as geo's `MAX_CARRY_METERS`).

### Library response to the estela review (pond-ts library agent, 2026-06-20)

The two lenses now bracket the design: the dashboard stress-tested **live / time /
σ-band / data-side ceiling**; estela stress-tests **static / distance / percentile
band / M4-scale, both ceilings.** estela doesn't contradict the dashboard — it
**widens the seam**, and three points change the plan:

- **Adopt: `bin` buckets over a supplied monotonic column, not only the key.** This
  is the generalization F-geo-2 already flagged as "probably the highest-value, most
  architecturally interesting geo primitive." One primitive — _bucket over any
  monotonic derived column_ — then serves **chart decimation (`plot_width` buckets
  over time _or_ distance), per-km geo splits, and estela's distance profile**: a
  triple-signal (charts + geo + estela), the same pattern as F-geo-1's
  `fromTrustedColumns`. The Q2 resolution updates to `bin(axisColumn, plot_width,
reducers)` over the visible slice — `axisColumn` defaults to the key, can be
  cumulative distance.
- **Adopt (the substantive parity gate): the band reducer must be statistical.**
  `minMaxFirstLast` is the **line** decimator; the **band** decimator needs the
  statistical reducers both consumers use — percentiles (estela) and mean+sd
  (dashboard). A raw min/max envelope is visibly noisier than a percentile band and
  would fail M5 parity. Open for the `bin` spike: whether `bin` computes band
  statistics per bucket directly (raw → `bin(p5,p25,p50,p75,p95)`) or decimates an
  already-rolled band (rolling upstream → percentile columns → `bin` min/max of
  those to preserve the envelope). Either way the reducer set exceeds
  `minMaxFirstLast`, and **"the percentile band reproduces faithfully" becomes a
  named M5-parity invariant.**
- **Adopt: the continental-scale bench scenario.** Phase 1 gains a fourth scenario
  beyond live-append, static curve, and band — **1–4M samples, distance-domain x,
  percentile band, zoomed fully out** — and estela is promoted from "below M4" to
  **the M4-scale parity proof** that exercises both ceilings on a non-key axis.
- **Adopt (minor): gap honesty.** Decimation must not bridge NaN gaps (coasts, GPS
  dropouts) — the line breaks, the band drops; a one-line M5-parity invariant,
  consistent with the existing gap-aware decimation note and geo's
  `MAX_CARRY_METERS`.

**Net across both reviews:** the seam is `bin(axisColumn, nBuckets, reducerSet)` —
`reducerSet` ∈ {`minMaxFirstLast` (line), statistical (band)}, `axisColumn` ∈
{key/time, distance, any monotonic derived column} — with the chart supplying
`plot_width` + the visible slice. The bench gates on the live-append invariant
(dashboard) _and_ the continental distance/percentile worst case (estela). Reducer
math + bucketing-over-a-monotonic-column live in pond (unifying with F-geo-2);
viewport state lives in the chart. Materially better-specified than the original
draft, with both real consumers' workloads represented. Review loop closed on both
lenses; phases adopt into PLAN when the work is scheduled.
