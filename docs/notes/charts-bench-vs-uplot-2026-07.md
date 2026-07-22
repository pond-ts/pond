# @pond-ts/charts vs the uPlot bench (leeoniya/uPlot/bench) — 2026-07-22

> Harness + raw results:
> [`packages/charts/perf/external/uplot-bench/`](../../packages/charts/perf/external/uplot-bench/)
> (see the [external-bench README](../../packages/charts/perf/external/README.md)
> for how to re-run). Companion:
> [charts-bench-vs-scichart-suite-2026-07.md](charts-bench-vs-scichart-suite-2026-07.md)
> — the SciChart suite run + the CPU profiles that turned both runs into the
> perf tasks now in [PND_CHARTS_PLAN.md](../plans/PND_CHARTS_PLAN.md).

**Protocol.** uPlot's own bench workload run locally, same machine, same harness,
for every target: its `data.json` (55,550 timestamps × 3 series = 166,650
points), a 1920×600 chart, 3 line series on two scales (CPU %, RAM %, TCP MB
right-axis). Headless Chromium (Playwright, `--enable-precise-memory-info`),
medians of 3 loads; "chart" is the page-stamped create→painted time (uPlot's
"done" column, data prep excluded for every lib); heap final is after a forced
GC; mousemove is a 10 s CDP-dispatched sweep across the plot with an in-page
rAF FPS counter. Machine: Apple Silicon MacBook Pro, 2026-07-22. Numbers are
directional — the _relative_ ordering is the signal.

**pond-ts state:** branch `feat/charts-draw-stats` working tree @ v0.50.0,
`onDrawStats` instrumentation active. Pond rows marked "fixed" include the
one-line `timeRange` identity fix (see Finding 1; since merged as
[#524](https://github.com/pond-ts/pond/pull/524)); load-time rows are
unaffected by it.

## Results

| lib                        | js min/gz KB | prep ms | chart ms | load script ms | heap peak/final MB | mm 10s script ms | mm fps | mm max gap ms |
| -------------------------- | ------------ | ------- | -------- | -------------- | ------------------ | ---------------- | ------ | ------------- |
| uPlot v1.6.32              | 51 / 22      | 6.9     | **15.0** | 25.2           | 13.8 / **3.3**     | **77**           | 119.8  | 25.5          |
| Chart.js v4.5.1 (CDN)      | 203 / 68     | 8.0     | 36.0     | 38.8           | 21.7 / 9.9         | 483              | 120.1  | 9.4           |
| pond-charts (decimate on)  | 643 / 189 ¹  | 12.1    | **11.8** | 64.8           | 25.8 / 6.7         | 336              | 119.8  | 24.1          |
| pond-charts (decimate off) | 643 / 189 ¹  | 11.2    | 12.3     | 73.8           | 25.8 / 6.7         | 431              | 119.9  | 24.9          |

¹ Whole-page bundle (a pond app already ships most of it): react+react-dom
188/58, pond-ts core 344/94, @pond-ts/charts+d3 **149/50**.

> **Raw-data provenance.** The uPlot and Chart.js rows match the committed
> `results-local.json` exactly. The pond rows are from a same-session run
> whose raw JSON was not preserved (the committed
> `results-local-pond-fixed.json` is a later pond-only re-run); against the
> committed files the deltas are run-to-run noise — chart 10.8 vs 11.8 ms,
> mm script 408 vs 336 ms, mm max gap 33 vs 24 ms — and **no cross-library
> ordering changes**. Treat the committed JSONs as the auditable numbers and
> this table as the session record.

Per-layer draw (onDrawStats): decimate on = 3.3 ms total, 55,550 → 7,280
points/layer (M4, DPR 1); decimate off = 10.0 ms total, all 55,550 stroked.

Mousemove per-event script cost: uPlot 0.13 ms, pond 0.56 ms (fixed),
Chart.js 0.80 ms. Pre-fix pond: 2.8 ms/event (decimate on, 41 fps),
9.0 ms/event (decimate off, 10.5 fps, 142 ms worst gap).

## Findings

1. **BUG (pre-existing on main, shipped in ≤ v0.50.0): every cursor mousemove
   repainted the data canvas.** `ChartContainer`'s frame memo rebuilds on
   `cursorX` change (by design) but allocates a fresh `timeRange: [d0, d1]`
   array each rebuild; `Layers`' draw `useCallback` lists `container.timeRange`
   as a dep → new identity per cursor move → new draw callback → `Canvas`
   layout effect re-runs → full replot including per-layer M4 re-decimation,
   despite the cursor living on the SVG overlay precisely to avoid this.
   Measured: 105 canvas repaints / 122 mousemove events (decimate on); with
   decimation off the repaint is so slow the event loop backpressures to 31
   events/3 s at 10.5 fps. **Fix (verified):** hoist
   `const timeRangeTuple = useMemo<[number, number]>(() => [d0, d1], [d0, d1])`
   and put that in the frame → 0 repaints, 120 fps both modes.
   **Status: shipped** — [#524](https://github.com/pond-ts/pond/pull/524)
   landed the fix plus a frame-audit for the same leak class.
2. **The internal perf harness cannot see this class of bug.** Pan/zoom change
   `timeRange` legitimately (repaint is _correct_ there); hover-only FPS was
   never measured. A hover-sweep invariant belongs in
   `e2e/perf-invariants.spec.ts` (assert zero data-canvas repaints — trivially
   checkable now via `onDrawStats` frame counting). **Status: shipped** — the
   invariant landed with [#524](https://github.com/pond-ts/pond/pull/524).
3. **Chart create is pond's strongest column** — 11.8 ms vs uPlot 15.0 —
   and stays 12.3 ms even stroking all 166,650 points (Float64Array columns +
   monotonic-x path). React boot is why total load script is ~2.6× uPlot's.
4. **Bundle size is the honest weak column** vs uPlot (149/50 KB for charts+d3
   alone vs 51/22 all-in; plus pond-ts 344/94 and React if not already shipped).
5. **Heap peak** (25.8 MB) is the other visible cost — row-array prep +
   `TimeSeries` construction + Float64Array materialization; final (6.7 MB)
   sits between uPlot (3.3) and Chart.js (9.9).
6. **Why hover is still ~5× uPlot's per-event cost after #524** _(→
   [PND-HOVCTX])_. #524 removed the canvas repaint, but the residual
   0.56 ms/event (vs uPlot 0.13) is a **React render+commit cascade**, not a
   redraw. Cursor position is `useState` on `ChartContainer` exposed as
   `ContainerFrame` fields (`cursorX`/`cursorY`/`cursorRowKey`),
   so `handlePointerMove`'s three setState calls rebuild the frame memo with a
   fresh identity each move and **every** `ContainerContext` consumer
   re-renders — including ones that never read the cursor. Measured (React
   Profiler, 179-event sweep): **4 commits/event**; both `YAxis` and `Legend`
   re-render on every move; the CPU profile shows no hot function and no
   redraw — just render+commit spread across `ChartContainer`/`Layers`/`YAxis`
   ×2/`Legend` (incl. `orderLegendItems` recomputing on each hover). uPlot has
   no vdom, so it moves the cursor with a direct DOM write and touches nothing
   else. **Fix:** a dedicated `CursorContext` for the three varying fields;
   config consumers (`YAxis`, `Bar`/`Box`) then keep a stable frame and stop
   re-rendering on hover (details + expected 4→~2 commits/event in
   [PND-HOVCTX]).

## Files

Committed in
[`packages/charts/perf/external/uplot-bench/`](../../packages/charts/perf/external/uplot-bench/):
`pond.html` + `src/pond-bench.jsx` (bench page), `uPlot.html` / `chartjs.html`
(instrumented copies of the upstream bench pages), `run-bench.mjs` (harness),
`check-repaint.mjs` (repaint counter), `results-local.json` /
`results-local-pond-fixed.json` (raw). Not committed (fetched or built at
re-run time — see the README): uPlot's `data.json` workload, the `uplot-dist`
vendored build, the esbuild output bundles, and the rendered-proof
screenshots.
