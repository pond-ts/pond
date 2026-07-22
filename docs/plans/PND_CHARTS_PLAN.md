# PND_CHARTS_PLAN — `@pond-ts/charts` remaining work

> Breakout plan for the **Charts** roadmap section in [PLAN.md](../../PLAN.md).
> Architecture: [docs/rfcs/charts.md](../rfcs/charts.md). Full shipped history
> of the canvas wave (M0–M4, chart types, decimator, cursor model, annotations,
> trading-time axis, categorical axis):
> [docs/archive/charts-wave-2026.md](../archive/charts-wave-2026.md).

The canvas wave (kicked off 2026-06-17) shipped the rendering spine, seven
chart types, the full interaction stack (cursor modes, pan/zoom, selection
Phase 1, annotations), the M4 decimator (pan-FPS cliff closed to 1M points),
the trading-time axis, and the categorical axis Phase 1. The package is
**published** (`@pond-ts/charts` on npm, `private: false`); what remains is
landing the built-but-unmerged work, Phase-2 slices of the adopted RFCs, the
M5 parity gate for the stable / estela-parity milestone, and the perf backlog
from the 2026-07 external bench ([PND-AFFINE] → [PND-GRADX] → [PND-DECKEY] →
[PND-MARKDEC] for the draw path, [PND-HOVCTX] for the hover path, in
measured-leverage order; notes:
[charts-bench-vs-scichart-suite-2026-07.md](../notes/charts-bench-vs-scichart-suite-2026-07.md),
[charts-bench-vs-uplot-2026-07.md](../notes/charts-bench-vs-uplot-2026-07.md)).

## Tasks

### [PND-CATAX] — Land categorical axis Phase 1

The three PRs (band-scale foundation, `transposeRow` reader, per-column
`mark` identity + label policy) are **built and verified on
`feat/charts-categorical-axis` but not yet pushed**. Landing sequence per PR:
self-review → Layer-2 → a Codex pass (a new scale primitive warrants it); the
`SelectInfo.mark` widening needs the human-approval gate. The RFC's own owed
Codex red-team (§12.3) runs in parallel.

Deferred beyond Phase 1 (stay RFC-only until adopted): the metric branch
(value-x coordinates — Tidal/Estela), the cursor binding / head-row (Phase 2),
label rotation. RFC:
[docs/rfcs/categorical-axis.md](../rfcs/categorical-axis.md).

### [PND-PARITY] — M5 estela parity (stable milestone)

Faithful `DataChart` reproduction on real activity data; prove no-regressions;
hand the production swap to the estela agent (the package already publishes
pre-parity — this is the stable/parity bar, not the first publish). Known M5
gates collected along the way:

- **Statistical bands** (named an M5-parity gate in the decimator wave).
- **Theme tokens required → optional-with-default** so a new chart type isn't
  a breaking `ChartTheme` change (deferred from the chart-type wave).
- Shared **axis-headroom** policy (no layer's auto-fit pads the top edge);
  BarChart hover-vs-select wide-bucket JSDoc (same deferral list).
- Open decision: how the estela swap is coordinated across the two agents.

### [PND-SELECT] — Selection Phase 2

Phase 1 (series-`id` identity, id-gates-interactivity) shipped. Phase 2, per
[docs/rfcs/selection.md](../rfcs/selection.md) A2/A3: the
`SelectInfo | null → readonly SelectInfo[]` widen + `selectionMode`
(multi-select, re-motivated as "pin several series to read");
`LineChart.hitTest` threshold nearest-point; the
`snapToClosest | snapToClosestSelected` prop; theme-referenced dim state.
The widen is a breaking public change — human-approval gate; estela's bar is
the sole external reader (shim for estela only).

### [PND-DECIM] — Decimator Phase 5 (finish-the-wave)

**Shipped (Phases 2–4), released in v0.49.0:** viewport culling (all layers);
M4 line/area/band decimation (auto-on, every gap mode, session breaks); the
pan-FPS re-bench (cliff closed — line/band 90–120 fps to 1M, `three` 24 fps
floor). **Phase 5, post-v0.49.0 (landed on `main`, CHANGELOG `[Unreleased]`):**
candlestick decimation ([#518]) + box-plot decimation ([#519]) — the same M4
interval-mark aggregate (`open=first/high=max/low=min/close=last` for candles;
`min(lower)/max(upper)` whiskers + `min(q1)/max(q3)` IQR body + first-median for
boxes), auto-on with an opt-out `decimate` prop, gated on the **visible** count
(a candle/box's width is its slot, so a deep zoom draws full-width marks, not
1px slivers), interaction reads the source (§2.3). Source of truth:
[docs/notes/charts-decimator-assessment-2026-07.md](../notes/charts-decimator-assessment-2026-07.md);
bench in [`packages/charts/perf/RESULTS.md`](../../packages/charts/perf/RESULTS.md).

**`three`-at-1M floor — decided, not built.** The static `three` (3 overlaid
lines) at 1M pans at 24 fps = 3× the per-frame decimation walk (render, not
data-side). **Path2D caching does _not_ help pan** — the `(view, width)` cache
invalidates every frame as the window moves — so the cull-then-decimate-per-frame
strategy is terminal here. 24 fps is documented as the extreme-case floor
(RESULTS.md re-bench section); Path2D + further `binBy` optimization are deferred
with this reasoning until a real consumer needs `three`-at-1M above 24 fps.

**Remaining:**

- **Release.** Promote CHANGELOG `[Unreleased]` (candle + box entries) → a
  version, bump every `packages/*/package.json` lock-step, tag `vX.Y.Z`, push →
  the workflow publishes. **Human-confirm the version + package set before the
  tag push** (npm publish is irreversible + covers all five packages).
- **How-to guide** — "Rendering large time series" in
  `website/docs/how-to-guides/` (landed with the box PR follow-up): the real
  perf work + the **honest** bench numbers (flat line/band curve, the `three`
  floor, "render ceiling ≠ perf solved — the data-side ceiling hits first for
  live").

**Explicitly deferred (named, not dropped):** LTTB opt-in (§2.5 — reducer shape
reserved; build when a smooth-signal consumer pulls); non-linear-`curve`
decimation (a smoothing curve blobs the 4-points-per-column verticals; fix =
decimate-then-re-smooth, only on a real driver); WebGL dense-scatter/heatmap
parity (conceded). M4 stays the auto-on default; LTTB the explicit opt-in.

[#518]: https://github.com/pond-ts/pond/pull/518
[#519]: https://github.com/pond-ts/pond/pull/519

### [PND-AFFINE] — Affine fast path for the per-point draw pipeline

**Source:** external bench 2026-07-22 — pond run through SciChart's
chart-performance suite and uPlot's bench, then CPU-profiled (V8 sampling,
unminified bundle). Results + protocol:
[charts-bench-vs-scichart-suite-2026-07.md](../notes/charts-bench-vs-scichart-suite-2026-07.md)
(finding 1) /
[charts-bench-vs-uplot-2026-07.md](../notes/charts-bench-vs-uplot-2026-07.md);
harness committed at
[`packages/charts/perf/external/`](../../packages/charts/perf/external/).
**The highest-leverage render lever the run found.**

At N×M 1000×1000 (125 ms/frame — every series sits below the per-series M4
threshold, so all 1M points stroke every frame), **~55% of self-time is the
per-point call chain**: accessor arrow → d3-scale `scale()` + its
deinterpolate/interpolate closures (~37%) → d3-shape `line`/`point` (~18%) —
before native `lineTo`/`stroke` (~14%) do the actual work. React reconcile
over the 1000 layer elements measured ~1% — element count is **not** the
bottleneck (see parking lot). uPlot draws the same 1M points in 40 ms with
inline `m*v+b`.

**Fix:** a `curveLinear` fast path in `drawLine` (`src/line.ts`) and
`drawArea` (`src/area.ts`): precompute the affine transform
(`kx, bx, ky, by`) from the linear scales once per draw, then loop raw
`ctx.lineTo` over the typed arrays — bypassing d3-shape and per-point d3-scale
calls. Est. **3–6× on stroke-bound frames**; also trims every decimated draw
(M4 output still pays the per-point constant today). Non-linear `curve`
values keep the d3-shape path — the same `curve === curveLinear` gate
decimation already uses. Scope note: this does **not** claim the
`three`-at-1M pan floor under [PND-DECIM] — that floor is the per-frame
decimation walk, not stroke. Perf-check protocol applies (complexity note,
before/after table in the commit message; the committed external harness is
the re-measure).

### [PND-GRADX] — `buildGradient`: stop walking the full series per frame

**Source:** same run, finding 2 — the real mountain/area ceiling. At
mountain@1M (47 ms/frame), **~21% self-time is `buildGradient`**
(`src/area.ts`) plus most of the ~52% d3-scale closure time it drives: an
O(N) pass per repaint to find the fill gradient's pixel extent, re-run on
every y-zoom / y-autorange frame. The decimation walk everyone suspected is
only ~19%. Killing it removes ~half the frame at large N.

**Fix options, in preference order:** (a) a **cached column extent** keyed on
series+column identity — semantics-preserving (the extent is over the full
series _by design_, so a full-series cache is exact and O(1) after first
compute); (b) derive the extent from the M4 output — exact per-bucket
extremes, but only over the _visible window's_ buckets, so it changes the
gradient's meaning under x-zoom; take (b) only if a deliberate design call
decides window-relative gradients are wanted. Perf-check protocol applies.

### [PND-DECKEY] — Decimation cache keyed on (series, x-domain, width)

**Source:** same run, finding 3; third in measured leverage after
[PND-AFFINE] and [PND-GRADX]. The remaining ~19% at mountain@1M re-runs an
**x-only computation under y-only invalidation** — every y-zoom or live
y-autorange frame re-decimates to an identical result. Fix: memoize the
decimation output keyed on (series identity, x-domain, plot width) —
e.g. a `WeakMap` on the series carrying a small keyed cache. Wins on y-only
frames (y-zoom, y-autorange); **does not help pan** — the x-domain changes
every pan frame, the same reasoning that rejected Path2D caching for the
`three`-at-1M floor under [PND-DECIM]. Include DPR/gap-mode/column in the key
audit before building. Perf-check protocol applies.

### [PND-MARKDEC] — Decimate scatter marks and bar columns

**Source:** same run, finding 4. The suite's point-update and column
categories fall off exactly where line/area/candle don't (point y-update:
pond 18.1 fps @ 100k vs uPlot 37.4; column dead by 5M) — Scatter and Bar are
the two marks with no decimation path. Shape, following the shipped
decimator conventions (auto-on, `decimate` opt-out, interaction reads the
source — §2.3): **scatter** = M4-for-marks, per-pixel-column min/max
representative points; **bars** = per-column envelope once a bar's slot is
narrower than ~1px (consistent with candle/box's visible-count gating).
Extends the [PND-DECIM] wave to the last undecimated marks. Note the
point-update group also pays a full per-frame `fromColumns` rebuild —
data-side cost, out of scope here. Perf-check protocol applies.

### [PND-HOVCTX] — Split cursor position out of the container context

**Source:** external bench 2026-07-22, uPlot-bench mousemove leg + follow-up
CPU/React profile (finding 6 in
[charts-bench-vs-uplot-2026-07.md](../notes/charts-bench-vs-uplot-2026-07.md)).
The **hover** counterpart to the draw-path tasks above, and the answer to "why
is mousemove still kind of slow" after [#524](https://github.com/pond-ts/pond/pull/524).

#524 stopped the cursor from repainting the **data canvas** (the 2.8–9 ms/event
killer). What remains: cursor position lives in `useState` on `ChartContainer`
(`hoverX`, `hoverPoint`) and is exposed as `ContainerFrame` fields
(`cursorX`, `cursorY`, `cursorRowKey`; note `ContainerFrame.cursorTime` is an
unrelated boolean config flag — the cursor *time value* is derived locally by
each consumer from `cursorX` + `xScale`). Because those are frame fields,
`handlePointerMove`'s three setState calls rebuild the frame memo with a new
identity every mousemove, and **every** `ContainerContext` consumer
re-renders — including the ones that never read the cursor. Measured (React
Profiler, 179-event sweep): 4 commits/event; both `YAxis`, the right `YAxis`,
and `Legend` each re-render on every move. Per-event script ≈ 0.68 ms vs
uPlot's 0.13 ms (uPlot has no vdom — it nudges the cursor with a direct DOM
write). No hot function, no redraw; it's the render+commit cascade of the whole
context subtree.

**Fix:** a dedicated `CursorContext` carrying only the every-move-varying
fields `{ cursorX, cursorY, cursorRowKey }`, provided nested inside
`ContainerContext`. Remove those three from `ContainerFrame` (and `cursorX` +
`hoverPoint` from the frame memo's deps, so the frame stays identity-stable
across a hover). The three real
cursor consumers subscribe to it (`Layers` overlay — always; `XAxis` crosshair
pill; `useChartLegend` values-in-legend); everyone else
(`YAxis`, `BarChart`/`BoxPlot` — the latter read only the transition-gated
`hovered`, which stays in `ContainerFrame`) stops re-rendering on hover with
**zero code change**, because the frame they read no longer changes identity.
`ContainerFrame` is internal (not exported), so this is a safe refactor.
Expected: 4 commits/event → ~2 (only `Layers` + `Legend` + the state-owning
`ChartContainer`, all of which genuinely track the cursor). Verify with the
render-counter harness in the external bench notes. Follow-ups left open:
`XAxis`/`Legend` still re-render on hover even in non-crosshair / no-values
configs (they subscribe unconditionally) — a selector-context or config-gated
subscription could trim those, but they're one component each, not the axis
fan-out that dominated.

### [PND-BOXPLT] — Finish BoxPlot

The G3/G4 direction from the vol-smile review
([docs/notes/vol-smile-followups-2026-07.md](../notes/vol-smile-followups-2026-07.md)):
per-x range marks (bid/ask error bars) = finish `BoxPlot`, not a new mark —
`ValueSeries` widening, point-key neighbour-spacing width, optional
`q1`/`median`/`q3` for an honest range-only mode, px `offset` prop for same-x
call/put pairing. Plus the follow-on-wave items: a line-only /
stem-without-caps `shape` variant, and reconciling the `cursorFlag` x-snap
exclusion so crosshairs grab box plots (Candlestick never opted out; this
remains BoxPlot-only).

**Selection `id` — DONE** (#508 triage item 5). `<BoxPlot id>` extends the
shipped id-gated discrete contract via `boxAt` — rect-containment (the
interval-mark analog of `barAt`), not the still-RFC continuous-layer
threshold — returning a `SelectInfo` keyed on the box's `x` (span begin);
selected/hovered boxes outline (reusing `theme.box.stroke`, no new token).
**Scoped to BoxPlot only:** the geometry is a per-mark `boxAt`, consistent
with the existing `barAt`/`stackAt`/`ohlcIndexAtTime` idiom — the _contract_
(id-gated `hitTest`→`SelectInfo` + `registerSelectable`) is what's reused, not
a shared geometry abstraction. Candlestick would add its own `ohlcAt` under
the same contract when it gains selection (deferred — not requested by the
report; the earlier "shared geometry helper" framing is superseded by the
per-mark idiom the codebase already uses). **Still open in this wave:**
`ValueSeries` widening, range-only mode polish, px `offset`, line-only shape,
and the `cursorFlag` x-snap reconciliation.

### [PND-LEGEND] — `<Legend>` wave — DONE

Shipped (#512, after the #511 label prerequisite): the sender's #508 design
sketch built as specced — per-layer resolved `SwatchSpec` registration on all
seven marks (line/area/band/scatter/box/bar/candle; a **stacked bar registers
one row per group** with its resolved fill), container-level registry +
`rowOrder`, zero-config `<Legend placement>` card over the rows block,
`legend={false | 'name'}` per-layer opt-out/rename, optional `theme.legend`
slot (token-derived fallback — no theme type break, unlike the required
`candle` slot's gate), `items` escape hatch (standalone mode included).
**Deltas held:** row identity keys `id ?? label` (A2.2), interactions id-gated
via the shipped frame contract (hover echo + select toggle; the legend's
series-scoped `SelectInfo` carries `NaN` provenance, documented), show/hide
stays consumer-side (`onRowClick` is the override hook). Decisions of note:
the swatch/helpers module is `swatch.ts` (a `legend.ts` beside `Legend.tsx`
collides on case-insensitive filesystems); a one-group stacked shape
(horizontal single, categorical) registers under the layer identity, not the
`categoryStack` `'value'` sentinel.

**Follow-up (design pass, `feat/charts-legend-headless`, [Unreleased]):** a
**headless `useChartLegend()`** — the same rows as data (`selected`/`hovered`
state) plus chart-synced `hover`/`select`, the axis `gutters`, and
`cursorTime` (the values-in-the-legend seam: `series.nearest(cursorTime)`);
`<Legend>` re-renders through the same `buildChartLegend` core. Card polish
from the first live review: plot-area-inset placement, selection reads by
**contrast** (selected bold, others dulled — not a decorated selected row),
canonical three-dash line swatch, centred rounded bar swatch. **Row-scoping:
scope follows placement** — a `<Legend>` / `useChartLegend()` inside a
`<Layers>` scopes to that `<ChartRow>` (rowKey filter via `RowContext`) and
anchors to that row's plot (the plot cell is already `position: relative`);
container-level stays all-rows. New docs page
`website/docs/charts/interaction/legend.mdx` (card + headless live examples;
one-row-per-group + row-scoping in prose). New exports `useChartLegend` /
`ChartLegend` / `LegendRow` / `LegendItem` (rows group items by chart row).

### [PND-ANROLE] — Per-annotation colour via theme role map — DONE

Shipped (#508 item 3). `theme.annotation.roles?: { [role]: { color;
fillOpacity? } }` + a `role?: string` prop on `<Baseline>`/`<Marker>`/
`<Region>`, resolved in `useAnnotationFrame(name, role)` as `roles[role] ??
annotation` — the role overrides colour (+ optional fill) only; the depth ramp
stays shared, so selection/hover/edit levels read identically per role. Inline
per-mark colour stays **rejected** (same discipline as the per-box red/green
reject — colour = theme role, not call-site). `cssVarTheme` carries the map
through unchanged (deep-merge, like `theme.legend`); the slot is optional so
existing themes are untouched. **Scope note:** cross-row annotation _guides_
(drawn in `Layers` from the base `annotation.color`) stay the base hue — a
role recolours the mark, not its faint cross-row reference line; revisit only
if a consumer needs role-tinted guides.

### [PND-YTICKS] — `YAxis` tick density — DONE

Shipped (#508 item 4). `<YAxis tickCount>` pins an explicit auto-tick target;
omitted, the count is **height-derived** (`resolveYTickCount(height)` ≈ 1
tick / 48px, floored at 2) so a short strip isn't crushed with a tall row's
density — the y mirror of the 0.44.1 width-derived x axis. Explicit `ticks`
still overrides both. **Key design point:** the count is resolved once per
axis in `ChartRow` (`row.tickCounts`) and read by the `<YAxis>` labels, the
readout formatter (`formats`), and the `Layers` gridlines — a single source
replacing the three hardcoded `5`s (`YAxis` `TICK_COUNT`, `ChartRow`
`AXIS_TICK_COUNT`, `Layers` `GRID_TICKS`) that previously agreed only by
convention, so label / gridline / readout can no longer drift.

### [PND-CURSOR] — Cursor/readout polish backlog

Deferred-until-a-design-call items, none blocking: scatter `inline`
**2D-nearest** readout (needs the pointer's y — a cursor-model change);
scatter flag staff from the dot's top for large encoded marks; the "‹ VAL"
callout; chip-vs-chip de-overlap (inline, and box+line in one row);
the **y-oriented region cursor** for horizontal histograms
([docs/notes/y-oriented-region-cursor-2026-07.md](../notes/y-oriented-region-cursor-2026-07.md),
parked until a real consumer needs it); the **`pointercancel` clear-only
fix** — the region cursor currently commits the span on `pointercancel`
(pre-existing; should clear instead — Layer-2 follow-up from #509). Timezone
control for the cursor readout is tracked with the trading-time work
([PND-TCAL] in [PND_FINANCIAL_PLAN.md](PND_FINANCIAL_PLAN.md)).

**Done from this backlog:** tracker-label-by-`as` (F-charts-8 §3) shipped in
#511 — BandChart edges and Candlestick `showOHLC` pills adopted BoxPlot's
`"<as> <role>"` qLabel convention (`iv lower`, `SPY high`), so readout/legend
merge keys are the series identity; no-`as` labels unchanged. This was the
[PND-LEGEND] label-source prerequisite.

### [PND-AXES] — Axis backlog + value-axis naming follow-up

Pull each in as a chart needs it, not before: time-label `align` place-prop
(`center`/`left`/`right`); wall-clock vs relative (elapsed) time axis; custom
labels at custom ticks (estela's intervals/splits); `<YAxis>` label position +
rotation; d3 scale variety (log / pow / sqrt). The deferred **value-axis
naming follow-up** rides here: `timeFormat` (needs an `<XAxis format>` →
cursor-readout coupling), `onTimeRangeChange`, the internal
`ContainerFrame.timeRange` field — one naming+neutrality pass
([docs/rfcs/value-axis.md](../rfcs/value-axis.md)).

### [PND-VALAX] — Value axis: remaining chart types + algebra growth

Box/Candlestick are still time-only on the x axis; widen them to
`ValueSeries` when a consumer pulls (BoxPlot's widening is part of
[PND-BOXPLT]). The `ValueSeries` **algebra grows late**, gated on a second
value-axis consumer (geo), not estela-alone — the type is the real
consolidation ([docs/rfcs/value-axis.md](../rfcs/value-axis.md)).

### [PND-THEME] — `cssVarTheme` candle mapping

LOW; from Tidal's F-charts-4. Deliverable: a candle branch in the
`CssVarTheme` story (rising/falling/neutral body+wick) + a documented
`--*-candle-*` var-name convention so the market palette is one declarative
overlay like the other slots — not new per-slot plumbing (the overlay is
already generic). Earns its keep when the next consumer adopts candles.

### [PND-WIDTH] — Responsive sizing / fill

Container currently needs an explicit px width (`F-charts-width`; estela is
the second consumer to hit it). The `useMeasuredWidth` `ResizeObserver`
pattern is documented as a recipe (#445); the library-side question is
whether `ChartContainer` should own a fill/auto-width mode.

### [PND-DECOBS] — Draw-time + decimation observability — DONE

**Shipped ([#523], CHANGELOG `[Unreleased]`):** `<ChartContainer onDrawStats>`
fires a `DrawStatsFrame` per row-canvas repaint (`rowKey` + one `LayerDrawInfo`
per layer: `{ as, index, drawMs, sourceCount, drawnCount, decimated }`). The
five decimating draw fns return `LayerDrawStats`; the `Layers` loop times each
layer only when a consumer is subscribed (`reportDrawStats` is `undefined`
otherwise ⇒ zero overhead). New exports `DrawStatsFrame` / `LayerDrawInfo`.
Same PR corrected the stale `index.ts` "chunked Path2D cache" comment that
seeded the report's reading (b). The design write-up below is kept as the
_why_.

[#523]: https://github.com/pond-ts/pond/pull/523

**Source:** dashboard-agent friction report (pond-ts-dashboard engine A/B,
2026-07-21). The dashboard A/B'd the 0.49 `decimate` prop (auto vs off) at
~360k visible points and found the two **indistinguishable** — but could not
tell from consumer land whether M4 wasn't engaging on their path or was
engaging with its win absent on a data-side-bound 1 Hz live tick. The packaged
layer is a black box; there is no seam to answer "is this layer decimated right
now, and what did the draw cost?" This is the standing gap from the 0.48
engine-A/B port (their `chartDraw` HUD channel meters their own canvas engine,
not ours).

**Investigation (already done, 2026-07-21).** Traced against the shipped draw
path, both of the report's candidate mechanisms are ruled out: (a) there is
**no identity- or object-keyed cache** — `decimateM4`/`decimateBand` recompute
every draw, so a fresh per-snapshot `TimeSeries` cannot defeat decimation; (b)
there is **no Path2D cache at all** — the `index.ts` header comment claiming a
"chunked Path2D cache" is stale (Path2D was deferred; [PND-DECIM] floor
decision), and it likely seeded the report's reading (b). The real silent
no-op paths are: a **non-linear `curve`** on a layer (`drawLine`/`drawBand`
only decimate when `curve === curveLinear` — a "smoothed" layer on
`curveMonotoneX`/`curveBasis` draws full-res both modes), an **x-scale missing
`.invert()`/`.range()`/`.domain()`** (the #504-class silent bail), and `W = 0`.
The report's _conclusion_ ("decimation's win is per-rebuild, not per-append") is
correct and now documented in the [large-series how-to] — on a tick where draw
is ~1 % of frame time, even fully-engaged decimation is invisible in fps.

**Shape (unify asks #1 + #2 from the report):** one per-frame, per-layer
draw-stats callback on `ChartContainer` — `onDrawStats?(frame: { layers:
{ as, sourceCount, drawnCount, decimated, drawMs }[]; totalDrawMs })` (name
TBD). `drawnCount ≈ sourceCount` ⇒ not engaging (and immediately fingers which
of the three no-op paths); the per-layer `drawMs` is the draw-cost seam they
asked for. Dev-mode `console.debug` is the cheap first cut; the callback is the
durable API. Design question: per-layer `performance.measure` marks vs a
pushed struct — the struct composes better with their HUD.

[large-series how-to]: ../../website/docs/how-to-guides/rendering-large-series.mdx

### [PND-LIVELYR] — Live-source-aware layer inputs

**Source:** same report (ask #4). Charts layers accept only a `TimeSeries`, so
a live consumer manufactures a fresh per-tick handle per entity
(`rollingSnapshot.partitionBy('host').toMap(g => g)` then `withColumn`-append)
— and their snapshot-vs-`LiveView` A/B (§7) can't extend to the pond engine at
all, because there is no live input to compare against. A `LiveView`-aware
layer input — or, cheaper, a **documented cheap-handle idiom** for live charts
(what the minimal per-tick allocation actually is, and how to avoid re-deriving
columns every frame) — closes both. Overlaps [PND-PARITY] (estela is the other
live consumer) and the live layer; sequence behind whichever pulls first. Not a
standalone build yet — needs the design call on whether layers gain a live
input or the idiom is just documented.

**Quantified (external bench 2026-07-22,
[finding 5](../notes/charts-bench-vs-scichart-suite-2026-07.md)):** the
per-frame `live.toTimeSeries()` snapshot + chart-series conversion caps the
SciChart suite's FIFO/ECG streaming category at **31.6 fps @ a 100k-event
window vs uPlot's 119** (at-cap through 10k; 3.2 fps @ 1M). This is the
data-side ceiling `perf/RESULTS.md` names — now measured against neighbours.
No new task: the levers are this task's live-aware input / cheap-handle
idiom plus the data-side items [PND-GATHER] (core), [PND-COLOUT] and
[PND-LROLL] (columnar).

### [PND-ANNRFC] — Annotations RFC write-up

The annotations system shipped (#306/#308/#309) and the staffed cursor-flag
landed (#270/#272), but the short `docs/rfcs/annotations.md` the owner asked
for ("to formalize") was never written. Confirm it is still wanted, then
write it as the durable design record (two registers, depth model, three
interaction modes, the interaction-mode W1/W2/W3 split).

## Core carry-forwards surfaced by charts

Tracked in [PND_CORE_PLAN.md](PND_CORE_PLAN.md): bundle-safe column-API
augmentation + validity-aware `toFloat64Array({ missing })` (F-1, two
consumers), `hasAnyDefined()`/`allMissing()`, the protobuf columnar wire
([PND-WIRE]), and `fromColumns({ onOutOfOrder })` clamp-on-ingest
([PND-INGEST] there).

## Open bug candidates (needs-repro)

- **Canvas async-width first mount** (#508 item 6): does NOT reproduce at the
  React/jsdom level (identical draw-op sequences on a ParentSize-style mount,
  plain + StrictMode; pin test landed in #510). Cause is below React or
  consumer-side; next step is Tidal's minimal browser repro (offered in the
  report).

## Parking lot (deferred, needs a second signal)

- `F-charts-area-gap-split` — a separate `outlineGaps` prop; cuts against the
  deliberate "area fill stays honest" design.
- `F-charts-theme-double-declare` — a vars-first `cssVarTheme` mode; mostly
  consumer-side, current shape buys the stable-ref + free dark toggle.
- Column → semantic-identifier **app-level registry** (global `column → as`
  mapping); composes above the per-chart `as` prop; estela adoption decides.
- Band gap treatment (a filled envelope's break wants its own design; bands
  always break honestly for now).
- M4.3 brush — skipped, no drivers.
- **Multi-series layer API** (one layer, K columns) — **ergonomics only, not
  perf**: the 2026-07 suite profile measured React reconcile over 1000 layer
  elements at ~1% of frame time
  ([finding 6](../notes/charts-bench-vs-scichart-suite-2026-07.md)); the N×M
  collapse is the per-point draw constant ([PND-AFFINE]). Recorded here so it
  is never built _as_ a perf fix; adopt only if a consumer asks for the
  ergonomics on their own weight.
