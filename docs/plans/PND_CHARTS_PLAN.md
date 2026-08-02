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
from the 2026-07 external bench. The draw-path levers have **shipped**
(**[PND-AFFINE]** affine draw fast path, **[PND-GRADX]** gradient-extent cache,
**[PND-DECKEY]** y-only decimation cache, **[PND-MARKDEC]** dense-mark
decimation — bar columns + scatter) and **[PND-HOVCTX]** the hover-context
split has shipped too (notes:
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

### [PND-READOUT] — `readout` column: tracked value ≠ plotted value — DONE

**Shipped ([Unreleased]).** `<LineChart readout>` / `<AreaChart readout>` name a
second column whose value rides each tracker sample as
`TrackerSample.readout`, while the layer keeps plotting `column`. Plotting a
derived series but reading the source number is the common case behind it (a
log / normalized / unit-transformed / smoothed line); estela's DATA chart plots
pace-space Gaussian-smoothed and wants the native m/s in the scrub readout.

**Decision — `value` does not move.** The plotted number stays `value`, so the
in-chart cursor **dot** keeps sitting on the line; a `readout` that displaced it
would put the dot off the curve. In-chart **flag / inline chips** likewise keep
rendering `value`. That is a real asymmetry — with `readout` set, the in-chart
chip and an off-chart readout show two different numbers for the same cursor —
accepted deliberately: the chips annotate the drawn line, the off-chart readout
answers "what is the underlying measurement". If the divergence proves
confusing in use, the fix is a chip that prefers `readout`, not a change to
`value`.

**Decision — a bad `readout` name throws on both axis kinds.** As first written,
a typo threw on a `ValueSeries` (the value path buffers the column via
`fromValueSeries`) but silently produced no readout on a `TimeSeries` (the time
path reads per-event, and `get()` just returns `undefined`) — the same mistake
failing loudly one way and invisibly the other, on the more common path.
`assertNumericColumn` (factored out of `readNumericColumn`, so the errors are
literally the same ones) now validates the time path in the same memo. Pinned by
tests on both kinds, for both charts.

**Not done here — the follow-on the consumer wiring surfaced.** `readout` fully
replaces estela's hand-rolled scrub on the **distance axis** (a value-axis
sample's own `x` _is_ the distance). The residual is the **time-axis map-dot
distance** — the cursor's _paired_ coordinate — which `readout` alone can't
give. The natural shape is a tracker sample carrying its **source index**
(`TrackerSample.index` + a `TimeSeries.nearestIndex`, since `ValueSeries`
already has one), so a consumer can read _any_ paired column at the cursor
rather than naming one in advance. Deliberately a separate change: it widens
core (`TimeSeries`), where `readout` is charts-local. Promote to a PLAN.md task
when estela pulls on it.

### [PND-BARMARK] — Stable per-bar identity for single-series bars — DONE

**Shipped ([Unreleased]).** The categorical stack's `(id, mark)` selection
identity, mirrored onto the single-series bar path. Three edits: `BarSeries`
gained an optional `marks` (`src/data.ts`), which the readers
(`barsFromTimeSeries` / `barsFromValueSeries`) fill with **the sample's own
axis key** stringified; `drawBars` matches on it (`src/bars.ts`); and
`<BarChart>`'s single-series `hitTest` echoes it (`src/BarChart.tsx`), as the
stacked `hitTest` already did.

**The gap it closes.** `drawBars` matched `selection.key === cs.begin[i]`. On a
**point-keyed** series `begin[i]` is not the sample's key at all — the span is
synthesized by `neighbourSpans`, so it's `key - prevGap/2`, a derived edge. A
consumer holding the sample (estela's split centres) had to re-derive the
neighbour spacing just to name the bar it wanted selected. The mark is the
centre it already owns.

**Decision — mark-first falls back on the _selection_, not the _series_.**
`drawStacks` switches to mark-matching whenever the _series_ carries marks. Bar
series now always carry them, so copying that rule verbatim would have silently
stopped matching every shipped controlled `selected={{ id, key }}` (the
`ControlledSelection` story, and estela's own bar). So `barMatches` uses the
mark only when the **selection** carries one. The two rules coincide wherever
both marks exist; they differ exactly on the legacy path, which is the point.
Considered and rejected: matching `mark || key` (two different bars could
match, lighting both); switching unconditionally and calling it a breaking
change (no benefit — the fallback costs one branch).

**Decision — `label` is not the mark.** The stacked `hitTest` reports
`stableMark ?? name` because a category stack's group name is the placeholder
`'value'`. A single series' `label` (`as ?? column ?? id`) is meaningful and
its mark is a stringified number, so the single path keeps the series label and
adds `mark` alongside.

**Decision — lazy marks, and what that actually buys (corrected after L2).**
One `string` per bar is ~an order of magnitude dearer per element than a
typed-array write, so eager marks would have taxed every chart on every data
update for a channel most never touch. The readers expose `marks` through a
memoized getter and `drawBars` reads it only when the live selection / hover
carries a `mark`.

The **first cut of this claimed too much**, and the Layer-2 review
([PR #568](https://github.com/pond-ts/pond/pull/568)) caught it: `Layers`
hit-tests on every _pointer move_, and `<BarChart>`'s `hitTest` echoes
`bs.marks?.[bi]` — so an **interactive** layer materializes the array on the
first move that lands on a bar, on the input path, re-armed per data identity.
The original bench measured a `drawBars`-only path the component doesn't take.
`scripts/perf-barmarks.mjs` now covers the hover path too:

| case (100k point-keyed bars)               | median    |
| ------------------------------------------ | --------- |
| `barsFromTimeSeries`, marks untouched      | 0.74 ms   |
| …forcing the marks (the deferred one-off)  | 9.27 ms   |
| `drawBars`, no selection                   | 6.51 ms   |
| `drawBars`, key-pinned selection (no mark) | 6.74 ms   |
| `drawBars`, mark-pinned (marks warm)       | 7.21 ms   |
| **first `hitTest` hit, cold series**       | 11.124 ms |
| **subsequent `hitTest` hit, marks warm**   | 1.72 ms   |

So the honest statement: **non-interactive layers never pay; interactive ones
pay ~9 ms once per data identity at 100k bars, on the first hover.** Lazy still
strictly dominates eager (which charges every chart on every update regardless),
and at realistic bar counts it is under a millisecond either way — but it is not
"free", and the docs no longer say it is.

**Considered, not taken: drop the strings entirely.** Carrying the key buffer
(`keys: Float64Array`, a zero-copy view) instead of `marks` would make `hitTest`
O(1) (`String(keys[bi])`) and let `drawBars` compare numerically against a
once-parsed `Number(selection.mark)` — zero allocation on every path, and no
getter. Rejected _for this PR_ because it stops mirroring
`StackedBarSeries.marks` (the shape the ask specified and the stack path uses)
and forecloses non-numeric identities. Worth revisiting if the 100k interactive
case ever bites — the change is local to `withKeyMarks`, `barMatches`, and the
one `hitTest` line.

No public export added, removed, or renamed (`BarSeries` gained an optional
field; `barsFromTimeSeries`'s signature is unchanged) ⇒ no API.md change.

**Not done here:** `SelectInfo.key` still reports the bar's `begin` as click
provenance rather than the sample key — changing it would be a behaviour shift
on a shipped field, and `mark` already carries the identity. Revisit under
[PND-SELECT] if the provenance value proves confusing.

**Second L2 finding, fixed:** `SelectInfo.mark`'s own JSDoc (`src/context.ts`)
still said `undefined` "for a time / value bar" — false once every single-series
bar carries one. Rewritten to enumerate both mark-carrying layers and to state
that a mark-less selection still matches on `key` everywhere.

### [PND-AFFINE] — Affine fast path for the per-point draw pipeline — DONE

**Shipped ([Unreleased]).** A `curveLinear` fast path in `drawLine`
(`src/line.ts`) and `drawArea` (`src/area.ts`): when both scales are affine,
map points with an inline `k·v + b` over the typed arrays, past the per-point
d3-scale closure + d3-shape generator the 2026-07 external bench profile
attributed **~55% of stroke-bound frame self-time** to (finding 1: accessor →
d3-scale deinterpolate/interpolate ~37% → d3-shape ~18%; React reconcile ~1%,
element count is **not** the bottleneck — see parking lot). uPlot drew the same
1M points in 40 ms with inline `m*v+b`; pond now draws a 1M line in ~19 ms.

**How the affine gate works — the load-bearing decision.** A new
`src/affine.ts` (`affineOf`) recovers the coefficients `{ k, b }` from a
scale's own domain/range endpoints, then **verifies affine by probing interior
points** (jittered fractions, sub-pixel tolerance). This accepts `scaleLinear`
(every y axis), `scaleTime`, and the **gap-free** default
`scaleTradingTime(identityProvider())` (genuinely affine over its domain), and
**rejects** a real-gap trading scale, a log/pow axis, or a `scaleBand` — those
transparently keep the exact d3 path. The verify step is what keeps it a pure
optimization: a non-affine scale is never drawn as a straight line, and the
e2e visual-regression + decimation pixel-identity specs are the backstop.
Shape: `strokeAffinePolyline` (line + area outline) and `fillAffineArea` (area
fill — one closed polygon per finite run, the flat baseline edge collapsed to
its two corners, identical filled pixels to d3-area). Same `curve ===
curveLinear` gate decimation already uses; composes with cull + M4 (the M4
polyline strokes through the fast path too). Did **not** touch the `three`-at-1M
pan floor ([PND-DECIM]) — that is the decimation walk, not stroke.

**Measured (perf-check; `scripts/perf-affine.mjs`, JS-only micro-bench vs the
real d3-scale path, i.e. the literal pre-PR behaviour):**

| workload  | before (d3) | after (affine) | speedup |
| --------- | ----------- | -------------- | ------- |
| line 100k | 3.8 ms      | 1.8 ms         | 2.1×    |
| line 1M   | 60.4 ms     | 19.0 ms        | 3.2×    |
| area 100k | 10.7 ms     | 3.7 ms         | 2.9×    |
| area 1M   | 132 ms      | 38 ms          | 3.5×    |

Within the estimated 3–6× (the browser's unminified d3-scale is heavier and
area fill rasterizes on the GPU, so the in-browser JS-fraction win runs at/above
the upper end). Non-public exports (`affineOf` / `strokeAffinePolyline` /
`fillAffineArea`), so no API.md change.

### [PND-GRADX] — `buildGradient`: stop walking the full series per frame — DONE

**Shipped ([Unreleased]).** The area fill gradient's vertical extent spans the
**full** series (culling-neutral by design — a culled/zoomed view must shade
identically), which meant an O(N) min/max walk on **every** repaint, including
each y-zoom / y-autorange frame where the data is unchanged (finding 2:
`buildGradient` ~21% of the mountain@1M frame, plus most of the d3-scale closure
cost it drove; the decimation walk everyone suspected was only ~19%). The value
extent is now memoized per column buffer (`columnFiniteExtent`, a `WeakMap` on
the `y` `Float64Array`): a y-zoom / pan reuses the buffer → O(1) hit; a live
re-materialization mints a new buffer → recompute once. `buildGradient` now maps
the two value extremes through the (always-monotonic-`scaleLinear`) y scale
instead of scanning per point.

**Chose the cached column extent, not the M4-derived one** — the deferred-but-
considered alternative: M4's per-bucket extremes are exact only over the
_visible window's_ buckets, so under x-zoom they'd change the gradient's meaning
(the "gradient anchors to the FULL series, not the culled view" contract the
existing e2e/unit tests pin). The cached full-series extent is semantics-
preserving and exact. `'none'`-bridged values stay within the finite extent, so
the plain extent is correct for every gap mode. Perf-check: the extent walk
(~0.6 ms/500k, ~1.2 ms/1M in JS) is eliminated on every cache hit; in-browser
it was a larger frame share (fill rasterizes GPU-side).

### [PND-DECKEY] — Decimation cache keyed on (series, x-domain, width) — DONE

**Shipped ([Unreleased]).** The remaining ~19% at mountain@1M re-ran an
**x-only computation under y-only invalidation** (finding 3) — every y-zoom /
live y-autorange frame re-binned the same points to the same polyline. The M4
decimation output never reads the y-scale, so `drawLine` / `drawArea` now go
through `decimateM4Cached` (`src/decimate.ts`): a `WeakMap<ChartSeries,
entry>` holding **one** entry per source series — the last `(xScale, W, k,
boundaries)` it was drawn for. A y-only frame matches → O(1) hit (reuses the
polyline, skips the cull too); a pan / x-zoom mints a fresh `xScale`
(`ChartContainer` keys the scale on the x-domain, **not** the y-domain — the
load-bearing fact this relies on) → miss + overwrite, so it's **bounded, wins
on y-only frames, no-op under pan** (the Path2D-doesn't-help-pan reasoning
from [PND-DECIM]).

**Key audit (as the plan asked):** keyed on the **`xScale` object identity**,
not just `[domain, W]` — same object ⇒ identical pixel-column edges, which
keeps a hit correct on a **non-affine trading-time** scale too (its edges
depend on the provider structure, not only domain/W). **DPR** is folded into
`W = deviceBucketCount(ctx)` (device columns = CSS width × DPR), so a DPR /
resize re-keys. **Gap mode** is _not_ a key — `decimateM4` always does the
§2.2 gap-edge union regardless of mode (the mode is applied downstream in the
draw), so the decimated output is mode-independent. **Column** is captured by
the source-series identity (the layer memoizes `cs` per series+column).
Correctness rests on the {@link ChartSeries} immutability contract — a data
change mints a new source object (new key ⇒ miss), so a stale entry can't be
read; `boundaries` is compared by identity (the `<LineChart>` instants are
`useMemo`-stable).

**Verified:** byte-identical to cull+`decimateM4` (equivalence test);
decimation pixel-identity e2e + all three perf invariants (live-append heap,
pan, hover) pass — the `WeakMap` doesn't leak under live-append (new source
per tick → old entries GC'd). **Perf** (`scripts/perf-deckey.mjs`): the
~5 ms/frame decimation walk at 1M is eliminated on every y-only frame
(0.6 ms @ 100k, 2.8 ms @ 500k). Scoped to line + area (`decimateM4`, the
measured target); band / candle / box decimation has the same y-independence
and can adopt the same helper later (mechanical follow-up, not built here).
`decimateM4Cached` is a non-public export ⇒ no API.md change.

### [PND-MARKDEC] — Decimate dense marks: bars + scatter (DONE)

**Source:** same run, finding 4. The suite's point-update and column categories
fall off exactly where line/area/candle don't (point y-update: pond 18.1 fps @
100k vs uPlot 37.4; column dead by 5M) — Scatter and Bar were the two marks with
no decimation path. **Both now ship** — bars first (#531), scatter second
([Unreleased]).

**Bars — DONE ([Unreleased]).** `<BarChart decimate>` (default `true`): once the
visible **single-series** bars exceed ~2 per device pixel (each slot < ~1px),
`drawBars` replaces them with one **envelope rect per pixel column** — the exact
painted union `[min(value, baseline), max(value, baseline)]` (`decimateBars`,
`src/decimate.ts`, the interval-mark analog of `decimateBand`, widened to the
baseline every bar reaches). Gated on the **visible** count (a bar's width is its
slot — the candle/box trap). The decimated pass draws the flat `fill` only —
aggregate columns aren't individually selectable, so per-bar selection/hover
highlight is suppressed when decimated (a <1px ring isn't visible anyway);
interaction still reads the **source** bars via `barAt` (§2.3). `drawBars` now
returns `LayerDrawStats` (`onDrawStats`). **No-op for stacked / multi-group**
histograms (low-count categorical). **Verified:** `decimateBars` envelope math +
gating unit tests; `drawBars` decimated-path tests (W rects, stats,
highlight-suppressed); visual — the `Decimation/Bars` vs `BarsOff` stories render
**identically** at 100k. **Perf** (`scripts/perf-markdec.mjs`, JS-only): 5M bars
485 → 26 ms (18.9×), 100k 9.7 → 0.9 ms (10.7×); the rasterization win (N filled
rects → ~W) is browser-side on top. `decimateBars` / `BarColumnEnvelope` are
non-public ⇒ no API.md change.

**Deferred design note:** the envelope ignores per-bar `gapPx` and tiles the
column (a few-px gap is invisible at <1px bars); a column with horizontal gaps
between sparse bars would over-fill — accepted (the decimation-at-density
tradeoff). Bars binned by `begin` key (begin/end share a column at density).

**Scatter — DONE ([Unreleased]).** `<ScatterChart decimate>` (default `true`)
ships the radius-aware 2D-occupancy grid the design note below called for.
`decimateScatter` (`src/decimate.ts`) bins the visible marks into
mark-**radius** cells and keeps one representative per occupied `(col, row)` — a
sorted-x sweep with a per-column row `Set` (bounded memory, O(visible)); the
per-point pixel mapping uses the affine fast path so the sweep doesn't
re-introduce the per-point d3-scale cost. Gated on three conditions so it only
engages where it's **lossless**: the encoding is **uniform**
(`ResolvedEncoding.uniform` — fixed radius + colour, no `{column,range}`), the
fill is **opaque** (`isOpaqueColor` — a translucent / density-encoded scatter,
where overlap _should_ build up, keeps the full draw), and the visible marks
exceed the density threshold. Interaction reads the **source** (`hitTestScatter`
unchanged); the selection ring + labels are suppressed on the decimated path
(illegible at that density), like bars. `drawScatter` now returns
`LayerDrawStats` (`onDrawStats`). **Verified:** `decimateScatter` occupancy /
gap / window + `isOpaqueColor` unit tests; `drawScatter` gate tests (decimates
uniform + opaque + dense; full draw for data-driven / translucent /
`decimate={false}` / sparse); `Decimation/Scatter` vs `ScatterOff` stories.
**Perf:** `scripts/perf-scatterdec.mjs` is JS-only, so it shows the affine sweep
≈ the full draw (the win is browser-side rasterization — 1M marks → ~47k). The
**real-browser proof** (SciChart-suite point y-update): **100k 18 → 73 fps
(4×)**, and the ladder now runs to **10M** (was dead by 1M) — ahead of uPlot
(37 @ 100k), behind only the WebGL engine. `decimateScatter` / `isOpaqueColor`
are non-public ⇒ no API.md change.

**Why 2D occupancy, not the earlier "M4-for-marks" sketch** (kept — the
load-bearing design call): "per-x-column argmin-y / argmax-y representatives" is
**1D** — right only for a noisy-signal-over-sorted-x scatter, where the column
min/max is the fuzzy-band envelope (same as line M4). For a genuine **2D cloud**
(many marks at one x — a value-axis strike/IV scatter, returns-vs-returns) it
collapses the vertical distribution to two dots and looks nothing like the data.
The occupancy grid handles both. The costs the deferral flagged are **handled by
the gate**, not solved: **encoding loss** (which colour/radius wins a cell) →
decimation is off whenever radius/colour is data-driven; **selection / labels** →
suppressed on the decimated path; and the measured category's real ceiling — the
per-frame `fromColumns` **rebuild** (data-side, [PND-LIVELYR]) — still bounds it,
so the 73 fps is the draw win layered on top of that ceiling, not a full fix.

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
unrelated boolean config flag — the cursor _time value_ is derived locally by
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

### [PND-LISTS] — BarList + BoxList ranked row lists — DONE

Shipped in [#585](https://github.com/pond-ts/pond/pull/585): the
react-timeseries-charts `HorizontalBarChart` shape as two standalone DOM
sisters — `<BarList>` (proportional value bars) and `<BoxList>` (five-number
distribution + current-value tick with printed label), one shared value
scale, label + data cells, `sortBy`/custom sort (missing last both
directions), per-row expander, consumer-owned selection, and a thin
`axis.grid` baseline rule at the scale origin (BoxList default-on, BarList
opt-in — box lines float at `lower`, so the origin is what relates rows).
Readers `listRowsFromTimeSeries` / `listRowsFromValueSeries`;
`theme.box.secondary` added to both built-in themes.

**The load-bearing decision: a table, not a plot.** The owner initially
steered toward extending the canvas path (`BoxPlot orientation='horizontal'`

- cells-as-axes + expander-as-recipe), then opened it to guidance; the
  recommendation that stuck is that the pattern's defining features — link
  labels, aligned data cells, an expander inserting arbitrary-height content,
  custom sort — are table semantics a band-scaled canvas plot can't carry
  (canvas ticks can't be links; an expander would warp the band scale). The
  lists render a real `<table>`; `<BarChart orientation="horizontal">` remains
  the in-plot histogram, and the docs page states the split.

**Considered and deliberately not built:** canvas
`BoxPlot orientation='horizontal'` (no in-plot consumer; [PND-BOXPLT]'s
backlog doesn't ask for it — revisit only if one appears); diverging
(negative) bar lists (bars are length-encoded from the domain minimum,
documented as non-negative; a diverging mode is its own axis story);
controlled expansion state (uncontrolled + `defaultExpanded` +
`onExpandToggle` until friction says otherwise); a theme token for the bar
track (fill at fixed 0.15 opacity, works on both grounds). Known sharp edge:
the box tick's inline label is an absolute overlay and can overpaint the
after-cells near the domain's right edge.

Review record: adversarial review + response on #585 (both comments). Its
one process find worth remembering: a corrupted write left two raw NUL bytes
in a key literal, making the .tsx binary to git — `file`/`git diff --numstat`
is the fast check when a text diff mysteriously shows "Binary files differ".

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
(`center`/`left`/`right`); custom labels at custom ticks (estela's
intervals/splits); `<YAxis>` label position + rotation; d3 scale variety
(log / pow / sqrt). The deferred **value-axis naming follow-up** rides here:
`timeFormat` (needs an `<XAxis format>` → cursor-readout coupling),
`onTimeRangeChange`, the internal `ContainerFrame.timeRange` field — one
naming+neutrality pass ([docs/rfcs/value-axis.md](../rfcs/value-axis.md)).

**Done from this backlog: the relative (elapsed) time axis** — shipped as
`<ChartContainer origin>` (`'data'` | an explicit axis value), CHANGELOG
`[Unreleased]`. Decisions worth keeping:

- **Container-level, not `<XAxis>`-level.** The container owns the shared x
  geometry, and the ticks it resolves are both what the axis labels _and_
  where `Layers` draws gridlines. An axis-level prop would have put labels at
  `00:05` over a gridline at `10:35`, or forced an axis→container tick
  feedback loop. The dual-strip case (wall clock + duration) that motivates an
  axis-level prop is served instead by declaring two `<XAxis>` strips and
  letting a d3 _time_ specifier read the absolute instant — one shared tick
  set, two languages, which is strictly better than two tick sets.
- **A wrapper scale, not new frame fields** (`scaleElapsed` in
  [`elapsed.ts`](../../packages/charts/src/elapsed.ts)). It delegates the
  pixel mapping and overrides `ticks`/`tickFormat` only, and deliberately
  exposes **no** `tickBoundaries` / `bands` / `gridLevels` — which is exactly
  how `<XAxis>` knows to skip the calendar date styles and how `Layers` knows
  to fall to its labelled-ticks grid path. Zero call-site changes in either.
- **Origin-anchored ticks are the feature**, not the formatter. `transform`
  could already relabel `t - t0`, but its 1-2-5 ladder offers a 200-second
  tick and its ticks stay where the calendar put them. The duration ladder
  (…15s/30s/1m/2m/5m…/12h, then 1-2-5 whole days) plus the `origin + k·step`
  walk is what makes `00:05` mean five minutes in.
- **Labelling, not transforming.** `range`, `<Marker at>`, `onRegionSelect`,
  `trackerPosition` stay absolute — no second coordinate system.
- **Deferred, considered:** an `origin: 'view'` mode (re-zero at the left edge
  as you pan) — nobody asked, and the union type leaves room. **Elapsed
  _trading_ time** on a calendar axis (`provider.distance`/`offset` would give
  evenly-spaced trading-time ticks) — parked because under
  `spacing: 'uniform'` those primitives are in session-units, not ms, so a
  duration formatter would be lying; wall-clock durations ship with the
  uneven-across-a-seam caveat documented.

**What the review caught (v0.53.1, [#540] / [#541]).** The axis shipped
without its Layer 2 pass; run afterwards, it found two real bugs, and the
review of the _fix_ found two more. Worth recording because both pairs share
a shape:

- **Precedence inversions come in ladders.** The elapsed axis's finer default
  readout was delivered through `formatReadout`, the field an explicit
  `cursorFormat` uses — so it outranked an `<XAxis format>`. Fixing only that
  rung left the identical bug for a container `timeFormat` one rung down. When
  a fix restores one rung of a documented precedence chain, walk the whole
  chain.
- **A dedupe has to say which duplicate wins.** Dropping ticks that collide on
  a collapsed-session pixel was right; keeping the _first_ was not — the
  survivor should be the session open that sits on that pixel, not the instant
  inside the closed night. "Drop duplicates" is under-specified whenever the
  duplicates aren't interchangeable.

**Follow-up (not done):** `formatReadout` is now two channels in one field
(`cursorFormat` vs the axis kind's default), disambiguated by a companion
`xReadoutCustom` flag mirroring `xFormatCustom`. The reviewer's point stands
that the honest fix is to split the channels — let consumers read the scale's
own `readoutFormat` (already present on both `ElapsedScale` and
`TradingTimeScale`) and return `formatReadout` to meaning `cursorFormat`
alone. Deferred out of a patch release because it touches all four
`formatReadout` consumers (`XAxis`, `Layers`' in-plot chip, and two in
`annotations`); pull it in with the next axis-surface change.

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

### [PND-YFIT] — `YAxis` cannot fit the visible window

Surfaced by a consumer (the process demo) trying to read a Bollinger band
and concluding, correctly, that there wasn't one.

`YAxis` auto-fit walks the **whole** series: `yExtent`
([line.ts](../../packages/charts/src/line.ts)) captures `cs` directly, and
[culling.ts](../../packages/charts/src/culling.ts) states the invariant
outright — _"`sampleAt` / `hitTest` / `yExtent` read the full source series
… nothing user-facing depends on the visible slice."_ That is right for a
readout: a hover value must not shift when the window resizes.

It is wrong for reading structure inside a series. Measured on 150,000
5-minute bars: a 20-period 2σ band spans **1.26 USD inside a 58.2 USD
extent — 2.8 pixels** on a 130px plot, thinner than the line's own
vertical smear at that point density. The band renders correctly (a
5000-period 5σ one fills 40.4% of the plot) and is simply invisible, and
time-zoom cannot recover it while y stays pinned to the full range. Two
observers in a row concluded the `BandChart` was broken.

**The workaround, and why it is a signal.** The consumer now bisects the
key column per figure per frame and passes explicit `min`/`max`
([Viz.tsx](../../apps/process-demo/web/Viz.tsx) → `useVisibleExtent`).
Zooming 150,000 rows to ~6,000 tightens the domain from 58 USD to
166.68–181.45 and the ribbon appears. That is ~40 lines every consumer
wanting a legible zoom would have to write, including the bisect — the
naive full scan re-run per figure per pan frame is the difference between
a smooth drag and a stuttering one.

**Open questions.**

- **Opt-in shape.** `<YAxis fit="visible">` alongside the current default
  reads right and keeps the readout invariant intact. `fit="data"` stays
  the default; nothing existing changes.
- **Who computes it.** The container already resolves the x domain and
  owns the visible range, and layers already publish `yExtent()` — so a
  _windowed_ extent is a layer capability (`yExtentIn(range)`) that the
  container unions, mirroring the existing auto-fit path rather than
  adding one. Culling already computes visible slice bounds per layer on
  the draw path; that index arithmetic is the same arithmetic.
- **Does the readout invariant actually break?** Only if a readout reads
  the _axis_ domain rather than the source. Worth confirming, because if
  it does not, the invariant as written is stronger than it needs to be.
- **Pan stability.** A domain recomputed per frame makes the y-axis move
  under a horizontal drag, which is disorienting on a shared-view stack.
  A hysteresis or nice-number quantisation is probably part of shipping
  this, not a follow-up.

**Done when:** a consumer can ask for a visible-window domain without
hand-computing one, and a 20-period band on 150k points becomes legible
by zooming rather than by 40 lines of caller code.

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
