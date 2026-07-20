# Archive: docs-site, core-docs, and in-site API reference waves (2026-07)

> **Archived from PLAN.md on 2026-07-20** as part of the PLAN reorganization.
> Frozen historical record — do not update. The current roadmap lives in
> [PLAN.md](../../PLAN.md); per-area breakout plans live in [docs/plans/](../plans/).

## Docs site wave — the charts guide buildout (adopted 2026-07-12)

**Decision (pjm17971, 2026-07-11/12): build a best-in-class docs site
for `@pond-ts/charts` and the data→chart pipeline.** The full plan —
19-agent research across charting-library docs sites + repo grounding,
three-lens adversarial review, and the user's design directives —
lives in
[docs/notes/charts-docs-site-plan-2026-07.md](../notes/charts-docs-site-plan-2026-07.md)
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
[docs/notes/core-and-landing-docs-plan-2026-07.md](../notes/core-and-landing-docs-plan-2026-07.md).
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

- **Right-sidebar TOC shipped:** every API page exports a computed
  `toc` from its model (the MDX loader honors an explicit `export
const toc`, so the theme's own right-rail renders it — no swizzle):
  classes list constructor / properties / static methods before
  instance methods, components list their props, function pages their
  functions. SSR'd like any docs page (`TimeSeries` carries 86
  entries).
- **Functions tranche + /api swap-over shipped:** function-group
  pages (`ApiFunctionsPage` — several free functions per page, indexed
  and anchored, grouped the way API.md groups them): core
  `Functions` (`toTimeRange`, `top`); charts `Data adapters` (the 10
  `*FromTimeSeries` / stacks / category helpers), `Theming`
  (`useChartTheme`, `cssVarTheme`), `Scales & live values`
  (`scaleTradingTime`, `scaleBand`, `createLiveValue`). **`/api` now
  redirects to the in-site reference**; navbar/footer repointed; the
  13 doc-page deep links into `/generated-api/charts|core/` rewritten
  to in-site pages; the core and charts typedoc HTML sub-sites
  retired from the build chain (react / fit / financial sub-sites
  remain, linked from the API index, until their own tranches).
  Sidebar label dropped "(pilot)".
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
