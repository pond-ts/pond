# Plan

This document is the single source of truth for what has shipped, what is next,
and the design decisions behind each phase. Update it whenever meaningful work
lands so a lost session does not erase the current state of the project.

---

## Current baseline

What already exists today:

- typed `TimeSeries` construction and JSON ingest/export
- `Time`, `TimeRange`, and `Interval` temporal keys
- immutable `Event` values
- temporal selection and slicing
- alignment, aggregation, joins, rolling windows, and smoothing
- calendar-aware `Sequence` and `BoundedSequence`
- npm packaging and automated release flow
- a Docusaurus docs site plus generated API reference
- PR review discipline — self-review + adversarial agent review with a
  two-comment protocol (agent comment + author response comment) per
  CLAUDE.md; `CHANGELOG.md` now tracks every release

What is still not stable enough to build on aggressively:

- edge-case coverage in several analytical paths is still lighter than it
  should be
- a settled plan for live/stateful composition is still ahead of us

---

## Current focus — `@pond-ts/charts` (canvas wave, kicked off 2026-06-17)

**Decision (pjm17971, 2026-06-17): build `@pond-ts/charts` canvas-first. No
SVG.** The renderer-fork scoping (the canvas RFC, built for the gRPC firehose,
vs estela's working SVG chart) resolved to **canvas**: SVG is a dead end for the
firehose / dashboard consumers, and one canvas engine that also handles
interactions serves estela _and_ them. estela not pulling on canvas as hard
_today_ doesn't mean it won't — we build the chart that works for both. The
charts RFC ([docs/rfcs/charts.md](docs/rfcs/charts.md)) is the architecture;
this section is the binding milestone plan.

- **Interface:** react-timeseries-charts-style declarative layout
  (`ChartContainer` / `ChartRow` / `YAxis` / `Charts` + `LineChart` /
  `BandChart`), canvas underneath.
- **Proving consumer:** estela (`@estela/ui` `DataChart`). Success bar = estela
  can swap our chart in for theirs with **no regressions**. That promotes
  estela's features to v1 must-haves: dual y-axis (left group channel + right
  HR), two-tone variance underlay (`rollingByColumn` percentiles over a fixed
  value-window), gap-aware smooth (`smooth missing:'skip'`), pace axis, scrub
  readout, zoom-stable spread.
- **Theme system (new, first-class):** estela's role palette (foam/coral/teal)
  is _one theme_, not hardcoded. `ChartTheme` threaded through container context
  - a `defaultTheme`, so dashboard / gRPC / other consumers restyle. This is the
    "target other uses too" requirement.
- **Home:** `packages/charts`, `"private": true` until M5 parity (so the release
  workflow doesn't publish a half-built package); lockstep-versioned with the
  monorepo.

**Testing strategy (set 2026-06-17).** React + canvas needs more than unit
tests — a mock-context unit test can assert a `lineTo` was _called_ but never
that the pixels are right or that an interaction behaved. Four layers:

1. **Unit** — vitest + happy-dom + a recording-mock 2D context. Pure logic
   (scales, decimation, store append/evict) and draw-call _sequences_ (a gap →
   `moveTo`, not `lineTo`). Fast, no browser.
2. **Storybook 10** (Vite builder) — `*.stories.tsx` as the design surface and
   the canonical fixture set (estela activity + gaps / NaN / dense / sparse /
   dual-axis / band / each theme). Stories feed layers 3–4.
3. **Behavior** — Playwright specs driving pan / zoom / scrub / brush against
   the static Storybook, asserting callbacks + readout state in a real browser.
   (Storybook `play` functions remain available for in-UI interaction debugging.)
4. **Visual regression** — Playwright screenshots of the canvas diffed against
   committed baselines.

Runner: **Playwright (`@playwright/test`) drives both real-browser layers**
against a static Storybook build (`npm run test:e2e`) — stories are the
fixtures, `toHaveScreenshot` does visual regression. (The Storybook Vitest addon
was the original plan; Playwright-against-Storybook proved simpler and gives
best-in-class visual diffing. Every visual assertion first gates on the canvas
having actually painted — `toBeVisible` waits for the element, not the pixels.)
**Visual baselines are self-hosted**
(pjm17971's call, 2026-06-17 — no external service / no cost / no data leaves
the repo, chosen over Chromatic). Canvas pixels differ across OS / GPU / fonts,
so **CI (Linux + Playwright's pinned Chromium) owns the baselines** — commit the
Linux PNGs, use a small `maxDiffPixelRatio` threshold, local visual runs are
best-effort.

**Milestones** (branch + PR + Layer-2 review each; check-in at each boundary):

- **M0 — package skeleton.** ✅ 2026-06-17. `@pond-ts/charts` workspace +
  build/test/format/release wiring; root format glob broadened to `.tsx`.
  Canvas-in-test decision: a recording-mock 2D context for unit tests (assert
  draw calls, no native dep); real-browser visual + behavior testing stands up
  in M0.5 (below).
- **M0.5 — testing harness.** Stand up Storybook 10 + the four-layer test stack
  (above) against a trivial example, _before_ component work, so M1's
  `LineChart` is built test-first and becomes the template every later component
  copies. Adds the CI browser-test job + the baseline-update workflow.
- **M1 — rendering spine.** ✅ Built 2026-06-17, merged (#241). `fromTimeSeries`
  adapter + `ChartContainer` (time axis) / `ChartRow` (y-domain + canvas +
  draw-layer registry) / `LineChart` (gap-aware line), d3-scale. Renders a pond
  `TimeSeries` → canvas line end-to-end with the coast reading as a break, not a
  drop to zero. Test-first against the M0.5 harness: 14 unit (draw-call
  sequence, gap-break, extent, DPR) + 5 e2e (behavior + visual baselines).
  **Surfaced F-1 (HIGH):** pond-ts's prototype-augmented column-API methods
  (`toFloat64Array`, `at`, `slice`, scalar reductions, `bin`) are **tree-shaken
  out of Vite/Rollup browser bundles** despite core's
  `sideEffects: ["./dist/column.js"]` — they work in Node/vitest but throw
  `"not a function"` in a bundled app. Hits **any** browser consumer
  (estela / dashboard), not just charts. M1 works around with `col.read(i)`
  (a class method, bundle-safe, per-element) and forfeits the columnar bulk-read
  throughput win until core makes the augmentation bundle-safe. Full analysis +
  fix candidates in
  [`docs/notes/charts-m1-friction.md`](docs/notes/charts-m1-friction.md); this
  is the top charts→core carry-forward.
- **M2 — axes + theme.** ✅ Built 2026-06-17, merged 2026-06-18 (#242).
  `YAxis` (per-axis auto-fit domain, the widen-not-cap trap; DOM
  gutter chrome) + wall-clock `scaleTime` x-axis + the `ChartTheme` system
  (`defaultTheme` + `estelaTheme`) + dual y-axis + gridlines. Six Layout stories
  (SingleRow / LeftAxis / DualAxis / MultiRow / VaryingGutters / EstelaShaped)
  are the visual baselines; 20 unit tests. Slices: **M2.1** theme/`as` pipeline,
  **M2.2** `<Layers>` + horizontal shell, **M2.3a** per-axis y-scales + `YAxis`,
  **M2.3b** shared time axis + uniform gutters, **M2.3c** layout stories, **M2.4**
  gridlines + `estelaTheme`.
  - **Shared-x-geometry decision (M2.3b, 2026-06-17).** The bottom time axis must
    align across stacked rows, so the **x geometry lives on `ChartContainer`,
    not the row**: the container collects each row's per-side gutter need and
    reserves a _uniform_ gutter (the max each side), then owns `plotWidth` + the
    shared `scaleTime` `xScale`. A row with a narrower gutter pads with a flex
    spacer so its plot left-aligns. Y-scales stay per-row (row-local data). This
    resolves the cross-row-alignment item the RFC parked. The x scale is
    `scaleTime` so ticks land on wall-clock boundaries; it renders in local time
    (Playwright pins `timezoneId: 'UTC'` for reproducible baselines — a
    configurable display tz is a later feature).
  - **Gridlines decision (M2.4, 2026-06-17).** Faint dashed gridlines are **on by
    default**, drawn behind the data from the same ticks the axes label (vertical
    = time scale, horizontal = the row's default y-axis), consuming
    `theme.axis.grid` + `gridDash`. No per-chart toggle yet (YAGNI; add if estela
    wants gridless — pjm17971 confirmed "fine for now," 2026-06-18).
  - **estelaTheme pinned (2026-06-18).** The real `@estela/ui` palette is now in
    `theme.ts` (no longer representative) — full token ramp in the
    `estela-design-palette` memory. Line roles: `default`→`--es-estela` (action
    teal), `foam`→`--es-foam` (shared motion trace for power/speed/cadence),
    `hr`→`--es-filament` (warm accent); ground `--es-bg`, grid `--es-ink`, labels
    `--es-slate`, `--es-font-data` (JetBrains Mono) ticks. `elevation` (reef) +
    band fills land with `BandChart` (M3).
  - **Per-component hardening pass (planned, pjm17971 2026-06-18).** Once the
    charts are more end-to-end, do a multi-agent pass **over each component** to
    build out + lock the features each needs (gridline toggles, axis tick
    control, label measurement, etc.). M2 ships the spine + sensible defaults;
    that pass is where per-component depth gets nailed down.
  - **Row-layout decision (2026-06-17, with pjm17971 / the RTC author).**
    `ChartRow`'s direct children are a **horizontal** layout — left `YAxis`(es),
    a `<Layers>` wrapper (the plot area), right `YAxis`(es) — e.g.
    `<YAxis/><YAxis/><Layers>…</Layers><YAxis/>`. Inside `<Layers>` is the
    **z-stack** of draw layers (declaration order, last on top — the
    `ChartRow` JSDoc convention). Same ordered-children pattern as the row, on a
    different axis (x → z). The wrapper is **mandatory** (no optional-when-single
    sugar — that would force the row to sniff axis-vs-layer roles and give two
    ways to write one chart) and serves as the **context boundary**: children
    inside `<Layers>` register as draw layers, direct row children as axes — so a
    layer knows what it is from _where it sits_, not a `role` prop. Named
    `<Layers>` over RTC's `<Charts>` / a `<Group>` — it names the z-stacking role
    rather than the contents, and reads clearly beside the axes.
  - **Theme decision.** A single typed `ChartTheme` object is the **one styling
    channel** for drawn layers — canvas has no CSS cascade into pixels, and that
    constraint is _why_ this avoids RTC's styling bugs (RTC had two overlapping
    channels: CSS + per-element `style` props with deep merges). Role tokens
    (primary / secondary / context line colours, band fill opacities, axis tint,
    grid stroke + dash, label typography), `defaultTheme` + `estelaTheme`,
    threaded via `ChartContainer` context. DOM chrome (axis labels, legend)
    derives its styles from the same theme object — still one source of truth.
    Realised in M2.1 (built 2026-06-17) as a three-stage pipeline — **column →
    semantic identifier → theme style** — where a draw layer tags its column via
    the `as` prop (`<LineChart column="power" as="foam" />`), the theme maps the
    identifier → `LineStyle` (`theme.line[as] ?? theme.line.default`), an
    untagged line draws `default`, and there is no per-component colour/width
    override (the leak pjm17971 caught).
  - **Parked idea (2026-06-17, pjm17971 — let experiments validate).** Whether
    the column → semantic-identifier mapping should be definable **once for the
    app** (a global `column → identifier` registry, so `power` always renders
    `foam` everywhere) rather than tagged per `<LineChart>`. It composes as a
    layer _above_ the per-chart `as` (registry supplies the default `as`; the
    prop overrides) and mirrors estela's existing `CHANNEL_META`. Not built —
    feeling out the surface; estela adoption decides whether charts owns the
    registry or the app provides it. The per-chart `as` prop is the primitive
    either way.
- **M3 — `BandChart` + variance underlay.** ✅ Built 2026-06-18 (branch
  `feat/charts-m3-band`). The variance band as **composed** primitives — two
  single-band `<BandChart lower upper>` (gap-aware filled envelope) + a
  `<LineChart>` centerline in the z-stack, _not_ a bundled outer/inner/center
  prop (pjm17971's call, weighed against RTC's `aggregation`). Slices: M3.1 band
  spine + theme band tokens; M3.2 real `rolling` percentile pipeline (the chart
  consumes pond-computed columns); M3.3 draw primitives on **d3-shape**
  (`line`/`area`, `.defined` gaps) + a `curve` prop (RTC's `interpolation`); plus
  a d3 SF-temperature real-data baseline and a gap-aware `smooth(missing:'skip')`
  story.
  - **Band-data decision.** Reducers live **upstream in pond**, not a chart prop
    (more pond-oriented than RTC's bundled `aggregation`).
    `rolling(sequence, window, mapping)` returns a chart-ready `TimeSeries` for a
    **time**-window band; `rollingByColumn` (records over a numeric axis) is the
    **value-axis** (pace) tool → a records→`TimeSeries` gather is the carry-forward
    for the pace axis.
  - **Two smoothing axes, kept distinct.** `curve` = view-layer d3 path
    interpolation; pond `smooth()` = data-layer denoise, gap-aware via
    `missing:'skip'`.
- **Layout hardening (pre-M4).** ✅ 2026-06-19 (branch
  `feat/charts-multi-axis-layout`, #244). **Per-slot gutters**: each side is N
  axis-column slots indexed from the plot outward (slot 0 nearest the plot); the
  container reserves each slot's max width across rows, and a row aligns its axis
  _toward the plot_ within its slot and pads the outer slots it lacks
  (generalizes M2's single block, which couldn't column-align multi-axis rows).
  Plus `rowGap` and `timeAxis={false}` on `<ChartContainer>`; different per-row
  heights confirmed. `slots.ts` holds the pure `maxSlotWidths` rule; single-axis
  baselines byte-identical (one slot == the old block).
  - **Axis backlog (pjm17971).** Surfaced reviewing the layout; pull each in as
    the relevant chart (or M4) needs it, not before:
    - **Time-label alignment** — an `align` place-prop on `<ChartContainer>`:
      `center` (label centered under the tick), `left`/`right` (label alongside a
      longer tick, e.g. `| 0:15`). Today's auto edge-align reads as uneven when
      the axis is moving.
    - **Wall-clock vs relative** time axis (elapsed time).
    - **Custom labels at custom ticks** — estela's intervals/splits (e.g. `1 2 3`
      at specific times); lands with the bar chart.
    - **`<YAxis>` label** position (top / mid-height) + optional rotation (text
      bottom facing the plot).
    - **d3 scale variety** — log / pow / sqrt / … beyond linear.
- **M4 — interactions.**
  - **M4.1 ✅ scrub tracker + cross-row cursor sync** (branch
    `feat/charts-m4-tracker`, #245). Crosshair + per-series dots on a per-row
    **overlay canvas** above the data (the data canvas never repaints on hover —
    protects the future Path2D cache); `ChartContainer` owns the hover state, so
    the cursor syncs across rows for free. Tracked by **plot pixel, not
    timestamp**, so a still cursor stays put while a live window slides under it
    (the drift bug pjm17971 caught on LiveSine — a timestamp drew at
    `xScale(t)`, which moves as the window scrolls). Readout is opt-in + modal:
    `readout` = `none` (default — crosshair + dots, values emitted) / `flag`
    (chips at the crosshair top) / `inline` (chip by each dot), chip-styled
    (`chip` theme token); the **preferred surface is outside the chart** via
    `onTrackerChanged({ time, values })` (pjm17971: in-chart tooltips are "ick").
    Layers register as tracker sources so the container fans in every series'
    value. LiveSine playground gained sine / tooltip-method / light-dark controls.
  - **M4.2 ✅ pan/zoom** (branch `feat/charts-m4-panzoom`, #249). Drag-pan +
    wheel-zoom on the shared x-geometry; `panZoom` opt-in, **controlled**
    (`onTimeRangeChange`) or **uncontrolled** (internal view state). Pure math in
    `viewport.ts` (`panRange`/`zoomRange`, `minDuration` zoom floor) with unit
    tests; wheel via a **native non-passive listener** so `preventDefault` works
    (React's `onWheel` is passive). Tracker suppresses mid-pan; both rows move
    together (shared x). The readout-mode stories
    (`CursorSync`/`FlagReadout`/`InlineReadout`) became **hover-driven** —
    dropped the fake controlled `trackerPosition`, so they're interactive in
    Storybook (crosshair follows the pointer, synced across rows); the e2e drives
    a deterministic pointer to 12:30 (30/59 of the window) so they stay
    baseline-able (verified the driven hover reproduces the prior controlled
    baseline exactly — no churn). The controlled `trackerPosition` API stays for
    app-driven cursors (external slider / video playhead).
  - **Tracker-crash hotfix** (#248). #246's runtime-string value read detached
    `Event.get` from its receiver (`this` lost → `this.#data` threw), crashing
    any tracker on render — missed by L2, Codex, and the e2e (the package is
    `private`, so no consumer was hit). Fixed by casting the _event_ not the
    _method_; `interactions.spec` now fails on any console/page error (the
    regression test that would have caught it).
  - **Chart-type wave ✅** (2026-06-20, #257 — built as #252 interaction
    groundwork, #253 scatter, #254 box, #255 bar [#251 area earlier]; the types
    merged together so cross-cutting fixes land on one tree). **AreaChart**
    (outline + graded fill, above/below-axis), **ScatterChart** (data-driven
    radius/colour encoding — column → scale, the signed-off exception — hover /
    select / label / nearest), **BoxPlot** (per-key box-and-whisker from quantile
    columns), **BarChart** (interval-keyed bars, neighbour-width fallback for point
    keys, hover / select). On the **interaction groundwork** (`select` + per-layer
    `hitTest`, `barSpanPx`, the full-`SelectInfo` identity). Built by parallel
    worktree-isolated agents, each L2'd (groundwork also Codex'd). **Cross-cutting
    follow-ups deferred to fix on main:** shared **axis-headroom** policy (no
    layer's auto-fit pads the top edge); BarChart **hover-vs-select** wide-bucket
    JSDoc; theme tokens **required → optional-with-default** at M5 (so a new chart
    type isn't a breaking `ChartTheme` change).
  - **Perf bench Phase-1 ✅** (#256/#257). Playwright render harness + baseline
    curve. **Diagnosis: interaction FPS tops out 10k–100k** (pan 120fps → 8fps @
    100k; initial render degrades gently, ~7s @ 1M); band + 3-series hit the same
    cliff → per-point stroke cost dominates. **This orders the decimator.** The
    data-side ceiling (snapshot flush) is named as out-of-bench scope. Heap CI gate
    hardened (median baseline + 4×) so it can't flake.
  - **Gap-rendering modes ✅** (2026-06-21, #260 + follow-up `fix/charts-gap-modes-followup`).
    Shared `gaps?: 'none' | 'empty' | 'dashed' | 'step' | 'fade'` prop (default
    `'empty'` — today's break, so existing charts unchanged) on **LineChart /
    AreaChart**, threaded into the draw primitives. One concept across line + its
    area fill: `src/gaps.ts` holds the `GapMode` type + the O(N) `collectGapEdges`
    walk + the bridge/step/fade drawers + the shared `withAlpha` (lifted out of
    `area.ts`). **Decisions:** `none` = linear interpolation of _interior_ gaps
    (`bridgeGaps`) so fill+line bridge with real path ops, robust to
    leading/trailing gaps (which stay broken) — chosen over `.defined(()=>true)`
    which emits `lineTo(NaN)` and mis-handles a leading gap. `step` = a **flat
    dashed line at the average** of the two edge values (a horizontal `- - -`, no
    vertical) — a neutral "value sat around here" estimate, flatter than
    `dashed`'s straight diagonal. `dashed` + `step` are the **inferred dashed
    connectors**, drawn **faint** via the new theme token `gap.connectorOpacity`
    (default `0.5`, per-theme so a dark ground can tune it) — an inferred bridge
    reads as secondary to measured data. For **area the fill stays honest**: only
    `none` fills across; `dashed`/`step`/`fade` keep the fill broken and add the
    connector to the outline. `fade` replicates estela's `es-drop`
    `<linearGradient>` as a per-edge vertical canvas `createLinearGradient`
    (opaque at line → transparent at baseline); estela uses one
    `objectBoundingBox` gradient for the whole path, we need one per drop (canvas
    gradients are user-space) — same visual. Only `fade` drops to a baseline
    (line: axis floor; area: its own fill floor). **Bands deliberately have no gap
    mode** (pjm17971): a filled envelope's break wants its own treatment (sharp
    edge vs. blurred), still to be designed — a band always breaks honestly for
    now. (`step` was iterated twice post-#260: down-across-up-to-baseline →
    sample-and-hold → flat-at-average; #260's two L2 doc nits were folded in
    along the way.) Stories: `GapModes.stories.tsx` (5 modes
    stacked × line/area, estelaTheme) + `Area.stories.tsx` `TrafficAreas` (esnet
    "Into Site"/"Out of site", the static part — no brush). Unit tests
    (recording-mock draw-call asserts) + 2 GapModes e2e + 1 area-traffic e2e
    baseline. O(N) per layer; no perf script (straightforward per-segment draw).
  - **Cursor model + readout formats ✅** (2026-06-21, #265–#270). M4.1's
    `readout` prop (`none`/`flag`/`inline`) became the **`cursor` mode**
    (`none`/`line`/`point`/`inline`/`flag`), set on the **container** (default
    `line`) with an optional **per-row override** (`row.cursor ?? container.cursor`)
    — one mode per row, since mixing cursor types across layers in a stack reads
    badly (pjm17971). #266 **axis value format** (`format`: a d3 specifier string
    or `(v)=>string`), resolved per-axis through `scale.tickFormat` so the readout
    chip uses the **same** formatter as the ticks. #268 made **`side` authoritative**
    for axis placement — a `side="right"` axis renders right even when authored
    before `<Layers>` (fixes the space-reserved-on-the-wrong-side desync pjm17971
    caught), `ChartRow` partitions children by `side` not author order. #269 added
    the optional **cursor-time** chip atop the readout (matched to the time axis via
    a shared `formatTime`) + a `TimeAxis` `timeFormat`. **Phase 2 (#270): the
    staffed flag.** `flag` now raises a faint staff (`opacity 0.5`, at the data
    point's x) from each point up to its value flag stacked near the top, drawn
    only when the dot sits below the stack. The whole cursor presentation moved
    **off the second canvas onto a DOM/SVG overlay** — line/dots/staffs as SVG
    (crisp 1px for free), value chips as DOM divs. The M4.1 invariant holds: the
    overlay never touches the data canvas, so the hover-doesn't-repaint-data
    (Path2D-cache) protection survives. Internal `drawCrosshair`/`drawTrackerDot`
    deleted (never exported); `cursorParts` + `resolveCursorX` stay the pure
    geometry, unit-tested directly. e2e gotcha pinned: the line-mode cursor is a
    zero-width `<line>`, so the hover wait gates on `state:'attached'` (Playwright's
    default `'visible'` needs a non-empty box and hangs). **Phase 2 refinements
    (#272, pjm17971's review):** the flag now **rides its data point** (`s.px`) —
    flag + staff + dot read as one column, not split between the point (staff) and
    the cursor (flag); and the **cursor-time chip shows once, atop the first row**
    (a shared time shouldn't repeat per row). Rows can't learn their index from an
    injection into the container's direct children (often wrapped in a `Rows()`-style
    helper the injection can't reach through), so each row **registers on mount**
    (effect order = top-to-bottom) → `firstRowKey` → `RowFrame.isFirstRow`; gating
    the time on it also drops its top-of-stack space reservation on the other rows.
    A single cursor-time source is kept, so times never diverge across rows (the
    edge case — series whose nearest points sit at slightly different times — is
    left to ride each series' own point; only one _time_ is ever shown).
    **Phase 3 — bar (#274):** the flag rides the bar **under the cursor** (span
    containment `barIndexAtTime`, not nearest-by-begin — which flipped past a wide
    bar's midpoint) at the bar's top-centre; **hover-highlight** (a container
    `hovered` mark, deduped → the data canvas repaints only on a bar transition;
    `drawBars` fills the hovered bar, outlines the selected one). **Phase 4 — box
    (#275):** the box `flag` is a **consolidated** flag — all five values on **one
    horizontal-row chip** (each coloured to its piece, median brighter) + one staff
    at the box top-centre, via a new optional `RowLayer.cursorFlag(time)` hook (a
    box has five values, so the per-sample cursor doesn't fit); same containment +
    centre-anchor as the bar. **Phase 5 — scatter (#276):** the scatter cursor
    already worked through the generic path (`sampleAt` → nearest point, so
    line / flag / inline render point-anchored); landed a `CursorFlag` story +
    baseline confirming it, no source change. **Cursor phases 1–5 complete.**
    **Deferred polish (need a design call, not guessed):** scatter `inline`
    **2D-nearest** (the cursor is x-synced; a nearest-in-(x,y) readout needs the
    pointer's y — a cursor-model change); scatter flag staff from the **dot's top**
    for large encoded marks; the "‹ VAL" callout. Chip-vs-chip de-overlap (inline,
    and box+line in one row) also still open.
  - **Box whisker styles ✅ (separate from the cursor).** `<BoxPlot shape>` —
    **`whisker`** (default, unchanged) / **`solid`** (the candlestick look: a light
    outer bar over `lower→upper` + a darker inner `q1→q3` box, no stems — same hue
    at rising opacity, so on the dark theme the inner reads _brighter_, not darker)
    / **`none`** (the `q1→q3` box only). Median centre line independently optional
    (`showMedian`, default `true`). A prop (structural variant); colours stay
    theme-driven (`solid` reuses `fill` at two opacities). pjm17971 corrected the
    set from the RFC's `feather`/`solid`/`T` → `whisker`/`solid`/`none`.
  - **Decimator — pond-side reducer math SHIPPED; chart-side building.**
    Pre-build assessment + full execution plan:
    [`docs/notes/charts-decimator-assessment-2026-07.md`](docs/notes/charts-decimator-assessment-2026-07.md)
    (six corrections to the 2026-06 RFC plan: §2.1 key-domain from day one,
    §2.2 gap-edge union, §2.3 interaction-reads-source invariant, §2.4 candle
    hint + Tidal, §2.5 LTTB rescoped to opt-in, §2.6 device-pixel + auto-on;
    the RFC perf section carries the amendment). **Phase 1 (pond) DONE:**
    `Float64Column.bin(W, 'minMaxFirstLast')` — the four-channel M4 reducer
    (#362, `fd8265a`); `Float64Column.binBy(key, edges, reducer)` — key-domain
    bucketing so empty pixel columns surface as `NaN` on gappy data, the §2.1
    fix (#363, `bd8e1cf`); both share one `reduceFloat64ByBounds` engine. OHLC
    candlestick re-aggregation reuses `minMaxFirstLast` per column (Tidal
    consumer). `binBy` is the machinery the value axis later exposes as
    `binByAxis`. **Remaining → chart-side (Phases 2–5), bench-ordered:**
    viewport culling **first** (#256 failing metric), then the per-layer
    decimator stage (device-pixel edges + gap-edge union + interaction
    invariant), then re-bench, then candlestick with Tidal; Path2D cache
    (M4.4) only if the pan bench still misses. `plot_width` + visible slice
    live in the chart; reducer math in pond (unifies with geo F-geo-2). **M4
    is the auto-on default; LTTB an explicit opt-in** (§2.5 — one consumer's
    anomaly-detection rejection was consumer-scoped, not global).
    **Statistical bands an M5-parity gate**; **M4.3 brush skipped** (no
    drivers); one-time competitive head-to-head (uPlot + published AG Charts /
    klishevich; SciChart trial optional) stays optional.
  - **Value-axis RFC (`docs/rfcs/value-axis.md`, PR #279 — merged `f141443`) —
    ADOPTED; wave building.** Non-time x (distance / splits / laps).
    **Spine (v2, after the estela + Codex + dashboard red-team + pjm17971):
    value-land needs a _closed `ValueSeries` type_, not bare records.** pond is a
    closed algebra (`TimeSeries → TimeSeries`); `byColumn`/`rollingByColumn` ship
    but return `{start,end,…}[]` — they project _out_ of it (so they're not "tight
    analogues" of `aggregate`/`rolling` — not closed). The key is already generic
    numeric-interval (`'time' | 'timeRange' | 'interval'`), so `ValueSeries` is a
    **recognition** (time is a tag) and `byColumn`/`rollingByColumn` are the
    **`TimeSeries → ValueSeries` projection**; it carries the ordering-based
    operators, calendar ops stay time-only. Honest thesis (v1 was
    self-flattering): the analytics shipped a _project-out reduce_ — the head
    (`scan`), the chart, AND the closure are **all** pending (not "chart is the
    laggard"). **Central question: records vs a closed `ValueSeries`** — lean
    `ValueSeries` as the north star; **adopt the type early, grow the algebra
    late, gated on a 2nd value-axis consumer (geo), NOT estela-alone**
    (over-fitting guard — estela's pipeline is linear / records suffice today).
    Source stays time-keyed (estela's model B, confirmed — **not** re-keying);
    `ValueSeries` is the derived output (records are its rows → additively
    wrappable). **`scan` SHIPPED — the wave lead.** `TimeSeries.scan(source,
step, init, {output?})` — the typed-accumulator `mapAccumL` generalizing
    `cumulative` (decouples accumulator / output / output-column); replace or
    append; `cumulative` semantics inherited; `partitionBy().scan().collect()`;
    `split = scan + byColumn`. **Phase 1 `ValueSeries` + `byValue` SHIPPED**
    (pjm17971 chose extend-`KeyKind` over a wrapper / defer): new `'value'`
    `KeyKind` + `ValueKeyColumn` substrate; `TimeSeries.byValue(axis)` =
    `assertMonotonicAxis` (defined+finite+non-decreasing) + re-key onto the axis
    column + drop it from values → a closed `ValueSeries<ValueKeyedSchema<S,
Axis>>` carrying ordering-based ops (`axisValues`/`axisAt`/`column`/
    `nearestIndex`/`sliceByValue`), calendar ops type-impossible (disjoint
    `ValueSeriesSchema`). Wraps the `ColumnarStore` directly (not `SeriesStore`).
    O(N+C) projection / O(log N) bisect / O(log N+C) zero-copy slice; byValue
    reuses the packed axis buffer zero-copy (#283). **`ValueSeries.fromColumns`
    SHIPPED (2026-07-11, #420)** — the direct columnar door for _natively_
    value-keyed (cross-sectional) data: an options chain keyed by strike (the
    Tidal vol-smile driver — a live cross-section is pond's third chart
    archetype after time-marching and categorical), a spectrum keyed by
    frequency. Exact `TimeSeries.fromColumns` contract (polymorphic `number[]` /
    `Float64Array`, zero-copy adoption, stable opt-in `sort`, one gap rule) —
    the shared engine extracted to `operators/ingest-columns.ts`, so the two
    doors can't drift; before this, cross-sectional callers laundered the axis
    through a fake `time` column. The projection door (`byValue`) stays the
    right entry for data that starts life time-keyed. **Phase 2 — chart
    x-on-`ValueSeries` SHIPPED** (#284, `@pond-ts/charts`): additive
    `xScaleType: 'time' | 'linear'` → a `scaleLinear` value axis; `xScale` widened
    to `ScaleTime | ScaleLinear` (rippled to no consumer — draw layers already take
    `(v)=>number`); `fromValueSeries` adapter; `LineChart` accepts
    `TimeSeries | ValueSeries` (instanceof-branched adapter + cursor sampleAt).
    **Phase 2b — `<XAxis>` chart-API refactor SHIPPED** (#286, `381e2a8`): the x
    axis is now a first-class, placeable, kind-inferred concept. `<XAxis>` =
    placeable axis renderer (`format`/`label`/`side`/`height`/custom `ticks` — the
    lap-markers lever), x-sibling of `<YAxis>`; `<TimeAxis>` is a thin preset over
    it. The x **kind is inferred from the data** (each layer reports `xKind` +
    `xExtent()`; `TimeSeries`→time, `ValueSeries`→value; a container mixing the two
    is a hard error). `range?: [number,number] | TimeRange` is the shared domain
    (auto-fits when omitted; kind never taken from `range`). **Breaking** (unshipped):
    `timeRange`→`range`, `xScaleType`→gone (inferred), `timeAxis`→`showAxis`.
    **Deferred** to a "finish the value-axis naming" follow-up: `timeFormat` (needs
    an `<XAxis format>`→cursor-readout coupling), `onTimeRangeChange`, and the
    internal `ContainerFrame.timeRange` field. **Next: more chart types
    (Bar/Band/Box/Area/Scatter) on the value axis + the naming follow-up + estela
    friction cycle** (Bar/Band/Area landed with later waves; **Scatter SHIPPED
    2026-07-11, #422** — the vol-smile G2 item, instanceof-branch mirroring LineChart,
    encodings/label/sampleAt all value-axis-clean, Box/Candlestick still
    time-only)**.** **G3/G4 direction set (pjm17971, 2026-07-11 —
    `docs/notes/vol-smile-followups-2026-07.md`):** per-x range marks (bid/ask
    error bars) = **finish `BoxPlot`** (ValueSeries widening + point-key
    neighbour-spacing width + optional `q1`/`median`/`q3` for an honest
    range-only mode + px `offset` prop for same-x call/put pairing — the RTC
    BarChart side-by-side precedent), NOT a new mark; region-select-on-value =
    ungate the region cursor with a **neutral `[lo, hi]` payload** ("returning
    a `TimeRange` was probably the wrong answer"), folded into the deferred
    value-axis naming follow-up as one naming+neutrality pass. **Decimator
    DECOUPLED** (dashboard): ship time-only (index `Column.bin`) first; the value
    axis brings axis-domain `binByAxis` (Codex: `Column.bin` is index-domain,
    wrong for gappy data). `byColumn` is **order-free** (Codex: v1 wrongly said it
    enforces monotonic) — the monotonicity contract lives on the axis
    **projection** (`assertMonotonicAxis`). Splits/laps = `ValueSeries` interval
    marks → un-parks range-editing **#261**. Operator-surface consolidation
    deferred hard; the **type** is the real consolidation. Positioning bet
    (time-series → monotonic-axis lib; opt-in/time-default = a middle path) =
    pjm17971's call. estela / Codex / dashboard reviews layered in the RFC;
    geo / core pending. estela friction: `~/Code/estela/docs/pond-friction.md`.
  - **Annotations wave — SHIPPED (#306 system + #308 label opt-out / Codex
    interaction fixes; the `feat/charts-annotations` spike formalized into
    PRs).** User-authored marks in a turquoise register distinct from the
    foam data: `<Region>` / `<Baseline>` / `<Marker>` as `<Layers>` children, an
    SVG overlay above the data canvas. Complete: creation (arm a tool → draw
    gesture → `onCreate`), selection (`onSelectAnnotation` — click-select /
    empty-click deselect / double-click region), a **depth model** (brightness =
    depth, 3 levels + guides; `theme.annotation.depth`), `selectable` bool,
    **hover observable+controllable** (`onHoverAnnotation` + `hovered`), and the
    **three interaction modes** (W1 single-click inspect-select / W2 double-click
    single-annotation-edit via `onEditAnnotation` + `editing` / W3 global
    `editAnnotations` bulk + spring-loaded create tools), cursor suppressed while
    editing, label lane-packing for overlapping flags. Dogfooded by the
    network-traffic example (the charts-experiment repo). **z-order on select was
    DROPPED** (would need splitting the shared grid/data canvas — not worth it).
    Un-parks range-editing **#261**. **To formalize (pjm17971's go):** a
    **cursor-flag PR** ("flag flies from a pole" — re-bases the flag e2e
    baselines) AHEAD of the **annotations PR**, plus a short
    `docs/rfcs/annotations.md`.
  - **panZoom click-select follow-up — RESOLVED (#309).** The one finding the
    #308 Codex pass deferred as browser-dependent — a _selectable but
    non-editable_ mark's click-select dropped when `panZoom` is on — **reproduces
    in Chromium**: the plot's press-time `setPointerCapture` (to start a pan)
    makes the browser retarget the `click` off the mark, so `onSelectAnnotation`
    never fires. Fixed by **deferring the pan-capture to the first pointer move
    past the drag slop** — a click never captures (its select fires), a drag still
    captures + pans through a non-editable mark. Adds
    `e2e/annotations-panzoom.spec.ts`, the **first real-pointer-event behavior
    e2e** for annotations (the harness gap the #308 review explicitly named —
    until now drag/select was only pinned by pure-function unit tests + static
    visual baselines).
  - **estela DataChart-port friction wave — the 3 adopts SHIPPED 2026-07-04
    (#342 / #343 / #344, merged).**
    The `@estela/ui` `DataChart` was ported onto `@pond-ts/charts` (behind the
    unchanged `DataChartProps`); seven port findings triaged against the real
    source in
    [`docs/notes/charts-friction-triage-2026-07.md`](docs/notes/charts-friction-triage-2026-07.md)
    (all verified; estela log: `~/Code/estela/docs/pond-friction.md`). **Shipped
    landings:** (1) **#342** `F-charts-axis-reregister` — `axisSpecEqual` /
    `layerEntryEqual` value-equality guards in `registerAxis` / `registerLayer` +
    the `format`/`series` memoize JSDoc; Layer-2 found the _layer_ guard is
    unreachable-but-defensive (the nested `entry` memo already gates the layer
    effect) — the **axis** guard is what breaks the loop. Merged at medium Layer-2
    confidence (Codex pass offered, pjm17971 merged without). (2) **#343**
    `F-charts-bar-interaction` — landed as `hovered` + `onHover` on
    **`ChartContainer`** (not `onBarHover` on `BarChart` as first sketched), an
    exact mirror of the shipped `selected`/`onSelect` pair keyed by `SelectInfo`;
    dedup on `key`+`label` documented. (3) **#344** `F-charts-fromColumns-key-monotonic`
    — opt-in `sort?: boolean` on `TimeSeries.fromColumns` (default still throws;
    `clampNonDecreasing` rejected as lossy) + `perf-from-columns.mjs`. All three
    strictly additive (0/2/1 new optional surface, existing `SelectInfo` reused).
    **Triage detail (original adopt rationale):** (1) **`F-charts-axis-reregister`
    (HIGH)** — a fresh
    `ticks`/`format`/`series` ref re-registers the axis/layer (`YAxis.tsx:108-134`
    / `LineChart.tsx:163-185` register on pure reference identity, no value
    compare), cascading to "Maximum update depth exceeded" on the scrub-heavy
    chart. Fix = **value-equality guard in `registerAxis`/`registerLayer`** (no-op
    when the spec/entry is value-equal — covers arrays + `byValue()`-projected
    series) **+ widen the memo warning** to `format` (on `YAxis`) and `series` (on
    the layer docs), since an inline `format` closure can't be value-compared and
    genuinely must be hoisted. (2) **`F-charts-bar-interaction` (MED)** — add the
    hover half of the pair selection already has: controlled `hovered?: SelectInfo`
    - `onBarHover?` on `BarChart`, keyed by the same `SelectInfo.key`, so a list
      row can pin/receive the lit bar. (3) **`F-charts-fromColumns-key-monotonic`
      (LOW-MED, core)** — add opt-in `sort?: boolean` to `TimeSeries.fromColumns`
      (parity with `fromJSON`; keep the default throw — a backwards key on the
      trusted path is a real signal; **reject** `clampNonDecreasing`, which lies
      about data). Lands on the Tidal ingress surface (task #19). **Already tracked:**
      `F-charts-width` (container needs explicit px width) = **PLAN #14** (responsive
      sizing/fill) — estela is the 2nd consumer, bump priority, no new item.
      **Defer (backlog, LOW):** `F-charts-area-gap-split` (a separate `outlineGaps`
      — cuts against the deliberate "area fill stays honest" design; single time-axis
      visual, estela degraded cleanly); `F-charts-theme-double-declare` (a vars-first
      `cssVarTheme` mode — mostly estela-side per task #10, current shape buys the
      stable-ref + free dark toggle). **Reject:** `F-charts-band-tint` — per-channel
      bands are already a `as`-per-`<BandChart>` composition, not a gap (estela's own
      note agrees); struck.
  - **Tidal financial-charts + selection intake (RFCs drafted 2026-07-05, pending
    red-team).** A design batch from pjm17971 (Tidal-driven): a first-class
    candlestick, a selection-model extension, and a cluster of BoxPlot/tracker
    refinements. Sequenced **RFC-first for the two big ones, then a wave for the
    rest** (pjm17971's call). **RFCs drafted (NOT commitments — red-team via the
    Tidal Discussions before adoption):**
    [`docs/rfcs/selection.md`](docs/rfcs/selection.md) — click-select any series
    (closest-point-within-threshold `hitTest` on continuous layers) + the one new
    coupling, **snap-follows-selection**. **A1→A2 (same day): multi-select, then a
    Tidal+Estela red-team ([Discussion #352](https://github.com/pjm17971/pond-ts/discussions/352))
    corrected it.** Current model (A2): **readout ALWAYS fans all series** (hard
    invariant); **cursor snap is a prop** — `snapToClosest` (default) vs
    `snapToClosestSelected` (selection as a focusing lever); **selection identity =
    a series `id` distinct from `as`** (a theme role can repeat — sample key/value
    demote to click provenance; the highest-value fix, both consumers +1); **dim =
    theme-referenced selection _state_** (consumer themes selected/dimmed once, the
    library applies by set-membership — NOT a core auto-dim; A1.3's promote-to-core
    withdrawn); **compare does NOT drive multi-select** (Tidal's compare = consumer
    paired rendering + single selection + consumer dim — A1's forcing-case refuted),
    so multi-select is retained but re-motivated as "pin several series to read."
    `selected` widen `SelectInfo | null → readonly SelectInfo[]` **accepted**
    (pjm17971); blast radius smaller than #350 said — **Tidal reads none** of the
    selection surface, **estela's bar is the sole reader**, shim for estela only;
    breaking public change → human-approval gate at build. **A3 (Q11 resolved):
    series `id` is optional and _gates interactivity_** — a layer with an `id` is
    selectable/hoverable (id = the stable identity for selection/hover/snap/dim,
    and it survives live data updates where a sample `key` goes stale); a layer
    without one is display-only. Drops the implicit `as ?? column` selection
    identity — a deliberate break so identity is explicit. **Still an RFC, not
    adopted.** And
    [`docs/rfcs/financial-charts.md`](docs/rfcs/financial-charts.md) — a first-class
    `<Candlestick>` (OHLC-named props, draws-only, point-**or**-interval keyed so raw
    daily OHLCV skips `aggregate`), `variant: candle|bar|hollow` (fork 2 → **bundle**,
    like BoxPlot's `shape`), `colorBy: direction|series`, a full O/H/L/C tracker
    (fork 1 → **yes**, close keyed on `as` + opt-in 4 pills), and a `theme.candle`
    slot **with the one amendment**: `defaultTheme.candle` ships a neutral
    distinguishable up/down pair, NOT market green/red (Tidal supplies real
    green/red via `cssVarTheme`) — preserves [[charts-no-consumer-themes]].
    Supersedes `BoxPlot shape='solid'` for OHLC. **Then — the follow-on wave (the
    stand-alone rest):** (a) **tracker-label-by-`as`** on Band/Box/Candle (friction
    **F-charts-8 §3** — `sampleAt` hardcodes column names; prerequisite for the
    candlestick legend merge, small); (b) **BoxPlot line-only / stem-without-caps
    shape** ("just a line, no T off the box" — a new `shape` variant); (c)
    **interval/OHLC marks join x-snap** (reconcile the `cursorFlag` exclusion so
    "crosshairs grab box plots"); (d) **clamp-on-ingest** — reopens the #344
    `clampNonDecreasing` **reject**: pjm17971 + Tidal's noisy time samples are a
    real 2nd signal, and clamp (`t = t >= prevT ? t : prevT`, carry-forward a lone
    backwards blip) is a distinct, sometimes-more-correct op than `sort` (reorder).
    Adopt as an opt-in **`fromColumns({ onOutOfOrder: 'throw' | 'sort' | 'clamp' })`**
    (default `throw`; fold the 4-hour-old `sort?: boolean` into the enum while it's
    cheap, keep `sort:true` as a one-release alias). "Per-box red/green styling" is
    **subsumed** by candlestick `colorBy: 'direction'` — not a separate per-datum
    style hook (that cuts against "colour = series/theme role").
  - **Candlestick — Phase 1 ADOPTED + shipped** (`feat/charts-candlestick`).
    The RFC's Phase 1 is built and merged behind
    [`docs/rfcs/financial-charts.md`](docs/rfcs/financial-charts.md): a
    first-class `<Candlestick>` (`open`/`high`/`low`/`close` props defaulted to
    the conventional names, so a standard series needs `<Candlestick series={s}
/>`), draws-only (body extents derived per-mark, no consumer `withColumn`),
    **point-or-interval keyed** (raw daily OHLCV feeds straight in via the new
    `ohlcFromTimeSeries` neighbour-spacing path — shared with `barsFromTimeSeries`
    through an extracted `neighbourSpans` helper; a weekly/monthly `aggregate`
    rollup is the identical call), `variant: candle|bar|hollow`, `colorBy:
direction|series`, `showOHLC` (Phase-2 four-pill readout, folded in early),
    and a `theme.candle` slot with the amendment kept — `defaultTheme.candle` +
    `estelaTheme.candle` ship neutral **unbranded** up/down pairs, market
    green/red is a `cssVarTheme` overlay ([[charts-no-consumer-themes]]).
    `drawCandles` + geometry live in `src/ohlc.ts` (28 unit tests). **Design
    divergence from the RFC, locked here:** the RFC framed the OHLC readout as a
    `BoxPlot`-style consolidated `cursorFlag`, and warned Candlestick "must not
    inherit BoxPlot's cursorFlag x-snap exclusion." Resolution: Candlestick
    implements **plain `sampleAt` (like `BandChart`), NOT `cursorFlag`** — so it
    joins the crosshair x-snap and the per-series y-pills **for free** (both paths
    key off "layer has no `cursorFlag`"), with **zero changes to
    `context.ts`/`Layers.tsx`**. That makes follow-on item **(c) "interval/OHLC
    marks join x-snap" moot for Candlestick** (it never opted out); (c) remains
    only for `BoxPlot`. **Breaking type change → human-approval gate before
    release:** `ChartTheme` gains a **required** `candle` slot (RFC-sanctioned,
    consistent with `box`/`bar`); in-repo themes (`defaultTheme`/`estelaTheme` +
    three inline story themes) are updated, but any **hand-built external
    `ChartTheme`** (e.g. estela's, if it doesn't derive from a shipped theme)
    stops compiling until it adds a `candle` slot. Not selectable yet (no
    `hitTest`) — selection rides the separate selection RFC. Follow-on wave
    (tracker-label-by-`as`, BoxPlot line-shape, clamp-on-ingest) still pending.
    **`cssVarTheme` candle mapping (queued, from the Tidal adoption 2026-07-08,
    their `F-charts-4`).** Tidal adopted `<Candlestick>` cleanly (tidal#56/#61,
    reviewed on behalf of the library — usage idiomatic against the 0.41 API),
    and confirmed one real gap: the `candle` slot is type-_required_, but a theme
    built by spreading `defaultTheme`/`estelaTheme` still compiles and silently
    renders the **neutral placeholder** pair (`theme.ts` `defaultTheme.candle`),
    so the type break only bites hand-built themes. Second, `cssVarTheme`
    (`src/css-theme.ts`) is a **generic** overlay (a `resolve` callback →
    `DeepPartial<ChartTheme>`), so it already _accepts_ a `candle` override —
    but there is no **worked candle branch**: the `CssVarTheme` story + docs
    drive only `line`/`axis`/`cursor`/`background`, and there is no canonical
    `--*-candle-*` var-name convention, so a consumer wiring market green/red
    from CSS vars hand-rolls `candle.default` (Tidal did, via its own
    `readChartTheme`). Deliverable when it lands: a candle branch in the
    `CssVarTheme` story (rising/falling/neutral body+wick) + a doc'd var-name
    convention, so the market palette is one declarative overlay like the
    other slots — **not** new per-slot plumbing (the overlay is already
    generic). LOW — the hand-roll works today; earns its keep when the next
    consumer adopts candles.
  - **Selection — Phase 1 (series-`id` identity) ADOPTED + built**
    (`feat/charts-selection-id`, Harbor issue #360). The first slice of
    [`docs/rfcs/selection.md`](docs/rfcs/selection.md) — **A2.2 + A3** — is built
    behind the human-approval gate the RFC flagged for the public-type change
    (SelectInfo widening + dropping the implicit Bar/Scatter identity). What
    shipped: **`SelectInfo` gains `id`** (`{ id, key, value, color, label }`) —
    `id` is the series identity (selection / dedup / controlled-echo key),
    `key`/`value` demote to click **provenance**, `label` stays display; equality
    keys on `id`, never on `begin`. **`id?: string` prop on `BarChart` /
    `ScatterChart`** wired through to `hitTest`, and it **gates interactivity**: a
    layer only wires `hitTest` when given an `id`, so a no-id layer renders + reads
    out but can't be selected/hovered (a click on it resolves to empty space ⇒
    deselect). Highlight + hover dedup now match the series `id` (was `as`/`label`,
    a theme role that can repeat). Container **dev-warn** when `selected`/`onSelect`
    is wired but no layer carries an `id` (via a ref-backed selectable registry,
    read after child register effects settle). **Breaking (human-approval gate):**
    (1) `SelectInfo` grew a **required** `id` — any code constructing one by hand
    must add it; (2) Bar/Scatter selection now **requires an explicit `id`** — the
    implicit `as ?? column` identity is gone. **estela's bar** is the sole external
    reader (Tidal reads none) — it needs the one-line `id` on its selectable
    `<BarChart>`; migration noted in CHANGELOG. Unit tests cover id-keyed
    equality/dedup, the gates-interactivity rule, the dev-warn, and the A3 sleeper
    win (a series `id` is stable across samples where a `key` goes stale). **Still
    OUT of scope (Phase 2 / later, named in the PR):** the `SelectInfo | null →
readonly SelectInfo[]` widen + `selectionMode` (multi-select); `LineChart.hitTest`
    threshold nearest-point; the `snapToClosest | snapToClosestSelected` prop;
    theme-referenced dim state.
- **Histograms (BarChart) — SHIPPED** (`feat/charts-histograms`,
  user-directed 2026-07-10). First-class histogram support as an **extension of
  `<BarChart>`** (not a new component — user decision), covering four real
  consumer shapes: incidents-by-host, risk-by-band, heart-rate zones, and a
  power distribution. Two new capabilities: **(1) stacking** — a group-by
  dimension → per-segment stacked bars, coloured by `colors[group] ??
theme.bar[group] ?? default` (theme-role + ad-hoc-palette, the single styling
  channel preserved); **(2) `orientation`** — `'vertical'` (default, bars up /
  bins on x) | `'horizontal'` (bars right / bins on a y band axis, labelled via
  `<YAxis ticks>`). New props: `bins` (a `byColumn` `{start,end,…}[]` array),
  `columns` (stacked segments), `series` also accepts a `Map<group,TimeSeries>`
  (the `partitionBy().aggregate().toMap()` shape), `colors`, `ordinal`. New
  exported readers `stacksFromGroups` / `stacksFromColumns` / `stacksFromBins`
  - `StackedBarSeries` / `BinRecord` / `Orientation` types.
    **No core changes** — all data-gen composes from shipped operators
    (`aggregate` / `byColumn` / `partitionBy` / `withColumn`); the histogram is
    chart-side glue.
    **Load-bearing decisions:** (a) horizontal fits the existing container/row
    plumbing by putting the _value_ on the shared x (`xKind:'value'`) and the bin
    range on a normal linear y — no transposition of the container/cursor/scale
    machinery; (b) hover + click are pixel-hit-tested so they work in both
    orientations, while the x-scrub `flag`/`crosshair` value cursor stays
    single-series-vertical only; (c) **no public-type change** — a stacked
    segment's identity reuses `SelectInfo` as `(id, key=binBegin, label=group)`;
    (d) `stacksFromGroups` **aligns groups by bucket key, not index** — a caught
    bug: `partitionBy().aggregate()` gives each group _its own_ grid, so an
    index zip stacked unrelated buckets (fixed via a key-union; regression test
    pins it). **Deliberately out of scope (documented):** diverging/negative
    stacks; a horizontal histogram sharing a container with time rows (shared
    x-kind). Verified: unit tests (geometry both orientations + readers +
    draw-call + G=1↔drawBars regression pin), headless story render of all 7
    `Charts/Histogram` stories, and a real-browser Playwright screenshot pass of
    each. Guide: `website/docs/how-to-guides/histograms.mdx`.
  - **Region cursor on histograms — SHIPPED (#424, #425, [Unreleased]).**
    Follow-up to the region cursor: `onRegionSelect` now reports a neutral
    `[lo, hi]` (was a `TimeRange`) and the cursor works on **value** axes (#424);
    a `<BarChart>` publishes its bar spans (`binIntervals`) so the region cursor
    **snaps to a vertical histogram's bars** bar-by-bar (#425). **Deferred (see
    `docs/notes/y-oriented-region-cursor-2026-07.md`):** a **y-oriented** region
    cursor for **horizontal** histograms (bins on y) — a coherent but moderate
    lift (per-row y-band vs the shared-x cursor), parked until a real consumer
    needs horizontal-histogram selection.
- **Categorical axis — Phase 1 (ADOPTED from `docs/rfcs/categorical-axis.md`,
  building 2026-07-10).** The RFC's Phase 1 — a first-class **ordinal
  column-domain x-axis** (the transpose view's "columns on x"; closes the categorical-charts report's
  item 2, replacing the hand-rolled ordinal-index hack). This is the RFC's _sole
  new scale primitive_ and its stated design-risk piece. Adopted into PLAN by
  user direction; the metric branch + cursor-binding (Phase 2) stay RFC-only.
  Sequenced as a **series of PRs**:
  - **PR1 — the category axis foundation (building on `feat/charts-categorical-axis`).**
    `bandScale.ts` — `scaleBand(categories)`, a thin `scaleLinear` wrapper over a
    **numeric slot-index domain** `[0, n]` (the load-bearing choice, mirroring how
    `scaleTradingTime` kept an epoch-ms domain: the pixel mapping stays linear so
    the container's numeric domain / auto-fit / pan pipeline is untouched; the
    category-ness is only in `ticks`→band-centres, `invert`→snap-to-slot, and a
    `label(i)` formatter). New `xKind:'category'` (widened in `context.ts`'s three
    sites) + an `xCategories()` layer channel; the container reconciles the
    category list (throw on disagreement, like the kind) and builds the band scale
    - label formatter. `<CategoryAxis>` preset (ticks once per category via the
      container's `formatTime`). `<BarChart categories={{label,value}[]}>` — a third
      data source (alongside `series`/`bins`) reusing the shipped stacked geometry
      (`categoryStack` → unit slots → `drawStacks`/`stackAt`, **zero new draw
      code**); vertical only; per-category colour via `binColors`; selection reports
      the **category name** as `SelectInfo.label`. Pan/zoom + x-gridlines gated off
      the category axis in `Layers`. Verified: `bandScale.test.ts` (centres, invert
      snap, ticks, bandwidth, label, copy) + a headless category-stories render test
    - a real-browser Playwright screenshot pass (`Charts/CategoryAxis`:
      Tickers/SingleHue/HighCardinality/Select); 463 charts tests green; existing
      time/value/trading charts unchanged (the branch is purely additive).
  - **PR2 — the transpose reader.** `transposeRow(wideSeries, { at })` → the
    `{label,value}[]` from one row of a wide series (`Event` via
    `.at`/`.last`/`.nearest`; numeric columns via `schema.slice(1)`). "Read a row
    of a series, columns on x."
  - **PR3 — per-column stable identity + label policy (built).** `SelectInfo`
    gains an optional **`mark`** (a stable per-mark identity); a categorical bar
    reports its **column name** as `mark`, and the highlight match / controlled
    `selected` key on `(id, mark)` so a pinned selection survives a column reorder
    (Estela's `F-charts-bar-stable-id`). Additive (`mark` undefined for time/value
    bars) — **but a public-type touch → human-approval gate at merge.** Plus a
    category-axis **thin + truncate** label policy (width-estimated) for
    high-cardinality (many category labels); rotate deferred.
  - **All three PRs are built + verified on `feat/charts-categorical-axis`** (479
    charts tests green; `bandScale` / `transposeRow` / category-identity unit
    tests; real-browser screenshots of the 7 `Charts/CategoryAxis` stories). Not
    yet pushed. Landing sequence per PR: self-review → Layer-2 → a Codex pass (a
    new scale primitive warrants it); the `SelectInfo` widening needs the
    human-approval gate. The RFC's own owed Codex red-team (§12.3) runs in
    parallel. **Deferred beyond Phase 1:** the metric branch (value-x coords —
    Tidal/Estela), the cursor binding / head-row (Phase 2), and label rotation.
- **M5 — estela parity.** Faithful `DataChart` reproduction on real activity
  data; prove no-regressions; hand the production swap to the estela agent; flip
  `private:false` + first publish.

**Open decisions (surfaced when they gate, not before):** theme token depth (at
M2); how the estela swap is coordinated across the two agents (at M5). The
chart carry-forwards in the backlog (`toFloat64Array`, `fromTrustedColumns`,
`bin` NaN JSDoc) land into core as M1–M4 pull on them. (`bisectBegin` — done,
landed as `nearest`, see below.)

**`@pond-ts/fit` data points (from estela#76 review, `docs/notes/pond-fit-review.md`).**
The fitness-library work surfaced the same core needs as charts — pulling these
forward when they next gate:

- **Validity-aware bulk read — now a SECOND consumer (priority).** Both the
  fitness lib (`numberColumn`) and charts (`readNumericColumn`) hand-roll
  "`toFloat64Array` with missing → `NaN`." Land a **bundle-safe, validity-aware
  `column.toFloat64Array({ missing })`** in core so neither launders NaN by hand.
  This is the `toFloat64Array` carry-forward above; estela#76 is what tips it.
- **`column.hasAnyDefined()` / `allMissing()`** — the complement of `hasMissing()`;
  replaces estela's O(N) presence scan and backs `series.has(col)`.
- **`TimeSeries` (de)serialization** — the canonical-in-vault fast-read path needs
  columnar rehydrate; a `pond-friction` item (mechanism TBD, architecture settled).
- **Convergence:** the fit `activity.at(time)` (interpolated) is the same
  sample-at-time family as the chart tracker — both land on core `nearest` +
  `align`. Two consumers validate those primitives belong in core.

**✅ Landed carry-forward — `nearest(time)` in core.** M4.1's tracker pulled on
`bisectBegin`: it had a charts-local `nearestIndex` duplicating core's
`bisect`/`atOrBefore`/`atOrAfter`. Now core `TimeSeries.nearest(key)` — the
closest event by `begin()` distance (ties → earlier; clamps to an endpoint
outside the span; `undefined` iff empty), composed via `bisect`, O(log N) —
complements `atOrBefore`/`atOrAfter`. The chart tracker (`LineChart`/`BandChart`
`sampleAt`) calls `series.nearest`; the local `nearestIndex` is deleted. The "no
readout past the data span" rule stays as **tracker policy** (a chart-side guard
on the cursor time), per the chosen closest-existing semantics. Friction noted:
`Event.get` is typed-key, so the tracker reads the value via a runtime-string
cast (same shape as the column-API read in `data.ts`) — a candidate for a
runtime-string value accessor on `Event`/`TimeSeries` later.

**Wire format + columnar ingress — the end-to-end data path (Tidal-driven, 2026-06-30).**
Consolidates two carry-forwards above — **`fromTrustedColumns`** (the public
column-native constructor) and **`TimeSeries` (de)serialization / columnar
rehydrate** ("mechanism TBD") — into one committed story, now that Tidal +
`@pond-ts/financial` supply the driving consumer (a market-data endpoint feeding
charts at the ~70-100k-point client-side budget; SpiderRock's binary WS feed
later). The shape of the pipe, end to end — **simple rows in, columnar in the
middle, columnar out:**

- **Ingest stays simple at the easy end.** `TimeSeries.fromJSON({name, schema,
rows})` — positional row tuples, epoch-ms keys, `null` = gap — is the canonical,
  zero-transform door and stays the default; a plain REST endpoint emits exactly
  what `toJSON()` emits (round-trips by construction). The simple case must not
  pay for the fast case.
- **Columnar store in the middle** — already true (the internal `ColumnarStore` /
  `SeriesStore` the `select`-family reshapes via the private `#fromTrustedStore`).
- **Columnar-friendly hand-off to charts** — already true (`fromTimeSeries` /
  `fromValueSeries` read the columnar buffers directly: zero-copy `x`, materialized
  `y`; no per-event path).
- **The gap = a columnar INGRESS for high-volume feeds.** Land **`TimeSeries.fromColumns({name, schema, columns})`** — the public, _validated_ front door over
  the existing column-native machinery: accepts struct-of-arrays (JS `number[]` OR
  typed arrays), validates length/kind per column, fills `Float64Array`s
  (`null`/`NaN` = gap, pond's native signal), builds the key column, installs the
  store — **no per-row materialization, no re-validation pass.** This _is_ the
  columnar rehydrate the (de)serialization carry-forward wanted. (pond task #19.)

**Wire-format contract (design settled; full examples in the Tidal data-contract note):**

- **JSON columnar (struct-of-arrays)** — `{name, count, schema, columns:{time:[…],
open:[…], …}}`; epoch-ms number keys, `null` = gap, every column length `count`.
  Compact + gzip-friendly (homogeneous arrays compress well). Lands via
  `fromColumns`; the simple `fromJSON` row form stays for the easy/debuggable case.
- **Protobuf columnar** — `repeated double` **packed** fields _are_ columns (a packed
  blob ≈ a `Float64Array` on the wire). A generic `Series{name, count, repeated
Column}` with a `oneof` typed payload per column. Gaps = `NaN` in doubles (no
  validity bitmap needed); the **time/key column delta-encoded** (zigzag varint —
  the one column that meaningfully compresses). On LE machines a packed-double blob
  views straight as a `Float64Array` → `fromColumns` with **zero `JSON.parse`** —
  the path that matters for the binary WS feed + "load the archive once" scale. A
  `SeriesUpdate{from_index, repeated Column appended}` is the streaming/append
  extension onto `LiveSeries` (whose `toJSON` already narrows for the networked
  snapshot path).

**Calls:** JSON-rows = REST/dev default · JSON-columnar = the bulk endpoint ·
protobuf-columnar = the binary/streaming feed — **all land through the one
`fromColumns` / `fromJSON` door**, so the data model is single and only the decode
differs.

**Measured (spike, `tidal-app/pond-columnar-ingest`, 2026-07-01 — this is the
durable record of the sizing/ingest decisions):** 100k × 7 OHLCV cols, Node,
median-of-7.

- **Size surprised us: protobuf-`double` is the _worst_ size choice for
  fixed-decimal data** — 8-byte doubles beat short decimal text only at high
  precision, and their near-random mantissas don't gzip, so proto-double _worsens_
  with precision (gzip 1594→4083 KB across 2→8 decimals) while JSON-columnar (the
  smallest general choice, 1292 KB gzip) compresses well. **The real size win is
  fixed-point scaled-int varints** (prices ×10^d as zigzag varints, time
  delta-encoded): ~half the bytes (1014 KB gzip / 2661 KB raw @ 2dp) — but pays it
  back in decode CPU (descale + undelta + Long→number ≈ 33ms). Size ↔ CPU,
  quantified. The _encoding_ (fixed-point vs double vs text) dominates the _format_
  (protobuf vs JSON) for size.
- **`fromColumns` is the lever, confirmed.** Until it landed, every non-rows path
  paid a transpose→`fromJSON` tax (~28ms ingest) that dominated total time.
  `fromColumns` adopts the decoded `Float64Array`s directly: **ingest 27.7→2.8ms
  (protobuf), total 37→12ms**; JSON-columnar's `number[]` costs one bulk
  `Float64Array.from` (5.2ms) — the adopt-vs-copy gap that justifies the _one
  polymorphic door_ (typed-array adopt · `number[]` copy) rather than two.
- **The jank finding (browser, the reason this matters):** a 500k-pt ingest on the
  main thread freezes a rAF animation for a ~50ms frame; decoding in a **Web Worker**
  and transferring the `Float64Array`s back (→ `fromColumns` adopt, ~9ms on main)
  drops the worst frame to 9.2ms — smooth. **The columnar wire + `fromColumns` is
  what makes off-main ingest both _possible_ (typed arrays transfer zero-copy; JSON
  `number[]` can't) and _cheap_ (adopt, not re-materialize).** This is the payoff for
  charts: a hefty series lands mid-pan as a blip, not a multi-frame freeze.

So: protobuf earns its keep on **off-main parse-speed + zero-copy transfer + a
typed/evolvable schema + stream framing** (not raw size); fixed-point is the size
tool when a constrained link makes the decode CPU worth it; JSON-columnar is the
good-enough-no-schema middle. Exactly the menu a market-data feed needs.

---

## Docs site wave — the charts guide buildout (adopted 2026-07-12)

**Decision (pjm17971, 2026-07-11/12): build a best-in-class docs site
for `@pond-ts/charts` and the data→chart pipeline.** The full plan —
19-agent research across charting-library docs sites + repo grounding,
three-lens adversarial review, and the user's design directives —
lives in
[docs/notes/charts-docs-site-plan-2026-07.md](docs/notes/charts-docs-site-plan-2026-07.md)
(v2.2). Per the RFC-vs-PLAN layering, the note is context; **this
entry is the binding commitment.** The value-axis item in the
Documentation backlog (its own "highest priority" flag) rides P2 of
this wave.

Binding directives (user):

- **Live chart embeds** — real mounted components in MDX, cursors /
  hover / selection always on ("alive and beautiful" is the acceptance
  bar). Live _editable_ code stays deferred behind RFC #285.
- **One look** — a neutral, professional `docsTheme` for site chrome,
  every embed, and every Storybook story, light + dark; estela-flavored
  palette only as the worked example on theming-teaching pages/stories.
  **Superseded 2026-07-12** by the real Pond brand system (bracket
  mark, teal accent, IBM Plex): site chrome shipped in #437, and
  `docsTheme`/`docsThemeDark` retuned onto the brand's `tokens.viz.css`
  data-visualization ramp in #438 (`viz1`-`viz5` + `vizMark` + `vizUp`/
  `vizDown`, with the hard rule that `vizMark` never shares a hue
  family with any data-role color). `packages/charts/test/docs-theme-sync.test.ts`
  keeps `docs-theme.fixture.ts` and `website/src/css/custom.css` in
  lockstep; both PRs did a full wipe-then-regen of the 62 Playwright
  Linux baselines rather than a single-pass update, since a one-shot
  regen only rewrites snapshots that fail the 2% pixel tolerance and
  silently leaves old-palette-but-within-tolerance images in place.
- **Storybook = the disciplined, API-adjacent knob walk** — the
  story-discipline pass (tree normalization, thin-group coverage fill)
  is planned work in this wave.
- **Third-party charting is quarantined to the bridge page** —
  `pond-ts → Advanced → Using other chart libraries` assumes
  `@pond-ts/charts` is _the_ charting answer and is the only place the
  docs discuss exporting pond data to third-party chart packages
  (`toPoints`/column-API-as-export + a Recharts example live there,
  nowhere else). The Recharts-based dashboard guide is retired when
  the charts-native dashboard guide (P4) replaces it.

Phases (each independently shippable, ends with a docs deploy):

- [x] **P0 — hygiene** (shipped in this adoption PR): fix
      `advanced/charting.mdx` (claimed no first-party charts existed),
      add `Candlestick`/`ohlcFromTimeSeries` + the reader functions to
      the charts index (and remove the nonexistent `BoxPlot`
      candlestick-`shape` claim), `typedoc.financial.json` + `/api`
      landing now lists all five packages, re-home the orphaned
      `recipes/` pages into the sidebar, fix `intro.mdx`'s stale site
      map and the homepage CTA target.
- [x] **P1 — foundation** (complete, 7/7 shipped):
  - [x] Storybook `docsTheme` restyle + tree normalization + one-time
        visual-baseline regen (#433)
  - [x] site visual-theme pass, dark mode, local search, redirects
        plugin, llms.txt (#432)
  - [x] deployed Storybook, linked from the charts index (#434)
  - [x] live-embed infrastructure — `file:` workspace dep,
        `useSiteChartTheme` (the CSS-var bridge, not the dev-only
        fixture), the `example-sources` plugin + `<ChartExample>`
        single-source pattern, the seeded server-metrics dataset,
        one pilot example verified end-to-end (SSG, hydration,
        interaction, dark-mode retheme) (#435)
  - [x] Gallery (live cards) + evaluator-first charts Overview rewrite
        (#441) — 8 live `GalleryCard`s (ops dashboard, financial
        candlesticks, activity area, annotated region/marker/baseline,
        variance band, value-axis histogram, encoded scatter, boxplot
        percentiles) in a responsive `ResizeObserver`-driven grid, each
        linking its exact Storybook story id; `charts/index.mdx`
        reordered per plan §5a (live hero → snippet → compact
        capability matrix → why/when-not → used-in-production →
        doors). Drive-by fix: `ChartExample`'s placeholder referenced
        the pre-#438 `--pond-grid` token name (dangling since the
        rename to `--pond-viz-grid`).
  - [x] Learn chapters 1–5 (#443) — a five-chapter tutorial track
        (`website/docs/learn-charts/`), one running server-metrics
        example threaded throughout: ch1 the four-primitive minimal
        chart, ch2 dual-axis/two-row layout + the prop-identity
        caution, ch3 `fromJSON` + temporal keys (point vs. interval) + the data-contract idea, ch4 (the centerpiece) `aggregate` →
        bars, `rolling`+`baseline` → smoothed line + `BandChart`
        envelope, `partitionBy` → per-host multi-series, `byColumn` →
        value-axis histogram, ch5 the `as`-role styling pipeline +
        the three-way theming decision table. Every chapter has a
        live `ChartExample` embed. `charts/index.mdx`'s "Where to go
        next" now leads with Learn charts instead of the honest
        placeholder #441 shipped. Gotcha hit + fixed: Docusaurus
        strips a filename's leading `NN-` numeric-ordering prefix
        from both the doc id and the route slug, so `sidebars.ts`
        item ids and every chapter's internal `Next:` link had to
        drop the prefix too (`learn-charts/your-first-chart`, not
        `learn-charts/01-your-first-chart`).
  - [x] responsive-width recipe + `@pond-ts/financial` section stub
        (#445) — `recipes/responsive-width.mdx`: the `useMeasuredWidth`
        `ResizeObserver` pattern already used ad hoc by `GalleryCard`
        and `MultiPanelLayout.stories.tsx`, now a documented recipe
        with a live drag-to-resize demo; the 3 "not yet a documented
        recipe" placeholders (charts index, `GalleryCard`'s doc
        comment, Learn ch1's width caution) now link to it.
        `financial/index.mdx` (new `@pond-ts/financial` sidebar
        category, `website` takes a `file:` dep on the package): the
        `TradingCalendar` quickstart (`fromRules`/`fromSessions`,
        `sessions`/`sessionOn`/`isTradingDay`/`sessionContaining`,
        `barSequence`/`sessionSequence` → `aggregate`, `tagSessions` →
        `partitionBy`), with a real live demo — a candlestick chart
        built from weekday-only session data, calendar-aware via
        `ChartContainer`'s `calendar` prop, so weekends visibly
        collapse on the axis rather than leaving gaps. Explicitly not
        the full financial guide (OHLC → rollups → volume row → live
        forming-bar pattern) — that's still P3's flagship guide.
        Real bug caught in self-review before the PR even opened: the
        `responsive-width` demo measured its own padded/bordered box
        and hand the _outer_ (padded) width to `ChartContainer`, which
        then rendered inside the _inner_ (unpadded) space — silently
        clipped by the demo's `overflow: hidden`. Fixed by splitting
        the styled outer box from a plain, unstyled inner box that's
        the one actually measured; documented as a new gotcha in the
        recipe itself, since it's a realistic mistake the next reader
        would make too.
- [ ] **P2 — interaction + doc-debt burn-down** (in progress; 6/7 shipped):
  - [x] Learn chapters 6–9 (#446) — completes the nine-chapter tutorial
        track. Ch6 reading/selecting values: the five `cursor` modes
        via a live mode-switcher demo, `onTrackerChanged` for an
        off-chart readout, the `cursor="region"` → `onRegionSelect` →
        controlled `range` select-to-zoom loop. Ch7 marking up charts:
        `Region`/`Marker`/`Baseline` + a static `YAxisIndicator` pill,
        the two-register hue law. Ch8 live charts: `LiveSeries` →
        `useSnapshot` → chart (push faster than the throttle to make
        the re-render-on-snapshot-cadence model visible), the
        prop-identity caution one level up (memoize what `useSnapshot`
        feeds into), `createLiveValue` for an isolated-repaint pill,
        the live-data-is-append-only honesty note. Ch9 beyond the time
        axis: `byValue` → a linear value axis, `transposeRow` → a
        category axis, reuses #445's calendar-aware candlestick demo
        for the trading-time axis slot. Every API call (cursor modes,
        `onTrackerChanged`/`cursorTime`/`trackerPosition`,
        `onRegionSelect`, `LiveSeries`, `useSnapshot`, `createLiveValue`,
        `byValue`, `transposeRow`) verified against source via a
        research subagent before writing example code — one correction
        surfaced: the plan's remembered "partitioned per host" live
        example doesn't exist anywhere in the stories, so ch8 uses a
        single live series instead of claiming a pattern that was
        never actually vetted. Two real bugs caught by `npm run
typecheck` (not just eyeballing): `TimeSeries.timeRange()`
        returns a `TimeRange` _class_ (`.begin()`/`.end()`), not a
        plain tuple — two new examples had array-indexed it directly.
        `learn-08-live-value.tsx`'s `createLiveValue` pill was verified
        live-updating by finding its actual DOM node (a plain styled
        `<div>` chip, not canvas/SVG) after a canvas-byte-diff check
        wrongly suggested it was frozen — `YAxisIndicator` doesn't
        paint to canvas at all.
  - [x] **Interaction reference section** — new `Interaction`
        sub-category under `@pond-ts/charts` (3 pages, matching the
        docs-plan §3 IA): `cursors-and-readouts` (all seven
        `CursorMode` values incl. `none`/`region` in a complete table
        — ch. 6 only tours five; `onTrackerChanged` +
        `TrackerInfo`/`TrackerSample` shapes; `trackerPosition`,
        `cursorTime`, `crosshairSnap`; reuses the `learn-06-cursor-modes` + `learn-06-tracker-readout` embeds), `selection-and-hover`
        (`selected`/`onSelect`/`hovered`/`onHover` + `SelectInfo`; the
        id-gates-selectability rule; single-select honesty; distinct
        from annotation selection — no existing embed, links the real
        `Bar`/`Scatter` selection stories), `pan-zoom-and-range-selection`
        (`cursor="region"` + `cursorSequence` + `onRegionSelect`; the
        select-to-zoom loop via `learn-06-zoom`; `panZoom` +
        `onTimeRangeChange` + `minDuration`; the "container never zooms
        itself" contract). All props verified against
        `ChartContainer.tsx`/`context.ts` source.
  - [x] **Annotations & indicators reference section** — new
        `Annotations & indicators` sub-category (4 pages, the docs-plan's
        "ONE section" mandate): `the-annotation-model` (two registers,
        3 depth levels, 3 interaction modes, the indicator law;
        `learn-07-annotations` hero embed), `region-baseline-marker`
        (full geometry/label prop tables for all three — `Region`
        `from/to/edges`, `Marker` `at/indicator`, `Baseline`
        `value/axis/labelSide/labelPosition/indicator`; from
        `annotations.tsx`), `editing-and-creating` (shared
        `id/selectable/selected/hovered/editing` + per-primitive
        `onChange`; container `onSelectAnnotation`/`onHoverAnnotation`/
        `onEditAnnotation`/`editAnnotations`/`snap`; `creating` +
        `CreateSpec` union; snap-is-guideline-only honesty),
        `axis-indicators-and-live-values` (`YAxisIndicator` full props;
        `createLiveValue`/`LiveValue` isolated-repaint path, linked —
        not restated — to ch. 8 + the react hooks page; "no standalone
        `XAxisIndicator` — it's `<Marker indicator>`"; the pill-location
        table). Both sections: `docusaurus build` (`onBrokenLinks:
'throw'`) clean after a cache-clear; reused live embeds checked
        in-browser (canvases render, no console errors). Storybook
        deep-links point at real story export names (verified against
        the `.stories.tsx` files). Content-ownership rule followed:
        reference pages give the complete prop/mode tables and link the
        Learn chapters (6, 7, 8) for narrative rather than restating.
  - [x] **Financial charts hub (+ TradingView vocabulary bridge)** —
        `charts/financial` (#483). Leads with the **studies library**
        (per the package's headline direction — a growing studies library):
        the study contract (pure `(series, options) => series` appending
        oracle-verified columns; `column`/`output`/bar-count-period +
        length-preserving warm-up), the fluent surface, a table of the
        **10 studies shipped today** (sma, ema, bollinger, envelope,
        rollingStdev/Min/Max/Percentile, zScore, percentChange), and a
        "what's coming" note (Phase-1 breadth: RSI/MACD/ATR/VWAP/…).
        Then chart assembly (candles + volume pane + trading-time axis +
        crosshair/OHLC + live pill) and a Coming-from-TradingView
        vocabulary table. New Bollinger-band + EMA overlay embed
        (`charts-financial-studies.tsx`), study pipeline verified in
        Node. Studies table + embed columns + cross-links verified vs
        source (Layer 2, high confidence).
  - [x] **Missing data & gaps page** — `charts/gaps` (#477), the
        canonical gap-semantics owner: the NaN contract (not
        null/undefined), the upstream (`materialize` empty buckets →
        `fill(strategy, { maxGap, limit })`, all-or-nothing per gap) vs
        downstream (`GapMode` on Line/Area: empty/none/dashed/step/fade)
        split, the per-layer matrix (band always-breaks; scatter/bar/
        box/candle no-draw). New interactive gap-mode switcher embed.
  - [x] **value-axis docs** (the Documentation backlog's
        highest-priority item) — closes B5 at reference level (the
        series-level concept page landed earlier via #382/#383/#421;
        Learn ch. 9 closed the tutorial level via #446). New page
        `website/docs/charts/value-axis.mdx`, added to the
        `@pond-ts/charts` sidebar between Learn charts and the
        generated API link: kind-inference reference (the
        `'time'`/`'value'`/`'category'` table + the container's
        mixing-throws invariant, quoted from `ChartContainer.tsx`'s
        actual error string), the two ways onto a value axis
        (`byValue` projection, linked out to ch. 9's live embed rather
        than restated — content-ownership rule — plus a new native
        `ValueSeries.fromColumns` live embed since ch. 9 only covers
        the projected case), `byColumn` as a value-axis histogram
        (reuses the Gallery's existing `gallery-histogram` example
        component directly — single-source, no duplicated fixture),
        category axis (links ch. 9 + the `Axes/CategoryAxis` Storybook
        group rather than re-embedding, since Storybook is already the
        systematic per-prop reference), a new dual-x-axes live embed
        (`charts-value-axis-dual.tsx`, the linear
        strike-to-moneyness `transform` case — simpler than the
        shipped σ-to-delta nonlinear story, chosen so the docs example
        stays readable; shares its synthetic smile chain with the
        native-`fromColumns` example via a new
        `lib/value-axis-fixtures.ts`, the same shared-fixture
        convention `gallery-fixtures.ts` already established), and an
        interaction section linking the
        `Cursors/Region` + `Annotations/Scenarios` value-axis stories
        without a new embed. Cross-linked from the concept page's
        "Plotting" bullet, ch. 9's recap, and `charts/index.mdx`'s
        "Where to go next". `docusaurus build` (with `onBrokenLinks:
'throw'`) passed clean, and both new live embeds were checked
        in-browser in light + dark mode (the theme retunes live via
        the `data-theme` `MutationObserver` bridge, no reload needed).
        Placement note: the content-ownership table in the docs-site
        plan slots chart-level value-axis content under a not-yet-built
        "X-axes page" inside P3's "Axes & layout" fan-out; this page is
        that content pulled forward to close P2's backlog item now —
        P3 should absorb/link it rather than duplicate when the Axes &
        layout section is built.
  - [ ] prop-identity recipe + story-coverage fill for the groups
        these pages source from. **Partial prep landed:** #464
        promoted the axis/annotation/cursor/indicator/gap story
        groups scattered through `Charts/` to top-level Storybook
        groups (`Axes/`, `Annotations/`, `Cursors/`, `Indicators/`,
        `Gaps/`), leaving `Charts/` holding only chart-type
        primitives — a second tree-normalization pass (title-only,
        no story renders changed, e2e spec IDs + docs-site Storybook
        links updated). This is scaffolding for the coverage fill,
        not the fill itself — no new stories landed.
- [ ] **P3 — reference fan-out + flagship guide**: per-chart-type
      pages, Axes & layout, Theming, Data adapters, Cheat sheet,
      Rendering & performance (measured perf envelope — the accepted
      #395 docs deliverable), Design philosophy (2 pages),
      Accessibility, Troubleshooting, Coming-from-RTC migration page,
      the financial end-to-end guide.
  - **Structure agreed 2026-07-15 (user-directed), building top-to-bottom
    as one PR per section.** Final `@pond-ts/charts` nav order: Gallery,
    Learn charts, **Axes**, **Layout**, **Chart types**, Interaction,
    Annotations & indicators, **Missing data & gaps**, **Financial
    charts**, API reference (generated link). Divergences from the
    docs-plan §3 IA, on purpose: (a) **Axes and Layout are split** into
    two separate sections (plan had a combined "Axes & layout"); (b)
    **Axes leads** (before Chart types), and the shipped
    `charts/value-axis` page **relocates under it** →
    `charts/axes/value-axis` (update the 3 doc cross-links —
    `charts/index.mdx`, `start-here/concepts/value-axis.mdx`,
    `learn-charts/09-…` — plus sidebars.ts). **Axes section = 4 pages**
    (full scope): overview (Y & X axes) · Value axis (moved) · Category
    axis · Trading-time axis (charts scale + financial calendar).
    **Chart-type pages** use a _middle-tier_ template (lighter than the
    plan's 9-section one): live hero + when-to-use → minimal snippet →
    data contract → compact props table → a few key variants w/ embeds →
    interaction/theming/cautions → footer link to the generated typedoc
    page. One page per draw layer: LineChart, AreaChart, BandChart,
    ScatterChart, BarChart, BoxPlot, Candlestick (Histogram is a
    BarChart mode, not its own page). Each links out to the generated
    reference for exhaustive types — "something in the middle" between
    Learn and typedoc, matching the Interaction/Annotations pages.
  - **Shipped (2026-07):** Axes section (#474), Layout (#475), Chart
    types 8 pages (#476), Missing data & gaps (#477, counted under P2),
    Financial charts hub (#483, P2). Reconcile after #479/#481 axis
    rendering changes: `grid` + `sessionDividers` container props
    tabulated (#482). **Repo transferred to `pond-ts/pond`** mid-wave
    (#480 hosting migration → Cloudflare/pond-ts.org); local remote
    updated. Theming (re-homed + expanded) and Cheat sheet (canonical
    owner of the capability matrices) shipped in #487; API.md
    agent-facing API map (#488) + CI guard (#489) landed alongside.
    **Remaining P3 reference pages:** Data adapters, Rendering &
    performance, Design philosophy (2), Accessibility, Troubleshooting,
    Coming-from-RTC migration, the financial end-to-end guide.
- [ ] **P4 — guides library completion**: ops-dashboard, annotation
      workflows, and value-axis guides + remaining recipes.

Content-ownership rule (review-checklist item for every docs PR in
this wave): every cross-cutting concept has one canonical page;
everything else links — see the ownership table in the plan note §3a.

## Core docs & landing wave — concept figures (kicked off 2026-07-17; first tranche shipped in #490, v0.48.1)

Companion wave to the charts buildout, aimed at the **core-transform
docs pages and landing story**: the thesis is "analytics AND
visualization platform", so each core page gets a **codeless embedded
concept figure** whose controls bind to **pond core options** (window,
reducer, method, stride, sigma, smoothing strength) — never chart
props — and every figure dogfoods real pond operators through real
`@pond-ts/charts` primitives. Full plan:
[docs/notes/core-and-landing-docs-plan-2026-07.md](docs/notes/core-and-landing-docs-plan-2026-07.md).
Built by two agents sharing one branch/worktree; landed as one PR
(#490) to keep the interleaved history, then released as **v0.48.1**.

- **Shipped (#490):** `ConceptViz` shell (`BrowserOnly` mount,
  `SegmentedControl` / `Slider` / `ToggleChips` / `PlayButton`);
  figures on aggregate + reduce (water-drop ponds), byColumn (live
  value-axis histogram), byValue (run-pace hero), align
  (grid-construction, semantics verified against source), sampling
  (static stride/reservoir + live stride with stable kept-subset),
  smoothing (EMA/MA/LOESS over real SILSO sunspot data, one
  bandwidth-matched strength slider), anomaly detection (live
  `baseline()` band + out-of-band scatter, live sigma), rolling
  (batch + live window figures — rolling-page agent); Queries page
  columnar refresh; all seven Concepts-page Excalidraw PNGs redrawn
  as theme-aware SVG components (`ConceptFigures/`).
- **Dogfooding payoff:** building the smoothing figure surfaced a
  real core bug — `smooth(…, 'loess')` was numerically unstable on
  epoch-ms anchors (un-centred normal equations, cancellation).
  Fixed + regression-pinned (second-spaced anchors; test verified to
  fail on pre-fix code) in the same wave; released as v0.48.1.
- **Remaining:** landing-page story + any core pages the plan note
  lists beyond the transforms set (see note for the roster).

## In-site API reference (pilot; kicked off 2026-07-19)

**Direction (pjm17971):** replace the typedoc HTML sub-sites under
`/generated-api/*` with reference pages that are fully part of the
site — extract TS → JSON, distill to a curated model, render with
site components — **centered on the primitives** (core: `Time`,
`TimeRange`, … `TimeSeries`, `LiveSeries`; charts: one page per
React component, docstring first then props).

- **Charts rollout shipped:** all 17 React components with Props
  interfaces, grouped Structure (`ChartContainer`, `ChartRow`,
  `Layers`, `XAxis`, `YAxis`, `Canvas`) / Draw layers (the seven
  chart types) / Annotations (`Baseline`, `Marker`, `Region`,
  `YAxisIndicator`). `TimeAxis` / `CategoryAxis` ride along as
  thin `XAxisProps` wrappers (Layer 2 catch — they were mislabelled
  "inline prop types"). Not yet covered: data adapters, hooks,
  scales (functions, not components — a different page shape) — the
  remaining gap before `/api` can swap over.
- **Core rollout shipped:** all 13 core-primitive pages — the three
  temporal keys (`Time`, `TimeRange`, `Interval`), `Event`,
  `Sequence` / `BoundedSequence`, the batch series (`TimeSeries`,
  `PartitionedTimeSeries`, `ValueSeries`), and the live layer
  (`LiveSeries`, `LiveView`, `LivePartitionedSeries`,
  `LivePartitionedView`) — under a grouped sidebar. Models emit one
  JSON per page (page-local hover dictionary), so a page loads only
  its own chunk (`TimeSeries` alone is ~150 KB). Type printer covers
  the full real surface with zero warnings (added
  namedTupleMember / mapped / inferred / rest). Referenced-type
  **hover cards** (kind badge, package, printed definition,
  first-paragraph doc) resolve across both package JSONs.
  `TimeSeries` / `LiveSeries` / `LiveView` lack class-level
  docstrings in source (pages faithfully show none) — flagged as a
  library docs chore.
- **Pilot shipped:** `website/scripts/build-api-model.mjs`
  (`typedoc --json` → curated model in `src/api-model/`, gitignored,
  wired into prestart/prebuild; fails the build if a curated symbol
  vanishes from the export surface), `ApiDoc` components
  (`ApiClassPage` / `ApiComponentPage` — docstring-first, house
  "Example:" split into code chips, member index, prop cards), and
  two pages under an "API (pilot)" sidebar group: `Time` (class) and
  `<LineChart>` (component). Docstrings render as markdown
  (react-markdown); signatures as highlighted TS.
- **Known pilot limits (the rollout backlog):** `{@link}` renders as
  code, not resolved cross-page links; type printer covers the
  common tree kinds with an `unknown` fallback + build warning;
  `TimeSeries`-scale pages need collapsed generics + grouped method
  categories; typedoc sub-sites stay live until parity, then `/api`
  swaps over.

---

## Active experiments

Pond is battle-tested through parallel multi-agent experiments — see
[CLAUDE.md "Multi-agent experiments and the feedback model"](CLAUDE.md#multi-agent-experiments-and-the-feedback-model)
for the philosophy. This section is the canonical roster: who's
working on what, what each has driven into the library, where each
track is now.

### Internal robustness audits

Complementing the experiment loop (which surfaces _user-facing_ API
friction), a fresh model periodically does a full-project read-only
audit targeting _internal_ robustness — the issues experiments route
around rather than report. As the available model improves, re-run.

- **2026-06-10 (fable, against v0.20.0):**
  [`docs/notes/technical-audit-2026-06.md`](docs/notes/technical-audit-2026-06.md).
  Healthy baseline (~2,100 tests, ~zero debt markers, honest decision
  log). Top findings triaged into the backlog: live-layer listener
  error isolation + re-entrancy contract; partition-cardinality cap
  (double-signalled with the metric-agent review); perf-scripts-in-CI
  - coverage; React `useSyncExternalStore` migration; operator
    extraction + type-safe schema helpers. Two findings cross-validated
    independent signals (partition OOM; the "which aggregation style"
    doc gap), which bumped their rank.
- **2026-06-12 (opus, against v0.21.0):**
  [`docs/notes/technical-audit-2026-06-v2.md`](docs/notes/technical-audit-2026-06-v2.md).
  Confirmed the Step-4 column-native wave goal empirically (pipeline tax
  fixed; ~11.8k differential-fuzz cases, zero mismatches on type-correct
  input). Surfaced **three P0s — all fixed for v0.22.0:** §1.2 `asTime`
  monotonicity guard ([#201](https://github.com/pjm17971/pond-ts/pull/201));
  §1.3 `mapColumns` rejects non-finite numeric results at write, consistent
  with intake ([#202](https://github.com/pjm17971/pond-ts/pull/202)); §1.1
  `aggregate('stdev')` silent numeric change + NaN crash, fixed by unifying
  `reduce` / `reduceColumn` / `bucketState` on one **Welford** recurrence
  ([#203](https://github.com/pjm17971/pond-ts/pull/203) — a Codex pass caught
  that bucketState-only Welford still diverged from the two-pass `reduceColumn`
  ~8.7% at 2^52; Welford chosen over buffered two-pass to keep the shared live
  path O(1), at the cost of `reduceColumn` stdev ~3× a divisionless scan).
  **Open follow-up (not gating 0.22.0):** the computed columnar writers
  (`cumulative` / `diff` / `shift` / `collapse` via `float64ColumnFromArray`)
  can still pack non-finite (overflow → Inf, 0/0 → NaN) — the §1.3 sibling; the
  candidate fix is a principled reducer NaN policy (consistent fast/row/bucket/
  rolling for all inputs), not a blanket builder throw. Perf P1s still open:
  partitioned `aggregate` never takes the 3B fast path; cold `aggregate()`
  materializes via `timeRange()` (columnar `timeRange` is the cheap fix);
  `partitionBy().op().collect()` (~920 ns/row) is the top batch hotspot.

  **v2 backlog beyond the P0s** (full detail in the linked doc; this is the
  actionable integration so the findings aren't stranded in the note):
  - **P1 — live robustness cluster** (§4; empirically reproduced, third audit)
    — ⏳ **STILL OPEN; the standing live-correctness P1** (#114/#98/#99). The
    one piece of non-speculative core debt left from this audit — confirmed
    wrong-answer behavior under code already in flight, not an optimization.
    Travels with the reorder+retention windowed-extrema bug from the
    live-columnar assessment (`docs/notes/live-columnar-assessment-2026-06.md`).
    listener error isolation (a throw skips retention entirely + a derived
    `filter()` view desyncs permanently), re-entrancy (3 failures incl. the
    `[object Object]` error at `live-view.ts:704`), unbounded partitions
    (push-driven `maxAge` never evicts quiet keys; `maxPartitions` silently
    ignored), **chained dispose** (`live.filter().map()` orphans the
    intermediate — no way to dispose it; `dispose()` has no JSDoc). Items 1–3 →
    tasks #98/#99; chained-dispose + evict-staleness + the empirical upgrade →
    new task #114.
  - **P1 — columnar `timeRange()`** (§3.3) — ✅ **SHIPPED #214 (v0.24.0)**: cold `aggregate()` defaults `range`
    to `series.timeRange()`, materializing all events (430 ms/1M) before the
    fast path runs (one-shot callers see ~1.09×). `begins[0]..begins[n−1]` off
    the key column (`time-series.ts:3664`) → ~21× faster cold path, every
    caller benefits → new task #115.
  - **P1 — partitioned-aggregate fast path + columnar partitionBy split**
    (§3.2/§3.3) — ✅ **SHIPPED #215 + #216 (v0.24.0)**: the auto-injected `'first'` partition reducer had no
    `reduceColumn`, so the all-or-nothing gate bails for _every_ partitioned
    aggregate (~14× slower than it should be); and `partitionBy().<op>()` buckets
    via `source.events` + rebuilds via `fromEvents`, re-paying the tax — the top
    batch hotspot and the library's own recommended pattern. Columnar partition
    split (scatter by group index) is the highest-leverage next batch target,
    ahead of 3C → new task #116.
  - **P1 — greenfield adoption killers** (§5) — ✅ **SHIPPED #206 + #211 (v0.23.0)**: F1 — mixed shorthand+`{from,
using}` aggregate mappings resolved to the shorthand overload and silently
    drop every spec-keyed output column from the result _type_ (runtime emits
    it); F2 — shipped `.d.ts` fail under `skipLibCheck: false` (`EMITS_EVICT`
    stripped from `series.d.ts` but its re-export survives in `index.d.ts` →
    TS2305). Both first-hour killers, both cheap → new task #117.
  - **P2 — wave mediums** (§7): `collapse` mixed-kind → silent missing (row-0
    inference); `fill` literal `undefined` now throws; `slice`/rekey dropped
    cross-derivation identity + zero-copy results pin the parent's full buffers
    (subarray retention — doc + copy-out pointer); inconsistent unknown-column
    handling across the 6 ops (2 skip, 4 crash); `kind→builder` triplicated
    (fill/map/collapse); `withKeyColumn` breaks `with<Noun><Participle>`;
    `asInterval` cast-bypassed label rejection works by accident → fold into
    #104 (papercuts) + #106 (parity matrix covers NaN-untested).
  - **P2 — smaller** (new task #118): `Sequence.calendar('hour')` accepted with
    no unit validation → silent garbage (runtime throw, §6); `validateAndNormalize`
    is dead code — cleanup (§2); #200's three redundant self-casts at
    `time-series.ts:1378/1399/1457` (§2); F3–F12 doc/type (unsorted-rows
    `{sort:true}` + ingest doc, `Time.asString`, CJS error, source maps, §5).
  - **Carried, already tracked:** CI TZ matrix + perf-in-CI (§3.3/§6 → #100),
    cast growth + schema helpers (§2 → #102), parity matrix (§1.1/§7 → #106),
    bundle re-pin 48.5 KB vs <25 KB RFC (§7 → #108), 3C rolling after the NaN
    doc (§3.4).
  - **Process (§8), discipline note not a task:** #186 merged 66 min after a
    medium-confidence L2 that recommended Codex + deferred two decisions, with
    no committed record — the exact gap this wave's stdev re-fix _avoided_ by
    actually running the Codex pass. The confidence machinery was accurate (the
    dimension it "cleared," parity, is where all three P0s lived); hold the
    merge discipline around it.

### CSV-cleaner (complete; v0.9.x)

Three-agent run (Claude, Codex, Gemini) on a real per-host metrics
CSV with mixed timestamp formats, four spellings of "missing,"
duplicate-retry rows, and gap-from-missed-scrapes. Each agent
produced an independent friction report; library responded with a
coordinated v0.9.x wave.

- **Drove:** `partitionBy`/`PartitionedTimeSeries` (cross-entity
  correctness), `dedupe({ keep })`, `fill(maxGap)` + all-or-nothing
  fill semantics, `**Multi-entity series:**` JSDoc warnings on every
  stateful operator.
- **Writeup:** `website/docs/how-to-guides/ingesting-messy-data.mdx`.
- **Source folder:** `experiments/csv-cleaner/` (PROMPT.md, RUBRIC.md,
  SPEC.md, generate.ts, messy.csv, results/).
- **Notable:** Gemini escaped its sandbox, found the experiment
  folder, cheated. We laughed.

### Dashboard (ongoing as reviewer; drove v0.10-v0.11.0)

Built a full webapp at
[`pjm17971/pond-ts-dashboard`](https://github.com/pjm17971/pond-ts-dashboard).
The dashboard agent stays involved as the React/charting domain
expert and reviews PRs touching that surface. **`@pond-ts/charts` has now
extracted (M0–M4.2 + chart types + value-axis), so the next move is dashboard
ADOPTION** — swap our charts in for its hand-rolled canvas charts and report the
gaps + any perf slips vs its own. That comparison is the honest test of whether
the package earns its place (and one of the inputs that should drive the chart
roadmap).

- **Drove:** v0.11.0 `LivePartitionedSeries` (named explicitly as the
  "obvious next step" in round-2 feedback), `useCurrent` reference
  stability, `pivotByGroup` typed `groups`, `useEventRate` /
  `LiveView.eventRate()`, `useCurrent` value narrowing.
- **Writeup:** `website/docs/how-to-guides/dashboard-guide.mdx`.

**Current wave (2026-06): per-render cost at 256-host stress.** The
dashboard now stress-tests at 256 hosts × 250–500 ev/s, which surfaced a
cluster of allocation/rebuild friction (three reports in
`~/Notes/Projects/Pond/`: snapshot-side `partitionBy.toMap` gather, snapshot
flush cost, wide-schema metrics). The library response, ranked by
value-per-surface (surface-area sensitivity is now an explicit constraint —
no hard-to-explain toggles):

- **Shipped:** [#180](https://github.com/pjm17971/pond-ts/pull/180) —
  `LiveView.toTimeSeries()` memoized by a mutation counter (the flush-cost
  report's issue #1). Back-to-back identical-state snapshots return by
  reference: >1 s React commits → ~0 (44 ms → 0.0001 ms at 262k events).
  **Zero public surface.**
- **Queue** (surface-minimal first): NaN-as-missing error nudge (wide-schema
  #3, zero surface); `push` × N vs `pushMany` jsdoc warning (90,000× gap,
  zero surface); **`TimeSeries.partitionBy().toMap()` gather-only** — the
  snapshot dual of increment 1's `LiveView` column gather, the dashboard's
  biggest validated ask (workaround already bought 218 ms → 300 μs at 256
  hosts); `column.dropMissing()` (wide-schema #7, the only correctness item).

**Live zero-copy arc — explored, measured, DEFERRED (2026-06-03).** The
"column-native output" arc (chunk `collect()`/rolling output for zero-copy
per-partition reads) was scoped and sized, then parked. Two measurements
killed it at realistic scale: `perf-band-gather.mjs` showed the per-partition
band gather is **<6% of a frame at ≤64 hosts** (hot only at the 256-host /
fast-clock ceiling), and the synchronized rolling output is
partition-**interleaved** (not per-partition contiguous), so a zero-copy
windowed read doesn't even apply without a hard-to-explain opt-in mode. The
real friction is the snapshot-side cluster above, not the arc. #175 (its P0)
stays merged on its own gRPC-OOM merits. Detailed briefs + the
`windowColumn` spike + `perf-baseline-memo-split.mjs` /
`perf-liveview-structural.mjs` live on branch `spike/structural-window`;
`docs/briefs/collect-output-columnar-arc.md` is the arc's design record.
Revisit only if a 256-host-class dashboard becomes a committed target.

### gRPC pipeline (M3.5 done; **V5 columnar re-bench wave queued 2026-05-28**)

Claude agent. Three-process gRPC + WebSocket stack: producer
(`@pond-ts/dev-producer` candidate) → aggregator (`@pond-ts/server`
candidate, runs a server-side `LiveSeries`) → web dashboard (the read
side, `useRemoteLiveSeries` candidate). Targeting M5 extraction
sweep producing three RFC-style design docs.

**Active wave: V5 columnar re-bench.** Per Phase 4.7's "Next wave"
sequencing, the experiment re-benches against the matured substrate
(v0.17.1 vs the V4 baseline at v0.14.0) to surface which substrate
step earns library work next (Step 7 LiveSeries ring buffer vs
Step 3 Phase C rolling fast path). Plan:
[`columnar-rebench.md`](https://github.com/pjm17971/pond-grpc-experiment/blob/main/friction-notes/columnar-rebench.md).

- **Drove so far:** v0.11.3 (`pond-ts/types` subpath export — schema-
  as-contract without runtime dep), v0.11.4 (`LiveSeries.toJSON` /
  `pushJson` / `pushMany` / `Event.toJsonRow` — codec-agnostic
  snapshot+append primitives), v0.11.5 (packaging fix — README/
  LICENSE/CHANGELOG in tarballs), v0.11.6 (count() doc clarification
  on duplicate keys; the M3 friction notes confirmed this fixed M1's
  misdiagnosed stagger workaround), v0.12.0 (Trigger
  primitive — M3.5's `HostAggregator` motivated the synchronised
  partitioned-rolling shape; webapp telemetry's `.sample()` use case
  folded into the same redesign).
- **Milestone files:** `experiments/grpc-pipeline/{PLAN,LINKS,M0..M3.5}.md`.
  - M3 (PR #8) — throughput-characterisation friction report, gRPC
    framing-bound at 73k events/sec, captured in PLAN under
    "Performance expectations and the bench-vs-real-world gap."
  - M3 phase A (PR #9) — `EventBatch` wire batching, 22k → 486k
    events/sec at the saturation cell; pond is genuinely under
    pressure now (~30% wall-clock minor GC). Confirmed bench numbers
    are real-world-validated.
  - M3.5 (PR #11, PR #13) — server-side aggregation slice; surfaced
    that pond had no synchronised-partitioned-tick primitive,
    forcing a hand-rolled `HostAggregator`. Resolved by the v0.12
    Trigger redesign (RFC: `docs/rfcs/triggers.md`).
- **Carry-forwards to `@pond-ts/server` RFC:** coalesce strategy with
  tested default windowMs, reference EventBatch-style proto in
  examples, snapshot-cache design, slow-client policy defaults,
  per-phase metrics histograms (`pushManyTotalMs`, `fanoutRecordMs`,
  `fanoutSerializeMs`, `fanoutBroadcastMs`) as opt-in defaults.
- **V4 validation (2026-05-01).** After v0.14.0 shipped, the
  experiment re-profiled and produced a four-way bench (V1 manual
  `HostAggregator` → V2 v0.12 trial → V3 v0.13.0 → V4 v0.14.0).
  Every CHANGELOG-claimed delta from the v0.14.0 wave shows up in
  the bench: heap −17% to −50% across moderate loads, ceiling
  throughput +23% (208k → 256k/s), tick fps +30%, p99 1.91ms →
  1.15ms. The two profile-flagged hot spots
  (`estimateEventBytes` + `Event → row → Event` round-trips) are
  gone or reduced as advertised. **The remaining ~38% ceiling gap
  to V1 is now isolated to one operator:**
  `LivePartitionedSyncRolling.ingest` per-event reducer-state
  work (8.2% self time at V4 ceiling, larger share than V3's 4.1%
  only because more events are processed per second — the per-event
  cost is roughly unchanged). Reducer batching is the natural
  next lever IF a future user pushes near ceiling; production
  target is 100k/s (V4 hits 256k/s = 2.56× headroom), so it
  doesn't earn its API surface yet. PR #14 on
  `pond-grpc-experiment` carries the four-way story; the
  experiment is now considered fully realized for the M3.5
  scope and ready for its writeup.

### Charts experiment (kicked off 2026-05-26; validates Phase 4.7 substrate against chart use case)

> **Superseded 2026-06-17** by the committed canvas wave — see
> [Current focus → `@pond-ts/charts`](#current-focus--pond-tscharts-canvas-wave-kicked-off-2026-06-17)
> at the top. This experiment (a paused, raw-canvas validation harness)
> remains the source of the substrate-access friction notes the wave builds
> on; it is no longer the live charts track.

Claude agent at
[`pjm17971/pond-ts-charts-experiment`](https://github.com/pjm17971/pond-ts-charts-experiment).
Pulled forward from the planned step-8 chart-extraction alignment
because pre-step-3 was the right moment to validate that the
substrate ACTUALLY serves the chart use case it was strategically
motivated by. Steps 3–7 are downstream of that justification; if
the chart adapter can't consume the substrate cleanly, the
back-half of the columnar roadmap is mis-targeted.

The pond-ts side already shipped:

- **Spike PR #152** — `series.column(name)` + `series.keyColumn()`
  experimental accessors. Measured **~9× faster per-frame walk**
  via typed arrays vs the row-API path at N=1M.
- **Friction notes** at
  [`docs/notes/chart-spike-friction.md`](docs/notes/chart-spike-friction.md)
  capturing 7 design questions for steps 3–8.

The experiment repo's job is to **validate the spike's claims in a
real browser environment** with an interactive chart (pan / zoom /
range-select). Five workloads in priority order: (1) single-column
line chart scaling 100k → 1M → 10M; (2) multi-column overlay;
(3) chunked-column rendering after `concatSorted`;
(4) range slicing for zoom; (5) interval-keyed heatmap.

- **Will drive:** step 8 (chart-extraction alignment) scope
  refinement based on real friction. May also drive step 4
  (derived transforms) if windowing / slicing surfaces gaps.
- **Stack:** Vite + React + TypeScript + raw Canvas (no chart
  library — pond-ts friction in foreground).
- **Status (updated 2026-06-28):** M1 + M2 shipped (single-column line chart
  100k→10M; multi-column overlay — substrate access validated, 60 fps at N=10M;
  M3/M5 chunked/heatmap deferred). The repo has since **pivoted from raw-canvas
  validation to being the first `@pond-ts/charts` _package_ consumer**: a
  network-traffic dashboard exercising the annotation API end-to-end (toolbar +
  synced legend + inspector + all three interaction modes;
  `friction-notes/annotations-consumer.md`, which drove the `AnnotationKind` /
  `CreateSpec` barrel export). No longer paused — it's now the charts-adoption +
  friction dogfood.

### Webapp telemetry (ongoing; drove v0.11.8)

Codex agent. Frontend telemetry-stats reporting (collect latency
events, sample percentiles to a backend every 30 s, display live in
React). Real production code in a trading-platform app.

**Status (2026-06-28): shipping to PRODUCTION the week of 2026-06-29** — pond's
first production deployment with live user data (rolling stats on real front-end
performance telemetry). The validation that the live rolling-stats path holds up
under real load + messy real-world telemetry.

- **Drove:** v0.11.8 `rolling.sample(sequence)` (later subsumed by
  v0.12.0 triggers). The first design attempt was an
  overload (`live.rolling(Sequence, '1m', mapping)`) mirroring the
  batch shape; closed PR #92 walked that back after implementation
  surfaced a hidden-ownership leak and locked-away rolling state.
  v0.11.8 (PR #93) shipped `.sample()` as a separate composition step.
  Then the gRPC experiment's M3.5 work surfaced that `.sample()` was
  itself overly specific — the deeper factoring is `Source × Trigger
× Aggregation`, with `.sample()` collapsing into "rolling with a
  clock trigger." v0.12.0 ships `Trigger.clock(seq)`
  as a first-class concept; `.sample()` and `LiveSequenceRollingAggregation`
  are deleted. The webapp telemetry agent migrates from `.sample()`
  to `{ trigger: Trigger.clock(seq) }` as part of v0.12 adoption.
- **Surfaced as next deferred:** the `AggregateOutputMap` overload
  on `LiveSeries.rolling()`. The Codex code duplicates the same
  numeric value into four columns named `p50`/`p75`/`p95`/`count` to
  satisfy `AggregateMap`'s "one reducer per column" constraint —
  exactly the gap PLAN's deferred section predicted.

### estela (geo + power; drives `@pond-ts/fit`; kicked off 2026-06-14)

estela — "a story-first record of long journeys" (sibling repo) — is the
use-case experiment driving **`@pond-ts/fit`**, the activity-analytics umbrella
(reframe from `@pond-ts/geo`, adopted 2026-06-15:
[`docs/rfcs/fit.md`](docs/rfcs/fit.md)). Two milestones, both validated against
Strava's own numbers on real files, both built entirely on pond's public
surface (zero core changes — the geo-RFC thesis held; of a 4.2 ms M1 pipeline,
<0.3 ms touches pond):

- **M1 (geo):** a 123 km / 15,207-pt ride — distance / elevation / splits /
  profile / polyline; +0.2% distance vs Strava, exact elapsed.
- **M2 (power):** a power-meter FIT — NP / FTP zones / mean-maximal curve /
  work / TSS; **exact** zone split + work vs Strava.

**`@pond-ts/fit` LANDED on main 2026-06-28.** The library extracted from estela's
proven copy into its canonical home: **#288** (`a73456a`) the base package
(quantities, canonical activity series, geo/power/zones/profile/summary, Activity/
Section façade; 143 tests), then **#290** (`d2f60a6`) `Profile` + `usingProfile()` →
`ProfiledActivity`/`ProfiledSection` (façade-first slice 1, + an RFC at
`packages/fit/docs/rfc-facade-first.md`), then **#293** (`2d0f815`, **MERGED
2026-06-28**) the release-prep consolidation: quantity `.format()` (slice 2), a `Track`
value object (slice 3), `windowChannels` as a method, and barrel curation (drop the
four blanket `export *` for a single curated flat barrel — demoting the operator
surface to the Activity / Section / Track / Profile façade). The standalone slice PRs
(#289 barrel, #291 slice 2, #292 slice 3) were **closed in favour of #293**.
**Publish-time flag (from the #293 review):** the curation left a few geo analytics
with no public path — neither barrel nor façade — `simplify`, `elevationProfile`,
`profileByDistance`, `rollingSpread` (the last likely superseded by core
`rollingByColumn`); fine while `private` / unpublished, but the export list earns a
deliberate pass at first publish (power analytics stay reachable via `PowerSummary` +
the façade — verified, not affected). **Still sequenced:** (1) the units-preference
home + any remaining façade demotion of the operator surface; (2) **estela's own
adoption is NOT done** —
estela still consumes its local copy and **has not adopted the shipped value-axis
primitives** (`scan` / `byValue`); `geo.segmentsInRange` etc. are still hand-rolled
(`split = scan + byColumn` is the available-but-unadopted path); (3) publish, then
estela swaps to the npm package (adopting **both** `@pond-ts/fit` + `@pond-ts/charts`)
and deletes its local copy. **Docs gap:** the website docs lag the value-series wave
(`scan`/`ValueSeries`/`byValue`) — status currently only legible from the code (see
Documentation backlog).

Docs: [`docs/rfcs/fit.md`](docs/rfcs/fit.md),
[`docs/rfcs/geo.md`](docs/rfcs/geo.md) §10–§13 (use-case feedback + library
ruling), estela's `docs/pond-friction.md`.

**Core-bound carry-forwards.** The gating sequence (NaN-policy → byColumn) has
**shipped**; the remaining items are sequenced behind the next estela milestone:

- **`byColumn` value-axis aggregation** — ✅ **SHIPPED v0.27.0** (#227, docs
  #229). Bucket `aggregate` over any column: monotonic → contiguous ranges
  (splits / profile, `{ width, origin? }`), non-monotonic → histogram (power
  distribution / FTP zones, `{ edges }`). Returns an ordered array of
  `{ start, end, ...aggregates }` bin records (owner decision: value-bins aren't
  time-indexed, so not a `TimeSeries` — `docs/notes/bycolumn-value-axis.md`).
  Was queued behind the NaN-policy (#218, shipped) → rolling-stdev stability
  (#222, shipped); both cleared, then byColumn landed. **Open watch:** the
  design note flagged composition friction (e.g. `rolling` over the bins) as the
  thing to surface on real adoption — estela adopting it is the validation.
- **`rollingByColumn` value-axis windowing** — ✅ **SHIPPED v0.28.0 (#231, estela
  wave 1/3).** The sliding-window sibling of `byColumn`: a centered `±radius`
  window over a non-decreasing numeric column, reduced per row. Addresses the #1
  instance of estela's "window/scan over a derived monotonic axis" digest (4
  votes) — `geo.rollingSpread`, the zoom-stable variance band. The other two
  instances of that digest stay deferred: the extremal-window **sweep**
  (best-efforts / power curve, low urgency) and the stateful **scan** (splits,
  out of scope per estela). Design note: `docs/notes/rolling-by-column.md`.
- **`withColumn`** — ✅ **SHIPPED v0.28.0 (#232, estela wave 2/3).** Attach a
  computed `Float64Array` / `(number | undefined)[]` as a new `number` column
  (schema type widens); the seam that lets a derived array re-enter the pipeline
  as a real column `aggregate` / `byColumn` / `rollingByColumn` / `column(name)`
  can see. Validated attach (re-asserts the numeric intake contract — non-finite
  rejected). Double-signalled with the chart carry-forwards (#107); serves estela
  _and_ the chart feed.
  - **`fromTrustedColumns`** — deferred sibling: the bulk-construction path that
    builds a series straight from columns and **skips** the finite scan (the perf
    escape hatch). Build when a perf-critical consumer earns it; `withColumn`'s
    validated attach covers the estela need today.
- **DX bundle (estela wave 3/3)** — 🚧 **in flight (PR #234, unreleased).** Three
  small, confirmed papercuts in one PR: `byColumn({ edges, inclusive: '(]' })`
  (upper-inclusive zone bins, removes the ε-nudge — F-geo-2 zone inclusivity);
  `'mean'` reducer alias for `'avg'` (F-reducer-naming); `RowForSchema` honoring
  `required: false` so an optional tuple cell accepts `undefined` with no cast
  (the known greenfield F4 / ARCHITECTURE §4 limitation, F-geo-row-optional,
  confirmed ×4).
  - **`F-schema-key-name` (key column must be named `time`) — structural fix
    DEFERRED.** Accepting any name for a `kind:'time'` key widens `FirstColumn`,
    which `SeriesSchema` and key-name assumptions across the codebase depend on —
    structural blast radius, not a cheap-bundle item. Workaround (name the key
    `time`) is trivial; revisit if it recurs. **Action taken:** a clarifying
    JSDoc on `FirstColumn` (the key column's name must equal its kind) so the
    opaque `'"at"' is not assignable to '"time"'` error doesn't cost a debug
    cycle.
- **Data point against opening the kind system:** a packed geo column earned
  nothing on perf at GPS scale (reinforces `geo.md` §7).

### Tidal (financial charts; drives `@pond-ts/financial`; kicking off ~week of 2026-06-29)

A charts use-case experiment — the financial counterpart of estela. Where estela
drives `@pond-ts/fit` and adopts `@pond-ts/charts` for activity data, **Tidal** is a
financial-charts consumer that drives **`@pond-ts/financial`** (the market-analytics
sibling of `@pond-ts/fit`) and adopts `@pond-ts/charts`. A **dedicated Tidal agent**
runs it, the same way the estela agent runs estela (and drove `@pond-ts/fit`).
**It's just a charts use case for now** — earliest stage, pre-RFC, not a committed
library phase; the RFC→PLAN discipline applies (only adopted work becomes a
commitment).

- **`@pond-ts/financial` shape:** a **toolkit of analytics operators** over core
  (volatility, returns, OHLC roll-ups, …), deliberately distinct in API shape from
  `@pond-ts/fit`'s façade — each domain package's surface stands on its own, no
  precedent carried over. Batch first; real-time is a later horizon leaning on the
  same live layer the gRPC + webapp-telemetry tracks stress.
- **Substrate is largely already in place.** The value-axis wave (`scan`, `byValue`
  / `ValueSeries`, `byColumn` / `rollingByColumn`, chart x-on-value) shipped for the
  estela / charts work and hands the financial analytics their non-time-axis
  substrate close to free. The likely _new_ core sibling is an RLE / segmentation
  primitive (`runs` / segment-by-predicate) — the same gap fit hand-rolls — rather
  than net-new value-axis work.
- **Charts gaps it surfaces (candidate roadmap items, driven by adoption):**
  (1) **candlestick / OHLC marks** — ✅ SHIPPED (`<Candlestick>`, PR #357,
  financial-charts RFC Phase 1).
  (2) a **trading-calendar x-axis** that skips weekends / non-trading days (and
  overnight gaps for intraday bars) — a non-wall-clock x adjacent to the value-axis
  machinery, so the very first axis requirement already pushes past a naive
  continuous `TimeAxis`. **Now an RFC + active build wave — see below.**

#### Trading-calendar wave — ADOPTED (RFC `docs/rfcs/trading-calendar.md`)

The disjoint-time-axis RFC (drafted #366, promoted to an RFC #368, red-teamed by
Tidal + a Codex pass #370) was built as a wave. **Phase 1 (the calendar engine —
pure data) and Phase 2 (charts `scaleTradingTime`) are both COMPLETE and PLAN
commitments.** Phase 2 was **built ahead of Tidal's adoption** (a deliberate
get-ahead-of-the-consumer move, user-directed): rather than wait for Tidal to
source real gappy data and drive the friction loop, we validated the axis
against our own real data (daily EODHD + intraday SPY fixtures) so Tidal
inherits a working scale instead of a draft. The design was validated — Tidal
independently built the same `calendar.bars → BoundedSequence` seam.

- **`@pond-ts/financial` BOOTSTRAPPED** — the package now exists (scaffolded off
  `@pond-ts/fit`; peer-deps `pond-ts`; browser+Node, no React). First inhabitant
  is the calendar engine; the indicator corpus
  (`docs/notes/financial-indicators-assessment-2026-07.md`) follows on the same
  substrate. **Not yet published** (new-package OIDC bootstrap is a later step —
  see [[npm new-package publish bootstrap]] in the release notes).
- **Phase 1 build — COMPLETE (PRs #371–#374, unreleased):**
  - ✅ **`DiscontinuityProvider`** (#371) — the d3fc-style 5-method axis primitive
    (`clampUp`/`clampDown`/`distance`/`offset`/`copy`) + `identityDiscontinuity()`
    - the bundled `weekendSkip()` reference provider (UTC weekends, closed-form
      O(1) trading-ms math). Charts will consume this structurally in Phase 2.
  - ✅ **Session model + both construction paths** (#372) — `Session`/`SessionBreak`
    - `normalizeSessions`; `TradingCalendar.fromSessions` (explicit schedule, the
      first-class path — Tidal Ask 1) and `.fromRules` (weekmask/holidays/half-days/
      breaks, DST-correct via Temporal); query surface (`sessionOn`, `isTradingDay`,
      `sessionContaining`, `isOpen`, `sessionsInRange`, `next`/`previousSession`).
      Overnight sessions deferred (explicit-list only for now).
  - ✅ **`sessionSequence`/`barSequence` → `BoundedSequence`** (#373) — the core
    bucketing seam; force-close truncation + break-splitting; flows through
    `aggregate`/`materialize` **with no core edits** (`BoundedSequence` IS
    `SequenceLike`). The RFC's zero-core-edit claim, proven.
  - ✅ **`tagSessions(series)`** (#374) — appends a numeric session-id column
    (session `open` id; `undefined` in closed time), O(n+sessions) merge walk.
    The `partitionBy('session')` stopgap (Tidal Ask 2, pulled to Phase 1) so
    `fill`/`rolling` don't bridge closures — proven in-test (a hold-fill that
    bridges the overnight gap plainly, but not when partitioned by session).
  - **Core asks kept independent + ahead:** G1 count-based `rolling` windows (the
    top indicator-track ask; decouples the K1 family from the calendar).
    `align`/`rolling` are NOT calendar-correct via `BoundedSequence` (they bridge
    session gaps) — that's the `partitionBy(sessionId)` / G1 / span-hook set, not
    the zero-edit seam.
- **Phase 2 build — COMPLETE (PRs #377–#379, #384; unreleased):**
  - ✅ **`TradingCalendar.discontinuities()`** (#377) — the **proportional**
    trading-time provider (sessions minus breaks → `segmentDiscontinuity`,
    O(log n)). The Phase-1-deferred piece: the calendar now _produces_ a provider.
  - ✅ **`scaleTradingTime`** (#378, `@pond-ts/charts`) — a d3-scale-shaped
    discontinuous time scale on a **structural** `DiscontinuityProvider` (charts
    never imports `@pond-ts/financial`; RFC §6.1). Callable/`invert`/`ticks`/
    `tickFormat`/`domain`/`range`/`copy`; interior ticks even in trading time.
  - ✅ **`ChartContainer discontinuities` prop** (#379) — pass
    `calendar.discontinuities()` → trading-time x axis (gaps collapse, proportional
    within sessions). Pan/zoom move in **trading time** (`panRangeTrading`/
    `zoomRangeTrading`, boundary-safe after a Codex pass fixed span-preservation +
    the value-axis gate). Public-API PR — human-approved.
  - ✅ **Feature-axis stories** (#384) — `Charts/TradingTimeAxis` (weekend skip,
    holiday, half-day, intraday, continuous-vs-trading), render-smoke-tested.
  - ✅ **Session-aware axis** (#387–#389) — `DiscontinuityProvider.boundaries()`
    enumerates collapse points; charts draws a **session divider** at each
    (`theme.axis.sessionDivider` token) and labels the axis with a **date at each
    session open** (two-tier `tickFormat`: date at opens, time elsewhere) instead
    of repeated times. The collapsed axis now reads like a trading terminal.
  - ✅ **Follow-up wave — SHIPPED (PRs #391–#394, unreleased):** the four
    "ready to build" follow-ups, each Layer1+Layer2-reviewed. - ✅ **`stamped:'open'|'close'` on `tagSessions`** (#391) — a feed's bar-stamp
    convention: `'close'` bins a bar stamped at the close into its closing
    session (`(open, close]`) instead of dropping it to closed time. Resolves
    the real-fixture 16:00 close-boundary finding. Scoped to binning; point
    queries stay half-open. - ✅ **Uniform-spacing metric** (#392) — `segmentDiscontinuity(segs, { spacing:
'uniform' })` + `TradingCalendar.discontinuities({ spacing, period })`. Each
    session (or period-bar) equal width (Q7's TradingView metric); proportional
    stays default. `discontinuities` now takes an options object. - ✅ **Calendar-grain ticks + aligned dividers** (#393) — `scaleTradingTime`
    coarsens session opens to week/month/quarter/year starts (`coarsenCalendar`);
    `tickFormat` labels dates or the year at year grain. Dividers now draw at the
    axis ticks that are collapse points, so grid + dividers + labels align. Dense
    → coarse rhythm (terminal look); sparse → every collapse marked (unchanged). - ✅ **`calendar` + `spacing` props** (#394, public API, human-approved) — the
    high-level sugar over the low-level `discontinuities` prop:
    `<ChartContainer calendar={cal} spacing="uniform" />`. `calendar` is a
    structural `TradingCalendarLike` (charts still never imports financial);
    `spacing` is Q7's explicit prop, default proportional.
  - ✅ **Interaction stories + annotation-drag fix (PRs #404, #405).** Seven
    `Charts/TradingTimeAxis/Interactions` stories (cursors, annotations-across-gaps,
    snapping, pan/zoom) over a shared `tradingAxis.fixture.ts` (#404). The walk
    verified cursor-snap / region-across-gap / pan-zoom correct **and surfaced the
    deferred annotation-drag-delta bug** — the region body-move applied a shared
    epoch-ms delta to both edges, distorting a box dragged across a collapsed gap.
    #405 fixes it: `moveRegionByPixels` shifts each edge equal **pixels** through the
    scale (rigid pixel translation), an affine no-op on continuous axes; edge-resize
    and marker drags were already correct.
  - ✅ **Charts interaction feature batch (PRs #407–#410, unreleased).** Five
    requests off the zones-chart + trading-axis context, each Layer-2-reviewed:
    - **#407** — made the `CrosshairSnap` story interactive (it pinned
      `trackerPosition`; the snap path was already correct).
    - **#408 `binColors`** — per-bin colour for single-series band bars (the
      zones / value-band look; `colors` is per-group, this is per-bin). The
      horizontal ordinal bar + band axis already shipped, so the zones chart is
      buildable today; the multi-column zone _table_ is consumer HTML.
    - **#409 region cursor** — `cursor="region"` + `cursorSequence` (a pond
      `Sequence` — duration or calendar-aware — or a `BoundedSequence` like a
      calendar's `sessionSequence`) shades the bucket under the pointer, cropped
      to live time through `xScale`.
    - **#410 snap-to-disjoints** — annotation drags snap to session boundaries;
      the collapsed close/open share a pixel, so `snapToGuides` picks the side by
      pointer position (left → close, right → open).
  - ✅ **Width-derived tick count (PR #447, unreleased)** — Tidal 0.44 friction
    report: the trading scale's `ticks(count)` caps **calendar buckets**, so the
    fixed count of 5 coarsened a 1-year daily view to year grain (2 ticks on a
    900px plot). The container now derives the x-side count from plot width on a
    trading axis (~65px/tick → month grain at 900px) and shares one `xTickCount`
    through the frame — `<XAxis>`, x gridlines, session dividers, and
    `formatTime` agree by construction (previously three hardcoded 5s by
    convention, and `formatTime` got _no_ count, anchoring labels at grain 10 vs
    ticks at 5 — the report's date-labelled year ticks). Continuous axes keep
    the fixed 5. **Deliberately no `tickCount` prop** — the failure was the
    default; a knob waits for real friction (the vol-smile `YAxis` tickCount
    itch is the sibling to watch).
  - ✅ **Logical tick ladder + two-tier axis labels
    (`feat/two-tier-axis-ticks`, unreleased)** — a Tidal screenshot (year of
    daily data, continuous axis) showed d3's multi-scale default mixing
    `"Jun 23"` / bare `"Sep"` labels; owner directed a proper ladder instead of
    a format patch. `tickLadder.ts` walks second/minute/hour clock rungs
    (1s…30s, 1m…30m, 1h…12h) →day→week→month→quarter→year, finest grain
    fitting the width-derived cap; clock anchors generate in **live** time (clock-aligned per session, never in a
    collapsed gap / lunch break / early close, no new provider surface).
    Labels are **two rows**: first row at the tick grain (`14:00` / `Feb 02` /
    `Feb` / `2026`), second **boundary row** carrying the omitted coarser unit
    (`Jan 05` under clock ticks, `2026` under day/week/month ticks — never a
    unit the first row already shows; owner flagged `Jan 2026` under a
    `Jan 05` tick as redundant, 2026-07-14) under
    the first tick of each period + the first tick shown (owner-confirmed
    anchoring). **Plain continuous time axes now run the same ladder** through
    an internal gap-free `identityProvider()` (calendar days as sessions) —
    one algorithm, both axis kinds; the frame's `discontinuities` stays
    undefined so pan/zoom keep continuous math. `TradingTimeScale.tickBoundaries(count)`
    is the new scale surface; `coarsenCalendar` moved to `tickLadder.ts`
    ('session' grain renamed 'day'). A cramped leading partial-period anchor
    (< half a period from the next tick, in live time) is dropped — the
    screenshot's `"Jun 23Jul 07"` pile-up. Design rules: an hour rung must add
    intraday anchors beyond the opens (else it's day grain); boundary row is
    where coarser context lives, so month boundaries format `%b %Y`.
    Systematic story matrix `Charts/TimeAxisTicks` (one story per rung,
    trading + continuous, narrow variants). **Boundary context pinned to the
    left edge (2026-07-14, owner-directed after the live-window walk):** the
    original owner-confirmed first-tick anchoring made the context label hop
    tick-to-tick on a live sliding window, so it now pins at x=0 showing the
    _domain start's_ period, with crossing labels pushing it off as they
    approach (sticky-header behavior; no knob — first-tick anchoring is
    strictly worse live and near-identical static). Crossing detection seeds
    from the domain start's bucket so a first tick past a period turn still
    flags, even when the cramped-lead drop removed its predecessor.
  - ✅ **Dual x-axes — two tick layouts on one shared scale
    (`feat/dual-x-axes`, unreleased).** Owner-directed (Tidal / legacy
    ChartTool parity, reference screenshots 2026-07-14): a second `<XAxis>`
    stacks by declaration order (proven + pinned — was supported by
    construction but never exercised), and the new `transform` prop
    (`{ to, from }` monotonic inverses, may be **nonlinear**) relabels an
    axis into a derived unit: strike↔moneyness top axis, BS-delta strip
    under a σ chart. Tick selection = pixel-aware multi-resolution fill
    (`derivedTicks.ts`): 1-2-5 steps coarsest→finest, admitted where ≥48px
    of room remains — a compressed span gets coarse ticks, a stretched span
    finer ones (delta wings pick up 0.45/0.48 while the middle stays at
    0.10). Design rules: **label honesty** (a tick whose formatted label
    parses back to a different pixel is dropped — the fill may descend past
    the format's resolution, and "+0.50" at u=0.498 is a lie), an empty
    ladder level does NOT stop the walk (nonlinear gaps have tiny u-spans;
    three consecutive empty levels do), gridlines stay on the primary axis,
    one domain so pan/zoom moves both layouts for free. Resolves the
    vol-smile relabelled-axis friction item.
  - ✅ **Pan/zoom + grid polish (2026-07-16, owner-driven live walk of the
    DateStylePanZoom story; uncommitted on `worktree-flat-time-axis`).** Three
    fixes, each verified live in Storybook:
    1. **Zoom drift with weekends hidden** — the story's demo `weekendSkip`
       provider broke the `offset`-inverts-`distance` contract across DST
       (`liveMs` anchored to local midnights, `offset` mapped back with raw
       `START + di·DAY` = 01:00 local in summer): +1h per offset round-trip →
       ~1.6h window drift per wheel tick in Apr–Oct regions. Fixed by
       constructing the local midnight through the calendar. Library providers
       were never affected (they derive both directions from shared helpers) —
       the provider contract is what the viewport math leans on.
    2. **Session-line fade curve** — the `'all'`-divider linear fade
       (`alpha = gap/6`) mathematically cannot clear: perceived wash =
       `alpha/gap` = constant, so zooming out pinned a permanent gray veil
       (plus alpha-stacking on shared pixel columns). Now a two-anchor
       quadratic ramp (full ≥ 28px, gone ≤ 6px) whose wash → 0; regression
       test pins "total ink strictly falls and reaches exactly 0".
    3. **Hierarchical fading calendar grid** (owner-directed design): vertical
       gridlines are now the **full grain populations** — every day / month /
       aligned clock instant in view — not the label algorithm's thinned picks
       ("the labels decorate the grid, they don't define it"). Each grain
       fades **as a unit by its calendar density** — nominal gap-free spacing
       `width × grainStep / wallSpan`, NOT the measured on-screen gaps — on
       the same wash-aware quadratic ramp (full ≥ 15px ≈ day lines at a
       ~1.5-month window, gone ≤ 5px). Zoom-out dissolves fine grain into
       coarse with no pop at label-rung switches, and the look is
       **mode-invariant**: collapsing weekends draws fewer day lines at the
       same strength (owner's same-zoom, different-weight screenshots —
       measured-gap fading had jumped the surviving lines to full). New scale
       surface `TradingTimeScale.gridLevels(minGapPx)` (nested populations +
       nominal spacing, memoized, enumeration capped at width/gone so
       over-dense grains are never built); levels nest (no week rung),
       consumers dedupe coarsest-first.
    4. **`sessionDividers` default `'labeled'` → `'none'`** (owner report:
       with weekends hidden, labeled-tick dividers rendered as quasi-grid
       even with `grid={false}`, "layer on top and confuse things"). The
       hierarchical grid now owns calendar structure at every zoom; dividers
       are opt-in emphasis (`'all'` = TradingView separators; `'labeled'` =
       only under labelled collapse points). The label stride is a rendering
       choice, not calendar structure — solid lines shouldn't ride it by
       default.
    5. **Dividers mark collapse _seams_, not the session roster** (owner:
       "why are session lines on each day when we're removing the
       weekends?"). `boundaries()` is overloaded by design — the tick ladder
       and grid consume every session open as a date anchor (the identity
       provider even reports every midnight), while a divider means _time was
       removed here_. The two coincide on real exchange calendars (every
       open follows an overnight gap) but diverge on contiguous-session
       calendars (the story's 24h weekday demo). The draw path now keeps
       only true seams — `distance(b−1, b) ≈ 0` — so the demo seams only at
       Monday opens; real calendars are unchanged. Contract docs updated on
       both `DiscontinuityProvider.boundaries` declarations (charts +
       financial) to name the roster/seam dual role.
    6. **The window edge is never ticked unless genuine** (owner: "remove
       the sticky one at the end on flat mode… sort of misleading"). The
       ladder injected `opens[0]` (the raw domain start) as an anchor, so a
       mid-period edge became a tick pinned at x=0 relabelling itself as the
       window panned (a half-spaced `8`, a `15:23` under an hour grain); the
       old cramped-lead heuristic only dropped it when crowded. Now the lead
       tick survives only when **live** and either a true session open
       (dead-before/live-after probe — includes the calendar's absolute
       start) or **exactly on a grain instant** (`alignedToGrain`: midnight /
       month start / clock multiple) — the alignment arm is how a gap-free
       continuous axis, with no dead time to probe, keeps a window cut
       exactly on a boundary (a Jan-1 year fixture keeps its `2026`).
       TradingView-matching: the first real calendar anchor leads. Story
       controls also reworked (Grid / Sessions / Session markers switches
       below the chart, `labels center|left` control on the `align` prop).
  - ✅ **Stacked date style → segmented band row (`feat/stacked-band-axis`,
    2026-07-16, owner design from reference frames).** Redesigned
    `dateStyle="stacked"` from the ride-a-tick boundary row + pinned context
    into a **segmented band row**: a terse top row (the grain's bare unit) over
    zebra-shaded bands of the **next-coarser** period — day bands under
    intraday ticks, **month** bands under day ticks (one step finer than the
    old day→year boundary jump), year bands under month/quarter ticks. Each
    band left-aligns its label, draws a divider at its turn, and the partial
    left band pins its label at x=0 (replacing `boundaryContext`). **Zebra by
    absolute calendar parity** (year %2, months-since-epoch %2, UTC-day %2 —
    pan/zoom-stable, DST-immune), not a live/current-cell rule (owner
    correction: "it does zebra"). The top-row **turn tick** is bold + takes the
    divider colour so tick + rule + divider read as one boundary line — matched
    by **pixel**, not instant, so on a trading axis the session-open tick at the
    collapsed-midnight seam is the one emphasized. New scale surface
    `TradingTimeScale.bands(count)` + `baseFormat(count)`; new `bandGrainFor` /
    `bandShaded` / `bandStartOf` / `bandNext` ladder helpers; new
    `theme.axis.band` tokens (`fill` / `divider` / `label` — the shade is a
    themeable background, "could be a background color for some people"). **Flat
    (the shipped default) also picks up the boundary emphasis** (owner: "style
    the band boundary in the non-layered case too, so it matches"): a tick
    whose label was promoted to a coarser period (`Feb`, `2026`) now renders
    **bold**, so a period boundary reads the same in flat and stacked — a
    default-path behaviour shift, pinned by a test. The old
    `tickBoundaries` / `boundaryContext` scale methods stay for external
    consumers but the axis no longer renders them.
  - ✅ **Grain-aware cursor readout + `cursorFormat` channel
    (`fix/cursor-readout-grain`, 2026-07-17, Tidal F-charts-7 escalation via
    PR #484).** 0.47.0's flat default regressed the crosshair x-pill to a bare
    time-of-day (`02 AM`) on daily bars: the readout fell to d3's multi-scale
    default, and the only prior fix — a day-floor `timeFormat` — disqualifies
    the `dateStyle` ladder by design ("a custom format owns the labels"). One
    knob, two concerns. Fix, per the owner's steer (grain-aware default **+**
    independent per-channel control, RTC-style): (1) **default** cursor /
    marker / annotation readout now formats at the axis **grain**
    (`TradingTimeScale.readoutFormat` / `readoutFormatFor`) — day-or-coarser →
    a date, sub-day → date + clock, never a foreign-tz time-of-day; (2) a new
    **`cursorFormat`** container prop shapes _only_ the readout, independent of
    the label `timeFormat` / `format`, and does **not** set `xFormatCustom`, so
    a consumer keeps flat/stacked **and** shapes the pill. Tick labels
    unchanged. **Callback shape (owner-decided pre-merge, "do I know the
    grain?"):** the function form is `(epochMs, { grain, defaultText }) =>
string` — the library hands over the resolved coarse **`TimeGrain`**
    (`year`…`second`, strides collapsed via `coarseUnitOf`; new
    `TradingTimeScale.grain(count)`) and the grain-aware default text, so a
    consumer branches on zoom and passes the default through rather than
    re-deriving the ladder from the range. New public types `CursorFormat` /
    `TimeGrain`. **Timezone control is the deferred follow-on** the owner
    flagged — the grain-aware default sidesteps the common daily-bar case, but
    true exchange-/display-tz handling (cf. the deferred exchange-tz tick
    grain) is its own conversation, not attempted here.
  - **Still deferred (documented, none blocking):** `neighbourSpans` point-key slot
    widths on the discontinuous axis (interval-keyed bars from
    `aggregate(barSequence)` — the primary path — are immune); exact **exchange-tz**
    tick grain (the current grain buckets by runtime-local calendar). Validated
    against real data: daily EODHD (#375) + intraday SPY fixtures (#376), incl. a
    half-day, holidays, overnight gaps, and a dirty (duplicated) session.
  - ✅ **RELEASED v0.42.0 (2026-07-10).** All five packages on npm together. The
    new-package bootstrap: `@pond-ts/financial` was manually token-published at
    `0.41.0` to claim the name + OIDC trusted publisher (per
    [[npm new-package publish bootstrap]]), then the `v0.42.0` tag OIDC-published all
    five (financial's first OIDC release). The charts publish auto-wakes the Tidal
    adoption agent via the CHANGELOG.
- **Indicator / studies track — the `@pond-ts/financial` analytics layer.**
  Grounded in the corpus assessment
  (`docs/notes/financial-indicators-assessment-2026-07.md`): 124 ChartIQ studies
  reduce to ~11 kernels, ~80% expressible on core primitives today. Kicked off by
  the study-primitives report (issue #449, triaged 2026-07-13). **Dispositions
  (owner-acked):**
  - **Item 1 (static trailing-window transform)** — the reducer set (`avg`/`stdev`/
    `min`/`max`/`median`/`p{q}`) ships today on `rolling(duration, …)`; the real
    gap is a **count-based (N-bar) window** (G1) — the only correct window across
    session gaps. **→ built (see below).**
  - **Item 2 (EWMA)** — `smooth('ema', { alpha })` ships; gap is the `span`
    parameterization (α = 2/(span+1)). **→ PLAN** (public option-type change,
    human-approval gate).
  - **Item 3 (warmup/alignment convention)** — `rolling` `minSamples` keeps length
    (emits `undefined`), ema `warmup` slices length. **→ PLAN**: document one
    length-preserving convention; reconcile ema toward it. Too small for an RFC.
  - **Decision (owner):** land **G1 in core first** (gap-correct from the first
    studies release), then the **#449 first-batch studies** (SMA, EMA-span,
    Bollinger®, MA-envelope, z-score, rolling stdev/min/max/percentile,
    percent-change) in `@pond-ts/financial` — package shape per assessment §7
    (`kernels/`/`studies/`/`contract/`, `column`/`output` on every fn, shared
    `maType`, bar-count `period` in the public API from day 1).
  - ✅ **G1 count-based rolling window — BUILT (unreleased).** `TimeSeries.rolling`
    now takes `{ count: N }` in place of a duration: reduces the last/next/centered
    `N` **rows** by position, so an N-bar window is correct across session gaps
    (where `N` bars ≠ `N × barSize` of time). Honours `alignment` + `minSamples`
    (`minSamples: N` = the conventional first-`N-1`-`undefined` warmup); per-row
    only (throws with a sequence). Same amortized-O(1)-per-row sweep as the duration
    path (perf: linear, ~16ms/100k rows, tracks the duration numbers). Adds an
    overload to `TimeSeries` → human-approval gate before merge. 10 tests +
    `perf-rolling.mjs` count scenario.
  - ✅ **`span` + `minSamples` on `smooth('ema')` — BUILT (unreleased).** ema now
    takes the financial `span` rate (`α = 2/(span+1)`) as an alternative to
    `alpha`, and a **length-preserving** `minSamples` warm-up (emit `undefined`
    for the first `N` present values, keep the row count) — mirroring `rolling`'s
    `minSamples`, so **one** warm-up convention holds across primitives. The
    existing length-changing `warmup` is untouched (documented as the drop-the-
    head counterpart) — item 3 reconciled additively, no breaking change. Adds
    options on `smooth` → human-approval gate. 8 tests.
  - ✅ **First studies — BUILT (unreleased):** `@pond-ts/financial` now ships
    `sma` / `ema` / `bollinger` on the assessment §7 package shape — `contract/`
    (`OhlcvColumns` + `DEFAULT_OHLCV`), `kernels/` (`rollingValues` count-window
    read-and-append + `assertPeriod`/`assertNoColumn`), `studies/` (one file per
    study, `column`/`output` on every fn, bar-count `period`, length-preserving
    warm-up). SMA/Bollinger compose on core's `rolling({ count })`; EMA on
    `smooth('ema', { span, minSamples })`. Core `AppendColumn` exported so study
    returns name their appended column (typed composition — a study over another
    study's output). 8 tests. Adds `@pond-ts/financial` public API + a core type
    export → human-approval gate.
  - ✅ **Pandas oracle — cross-validation harness (unreleased):** every study is
    checked bar-for-bar against a **pandas** reference (`scripts/oracle/generate.py`
    → committed golden `test/fixtures/study-oracle.json` → `study-oracle.test.ts`).
    CI needs no Python (JSON is committed; regenerate via a venv on definition
    change). Conventions pinned to match (ema `adjust=False`; Bollinger σ `ddof=0`
    = population, TA-Lib's). **Phase-2 named indicators (RSI/MACD/ATR) add TA-Lib**
    to the same harness, documenting deltas (vendor bar-parity is a non-goal).
    This is the "fully trust the numbers" gate for the whole studies track.
  - ✅ **Fan-out — #449 first batch COMPLETE (unreleased):** `rollingStdev` /
    `rollingMin` / `rollingMax` / `rollingPercentile`, `zScore`, `envelope`
    (MA ± percent, `maType` sma/ema), `percentChange` (n-bar) — all on the shipped
    `rollingColumns`/`columnValues`/`emaValues` kernel, each with a fluent method
    and a pandas-oracle case (13 oracle cases now). The whole first batch (SMA,
    EMA, Bollinger + these) is built, fluent, and pandas-verified.
  - **Next:** assessment §7.4 **Phase-1 breadth** — RSI, MACD, ATR(+bands),
    stochastics, %R, Donchian, OBV, VWAP, Historical Volatility, momentum/ROC.
    These add **TA-Lib** alongside pandas in the oracle (named-indicator
    convention deltas documented). The core substrate (G1 count windows +
    span/minSamples EMA + the reducer set) is complete; a few need the K6
    stateful-fold shim (PSAR/SuperTrend etc., Phase 3).
- **Cross-repo coordination — the constellation bridge (live since 2026-07-03).**
  Handoffs between this repo and Tidal are automated; Peter no longer hand-relays
  them. **Inbound:** a Tidal→pond PR with `Tidal` in the title wakes a headless,
  budget-capped pond-agent session (disposable worktree of `~/Code/pond`) to triage
  it per the normal process — read, respond on the PR, merge acceptable notes, fold
  into PLAN, implement or queue. **Outbound (release signal):** an `@pond-ts/charts`
  npm publish auto-wakes a Tidal agent that reads the CHANGELOG and PRs the adoption
  — so keep CHANGELOG entries wave-shaped, they're a machine-read payload now.
  **Outbound (everything else — asks, canaries, RFC feedback, deprecations):** file
  a GitHub issue on `tidal-app/tidal` titled `[pond] <ask>`. Neither watcher touches
  a live checkout; both sides' normal review processes still apply. Full contract:
  [docs/notes/constellation-bridge.md](docs/notes/constellation-bridge.md) (pond#327).
  **Outbound (RFC feedback via Discussions — pond#332):** open a GitHub Discussion
  per RFC (title `RFC: <name>`, body linking `docs/rfcs/*.md`) and mention `tidal`
  in the title/body to summon a one-shot consumer-perspective comment from a Tidal
  agent (grounded in the terminal's code); generalizes to `consumers: tidal, estela`
  as more consumers get watchers. Fire-once per discussion; a fresh discussion or a
  `[pond]` issue drives a second round. Discussions is enabled on the repo, so this
  works today. **Queued (not auto-fired):** open discussions for the living-examples
  RFC (#285) and the range-editing RFC (#261) — Tidal has real consumer positions on
  both. Left as a deliberate act rather than fired inside an autonomous triage run,
  since summoning a consumer spends budget on the other side of the bridge.

---

## Completed work

### Phase 0: Core performance (done)

All five critical O(N^2) hot paths have been optimized:

| Method                     | Was             | Now                   | Speedup (largest test)  |
| -------------------------- | --------------- | --------------------- | ----------------------- |
| `aggregate()`              | O(N x B)        | O(N + B)              | **172x** at 16k events  |
| `rolling()` (event-driven) | O(N^2)          | O(N) sliding window   | **182x** at 4k events   |
| `smooth('movingAverage')`  | O(N^2)          | O(N) sliding deque    | **15x** at 4k events    |
| `smooth('loess')`          | O(N^2 log N)    | precomputed neighbors | **7.5x** at 1.6k events |
| `includesKey()`            | O(N)            | O(log N) bisect       | **819x** at 8k events   |
| `#alignLinearAt()`         | O(N) + O(log N) | forward cursor        | **134x** at 4k events   |

Landed in commits `05a7af3` and `60b2f07`. Each change has dedicated regression
tests and a benchmark script.

Internal pre-validated constructor path now skips the
`events -> toRows() -> validateAndNormalize() -> events` round-trip for
order-preserving derived transforms (`filter`, `select`, `rename`, `collapse`,
`map`, etc.). Landed in commit `2ef6265`. A chained `filter -> select -> rename
-> collapse -> map` derivation is **2.5x** faster at 8k events.

### Phase 1 progress: Batch hardening (in progress)

- [x] `toJSON()` round-trips with `fromJSON(...)`
- [x] `toRows()` and `toObjects()` explicit normalized export helpers
- [x] both array-row and object-row JSON shapes supported
- [x] docs cover both ingest and export
- [x] custom aggregate reducers and named aggregate outputs
- [x] edge-case tests for empty series, single-event series, empty aggregation
      buckets, rolling alignment edge cases, and half-open interval semantics
- [x] test and document custom reducers for `rolling()` (type plumbing already
      accepted `CustomAggregateReducer`; added edge-case tests and docs)

### Source-layout migration (shipped — kebab-case layer folders, schema split)

`packages/core/src/` was a flat 26-file root mixing public classes,
helpers, types, and `Live*` operators. The migration moved every
non-barrel module into a layer folder under a single naming rule.

**Shipped via PRs #137, #138, #140, #141, #142, #143, #144, #145.**

Final layout:

```
packages/core/src/
├── index.ts              # public package barrel (only file at root)
├── batch/                # TimeSeries, PartitionedTimeSeries, validate, json, aggregate-columns
├── core/                 # event, interval, time, time-range, temporal, calendar, duration, errors
├── columnar/             # internal storage substrate (unchanged)
├── live/                 # LiveSeries + every Live*, series-store, live-history, triggers
├── reducers/             # reducer registry (unchanged)
├── schema/               # type vocabulary split by concern (10 files; was types.ts + types-*.ts)
└── sequence/             # Sequence, BoundedSequence, sample
```

Naming rule: every file is kebab-case; class names stay PascalCase
inside the file. No mixed convention, no judgment calls about
"public concept vs internal helper." Documented in ARCHITECTURE.md
under "Source layout conventions."

`schema/` decomposes the former 1022-line, 82-export `types.ts` into
10 focused files (`series.ts`, `events.ts`, `json.ts`,
`aggregate.ts`, `reduce.ts`, `rolling.ts`, `reshape.ts`, `diff.ts`,
`join.ts`, `public.ts`) plus an internal `schema/index.ts` barrel.
The `pond-ts/types` subpath still resolves; `package.json#exports`
was updated to point at `dist/schema/public.{d.ts,js}`.

**No compatibility shims left at the root.** Each layer-move PR
rewired every import site rather than leaving 1-line re-exports
behind. Per-PR diffs were larger, but the end state needs no v1.0
cleanup pass for shim removal.

**What's still aspirational** (not shipped here):

- Operator extraction from `batch/time-series.ts` (~4850 lines).
  **Underway as of the Step-4 transform wave** — `batch/operators/`
  now exists with `cumulative.ts` as the first extracted operator
  (PR #190); `select` / `rename` reshape the store column-native but
  inline (not yet pulled into `operators/`). The "thin API shell +
  `batch/operators/*.ts`" goal in ARCHITECTURE.md is now in motion,
  one operator per PR. Not yet started for `live/live-series.ts`
  (1185 lines) and `live/live-partitioned-series.ts` (1448 lines).
- `io/` layer (row/object/json/point converters) is reserved in
  ARCHITECTURE.md but not yet created — comes into existence when
  operator extraction surfaces the relevant code paths.

**Why this was worth doing now.** Phase 4.7 (columnar core
substrate) and the eventual operator extraction both touch every
public-class file. Doing them on the old flat layout meant
arbitrating PascalCase/kebab-case naming and "public concept vs
internal helper" judgment per PR; doing them on a clean layered
tree means the storage rewrite and operator splits land as
mechanical moves into known homes.

**Public API unchanged.** Every `import { ... } from 'pond-ts'`
and `import type ... from 'pond-ts/types'` resolves to the same
identifiers it did before #137. 1670/1670 tests pass on every
migration PR.

---

## Phase 1: Batch hardening (in progress)

Goal: make the existing batch surface trustworthy enough to extend.

Remaining scope: none — all items complete. Phase 1 is ready for the decision
gate: is the batch layer complete and trustworthy enough to be the foundation?

Definition of done:

- [x] custom reducer typing and runtime behavior are documented and covered
- [x] edge-case coverage exists for every current analytical primitive

### Remaining performance items (lower priority, address incrementally)

From the original audit, not yet addressed:

- `Time`/`Interval` temporal comparisons still allocate a throwaway `TimeRange`
  per call
- `Event` constructor still does `Object.freeze({ ...data })` +
  `Object.freeze(this)` — measurable overhead at scale
- `rows` getter still materializes N frozen arrays on every access — should
  cache lazily or become a method
- `aggregateValues` still filters the values array twice — one pass suffices
- `compareEventKeys` still uses `localeCompare` for tiebreaking on fixed
  strings — plain `<` is ~10x faster
- `joinMany` still does repeated pairwise joins — an N-way sorted merge would
  be one pass
- `parseDurationInput` is duplicated in `TimeSeries.ts` and `Sequence.ts`

### Known type-level limitation: `TimeSeries<S>` variance

Both Codex and Claude agents flagged in the CSV-cleaner experiment that:

- `toJSON()` returns `TimeSeriesJsonInput<SeriesSchema>` (loose) rather than
  `TimeSeriesJsonInput<S>`, so a typed `TimeSeries<Schema>` round-tripped
  through `toJSON` loses its specific schema. Callers cast back at the
  call site (`as TimeSeriesJsonInput<MySchema>`).
- `RowForSchema` doesn't honor `required: false`, so
  `new TimeSeries({ rows: [[ts, undefined, ...]] })` rejects undefined
  cells even when the schema allows them. Workaround: go through
  `fromJSON({ rows: [[ts, null, ...]] })` instead, which already widens
  cells via `JsonRowForSchema`.

Both fixes are real and correct in isolation, but trying to land them
hits a class-wide variance issue: many `TimeSeries` methods have
overloads that return `TimeSeries<NarrowSchema>` while the impl returns
`TimeSeries<SeriesSchema>`. Tightening `toJSON`'s return to use `<S>`
makes `TimeSeries<NarrowSchema>` no longer assignable to
`TimeSeries<SeriesSchema>` (the variance now propagates through every
method that references S in a return position), which breaks the
overload-impl compatibility check on `pivotByGroup`, `rolling`,
`arrayAggregate`, and `arrayExplode`.

Fixing this properly requires a class-wide variance refactor — either
restructure each invariant overload to use a separate type-level helper
that doesn't tie back to the class generic, or split `TimeSeries<S>`
into a covariant read-side and an invariant write-side. Both are
non-trivial. Queued as future work; the workarounds above are honest
documentation in the meantime.

---

## Phase 2: Batch expansion

Status: complete.

Goal: fill the most obvious product gaps in the batch analytics story.

Completed:

- [x] `reduce` — collapse a series to a scalar or record (whole-series aggregation)
- [x] `groupBy` — partition by column value, optional transform callback
- [x] `diff` / `rate` — per-event differences and per-second rates of change
- [x] `fill` — per-column gap-filling strategies (hold, linear, zero, literal)
- [x] `pivotByGroup` — long-to-wide reshape on a categorical column; the missing
      inverse of `groupBy` for cases where you want one wide series instead of N
      separate ones (added late, after dashboard-agent feedback)
- [x] `TimeSeries.concat([s1, s2, ...])` — fan-in primitive that closes the
      `groupBy(col, fn)` round-trip without forcing callers out of the typed
      contract. Concatenate same-schema series, re-sort by key, return one
      wider series. Shipped in v0.8.2 after the CSV-cleaner agent run flagged
      the missing third leg of the fan-out / column-merge / row-append triangle.
      Initially named `merge` (matching pondjs lineage); renamed to `concat`
      pre-release after the adversarial review flagged the verb-overlap with
      `Event.merge(patch)` and the cleaner alignment with `Array.prototype.concat`,
      `pandas.concat(axis=0)`, and SQL `UNION ALL`.
- [x] `TimeSeries.fromEvents(events, { schema, name })` — companion to `merge`
      for the rare case where you have a flat events array (not a list of
      series) to assemble. Sorts by key. Shipped in v0.8.2.
- [x] `TimeRange.toJSON()` and `.toString()` — `{ start, end }` ms shape that
      round-trips through `new TimeRange(...)` and JSON wire formats; ISO
      `start/end` for debug. Shipped in v0.8.2.
- [x] `series.partitionBy(col)` and `PartitionedTimeSeries<S>` — chainable
      view that scopes stateful transforms to within each partition, fixing
      the cross-entity correctness hazard surfaced by all three CSV-cleaner
      agents. Sugar for `fill` / `align` / `rolling` / `smooth` / `baseline` /
      `outliers` / `diff` / `rate` / `pctChange` / `cumulative` / `shift` /
      `aggregate` plus `apply(fn)` escape hatch. Sugar methods return another
      `PartitionedTimeSeries` (persistent across chains, e.g.
      `ts.partitionBy('host').dedupe(...).fill(...).collect()`); `.collect()`
      materializes back to a regular `TimeSeries`. Shipped in v0.9.0 (PR 1
      of the wave).

Scope: none — all items complete.

Dropped:

- `fillNull` — `fill()` covers all use cases; a separate method doesn't earn its
  API surface

- `resample` — everything it would do is already covered by `aggregate()`
  (downsample) and `align()` (upsample); adding it as pure sugar doesn't earn
  its API surface

Nice-to-have in the same wave:

- per-column alignment policies

Hold for later unless a concrete user need appears:

- `unpivot` — wide-to-long; sketched on the
  [Reshaping](website/docs/pond-ts/transforms/reshape.mdx#unpivot)
  page with a manual workaround. Promote to shipped if a real case
  appears.

### Design notes

**`groupBy`**: returns `Map<string, TimeSeries<S>>` keyed by group values,
preserving full typing on inner series. Optional transform callback avoids
materializing intermediate maps:

```ts
const perHost = series.groupBy('host');
const perHostRolling = series.groupBy('host', (group) =>
  group.rolling('5m', { cpu: 'avg' }),
);
```

**`reduce`**: collapses an entire series to a scalar or record, using the same
reducer specs as `aggregate` but without a time-bucketing sequence. Where
`aggregate` always produces a new `TimeSeries`, `reduce` produces a plain value.
Supports both built-in and custom reducers, same as `aggregate`:

```ts
// single column
const avg = series.reduce('cpu', 'avg'); // => number

// multi-column
const summary = series.reduce({
  cpu: 'avg',
  requests: 'p95',
});
// => { cpu: number, requests: number }

// custom reducer
const weighted = series.reduce(
  'cpu',
  (values) => values.reduce((a, b) => a + b, 0) / values.length,
);

// per-group reduction
const perHost = series.groupBy('host', (g) =>
  g.reduce({ cpu: 'avg', requests: 'p95' }),
);
// => Map<string, { cpu: number, requests: number }>
```

**`diff` / `rate`**: operate on one or more named numeric columns. Non-specified
columns pass through unchanged. First event gets `undefined` in affected columns
by default; `{ drop: true }` removes it instead. `rate` divides by time gap in
seconds. Options object is always the last argument, after column names.

```ts
// single column
const deltas = series.diff('requests');
const perSec = series.rate('requests');

// multi-column
const deltas = series.diff('requests', 'cpu');
const perSec = series.rate('requests', 'cpu');

// drop first event instead of undefined
const deltas = series.diff('requests', { drop: true });
```

**`fill`**: replaces `undefined` values using per-column strategies. Strategies
and options are separate arguments. Strategy names: `hold` (forward fill),
`linear` (time-interpolated), `zero`. Non-string values in the mapping are
literal fill values. `limit` caps consecutive fills per column.

```ts
// single strategy for all columns
series.fill('hold');
series.fill('hold', { limit: 3 });

// per-column strategies
series.fill({ cpu: 'linear', host: 'hold' });

// literal fill values
series.fill({ cpu: 0, host: 'unknown' });
```

`linear` requires known values on both sides of a gap; leading and trailing
undefined runs are left unfilled.

**`pivotByGroup`**: reshapes long-form data into wide rows. Each distinct
value of a categorical column becomes its own column in the output schema,
named `${group}_${value}`, holding the value column at that timestamp.
Rows sharing a timestamp collapse into one output row; missing
`(timestamp, group)` cells are `undefined`. Output schema is dynamic
(column names depend on runtime data), so the return type is
`TimeSeries<SeriesSchema>` (loosely typed) — callers bridging to charts
read columns by name out of `toPoints()` rows.

```ts
// Long: { ts, cpu, host } per row
// Wide: { ts, "api-1_cpu", "api-2_cpu", ... } per row
const wide = long.pivotByGroup('host', 'cpu');
wide.toPoints(); // ready for Recharts <Line dataKey="api-1_cpu" /> etc.
```

Duplicate `(timestamp, group)` pairs throw by default; opt-in with
`{ aggregate: 'avg' | 'sum' | 'first' | 'last' | ... }` to combine
(reuses the `aggregate()` reducer registry, including custom functions
and `pN` / `topN` parsed names). Requires a time-keyed input.

The single-value-column form covers the dashboard case ("one metric,
multiple producers"). A typed-output overload ships in v0.8.1:
`pivotByGroup(group, value, { groups: [...] as const })` propagates the
declared group set to the output schema as literal column names, so
downstream `baseline` / `rolling` / `toPoints` calls narrow without
`as never` casts. The declared form also preserves declaration order
(not alphabetical) and emits columns for declared-but-empty groups so
the schema is stable across runs. The untyped form remains as the
open-set discovery path returning `TimeSeries<SeriesSchema>`. Both
live behind one method via overload.

Rejected follow-ups (from v0.8.0 dashboard-agent feedback):

- **Multi-value-column pivot** — `pivotByGroup('host', ['cpu', 'memory'])`.
  Cross-host-cross-metric layouts hit this, but the workaround
  (two pivots + `join`) is one extra line and stays inside the typed
  contract. Not earning the API surface.
- **`baselineMany` / multi-column `baseline`** — replacing the
  chained `wide = wide.baseline(...)` reassignment with a single
  multi-column call. Cosmetic — the chain is idiomatic immutable-API
  code and reads fine in practice.

Both rejections will be revisited only if a second concrete case
lands.

**Per-column alignment**: extend `align()` to accept a per-column map. Default
(`'hold'`) applies to any column not in the map:

```ts
const aligned = series.align(Sequence.every('1m'), {
  method: { cpu: 'linear', host: 'hold' },
});
```

Definition of done:

- each method has both API docs and worked examples
- type flow is preserved through all new methods
- batch examples cover realistic host/service metrics workflows

---

## Phase 2.5: Columnar primitives

Status: complete.

Goal: fill the remaining analytical gaps that pandas users expect, without
exposing a general "access neighboring events" API. Each operation is a named
columnar primitive that the library implements internally by walking the event
array — the user describes what they want, not how to iterate.

Completed:

- [x] `pctChange` — percentage change relative to previous value
- [x] `cumulative` — running accumulation (sum, max, min, count, custom)
- [x] `shift` — lag/lead column values by N events
- [x] `bfill` strategy for `fill()` — backward fill (propagate next known value backward)
- [x] built-in aggregator parity with original pondjs: `median`, `stdev`,
      `percentile` (`p50`, `p95`, `p99`, etc.), `difference`, `keep`

### Design notes

**`pctChange`**: same shape as `diff`/`rate`. Computes `(curr - prev) / prev`
for named numeric columns. First event gets `undefined` (no previous value).
Purely value-relative — time gap doesn't matter.

```ts
const pct = series.pctChange('requests');
const pct = series.pctChange(['cpu', 'mem']);
const pct = series.pctChange('requests', { drop: true });
```

For period-over-period comparison (today vs yesterday, current vs one hour ago),
the idiomatic approach is `shiftKeys` + `join` rather than a single-series
`pctChange` — that's a separate composition pattern, not a primitive.

**`cumulative`**: takes a mapping of column names to accumulation functions.
Returns a series of the same length with running values. Supported built-ins:
`sum`, `max`, `min`, `count`. Custom accumulators via function.

```ts
const running = series.cumulative({ requests: 'sum' });
const peaks = series.cumulative({ cpu: 'max' });
const mixed = series.cumulative({
  requests: 'sum',
  cpu: 'max',
  errors: 'min',
});
```

Non-accumulated columns pass through unchanged. Unlike `rolling` (fixed window),
`cumulative` grows from the first event — every event sees all prior values.

**`shift`**: moves column values forward (lag) or backward (lead) by N events.
Vacated positions get `undefined`. Useful for "compare to N ticks ago" on
regular-grid data, or as a building block for custom derived metrics.

```ts
const lagged = series.shift('value', 1); // lag by 1
const lead = series.shift('value', -1); // lead by 1
const lagged = series.shift(['cpu', 'mem'], 2);
```

For time-based shifting (e.g. "value 1 hour ago" on irregular data), the
pattern is to `align` to a regular grid first, then `shift` by the
corresponding number of events. A dedicated `shiftKeys(duration)` that offsets
event timestamps (for join-based period comparison) may come later if the
pattern proves common enough.

**`bfill` for `fill()`**: adds a `'bfill'` strategy to the existing `fill()`
method — the mirror of `'hold'` (forward fill). Walks the event array backward,
propagating the next known value into preceding `undefined` gaps. Supports
`limit` to cap consecutive fills, same as other strategies. Works in per-column
mode too:

```ts
series.fill('bfill');
series.fill('bfill', { limit: 3 });
series.fill({ cpu: 'linear', host: 'bfill' });
```

Trailing `undefined` runs (no future value to propagate) are left unfilled,
mirroring how `'hold'` leaves leading runs unfilled.

**Aggregator parity**: the original pondjs shipped 12 built-in reducers. We have
7 (`sum`, `avg`, `min`, `max`, `count`, `first`, `last`). The five missing ones:

- **`median`** — middle value of the sorted bucket. Same as `percentile(50)` but
  earns its own name for readability.
- **`stdev`** — population standard deviation of bucket values.
- **`percentile`** — q-th percentile. Expressed as `'p50'`, `'p95'`, `'p99'`,
  etc. in reducer specs. Linear interpolation between adjacent ranks by default.
- **`difference`** — range within a bucket (`max - min`). Useful for spread /
  volatility measures.
- **`keep`** — returns the value if all bucket values are identical, `undefined`
  otherwise. Useful for preserving constant columns (e.g. `host`) through
  aggregation.

These extend the existing `AggregateFunction` union and work everywhere reducers
are accepted: `aggregate()`, `reduce()`, `rolling()`, and `collapse()`.

```ts
series.aggregate(Sequence.every('10m'), {
  latency: 'p95',
  cpu: 'median',
  host: 'keep',
});

series.reduce({ latency: 'stdev', spread: 'difference' });
```

Definition of done:

- each method follows the `diff`/`rate` pattern (columns + options)
- type flow is preserved — affected columns become optional number
- tests cover empty series, single event, leading/trailing gaps, and
  composition with groupBy
- all 12 original pondjs reducers are available as built-in names
- `percentile` patterns (`p50`, `p95`, `p99`) parse correctly in reducer specs

---

## Phase 3: Live core

Status: complete.

Goal: introduce a minimal but principled live layer without collapsing the
immutable `TimeSeries` model.

Scope:

- [x] `LiveSeries<S>` — mutable, append-optimized buffer sharing the same schema
      type as `TimeSeries`
- [x] push/append APIs
- [x] retention policies (`maxEvents`, `maxAge`); ~~`maxBytes`~~ removed in v0.14.0 as unused
- [x] immutable snapshot via `toTimeSeries()`
- [x] ordering modes (`strict`, `drop`, `reorder`) and late-arrival policy
- [x] subscriptions (`event`, `batch`, `evict`) — synchronous, inline with push
- [x] docs page for LiveSeries

Non-goals for this phase:

- live aggregation, rolling, or smoothing
- React hooks

### Design notes

**Retention** runs on every push. No background timers — the caller controls the
event loop. Data is the clock.

**Ordering**: three modes — `strict` (default, throws on out-of-order),
`drop` (silently discards late events), `reorder` (inserts in sorted position
within a grace window).

**Subscriptions** are synchronous and fire inline with `push`. Async fanout is
the caller's responsibility.

**Subscription ordering**: within a single `push()` call, listeners fire in
this order: `event` (once per event, inline with insertion) → retention runs →
`batch` (once with all added events) → `evict` (if retention removed events).

**`reorder` mode**: without a `graceWindow`, any out-of-order event is inserted
in sorted position via binary search. With a `graceWindow`, events older than
the window relative to the latest timestamp throw. This gives callers control
over how much disorder they'll tolerate.

**`toTimeSeries()` snapshot**: reconstructs rows from the internal event array
and passes them through the standard `TimeSeries` constructor. This re-validates
events redundantly but keeps the two classes fully decoupled. Snapshot is not a
hot path — if profiling proves otherwise, a trusted constructor bridge can be
added later.

**Byte estimation** (`maxBytes`) was shipped in this phase but removed in
v0.14.0 — no real user reached for it, and the gRPC experiment's V3 profile
flagged the per-push estimator as the largest single self-time line (6.2%)
purely maintaining a counter no working app consulted. Pre-1.0 cleanup;
`maxEvents` covers the eviction patterns real apps actually need.

Definition of done:

- [x] `LiveSeries` can ingest ordered data reliably
- [x] retention and snapshot semantics are clearly documented
- [x] subscriptions are predictable and synchronous
- [x] the API is small enough to change if the composition model reveals flaws

---

## Phase 4: Live composition

Status: core primitives complete; **two queued workstreams** —
late-event propagation through live transforms and live merge / join
across sources. Both are committed for upcoming work (no longer in
"deferred" status) but are large enough to ship as their own phases.

Goal: validate the live composition model before building UI integrations on top
of it.

Completed:

- [x] `LiveAggregation` — incremental bucketed aggregation over a `LiveSeries`
- [x] `LiveRollingAggregation` — sliding-window reduction (time-based or count-based) over
      a `LiveSeries`
- [x] `LiveSource<S>` interface — common contract for LiveSeries and LiveView
- [x] `LiveView<S>` — derived view with `filter()`, `map()`, `select()`,
      `window()`, composable with all live transforms via `LiveSource`
- [x] `LiveAggregation` and `LiveRollingAggregation` accept any `LiveSource<S>`, not just
      `LiveSeries<S>`
- [x] `LiveAggregation` and `LiveRollingAggregation` satisfy `LiveSource` for chaining
      (`name`, `schema`, `length`, `at()`, `on('event')`)
- [x] Grace period for `LiveAggregation` — delays bucket closing so
      out-of-order events within the window accumulate into their correct bucket
- [x] `LiveSeries` rejects `graceWindow > retention.maxAge` at construction
      (v0.5.11) — a late event accepted within grace but older than `maxAge`
      would be evicted immediately by retention; the grace contract was a lie
      in that config.

Remaining:

- [x] per-event views: `diff`, `rate`, `pctChange` (stateless, prev→curr)
- [x] carry-forward views: `fill`, `cumulative` (small state per column)
- [x] docs page for live transforms

### Queued: late-event propagation

`graceWindow` is honored at two boundaries and nowhere else:

- ✅ `LiveSeries` ingest — rejects events older than `latest - grace`
- ✅ `LiveAggregation` bucket closure — buckets stay open until
  `watermark - grace`, so late events within grace land in the correct bucket

But a late event accepted at ingest does **not** re-flow through downstream
live transforms:

- ❌ `LiveRollingAggregation` — a reordered insertion becomes a fresh output
  event at its insertion point; the method does not re-scan historical
  windows to include the late event
- ❌ `LiveView.window()` — eviction is not re-applied when an event is
  reordered into the view; a late event "outside the window" sticks around
- ❌ Subscriber notifications — the `event` callback fires identically for
  on-time and out-of-order arrivals; there is no "this was late" payload
  for downstream transforms to key off of
- ❌ React hooks inherit all of the above

Fixing this is a real project, not a small patch. It would likely require
either a new event payload shape (`{ event, kind: 'append' | 'reorder' }`)
or a full patch-event model, and each stateful live transform would need
a recompute path. See Akidau's
[Streaming 102](https://www.oreilly.com/radar/the-world-beyond-batch-streaming-102/)
for the broader picture of what full late-event correctness looks like.

For now, document the scope honestly: `LiveSeries` tolerates moderate
late-event reordering for ingest and bucketed aggregation; stateful live
transforms assume in-order arrival. Callers who need late-event correctness
through rolling windows should batch their work into `TimeSeries` and use
the batch API.

Concrete next steps when this work begins:

- [ ] Add a discriminated `event` payload: `{ event, position: 'append' | number }`
      so downstream transforms know an insertion was reordered and at what
      index
- [ ] Plumb the reorder signal into `LiveRollingAggregation`; decide whether
      to recompute all windows overlapping the insertion, or mark them stale
      and defer until next observer read
- [ ] Do the same for `LiveView.window()` eviction re-evaluation
- [ ] Test matrix: `graceWindow + retention`, `graceWindow + rolling`,
      `graceWindow + window view`, `graceWindow + nested transforms`

### Queued: live merge / join

Multiple `LiveSeries` instances cannot be combined into a single live source
today. There is no `LiveSeries.merge(a, b)` (interleave events from same-schema
sources) and no `LiveSeries.join(a, b)` (join cross-schema sources by time
proximity into a wider schema). The batch API has `series.join(other, ...)`
and a manual `mergeWideRows` recipe documented for charting; the live side
has neither.

The dashboard use case that surfaces this: overlaying two metrics from
separate WebSockets onto one chart (e.g. `cpu` and `memory` arriving as
independent streams that need to render as `{ ts, cpu, memory }` rows). The
dashboard agent asked for `mergeWideRows` to be re-exported as a workaround;
the deeper ask is a live join.

Why it's deferred:

- **Subscription fan-in.** A live join needs to subscribe to N upstream
  sources and emit events on its own schedule (per-source push? buffered
  flush? watermark-driven?). The choice has user-visible latency and ordering
  consequences.
- **Time alignment.** Cross-source joins almost never have exactly-aligned
  timestamps. Either we expose a tolerance window (`{ within: '50ms' }`),
  carry-forward fill, or push the alignment problem to the caller via a
  required `align()` step. Each option has different memory and correctness
  trade-offs.
- **Schema conflict.** Same as batch `join` — two columns called `value` on
  both sides need a prefix or rename strategy. Live join inherits this.
- **Interaction with grace / retention / late events.** A late event on
  source A may need to retroactively emit a join row with the prevailing
  source-B value at that timestamp. This compounds the late-event scope gap
  above.

For now, document the scope honestly: callers who need to combine live
sources for rendering should snapshot each source independently and use the
batch `join()` on the resulting `TimeSeries` instances. The throttled
re-snapshot at the React layer makes this cheap enough for typical dashboard
cadences (`useSnapshot` on each source + `useMemo` over both for the joined
result; `useDerived` is single-source only today). See
[Charting → Live: snapshot-then-batch-join](website/docs/pond-ts/transforms/charting.mdx)
for the worked pattern.

Concrete next steps when this work begins:

- [ ] Decide the surface: `LiveSeries.merge(a, b, ...)` for same-schema
      interleave, `liveA.join(liveB, options)` for cross-schema. Mirror the
      batch shape where possible.
- [ ] Pick a time-alignment story: tolerance window vs. carry-forward fill
      vs. caller-supplied `align()`.
- [ ] Define emission cadence: emit on every upstream push (high frequency)
      vs. emit on watermark advance (lower latency variance).
- [ ] Schema conflict: reuse the batch `onConflict: 'error' | 'prefix'`
      contract verbatim.
- [ ] Decide what late events on one input do to already-emitted join rows
      — defer to the late-event work above, or carve out an in-order-only
      contract for the first cut.

### Queued: live align for multi-stream joining

`series.align(seq, { method: 'hold' | 'linear' })` exists on the batch
side and is the canonical primitive for resampling irregular events
onto a regular grid. There is no live counterpart today — earlier
PLAN drafts classified `live.align` as an intentional gap (claiming
the live buffer doesn't have "stable footing" for it). That framing
was wrong: align needs a point _forward_ of each grid boundary, not
historical context, and the live buffer has the historical side
already. The forward-point requirement makes streaming align a
**bounded-lag** problem, not a structural impossibility.

**Use-case driver: multi-stream joining.** The textbook case is
network counter data combined into derived timeseries — `cpu_in`
and `cpu_out` arriving on independent producers' schedules, joined
via `throughput = in - out` after both are aligned to a common
grid. pondjs supported this in production for exactly this shape.
Today's pond-ts users work around it with snapshot-then-batch on
every tick — heavy at firehose rates and per-tick latency-bound.
A live `align` unblocks the natural shape of the queued live join
work above (joining two streams typically requires aligning both
first).

**Lag trade-off:**

- `method: 'hold'` — emit grid point T once a source event with
  `time > T` arrives (or once we know no source has been seen since
  the last update past T). Lag = (next source event time) - T.
  Bounded for dense sources; unbounded if the source goes quiet.
  Same as batch's "no source seen since" semantics.
- `method: 'linear'` — needs a defined source value strictly after
  T to interpolate. Lag is strictly the inter-event gap straddling
  T. For dense sources (the network-counter case at sub-second
  resolution), sub-second lag; for sparse sources, indefinite.
  Caller opts in.

**Connection to streaming-RFC milestones:**

- **Milestone A (`LiveChange`)** — not strictly needed; live align
  works on top of `'event'` listeners alone.
- **Milestone C (`AggregateEmission` finality modes)** — cleanly
  models the lag: align could emit `kind: 'update'` when a grid
  boundary first crosses, `kind: 'final'` once the bounding event
  arrives. Without C, the v1 cut emits a single event per grid
  point at the moment the lag closes — simpler shape, less rich.
- Independent of milestones B and D.

**v1 surface (proposed):**

```ts
const aligned = live.align(Sequence.every('1s'), {
  method: 'hold',
  emit: 'on-bound', // emit only when the bounding source confirms;
  //   alternative: 'provisional' for milestone-C
  //   `update`/`final` semantics later.
});

// Multi-stream join shape (depends on live merge/join above):
const throughput = live.alignAndJoin([cpuIn.align(seq), cpuOut.align(seq)], {
  compute: ([inV, outV]) => (inV ?? 0) - (outV ?? 0),
});
```

The `alignAndJoin` shape is illustrative — the actual API depends
on how the live merge/join entry resolves. If the v1 cut of merge/
join requires aligned inputs, `align` ships first and merge/join
chains it; if merge/join supports tolerance-window joining without
explicit alignment, `align` is independent.

**Same logic applies to `live.materialize(seq)`.** Materialize is
align's sibling: both regularize an irregular source onto a
sequence grid; both need a forward bound. Materialize emits the
first / last / nearest source event inside each bucket, which only
becomes definitive when the next-bucket event arrives. Bounded-lag
the same way. Probably ships alongside live align as a paired
release; defer the design until the align driver is firm.

**Why not deferred indefinitely:** the multi-stream join story is
a recurring pattern (network monitoring, financial feeds, IoT
multi-sensor fusion). Pond's current "snapshot every tick + batch
join" workaround is correct but expensive at scale — it pays the
TimeSeries reconstruction cost on every tick, which dominates at
firehose loads. Live align + live join is the structural fix.

**Sequencing posture:** earns its slot when (a) a use-case agent
hits the snapshot-then-batch friction concretely, or (b) the live
merge/join work above starts and align is needed as a prerequisite.
Until then, queued.

### Shipped: batch dedupe — `series.dedupe({ keep })`

Real-world ingest produces duplicate events: WebSocket replays, Kafka
at-least-once semantics, retried HTTP fetches, polling overlaps.
v0.9.0 (PR 3 of the wave) ships the **batch** dedupe primitive:

```ts
series.dedupe(); // default: keep last
series.dedupe({ keep: 'first' });
series.dedupe({ keep: 'error' }); // throw on duplicates
series.dedupe({ keep: 'drop' }); // discard all events at any duplicate timestamp
series.dedupe({ keep: { min: 'cpu' } }); // keep smallest at named numeric column
series.dedupe({ keep: { max: 'cpu' } });
series.dedupe({ keep: (events) => events[0] }); // custom resolver

// Multi-entity: pair with partitionBy so the key includes the entity column.
series.partitionBy('host').dedupe({ keep: 'last' }).collect();
```

Decisions made:

- **Default key is timestamp alone.** Multi-entity series are
  expected to compose with `partitionBy` rather than have an `on`
  option on `dedupe` itself — `partitionBy` is the project's
  canonical entity-segregation primitive. Adding `on` would
  duplicate that vocabulary.
- **Default `keep` is `'last'`.** Matches WebSocket replay
  intuition: a retried event supersedes the prior occurrence.
- **`min`/`max` take a column reference.** Bare `'min'`/`'max'`
  strings can't carry the column to evaluate; the object form
  (`{ min: 'col' }`) is one extra brace and removes ambiguity.
- **`'drop'` discards the entire bucket.** The value of "1.5 events
  at this timestamp" is rarely defensible. `'drop'` is the
  conservative choice when duplicates indicate untrustworthy data.
- **Custom resolver gets the array.** Two-event reducer (`(a, b) =>
Event`) is more streaming-friendly but less flexible; `(events)
=> Event` lets callers compute averages, medians, etc. Batch can
  afford the array.
- **Custom resolver only invoked for buckets ≥ 2.** Single-event
  buckets pass through untouched without function call overhead.

### Queued: live dedupe (LiveSeries)

The **live** ingest-time story is still open. The PR-3 batch
primitive is a clean shape for it to converge on (`keep: 'first' |
'last' | 'error' | 'drop' | { min/max } | fn`), but live raises
its own questions:

- **Live update vs. emit?** When a duplicate-key event arrives in
  last-wins mode, do we update the in-place event (and notify
  subscribers via a separate `'replace'` event), or treat the new
  one as the canonical event and the old one as evicted? The
  in-place mutation breaks immutability; the evict-and-emit path
  is heavier but stays consistent with the rest of the model.
- **Interaction with grace + retention.** A late event whose key
  already exists in the buffer is a duplicate by definition under
  this design. The grace window already buffers late arrivals;
  dedupe should fold into that window rather than be a separate
  pre-filter. Likely shape: at the close of the grace window for a
  given timestamp, the buffered events are passed through the
  configured `keep` policy and the survivor is emitted.
- **Subscribers:** does dedupe surface a `'duplicate'` event so
  metrics / logging can react? Probably yes.

Concrete next steps when this work begins:

- [ ] Spec live API shape: separate `dedupe` option vs. third
      `ordering` mode. Lean separate-option since dedupe is
      orthogonal to ordering.
- [ ] Plumb through `LiveAggregation` / `LiveRollingAggregation` —
      a duplicate that arrives after a bucket closes is a special
      case (modify or ignore?).
- [ ] Add the `'duplicate'` (and possibly `'replace'`) event type
      to the subscriber surface.
- [ ] Decide grace-window interaction shape (likely:
      dedupe-at-close).

### Shipped: cross-entity correctness via `partitionBy`

The cross-entity hazard turned out to be widespread — almost every
stateful pond-ts transform (`fill`, `align`, `rolling`, `smooth`,
`baseline`, `outliers`, `diff`, `rate`, `pctChange`, `cumulative`,
`shift`, `aggregate`) silently mixes data across entities on a
multi-entity series. Three independent agent runs (Codex, Claude,
Gemini) converged on the issue via `fill('linear')` interpolating
across host boundaries.

Initially scoped as a `fill({ partitionBy })` option. Reframed
because the hazard isn't a `fill` quirk — it's class-wide. Adding
a `partitionBy` option to every affected method would have meant
twelve more options to maintain.

**Solution: `series.partitionBy(col)` chainable primitive.** Returns
a `PartitionedTimeSeries<S>` view with sugar methods for each
affected operator — each one runs the underlying transform per
partition and reassembles via `TimeSeries.concat`. One primitive,
covers all twelve at-risk operators. Shipped in v0.9.0 (PR 1 of
the v0.9.0 wave).

```ts
ts.partitionBy('host').fill({ cpu: 'linear' }).collect();
ts.partitionBy('host').rolling('5m', { cpu: 'avg' }).collect();
ts.partitionBy(['host', 'region']).aggregate(seq, { cpu: 'avg' }).collect();

// Persistent partition — chained per-partition ops without re-partitioning:
ts.partitionBy('host').dedupe(...).fill(...).rolling(...).collect();

// Escape hatch — terminal, returns TimeSeries directly (no .collect):
ts.partitionBy('host').apply((g) => g.fill(...).rolling(...));
```

Decisions made:

- Chainable view (not an option on every method) for surface-area
  discipline.
- Sugar methods return another `PartitionedTimeSeries` so multi-step
  per-partition workflows compose cleanly. `.collect()` is the
  terminal materialize-to-`TimeSeries` step. Pivoted away from the
  initial "always returns `TimeSeries`" design after agent feedback
  showed multi-step chains as the common case.
- Composite partitioning supported via array (`partitionBy(['a',
'b'])`).
- `apply(fn)` escape hatch is terminal (returns `TimeSeries<R>`
  directly) for arbitrary per-partition transforms.

**Bonus fix.** Discovered and fixed a pre-existing brand-check bug
where `series.filter(...).diff(...)` and similar chains failed with
"Receiver must be an instance of class TimeSeries." Root cause:
`#diffOrRate` was a JS-`#`-private method, which fails the brand
check on instances built via `#fromTrustedEvents` (which uses
`Object.create` to bypass constructor validation). Surgical fix:
demote `#diffOrRate` to TS-private (compile-only, no runtime brand
check). Regression test added in
`test/TimeSeries.diff-rate-brand.test.ts`.

### Shipped: `fill` improvements (`maxGap`, all-or-nothing semantics)

The original Codex friction on `fill` had two parts:

- Cross-entity leakage — solved by `partitionBy`, see above.
- **Long-gap policy** — `series.fill('linear', { limit: 3 })`
  formerly filled 3 cells of a 30-cell gap, "fabricating" interpolated
  data across what's actually a long outage. Codex wanted "don't fill
  at all if the gap exceeds N."

Shipped in v0.9.0 PR 2:

- [x] `maxGap: DurationInput` option as a duration-based gap cap.
      `limit` is count-based, `maxGap` is time-based, both compose
      (most restrictive wins).
- [x] All-or-nothing semantics: a gap either fits the caps and gets
      filled entirely, or exceeds them and is left fully unfilled.
      Strictly behavioral change for callers who relied on partial
      fill — flagged in the v0.9.0 release notes.
- [x] No `mode` option — always all-or-nothing. The user's argument:
      "a big gap is never going to benefit from a few points being
      filled in." Partial fill was a confused default.

Implementation: replaced the per-strategy switch (which tracked
`consecutive` per cell) with a unified gap-walker. Each gap is
detected once; size caps and strategy-feasibility (linear needs both
neighbors, hold needs prev, bfill needs next) are checked once;
the gap is filled or skipped atomically. ~50 LOC reduction net,
clearer code.

### Queued: `series.materialize(sequence, options?)` — regularize without filling (v0.10 PR 1)

Round-2 agent feedback (Codex retest of v0.9.0) surfaced a real gap:
`fill()` patches `undefined` cells in an existing event sequence
but never creates new rows; `align()` materializes a grid AND picks
a fill method (`hold` or `linear`) — there's no way to do the
first without the second. This forced Codex to either accept
`align`'s implicit fill choice or hand-roll a grid-completion
pass before applying gap-capped `fill('linear', { maxGap: '3m' })`.

`materialize` does only step one: emit one time-keyed row per
sequence bucket, populate value columns from the chosen source
event in that bucket, leave value columns `undefined` for empty
buckets. The natural composition with `fill()`:

```ts
series
  .partitionBy('host')
  .dedupe({ keep: 'last' })
  .materialize(Sequence.every('1m')) // regularize, undefined for empty buckets
  .fill({ cpu: 'linear' }, { maxGap: '3m' }) // fill with explicit policy
  .collect();
```

**Spec:**

```ts
materialize(
  sequence: Sequence | BoundedSequence,
  options?: {
    sample?: 'begin' | 'center' | 'end';      // bucket anchor for output time
    select?: 'first' | 'last' | 'nearest';    // which source event in each bucket wins
    range?: TemporalLike;                      // bounded slice for procedural sequences
  },
): TimeSeries<MaterializeSchema<S>>
```

**Defaults:** `sample: 'begin'` (matches `align`), `select: 'last'`
(matches `dedupe`'s "newer reading wins" intuition).

**`select` semantics — bucket-bounded.** All three options use
half-open `[bucket.begin, bucket.end)` membership. `'first'` /
`'last'` pick the boundary source event in the bucket;
`'nearest'` picks the source event closest to the `sample`
timestamp **among events in the bucket**. Empty bucket → all
value cells `undefined` regardless of `select`. Users who want
to reach across empty buckets compose `fill('hold')`
afterwards.

**Schema:** `MaterializeSchema<S>` widens value columns to
optional (parallel to `AlignSchema<S>`) since empty buckets emit
`undefined` cells.

**Partitioned variant — bonus.**
`series.partitionBy('host').materialize(seq)` auto-populates the
partition columns on every output row, including empty-bucket
rows — `host`'s value is known by virtue of which partition we're
in. Eliminates a sharp edge that would otherwise force a
`.fill({ host: 'hold' })` step that fails for partitions where
every event is in a long-outage gap. Tiny extra branch in the
partitioned row builder.

**Why a new primitive (not enrichment of existing ones):**

- `align()` mandates a fill method; relaxing that contract is a
  breaking semantic change.
- `aggregate(seq, { *: 'last' }).asTime()` is mathematically
  equivalent for `select: 'last'` (and would require a `'*'`
  shorthand), but conflates "summarize this column" with
  "regularize timestamps." Different intent at the call site.
- The "regularize without choosing fill" use case is the natural
  pre-step to `fill(maxGap)`, and clean composition is the whole
  point.

**Naming.** `materialize` reads naturally (parallel with the
database-view sense of "make this concrete on a grid"). Survives
the lazy-eval connotation since pond-ts is eager throughout.
Better than the alternatives considered: `completeOn` (overlaps
with promise terminology), `densify` (jargon-y, has prior art in
geo libs), `toGrid` (pond-ts `to*` methods conventionally return
non-`TimeSeries` shapes — `toJSON`, `toRows`, `toPoints`).

**Concrete next steps when work begins (PR 1 of v0.10):**

- [ ] Add `materialize` to `TimeSeries` and the `PartitionedTimeSeries`
      sugar (with partition-column auto-fill).
- [ ] `MaterializeSchema<S>` type — value columns widened to optional.
- [ ] Test matrix: empty source, single source on a multi-bucket
      grid, sub-bucket events with each `select` mode, empty
      buckets, off-grid events, partitioned variant preserves
      partition values, full chain (`partitionBy + dedupe +
materialize + fill(maxGap) + collect`).
- [ ] Cleaning page rewritten to lead with the
      `partitionBy + dedupe + materialize + fill` chain as the
      canonical multi-host cleaner.

### Queued: live partitioning — `LivePartitionedSeries` (v0.11 wave)

Same cross-entity hazard exists on the live side.
`LiveRollingAggregation`, `LiveAggregation`, `LiveView.window()`,
and live `diff`/`rate`/`pctChange`/`fill`/`cumulative` all read
from neighboring events and silently mix entities on a multi-host
stream. Dashboard-agent feedback (post-v0.9.0) flagged this
explicitly: their workaround was a hand-rolled per-host filter
view, which doesn't compose with the rest of the live API.

**Design (settled):**

Surface mirrors batch: `liveSeries.partitionBy(col)` returns
`LivePartitionedSeries<S>` with chainable sugar for each affected
operator. `.collect()` materializes back to a unified `LiveSeries`.
`.apply(fn)` is the terminal escape hatch.

```ts
const live = useLiveSeries(source, { maxAge: '5m' });

const cpuSmoothed = live
  .partitionBy('host')
  .fill({ cpu: 'linear' })
  .rolling('1m', { cpu: 'avg' })
  .collect();
// cpuSmoothed is a LiveSeries — events from all hosts interleaved
// by arrival, each with its host's per-partition rolling avg.
```

Decisions made in design review:

- **Per-partition retention.** `maxAge: '5m'` applies to each
  partition independently. A chatty host can't squeeze a quiet
  one out of the buffer.
- **Per-partition grace.** Late events route to their own
  partition's grace window; a late event for host-A doesn't
  perturb host-B's emission.
- **Per-partition aggregation timing.** Host-A's rolling avg
  fires when host-A has enough data, regardless of host-B.
- **Auto-spawn on new partition values.** New host appears →
  allocate a sub-buffer on first event. Optional `{ groups: HOSTS
as const }` upfront for typed narrowing (mirrors the batch
  typed-groups pattern from v0.10 PR 3).
- **Unified eviction stream.** Subscribers see one `'evict'` event
  stream with the partition column populated on each event;
  consumers can filter if they want per-partition handling.

**Cost model:** per-partition state means `N × per-window-buffer`
for rolling/baseline, `N × prev-event` for diff/rate/cumulative,
etc. For 1000 hosts × 1m rolling at 1Hz: ~60k floats. Fine for
typical telemetry; document in the operator JSDocs alongside
the existing per-method warnings.

**Two-PR split:**

**v0.11 PR 1 — `LivePartitionedSeries` view + four most-used
sugar methods.** `fill`, `rolling`, `diff`, `rate` — the
operators dashboard agent named explicitly. Chainable view +
`.collect()` + `.apply()`. Per-partition state map on the source
side; React hook `useLiveSeries(...).partitionBy(col)` works
naturally without a new hook (the view is a property of
`LiveSeries`).

**v0.11 PR 2 — Remaining operator coverage.** `smooth`,
`baseline`, `outliers`, `cumulative`, `shift`, `aggregate`,
`dedupe`. Each follows the same pattern as PR 1 — state allocated
per-partition, output aggregated per-partition, results
interleaved by arrival.

Then **v0.11.0 release** with the full live partitioning package.

For now (until v0.11): snapshot via `useSnapshot` (or
`live.toTimeSeries()`) and use batch `partitionBy`. Throttled
snapshots make this cheap enough for typical dashboard cadences;
it's not free for high-frequency streams.

### Batch → Live applicability

Not every batch `TimeSeries` method needs a live equivalent. The live layer is
about ingestion and incremental computation — when you need the full analytical
toolkit, snapshot to `TimeSeries` and use the batch API.

| Batch method      | Live?    | Notes                                                    |
| ----------------- | -------- | -------------------------------------------------------- |
| `filter(pred)`    | **done** | LiveView                                                 |
| `map(fn)`         | **done** | LiveView                                                 |
| `select(...cols)` | **done** | LiveView, schema-narrowing                               |
| `aggregate()`     | **done** | LiveAggregation (bucketed)                               |
| `diff(...cols)`   | **done** | stateless view, needs previous event                     |
| `rate(...cols)`   | **done** | stateless view, delta / time gap                         |
| `pctChange()`     | **done** | stateless view, (curr-prev)/prev                         |
| `fill(strategy)`  | **done** | carry-forward state per column (hold, zero, literal)     |
| `cumulative()`    | **done** | carry-forward state per column (sum, max, min)           |
| `rename(mapping)` | skip     | achievable with `map()`                                  |
| `collapse()`      | skip     | achievable with `map()`                                  |
| `rolling()`       | covered  | `LiveRollingAggregation` as chainable source (see below) |
| `smooth()`        | covered  | EMA is a closure in `map()`; MA is rolling avg           |
| `shift(col, n)`   | maybe    | needs lookback buffer, niche for live                    |
| `align()`         | no       | resampling assumes complete data                         |
| `join()`          | **gap**  | real ask, queued — see "live merge / join" above         |
| `dedupe()`        | **gap**  | new primitive needed both sides — see "deduping" above   |
| `groupBy()`       | no       | partitioning is a source-level concern                   |
| `within/trim`     | no       | temporal selection — snapshot then slice                 |
| `reduce()`        | no       | whole-series → scalar — that's `LiveRollingAggregation`  |

### Chainable stateful transforms

`LiveAggregation` emits closed buckets. `LiveRollingAggregation` emits per-event aggregate
values. Both should implement `LiveSource<S>` so their output can feed further
views:

```ts
live
  .filter((e) => e.get('host') === 'api-1')
  .aggregate(Sequence.every('1m'), { value: 'avg' })
  .filter((e) => (e.get('value') as number) > threshold)
  .on('event', alertBucket);
```

For `LiveAggregation`, the output events are interval-keyed (closed buckets).
For `LiveRollingAggregation`, each source event produces a new time-keyed output event with
the current sliding-window aggregate. This makes LiveRollingAggregation-as-source the live
equivalent of `rolling()` — no separate class needed.

Similarly, `LiveSmooth` is not needed as a dedicated class: EMA is a stateful
closure inside `map()`, and moving average is `LiveRollingAggregation`-as-source with
`'avg'`.

### Views

`filter`, `map`, `select`, and `window` return `LiveView` — a derived view
that subscribes to its source's event stream and forwards processed events.

**Stateless views** (`filter`, `map`, `select`) apply a per-event transform.
**Bounded views** (`window`) add eviction to keep the buffer within a time or
count limit.

Planned per-event views (`diff`, `rate`, `pctChange`) carry one value per
column from the previous event. Planned carry-forward views (`fill`,
`cumulative`) carry state that accumulates across events. Both fit the LiveView
model — the `process` function closes over the state.

### Accumulators

**`LiveAggregation`**: maintains pending buckets (accumulating), a watermark
(highest timestamp seen), and an optional grace period. A bucket closes when
its `end <= watermark - grace`. With zero grace (default), buckets close
immediately on boundary crossing — matching the behavior before grace was
added. With grace > 0, multiple buckets can be pending simultaneously, and
late events within the grace window route to their correct bucket instead of
being lost.

`.closed()` returns only finalized buckets; `.snapshot()` includes all
pending buckets as provisional results. As a `LiveSource`, `at(index)` and
`length` expose the closed-bucket event buffer; `on('event', fn)` fires
when a bucket finalizes.

```ts
new LiveAggregation(
  source,
  Sequence.every('1m'),
  { value: 'avg' },
  { grace: '5s' },
);
```

**`LiveRollingAggregation`**: maintains a sliding-window reduction. Supports both
time-based windows (`'5m'`) and count-based windows (`100`). Uses
`RollingReducerState` from the reducer registry for incremental add/remove.
As a `LiveSource`, each source event produces an output event containing the
current aggregate value at that point. The output buffer grows with each
source event (downstream consumers can use `.window()` to bound it).
`on('event', fn)` fires per source event with the new aggregate.

| Transform                | Live behavior                          | Owns a buffer? | Chainable? |
| ------------------------ | -------------------------------------- | -------------- | ---------- |
| `filter/map/select`      | Per-event transform                    | Yes (view)     | Yes        |
| `window`                 | Bounded view with eviction             | Yes (view)     | Yes        |
| `diff/rate/pctChange`    | Per-event with prev-event state        | Yes (view)     | Yes        |
| `fill/cumulative`        | Per-event with carry-forward state     | Yes (view)     | Yes        |
| `LiveAggregation`        | Accumulator per bucket + closed stream | Yes            | Yes        |
| `LiveRollingAggregation` | Sliding window + per-event output      | Yes            | Yes        |

### LiveSource interface and LiveView

`LiveSource<S>` is the common interface that all live objects expose for
downstream consumers: `name`, `schema`, `length`, `at(index)`, and
`on('event', fn)`. Both `LiveSeries` and `LiveView` satisfy it, so
`LiveAggregation` and `LiveRollingAggregation` accept any `LiveSource<S>`.

`LiveView<S>` wraps a source with a `process: (event) => event | undefined`
function. If `process` returns `undefined`, the event is filtered out. This
unifies filter (predicate → event or undefined) and map (transform → always
returns event) in one class.

Views maintain their own buffer of processed events for O(1) `at()` and
`length`. Views mirror evictions from their source: when a retention-capped
`LiveSeries` evicts old events, downstream views (filter, map, etc.) remove
corresponding events automatically. This prevents unbounded growth on
filtered/mapped views of a retention-capped source. Detection uses the
`EMITS_EVICT` symbol to safely identify sources that fire `'evict'` events
(avoids duck-typing `on('evict')` which breaks on `LiveAggregation`).

**`select`** narrows the schema. The output `LiveView` has a different schema
type from the input. The constructor accepts an optional output schema for this
case; filter/map omit it (schema is inherited).

**`window`** bounds the view by time or event count. Uses an eviction function
that runs after each event is added. Time-based windows evict events whose
timestamp is below `latest - duration`. Count-based windows keep the last N
events. Unlike retention on `LiveSeries`, window is a query over the data, not a
memory policy — you can keep a large source buffer but view a narrow window.

Views compose by stacking:

```ts
live.filter(pred).select('cpu', 'mem').window('5m').aggregate(seq, mapping);
```

Each view subscribes to its source's `'event'` stream and forwards processed
events to its own subscribers.

### Composition

Views, accumulators, and further views compose naturally:

```ts
live
  .filter(pred)
  .select('cpu', 'mem')
  .window('5m')
  .aggregate(Sequence.every('1m'), { cpu: 'avg' })
  .filter((e) => (e.get('cpu') as number) > threshold);
```

Multiple consumers fan out from one source with shared buffer but separate
state.

**Windowed snapshots**: `live.window('5m')` returns a view backed by the same
source, materialized on `.toTimeSeries()`. Window boundary is relative to
latest event timestamp, not wall-clock.

### Queued: snapshot/append primitives on `LiveSeries`

Surfaced by the gRPC experiment's M1 milestone (WebSocket bridge,
[pond-grpc-experiment#3](https://github.com/pjm17971/pond-grpc-experiment/pull/3)).
`LiveSeries` is missing the parallel JSON / typed-row APIs that
`TimeSeries` already has. The aggregator and browser today hand-
roll per-row push loops, manual column-by-column serialization in
the batch listener, and an unsafe `live.push(row as never)` cast on
the wire→push path. Schema-evolution self-test confirms the cast is
the lone hole where a column rename or addition silently passes
type-check.

Next PR adds **codec-agnostic primitives** plus **JSON sugar over
them**:

| Layer                                    | Methods                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Primitives (typed-tuple, codec-agnostic) | `LiveSeries.toRows()`, `LiveSeries.toObjects()`, `LiveSeries.pushMany(rows)`, `Event.toRow(schema)`    |
| JSON sugar                               | `LiveSeries.toJSON()`, `LiveSeries.fromJSON()`, `LiveSeries.pushJson(rows)`, `Event.toJsonRow(schema)` |

Closes M1 friction notes #1 (`LiveSeries.toJSON()` missing), #2
(batch listener delivers `Event` objects, not rows), #4 (the
`as never` push hole — `pushJson` validates a `JsonRowForSchema<S>`
and translates `null → undefined`), and #5 (no `pushMany` /
`fromJSON`).

**Partial follow-up (post-v0.11.5):** friction note #3 was
re-attempted with distinct named return types
(`TimeSeriesJsonOutputArray<S>` / `TimeSeriesJsonOutputObject<S>`)
in place of `TimeSeriesJsonInput<S> & { rows: ... }` intersections.

- **`LiveSeries.toJSON` narrowing landed.** Overloads keyed on
  `rowFormat` work cleanly; the impl casts the inner
  `toTimeSeries().toJSON()` result. `test-d/liveseries-tojson-narrowing.test-d.ts`
  pins it. For the live snapshot path — the common case for
  networked consumers — the ergonomic win is there.
- **`TimeSeries.toJSON` narrowing still cascades.** Adding the same
  overload pair triggers TS2394 errors at four unrelated overload
  sets (`pivotByGroup`, `rolling`, `arrayAggregate`, `arrayExplode`).
  Cause-and-fix isolated has defeated multiple time-boxes. The
  cascade is reproducible whether the impl signature returns a
  union, `any`, or the broad `TimeSeriesJsonInput<SeriesSchema>` —
  it's specific to `TimeSeries.toJSON`'s shape, not the impl. The
  inline JSDoc records this. Re-attempt if a TypeScript upgrade
  or a refactor of one of those four overload sets unblocks it.

  **Alternative path worth trying first:** extract the toJSON
  serialization body into a module-level helper
  (`serializeToJSON<S>(events, schema, rowFormat)`) called by both
  `TimeSeries.toJSON` and `LiveSeries.toJSON` (replacing the
  current `live.toTimeSeries().toJSON(...)` indirection). Each
  class becomes a thin narrowed wrapper over the helper. The
  cascade trigger is sensitive to `TimeSeries.toJSON`'s in-class
  shape; pulling the body out may bypass it without needing a
  TypeScript upgrade. Cheaper than waiting on a compiler fix and
  unblocks the unified narrowing story for batch consumers too.

**Friction note #7 follow-up (events-per-second ergonomics).**
The original friction was "useCurrent(live, { cpu: 'count' }, { tail: '1m' }).cpu / 60
is awkward." Investigated as a column-free count earlier and
deemed solvable in user code; revisited with a stronger ergonomic
target.

Landed (queued for the next patch release):

- **`LiveView.count()` and `LiveView.eventRate()`** terminal
  accessors. `live.window('1m').count()` and
  `live.window('1m').eventRate()` read the current window count
  and events/sec directly. `eventRate` is the per-window-events-
  per-second operator, deliberately distinct from
  `LiveView.rate(columns)` (the per-column derivative).
  `eventRate` requires a time-based window — `window(N)`
  count-based windows throw at the call site (no denominator).
- **`@pond-ts/react` ships `useEventRate(source, '1m')`** — a
  reactive hook returning the events-per-second number,
  throttled on `'event'` like `useSnapshot`. Single hook
  replaces `useCurrent + custom division`.

The hook works because `LiveView.window(duration)`'s eviction is
arrival-driven: count and rate update on each push, which is when
display matters. Same staleness-at-zero-rate caveat as rolling —
documented at the call site.

**Friction note #6 (count semantics) — investigated, not a bug.**
Empirical reproduction across nine scenarios (LiveSeries push
variadic + per-row, TimeSeries construction, reduce, aggregate,
rolling, LiveAggregation, LiveRollingAggregation, plus the exact
"dashboard defaults: 480 events at 8/s" case) shows the library
preserves duplicate temporal keys and counts them independently at
every layer. The friction-noted "count collapses same-ts events"
diagnosis was empirically wrong; the agent's stagger workaround in
the simulator probably wasn't necessary for the reason claimed.

`test/duplicate-keys.test.ts` locks down the behavior so a future
regression breaks visibly. `count` reducer JSDoc updated to call
out duplicate-key semantics explicitly.

**Deliberately NOT in scope: pluggable codec adaptors.** The
ergonomic shape we're considering for codecs (msgpack, protobuf) is
a `using:`-keyed export/import:

```ts
ws.send(live.export({ using: MessagePackAdaptor }));
const live = LiveSeries.import(bytes, { schema, using: ProtoAdaptor });
```

Tempting to ship the `Adaptor` interface alongside the JSON case as
a "default codec," but several open design questions only get
answered by working code:

- **Per-row vs per-snapshot semantics.** Protobuf likely wants
  per-row (one message per `call.write`); msgpack wants whole-array
  encoding. The interface needs to support both without forcing
  either side into ugly wrapping.
- **Schema-passing semantics.** Protobuf needs the message type;
  JSON / msgpack don't. Pass schema as a second arg, or parameterize
  the adaptor instance with the proto descriptor at construction?
- **Streaming.** Does `Adaptor.encode` need to support streaming
  for huge snapshots, or always return a whole `Uint8Array`?

**Decision: extract `Adaptor` from working code post-M2.** The
gRPC experiment's M2 builds protobuf-on-gRPC for the producer
hop; M3+ may add msgpack-on-WebSocket. Once two real codecs exist
in user-land, we have the shape data to define the contract. Pre-
shipping `Adaptor` now would lock in answers we'd otherwise extract.
The codec-agnostic primitives above (typed tuples in/out) are
sufficient to build M2 with — no library work blocks the experiment.

When the time comes, `Adaptor` likely lives in a separate package
(`@pond-ts/adaptors` or similar) so codec libs don't get pulled
into pond-ts core. The default JSON path stays directly on
`LiveSeries.toJSON()` / `pushJson()` / `fromJSON()` — the most
common case shouldn't pay an adaptor-indirection tax.

### Queued: live API parity for the buffer-as-window persona (logged 2026-05-04)

Surfaced by the gRPC experiment's metric agent code:

```ts
const rolling = series.rolling(
  RETENTION,
  { p50: 'p50', p75: 'p75', p95: 'p95', count: 'count' },
  { minSamples: 1, trigger: rollingReportTrigger },
);
```

The agent wrote `rolling(RETENTION, ...)` because they wanted "stats
over my entire current buffer, emitted on a trigger" — and the
explicit form was the closest primitive available. It works, but
it's a workaround. The user holds a `LiveSeries` with retention as
their only window; the buffer **is** the window. Forcing them to
declare a two-level structure (retention + a rolling window matched
to retention) reads as ceremony when the simpler intent is "reduce
the buffer streaming-style."

This is a recurring shape — many users will not want a two-level
series (rolling-window buffer via retention plus a rolling window
inside it). The library's job is to make the one-level case as
obvious to write as the two-level case.

**Triage of gaps surfaced when comparing `LiveSeries` / `LiveView`
to batch `TimeSeries` for this persona:**

**Tier 1 — direct asks for the buffer-as-window user.**

> **Cross-reference (2026-05-05):** `live.reduce()` is the
> single-buffer face of the **Fused multi-window rolling +
> buffer-as-window unification** primitive (see "Deferred from this
> wave" below). Design `live.reduce()` from the start as sugar for
> the fused form (record API) with the `'buffer'` sentinel:
>
> ```ts
> live.reduce(mapping, opts) ===
>   live.rolling({ buffer: mapping }, { history: false, ...opts });
> ```
>
> This makes the API future-compatible: extending to multi-window
> via `live.rolling({ '1m': m1, '200ms': m2 }, opts)` is "add
> another entry to the record" not "introduce a new primitive
> shape." Ship Tier 1 first if fused-rolling lands later; if both
> ship together, ship as the unified buffer-as-window release.

- **`live.reduce(mapping, opts?)`** — full-window streaming reduce.
  Mirrors batch `series.reduce(mapping)` semantically: "no window,
  just everything in scope." Returns an accumulator with
  `value()` + `on('event', ...)`. Implementation is thin — under
  the hood it's `rolling(retention-bound, mapping, { history: false })`
  with the window taken from `LiveSeries`'s own retention. Pairs
  with the `history: false` tactical fix and is sugar over the
  fused multi-window primitive.

  **Open questions to settle pre-ship:**
  - **No retention case.** If the source has no retention bound
    (or unbounded `maxEvents`), `live.reduce` reduces over the
    whole history. Doc-note: "memory grows with `LiveSeries`
    retention; use bounded retention for high-rate sources." Same
    caveat as live rolling, but more invisible because the user
    didn't write the window down — louder doc treatment warranted.
  - **Retention change after construction.** Probably an error or
    stale-state case; needs explicit handling.
  - **Late events / grace.** Should follow whatever the source
    buffer does — a late event accepted within grace updates the
    reduce; an evicted event is removed. Same machinery as today's
    rolling.

- **`live.timeRange()`** — span of the current buffer
  (`last.begin() - first.begin()`). Trivial to implement; "how much
  data am I holding?" is a question this persona genuinely asks.
  Batch has it; live doesn't.

- **`live.eventRate(): number`** — events per second over the buffer.
  `LiveView` already exposes this (line 240); `LiveSeries` does
  not. Today the user does `live.window('1m').eventRate()` to get
  rate over the last minute — fine when they want "last minute"
  specifically; needless detour when they want "rate over what's
  retained." Pure parity addition.

- **Naming consistency: `live.count()` vs `live.length`.** `LiveView`
  has both `count()` (line 218) and `length`; `LiveSeries` exposes
  only `length`. Either give `LiveSeries` a `count()` alias for
  symmetry, or drop `LiveView.count()` in favor of `length`. Lean
  toward dropping `LiveView.count()` — `length` is the JS-idiomatic
  shape. Minor; settle alongside the other Tier 1 work.

**Tier 2 — query primitives on the sorted live buffer (SHIPPED v0.16.0).**

Pure parity additions on `LiveSeries` and `LiveView`. Both classes
now expose:

- **Predicate query:** `find(pred)`, `some(pred)`, `every(pred)`.
  Linear scan; thin wrappers over the underlying event array's
  same-named methods.
- **Key-position query:** `includesKey(key)`, `bisect(key)`,
  `atOrBefore(key)`, `atOrAfter(key)`. Binary search on the sorted
  buffer; O(log N).

`KeyLike` and `toKey` are now exported from `TimeSeries.ts` (and
re-exported from the package root) so callers can type their own
helpers consistently across batch and live.

37 dedicated tests in `packages/core/test/live-query-tier2.test.ts`
cover empty-buffer behavior, bisect edge cases (before / exact /
between / after), live mutation reflection (retention evicts
update bisect), and LiveView parity (windowed bisect respects
view boundary; filtered view's `includesKey` returns false for
filtered-out events).

Use cases that motivated this: "is there already an event with
key K?" / "what was the most recent event before time T?" — both
come up in dashboard / monitoring patterns where the buffer **is**
the working set.

**Tier 3 — range slicing and the `window` vs `tail` naming.**

`TimeSeries` has `tail(duration)`, `within(range)`, `before(t)`,
`after(t)`, `trim(range)`, `overlapping(range)`, `containedBy(range)`.

`LiveSeries.window(size)` is conceptually a tail-like `LiveView` —
"recent slice." But `window` collides with the windowing-operator
concept (`rolling`, `aggregate`, `reduce` are all "windowing modes"
per the docs). Two open questions:

- **Rename `window` → `tail`?** Better matches batch and reads
  more clearly. Public-API rename — needs deprecation. Reach for
  this only if it's part of a broader live-naming pass.
- **Add `live.within(range)` / `before(t)` / `after(t)`?** Same
  machinery as `window`, scoped differently. Returns `LiveView`.
  Useful for the buffer-as-window persona who wants "events
  between two timestamps."

Ship Tier 3 only after Tier 1 + 2 land and the persona's actual
usage patterns reveal which slicing shapes matter most.

**Not gaps (intentional):**

- `live.smooth({ alignment: 'centered' })`, `live.smooth('loess')` —
  these need a forward window the live buffer can't bound generally.
  Trailing-alignment EMA / movingAverage are online and feasible if
  driven by friction; the centered / loess variants are best left to
  `live.toTimeSeries().smooth(...)`.
- `live.shift` is a re-keying transform that doesn't bring obvious
  live value beyond `live.map(e => e.set('time', ...))` — defer
  unless a use case argues for it.

**Reclassified — moved to queued.** An earlier draft of this section
listed `live.align(seq, ...)` and `live.materialize(seq, ...)` as
intentional gaps because "they need historical context the live
buffer doesn't have stable footing for." That framing was wrong —
both operators need a point _forward_ of each grid boundary, not
historical context, and that's a bounded-lag problem rather than a
structural impossibility. See the new "Queued: live align for
multi-stream joining" entry above for the use-case driver and the
lag trade-off.

**Suggested PR structure:**

- **PR 1 — Tier 1 core:** `live.reduce()` + `live.timeRange()` +
  `live.eventRate()` + `live.count()` parity decision (~150 LoC
  - tests).
- **PR 2 — Tier 2 query parity:** `find` / `some` / `every` /
  `includesKey` / `bisect` / `atOrBefore` / `atOrAfter` (~100 LoC,
  pure parity additions, no design questions).
- **PR 3 — Tier 3 if/when:** range-slicing parity + `window` vs
  `tail` decision. Defer until Tier 1 + 2 ship and the API-usage
  shape suggests which slicing matters.

**Why queued and not blocked-on-something:** all three tiers are
small, well-scoped, and motivated by direct user evidence (the
metric agent's call site for Tier 1, batch parity gaps for Tier
2, naming consistency for Tier 3). No design surface needs a
second user signal first — the gaps are visible from the existing
batch-vs-live contrast. Schedule alongside the next live-API pass
or when a buffer-as-window user reports specific friction.

### Shipped: pipeline `stats()` accessor across 8 live classes (v0.16.0)

Per-class `stats()` accessor shipped in PR 2 of the v0.16.0 wave —
covers `LiveSeries`, `LiveRollingAggregation`, `LiveFusedRolling`,
`LiveAggregation`, `LiveReduce`, `LivePartitionedSeries`,
`LivePartitionedSyncRolling`, and `LivePartitionedFusedRolling`.
Each class has private integer counters incremented in existing
handlers (`#ingest` / `#removeFirst` / `#emitEvent` / `#routeEvent`)
plus an O(1) `stats()` accessor returning a plain record.

Per-class shapes match the design sketch below, with two
deviations:

1. `LiveAggregation.stats()` returns
   `{ eventsObserved, bucketsClosed, openBuckets, openBucketStart? }`
   instead of `{ eventsObserved, bucketsClosed, emissions,
openBucketStart? }`. `emissions` would have been redundant with
   `bucketsClosed` (every closed bucket emits exactly one output
   event); `openBuckets` (current pending bucket count) carries
   bucket-lifecycle info users actually reach for.
2. `LiveReduce.stats()` was added beyond the original 7-class
   sketch since the gRPC team uses it as their primary primitive;
   shape is `{ eventsObserved, evictions, emissions, bufferSize }`
   where `bufferSize = eventsObserved - evictions` (current count
   of events in reducer state, tracking the source's retained
   buffer).

Tests: 33 dedicated stats tests in
`packages/core/test/live-stats.test.ts` covering shape pinning,
counter advancement on every relevant event, retention/eviction
counting, late-event silent-drop accounting, partition counting,
trigger-fire-count for non-event triggers, and a 10k-event
allocation smoke test. All 1177 core tests + 55 react tests
passing.

Original design sketch (logged 2026-05-06):

Surfaced by the gRPC experiment's manual-counter pattern in
`aggregator/src/aggregate.ts` (step 6, pond-grpc-experiment#26):

```ts
let eventsIngested = 0;
let eventsEvicted = 0;
const offBatch = live.on('batch', (events) => {
  eventsIngested += events.length;
});
const offEvict = live.on('evict', (events) => {
  eventsEvicted += events.length;
});
// later, on every tick:
emit({ events_ingested_total: eventsIngested, ... });
```

Every long-running pond pipeline reaches for cumulative counters
of _something_ — events seen, events evicted, emissions fired,
partitions spawned. The library has the data internally
(`'batch'` / `'evict'` listeners, the `#partitions` map, the
output buffer length); users wire it themselves because pond
doesn't expose it in a single accessor. Each new user
reinvents the same handler+counter boilerplate.

**The shape — `stats()` accessor on each accumulator/series.**
Read-only point-in-time snapshot, returned as a plain record.
Per-class field set:

```ts
live.stats();
// { ingested, evicted, rejected, length, earliestTs?, latestTs? }

rolling.stats(); // LiveRollingAggregation
// { eventsObserved, evictions, emissions, windowSize }

fused.stats(); // LiveFusedRolling
// { eventsObserved, evictions, emissions, windowSize, windowsCount }

agg.stats(); // LiveAggregation
// { eventsObserved, bucketsClosed, emissions, openBucketStart? }

byHost.stats(); // LivePartitionedSeries
// { partitions, eventsRouted }

syncRolling.stats(); // LivePartitionedSyncRolling / LivePartitionedFusedRolling
// { partitions, eventsObserved, emissions, windowSize: max-across-partitions }
```

**Cost budget — strict.** Each new field is a private integer
counter, incremented in handlers that already exist. `stats()`
itself constructs one record on call. Per-event cost: ~3
integer increments. No allocation per event, no listener fan-
out, no per-event indirection. This is an observability
ergonomic, not a perf concern — sits in the same bucket as
`length` / `windowSize` / other zero-cost accessors.

**Read pattern — polling, not subscription.** Users call
`stats()` when they want a snapshot:

- Once per tick when assembling a wire frame (gRPC pattern)
- On every render frame at 60fps (dashboard pattern)
- From `setInterval(..., 10_000)` for periodic backend export
- From inside a `Trigger.every('10s')` handler for data-clock
  cadence

A push-based `on('stats', cb, { trigger })` shape was
considered and rejected for v1 — wall-clock timers inside pond
break the data-is-the-clock invariant the rest of the library
preserves; data-clock cadence via `Trigger.every` is already
composable in 5 lines of user code (subscribe to `'event'`,
check ts crosses boundary, call `stats()`). Revisit only if
users repeatedly write that exact composition.

**What's NOT in scope:**

- **Distributions / latency histograms.** That's metrics-
  framework territory; users wanting Prometheus-style
  observability layer a real metrics library at the
  application boundary on top of `stats()`.
- **Per-partition stats maps.** Aggregate "partition count"
  is enough for v1; per-partition counts add memory
  proportional to partition count. Add only if a user lands
  on the wall.
- **Late-event / reorder accounting.** Useful for
  `ordering: 'reorder'` debugging, but the reorder path is
  already complex; targeted additions when `OrderingMode`
  semantics get more attention.
- **Beam-style metrics registry.** Counter / Gauge /
  Distribution / runner aggregation. Massive scope creep —
  pond is an in-process series library, not a distributed
  pipeline orchestrator. Permanently out of bounds.

**Framing.** Same as the v0.15.2 abstraction-cost framing:
making observation cheap is library work; building a metrics
system isn't. Polling `stats()` is sufficient for the long-
tail of "I want to know how my pipeline is doing"; anything
richer is application code that composes on top.

**Implementation rough estimate.** ~150 LoC across the seven
accumulator/series classes (~20-25 LoC each, mostly counter
fields + `stats()` method). Tests pin "counter advances on
every relevant event" + "snapshot record shape matches
class." Bench: trivial — confirm the stats() construction is
sub-µs and per-event counter updates are unmeasurable. Could
ship as v0.16.0 (small additive surface, type-safe) alongside
the queued buffer-as-window Tier 1 work.

Cross-reference: gRPC experiment manual counter
(pond-grpc-experiment#26 step 6); the v0.15.2 SHIPPED entry's
"manual counter vs rolling" follow-up doc note.

### Shipped: `partitionBy` default-inherit fix (v0.17.1)

Bug fix, strictly additive, no surface change beyond defaults. Surfaced by
the gRPC experiment's
[M4 friction note](https://github.com/pjm17971/pond-grpc-experiment/blob/main/friction-notes/M4.md):
under `source = LiveSeries({ ordering: 'reorder', graceWindow: '30s' })`
followed by bare `live.partitionBy('host')`, the source accepted late
events via its reorder path but the partition sub-series was constructed
with default `'strict'` ordering. `_pushTrustedEvents` routed the late
event to the partition's `#insert` which threw with a strict-mode error,
and the throw propagated back up through the source's listener fan-out
into `live.push()`. **99.5% of late events crashed the partition router**
in the friction-note's drift harness.

**Fix:** `LiveSeries.partitionBy()` now default-inherits `ordering`,
`graceWindow`, and `retention` from the source. Explicit options on
`partitionBy(by, ...)` override per-field. `LivePartitionedSeries.collect()`
and `apply()` likewise default-inherit `ordering` and `graceWindow` from
the partitioned series (which inherits from source); retention stays
caller-explicit on collect/apply per the existing append-only fan-in
semantics. `graceWindow` inheritance is gated on effective ordering being
`'reorder'` — LiveSeries' constructor rejects strict + graceWindow.

Existing callers with explicit `partitionBy(by, { ordering, ... })`
unchanged. Existing callers on strict sources unchanged (source default
is strict; inherited default is strict). The behavior change is exactly
the bug fix: `'reorder'`-mode sources now produce reorder-mode partitions
by default.

Six tests in `LivePartitionedSeries.test.ts` pin: inherited ordering,
inherited graceWindow within reorder, inherited retention on partitions,
explicit override of inheritance, strict-source no-change, and the
edge case where overriding ordering to strict suppresses graceWindow
inheritance. `collect()` inheritance pinned by a separate test.

Released as v0.17.1.

### Shipped: `live.sample({...})` — bounded-memory stream sampling (v0.17.0)

Surfaced by the gRPC experiment's M3.5 finish-line work. Cross-reference:
[`pond-grpc-experiment/friction-notes/rfcs/bounded-memory-sampling.md`](https://github.com/pjm17971/pond-grpc-experiment/blob/main/friction-notes/rfcs/bounded-memory-sampling.md)
(originating RFC, with measured firehose numbers). Shipped via PR #129.

#### Shipped scope (v0.17.0)

- **Live-side: stride only.** `LiveSeries.sample`, `LiveView.sample`,
  `LivePartitionedSeries.sample`, `LivePartitionedView.sample` all accept
  `SampleStrategy = { stride: number }`.
- **Snapshot-side: stride + reservoir.** `TimeSeries.sample` and
  `PartitionedTimeSeries.sample` accept `BatchSampleStrategy` (both forms);
  reservoir uses single-pass Algorithm R, sorted by key on output to preserve
  the chronological invariant.
- **Bias trap is a doc warning, not a type-level guard.** The
  multi-entity bias risk on pre-partition `live.sample(...)` is documented
  in the `LiveSeries.sample` / `LiveView.sample` JSDoc with the
  `partitionBy(...).sample(...)` recommendation, matching the existing
  convention for `rolling` / `aggregate` / `fill` / `diff` / `rate` /
  `cumulative` / `pctChange` / `reduce`. None of those operators have a
  type-level partition-acknowledgment token; `sample` follows the same
  convention.

#### Implementation: closure-counter inside `LiveView`

The live-side implementation collapsed dramatically from the original
~300-LoC `LiveSample` class to a `~30-LoC` `makeStrideSampleView` helper in
`LiveView.ts` — the same factory pattern that backs `makeFillView` /
`makeDiffView` / `makeCumulativeView`. Each `.sample({...})` call site
captures its own counter in a closure and returns a `LiveView<S>`:

```ts
export function makeStrideSampleView<S>(
  source: LiveSource<S>,
  stride: number,
): LiveView<S> {
  let counter = 0;
  return new LiveView<S>(source, (event) => {
    counter++;
    return counter % stride === 0 ? event : undefined;
  });
}
```

Returning a `LiveView` (not a bespoke operator) means the chainable
surface — `filter`, `rolling`, `reduce`, `select`, `map`, … — is
immediately available downstream of the sample. This was a Layer 2
adversarial-review finding on PR #129's first attempt; the simplification
fixed it for free. Per-partition state falls out of the existing factory
pattern (`new LivePartitionedView(this, sub => makeStrideSampleView(sub, N))`):
each partition's sub-series gets its own closure, so the counter is
per-partition by construction.

#### Deferred from this wave: live-side reservoir

Live-side reservoir is **deferred to v0.18.0+** and gated on milestone A
of the streaming RFC (`LiveChange` model). The blocker: Algorithm R's
random-slot replacement produces **non-prefix** evictions of the live
buffer (e.g., replacing `event_50000` in `[event_1000, event_50000,
event_100000]`), but the current live-eviction protocol is **prefix-only**
— `LiveView` mirrors source eviction by computing `cutoff =
evicted[last].begin()` and dropping every view event with `begin() <=
cutoff`. A reservoir-style replacement event_50000 would corrupt
downstream `LiveView`s by also dropping event_1000.

Codex's adversarial review on PR #129 caught this protocol violation on
the original implementation (which emitted reservoir replacements as
single-element `'evict'` events and relied on `LiveView` accepting them as
prefix evictions — silent corruption of any `view.sample(...).filter(...)`
chain). The fix needs an **exact-removal eviction channel** — `LiveChange`
with `kind: 'remove' | 'replace'` carrying event identity — which arrives
with Phase 4.5 milestone A.

Snapshot-side reservoir is unaffected (single-pass Algorithm R over a
known-N events array, no eviction concern) and ships in v0.17.0 as the
canonical visualization shape:

```ts
series.sample({ reservoir: { size: 500 } }).toRows();
```

The user's framing ("ship reservoir, especially for visualization, that
seems a more natural interface") drives the snapshot-side default;
visualization is exactly the use case where reservoir's uncorrelated
points beat stride's regular-spacing artifact.

**The window-length wall.** Streaming aggregator memory is `O(window_seconds ×
event_rate × per_partition_count)`. At 70k events/s × 80 partitions, a 1m
rolling baseline holds ~4.2M events × ~600 bytes ≈ 2.5 GB. A 5m baseline at
the same rate is 170 GB — non-starter. Window length is pinned to whatever
fits in the heap, even though operators consistently want longer baselines
for stability (`sd / sqrt(N)` standard error scales with `N`).

Sampling decouples baseline length from event rate. At firehose × stride=10:
`cpu_avg` 0.5446 → 0.5575 (within burst-walk drift), `cpu_sd` 0.1166 → 0.1176
(identical to 3 d.p.), `cpu_n` per host 53,282 → 5,278. The SE grows √10 ≈
3.2× but stays an order of magnitude below the per-event noise floor for the
gRPC experiment's reducer mix (`avg`/`sum`/`min`/`max`/`count`/percentiles).

**The product framing:** "5× more stable cluster CPU baseline at the same
memory budget" beats "30% lower aggregator memory" as a roadmap pitch.

#### API shape

A new chainable operator on `LiveSeries`, `LivePartitionedSeries`, `LiveView`,
`LivePartitionedView`, `TimeSeries`, and `PartitionedTimeSeries`. Identity-on-
schema — `sample` doesn't transform row shape, just thins the stream:

```ts
live
  .partitionBy('host')
  .sample({ stride: 10 })
  .rolling('5m', { cpu_avg: 'avg', cpu_sd: 'stdev' }, { trigger });
```

Two strategy types — split by call-site:

```ts
// Live-side (all four call sites)
type SampleStrategy = { stride: number };

// Snapshot-side (both forms; no live-eviction concern)
type BatchSampleStrategy = { stride: number } | { reservoir: { size: number } };
```

`partitionBy(...).sample(...)` thins each partition's stream independently —
the canonical safe shape, recommended in the JSDoc on the pre-partition
sites. Snapshot-side `TimeSeries.sample` and `PartitionedTimeSeries.sample`
accept the broader `BatchSampleStrategy` since single-pass Algorithm R is
unaffected by the live-eviction protocol.

#### Strategy: stride (live + snapshot)

- Deterministic — keep events whose per-stream counter is a multiple of N
- O(1) per event, no RNG, no allocation
- Uniform-over-time: every moment's window is a uniform sample of events
- **Default for sliding-window stats** (rolling, aggregate, reduce-over-window)
- Plays cleanly with the existing prefix-eviction protocol (closure-counter
  inside `LiveView`)

#### Strategy: reservoir (snapshot-side only in v0.17.0)

Snapshot-side: single-pass Algorithm R over the known events array, sorted
by key on output. O(N) time, O(K) space, no eviction concern. Ships in
v0.17.0 as `TimeSeries.sample({reservoir: {size: K}})`.

- Approximately uniform K-subset of the snapshot's events
- Output is sorted by key (chronological invariant preserved)
- **Default for population-summary and visualization** —
  `series.sample({reservoir: {size: 500}}).toRows()` for a scatter plot is
  the canonical case: uncorrelated points (no regular-spacing artifact),
  fixed point count, no `aggregate(seq, ...)` collapse-to-grid
- `Math.random()` for v1; an optional `rng?: () => number` parameter for
  reproducible benchmarks / tests can land later if friction surfaces

**Live-side reservoir deferred to v0.18.0+** — the original Option A
"drift-on-eviction" design (Algorithm R + slot-refill on source evict) was
implemented and reviewed; Codex caught that Algorithm R's random-slot
replacement produces non-prefix evictions, which silently corrupt
downstream `LiveView`s mirroring eviction via cutoff. See "Deferred from
this wave" above for the dependency chain. The original Option A design
description is preserved here for the next implementation pass:

> Algorithm R for ingest: each new event has probability `K / seen` of
> replacing a random reservoir slot. On source eviction, if the evicted
> event is in the reservoir, remove that slot; the next arriving event
> refills deterministically. Approximately uniform K-subset of the
> source's currently-retained buffer; drifts slightly toward newer events
> under steady-state eviction.

Strict sliding-window uniform sampling (chain sampling, Babcock-Datar-Motwani)
is deferred indefinitely — Option A's drift is acceptable for streaming
statistics; the strict variant would need its own paper-citation review
and chain bookkeeping. Live-side will get Option A first, on top of the
`LiveChange` exact-removal channel.

#### The bias trap (documented in JSDoc, not gated by types)

The gRPC experiment's prototype shipped with a real bug: a single global
stride counter applied to a structured stream (round-robin host order) kept
the same 8 hosts every batch and dropped the other 72. Nothing in the
cluster headline noticed. The fix was per-host counters — exactly what
`partitionBy('host').sample(...)` does for free.

This is the **same multi-entity consideration** that already applies to
every stateful live operator — `rolling`, `aggregate`, `fill`, `diff`,
`rate`, `cumulative`, `pctChange`, `reduce` all silently mix data across
entities on a multi-entity stream unless scoped per-partition first. None
of those operators have a type-level partition-acknowledgment token; the
JSDoc warns and points users at `partitionBy(...)`. `sample` follows the
same convention:

```ts
class LiveSeries<S> {
  sample(strategy: SampleStrategy): LiveView<S>; // JSDoc warns about
  //                                                multi-entity bias
}

class LivePartitionedSeries<S, K, ByCol> {
  sample(strategy: SampleStrategy): LivePartitionedView<S, K, ByCol>;
  // safe by construction — each partition gets its own counter
}
```

An earlier iteration of this PR shipped a `GlobalSampleStrategy =
{ stride; unsafeGlobal: true }` type-level token, but the user pulled it
during review with the framing _"partitioning needs to be considered by
the user in many of our operators"_ — token-of-the-week consistency
beats per-operator novelty. The bias trap is captured in the
`LiveSeries.sample` / `LiveView.sample` JSDoc, the test file's
"bias-trap regression pin" doc-comment, and the `partitionBy().sample()`
recommendation chain in the example mappings.

#### Sample-rate metadata: Option A (observed-only)

Reducer outputs (`'count'`, `'sum'`, `'samples'`, `topN`) reflect what
actually flowed through the consumer. Users multiply by `1/sample_rate` to
estimate true counts. Library does not thread sample rate through reducer
state.

Documented in the docstring with a worked example:

```ts
// Estimating true count from sampled stream:
const sampled = live.partitionBy('host').sample({ stride: 10 });
const counts = sampled.rolling('1m', { events: 'count' });
// counts.value().events × 10 ≈ true count over the 1m window
```

`live.stats().ingested` and `live.on('batch', cb)` are upstream of any
`.sample(...)` op — they continue counting true throughput. Only consumers
downstream of `sample` see the thinned stream.

#### Snapshot-side parity

`TimeSeries.sample(strategy)` and `PartitionedTimeSeries.sample(strategy)`
ship for parity. Reservoir on a `TimeSeries` is materially simpler than on
a live source (single pass of Algorithm R over the known events array, no
eviction concern, no Set bookkeeping). `series.sample(...).toRows()` is the
canonical visualization path.

#### Per-partition state

`partitionBy(...).sample({stride: N})` holds an independent stride counter
per partition, not a single shared counter (which would re-introduce the
bias trap on a multi-host stream). Same factory-per-partition pattern that
`partitionBy(...).rolling(...)` already uses — each partition's `LiveView`
owns its closure.

Once live-side reservoir lands (v0.18.0+ on top of `LiveChange`),
`partitionBy(...).sample({reservoir: {size: K}})` will hold a K-event
reservoir per partition. For the gRPC experiment's 80 partitions × K=100,
that's 8000 events of reservoir state — bounded, predictable.

#### Use-case mapping

| Use case                                         | Stride                      | Reservoir                                   |
| ------------------------------------------------ | --------------------------- | ------------------------------------------- |
| Sliding-window stats (rolling avg / percentiles) | ✅ default                  | n/a (live) — ⚠️ drift (live, post-v0.18.0+) |
| Population summary over the retained buffer      | ⚠️ rolling-only             | ✅ snapshot                                 |
| Visualization (scatter plot, sparkline samples)  | ⚠️ regular-spacing artifact | ✅ snapshot default                         |
| Top-K / unique reducers                          | ❌ misses singletons        | ⚠️ also misses, with extra randomness       |
| `live.reduce()` over buffer-as-window            | ✅ uniform-over-time        | n/a (live)                                  |

Picking the wrong strategy is the highest-leverage bug the docs can prevent;
this table belongs in the operator's JSDoc verbatim. v0.17.0 lands the
live "stride" column and the snapshot "reservoir" column; the live
"reservoir" column rolls in with v0.18.0+ milestone A.

#### Composability

Composes cleanly with the rest of the live operator surface — the
`LiveView` return type means filter/rolling/reduce/select/map/diff/rate/
fill/cumulative all chain naturally downstream of `.sample(...)`:

```ts
// rolling — primary case from the gRPC experiment
live.partitionBy('host').sample({ stride: 10 }).rolling('5m', mapping);

// pre-partition stride feeding rolling (v0.17.0 PR #129 chainability fix)
live.sample({ stride: 10 }).rolling(5, mapping);

// pre-partition stride feeding filter — chainable surface available
live.sample({ stride: 10 }).filter(predicate);

// buffer-as-window — also valid
live
  .partitionBy('host')
  .apply((sub) => sub.sample({ stride: 10 }).reduce(mapping));

// snapshot-side visualization
series.sample({ reservoir: { size: 500 } }).toRows();
```

#### Implementation scope (as shipped)

- **Live-side stride:** ~30-LoC `makeStrideSampleView` helper in
  `LiveView.ts` + four call-site methods (`LiveSeries.sample`,
  `LiveView.sample`, `LivePartitionedSeries.sample`,
  `LivePartitionedView.sample`) each ~3 lines.
- **Snapshot-side stride + reservoir:** ~30 LoC inline in
  `TimeSeries.sample`, plus per-partition delegation in
  `PartitionedTimeSeries.sample`.
- **Strategy types:** `src/sample.ts` (~80 LoC of types + JSDoc explaining
  why live reservoir is deferred).
- **Tests:** 23 runtime tests in `test/LiveSample.test.ts` covering stride
  determinism, eviction tracking, per-partition isolation, the bias-trap
  regression pin, composability with rolling, snapshot reservoir
  approximate-uniformity (statistical pin: 4σ × ≥18-of-20 trials), and
  type-level `@ts-expect-error` pins in `test-d/live-sample.test-d.ts`.
- **Two-pass review:** Layer 2 (Claude) + Codex adversarial. Codex
  caught the live-reservoir non-prefix-eviction protocol violation that
  drove the simplification described above. Both reviews are durable on
  PR #129.

#### Forward dependencies

The shipped v0.17.0 scope (live stride + snapshot stride/reservoir)
doesn't depend on Phase 4.5 — it's a current-shape transform built on the
existing `LiveView` infrastructure (closure-counter + the standard
`EMITS_EVICT` cutoff-based prefix-eviction protocol). Lands standalone,
before milestone A starts.

**Live-side reservoir DOES depend on Phase 4.5 milestone A.** The
non-prefix eviction problem only resolves once the streaming RFC's
`LiveChange` model gives us an exact-removal channel
(`{ kind: 'replace' | 'remove', target: EventId }`). Until then, the
existing `'evict'` channel can only carry prefix evictions consistently.
This pins the v0.18.0+ wave order: milestone A first, then live-side
reservoir as a follow-up PR landing on top.

The stride form is independent of v0.18.0+ milestone B/C/D — it's a
stream-content transform, not a state or finality transform. Sampled
streams flow through the future `LiveChange` model unchanged: dropped
events simply don't appear as `kind: 'append'` in the downstream change
stream.

### Shipped: `rolling.sample(sequence)` — sequence-triggered rolling snapshot (v0.11.8, superseded by v0.12 triggers)

> **Status note (2026-05-01):** `.sample()` and
> `LiveSequenceRollingAggregation` shipped in v0.11.8 and were deleted
> in v0.12.0. The use case is preserved as
> `live.rolling('1m', m, { trigger: Trigger.clock(seq) })` — same
> emission semantics, no separate class. Migration is a one-line
> change in the webapp telemetry track. The design history below is
> retained because the reasoning ("composition, not fusion") still
> applies and informed the v0.12 trigger factoring.

A frontend telemetry use case (collect latency events at high rate,
report p95 to a backend every 30 s, also display it live in the UI)
surfaced a gap. `LiveRollingAggregation` emits per source event — too
noisy for backend reporting. The batch layer has
`series.rolling(Sequence.every('30s'), '1m', mapping)` for the
"sampled rolling" shape, but the live layer didn't.

`rolling.sample(sequence)` fills it without conflating two operations:

```ts
const rolling = timings.rolling('1m', { latency: 'p95' });

// Backend report every 30 s of event time
const reported = rolling.sample(Sequence.every('30s'));
reported.on('event', (e) =>
  fetch('/api/telemetry', { method: 'POST', body: JSON.stringify(e.data()) }),
);

// Same rolling drives the in-app display, no duplicated state
useLiveQuery(timings, () => rolling.value());
```

**Design decisions:**

- **Composition, not overload.** An earlier iteration tried a
  `live.rolling(Sequence, '1m', mapping)` overload mirroring the batch
  shape exactly. The implementation revealed the misfit: the overload
  had to allocate a hidden inner rolling and track ownership with an
  `ownsRolling` flag to avoid leaking source subscriptions on dispose,
  and the hidden rolling locked away state the user might want to read
  directly (the in-app display case). Keeping the two operations
  separate — `live.rolling(...)` returns a rolling, `rolling.sample(seq)`
  taps it for sequence-triggered snapshots — gives the user one
  reference per concern with no hidden ownership.
- **Honest naming.** "sample" describes what the operation actually
  does (snapshot at sequence boundaries), versus "rolling" which would
  imply a dense grid the live emission doesn't deliver.
- **Data-driven, not timer-driven.** Emission happens when source
  events cross an epoch-aligned boundary. If no events arrive during
  an interval, no event is emitted. Consistent with "data is the
  clock"; no `setInterval` inside the library.
- **Independent lifetimes.** `sample.dispose()` only detaches the
  sampler from the rolling. `rolling.dispose()` is the user's
  responsibility. One rolling can power multiple downstream consumers
  (multiple `.sample()` cadences for different reporting endpoints,
  plus direct `rolling.value()` reads) without coupling.
- **`LiveSequenceRollingAggregation` is a full `LiveSource`.**
  Implements `name`, `schema`, `length`, `at()`, `on('event')`.
  Supports the same view-transform set as `LiveRollingAggregation`
  (filter, map, select, window, diff, rate, pctChange, fill,
  cumulative, rolling, aggregate) for downstream chaining.
- **Output is time-keyed** at epoch-aligned boundaries (e.g.
  `Sequence.every('30s')` → 0, 30 000, 60 000 … ms).
- **Snapshot timing.** `rolling.value()` is read after the
  boundary-crossing event has been ingested by the rolling, so the
  emitted aggregate includes that event's contribution.

### Deferred from this wave

- **Cheap-sampling primitive on `LiveSeries` / `LiveView`** —
  considered and **deliberately not generalized as `.sample()`**. The
  rolling version of `.sample()` snapshots a stateful aggregate
  (`rolling.value()`) at boundaries; a raw `LiveSeries` has no such
  state — the operation would be "emit the most-recent event in each
  bucket" or "emit every Nth event," both of which are inherently
  lossy. Reusing the `.sample()` verb would conflate two different
  operations: principled-aggregate-snapshot vs cheap-stream-thinning.

  If a real use case appears (debugging firehose streams, prototype
  back-pressure relief, ad-hoc data reduction without an aggregation
  decision), it warrants its own primitive with an honest name —
  candidates like `.lastPerBucket(sequence)`, `.throttle(sequence)`,
  or `.everyNth(n)` telegraph "this is lossy by design." The
  asymmetry of `.sample()` only existing on `LiveRollingAggregation`
  is therefore intentional, not a gap to be filled.

  The principled answer for almost any real reporting / dashboarding
  use case is the path that already shipped:
  `live.rolling(...).sample(seq)` — make a deliberate aggregation
  decision, then emit the reduced result at intervals.

- **`AggregateOutputMap` overload on `LiveSeries.rolling()`** —
  **shipped in v0.13.0.** The batch `series.rolling()` accepted both
  `AggregateMap<S>` (`{ existingCol: reducer }`) and
  `AggregateOutputMap<S>` (`{ alias: { from, using } }`); live
  rolling/aggregate now do too. The runtime helper
  (`normalizeAggregateColumns`) was already doing the work for batch
  — extracted to `aggregate-columns.ts` and threaded through the
  three live accumulators (`LiveRollingAggregation`,
  `LiveAggregation`, `LivePartitionedSyncRolling`) plus the public
  surface (`LiveSeries`, `LiveView`, `LivePartitionedSeries`,
  `LivePartitionedView`, plus the chainable `LiveAggregation.rolling`
  / `LiveRollingAggregation.aggregate`). Custom-function reducers
  remain batch-only — guarded at construction with a clear error
  pointing at the alias workaround. The telemetry recipe's "want
  multiple percentiles?" section was rewritten around the
  single-pass `{ p50, p95, p99 }` pattern.

- **`live.rolling(Sequence, ...)` overload.** Not coming back. The
  composition form (`live.rolling(...).sample(seq)`) is clearer about
  what's happening and avoids the hidden-ownership / leaked-listener
  footgun the overload required. Captured in the closed PR #92 as a
  deliberate blind alley.

- **`Trigger.every(duration)` sugar — shipped in v0.13.1.** Codex
  feedback after adopting v0.12 triggers in the production webapp
  telemetry app: `Trigger.clock(Sequence.every('30s'))` is "ceremony-
  heavy for the common case." Sugar added as a one-line wrapper that
  forwards `(duration, { anchor })` to `Sequence.every` internally.
  The explicit `Trigger.clock(seq)` form remains for callers who
  already hold a `Sequence` object (e.g. one shared across batch
  `series.aggregate(seq, ...)` and live triggers) — `Trigger.every`
  always builds a fresh `Sequence`. Telemetry recipe + live-transforms
  doc updated to lead with the sugar form.

- **`Trigger.clock` naming wrinkle — deferred.** Codex flagged the
  same v0.12 retrospective: "the word `clock` made me briefly expect
  wall-clock timers." Docs cleared up the data-driven semantics in
  seconds, so the friction is real but mild. Considered renaming to
  `Trigger.boundary(seq)` or `Trigger.sequence(seq)` for semantic
  precision. Held for two reasons: (1) one signal isn't enough to
  pay the migration cost across an in-flight RFC, two active
  experiments, and existing tests/CHANGELOG/docs; (2) a wall-clock
  trigger may eventually be a real ask, in which case `Trigger.clock`
  becomes a natural umbrella with `Trigger.eventClock` (current data-
  driven behaviour) vs `Trigger.wallClock` (timer-driven). Revisit if
  a second user reports the same naming friction OR if a wall-clock
  trigger lands and the umbrella naming becomes the deciding factor.

- **`Trigger.count(n)` — shipped in v0.13.2.** Second wave of Codex
  feedback after webapp-telemetry adoption. Use case: "very hot
  metrics like row stale times or handler payload sizes where event-
  time boundaries may lag during bursts, but per-event is too noisy."
  Implementation is a counter on `LiveRollingAggregation` plus a
  `case 'count'` branch in the trigger switch — `event` and `clock`
  remain unchanged. Per-partition rollings get count emission
  independently; synced partitioned rolling
  (`LivePartitionedSyncRolling`) doesn't support count because count
  semantics across partitions are ambiguous (per-partition? global?)
  and there's no killer use case for either.

- **Fused multi-window rolling — SHIPPED v0.15.0 (2026-05-05).**
  The keyed-form `live.rolling({ '1m': m1, '200ms': m2 }, opts)`
  primitive is live on `LiveSeries`, `LiveView`, and
  `LivePartitionedSeries` — a single ingest pass over a shared
  deque, single trigger, one merged output event per boundary.
  Two new classes (`LiveFusedRolling`,
  `LivePartitionedFusedRolling`); type-level surface
  (`FusedMapping`, `FusedRollingSchema`,
  `FusedPartitionedRollingSchema`, `DurationString`) exported.

  Bench against gRPC RFC #20 acceptance criteria
  (`packages/core/scripts/perf-fused-rolling.mjs`):
  - Partitioned 100 hosts, 100k events: fused vs two-rollings =
    **−27.9% wall, −29.0% heap**.
  - Partitioned 1000 hosts saturation: **−31.8% wall, −44.5% heap**.
  - Fused vs single-rolling baseline: +16.8% wall, +4.0% heap
    (the small constant overhead of an extra window's reducer
    state).

  The architectural cliff is closed; gRPC experiment can migrate
  V7 → V8 with one ingest pass. Test surface: 24 runtime tests
  (single-window equivalence + multi-window + partitioned + types)
  - type-d block. All pass; full suite green at 1111 + 55.

  **Validated by gRPC experiment V8 (pond-grpc-experiment#22,
  2026-05-05).** Same-day migration; V8 is a **strict improvement
  over V6 across every measured load point** — not just a V7
  recovery:

  | Config           | V6 heap | V7 heap | V8 heap | V8 vs V6 |
  | ---------------- | ------- | ------- | ------- | -------- |
  | 9k/s             | 161 MB  | 147 MB  | 132 MB  | **−18%** |
  | 87k/s            | 1617 MB | 1886 MB | 1217 MB | **−25%** |
  | 92k/s × 1k hosts | 1379 MB | 1426 MB | 1263 MB | **−8%**  |
  | Ceiling tput     | 258k/s  | 209k/s  | 284k/s  | **+10%** |

  All three RFC #20 acceptance criteria met and surpassed.
  End-to-end p99 latency at 87k/s: **0.71ms (V7) → 0.16ms (V8)**
  — 4.4× improvement, the shared per-event ingest doing
  measurable work. This closes the architectural cliff the V6→V7
  profile-diff exposed.

  **Second validation axis — reducer cardinality
  (pond-grpc-experiment#25, M3.5 step 5).** The first axis
  (N windows) was pinned by pond's bench at N=2..5 (constant
  ~100ms wall, win compounding). Step 5 added three more
  reducers (`requests_avg`/`sum`/`count`) to the same 1m window
  in the gRPC aggregator — same window, +75% reducer count.
  Cost: **+5-11% heap, −3% throughput** (4 → 7 reducers); still
  beats V6 baseline at most load points despite doing 2× the
  reducer work. Confirms that adding reducers within an existing
  window doesn't add per-event pipeline overhead — only the
  unavoidable per-reducer state work, which separate rollings
  pay too. Both axes (window count + reducer cardinality) of the
  primitive's compose-for-free claim are now empirically grounded.

  **Deferred to follow-ups (logged here for the future-reader):**
  - **`live.reduce(mapping)` sugar.** `'buffer'` sentinel is in
    the type but throws at runtime. Lands with the buffer-as-
    window Tier 1 PR. (gRPC V8 noticed the sentinel-in-types
    surprise — confirmed as known gap.)
  - **`TimeSeries.rolling` snapshot-side parity.** Live-side only
    in v0.15.0.
  - **Path A** (share `LiveSeries` buffer when `longest_window ≤
retention`). Currently Path B (own deque); same API, perf
    follow-up.
  - **SHIPPED v0.16.0: compile-time uniqueness check** on fused
    output columns. `FusedMappingValid<FM>` resolves to a branded
    `__FUSED_ROLLING_ERROR` type when two windows declare the same
    output column name; the call site fails with a message naming
    the conflicting column. Wired into `LiveSeries.rolling`,
    `LiveView.rolling`, and both `LivePartitionedSeries.rolling`
    overloads. Pinned in `test-d/fused-rolling.test-d.ts`.
  - **Tighter `DurationString` template-literal type — DEFERRED.**
    Investigated in v0.16.0 development: a fully-recursive integer-
    only template hits TS's "circularly references itself" error,
    and a bounded union (10^N digit strings up to N=12) hits "union
    type is too complex to represent" past ~5 digits. The current
    `${number}${unit}` already rejects non-numeric prefixes
    (`'1min'`, `'abch'` fail); fractional / negative / exponential
    shapes (`'1.5m'`, `'-1m'`, `'1e3m'`) pass at the type level but
    fail runtime parsing. Documented in `utils/duration.ts` JSDoc
    so future readers don't re-attempt the bounded-union dead end.
    Revisit only if a user lands on this with concrete friction.
  - **`partitionBy` partition-column literal narrowing —
    SHIPPED v0.15.1 (2026-05-05).** gRPC V8 found that
    `live.partitionBy('host').rolling({...})` widened the
    partition-column type, with the V8 workaround
    `live.partitionBy<'host'>('host')` clobbering the value-type
    parameter K. v0.15.1 added `ByCol` as a third generic
    parameter on `LivePartitionedSeries<S, K, ByCol>` and
    `LivePartitionedView<SBase, R, K, ByCol>`, captured from the
    `by` argument; threaded through every per-partition method
    so chained pipelines (`partitionBy('host').fill(...).rolling(
{...})`) survive the narrowing. The workaround can drop;
    `partitionBy('host')` is now sufficient. type-d block
    extended to pin both root and chained narrowing.

  ***

  **Original design rationale (preserved for the historical
  record):** Two independent signals merged into one design. Tap-
  by-itself was overfitting to the gRPC use case; the fused form
  covers both gRPC and the buffer-as-window persona without
  hierarchy bookkeeping.

  **The two signals:**
  1. **gRPC profile-diff (PR #19, 2026-05-05).** Profile-grade
     evidence that V7's regression is the second
     `LivePartitionedSyncRolling`, not the `samples` reducer.
     Every per-event pond hop roughly doubled in inclusive time
     vs V6 (`#routeEvent` 15.0% → 28.9%, `ingest` 11.5% → 25.0%,
     `_pushTrustedEvents` 13.1% → 27.4%). The reducer itself is
     ~2.3% self-time; v0.14.3's allocation fix closed that leak.
     The architectural cost is doubled per-event ingest. Closing
     it needs a single ingest pass that updates multiple windowed
     reducer states.

  2. **Buffer-as-window persona (metric agent's call site).**
     `series.rolling(RETENTION, mapping, ...)` is the workaround
     when the buffer IS the window. The user has retention; they
     want stats over the buffer; they shouldn't have to declare a
     two-level structure (retention + a matched rolling window) to
     get there. `live.reduce(mapping)` covers the single-buffer
     case, but the broader pattern is "buffer + zero-or-more
     sub-windows." Same primitive answers both.

  **gRPC RFC #20 carry-forwards (2026-05-05).** Library-side RFC
  posted from the experiment side, in response to the design
  consolidation in PLAN. Pushes back on several details and
  refines others; outcomes carried into this entry below:
  - Drop the array-form escape hatch entirely; record form is the
    only fused-rolling API. Per-window options via elaborated
    value form (`{ mapping, minSamples }`) instead of dropping to
    array form.
  - Output shape is **ONE merged `LiveSource<Out>` stream**, not
    N accumulators or N streams. The collapse-to-one-event-handler
    win is half the value of the proposal.
  - Compile-time duplicate-column detection across windows via
    branded error type — strict improvement over status quo.
  - `DurationString` template-literal type for record keys —
    catches typos like `'1min'` at compile time.
  - Time-based windows only (count-based stays on the single-
    window overload).
  - Partition-column auto-injection unified across all windows.
  - Acceptance criteria pinned at hard perf targets.

  **The unified user-facing shape.** A `LiveSeries` with retention
  IS a buffer; the buffer IS the implicit longest window of any
  rolling computation attached to it. Declared sub-windows are
  tighter cursors into that buffer. Three APIs over the same
  machinery:

  ```ts
  // Single buffer (the buffer-as-window common case):
  const stats = live.reduce({ p95: 'p95', count: 'count' });

  // Single sub-window (today's shape; no change):
  const r = live.rolling('200ms', { samples: 'samples' });

  // Multi-window — keyed-record form (the fused primitive):
  const fused = live.rolling(
    {
      '1m': { cpu_avg: 'avg', cpu_sd: 'stdev', cpu_n: 'count' },
      '200ms': { cpu_samples: 'samples' },
    },
    { trigger },
  );
  ```

  User mental model is unified: "what windows do I want?" The
  buffer is just the longest one (clipped to retention; see below).
  All three APIs share the same trigger / output / event-subscriber
  surface — they're sugar over the same primitive.

  **Record form is the only fused-rolling API.** No array form.
  The earlier proposal to keep an array form as escape hatch for
  per-window options was rejected in the gRPC RFC for three
  reasons:
  - Strictly worse readability — three layers of nesting
    (`window:` / `output:` / individual columns) where two suffice.
  - Compile-time duplicate-column detection works naturally for
    the record form (objects can't have duplicate keys); is hard
    for the array form.
  - Per-window cadence (the main motivation for the array form)
    is rare; users who need it fall back to two `rolling()` calls
    and pay the V7 cost. Fused rolling explicitly trades that
    rare case for the simpler API in the common case.

  **Per-window options via elaborated value form.** When per-window
  options are needed (like `minSamples`), the record value
  switches from a bare mapping to a wrapper:

  ```ts
  byHost.rolling(
    {
      '1m': { cpu_avg: 'avg', cpu_sd: 'stdev' },
      '200ms': {
        mapping: { cpu_samples: 'samples' },
        minSamples: 5,
      },
    },
    { trigger },
  );
  ```

  Common path stays clean (value = mapping); elaborated form is
  used only when needed. Top-level options
  (`{ trigger, minSamples }`) apply as defaults across all
  windows; per-window elaborated `minSamples` overrides for that
  window.

  **Output shape — one merged stream.** Fused rolling emits ONE
  `LiveSource<Out>` with all windows' columns merged into one
  event per partition per trigger boundary. Not N accumulators;
  not N event streams. The whole point is that user code
  collapses to one event handler — V7's `pendingByTs` /
  `partsFor` / `tryEmit` machinery dissolves into:

  ```ts
  fused.on('event', (e) => {
    // All windows' columns on one event — no buffering, no drain.
    const tick = assembleTick(
      e.key().begin(),
      e.get('host'),
      {
        cpu_avg: e.get('cpu_avg'),
        cpu_sd: e.get('cpu_sd'),
        cpu_n: e.get('cpu_n'),
      },
      e.get('cpu_samples') ?? [],
    );
    scheduleFrame(tick);
  });
  ```

  See gRPC RFC #20's "Worked example" for the full V7 → V8 diff —
  ~30 lines of join/drain machinery (`pendingByTs`, `partsFor`,
  `tryEmit`, microtask scheduling) collapse to the handler above.
  Readability win is independent of the perf win and may be the
  larger of the two for typical users.

  **TypeScript surface.** Three things the type system needs to
  do:
  1. **Flat-merge per-window columns into one schema.** For each
     entry in the fused mapping, compute the per-window columns
     the way `RollingSchema` / `RollingOutputMapSchema` do today,
     then union all of them. Auto-inject the partition column
     once at the front (not per window).

  2. **Compile-time duplicate-column detection.** If two windows
     define the same output column name
     (`'1m': { cpu_avg: 'avg' }` plus `'5m': { cpu_avg: 'avg' }`),
     emit a `never` plus a branded error type at the call site:

     ```ts
     type CheckUniqueOutputs<FM> = /* duplicate detected */
       ? { __error: `Duplicate output column '${string}' across windows` }
       : FM;
     ```

     Strict improvement over the status quo, where two separate
     `rolling()` calls can silently shadow each other's column
     names.

  3. **`DurationString` template-literal type for keys.**
     Constrain object keys to `${number}${'ms'|'s'|'m'|'h'|'d'}`
     to catch typos like `'1min'` at compile time. The `'buffer'`
     sentinel is allowed alongside as a literal:

     ```ts
     type DurationString =
       | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`
       | 'buffer';

     type FusedMapping<S extends SeriesSchema> = Readonly<
       Record<DurationString, FusedMappingValue<S>>
     >;
     ```

  Substantive type-level work — non-trivial generics across the
  three responsibilities. Worth budgeting separately from the
  runtime implementation.

  **Time-based windows only.** Object keys are duration strings
  (or the `'buffer'` sentinel). Count-based windows
  (`live.rolling(100, ...)`) stay on the existing single-window
  overload and are not mixable with time-windows in the fused
  form. The window-clip-to-retention rule and the boundary-
  detection logic both depend on time semantics; mixing kinds
  isn't worth the complexity for a primitive whose target use
  cases (multi-window stats over a streaming buffer) are
  inherently time-shaped.

  **Partition-column auto-injection.** The existing partitioned-
  rolling overload auto-injects the partition column (e.g.
  `host`) into the output schema, even if the mapping doesn't
  name it. Fused does the same — partition column appears once
  at the front of the merged output, never per-window.

  If a window's mapping explicitly tries to name the partition
  column (`'1m': { host: 'first' }`), the existing collision check
  in `LivePartitionedSyncRolling` fires; fused preserves this
  guarantee across all windows. The merged output schema is
  `[time, partition_col, ...union_of_window_columns]`.

  **Snapshot-side parity.** `TimeSeries.rolling` should accept the
  same record-form keyed mapping. Less perf-critical (offline)
  but API parity matters for code that moves between live and
  snapshot mode (the gRPC experiment's V6 → V7 → fused migration
  is exactly this pattern). Implementation is simpler on the
  snapshot side (no trigger, no streaming dispatch); the
  TypeScript surface is shared.

  **Storage model.** One shared deque of `{ absIdx, ts, values }`,
  sized by the longest declared window. Each window holds:
  - `head: absIdx` — absolute event index of the oldest event still
    in this window's reducer state (monotonic across the rolling's
    life; survives deque compaction)
  - `reducerStates: RollingReducerState[]` — one per output column

  Per-event work:

  ```
  ingest(event):
    deque.push({ absIdx, ts, values })          # 1 append (was N)
    for window in windows:
      cutoff = event.ts - window.duration
      while getEntry(window.head).ts < cutoff:
        for col: col.state.remove(window.head, ...)
        window.head++
      for col in window.cols:
        col.state.add(event.absIdx, ...)
    deque.dropFrontTo(min(window.head for window in windows))
  ```

  Cost story matches the gRPC profile-diff:
  - `#routeEvent` / `_pushTrustedEvents` runs once instead of N →
    kills the V6→V7 doubled inclusive-time
  - Per-window add/remove cost unchanged (same as N rollings)
  - Shared deque storage → kills V7's +17% heap delta (the second
    rolling's per-bucket array state goes away)

  **Cursor representation: absolute event indices.** `head` is the
  absIdx of the oldest event still in the window. Stable across
  deque compaction (`deque.frontAbsIdx` translates absIdx → array
  position). Matches how `RollingReducerState.add(index, ...)`
  already takes an absolute index for `Map`-keyed remove.

  **Path A vs Path B — the buffer-as-window optimization.**

  If the longest declared window ≤ retention, the LiveSeries buffer
  already holds every event the fused rolling needs. The fused-
  rolling's own deque becomes redundant.

  | Path                            | Behavior                                                                     | Cost                                                                                                           |
  | ------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
  | **A** — share LiveSeries buffer | Fused holds only cursors + reducer state; events live once                   | Bigger refactor: fused needs read access into LiveSeries' deque shape; eviction wiring crosses module boundary |
  | **B** — own deque               | Fused subscribes via `'event'`, maintains its own deque alongside LiveSeries | Smaller change; same code shape as today's rolling. Events held twice when longest_window ≤ retention          |

  **Ship B first.** It gets the gRPC win immediately (single ingest
  pass eliminates the doubled per-event hop) and the API surface
  is identical to A. Path A is a buffer-as-window perf follow-up —
  a runtime optimization that's invisible to the user. Storage
  duplication at typical scale (~100 hosts × low-rate streams) is
  invisible; at saturation (1k partitions × kHz) it's measurable
  but not blocking.

  **Constraint: windows clip to retention.** When a declared window
  exceeds retention, the rolling reduces over whatever's currently
  retained. No fallback, no escape hatch — buffer-as-window users
  already accept this semantic by virtue of choosing retention as
  their bound. The rule is consistent: declaring a window through
  the fused form means "this is a sub-window of the buffer."

  Users who need exact-window semantics regardless of buffer size
  keep using today's-shape `live.rolling(window, mapping)` — that
  primitive maintains its own deque independent of LiveSeries
  retention and is preserved unchanged. The choice between fused
  and standalone-rolling becomes "are you a buffer-as-window user
  (fused, clipped) or do you want exact-window-no-matter-what
  (standalone)?"

  **Single-window equivalence — load-bearing pin.**
  `live.rolling(window, mapping, opts)` (today's shape) MUST
  produce identical output to `live.rolling([{ window, output:
mapping }], opts)` (fused with one entry). Tested explicitly.
  Otherwise the unification is incomplete — users would observe a
  silent behavior shift when adding a second window.

  **`live.reduce()` as fused-with-one-entry.** Design `live.reduce(
mapping, opts)` from the start as sugar for the fused form (record
  API) with the `'buffer'` sentinel:

  ```ts
  live.reduce(mapping, opts) ===
    live.rolling({ buffer: mapping }, { history: false, ...opts });
  ```

  Same trigger options, same `value()` shape, same event-subscriber
  surface. The `'buffer'` sentinel resolves to retention at
  construction. No API divergence; either Path A or Path B
  implements correctly.

  **Tap is a separate primitive — not subsumed by fused.** The
  earlier "tap as compositional sugar over fused-rolling" framing
  (where `parent.tap(w, m)` would add a sub-window to an existing
  rolling) is dropped. Once we accept the record form as the
  primary API, there's no compositional add-after-the-fact use
  case worth supporting — declare your windows up front in one
  call.

  However, the gRPC RFC #20 introduces `tap()` as a different
  primitive: a **per-partition observer callback** for slim
  observation use cases. See every event in a partition cheaply,
  no aggregation. Distinct problem, distinct solution; not a
  replacement for fused rolling. Captured as a separate companion
  entry below.

  **Tile-mode storage axis (preserved as alternative).** Fused-
  rolling stores raw events in the shared deque. For composable-
  reducer-only workloads (`avg`/`stdev`/`count`/`sum`/`min`/`max`),
  the deque could store fixed-duration tile summaries instead —
  `{ n, sum, sumSq, ts_start, ts_end }` per tile. 5m at 1s
  resolution = 300 tile entries vs ~150M raw events at 500k/s ×
  5m. Three orders of magnitude less storage; per-tile O(1)
  update.

  Tile mode is an alternative storage shape for fused-rolling; it
  applies when the reducer set is closed under associative summary.
  Defer until fused ships and we see the workload mix that
  motivates adding it. Sibling axis to "Path A vs Path B" — both
  are perf optimizations on the fused primitive, transparent to
  user-facing API.

  **Implementation rough estimate.**
  - New class `LiveFusedRolling<S, Out>` (single merged output
    schema): ~400-500 LoC for the runtime — shared deque, per-
    window cursors + reducer-state, fused `#evictPartition`,
    boundary-detection collapsing N triggers into one fan-out.
  - Type-level work — substantive generics across three
    responsibilities (flat-merge schemas, duplicate-column
    detection, `DurationString` constraint): ~150-200 lines of
    type aliases + helpers + tests in `test-d/`.
  - Public surface: keyed-form overload on `LiveSeries.rolling` /
    `LivePartitionedSeries.rolling` / `LiveView.rolling` /
    `TimeSeries.rolling` (snapshot-side parity).
  - `live.reduce(mapping)`: ~20 LoC of sugar over the keyed form.
  - Single-window equivalence test: today's-shape produces
    identical output to fused with one entry.
  - Multi-window correctness tests: ~200 LoC.
  - Partitioned variant tests: ~100 LoC.
  - Bench `perf-fused-rolling.mjs`: V6-vs-V7-style cost diff plus
    buffer-as-window storage footprint.

  Total ~1000-1200 LoC + tests + bench. Medium PR; not multi-week.

  **Acceptance criteria (from gRPC RFC #20).** When this lands,
  the experiment migrates `aggregate.ts` from V7 (two rollings +
  per-`(ts, host)` join) to V8 (fused rolling, single event
  handler). The bench bar:
  - Ceiling throughput within 5% of V6's 258k/s (V7 was 209k/s,
    −19%).
  - 87k/s heap close to V6's 1617 MB (V7 was 1886 MB, +17%).
  - 9k/s heap stays at or below V7's 147 MB.
  - `LivePartitionedSyncRolling.js` self-time drops back to
    ~8-10% range (V7 was 20.7%).
  - `#routeEvent` / `_pushTrustedEvents` / `ingest` inclusive
    times drop back to V6's range.
  - `#evictPartition` self-time drops to ~4-5% (V7 was 8.8%, NEW
    in V7's top-25).

  Not "exact V6 parity" — the perf budget is "fused rolling pays
  for the readability + correctness wins (compile-time uniqueness,
  one event handler) without measurable regression vs the manual-
  deque V6 baseline." Bench numbers are the load-bearing record;
  don't ship without the full diff in the PR body.

  **Open design questions to settle pre-ship.**
  - **Top-level vs per-window `minSamples`.** Top-level applies as
    a default; per-window elaborated form overrides for that
    window. Settled this way — matches the existing `minSamples`
    surface and avoids forcing every entry into the elaborated
    form when one window needs the override.

  - **Partitioned variant.** `live.partitionBy('host').rolling(
{...}, opts)` — one shared deque per partition, all windows
    over that partition's deque. At 1k partitions × 2 windows,
    fused saves the 1k duplicated deques V7 builds today.
    Per-partition partitioned variant uses the existing
    `LivePartitionedSyncRolling` machinery; the changes are in
    how it stores/iterates per-partition state to support multiple
    windows.

  - **Path A boundary case.** When `longest_window ≤ retention`
    changes at runtime (e.g., user mutates retention), Path A
    detects and degrades to Path B. Document explicitly. Most
    users won't change retention at runtime; the case worth
    handling is the construct-time choice.

  - **Custom-function reducers.** Same per-window O(W) snapshot
    cost as today's rolling; doc-note unchanged. Fused doesn't
    make this cheaper — per-event work is shared, but snapshot
    cost is per-window-per-emit and that's already what custom
    functions cost today.

  - **`window: 'buffer'` sentinel resolution.** When does it
    resolve — construct time (capture retention then; reject if
    retention later changes), or runtime (re-resolve every emit
    against current retention)? Lean construct-time + reject-on-
    change for predictability. If a user genuinely needs dynamic
    retention coupling, they declare `window: live.retention()`
    explicitly and we expose a method for it.

  - **Single trigger vs per-window trigger — closed.** Single
    trigger across all windows is by design; that's the point of
    fusion. Users who need per-window cadence fall back to two
    `rolling()` calls and pay the V7 cost. Rejected the array-
    form alternative.

  **Why ship.** Two distinct user signals (gRPC profile-diff +
  buffer-as-window metric-agent call site), one clean primitive
  design that covers both, fits the existing API surface as
  `rolling`'s array overload, shipping unblocks both the buffer-
  as-window release AND the gRPC saturation regime. The earlier
  parking rationale ("wait for second user") is satisfied by the
  two signals being independent — different agent, different
  experiment context, same primitive answers both.

  Reference workaround in the meantime: two separate `rolling()`
  calls off the same source, both with the same trigger.
  Documented in the eventual fused-rolling RFC as the "before-
  v0.X" pattern.

- **Companion: per-partition observer `tap()` (gRPC RFC #20,
  pending evaluation).** A separate primitive raised alongside
  the fused-rolling RFC. **Distinct problem from the earlier
  hierarchical-tap design** that was folded into fused-rolling
  above — this one is a per-partition observer callback for
  slim-observation use cases.

  Use case shape: "see every event in a partition cheaply, no
  aggregation." E.g., per-host event-rate gauges, per-host
  arrival-time histograms, debug instrumentation that doesn't
  need a windowed reducer. Today the only way to get per-
  partition events is `live.partitionBy('host').apply(sub =>
sub.rolling(...))` or `partitionBy.collect()` — both do more
  work than the use case needs.

  Sketch from the RFC:

  ```ts
  byHost.tap((host, event) => {
    // Observer fires once per (host, event) pair.
    // No aggregation, no buffer, no reducer state.
  });
  ```

  Pairs well with fused rolling (shared dispatch infrastructure
  on the per-event hot path) but doesn't subsume or get subsumed
  by it — different problems. RFC explicitly says fused-rolling
  is the higher-value of the two for the experiment's M3.5 step
  5+ roadmap; if only one ships first, fused goes first.

  **Status: pending evaluation.** Hold until fused-rolling lands
  (its design is settled; tap's design is one paragraph and a
  use case). Re-triage once fused ships and we have the dispatch
  infrastructure to share. May turn out to be a small bolt-on; may
  surface enough open questions to earn its own RFC. Don't pre-
  decide.

- **Reducer batching — deferred per the V4 bench.** The gRPC
  experiment's V4 profile (after v0.14.0 shipped) confirms
  `LivePartitionedSyncRolling.ingest` per-event reducer-state work
  (`stdev.add` / `avg.add` / Welford-style running stats) is the
  largest remaining hot spot at ceiling — 8.2% self time. Welford
  updates ARE associative, so an `addMany([values])` reducer
  interface that processes a contiguous run of events in one call
  is sound. But:
  - **Bench validates the user's earlier triage.** Production target
    on the experiment is 100k events/sec; V4 hits 256k/s (2.56×
    headroom). The remaining ceiling gap to V1 is real but doesn't
    block any working app.
  - **API surface impact is wide.** Every reducer (built-in + the
    custom-function path) would need an `addMany` variant; call
    sites in `LiveRollingAggregation` and `LivePartitionedSyncRolling`
    would need to detect "do I have a contiguous batch?" and route
    accordingly. Easy to get wrong; non-trivial to test.
  - **Real gain is narrow.** Welford batching only wins on bulk
    pushes (`pushMany` of N rows in one call). The streaming
    pattern — one event per network handler call — doesn't benefit.

  Revisit if (a) a second user reports ceiling-bound throughput as
  blocking, OR (b) the gRPC experiment's writeup ends up needing
  pond to claim parity with V1 on the saturation regime (it
  currently doesn't; the writeup's honesty section will say "for
  high-rate, custom aggregators win because they can amortise
  reducer state across batches that pond's primitives can't see
  is shareable"). Until then, parked.

  **Related opportunity (logged 2026-05-04):** when a user requests
  both `avg` and `stdev` on the same column, both reducers maintain
  `sum` and `count` independently — duplicated arithmetic on every
  event. Codex flagged this in the blind multi-window review.
  Smaller-scope than full reducer-batching; the fix is to detect
  the compatible-reducer pair at construction and share the
  lower-order moments. Worth measuring before designing — micro-
  bench a paired `avg + stdev` rolling against a single `stdev`
  (which already maintains both internally) to confirm the
  duplication cost is non-trivial. If yes, ~30-line opt-in fast
  path; if no, leave as-is. Independent of the bigger reducer-
  batching question.

- **Live rolling tactical fixes (logged 2026-05-04, expanded
  2026-05-05, not yet scheduled).** Operational items surfaced in
  Codex's blind multi-window review and the gRPC profile-diff
  (PR #19). Independent of any larger redesign — local fixes
  inside the live-rolling classes.
  - **`Array.shift()` eviction — SHIPPED v0.15.2 (2026-05-06).**
    The gRPC experiment's step 6
    (pond-grpc-experiment#26) escalated this from "tactical
    follow-up" to "shipping blocker" — they hit a 4× throughput
    regression (88k/s → 21k/s) when adding a non-partitioned
    `live.rolling({...}, { trigger })` next to the partitioned
    per-host one. The cliff is the same `Array.shift()` cost,
    just exposed by the firehose-rolling shape instead of the
    multi-second-window-many-evictions shape PLAN originally
    expected.

    All four call sites converted to the head-index pointer
    pattern + periodic batched compaction:
    - `LiveFusedRolling.#compactFront`
    - `LivePartitionedFusedRolling.#compactPartitionFront`
    - `LiveRollingAggregation.#removeFirst` / `#evict`
    - `LivePartitionedSyncRolling.#evictPartition` (time + count
      branches)

    Per-event eviction is now O(1) amortized at all deque sizes.
    Compact-batch threshold = 1024 stale entries (or half the
    array, whichever comes first); above either threshold, the
    deque splice-removes the dead prefix and resets the pointer.

    Bench (`packages/core/scripts/perf-fused-rolling.mjs`):
    worst-case shift pattern (50s window, 50k fill + 50k evict)
    drops 1123ms → 53ms — **21× faster** at the cliff. Steady-
    state deque without eviction is unchanged (V8's hidden-offset
    optimization already handled that well; the cliff was
    specific to large-deque + per-ingest-eviction).

    The agent's manual-counter workaround in `aggregate.ts` can
    now drop; non-partitioned `live.rolling` is viable at the
    rates the experiment cares about.

    **Validated end-to-end by gRPC step 6 follow-up
    (pond-grpc-experiment#26, same-day).** The agent re-enabled
    the natural API and benched it against their preserved
    manual-counter implementation:

    | Config       | Manual counter | Natural API (0.15.2) | Δ        |
    | ------------ | -------------- | -------------------- | -------- |
    | 87k/s heap   | 1278 MB        | 1460 MB              | +14%     |
    | Ceiling tput | 303k/s         | 257k/s               | **−15%** |
    | At 87k/s p99 | —              | 0.40 ms              | —        |

    The cliff is gone (21k/s → 89.9k/s sustained at 87k/s bench
    point — fully closed). The remaining ~15% throughput gap at
    ceiling vs the manual counter is the inherent abstraction
    cost: a rolling pipeline does push-to-deque + reducer-add +
    periodic snapshot per event, where a manual counter is just
    `count++`. That's not a cliff to chase — it's the expected
    constant-factor difference between "just track a number" and
    "maintain a windowed reducer." The agent shipped the natural
    API anyway: API symmetry with the partitioned variant; the
    gap falls in a regime (>100k/s single-stream) the dashboard
    doesn't reach.

    **Doc-worthy follow-up:** add a "manual counter vs rolling"
    note to the rolling reference. The rolling primitive is the
    right answer for sliding windowed reductions; for "I just
    need a cumulative counter or a tick-window delta," a manual
    counter off `live.on('batch')` remains strictly cheaper.
    Small docs entry; not blocking.

    **The framing this validates:** abstractions have a cost.
    We just don't want the cost to fall off a cliff. v0.15.2
    closes the cliff; the remaining 15% is the abstraction
    paying for itself.

  - **SHIPPED v0.16.0: `history: false | RetentionPolicy` on live
    rolling outputs.** Both `LiveRollingAggregation` and
    `LiveFusedRolling` accept the option. Default `true` preserves
    current behaviour; `false` skips the `outputEvents.push`
    entirely (so `length` stays 0 and `at(i)` returns `undefined`,
    while `'event'` listeners and `value()` still work);
    `{ maxEvents?, maxAge? }` mirrors `LiveSeries`'s existing
    retention shape. The accumulator's "skip allocation entirely
    when opted out" question resolved toward strict opt-out. 16
    dedicated tests in `packages/core/test/live-rolling-history.test.ts`.

    Original sketch (preserved for the historical record):

    ```ts
    live.rolling('1m', m, { history: false }); // no retention
    live.rolling('1m', m, { history: { maxEvents: 1000 } });
    live.rolling('1m', m, { history: { maxAge: '5m' } });
    ```

  Both are opportunistic — neither blocks any working app. Schedule
  alongside the next live-rolling perf pass or when the gRPC writeup
  earns a "what we'd fix next" footnote.

- **`'samples'` reducer + lifted custom-function restriction on
  live — queued for v0.14.1.** Surfaced by the gRPC experiment's
  step-4 (anomaly density). The use case: per-host per-200ms tick,
  count samples exceeding `k·σ` from the baseline mean for several
  `k` thresholds. Mean/stdev come from a 1m baseline rolling (works
  fine via `AggregateOutputMap`); the threshold counts need the
  **raw values** from a 200ms current-tick window. None of pond's
  built-ins yield "all values" — `unique` deduplicates, `top${N}`
  bounds, `keep` is the unique-or-undefined sentinel (and is
  pervasively misread to mean "keep all values" — the agent
  tripped on this).

  Custom-function reducers (`(values) => values.slice()`) cover
  the use case cleanly. Batch already accepts them; live rejects
  with a runtime TypeError pointing at AggregateOutputMap aliases,
  which don't actually solve "all values" either. Asymmetry the
  agent reasonably stumbled on.

  **Two related changes ship together in v0.14.1:**
  - **`'samples'` built-in reducer** — returns the window's values
    as an array. Library-implemented; no custom-function-on-hot-
    path concerns; sits beside `unique` and `top${N}` (same
    array-output kind, same type-system narrowing). `add` O(1),
    `remove` O(N) on eviction, `snapshot` O(N). Memory O(W) for
    window size W. Doc-note: "use on bounded windows."

    **Naming note (2026-05-02):** initially proposed as `'collect'`,
    renamed to `'samples'` to avoid collision with
    `LivePartitionedSeries.collect()` (already used to fan partitions
    back into a unified buffer). `'samples'` also reads naturally
    as a "subset of a population," which dovetails with the
    deferred parameterized form below.

  - **Lift the custom-function-reducer runtime guard on live
    rolling and live aggregation.** Document the perf characteristic
    instead of rejecting. Custom functions don't have incremental
    add/remove machinery — on live they re-run over the full
    window every event (O(W) per event vs O(1) for built-ins).
    For low-rate dashboards / debug aggregations / prototype
    pipelines the convenience matters more than the perf cliff;
    for high-rate use built-ins or `'collect'`. JSDoc on
    `LiveRollingAggregation` / `LiveAggregation` mapping options
    - a callout on the live transforms doc page telegraph the
      cost so callers make an informed choice.

  **Why both rather than just `'collect'`** (decision 2026-05-02
  during the docs phase): the batch-vs-live asymmetry is itself
  the friction. The agent assumed "same reducer shape on both,"
  hit the runtime guard, then had to find a different escape
  hatch. Cleaner to align the surface. Many real use cases gain
  ergonomic value from custom-function reducers; the perf cliff
  is real but documentable, not a footgun once telegraphed. The
  v0.14.1 patch closes both gaps in one motion.

  **Why deferred (vs ship-now):** the perf-doc story lands in the
  windowing concept page (DOCPLAN Wave 3.2). Better to ship the
  reducer + guard removal alongside the docs that explain the
  perf characteristic, rather than ship the API and then write
  the docs separately.

  Scope: ~50-80 lines for `'samples'` + tests, ~10 lines to drop
  the runtime guards in `LiveRollingAggregation` /
  `LiveAggregation` / `LivePartitionedSyncRolling`, ~20 lines of
  perf-doc prose.

  **Shipped 2026-05-03 as v0.14.1**, hotfixed same-day as v0.14.2
  to close a type-narrowing gap the Layer 2 review caught
  post-merge: `'samples'` was registered in the runtime registry
  but missing from `AggregateFunction`, `AggregateFunctionsForKind`,
  `AggregateKindForColumn`, `ArrayAggregateKind`, and
  `ReduceResult`. Build passed because `tsconfig.json` excludes
  `test/` and `npm run verify`'s `test:type` step uses
  `tsconfig.types.json` (covers `src` + `test-d/` only). v0.14.2
  added the missing entries plus a `test-d/types.test-d.ts` block
  pinning narrowing parity with `unique` / `top${N}`.

  **v0.14.3 — `samples.rollingState()` allocation fix
  (2026-05-04).** gRPC experiment V7 (all-pond pipeline using
  `samples()`) regressed throughput ~19% vs V6 (hybrid pond-
  rolling + manual deque) at the saturation regime (1k partitions
  × 1k events/s, 1M target: 209k/s vs 258k/s) and ran +17% heap
  at moderate loads. Two suspects:
  1. **Per-event 1-element `ScalarValue[]` allocations** in the
     rolling state's `add()` — wraps every scalar value in a
     fresh array even though `remove(index)` only needs the
     wrap when the source is array-kind (a single event
     contributing multiple scalars together).
  2. **Two full LiveRollingAggregation pipelines** (baseline +
     samples) where V6 had one rolling + one passive
     `array.push` listener — Map ops + reducer state + trigger
     dispatch + subscriber fan-out duplicated per pipeline.

  Suspect 1 is fixable in-pond and ships in v0.14.3: branch on
  `typeof v` in `add` to store scalars directly; only build a
  sub-array on array-kind sources; snapshot branches on
  `Array.isArray` to flatten the mixed map. Behavior preserved;
  all 15 existing `samples-reducer.test.ts` assertions pass
  unmodified.

  Bench (`packages/core/scripts/perf-samples-reducer.mjs`):
  focused micro-bench (5M scalar add+remove cycles) drops
  239.85ms → 209.09ms median (−12.8%). Integration scenarios
  (100k events × N hosts through full LiveSeries+partition
  pipeline) show tight wall-clock parity within run-to-run
  noise — allocation pressure isn't the dominant cost at that
  scale; the fix compounds at saturation regimes where GC
  pressure stacks. Heap-end snapshots (`process.memoryUsage`)
  are dominated by retained window state, not transient
  allocations, so the saturation-regime benefit isn't directly
  measurable in this script — the gRPC experiment's writeup is
  the load-bearing measurement, and v0.14.3 should narrow the
  V7-vs-V6 gap on heap pressure even if it doesn't close the
  throughput gap.

  **Suspect 2 (architectural cliff) is NOT chased in v0.14.3 —
  shipping addressed by fused-rolling.** Closing the V7-vs-V6
  throughput gap needs shared-buffer storage with single-ingest
  dispatch. At the kHz × 1k-partition saturation regime, V6's
  hybrid (one pond rolling for stats + manual deque for raw
  values) is genuinely the right architectural shape; pond's
  `samples` is for typical loads where the per-event pipeline
  overhead is invisible. v0.14.3 closes the per-event allocation
  leak; the architectural cliff needed a primitive design.

  **Profile-grade isolation (PR #19, 2026-05-05).** The gRPC
  agent's V6→V7 profile-diff confirmed the cost story is doubled
  per-event hop, not the `samples` reducer (which is fine, ~2.3%
  self-time). Inclusive-time deltas:
  - `LivePartitionedSeries.#routeEvent` 15.0% → 28.9% (+13.9 pp)
  - `LivePartitionedSyncRolling.ingest` 11.5% → 25.0% (+13.5 pp)
  - `LiveSeries._pushTrustedEvents` 13.1% → 27.4% (+14.3 pp)

  Every per-event pond hop roughly doubled. Single-ingest fused
  rolling closes this directly.

  **Two signals merged into the fused-rolling entry.** The V7
  profile-diff plus the buffer-as-window persona's metric-agent
  call site are independent signals (different agents, different
  experiments) pointing at the same primitive. Combined design
  is captured in the **Fused multi-window rolling + buffer-as-
  window unification** entry above. The earlier `tap()` framing
  (hierarchical parent/child) is preserved as compositional sugar
  on top; fused-rolling is the lower-level primitive that ships
  first.

- **CI safety-net widening — deferred.** v0.14.1 review surfaced
  that `npm run verify`'s `test:type` step doesn't run `tsc -p
tsconfig.vitest.json` (which covers `test/`). Vitest itself
  uses esbuild and strips types, so `npm run test:runtime` doesn't
  catch type errors in test files either. Net: a new public-API
  type entry can break user-facing call sites without `verify`
  failing.

  Fix path: add a `test:type:vitest` script that runs `tsc -p
tsconfig.vitest.json --noEmit`, wire it into `verify`. **Blocked
  by:** existing test files have ~30 unrelated type errors under
  the vitest tsconfig (mostly pushing `undefined` into required
  number columns without `as any` — patterns that work because
  vitest doesn't typecheck but would fail tsc). Cleaning those up
  is its own piece of work, ~half a day. Worth it because the next
  similar slip costs as much as v0.14.2 did to clean up.

- **`'samples(n)'` parameterized form — deferred.** Random thought
  during the v0.14.1 naming pass (2026-05-02): if `'samples'`
  reads as "subset of a population," then `samples(n)` could
  return a uniform random subsample of size `n` — useful for
  bounded-memory representations of large buckets.
  - **Batch:** straightforward reservoir sampling (Algorithm R).
    O(N) time, O(n) memory, classic.
  - **Live rolling:** harder. Reservoir sampling assumes each
    element is seen exactly once; a sliding window has elements
    _exiting_ too (the reservoir might hold an element that's
    just aged out). Sliding-window-reservoir algorithms exist
    (priority sampling with random keys, time-bucketed chunked
    sampling) but each has tradeoffs and adds real implementation
    complexity. Not a one-line addition.

  **Defer.** The default `samples()` (no arg = all values) covers
  every use case the experiments have surfaced. Revisit if a real
  user lands a "I need bounded-memory subsamples of high-cardinality
  windows" pattern.

- **Reducer composition / chaining — deferred RFC.** Same naming
  pass surfaced: it would be useful to chain `samples(20).avg()`
  to mean "subsample 20, then average." That's a two-stage
  reduction — reduce events to 20 values, then reduce those to 1.

  Pond's reducer registry today maps strings to single-stage
  reducers. Chaining means either parsing a string DSL
  (`'avg(samples(20))'`) or shifting the API toward composable
  reducer _objects_ (`avg.of(samples(20))` or
  `pipe(samples(20), avg)`). Both are RFC-shaped — they'd touch
  the reducer-registry contract, the type-system narrowing, and
  the AggregateOutputMap mapping shape.

  **Defer.** Custom-function reducers (shipping in v0.14.1) cover
  the same use case as one-liners today:
  `{ avgSample: { from: 'cpu', using: vals => avg(reservoir(vals, 20)) } }`.
  Lift composition into the registry only after we see two or
  three users hit the pattern frequently enough that the custom-
  function workaround feels like a workaround. Until then the
  custom-function form is the right escape hatch.

### RFC sketch: trigger taxonomy expansion (post-v0.13.2)

Surfaced by Codex feedback after adopting v0.12 triggers in the
production webapp telemetry app (2026-05-01, second wave). Codex
proposed five additional triggers; triage below distinguishes
mechanical extensions, the architectural design moment, and
misclassified asks.

**Mechanical extensions (low design cost):**

- **`Trigger.count(n)` — shipped in v0.13.2.** Captured above.

- **`Trigger.any(...)` — composition over single-axis triggers.**
  Killer use case from Codex:
  `Trigger.any(Trigger.every('30s'), Trigger.count(1000))` —
  "send every 30 s of event time, or sooner if 1000 events have
  arrived since the last fire." Bounds queue depth even when the
  time interval is long. Compositional shape — once count + every +
  idle exist as singletons, `any` is a thin coordinator.

  **Design wrinkle: reset semantics.** When one inner trigger fires
  inside an `any`, do the others reset?
  - For `count(N)`: yes — counter restarts after each fire so it
    measures "N events since the last emission," not "every Nth
    event modulo the input."
  - For `every(duration)`: no — the time grid is epoch-aligned, not
    last-fire-aligned. A reset would drift the boundaries.
  - For `idle(duration)`: yes — idle timer restarts on every fire
    (any fire, not just its own) and on every event arrival.

  Ship after the singletons exist; let real composite usage shape
  reset semantics rather than over-design upfront. v0.14.x candidate.

**Design moment (RFC required):**

- **`Trigger.idle(duration)` — wall-clock crossing.**
  Codex use case: scroll profiling. "User scrolls, events stream in,
  then the idle trigger flushes a final 'settled' snapshot." Real
  pattern, currently underserved — `Trigger.event()` is too noisy
  during the burst, `Trigger.every('500ms')` either misses the
  settle moment or fires uselessly during quiet periods.

  By definition, "fire after N ms of silence" can't be data-driven.
  No event arrives to consult; the trigger has to fire on the
  wall clock. Two architectural forks:

  a) **Accept wall-clock.** `setTimeout`-driven, only armed when a
  subscriber is attached. Ergonomic, real, but commits pond to a
  `setTimeout` dependency it has explicitly avoided through v0.12
  ("data-driven, no setInterval inside the library").

  b) **User-driven tap.** Pond exposes `rolling.checkIdle(now)` or
  similar; user wires their own `requestAnimationFrame` /
  `setTimeout`. Keeps the pure data-driven model but defeats the
  ergonomic promise — the user is now responsible for the tick
  loop.

  **Lean: (a).** Idle is fundamentally about _absence_, and absence
  isn't a data event. A user-side workaround re-implements the
  same `setTimeout` pond would have done, just less centrally. The
  ergonomic win for the targeted use case (interactive UIs, scroll
  profiling, debounce-on-quiet) is real.

  **What (a) commits us to:**
  - `setTimeout` inside the library (host-environment dependency)
  - Fake-timer test infra for deterministic tests
  - The `Trigger.clock` naming wrinkle becomes pressing — once
    pond has a wall-clock trigger, "clock" no longer means
    "data-driven boundary crossing" uniformly.

  **Likely naming reshuffle alongside `idle`:**
  - `Trigger.eventClock(seq)` — current `Trigger.clock` behaviour,
    fires on data-clock boundary crossing
  - `Trigger.wallClock(seq)` — future variant, fires on
    wall-clock boundary regardless of activity
  - `Trigger.idle(duration)` — wall-clock-driven, fires after N ms
    of silence
  - `Trigger.event()`, `Trigger.every(duration)`, `Trigger.count(n)`
    unchanged
  - `Trigger.clock` deprecated as ambiguous, redirected to
    `eventClock` for back-compat through one minor cycle

  This is the RFC moment. Decide: do we want `idle` enough to take
  on `setTimeout`, fake-timer infra, and the naming reshuffle? My
  read: yes — Codex's use case is well-specified and ergonomically
  hard to replicate user-side — but worth waiting for one more
  signal (a second user, or a real production blocker) before
  committing the design effort. v0.14 candidate; gate on signal
  strength.

**Decline / defer:**

- **`Trigger.threshold(column, predicate)` — misclassified.**
  Codex even hedged: "maybe this belongs as a filter after rolling
  rather than a trigger." Confirmed: it does. A trigger answers
  "_when_ do we emit?" uniformly across all output events; a
  threshold answers "_do we emit this event?_" — that's filter
  semantics. Already trivially expressible:
  `live.rolling(window, mapping, options).filter(e => e.get('current') > x)`.
  Document this answer in the trigger doc's "what about
  threshold-based emission?" section so the question doesn't
  re-surface.

- **`Trigger.manual()` / externally poked — sugar over existing.**
  The unload case is `addEventListener('beforeunload', () =>
post(rolling.value()))`. Debug export is `rolling.value()`.
  Reconnect-on-disconnect is the same pattern. If a real version
  ever earns its keep (multiple users hitting it), the right shape
  is `rolling.emit()` as an explicit method on the accumulator,
  not a trigger primitive — because there's no temporal predicate,
  just an imperative "fire one snapshot now." Defer until concrete
  signal.

### Shipped: Trigger as a first-class concept (v0.12.0)

> **Status note (2026-05-01):** the RFC below was approved and
> implemented as v0.12.0. RFC document at
> `docs/rfcs/triggers.md`. Two real users migrating: Codex on webapp
> telemetry, Claude on the gRPC experiment's M3.5 work. Their
> friction notes inform the final stable v0.12.0 release. The
> sketch is preserved for context.

### RFC sketch (approved, implemented): Trigger as a first-class concept

Surfaced by the gRPC experiment's M3.5 step-1 friction note (the
dashboard agent's [`WIRE.md`](https://github.com/pjm17971/pond-grpc-experiment/blob/m3.5-aggregate-wire-step-1/WIRE.md)
asked for synchronised tick aggregation across all partitions; pond
has no primitive for it). On reflection, the gap goes deeper than
"sample is missing one variant" — it's a factoring problem.

**The factoring.** Pond's live layer today carries trigger
semantics implicitly inside each accumulator type:

| Type                                       | Implicit trigger              |
| ------------------------------------------ | ----------------------------- |
| `LiveRollingAggregation`                   | event-driven (emits per push) |
| `LiveAggregation`                          | bucket-close-driven           |
| `LiveSequenceRollingAggregation` (v0.11.8) | sequence-crossing-driven      |

Three accumulators, three implicit triggers, no recombination.
"Rolling-window with count-trigger" or "bucketed with clock-trigger"
have nowhere to live. The sharper factoring is **Source × Trigger ×
Aggregation** — trigger as a first-class composable concept,
orthogonal to the aggregation choice.

**Settled design choices** (as of this RFC sketch):

- **Constructor-function form for triggers.** `Trigger.clock(seq)`,
  `Trigger.count(n)`, future `Trigger.custom(predicate)`. Avoids
  stringly-typed first args; type system narrows naturally; leaves
  room for additional trigger kinds without API churn.
- **Trigger attaches at the source level**, above `partitionBy`.
  All downstream accumulators inherit the trigger; partitions
  share one synchronised clock (which is the dashboard's
  motivating requirement). Shape:

  ```ts
  const ticks = live
    .triggerOn(Trigger.clock(Sequence.every('200ms')))
    .partitionBy('host')
    .rolling('1m', { cpu: 'avg', cpu_sd: 'stdev' });
  ```

- **`.sample()` (v0.11.8) will be removed pre-1.0.** Replaced by
  `live.triggerOn(Trigger.clock(seq)).rolling(...)`. The webapp
  telemetry agent migrates once. No backwards-compat sugar — pond
  prefers one way to do each thing, and pre-1.0 is the right time
  to fix this.

**Default trigger.** Without an explicit `triggerOn`, accumulators
keep their existing event-driven behavior (i.e. an implicit
`Trigger.event()`). Backward compatible for everything that doesn't
care about emission cadence.

**Filter/map/select stay per-event.** Triggers configure
_accumulator emission cadence_, not the entire chain. Stateless
transforms keep running on every event; only `rolling()` /
`aggregate()` / etc. observe the trigger when emitting.

**Open design questions for the M5 RFC:**

1. **What's the type of `live.triggerOn(...)` output?** A new
   `TriggeredLiveSource<S>` that wraps source + trigger? Same type
   with a phantom-tag generic? Decide based on what makes the
   downstream method signatures cleanest. Shouldn't leak into call
   sites the user writes.
2. **Trigger placement in the chain.** Source-level is the design
   decision; but where exactly? Before `partitionBy` was the
   user's framing. Should it also be expressible later
   (`partition.triggerOn(...)` for finer scoping)? Probably not —
   keep it at the source for synchronisation guarantees.
3. **Multiple triggers on the same source.** Two consumers want
   different cadences (e.g. backend report at 30s, dashboard at
   200ms). They'd each call `triggerOn` independently — does that
   produce two `TriggeredLiveSource` views, each driving its own
   downstream chain? Yes — same composition story as `LiveView`.
4. **Cross-trigger semantics: clock + count?** "Emit on clock, but
   no more than every 100 events." Compound triggers via
   `Trigger.any(...)` / `Trigger.all(...)` are a natural extension
   but speculative until needed.

**Sibling RFC item: delta-reducer family.** The dashboard's
`n_in_tick` ("samples since last emission") is a fundamentally
different statistic from rolling-window count — it requires
snapshot-aware state. Triggers alone don't solve it. Reducers like
`countSince`, `sumSince`, `firstSince`, `lastSince` track "what
arrived between my last emission and now" and report the delta. Has
to land in the same RFC because a tick-driven rolling that doesn't
expose `n_in_tick` is incomplete for the motivating use case.

**What this replaces:**

| Today                                                                                 | After                                                                                                |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `live.rolling('1m', m)`                                                               | `live.rolling('1m', m)` (unchanged; implicit `Trigger.event()`)                                      |
| `live.rolling('1m', m).sample(seq)`                                                   | `live.triggerOn(Trigger.clock(seq)).rolling('1m', m)`                                                |
| `live.partitionBy('host').rolling(...).toMap()` (per-host samplers, NOT synchronised) | `live.triggerOn(Trigger.clock(seq)).partitionBy('host').rolling(...)` (synchronised by construction) |

**What does NOT change:**

- `LiveAggregation` (sequence-bucketed with bucket-close emission)
  stays as-is. Its trigger semantics are different from
  `Trigger.clock` — it emits on bucket close, which is a
  conditional-on-watermark, not a per-N-time-units event. May fold
  into the trigger taxonomy as `Trigger.bucketClose(seq)` later;
  not in scope for first cut.

**Status:** RFC sketch only. No implementation work yet. The
gRPC experiment's `HostAggregator` workaround (M3.5 step 1) is
the right shape until this lands. The M5 extraction sweep should
absorb this design as a core-library proposal alongside the
`@pond-ts/server` / `useRemoteLiveSeries` / `@pond-ts/dev-producer`
RFCs. Three external surfaces + one internal factoring change is
the M5 scope to plan around.

Cite for context recovery: this RFC sketch was drafted in
conversation between the user and the pond-ts library agent (Claude)
on 2026-04-30, after the dashboard agent and gRPC experiment agent
collaborated on M3.5 step 1 (`pond-grpc-experiment` PR #11). The
factoring observation came out of asking "is `.sample()` overly
specific?" — yes, but the deeper problem is that trigger semantics
are baked into accumulator types instead of being orthogonal.

### Dropped from scope

- **`LiveRolling`**: covered by `LiveRollingAggregation` implementing `LiveSource` — the
  per-event output stream IS the rolling output.
- **`LiveSmooth`**: EMA is a stateful closure in `map()`. Moving average is
  `LiveRollingAggregation`-as-source with `'avg'`. LOESS is too expensive for per-event
  streaming.
- **`rename`/`collapse` views**: achievable with `map()`. Don't earn dedicated
  API surface in the live layer.

Definition of done:

- [x] stateful transforms use existing reducer infrastructure incrementally
- [x] stateless and stateful transforms compose cleanly
- [x] stateful transforms satisfy `LiveSource` for pipeline chaining
- [x] filtered/live aggregation pipelines are demonstrated in examples
- [x] snapshot vs closed/finalized semantics are explicit where relevant

---

## Phase 4.5: Streaming semantics

Status: not started.

Adoption of RFC phases 1–3 from
[`docs/rfcs/streaming.md`](docs/rfcs/streaming.md). The RFC is strategic
context developed across four contributors (original by pjm17971 + Codex,
review notes from the library agent, V2 + V3 amendments by Codex, use-case
agent feedback from the gRPC experiment). This section is the binding
adoption: phases 1–3 of the RFC become committed work, milestones A–D below.
RFC phases 4–7 (progress abstraction, replay/recovery, joins, async
operational polish) stay forward-looking and are explicitly not adopted
here — they will be revisited if and when use-case friction earns them.

Goal: turn the live layer into a deterministic streaming aggregation engine
with explicit time, lateness, finality, keyed state, and structured change
metadata. Preserve pond's data-clock-as-default identity; resist Beam and
operator-graph vocabulary; keep the chain-first user model.

Sequencing: this work lands BEFORE the Phase 6 ecosystem extraction
(`@pond-ts/server`, `@pond-ts/charts`). The server package's
WebSocket-snapshot-then-deltas pattern depends on milestones C (output
finality + wire-safe `AggregateEmission` + stable IDs) and the
emission-history snapshot work that's currently parked in RFC phase 5.
When the server extraction starts, emission-history can be pulled forward
from the RFC into PLAN as the friction signal arrives.

Validation: each milestone must be exercised by a use-case agent (the gRPC
experiment, a successor experiment, or the eventual server/charts package
work) before the design is considered settled. Per CLAUDE.md "Multi-agent
experiments and the feedback model," friction reports drive refinement; per
"Strategic RFCs," the RFC stays as context while PLAN entries are the
contract.

### Milestone A: Source-side change model

Goal: structured `LiveChange` discriminated union surfacing append vs
reorder vs evict on every `LiveSource`. Every later milestone depends on
this. The change stream is internal-first — public `on('change')` lands
only when the API is ready to commit; `on('event')` stays unchanged for
backward compat.

Type:

```ts
type LiveChange<S extends SeriesSchema> =
  | { kind: 'append'; event: EventForSchema<S>; index: number }
  | {
      kind: 'reorder';
      event: EventForSchema<S>;
      index: number;
      previousLatest: EventForSchema<S>;
    }
  | {
      kind: 'evict';
      events: readonly EventForSchema<S>[];
      reason: 'retention' | 'window' | 'clear';
    };
```

Required behavior:

- `LiveSeries.push` identifies append vs reorder; reorder reports the
  insertion index
- retention emits structured eviction changes
- `LiveView`, `LiveRollingAggregation`, `LiveAggregation`, `LiveReduce`,
  and partitioned live operators consume `LiveChange` internally
- existing `on('event')` listeners continue to fire for both append and
  reorder

Performance budget: per-event ingest within 5% of v0.16.1 baseline at
70k events/s, measured against the gRPC experiment's existing benches and
`packages/core/scripts/perf-*.mjs`. Bench numbers go in the commit message.

Dependencies: none. This is the foundational milestone.

Cross-reference: RFC milestone A; library agent review notes "Decisions
to pin before milestone A"; V3 "Operator changes are distinct from source
changes."

### Milestone B: Late repair via reducer capabilities

Goal: capability-based late-data repair, with reducer metadata declaring
what each reducer can correct cheaply.

New registry contract:

```ts
type ReducerCapabilities = {
  lateRepair: 'incremental' | 'recompute' | 'unsupported';
  serializable: boolean;
  emptyBucketIdentity?: ScalarValue;
};
```

Initial population: all built-in reducers declare `lateRepair`. The gRPC
experiment's reducer mix (`avg`, `sum`, `min`, `max`, `count`,
`samples`-deque, eventual t-digest) is 100% `'incremental'` per the
use-case feedback; that's the dominant case for production telemetry.
`'recompute'` and `'unsupported'` are escape hatches for custom function
reducers and reducers that can't safely correct.

Required behavior:

- `LiveRollingAggregation` and `LiveFusedRolling` repair affected windows
  on `kind: 'reorder'` events for `'incremental'` reducers
- `'recompute'` reducers re-evaluate the affected window; diagnostics
  expose how often it fires
- construction-time rejection: `ordering: 'reorder'` plus
  `lateRepair: 'unsupported'` throws unless the operator is configured
  with `late: 'append-only'`

`emptyBucketIdentity` and `serializable` are added as fields but consumed
later (by milestones C and the deferred RFC phase 5, respectively).

Dependencies: milestone A (`LiveChange` provides the reorder signal).

**Driver status (2026-05-11):** the gRPC experiment exercised pond's
late-data behaviour under controlled injection (see
[friction note M4](https://github.com/pjm17971/pond-grpc-experiment/blob/main/friction-notes/M4.md)).
Round-1 results suggested ~11% drift on the biased host, which a Codex
adversarial pass falsified — the `Math.random()` calls in the simulator
leaked through the round-1 methodology. Once every randomness source
was seeded across replicates, **drift collapsed to within noise on every
host** at the experiment's measurement style (last-tick `.value()` reads
over a 60s rolling window). Milestone B's library design is sound, but
the gRPC experiment's measurement style doesn't surface its payoff —
by the time the consumer reads `.value()`, all late events are already
in the buffer.

The cases that _would_ surface B's value (emission-stream consumers,
idempotent sinks via stable IDs, intermediate-tick reads, short-window
`cpu_sd`) aren't in the gRPC experiment's shape. Milestone B is
design-ready but **driver-light by empirical test**; sequencing it
should wait until a different consumer surfaces friction at one of
those measurement styles, or until milestone C's stable-ID + upsert
output mode makes "idempotent backend writer" a real consumer pattern.

Cross-reference: RFC milestone B; V2 "Late-repair cost model"; V3
"Reducer capabilities become the streaming registry contract."

### Milestone C: Output finality and stable IDs

Goal: explicit finality contract on aggregate output. `'append'` and
`'upsert'` modes; stable JSON-safe `AggregateEmission` shape; library-
specified output ID encoding so sinks can write idempotently. `'retract'`
mode is deferred.

Type:

```ts
type AggregateEmission<Value, Key = Record<string, ScalarValue>> = {
  kind: 'update' | 'final';
  id: string;
  key: Key;
  window: { start: number; end: number };
  value: Value;
};
```

Wire-safety rules: `id` is a string; `kind` is a string literal; `window`
fields are epoch milliseconds; `key` is a shallow scalar record; `value` is
JSON-encoding-safe (no `Date` / `Time` / `Interval` / function / class
instance / cyclic value). Reducers whose output isn't JSON-safe must
require a codec or be rejected for `AggregateEmission` output.

Output ID format: `pond:v1:<series>:<operator>:<key>:<windowStart>:<windowEnd>`,
each segment URI-component encoded. The `pond:v1:` prefix gives room to
change composite-key encoding later without pretending old IDs were
informal. Composite-key encoding for `keyBy(['host', 'region'])` is
explicitly deferred to post-v1.

Output mode behavior:

- `'append'` (default for back-compat): every emission is a new event;
  late corrections do not mutate prior outputs
- `'upsert'`: each output has a stable identity; `kind: 'update'` for
  open buckets, `kind: 'final'` exactly once per bucket; late data inside
  grace produces a replacement value with the same ID
- `'retract'`: deferred

Pinned semantics:

- empty buckets: do NOT emit `final` by default; opt-in via
  `emitEmpty: true`, which uses the reducer's `emptyBucketIdentity`
- grace zero: a bucket that closes on a boundary-crossing event emits one
  `final`, never `update` then `final` for the same ID in the same cycle
- `final` exactly once per output ID
- late-after-final default: `LateAfterFinalPolicy = 'drop'` with a
  diagnostic counter; `'error'` and `'correction'` are opt-in

`'append-only'` late mode definition:

```ts
type LateCorrectionMode = 'correct' | 'append-only';
```

`'correct'` repairs prior outputs; `'append-only'` skips correction and
allows the late event to flow through the operator's forward path
without producing `update` emissions for finalized IDs.

`LiveAggregation.grace` surface fix: `live.aggregate(sequence, mapping,
{ grace: '5s' })` now accepts the `grace` option directly. The constructor
path stays. Default remains source `graceWindowMs` when present; explicit
`grace` overrides. Closes a v0.16.0 surface gap surfaced during the stats
review.

Dependencies: milestone A (change-stream); milestone B (capability
registry — `emptyBucketIdentity` consumed here).

Cross-reference: RFC milestone C; V2 "Output finality decisions";
V3 "AggregateEmission is a wire-safe frame," "Stable output ID encoding,"
"`late: 'append-only'`."

### Milestone D: Keyed streaming aggregation

Goal: first-class `keyBy/window/aggregate` builder, distinct from
`partitionBy`. Per-key bucket state, per-key grace, stable per-key output
identity, and `keyTtl` for high-cardinality stability.

Public surface:

```ts
const ticks = live
  .keyBy('host')
  .window(Sequence.every('1m'), { grace: '5s' })
  .aggregate(
    { cpu: 'avg', latency: 'p95', requests: 'sum' },
    { output: 'upsert', keyTtl: '1h' },
  );
```

`keyBy` is a streaming-aggregation builder; `partitionBy` stays the per-
partition transform builder. Same partition-column machinery underneath,
different return types and mental models. Documentation must keep them
distinct so every example doesn't have to explain which mode it's in.

Required behavior:

- single-column keys for v1 (composite keys deferred — see RFC V3
  "Composite keys are explicitly post-v1")
- per-key isolated state, per-key open buckets
- per-key grace inheritance + override
- stable output identity = key + window
- quiet keys finalize when progress permits
- `keyTtl` measured against progress (not wall-clock); a key is eligible
  for eviction only after all of its windows are final; eviction emits an
  operator-side change

New operator-side change type, distinct from source-side `LiveChange`:

```ts
type OperatorChange =
  | {
      kind: 'key-evict';
      key: Record<string, ScalarValue>;
      reason: 'keyTtl';
      lastEventTime: number;
      progress: number;
    }
  | { kind: 'bucket-open'; id: string }
  | { kind: 'bucket-final'; id: string };
```

`OperatorChange` is diagnostic / control-plane. The data plane stays
`AggregateEmission`. This preserves the RFC V3 three-layer split:
`LiveChange` (source buffer), `OperatorChange` (operator state),
`AggregateEmission` (user-facing output frames).

Dependencies: milestone A (changes), B (capabilities), C (emissions).

Cross-reference: RFC milestone D; V2 "`keyBy` is distinct from
`partitionBy`," "Key retention"; V3 "Operator changes are distinct from
source changes."

### Out of scope (RFC phases 4–7 deferred)

Explicitly NOT adopted in this PLAN entry; these stay in
`docs/rfcs/streaming.md` as forward-looking context until use-case
friction earns them:

- **Phase 4 — Watermark / progress abstraction.** Data-clock progress
  is the current behavior and stays the default; manual / source progress
  modes wait until a use case forces them. Beam-style watermark holds
  are permanently deferred.
- **Phase 5 — Replay, snapshots, recovery.** Input-log replay,
  operator-state snapshots, reducer state serialization, and emission-
  history snapshots are all deferred. The server extraction (Phase 6)
  may pull emission-history forward when it's needed; that's a friction-
  driven decision.
- **Phase 6 — Streaming joins.** Bounded keyed joins and richer triggers
  (`Trigger.any`, idle / wall-clock triggers) wait until progress
  semantics settle.
- **Phase 7 — Operational polish.** Async fanout subscriber error policy,
  full operator metrics expansion (`live.stats()` is the seed),
  WebSocket adapter (lives in `@pond-ts/server`, not core), backpressure
  modes — all deferred.
- `'retract'` output mode.
- Composite-key output ID encoding (single-column keys only for v1).
- `maxKeys` eviction (time-based `keyTtl` is the v1 must-have).

### Forward dependencies on this milestone set

Phase 6 (Ecosystem and adapters) depends on milestones C and D landing
before the server / charts extraction. Specifically:

- `@pond-ts/server` extraction needs `AggregateEmission` (C) +
  `keyBy/window/aggregate` (D) + stable IDs (C) before its
  WS-snapshot-then-deltas pattern can be cleanly built. Emission-history
  (RFC phase 5) is the next dependency to pull forward when that
  extraction starts.
- `@pond-ts/charts` extraction needs `AggregateEmission`'s wire-safe shape
  (C) so chart inputs are JSON-safe streaming frames rather than
  experiment-specific protocols. The constraints captured in the existing
  `@pond-ts/charts` Phase 6 entry stay as the design input from the gRPC
  experiment's M3.5 friction.

### Release shape (tentative)

The RFC is explicit that the seven-phase scope is aspirational, not a
binding contract. For the adopted milestones A–D, a plausible release
shape:

- v0.17.0 — milestone A (`LiveChange` source-side, internal consumption,
  perf-budget commit)
- v0.18.0 — milestone B (capability registry + late repair on incremental
  reducers)
- v0.19.0 — milestone C (`AggregateEmission`, output IDs, `'append'` /
  `'upsert'` modes)
- v0.20.0 — milestone D (`keyBy/window/aggregate` builder + `keyTtl`)

Each release follows the existing two-pass review protocol (Layer 2
adversarial agent review + Codex pass) and is validated by at least one
use-case agent before merge. Release shape is tentative; if friction
reshapes the milestones, the version map adjusts.

**Sequencing addendum (2026-05-11):** Phase 4.7 (columnar core substrate)
is adopted as the v1.0 wave. Milestone A is foundational and ships
independently — `LiveChange` is small, no columnar dependency, and its
internal API is designed to carry columnar-batch updates once the
substrate exists. Milestones B, C, and D **wait for the columnar
substrate** so they ship natively on top, with operator state in
typed-array buffers rather than retrofitted later. The release shape
above adjusts accordingly: A continues toward v0.18.0; B/C/D defer to
post-Phase 4.7.

---

## Phase 4.7: Columnar core substrate (v1.0 wave)

Status: adopted 2026-05-11. Not started.

**Status update (2026-06-10)** — the framing below is the original adoption
note; for current ground-truth see the consultant assessment
([`docs/notes/columnar-arc-assessment-2026-06.md`](docs/notes/columnar-arc-assessment-2026-06.md),
against v0.20.0). **Shipped:** substrate (1a–1h), batch columnar-first intake,
reduce fast paths (3A: 59–73× numeric), **3B aggregate per-bucket** (#186/#187),
public column API (step 8), _conditional_ live chunked backing (step 7,
strict-time-keyed only), and the **first transforms + operator extraction**
(step 4: `select` #188, `rename` #189, `cumulative` #190 — the latter the first
op pulled into `batch/operators/`, establishing the template; `withRowRange`
substrate #191; `diff`/`rate`/`pctChange` #192). **The remaining middle of the
pipeline — the rest of the transforms and windowed rolling — is still
row-shaped.** Recommended remaining sequence (consultant §5, north-star-ranked),
with the shipped prefix struck through: ~~3B aggregate per-bucket~~ →
~~4 transforms + operator extraction~~ ✅ **COMPLETE** (cumulative #190,
diff/rate #192, fill #194, slice #195, mapColumns #196, shift #197, collapse;
`tail`/`filter` left as deferred judgment calls, event-based `map` permanently
out of scope) → **chart carry-forwards (next)** → 6 dict reducers → 5 planner →
3C rolling
(last; numerical risk stacks there).
Every step before 3C is zero-or-negative public surface. Live §A (column-native output) stays **friction-gated** — the
zero-copy arc was correctly killed by measurement (`perf-band-gather.mjs`).
Near-term items tracked as backlog tasks (3B, step 4 + extraction, row/columnar
parity suite, `toFloat64Array` carry-forward, bundle-budget re-pin). North
star: overall performance with a consistent, clear API surface — reducer speed
first ([columnar-live-protocol RFC Amendment V3](docs/rfcs/columnar-live-protocol.md)).

**Status update (2026-06-16, against v0.27.0) — the batch columnar wave is
COMPLETE.** Everything in the "recommended remaining sequence" above that lives
on the batch path has shipped. Since the 2026-06-10 note: columnar `timeRange()`
(#214, killed the cold-aggregate cliff), `first`/`last` columnar fast path
(#215) + columnar `partitionBy` split (#216) (the two v2-audit P1s #115/#116),
the principled non-finite reducer policy (#218), numerically-stable rolling
stdev via Welford order-independent delete (#222) + a standing differential
parity-fuzz suite (#223), the **columnar rolling _output_ path** (#225), and
**`byColumn` value-axis aggregation** (#227). Plus the v0.23 greenfield-polish
wave (#206–#211: stripped internal `EMITS_EVICT` from the `.d.ts`, `{ sort: true }`
intake, `at(-1)` parity, F1 type unify). There is no row-shaped middle left in
the batch pipeline that a consumer has flagged.

**The one label that confuses every reading of this roadmap:** "3C rolling"
above means the batch rolling **output** path — SHIPPED (#225). The
gRPC-rebench section below uses "Step 3 Phase C" for the _live_ rolling
**reducer** columnar state — still DEFERRED, unearned. Same number, different
layer.

**Live columnar is a different shape and a different bar.** It went columnar
only where a consumer's measured pain proved it pays, and it is at a defensible
**retention-boundary waypoint**, not an end-to-end rewrite — the originating
live problem (gRPC partition-retention OOM) is _solved_ (chunked backing +
column-native partition routing #175). Full state, batch-vs-live asymmetry, the
parked items + the measurement that parked each, and the one live correctness
loose end (reorder+retention windowed extrema, which belongs with the
robustness cluster #98/#99/#114, not the optimization queue) in the consultant
assessment
([`docs/notes/live-columnar-assessment-2026-06.md`](docs/notes/live-columnar-assessment-2026-06.md)).

This is the **v1.0 substrate**. Adoption decision documented in
[`docs/rfcs/columnar-core.md`](docs/rfcs/columnar-core.md) ("Library-agent
response and adoption" section); evidence base in
[`docs/briefs/core-columnar-store-spike.md`](docs/briefs/core-columnar-store-spike.md);
spike implementation on branch `codex/core-columnar-store-spike`
(PR #130, not for merge — kept as the Phase 3 implementation baseline).

**Goal: a foundational columnar framework that underpins pond-ts
internals, preserving the public event-shaped API.** Builds the
substrate that future streaming, charts, server, and ecosystem work
ride on top of. Future optimization doors (WASM reducer kernels,
WebGPU large scans, SIMD via wasm-simd, zero-copy Arrow export) stay
open for v1.x but are not committed for v1.0 itself.

**Strategic frame.** The columnar substrate is not a series of one-off
fast paths; it's a properly abstracted, independently-tested layer
that the rest of pond-ts is rebuilt on. The spike measured the wins
(numeric reduce 6–12×, memory under lazy event materialization 4×
reduction, chart extraction 34×); the strategic argument is timing —
do this before streaming-RFC milestones B/C/D land so they ship
natively on the substrate, not as retrofits of row-oriented internals.
See the RFC for the full argument.

**Locked-in commitments (from the RFC's "Library-agent response"):**

1. Columnar storage adopted broadly across internals (`TimeSeries`,
   derived series, `LiveSeries` ring buffers, the streaming change
   channel, chart `ChartDataSource`). Public APIs (Event, `at(i)`,
   `live.on('event')`, etc.) stay row-oriented at the boundary.
2. Framework as a foundational layer at `packages/core/src/columnar/`
   (or similar), independently tested, with its own bench suite.
   Apache Arrow-compatible concepts without Arrow runtime dependency.
3. Public API invariants preserved (the five from the RFC):
   `series.events === series.events`, `at(i)` reference stability,
   `at(i)` ↔ `events` consistency, `concat` event identity (preserved
   for events the source has materialized; under columnar the
   per-index cache propagates through concat — under today's
   eager-events shape every event is materialized so the guarantee
   is universal in practice; see V4 amendment for the tightened
   contract), event-shaped iteration. `series.at(i)`'s reference
   stability is the contractual stable-reference accessor; no new
   public API.
4. Phase 3 (derived transform chains) is part of the implementation,
   not a prerequisite gate. Implementation adjusts mid-stream if
   Phase 3 surfaces a deal-breaker; worst case is a narrower
   columnar scope (numeric scans + chart extraction + live numeric
   rolling) with row-backed paths for transform chains.
5. String / dictionary reducer adaptation in v1.0 wave (`unique`,
   `top`, `samples`, grouped `count` over dictionary-encoded
   columns).
6. `LiveSeries` columnar ring buffer in v1.0, scoped narrowly:
   numeric typed ring buffers for hot rolling windows + built-in
   reducers. Strings / custom reducers / array columns / mixed
   schemas stay event-backed inside the framework.
7. Aggregate planner: minimal fused planner; precompute bucket
   spans once, answer simple reducers from prefix sums/counts,
   fall back to event-walked path for non-decomposable operations.
8. Private fields on `TimeSeries` / `LiveSeries`, NOT WeakMap
   sidecars (the spike's shape is exploration-only).

**Implementation sequence (rough, ~3–4 months focused work):**

1. Framework layer (~6 weeks) — `Column<T>` interfaces,
   `Float64Column` / `BooleanColumn` / `DictionaryColumn` /
   `ArrayColumn` concrete impls, validity bitmaps, chunked columns,
   range-aware primitives. Independently tested. Bundle-size pin:
   `<25 KB` gzipped delta to pond-ts core.

   Sub-sequenced per
   [`docs/briefs/columnar-framework-design.md`](docs/briefs/columnar-framework-design.md).
   Per-sub-step status:
   - **1a — Float64Column, BooleanColumn, ValidityBitmap.** ✅
     Shipped (PR #132, merged 2026-05-13). 116 framework tests,
     bundle delta < 5 KB gzipped. Length validation
     (`MAX_COLUMN_LENGTH = 2**31 - 8`), packed validity bitmap with
     one-shot freeze that copies bits into an owned buffer,
     boundary tests on every public entry point. Two rounds of
     Codex adversarial review per the PR comment trail.
   - **1b — StringColumn (dict + fallback), DictionaryColumn ops.** ✅
     Shipped (PR #133, merged 2026-05-13). 210 framework tests
     (+94 from 1b's StringColumn surface). Constructor enforces:
     mutually exclusive dict/fallback modes; dictionary indices in
     range for valid cells; fallback no-validity invariant (every
     slot must be a string, else throw); explicit validity
     consistency. `scan` uses `''` as the missing-value sentinel
     for invalid rows in both modes (no divergence); validity-aware
     cross-dictionary `remapColumnToDictionary` for join paths.
     Four rounds of Codex adversarial review per the PR comment
     trail, each finding real issues; the contract surface ended
     up substantially more rigorous than the original draft.
   - **1c — ArrayColumn + KeyColumn (time / timeRange / interval),
     EventKey cache.** ✅ Shipped (PR #134, merged 2026-05-13).
     289 framework tests (+79 across ArrayColumn + KeyColumn).
     `ArrayColumn` (fallback mode) with defensive freeze on cells,
     `EMPTY_ARRAY_SENTINEL` for `scan(skipInvalid:false)`,
     element-wise `ArrayValue` contract enforcement. Three
     `KeyColumn` variants with lazy `Map<number, EventKey>` cache
     pinning `keyAt(i) === keyAt(i)`. `IntervalKeyColumn` supports
     discriminated label columns (`StringColumn | Float64Column`)
     for `IntervalValue = string | number` round-trip, with
     hardened runtime discriminator and per-row type/finite
     assertions. Three rounds of Codex adversarial review per
     the PR trail; each round closed real gaps.
   - **1d — ColumnarStore (read-only) + SeriesStore row-API
     adapter (Path B layering split).** ✅ Shipped (PR #135,
     merged 2026-05-13). 324 framework + adapter tests.

     **Architectural pivot mid-review.** The initial 1d shape had
     `ColumnarStore` materialize Events, manage the eventCache,
     and emit row-shape exports — framework-level code that knew
     about `Event` / `EventKey` / `Time` / `TimeRange` /
     `Interval`. Three rounds of review (L2 + 2 Codex) found
     correctness issues at the same surface (cache validation
     incomplete, key identity, kind-aware data equality, extra-
     /missing-fields leaks) because those concerns sit at the
     wrong layer.

     Pivoted to clean separation:

     **Pure framework** at `packages/core/src/columnar/`. Zero
     upstream imports (runtime or type). Owns its own type
     vocabulary at `columnar/types.ts` (`ColumnDef`,
     `ColumnSchema`, `ScalarValue`, `ArrayValue`, `KeyKind`).
     `ColumnarStore<S>` is schema-validated composition of
     `KeyColumn` + value columns + `valueAt`. Independence test
     scans every framework file for forbidden imports
     (`Event` / `Time` / `TimeRange` / `Interval` / `temporal` /
     `types` / operators).

     **Row-API adapter** at `packages/core/src/series-store.ts`.
     `SeriesStore<S>` wraps a `ColumnarStore` + optional
     eventCache. Owns `keyAt` / `eventAt` / `toEvents` /
     `Symbol.iterator` / `toRows` / `toObjects` + the five
     public-API invariants from the RFC. Structural cache
     validation: structural key equality via `EventKey.equals`,
     per-column data agreement, exact-schema field set (no
     extras OR missing fields), kind-aware value equality
     (`Object.is` for numbers so NaN matches itself, shallow
     element-wise for arrays so the `ArrayColumn` defensive freeze
     doesn't break cache sharing).

     Bundle: 17.2 KB framework + 4.0 KB adapter = 21.2 KB
     gzipped (under the framework-design <25 KB target).

     The split also surfaced what later sub-steps need to
     decide: row-shape intake factories (`fromValidatedRows`,
     `fromTrustedEvents`) belong at the `SeriesStore` layer; the
     framework's `ColumnBuilder` operates on column data.

   - **1e — `ColumnBuilder` primitives + `fromValidatedRows`
     row-intake.** ✅ Shipped (PR #136, merged 2026-05-13). 34
     builder tests + 11 row-intake tests. Framework adds Float64
     / Boolean / String / Array column builders with one-shot
     `finalize`, defensive copy at append for arrays, and
     amortized O(1) capacity doubling. Row-API adapter adds
     `SeriesStore.fromValidatedRows` that delegates to
     `validateAndNormalize`, walks events into builders, and
     pre-populates the eventCache so event identity survives
     intake. Two real bugs caught in review — both in the
     overwrite path: `#writeAt(rowIndex, undefined)` failing to
     clear the validity bit (L2), and defined→defined `appendAt`
     overwrite inflating `#definedCount` without a bitmap (Codex
     round 1). Both fixed with regression tests.
     Deferred follow-up (start of 1f or later): `fromTrustedEvents`
     (skip validation pass) and framework-level `fromBuilders`
     factory on `ColumnarStore` — both reuse the in-place
     `buildSeriesStoreFromEvents` helper.
   - **1f — Index views (`withRowSelection`, `materialize`) +
     zero-copy schema ops.** ✅ Shipped (PR #147, merged
     2026-05-27). 49 view tests; framework total ~370 tests.
     Five framework-level ops: `withRowSelection` (materializing
     gather via per-column `sliceByIndices`), `materialize`
     (identity for 1f; stable surface for the future lazy-view
     path), `withColumnsRenamed`, `withColumnReplaced`,
     `withColumnAppended`, `withColumnsSelected`. All three
     `KeyColumn` variants got `sliceByIndices(indices)` methods
     to support the gather path. Three rounds of review (L2 +
     Codex × 2) found real correctness gaps closed before merge:
     eager out-of-range index validation (silent epoch-row
     corruption under `withColumnsSelected([])`), unsafe column
     names (`__proto__` / `prototype` / `constructor` reserved
     centrally at `ColumnarStore.fromTrustedStore`), and
     inherited-Object-prototype names as rename-map keys
     (`renames[name]` walked `Object.prototype`; fixed with
     `hasOwnProperty.call`). The materializing-vs-lazy decision
     is documented; lazy view-mode columns are a future-doors
     optimization with the existing API as the stable surface.
   - **1g — Chunked value columns + `concatSorted` + `materialize`
     compaction.** ✅ Shipped (PR #148, merged 2026-05-25). 62
     framework tests after Codex round-1 fixes (42 `ChunkedColumn` - 20 `Concat`); framework total ~433 tests.
     Four chunked value-column variants
     (`ChunkedFloat64Column`, `ChunkedBooleanColumn`,
     `ChunkedStringColumn`, `ChunkedArrayColumn`) — each holds a
     `ReadonlyArray<Plain>` of chunks + `chunkOffsets: Int32Array`
     (prefix sum), eagerly computes an aggregate validity bitmap
     (preserving the "no bitmap ⇒ all defined" convention), and
     implements the shared `Column` interface
     (`read`/`scan`/`sliceByRange`/`sliceByIndices`). The `Column`
     union widens to include them; a new `storage: 'packed' |
'chunked'` secondary discriminator lets hot-path callers
     (reducers) narrow on `kind === 'number' && storage ===
'packed'` to dereference `Float64Column.values` etc.
     `sliceByRange` stays chunked across multi-chunk ranges
     (zero-copy on chunk boundaries) and collapses to plain
     within a single chunk; `sliceByIndices` always
     materializes (gather destroys chunk locality).
     `concatSorted(stores)` N-way concat over temporally-disjoint
     stores: validates schema structural equality, key disjointness
     (strict `<` for Time, half-open `<=` for TimeRange/Interval),
     materializes the key column (`begin`/`end`/labels — labels
     rebuilt via `stringColumnFromArray` so the dict-vs-fallback
     heuristic runs on the whole), and flattens nested chunked
     inputs so chunks always stay one level deep. `materialize`
     now does real work: walks each value column, compacts any
     chunked variants to their plain counterparts via dedicated
     `materializeChunked*` helpers, and returns the input
     unchanged when every column is already packed (identity
     fast-path).
   - **1h — `ColumnarRingBuffer` + `scatterByPartition`.** ✅
     Shipped (PR pending, branch `feat/columnar-step-1h`). 49 new
     framework tests (35 `ColumnarRingBuffer` + 14 `Scatter`);
     framework total ~482 tests.
     `ColumnarRingBuffer<S>` is a mutable, append-only circular
     buffer backing streaming sources. Circular indexing with
     `head` + `length` + `capacity`; logical row `i` lives at
     physical `(head + i) % capacity`. Per-column mutable storage
     for all four value kinds (Float64Array, bit-packed Uint8Array,
     `(string|undefined)[]`, `(ArrayValue|undefined)[]`) and all
     three key kinds (Time, TimeRange, Interval — the latter
     requires `intervalLabelKind: 'string' | 'number'` in options).
     `appendBatch(batch: ColumnarStore<S>)` validates schema
     structural equality and routes per-row writes through circular
     indexing. Lazy growth (default true) starts at
     `min(retention, 64)` and doubles to `retention`; eager mode
     pre-allocates. Eviction advances `head` once `length ===
retention`. Batches larger than `retention` keep only the
     trailing `retention` rows. `evictPrefix(n)` and `snapshot()`
     decouple the immutable view from ongoing append/evict — the
     snapshot owns fresh typed buffers and dict-rebuilds the
     string columns via `stringColumnFromArray` so encoding
     decisions run once on the snapshot window. The ring is
     **ordering-agnostic** (per RFC V4); strict/drop/reorder
     semantics live at the `LiveSeries` layer.
     `scatterByPartition(source, columnName)` partitions a store
     by a scalar value column, returning
     `Map<ScalarValue, ColumnarStore<S>>`. Rejects array-kind
     partition columns and the key column. Drops rows whose
     partition cell is undefined or `NaN` (the `NaN !== NaN`
     gotcha makes it useless as a Map key). Per-bucket sub-stores
     preserve schema and the input's relative row order;
     cross-bucket order is unspecified (it's a Map).

   **State after 1h (2026-05-25).** All step-1 sub-steps (1a–1h)
   shipped. The framework layer is complete; the next batch of
   work is TimeSeries integration (step 2 in this section's
   roadmap). 1885 tests total across core + react. Framework
   total: ~482 columnar tests. Bundle target (<25 KB gzipped)
   slipped past 26 KB at 1g; 1h adds ~12-15 KB more (ring buffer
   is substantial). Targeted size optimization will be a separate
   sub-step before merging the framework into the user-visible
   API. The pure-substrate layering established in PR #135 (Path
   B) has held cleanly across every subsequent sub-step — no
   framework file imports `Event` / `Time` / `TimeRange` /
   `Interval` / `temporal` / row-API types, verified by the
   independence test on each PR.

2. TimeSeries integration (~3 weeks) — private-field columnar store,
   lazy event materialization, API invariants pinned by tests.
   Sub-stepped per the integration pattern.
   - **2a + 2b — Private `#store` field + lazy `events` getter +
     point-accessor routing.** ✅ Shipped (PR #150, merged
     2026-05-25). 78 TimeSeries tests (+8 columnar-integration
     invariants); 1849 in `packages/core`. `TimeSeries`'s row-
     oriented `events: ReadonlyArray<Event>` field replaced with a
     private `#store: SeriesStore<S>` + lazy `get events()`. Every
     point accessor (`at` / `first` / `last` / `find` / `some` /
     `every` / `includesKey` / `bisect` / `atOrBefore` /
     `atOrAfter` / `Symbol.iterator`) routes through
     `#store.eventAt(i)` or `#store.keyAt(i)` directly — no full
     event-array materialization on point lookups. `bisect` does
     O(log N) `keyAt` probes with zero Event allocations.
     Module-private `TRUSTED_STORE_SENTINEL` Symbol routes
     trusted-store paths through the public constructor (ES
     private-field installation requires a running constructor;
     the previous `Object.create(prototype)` shape is no longer
     viable). `series.events` is `Object.freeze`d after lazy
     materialization to preserve immutability invariants. Five
     review rounds total (L2 medium + Codex × 4): events freeze,
     `fill('linear')` kind sensitivity, point-accessor refactor
     pulled in from 2b, fill contract docs, mixed-kind interval
     breaking change documented in CHANGELOG, `at(NaN)` integer
     guard, cache-validation fast-path.
     **Perf: +40% construction vs the pre-2a row-array baseline**
     (15ms → 21ms at N=100k). The substrate has real construction
     cost; the recovery path is sub-step 2c's column-native intake
     (bypass per-row Event allocation in `validateAndNormalize`).
     Benchmark script at `packages/core/scripts/perf-timeseries-
columnar.mjs`.
   - **2c — Column-native intake.** ✅ Shipped (PR #151, merged
     2026-05-25). New `validateAndNormalizeColumnar` in
     `validate.ts` walks rows once and writes directly into
     per-column typed-array buffers + per-row key buffers,
     skipping the N Event allocations + N frozen data dicts that
     `validateAndNormalize` paid for the row-shape pipeline.
     `SeriesStore.fromValidatedRows` routes through the new
     path with an empty event cache; events lazy-materialize on
     first `eventAt(i)` access. Lazy validity bitmap allocation
     (first-missing-cell triggers alloc + back-fill of previously-
     defined bits). Inlined the bitmap allocate-+-backfill in the
     hot loop (L2 perf nit) so per-row × per-column iterations
     don't allocate closures. **Perf vs main (3.6× faster
     construction, 3× faster point-access):**
     - build N=100k: 14.9ms → 4.19ms (-72%)
     - build N=1M: 167ms → 46ms (-72%)
     - build + 100 at(i) N=100k: 14.1ms → ~4.9ms (-65%)
     - build + bisect N=100k: 14.5ms → ~4.8ms (-67%)
     - **trade-off**: `series.events` full-materialize is now
       slower (lazy materialization shifts cost from build to
       first-events-access). The columnar substrate's whole
       point is "don't materialize rows you don't need." Users
       opting into row materialization pay there.
       The existing `validateAndNormalize` stays as-is for
       `TimeSeries.fromEvents` and other Event-array consumers.
       Column-native `toRows` / `toObjects` / `toJSON` paths
       deferred to a later sub-step (the lazy events path is
       already fast enough for the common cases).
   - **2d — Invariant test + bench**. Pin the five public-API
     invariants from the RFC at the TimeSeries layer. Run the
     perf bench against multiple workload patterns (dashboard
     build-once-use-many, one-shot transform, streaming append).
3. Numeric reducer adaptation (~2 weeks) — `sum` / `avg` / `count` /
   `min` / `max` / `stdev` / `median` / percentile family.
   - **3 Phase A — `series.reduce()` column fast path.** ✅ Shipped
     (PR #153, merged 2026-05-26). Optional
     `ReducerDef.reduceColumn(col: Float64Column)` for the 8
     built-in numeric reducers; `tryReduceColumnFastPath` dispatches
     when the target column is packed `Float64Column` and the
     reducer defines `reduceColumn`. Inline validity-bitmap walk
     pattern (`(bits[i >> 3]! & (1 << (i & 7))) !== 0`) avoids
     per-cell function calls. **Perf vs main (N=1M):**
     - sum: 33.9 ms → 0.57 ms (**59×**)
     - count: 28.8 ms → ~0 ms (∞ via O(1) `validity.definedCount`)
     - min: 33.7 ms → 0.46 ms (**73×**)
     - max: 33.5 ms → 0.57 ms (**59×**)
     - avg: 33.9 ms → 0.57 ms (**59×**)
     - stdev: 40.2 ms → 1.16 ms (**35×**) — two-pass formula for
       numerical stability (catastrophic cancellation in one-pass
       at large magnitudes; row-API also uses two-pass)
     - median / p95: 185 ms → 54 ms (**3.4×**) —
       `Float64Array.sort` intrinsic compare dominates over
       `Array.sort` with comparator
       L2 + Codex reviews caught two correctness divergences in the
       parity claim: stdev one-pass cancellation (closed via
       two-pass) and NaN-laundered min/max + sort-order divergence
       (closed via bug-for-bug row-API mirroring; single-pass
       `Number.isNaN` detector preserves `Float64Array.sort` for the
       no-NaN common case). 8 new regression tests pin row/column
       parity across all reducers on NaN-bearing inputs.
   - **3 Phase B — `series.aggregate()` per-bucket fast path.**
     ✅ Shipped (PR #186 + empty-bucket strengthening re-commit
     #187, merged 2026-06). `tryAggregateColumnarTimeKeyed(begins,
getColumn, buckets, columns)` in `batch/aggregate-columns.ts`
     reduces each time-keyed bucket straight off the column via the
     Phase-A `reduceColumn` fast paths, no per-bucket event
     materialization. Honest-baseline caveat pinned in
     `scripts/perf-aggregate-range.mjs` (the displaced `states` path
     was lighter than the custom-fn baseline; the small floor
     regression was accepted against goal-3, no magic-number
     threshold). Friction item #6 from
     [M1 chart-extraction](experiments/pond-ts-charts/) flagged
     `reduceColumnRange` as the more directly useful next step than
     Phase C — chart's per-frame Y-extent compute over the visible
     subarray is exactly the shape this serves.
   - **3 Phase C — `series.rolling()` fast path.** Deferred.
     Sliding windows need add/remove semantics; monotonic-deque
     - running-stats patterns don't map cleanly to a single
       `reduceColumn` call. Probably a per-reducer `rollingColumn`
       state factory.
   - **Followup — principled NaN + Welford semantics.** Codex
     flagged a shared row + column stdev overflow on `[1e308,
1e308]` (sum overflows before mean). Both paths share this
     numerical-stability gap. Folded into a broader design-doc
     follow-up that also decides whether NaN should be filtered
     universally across reducers (currently both paths exhibit
     surprising NaN-laundered behavior; bug-for-bug parity is
     the closed state).
4. Derived transforms (~3 weeks) — `select` / `rename` / `filter` /
   `slice` / `head` / `tail` / `diff` / `rate` / `pctChange` /
   `cumulative` / `shift` columnar paths. **In progress — recovers
   the 3.6× columnar construction win that the consultant found
   "evaporates at the first transform" (batch operators read
   `this.events`, forcing full lazy materialization).** Each
   transform reshapes the store directly via the column-native view
   ops (`withColumnsSelected` / `withColumnsRenamed` /
   `withColumnReplaced`) + `#fromTrustedStore`, no events touched.
   Doubles as **operator extraction** (ARCHITECTURE.md "thin API
   shell + `batch/operators/*.ts`"): each op becomes a pure
   `(store, schema, spec) → {store, schema}` function, the method a
   thin delegate. Per-transform status:
   - **`select`** ✅ Shipped (PR #188, merged 2026-06). Column-native
     reshape via `withColumnsSelected`; 7–10× pipeline win
     (`newPipeline ≈ build`).
   - **`rename`** ✅ Shipped (PR #189, merged 2026-06).
     `withColumnsRenamed`; stricter than the old event path (rejects
     key-rename + target collisions). Same pipeline win.
   - **`cumulative`** ✅ Shipped (PR #190, merged 2026-06). **First
     fully extracted operator** — `cumulativeOp` in
     `batch/operators/cumulative.ts`, establishing the Step-4
     template. 5.4–5.9× pipeline win. Exact parity (11 existing +
     7 column-native-edge tests); a type-defeated non-numeric target
     now fails fast (kind guard) instead of silently corrupting.
   - **`withRowRange` substrate** ✅ Shipped (PR #191, merged 2026-06).
     Contiguous row-range store slice (`view.ts`) — the row-dimension
     sibling of `withRowSelection`; the substrate precursor for
     `drop` and the row-range transforms (`slice` / `head` / `tail`).
   - **`diff` / `rate` / `pctChange`** ✅ Shipped (PR #192, merged
     2026-06). `diffRateOp` in `batch/operators/diff-rate.ts`; first
     consumer of `withRowRange` (`drop: true` slices off the
     predecessor-less first row). 5.3–7× pipeline win. Exact parity
     (31 existing tests, verified additionally by a 7,200-case
     differential fuzz in L2) + 7 column-native-edge tests, incl. the
     first **chunked-input direct-operator tests** (the storage-
     agnostic `col.read` contract; unreachable through the method
     since `concat` is still events-based → packed).
   - **`cumulative` chunked-input backfill** ✅ Shipped (PR #193,
     merged 2026-06). Completed the chunked-coverage policy for every
     extracted operator (the pattern proven on diff/rate in #192).
   - **`fill`** ✅ Shipped (PR #194, merged 2026-06). `fillOp` in
     `batch/operators/fill.ts` — the largest transform body
     (god-file −181 net). Multi-kind rebuild (number/string/boolean/
     array), only-rebuild-changed zero-copy passthrough, lazy times,
     `withRowRange` not needed (schema-stable). 4.9–5.5× pipeline win.
     L2 + a Codex pass both cleared it. One **deliberate behavior
     change** (not parity, now documented): a kind-mismatched literal
     throws (was: a silently-inconsistent series). 47 existing + 7
     column-native-edge tests.
   - **`slice`** ✅ Shipped (PR — this wave-step). Inline reshape via
     `withRowRange` (like `select`/`rename`, no per-row walk → no
     operator file); normalizes `Array.prototype.slice` semantics
     (negative indices, `ToInteger` truncation, clamps) to an absolute
     range first. Pinned by an 11-case suite incl. a differential
     sweep against `Array.prototype.slice`.
   - **`mapColumns`** ✅ Shipped (PR — this wave-step). **New public
     method** (not a conversion): a per-cell column value transform,
     `mapColumns({ col: (value) => newValue })`, extracted as `mapOp`.
     Same kind in/out (number→number, string→string, …) ⇒ schema
     unchanged; missing cells carry. The column-scoped counterpart of
     the event-based `map()` — fills the gap that there was no
     ergonomic per-cell column transform (you'd have used the slow
     event `map`). ~5–6× pipeline win. Same-kind enforced at the type
     level (`mapColumns.test-d.ts`); chunked-input + NaN pinned via
     direct `mapOp`. Surfaced by the user from the PR-comment scope
     note below.
   - **`shift`** ✅ Shipped (PR — this wave-step). `shiftOp` in
     `batch/operators/shift.ts`; per-target numeric shift+pad
     (`out[i] = col.read(i−n)`, else undefined-pad), `cumulative`-shaped
     (widens targets to optional number). 5.8–6.8× pipeline win. Exact
     parity (11 existing tests) + 8 column-native-edge tests incl.
     chunked-input.
   - **`collapse`** ✅ Shipped (PR — this wave-step). `collapseOp` in
     `batch/operators/collapse.ts` — reads only the keyed columns,
     runs the reducer over a minimal `{key: value}` object (no full
     Event), composes via `withColumnsSelected` (drop keyed unless
     `append`) + `withColumnAppended`; output kind inferred from row 0.
     4.7–6.5× pipeline win (more modest in spirit — the per-row reducer
     dominates both paths — but the event-materialization tax still
     dominates the measured number). Parity pinned by the existing
     `TimeSeries.test`/`Event.test` collapse cases + 8 column-native-edge
     tests incl. chunked-input.
   - **Transform wave COMPLETE.** All genuinely column-native-able
     batch transforms now read columns, not `this.events`. Judgment
     calls left intentionally event-shaped / deferred: `tail(duration)`
     (key-bisect + `withRowRange` — convertible, low value),
     `filter` (predicate is event-shaped; only the row-subset assembly
     via `withRowSelection` would be column-native). The event-based
     `map(nextSchema, (event, i) => newEvent)` is permanently out of
     scope — an arbitrary event→event closure can't be vectorized
     (distinct from the new per-cell `mapColumns`). **Follow-up:**
     extract the shared `columnFromValuesByKind` kind→builder dispatch
     (duplicated across `fillOp` / `mapOp` / `collapseOp`).
   - **`asTime` / `asTimeRange` / `asInterval` rekeys** ✅ Shipped
     (post-wave). Key-axis kind reinterpretation via the new internal
     `withKeyColumn` view op (the key-dimension sibling of
     `withColumnReplaced`): reads the existing key's `begin`/`end`
     buffers, builds the new-kind `KeyColumn`, reuses value columns by
     reference — no events. `asTimeRange` ~9× (zero-copy buffer reuse).
     **Breaking:** `asInterval`'s label fn now takes the interval's
     `TimeRange` + index, not the whole `Event` (this is what lets the
     function form stay columnar) — `range => range.begin()` unchanged;
     CHANGELOG [Unreleased]. This corrects the earlier mis-bucketing of
     `asX` as "inherently event-shaped" — they were always key-axis
     rekeys, just needing the `withKeyColumn` primitive.
5. Aggregate planner (~2 weeks).
6. String / dictionary reducer adaptation (~2 weeks).
7. `LiveSeries` numeric ring buffer (~2 weeks).
8. Chart-extraction alignment — **column-centric public API**
   (~2-3 weeks total, per the sub-step sequencing).

   Implements [`docs/rfcs/column-api.md`](docs/rfcs/column-api.md)
   (V3, adopted 2026-05-27). The RFC promotes the PR #152 spike
   accessor (`series.column('x')` / `series.keyColumn()`) into a
   canonical, kind-narrowed, time-detached public surface for
   single-column work. Multi-column composition and time-aware
   operations stay event-shaped per
   [`columnar-core.md`](docs/rfcs/columnar-core.md). RFC went
   through original draft → chart-experiment review → independent
   library review → V2 amendment → Codex pass on V2 → piece A
   (type system rewrite) → V3 restructure (pieces B + C + D + E) →
   Codex pass on V3 → V3.1 fixes (KeyColumn range-key invariant,
   per-kind method consistency, walkback log cleanup). Adopted as
   the binding spec; sub-step status:
   - **8a — Public type re-exports.** ✅ Shipped (PR #154,
     merged 2026-05-27). Re-exported the curated public Column
     surface from `pond-ts`'s top-level barrel: per-kind classes
     (Float64Column / BooleanColumn / StringColumn / ArrayColumn),
     chunked variants, key-column variants (TimeKeyColumn /
     TimeRangeKeyColumn / IntervalKeyColumn), union /
     discriminator types (Column, KeyColumn, ColumnKind,
     ColumnStorage, ScanOptions, IntervalLabelKind,
     ValidityBitmap). Substrate-internal items (builders,
     validity helpers, ColumnarStore, view transforms,
     concatSorted, scatterByPartition, ColumnarRingBuffer,
     factory functions, sentinels) deliberately held back. Closes
     M1 friction item #4. Type test
     `packages/core/test-d/column-api-reexports.test-d.ts` pins
     every re-exported symbol against the literal-narrowing
     contract. L2 high confidence, no Codex round needed (pure
     re-export, no runtime behavior change).
   - **8b — `Float64Column` scalar reductions + schema-narrowed
     `column()`.** ✅ Shipped (PR #155, merged 2026-05-27). Public
     method surface on all four packed column classes AND their
     chunked variants (`min` / `max` / `sum` / `mean` / `stdev` /
     `median` / `percentile(q)` / `count` / `minMax` / `hasMissing`
     / `nullCount` / `first` / `last` / `firstDefined` /
     `lastDefined` / `at` / `slice` on Float64Column;
     kind-appropriate subsets on Boolean / String / Array per RFC
     §7.3). Mounted via declaration-merging + prototype attachment
     in `packages/core/src/column-api.ts`, which lives outside
     `columnar/` so the substrate stays pure (substrate-purity
     test still passes). Reducer-backed methods delegate to PR
     #153's `reducer.reduceColumn` fast paths; chunked methods
     delegate to `materialize().method()` for v1 (~2× cost vs
     packed-native; future PR can add chunked-native impls).
     Schema-narrowed `TimeSeries.column<Name>(name: Name)`
     overload from RFC §7.2 — public wide overload dropped, so
     typos / key-column names / out-of-schema strings fail to
     compile rather than silently returning undefined. Tests:
     45 new runtime + comprehensive `.test-d.ts` per RFC §7.4.
     Review chain: L2 medium → 3 substantive fixes (chunked
     type-safety hole, missing negative tests, JSDoc/code
     mismatch) → Codex pass approve, no material findings.
   - **8c — `bin` (chart per-pixel downsampler).** ✅ Shipped (PR
     #156, merged 2026-05-27). `Float64Column.bin(W, reducer)` lands the chart's
     headline primitive: equal-width index bins with a reducer per
     bin, output type narrowing per reducer name (`'minMax'` →
     `{ lo, hi }`, scalar reducers → `Float64Array(W)`). The fused
     `'minMax'` variant collapses the chart's manual per-pixel
     min/max loop into one method call; the `{ lo, hi }` shape was
     the chart-experiment reviewer's stride-1 cache-pattern finding.
     Empty-bin convention: `sum` / `count` → 0 (mathematical),
     others → NaN (canvas-friendly: `ctx.lineTo(px, NaN)` breaks
     the sub-path). `slice` (zero-copy view) was already on the
     substrate from earlier work and exposed via 8b — the original
     8c framing of "slice + bin together" was unnecessary once 8b
     shipped slice as part of the substrate's already-mounted
     surface, so 8c was scoped to bin alone. Implementation
     delegates per bin to PR #153's `reducer.reduceColumn` fast
     paths; `minMax` inlines through the substrate's existing
     fused walk. Chunked variant delegates to materialize-then-bin
     per the 8b pattern. Tests: 28 new runtime tests covering all
     reducers, percentile via `'p${q}'`, empty / sparse bins,
     validity gaps (including chunked-specific coverage), edge
     cases, plus type-test narrowing per reducer. **Naming
     walkback:** V3 of the RFC originally proposed `binnedByIndex`
     to disambiguate from a deferred `binnedByTime`; in review the
     past-tense form felt overlong, so the method renamed to `bin`
     with the time-axis companion renamed to `binByTime` for
     parallelism. The disambiguation V3 was protecting is
     preserved by the operation's location — Column is detached
     from the time axis (§5 guardrail), so `col.bin` is necessarily
     index-domain. RFC's V3 amendment log records the rename with
     historical context.
   - **8d — `KeyColumn` `.at(i)` + `.slice(s, e)` + narrowed
     `keyColumn()`.** ✅ Shipped (PR #159, merged 2026-05-27).
     Mirrors Column's shape on the key axis: `.at(i)` returns the
     raw row shape (`number` for `TimeKeyColumn`, `{ begin, end }`
     for `TimeRangeKeyColumn`, `{ begin, end, label }` for
     `IntervalKeyColumn`) per the substrate columnar idiom;
     `.slice(s, e)` is a zero-copy index-range view (typed-array
     `subarray` under the hood; for `IntervalKeyColumn` the labels
     column is sliced in lockstep). Substrate gained
     `sliceByRange(start, end)` + `fromValidatedSubarray` trusted-
     construction factory on all three key-column variants — the
     latter is the key perf primitive that keeps slice O(1) rather
     than O(N) (skips the per-row finiteness scan that the public
     constructor runs, since a subarray of a validated buffer is
     itself validated). `TimeSeries.keyColumn()` return type now
     narrows to `KeyColumnForSchema<S>` per RFC §7.5 — consumers
     no longer need `instanceof` / discriminator checks just to
     reach kind-specific fields like `.labels`. The
     `KeyColumnForSchema` type is implemented via a distributive
     `KeyColumnForKind<K>` helper so broad schemas (e.g.
     `TimeSeries<SeriesSchema>`) get the full key-column union
     rather than collapsing to `never`. Closes the chart-
     experiment's NF4 finding (hover/tooltip wants
     `keyColumn().at(i)`) and unblocks M5 heatmap. KeyColumn does
     NOT get scalar reductions in v1 — `TimeKeyColumn` min/max are
     trivial (`begin[0]` / `begin[length - 1]`); range-key max-end
     requires a scan and is RFC-deferred per §4 close-cases. Tests:
     34 new runtime + type-test narrowing per variant. New public
     type re-exports: `KeyColumnForKind`, `KeyColumnForSchema`,
     `TimeRangeKeyAt`, `IntervalKeyAt`. Review chain: L2 medium →
     5 substantive fixes (slice-input NaN/Infinity, JSDoc cleanup,
     non-public `keyAt` reference, stale comment, frozen-by-
     convention misleading wording) → Codex needs-attention → 3
     substantive fixes (at-input NaN/fractional/Infinity gate,
     `KeyColumnForSchema` distributivity collapsing to `never` for
     broad schemas, trusted-slice factory closing the O(N)
     validation hidden behind the "zero-copy" claim). The full
     audit trail is on PR #159's two L2 + two Codex comments.
   - **8e — M1 chart adopts the new API.** ✅ Shipped 2026-05-27 in
     pond-ts-charts-experiment commit
     [`e89eca1`](https://github.com/pjm17971/pond-ts-charts-experiment/commit/e89eca1).
     The single-column line chart rewrote from spike accessors
     (`series.column('x').values` + manual per-pixel min/max loop)
     to the column-centric idiom
     (`series.column('x').slice(s, e).bin(W, 'minMax')`). Per-frame
     chart work shrank from ~33 lines of hand-written reducer +
     downsampler code to 8 lines of method calls. Bench confirms
     a clean win at the load-bearing scale: N=10M full-window
     drops from 13.1 ms → 10.7 ms (-18%), comfortably under the
     16.7 ms 60 fps budget with real headroom for canvas draw.
     **Validation gate verdict:** kind dispatch retires cleanly
     (schema narrowing eliminates the `kind !== 'number'` and
     `| undefined` guards). Storage dispatch survives at the
     `.values` boundary because pond-ts doesn't yet expose a
     storage-agnostic typed-array materializer at the column-API
     surface — captured as friction NF3 in
     [`M1-column-api-adoption.md`](https://github.com/pjm17971/pond-ts-charts-experiment/blob/main/friction-notes/M1-column-api-adoption.md).
     Carry-forward items into the next pond-ts wave (in priority
     order): `series.bisectBegin(ts: number): number` (was F3,
     ergonomic), `col.toFloat64Array(): Float64Array`
     (storage-agnostic gather, closes F1 + NF3),
     `TimeSeries.fromTrustedColumns(...)` (was F5, producer-side
     intake), JSDoc note on `bin`'s NaN empty-bin convention
     (NF1, doc-only). API shape is proven for single-column
     line charts; M2 (multi-column) and M3 (chunked) are the
     next validation passes.
   - **8f — `BooleanColumn` / `StringColumn` reductions, on
     demand.** `all` / `any` / `none` on `BooleanColumn`;
     `uniqueCount` on `StringColumn`. Each method lands when an
     actual consumer use case earns it — not on spec. Docs lead
     with the generic Column shape and surface per-kind reductions
     as additive. Pending; awaits experiment friction.
   - **8g — (Deferred) `series.binByTime(name, W, range,
reducer)` on TimeSeries.** Time-aware variant for irregular-
     sample charts. Composable today as
     `series.within(t0, t1).aggregate(every((t1-t0)/W), { col:
reducer }).column(col).values`; the dedicated shortcut lands
     only when measured per-frame friction earns it. Deferred per
     pond's "friction-driven additions" discipline.
   - **8h — Docs update.** JSDoc on `series.reduce(col, reducer)`
     points single-column callers at `series.column(name).method()`
     as the recommended idiom. Docs site recipe for the column-
     centric pattern (and a `@pond-ts/react` section on column
     identity, memoization, and `useEffect` dependencies — see
     RFC §12 caching decision). Lands alongside 8b.

Each step lands as its own PR with the standard two-pass review
(Layer 2 + Codex). The framework layer is the most load-bearing;
reviewing it well matters more than ticking the whole sequence off
quickly.

**Validation pattern.** Each step is exercised by a use-case agent
before merge — the gRPC experiment is the natural primary driver
(memory pressure was its recurring friction), supplemented by the
dashboard / webapp telemetry / future experiments as they arise.
Per CLAUDE.md "Multi-agent experiments and the feedback model,"
friction reports drive refinement; the substrate is foundational
enough that getting feedback per step matters more than usual.

**Release shape (tentative).** v1.0 is the target version when the
substrate + the streaming milestones (B/C/D) that ship on top all
land cleanly. Tentative version map:

- v0.17.x — current patch wave (partitionBy ordering inheritance,
  etc.) — bug fixes only
- v0.18.0 — streaming milestone A (`LiveChange` source-side) — ships
  independently of columnar
- v0.18.x — columnar framework layer (step 1) lands behind feature
  flag or as internal-only initially
- v0.19.0 — columnar TimeSeries integration (steps 2–4) — first
  user-visible substrate landing
- v0.19.x — aggregate planner + string reducer adaptation +
  LiveSeries ring buffer (steps 5–7)
- v0.20.0 — streaming milestones B + C ship on substrate
- v1.0.0 — substrate complete + milestone D + chart alignment;
  v1.0 framing is the version when public API stability commits
  long-term

Release shape is tentative; if implementation surfaces a different
sequencing or a chunk doesn't earn its slot, the version map
adjusts.

### Next wave: gRPC re-bench → substrate adoption (queued 2026-05-28)

The chart-experiment closed its adoption + measurement cycle on
2026-05-28 (see
[`pjm17971/pond-ts-charts-experiment/STATUS.md`](https://github.com/pjm17971/pond-ts-charts-experiment/blob/main/STATUS.md))
and validated the substrate against single-column and multi-column
chart workloads at N=10M / 60fps. The natural next consumer for
substrate validation is the **gRPC experiment** — that's where the
columnar overhaul was originally strategically aimed (per the
columnar-core RFC's motivation), and the substrate has matured
upstream of the gRPC workload without the gRPC hot path re-benching
against it.

**Outcome (2026-05-29): the wave ran, and the measurable conclusion
is that the substrate's free wins were already delivered by v0.17.1;
the next real lever (columnar rolling) doesn't earn its cost at
current production headroom.** Phase A (V5 re-bench) completed; Phase
B Step 7 (LiveSeries ring buffer) was attempted and **walked back**
after the bench falsified it. Details below + in the experiment
friction note. The phase descriptions that follow are the original
plan, annotated with what actually happened.

**Step 7 walk-back — the durable finding.** The LiveSeries columnar
ring buffer was built and benched ([brief](docs/briefs/step-7-live-series-ring-buffer.md)):
ingest 9.4× slower (630ms vs 67ms for 300k rows), heap retained
_higher_ (36MB vs 28MB), not lower. **Why it can't win: the gRPC hot
path needs `Event` objects** — the rolling pipeline subscribes to
`'event'`, so `LiveSeries` materializes an Event per row regardless
of backing. The ring then decomposes it back into columns (strictly
more work than create + store-reference), and the "don't retain
events" payoff didn't even show as a heap win. A columnar _buffer_
can't avoid the allocation when the consumer needs events; only a
columnar _rolling reducer_ (Step 3 Phase C) would cut the V5 GC
pressure. Kept: the storage-strategy refactor (PR #168, earned its
keep). Reverted: PR #169 reverts #167's `_appendRowTrusted`. The
ring attempt is preserved on branch `feat/step-7-ring-storage`
(not merged). Same measure-and-walk-back discipline as the `bin
{out}` revert.

**Wave shape.** Three phases. Documented in detail at
[`pjm17971/pond-grpc-experiment/friction-notes/columnar-rebench.md`](https://github.com/pjm17971/pond-grpc-experiment/blob/main/friction-notes/columnar-rebench.md) —
that file is the binding plan for the experiment-side work; this
section is the pond-ts side.

- **Phase A — Baseline re-bench (gRPC agent, no library code).**
  Run the V4 bench harness (`pnpm perf` — four bench:agg load
  points + ceiling profile) against the current v0.17.1 pin. V4 was
  measured at v0.14.0; v0.15.0 (fused rolling), v0.16.0
  (pipeline.stats), v0.17.0 (live.sample), v0.17.1 (partitionBy
  default-inherit) have shipped since. The V5 row of the
  V1→V2→V3→V4 bench table is the deliverable. **No public API
  consequences.**

- **Phase B — Library work prioritized by what V5 surfaces.** Two
  candidates, both pre-named in this Phase 4.7 roadmap:
  - **Step 7 — `LiveSeries` numeric ring buffer.** ❌ **ATTEMPTED
    AND WALKED BACK (2026-05-29).** Wired `ColumnarRingBuffer` (step
    1h) under `LiveSeries` for strict/drop modes; bench showed 9.4×
    slower ingest and _higher_ heap retention. The ring can't win
    because the consumer (rolling pipeline) needs `Event` objects
    regardless of backing — see the walk-back finding above. The
    storage-strategy refactor that preceded it (PR #168) stays as
    clean architecture; the ring backing was reverted.
  - **Step 3 Phase C — `series.rolling()` columnar fast path.** The
    structural fix for V4's 8.2% `LivePartitionedSyncRolling.ingest`
    self-time line. Per-reducer `rollingColumn` state factory (or
    batch-recompute over substrate slices). **Public API
    consequence:** the per-reducer extension surface is the design
    question — is `rollingColumn` an internal hook on the reducer
    registry, or is it a public extension contract (analogous to
    `ReducerDef.reduceColumn` from PR #153)? Defer the decision to
    the V5-surfaced friction; if no custom-reducer driver shows up,
    keep it internal.

  Ordering between Step 7 and Step 3C depended on V5's profile.
  V5 said "Step 7 first" (GC dominant at 22%), but the Step 7
  walk-back proved that recommendation wrong: the GC line is driven
  by the rolling pipeline's per-event `Event` consumption, not by
  buffer storage. **Step 3 Phase C is the only lever that would
  actually cut it** — but it's a much larger change (per-reducer
  columnar state machines) and earns its slot only if a future
  workload pushes near ceiling. Production target is 100k/s; V5 hits
  ~210k/s (2.1× headroom). Deferred until friction earns it.

- **Phase C — Consumer re-adoption + dashboard validation.** The
  gRPC experiment bumps to whatever ships from Phase B and
  produces the V6 bench. In parallel, the **dashboard agent** —
  the second consumer surface, owning the React/`useSnapshot` /
  `useLiveQuery` path — gets looped in for adoption friction on
  the same substrate. Two independent friction reports converge
  on the writeup: gRPC reports the throughput story, dashboard
  reports the snapshot/render story. Substrate's strategic
  justification is met when both consumers report wins.

**Operating rules for this wave.**

- **PR merges wait for human approval.** Standing instruction from
  2026-05-28 — every library PR in this wave gets the standard
  two-layer review (Layer 1 self + Layer 2 adversarial agent + Codex
  pass when below-high confidence), then **pauses** for human review
  before merge. Agent-merge default per CLAUDE.md is suspended for
  this wave so the user can pace engagement.
- **Each PR carries a benchmark.** Performance-centered work
  (which most of this wave is) reports before/after numbers in the
  commit message per the CLAUDE.md "Performance check for new
  operators" section. The V4 bench table format is the template.
- **Each PR carries a plan summary and motivation in the body.**
  Including a section on public API consequences when any exist —
  even invariant-preserving changes (Step 7) get an explicit
  "invariants preserved" subsection so the diff reviewer can verify
  rather than infer.
- **Friction notes live in the consumer experiment, not pond-ts.**
  gRPC's V5 / V6 reports land in `friction-notes/columnar-rebench.md`
  in the experiment repo; pond-ts gets the corresponding PR with the
  library-actionable item. Same discipline the chart-experiment
  used.

**What this leaves on the table (intentionally).** Steps 4
(derived transforms columnar), 5 (aggregate planner), 6 (string/
dict reducers), 8e/8f/8g (additional chart sub-steps) all defer
until a consumer friction earns their shape. The chart-experiment's
M3 (chunked rendering) and M5 (interval heatmap) remain deferred
per their respective notes.

**Deferred (surfaced by the chunked-live wave, PR #170 Codex pass).**
`LiveReduce` over an `ordering: 'reorder'` source **with retention**
returns stale/`undefined` snapshots for the windowed reducers
(`min` / `max` / `first` / `last` / `samples`). Their rolling state
(monotone deque / head-removal ordered entries) assumes eviction
removes the oldest-_arrived_ event first — true for `strict` / `drop`
and the chunked backing (all append-only), but `reorder`'s
sorted-prefix eviction can drop a later arrival, which those
structures can't represent. Value-based reducers (`avg` / `count` /
`sum` / `stdev` / `median` / `percentile` / `unique`) remove by value
and stay correct. This is **pre-existing** (true on `main` before the
chunked work; the PR #170 FIFO change merely swapped one wrong answer
for another, now reverted to identity-primary) and is documented in
`LiveReduce`'s class JSDoc + pinned by the value-based test in
`live-buffer-as-window.test.ts`. The fix, when a consumer earns it:
give `min`/`max` a removal-by-value structure (sorted array, as
`median` already uses) selected only for reorder sources — keeping
the O(1) monotone deque on the append-only hot path. Workaround today:
`live.toTimeSeries().reduce(...)`. The broader architecture for a
columnar `reorder` (append-only main store + sorted "late corral"
overlay + grace-flush compaction) and the column-native output boundary
it shares a spine with are captured in
[`docs/rfcs/columnar-live-protocol.md`](docs/rfcs/columnar-live-protocol.md)
— RFC context, not committed.

**The V6 re-bench corrected the target (2026-05-30).** The gRPC
experiment re-benched against the released v0.18.0
([pond-grpc-experiment#42](https://github.com/pjm17971/pond-grpc-experiment/pull/42))
and **falsified Phase 1's heap framing for the real consumer.** The
chunked backing engaged on the source (67k chunks), but the retained
`Event` count was **unchanged (6.77M)** and net heap went **up ~210 MB** —
because the dominant retention is the **100 `partitionBy('host')`
sub-series**, which Phase 1 carved out to `Event[]` (`__backing: 'array'`)
on the assumption "partitions aren't the OOM driver." That assumption was
wrong: ~67k retained Events per partition × 100. Phase 1 aimed at the
wrong tier. What it _did_ deliver is real and worth keeping: minor GC max
pause **−74%**, ingest→fanout p99 **−78%**, pushManyTotal p99 **−77%** —
Phase 1 is a churn/latency fix, **not** the heap fix it was billed as.

**Phase 2 — column-native partition routing (✅ MERGED #175, 2026-06-03;
gRPC V8 clean win).** The genuine OOM fix. `partitionBy(...)` over a
chunked source routes its chunks to per-partition slices and stages them
into chunked-backed partition sub-series — replacing the per-partition
`Event[]` retention with columnar chunks. The naive "one chunk per
(batch × partition)" was a V7 regression (1.58M chunks, 4.1× heap,
throughput collapse — the thin-scatter / ~1-row-chunk pathology); the fix
is a **per-partition coalescing tier** (`ChunkedColumnarLiveStorage`
stages gathered tuples and flushes one packed chunk per 256 rows). gRPC
**V8** cleared every gate: ColumnarStore 1.58M→94k (60×, matches the
threshold), retained heap 2.22 GB→1.92 GB (−13.5%, below the V6
baseline), Event retention 6.77M→37,891 (−99.4%, the remainder all
emit-side), sustained throughput 41k→51k/s (+24%), ingest→fanout p99
−25%. One soft caveat: `pushManyTotalMs` p99 7.1 ms vs 3.6 ms (the flush
lands on threshold-crossing batches; p50 unchanged, under deadline) —
smoothable later, not a blocker. Merged as #175 (2026-06-03) after a fresh
L2 + Codex re-review (task #89); **no new public surface** (only `_`-internal
hooks). Implementation now on `main` (`live/live-partitioned-series.ts`
`#routeChunk`, `live/live-chunked-storage.ts` coalescing tier). Scope plan:
[`docs/briefs/columnar-partition-routing.md`](docs/briefs/columnar-partition-routing.md).

**Next (now unblocked by Phase 2): column-native output (§A).**
Before-number locked by V6: **~11.7 MB/s** transient at the OOM cell
(~90k Events/s + ~90k row-objects/s for the shared `'batch'` listeners),
and the V8 result confirms it's the dominant remaining allocation slice
(the 37k retained Events are all emit-side). §A removes that
_output-boundary_ slice — separate from the partition-retention fix
above. Spike plan:
[`docs/briefs/column-native-output-spike.md`](docs/briefs/column-native-output-spike.md).
§B (columnar reorder) stays unearned.

**Cross-references:**

- [`docs/rfcs/columnar-live-protocol.md`](docs/rfcs/columnar-live-protocol.md)
  — the live boundary protocol: column-native output (§A), columnar
  reorder corral/LSM overlay (§B), and the structural-delta spine that
  unifies them (§C). Successor-direction to this wave's chunked backing.
  Carries the full multi-agent review layer + V2 amendments.
- [`docs/briefs/columnar-partition-routing.md`](docs/briefs/columnar-partition-routing.md)
  — **Phase 2, the measured-earned OOM fix** (re-prioritized ahead of §A
  by the gRPC V6 re-bench): column-native partition routing via
  `scatterByPartition` + chunked-backed strict-time partition sub-series.
- [`docs/briefs/column-native-output-spike.md`](docs/briefs/column-native-output-spike.md)
  — the §A increment (column-native output), now sequenced **after**
  Phase 2: payload fork, additive listener name, before-number locked by
  the V6 re-bench, API gate.
- [`docs/rfcs/columnar-core.md`](docs/rfcs/columnar-core.md) — the
  binding RFC with full library-agent response.
- [`docs/briefs/core-columnar-store-spike.md`](docs/briefs/core-columnar-store-spike.md)
  — evidence base from the Codex spike.
- [`docs/rfcs/streaming.md`](docs/rfcs/streaming.md) — streaming
  RFC; sequencing addendum notes how milestone A + columnar
  interact.
- [`docs/rfcs/charts.md`](docs/rfcs/charts.md) — chart RFC; v1
  charts share columnar primitives with core.
- [`docs/rfcs/column-api.md`](docs/rfcs/column-api.md) — column-centric
  public API RFC (V3 adopted 2026-05-27). Binding spec for Phase 4.7
  step 8's sub-step sequencing (8a-8h above). Deliberate, small,
  scoped walkback of `columnar-core.md`'s "public API remains
  event-shaped" commitment, scoped to single-column / time-agnostic
  operations. Survived original draft → two parallel reviews →
  V2 amendment → Codex pass → V3 restructure → second Codex pass
  → V3.1 fixes. Type-system design verified compilable; type-level
  acceptance tests pinned in RFC §7.4 as CI-enforced contract.
- The previous "row-oriented core stays" deferred-design entry
  (now superseded; walked back in the Deferred Design Decisions
  section above).

---

## Phase 5: React integration

Status: in progress. Monorepo restructure complete — `@pond-ts/react` package
at `packages/react/`. Hooks shipped at v0.4.2; usability fixes in progress.

Goal: make Pond useful in frontend apps without forcing a framework-y runtime
model into the core package.

Entry point: `@pond-ts/react` (separate workspace package)

### Hooks

- [x] `useLiveSeries` — creates and owns a `LiveSeries` for component lifetime;
      returns a stable `live` ref and a throttled `TimeSeries` snapshot
- [x] `useTimeSeries` — memoized `TimeSeries.fromJSON(...)` for static/fetched
      data; re-parses only when key changes
- [x] `useSnapshot` — converts any `LiveSource` into a throttled `TimeSeries`
      snapshot for rendering; works with `LiveSeries`, `LiveView`,
      `LiveAggregation`, and `LiveRollingAggregation`
- [x] `useWindow` — derived windowed view that updates as the source grows;
      disposes the view on cleanup
- [x] `useDerived` — applies a batch transform to a snapshot, recomputing when
      the input changes
- [x] `takeSnapshot` — utility: build a `TimeSeries` from any `LiveSource`

### Usability fixes (from external testing)

- [x] `Time.toDate()` — added missing convenience method
- [x] `useWindow` StrictMode fix — view created in `useEffect`, not `useMemo`
- [x] `TimeSeries[Symbol.iterator]` and `toArray()` — ergonomic iteration
- [x] `useSnapshot` accepts `SnapshotSource<S>` structural type — avoids casts
      when passing `LiveAggregation` or `LiveRollingAggregation`
- [x] `LiveView` eviction mirroring — filtered/mapped views now mirror source
      evictions (uses `EMITS_EVICT` symbol to safely detect evict-capable sources)
- [x] `LiveAggregation<S, Out>` and `LiveRollingAggregation<S, Out>` — output
      schema type parameter enables `event.get('col')` to narrow through
      aggregation chains (e.g. `agg.at(0)?.get('cpu')` returns `number | undefined`
      instead of `ScalarValue | undefined`)
- [x] Schema-transform types already exported: `AggregateSchema`, `RollingSchema`,
      `DiffSchema`, `SmoothSchema`, `SmoothAppendSchema`, `SelectSchema`,
      `RenameSchema`, `CollapseSchema`
- [x] `useLiveQuery` — bundles `useMemo` + `useSnapshot` into one call; return
      shape matches `useLiveSeries`, cuts hook count roughly in half for dashboards
      with multiple derived views
- [x] `useLatest` — subscribes to a live source and returns only the most recent
      event; lighter than a full `TimeSeries` snapshot for stat cards and gauges

### Remaining

- [ ] Document `rate()` / `diff()` / `pctChange()` behavior when `dt = 0` —
      concurrent events (same timestamp) produce `undefined`. Workaround is to
      filter per-producer first. A `rateOver({ every: '1s' })` variant that
      normalizes to fixed wall-clock windows may be worth adding later.
- [x] `smooth('ema', { warmup: N })` — drops the first `N` output rows so
      callers don't have to write `.slice(N)` after every EMA call. Shipped
      in v0.5.7. A `seed` variant that initializes the EMA with a specific
      value (rather than trimming the output) is still open if the need
      comes up.
- [x] `outliers(col, { window, sigma, alignment? })` — rolling-baseline
      anomaly detection as a first-class operator. Returns `TimeSeries<S>`
      filtered to events deviating from the rolling avg by more than
      `sigma * rolling_stdev`. Collapses the 30-line manual pattern
      (rolling → avgByTs Map → filter loop) into one call. Shipped in
      v0.5.8.
- [x] `baseline(col, { window, sigma, alignment?, names? })` — appends
      `avg` / `sd` / `upper` / `lower` columns to the source schema in
      one rolling pass; band-chart `toPoints()` (wide rows after
      v0.7.0) and outlier-filter `.filter(cpu > upper)` both read from
      the same intermediate. Replaces the dashboard's "call rolling
      for bands, call outliers for dots" two-pass pattern with one
      call. Shipped in v0.5.9. v0.5.10 followup: `upper` / `lower`
      collapse to
      `undefined` when the rolling window is flat (`sd === 0`) so a
      naive `value > upper || value < lower` filter doesn't flag every
      non-equal point; matches `outliers()`. The two methods are now
      documented as conceptually equivalent (not sugar — they're
      independently implemented). First trial of the two-comment review
      protocol landed through PR #47.
- [x] `toPoints()` / `TimeSeries.fromPoints(points, { schema })` —
      chart-library interop. Originally narrow-form
      `toPoints(col) → { ts, value }[]` in v0.5.8; redesigned in
      v0.7.0 to wide rows
      (`toPoints() → { ts, ...valueColumns }[]`) to match the
      multi-column nature of `TimeSeries` and feed Recharts /
      Observable Plot / visx without a manual merge step.
      `fromPoints` accepts the inverse wide-row shape over any
      time-keyed schema.
- [ ] Dashboard guide doc fixes — show `useLiveQuery` as the idiomatic pattern
      rather than manual `useMemo` + `useSnapshot`; document how derived views
      interact with `LiveSeries` retention.

**Render throttling** is critical. Raw data can arrive at hundreds of events per
second. The `throttle` option caps how often the snapshot is recomputed.
Stateless transforms are cheap enough to build inline during render; stateful
transforms must be created once via `useMemo` on the `live` ref (or
`useLiveQuery`).

Requirements before starting:

- live composition semantics from phases 3 and 4 should already feel stable

Definition of done:

- [x] live data can flow from WebSocket-like sources into throttled React renders
- hooks have examples that mirror likely product use
- the docs explain when to use lazy views vs memoized derived data

---

## Phase 6: Ecosystem and adapters

Status: not started.

Goal: make Pond easier to adopt in real products before committing to a full
first-party charting system.

Scope:

- `pond-ts/node` — Node stream adapters (`Readable`/`Writable`); views and live
  aggregations also expose `.toReadable()`
- `pond-ts/adapters` — bridge helpers such as `toRecharts`, `toObservablePlot`
- improved docs and examples for integrating with existing chart libraries

Later, only after the previous phases are stable:

- **`@pond-ts/server`** — first-party server package extracted from the gRPC
  experiment's aggregator + WebSocket fan-out shape. Owns the
  WS-snapshot-then-deltas pattern, `WireMsg<T>` envelope versioning,
  heartbeat / slow-client policy, server-side backpressure, and schema-to-
  wire coordination. Depends on Phase 4.5 milestones C
  (`AggregateEmission` + stable IDs) and D (`keyBy/window/aggregate`)
  landing first. Will likely pull emission-history snapshots forward from
  RFC phase 5 when the snapshot-on-connect pattern needs them. Core stays
  connector-light per the streaming RFC; the server package owns the
  deployment shape.
- `@pond-ts/charts` — first-party chart components built directly on the
  `pond-ts` data model, successor to `react-timeseries-charts`. Strategic
  positioning: **the visualization end of pond** — `data → pond → charts`
  with zero friction, where the pond pipeline is the moat. Scope is
  **timeseries only** (line, band, bar, scatter, box); not pie, treemap,
  or generic visualization.

  **v1 does not depend on Phase 4.5 milestone C.** Only the final
  `fromAggregateEmission` adapter does — v1 ships earlier with a loose
  pre-milestone-C wire shape contained inside the adapter layer. The
  sequencing reason is bandwidth: streaming-RFC work earns more leverage
  until milestone C is in flight.

  **Full design** in [`docs/rfcs/charts.md`](docs/rfcs/charts.md). Covers
  the layered-engine architecture (pond source → adapter → typed-array
  store → viewport/decimator → chunked Path2D cache → canvas renderer
  → React shell), the `ChartDataSource` interface, the v1 component
  reduction (rendering spine + `LineChart` + `BandChart` only;
  `BarChart` / `ScatterChart` / `BoxChart` as v1.1 layer implementations),
  the 9 implementation traps from the gRPC experiment, the uPlot
  technique inventory reweighted for the library's scale, and the
  perf-invariant test surface. Authorship trail: original gRPC-experiment
  RFC + pjm17971 strategic frame + Codex architectural review + library
  agent amendment.

  **Cross-references:**
  - Working canvas implementation:
    [pond-grpc-experiment#37](https://github.com/pjm17971/pond-grpc-experiment/pull/37)
    (merged; 50 MB plateau vs Recharts OOM at 1–5 min).
  - Original friction-note RFC:
    [`canvas-chart-primitive.md`](https://github.com/pjm17971/pond-grpc-experiment/blob/main/friction-notes/rfcs/canvas-chart-primitive.md).
  - Layout-primitive design template:
    [react-timeseries-charts](https://github.com/esnet/react-timeseries-charts).

- **gRPC stream processor experiment** — in progress at
  [pjm17971/pond-grpc-experiment](https://github.com/pjm17971/pond-grpc-experiment).
  Three-tier setup: producer (Node, gRPC) → aggregator (Node,
  WebSocket fanout) → React app, all sharing one `as const` schema
  via `pond-ts/types`. Exploratory: characterizes the single-thread
  aggregator's operating envelope, surfaces the friction notes that
  drive library follow-ups (already shipped: `pond-ts/types`
  subpath in v0.11.3; queued: snapshot/append primitives on
  `LiveSeries` — see Phase 4). Real high-throughput workload would
  also surface routing-overhead bottlenecks with actual data
  (currently the partition routing path is ~0.8 µs/event due to
  row revalidation in `LiveSeries.push`; we deferred the
  optimization for v0.11 because synthetic measurements weren't
  enough signal). Becomes a reference deployment shape for users
  who want pond-ts pipelines in their own services; M5's extraction
  sweep should yield three RFCs (`@pond-ts/server`,
  `useRemoteLiveSeries` for `@pond-ts/react`, `@pond-ts/dev-producer`)
  and — once two codecs exist in working code (JSON on the WS hop,
  protobuf on the gRPC hop) — likely an `Adaptor` interface in a
  separate `@pond-ts/adaptors` package. Separate repo, not part of
  the npm packages.

### Package structure

Monorepo with npm workspaces (`packages/*`):

```
pond-ts              -> packages/core — batch + live library
@pond-ts/react       -> packages/react — React hooks
@pond-ts/charts      -> future — first-party chart components
```

Subpath entry points within `pond-ts`:

```
pond-ts              -> core batch library
pond-ts/live         -> LiveSeries, subscriptions, retention, live transforms
pond-ts/node         -> Node stream adapters (Readable/Writable, future)
pond-ts/adapters     -> bridge adapters for third-party chart libs (future)
```

Browser-safe by default. Node-specific APIs go behind a separate entry point.

Definition of done:

- Node-specific APIs stay out of the browser-safe default entry point
- adapters solve common "how do I graph this?" questions in the docs
- a chart package remains an intentional future decision, not implied scope creep

---

## Recommended release grouping

| Release band | Focus                                                        |
| ------------ | ------------------------------------------------------------ |
| `0.1.x`      | Performance fixes, hardening, serialization, custom reducers |
| `0.2.x`      | `groupBy`, `reduce`, `diff`/`rate`, `fill`                   |
| `0.2.5`      | `pctChange`, `cumulative`, `shift`                           |
| `0.3.x`      | `LiveSeries` core and subscriptions                          |
| `0.4.x`      | Live views and live stateful transforms                      |
| `0.5.x`      | React hooks                                                  |
| `0.6.x`      | Node adapters and third-party chart adapters                 |

---

## Decision gates

Before moving from one major phase to the next, answer the relevant question:

- After Phase 1: is the batch layer complete and trustworthy enough to be the
  foundation?
- After Phase 3: is the `LiveSeries` shape correct, or are we still learning?
- After Phase 4: do live/stateful composition rules feel simple enough for
  users?
- After Phase 5: do common frontend use cases work without ad hoc glue?

If the answer is no, stay in the phase and tighten the model before expanding.

---

## Deferred design decisions

### Array column values (`unique`, `topK`, `percentiles`)

**Status: shipped.** `unique` reducer and the four array column operators
(`includes`, `count`, `containsAll`, `explode`) landed on branch
`feat/array-columns`. The sections below describe the design; see the
implementation checklist at the bottom for what's done and what's still open.

**Decision: reducers may output arrays, but array columns are inert.**

A `'unique'` reducer (distinct values in a bucket) is a natural aggregation —
"which hosts reported in this window?" — but it collides with a constraint:
`CustomAggregateReducer` returns `ScalarValue | undefined`
(`number | string | boolean`), and the natural output of `unique` is
`string[]`.

The full-fat approach — making `ScalarValue[]` a first-class value everywhere —
is expensive. Every conditional type, every reducer, `fill`, `align`, `diff`,
`rate`, chart adapters, JSON round-trips — all need to handle or reject arrays.

But most array-valued use cases share a property: **the array is a reducer
output, never an input to further numerical operations.** You never `avg` a tag
list. You never `diff` a set of host names. The arrays are read-only results
that pass through the pipeline untouched.

That observation dramatically reduces the blast radius:

#### What changes

- **New column kind `'array'`** with value type `ScalarValue[]`.
  `NormalizedValueForKind<'array'>` → `ScalarValue[]`.
- **Reducer registry** gains an `outputKind` that can be `'array'`. A reducer
  like `'unique'` declares `outputKind: 'array'`; the output schema column gets
  `kind: 'array'` automatically.
- **`toJSON` / `fromJSON`** encode array cells as JSON arrays. No format break —
  existing scalar cells are unchanged, and a cell that happens to be an array
  serializes naturally.
- **`CustomAggregateReducer`** return type widens to
  `ScalarValue | ScalarValue[] | undefined`.

#### What stays the same (inert behavior)

- **`NumericColumnNameForSchema`** already filters to `kind: 'number'` — so
  `diff`, `rate`, `pctChange`, `cumulative`, `rolling` naturally skip array
  columns with no code changes.
- **`fill`** strategies (`hold`, `zero`, `linear`, `bfill`) don't apply — array
  columns are skipped.
- **`align`** interpolation doesn't apply — array columns pass through.
- **`filter`, `map`, `select`, `rename`, `collapse`** operate at the event
  level, not individual cell values — arrays pass through naturally.
- **`aggregate` / `rolling`** on a column that is already `'array'` — only
  reducers that accept array inputs would work (`first`, `last`, `keep`,
  `count`). Numeric reducers reject or ignore.

#### Built-in reducers that return arrays

- **`unique`** — distinct non-undefined values, sorted. Works on any column
  kind. **Shipped.**
- **`top(n)`** — top N values by frequency, sorted by count descending with
  deterministic scalar tie-break. Implemented as a string-pattern reducer
  (`'top3'`, `'top10'`, …) parallel to `pNN`, plus a `top(n)` helper that
  returns the typed string literal. Incremental bucket/rolling state via
  a count map, so `rolling('5m', { host: top(3) })` is O(1) per update.
  **Shipped.**
- **`percentiles(...qs)`** — compute multiple quantiles in one pass:
  `percentiles(50, 90, 99)` returns `number[]`. Avoids three separate
  `p50` / `p90` / `p99` columns. **Deferred** — the workaround (declaring
  three output columns) is ergonomic enough and doesn't lose efficiency
  (each `pNN` reducer already shares a sorted-array rolling state). Revisit
  only if multi-quantile dashboards become a common pattern.

#### Array column operators

Once array columns exist, a small set of operators makes them useful for
tagging workflows (e.g. "which hosts reported?", "does this bucket include
host X?"). All operators are prefixed `array*` so they read clearly and
don't collide with existing scalar / temporal methods (e.g. temporal
`contains(range)`).

**Filters** (same schema, predicate-only):

- **`arrayContains(col, value)`** — keep events where the array column
  contains `value`. Common pattern: "show only buckets that saw host
  `api-1`."
- **`arrayContainsAll(col, values)`** — keep events where the array
  contains _every_ value in `values` (AND / subset).
- **`arrayContainsAny(col, values)`** — keep events where the array
  contains _at least one_ value in `values` (OR / intersection non-empty).

**Per-event reduction** — reuses the existing reducer registry:

- **`arrayAggregate(col, reducer, options?)`** — feed each event's array
  to a reducer (`count`, `sum`, `avg`, `min`, `max`, `median`, `stdev`,
  `difference`, `pNN`, `first`, `last`, `keep`, `unique`, or a custom
  function) as if it were a bucket of values. This unifies "count the
  array length" with "average a sample list" with "dedupe within the
  array" under one method. Output kind is inferred from the reducer
  (`outputKind: 'number'` → `number`, `'array'` → `array`, `'source'`
  falls back to `'string'` unless overridden with `{ kind }`). Without
  `as`, the source column is replaced in place; with `{ as: "name" }` a
  new column is appended and the source array is preserved.
  Custom reducer contract matches `CustomAggregateReducer`:
  `(values: ReadonlyArray<ColumnValue | undefined>) => ColumnValue | undefined`.

**Flatten**:

- **`arrayExplode(col, options?)`** — fan each event out into one event
  per element of the array. Default replaces the array column with a
  scalar column of kind `kind` (default `'string'`, overridable).
  With `{ as: "name" }` the array column is preserved and a new scalar
  column `name` carries the per-element value; the source array is
  repeated on each fanned-out event. Events with empty or `undefined`
  arrays are dropped. The resulting series may contain events with
  duplicate timestamps.

All five are batch `TimeSeries` methods. Live equivalents (`LiveView`
variants of `arrayContains` / `arrayContainsAll` / `arrayContainsAny`)
are deferred but straightforward — they'd be stateless predicate views.
Live `arrayAggregate` and `arrayExplode` need more thought (how
`arrayExplode` interacts with eviction is the hard case).

#### Implementation checklist

- [x] Add `'array'` to `ScalarKind`, `ScalarValue`, `NormalizedValueForKind`.
      New types: `ArrayValue = ReadonlyArray<ScalarValue>` and
      `ColumnValue = ScalarValue | ArrayValue`.
- [x] Widen `CustomAggregateReducer` return type to `ColumnValue | undefined`.
      `ReducerDef.outputKind` gains `'array'`.
- [x] Ship `unique` as the first built-in (outputKind: `'array'`). Works in
      `reduce`, `aggregate`, and `rolling` contexts.
- [x] JSON round-trip support for array cells (passes through unchanged;
      validate enforces element kinds on read).
- [x] Array column operators: `arrayContains`, `arrayContainsAll`,
      `arrayContainsAny`, `arrayAggregate`, `arrayExplode`. All append-mode
      operators (`arrayAggregate`, `arrayExplode`) accept `{ as }`.
- [x] `top(n)` — top N values by frequency with incremental bucket/rolling
      state. Usable as `'top3'`, `top(3)`, or any `` `top${number}` ``.
- [ ] `percentiles(...qs)` — multi-quantile reducer. Deferred; the
      workaround of declaring three `pNN` columns is cheap and clear.
- [ ] Live equivalents of array column operators (deferred until there's a
      concrete live dashboard need).

### Internal storage shape: row-oriented stays; columnar lives at the chart boundary

**Status: SUPERSEDED by Phase 4.7 (Columnar core substrate), 2026-05-11.** A
Codex evidence-gathering spike measured the gap — see
[`docs/rfcs/columnar-core.md`](docs/rfcs/columnar-core.md) and
[`docs/briefs/core-columnar-store-spike.md`](docs/briefs/core-columnar-store-spike.md).
The evidence (6–12× numeric reduce, 4× memory reduction under lazy event
materialization, neutral on string reducers) plus the strategic timing
argument (do this before streaming-RFC milestones B/C/D so they ship on
the substrate, not on row-oriented internals that need retrofitting)
flipped the decision. The original deferred-design framing below stays
for trajectory reasons — future readers can see what was decided when
and why the position changed. Phase 5 of this PLAN is the binding entry.

---

**Status (prior): deferred. Logged 2026-05-10.**

**Decision (superseded).** Keep row-oriented (`Event[]`) internal storage in `TimeSeries` /
`LiveSeries`. Columnar storage lives at the **chart-package boundary** as an
explicit fast path (`ChartDataSource` + typed-array buffers per
[`docs/rfcs/charts.md`](docs/rfcs/charts.md)), not as a core refactor.

**Reasoning.** A modern analytical engine would store columns: one
`Float64Array` per numeric column, validity bitmaps, string interning,
sequential cache-friendly iteration, SIMD-friendly inner loops in reducers.
Apache Arrow / DuckDB / Polars all do this. The win is real — at firehose
× 100k events × tens of columns we're paying ~6×–10× the memory and
iteration cost a columnar store would.

But the cost-benefit analysis at pond's target operating point doesn't
support the rewrite:

- 100k+/sec on a non-distributed JavaScript runtime is plenty for the
  workloads we target. Workloads needing millions/sec are on Beam / Spark —
  a different operational and cost regime that pond explicitly doesn't
  compete with (per the streaming RFC's "non-goals").
- The `Event` API ergonomics (`event.get('cpu')` schema-narrowed, `set` /
  `merge` / `select` / `collapse` / `data()` / `key()`) are a real
  product moat. They're across 1,300+ tests, every reducer, every operator,
  every React hook. We don't disassemble that for "a bit more speed."
- The row-oriented tax is real and visible — v0.14 / v0.15 perf wave was
  a string of row-shape paper cuts (`estimateEventBytes` removal in
  v0.14.0, trusted-pipeline partition router in v0.14.0,
  `samples.rollingState()` scalar-add allocation fix in v0.14.3, O(1)
  head-index eviction in v0.15.2). Each fix addresses an instance of the
  class; columnar would address the class. We accept the per-fix cost in
  exchange for keeping the API intact.

**Where columnar pays back NOW: the browser.** Beam / Spark don't run
there. The perf ceiling for visualization at firehose × tens of series
is a place pond can credibly win — `@pond-ts/charts` adopts columnar
internals via the layered architecture in
[`docs/rfcs/charts.md`](docs/rfcs/charts.md), specifically the typed-array
store + chunked Path2D cache + viewport/decimator pipeline. The core
public API stays row-oriented; columnar lives behind the chart adapter
boundary.

**Three positions considered:**

1. **Row-oriented core + chart-side columnar adapter (adopted).** The
   chart package commits to columnar from v1 via `ChartDataSource`; the
   core API stays `Event`-shaped. User-facing perf cliff (browser
   rendering) closed without forcing a core refactor.
2. **Hybrid: columnar internals + Event views + row API outside (right
   north star, deferred).** TimeSeries internals migrate to typed-array
   columns; `at(i)` / iterators return Event _views_ that read lazily from
   buffers. Reducers' hot loops can drop to column reads. The
   duckdb / Arrow / Polars precedent — _columnar internals, row API for
   ergonomics._ Significant refactor; LiveSeries mutability complicates
   Event lifetimes (held Event view after eviction). Earns its slot only
   after the streaming-RFC milestones land — refactors should follow
   major architectural commitments, not lead them.
3. **Columnar everywhere, Event becomes a transient projection
   (rejected).** Best perf, simplest internals, major API break.
   v2.0 territory; the API moat goes with it.

**When to revisit (Hybrid B):**

- After Phase 4.5 milestones A–D land (the change-stream model and
  capability registry inform what columnar internals would consume —
  e.g. `LiveChange` could carry columnar-batch updates instead of
  per-event `Event`s).
- When chart-side columnar machinery is proven in production (validates
  the inner-loop primitives a core migration would reuse).
- v1.0 is a natural forcing function.

If revisited, **Hybrid B is the target.** A serious RFC at that point —
not before. Premature refactor risk plus the streaming-RFC work earns
more leverage right now.

**Cross-references:**

- The chat thread that surfaced this decision: 2026-05-10, during the
  `@pond-ts/charts` Codex review on
  [`docs/rfcs/charts.md`](docs/rfcs/charts.md). The chart RFC's
  "Internal data shape: columnar typed arrays from day one (Codex 2)"
  section is where columnar got committed at the chart boundary; the
  conversation pivoted on whether the same commitment should extend to
  the core. This entry says no.
- Row-shape paper cuts (evidence of the tax): CHANGELOG entries for
  v0.14.0 (`estimateEventBytes`, trusted-pipeline router), v0.14.3
  (`samples.rollingState()` allocation), v0.15.2 (O(1) eviction).
- Streaming RFC's non-goals (
  [`docs/rfcs/streaming.md`](docs/rfcs/streaming.md) §"Non-goals"):
  "pond should not become 'mini Beam'." Columnar-everywhere is part of
  what would push us in that direction; staying row-oriented in the
  core keeps us on the deterministic-single-process side of the line
  the RFC draws.

---

## Design principles

These hold across all new work:

- **`TimeSeries` stays immutable.** Live mutation belongs in `LiveSeries`.
- **Schema types flow through every operation.** New methods must produce typed
  output schemas. If a method can't be typed, it shouldn't ship.
- **Half-open `[begin, end)` bucketing.** All sequence-based operations use this
  convention.
- **Alignment is separate from aggregation.** `resample` composes them; it
  doesn't merge them.
- **Transforms are views or accumulators.** If an operation needs only per-event
  or carry-forward state, it's a `LiveView`. If it needs a growing buffer
  (buckets, sliding window), it's an accumulator. Both implement `LiveSource`
  for chaining.
- **Data is the clock.** Bucket close, watermark advance, and window eviction
  are all driven by event timestamps, not wall-clock timers.
- **No background timers or implicit scheduling.** The caller owns the event
  loop. The library is a data structure, not a framework.
- **Browser-safe by default.** Node-specific APIs go behind a separate entry
  point.

## Semantics to preserve

### Half-open bucketing

For sequence-based bucketing and alignment, interval membership is half-open:
`[begin, end)`. Example: times `10`, `15`, `20` in bucket `[10, 20)` includes
`10` and `15`, excludes `20`.

### Alignment sample position

- default: `begin`
- optional: `center`
- `end` is intentionally not a target mode

### Temporal selection vocabulary

Keep these distinct:

- `within(...)` = fully contained
- `overlapping(...)` = intersects, no key modification
- `trim(...)` = intersects and clips key extents

---

## Documentation backlog

Items collected from the multi-agent experiments (CSV-cleaner,
dashboard, gRPC pipeline, webapp telemetry). Each is small in
isolation; worth landing as a single MDX pass rather than dribbling
in piecemeal so readers benefit from a coherent "production
deployment" / "observability" surface in one place.

- **⚠️ HIGHEST PRIORITY — the value-axis wave is shipped but
  under-documented.** `scan` (#280), `ValueSeries` + `byValue`
  (#282/#283), and the chart `<XAxis>` x-on-value support
  (#284/#286) all landed in core, but the docs don't yet reflect
  them — a reader can't discover the value-axis story (distance /
  splits / laps x-axes, `split = scan + byColumn`, cumulative via
  `scan`) without reading source. This is different in kind from
  the experiment-derived items below: it's a **shipped public
  feature that the docs don't surface**, not a recipe gap. Concrete
  symptom (2026-06-28): when checking whether `@pond-ts/fit` had
  adopted the wave, the docs were no help — the determination
  required reading `time-series.ts`. Venue: update the core
  operator reference + a dedicated "value-axis charts" how-to /
  concept page; cross-link the RFC (#279). Land before the next
  release so the npm version's docs match its surface.
  **→ Adopted into the Docs site wave, P2** (see the "Docs site wave"
  section above) — the wave's Learn ch. 9 + reference pages are the
  venue. **✅ Shipped:** the core operator reference (`byValue`,
  `byColumn`, `scan`, cross-linked to RFC #279) and the series-level
  concept page landed earlier (#382/#383/#421); Learn ch. 9 closed the
  tutorial level (#446); the chart-level reference page
  (`website/docs/charts/value-axis.mdx` — kind inference, `byColumn`
  histograms, category axis, dual x-axes) closes the reference level.
  Backlog item complete.

- **`pushMany` is the throughput-critical primitive** — call this
  out explicitly in `live-series.mdx`'s push section. Apps forwarding
  events from a per-event source (gRPC streams, EventSource, brokers
  with `qos=1`) should reach for `pushMany` with explicit
  producer-side batching, not "trust consumer-side coalescing." The
  M3 friction notes show macrotask-coalesced `pushMany` averages 1.4
  events/call at saturation — the API works, but only when the
  caller actually batches.

- **GC observation snippet** — six-line `PerformanceObserver` over
  `'gc'` entries, alongside the existing `LiveSeries.on('evict')`
  callback docs. Aggregator deployments need this; pond can host the
  one-paragraph pattern.

- **No-NaN guarantee from numeric reducers** — reducer-reference
  page should state explicitly that `p50`/`avg`/`stdev`/`pNN`/
  `difference` emit `undefined` (not `NaN` or `Infinity`) for empty
  windows, cold windows under `minSamples`, and below-threshold
  states. Surfaced in the webapp-telemetry code as defensive
  `toNumber()` wrappers that wouldn't be needed if the guarantee
  were stated.

- **Same-timestamp event behavior per ordering mode** — the
  `LiveSeries` ordering-modes section should pin what happens with
  ties under each mode. The webapp-telemetry code's `Math.max(ts,
lastTs + 0.001)` monotonicity hack was belt-and-suspenders against
  unclear tie-handling. Documenting "ties accepted under `'reorder'`
  and `'drop'`; throws under `'strict'`" would remove the need.

- **Side-channel latency-measurement pattern** — short recipe / how-
  to showing the `Map<eventKey, pushedAtMs>` pattern for end-to-end
  latency in network-fronted aggregators. The M3 experiment hand-
  rolled this; we explicitly chose not to bake `pushedAt` into pond
  (push→batch is synchronous; the latency is entirely
  application-side). Documenting the pattern is the right
  deliverable.

Likely venue: a new how-to page, "Observing pond-ts in production",
covering eviction listeners, GC observation, end-to-end latency,
push-vs-pushMany guidance, and pointers to the relevant operator
sections. Estimate: 200-400 lines MDX, single PR, ships via
`gh workflow run docs.yml --ref main` — no version bump required.

## Performance expectations and the bench-vs-real-world gap

A design note worth pinning, surfaced concretely by the gRPC
experiment's M3 milestone.

The library benchmark publishes peak throughput numbers (e.g. **538k
events/sec at P=100, N=10** in the multi-partition rolling
benchmark). These numbers are **achievable iff the caller hands
`pushMany` arrays of N events**. Per-event sources without wire
batching see roughly an order-of-magnitude less:

| Scenario                                                    | Effective throughput                            |
| ----------------------------------------------------------- | ----------------------------------------------- |
| Library bench, `pushMany([...N events])`, N=10              | **538k events/sec**                             |
| Per-event push (`live.push([row])` once per source event)   | ~70k events/sec end-to-end (gRPC framing-bound) |
| Macrotask-coalesced `pushMany` over a per-event gRPC stream | ~73k events/sec (+7-17%); avg batch 1.4 events  |
| Wire-level batched `pushMany` (estimated)                   | 200-400k events/sec                             |

The gap is **wire-shape, not pond**. gRPC delivers one event per
`'data'` callback; `setImmediate`-based coalescing rarely catches
more than the event that triggered the schedule. To approach library
peak with a real network source, the **producer must batch at the
wire** (e.g. `stream EventBatch { repeated Event }` in proto, with
the producer accumulating 1-10ms of events per frame and the
aggregator unpacking into a single `pushMany`).

**Documentation implication:** the benchmarks page (and the README's
"performance" section) should grow a one-paragraph callout that
frames the bench numbers honestly:

> _Pond's bench numbers reflect what's possible when the caller hands
> `pushMany` an array of N events. If you're forwarding from a
> per-event source — gRPC `'data'` callbacks, EventSource frames,
> message-broker `qos=1` subscribers — your effective throughput
> depends on whether the wire layer batches. Per-event forwarding
> typically reaches ~14% of the bench peak; producer-side wire
> batching can recover most of the gap. The
> [gRPC experiment's M3 friction notes](link) show this in detail._

Worth doing alongside the docs-backlog pass above — same MDX
deploy.

**`@pond-ts/server` implication:** the eventual server package
should ship a `coalesce({ windowMs })` strategy with a tested
default, plus a reference `EventBatch`-style proto in examples.
Both surfaced as M3 friction-note carry-forwards. Captured here so
the M5 RFC starts with these pre-baked rather than re-discovering
them.

**What this is NOT:** a deficiency in pond. The bench numbers are
real; `pushMany` is the right primitive; the wire-shape consideration
is inherent to network-bound architectures. Documenting the
expectation is the deliverable, not optimisation work.

## Cross-cutting work

These happen throughout the phases rather than being deferred:

- keep this document current whenever a meaningful implementation milestone lands
- keep the docs site aligned with shipped behavior
- add end-to-end examples whenever a major capability lands
- keep API reference generation working in CI
- expand tests alongside every new public API
- prefer benchmark-backed changes for performance-sensitive core refactors
