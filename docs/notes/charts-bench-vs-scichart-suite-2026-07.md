# @pond-ts/charts in the SciChart JS chart-performance test suite — 2026-07-22

> Adapter, drivers, profilers + raw results:
> [`packages/charts/perf/external/scichart-suite/`](../../packages/charts/perf/external/scichart-suite/)
> (see the [external-bench README](../../packages/charts/perf/external/README.md)
> for how to re-run). Companion:
> [charts-bench-vs-uplot-2026-07.md](charts-bench-vs-uplot-2026-07.md).
> The library-actionable findings below are triaged into tasks in
> [PND_CHARTS_PLAN.md](../plans/PND_CHARTS_PLAN.md) — IDs inline.

**Protocol.** abtsoftware/javascript-chart-performance-test-suite run locally,
same machine, all libraries sequentially through the suite's own harness
(3 s FPS window per size, escalating point counts to 10M, skip-cascade below
1 fps, `HANGING` if setup exceeds 3 s). A `public/pond/` adapter implements the
suite's hook contract with the same semantics as its uPlot adapter (800×600,
cursor off, per-frame y-zoom / append / y-jitter via `flushSync` so React pays
its full cost inside each timed frame). Playwright headless Chromium with
`--use-angle=metal --enable-gpu` — **real Apple M1 Pro Metal GPU** for WebGL
(verified renderer string; default headless is SwiftShader, which would have
crippled SciChart) — rAF cadence ≈ 120 Hz, so 119 fps ≡ at-cap. Run
2026-07-22. Directional; the cross-library ordering on this machine is the
signal.

**Vendor caveat.** The suite is published by SciChart and its test axes
(raw point-count scale, GPU-friendly workloads) favour a WebGL engine — read
it as "how far does each architecture stretch", not "which chart should a
dashboard use". Their README's own caveats say as much. One reproducibility
flag: our local uPlot runs the unsorted-XY group at 119 fps @ 50k where their
published table records 0.11 fps — the vendored adapter has since gained a
custom Path2D renderer; published vendor numbers and current-suite behaviour
can drift apart, which is exactly why we re-run locally.

**pond scope.** 8/13 categories implemented. Brownian-scatter and unsorted-XY
report SKIPPED by design — pond is a time-series library and its series
contract is monotonic sorted x. Heatmap and the 3D categories are UNSUPPORTED
(no such layers). Multi-chart runs 1 chart only (2+ charts include a
Brownian-scatter slot).

## Avg FPS by category (local run; cap ≈ 119)

Full tables in `suite-results.json` / `pivot.mjs`; the shape in brief, listing
points → scichart / pond / uplot / chartjs:

**Candlestick — pond's headline.**
200k: 119 / **119.7** / 4.7 / dead · 1M: 119 / **46.1** / 0.6 / — ·
10M: 117.8 / **5.2** / — / —.
pond's M4-decimated OHLC holds the frame cap through 200k candles —
indistinguishable from the WebGL engine — and completes the full 10M ladder.
uPlot's candle plugin (fillRect per candle) collapses at 50k. In the vendor's
published table only SciChart/ChartGPU/LCJS survive past 500k; pond joins that
club as a canvas+React library.

**Mountain (area).** pond at cap through 200k, then 52 @ 500k, 28 @ 1M,
3.1 @ 10M. uPlot holds cap to 1M and wins the tail (18 @ 10M). SciChart flat
at cap.

**Column.** pond ≈ uPlot throughout (23.9 vs 31.8 @ 100k; both ~0.2 @ 5M);
SciChart flat at cap to 10M.

**N series × M points (monte-carlo).** pond is the weakest of the three
performers: cap to 200×200, 9.5 fps @ 1000×1000, dead at 2000×2000
(uPlot 24.8 / 5.5; SciChart 47.3 / 27.2). Per-frame React reconcile over N
layer elements dominates. _(First-pass guess — overturned by the profile;
see finding 1 and 6 below.)_

**Point series, y-update per frame.** pond 18.1 @ 100k vs uPlot 37.4,
SciChart 118.9. Full per-frame `fromColumns` rebuild + un-decimated scatter
markers.

**FIFO / ECG streaming (5 series).** pond at cap through a 10k window, then
31.6 @ 100k vs uPlot 119 / SciChart 119; 3.2 @ 1M window. The per-frame
`live.toTimeSeries()` snapshot + chart-series conversion is the data-side
ceiling the internal perf doc already names — this run quantifies it against
neighbours.

**Compression (append-as-fast-as-you-can).** cap to 10k, 52.5 @ 100k
(uPlot 83), 15.9 @ 1M (uPlot 26.5, SciChart 87.6), 3.5 @ 10M (uPlot 6.2,
SciChart 24.7). Within ~1.7× of uPlot at every rung.

**Multi-chart.** pond 50.5 fps at 1×100k chart (uPlot 78.4, SciChart 117.7);
2+ charts skipped (scatter slot).

**Chart.js** died early in every category (their published table agrees), and
its candlestick page errors outright (`ERROR_APPEND_DATA` — the CDN financial
plugin setup in the suite's own page).

## Read on the architecture axis

SciChart's thesis — GPU engines are flat in N, canvas libraries are linear —
reproduces locally. What the vendor table understates is how far decimation
moves a canvas library along that axis _when the workload has structure_:
pond's sorted-x + M4 pipeline makes candlestick behave GPU-flat to 200k and
keeps every static category alive to 5–10M, while staying a React component
tree. Where pond pays is (a) per-frame work that scales with **series count**
(React reconcile), (b) per-frame work that scales with **raw N even when the
picture doesn't change** — see below — and (c) snapshot rebuild cost on the
live path.

## Library-actionable findings (friction) — profile-verified

CPU profiles (V8 sampling, 200 µs, unminified bundle; `profile-nxm.mjs` /
`profile2.mjs`) were taken for the two weak categories. They **overturn the
first-pass guesses** — React is noise, decimation is engaged-and-cheap; the
costs are per-point constants and one O(N)-per-frame walk:

1. **The per-point draw pipeline is the NxM ceiling — not React.**
   _(→ [PND-AFFINE])_ At 1000×1000 (125 ms/frame; React < 1%, decimation 0.1%
   because 1k-point series sit below the M4 threshold, so all 1M points stroke
   every frame), ~55% of self-time is the per-point call chain: accessor arrow →
   d3-scale `scale()` + its deinterpolate/interpolate closures (~37%) →
   d3-shape `line`/`point` (~18%), before `lineTo`/`stroke` (~14%) do the
   actual work. uPlot draws the same 1M points in 40 ms with `m*v+b` inline.
   **Fix:** a `curveLinear` fast path in `drawLine`/`drawArea` that
   precomputes the affine scale (kx, bx, ky, by) and loops raw
   `ctx.lineTo` over the typed arrays, bypassing d3-shape + d3-scale.
   Est. 3–6× on stroke-bound frames; benefits every line/area/candle draw.
2. **`buildGradient` walks the full series every frame — the real mountain
   ceiling.** _(→ [PND-GRADX])_ At mountain@1M (47 ms/frame), 21% self-time is
   `buildGradient` plus most of the ~52% d3-scale closure time it drives — an
   O(N) pass per repaint to find the fill gradient's pixel extent, while the
   decimation walk everyone suspected is only ~19% (binBy +
   reduceFloat64ByBounds + decimateM4). **Fix:** derive the gradient extent
   from the M4 output (M4 preserves per-bucket extremes, so the global min/max
   is exact) or a cached column extent — kills ~half the frame at large N.
3. **Decimation cache keyed on x-domain** _(→ [PND-DECKEY])_ (series identity,
   x-domain, plot width): still real — the remaining ~19% at mountain@1M
   recomputes an x-only function under y-only invalidation (every y-zoom /
   y-autorange frame). Third in line after (1) and (2).
4. **Scatter markers and bars don't decimate** _(→ [PND-MARKDEC])_ — groups
   4/5 fall off exactly where line/area/candle don't. M4 for marks ≈
   per-pixel-column min/max representative points; bars ≈ per-column envelope.
5. **Live snapshot rebuild dominates FIFO at ≥100k windows** — already the
   known data-side ceiling; now quantified (pond 31.6 vs uPlot 119 @ 100k).
   _(No new task — evidence recorded against [PND-LIVELYR] and the data-side
   items [PND-GATHER] / [PND-COLOUT] / [PND-LROLL].)_
6. **A multi-series layer API is an ergonomics gap, not a perf fix.** React
   reconcile over 1000 layer elements measured ~1% of frame time — element
   count is not why NxM collapses; (1) is. _(Recorded in the
   PND_CHARTS_PLAN parking lot so it is never built as perf work.)_

## Files

Committed in
[`packages/charts/perf/external/scichart-suite/`](../../packages/charts/perf/external/scichart-suite/):
`pond/` (adapter: `pond_tests.src.jsx`, `pond.html`), `run-suite.mjs`
(driver), `suite-results.json` (raw), `pivot.mjs` (tables), `gpu-check.mjs`
(backend verification), `profile-nxm.mjs` / `profile2.mjs` (CPU profilers).
The suite itself is not vendored — clone it and drop the `pond/` directory
into its `public/`; see the README. Companion:
[charts-bench-vs-uplot-2026-07.md](charts-bench-vs-uplot-2026-07.md) (uPlot
bench protocol — load/heap/mousemove on the 166k-point dstat workload, plus
the cursor-repaint bug that bench exposed, fixed in
[#524](https://github.com/pond-ts/pond/pull/524)).
