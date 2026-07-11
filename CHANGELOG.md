# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The `@pond-ts` packages — `pond-ts`, `@pond-ts/react`, `@pond-ts/charts`,
`@pond-ts/fit`, and `@pond-ts/financial` — release together under a single `v*`
tag, so this file covers them all. Pre-1.0: minor bumps may include new features
and type-level changes; patch bumps are strictly additive.

[Unreleased]: https://github.com/pjm17971/pond-ts/compare/v0.44.0...HEAD
[0.44.0]: https://github.com/pjm17971/pond-ts/compare/v0.43.0...v0.44.0
[0.43.0]: https://github.com/pjm17971/pond-ts/compare/v0.42.0...v0.43.0
[0.42.0]: https://github.com/pjm17971/pond-ts/compare/v0.41.0...v0.42.0
[0.41.0]: https://github.com/pjm17971/pond-ts/compare/v0.40.0...v0.41.0
[0.40.0]: https://github.com/pjm17971/pond-ts/compare/v0.39.0...v0.40.0
[0.39.0]: https://github.com/pjm17971/pond-ts/compare/v0.38.0...v0.39.0
[0.38.0]: https://github.com/pjm17971/pond-ts/compare/v0.37.0...v0.38.0
[0.37.0]: https://github.com/pjm17971/pond-ts/compare/v0.36.0...v0.37.0
[0.36.0]: https://github.com/pjm17971/pond-ts/compare/v0.35.0...v0.36.0
[0.35.0]: https://github.com/pjm17971/pond-ts/compare/v0.34.1...v0.35.0
[0.34.1]: https://github.com/pjm17971/pond-ts/compare/v0.34.0...v0.34.1
[0.34.0]: https://github.com/pjm17971/pond-ts/compare/v0.33.0...v0.34.0
[0.33.0]: https://github.com/pjm17971/pond-ts/compare/v0.32.0...v0.33.0
[0.32.0]: https://github.com/pjm17971/pond-ts/compare/v0.31.2...v0.32.0
[0.31.2]: https://github.com/pjm17971/pond-ts/compare/v0.31.1...v0.31.2
[0.31.1]: https://github.com/pjm17971/pond-ts/compare/v0.30.0...v0.31.1
[0.31.0]: https://github.com/pjm17971/pond-ts/compare/v0.30.0...3c4e8bd
[0.30.0]: https://github.com/pjm17971/pond-ts/compare/v0.29.0...v0.30.0
[0.29.0]: https://github.com/pjm17971/pond-ts/compare/v0.28.0...v0.29.0
[0.28.0]: https://github.com/pjm17971/pond-ts/compare/v0.27.0...v0.28.0
[0.27.0]: https://github.com/pjm17971/pond-ts/compare/v0.26.0...v0.27.0
[0.26.0]: https://github.com/pjm17971/pond-ts/compare/v0.25.0...v0.26.0
[0.25.0]: https://github.com/pjm17971/pond-ts/compare/v0.24.0...v0.25.0
[0.24.0]: https://github.com/pjm17971/pond-ts/compare/v0.23.0...v0.24.0
[0.23.0]: https://github.com/pjm17971/pond-ts/compare/v0.22.0...v0.23.0
[0.22.0]: https://github.com/pjm17971/pond-ts/compare/v0.21.0...v0.22.0
[0.21.0]: https://github.com/pjm17971/pond-ts/compare/v0.20.0...v0.21.0
[0.20.0]: https://github.com/pjm17971/pond-ts/compare/v0.19.0...v0.20.0
[0.19.0]: https://github.com/pjm17971/pond-ts/compare/v0.18.0...v0.19.0
[0.18.0]: https://github.com/pjm17971/pond-ts/compare/v0.17.1...v0.18.0

## [Unreleased]

## [0.44.0] — 2026-07-11

The **value-axis charts** release: cross-sectional data (a volatility smile keyed
by strike) becomes a first-class charting surface. `ValueSeries.fromColumns` is
the direct columnar door; `<ScatterChart>` and `<BoxPlot>` join `<LineChart>` on
the value axis; `<BoxPlot>` gains range-only (bid→ask) marks, `offset` pairing,
and `capWidth`; and the region cursor works on value axes and snaps to histogram
bins.

### Added

- **`<BoxPlot>` finished for the value axis + range-only marks** (`@pond-ts/charts`).
  Four coordinated changes, driven by the volatility smile's per-strike bid/ask IV
  segments (`docs/notes/vol-smile-followups-2026-07.md` §1):
  - **Accepts a `ValueSeries`** (`series.byValue('strike')` /
    `ValueSeries.fromColumns`) — boxes on a value axis, the same instanceof branch
    as `<LineChart>` / `<ScatterChart>`. The box **width** now comes from neighbour
    spacing for a **point** key (a `ValueSeries`, or a point-keyed `TimeSeries`) —
    like bars/candles — instead of collapsing to the 1px floor; an interval-keyed
    `TimeSeries` still uses its `[begin, end)`.
  - **Optional `q1`/`median`/`q3`** — omit `q1`+`q3` for a **range-only** box: a
    whisker-only `lower→upper` segment, no body (a bid→ask IV mark honestly named,
    not a candlestick abuse). Omitting exactly one of `q1`/`q3` throws.
  - **`offset` prop** (`<BoxPlot>` and `<ScatterChart>`) — a **pixel** shift for
    pairing same-key marks (call/put at one strike) side by side, zoom-stable. On
    the scatter it moves the draw **and** the click hit-test together; on the box
    the readout hit-tests in un-shifted data space (keep the offset small).
  - **`capWidth` prop** (`<BoxPlot>`) — the whisker end-cap width in **pixels**
    (else half the box width). A small fixed cap keeps two `offset`-paired marks'
    T-bars from overlapping when the value-axis slot is wide; clamped to the box
    width, `'whisker'` shape only.
  - **Readout labels** carry the series' `as` identity (`iv upper`, `iv median`)
    when set, instead of bare column names — the `as ?? column` convention
    Line/Scatter already use.
- **`<ScatterChart>` accepts a `ValueSeries`** (`@pond-ts/charts`) — scatter
  marks on the value axis, the same instanceof-branched adapter as
  `<LineChart>` (the container infers the x kind from the data). The
  data-driven `radius` / `color` encodings work unchanged on a value axis;
  the per-point `label` reads through a new columnar branch (a `ValueSeries`
  has no per-row events) — IV marks keyed by strike with open-interest
  radius is the driving composition (vol smile). New value-axis Storybook
  fan-out (`ValueAxis` / `ValueAxisEncoded` / `ValueAxisSmile` /
  `ValueAxisFlag`) + Linux visual baselines.

- **`ValueSeries.fromColumns({ name, schema, columns, sort? })`** (`pond-ts`) —
  the direct columnar door into value-land, for data that is _natively_
  value-keyed (cross-sectional): an options chain keyed by strike, a spectrum
  keyed by frequency. Exact `TimeSeries.fromColumns` contract with the axis in
  place of time — same polymorphic `number[]` / `Float64Array` inputs, same
  zero-copy adoption, same stable opt-in `sort`, same gap rule — the two doors
  share one ingest engine. Previously cross-sectional callers had to launder
  the axis through a fake `time` column (`TimeSeries.fromColumns` +
  `byValue`); that detour is no longer needed.

- **The region cursor snaps to a histogram's bins** (`@pond-ts/charts`). On a
  `<BarChart>` histogram, `cursor="region"` now snaps **bar by bar** with no
  `cursorSequence`: hovering highlights the bar under the pointer, a drag extends
  across whole bars, and `onRegionSelect` reports the selected bin range
  `[lo, hi]` at the bar edges. The bar layer publishes its `[begin, end)` spans
  (a new internal `binIntervals` channel) as the region cursor's snap buckets —
  the same machinery a `cursorSequence` drives on a time axis, so it also covers a
  time-axis histogram. Only a **vertical** bar layer on a continuous (time /
  value) x axis publishes bins; a horizontal chart (value on x) and a categorical
  axis stay freeform / excluded. An explicit `cursorSequence` still takes
  precedence. New `HistogramBins` region-cursor story.

### Changed

- **BREAKING (`@pond-ts/charts`): the region cursor works on a value x-axis, and
  `onRegionSelect` reports a neutral `[lo, hi]` pair.** The drag-select callback
  fired a `TimeRange`; it now fires `readonly [number, number]` in **axis units** —
  epoch ms on a time axis, the axis value (strike, distance, …) on a value axis —
  mirroring the container's polymorphic `range` input (which never takes the axis
  _kind_ from its value). A time-axis consumer that wants a `TimeRange` builds one
  from the pair (`new TimeRange({ start: lo, end: hi })`). The cursor itself is
  ungated from time-only to any **continuous** x-axis (time **or** value; a
  **category** axis stays excluded — an ordinal-slot select is a different gesture).
  Bucket **snapping** stays time-only (a `cursorSequence` bucket is a time
  interval), so a value axis is always **freeform** (hover line + raw-span drag).

## [0.43.0] — 2026-07-11

The **categorical x-axis** release: a first-class ordinal band scale (ticker /
account / expiry on x — the transpose view of a time series), plus the charts
**interaction** wave that landed after v0.42.0 was cut — the region cursor and
its drag-to-select gesture, per-bin band colour, and annotation edges that snap
to session boundaries.

### Added

- **`@pond-ts/charts`: a first-class categorical x-axis.** `<BarChart
categories={[{ label, value }]}>` draws one bar per category on an ordinal
  **band scale** (the transpose view's "columns on x" — ticker / account / zone
  on x). The container infers `xKind:'category'` and builds a `scaleBand` over the
  labels; `<CategoryAxis>` ticks once per category. Colour per category via
  `binColors`; selection reports the category name. **Negative** category values
  draw below the baseline (the P&L / delta case) — a single-series category bar
  honours its sign. New exports `scaleBand` / `ScaleBand`, `CategoryAxis`,
  `categoryStack` / `CategoryDatum`. Additive — a new x-kind alongside time /
  value; existing charts are unchanged. First slice of the categorical-axis RFC
  (`docs/rfcs/categorical-axis.md`, Phase 1).
- **`@pond-ts/charts`: `transposeRow`** — read one **row** of a wide `TimeSeries`
  **across** into `{ label, value }[]` for `<BarChart categories>`: the schema's
  numeric columns (a `pivotByGroup` output's per-group columns, a term
  structure's per-expiry columns) become the categories at one instant. Pick the
  row with `at` (`'last'` — the head/live row — by default; `'first'`, an index,
  or `{ time }`); bound / order the set with `columns`.
- **`@pond-ts/charts`: stable per-column selection identity.** `SelectInfo` gains
  an optional **`mark`** — a stable per-mark identity within a layer. A categorical
  bar reports its **column name** as `mark`, and a controlled `selected` echo /
  the highlight match key on `(id, mark)`, so a pinned selection survives a column
  reorder (the slot index doesn't; the name does). Additive — `mark` is
  `undefined` for a time / value bar (whose sample `key` is already its identity).
  Plus a category-axis **label policy**: a dense axis thins (keeps every k-th) and
  ellipsis-truncates its labels so they stay legible while every bar draws.
- **`@pond-ts/charts`: region cursor (`cursor="region"`).** A shaded **band**
  highlights the bucket under the pointer, bucketed by a new **`cursorSequence`**
  prop — a `Sequence` (`Sequence.every('15m')`, `Sequence.calendar('week')`)
  realized over the view, or a `BoundedSequence` (a `TradingCalendar`'s
  `sessionSequence()` / `barSequence()`) used as-is. The band maps through the x
  scale, so on a trading-time axis the closed part of a bucket collapses (crops
  to live sessions). Time-axis only (a no-op on a value axis). (#409, #413)
- **`@pond-ts/charts`: draggable region cursor → one-shot select.** Opt-in
  **`onRegionSelect?: (range: TimeRange) => void`** makes the region cursor
  draggable: the band extends bucket by bucket and fires **once** on release
  with the selected `[start, end)` `TimeRange` (the cursor doesn't keep it —
  typical use is to zoom the view). With **no `cursorSequence`** it degenerates
  to a hover **line** + **freeform** drag. **`regionSelectModifier="shift"`**
  resolves the gesture conflict with `panZoom` (plain drag pans, shift-drag
  selects); omitted, a region-drag preempts pan. (#416)
- **`@pond-ts/charts`: `binColors` — per-bin colour for single-series bars.**
  `<BarChart binColors={[...]}>` colours each bar/band segment individually (one
  colour per bin, in order), the single-series analog of the stacked `colors`
  prop — used by the category axis (colour per category) and any single-series
  band chart. (#408)
- **`@pond-ts/charts`: annotation edges snap to session boundaries.** When a
  `<ChartContainer>` carries a trading calendar (disjoint x axis), dragging a
  `<Region>` edge (or creating one) snaps to the nearest **session boundary**
  rather than raw wall-clock, so a drawn span aligns with real market sessions.
  (#410)

### Fixed

- **`@pond-ts/charts`: region body-move no longer distorts across a session
  boundary.** On a trading-time (discontinuous) axis, dragging a `<Region>`
  annotation by its body now translates it rigidly in pixel space, so the box
  keeps its width as it crosses a collapsed gap (it previously applied one
  value-delta to both edges, which stretched the box in the different
  rate-contexts either side of a session boundary). No-op on a continuous axis.
  (#405)

## [0.42.0] — 2026-07-10

The **trading-calendar** release: a new `@pond-ts/financial` package (its first
publish) and a discontinuous **trading-time x axis** in `@pond-ts/charts` that
collapses closed-market time (weekends, holidays, overnight, lunch breaks).

### Added

- **`@pond-ts/financial` — new package (first release).** A calendar/analytics
  layer on `pond-ts` (peer dep; ESM, no React; `@js-temporal/polyfill` for
  DST-correct session generation):
  - **`TradingCalendar`** — `fromSessions` (explicit schedule) and `fromRules`
    (weekmask / holidays / early-closes / breaks, DST-correct via Temporal);
    query surface (`sessionOn`, `sessionContaining`, `isOpen`, `sessionsInRange`,
    `nextSession`, `previousSession`).
  - **Bucketing seam** — `sessionSequence()` / `barSequence(period)` return a
    `BoundedSequence` that flows straight through `aggregate` / `materialize`,
    so every bucket is a real trading session/bar (no weekend/holiday buckets,
    no bucket spanning a closure). Zero core edits.
  - **`tagSessions(series, { column?, stamped? })`** — appends a session-id
    column (`number | undefined`) for `partitionBy` so stateful ops don't bridge
    a session boundary. `stamped: 'close'` bins a bar stamped at its close into
    the closing session (`(open, close]`) for OHLC feeds.
  - **`DiscontinuityProvider`** — the d3fc-style 5-method provider
    (`clampUp`/`clampDown`/`distance`/`offset`/`copy` + optional `boundaries`);
    `identityDiscontinuity`, `weekendSkip` (bundled reference), and
    `segmentDiscontinuity(segments, { spacing })`.
  - **`TradingCalendar.discontinuities({ range?, spacing?, period? })`** — the
    chart-ready provider; `spacing: 'proportional'` (default, true-time) or
    `'uniform'` (equal-width per session/bar, the TradingView ordinal look).
- **`@pond-ts/charts`: trading-time x axis.** Pass a `@pond-ts/financial`
  provider (structurally — charts never imports that package) to collapse
  closed-market gaps:
  - **`ChartContainer` `discontinuities` prop** (low-level) and **`calendar` +
    `spacing` props** (high-level sugar; `calendar` is a structural
    `TradingCalendarLike`, `spacing` defaults to proportional).
  - **`scaleTradingTime`** — a d3-scale-shaped discontinuous time scale; ticks
    coarsen to a **calendar grain** (week/month/quarter/year starts) with
    date/year labels, and **session dividers** draw at the collapse points
    (`theme.axis.sessionDivider`), aligned with the labels.
  - `Charts/TradingTimeAxis` stories (weekend/holiday/half-day/intraday,
    continuous-vs-trading, daily-months, proportional-vs-uniform).
- **`@pond-ts/charts`: first-class histograms.** `<BarChart>` gains **stacking**
  — a group-by dimension → stacked segments, from a wide series (`columns`), a
  `Map<group, TimeSeries>` (the `partitionBy().aggregate().toMap()` shape), or a
  `byColumn` `bins` array; per-group colour via `colors` or theme roles — and an
  **`orientation`** prop (`'vertical'` default | `'horizontal'`, bars grow right
  with the bins on a y band axis). New readers `stacksFromGroups` /
  `stacksFromColumns` / `stacksFromBins` plus `StackedBarSeries` / `BinRecord` /
  `Orientation` types. All data generation composes from existing operators
  (`aggregate` / `byColumn` / `partitionBy`); no core changes. Guide: How-to
  guides → Histograms. (#401)
- **`@pond-ts/charts`:** selection now has a stable series identity. `SelectInfo`
  carries an `id`, and `BarChart` / `ScatterChart` take an optional `id` prop —
  the series identity used for selection + hover. An `id` **gates interactivity**:
  a layer is selectable/hoverable only when given one (a layer with no `id`
  renders and reads out but can't be selected). A dev-warning fires when
  `selected`/`onSelect` is wired but no layer carries an `id`. First slice of the
  selection RFC (`docs/rfcs/selection.md`, Amendments 2–3).
- **`pond-ts`: `bin(W, 'minMaxFirstLast')`** — the four-channel M4 downsampling
  reducer (per-bin min/max/first/last, validity-aware, chunked-delegating); the
  foundation for the charts decimator wave.
- **`pond-ts`: `binBy`** — key-domain bucketed reduction (the M4 gappy-data
  decimation path).

### Changed

- **BREAKING (`@pond-ts/charts`):** `SelectInfo` gained a required `id` field
  (`{ id, key, value, color, label }`) — `id` is the selection identity, `key` /
  `value` are now click provenance. Code that constructs a `SelectInfo` by hand
  must add `id`, and selection equality/dedup now keys on `id`, not the sample
  `begin`.
- **BREAKING (`@pond-ts/charts`):** `BarChart` / `ScatterChart` selection now
  requires an explicit `id` prop — the previous implicit `as ?? column` selection
  identity is gone. A selectable bar/scatter layer must add `id` (e.g.
  `<BarChart series={s} column="v" id="v" />`); without it the layer is
  display-only.

## [0.41.0] — 2026-07-06

### Added

- **`@pond-ts/charts`: `<Candlestick>` — a first-class OHLC mark** (Phase 1 of
  the financial-charts RFC, Tidal-driven). `open`/`high`/`low`/`close` props
  default to the conventional names (`<Candlestick series={s} />` for a standard
  OHLCV series); draws-only (body extents derived per-mark); **point- or
  interval-keyed** so raw daily OHLCV feeds straight in (no `aggregate`), while a
  weekly/monthly rollup is the identical call. `variant: 'candle' | 'bar' |
'hollow'`, `colorBy: 'direction' | 'series'`, `gap`, and `showOHLC` (four-pill
  O/H/L/C hover readout; default is a single `close` pill keyed on `as`).
  Participates in the crosshair x-snap (unlike `BoxPlot`). Supersedes `BoxPlot
shape='solid'` for OHLC data.
- **`@pond-ts/charts`: `ohlcFromTimeSeries`** + the `OhlcSeries` / `OhlcColumns`
  types — read four price columns into a chart-ready columnar view (exported
  alongside the existing `*FromTimeSeries` builders).

### Changed

- **`@pond-ts/charts`: `ChartTheme` gains a required `candle` slot** (a
  `CandleStyle`: `rising`/`falling`/`neutral` body+wick pairs, `bodyWidth`,
  `wickWidth`). `defaultTheme` and `estelaTheme` ship neutral, **unbranded**
  up/down pairs — market green/red is a `cssVarTheme` overlay, not a library
  default. **Breaking (type-level):** a hand-built `ChartTheme` that doesn't
  derive from a shipped theme must add a `candle` slot to compile.

## [0.40.0] — 2026-07-05

A **core + charts** release from the estela `DataChart`-port friction wave.
`@pond-ts/react` and `@pond-ts/fit` carry no code changes — republished in
lock-step (peer ranges widen to `^0.40.0`).

### Added

- `pond-ts`: **`TimeSeries.fromColumns({ sort })`** — an opt-in `sort?: boolean`
  (default `false`) that stable-sorts a columnar payload by key before
  construction, the columnar counterpart of `fromJSON`'s `sort`. The default path
  is unchanged: a decreasing key still throws (a backwards key on the trusted fast
  door is a corruption signal, not silently accepted), and the `Float64Array`
  zero-copy adoption is preserved when `sort` is unset. (#344)
- `@pond-ts/charts`: **controlled bar hover** — `<ChartContainer hovered
onHover>`, the transient-hover analog of the existing `selected` / `onSelect`
  pair, keyed by the same `SelectInfo`. Pin a lit `<BarChart>` bar from a legend
  or list row (`hovered`), or mirror a bar-originated hover out-of-band
  (`onHover`); omit both for today's uncontrolled behavior. (#343)

### Fixed

- `@pond-ts/charts`: **axis and layer registration are value-equality-guarded** —
  a fresh-but-value-equal `ticks` / `format` / `byValue()`-projected `series`
  reference no longer re-registers the axis/layer, fixing a "Maximum update depth
  exceeded" loop on frequently re-rendering (scrub-driven) charts. The layer and
  axis docs gain a memoize note for `format` / `series` (an inline `format`
  closure still must be hoisted — a closure can't be value-compared). (#342)

## [0.39.0] — 2026-07-03

A `@pond-ts/charts` release: the **crosshair reticle + annotation-layout** wave,
driven by the Tidal terminal. `pond-ts`, `@pond-ts/react`, and `@pond-ts/fit`
carry no code changes — republished in lock-step (peer ranges widen to `^0.39.0`).

### Added

- `@pond-ts/charts`: **`<ChartContainer crosshairSnap>`** (default `true`) — the
  `cursor="crosshair"` reticle centres on the nearest data point; `false` gives a
  **free** reticle whose horizontal line + value follow the pointer y
  (`yScale.invert`), while the vertical line still snaps its x to the data grid
  for a clean time readout.
- `@pond-ts/charts`: **coincident marker labels merge** — labelled `<Marker>`s at
  the same x fold into one chip (`"a, b, c"`) instead of stacking; their x-axis
  indicator pills dedup to one.
- `@pond-ts/charts`: **x-axis indicator pills lane-stack** when they'd overlap
  (each connector lengthens to its lane).

### Changed

- `@pond-ts/charts`: **`cursor="crosshair"` is now a single reticle** — a
  full-height dashed vertical + full-width dashed horizontal line + a centre dot +
  one value pill, with the time pill connected to the vertical line. (Was
  per-series dots + on-axis pills; the per-series readout stays on `flag` /
  `inline`.)
- `@pond-ts/charts`: top-flag **labels pack per row** — a label only contends with
  labels in its own row's top space (a bottom-row label no longer dodges a
  top-row one at the same x). A dragged mark is excluded from the pack, so static
  marks hold their lanes as it crosses them (no phantom lane swaps). A marker's
  staff now hangs from the top of its (stacked) flag.

### Fixed

- `@pond-ts/charts`: the crosshair x-axis pill and marker pills read the axis's
  own formatter (a value-axis / off-boundary time no longer shows a raw number).
- **Charts — click-to-select an annotation now works while `panZoom` is on.** A
  _selectable but non-editable_ `<Region>` / `<Marker>` (one with no `onChange`)
  lets its press bubble to the plot so a drag can pan _through_ it. The plot
  captured the pointer on press to start the pan, and the browser then retargeted
  the resulting `click` onto the plot (Pointer Events spec: a captured pointer's
  compatibility mouse events fire on the capture target) — silently dropping the
  mark's `onSelectAnnotation`. The plot now **defers** its pan pointer-capture
  until the pointer actually moves past the drag slop, so a click (no drag) leaves
  the pointer on the mark and its select fires, while a press-drag still pans
  through and the tracker still hides once the pan commits. Resolves the
  browser-dependent finding deferred from #308; adds
  `e2e/annotations-panzoom.spec.ts`, the first real-pointer-event behavior e2e for
  the annotation layer. (#309)

## [0.38.0] — 2026-07-03

A `@pond-ts/charts` release: **axis-edge value indicators + the crosshair
cursor** — the ChartIQ / Yahoo-Finance price-tag family, driven by the Tidal
terminal. `pond-ts`, `@pond-ts/react`, and `@pond-ts/fit` carry no code changes —
republished in lock-step (peer ranges widen to `^0.38.0`).

### Added

- `@pond-ts/charts`: **`<YAxisIndicator>` + `createLiveValue`** — a value pill
  pinned to a y-axis edge, decoupled from the series' last point. A `LiveValue`
  `source` updates it at high frequency **without re-rendering the chart** (only
  the subscribed pill repaints). Props: `value` / `source`, `axis`, `side`,
  `color`, `format`, `line` (dashed guide), `pointer` (callout triangle).
- `@pond-ts/charts`: **`cursor="crosshair"`** `CursorMode` — a synced vertical
  line + per-series dots, each series' value pinned to its y-axis and the hovered
  time pinned to the x-axis.
- `@pond-ts/charts`: **`indicator`** opt-in on `<Baseline>` (a y-axis value pill)
  and `<Marker>` (an x-axis time pill, with a connector down to the mark).
- `@pond-ts/charts`: `<Baseline labelSide>` (`left` / `right`) + `labelPosition`
  (`center` on the line / `above` it) for the near-line label chip.
- `@pond-ts/charts`: `<Region edges>` (default `true`; `false` = shaded fill with
  no side outlines).
- `@pond-ts/charts`: `axisPillStyle`, `contrastText`, `pointerStyle` chip helpers
  are exported.

### Changed

- `@pond-ts/charts`: axis indicator pills are **solid** (colour fill +
  auto-contrast text), aligned to the tick-label row, and **always show the axis
  coordinate** — never a custom label (a label stays the in-plot chip).
- `@pond-ts/charts`: cursor flag / inline chips now have **square corners**; the
  cursor **time** atop a flag stack renders as plain text (no chip background).
- `@pond-ts/charts`: Storybook reorganized into a feature-axis reference tree with
  systematic per-prop coverage (dev-only; stories are excluded from the package).

### Fixed

- `@pond-ts/charts`: the crosshair x-axis pill used the container's time formatter
  (showing a raw number on a value axis) — it now uses the axis's own resolved
  formatter, matching the ticks. The crosshair also no longer double-renders the
  time (a stray per-row chip alongside the x-axis pill).

## [0.37.0] — 2026-07-02

A `@pond-ts/charts` release: the axis wave — label, tick, and domain controls
driven by the Tidal terminal's friction. `pond-ts`, `@pond-ts/react`, and
`@pond-ts/fit` carry no code changes — republished in lock-step (peer ranges
widen to `^0.37.0`).

### Added

- **Charts — axis title typography (`theme.axis.title`).** The rotated y-axis
  title now renders a touch larger than the ticks by default and is fully
  themeable (`{ color, size, opacity }`, shared with the x-axis label). (#318)
- **Charts — `YAxis labelPlacement`.** `'rotated'` (default) or `'top'` — a
  horizontal title above the axis, aligned to the axis line, in a reserved
  header band that clears the top tick. (#318, #320)
- **Charts — `XAxis align`.** `'center'` (**new default**), `'auto'` (previous
  behaviour: centred but first/last end-anchored), or `'right'` (label beside an
  extended tick). (#318)
- **Charts — `YAxis pad`.** Fractional headroom added to each side of the
  resolved domain (`0` default) — lifts a tight domain off the plot edges
  without hand-computing bounds. (#319)
- **Charts — `YAxis boundaryLabels`.** `false` drops the top & bottom tick
  numbers (gridlines stay) for stacked layouts where the edge labels crowd. (#319)
- **Charts — new `Charts/Axes` Storybook gallery** covering the above. (#318)

### Changed

- **Charts — domain-extreme y-tick labels now clamp inside the row** instead of
  half-overflowing the top/bottom edge (resolves Tidal friction F-charts-6). (#319)
- **Charts — `XAxis` tick-label default is now `'center'`** (was the
  end-anchored `'auto'`). Pass `align="auto"` for the old behaviour. (#318)

## [0.36.0] — 2026-07-02

A `@pond-ts/charts` release: a CSS-custom-property → theme bridge so a canvas
chart can follow a design system's tokens and dark/light toggle. `pond-ts`,
`@pond-ts/react`, and `@pond-ts/fit` carry no code changes — republished in
lock-step (their `pond-ts` / `@pond-ts/react` peer ranges widen to `^0.36.0`).

### Added

- **Charts — `cssVarTheme(base, resolve, opts?)`.** Builds a `ChartTheme` by
  overlaying CSS custom properties onto a base theme: a typed `resolve`
  receives a `readVar` and returns only the slots to override. An unresolved
  var keeps the base value (a missing token never blanks a colour). DOM-only by
  design; safe under SSR / worker (returns the base + any literal fallbacks).
  The typed `ChartTheme` stays the single styling channel — this generates it
  from CSS rather than adding a second one. (#315)
- **Charts — `useChartTheme(base, resolve, opts?)`.** Wraps `cssVarTheme` and
  re-resolves on a `data-theme` / `class` change (a `MutationObserver` on the
  root, configurable via `{ target, attributes }`), so a chart follows
  dark/light with the page — no `mode` prop threaded through. Returns a new
  theme reference only when the resolved theme actually changed (the repaint
  signal `ChartContainer` keys on), so an unrelated attribute toggle doesn't
  repaint. Lives in `@pond-ts/charts` (not `@pond-ts/react`) to keep the
  package graph acyclic. (#315)
- **Docs — charts recipes.** [Theming charts](https://pjm17971.github.io/pond-ts/docs/recipes/theming)
  (the `ChartTheme` model, semantic identifiers, per-series dash, the CSS-var
  bridge), [Using @pond-ts/charts](https://pjm17971.github.io/pond-ts/docs/recipes/using-charts)
  (install, the Storybook `react-docgen` gotcha, the repaint contract,
  in-dev consumption), and
  [Resizable multi-panel layout](https://pjm17971.github.io/pond-ts/docs/recipes/resizable-panels).
  (#314, #315, #316)

## [0.35.0] — 2026-07-02

A `@pond-ts/charts` release: per-series line dash patterns. `pond-ts`,
`@pond-ts/react`, and `@pond-ts/fit` carry no code changes — republished in
lock-step (their `pond-ts` / `@pond-ts/react` peer ranges widen to `^0.35.0`).

### Added

- **Charts — per-series line dash (`LineStyle.dash`).** A theme's line style
  accepts an optional `dash?: readonly number[]` — a px on/off pattern
  (`[6, 4]` dashed, `[2, 3]` ≈ dotted; omit or `[]` = solid) applied to the
  series stroke. Lets a theme set a **modeled / forecast** line (e.g. GARCH
  vol) apart from an observed one at a glance. Distinct from a `GapMode`'s
  inferred gap-bridge dashing (which marks _missing data_, not the whole
  line). Additive: existing themes are unaffected; a solid line never touches
  `setLineDash`. New `Charts/LineChart → LineStyles` story. (#313)

## [0.34.1] — 2026-07-01

A `pond-ts` core patch: fixes a performance regression introduced in 0.34.0.
`@pond-ts/react`, `@pond-ts/charts`, and `@pond-ts/fit` carry no code
changes — republished in lock-step; their `^0.34.0` peer ranges already
admit this patch.

### Fixed

- **`TimeSeries.fromColumns` — `number[]` column conversion was ~7-18x
  slower than intended.** The `null`/`NaN`-gap parity fix in 0.34.0
  converted `number[]` columns via `Float64Array.from(raw, mapFn)`.
  Supplying a map function forces V8's generic iterable-protocol path even
  for a plain array, dramatically slower than a manual loop into a
  preallocated buffer at 100k-element scale. Found while pointing the
  `pond-columnar-ingest` wire-format spike at the real published package
  instead of a local build. Fixed with a manual `for` loop in both the
  key-column and value-column conversion paths — no behavior change, same
  gap semantics, all 12 `fromColumns` tests unchanged and green. Added
  `scripts/perf-from-columns.mjs` as the durable regression benchmark.
  Measured: 100k × 7 cols, `number[]` columns, dense — 21.5ms → 2.9ms.
  (#311)

## [0.34.0] — 2026-07-01

A `pond-ts` core release: the columnar/typed-array ingress driven by the
Tidal wire-format spike. `@pond-ts/react`, `@pond-ts/charts`, and
`@pond-ts/fit` carry no code changes — republished in lock-step (their
`pond-ts` / `@pond-ts/react` peer ranges widen to `^0.34.0`).

### Added

- **`TimeSeries.fromColumns`** — the columnar (struct-of-arrays) ingress,
  the counterpart to `fromJSON`'s row-tuple shape. Accepts either a plain
  `number[]` or a `Float64Array` per column — one polymorphic door, so a
  wire format only changes the _decoder_, not the ingest. `Float64Array`
  columns are adopted directly (zero-copy); `number[]` columns are copied.
  A `null`/`undefined` cell or a non-finite value (`NaN`/`Infinity`) is a
  gap, identically across both input shapes. Enforces the same
  non-decreasing key-order invariant as `fromJSON`. v1 scope: a `time`-kind
  key and `number` value columns. (#310)

  Measured against a wire-format spike (`tidal-app/pond-columnar-ingest`):
  `fromColumns` collapses the ingest step that every non-rows path
  previously paid (transpose → `fromJSON`) — 100k-point protobuf ingest
  27.7ms → 2.8ms; JSON-columnar 27.0ms → 5.2ms. In a browser, decoding
  off-main in a Web Worker and transferring the resulting `Float64Array`s
  back keeps `fromColumns`'s adopt path on the main thread to ~9ms,
  dropping a 500k-point ingest's worst animation-frame stall from ~50ms to
  ~9ms.

- **Docs** — a "Columnar ingest" section on the
  [Creating series](https://pjm17971.github.io/pond-ts/docs/start-here/creating#columnar-ingest)
  page covering both input shapes, the adopt-vs-copy/aliasing distinction,
  missing-value and ordering semantics, and why this matters for
  interactive charts; a pointer from Getting Started.

## [0.33.0] — 2026-06-30

A `@pond-ts/charts` release: a label opt-out for annotations plus interaction
fixes from an adversarial review of the #306 annotation system. `pond-ts`,
`@pond-ts/react`, and `@pond-ts/fit` carry no code changes — republished in
lock-step (their `pond-ts` / `@pond-ts/react` peer ranges widen to `^0.33.0`).

### Added

- **Charts — annotation label opt-out.** `<Region>`, `<Marker>`, and
  `<Baseline>` accept `label={false}` (or `label=""`) to render **no label
  chip** — for an inert background mark (e.g. a `selectable={false}` highlight
  band) where the auto-label would only show a raw axis value. Omitting `label`
  still auto-labels; a string still renders it. `label` widens to
  `string | false`. New `Highlight` story + Linux e2e baselines for the
  `Annotations` stories. (#308)

### Changed

- **Charts — `<Region>` / `<Marker>` / `<Baseline>` with `label=""` now render
  no chip** (previously an empty, zero-width chip). The label-less path; pass a
  non-empty string for a visible label. (#308)

### Fixed

- **Charts — annotation edge-resize no longer inverts.** Dragging a `<Region>`
  edge past the opposite one previously reported `{ from > to }`; it now pivots
  around the fixed opposite edge, so the reported span stays ordered and a drag
  either way re-opens the region instead of dead-ending at zero width. (#308)
- **Charts — annotation drag releases on `pointercancel`.** A system gesture
  takeover (which fires `pointercancel`, not `pointerup`) no longer leaves a mark
  stuck mid-drag. (#308)
- **Charts — single-annotation edit exits on an empty-plot click** even when the
  mark is `editing` but not `selected`. (#308)

## [0.32.0] — 2026-06-29

A `@pond-ts/charts` release: value-axis support across the fill/bar layers, plus
explicit y-axis ticks and the annotation primitives. `pond-ts`,
`@pond-ts/react`, and `@pond-ts/fit` are unchanged this cycle — republished in
lock-step at the same version.

### Added

- **Charts — explicit y-axis ticks.** `<YAxis ticks={[{ at, label }]}>` places
  ticks (and their gridlines) at chosen values with custom labels, mirroring
  `<XAxis ticks>`; `ticks={[]}` draws none. (#303)
- **Charts — value-axis (`ValueSeries`) support for `<AreaChart>`,
  `<BandChart>`, and `<BarChart>`.** Each now accepts a `ValueSeries`
  (`series.byValue('dist')`) and plots against its monotonic value axis
  (distance, cumulative work, …), not just time — joining `<LineChart>`, which
  already did. The container infers the x-axis kind from the data, so there is
  no axis-type prop. `BarChart` derives each bar's span from neighbour spacing
  on a point-keyed value axis (the splits/laps case). (#304, #307)
- **Charts — annotations: `<Region>`, `<Marker>`, `<Baseline>`.** User-authored
  marks in a distinct register — a shaded x-span, a vertical x line, and a
  horizontal value line — with flag labels, a three-level depth ramp, and opt-in
  interaction modes (inspect-select, single-edit, drag-resize, create-tool
  gestures) coordinated by the container (cross-row guide lines,
  snap-to-guideline, z-order). Adds `ChartContainer` annotation props
  (`creating` / `editAnnotations` / `onCreate` / `onSelectAnnotation` /
  `onHoverAnnotation` / `onEditAnnotation` / `snap`) and a `ChartTheme.annotation`
  depth theme. (#306)

### Changed

- **Charts — the fill/bar layer `series` prop widens (additive).**
  `AreaChartProps` / `BandChartProps` / `BarChartProps` now accept
  `TimeSeries | ValueSeries`; the new second generic defaults, so existing
  one-type-argument uses (`AreaChartProps<S>`, `<AreaChart<S>>`) compile
  unchanged. (#304, #307)

## [0.31.2] — 2026-06-29

### Fixed

- **`pond-ts` column methods survive consumer tree-shaking.** The column-API
  methods (`hasMissing`, `at`, `min`, `slice`, …) are mounted onto the column
  prototypes by a side-effect module (`dist/column.js`); the previous
  `sideEffects: ["./dist/column.js"]` per-file glob was dropped by some bundlers
  (notably Rollup production builds under pnpm), so
  `series.column('x').hasMissing()` could throw in production. `pond-ts` now
  declares `sideEffects: true`, matching the other `@pond-ts` packages — robust
  regardless of bundler or symlink layout, at the cost of whole-package
  tree-shaking (the column prototype augmentation makes that unsafe anyway).
  (estela#98.)

## [0.31.1] — 2026-06-28

### Fixed

- **`@pond-ts/charts` and `@pond-ts/fit` now ship their own README** on npm.
  0.31.0 inadvertently published the `pond-ts` core README on every package
  (each `prepack` copied the repo-root README); charts and fit now carry their
  own. No code or API changes.

## [0.31.0] — 2026-06-28

First published release of **`@pond-ts/charts`** and **`@pond-ts/fit`** (both were
previously `private`). All four packages — `pond-ts`, `@pond-ts/react`,
`@pond-ts/charts`, `@pond-ts/fit` — now release together, lock-step, under one
`v*` tag.

### Added — `pond-ts` (core)

- **`ValueSeries` + `TimeSeries.byValue(axis)` — the value axis as a closed
  type.** `byValue` re-keys a series onto a monotonic non-time **value axis**
  (distance, cumulative work, …), returning a `ValueSeries` — the value-keyed
  counterpart of `TimeSeries`. It carries the ordering-based operators
  (`axisValues`, `axisAt`, `column`, `nearestIndex`, `sliceByValue`); the
  calendar/clock operators are deliberately absent — a value axis has no
  wall-clock semantics, and the disjoint `ValueSeriesSchema` makes them
  type-impossible. The axis must be **defined, finite, and non-decreasing at
  every row** (it becomes the index); it is dropped from the value columns (it
  is now the key) and the rest reshare zero-copy. Substrate: a new `'value'`
  `KeyKind` + `ValueKeyColumn`. Projection is O(N + C); `nearestIndex` is
  O(log N); `sliceByValue` is O(log N + C) zero-copy. (value-axis RFC Phase 1.)
- **`scan(source, step, init, options?)` — typed-accumulator running fold.** The
  general form of `cumulative` (the classic `mapAccumL`): the accumulator `A`
  (any value, seeded from `init`) is **decoupled** from the numeric `output` and
  the output column. `step(acc, value, i)` returns `[nextAcc, output]`. With no
  `options.output` the source column is **replaced** in place (as `cumulative`
  does); with `options.output` a **new** column is appended and the source is
  left intact. Missing-cell carry, stored-`NaN`, and multi-entity semantics are
  inherited from `cumulative` (scope per entity with
  `partitionBy(col).scan(...).collect()`). Column-native, O(N + C), no event
  materialization. Enables `split = scan + byColumn` — materialize cross-bin
  state (e.g. hysteresis elevation gain) into a column, then segment it with
  `byColumn`'s pure, order-free reducers. (estela F-geo-2-splits; value-axis
  RFC wave lead.)

### Added — `@pond-ts/charts` (initial release)

- **First public release.** A React charting layer over pond-ts — a canvas data
  plane with SVG interactive overlays. `ChartContainer` / `ChartRow` / `Layers`
  composition; `LineChart`, `AreaChart`, `BarChart`, `Scatter`, `BoxPlot`;
  `TimeAxis` / `YAxis` / `XAxis` (time **and** value x-axes); the cursor system
  (staffed flag, per-row cursor modes); shared gap-rendering modes; and the
  estela theme. Peer-depends on `pond-ts`, `@pond-ts/react`, and React 18/19.

### Added — `@pond-ts/fit` (initial release)

- **First public release.** A fitness / activity domain library over pond-ts — the
  `Activity` / `Section` façade, unit-safe quantities (`Distance` / `Speed` /
  `Power` / … with `.format()`), geo / power / zones analytics, `Profile` +
  `usingProfile()` → `ProfiledActivity` / `ProfiledSection`, and the `Track`
  value object. Façade-first: one curated flat barrel, with the functional
  operator surface kept internal. Peer-depends on `pond-ts`.

### Changed

- **All `@pond-ts/*` peer / dependency ranges widened to `^0.31.0`** for the
  lock-step release.

## [0.30.0] — 2026-06-17

### Added

- **`rollingByColumn(col, { radius, at }, mapping)` — evaluate at explicit
  centers.** `at` takes a **non-decreasing** array of center values (e.g. a chart's
  coarse display grid) and returns **one record per center**, instead of the
  default one-per-row. A center with no rows within `±radius` yields each
  reducer's empty value. Same O(n + centers) two-pointer. Closes the
  evaluate-at-grid gap surfaced adopting `rollingByColumn` for a chart variance
  band. (estela F-rolling-by-row.)
- **`smooth(col, 'movingAverage' | 'loess', { …, missing: 'skip' })` —
  validity-respecting smoothing.** By default (`missing: 'bridge'`) a cell whose
  own value is missing is still assigned a smoothed value from its present
  neighbours — the line is drawn _across_ the hole. `missing: 'skip'` keeps a
  missing cell **missing** in the output, so a sustained dropout (a coast, a
  sensor gap) is preserved as a break rather than fabricated through. Present
  cells smooth over only the present values in their window either way. `ema`
  takes no `missing` option (it is causal and never fabricates across a gap). A
  `maxGap` hard segment boundary is a deferred follow-on. (estela
  F-smooth-interactive.)

### Changed

- **`byColumn(…, { inclusive: '(]' })` floor edge is now inclusive.** Under
  `'(]'`, interior bins stay upper-inclusive (`(eᵢ, eᵢ₊₁]`) but the **floor `e₀`
  is inclusive** (bin 0 is `[e₀, e₁]`), so a value at exactly the minimum edge —
  e.g. a `0` W coast/stop sample at a zone floor of 0 — lands in bin 0 instead of
  being dropped (the `include_lowest` convention). Previously the floor was
  exclusive. (estela F-inclusive-floor.)

## [0.29.0] — 2026-06-17

### Added

- **`byColumn({ edges, inclusive })`** — `inclusive: '(]'` makes edge bins
  upper-inclusive (`(eᵢ, eᵢ₊₁]`), for Coggan power / HR zones where a sample on a
  zone's top edge belongs to the lower zone (the first edge becomes an exclusive
  floor). Defaults to `'[)'` (unchanged — lower-inclusive `[eᵢ, eᵢ₊₁)`). (estela
  F-geo-2 zone inclusivity.)
- **`'mean'` reducer alias for `'avg'`** — `'mean'` is now an accepted built-in
  reducer name across `aggregate` / `rolling` / `byColumn` / `rollingByColumn` /
  `reduce` (and the live equivalents), at **both runtime and the type level**: it
  resolves to the `avg` kernel and classifies as numeric output
  (`number | undefined`), exactly like `'avg'`. Matches the column API's
  `Float64Column.mean()`. (estela F-reducer-naming.)

### Fixed

- **`RowForSchema` honors `required: false`** — a **value** column declared
  `required: false` now accepts `undefined` in its tuple-row cell at the type
  level (matching the runtime, which records it as missing), so optional cells no
  longer need an `as never` cast. The **key (first) column stays required** even
  if marked `required: false` (the constructor always requires it). `null` is
  still not admitted for tuple rows (only the JSON object-row path takes `null`).
  Correspondingly, **`.rows` / `toRows()` now type an optional cell as
  `… | undefined`** (`NormalizedRowForSchema`), so reading a possibly-missing
  cell is no longer unsoundly typed as present — a type tightening on output for
  schemas that use `required: false`. (estela F-geo-row-optional; Codex-hardened.)

## [0.28.0] — 2026-06-17

### Added

- **`TimeSeries.rollingByColumn(col, { radius }, mapping)` — windowed value-axis
  aggregation.** The sliding-window sibling of `byColumn`: slides a centered
  `±radius` window along a **non-decreasing** numeric column and reduces it at
  every row, returning one record per row (positionally aligned with the
  series). Where `byColumn` collapses rows into disjoint value-bins (the
  value-axis analogue of `aggregate`), `rollingByColumn` is the value-axis
  analogue of `rolling`. Built for windowed-percentile bands over a derived axis
  (e.g. a spread band over cumulative distance). A missing/non-finite axis row is
  excluded from every window and emits each reducer's empty value. O(n) two-pointer
  sweep. See `docs/notes/rolling-by-column.md`.
- **`TimeSeries.withColumn(name, values)` — attach a computed numeric column.**
  Appends a `Float64Array` / `(number | undefined)[]` as a new `number` column
  (the schema type widens to include it), so a derived array — cumulative
  distance, speed, gradient — can re-enter the pond pipeline as a real column
  that `aggregate` / `byColumn` / `rollingByColumn` / `column(name)` can
  reference. Existing key + value columns are shared by reference (zero-copy);
  only the new column is added. `values` must match `series.length`; defined
  cells are validated against the numeric intake contract (**non-finite is
  rejected** — pass `undefined` for a missing cell, not `NaN`).

### Added

- **`TimeSeries.byColumn(col, { width, origin? } | { edges }, mapping)` —
  value-axis aggregation.** Where `aggregate` buckets the temporal key,
  `byColumn` buckets rows by the **value** of a numeric column and reduces each
  bin, returning an ordered array of `{ start, end, ...aggregates }` records
  (one per bin) — not a `TimeSeries`, since value-bins (distance / power ranges)
  aren't time-indexed. `{ width }` gives even bins emitted contiguously from the
  lowest to highest occupied bin (monotonic source → splits / profile;
  non-monotonic → histogram); `{ edges }` gives explicit ascending bins (e.g.
  power zones). Reuses the reducer mapping + non-finite policy. Rows whose bin
  value is missing / non-finite (or, for `edges`, out of range) are dropped;
  empty bins emit the reducer's empty value; a non-finite / wrong-kind reducer
  result throws `ValidationError`. See `docs/notes/bycolumn-value-axis.md`.

### Changed

- **`rolling(...)` now builds its output columns directly instead of
  materializing events.** The rolling family was the last batch operator still
  assembling a row per event and re-validating/re-packing it through the
  constructor; it now reads the key axis and source values straight off the
  columnar store and writes the result columns via trusted construction. The
  result is unchanged for the common (scalar) cases. Measured: `rolling` with
  `avg`/`sum` ~2.2–2.7× faster; rolling `stdev` on 100k events ~3.3–7.3×
  (a 1-event window 45.7 ms → 6.3 ms); partitioned rolling ~1.8×.
  `baseline` / `outliers` (which delegate to `rolling`) inherit the speedup.
  - **Behavior note — `array` columns:** an identity-comparing reducer (`keep`,
    or a custom reducer using `===` on the cell) on an `array`-kind source
    column now compares the value stored in the column, not the original object
    reference passed at construction. Two rows given the _same_ array object
    therefore read as distinct. Scalar columns (number / string / boolean) are
    unaffected. A non-finite or wrong-kind reducer result is still rejected with
    a `ValidationError`, exactly as the constructor's intake did.

## [0.25.0] — 2026-06-15

### Changed

- **Reducers now treat non-finite numerics (`NaN` / `±Infinity`) as missing —
  they are skipped — uniformly across every built-in reducer and all four
  execution paths (`reduce`, the columnar fast path, `aggregate`/bucket, and
  `rolling`/live).** Previously the paths disagreed on non-finite input: e.g.
  `min`/`max` returned a position-dependent wrong extreme on the batch/columnar
  paths but the true extreme on aggregate/rolling; `sum`/`avg` propagated
  `NaN`. Non-finite can't enter via the row API (intake rejects it) — it only
  arises inside computed columns (`cumulative` overflow, `diff`/`rate`
  overflow, `collapse`, trusted construction) — so this only changes results
  for those degenerate values, and makes every path agree. The three-layer
  contract: **intake** stays strict (rejects non-finite), **computed writers**
  stay permissive (pack honest non-finite), **reducers** are robust (skip it).
  A standing parity-matrix test now pins all paths together. See
  `docs/notes/reducer-nan-policy.md`. This also resolves the `aggregate('stdev')`
  divergence class and the `min`/`max` NaN-laundering bug.
- Internal: `Float64Column` gained an `allFinite` fast-path flag (data-derived
  at construction, conservative-by-default) so reducers skip the per-element
  finite check on provably-finite columns — keeping the policy's cost off the
  hot path (min/max/count stay at their pre-policy speed).

### Fixed

- **`rolling(window, { x: 'stdev' })` is now numerically stable.** It was the
  last batch stdev path still on the one-pass `Σx²/n − mean²`, which cancels
  catastrophically on near-equal large values (`[1e10, 1e10+1, …]` → `0`
  instead of ≈1.118, or a negative variance → `NaN`) and drifts on trending
  data (cumulative distance, elevation). It now uses Welford's online variance
  with an order-independent **delete** — deviation-space, so no cancellation,
  and removal **by value**, which keeps it correct under the live layer's
  `reorder`-mode eviction (a positional/FIFO remove would have broken it; the
  documented "stdev is reorder-safe" contract is preserved). Rolling-stdev
  values shift in the last ULPs (now correct); the path stays O(1) and within
  run-noise of the old one-pass, and a single-element window now reports exactly
  `0` at any magnitude. Like any subtractive sliding variance, evicting an
  outlier far outside the residual spread loses precision — negligible until the
  evicted point is ~1e7–1e8× the residual stdev, far beyond realistic data.
- A standing differential-fuzz parity suite now pins every built-in reducer's
  execution paths (columnar fast path vs `bucket` vs `rolling`, and the FIFO
  sliding window vs a from-scratch recompute) against silent drift across
  randomized magnitudes and window sizes — the class of bug behind the stdev
  and `min`/`max` divergences.

## [0.24.0] — 2026-06-14

### Changed

- **`TimeSeries.timeRange()` is now a columnar key-axis read instead of a
  reduce over materialized events.** Behavior is unchanged, but the old
  implementation materialized every `Event` on its first call — and because
  `aggregate()` defaults its `range` to `series.timeRange()`, a one-shot
  `aggregate()` paid full event materialization before the columnar fast
  path could run, erasing the win. The new path reads the key column's
  begin/end axis directly: O(1) for time-keyed series, a typed-array scan
  for range/interval-keyed series, with no event materialization. Measured
  on 1M rows: `timeRange()` itself ~407 ms → ~0.002 ms (time-keyed); cold
  `aggregate()` with a defaulted range ~387 ms → ~6 ms (~63×). Every
  `timeRange()` / `overlaps` / `contains` / `intersection` caller benefits.
  (Audit v2 §3.3.)
- **`aggregate()` now takes the columnar fast path when a mapping mixes
  numeric reducers with `first` / `last`.** Previously a single `first` or
  `last` column (they have no numeric `reduceColumn`) bailed the entire call
  to the row path. They now qualify via a boundary scan — the first/last
  _defined_ cell, on any column kind. Behavior is unchanged. The big
  beneficiary is **partitioned `aggregate`**, which auto-injects a `'first'`
  reducer for the partition column and so was excluded from the fast path on
  every call (audit v2 §3.2/§3.3). Measured on 1M rows, flat
  `{ cpu: 'avg', host: 'first' }`: ~37.7 ms → ~4.8 ms (~7.8×); the
  pure-numeric path is unchanged. (The remaining `partitionBy` materialization
  cost is addressed separately by the columnar `partitionBy` split.)
- **`partitionBy(...)` now splits the columnar store directly instead of
  materializing events.** `collect()` / the per-partition sugar methods
  (`fill` / `diff` / `rolling` / …) and `toMap()` previously walked
  `this.events` to bucket rows, then rebuilt each partition via `fromEvents`
  (re-validating + re-packing) — silently re-paying the event-materialization
  tax the columnar wave removed, and making `partitionBy(host).fill().collect()`
  the #1 batch hotspot. They now group row indices off the store and gather
  each partition via a zero-materialization columnar selection. Behavior is
  unchanged (partition order, the `' undefined'` missing-key bucket, composite
  keys, and declared `groups` all preserved). Measured on 100k rows / 64
  partitions: `toMap()` ~389 → ~25 ns/row (~15×, no event materialization at
  all); `diff().collect()` ~2×; `fill(hold).collect()` ~1.7× (the residual is
  `TimeSeries.concat` still materializing to re-sort — a separate follow-up).
  Declared-`groups` membership is validated by the same columnar scan, so that
  path is materialization-free too (~331 → ~33 ns/row). **Behavior note:**
  per-partition sub-series from `toMap()` / `apply()` now lazily materialize
  their own `Event` objects rather than reusing the source's instances — cell
  values are identical; only object identity differs (`collect()`, which
  returns the source unchanged, is unaffected). (Audit v2 §3.2.)

## [0.23.0] — 2026-06-13

### Added

- **`new TimeSeries({ …, sort: true })` (and `TimeSeries.fromJSON`) sort rows by
  key on construction.** Pond requires rows in non-decreasing key order and
  throws otherwise; `sort: true` accepts unsorted input (messy CSVs, merged
  sources) and sorts it for you instead of forcing a manual pre-sort. The sort
  is **stable** — rows with equal keys keep their input order — matching what
  `TimeSeries.fromEvents` already does. The out-of-order error now names the
  option. (Audit v2 §5 F3.)

### Changed

- **CommonJS consumers now get a clear error instead of
  `ERR_PACKAGE_PATH_NOT_EXPORTED`.** Both `pond-ts` and `@pond-ts/react`
  add a `require` condition to their `exports["."]` map pointing at a tiny
  shipped CJS stub that throws an ESM-only message naming `import` as the
  fix. The packages remain ES-module-only; this only improves the error a
  `require('pond-ts')` caller sees. (Audit v2 §5 F6/F7/F9/F10/F11)
- **Published tarballs no longer ship `*.js.map` / `*.d.ts.map` source
  maps.** The maps referenced a `../src` tree that was never included in
  the tarball (`files: ["dist", …]`), so they were dead weight (~⅓ of the
  unpacked size). A `prepack` step now strips them from the published
  artifact for both packages; local `npm run build` still emits them, so
  in-repo debugging is unaffected. (Audit v2 §5 F6/F7/F9/F10/F11)

### Fixed

- **Shipped `.d.ts` now type-check under `skipLibCheck: false`.** The internal
  `EMITS_EVICT` marker symbol was `@internal` (stripped from the emitted
  `series.d.ts`) but still referenced by un-stripped public declarations — a
  by-name re-export in `schema/index.d.ts` and the `[EMITS_EVICT]` brand members
  on `LiveSeries` / `LiveView` — leaving dangling references that broke strict
  consumer builds with **TS2305**. Those references are now `@internal` too, so
  the symbol is fully stripped from the published types; runtime behavior is
  unchanged. (Audit v2 §5 F2.)
- **`TimeSeries.at(-1)` counts from the end**, matching `LiveSeries.at` and
  `Array.prototype.at` (it previously returned `undefined` for any negative
  index). Deep underflow (e.g. `at(-100)` on a 3-event series) still returns
  `undefined`, and the non-integer / `NaN` guard is unchanged. (Audit v2 §5 F8.)
- **Docs: corrected `Time.asString()` (does not exist), the missing
  `aggregate`/`materialize` → `pivotByGroup` rekey pointer, and an
  inaccurate `rolling().value()` return-type example.** The getting-started
  example now calls `event.key().toDate().toISOString()`; the aggregation
  and reshape pages note that interval-keyed output must be rekeyed with
  `.asTime({ at: 'begin' })` before a time-keyed transform like
  `pivotByGroup` (whose runtime error now says so too); the rolling page
  documents `value()` as `Record<string, ColumnValue | undefined>`.
  (Audit v2 §5 F6/F7/F9/F10/F11)
- **Mixed shorthand + `{ from, using }` mappings now keep every output
  column in the result type (Audit v2 §5 F1).** Calling
  `aggregate` / `rolling` / `reduce` with a mapping that mixes the
  shorthand form (`cpu: 'avg'`) and the spec form
  (`cpu_p95: { from: 'cpu', using: 'p95' }`) in one call — the
  docs-blessed pattern — previously resolved to the shorthand overload
  and **silently dropped every spec-keyed output column from the result
  type** (`event.get('cpu_p95')` failed to compile with `TS2345`), even
  though the runtime emitted the column. The two overloads
  (`AggregateMap` shorthand + `AggregateOutputMap` spec) are now
  collapsed into one unified mapping shape whose result schema dispatches
  per output key, so all columns survive and each narrows to its
  reducer's output kind. Runtime behavior is unchanged — this is a
  types-only fix plus the tests that should have caught it.
- **The unified mapping keeps the shorthand compile-time guards.** A
  shorthand reducer is still kind-checked against its source column
  (`host: 'avg'` on a `string` column stays a compile error), and a bare
  reducer on a key that is not a source column (`ghost: 'avg'` — a typo
  the runtime rejects with "unknown source column") is now a compile
  error too. Spec keys (`{ from, using }`) remain free output names.
  Inline mapping literals get full validation; values pre-widened to
  `AggregateMap<S>` and broad-schema (`TimeSeries<SeriesSchema>`)
  callers keep the permissive shape. `AggregateOutputMap` is retained
  as a back-compat alias of `AggregateMap`.

## [0.22.0] — 2026-06-12

### Changed

- **`asTime` / `asTimeRange` / `asInterval` are now column-native.** They
  reinterpret the key's kind (a "rekey") straight off the existing key's
  `begin` / `end` buffers instead of materializing events — value columns pass
  through by reference. `asTimeRange` and `asTime` with `begin` / `end` reuse
  the key buffer zero-copy (≈ **9×** faster on a build → rekey → read pipeline);
  `asTime({ at: 'center' })` adds one midpoint pass; `asInterval` builds the
  label column (string → `StringColumn`, number → `Float64Column`, inferred
  from the first label and required consistent across rows). `asTime` with
  `center` / `end` throws if anchoring a source with overlapping extents would
  produce a non-monotonic time axis (preserving the prior validation — `begin`
  is always sorted and is exempt).
- **Breaking: `asInterval`'s label function now receives the interval's
  `TimeRange` (its `[begin, end]` extent) and index — not the whole `Event`.**
  The canonical form is unchanged: `series.asInterval(range => range.begin())`
  works exactly as before (both `Event` and `TimeRange` expose `begin()` /
  `end()`). Only a label fn that read a _value column_ off the event (e.g.
  `event => event.get('label')`) needs rewriting — compute the label before
  `asInterval`, or derive it from the extent. The constant form
  (`asInterval('bucket')` / `asInterval(42)`) is unaffected. (Pre-1.0 minor;
  this is the change that lets the function form stay on the columnar path.)

### Fixed

- **`mapColumns` rejects a non-finite numeric result at write.** A mapper on a
  `number` column that returns `NaN` or `±Infinity` now throws a `RangeError`,
  consistent with construction intake (which already rejects non-finite
  numbers). Previously the value was packed into the column, where the reduce
  fast path and the row path could disagree on the same bucket (e.g.
  `aggregate('min')` returning a different result depending on which path ran).
  A stored `NaN` is still a defined value the mapper sees — map it to a finite
  number, or to `undefined` (missing), to clean it. (Closes a hole introduced
  alongside `mapColumns` in 0.21.0.)
- **`aggregate('stdev')` is now numerically stable and path-independent.** The
  bucketed row path (`bucketState`) used a one-pass `sq/n − mean²` accumulator
  that cancels catastrophically on near-equal large-magnitude values —
  returning `0` (e.g. `[1e10, 1e10+1, 1e10+2, 1e10+3]` → `0` instead of
  `≈1.118`), or a negative variance whose `sqrt` is `NaN` that the validating
  constructor then rejected with a throw. Because the columnar fast path is
  all-or-nothing, an unrelated mapping (e.g. a `count` over a string column)
  could silently flip the _same_ series' stdev. All three batch paths (`reduce`,
  `reduceColumn`, `bucketState`) now share **one Welford recurrence** — O(1) per
  element, no buffer (so the live aggregation path that shares `bucketState`
  stays O(1)), `m2 ≥ 0` by construction — so they agree regardless of magnitude.
  (Even the prior two-pass `Σv/n`-then-deviations drifted ~8.7% from the true
  value at `2^52`, where the summed mean rounds — so unifying on Welford, not
  two-pass, was necessary.) **Correction:** 0.21.0's columnar `aggregate()` fast
  path (#186) was described as "signature + semantics unchanged", but it did
  change released `stdev` output for fast-path-qualifying aggregates; this fix
  makes every path agree. (`rolling`/`smooth` stdev keep the one-pass form for
  now — a separate, deferred item.)

## [0.21.0] — 2026-06-11

### Added

- **`TimeSeries.mapColumns({ col: (value) => newValue })`** — a per-cell column
  value transform. The column-scoped counterpart of the event-based `map()`:
  where `map(schema, event => newEvent)` rebuilds whole rows through an
  arbitrary closure (and can change the schema/key), `mapColumns` transforms
  individual columns' values in place, reading the columns directly (no
  per-row `Event`) so it stays on the fast columnar path. Same kind in/out
  (number→number, string→string, …), so the schema is unchanged; missing cells
  carry (the mapper isn't called on `undefined`). ~5–6× faster than the
  `map()` workaround on a build → transform → read pipeline.

### Changed

- **`select` / `rename` / `slice` / `cumulative` / `diff` / `rate` /
  `pctChange` / `fill` / `shift` / `collapse` are now column-native.** They
  reshape the columnar store directly instead of materializing events, so the
  columnar construction win is preserved through these transforms — build →
  transform → read pipelines run several× faster (~7–10× for `select` /
  `rename` / `slice`; ~5–7× for the `cumulative` / `diff` / `rate` / `fill` /
  `shift` / `collapse` folds). No API change for type-correct callers (one
  narrow `fill` behavior change is noted under Fixed). `cumulative` / `diff` /
  `rate` / `pctChange` / `fill` / `shift` / `collapse` are also the first
  operators extracted into `batch/operators/` (internal refactor); `fill`
  rebuilds only the columns it actually changes; `slice` normalizes
  `Array.prototype.slice` semantics onto a zero-copy `withRowRange` reshape;
  `collapse` reads only the keyed columns and passes the kept columns through
  by reference.

### Fixed

- **`rename` now rejects target-name collisions** (e.g. renaming `a` → `b`
  when `b` already exists) with a clear error, instead of silently producing a
  duplicate-named schema. Also fixes a prototype-chain bug where a column named
  `toString` (or another `Object.prototype` member) could be corrupted during
  a rename.
- **`fill` now throws on a kind-mismatched literal** (e.g.
  `fill({ value: 'banana' })` where `value` is numeric — type-allowed because
  mapping values are the broad `FillStrategy | ScalarValue`) with a clear
  `RangeError` naming the column, instead of silently producing an
  internally-inconsistent series (the old events path returned the literal
  from `.get()` while the numeric column read `NaN`). The throw is
  gap-dependent — it only fires when the literal would actually be placed.

## [0.20.0] — 2026-06-04

Two internal performance improvements driven by the dashboard experiment at
256-host stress. **No public API changes** — both are behavior-preserving.

### Changed

- **Column-native partition routing.** `partitionBy(...)` over a strict
  time-keyed source now routes its source chunks into per-partition
  **chunked** sub-series via a coalescing staging tier, replacing the
  per-partition `Event[]` retention. A large drop in retained memory and
  object count at high partition counts (gRPC bench at 256 partitions: 60×
  fewer columnar stores, −99.4% `Event` retention, +24% sustained throughput)
  ([#175](https://github.com/pjm17971/pond-ts/pull/175)). Behavior-preserving;
  internal only — no public surface added.
- **`LiveView.toTimeSeries()` snapshot caching.** The built `TimeSeries` is
  memoized against an internal mutation counter, so back-to-back
  identical-state calls (multiple subscribers, framework commit batching,
  StrictMode double-invoke) return the cached instance by reference instead of
  rebuilding the whole snapshot — ~44 ms → ~0 at a 262k-event window. A
  fresh-state call still builds; safe because `TimeSeries` is immutable
  ([#180](https://github.com/pjm17971/pond-ts/pull/180)).

## [0.19.0] — 2026-06-02

Adds an **experimental column-read surface to the live side** — read typed
columns straight off a `LiveView` without materializing a `TimeSeries`
snapshot — driven by the dashboard experiment's per-tick memo cost. Plus a
`useTimeSeries` schema-inference fix. The live column surface is
**experimental and expected to keep moving in 0.19.x**.

### Added

- **`LiveView` column-read surface (experimental).** Read columns directly
  off a windowed live view, the column-API counterpart to the batch
  `TimeSeries` surface ([#179](https://github.com/pjm17971/pond-ts/pull/179)):
  - `liveView.column(name)` — a numeric value column gathered from the view's
    current events (string / array columns are a compile error; read those as
    scalars or snapshot via `toTimeSeries()`).
  - `liveView.keyColumn()` — the time axis (`TimeKeyColumn`; time-keyed views
    only, enforced at compile time).
  - `liveView.partitionBy(col).toMap(fn)` — a walk-now per-partition read
    returning `Map<string, R>`, mirroring `TimeSeries.partitionBy().toMap()`
    but without per-partition `TimeSeries` construction. Distinct from
    `LiveSeries.partitionBy` (which is subscription-oriented). Throws on a
    missing / key partition column rather than silently merging.
  - `LiveColumnGroup` — the per-partition view passed to the `toMap` callback.
- **`@pond-ts/react`: `useLiveVersion(source, { throttle })` (experimental)**
  — a `useSyncExternalStore`-based change signal that bumps on append **and**
  eviction, so a component can read columns off a live view each render
  without manufacturing a `TimeSeries` snapshot. Closes the
  render-before-subscribe gap; throttling bounds only the React notification
  ([#179](https://github.com/pjm17971/pond-ts/pull/179)).

### Changed

- **`useTimeSeries` collapsed to a single generic** `<S extends SeriesSchema>`
  so the schema infers from `input.schema`. The prior two-generic signature
  lost `S` through the input-wrapper generic and resolved
  `result.column('cpu')` to `never`; the accepted input type is unchanged, so
  this is an inference fix — but a caller passing two explicit type arguments
  must drop the second ([#176](https://github.com/pjm17971/pond-ts/pull/176)).

## [0.18.0] — 2026-05-30

This release graduates the **Phase 4.7 columnar substrate** from
framework-internal (shipped piecemeal to `main` since v0.17.1) to a
user-visible **public column API**, plus a column-native live buffer that
fixes a high-partition-count OOM. Everything is additive except one
documented breaking change (interval label kinds) and one documented
behavior change (chunked-backed `pushMany` commit semantics). Pre-1.0: the
column API is expected to keep moving toward its eventual shape.

### Added

- **Public column API (Phase 4.7 step 8).** A column-centric extraction
  surface on `TimeSeries`, for high-throughput and charting consumers that
  want typed-array access instead of per-`Event` iteration. Additive — every
  existing row / `Event` API is unchanged.
  - `series.column(name)` returns a schema-narrowed typed column view, with
    public re-exports of the `Float64Column` / `BooleanColumn` /
    `StringColumn` / `KeyColumn` (time / timeRange / interval) variants
    ([#154](https://github.com/pjm17971/pond-ts/pull/154),
    [#155](https://github.com/pjm17971/pond-ts/pull/155)).
  - `Float64Column`: scalar reductions (`min` / `max` / `sum` / `mean` /
    `count` / …) and `scan`
    ([#155](https://github.com/pjm17971/pond-ts/pull/155)); `bin(...)` for
    histogram / downsample bucketing
    ([#156](https://github.com/pjm17971/pond-ts/pull/156)); and
    `toFloat64Array()` for a storage-agnostic gather into a dense array
    ([#165](https://github.com/pjm17971/pond-ts/pull/165)).
  - `KeyColumn.at(i)` and `.slice(start, end)`
    ([#159](https://github.com/pjm17971/pond-ts/pull/159)).
- **Columnar substrate (Phase 4.7 step 1, framework layer).** All
  eight sub-steps (1a–1h) shipped to main as PRs #132 / #133 /
  #134 / #135 / #136 / #147 / #148 / #149. See `PLAN.md` and
  [`packages/core/src/columnar/README.md`](packages/core/src/columnar/README.md)
  for the full inventory. Framework-internal — surfaced behind the existing
  `TimeSeries` API at step 2 (below) and the public column API at step 8
  (above).

### Changed

- **Chunked columnar live backing for strict time-keyed `LiveSeries`**
  ([#170](https://github.com/pjm17971/pond-ts/pull/170)). A top-level
  `LiveSeries` with `ordering: 'strict'` and a time key now backs its
  retained window with batch-granular columnar chunks instead of an
  `Event[]` window — each `pushMany` validates straight into typed columns,
  retaining **zero `Event` objects** (~4.7× less retained heap in-pond; the
  high-partition-count OOM fix). Two consequences:
  - **`pushMany` commit semantics** on the chunked path: the batch is
    appended atomically _before_ any `'event'` fires, so a listener observes
    the full post-batch `length` (not a row-by-row `1, 2, 3`), and a listener
    that throws mid-batch leaves the whole batch committed. The per-row
    `Event[]` backing (`reorder` / `drop` / interval-keyed /
    internally-created series) keeps per-row commit. Listener _values_ and
    `event → batch → evict` ordering are unchanged.
  - **`LiveReduce` eviction** resolves by event identity (primary) with a
    FIFO-frontier fallback for the chunked backing's materialized evictions —
    correct for both `reorder` and the chunked backing. `min` / `max` /
    `first` / `last` / `samples` over a `reorder` source **with retention**
    remain a documented limitation (see `LiveReduce` JSDoc and PLAN
    "Deferred") — pre-existing, not introduced here.
- **Internal, behavior-preserving performance work.** Column-native intake
  bypasses per-row `Event` allocation at `TimeSeries` construction
  ([#151](https://github.com/pjm17971/pond-ts/pull/151)); numeric reducers
  (`min` / `max` / `sum` / `avg` / …) compute over typed-array columns where
  available, with NaN parity preserved
  ([#153](https://github.com/pjm17971/pond-ts/pull/153)); the live storage
  strategy was extracted behind an internal interface
  ([#168](https://github.com/pjm17971/pond-ts/pull/168)).

### Changed (BREAKING)

- **Interval-keyed series must use one label type throughout**
  ([#150](https://github.com/pjm17971/pond-ts/pull/150)). Pre-2a,
  TimeSeries silently tolerated mixed-kind interval labels —
  rows with `value: 'row-1'` (string) and `value: 2` (number) could
  coexist in a single series because events were stored as a raw
  array with no per-column type alignment. The columnar substrate
  introduced at Phase 4.7 enforces one label kind per column via
  `IntervalKeyColumn`, so mixed-kind labels now throw at series
  construction with a row-pointed error message.
  - **Affected:** Any series built via `new TimeSeries(...)`,
    `TimeSeries.fromJSON(...)`, `TimeSeries.fromEvents(...)`, or
    any transform that produces interval-keyed events, where the
    `value` field of `IntervalInput` rows or `Interval` keys
    mixes `string` and `number` types.
  - **Migration:** Choose one label kind for the whole series.
    Numeric labels can be stringified at intake (`String(label)`)
    if the downstream consumer accepts string equality; string
    labels parseable as integers can be converted to numbers at
    intake. The error message names the first offending row so
    the offending data is easy to find.
  - **Rationale:** Aligns the row-API contract with the columnar
    substrate's per-column kind discipline (matching Polars /
    Arrow / Parquet). The previous behavior produced type-broken
    events that worked only because TimeSeries didn't enforce
    per-column alignment; downstream columnar operators (the
    upcoming reducer adaptation in steps 3+) require it.
  - **Affected types:** `IntervalValue` remains `string | number`
    per the `Interval` class contract. The runtime restriction
    is at the **series** level (all intervals within one series
    must share a kind), not the per-interval level. Type-level
    narrowing of `IntervalKeyedSchema<S>` over label kind is a
    follow-up deferred to a later sub-step.

## [0.17.1] — 2026-05-11

Bug fix: `live.partitionBy()` now default-inherits `ordering`,
`graceWindow`, and `retention` from the source `LiveSeries`. Surfaced
by the gRPC experiment's
[M4 late-data friction note](https://github.com/pjm17971/pond-grpc-experiment/blob/main/friction-notes/M4.md),
which measured `99.5%` of late events crashing the partition router
under `source = LiveSeries({ ordering: 'reorder', graceWindow })`
followed by bare `partitionBy('host')`.

### Fixed

- **`LiveSeries.partitionBy(by)` default-inherits source config**
  ([#TBD](https://github.com/pjm17971/pond-ts/pull/TBD)). Pre-fix,
  per-partition sub-series were constructed with default
  `ordering: 'strict'` regardless of source mode. Under a `'reorder'`
  source, late events that the source accepted via its reorder path
  were routed into the partition's `#insert` and threw with a
  strict-mode error; the throw propagated back through the source's
  listener fan-out into `live.push()`.

  Post-fix, `partitionBy(by)` defaults each per-partition sub-series'
  `ordering`, `graceWindow`, and `retention` to the source's values.
  Explicit options on `partitionBy(by, { ordering, ... })` override
  per-field. `graceWindow` inheritance is gated on effective ordering
  being `'reorder'` (LiveSeries rejects strict + graceWindow combos).

  ```ts
  // Pre-0.17.1: crashed the partition router
  const live = new LiveSeries({
    name: 'metrics',
    schema,
    ordering: 'reorder',
    graceWindow: '30s',
  });
  live.partitionBy('host'); // ← partition was strict regardless

  // Post-0.17.1: partitions inherit reorder + 30s grace; late events
  // accept correctly via the reorder path.
  ```

  Existing callers with explicit `partitionBy(by, { ordering, ... })`:
  unchanged. Existing callers on `'strict'` sources: unchanged.
  Existing callers on `'reorder'` sources with bare `partitionBy`:
  the previously-thrown late events now accept correctly — bug fix,
  not a behavior change anyone could rely on.

- **`collect()` and `apply()` on `LivePartitionedSeries` default-
  inherit `ordering` and `graceWindow`** from the partitioned series
  (which inherits from source). Pre-fix, the unified buffer defaulted
  to `'strict'`, so partition fan-in on a `'reorder'` source could
  deliver events out-of-order to a strict unified buffer and throw.
  Retention stays caller-explicit on these per the existing append-
  only fan-in semantics.

### Notes

- **Six regression tests pin the new defaults** in
  `LivePartitionedSeries.test.ts`: inherited ordering, inherited
  graceWindow within reorder, inherited retention on partitions,
  explicit override of inheritance, strict-source no-change, and the
  edge case where overriding ordering to strict suppresses graceWindow
  inheritance. `collect()` inheritance pinned separately.
- The gRPC experiment's M4 friction note also surfaced milestone B
  (capability-based late repair) as **driver-light by empirical test**
  after Codex's adversarial pass caught simulator RNG leakage across
  A/B legs. Drift signal collapsed to within noise on every host once
  all randomness sources were seeded — milestone B's library design
  stays sound, but the gRPC experiment's measurement style (last-tick
  `.value()` reads) doesn't surface its payoff. Milestone B sequencing
  updated in PLAN.md to reflect this finding.

## [0.17.0] — 2026-05-08

`sample({...})` operator wave: bounded-memory stream thinning, surfaced
by the gRPC experiment's M3.5 finish-line work
([friction note](https://github.com/pjm17971/pond-grpc-experiment/blob/main/friction-notes/rfcs/bounded-memory-sampling.md)
with measured firehose numbers). Decouples downstream baseline window
length from event rate — at firehose rates × stride 10, `sd / sqrt(N)`
standard error stays well below per-event noise while a 5-minute
baseline that wouldn't fit in a Node heap un-sampled does at
stride 10. PR [#129](https://github.com/pjm17971/pond-ts/pull/129).

### Added

- **`series.sample({ stride | reservoir })`** on `TimeSeries` and
  `PartitionedTimeSeries` — single-pass thinning that keeps the
  `TimeSeries<S>` schema. Stride is deterministic 1-in-N
  (`{ stride: N }`); reservoir is random K-of-N via single-pass
  [Vitter's Algorithm R](https://en.wikipedia.org/wiki/Reservoir_sampling#Simple:_Algorithm_R)
  (`{ reservoir: { size: K } }`), sorted by key on output to preserve
  the chronological invariant. The canonical visualization shape:

  ```ts
  series.sample({ reservoir: { size: 500 } }).toRows();
  ```

  500 uncorrelated points drawn uniformly from the source — no
  `aggregate(seq, ...)` grid collapse, no regular-spacing artifact,
  fixed point count regardless of source size. Per-partition state on
  `PartitionedTimeSeries.sample(...)` — each partition gets its own
  K-event reservoir or stride counter.

- **`live.sample({ stride })`** on `LiveSeries`, `LiveView`,
  `LivePartitionedSeries`, `LivePartitionedView` — closure-captured
  counter inside a `LiveView<S>`, so the chainable surface (`filter`,
  `rolling`, `reduce`, `select`, `map`, `diff`, `rate`, `cumulative`,
  `fill`) is immediately available downstream of the sample. The
  bounded-memory firehose pattern:

  ```ts
  live.partitionBy('host').sample({ stride: 10 }).rolling('5m', mapping);
  ```

  Each host's stream is thinned 1-in-10 before flowing into a per-host
  5m rolling window. `live.stats().ingested` and `live.on('batch', cb)`
  are upstream of any `.sample(...)` op — they continue counting true
  throughput; only consumers downstream see the thinned stream.

- **Sampling docs page** at
  [`pond-ts/transforms/sampling`](https://pjm17971.github.io/pond-ts/docs/pond-ts/transforms/sampling/)
  covering when-to-use-which decision table, both strategies, the
  visualization shape, multi-entity considerations, and a forward-link
  to the live counterpart. New `## Sampling: bounded-memory thinning`
  section in
  [Live transforms](https://pjm17971.github.io/pond-ts/docs/pond-ts/live/live-transforms#sampling).

### Deferred

- **Live-side reservoir sampling** is queued for v0.18.0+. Algorithm R's
  random-slot replacement produces non-prefix evictions, but the existing
  live-eviction protocol (`'evict'` event + cutoff-based mirroring in
  `LiveView`) assumes prefix evictions only. Bridging needs an exact-
  removal eviction channel — arriving with the streaming RFC's
  `LiveChange` model (Phase 4.5 milestone A). For visualization-shaped
  reservoir today, materialize via `live.toTimeSeries().sample({ reservoir })`.

### Notes

- **Multi-entity bias trap** is documented in JSDoc on the pre-partition
  sites (`LiveSeries.sample`, `LiveView.sample`) with the
  `partitionBy(...).sample(...)` recommendation, matching the existing
  convention for `rolling` / `aggregate` / `fill` / `diff` / `rate` /
  `cumulative` / `pctChange` / `reduce`. An earlier iteration of #129
  shipped a type-level `unsafeGlobal: true` token; pulled during review
  for consistency with how every other stateful live operator handles
  the same multi-entity consideration. Token-of-the-week novelty was
  the wrong shape; the doc warning is the same answer the other
  operators already give.

- **Legacy `rolling.sample(seq)` doc references removed.** Pre-v0.12
  pond exposed `LiveRollingAggregation.sample(sequence)` as a separate
  method (deleted in v0.12.0, replaced by `Trigger.every`). Active doc
  references in `pond-ts/live/triggering.mdx`,
  `pond-ts/transforms/alignment.mdx`, `pond-ts/transforms/rolling.mdx`,
  and `pond-ts/live/live-transforms.mdx` removed to eliminate the
  naming-collision confusion now that `series.sample({ stride | reservoir })`
  is a real but completely unrelated operator. Historical record
  preserved in PLAN.md, the v0.11.8 CHANGELOG entry, and the triggers RFC.

## [0.16.1] — 2026-05-06

Patch wave addressing one ergonomic gap surfaced by the gRPC
experiment ([pond-grpc-experiment#29](https://github.com/pjm17971/pond-grpc-experiment/pull/29))
plus the v0.16.0 docs deploy that broke since v0.15.2.

### Added

- **`PartitionedTimeSeries.aggregate(...)` and `.rolling(...)` now
  auto-inject the partition column into the user's mapping**
  ([#128](https://github.com/pjm17971/pond-ts/pull/128)). The
  natural shape just works:

  ```ts
  series
    .partitionBy('host')
    .aggregate(Sequence.every('600ms'), { cpu_avg: 'avg' });
  ```

  Pre-fix this threw `column "host" not in schema` at the rewrap
  step because the user's mapping didn't carry the partition
  column through; users had to add `host: 'first'` mechanically
  to every partitioned-aggregate call. Pond now adds it
  automatically — `'first'` is by-construction-correct since
  every row in a single partition shares that column's value.
  User-supplied mappings for the partition column win (auto-
  inject is a no-op when the user has already opted in).
  Composite partitions (`partitionBy(['host', 'region'])`)
  auto-inject every partition column. Strictly additive — the
  pre-fix workaround pattern still works unchanged.

### Fixed

- **Docs deploy workflow unblocked**
  ([#126](https://github.com/pjm17971/pond-ts/pull/126)). Has
  been failing since v0.15.2 with `Cannot find name
'queueMicrotask'` — TypeDoc runs the same tsconfig as the
  npm-publish path but from a different cwd, where `@types/node`
  doesn't resolve. Fixed via a one-line ambient declaration in
  `LiveReduce.ts`. No runtime change; `queueMicrotask` is still
  the host-provided global it always was.

### Changed

- **Updated `LiveSeries` tool comparisons in the docs**
  ([#127](https://github.com/pjm17971/pond-ts/pull/127)).
  Tightened the Beam/Flink, PondJS, and pandas comparison tables
  to be technically accurate. Doc prose only; no code change.

### Notes

- **Captured `@pond-ts/charts` design constraints in PLAN.md**
  ([#128](https://github.com/pjm17971/pond-ts/pull/128)). The
  gRPC experiment's M3.5 friction note hit Recharts' SVG render
  cliff at firehose loads (~75-80k SVG nodes per render, ~1 fps
  at 10 hosts × 70k events/s). Four constraints from real
  workload now baked into the plan so the eventual extraction
  starts with the answer key — not new code, just durable
  design capture.

## [0.16.0] — 2026-05-06

Live-API ergonomic wave. Four PRs:
[#122](https://github.com/pjm17971/pond-ts/pull/122) (buffer-as-window
Tier 1), [#123](https://github.com/pjm17971/pond-ts/pull/123)
(`stats()` accessor), [#124](https://github.com/pjm17971/pond-ts/pull/124)
(`history` option + compile-time fused uniqueness),
[#125](https://github.com/pjm17971/pond-ts/pull/125) (Tier 2 query
primitives). Strictly additive surface — no public-API removals or
narrowings.

### Added

- **`live.reduce(mapping, opts?)`** on `LiveSeries` and `LiveView`
  — streaming reduce over the source's current buffer. Mirrors
  `series.reduce(mapping)` from batch but reactive: per-event
  `add`, per-eviction `remove`, microtask-deferred trigger
  emission so retention has run before the snapshot. Closes the
  buffer-as-window persona's biggest ergonomic gap.
- **`live.timeRange()`** on `LiveSeries` and `LiveView` — O(1)
  temporal extent of the current buffer (`undefined` when empty).
- **`live.eventRate()`** on `LiveSeries` and `LiveView` — O(1)
  events-per-second over the buffer's time span (zero when fewer
  than two events). Convenience over the existing
  `view.eventRate()` shape; no window argument required.
- **`live.count()`** on `LiveSeries` (alias for `length`) for
  parity with `LiveView.count()` and chainable composition with
  `eventRate()`.
- **`stats()` accessor on every live accumulator/series.** Per-class
  shapes, all returning a plain record (cumulative integer counters
  - current-state fields):

  | Class                       | Shape                                                                 |
  | --------------------------- | --------------------------------------------------------------------- |
  | LiveSeries                  | `{ ingested, evicted, rejected, length, earliestTs?, latestTs? }`     |
  | LiveRollingAggregation      | `{ eventsObserved, evictions, emissions, windowSize }`                |
  | LiveFusedRolling            | `{ eventsObserved, evictions, emissions, windowSize, windowsCount }`  |
  | LiveAggregation             | `{ eventsObserved, bucketsClosed, openBuckets, openBucketStart? }`    |
  | LiveReduce                  | `{ eventsObserved, evictions, emissions, bufferSize }`                |
  | LivePartitionedSeries       | `{ partitions, eventsRouted }`                                        |
  | LivePartitionedSyncRolling  | `{ partitions, eventsObserved, emissions, windowSize }`               |
  | LivePartitionedFusedRolling | `{ partitions, eventsObserved, emissions, windowSize, windowsCount }` |

  Per-event cost: ~1-3 integer increments in already-existing
  handlers. `stats()` itself is O(1) — or O(partitions) for the
  max-across-partitions `windowSize` on partitioned variants.
  Polling-based by design — wall-clock timers inside pond would
  break the data-is-the-clock invariant.

- **`history: false | RetentionPolicy` option on
  `LiveRollingAggregation` and `LiveFusedRolling`** (and
  partitioned variants — threaded through
  `LivePartitionedSeries.rolling` end-to-end). Controls how much
  of the rolling's emitted history the accumulator keeps in its
  own output buffer (the one read by `length` / `at(i)`). Default
  `true` preserves current behavior; `false` skips the push
  entirely (`'event'` listeners and `value()` still work, but
  `length` stays at 0); `RetentionPolicy` (`{ maxEvents?, maxAge? }`)
  caps the buffer using the same shape as `LiveSeries.retention`.
  Stricter validation: rejects 0, negative, or non-integer
  `maxEvents`; `Infinity` is the documented "no cap" sentinel.

- **Compile-time uniqueness check on fused output columns**
  (`FusedMappingValid<FM>`). Two windows declaring the same
  output name now fail at the call site with a branded error
  type naming the conflict. Wired into all four fused-rolling
  overloads (LiveSeries, LiveView, root + view
  LivePartitionedSeries). Runtime check still in place.

- **Tier 2 query primitives on `LiveSeries` and `LiveView`** —
  pure parity additions mirroring `TimeSeries`:
  - `find(pred)`, `some(pred)`, `every(pred)` — O(N) predicate query
  - `includesKey(key)`, `bisect(key)`, `atOrBefore(key)`,
    `atOrAfter(key)` — O(log N) binary search on the sorted buffer

  Use cases: "is there already an event with key K?" / "what was
  the most recent event before time T?" Both come up in dashboard
  patterns where the live buffer IS the working set.

- **`KeyLike` type** exported from the package root (re-exported
  from `TimeSeries`). Accepts `EventKey | TimestampInput |
TimeRangeInput | IntervalInput`; normalised by the new query
  primitives.

- **`DurationLiteral` and `DurationUnit` types** extracted from
  `utils/duration.ts` and exported. Same shape as before, just
  named.

- **Concrete return types from partitioned rolling overloads.**
  `LivePartitionedSeries.rolling` and `LivePartitionedView.rolling`
  clock-trigger and fused-mapping overloads now return the concrete
  `LivePartitionedSyncRolling` / `LivePartitionedFusedRolling`
  classes (instead of bare `LiveSource<...>`), exposing `stats()`
  to callers without a cast. Strictly additive — concrete classes
  implement `LiveSource` plus `stats()`.

### Changed

- **`LiveSeries.clear()`** now increments the `evicted` counter
  on `stats()` to match the existing `'evict'` listener fan-out.
  Previously cleared the buffer and fired listeners but didn't
  update the counter.
- **`LiveSeries` insertion comparator** delegates to
  `EventKey.compare` (was previously `begin/end` only). Affects
  interval-keyed series with same-span / different-value
  intervals: previously stored in arrival order — and broke
  `bisect`/`includesKey` queries — now stored in value-ascending
  order. Time-keyed and timeRange-keyed series unaffected.
- **`LiveView.map(fn)` runtime check** rejects re-keying maps
  that produce non-monotonic outputs. Throws `ValidationError`
  at append time rather than silently breaking the view's
  sorted-buffer invariant (which Tier 2 query primitives rely
  on). Sane transforms (data-only maps, monotonic time-shifts)
  unaffected.
- **`LiveAggregationOptions.grace`** type tightened from
  `DurationInput | \`${number}${unit}\``(redundant union) to
just`DurationInput`. No behavioral change.

### Notes

- React package (`@pond-ts/react`) version-bumped lock-step; no
  hook surface changes in this release. New core hooks
  (`useLiveReduce`, `useStats`, optional-window `useEventRate`)
  are queued for a follow-up — see PLAN.md for the design.
- Codex caught real bugs on every Layer-2-reviewed PR in this
  wave (1 HIGH + 1 MEDIUM on PR #123, 1 HIGH + 1 MEDIUM on
  PR #124, 2 MEDIUM on PR #125). The Layer 2 + Codex two-pass
  protocol earned its keep again.

## [0.15.2] — 2026-05-06

Performance fix for live rolling at firehose rates. The gRPC
experiment's step 6
([pond-grpc-experiment#26](https://github.com/pjm17971/pond-grpc-experiment/pull/26))
attempted to use the non-partitioned `live.rolling({...}, opts)`
overload for global counters and saw throughput collapse from 88k/s
to 21k/s — a 4× regression even worse than the V7→V6 gap that
motivated v0.15.0. The cliff is the same `Array.shift()` pattern
already flagged as queued tactical work in PLAN; the gRPC encounter
made it urgent.

### Fixed

- **Eviction is now O(1) per ingest in all live rolling classes.**
  Replaced `entries.shift()` (worst-case O(N) on the deque length)
  with a head-index pointer + periodic batched compaction:
  - `LiveFusedRolling.#compactFront` — non-partitioned multi-window
  - `LivePartitionedFusedRolling.#compactPartitionFront` —
    per-partition fused
  - `LiveRollingAggregation.#removeFirst` — single-window
    non-partitioned
  - `LivePartitionedSyncRolling.#evictPartition` — per-partition
    single-window synced

  The pattern: track a `frontIdx` field; "evicting" advances the
  pointer instead of shifting. When the dead prefix grows past
  half the array length, batch-splice it off and reset the
  pointer. Per-event cost stays O(1) amortized at every live-
  window size — each surviving entry is copied at most once
  between two compactions, and compactions fire at most every
  (live-size) events.

  An earlier draft also compacted on a fixed 1024-entry threshold;
  Codex's adversarial review on PR #119 caught that this would
  reintroduce O(live_size / 1024) per-eviction cost on large
  windows (100k+ live entries) — the threshold would fire
  repeatedly and copy the entire live slice each time. The
  proportional guard alone has the right amortization invariant.

### Performance

`packages/core/scripts/perf-fused-rolling.mjs` — new regression
scenario that reproduces the cliff (50k-event deque with continuous
eviction):

```
Worst-case shift pattern (50s window, 50k fill + 50k evict):
                    median (ms)   min (ms)   max (ms)
  pre-fix              1123.12     1118.47    1149.95
  v0.15.2                53.00       52.34      53.56
  speedup                21.2×

Steady-state deque, no eviction (5m window, 200k events):
                    median (ms)   min (ms)   max (ms)
  pre-fix                91.28       89.84      97.04
  v0.15.2                99.28       96.80     103.94
  delta                  +9% (within noise)
```

The fix targets the eviction-loop case specifically. Workloads with
no eviction (or rare eviction relative to ingest) see no change —
V8's internal hidden-offset optimization handles those well. The
cliff appears once eviction fires per-ingest at large deque size,
which is exactly the firehose-rolling shape.

### Why the cliff was hidden

V8's `Array.shift()` is amortized O(1) for shift-heavy workloads up
to ~10k-element arrays — it maintains a hidden offset and only
periodically compacts. Beyond that size or with mixed access
patterns, the optimization breaks down and shift falls back to true
O(N) memcpy. The bench scales from 1k to 50k deque sizes and the
cliff appears around 30k-40k. Pond's tests pin behavior at small
window sizes; the cliff was invisible to the test suite, only
showed up under the gRPC experiment's firehose load.

### What this unlocks

The agent's manual-counter workaround in `aggregator/src/aggregate.ts`
can now drop. The natural shape — a non-partitioned
`live.rolling({...}, { trigger })` over the firehose — is now
viable at the rates the experiment cares about. PLAN's
"`samples` reducer would exhibit a similar shape at firehose"
caveat also resolves: same fix in the same call sites covers
samples too.

### Note for downstream consumers

This is a **strict-additive perf fix.** All output behavior is
preserved — same eviction order, same emission timing, same
snapshot values. The deque's internal representation changed
(`#entries[0]` may now be a logically-evicted entry until periodic
compaction); any downstream code reading `#entries` directly would
break, but those fields are private. Public APIs and types are
unchanged.

[0.17.1]: https://github.com/pjm17971/pond-ts/compare/v0.17.0...v0.17.1
[0.17.0]: https://github.com/pjm17971/pond-ts/compare/v0.16.1...v0.17.0
[0.16.1]: https://github.com/pjm17971/pond-ts/compare/v0.16.0...v0.16.1
[0.16.0]: https://github.com/pjm17971/pond-ts/compare/v0.15.2...v0.16.0
[0.15.2]: https://github.com/pjm17971/pond-ts/compare/v0.15.1...v0.15.2

## [0.15.1] — 2026-05-05

Type-narrowing follow-up to v0.15.0. The fused partitioned-rolling
typing chain exposed a pre-existing pond limitation where
`partitionBy('host')` widened the partition-column type instead of
narrowing it to the literal `'host'`. The gRPC experiment's V8
migration ([pond-grpc-experiment#22](https://github.com/pjm17971/pond-grpc-experiment/pull/22))
worked around it as `partitionBy<'host'>('host')` — clobbering the
value-type parameter `K` to fill the column-name slot. v0.15.1
captures the column literal directly so the workaround can drop.

### Fixed

- **`partitionBy` narrows the partition column literal.** The
  `by` argument's literal type now flows into a new `ByCol`
  generic on `LivePartitionedSeries<S, K, ByCol>` and
  `LivePartitionedView<SBase, R, K, ByCol>`. Threaded through every
  per-partition method (`fill`, `diff`, `rate`, `pctChange`,
  `cumulative`, `apply`, the rolling overloads). The fused
  partitioned-rolling overload's
  `FusedPartitionedRollingSchema<S, ByCol, FM>` now resolves
  correctly without the `<'host'>` workaround:

  ```ts
  // Before v0.15.1: needed the explicit type arg to narrow
  // host through the fused-rolling schema chain.
  live.partitionBy<'host'>('host').rolling({ ... }, { trigger });

  // v0.15.1+: the literal 'host' is captured automatically.
  live.partitionBy('host').rolling({ ... }, { trigger });
  // Output schema includes `host` narrowed to its column kind;
  // event.get('host') resolves correctly.
  ```

  Existing V8 callers using the `partitionBy<'host'>('host')`
  workaround continue to narrow correctly. Type-parameter order
  on `partitionBy` is `<ByCol, K>` (column name first, value type
  second) so the explicit `<'host'>` binds the literal to `ByCol`
  — exactly what the workaround intended pre-v0.15.1. The
  workaround can now drop because automatic inference does the
  same job, but it doesn't have to.

### Type system

- `LivePartitionedSeries<S, K, ByCol>` — third generic added with
  default `keyof EventDataForSchema<S> & string`. Backwards-
  compatible: existing references to `LivePartitionedSeries<S, K>`
  and `LivePartitionedSeries<S>` resolve to the upper-bound default.
- `LivePartitionedView<SBase, R, K, ByCol>` — same shape; `ByCol`
  threaded through every chain hop so partition-column literals
  survive `partitionBy('host').fill(...).rolling({...}, opts)`.

### Test surface

`test-d/fused-rolling.test-d.ts` extended to pin the narrowing at
both the root and chained levels:

```ts
const fC = live.partitionBy('host').rolling({ ... }, { trigger });
sampleEvent.get('host'); // narrows to string | undefined

const chained = live.partitionBy('host').fill({ cpu: 'hold' })
  .rolling({ '1m': { cpu_avg: ... } }, { trigger });
chainedSample.get('host'); // narrows correctly through the chain
```

All 1115 + 55 runtime tests still pass; type-d clean.

[0.15.1]: https://github.com/pjm17971/pond-ts/compare/v0.15.0...v0.15.1

## [0.15.0] — 2026-05-05

The "fused multi-window rolling" release. Shipping the primitive
that closes the gRPC experiment's V6→V7 architectural cliff: a
keyed-form overload on `live.rolling()` that maintains N windows
in one ingest pass over a single shared deque, emits one merged
event per trigger boundary, and (on the partitioned variant) eats
the doubled `#routeEvent` / `#evictPartition` / `_pushTrustedEvents`
hops V7 surfaced.

Two independent signals motivated this: the gRPC profile-diff
(PR #19 in `pond-grpc-experiment`) and the buffer-as-window
persona's metric-agent call site
(`series.rolling(RETENTION, mapping, ...)` as workaround). Both
point at one primitive; both shipped together. RFC #20 in
`pond-grpc-experiment` is the design record.

### Added

- **Keyed-form fused rolling on `LiveSeries.rolling`,
  `LiveView.rolling`, and `LivePartitionedSeries.rolling`.** Pass
  a record of `{ duration: mapping }` instead of `(window, mapping)`
  to declare multiple windows; the rolling maintains them all in
  one ingest pass:

  ```ts
  const fused = byHost.rolling(
    {
      '1m': {
        cpu_avg: { from: 'cpu', using: 'avg' },
        cpu_sd: { from: 'cpu', using: 'stdev' },
      },
      '200ms': { cpu_samples: { from: 'cpu', using: 'samples' } },
    },
    { trigger: Trigger.every('200ms') },
  );
  // fused emits one merged event per boundary with all four
  // columns; one ingest pass per source event.
  ```

  - **Output: one merged stream.** All declared windows' columns
    concatenated into one record per trigger fire — not N
    accumulators or N streams. User code collapses to one event
    handler (the V7 → V8 migration in the gRPC experiment drops
    ~30 lines of `pendingByTs` / `partsFor` / `tryEmit` join
    machinery).
  - **Constraints.** Time-based windows only (object keys are
    duration strings); single trigger across all windows by
    design (per-window cadence falls back to two `rolling()`
    calls, paying the V7 cost). On partitioned series, clock
    trigger is required.
  - **Per-window options.** Use the elaborated value form
    (`{ mapping, minSamples }`) when one window needs different
    options from the rest; bare-mapping value stays clean for
    the common case.
  - **Duplicate output column names** across windows are rejected
    at construction with a clear error. Partition column auto-
    injection is unified across all windows.
  - **Single-window equivalence pin.**
    `live.rolling('1m', mapping, opts)` and
    `live.rolling({ '1m': mapping }, opts)` produce identical
    output (locked down by tests).

- **`LiveFusedRolling<S, Out>`** — non-partitioned class, exposed
  on the public surface via `live.rolling({...}, opts)`.
- **`LivePartitionedFusedRolling<S, K, Out>`** — synchronised-cross-
  partition class, exposed via `byHost.rolling({...}, { trigger })`.
- **Type-level surface:** `FusedMapping<S>`, `FusedMappingValue<S>`,
  `FusedMappingElaborated<S>`, `FusedRollingSchema<S, FM>`,
  `FusedPartitionedRollingSchema<S, ByCol, FM>`, and
  `DurationString` — all exported from `pond-ts`. Output column
  kinds narrow correctly through `event.get('cpu_avg')` to
  `number | undefined`.

### Performance

`packages/core/scripts/perf-fused-rolling.mjs` — bench against
gRPC RFC #20 acceptance criteria. Headline numbers (median of 3
runs, `node --expose-gc`):

```
Partitioned, 100k events × 100 hosts (the gRPC use case):
                                     wall (ms)    heap (MB)
  single rolling baseline                95.20       74.33
  two separate rollings (V7 shape)      141.12      101.71
  fused two-window (V8 shape)           112.36       68.46

Fused vs V7 shape:    -20.4% wall,  -32.7% heap
Fused vs baseline:    +18.0% wall,   -7.9% heap

Partitioned, 100k events × 1000 hosts (saturation):
                                     wall (ms)    heap (MB)
  two separate rollings (V7 shape)      700.35      556.56
  fused two-window (V8 shape)           446.21      309.25

Fused vs V7 shape:    -36.3% wall,  -44.4% heap
```

**Scaling beyond two windows — the architectural argument
verified.** Every per-event pond hop runs ONCE in fused vs N times
in N separate rollings. The bench scales N from 2 to 5 windows
over the same 100k-events × 100-hosts source:

```
                Separate (ms)   Fused (ms)   Wall delta
  N = 2            152.91         102.91       -32.7%
  N = 3            186.63          79.89       -57.2%
  N = 4            245.42         107.51       -56.2%
  N = 5            279.79         118.90       -57.5%

                Separate (MB)   Fused (MB)   Heap delta
  N = 2            108.13          72.20       -33.2%
  N = 3             93.30          43.08       -53.8%
  N = 4            113.69          47.19       -58.5%
  N = 5            137.17          47.12       -65.6%
```

Fused stays roughly constant (~100ms) across N=2..5; separate
scales linearly. At N=5: **2.4× faster wall, 34% of the heap.**

The architectural cliff is closed and the win compounds with N.
Fused rolling's per-event cost is O(1) in the number of windows
for pipeline overhead — only O(N) for the unavoidable per-window
reducer-state updates (which separate also pays). Heap is
dominated by the saved per-rolling deque + per-partition state.

### Notes on what this does NOT include

- **`live.reduce(mapping)` sugar.** Designed in PLAN as
  `live.rolling({ buffer: mapping }, { history: false })`; the
  `'buffer'` sentinel is reserved at the type level but throws at
  runtime for now. Lands with the buffer-as-window Tier 1 PR.
- **`TimeSeries.rolling` snapshot-side parity.** The keyed-form
  overload is live-side only in v0.15.0; batch-side comes in a
  follow-up.
- **Path A (share `LiveSeries` buffer).** Currently Path B (own
  deque) — fused rolling subscribes via `'event'` and maintains
  its own per-partition deque. Path A is a transparent perf
  follow-up; same API.
- **Compile-time uniqueness check on output columns.** Runtime
  check is in place; the type-level `CheckUniqueOutputs` helper
  is parked as a follow-up. Same with tightening `DurationString`
  to reject `'1min'`-style typos at the type level (today's
  template-literal type is permissive; runtime `parseDuration`
  catches malformed durations).

### Migration

Existing `live.rolling(window, mapping, opts)` calls are
unchanged. The keyed form is opt-in and additive. Two-rolling
patterns can migrate by collapsing to one fused call:

```ts
// Before:
const baseline = byHost.rolling('1m', m1, { trigger });
const slice = byHost.rolling('200ms', m2, { trigger });
// Then a per-(ts, host) join over both event streams …

// After:
const fused = byHost.rolling({ '1m': m1, '200ms': m2 }, { trigger });
fused.on('event', (e) => {
  // All columns from both windows on one event.
});
```

[0.15.0]: https://github.com/pjm17971/pond-ts/compare/v0.14.3...v0.15.0

## [0.14.3] — 2026-05-04

A targeted allocation fix in the `'samples'` reducer's rolling-state
implementation. Motivated by gRPC experiment V7 numbers — at the
ceiling regime (1k partitions × 1k events/s, 1M target) the all-
pond pipeline using `samples()` regressed throughput ~19% vs V6's
hybrid pond-rolling + manual-deque pattern, with +17% heap at
moderate loads. Per-event cost analysis pointed at a 1-element
`ScalarValue[]` allocation per scalar `add()` — one wasted
allocation per event compounding under sustained kHz × N-partition
load.

### Changed

- **`samples.rollingState()` skips array wrap for scalar source
  columns.** Scalar values (the common case at saturation) now
  store directly into the keyed map; only array-kind sources
  build a sub-array (because `remove(index)` needs to drop a
  single event's contributions together). Snapshot branches on
  `Array.isArray` to flatten the mixed map.

  ```
  Focused micro-bench (5M scalar add+remove cycles):
                       median (ms)   min (ms)   max (ms)
  baseline (v0.14.2)      239.85      236.62     244.58
  v0.14.3                 209.09      207.42     215.26
  delta                   −12.8%      −12.3%     −12.0%

  Integration bench (100k events × N hosts, full pipeline):
  Tight wall-clock parity within run-to-run noise across all
  scenarios (samples 1m/5s, scalar/array). Allocation pressure
  isn't the dominant cost at this scale; the optimization
  compounds only at saturation regimes where GC pressure stacks.
  ```

  Behavior is preserved bit-for-bit — every existing
  `samples-reducer.test.ts` assertion passes without modification.

### Added

- `packages/core/scripts/perf-samples-reducer.mjs` — benchmark
  covering the focused micro-bench + four integration scenarios
  (scalar moderate / scalar high-cardinality / scalar high-churn
  / array source) with a comparison anchor against `'avg'` on
  the same shape. Run with `node --expose-gc` for heap numbers.

### Note on saturation regimes

V7's regression isn't fully closed by this fix. The remaining gap
is architectural — V7 routes events through two full
`LiveRollingAggregation` pipelines (Map ops + reducer state +
trigger dispatch + subscriber fan-out per pipeline), where V6's
hybrid had one pond rolling for stats plus a passive
`array.push` listener for raw values. At the kHz × 1k-partition
saturation regime, the manual-deque pattern is genuinely the
right shape; pond's `samples` is for typical loads where per-
event overhead is invisible. A shared-buffer primitive (parked
as `tap()` in PLAN.md) would close the saturation gap; out of
scope for v0.14.3.

[0.14.3]: https://github.com/pjm17971/pond-ts/compare/v0.14.2...v0.14.3

## [0.14.2] — 2026-05-03

Hotfix over v0.14.1 — closes a type-narrowing gap on the new
`'samples'` reducer that the v0.14.1 Layer 2 review caught
post-merge. The runtime worked, but TypeScript didn't know about
`'samples'`: passing it through `series.aggregate({ col: 'samples' })`
or `live.rolling(window, { col: 'samples' })` produced
`Type '"samples"' is not assignable to type 'AggregateReducer'`,
and `series.reduce({ col: 'samples' }).col` fell through to
`ColumnValue | undefined` instead of the narrowed array type.

### Fixed

- **`'samples'` is now in the type system everywhere.** Added to
  `AggregateFunction` union, both branches of
  `AggregateFunctionsForKind` (numeric and array/string/boolean),
  `AggregateKindForColumn` (so output columns get
  `kind: 'array'`), `ArrayAggregateKind`, and the array branch of
  `ReduceResult` in `types-reduce.ts`.

  ```ts
  // Pre-v0.14.2: TS error, but ran correctly.
  // Post-v0.14.2: typechecks and narrows the same way `unique` and
  // `top${N}` do — `ReadonlyArray<T>` for source kind T.
  series.reduce({ vals: 'samples' }).vals; // ReadonlyArray<number> | undefined

  series.aggregate(Sequence.every('5s'), { vals: 'samples' });
  // Output column: { name: 'vals', kind: 'array' }
  ```

- **`reducer-reference.mdx`** updated: "14 built-in reducers" → 15.

### Added

- `test-d/types.test-d.ts` block pinning `'samples'` narrowing
  parity with `'unique'` / `'top${N}'`. Closes the regression hole
  the v0.14.1 review surfaced.

### Known follow-up

The v0.14.1 review also flagged that `npm run verify`'s
`test:type` step uses `tsconfig.types.json` (covers `src` +
`test-d/`), not `tsconfig.vitest.json` (covers `test/`) — that's
why the missing `'samples'` narrowing didn't fail CI even though
`packages/core/test/samples-reducer.test.ts` had ~30 type errors.
Captured in DOCPLAN.md / PLAN.md as a future safety-net widening;
not in scope for v0.14.2 because pre-existing test files have
their own type drift that would need cleanup first.

[0.14.2]: https://github.com/pjm17971/pond-ts/compare/v0.14.1...v0.14.2

## [0.14.1] — 2026-05-03

The "samples reducer + lifted custom-fn guard" release. Surfaced by
the gRPC experiment's step-4 (anomaly density) walkback: the use
case "compute counts of values exceeding `k·σ` from a baseline" needs
the **raw values** from the rolling window, but pond's existing
built-ins all collapse to scalars or deduplicate. Custom-function
reducers — which would cover the use case cleanly — worked on batch
but were rejected at runtime on live with a `TypeError` pointing at
`AggregateOutputMap` aliases (which don't actually solve "all values"
either). Two related changes ship together to close both gaps.

### Added

- **`'samples'` built-in reducer.** Returns the bucket's defined
  values as an array, in arrival order, with duplicates preserved.
  Sits beside `'unique'` (which deduplicates) and `'top${N}'` (which
  bounds and frequency-orders) — same array-output kind, same
  type-system narrowing through `AggregateOutputMap`. Library-
  implemented; per-event cost is O(1) `add` / O(1) `remove`
  (Map-keyed by event index); `snapshot` is O(N) array copy.
  Memory O(window size).

  ```ts
  // Anomaly density: count samples > k·σ from a separate baseline.
  const stats = live.rolling(
    '1m',
    {
      mean: { from: 'cpu', using: 'avg' },
      sd: { from: 'cpu', using: 'stdev' },
    },
    { trigger: Trigger.every('30s') },
  );

  const recent = live.rolling('200ms', {
    vals: { from: 'cpu', using: 'samples' },
  });

  // At each tick, count threshold crossings against the baseline:
  stats.on('event', (e) => {
    const samples = recent.value().vals as ReadonlyArray<number>;
    const counts = thresholds.map(
      (k) => samples.filter((v) => v - e.get('mean') > k * e.get('sd')).length,
    );
    // ... emit anomaly density
  });
  ```

  Like `unique`, `samples` flattens one level on array-kind source
  columns. Returns `[]` for an empty bucket.

### Changed

- **Custom-function reducers now work on live.** Removed the runtime
  `TypeError` guards on `LiveAggregation`, `LiveRollingAggregation`,
  and `LivePartitionedSyncRolling` that previously rejected
  function-typed reducers. New `bucketStateFor` and `rollingStateFor`
  helpers in `reducers/index.ts` route built-ins to their dedicated
  O(1) machinery and wrap custom functions in a generic adapter:
  - **Bucket adapter** (`LiveAggregation`): buffers values, calls
    the function once at `snapshot()` time. O(N) per snapshot.
  - **Rolling adapter** (`LiveRollingAggregation`,
    `LivePartitionedSyncRolling`): Map-keyed by event index for O(1)
    `add` / O(1) `remove`; `snapshot()` calls the function with
    `Array.from(map.values())` in arrival order. **O(N) per
    snapshot** — the function re-runs over the current window each
    time the accumulator emits.

  Documented as the explicit trade-off: convenience of writing
  `(values) => ...` inline against the perf cliff at high event
  rates. For high-throughput streams prefer built-ins or `'samples'`
  (collapse the window once on the producer side, run custom logic
  on the consumer). For low-rate dashboards / debug pipelines /
  prototypes, the convenience usually wins.

  Pre-v0.14.1, calling `live.rolling(...)` with a custom-function
  reducer threw `TypeError: live rolling reducer for output 'X' must
be a built-in name; ...`. Post-v0.14.1, the same call constructs
  successfully and runs.

### Tests

- 15 new tests in `test/samples-reducer.test.ts` covering: batch
  reduce / aggregate / rolling (including the array-source
  flattening); live aggregate (per-bucket arrays); live rolling
  (window eviction, snapshot correctness through multiple cycles);
  synced partitioned rolling with samples per partition; an
  end-to-end anomaly-density-against-baseline scenario.
- 2 obsolete tests in `LiveAggregateOutputMap.test.ts` rewritten —
  previously asserted the rejection error, now assert that custom
  functions construct successfully and produce the right value.
- Total core tests: 1087 (was 1072).

### Docs

- `pond-ts/transforms/reducer-reference.mdx`: new `'samples'` entry
  in the Array-producing reducers section; "Choosing a reducer"
  matrix updated; empty-bucket and rolling-complexity tables
  updated; Custom reducers section gained the live perf-cliff
  callout.
- `pond-ts/transforms/rolling.mdx`: replaced the "Custom-function
  reducers are batch-only" note with the new "O(N) per snapshot on
  live" perf-cliff note pointing at the reducer reference.

[0.14.1]: https://github.com/pjm17971/pond-ts/compare/v0.14.0...v0.14.1

## [0.14.0] — 2026-05-01

Two perf wins driven by the gRPC experiment's V3 profiling pass
(PR #14 on `pond-grpc-experiment`): `estimateEventBytes` at 6.2%
self time and the partition router's `Event → row → Event`
round-trip (combined ~7% in `#validateRow` + `Event` constructor
re-allocations). Both root-caused, both fixed.

Benchmark deltas on `scripts/perf-live-partitioned.mjs`
(100k events, median ms):

| Scenario                             | Before | After |        Δ |
| ------------------------------------ | -----: | ----: | -------: |
| bare `LiveSeries.push`               |  41.11 | 30.08 | **−27%** |
| `partitionBy('host')` routing (10)   |  83.14 | 39.10 | **−53%** |
| `partitionBy + collect()`            | 124.82 | 49.96 | **−60%** |
| `partitionBy + apply(fill)`          | 120.53 | 49.64 | **−59%** |
| `partitionBy('host')` routing (1000) | 105.92 | 43.23 | **−59%** |

The bare-push delta is from the byte-estimate removal; the
partition-routing deltas are from the trusted-pipeline path that
skips `Event → row → Event` reconstruction at every routing hop.

### Removed (breaking, pre-1.0)

- **`retention.maxBytes`** option on `LiveSeriesOptions`. Speculative
  feature from pre-v0.10 that no real user has reached for. Use
  `retention.maxEvents` for count-based caps; `maxBytes` was
  approximate (rough per-event byte estimate) and the imprecision
  meant it was rarely used as designed.

  Migration: replace `{ retention: { maxBytes: N } }` with
  `{ retention: { maxEvents: M } }` where M is your desired
  upper bound on event count.

### Changed

- **`estimateEventBytes` and the `#byteEstimate` accumulator
  removed** from `LiveSeries`. Closes the 6.2% per-push self-time
  line the gRPC experiment surfaced. Bare push is now ~27% faster
  for the typical case where `maxBytes` was never set.

- **Partition router uses a trusted-pipeline fast path.**
  `LivePartitionedSeries.#routeEvent`, `collect()`, and `apply()`
  previously round-tripped `Event → row → Event` at every routing
  hop — re-validating and re-allocating Events that the source
  pipeline had already constructed. New `_pushTrustedEvents` method
  on `LiveSeries` accepts pre-validated Event references (under a
  schema-identity contract; only used internally where the source
  and target schemas are guaranteed identical). Closes the ~7%
  combined self-time line in `#validateRow` (×2) and `Event`
  constructor (×2) that the gRPC profile flagged.

  Trusted-pipeline applies to: the source-to-partition route, the
  per-partition replay-on-construct prefix, the unified-buffer
  `collect()` subscriber, and `apply()`'s factory-output forwarding.
  All four sites had identical schemas at both ends — the trust
  contract holds without runtime re-checking.

  `_pushTrustedEvents` is `@internal` and not exported from the
  public type surface. Reach for `pushMany` from any external
  context; the trusted variant skips schema validation and is
  only safe for pond's own internal pipelines.

### Tests

- 4 new tests in `test/LiveSeries.test.ts` for the trusted-pipeline
  path: insertion without re-validation, listener fan-out and
  retention behaviour, ordering enforcement (strict still rejects
  out-of-order on the trusted path — the trust contract is only
  about validation/allocation, not insertion ordering), empty-array
  no-op.
- Removed the `retention: maxBytes` describe block in
  `test/LiveSeries.test.ts` and the `forwards retention.maxBytes`
  assertion in `test/LiveSeries.snapshot-append.test.ts`.
- Total core tests: 1072 (was 1070; +4 new for the trusted path,
  −2 for the removed maxBytes assertions).

### Docs

- `live-series.mdx`: retention table and example trimmed to
  `maxEvents` + `maxAge` only. Removed the byte-estimate prose.

[0.14.0]: https://github.com/pjm17971/pond-ts/compare/v0.13.2...v0.14.0

## [0.13.2] — 2026-05-01

Strictly additive over v0.13.1. Adds `Trigger.count(n)` per the
second wave of Codex feedback after webapp-telemetry adoption. Use
case: "very hot metrics like row stale times or handler payload
sizes where event-time boundaries may lag during bursts, but
per-event is too noisy."

### Added

- **`Trigger.count(n)`** — third trigger primitive alongside
  `Trigger.event()` and `Trigger.clock(seq)` /
  `Trigger.every(duration)`. Emits one rolling-window snapshot
  every `n` source events, with the counter resetting on each fire
  (so "events since the last emission," not "every Nth event modulo
  the input"):

  ```ts
  const rolling = timings.rolling(
    '5m',
    { latency: 'p95' },
    { trigger: Trigger.count(1000) },
  );
  ```

  - **Data-driven** — counter only advances on event ingestion, no
    `setTimeout` inside the library. The first emission fires on
    the `n`th event, not the first.
  - **Per-partition** — when applied via `partitionBy(...).rolling(...)`,
    each partition counts independently. Count does not synchronise
    emission across partitions; use `Trigger.clock` for that.
  - **Rejects non-positive integers** — `Trigger.count(0)`,
    `Trigger.count(-1)`, `Trigger.count(1.5)`, and `Trigger.count(NaN)`
    throw at construction with a clear error.

### Changed

- **Trigger taxonomy expanded.** `Trigger` union is now
  `EventTrigger | ClockTrigger | CountTrigger`. Per-partition
  rolling overload widened to accept count triggers and route them
  to the `LivePartitionedView` per-partition path (not the synced
  rolling — count semantics across partitions are ambiguous and
  there's no killer use case for either choice yet).

### Docs

- `live-transforms.mdx`: trigger section now lists all three
  primitives up front with a dedicated subsection on count
  semantics. JSDoc on `LiveRollingAggregation.trigger` updated to
  mention count.
- PLAN.md: trigger-taxonomy expansion RFC sketch captured —
  documents the shipped `count` plus deferred decisions on `idle`
  (the wall-clock crossing, requires its own RFC), `any` (composite,
  ships after singletons exist), and `threshold` / `manual`
  (declined / deferred as misclassified or sugar over existing
  primitives).

### Tests

- 7 new tests in `test/Triggers.test.ts`:
  - `Trigger.count(n)` shape and freeze
  - Non-positive integer rejection (zero, negative, fractional, NaN)
  - Emission cadence: snapshots every Nth event with correct
    rolling-window values
  - `Trigger.count(1)` behavioural equivalence to `Trigger.event()`
  - No emission during quiet periods (data-driven)
  - `rolling.value()` independent of trigger
  - Per-partition independent counting via
    `partitionBy().rolling(..., { trigger: Trigger.count(2) })`
- Total core tests: 1070 (was 1063).

[0.13.2]: https://github.com/pjm17971/pond-ts/compare/v0.13.1...v0.13.2

## [0.13.1] — 2026-05-01

Strictly additive over v0.13.0. Adds a sugar factory on `Trigger`
following Codex feedback after adopting v0.12 triggers in the
production webapp telemetry app: the explicit form
(`Trigger.clock(Sequence.every('30s'))`) is "ceremony-heavy for the
common case."

### Added

- **`Trigger.every(duration, options?)`** — sugar for the common
  `Trigger.clock(Sequence.every(duration, options))` pattern. Removes
  the need to import `Sequence` for trigger-only use sites. Forwards
  `{ anchor }` to `Sequence.every` and inherits the same fixed-step
  validation:

  ```ts
  // Before
  live.rolling('1m', mapping, {
    trigger: Trigger.clock(Sequence.every('30s')),
  });

  // After
  live.rolling('1m', mapping, { trigger: Trigger.every('30s') });

  // Anchored variant (passes through to Sequence.every):
  Trigger.every('30s', { anchor: 5_000 });
  ```

  The explicit `Trigger.clock(seq)` form remains for callers who
  already hold a `Sequence` object (e.g. one shared across batch
  `series.aggregate(seq, ...)` and live triggers) — `Trigger.every`
  always builds a fresh `Sequence`.

### Docs

- Telemetry recipe and live-transforms doc updated to lead with
  the sugar form. `Trigger.clock` documented as the explicit form
  for "I already have a Sequence object" cases.
- JSDoc on `LiveRollingAggregation.trigger` and the partitioned
  rolling clock-trigger example updated to show the sugar.

### Tests

- 3 new tests in `test/Triggers.test.ts` covering: sugar produces
  `kind: 'clock'` with correct stepMs/anchor; anchor option
  forwards correctly; behavioural equivalence between
  `Trigger.every('30s')` and `Trigger.clock(Sequence.every('30s'))`
  pinned by emission-time comparison through a real
  `LiveRollingAggregation`.
- Total core tests: 1063 (was 1060).

[0.13.1]: https://github.com/pjm17971/pond-ts/compare/v0.13.0...v0.13.1

## [0.13.0] — 2026-05-01

The "AggregateOutputMap on live" release. Closes the feature-parity
gap between batch and live aggregation: the `{ alias: { from, using } }`
mapping shape that batch `TimeSeries.rolling`/`aggregate` already
accepted now works on `LiveSeries.rolling`, `LiveSeries.aggregate`,
and the synchronised partitioned form. Multiple stats from one
source column in a single rolling deque — no more "one rolling per
percentile" workaround.

The shared runtime helper (`normalizeAggregateColumns`) was already
doing the work for batch; this release extracts it to
`aggregate-columns.ts` and threads the type-level overloads through
the live surface.

### Added

- **`AggregateOutputMap` on `LiveSeries.rolling` and
  `LiveSeries.aggregate`.** Compose multiple built-in reducers from
  one source column in a single pass:

  ```ts
  const band = live.rolling('1m', {
    mean: { from: 'cpu', using: 'avg' },
    sd: { from: 'cpu', using: 'stdev' },
  });
  band.value(); // { mean, sd } — single deque, one walk
  ```

  Threaded through `LiveView.rolling`/`aggregate`,
  `LiveAggregation.rolling`, `LiveRollingAggregation.aggregate`,
  `LivePartitionedSeries.rolling`, and `LivePartitionedView.rolling`
  — so chained pipelines (`live.filter(...).rolling(...)`,
  `live.partitionBy(c).fill(...).rolling(..., { trigger: ... })`)
  accept either shape.

- **Synchronised partitioned rolling with `AggregateOutputMap`.**
  `partitionBy(col).rolling(window, mapping, { trigger: Trigger.clock(seq) })`
  now accepts the alias form. Output schema becomes
  `[time, <partitionColumn>, ...aliasColumns]`. The collision check
  rejects when an alias output collides with the partition column
  name (compare against the alias, not the source column).

### Changed

- **Better error message when a custom-function reducer is passed to
  live aggregation.** `LiveAggregation` already failed at construction
  via `resolveReducer(reducer)` (with a generic `unsupported aggregate
reducer` message); now the eager built-in-name check runs first and
  emits a targeted error pointing at the `AggregateOutputMap` alias
  workaround. Same eager behavior on `LivePartitionedSyncRolling`,
  which previously failed lazily when the first partition spawned —
  now fails at construction. Aligns with `LiveRollingAggregation`'s
  long-standing eager check.

- **Shared `normalizeAggregateColumns` helper.** Extracted from
  `TimeSeries.ts` into `aggregate-columns.ts` and used by all three
  live accumulators (`LiveRollingAggregation`, `LiveAggregation`,
  `LivePartitionedSyncRolling`). Single source of truth for column
  normalisation; identical error messages across batch and live
  (`unknown source column`).

### Constraints

- **Custom-function reducers remain batch-only.** Live rolling and
  live aggregation still require built-in reducer names (`'avg'`,
  `'p95'`, etc.). Custom `(values) => ...` functions don't have the
  incremental add/remove machinery the live path needs and are
  rejected at construction with a clear error pointing at the
  `AggregateOutputMap` workaround. This is the established
  recommendation: alias multiple built-ins to compose stats from
  one source column.

### Fixed

- **`partitionBy(...).rolling(..., options)` now accepts `options` as
  a variable typed `LiveRollingOptions`, not just inline literals.**
  Pre-fix, the four narrowed overloads on
  `LivePartitionedSeries.rolling` and `LivePartitionedView.rolling`
  required TS to see the `trigger` field's discriminator at the call
  site — so a caller writing
  `const opts: LiveRollingOptions = { trigger: Trigger.event() };
partitioned.rolling(window, mapping, opts);` got `TS2769 No
overload matches this call`. Pre-existing hole on the partitioned
  surface; surfaced by the v0.13.0 Codex adversarial pass. Closed by
  adding catch-all overloads that accept the broader
  `LiveRollingOptions` and return the union of both trigger
  branches; the four narrowed overloads above still match inline
  literals first, so callers keep the precise return type when they
  pass the trigger inline. Pinned with `test-d/types.test-d.ts`
  coverage using both inline-literal and variable forms.

### Tests

- 16 new tests in `test/LiveAggregateOutputMap.test.ts` covering:
  flat live rolling/aggregate with the alias form, chained-view
  rolling/aggregate, `LiveAggregation.rolling` and
  `LiveRollingAggregation.aggregate` chainable accumulators,
  per-partition rolling, synchronised partitioned rolling with
  alias outputs, output-vs-source column-collision rejection on
  the synced form, and explicit kind override.
- 2 existing tests updated (`LiveAggregation` and
  `LiveRollingAggregation` "unknown column" → "unknown source column"
  to match the shared helper's error string).
- Test count: 1060 (was 1044).

### Docs

- `transforms/rolling.mdx`: live section now documents the
  `AggregateOutputMap` shape with a band-chart example, plus a
  callout that custom functions remain batch-only.
- `recipes/telemetry-reporting.mdx`: "Want multiple percentiles?"
  section rewritten — the workaround note is gone, replaced with
  the single-pass `{ p50, p95, p99 }` pattern.

[0.13.0]: https://github.com/pjm17971/pond-ts/compare/v0.12.1...v0.13.0

## [0.12.1] — 2026-05-01

Strictly additive over v0.12.0. Closes the chained-view restriction
on synchronised partitioned rolling. The trigger option now applies
consistently across the entire `rolling()` surface — chained sugar
methods on the partitioned surface (`fill`, `diff`, `rate`,
`pctChange`, `cumulative`) no longer break it.

### Changed

- **`partitionBy(col).<chained>().rolling(window, m, { trigger: Trigger.clock(seq) })` now works.**
  Previously this threw a clear-but-restrictive error. The chain
  factory runs per partition; the sync rolling subscribes to each
  chain output instead of the raw partition events. Output schema is
  unchanged (`[time, <partitionColumn>, ...mappingColumns]`); the
  partition tag is set from the routing key, so chains that drop the
  partition column still emit correctly.

  Motivating example — per-host gap-filling before synchronised
  ticks:

  ```ts
  const ticks = live
    .partitionBy('host')
    .fill({ cpu: 'hold' })
    .rolling(
      '1m',
      { cpu: 'avg' },
      { trigger: Trigger.clock(Sequence.every('200ms')) },
    );
  ```

  Coherence-of-feature fix: the trigger concept now applies wherever
  `rolling()` appears in the partitioned chain, not just in the
  one-step case. Captured in the RFC's post-implementation notes
  alongside the deferred-and-now-shipped section.

### Tests

- 4 new tests in `test/Triggers.test.ts` covering chained-view sync
  rolling: `fill().rolling(.., trigger)`, output schema, cross-
  partition synchronisation through the chain, dispose semantics
  through the chain, and replay-on-construction with the chain factory.
- 1 test removed (the throw-on-chained-view assertion that no longer
  applies).
- Test count: 34 (was 30). Total core tests: 1043 (was 1039).

[0.12.1]: https://github.com/pjm17971/pond-ts/compare/v0.12.0...v0.12.1

## [0.12.0] — 2026-05-01

The "triggers" release. Major redesign of how live accumulators
control emission cadence — `Trigger` is now a first-class concept
shaped by two converging real-world use cases (synchronised
partitioned tick aggregation in the gRPC pipeline experiment,
sequence-sampled rolling in webapp telemetry).

Two correctness audits before publish: a Layer 2 Claude review
(column collision, dispose, late-spawn, peer-dep) and a Codex
adversarial review (quiet-partition stale samples, pre-existing
data replay at construction, spawn-listener cleanup). All findings
fixed and pinned with regression tests. 1039 / 1039 tests pass.

### Added

- **Trigger as a first-class concept.** A new `Trigger` factory
  exposed at the package root lets `LiveRollingAggregation` switch
  emission cadence without changing any other shape:

  ```ts
  import { LiveSeries, Sequence, Trigger } from 'pond-ts';

  // Webapp telemetry: rolling 1m p95, emit on every 30 s of event-time
  const rolling = timings.rolling(
    '1m',
    { latency: 'p95' },
    { trigger: Trigger.clock(Sequence.every('30s')) },
  );

  rolling.on('event', (e) =>
    fetch('/api/telemetry', { method: 'POST', body: JSON.stringify(e.data()) }),
  );
  rolling.value(); // current rolling-window snapshot, independent of trigger
  ```

  Two trigger variants in this release:
  - **`Trigger.event()`** — per-event emission. Default; the historical
    behavior of `LiveRollingAggregation` when no trigger is specified.
  - **`Trigger.clock(sequence)`** — sequence-triggered emission. One
    snapshot fires when a source event crosses an epoch-aligned
    boundary of the (fixed-step) `Sequence`. Output keyed at boundary
    instants. Calendar sequences are rejected upfront.

  Future variants (`Trigger.count(n)`, custom predicates, compound
  triggers) are reserved but not yet shipped.

- **Synchronised partitioned rolling.** `LivePartitionedSeries.rolling`
  now accepts a clock trigger. The output is a
  `LiveSource<RowSchema>` whose schema is `[time, <partitionColumn>,
...mappingColumns]`; on every boundary crossing, one event fires
  per known partition, all sharing the same boundary timestamp.
  Synchronised across partitions by construction (the bucket index is
  shared, not per-partition).

  ```ts
  // Dashboard tick aggregation: 100 hosts, 200ms cadence
  const ticks = live
    .partitionBy('host')
    .rolling(
      '1m',
      { cpu: 'avg' },
      { trigger: Trigger.clock(Sequence.every('200ms')) },
    );

  ticks.on('event', (e) => {
    // e.begin() === <boundary timestamp>, same for every host this tick
    // e.get('host') === 'api-1' | 'api-2' | …
    // e.get('cpu') === <rolling avg for that host>
  });
  ```

  Restricted to direct-after-`partitionBy` in this release: chained
  sugar (`partitionBy(c).fill(...).rolling(...)`) rejects clock
  triggers with a clear error. Lifts in a future release once a real
  use case appears.

  Closes the gRPC experiment's M3.5 dashboard friction note (the
  hand-rolled `HostAggregator` becomes ~10 lines of pond code).

### Removed (breaking — pre-1.0)

- **`LiveSequenceRollingAggregation`** class deleted. Its capability
  is preserved as `LiveRollingAggregation` with
  `{ trigger: Trigger.clock(sequence) }`. Migration: replace
  `live.rolling('1m', m).sample(seq)` with
  `live.rolling('1m', m, { trigger: Trigger.clock(seq) })`. Single
  rolling object now serves both backend reporting and direct
  `.value()` reads (no separate sampler reference).
- **`.sample(sequence)`** method removed from `LiveRollingAggregation`.
  Use the trigger option above.

### Changed

- **`LiveRollingOptions`** gains an optional `trigger?: Trigger`
  field. Default behavior (no `trigger` specified) is unchanged from
  v0.11.x — per-event emission. Backward compatible for everyone
  who didn't use `.sample()`.

### Performance

- New benchmark `scripts/perf-triggers.mjs` covers both
  non-partitioned and synchronised partitioned cases. Headline numbers
  on a current MacBook Pro:
  - Non-partitioned: clock(30s) ~50% faster than per-event baseline
    (emission is rarer); clock(1s) similar.
  - Synchronised partitioned (100 hosts, 30k events at realistic
    rates): ~300 ns/emission at 200ms cadence; +205% over per-
    partition baseline at the high end. Well within budget for the
    motivating dashboard use case.

### Notes

- **`docs/rfcs/triggers.md`** captures the full design rationale,
  the four sign-off questions, and the migration plan. Read this if
  you want the "why this shape" context.

### Known limitations

- **Synchronised partitioned rolling output type is loose** —
  `LiveSource<SeriesSchema>` rather than a schema-narrowed shape.
  Runtime schema is correct; only static types widen. Tightening is
  queued for a follow-up release.
- **Synchronised partitioned rolling rejects column-name collisions**
  between the partition column and any reducer-output column at
  construction (e.g. `partitionBy('cpu').rolling('1m', { cpu: 'avg' }, { trigger })`).
  Rename the reducer output (once `AggregateOutputMap` lands on live
  rolling) or partition by a different column.
- **Late-spawn partitions only appear in ticks after their first event
  arrives.** A partition unknown to the sync source contributes no
  row to the current tick. Use `partitionBy(col, { groups: [...] })`
  to eagerly include partitions from construction.

## [0.11.8] — 2026-04-30

### Added

- **`rolling.sample(sequence)`** on `LiveRollingAggregation` — taps a
  rolling aggregation and emits one snapshot of the rolling state each
  time a source event crosses an epoch-aligned boundary of `sequence`.
  Closes the frontend-telemetry gap: collect high-frequency timing
  events, sample p95 latency to a backend every 30 s, while the same
  rolling drives an in-app live display (no duplicated deque).

  ```ts
  const rolling = timings.rolling('1m', { latency: 'p95' });

  // One sampler → backend report every 30 s of event time
  const reported = rolling.sample(Sequence.every('30s'));
  reported.on('event', (e) =>
    fetch('/api/telemetry', { method: 'POST', body: JSON.stringify(e.data()) }),
  );

  // Same rolling drives the UI live display
  useLiveQuery(timings, () => rolling.value());
  ```

  `sequence` must be a fixed-step `Sequence`; calendar sequences
  (`Sequence.daily()` etc.) are rejected upfront — boundary indexing
  needs a constant step.

  Emission is **data-driven**: no `setInterval`. If the source goes
  quiet, no events fire. A single source event spanning multiple
  boundaries fires exactly one event at the new bucket. Snapshot is
  taken after the boundary-crossing event is ingested by the rolling,
  so the emitted value includes that event's contribution.

  **Independent lifetimes.** `sample.dispose()` only detaches the
  sampler from the rolling; the rolling's lifecycle stays the user's
  responsibility. One rolling can power multiple `.sample()` cadences
  plus direct `rolling.value()` reads without coupling.

- **`LiveSequenceRollingAggregation` exported** from package root with
  full `LiveSource<Out>` surface and the same view-transform set as
  `LiveRollingAggregation` (`filter`, `map`, `select`, `window`,
  `diff`, `rate`, `pctChange`, `fill`, `cumulative`, `rolling`,
  `aggregate`).

- **Telemetry-reporting recipe** at
  `website/docs/recipes/telemetry-reporting.mdx` — end-to-end
  frontend-collection → backend-summary pattern using `.sample()`,
  plus the React in-app display via `useLiveQuery`.

[0.12.0]: https://github.com/pjm17971/pond-ts/compare/v0.11.8...v0.12.0
[0.11.8]: https://github.com/pjm17971/pond-ts/compare/v0.11.7...v0.11.8

## [0.11.7] — 2026-04-29

### Added

- **`LiveView.count()` and `LiveView.eventRate()` terminal accessors.**
  Read the current event count and events-per-second over a windowed
  view directly — closes the
  `useCurrent(live, { cpu: 'count' }, { tail: '1m' }).cpu / 60`
  boilerplate surfaced by the gRPC experiment.
  ```ts
  const eventsPerSec = live.window('1m').eventRate(); // events/sec
  const eventsInWindow = live.window('1m').count();
  ```
  `eventRate()` requires a time-based window (`window('1m')`) and
  throws on count-based windows (`window(100)`) — there's no
  denominator to use. Distinct from `LiveView.rate(columns)`,
  which is the per-column derivative operator (rate-of-change of
  values).
- `LiveView.{filter,map,select}` now propagate the parent's window
  duration to the child view, so chains like
  `live.window('1m').filter(...).eventRate()` work as expected.
- `@pond-ts/react` ships **`useEventRate(source, '1m')`** — a
  reactive hook returning the events-per-second number, throttled
  on `'event'` like `useSnapshot`. Hooks mounted on already-
  populated sources render the actual rate on first paint via
  lazy `useState` init.
  ```tsx
  const eventsPerSec = useEventRate(liveSeries, '1m');
  // <div>EVENT RATE {eventsPerSec.toFixed(1)}/s</div>
  ```

[0.11.7]: https://github.com/pjm17971/pond-ts/compare/v0.11.6...v0.11.7

## [0.11.6] — 2026-04-29

### Added

- **`LiveSeries.toJSON()` return-type narrowing on `rowFormat`.**
  Overloads keyed on `rowFormat: 'array' | 'object'` so consumers
  read `result.rows` without a cast. Tuple form returns
  `TimeSeriesJsonOutputArray<S>`; object form returns
  `TimeSeriesJsonOutputObject<S>`. Both new types exported from
  `pond-ts/types`. The companion narrowing on `TimeSeries.toJSON`
  is still parked — it cascades TS2394 errors through unrelated
  overload sets in `TimeSeries.ts`. See PLAN.md.
- New types: `TimeSeriesJsonOutputArray<S>` and
  `TimeSeriesJsonOutputObject<S>`. Use these for typed assignment
  (`const out: TimeSeriesJsonOutputArray<S> = ts.toJSON()`) or
  cast (`ts.toJSON() as TimeSeriesJsonOutputArray<S>`) until the
  `TimeSeries.toJSON` narrowing lands.

### Documentation

- `count` reducer JSDoc clarifies that **duplicate temporal keys
  do not collapse** — multiple events sharing one `Time` key each
  contribute independently to the count. Walks the per-column
  value array, not unique keys. Behavior is consistent across
  `reduce`, `aggregate`, `rolling`, `LiveAggregation`, and
  `LiveRollingAggregation` — pinned by `test/duplicate-keys.test.ts`
  (9 tests covering every layer including the
  "dashboard-defaults" 480-events-at-8/s scenario from the gRPC
  experiment's M1 friction notes).

[0.11.6]: https://github.com/pjm17971/pond-ts/compare/v0.11.5...v0.11.6

## [0.11.5] — 2026-04-29

### Fixed

- Published tarballs for both `pond-ts` and `@pond-ts/react` now
  include `README.md`, `LICENSE`, and `CHANGELOG.md`. Earlier
  releases shipped only `dist/` + `package.json`, which left the
  npm page rendering as "This package does not have a README"
  despite the comprehensive root README. The repo-root files were
  invisible to `npm pack` because npm publishes from the package
  directory and only auto-includes README/LICENSE when those files
  live in the package dir itself. Each package now has a `prepack`
  step that copies them in from the repo root before build.

[0.11.5]: https://github.com/pjm17971/pond-ts/compare/v0.11.4...v0.11.5

## [0.11.4] — 2026-04-29

### Added

- **`LiveSeries` snapshot/append primitives** — closes the gap
  where networked `LiveSeries` setups (gRPC, WebSocket fanout) had
  to hand-roll the parallel APIs that already existed on
  `TimeSeries`.
  - **Codec-agnostic typed-tuple primitives:** `LiveSeries.toRows()`,
    `LiveSeries.toObjects()`, `LiveSeries.pushMany(rows)`,
    `Event.toRow(schema)`. Operate in `RowForSchema<S>` typed
    tuples — JSON, MessagePack, protobuf, anything else applies at
    the application boundary, not inside the library.
  - **JSON sugar layered on top:** `LiveSeries.toJSON()`,
    `LiveSeries.fromJSON(input, options?)`,
    `LiveSeries.pushJson(rows)`, `Event.toJsonRow(schema)`. Closes
    the wire→push safety hole — `pushJson` validates a
    `JsonRowForSchema<S>` against the schema at compile time, so
    schema evolution breaks the call site instead of swallowing
    via `live.push(row as never)`.
  - **`pushMany(rows)` is non-variadic.** Pair with the existing
    variadic `push(...rows)` (now a one-line wrapper); reach for
    `pushMany` when ingesting a snapshot or any large array —
    variadic spread allocates a stack frame per element and can
    blow on multi-thousand-row snapshots.

  Surfaced by the gRPC experiment's M1 milestone
  ([pond-grpc-experiment#3](https://github.com/pjm17971/pond-grpc-experiment/pull/3)).
  See PLAN.md Phase 4 for the deferred adaptor-extraction
  framing (codec strategies parked until two real codecs exist
  in working code).

### Changed

- `LiveSeries.push(...rows)` is now a wrapper around
  `LiveSeries.pushMany(rows)`. Behavior is identical — same
  validation, listener fires, and retention pass.

[0.11.4]: https://github.com/pjm17971/pond-ts/compare/v0.11.3...v0.11.4

## [0.11.3] — 2026-04-28

### Added

- **`pond-ts/types` subpath export** — type-only entry point that
  exposes the schema-shape, row-shape, and JSON-shape types
  (`SeriesSchema`, `ColumnDef`, `RowForSchema`,
  `JsonRowForSchema`, etc.) without dragging in the runtime.
  Schema-as-contract consumers — packages whose only job is to
  declare the `as const` schema flowing through producer /
  aggregator / web — can now constrain literals via
  `satisfies SeriesSchema` without adding `pond-ts` as a runtime
  dependency. Surfaced by the gRPC experiment's `packages/shared`,
  where `import { SeriesSchema } from 'pond-ts'` would have
  pulled in the whole library for one type.

  ```ts
  import type { SeriesSchema } from 'pond-ts/types';
  export const schema = [
    { name: 'time', kind: 'time' },
    { name: 'cpu', kind: 'number' },
  ] as const satisfies SeriesSchema;
  ```

  Existing `import { SeriesSchema } from 'pond-ts'` calls keep
  working unchanged.

[0.11.3]: https://github.com/pjm17971/pond-ts/compare/v0.11.2...v0.11.3

## [0.11.2] — 2026-04-28

### Added

- `minSamples` option on `TimeSeries.rolling`,
  `PartitionedTimeSeries.rolling`, `LiveRollingAggregation`, and
  the `LivePartitionedSeries` rolling sugar — suppresses output
  rows whose window contains fewer than the configured number of
  source events. Forwarded to `TimeSeries.baseline` and
  `TimeSeries.outliers` (and their per-partition variants), which
  pass it to their internal rolling pass. Defaults to `0` (no
  gate) so existing call sites are unaffected. Use it on noisy
  rolling stats (e.g. the rolling stdev that feeds
  `baseline()`'s ±σ bands) to hide the warm-up region where a
  tiny-sample stdev would collapse the band tight enough to
  false-flag normal events.

[0.11.2]: https://github.com/pjm17971/pond-ts/compare/v0.11.1...v0.11.2

## [0.11.1] — 2026-04-27

Closes a packaging footgun the dashboard agent surfaced while
upgrading from `pond-ts@0.10.1` to `pond-ts@0.11.0`.

When users had `@pond-ts/react@0.10.1` (which declared
`dependencies: { "pond-ts": "^0.10.0" }`) and bumped only
`pond-ts` to `0.11.0`, npm satisfied the react package's `^0.10.0`
range by nesting a _second_ copy of `pond-ts@0.10.1` under
`@pond-ts/react/node_modules/`. Two pond-ts copies meant two
distinct `Sequence` / `Time` / etc. classes with non-shared JS
private (`#`) brands. TypeScript surfaced this as
`Property '#private' refers to a different member`, which is
opaque without the package context.

### Changed

- **`@pond-ts/react`**: moved `pond-ts` from `dependencies` to
  `peerDependencies` (range unchanged: `^0.11.0`). With peer-dep
  semantics, npm refuses to install a duplicate `pond-ts`; instead
  it warns at install time about peer-version mismatch — concrete,
  actionable feedback rather than a runtime brand-check failure.

  This is the standard pattern for packages that wrap another
  library's classes (`react-dom` peer-deps `react`, etc.):
  `@pond-ts/react`'s hooks return and operate on `pond-ts`
  instances, so they MUST share class identity with the consumer's
  `pond-ts`.

  **Mild break:** consumers who installed only `@pond-ts/react`
  and relied on the transitive `pond-ts` will now get an npm
  warning and need to add `pond-ts` to their direct dependencies.
  In practice anyone using `@pond-ts/react` is already importing
  `pond-ts` types/classes, so the typical setup already has it
  declared explicitly.

### Notes

- **Why caret (`^0.11.0`) and not exact pin?** Pre-1.0 caret
  semver only accepts patches within the same minor (so
  `^0.11.0` matches 0.11.x but not 0.12.0). That already
  enforces minor-level lockstep — exact pinning would force
  consumers to bump both packages for every patch, even when one
  package's bump is a lockstep no-op.

[0.11.1]: https://github.com/pjm17971/pond-ts/compare/v0.11.0...v0.11.1

## [0.11.0] — 2026-04-27

The "live partitioning" release. Closes the cross-entity
correctness story end-to-end — the per-partition primitives we
shipped in v0.9.0 / v0.10.0 for batch now have a live counterpart
that handles ingestion, retention, grace, and stateful pipelines
on multi-host streams.

Without this, every multi-host live pipeline (rolling avg, fill,
diff, rate, cumulative, pctChange) silently mixes data across
entities — the same hazard the partitionBy work resolved for
batch, but live-side. Dashboard agent's v0.9.0 round-2 feedback
explicitly named "LivePartitionedSeries would be the obvious next
step" as the missing piece.

### Added

- **`liveSeries.partitionBy(col, options?)`** — returns
  `LivePartitionedSeries<S, K>`, the live counterpart to
  `PartitionedTimeSeries`. Routes events from a source
  `LiveSource<S>` into per-partition `LiveSeries<S>` sub-buffers,
  each with its own retention, grace window, and stateful
  operator pipeline.

  Per-partition semantics (settled in design):
  - Retention applies per partition (a chatty host can't squeeze
    a quiet one out of the buffer)
  - Grace windows apply per partition (late events touch only
    their own partition)
  - Aggregation timing is per partition (one host's rolling avg
    fires when that host has enough data)
  - Auto-spawn on new partition values; optional `groups` for
    typed declared partitions (mirrors batch typed-groups)

  Terminals:
  - `.toMap()` → `Map<K, LiveSource<S>>` for direct per-partition
    subscription
  - `.collect()` → unified `LiveSeries<S>` (append-only fan-in)
  - `.apply(factory)` → unified `LiveSeries<R>` with per-
    partition operator chains
  - `.dispose()` cleans up source subscription, all per-partition
    pipeline subscribers, and `toMap`-created factory chains

- **Typed chainable sugar** — `partitioned.fill(...).rolling(...).collect()`
  matches the batch chainable view. Sugar coverage on both
  `LivePartitionedSeries` and the chained `LivePartitionedView`:
  `fill`, `diff`, `rate`, `pctChange`, `cumulative`, `rolling`.

  ```ts
  const cpuSmoothed = live
    .partitionBy('host')
    .fill({ cpu: 'hold' })
    .rolling('1m', { cpu: 'avg', host: 'last' })
    .collect();
  ```

  `LivePartitionedView<SBase, R, K>` is a lazy chain step holding
  a composed factory; terminals delegate to the root partitioned
  series. Auto-spawn flows through the chain — a new partition
  triggers a fresh factory invocation.

- **`LivePartitionedView`** exported from package root.

- **`ARCHITECTURE.md`** at repo root — first-pass document for
  contributors (human or AI) reading the codebase cold. Covers
  layered model, stateful primitives, recurring patterns
  (typed-groups, trusted construction via `static #foo`,
  factory-based per-partition state, append-only fan-in vs
  mirrored materialization, per-method JSDoc warnings, perf-
  check discipline), decision log, and conventions.

### Changed

- **CLAUDE.md** points to `ARCHITECTURE.md` so future sessions
  discover it alongside `PLAN.md`.

### Notes

- **Append-only fan-in semantics** for `collect()` and `apply()`
  on `LivePartitionedSeries` — per-partition retention/grace
  evictions do NOT propagate to the unified buffer. Documented
  via JSDoc; the unified buffer's own retention is independent.
  Use `toMap()` for current per-partition state.

- **Post-commit error semantics for partition rejection** — when
  the partition view throws inside the source's event listener
  (rogue value, partition ordering rejection), the source has
  already committed the event. Documented in
  `LiveSeries.partitionBy` JSDoc; recommend upstream input
  validation if source/partition atomicity matters.

- **Rolling drops partition column unless explicitly added.**
  `LiveSeries.rolling` (and the partitioned chain via it) only
  retains columns named in `mapping` — include `host: 'last'` (or
  similar) to keep the partition tag visible in the unified
  output. Documented in `rolling`'s JSDoc on both the
  `LivePartitionedSeries` and `LivePartitionedView` surfaces.

### Performance

- Routing overhead measured at ~88ms for 100k events × 10 hosts
  (50ms over bare push). Apples-to-apples vs equivalent un-
  partitioned operator chains: ~1.8-2.6× cost. Constant per
  event (~0.8 µs); cardinality scales flat (Map lookup is O(1)).
  See `scripts/perf-live-partitioned.mjs`.

- An `_acceptEvent` private-method optimization to bypass row
  re-validation in partition routing was scoped and rejected for
  v0.11 — the benefit (~0.3-0.4 µs/event saved) is marginal for
  typical telemetry workloads (1-10k events/sec) and the cost
  (validation-bypass primitive on the public API surface) wasn't
  justified. May revisit if a high-throughput user surfaces the
  bottleneck with real workload data.

[0.11.0]: https://github.com/pjm17971/pond-ts/compare/v0.10.1...v0.11.0

## [0.10.1] — 2026-04-27

Strictly additive over v0.10.0. Closes the export gap surfaced by
the Codex CSV-cleaner v0.10 retest:

> `MaterializeSchema` exists in `dist/types.d.ts` but is not
> exported from the package root, so the script had to spell out
> the materialized schema locally for strict typing.

### Added

- **`MaterializeSchema<S>`** now exported from the package root.
  Users typing `materialize` output (or composing it into wrapper
  utilities) can import the type directly from `pond-ts` instead
  of digging into the dist-types.
- **`DedupeKeep<S>`** also exported (was the same gap — the type
  for the `dedupe({ keep })` resolver function shape). Closes the
  same friction for callers writing custom dedupe resolvers in
  isolation.

[0.10.1]: https://github.com/pjm17971/pond-ts/compare/v0.10.0...v0.10.1

## [0.10.0] — 2026-04-27

The "round-2 dashboard agent feedback" release. After v0.9.0
shipped the cross-entity correctness wave, three independent
agents (Codex CSV-cleaner, fresh CSV-cleaner eval, dashboard
agent) flagged refinements. v0.10 delivers all three:

- A grid-completion primitive that doesn't pre-pick a fill method
  (Codex's "regularize without filling" friction)
- A terminal `toMap` that materializes the partition view directly
  to a Map keyed by partition value (dashboard agent's
  `.collect().groupBy(col, fn)` chain pain)
- Typed partition declaration via `groups` for narrowed Map keys
  and declared-order iteration (dashboard agent's third
  refinement; mirrors `pivotByGroup({ groups })`)

Strictly additive over v0.9.x — no behavior changes for existing
callers.

### Added

- **`series.materialize(sequence, options?)`** — emits one
  time-keyed row per sequence bucket, populating value columns
  from a chosen source event in the bucket (or `undefined` for
  empty buckets). Does only the grid step; pairs naturally with
  `fill()` for explicit fill-policy control:

  ```ts
  series
    .partitionBy('host')
    .materialize(Sequence.every('1m'))
    .fill({ cpu: 'linear' }, { maxGap: '3m' })
    .collect();
  ```

  Three `select` modes: `'first'` / `'last'` (default) /
  `'nearest'` — all bucket-bounded; empty buckets emit
  `undefined` regardless. Three `sample` anchors:
  `'begin'` (default) / `'center'` / `'end'`. Output schema
  widens value columns to optional (`MaterializeSchema<S>`).

  The `PartitionedTimeSeries.materialize` sugar auto-populates
  the partition column on every output row, including
  empty-bucket rows — without this, downstream code would need a
  `.fill({ host: 'hold' })` step that fails for partitions where
  every event sits in a long-outage gap.

  Distinct from `align()` (which mandates a `'hold'` or
  `'linear'` fill method and returns interval-keyed) and
  `aggregate()` (which applies a per-column reducer). See
  `cleaning.mdx` for the full operator-comparison table.

- **`PartitionedTimeSeries.toMap(transform?)`** — terminal that
  returns `Map<key, TimeSeries<S>>` (or `Map<key, R>` with a
  transform) directly from the partition view. Replaces the
  `.collect().groupBy(col, fn)` chain dashboard code was using.

  Three overloads cover the common shapes: bare per-partition
  `TimeSeries`, transform that returns `TimeSeries<R>`, and
  transform that returns arbitrary `R`. Map iteration order
  matches the order each partition was first encountered in the
  source events (or declared order when `groups` is set).

  Map keys are stringified partition values for single-column
  partitions (preserving the natural string representation:
  `'api-1'`, `'eu'`, etc.), or JSON arrays for composite
  partitions (`'["api-1","eu"]'`). `undefined` partition values
  use the leading-space sentinel `' undefined'` to avoid
  collision with the literal string `'undefined'` — distinct
  from `groupBy`'s bare `'undefined'` key, which silently
  collapses the two cases. Documented as an intentional
  improvement; migrators changing from `.get('undefined')` to
  `.get(' undefined')`.

  **3.3× faster than the `.collect().groupBy(col, fn)` chain it
  replaces** at 100k events × 10 hosts (33 ms vs 108 ms,
  measured by `scripts/perf-partitioned-toMap.mjs`).

- **`series.partitionBy(col, { groups })` typed declaration**
  — pre-declares the expected partition values, narrowing the
  partition view's `K` type from `string` to the literal union.
  Propagates through every sugar method's return type and through
  `toMap`'s `Map` key:

  ```ts
  const HOSTS = ['api-1', 'api-2', 'api-3'] as const;
  const byHost = series
    .partitionBy('host', { groups: HOSTS })
    .fill({ cpu: 'linear' })
    .toMap();
  // byHost: Map<'api-1' | 'api-2' | 'api-3', TimeSeries<S>>
  ```

  Mirrors `pivotByGroup({ groups })` — same design vocabulary,
  same discipline: declared-order iteration, empty declared
  groups produce empty entries, partition values not in `groups`
  throw at construction time, empty `groups: []` and duplicate
  values throw upfront, single-column only (composite + groups
  throws). Numeric and boolean partition columns are stringified
  by the encoder, so declared groups must be the stringified
  form (`groups: ['1', '2']` for a numeric column).

- **Per-method `**Multi-entity series:**` JSDoc warnings**
  remain on every stateful operator (shipped in v0.9.0); the
  v0.10 operators (`materialize`, `toMap`) inherit the same
  discoverability.

### Changed

- **CLAUDE.md adds a perf-check policy.** New operators that walk
  events, allocate per-event, or scale with input dimensions
  must have an analytical complexity statement, a benchmark
  script (`packages/core/scripts/perf-<operator>.mjs`), and
  before/after numbers in the commit message. Surfaces in the
  Layer 1 self-review checklist. Every v0.10 PR followed this:
  `materialize` got `perf-materialize.mjs` (and two optimization
  passes that landed –41% on the partitioned variant);
  `toMap` got `perf-partitioned-toMap.mjs` (3.3× speedup
  measurement); typed `groups` got `perf-partitionby-groups.mjs`
  (zero chain-step regression via the class-private trusted
  factory).

[0.10.0]: https://github.com/pjm17971/pond-ts/compare/v0.9.1...v0.10.0

## [0.9.1] — 2026-04-26

Strictly additive over v0.9.0. Closes a sugar-method type bug
identified independently by two agents (a fresh CSV-cleaner eval
against v0.9.0 and Codex on a v0.9.0 retest), plus folds in two
fresh-agent doc improvements.

### Fixed

- **`PartitionedTimeSeries.fill` now accepts `maxGap`.** PR #78
  added `maxGap` to `TimeSeries.fill` for v0.9.0 but the partitioned
  sugar's option type was not widened, so the headline v0.9.0 chain —
  `partitionBy('host').fill('linear', { maxGap: '5m' })` — failed
  type checking and forced callers into `.apply()`. The underlying
  impl already passed options through, so this is a one-line type
  widening: `{ limit?: number; maxGap?: DurationInput }`.

### Added

- **9 new tests** under `TimeSeries.partitionBy.test.ts`:
  - 4 regression tests pinning the partitioned `fill(maxGap)` chain
    works (bare `maxGap`, all-or-nothing per-partition span,
    `limit + maxGap` composition, full `partitionBy + dedupe +
fill(maxGap)` chain).
  - 5 composite-key round-trip tests addressing a refinement flagged
    by the dashboard agent: `partitionBy(['host', 'region'])`
    preserves both key columns in the schema, on every output event,
    keeps `(host, region)` tuples distinct (no collapse on host
    alone), and round-trips through `apply()` and the full chain.
- **`cleaning.mdx` "Schema first — `required: false`" section.**
  Leads the page; documents why optional cells need the flag and
  surfaces the `fromJSON`/`null` workaround for the known
  `RowForSchema` variance limitation. Previously this prose only
  lived in the 0.8.2 changelog (fresh-agent feedback).
- **`cleaning.mdx` "End-to-end multi-entity cleaning pipeline"
  section.** The unified `partitionBy + dedupe + fill(maxGap)`
  chain in one place plus a step-by-step hazard table.
  Previously split across three sections (fresh-agent feedback).

[0.9.1]: https://github.com/pjm17971/pond-ts/compare/v0.9.0...v0.9.1

## [0.9.0] — 2026-04-26

The "cross-entity correctness + cleaning hygiene" release. Three
independent CSV-cleaner agent runs (Codex, Claude, Gemini) all hit
the same shape: stateful transforms (`fill('linear')`, `rolling`,
`diff`, etc.) silently mix data across entities on multi-host
series, and `fill('linear', { limit: 3 })` fabricates interpolated
data across long outages instead of leaving the unknown unknown.

v0.9.0 ships three operator-level fixes plus a discoverability pass
on every affected method's JSDoc.

### Added

- **`series.partitionBy(col).<op>(...).collect()`** — chainable
  per-partition view over `TimeSeries`. Sugar methods for every
  stateful operator (`fill`, `align`, `rolling`, `smooth`,
  `baseline`, `outliers`, `diff`, `rate`, `pctChange`, `cumulative`,
  `shift`, `aggregate`, `dedupe`) run the underlying transform per
  partition. `.collect()` materializes back to `TimeSeries<S>`.
  `.apply(g => /* arbitrary chain */)` is the terminal escape hatch.
  One primitive covers the cross-entity hazard for every at-risk
  method, instead of adding a `partitionBy` option to each.
- **`series.dedupe({ keep })`** — first-class deduplication with
  policies: `'first' | 'last' | 'error' | 'drop' | { min: col } |
{ max: col } | (events) => Event`. Default key is the full event
  key (`begin` for time-keyed, `begin+end` for time-range,
  `begin+end+value` for interval-keyed); default resolution is
  `'last'`. `partitionBy('host').dedupe()` is the multi-entity
  pattern.
- **`fill(strategy, { maxGap })`** — duration-based gap cap,
  complements the existing count-based `limit`. Both compose; most
  restrictive wins.

### Changed

- **`fill` is now all-or-nothing.** A gap either fits both caps and
  is filled entirely, or exceeds either cap and is left fully
  unfilled. Previously `limit: 3` on a 5-cell gap filled 3 cells and
  left 2 unfilled — propagating stale `'hold'` values past their
  useful lifetime and inventing misleading `'linear'` slopes across
  long outages. Existing `limit` callers see strictly more
  conservative behavior; to opt back in to partial fill, set
  `limit`/`maxGap` larger than any gap you want filled.
- **Every stateful TimeSeries method's JSDoc** now includes a
  `**Multi-entity series:**` warning paragraph naming the operator's
  specific cross-entity hazard and pointing at the
  `partitionBy(col).<method>(...).collect()` pattern. Discoverable
  in LSP hover, IDE quick-help, and any tool that reads type
  definitions.
- **`PartitionedTimeSeries` view** preserves partition state across
  every sugar call, so multi-step per-partition chains compose
  cleanly without re-partitioning at each step.

### Fixed

- Pre-existing brand-check bug on `series.filter(...).diff(...)`
  and similar chains: events constructed via
  `#fromTrustedEvents` (which uses `Object.create` to bypass the
  constructor) hit a JS-private brand check on `#diffOrRate` and
  threw. Refactored to a class-static private (`static
#diffOrRate`) — runtime-private without the per-instance brand
  failure.

[0.9.0]: https://github.com/pjm17971/pond-ts/compare/v0.8.2...v0.9.0

## [0.8.2] — 2026-04-26

Strictly additive over v0.8.1. Closes friction surfaced by two
independent agent runs against a realistic CSV-cleaning task —
specifically, the missing fan-in primitive that forces callers out
of the typed contract when reassembling per-host transformed
subseries.

### Added

- **`TimeSeries.concat([s1, s2, ...])`** — concatenates the events of
  N same-schema `TimeSeries` instances, re-sorted by key. The
  row-append / vertical-stack counterpart to `joinMany` (which
  column-merges by key). Matches `Array.prototype.concat` /
  `pandas.concat(axis=0)` / SQL `UNION ALL` semantics. Closes the
  round-trip after `groupBy(col, fn)` + per-group transforms without
  forcing callers to unwrap events back to row tuples.

  ```ts
  const filledByHost = series.groupBy('host', (g) =>
    g.fill({ cpu: 'linear' }, { limit: 2 }),
  );
  const combined = TimeSeries.concat([...filledByHost.values()]);
  // back to one TimeSeries<S>; events from all hosts re-sorted.
  ```

  Schemas must match column-by-column on `name` and `kind`; throws
  upfront on mismatch. Same-key events from different inputs are
  both kept (row-append, not key-dedupe).

  Coming from pondjs: `timeSeriesListMerge`'s concatenation case
  maps to `TimeSeries.concat([...])`; its column-union case maps to
  `TimeSeries.joinMany([...])`.

- **`TimeSeries.fromEvents(events, { schema, name })`** — builds a
  typed series from a flat `Event[]` array. Sorts by key. Companion
  to `merge` for the case where you have raw events rather than a
  list of series.

- **`TimeRange.toJSON()`** returns `{ start: number, end: number }`,
  the same shape `JsonTimeRangeInput` accepts, so
  `new TimeRange(range.toJSON())` round-trips. Implicitly invoked by
  `JSON.stringify(range)`.

- **`TimeRange.toString()`** returns ISO-8601 `start/end` format
  (e.g. `2025-01-15T09:00:00.000Z/2025-01-15T10:00:00.000Z`) for
  debug logs and human-readable display.

### Known limitation

Two type-level fixes flagged by the agents are tracked but deferred
to a future variance refactor:

- `toJSON()` returns `TimeSeriesJsonInput<SeriesSchema>` (loose),
  not `TimeSeriesJsonInput<S>`. Cast the result at the call site
  if you need the narrow schema preserved.
- `RowForSchema` doesn't honor `required: false`. Use `fromJSON`
  with `null` cells instead of the row-array constructor with
  `undefined`.

Both are real but blocked by class-wide invariance through method
overloads. See PLAN.md "Known type-level limitation" for the full
story.

## [0.8.1] — 2026-04-26

Strictly additive over v0.8.0 — typed overload narrows result types when
opted in via `groups`; untyped form is unchanged. Plus a docs reorg.

### Added

- **`pivotByGroup` typed overload** — pass `{ groups: [...] as const }`
  and the output schema becomes literal-typed, so downstream
  `baseline` / `rolling` / `toPoints` calls narrow without `as never`
  casts. Eliminates the dashboard friction reported on v0.8.0.

  ```ts
  const HOSTS = ['api-1', 'api-2'] as const;
  const wide = long.pivotByGroup('host', 'cpu', { groups: HOSTS });
  // wide.schema is now literal-typed:
  //   [time, { name: 'api-1_cpu', kind: 'number', required: false },
  //          { name: 'api-2_cpu', kind: 'number', required: false }]
  wide.baseline('api-1_cpu', { window: '1m', sigma: 2 }); // no cast
  ```

  Behavior in the typed path: declaration order (not alphabetical),
  declared-but-empty groups still emit columns, runtime values not
  in the declared set throw upfront. Untyped form (no `groups`)
  keeps existing alphabetical / dynamic-discovery / loose-output
  behavior.

### Changed

- **Docs site reorganized.** `Transforms` → **TimeSeries**;
  `Live` → **LiveSeries**; new **Advanced** section for charting and
  array columns. Concepts moves to `Start here`. New **Reshaping**
  page splits `pivotByGroup` / `groupBy` / `join` / `joinMany` from
  Aggregation, plus a new **Queries** page covering `at` / `first` /
  `timeRange` / `includesKey` / `intersection` / iterators / output
  forms — everything that interrogates a series rather than
  transforming it. JSON ingest renamed to **Ingest** and slotted as
  the first page under TimeSeries.

## [0.8.0] — 2026-04-25

### Added

- **`TimeSeries.pivotByGroup(groupCol, valueCol, options?)`** — long-to-wide
  reshape on a categorical column. Each distinct value of `groupCol` becomes
  its own column in the output schema named `${group}_${value}`, holding the
  value column at that timestamp. Rows sharing a timestamp collapse into one
  output row; missing `(timestamp, group)` cells are `undefined`.

  ```ts
  // Long: { ts, cpu, host } per row
  // Wide: { ts, "api-1_cpu", "api-2_cpu", ... } per row
  long.pivotByGroup('host', 'cpu').toPoints();
  // Drops straight into <Line dataKey="api-1_cpu" /> etc.
  ```

  Duplicate `(timestamp, group)` pairs throw by default; opt-in
  `{ aggregate: 'avg' | 'sum' | 'first' | 'last' | 'min' | 'max' | 'median' | 'p95' | ... }`
  to combine. The aggregator's output kind must match the value column's
  kind — `count`, `unique`, `topN` and other kind-changing reducers are
  rejected upfront with a clear error. Output schema is dynamic so the
  return type is `TimeSeries<SeriesSchema>` (loosely typed). Time-keyed
  input required.

  Use `pivotByGroup` for the per-group dashboard case ("one source, many
  producers, one chart line per producer"). Use `groupBy + joinMany` when
  each group spawns multiple derived columns (e.g. per-host baseline →
  cpu/avg/upper/lower per host). At 200k events × 100 groups, runs in
  ~43 ms — at parity with hand-rolled JS that skips `TimeSeries`
  construction entirely.

### Changed

- Charting docs lead with `series.join(other, ...).toPoints()` for
  cross-source overlays. The manual `mergeWideRows` recipe is demoted to
  "non-`TimeSeries` inputs". A new "Per-group wide rows" section covers
  `pivotByGroup` end-to-end with Recharts.

### Notes

- **Live counterpart deferred.** No `LiveSeries.pivotByGroup` /
  `LiveSeries.merge` / `LiveSeries.join` yet — see PLAN.md "Known scope
  gap: live merge / join". Snapshot-then-batch is the workaround:
  `useSnapshot` per source + `useMemo` running a batch `pivotByGroup` or
  `join`.

## [0.7.0] — 2026-04-25

### Changed (breaking)

- **`TimeSeries.toPoints()` returns wide rows** instead of single-column
  `{ ts, value }[]`. Every event becomes one row with `ts` plus every
  value column from the schema as a top-level key:

  ```ts
  // Before:                       // After:
  series.toPoints('cpu');
  series.toPoints();
  // [{ ts, value }, ...]          // [{ ts, cpu, host, ... }, ...]
  ```

  This aligns pond-ts's multi-column nature with what every chart
  library actually wants (Recharts, Observable Plot, visx all consume
  wide rows directly). Band charts, multi-series overlays, and
  `<Area>` ranged-`dataKey` patterns become a single `toPoints()`
  call instead of a manual merge.

  **Migration:** for the common single-column case, compose with
  `select`:

  ```ts
  const cpuPoints = series.select('cpu').toPoints();
  // [{ ts, cpu }, ...]
  ```

  Then read the column by name (`row.cpu`) instead of the old
  `.value`. Wide form keeps every event — the old narrow form
  dropped events whose column was `undefined`; the new form preserves
  them so chart libraries can render gaps via `connectNulls={false}`.

  **Watch out for `value`-named columns.** If your schema has a value
  column literally named `value`, the new wide rows will have a
  `value` key that looks identical to the old narrow shape — but it's
  the column-named-`value`, not the narrow-form `value`. Audit any
  `row.value` reads after upgrading; the safe migration is
  `row.<schema-column-name>`.

- **`TimeSeries.fromPoints()` accepts wide-row points** with a schema
  of any number of value columns. Schema's first column must still be
  `kind: 'time'`.

  ```ts
  TimeSeries.fromPoints(
    [{ ts: 0, cpu: 0.3, host: 'api-1' }, ...],
    {
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'cpu', kind: 'number' },
        { name: 'host', kind: 'string' },
      ] as const,
    },
  );
  ```

  Previously restricted to exactly two columns with `{ ts, value }`
  rows; that form is gone.

## [0.6.0] — 2026-04-25

### Added

- **`'end'` sample option** for `align()` and `Sequence.bounded()`. Joins
  `'begin'` and `'center'` as a third anchor inside each grid step.
  Useful for end-of-period readings (close-of-day, last value before
  bucket close). Inclusion semantics are left-exclusive
  (`sample ∈ (range.begin, range.end]`) so an end-sample at exactly
  `range.begin()` doesn't pull in an interval that sits entirely
  before the range.

### Type-surface change

- `AlignSample` and `SequenceSample` literal unions widen from
  `'begin' | 'center'` to `'begin' | 'center' | 'end'`. Pattern-matching
  consumers that exhaustively `switch` on the old two-value union
  silently miss the new arm — minor bump rather than a patch per this
  project's "patch bumps are strictly additive" rule. Update any
  `switch (sample)` blocks to handle `'end'` (or add a `default`).

## [0.5.11] — 2026-04-24

### Fixed

- **`LiveSeries` rejects `graceWindow > retention.maxAge` at construction.**
  A late event accepted within grace but older than `maxAge` would be evicted
  immediately by retention — the grace contract would be meaningless. The
  guard only fires when both options are set explicitly; default behavior is
  unchanged. `LiveAggregation` bucket closure (which inherits grace from the
  source) still behaves as before.

### Changed

- Docs: clarified `graceWindow`'s scope in the `LiveSeriesOptions`
  docstring. Enforced at ingest and honored by `LiveAggregation` bucket
  closure; `rolling()` / `window()` live views do not re-flow late events
  through historical windows. Matches the actual pipeline behavior; full
  late-event propagation through live transforms is explicitly out of
  scope (see Akidau's Streaming 102 for the larger story).

## [0.5.10] — 2026-04-24

### Fixed

- **`baseline()` emits `undefined` for `upper` / `lower` when the rolling
  window is flat (`sd === 0`)** — matching `outliers()`'s behavior. Before,
  a zero-width band would cause a naive `value > upper || value < lower`
  filter to flag every non-equal point as anomalous inside a constant run.
  The `avg` and `sd` columns still report their true values; only the band
  edges collapse to `undefined`.

### Changed

- Internal: consolidated a duplicate `OptionalNumberCol` type alias into
  the pre-existing `OptionalNumberColumn`. No surface change.
- Docs: walked back an over-claim in `outliers()`'s docstring. It was
  documented as "sugar over `baseline().filter()`" but is implemented
  independently. Now says the two are conceptually equivalent.

## [0.5.9] — 2026-04-23

### Added

- **`TimeSeries.baseline(col, opts)`** — rolling-stats primitive. Runs one
  rolling pass and appends four optional number columns (`avg`, `sd`,
  `upper = avg + σ·sd`, `lower = avg - σ·sd`) to the source schema. Band
  charts read `toPoints('upper')` / `toPoints('lower')` directly; outlier
  filters compare against `upper` / `lower`. Replaces the band-plus-outliers
  two-pass pattern with one call. Custom column names via `{ names }` if the
  defaults collide.

[0.8.2]: https://github.com/pjm17971/pond-ts/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/pjm17971/pond-ts/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/pjm17971/pond-ts/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/pjm17971/pond-ts/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/pjm17971/pond-ts/compare/v0.5.11...v0.6.0
[0.5.11]: https://github.com/pjm17971/pond-ts/compare/v0.5.10...v0.5.11
[0.5.10]: https://github.com/pjm17971/pond-ts/compare/v0.5.9...v0.5.10
[0.5.9]: https://github.com/pjm17971/pond-ts/compare/v0.5.8...v0.5.9

## [0.5.8] — 2026-04-23

### Added

- **`TimeSeries.outliers(col, { window, sigma, alignment? })`** —
  rolling-baseline outlier detection. Returns `TimeSeries<S>` filtered to
  events whose value deviates from the trailing rolling average by more than
  `sigma · rolling_stdev`. Composes directly with aggregate, groupBy, etc.
- **`TimeSeries.prototype.toPoints(col)`** — flat `{ ts, value }[]` export
  matching conventional chart-library shape (Recharts, Observable Plot, d3).
  Filters `undefined` values; returns a frozen array.
- **`TimeSeries.fromPoints(points, { schema, name? })`** — inverse
  constructor for round-tripping chart-style points back into pond-native
  operations. Schema must have exactly two columns.

[0.5.8]: https://github.com/pjm17971/pond-ts/compare/v0.5.7...v0.5.8

## [0.5.7] — 2026-04-23

### Added

- **`smooth('ema', { warmup: N })`** — drops the first `N` output rows so
  callers don't have to write `.slice(N)` after every EMA call. The smoother
  still processes those events, so kept rows are computed against a warm EMA.
  `warmup: 0` is a no-op; warmup ≥ series length returns an empty series.

[0.5.7]: https://github.com/pjm17971/pond-ts/compare/v0.5.6...v0.5.7

## [0.5.6] — 2026-04-23

### Added

- **`useCurrent` reference stability** — the returned record and each of its
  fields are reference-stable across renders when structurally unchanged. A
  no-op push (same aggregate values) hands back the previous references;
  downstream `useMemo([current.host], ...)` only re-runs when that specific
  field changes. Scalar fields compare via `===`; array fields compare length
  then elementwise.

[0.5.6]: https://github.com/pjm17971/pond-ts/compare/v0.5.5...v0.5.6

## [0.5.5] — 2026-04-23

### Added

- **Narrow return types for `rolling` + `aggregate` output-map overloads.**
  `rolling(w, { avg: { from: 'cpu', using: 'avg' }, ... })` now returns
  `TimeSeries<RollingOutputMapSchema<S, M>>` — `e.get('avg')` narrows to
  `number | undefined` instead of `ColumnValue | undefined`, and `e.key()`
  preserves the source's first-column kind. Same fix on `aggregate`'s
  output-map overload.

### Fixed

- `min` / `max` were missing from the numeric-reducer list in `ReduceResult`
  (v0.5.2 regression). Both reducers have `outputKind: 'number'` at runtime;
  the type now agrees. `reduce({ cpu: 'max' })` narrows to `number | undefined`.

[0.5.5]: https://github.com/pjm17971/pond-ts/compare/v0.5.4...v0.5.5

## [0.5.4] — 2026-04-23

### Added

- **`rolling` accepts `AggregateOutputMap`** — feature parity with
  `aggregate`. Multi-reducer-per-column now works in one pass:
  ```ts
  series.rolling('1m', {
    avg: { from: 'cpu', using: 'avg' },
    sd: { from: 'cpu', using: 'stdev' },
  });
  ```
  Two new overloads on both window-only and sequence-driven forms.

### Changed

- `rolling`'s internal column walker now routes through the shared
  `normalizeAggregateColumns` helper. Schema-column order is preserved for
  `AggregateMap` inputs so the runtime layout continues to match
  `RollingSchema<S, M>`.

[0.5.4]: https://github.com/pjm17971/pond-ts/compare/v0.5.3...v0.5.4

## [0.5.3] — 2026-04-23

### Added

- **Source-kind narrowing on array-output reducers in `ReduceResult`.**
  `unique` and `` `top${number}` `` now narrow their output to
  `ReadonlyArray<T>` where `T` is the source column's element type:
  ```ts
  series.reduce({ host: 'unique' }).host;
  //    ^ ReadonlyArray<string> | undefined (was ReadonlyArray<ScalarValue>)
  ```
  Array-kind source columns fall back to the wide `ReadonlyArray<ScalarValue>`
  union since element kind isn't schema-visible.

[0.5.3]: https://github.com/pjm17971/pond-ts/compare/v0.5.2...v0.5.3

## [0.5.2] — 2026-04-23

### Added

- **`TimeSeries.reduce` per-entry type narrowing.** Numeric reducers
  (`sum`/`avg`/`count`/`median`/`stdev`/`difference`/`pNN`) narrow to
  `number | undefined`; `unique`/`top${N}` narrow to `ReadonlyArray<…> |
undefined`; `first`/`last`/`keep` preserve the source column kind. Custom
  reducer functions and `AggregateOutputSpec` entries keep the wide
  `ColumnValue | undefined` fallback. Narrowing lives in the new
  `types-reduce.ts` — same file-split pattern used later for the output-map
  narrowing.

### Changed

- `useCurrent` now aliases `ReduceResult<S, Mapping>` directly; the hook's
  duplicated narrowing logic is gone.

[0.5.2]: https://github.com/pjm17971/pond-ts/compare/v0.5.1...v0.5.2

## [0.5.1] — 2026-04-23

### Added

- **`TimeSeries.tail(duration?)`** — trailing temporal slice, the
  counterpart to `Array.slice(-n)`. Called with no argument, returns the
  whole series. Composes with every other `TimeSeries` method.
- **`useCurrent` hook (`@pond-ts/react`)** — subscribes to a live source and
  returns the current value of a reducer mapping. Signature:
  `useCurrent(source, mapping, { tail?, throttle? })`. Stable-shape record
  even while the source is empty, so destructuring on first render is safe.

[0.5.1]: https://github.com/pjm17971/pond-ts/compare/v0.5.0...v0.5.1

## [0.5.0] — 2026-04-23

### Added

- **First-class `'array'` column kind.** New `ArrayValue = ReadonlyArray<ScalarValue>`
  and `ColumnValue = ScalarValue | ArrayValue` types. Array columns are inert
  with respect to numerical operators (`diff`, `rate`, `cumulative`,
  `rolling`-over-numbers skip them automatically via `NumericColumnNameForSchema`).
- **`unique` reducer** — distinct sorted values; works in `reduce`,
  `aggregate`, and `rolling`. Flattens array-kind sources one level (set union
  across arrays in a bucket).
- **`top(n)` reducer** — top N values by frequency with deterministic
  tie-break. String-pattern dispatch (`'top3'`, `'top10'`) parallel to `pNN`,
  plus a `top(n)` helper that returns the typed string literal. Incremental
  bucket + rolling state via a count map. Also flattens array-kind sources.
- **Five array-prefixed operators on `TimeSeries`**:
  - `arrayContains(col, value)` — has this one
  - `arrayContainsAll(col, values)` — has every one (AND / subset)
  - `arrayContainsAny(col, values)` — has at least one (OR / intersection)
  - `arrayAggregate(col, reducer, { as?, kind? })` — per-event reduction
    reusing the full reducer registry (count, sum, avg, unique, custom, etc.).
    Replace in place or append via `as`.
  - `arrayExplode(col, { as?, kind? })` — fan each event out into one event
    per array element. Replace the array column or keep it alongside a scalar
    sibling.
- **LiveSeries accepts `kind: 'array'`** on its schema with array cells
  frozen on push.
- **JSON round-trip** for array cells works unchanged (toJSON / fromJSON
  pass arrays through naturally).
- **Docs**: new `guides/arrays.mdx` reference page;
  `examples/error-rate-dashboard.mdx` scenario walkthrough backed 1:1 by an
  E2E test; `reducer-reference.mdx` expanded with concrete input/output
  examples for `unique` and `top(n)`.

### Changed

- **`reduce()` / `ReduceResult` / `CustomAggregateReducer` return types** widened
  from `ScalarValue | undefined` to `ColumnValue | undefined`. Narrowed
  annotations (`: number | undefined`) keep working; only callers with
  explicit `: ScalarValue | undefined` annotations need to widen.
  (v0.5.2 narrows these further per-entry.)

[0.5.0]: https://github.com/pjm17971/pond-ts/compare/v0.4.3...v0.5.0

## [0.4.3] — 2026-04-22

### Added

- `useLiveQuery` and `useLatest` hooks in `@pond-ts/react`.

### Fixed

- LiveView eviction mirroring (uses `EMITS_EVICT` symbol to safely detect
  evict-capable sources; avoids duck-typing that broke on `LiveAggregation`).
- Type narrowing through `LiveAggregation` / `LiveRollingAggregation` via
  `Out` type parameter.
- `Time.toDate()` convenience method.
- `useWindow` under React StrictMode (view creation moved to `useEffect`).
- `TimeSeries[Symbol.iterator]` and `toArray()` for ergonomic iteration.
- `useSnapshot` accepts `SnapshotSource<S>` structural type (no casts for
  `LiveAggregation` input).

[0.4.3]: https://github.com/pjm17971/pond-ts/compare/v0.4.2...v0.4.3

## [0.4.2] — 2026-04-21

### Changed

- First release using npm OIDC Trusted Publisher (no stored tokens).

[0.4.2]: https://github.com/pjm17971/pond-ts/compare/v0.4.1...v0.4.2

## [0.4.1] — 2026-04-21

Administrative — no behavioral changes.

[0.4.1]: https://github.com/pjm17971/pond-ts/compare/v0.4.0...v0.4.1

## [0.4.0] — 2026-04-21

### Added

- **`@pond-ts/react` package** — React hooks for live series
  (`useLiveSeries`, `useTimeSeries`, `useSnapshot`, `useWindow`, `useDerived`,
  `takeSnapshot`). Monorepo restructure completed.
- **LiveView + LiveSource composition** — `filter`, `map`, `select`,
  `window` views that compose with `LiveAggregation` / `LiveRollingAggregation`
  via a shared `LiveSource<S>` interface.
- **Live per-event and carry-forward transforms** — `diff`, `rate`,
  `pctChange`, `fill`, `cumulative` available as LiveView variants.
- **Grace period on `LiveAggregation`** — delays bucket closing so
  out-of-order events within a window accumulate into their correct bucket.
  Defaults from source `LiveSeries`'s `graceWindow`.
- **Streaming dashboard example** with E2E tests.
- **Benchmark suite** comparing `pond-ts` vs `pondjs`.

[0.4.0]: https://github.com/pjm17971/pond-ts/compare/v0.3.0...v0.4.0

## [0.3.0] — 2026-04-21

### Added

- **`LiveSeries`** — mutable, append-optimized streaming buffer sharing the
  same schema type as `TimeSeries`. Retention policies (`maxEvents`,
  `maxAge`, `maxBytes`). Synchronous subscriptions (`event`, `batch`,
  `evict`). Ordering modes (`strict`, `drop`, `reorder`).
- **`LiveAggregation`** — incremental bucketed aggregation over a
  `LiveSource`.
- **`LiveRollingAggregation`** — sliding-window reduction over a
  `LiveSource`.

[0.3.0]: https://github.com/pjm17971/pond-ts/compare/v0.2.0...v0.3.0

## [0.2.0] — 2026-04-16

### Added

- **Phase 2 batch expansion**: `reduce`, `groupBy`, `diff`, `rate`, `fill`.
- **Phase 2.5 columnar primitives**: `pctChange`, `cumulative`, `shift`,
  `bfill` fill strategy.
- **Aggregator parity with pondjs**: `median`, `stdev`, `percentile`
  (`pNN`), `difference`, `keep`.

[0.2.0]: https://github.com/pjm17971/pond-ts/compare/v0.1.4...v0.2.0

## [0.1.x] — 2026-04-16

Phase 0 (core performance) and Phase 1 (batch hardening) releases. Five
critical O(N²) hot paths optimized (172× aggregate, 182× rolling, 15×
movingAverage, 7.5× loess, 819× includesKey, 134× alignLinearAt).
`toJSON`/`fromJSON` round-trip, custom aggregate reducers, edge-case
coverage across every analytical primitive.

See [tag history](https://github.com/pjm17971/pond-ts/tags) for details.
