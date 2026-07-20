# Archive: `@pond-ts/charts` canvas wave (2026-06 → 2026-07)

> **Archived from PLAN.md on 2026-07-20** as part of the PLAN reorganization.
> Frozen historical record — do not update. The current roadmap lives in
> [PLAN.md](../../PLAN.md); per-area breakout plans live in [docs/plans/](../plans/).

## Current focus — `@pond-ts/charts` (canvas wave, kicked off 2026-06-17)

**Decision (pjm17971, 2026-06-17): build `@pond-ts/charts` canvas-first. No
SVG.** The renderer-fork scoping (the canvas RFC, built for the gRPC firehose,
vs estela's working SVG chart) resolved to **canvas**: SVG is a dead end for the
firehose / dashboard consumers, and one canvas engine that also handles
interactions serves estela _and_ them. estela not pulling on canvas as hard
_today_ doesn't mean it won't — we build the chart that works for both. The
charts RFC ([docs/rfcs/charts.md](../rfcs/charts.md)) is the architecture;
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
  [`docs/notes/charts-m1-friction.md`](../notes/charts-m1-friction.md); this
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
    [`docs/notes/charts-decimator-assessment-2026-07.md`](../notes/charts-decimator-assessment-2026-07.md)
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
    `binByAxis`. **Phase 2 (chart-side viewport culling) DONE:** line / area /
    band layers clip to the visible slice (+1 entry/exit point) before path work
    via `src/culling.ts` (`visibleWindow` bisect + `cullChartSeries` /
    `cullBandSeries`), so a pan repaint is O(visible) not O(N) — the #256 failing
    metric. Measured (`scripts/perf-culling.mjs`, JS path-gen cost): a 1M-point
    line zoomed in drops from ~29 ms/frame (over the 60 fps budget) to ~0.06 ms;
    fully-visible draws no-op (byte-identical). §2.3 interaction-reads-source
    holds by construction (culling is draw-path only). Area keeps its fill
    gradient over the full series so the cull is behavior-neutral. **Marks
    fast-follow DONE:** scatter / bars / candles / boxes cull too — they loop
    over index-keyed marks (a scatter's `colorAt(i)`, a bar's `begin[i]`
    selection), so instead of a subarray they restrict the draw loop to a visible
    index range (`visiblePointRange` for scatter, `visibleSpanRange` — a
    span-overlap window that keeps a wide edge-crossing mark — for the
    interval-keyed bar/candle/box), preserving every accessor's `i`. Verified on
    a candlestick `TradingTimeScale` under pan+zoom; bars 500k drop ~23 → 0.16
    ms/frame. **Scatter radius-aware pad DONE (the follow-up #499 flagged):** a
    scatter mark's disc has a pixel radius independent of sample spacing, so a
    dense scatter of fat marks could drop an edge bubble whose centre is >1 sample
    off-screen while its disc overlaps the plot edge (flicker under pan).
    `visiblePointRange` gained an optional `padPx` that widens the data window by
    that many pixels (via `xScale.invert`) before the bisect; `drawScatter` does
    two window calls — pass 1 finds the max drawn radius over the plain window,
    pass 2 re-expands by `maxRadius + |offsetPx|`. Interval marks don't need it
    (width _is_ span). **Phase 3 (M4 line decimator) SPINE DONE:** `src/decimate.ts`
    (`decimateM4`) reads W = device-pixel columns off `ctx.canvas.width` (no
    layer-signature change), builds pixel-column edges, calls
    `Float64Column.binBy(cs.x, edges, 'minMaxFirstLast')` (the Phase-1 reducer —
    confirmed to survive the charts bundle), and emits the
    first/min/max/last-per-column M4 polyline back into `drawLine`. Edges are the
    scale's pixel range (`xScale.range()`) inverted to key space (via
    `xScale.invert`), so buckets stay one pixel column wide on **non-affine**
    scales too (trading-time — the Layer-2 find). Auto-on above ~2 samples/px with
    `<LineChart decimate={false | {threshold}}>` (`DecimateOption`). Gated to the
    honest default (empty gaps, linear curve, no session breaks). Verified
    **visually lossless** (e2e bounds decimated-vs-full to a thin sub-pixel AA
    seam, ~1.8%) + **spike-preserving** (1-in-200k anomaly kept) in the browser;
    1M fully-visible ~34 → 3.4 ms/frame. §2.3 interaction-reads-source holds
    (decimation is draw-only). **§2.2 gap-edge union DONE:** `gapKeyEdges` folds
    each ≥1-pixel interior gap's boundaries into the bucket edges (`mergeGapEdges`),
    so the gap becomes its own empty (`NaN`) bucket with exact pre/post-gap values
    — the `'empty'` gate is gone and **all gap modes decimate** (`'none'` bridges,
    dashed/step/fade draw their connectors across the gap; verified in the browser
    on a gappy dashed 200k line). **Area + band decimation DONE:** `<AreaChart>`
    reuses the line M4 on its outline (gap-union included) with the fill under the
    full-series gradient; `<BandChart>` decimates to the per-column min-lower /
    max-upper envelope (`decimateBand` — never inverts, §2.5; the win is the fill
    raster, ≈W verts vs every sample). Both `decimate={false|{threshold}}`, gated
    off non-linear curve; verified in the browser (200k Area + Band stories).
    **`sessionBreaks` decimation DONE:** `decimateM4` unions the session-break
    instants into the bucket edges (alongside the gap edges) so no bucket merges
    two sessions; `sessionRuns` then splits the decimated series per session —
    verified on a ~40k-point trading-time line (Tidal case: decimates + clean
    per-session pen-ups). **So Phase 3 is complete** except **non-linear curves**
    (backlogged + documented — a smoothing curve would distort the
    4-points-per-column polyline); scatter stays `preserveSparse` (cull only).
    **Phase 4 re-bench DONE:** the #256 Playwright pan-FPS harness re-run with
    decimation on (`perf/baseline.json` + RESULTS.md "Re-bench" section) — the
    100k `panFps` cliff is gone: line/band hold **90–120 fps to 1M** (was 8/4.8
    fps at 100k, frozen at 1M), `three` 24 fps at 1M (the weak floor — 3× walk +
    data-side cost). Initial render at 1M line 6,976 → 69 ms. **Remaining → Phase
    5, bench-ordered:** candlestick decimation with Tidal; Path2D cache
    (M4.4) only if the pan bench still misses (it doesn't, except `three`-at-1M).
    **Backlog (documented):** non-linear-`curve` decimation (a smoothing curve
    distorts the 4-pts-per-column polyline; fix = decimate then re-smooth). `plot_width` + visible slice
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
    [`docs/notes/charts-friction-triage-2026-07.md`](../notes/charts-friction-triage-2026-07.md)
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
    [`docs/rfcs/selection.md`](../rfcs/selection.md) — click-select any series
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
    [`docs/rfcs/financial-charts.md`](../rfcs/financial-charts.md) — a first-class
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
    [`docs/rfcs/financial-charts.md`](../rfcs/financial-charts.md): a
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
    [`docs/rfcs/selection.md`](../rfcs/selection.md) — **A2.2 + A3** — is built
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
