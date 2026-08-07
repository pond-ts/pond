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

### [PND-ANNROLE] — Annotation **roles**: a resting mark's alpha is a role question

`theme.annotation.depth` is `[1, 0.7, 0.4]`, so a **resting** annotation draws
at 0.4 alpha. That is a level, and the evidence says the thing it is trying to
express is a **role**.

**Two consumers overrode it in opposite directions in the same week**, each
locally, neither reporting it until asked:

| consumer                       | what annotations are for them                             | override                                    |
| ------------------------------ | --------------------------------------------------------- | ------------------------------------------- |
| measles gallery card (pond-ts) | the three vaccine dates **are** the argument              | crimson `#d81e5b`, `depth: [1, 0.95, 0.85]` |
| estela                         | a **focus wash** behind data when a lap/split is selected | `fillOpacity: 0.07`, foam                   |

That is the whole case. No single resting alpha serves both, because they are
not the same _kind_ of mark: one is an argument the reader must not miss, the
other is a wash that must not compete with the data on top of it. A level can
only be wrong for one of them.

`<Marker role>` / `<Zone role>` already exist and read
`theme.annotation.roles[role]` (`color`, optionally `fillOpacity`) — but the
**site theme defines no roles**, so `role` currently has nothing to select and
both consumers fell back to patching `theme.annotation` wholesale.

**The work:** define an annotation role vocabulary in the shipped themes with
its own depth ramp per role — at minimum a _wash_ (quiet, sits behind data) and
an _argument_ (loud, resting stays legible) — and extend `roles[role]` to carry
`depth` rather than only `color` / `fillOpacity`. Estela says it would adopt
immediately and drop its local override; the measles card would drop its
per-chart theme spread.

Two things to get right rather than assume:

- **Naming by intent, not by loudness.** `wash` / `argument` survives a theme
  change; `subtle` / `strong` becomes a lie the moment a theme rebalances.
- **The default has to stay put.** `[1, 0.7, 0.4]` is right for the common case
  (annotations secondary to a line), so an unrolled mark must not move.

Related friction from the same exchange, **not yet tracked**: estela reserves
x-axis height by hand (`ChartRow height={h - X_AXIS_H}` plus a matching
`<XAxis height>`), got the arithmetic wrong once, and shipped labels overlapping
its own controls. Their framing is the right one — the axis should participate
in row layout rather than the consumer subtracting for it, which makes that
whole class of mismeasurement unrepresentable. Estela is filing it.

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

### [PND-HEATMAP] — Heat-map draw layer — PROTOTYPE ON A BRANCH

The write-up PLAN.md points at. **Not merged**: `feat/heatmap-prototype` carries
a working grid layer (`src/heat.ts`, `src/HeatMap.tsx`, 25 tests, six stories
under `Charts/HeatMap`).

**The whole thing needs no new data type.** `StackedBarSeries` is already a heat
map's data — `[begin, end]` spans per bin, a named second dimension in `groups`,
a row-major `length × G` value block, plus `marks` for stable identity. And
`stacksFromColumns(series, columns)` already accepts `TimeSeries | ValueSeries`,
branching to `seriesSlots()` or `neighbourSpans(axisValues())`. So one existing
reader produces every shape pond can express:

| source        | columns | x axis          |              |
| ------------- | ------- | --------------- | ------------ |
| `TimeSeries`  | one     | time intervals  | a stripe     |
| `TimeSeries`  | many    | time intervals  | a grid       |
| `ValueSeries` | one     | value intervals | a bin stripe |
| `ValueSeries` | many    | value intervals | a grid       |

**The stripe is `G === 1`** — one draw path, not two. An earlier cut of this
prototype had a separate `BarSeries` route for the single-row case; it
collapsed away entirely.

**The axis mechanism also already existed.** `RowLayer.binCategories()` — added
for horizontal histograms — reports row names while the y axis stays a linear
scale over unit slots `[i, i+1]`, and `<YAxis>` labels each at `i + 0.5`. So the
layer reports `yExtent: [0, G]` + `binCategories: () => groups` and gets a
labelled row axis with no band scale, no `CategoryAxis` variant, no new axis
work. The PLAN framing — "category axis **or** derived calendar coordinate" —
was a false choice: the axis is the same either way, and the real question was
only ever where the rows come from.

**Decision — the y dimension is columns, and only columns.** A month-of-year
grid means a column per month; a per-city grid means a column per city
(`pivotByGroup` long→wide, or `partitionBy` reshaped). This is a real
constraint and a deliberate one: it keeps the second dimension in the data
model, where pond's own reshaping operators produce it, rather than inventing a
chart-level pivot. The payoff is that **x keeps the whole of pond's binning
machinery for free** — `aggregate` over a trading calendar with sessions,
`Sequence.calendar` buckets, `byColumn` value bands — because the layer has no
opinion about x beyond "these are bin spans".

**Decision — one colour domain across the whole grid.** `heatValueExtent` spans
every cell, not each row, because rows are only comparable if one scale covers
them all. `domain` pins it for cross-chart comparison or a moving window, where
an auto-fit silently re-means every cell and a colour scale has no tick labels
to reveal that it moved.

**Decision — banded, not interpolated.** Values map to `colors.length` equal
bands. Matches the climate-stripes card (whose `anomalyStep` this replaces), is
the conventional reading for stripes and calendar grids, and is honest about
resolution; at nine-plus stops it is indistinguishable from a gradient.

**Decision — a live cell keeps its own colour.** Bars swap to `highlight`; a
cell must not, because its colour _is_ the datum. Full opacity plus an outline
on selection. Cell identity is two-dimensional — bin **and** row — reusing
`StackMark` so bars and cells share one selection vocabulary.

**Deferred — no `theme.heat` slot.** Geometry is borrowed from
`theme.bar[as] ?? theme.bar.default`. `ChartTheme`'s slots are required, so
adding one is breaking for every custom theme; the M5 optional-with-default
gate ([PND-PARITY]) lands first.

**Overlaps [PND-SPARCFRIC] (PR #599), which lands first.** That PR was blocked
on the CI outage and carries two things this prototype touches:

- **`<YAxis hide>`** ([PND-AXISHIDE]) — the right way to drop the axis for a
  single unnamed row. The stripes card currently does it the old way
  (`width={0}` + empty `ticks`); switch when #599 merges. Its sibling friction,
  `<YAxis>` titling itself `label ?? id`, is likewise already tracked there, so
  it is not re-raised here.
- **Threshold-banded bars** — `<BarChart thresholds={[t0, t1]}>` colours a bar
  by the band its value lands in, with fills from a new **`BarStyle.bands`**
  theme slot, overridable per chart via **`bandColors`**.

**That second one is a genuine vocabulary collision and needs reconciling
before either ships as public API.** Two agents arrived at colour banding
independently with different answers:

|                  | #599 (bars)                                              | this prototype (heat map)                         |
| ---------------- | -------------------------------------------------------- | ------------------------------------------------- |
| bands from       | explicit `thresholds` breakpoints                        | domain split into `colors.length` equal bands     |
| colours from     | the **theme** (`BarStyle.bands`), `bandColors` overrides | a **required `colors` prop**                      |
| stated principle | "breakpoints are data, colour stays in the theme"        | colour _is_ the data, so it cannot be theme-owned |

Neither is obviously wrong — a bar's banding is a _classification_ (good /
warn / crit belongs to the theme's semantics), whereas a heat map's ramp _is_
the quantitative channel and has no meaning without the data. But shipping
`bandColors` and `colors` as neighbouring props, and `BarStyle.bands` beside a
prop-only ramp, would be two ways to say one thing. Worth deciding deliberately:
either the heat map adopts `thresholds` for the explicit-breakpoint case (AQI
categories, Beaufort, HR zones all want it) and keeps `colors` for the
continuous case, or banding becomes one shared primitive both layers call.

**Asked for, not built — the 2-D interaction set.** pjm's follow-ups, hardest
last:

- **2-D readout — DONE, and it needed no new API.** The answer was that
  `onHover` (and `onSelect`) already carry a `SelectInfo` resolved on **both**
  axes by `hitTest`, so a grid readout is `onHover={setHit}` and reading
  `label` (the row), `key` (the bin) and `value` off it. The tracker is the
  wrong channel and cannot be made right: `sampleAt` samples every row at the
  cursor's x and knows nothing about y, so any single number picked out of it
  is a guess at which row was meant. The Niño 3.4 grid proved this the hard
  way — a first cut reported the warmest row under the pointer, which reads as
  nonsense because the year it names is not the year you are pointing at.
  **The rule: x-scrub questions go to the tracker, "what is under the pointer"
  goes to hover/select.**
- **2-D region selection.** The region cursor snaps to `binIntervals` on x
  only; a grid wants a rectangle across bins **and** rows. The x half exists;
  the y half needs the row band to become a snap dimension.
- **2-D pan and zoom.** Pan/zoom is an x-domain operation today. A grid with
  many rows wants both axes — a container-level change well beyond this layer,
  and the first real driver for it.

**Still open:**

- **Cell value labels** (the reference "heat map with labels"): draw the
  formatted value centred when it fits. Small; the fiddly part is text colour
  staying legible against both ends of the ramp.
- **A grouped two-level x axis** (quarters nested under years). Genuinely axis
  work — it would serve bars equally — so it belongs with [PND-AXES], not here.
- **Continuous interpolation** as an alternative to banding, if a consumer wants
  it. Nothing forecloses it.
  **Shipped since the prototype write-up above:**

- **The climate-stripes card is converted** — `columns={['anomaly']}`, one row,
  same draw path. It is the `G === 1` case in production.
- **The Niño 3.4 grid answers the granularity question** — and the answer is
  that granularity is **not a chart prop**. The site's existing wide series
  (a column per year, a row per day-of-year, built for the climatology
  `collapse`) is already a heat map's shape, so day / month / year is three
  `aggregate` calls on x with the rows untouched:
  `wide` → `Sequence.calendar('month')` → a whole-year bucket. 45 rows in all
  three; only the x bin width moves. That is the layer's y-must-be-columns
  constraint paying for itself — resolution belongs to x, where pond already
  owns it.
- **Live cells are outlined, not alpha-popped.** The bar layers say "live" by
  popping `opacity` to 1, which a heat map cannot use: on a full-opacity ramp
  it is invisible, and where it isn't, dimming a cell shifts where the reader
  places it on the colour scale. So hover strokes at `outlineWidth` and
  selection at twice that, both in `style.highlight`, inset by half the stroke
  so a flush (`gap: 0`) grid cannot bleed over its neighbour. Hover and select
  still share one colour deliberately — whether they should diverge is #577,
  and this layer shouldn't pre-empt it.
- **The array props are compared by value, not identity.** `columns`, `colors`
  and `domain` are all naturally written fresh per render (a JSX literal, a
  `.map()`, a theme hook like the docs site's `useSequentialRamp()`). Keyed by
  identity each rebuilds the layer entry every render, hence `registerLayer`
  every render — which on a chart that re-renders from its own hover state is
  not a treadmill but an **infinite update loop**, and that is exactly how it
  surfaced. `<BarChart thresholds>` had already learned this ([PND-BANDBAR2]);
  the heat map now keys on NUL-joined content, pinned by
  `test/heat-identity.test.tsx`. **Worth a sweep**: any layer taking an array
  prop is exposed to the same bug.

- **Hover deduped on `id + key`, so it was stuck on the y axis.**
  `ChartContainer.setHovered` suppresses repeats so the data canvas repaints
  only when the hovered mark changes. But `key` is the mark's position on the
  **bin axis**, unique only for a layer with one mark per bin — a stacked bar or
  a heat-map column stacks several, so every move _within_ a bin was swallowed.
  On the Niño grid that presented as dragging straight down a column never
  changing the reported cell. Now compares the full identity (`id`, `key`,
  `label`, `mark`) — which is what the comment above it had claimed all along.
  **This was a `<BarChart>` bug too**, not just a heat-map one: any stacked
  column had it. `test/hover-dedupe.test.tsx`.
- **Axis carriers leak without `timeFormat`.** The Niño day-of-year axis is a
  synthetic reference year (2001), and the first tick renders `2001` unless the
  container passes `timeFormat="%b"` — announcing a year the data has no opinion
  about. The line chart above it already knew this; the heat map had to learn it
  again, which suggests the reference-year idiom deserves a recipe rather than a
  per-card comment.
- **Explicit `{ at, label }` ticks are how you name _some_ rows.** With 45 rows,
  `binCategories` labels all of them into an unreadable stack. `<YAxis ticks>`
  overrides it, so naming the years the line chart names is three ticks at
  `row + 0.5`. Also needs `label=""`, since the axis title otherwise defaults to
  the axis id — the known friction pjm flagged.

- **Measure and palette are both "hand it a different value", not layer work.**
  The Niño grid now toggles SST vs anomaly and site/heat/diverging ramps. The
  first is a different _series_ (the per-year `anomaly` columns reshaped wide —
  a reshape, not a recomputation, since the line chart already computed them);
  the second is a different `colors` array. Neither touches `<HeatMap>`, which
  is the evidence that colour-as-a-prop was the right call: a themed
  `theme.heat` slot could not have expressed "inferno for absolute temperature,
  RdBu for the anomaly" without inventing a second axis of configuration.
  It also validated `domain`: a diverging ramp is meaningless without a pinned
  symmetric domain, because the neutral band has to sit on zero and an
  auto-extent moves it silently as the binning changes.

- **Perf: the draw loop did per-cell what was per-bin and per-row.**
  `scripts/perf-heat.mjs` (six scenarios). `drawHeat` called `cellRect` per
  cell, which recomputed the x span (two scale calls, depends only on the bin),
  recomputed the row band (two more, depends only on the row), and allocated a
  4-element array — O(V·G) scale calls and allocations where O(V + G) and zero
  do. On the Niño day grid that was ~33k scale calls and ~16k short-lived arrays
  **per frame**, and hover repaints the whole grid. Hoisting both, plus setting
  `ctx.fillStyle` only when the colour changes, took the real workload from
  **2.230ms → 0.798ms (−64%)** and a 200-row grid from **9.649ms → 3.682ms
  (−62%)**. `cellRect` itself is unchanged — `heatAt` calls it once per
  hit-test, where there is nothing to amortize over.

  Two optimizations were **measured and rejected**, recorded in the script so
  nobody re-derives them: short-circuiting `matchesCell` when nothing is live
  (no win — the checks already exit on their first line), and caching
  `globalAlpha` the way `fillStyle` is cached (measures a further −31% and that
  number is an artefact — the bench's context is a `Proxy` charging a trap
  crossing per property write, where a real canvas stores a number; `fillStyle`
  survives the same scrutiny only because a real canvas genuinely parses the
  colour string).

  **The harness has a known bias worth carrying forward to the other charts
  benches**: a `Proxy` context overstates any optimization whose only effect is
  doing fewer `ctx` property writes.

- **Decimation: the mean per pixel column, on by default.** pjm's push — "the
  library shouldn't ever hit 48ms for a layer, and you can statistically say
  what 16 pixels of different levels resolves to at a distance" — and he was
  right on both counts. The write-up above had argued for a dev warning that
  pushed callers to `aggregate`, on the grounds that collapsing cells is a
  statistical claim only the caller can make. **That was wrong**, for a reason
  worth keeping: collapsing cells for _display_ is a **resampling** question,
  not a statistical one, and resampling has a correct answer. Cells do not form
  a silhouette the way bars do — they **composite** — so what a column of N
  cells delivers to the eye is their area-weighted mean. The layer is not
  imposing a statistic by taking it; it is computing what the full-resolution
  draw already resolves to.

  The argument that it was a statistic also missed that the undecimated path was
  _already_ making one, and a worse one: sub-pixel cells are widened to
  `minWidth` about their midpoints, so they overlap and later draws overpaint
  earlier ones. Every column already showed one source cell out of N, chosen by
  loop order. **48.0ms → 5.7ms** on 20000×45, with every below-gate scenario
  byte-identical.

  This is also the one place a heat map can go where `decimateBars` explicitly
  cannot: that function bails when `binFills` is set, because its reduction is a
  geometric `[min, max]` envelope with no honest colour across differently
  coloured bars. Reducing the **value** and letting the ramp colour it sidesteps
  that entirely — worth remembering if per-cell colour ever comes to another
  layer.

  What it loses is a lone extreme among N, exactly as any image downsample does.
  `aggregate` with `max` remains the tool for a reader hunting rare spikes, and
  is unaffected. Follows the bar precedent on interaction: per-cell outlines
  suppressed while decimated, hit-testing still on the source grid.

- **`orientation="horizontal"`, and the mapping mistake that found it.** A real
  10,000-gene x 8-sample matrix went through the layer badly at first because
  **I mapped genes onto the column axis**, which meant a 10,000-column series,
  a 21ms construction, 80,000 cells, and a "y-binning has no pond expression"
  friction note that was **wrong**. pjm caught it: genes are the _key_ axis —
  one record per gene — so it is 10,000 rows x 8 columns, and bucketing them is
  `byColumn('rank', { width: 20 }, avg)` → `stacksFromBins`, a path the library
  already had. Measured end to end on the real file: 500 buckets x 8 samples =
  **4,000 cells**, and no decimation fires at all.

  **The lesson generalises past this dataset.** When a heat map feels like it
  needs thousands of columns, the data is almost certainly mapped the wrong way
  round: the many-dimension belongs on the key axis where pond's binning lives,
  and the few-dimension in the columns. The layer's constraint is a signpost,
  not an obstacle.

  What that leaves is a real gap, which this shipped: the pond-native mapping
  puts the long axis on **x**, while the convention for expression data (and
  Codex's reference rendering) runs genes down **y**. `<BarChart>` already had
  `orientation`; the heat map now does too. The transpose is genuinely cheap
  here — two _position_ axes and no value axis, so `cellRect` just swaps which
  scale carries bins and which carries slots, and `heatAt` inherits it for free.
  On the layer contract, `binCategories` (y) becomes `xCategories` (x), which
  puts the container in its `'category'` kind exactly as a categorical
  `<BarChart>` does, and `sampleAt` returns nothing because the x-scrub tracker
  only means something when x is the bin axis.

**Friction found, not fixed:**

- **`Sequence.calendar` has no `'year'` unit** — it stops at `month`
  (`CalendarUnit = 'day' | 'week' | 'month'`). A whole-year bucket has to be
  faked with a fixed step (`Sequence.every('370d', { anchor })`) sized past the
  record's end, which works but is wrong in general: a calendar year is not a
  fixed number of days. Adding `'year'` (and arguably `'quarter'`) is a small
  core change with an obvious caller.

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

### [PND-CHARTAPI] / [PND-BARSEM] / [PND-HCAT] / [PND-VSADAPT] — the 2026-08 API review — DONE

All four shipped (#590 / #592 / #593 / #594) from the owner's holistic review
([docs/notes/charts-api-review-2026-08.md](../notes/charts-api-review-2026-08.md)
— verdict: excellent data seam, good composition, uneven type/behaviour seam).
Residue tracked as **[PND-APIREV-REST]** in PLAN.md.

**What shipped, and the reasoning worth keeping:**

- **[PND-VSADAPT] — adapters are internal.** The owner's rule: _"any use of an
  adaptor when starting with a timeseries is a core api failure."_ So the
  ValueSeries builders stay unexported, the docs stopped teaching adapters as
  the contract, and the list family gained a direct `series` door. Second
  correction from review: "non-pond interop" was the wrong framing at both
  ends — the `from*` builders _take_ pond series and no layer accepts their
  output. They are **view builders for custom draw code**.
- **[PND-CHARTAPI] — the type seam.** Two findings neither reasoning nor CI
  would have produced, both from measurement:
  1. `NumericColumnNameForSchema<SeriesSchema>` is **`never`**, so a naive
     constraint rejects everything for a loosely-typed series. Invisible to
     this repo's suite, whose fixtures are all `as const`.
  2. With **two** generics only one is ever inferred, so
     `NumericColumn<S> | ValueNumericColumn<VS>` silently widens to `string` —
     the constraint was **inert** for the common TimeSeries case until each
     layer's props became a union _per series kind_.

     A third came from review: the `never` guard answered "no numeric columns"
     when it had to answer "is the schema loose" — an all-string schema
     silently accepted anything. The lesson generalises: on type-level work,
     _compiling_ is not evidence of _checking_; only a negative test is.

     Cost accepted by the owner: a union-typed series value must be narrowed
     or cast. The alternative (one generic over the series type) is verified in
     `spikes/charts-type-seam/REPORT.md` if that ever bites.

- **[PND-BARSEM] — capabilities follow the drawn mark.** One-segment vertical
  bars take the single-series path whatever fed them. Review caught the
  regression that mattered: the reroute **dropped the `colors` channel** (a
  one-group stack resolved `colors[group] ?? theme.bar[group]`; the single
  path read only `as`), changing bar colours with no error. Restored, plus
  `SelectInfo.label` parity between `column="a"` and `columns={['a']}`.
  Acceptance test met — `BarStyle.hover`'s scope warning shrank from five
  path-accidents to two real exclusions.
- **[PND-HCAT] — horizontal categorical bars.** Categories on y as unit slots,
  the `<YAxis>` deriving one label per category via a new internal
  `binCategories()` channel. Self-review before the Layer-2 pass caught a
  contract violation: labels landed on slot **centres** while gridlines fell on
  slot **boundaries**. Fixed by applying the rule the codebase already stated
  for the categorical x axis — no gridlines through bar centres.

**Process note.** #594's Layer-2 agent never posted (it stalled); the PR
merged on the owner's explicit instruction with CI green and a self-review
that had found the gridline bug. A post-merge adversarial pass on the
horizontal-categorical interaction contract is part of [PND-APIREV-REST].

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

### [PND-ZONE] — `<Zone>`: the y-span annotation — DONE

Shipped. The fourth annotation mark and the value-axis counterpart of
`<Region>`: a shaded band between two **y** values across the full plot width,
for a **classification of the value axis** (US EPA AQI categories, HR/power
zones, SLO bands, control-chart spec limits). Driven by a real consumer ask —
reproducing a sensor dashboard's AQI chart from a CSV export, where the
coloured category bands were the load-bearing element and pond had no way to
draw them. Guide: `website/docs/how-to-guides/air-quality-bands.mdx`;
reference: `website/docs/charts/annotations/zone.mdx`; stories:
`Annotations/Zone` (15, one per knob).

**Naming.** `<Zone>` chosen by the owner over `ValueBand` / `Band` / `Level`.
`Band` collides with `BandChart`/`BandSeries` (a data variance envelope, not a
placed mark); `ValueBand` misreads against pond's existing "value axis" =
_x_-carrying-values sense; `Zone` reads correctly for every real use case and
feeds directly from `@pond-ts/fit`'s `PowerZone`/`ZoneTime` `start`/`end`
edges.

**Three defaults deliberately invert the family's**, and this is the whole
design content of the primitive — a y-band spans the full plot **width**, and
a zone _set_ tiles the entire row, so the family's assumptions don't transfer:

- `selectable={false}` (family: `true`) — the pointer is always inside some
  zone, so interactive-by-default bands would light on every mousemove and
  their hit rects would swallow the plot's own clicks (`DragArea` always
  `stopPropagation`s its click).
- `edges={false}` (family: `Region` is `true`) — contiguous sets share every
  interior boundary, so edges-on draws each one **twice** at double opacity.
- **No auto-label** (family: auto-labels its bounds) — a zone's bounds are
  already written down the y axis it spans, unlike a region's x span. The
  useful label is a _name_, which only the caller has, so `label?: string`
  (omit ⇒ no chip) rather than the family's `string | false`.

**Bounds.** Order-free; clamped to the plot (past-domain cut, fully-outside
culled) so a whole category table renders and the axis decides what shows;
`±Infinity` accepted for open-ended bands. Infinite bounds resolve against
`yScale.domain()` **before** scaling — d3's interpolator is `a·(1−t) + b·t`, so
an infinite `t` yields `0 · Infinity` = **NaN**, not an off-plot pixel. A
boundary line is drawn only where the band has a real, in-plot edge (an
open-ended or clamped bound draws none, or it reads as plot chrome).

**Registry.** `AnnotationSpec.kind` widened via a new `AnnotationSpecKind =
AnnotationKind | 'zone'`, leaving `AnnotationKind` (the _create-tool_
vocabulary, `ContainerFrame.creating`) untouched — widening that instead would
let `creating="zone"` type-check and then silently never fire `onCreate`, since
there is no `CreateSpec` variant and no draw gesture. Zones register with empty
`xs` (like baselines): no cross-row guide, no drag-snap target.

**Deliberately not built:** `onChange` / drag-to-edit (a zone editor is
coherent — drag your HR boundaries — but has no consumer yet; the band stays
declarative until one arrives).

**Known limitation — the fill paints _above_ the data canvas**, like every
annotation, so it works by staying light (`fillOpacity` ~0.1–0.2) rather than
by being behind the traces. Putting it genuinely behind was investigated and
**rejected as out of scope**: the plot div is a flex sibling of the axis
columns and is _not_ a stacking context, so both candidate fixes regress paint
order elsewhere — `isolation: isolate` (or `z-index: 0`) on the plot div would
scope `chip.ts`'s `zIndex: 3` axis pills, which exist precisely to escape the
plot div and sit over the sibling axis column; and giving `<Canvas>` a
`z-index` would lift the canvas over a right-hand `<YAxis>`. A real fix is a
package-wide stacking-order pass (every overlay gets an explicit layer), which
wants its own PR and its own visual-regression sweep. Second signal needed.

**Also landed here:** `theme.annotation.dash` (register-wide) and
`roles[role].dash` — px on/off, same shape as `LineStyle.dash`, applied to
marker/baseline lines and region/zone boundaries; fills never dash. Motivated
by the same guide (the source chart's dashed grey average line): a dashed
reference line reads as _placed_ rather than _measured_, which is the register's
job and one colour alone can't always carry when the register hue sits near a
series hue.

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

### [PND-LOGAX] — `<YAxis scale="log">` — DONE

Shipped. The scale kind is per-axis and **transparent to every draw layer**:
`ChartRow` builds a `scaleLog` instead of a `scaleLinear`, and the shared
`YScale` supertype (`ScaleContinuousNumeric`) is the whole of the plumbing — no
layer branches on it. `format` formats the **value**, not its logarithm, via
`resolveAxisFormat` routing a log scale's formatting through a linear scale over
the same domain (`scaleLog.tickFormat` is a _tick_ formatter and returns `''`
for anything it doesn't consider significant, which would blank the cursor
readout and every chip); tick _thinning_ is `yTickValues`, which picks whole
decades rather than d3's near-step-function `ticks(count)` (3 ticks at count 4,
**64** at count 8, from a height-derived count).

**Decisions worth recovering.** The Layer-2 review found nine issues, all real;
three of the fixes involved a judgement call:

1. **A non-finite _scaled_ coordinate is now a genuine gap**, normalized to
   `NaN` in one place (`gapUnscalable` in `gaps.ts`) rather than by overriding
   the three `.defined` predicates. Chosen because the gap _modes_ then keep
   working — `collectGapEdges` and `bridgeGaps` read the values directly, so a
   `.defined` override would have left `'dashed'` / `'none'` / `'fade'` blind to
   the gap — and because it needs no knowledge of scale kinds, so a future
   restricted-domain scale inherits it. Costs nothing on a linear axis: an
   affine scale maps finite→finite by construction, so the walk is skipped, and
   that is exactly the condition under which the callers take their affine fast
   path anyway.
2. **The dev warning names only unambiguous mistakes.** It cannot distinguish a
   line touching zero from a `BarChart` on strictly positive data — `barExtent`
   widens its low end to exactly `0` so bars can meet their baseline, so both
   report `[0, hi]`. The first version keyed off that and warned on **every**
   bar chart on a log axis, with text that was false there. **Deferred
   alternative:** add a `yDataExtent?()` to the internal `RowLayer` reporting the
   unwidened extent, which would let the warning name the zero case precisely.
   Rejected as disproportionate — five files and a new internal channel for a
   dev-only `console.warn` — and cheaper now that a zero renders as a visible
   gap (decision 1), so the picture itself is the diagnostic. Revisit if the
   ambiguity actually bites someone.
3. **A stacked bar's base is the axis floor**, via the same `resolveBarBaseline`
   rule a plain bar uses, rather than a literal `0`. Identical geometry on a
   linear axis (zero clamped into a domain that contains zero _is_ zero); on a
   log axis it is the difference between drawing the bottom segment and silently
   dropping it — `fillRect` with a `NaN` argument is a canvas no-op, and the
   same rect feeds `stackAt`, so the segment was unhittable too.

Also landed from the same review: the log domain now follows the **linear
policy exactly** (explicit bounds verbatim, the _auto_ side moves on inversion,
`.nice()` on a fully auto-fit domain) — the log path had inverted the
never-discard-the-caller's-bound rule; `needsExtents` treats a _refused_ log
bound as absent, so `min={0} max={1e6}` gathers extents instead of silently
falling back to the placeholder domain (a gap between what `resolveLogDomain`'s
unit tests passed it and what `ChartRow` actually did); and `buildGradient`
drops an extreme with no position rather than letting `NaN` reach
`createLinearGradient`, which throws `IndexSizeError` on a real canvas.

**Test-double lesson.** That last one was invisible because `test/canvas-mock.ts`
stubbed `createLinearGradient` unconditionally — the double was _more permissive
than the platform_, so a defect that crashes every browser rendered as a green
suite. The mock now enforces the platform's own argument validation for the
gradient entry points. A double may be less capable than the real thing; it must
not be more forgiving, or the tests stop being evidence.

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
- **Annotation overlay stacking order** — every mark (now including `<Zone>`'s
  fill) paints _above_ the data canvas. A background band wants to be behind
  it; both local fixes regress paint order against the sibling axis columns
  (see [PND-ZONE]'s limitation note), so this is a package-wide "every overlay
  gets an explicit layer" pass with its own visual-regression sweep. Needs a
  second signal — a consumer whose bands are too heavy to stay light.
- **Zone editing** (`<Zone onChange>` — drag a band's edges) — the zone-editor
  case (drag your HR/power boundaries). Coherent and mostly a transpose of
  `<Region>`'s edge-resize + `orderRegion` pivot onto the y scale; no consumer
  yet.
- **Multi-series layer API** (one layer, K columns) — **ergonomics only, not
  perf**: the 2026-07 suite profile measured React reconcile over 1000 layer
  elements at ~1% of frame time
  ([finding 6](../notes/charts-bench-vs-scichart-suite-2026-07.md)); the N×M
  collapse is the per-point draw constant ([PND-AFFINE]). Recorded here so it
  is never built _as_ a perf fix; adopt only if a consumer asks for the
  ergonomics on their own weight.

## [PND-LOGTICK-N18] — an unexplained sixth axis label on Node 18

**Open.** A log-axis test that asserted the exact set of digit-bearing leaf
`<div>`s in a rendered chart passed on Node 22 (5 labels: `1 / 10 / 100 /
1,000 / 10,000`, evenly log-spaced) and failed on CI's `verify (18.x)` with
**six**. It blocked the v0.56.0 publish twice.

What is known, measured rather than assumed:

- The chart is `<YAxis scale="log">` over data `[1, 100, 10000]`, domain
  `[1, 10000]` — five whole decades, and `yTickValues` returns exactly those
  five on every environment tried.
- The stray sixth element's text parses to a value whose base-10 logarithm sits
  `0.2944662261615929` from a whole number — **exactly** `log10(1.97)`. So the
  label reads `1.97`, `19.7`, `197`, `1970` or `19700`.
- It was never reproduced locally. `NODE_ENV=production` was the obvious
  suspect and is a dead end (it fails on `React.act is not a function`, a
  testing-library artifact of a production React build). No Node 18 was
  available on the machine to reproduce with.
- `1.97e17` does appear in a _sibling_ test in the same file, but that test is
  pure — it calls `resolveAxisFormat` and never renders — so it cannot be
  leaking DOM. The coincidence is unexplained, not a cause.

The assertion has been relaxed to an order-preserving **subsequence** check, so
a claim about tick _selection_ (already pinned deterministically by the
`yTickValues` unit tests) no longer gates a release on a whole-render-tree
scrape. That is a workaround, not a diagnosis.

**Worth doing:** run the charts suite under Node 18 and dump every
digit-bearing leaf div with its inline style, as was done on Node 22. If the
sixth element is a real axis label, the tick selector has an environment
dependence and this is a bug. If it is some other node that happens to contain
a digit, the original assertion was simply the wrong shape and this can close.

## [PND-CHFRIC] — Chart example friction

Found by **building** the Gallery's replica of a production network dashboard
(`website/docs/charts/gallery/site-traffic-dashboard`), not by reading the API.
Each item below cost a debugging cycle or forced a workaround that is currently
shipping inside the example. Ranked roughly by how much they'd repay fixing.

Two siblings found the same way were fixed during the wave, which is the case
for the rest: **`AreaStyle.flatFill`** (stacked areas were undrawable — every
band faded to transparent at the baseline and showed the one beneath) and the
**`grid` / `sessionDividers` / `xKind` repaint dependencies** (toggling
`<ChartContainer grid>` did nothing until an unrelated dep moved; you had to pan
a pixel to force it).

### Bugs

1. **`BoxStyle.strokeWidth` is declared but never read.** `BoxLine` hard-codes
   the current-value tick at `width: 3` and centres it with
   `left: calc(… - 1.5px)`. The esnet original the component is explicitly
   modelled on draws 4–5px. Not fixed in-wave on purpose: honouring the field
   would change **every existing `BoxList`'s** appearance (the declared default
   is `1.5`, i.e. _thinner_ than the hard-coded value), so it needs its own PR
   with snapshot review.
2. **`BoxList`'s value label has no gutter.** It is positioned inside the glyph
   area at `tick% + 8px`, so a tick near the top of the scale pushes the number
   off the panel — measured ~39px of overflow and a scrollbar. The example works
   around it with `padding-right: 72px !important` (the cell's padding is an
   inline shorthand, so `!important` is the only lever).

### Gaps

3. **No band-radius knob on `BoxList`.** The range band is a pill
   (`barHeight / 2`); the product's is square. Second `!important` in the
   example.
4. **`<Legend>` is always an in-plot overlay**, even as a `ChartContainer`
   child rather than a `Layers` child — "outside the row" only changes the
   default corner. It sat on top of a data plateau in the multi-host CPU
   example until it was moved. There is no way to place a legend _below_ a
   chart.
5. **`ChartContainer grid` is a single boolean for both axes.** The esnet
   original draws horizontal gridlines only; the replica can't match it.
6. **`BoxList` renders no header row** (`ListTable` is `<tbody>` only), so the
   product's `INTERFACE / CATEGORY / IN / OUT` labels are simply absent.
7. **`BoxList` has one ink for every column** — the value label takes
   `listInk(theme)`, so a two-series list cannot tint its readouts per column.
8. **`onTrackerChanged` carries only _drawn_ series' values.** A table that
   reads out per-entity numbers for the hovered instant has to take the time
   from the callback and index its own data — which works, and is documented on
   the page, but means the callback can't answer the question by itself.

### Discoverability

9. **Theme roles fall back silently, per primitive.** `bar.muted` and
   `area.context` were both written, shipped and doing _nothing_ — the role
   simply didn't exist for that layer and the fallback is silent. Worse,
   `BarChart`'s `as` is **single-series only**: `bins` always takes the stacked
   path, which reads `bar.default` regardless. The only reliable check is
   sampling the rendered canvas. A dev-mode warning on an unresolved role would
   have saved three separate debugging cycles in this wave alone.
10. **`BoxList`'s theme channels are unrelated to lists.** Its text ink is
    settable only via `axis.band.label` (a stacked-date-band token) and its row
    hover tint via `legend.border`. Both work; neither is findable.
11. **`panZoom` uncontrolled ignores later `range` props.** Enabling it makes
    `ChartContainer` own the view, so preset buttons that write `range` work
    once and then silently die. The fix is to go controlled via
    `onTimeRangeChange`, which is not obvious from either prop's docs.
12. **`<YAxis label>` defaults to the axis `id`**, so an unlabelled axis prints
    a rotated `"bps"`-style strip nobody asked for.

Found the same way by the Gallery's **finance** track
(`website/docs/charts/gallery/{candlestick,price-volume,bollinger-bands,drawdown}`):

14. **`CursorMode`'s own docs contradict the implementation, and the docs are
    the optimistic one.** `context.ts` describes `'crosshair'` as "a dot on
    **each series**, with **each series' value** pinned to its y-axis edge (an
    on-axis pill)" — plural. `tracker.ts` describes the same mode, four files
    away, as "a single reticle (not per-series) … and **one value pill**", and
    that is what it does. Measured in the browser: a row carrying a
    `<BandChart>` + `<LineChart>` + `<Candlestick>` draws exactly **one** pill
    (`$158.40`, the band's upper edge) for four layers. This is not a cosmetic
    docs bug — page prose was written from the `CursorMode` doc and shipped a
    hover claim that was simply false, and the only way to catch it was to hover
    the running chart. Either make the docs match (`crosshair` is a per-**row**
    reticle; several layers need `cursor="inline"` or an off-chart
    `onTrackerChanged` readout) or make the behaviour match the docs.
15. **`TrackerSample.label` is the layer's `as`, and `as` is a theme role.**
    The field is documented as "the series identity (`as` ?? column)", but `as`
    is simultaneously documented — and used throughout the docs site — as the
    **styling** channel ("`as` picks the style from the theme"). A chart styled
    by role therefore reports `secondary $142.99` and `inner upper $158.40` to
    any readout built on `onTrackerChanged`: theme role names, not data names,
    with no way to recover the column. One prop is doing double duty and the
    readout is where it breaks. Either give layers a separate identity/label
    prop, or carry the source column on `TrackerSample` alongside `label`. The
    Bollinger example currently ships a hand-written rename map as the
    workaround.

### Not a library issue, but it cost the most time

13. **A worktree's `website/node_modules` symlinks to the main checkout**, so a
    docs preview resolves `@pond-ts/charts` to whatever branch _main_ happens to
    be on. Stacked areas rendered unfilled against a stale build — a symptom
    **indistinguishable from item 9**, which is why it burned a cycle. The
    workaround is a temporary `configureWebpack` alias pointing at the
    worktree's own `packages/charts`, reverted before committing. Worth either
    documenting in the fixture/preview conventions or solving properly.

14. **A draw layer can't opt out of the cursor readout**, so drawing one column
    twice reports it twice. `cursorFlag` exists as an internal `RowLayer` hook
    (`BoxPlot` uses it to consolidate, and it also opts that layer out of the
    x-snap) but there is no public per-layer prop. Found on the charts landing
    chart: a raw `<LineChart>` plus a `<ScatterChart>` **on the same column** —
    a completely standard pairing, and the shape the points-plus-faint-line
    reading asks for — makes `cursor="flag"` raise **five** flags, of which
    three carry the identical number (band `lo`, the raw line, and the scatter
    all read 0.2 kW at the same instant). Measured, not inferred: dispatching a
    real `pointermove` and reading the chips out of the DOM returned
    `0.2 / 0.5 / 0.2 / 0.2 / 0.3`.

    Compounded by the fact that near-coincident flags are **not** de-overlapped
    — `Layers.tsx` says so in a comment ("a de-overlap heuristic is a
    follow-up"), and the five chips land on the same coordinates, so the reader
    sees one number with no way to tell which layer it belongs to.

    The fix is probably a `readout={false}` (or `cursor={false}`) prop on the
    layer, promoting the existing internal opt-out to the public surface. The
    de-overlap is a separate, second fix.

15. **Nothing dedupes identical cursor samples.** Even without a per-layer
    opt-out, two layers reporting the same `(label, value)` at the same time
    could collapse to one chip. This is the cheaper half of item 14 and would
    fix the common case on its own.

Found the same way by the Gallery's **weather & climate** track
(`website/docs/charts/gallery/{temperature-range,rainfall,climate-stripes,wind-rose}`).
All three measured in the browser by dispatching real `pointermove` events and
reading the overlay SVG and the pill DOM back, not inferred from the source.

16. **The x-axis time pill is hard-gated on `cursor === 'crosshair'`**
    (`XAxis.tsx`, `showCursorTag`), so the **default** cursor tells you neither
    the value nor the _time_. `cursor` defaults to `'line'`, documented as "the
    synced vertical line, with values surfaced _outside_ the chart via
    `onTrackerChanged`" — which reads as a deliberate division of labour, values
    off-chart, position on-chart. It isn't: measured, `'line'` renders a bare
    `<line>` in the overlay and **no pill at all**, while the same chart under
    `'crosshair'` renders the date pill. So a chart whose values legitimately
    live off-chart (item 17 is one) has to wire `onTrackerChanged` just to
    answer "which year am I pointing at" — a question the container has already
    computed and is one `<div>` from displaying. Showing the x pill under
    `'line'` looks like a one-line change with no downside.
17. **`<BarChart>` has no `readout` prop, so the cursor pill can't be pointed at
    a column other than the drawn one.** `<LineChart>` / `<AreaChart>` both take
    `readout`; `<BarChart>` doesn't. It bites hardest where **colour is the
    value**: the climate-stripes card draws a constant `stripe` column purely to
    give each year a full-height slot, so `cursor="crosshair"` reports `1.0` on
    all 146 bars, and pins a horizontal arm to the top edge of the plot while
    it's at it. Distinct from items 14/15 — there the complaint is too many
    chips, here it's one chip reading the wrong column with no way to redirect
    it. The example ships the `onTrackerChanged` + look-up-the-year workaround,
    and the page documents it as the pattern, which is a fair answer but a
    `readout` prop would be a better one.
18. **The categorical cursor is only reachable by asking for a "crosshair".** On
    a `<CategoryAxis>` row, `cursor="crosshair"` degrades _well_ — a vertical
    line plus the hovered sector's name pinned to the axis, no horizontal arm
    and no value pill, because an ordinal axis has no continuous position to
    read back. That naming is genuinely load-bearing: the axis decimates 16
    sectors down to the 8 labels it has room for. But `cursor="line"` shows
    neither the name nor a pill, so the mode you must name to get an ordinal
    readout is the one whose documented behaviour is exactly what an ordinal
    axis can't do. Same root as item 16; worth listing separately because the
    categorical symptom is what a reader hits first, and because `CursorMode`'s
    docs say nothing about what any mode does on a category axis.

Found by **rebuilding the wind-direction card as a scrubbable categorical
series driving a live histogram** (`website/docs/charts/gallery/wind-rose`,
pjm's design). Both measured in the browser — the drag by dispatching real
`pointerdown`/`pointermove`/`pointerup` and reading the window back, the label
collision by counting the rendered axis labels in the DOM.

19. **`PartitionedTimeSeries` has no `reduce`** — a **core** gap, logged here
    because this is where the Gallery friction lives. "Collapse every partition
    to one scalar" is precisely the histogram case, and it has no direct form:
    `PartitionedTimeSeries` offers `collect` (glue the partitions back into one
    series), `toMap` (hand them all back) and `aggregate` (bucket each one _by
    time_), so counting a window per category means

    ```ts
    const byCategory = series
      .within(from, to)
      .partitionBy('sector', { groups })
      .toMap();
    const counts = [...byCategory].map(([k, g]) => [
      k,
      g.reduce('sector', 'count'),
    ]);
    ```

    — `toMap()` plus a `TimeSeries.reduce` per group, by hand. It totals
    correctly and it is not slow (0.55 ms over 8,735 rows), but the shape a
    histogram wants is `partitioned.reduce('sector', 'count') ⇒ Map<K, value>`,
    which is the exact partitioned analogue of the `TimeSeries.reduce` that
    already exists. Worth noting that `partitionBy(col, { groups })` is the
    other half of the answer and _does_ exist: declared groups fix the slot
    order and keep an empty group as an empty `TimeSeries`, which is what stops
    the bars shuffling as the window moves. The reduction is the missing half.

20. **`<CategoryAxis>`'s label thinning is estimated, not measured, and the
    estimate lands on the wrong side at Gallery-card width.**
    `thinCategoryLabels` (`XAxis.tsx`) derives its stride from
    `fontSize * 0.62` per glyph. At the card's 344px — 298px of plot after the
    y gutter, 16 sectors, 3-character worst case — that estimate comes out
    _exactly_ equal to the slot width, so `ceil()` gives stride 1, all sixteen
    labels render, and the real glyph advances run them together into
    `SSWSW WSW W WNWNWNNW`. Two things make this worse than a near-miss: the
    threshold is a knife edge (the same axis with a 46px gutter versus a 38px
    one flips between 8 labels and 16), and there is no signal — the axis
    reports nothing, so the only way to find it is to look. The card works
    around it by **blanking every other `CategoryDatum.label` itself**, which
    is deterministic but means the caller is now doing the axis's job. A DOM
    (or canvas) text measure, or simply padding the estimate, would close it.

Found the same way by the Gallery's **ESnet volume-history** card
(`website/docs/charts/gallery/volume-history`) — the first chart built on the
log axis, and the first with a draggable model parameter. Everything below was
measured in a running browser, not read off a type.

### Bugs

**Read item 30 first** — it is a hard crash in `pond-ts` core, and the most
serious thing found in this batch.

19. **The log axis's dev warning broke the docs build.** `ChartRow.tsx` guarded
    it with a bare `process.env.NODE_ENV`, which typechecks only when a tool
    happens to resolve node's ambient types from a parent `node_modules`.
    `@pond-ts/charts` is a browser package and its tsconfig pulls in no
    `@types/node`, so `tsc` inside the package passed while TypeDoc running the
    **same tsconfig** from `website/` failed with `TS2591: Cannot find name
'process'` — taking out `npm run build:api-model`, and therefore
    `docusaurus build`, entirely. Fixed here by `packages/charts/src/dev.ts`:
    one local `declare const process`, plus a `typeof` guard so a bare
    `<script type="module">` doesn't throw at import. The general point stands
    — **the failure surfaces in a tool that isn't in `npm run verify`**, so the
    next `process.env` reference will reintroduce it silently. Worth a lint
    rule (`no-restricted-globals: process` in the charts package) or adding the
    docs API-model build to CI.

### Gaps

20. **A draw layer cannot opt out of, or be bounded within, the y-axis domain
    fit.** The projected line is a _model_, and a model can be wrong by orders
    of magnitude: this chart's exponential, fitted on 1990–2008, projects
    **73.7 EB** for July 2026 against an actual **197.82 PB** — 373× over, two
    and a half decades above anything ever measured. As a layer it joins
    `resolveYDomain` exactly like a measurement, so an auto-fitted axis would
    squash 36 years of real data into the bottom fifth of the plot to make room
    for a line that is _wrong_. (The mirror case is a linear fit, whose values
    go **negative** and would pick the floor of a log axis.)

    There is no `fitDomain={false}` / `domain="ignore"` per-layer escape, so the
    example computes `[min, max]` by hand for every scale × window × split
    combination — ~40 lines whose only job is to stop one layer dictating the
    axis, including a hand-rolled "the projection may lift the ceiling by at
    most one decade, and past that it runs off the top" rule that is genuinely
    the right behaviour and that every forecast chart will have to reinvent.
    Any forecast, backtest, band-projection or annotation-as-a-series hits
    this. Sibling of the `readout={false}` in item 14: same shape (a layer that
    draws but shouldn't fully participate), different subsystem. A plain
    `fitDomain={false}` covers most of it; a `fitDomain="clamp"` — drawn, but
    clipped to the domain the other layers agreed on — covers all of it.

21. **`BarListColumn.as` is per column, not per row.** The canonical `<BarList>`
    is a **ranked list — one bar per row** — and that is exactly the shape that
    cannot colour its rows, because the theme role lives on the column spec that
    every row shares. A four-row per-series summary therefore gets four
    identical bars. The example splits the encoding (neutral bars for magnitude,
    a swatch in the label for identity, read from the same `line` role the chart
    draws with), which is defensible design but was forced, not chosen. A
    per-row `as` — or a `colorBy` reading a `values` entry — would close it.
    Also **confirms item 6 for `BarList`**: no header row, so four numeric cells
    have to smuggle their own labels (`1 m` / `1 y`) into the cell text.

### Discoverability

22. **`cursor="line"` has no readout at all, and nothing says so.**
    `cursorParts('line')` is `{ line: true, chip: 'none' }` — a bare vertical
    rule, no dots, no values. The page prose here was written claiming a hover
    readout and was **wrong**, caught only by dispatching a real `pointermove`
    and finding zero chips in the DOM. `CursorMode` badly wants a table in its
    own doc comment: which modes draw a line, which draw dots, which show
    values, and how many. This is the third page in this plan (see items 14, 15)
    whose hover prose had to be corrected against the running chart.

23. **Bucket-snapped cursoring and per-series values are mutually exclusive.**
    `cursorSequence` is honoured **only** for `cursor="region"`, and
    `cursorParts('region')` is a band with no dots and no chips. So "shade the
    real calendar month under the pointer" and "read all three series at that
    month" cannot both be on. Neither prop's doc mentions the other's cost.

    _Still true; no longer felt here._ The final design has no hover readout
    (the original chart has none), so the region cursor costs nothing and the
    conflict never arises. The item stands for the next chart that wants both —
    and the shape of the fix is clear from having hit it: `cursorParts` could
    let `region` compose with `dots`/`chip` rather than replacing them.

24. **A single `editing` mark suppresses the whole row's data cursor.**
    `Layers.tsx` computes `editingActive = container.editAnnotations ||
container.annotations.some((a) => a.editing)` and forces `cursorParts('none')`.
    So making _one_ `<Marker editing>` draggable silently turns off hover
    readouts for **every layer in the row** — a large, non-local consequence of a
    per-mark prop. `MarkerProps.editing` / `RegionProps.editing` describe the
    mark's own affordances and say nothing about it.

                                                                        _Still true; no longer felt here._ The draggable marker is gone — selection
                                                                        is a click — so nothing on this page is in edit mode. But it cost a design
                                                                        iteration to discover, and the docs still don't mention it. **The one-line
                                                                        fix is a sentence on `editing`**: "while any mark in a row is editing, that
                                                                        row's data cursor is suppressed."

25. **`onRegionSelect` fires on a plain click, and the docs imply it doesn't.**
    The prop reads as drag-only ("drag across the plot … on release this fires
    once with the selected `[lo, hi]` span"). Measured: a `pointerdown` +
    `pointerup` at the **same** x, no movement, fires it with exactly the bucket
    under the pointer — `[2016-12-01T00:00Z, 2017-01-01T00:00Z]` from a
    `Sequence.calendar('month')` grid. `regionSpan(buckets, t, t)` returns the
    single bucket by construction. **This is a feature nobody knows they have**:
    "click a bucket to select it" is the obvious thing to want from a bucketed
    cursor, and it already works.

    **Promoted from curiosity to the load-bearing gesture.** This chart's entire
    selection model is now click-to-select on a `Sequence.calendar('month')`
    cursor — hover previews the month, click commits it, and the returned span
    is already on real month boundaries so there is nothing to round. It is the
    single nicest interaction on the page and it was found by accident, reading
    `regionSpan` while investigating something else. **Highest-value doc fix in
    this batch**: one sentence on `onRegionSelect` and a story, and every
    consumer gets a bucket picker for free.

26. **Click-to-select and drag-to-pan cannot coexist.** A region-select arms on
    `pointerdown` and **preempts pan**; `regionSelectModifier="shift"` moves it
    behind a modifier, but then a _plain click_ falls through to pan and never
    selects — so a chart whose primary gesture is clicking a bucket must give up
    pan entirely (wheel-zoom is unaffected). That is a real and defensible
    trade, and this chart takes it, but it is invisible from the docs: neither
    `panZoom` nor `regionSelectModifier` says that plain-click selection and
    plain-drag panning are mutually exclusive. A third modifier value
    (`regionSelectModifier: 'none' | 'shift'` with click always selecting and
    drag always panning) would resolve it, since a zero-distance drag is
    unambiguous.

27. **A dragged mark does not snap to `cursorSequence` buckets.**
    `snapToGuides` follows _other annotations'_ x-positions and discontinuity
    boundaries only, so a `<Marker editing>` on a container with a month grid
    still lands mid-month; the caller has to re-snap in `onChange`. _Not felt in
    the shipped design_ (no draggable marks), but real, and surprising when the
    container already holds exactly the grid you want.

28. **`defaultTheme.legend` is a hardcoded light palette, and a bridged theme
    that forgets it fails silently.** The docs site's `useSiteChartTheme` never
    mapped the `legend` register, so **every embed drawing a `<Legend>` rendered
    a white card with slate text** — invisible-adjacent in light mode and a
    glaring white block in dark. Nothing warns; the card just doesn't follow the
    toggle. Fixed on the site side here. This is item 9's "roles fall back
    silently" in its most visible form, and the cheapest general fix is the same
    one: a dev-mode warning when a resolved theme still holds `defaultTheme`
    values for a register the consumer has otherwise overridden.

### Not a library issue, but it cost time again

29. **Item 13's stale-`dist` trap has a second form: you rebuilt, then merged.**
    This worktree had its **own** `node_modules` (a fresh `npm install` inside
    it), so the symlink resolved correctly and item 13 didn't apply. The trap
    fired anyway — `packages/charts` was built _before_ merging the log-axis
    fixes, so the site kept serving the pre-fix `dist` and a five-tick axis came
    back as **37 labels**, a symptom identical to "my domain logic is wrong".
    Diagnosed in seconds only because item 13 taught the check:
    `grep -c yTickValues packages/charts/dist/YAxis.js` → `0`. Worth promoting
    that grep into the preview conventions as a _routine_ step after any merge,
    not just after a checkout.

30. **FIXED (v0.56.0).** **`pond-ts` CORE — a fractional epoch millisecond hard-crashed the page.**
    Closed on two fronts: `toPlainDateStart` floors the instant to the
    millisecond containing it (`packages/core`), and `zoomRange`/`panRange`
    now round the view range at source (`packages/charts/src/viewport.ts`),
    which closes the whole class rather than one call site. The
    volume-history example's `wholeMs` workaround has been removed. Kept here
    because the discovery path is the durable part: two ordinary props, no
    unusual consumer code.
    **The most serious thing in this batch: not a gap, a crash**, and it lives
    in `packages/core`, not in charts. Reachable from two ordinary props with
    no unusual consumer code:

        ```tsx
        <ChartContainer cursorSequence={Sequence.calendar('month')} panZoom="panZoom">
        ```

        Scroll the wheel once over that plot and the page dies. The chain, each
        step verified rather than assumed:
        1. `Layers.tsx` wheel handler: `const pivot = +c.xScale.invert(localX)` —
           a d3 time-scale invert of a **pixel**, so fractional.
        2. `viewport.ts` `zoomRange()`: `pivot ± (…) * factor` with
           `factor = Math.exp(deltaY * k)` — float maths, **no rounding anywhere**.
        3. That range becomes the container's view, over which `cursorSequence` is
           realized (`ChartContainer.js:647` → `Sequence.bounded`).
        4. `core/calendar.ts` `toPlainDateStart` →
           `Temporal.Instant.fromEpochMilliseconds(1577836800000.37)` →
           **`RangeError: epoch milliseconds must be an integer`**.
        5. React unmounts the tree. The chart is gone; in dev the pane locks up.

        Isolated repro, no browser needed:

        ```js
        const s = Sequence.calendar('month', { timeZone: 'UTC' });
        s.bounded(
          new TimeRange({
            start: Date.UTC(2020, 0, 1) + 0.5,
            end: Date.UTC(2021, 0, 1),
          }),
        );
        // → RangeError: epoch milliseconds must be an integer
        ```

        Captured stack from the running page: `Instant.fromEpochMilliseconds` ←
        `toPlainDateStart (core/calendar.js:62)` ← `Sequence.bounded

    (core/sequence.js:155)`←`ChartContainer.js:647`.

        **The fix belongs in core** — floor the instant before it reaches Temporal.
        Sub-millisecond precision does not exist in this model, so an over-precise
        input can only mean the containing millisecond; throwing is never the
        useful answer. Being fixed upstream in `packages/core`; this worktree ships
        a **clearly-marked workaround** (`wholeMs` in
        `gallery-volume-history.tsx`) that rounds the range outward before it
        reaches anything calendar-aware. **Remove the workaround when the core fix
        lands.**

        Two notes for whoever takes the core fix. `scanWindow`
        (`src/lib/autoplay.ts`) produces fractional ms the same way, so **every
        autoplaying Gallery card** is exposed the moment it is given a calendar
        `cursorSequence`. And more generally: if wheel-zoom emits a fractional
        range, anything downstream that assumes integer ms shares this exposure —
        `zoomRange`/`panRange` rounding at the source would close the whole class
        rather than one call site. Not hunted further; the core fix should cover
        it.

### Found building Gallery Track D — energy (grid mix, renewables, negative prices)

Appended rather than numbered into the lists above, whose numbering is already
tangled from concurrent edits. Each item cost a debugging cycle or forced prose
that apologises for the library.

- **A `<YAxis>` can't have terse ticks and a precise cursor pill.** `format` is
  deliberately one channel for both ("so a tick and a cursor value read
  identically", `YAxis.tsx`), and `<ChartContainer cursorFormat>` shapes the
  **x** readout only. A price axis wants `0 / 50 / 100` ticks and a `−52.42`
  pill; it gets `−52`. All three Track D pages ended up explaining the rounding
  in prose. A `readoutFormat` on `<YAxis>` falling back to `format` would close
  it without touching the existing default.

- **The crosshair reticle ignores `readout`.** `AreaChart`/`LineChart`'s
  `readout` column names the raw value behind a derived plot, and
  `TrackerSample` documents that "a readout renderer prefers `readout ??
value`" — but the in-chart reticle (`Layers.tsx`, `pick.value`) takes the
  plotted number only. On the eight-band stack that means hovering the wind
  edge prints `16` (the cumulative "everything but solar"), where the obvious
  reading is wind's own 4.19 GW. Making the reticle prefer `readout ?? value`
  would make a stacked area's cursor say what a reader expects, with no new
  prop.

- **`<AreaChart>` has no `id`, so nothing about an area is clickable.** Bars,
  scatter points, candles and box rows all opt into hit-testing via `id`; areas
  register no `hitTest` at all. A stacked area is precisely where "click the
  band" is the expected affordance, and the grid-mix page has to state the
  absence instead of demonstrating it.

- **No diverging bar role in the theme.** Colouring bars by sign means reaching
  across primitive families into `theme.candle.default.falling.body` for the
  negative hue. The negative-prices page documents this as deliberate (the
  palette's "conventional exception" pair), but a signed **bar** chart is common
  enough to deserve `bar.positive` / `bar.negative` — or the pair under one
  `diverging` key — so the workaround stops being the documented answer.

- **Docs-side: `TrackerReadout` hard-codes an `America/New_York` date.**
  `website/src/examples/lib/tracker-readout.tsx` was written for the finance
  cards and formats `tracker.time` in a fixed New York timezone. Track D wanted
  an off-chart two-value readout for renewables-vs-demand (the crosshair shows
  one series at a time) and skipped it rather than stamp a German grid chart
  with New York dates. A `time` formatter prop, defaulting to today's
  behaviour, unblocks reuse.

- **A Gallery card's `staticPhase` is an unverifiable magic number, and all
  three Track D cards had it wrong.** `staticPhase` is both the first-paint and
  the `prefers-reduced-motion` frame, and `autoplay.ts` tells you to "pick the
  most interesting frame" — but the number maps to a window through
  `scanWindow`'s ping-pong triangle, which nobody can evaluate by eye. The
  salvaged values (0.52 / 0.5 / 0.55) parked all three windows on Easter
  Monday; the negative-prices card's static frame contained **none** of the
  eight negative hours its own blurb advertises. Fixed here by computing the
  windows offline (0.24 / 0.26 / 0.14, verified against the rendered axis
  ticks). A three-line script under `website/scripts/` that prints the window a
  `staticPhase` selects would turn this from a guess into a check.

- **Verification note: `requestAnimationFrame` is fully stopped in a hidden
  preview pane** — measured **0 callbacks in 2.5 s** with `document.hidden ===
true`. So autoplay cannot be observed there at all, and worse, whatever phase
  the last live tick left behind sticks: the card you inspect is a frozen
  mid-sweep frame, not `staticPhase`. Reload the page to read the static frame,
  and don't file "the cards don't animate" from that pane.

### Found building Gallery Track F — the Niño 3.4 day-of-year overlay

`website/docs/charts/gallery/nino34` — 45 years of daily SST stacked on one
Jan–Dec axis, with the anomaly computed in the page rather than baked into the
fixture. Appended rather than numbered into the lists above, whose numbering is
already tangled. Most of this batch is **core**, not charts: the chart itself
was the easy half.

- **`TimeSeries.select` is variadic, and an array argument silently returns an
  empty series.** `select(...keys)` filters with `keys.includes(column.name)`,
  so `select(['a', 'b'])` matches nothing and hands back **the key column
  alone** — no throw, no warning. Handed a computed column list (the natural
  case: one column per year / host / sensor), that is exactly the mistake you
  make, and TypeScript does not catch it on a widened schema. The symptom
  surfaces three calls later; see the next item. `select('nope')` on a real
  series is the same silent shrug. Either accept an array as well as a rest
  list, or reject an unknown name.

- **A `collapse` key that names no column is an unguarded crash.**
  `collapseOp` does `keyedCols[j].read(i)` with no check that the lookup
  resolved, so a missing name is
  `TypeError: Cannot read properties of undefined (reading 'read')` — no column
  name, no operator name, a stack inside `dist`. It is what the `select` bug
  above turns into, and a one-line `ValidationError` naming the column would
  have pointed straight at it.

- **A series whose columns are named at runtime has no supported type.** This
  chart's wide series is 365 rows × one column per year, and the years are a
  runtime list, so there are no literals for the column-name types to infer
  from. `TimeSeries<SeriesSchema>` — the obvious reach, and the shape API.md
  calls "loosely typed" — makes `keyof EventDataForSchema<S>` resolve to
  **`never`**, so `collapse(keys, …)`, `select(name)` and `column(name)` all
  fail to compile. (`TimeSeries<any>` is worse: also `never`.) The carve-out
  API.md documents is about **charts'** column props, not core's own methods.
  What does work, and is not written down anywhere:

  ```ts
  type WideSchema = readonly [
    { readonly name: 'time'; readonly kind: 'time' },
    ...{ readonly name: string; readonly kind: 'number' }[],
  ];
  ```

  One column per entity is an ordinary shape. Worth either a documented
  `RuntimeSchema` alias or a note on `SeriesSchema` saying what it isn't.

- **`collapse`'s result type only survives if it is never annotated.** The
  inferred `CollapseSchema` remembers that `anomaly` is a numeric column named
  `anomaly`, which is what makes `column('anomaly').toFloat64Array()` compile.
  Annotate the function that builds it with the _input_ schema type and that is
  gone — `column()` degrades to the union of every column kind and
  `.toFloat64Array()` stops existing. The example exports
  `ReturnType<typeof buildAnomaly>` as the workaround, which works but means the
  public type of a fixture module is a `ReturnType` of a private function.

- **There is still no y-span annotation, and this is the second card in one
  track to want one.** Threshold _bands_ — El Niño weak/moderate/strong/very
  strong at +0.5/+1.0/+1.5/+2.0 here, the AQI categories on the air-quality
  card, flood stages on the tide card — are a recurring shape, and the only way
  to draw one today is N `<Baseline>`s, because `<Region>`'s `from`/`to` are
  **x** positions. Four lines say the thing; a shaded band says it better, and
  says "between these two values" rather than "at this value" which is what a
  category actually is. `<Region orientation="y" axis>` or a sibling
  `<ValueRegion>` closes it.

- **`cursorFormat` is silently inert under the default cursor.** Set
  `cursorFormat="%-d %B"` expecting it to shape the readout; it does nothing,
  because `cursor="line"` renders no pill for it to shape (items 16 and 22).
  Nothing in `cursorFormat`'s doc — which is long and careful about precedence
  — says its effect is conditional on the cursor mode. Removed from the example
  rather than shipped as decoration. Same root as 16/22, listed because the
  _prop_ is where a reader meets it.

- **Not a library issue: a Gallery card's `pageHref` can dangle, and only
  `docusaurus build` notices.** Four Track F cards on this branch linked to
  pages that had not been written yet. `docusaurus start` renders them happily,
  `tsc` says nothing, and `onBrokenLinks: 'throw'` only fires in a production
  build — so the branch had been red since the WIP commit that added them. The
  prop is documented optional for exactly this reason; the convention should be
  **add `pageHref` in the same commit as the page**, not with the card.

- **Verification note: a synthetic `pointermove` needs a tick before the DOM
  says anything.** The dispatch recipe works (`elementFromPoint` is not
  required — dispatching on the canvas with `bubbles: true` reaches React's
  delegated listener), but reading the readout back **in the same synchronous
  block returns the pre-event text**, because the state commit has not
  happened. `await` ~100 ms first. Reading it synchronously is a very
  convincing way to conclude that hover is broken when it isn't.

- **Verification note: `elementFromPoint` returns `null` and `innerWidth` is 0
  while the preview pane is hidden**, which is a different failure from the
  `requestAnimationFrame` one already noted. Dispatch straight at the element
  and compute `clientX` from its `getBoundingClientRect()` — the rect is still
  correct (it just has a negative `left`), and the handlers only ever use it
  relative to themselves.

- **Verification note: `%b` on a year-long axis is four labels, not twelve.**
  The tick ladder thins month labels to fit; at a 578px plot it prints
  `Jan / Apr / Jul / Oct`. Page prose claiming "`Jan … Dec`" was written and had
  to be corrected against the rendered DOM. Counting the axis labels is a
  one-line check and worth doing on any axis whose labels the prose describes.

---

## [PND-SPARCFRIC] — SPARC charts friction (2026-08)

A 17-item survey from an external consumer planning the replacement of seven
hand-rolled SVG chart components with pond compositions. Assessed against
`@pond-ts/charts@0.56.2` read from `origin/main` (the reporter notes a local
checkout 137 commits behind gave a materially wrong answer on four items — worth
remembering when triaging any consumer report). Items marked **confirmed** were
hit while building; **predicted** ones were found by reading source.

The report is unusually well-disciplined: it retracts one of its own items
([PND-TICKUNIT]) and closes another ([PND-BANDBAR]) rather than leaving both as
asks. Both retractions are preserved below because in each case the mistake is
more instructive than the finding.

### Verified against `main` before triage

Spot-checked rather than taken on trust:

- `bars.ts:623` does carry `(v < 0 && G > 1)` — the negative-segment drop is real.
- `maxBandWidth`, `bandAlign`, `symlog`, `selectedKeys`, `selectionMode` return
  zero hits across `packages/charts/src` — all four gaps are real.
- `thinCategoryLabels` is at `XAxis.tsx:44` and does drop tick and label together.

Nothing checked was overstated.

### Already tracked — corroborating second reports, not new work

That an independent consumer hit these unprompted is signal on their priority,
which is the main reason to record them rather than just closing them:

| Report item                    | Existing entry | What the second report adds                                                                                                                                                                                                                     |
| ------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [PND-MULTISEL]                 | [PND-SELECT]   | Multi-select must **compose with `binColors`**, not exclude it the way the current highlight model does                                                                                                                                         |
| [PND-AUTOSIZE]                 | [PND-WIDTH]    | Third consumer. Adds the failure mode: `ResizeObserver` fires after paint, so the obvious `useEffect` version flickers on every mount; the fix is `useLayoutEffect` + a synchronous first `getBoundingClientRect`                               |
| [PND-AXISTITLE]                | [PND-CHFRIC]   | Independent second hit on `<YAxis label>` defaulting to the binding `id`. Same root as [PND-AXISHIDE]: the axis draws things the consumer cannot decline, because the scale and its presentation are one object                                 |
| [PND-SYMLOG], [PND-AXISMIRROR] | [PND-AXES]     | Symlog re-scored low → medium. Worth recording the reason: it was low only because the one caller was expected to be retired, and that call reversed. A severity resting on a _consumer's_ roadmap is not a stable basis for a library priority |

### Owner's priority ordering

**(1) [PND-BANDBAR2] — first-class threshold banding along one bar's length.**
One bar coloured in segments against a threshold ladder — neutral to the first
threshold, then warning, then alarm — so a long bar shows how far through the
ladder it travelled, not merely which band it ended in.

The reporter **closed** this as `[PND-BANDBAR]`, "resolved, no library change":
a bar grows from the baseline rather than from its own band's floor, so N layers
drawn outermost-first composite the gradient by overpainting. **The owner
re-opened it** — the workaround is real but keeps recurring, and it is a common
bar use case, vertical and (separately raised) horizontal.

What the N-layer workaround cannot give, and why this is a mark rather than a
recipe: **one bar should stay one thing**. N layers means N hit targets, N
`SelectInfo.mark` identities, and N legend rows for what the reader sees as a
single bar. Decided API (owner, 2026-08-06):

```tsx
<BarChart categories={cats} thresholds={[1, 2]} />
// band fills default from a new ordered `theme.bar.bands`;
// `bandColors={[...]}` overrides at the call site.
```

Breakpoints are data and go in a prop; colour comes from the theme with a prop
override — mirroring the existing `StackStyle` precedent exactly (theme supplies
group fills, `colors` overrides). Two alternatives were considered and declined:
a single self-contained `thresholds={[{upTo, color}, …]}` prop (reads well in
isolation, but puts the colour arithmetic back at the call site, which is what
the theme exists to remove), and a theme-slot-only version with no override (no
escape hatch for a one-off ladder short of wrapping the theme). Negatives band
symmetrically on `|v|`, matching the ±3.5 diverging case; an asymmetric ladder
can come later via signed breakpoints if a consumer pulls.

**It also un-narrows [PND-CATSTACK].** The reporter argued that the nested case
was solved by layering, leaving only _co-existing_ segments (several sub-series
summing to a bin total) genuinely unserved. Re-opening the nested case restores
both halves as real asks — though they remain different features, and this one
is the smaller.

**(2) [PND-AXISHIDE] — `<YAxis hide>`.** Confirmed; it blocked a change outright
rather than costing a workaround. A `<YAxis>` does two jobs — it **holds the
scale** (`min`/`max`/`scale`/`pad`) and it **renders a gutter** — and there is no
way to ask for the first without the second. So a consumer can express "auto
domain, no gutter" (omit the axis) and "explicit domain, with a gutter", but not
the combination a fixed-domain chart needs. `width={0}` does not help: the labels
still draw, now over the plot. The owner notes many visualizations where the
scale numbers do not matter at all, only relative category values.

**(3) [PND-BANDPACK] — `maxBandWidth` + `bandAlign`.** Confirmed twice: eight
categories in a 693px plot gave ~70px bars (about 3× the hand-rolled chart being
replaced), then eleven categories became eleven ~65px blocks reading as a
waterfall rather than a bar chart. A band scale spreads its categories across the
full plot width, so the same chart in the same panel reads differently depending
on how many categories the data returned — fine for a fixed domain, wrong for a
**live** one, where bar width becomes a meaningless variable that moves on its
own.

The two halves are **not** alternatives:

- **Width** is recoverable through `gap` (`gap = plotWidth / n - targetBarWidth`,
  floored) — confirmed working, and it degrades correctly. That the workaround
  exists is still the argument that the geometry belongs in the library: `gap` is
  expressed as "how much to inset" rather than "how wide may a bar be", so every
  consumer inverts it themselves against a width they must measure.
- **Alignment has no viable workaround.** Packing from one edge means padding the
  _domain_ with blank trailing categories; those are real domain, so they sit in
  the scale and on the axis and interact with `gap` in undocumented ways. The
  reporter's attempt produced bars that got _wider_ rather than packed — recorded
  as a failed attempt, not a recipe.

**(4) The three that mislead.** Grouped by the owner because they share a failure
shape rather than a subsystem:

- **[PND-SIGNSTACK]** (high, confirmed) — `bars.ts:623` skips any negative
  segment of a multi-group stack. The comment is explicit that this is
  intentional, and for a conventional stack that is fair; but it rules out the
  **signed stacked histogram**, where positives stack up from a zero line and
  negatives stack down (net flow by category, inflow/outflow, buy/sell pressure
  by venue). That is a well-defined stack — two running totals per bin instead of
  one. The failure mode is the problem: the negatives do not clamp, warn or
  throw, so mixed-sign data renders as a confident, wrong, all-positive chart.
  The fix is in the accumulator, not the renderer — the geometry below already
  normalizes an inverted rect via `Math.min`/`Math.max`. Splitting into two
  layers does **not** work as a workaround: the negative layer is still `G > 1`,
  so it is dropped too.

  Worth recording independently of the fix: the categorical-axis RFC (§1)
  surveyed this same consumer and concluded that signed stacking was "a
  phantom… item 6 (threshold colour) + a signed bar", and dropped it as a
  requirement. That conclusion was drawn from the consumer's **diverging** chart,
  which is indeed a signed single bar. It missed the **histogram**, which is a
  genuine signed multi-series stack — six of that consumer's eleven histogram
  configurations use it. A requirement was dropped on the basis of a survey that
  had not looked at the one chart that needed it.

- **[PND-CATEMPH]** (medium, confirmed) — `BarStyle` carries
  `fill` → `hover` → `highlight`, and the **category** path reads none of it:
  `categories` routes through the transposed stacked draw path, whose
  `StackStyle` has only `fills`/`opacity`/`outlineWidth`/`binFills`. The
  _behaviour_ is defensible and arguably the better default — a
  per-category-coloured bar that swapped to one highlight colour would lose the
  meaning its colour encodes. The friction is that **the theme accepts values it
  will not use**: `bar.hover`/`bar.highlight` are typed, settable and documented
  as the emphasis channel, and silently do nothing on the most common categorical
  chart. A theme author sets them, sees no change, and cannot tell whether they
  are wrong about the colour or about the mechanism. There is also no way to
  _tune_ the emphasis that does apply. Ask: give the stacked/category path a
  themed emphasis of its own, so it is expressible where it applies rather than
  only excluded where it doesn't.

- **[PND-TICKUNIT]** (low, **substantially retracted**) — the original claim was
  that nice-tick selection is decimal-only, so a time-like domain must hand-place
  ticks. False: pond already has the duration ladder, and `elapsed.ts` explains
  it in exactly the terms the reporter was reaching for. It was unreachable for
  two composable reasons: the duration ladder is used for `kind: 'time'` (so
  `<ChartContainer origin>` on a value axis relabels but does not re-ladder), and
  a **`bins` array is hard-wired to a value axis**. So feeding a histogram from
  `bins` _guarantees_ the decimal ladder whatever the data means, and the correct
  composition for a time-of-day histogram is a time-keyed wide series
  (`<BarChart series columns>`). What survives is much narrower: nothing at the
  call site says that `bins` selects a value axis, and the natural reading — "I
  have pre-binned buckets, so I'll pass `bins`" — quietly forecloses the time
  axis. Ask: say so in the `bins` prop docs and point a time-bucketed caller at
  the series door; optionally let `bins` carry `kind: 'time'`.

**The unifying finding.** All three render successfully and are simply not what
the caller asked for. Three independent items of that shape in one survey looks
like a theme rather than three coincidences, and argues for **one dev-mode
warning pass** — warn when a multi-group stack is handed a negative, when a theme
sets emphasis slots the active draw path cannot read, when `bins` is handed
plausibly-time-shaped keys — rather than three isolated fixes. Scope that before
building the individual fixes.

### [PND-MULTISEL] — shipped 2026-08-07 (P0/P0/P1; P2 stays [PND-CATRANGE])

The owner's ordered wave, and a deliberate **simplification of the RFC's
model** worth recording because it changed the migration cost.

`docs/rfcs/selection.md` A1.1/A1.4 has the *library* owning the set arithmetic:
`selectionMode: 'replace' | 'add'`, and `onSelect` reporting the resulting set —
which A1.4 flags as a breaking widen of a published prop needing the human gate
plus a one-release shim. The owner's spec inverts it: **the library reports the
hit plus the modifiers; the consumer computes.** Strictly less API, and once
`selected` is widened to a *union* rather than a replacement, the whole wave is
non-breaking. `selectionMode` becomes additive sugar later instead of a gate
now, so nothing in the RFC is contradicted — only deferred.

What shipped:

- **`onSelect(hit, modifiers)`** — `{ additive, ctrlKey, metaKey, shiftKey,
  altKey }`. This is the piece that was actually load-bearing: every consumer
  was hardcoding `additive: false` because it *could not do otherwise*, the
  click having already been reduced to a hit. `additive` resolves the platform
  chord once (⌘/Ctrl) rather than leaving six consumers to get one OS wrong.
  Deliberately **no derived `range` flag** — `shift` is already the
  `regionSelectModifier` drag chord, and an ordinal range gesture is
  [PND-CATRANGE], not a modifier.
- **`selected: SelectInfo | readonly SelectInfo[] | null`**, normalized to an
  array on the (internal, unexported) `ContainerFrame.selected`. Readers ask
  set membership instead of each deciding what a `null` means.
- **`BarStyle.dimmed`** — RFC A2.3's model exactly (theme carries the
  selection-state styling, library references it by state, opt-in so an
  un-themed chart dims nothing).

**Scope limits, both flagged in code and in the PR rather than left to be
found:** `ScatterChart` and `HeatMap` render `selected[0]` — their draw paths
match one mark, so a set lights only its first member there; and `dimmed` is
bars-only. Bars are the reporter's case, so the wave is useful as-is, but a
scatter with two selected points is still visibly wrong.

**A repeat of a known slip, worth naming.** `dimmed` was added to `BarStyle`
and to both draw paths, but not forwarded from `BarChart`'s `stackStyle` — so
it worked on plain bars and silently did nothing on `categories`, the exact
chart it was built for. That is the **second** time this session a new theme
field was wired into one of the two bar paths (the first was [PND-CATEMPH]'s
own `emphasisOpacity`/`selectedOutline`, caught by the Layer-2 review). Both
were caught, both by tests rather than by care. A structural guard — a test
asserting every `BarStyle` colour field is reachable from both the single and
stacked paths — would have caught both and is the obvious next move.

### Not yet scheduled — decided at the regroup

- **[PND-CATRANGE]** (high, predicted) — `cursor="region"` + `onRegionSelect` is
  gated to continuous axes; the 0.53.0 notes state it directly ("a **category**
  axis stays excluded — an ordinal-slot select is a different gesture"). For a
  ranked category chart, dragging across a run of bars is the primary
  interaction: "select the top twelve" is one gesture with a lasso and twelve
  ctrl-clicks without one. The workaround re-implements the inverse of the band
  scale the library already owns and exports, in a second place, so the two can
  disagree about which bar the pointer is on. The gesture genuinely _is_
  different — it snaps to whole slots and should report category names rather
  than a numeric range — but that is an argument for the library owning it, not
  for excluding it; the continuous version already handles drag state, the
  modifier conflict with pan, and one-shot commit on release.

- **[PND-CATSTACK]** (high, predicted) — co-existing segments on the first-class
  category axis (see the un-narrowing note under [PND-BANDBAR2] above).
  `<BarChart categories>` is single-value and `categoryStack` builds a one-group
  `StackedBarSeries`. The workaround is the ordinal-index hack the categorical-axis
  RFC itself names, and it costs label thinning, ellipsis, and the stable
  `SelectInfo.mark` identity. Precedent: pond removed the _same_ workaround for
  horizontal category charts in 0.55.0 ([PND-HCAT]), whose release notes describe
  it in almost these words.

- **[PND-THEMEBASE]** — **DECLINED 2026-08-07 (owner).** Kept here with its
  reasoning so it isn't re-litigated from the report's framing.

  _The report's case:_ `{ ...defaultTheme, bar: …, axis: … }` silently keeps
  pond's default colours in every unspread slot — `#2563eb` across
  `line`/`band`/`area`/`scatter`/`box`, the teal annotation register, a white
  `legend` card and chip. On a dark-panel consumer that is ~20 unreviewed hexes
  in the object whose whole purpose is to be the single colour channel, and
  nothing surfaces them until someone adds a `<LineChart>` and gets brand blue.
  Asked for a structure-only `blankTheme`, or a dev-mode warning naming the
  slots still carrying defaults.

  _Why declined._ **`blankTheme` is incoherent as specified**: a `<LineChart>`
  needs a stroke, so any base ships _some_ palette — "neutral grey" is just a
  different one, not an absence. And **the warning would fire on correct
  usage**: spread-and-override is the designed workflow, not a mistake. Take
  the defaults, change the one or two things that are yours, done — most
  consumers like what they see and want their brand primary on the line and
  nothing else. Scoping the warning to _drawn_ slots narrows the noise but
  doesn't fix the category error: spread the default, override `bar`, add a
  `<BandChart>` later, and you'd be warned for using the API as intended.

  The population this actually bites — a design system that must own every
  colour — is narrow, and is also the population most likely to already own a
  palette lint. This reporter wrote one, and said themselves it was "worth
  having regardless". If you need a full theme top to bottom, owning that is
  the client's job.

  _Considered and also declined:_ shipping the reporter's lint as a helper
  (`inheritedSlots(theme, base)`). Cheap and harmless, but they already have
  it, and a ~20-line test isn't a library's problem to solve.

  _What shipped instead:_ one sentence on `defaultTheme`'s docstring saying
  spreading inherits unoverridden slots and pointing a design-system consumer
  at their own test. That closes the honest half of the complaint ("nothing
  surfaces it") at the weight it deserves.

  _One argument for the item that turned out to be weak_, recorded because it
  was made in this repo and shouldn't be reused: that [PND-BANDBAR2] widened
  the blast radius by adding `theme.bar.bands`. It doesn't, materially — those
  three hexes only render if the caller passes `thresholds`, and a caller who
  opted into banding sees the colours immediately. That is not the
  `line.default` failure mode, which appears in a layer you weren't thinking
  about.

  **Consequence for the dev-warning sweep:** THEMEBASE is out of its scope. The
  sweep is about the genuine silent-failure class — a negative dropped from a
  stack, emphasis slots the active draw path can't read, `bins` foreclosing the
  duration tick ladder — where the library picks a branch the caller cannot
  see. A theme slot the caller declined to set is not that; they made a choice.

- **[PND-BINSWATCH]** (medium, confirmed — the legend rendered near-white squares
  for a yellow and a red series) — `useChartLegend` serves each row a resolved
  `swatch`, and the reason to prefer it over passing colours down is that the key
  then agrees with the plot **by construction**. For a `binColors` layer that
  guarantee does not hold: the row reports the layer's base theme fill. It is
  documented, and defensible for the case it was written for (a red/green volume
  series has no single legend colour); it is wrong for the more common case of a
  layer that is per-bin-coloured because **every bin is the same colour** and
  `binColors` was the only way to express selection dimming. Ask: when every
  entry in `binColors` is equal, report _that_ colour; better, let a layer set
  its legend swatch explicitly.

  **Note how this compounds** — and this is the sharpest structural observation
  in the report: [PND-MULTISEL] forces `binColors` on any chart used as a filter,
  and `binColors` then opts the layer out of themed emphasis ([PND-CATEMPH])
  **and** out of a truthful legend swatch. One missing feature quietly disables
  two others.

- **[PND-TICKCENSUS]** (medium, predicted) — `thinCategoryLabels` keeps every
  `stride`-th tick and drops the rest entirely, tick mark and label together.
  There is a distinction worth preserving between _labelling_ and _counting_: a
  dense axis can only name a fraction of its categories but can still show how
  many there are, and thinning both makes a 400-category axis and a 12-category
  axis look identical. Ask: thin labels, keep ticks — either independent
  label/tick density controls, or a minor/major distinction where minors are
  unlabelled. Adjacent to [PND-CHFRIC]'s existing finding that the thinning
  glyph-width estimate lands on the wrong side at Gallery-card width.

- **[PND-BARCAP]** (low) — a bar drawn as a low-opacity body from the baseline
  plus a bright 2–3px cap at the value, so at high density the caps form a
  legible profile while the bodies stay quiet. The reporter recommends
  **declining** it: it reads as a house mark and two layers compose it
  legitimately. Recorded so that declining is a decision rather than an
  oversight; if it recurs across consumers, an optional cap treatment on
  `BarStyle` is a small addition to an existing slot rather than a new mark.

### What the reporter says pond already does well

Recorded because it is the other half of an honest friction report, and because
each of these directly replaced hand-written code: the categorical x-axis with a
real band scale and per-category colour; **whole-slot hit testing** (0.55.0),
whose absence is exactly the bug hand-rolled charts ship with and patch later
with an ad-hoc click pad; the bar-snapping region cursor with `onRegionSelect`,
including drag-versus-click discrimination; the typed theme's three-step
rest/hover/selected emphasis; `SelectInfo.mark` stable identity that survives a
reorder (hand-rolled charts key on slot index and break on every re-sort); and
canvas rendering with decimation, so density stops being the consumer's problem.

### Shipped 2026-08-06 — the owner's first four groups

Landed together on `claude/pond-charts-friction-545b3b`. Design decisions worth
keeping, beyond what the CHANGELOG records:

**[PND-BANDBAR2] threshold banding.** `<BarChart thresholds>` + `bandColors`,
fills from `BarStyle.bands`.

- **The ladder lives on `BarStyle`, not as a `theme.bar.bands` sibling.** The
  chosen API was described as "`theme.bar.bands`", but `theme.bar` is a semantic
  **map** (`{ default, [semantic]: BarStyle }`) — a top-level key would collide
  with a role of that name and would not typecheck against the index signature.
  Per-role turned out to be the better shape anyway: `bar.default.bands` and
  `bar.capacity.bands` can differ, and the ladder resolves through the same
  `bar[semantic] ?? bar.default` lookup as every other bar colour.
- **Two alternatives declined**: a single self-contained
  `thresholds={[{upTo, color}, …]}` (reads well in isolation, but puts colour
  arithmetic back at the call site, which is what the theme exists to remove),
  and theme-slot-only with no override (no escape hatch for a one-off ladder
  short of wrapping the theme).
- **The perf lesson is the durable part.** The first cut had `bandSpan` return a
  `[lo, hi]` tuple. K tuples per bar per frame was the difference between
  banding measuring **~44% cheaper** than the N-layer workaround and **~44%
  dearer** than it. Split into a scratch-writing `bandSpanInto` with `bandSpan`
  as the allocating wrapper for tests; final numbers are **23–56% cheaper**
  than the workaround across 8–2000 bars, and free when unused.
- **A methodology note worth more than the number.** The first A/B compared a
  freshly-built `dist` against a stashed-build `dist` imported as two separate
  modules, and reported banding as _slower_ at every categorical size. That was
  a confound (two module instances, two independent V8 optimization states);
  re-run single-module and interleaved, the result reversed cleanly and matched
  the in-script bench. When two perf runs disagree, suspect the harness before
  the code — and never ship the flattering one because it agrees with you.
- **Breakpoints are absolute data values, not offsets from the resolved
  baseline** — corrected in review. The first cut measured the ladder from
  `resolveBarBaseline`, so on a domain that excludes zero (`<YAxis min={10}>`)
  a `[1, 2]` ladder silently banded at 11 and 12. A threshold means the same
  thing everywhere else in a dashboard: an absolute value. The bands are now
  computed from zero and the painted span clipped to the bar's drawn extent,
  which leaves the common (baseline 0) case identical and makes the min>0 case
  put the whole bar in the top band, correctly. Worth noting the original had
  a _passing test asserting the wrong behaviour_ — the test encoded the
  implementation rather than the requirement.
- **Deferred:** asymmetric ladders (signed breakpoints). Negatives band
  symmetrically on the magnitude, which covers the ± diverging case; no consumer
  has pulled for asymmetry.
- **`bandAlign` keeps `'center'`/`'end'` by owner decision** (2026-08-06) even
  though only left-packing has a caller: a 3-value alignment enum is a complete
  vocabulary and the extra values share one arithmetic path with `'start'`.
  Recorded so declining to trim it is a decision, not an oversight.
- **A perf-methodology lesson, twice over.** Two successive measurements of the
  same change were wrong in opposite directions — first a cross-module A/B that
  reported banding as slower (two `dist` instances, two V8 optimization
  states), then a table stitched from two pairwise runs that claimed a −40.6%
  win over a figure it was 26% dearer than. The fix is structural: the script
  now interleaves every arm in one harness and prints the ratios itself, so
  there is nothing left to stitch. **When two perf runs disagree, suspect the
  harness before the code, and never publish a number a committed script
  cannot reproduce.**

**[PND-AXISHIDE] `<YAxis hide>`.** Registers the spec with `width: 0` and
returns `null` after the last hook (so toggling `hide` at runtime can't change
hook order). **Gridlines deliberately unaffected** — they belong to the plot,
not the gutter, and `<ChartRow grid>` already governs them, so a hidden axis can
still rule its own gridlines. That is usually what a "the shape matters, the
numbers don't" chart wants.

**[PND-BANDPACK] `maxBandWidth` + `bandAlign`.** On `<ChartContainer>`, since
the band scale is the container's x scale.

- **Deviated from the requested `bandAlign: 'fill' | 'start'`.** `maxBandWidth`
  caps the **slot pitch**, and `bandAlign: 'start' | 'center' | 'end'` places
  the resulting block. There is no `'fill'` member because "fill" is what
  _omitting_ `maxBandWidth` means — a `fill` value alongside a pitch cap is a
  contradiction rather than a choice. The requested behaviour is fully
  expressible; the state space is smaller and has no unreachable combination.
- **`maxBandWidth` caps the slot, `<BarChart gap>` insets the bar.** One knob
  for pitch, one for ink, neither doing the other's job. The report's `gap`
  workaround was inverting an ink knob to get a pitch effect.
- **Not covered: horizontal.** A `orientation="horizontal"` categorical chart
  puts its categories on the **y** axis as unit slots — a different mechanism
  (`ChartRow`'s y scale, not the container's band scale) — and is _not_ capped.
  Flagged in the prop docs and CHANGELOG rather than left to be discovered.
- A story written for this (`StablePitch`) initially violated a real
  constraint: one container shares one category x-scale, so two rows cannot hold
  different category sets — it throws rather than misaligning silently. The
  demo needs two containers, which is also how the live case arrives.

**[PND-SIGNSTACK] / [PND-CATEMPH] / [PND-TICKUNIT] — the misleading trio.**

- **SIGNSTACK is a visible behaviour change**, and deliberately not opt-in: an
  opt-in fix preserves the silent wrongness by default, and a chart currently
  feeding negatives into a multi-group stack is already rendering a wrong
  picture. Three existing tests _pinned the old behaviour_ and were rewritten —
  worth noting, because a suite that asserts a silent-failure mode is part of
  what keeps it alive. An all-positive stack is bit-identical.
- **CATEMPH's fix is narrower than "add an emphasis channel".** The real defect
  was that `bar.hover` / `.highlight` were accepted and ignored, so the fix is
  to _use_ them wherever there is no meaning-carrying colour to destroy — i.e.
  whenever `binFills` is unset. The `binColors` exclusion stays and is now the
  only one; `selectedOutline` + `emphasisOpacity` make the emphasis tunable
  where the fill genuinely cannot change.
- **TICKUNIT shipped as docs only**, matching the retracted entry's narrowed
  ask. `bins` carrying `kind: 'time'` was not built — it is a real design choice
  and no consumer has pulled for it beyond the one that has since been pointed
  at the series door.

**Found in review, and worth recording as a class.** The Layer-2 pass caught
three real defects, two of which are the _same mistake this PR is about_:
`BarStyle.emphasisOpacity` and `.selectedOutline` were added as public theme
fields but wired only into `drawStacks`, so the single-series path accepted and
ignored them — [PND-CATEMPH]'s exact failure shape, reintroduced by the commit
fixing [PND-CATEMPH]. The threshold-baseline bug was the same species: silent,
plausible, wrong only on a domain the author didn't test. A fix for a class of
bug does not immunise its own diff against that class.

**The Codex pass found four more, with zero overlap.** Worth recording because
it is the clearest evidence yet for running both reviewers rather than treating
the second as ceremony:

- **`<YAxis hide>` broke alignment in a multi-row container** (the only HIGH
  across both reviews). The container reserves each axis _column_ at the widest
  across rows, so a hidden axis sharing a column with a visible one is still
  allotted that width — and rendering `null` slid that row's plot left of its
  siblings and the shared x-axis. Fixed by rendering an empty box at the
  reserved slot width, which collapses to zero when the axis is alone in its
  column. **Every one of my tests used a single-row container**; the story that
  does use two rows asserts nothing. The lesson generalises: a prop about
  _layout_ needs a multi-row case, because single-row is the one arrangement
  where layout cannot go wrong.
- **`normalizeThresholds` accepted negative breakpoints**, which the magnitude
  ladder cannot express — `[-2, -1]` painted the whole bar one colour, looking
  deliberate. Now dropped (with `0`) and dev-warned.
- **Two doc passages the code had outgrown** — `thresholds` still documented as
  baseline-relative after the implementation moved to absolute, and
  `<BarChart>`'s JSDoc still saying negative stack segments are skipped and
  diverging stacks out of scope, in the same PR that implemented signed stacks.
  Both would have shipped as confident lies.

Across the two passes: **ten findings, no duplicates.** Claude's clustered on
the diff's internal consistency (inert fields, memo identity, wrong numbers in
prose); Codex's on interaction with surrounding machinery (slot reservation,
input-domain validation, stale neighbouring docs). That split is the reason the
escalation exists, and is worth remembering the next time a medium-confidence
rating looks like a formality.

**Not done: the dev-mode warning sweep.** The report's best structural finding
is that SIGNSTACK, CATEMPH and TICKUNIT share a failure _shape_, arguing for one
warning pass rather than three fixes. Only [PND-BANDBAR2] got dev warnings (short
ladder, no colours, `binColors` conflict, multi-group stack). The sweep across
the rest — warn when a theme sets slots the active draw path cannot read, when
`bins` is handed plausibly-time-shaped keys — is still open and is the highest-
value item left from this report.
