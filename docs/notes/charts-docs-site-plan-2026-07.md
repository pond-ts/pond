# Charts docs site plan — a best-in-class guide for @pond-ts/charts (and making the most of pond)

_2026-07-11 · Pond technical consultant (Claude) · status: ADOPTED into PLAN.md 2026-07-12 (v2.2); v2.1 = visual-design direction (§9.5, §10); v2.2 = live-embeds directive + Storybook-discipline mandate (§1 P3, §9); v2.3 = third-party charting policy (§3a). PLAN.md's Docs site wave entry is the binding version._

This is the site-structure plan for the charts documentation buildout:
incremental knowledge-building from getting-started to advanced topics,
plus a growing library of guides and recipes. It is grounded in (a) a
19-agent research pass — 14 documentation-site surveys across charting
libraries and pedagogy exemplars (Observable Plot, ECharts, Highcharts,
Recharts, visx, Nivo, TradingView Lightweight Charts, Chart.js,
AG Charts, Victory, D3, react-timeseries-charts + pondjs, react.dev,
Diátaxis) and 5 repo-grounding reports (charts API surface, Storybook
inventory, current website state, core-for-charts mapping, doc-debt
mining); (b) a first-hand read of the export barrel, stories, and
current site; and (c) a three-lens adversarial review of the v1 draft
(ground-truth vs repo, ~60 claims verified, no blockers; pedagogy/IA;
consumer personas) whose amendments are folded in — see the provenance
note at the end.

Nothing here is committed until adopted into PLAN.md.

---

## 1. What "best-in-class" means here — eight principles

Each principle carries its evidence; these drive every structural choice
below.

**P1 — Separate the four question types.** Learn (tutorial), how-to
(task), reference (lookup), explanation (why) get separate navigation
homes, cross-linked but never mixed on one page. Every strong site
surveyed does this (ECharts Handbook: Concepts / How-To / Best
Practices; TradingView: Docs / Tutorials / API; react.dev:
Learn / Reference). The cautionary tale is Recharts: 78 examples
organized only by chart type, no path after onboarding, capabilities
buried — the most-used React charting library has the weakest docs, and
that's why.

**P2 — One continuous data→chart narrative.** The predecessor split its
knowledge across two sites: RTC's docs assumed pondjs (`Getting started`
calls `.timerange()` on a TimeSeries it never explains), and pondjs's
docs never rendered a chart — its `rate()`/`align()` examples stop right
before the visual payoff. Neither site ever took a reader from raw data
to rendered chart in one story. The monorepo site can, and **no
competitor even tries**: every surveyed library assumes "array of
objects" data and teaches zero data shaping. Pond's transform pipeline
(`aggregate` → `rolling`/`baseline` → `byColumn` → chart) is the
differentiator, playing the role Observable Plot's transforms play in
its grammar. "Make the most of pond" is not a bolt-on chapter; it is the
spine of the learn track. Corollary at page granularity: every
cross-cutting concept has **one canonical page** that owns it (§3a);
everything else links.

**P3 — Every chart on the site is alive (v2.2, user direction).** Today
the site contains zero rendered `@pond-ts/charts` output (the one chart
screenshot on the site is the Recharts-based dashboard guide's) — no
deployed Storybook, no screenshots, no live examples. The fix is **live
chart embeds**: real mounted components in the MDX pages, cursors and
hover-highlighting and selection always on — because charts are alive
when you touch them, and a static screenshot of an interaction system
is a contradiction. Every embed is a conversion opportunity: the site's
real sell is convincing a developer about to vibe-code their own custom
SVG page that this is better. The crucial unbundling (the v1 draft
conflated these): live _embeds_ are a rendering concern and are IN this
wave; live _editable code_ (Sandpack/StackBlitz, Twoslash, bespoke
teaching widgets) is the living-examples RFC #285's scope and stays
deferred behind it. Mechanism in §9.

**P4 — Feature-axis reference, scenario guides.** The Storybook
reorganization (PRs #325→#326) already proved the feature-axis walk
surfaces bugs and buried knobs; CLAUDE.md canonizes it. The story tree —
221 stories in 31 groups — maps almost 1:1 onto reference pages and is
the highest-leverage reuse in this plan. Scenario narratives stay in
how-to guides, exactly as the Diátaxis quadrants prescribe.

**P5 — Bidirectional links, no dead ends.** RTC's best structural idea:
every API page opened with a thumbnail gallery of every example using
that component (reference→example), while examples linked to source
(example→truth). react.dev's Learn↔Reference hyperlink graph is the
same idea. Every reference page here ends with: related stories (deep
links into the deployed Storybook **plus** links to the story source
`.tsx` on GitHub, for readers and agents alike), related guides,
generated API link. Every guide links each component's reference page at
first use.

**P6 — Consistent page templates.** AG Charts and Victory show that a
rigid per-chart-type template (same sections, same order, every page)
makes knowledge transfer predictable and knob coverage auditable.
Defined in §6, including its anti-rot guardrails.

**P7 — Teach the invariants as explanation pages — but only two.** Pond
has unusually well-articulated design law: the indicator law ("an
indicator shows only the axis value, never a label"), pills-vs-flags
vocabularies, the annotations two-register/depth model, style-vs-scale
channels, z-order = declaration order, honest gaps. These get (1) a
"Composed, not configured" mental-model page — the D3 "What is D3?"
move, preventing users from expecting `Chart({data, type})` — and (2)
one consolidated "Design invariants" page. The v1 draft proposed five
essays; the persona review correctly cut that to two — readers meet the
invariants at point of use (learn chapters, template cautions), and the
essays serve the library's self-image more than any reader.

**P8 — Honest docs.** PLAN.md checkmarks (not RFC phase lists) decide
what gets documented; in-flight features get an IA placeholder, not
content. Sharp edges are documented inline where the reader meets them
(Observable Plot's "cautions" pattern), phrased as intentional design
with rationale where that's the truth (AreaChart gap-fill coupling,
BoxPlot cursor exclusion, required numeric `width`). What doesn't exist
is stated — the full honesty list is in §6, and it now includes the
capability walls real consumers hit, not just the polite ones. Honesty
also applies to the Overview: the evaluator gets a "when NOT to use
this" answer with an exit path.

---

## 2. Current state — what the research found

The good: core docs are strong (per-operator reference pages,
consistent voice), the how-to-guide genre is proven
(`ingesting-messy-data`, `dashboard-guide`, `histograms`,
`categorical-charts`), typedoc reference generation works, and three
good charts pages already exist (`recipes/theming.mdx`,
`recipes/using-charts.mdx`, `recipes/resizable-panels.mdx`).

The broken (all verified against the live tree and source):

| #   | Issue                                                                                                                                                                                                                                                                                    | Severity                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| B1  | `pond-ts/advanced/charting.mdx` (in the sidebar) says `@pond-ts/charts` doesn't exist ("on the long-term roadmap, likely built on visx") and teaches a Recharts bridge as _the_ charting story                                                                                           | Actively misleading          |
| B2  | The entire `docs/recipes/` folder (9 pages) is absent from `sidebars.ts` — unreachable by nav; the homepage "Explore an example" CTA links into it anyway                                                                                                                                | 9 orphaned pages             |
| B3  | `charts/index.mdx` omits `Candlestick`/`ohlcFromTimeSeries` entirely and describes a `BoxPlot` candlestick `shape` value that **no longer exists at all** (`BoxShape` is `'whisker'\|'solid'\|'none'`)                                                                                   | Describes a nonexistent API  |
| B4  | Zero rendered `@pond-ts/charts` output anywhere on the site; Storybook not deployed, not linked                                                                                                                                                                                          | Credibility gap              |
| B5  | The value-axis wave (scan, ValueSeries, byValue, XAxis-on-value) is PLAN's own self-declared highest-priority doc gap                                                                                                                                                                    | Undocumented shipped feature |
| B6  | Cursor system, annotations, selection, indicators: shipped and stable for weeks, zero narrative docs ("follow as the API settles" note is stale)                                                                                                                                         | Whole systems invisible      |
| B7  | **`@pond-ts/financial` is invisible to the site**: five packages are published, but typedoc configs exist for only four, the `/api` landing lists two, and financial has no sidebar section — yet the trading-time axis and the flagship financial guide depend on its `TradingCalendar` | Whole package undocumented   |
| B8  | `intro.mdx` site-map paragraph describes a sidebar that no longer exists                                                                                                                                                                                                                 | Stale chrome                 |
| B9  | No search across ~53 pages + typedoc sub-sites; dark mode disabled site-wide (while charts ship dark-mode theming); no redirect infrastructure for moved pages                                                                                                                           | Infrastructure debt          |

---

## 3. Proposed information architecture

The charts section grows from one page into a structured sub-site with
its own internal learn/reference split; the site-level How-to guides and
Recipes sections serve all packages. Everything below maps to
`sidebars.ts` categories.

```
Start here                          (light touch — fix, don't rebuild)
├─ Introduction                     ← rewrite "In this docs site"; add two doors:
│                                     "chart data" → charts Learn track
│                                     "process data" → existing core path
├─ Getting started
├─ Concepts (9 pages, unchanged)
└─ Creating series

pond-ts (core)                      (unchanged except:)
└─ Advanced → Charting              ← SHRINK to a stub: banner "pond has
                                      first-party charts →" + the honest
                                      exit-path paragraph (bridging pond data
                                      to other chart libraries). Not maintained
                                      bridge content.

@pond-ts/react                      (unchanged)

@pond-ts/charts                     ★ THE BUILDOUT
├─ Overview                         ← rewritten index, evaluator-first (§5a)
├─ Gallery                          ← curated shop window: 8–12 LIVE hero
│                                     charts (financial terminal, ops
│                                     dashboard, activity chart, annotated
│                                     chart …) — the cards are mounted
│                                     components, not thumbnails (the visx
│                                     move, upgraded: touch them right in the
│                                     grid), each linking its guide + story.
│                                     [P1]
├─ Learn charts                     ← the tutorial track, §5 (9 chapters)
├─ Chart types                      ← per-type reference, §6
│  ├─ (section index: render strip + links)
│  ├─ LineChart · AreaChart · BandChart · ScatterChart
│  ├─ BarChart (bars · histograms · categories)
│  └─ BoxPlot · Candlestick
├─ Financial charts                 ← the subsystem hub (AG-style): assembles
│                                     candlestick + volume row + trading-time
│                                     axis + crosshair/OHLC readout + live
│                                     price pill into one sequenced page;
│                                     "Coming from TradingView" vocabulary
│                                     mapping table; links @pond-ts/financial
│                                     for TradingCalendar construction.  [P2]
├─ Axes & layout
│  ├─ Y axes  ·  X axes             (X-axes page owns timezone rendering)
│  ├─ Rows, gutters & multi-panel layout
│  ├─ The category axis             (flagged "new in 0.43")
│  └─ The trading-time axis         (cross-package: charts scale +
│                                     financial calendar)
├─ Interaction
│  ├─ Cursors & readouts            (all 7 modes rendered side by side +
│  │                                  onTrackerChanged + controlled cursor —
│  │                                  one page: the callback is how you
│  │                                  consume the modes)
│  ├─ Selection & hover             (id-gates-interactivity; single-select only)
│  └─ Pan, zoom & range selection   (new [number,number] contract;
│                                     select-to-zoom loop)
├─ Annotations & indicators         (ONE section — the learn track teaches them
│  │                                  together; the reference must match)
│  ├─ The annotation model          (two registers, depth/brightness, 3 modes,
│  │                                  pills-vs-flags + the indicator law)
│  ├─ Region · Baseline · Marker    (1–3 pages, split only if content volume
│  │                                  justifies; Baseline/Marker are near-duals)
│  ├─ Editing & creating annotations
│  └─ Axis indicators & live values (YAxisIndicator, createLiveValue,
│                                     x-axis marker pills)
├─ Missing data & gaps              ← cross-cutting page: the core→chart gap
│                                     pipeline (fill/maxGap upstream, GapMode
│                                     downstream) + per-layer behavior matrix
│                                     (Line vs Area's coupled fill/outline vs
│                                     Band always-breaks vs Bar).  CANONICAL
│                                     owner of gap semantics.
├─ Theming                          ← re-homed theming.mdx, expanded; OPENS
│                                     with the decision table (CSS tokens /
│                                     hardcoded palette / runtime flips → which
│                                     of literal theme, cssVarTheme,
│                                     useChartTheme) + theme-identity note
├─ Data adapters                    ← the second API surface: from*/stacksFrom*/
│                                     categoryStack/transposeRow + column
│                                     contracts (today JSDoc-only in data.ts)
├─ Cheat sheet                      ← one page, agent- and returning-user-
│                                     oriented: every component × data contract
│                                     × theme slot × one-line caution, plus the
│                                     capability/support matrix (chart × axis
│                                     kinds × cursor participation × selection
│                                     × gap modes). CANONICAL owner of the
│                                     matrices; Overview shows the compact cut.
├─ Rendering & performance          ← austere reference: canvas model, repaint
│                                     contract, measured perf envelope
│                                     (N points × M layers × K Hz — the accepted
│                                     #395 docs deliverable), many-charts-on-a-
│                                     page costs, decimation status (none yet)
├─ Design philosophy (2 pages)      ← §7: "Composed, not configured" +
│                                     "Design invariants"
├─ Accessibility                    ← honest status page: what the canvas model
│                                     implies, what exists (onTrackerChanged as
│                                     the hook for accessible readouts, theme
│                                     contrast), what doesn't (no DOM per point,
│                                     mouse-only interaction today)
├─ Install & integration            ← re-homed using-charts.mdx + the width
│                                     contract + SSR/Next.js behavior + touch
│                                     status, by name
├─ Troubleshooting                  ← the blank-canvas checklist: mistyped axis
│                                     id, width 0, range misses data, wrong
│                                     column name — canvas fails silently, so
│                                     this is the highest support-deflection
│                                     page in the plan
├─ Coming from react-timeseries-charts
│                                   ← mapping table for the highest-intent
│                                     arrivals: Charts→Layers, styler→theme/as,
│                                     EventMarker→Marker/indicators,
│                                     pondjs→pond-ts pointers
└─ [link] API reference (charts)    (typedoc, unchanged)

@pond-ts/financial                  ← NEW minimal section (fixing B7):
├─ Overview                           index.mdx with the TradingCalendar
│                                     quickstart (fromRules/fromSessions,
│                                     barSequence/sessionSequence, tagSessions)
└─ [link] API reference (financial)   (new typedoc.financial.json)

@pond-ts/fit                        (unchanged; gap noted, out of scope)

How-to guides                       ← §8: existing 4 + new roster
Recipes                             ← §8: genre redefined by SCOPE, re-homed
                                      into the sidebar
Reference
├─ Benchmarks
├─ Glossary                         (absorbs the value-axis naming decision)
└─ Versioning & breaking changes    (ChartTheme.candle; onRegionSelect pair)
```

Rationale for the shape:

- **Charts gets its own learn track** rather than extending Start-here,
  because chart-first arrivals are now the top of the funnel (three of
  four consumer tracks — estela, Tidal, SPARC — came for charts) and
  D3/Recharts evidence says a learner must reach first-render inside
  ~10 minutes without a data-theory prerequisite. Core concepts are
  pulled in on demand (chapters 3–4) with links into the existing core
  pages, which stay the deep reference.
- **Cross-cutting systems are sections, not per-chart-type
  subsections** — the Nivo/AG/Victory pattern that prevents 7×
  duplication, and it matches how the container actually works
  (cursor/selection/annotation state live on `ChartContainer`, not on
  the layers).
- **The story tree is the reference IA.** Annotations/{Baseline, Marker,
  Region} → the Annotations & indicators section; Cursors/{6 modes} +
  the legacy top-level Interactions group → Cursors & readouts;
  Indicators/{X,Y} → the axis-indicators page; Axes + Layout stories →
  Axes & layout; TradingTimeAxis(+Interactions) → the trading-time page.
  Where Storybook itself is inconsistent (`Layout` vs
  `Layouts/Multi-Panel`; top-level `Interactions` duplicating
  `Cursors/*`; BarChart's knobs split across three story files), the
  docs pick the clean name; retitling stories to match is opportunistic
  later work, not part of this wave.
- **Financial charts get a hub, not just scattered pages.** The
  financial path otherwise crosses five sections; the hub sequences the
  pieces (the plan's own survey credits AG Charts for exactly this) and
  is where the TradingView vocabulary bridge lives.

### 3a. Content ownership (anti-drift rule)

For every cross-cutting concept, one canonical page owns the semantics;
every other mention links. This is the page-granularity version of the
RTC/pondjs lesson, and "restates instead of links" becomes a review
checklist item for all P2/P3 PRs.

**Third-party charting policy (v2.3, user direction).** The bridge
page (`pond-ts → Advanced → Using other chart libraries`) leans hard
into `@pond-ts/charts` as _the_ charting answer to pond's data — and
is the **only** place in the docs that discusses data portability out
of pond in the context of third-party chart packages (`toPoints`, the
column API as an export path, and a Recharts mention/example are
sanctioned there, nowhere else). Every other page assumes
`@pond-ts/charts`. This joins "link, don't restate" on the docs-PR
review checklist.

| Concept                                                           | Canonical owner                                                             | Everyone else                                             |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------- |
| Gap semantics (fill/maxGap → GapMode, per-layer matrix)           | Missing data & gaps                                                         | chart-type variant bullets, ch. 4, philosophy — link only |
| Value-axis model (`ValueSeries`, `byValue`, monotonicity)         | `start-here/concepts/value-axis` (series level) + X-axes page (chart level) | ch. 9, guide #4, glossary                                 |
| Category axis (band scale, label policy, `transposeRow` contract) | The category axis page                                                      | `categorical-charts` guide, ch. 9, BarChart page          |
| Trading-time axis + calendar construction                         | The trading-time axis page (chart) + financial Overview (calendar)          | Financial hub, Candlestick page                           |
| Capability/support matrices                                       | Cheat sheet                                                                 | Overview (compact cut), chart-type pages (own row only)   |
| Width contract & responsive pattern                               | Install & integration (contract) + the responsive-width recipe (pattern)    | ch. 1 caution, perf page, multi-panel page                |
| Theming pipeline & entry-point choice                             | Theming                                                                     | ch. 5, chart-type theming slots                           |
| Live re-render model (`useSnapshot`, throttling)                  | ch. 8 (teaching) + `@pond-ts/react` hooks page (reference)                  | guides, LiveValue page                                    |
| Prop-identity/re-registration footgun                             | The hoist-your-callbacks recipe                                             | ch. 2 caution box, YAxis/layer template cautions          |

---

## 4. What happens to existing content (no orphans, no big-bang)

| Existing page                                                                | Disposition                                                                                                                                                                             |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `charts/index.mdx`                                                           | Rewritten as Overview (B3 fixed in P0 first); its "minimal API set" map tables survive into the Overview/cheat sheet — they're the best returning-user artifact on the current site     |
| `recipes/theming.mdx`                                                        | Re-homed → charts/Theming, expanded (redirect kept)                                                                                                                                     |
| `recipes/using-charts.mdx`                                                   | Re-homed → charts/Install & integration (redirect kept)                                                                                                                                 |
| `recipes/resizable-panels.mdx`                                               | Becomes the canonical responsive-width recipe (P1); mechanics cross-linked from Install & integration and the multi-panel page                                                          |
| `recipes/error-rate-dashboard`, `streaming-dashboard`, `telemetry-reporting` | Re-shelved as **guides** — they are multi-technique end-to-end walkthroughs and fail the recipe scope test (§8)                                                                         |
| `recipes/cpu-metrics`, `streaming-baseline`                                  | Stay recipes, re-homed into the sidebar                                                                                                                                                 |
| `pond-ts/advanced/charting.mdx`                                              | Shrunk to a stub: banner to `@pond-ts/charts` + the evaluator exit-path paragraph ("plain arrays, no transforms → use Recharts; here's the bridge"). No maintained bridge content       |
| `how-to-guides/*` (4)                                                        | Unchanged; `histograms` + `categorical-charts` get "reference page" cross-links once those exist                                                                                        |
| `dashboard-guide.mdx` (Recharts-based)                                       | Kept only until the charts-native dashboard guide (§8 guide #2) lands, then retired/replaced — hardened by the v2.3 third-party policy (Recharts content lives only on the bridge page) |
| Core + react + fit sections                                                  | Untouched                                                                                                                                                                               |

All moved pages keep their old URLs via
`@docusaurus/plugin-client-redirects` (new infra item, §10) — agents and
search engines hold the old links.

---

## 5. The Learn track — nine chapters, one running example

The RTC pattern worth copying exactly: **one canonical example threads
the whole track** — the intro's teaser is the same code the chapters
grow, so the learner never loses their working chart (react.dev's
scaffolding principle).

Running example: a small **server-metrics series** (cpu + latency per
host — matches the existing `cpu-metrics` recipe flavor, gives
`partitionBy` a natural role, and goes live in ch. 8). The
SF-temperatures dataset (real, citable, already a fixture) appears as
the "real data" cameo in ch. 4's band chart. Storybook fixtures are
build-excluded from the npm package, so each chapter inlines its
~10-line data generator — ch. 1 frames it explicitly as
"not-yet-explained, copy it for now"; ch. 3 explains it.

Each chapter opens with react.dev-style "You will learn" bullets and
ends with a recap + where-next links. Every chapter has at least one
**live chart embed** — cursors and hover working from ch. 1, so the
learner is touching the interaction system pages before it is formally
taught. Example code is single-source (§9.2): the code shown is the
component mounted — complete, imports included, never fragments.

1. **Your first chart** — install; `ChartContainer`/`ChartRow`/`Layers`/
   `LineChart`/`YAxis` in ~15 lines; render. Teaches: charts are
   composed, not configured; `series` + `column`. Three deliberate
   boxes: (a) **"Bring your own data"** — you have an array of objects:
   `TimeSeries.fromJSON(...)` in 5 lines, "explained in ch. 3" (the
   chart-first arrival's first question, answered in minute five);
   (b) a two-line **styling teaser** (`as` + one theme override, "full
   story in ch. 5"); (c) the **width caution** — `width` is a required
   number, here's the measured-width recipe link. Under 10 minutes to
   first render.
2. **Anatomy of a chart** — the layout model: rows share the x axis,
   axes are declared and linked by `axis` id, `Layers` is the z-stack
   (declaration order, last on top), gutters/slots align stacked rows.
   Dual-axis and two-row examples. Plus the **prop-identity caution
   box**: inline `format` closures and fresh projections re-register on
   every render — hoist them (links the recipe). This is the chapter
   the whole reference section leans on.
3. **Feeding charts pond data** — task-first, not bottom-up: "I have
   data from my API" → `fromJSON`/`fromColumns` → rendered. Then the
   concepts, each justified by a rendered payoff: temporal keys
   (`Time` vs `Interval` — and now bars work, because bar-shaped layers
   read key spans), columns and what a draw layer actually reads (first
   sight of the data-contract idea). Deep links into Start-here/core
   for the theory.
4. **Shaping data to chart** — the "make the most of pond" chapter and
   the track's centerpiece: `aggregate` to buckets → BarChart;
   `rolling` + `baseline()` → smoothed line + BandChart envelope;
   `partitionBy` → per-host multi-series; `byColumn` → histogram bins.
   Problem-first framing (Plot's transforms-page move: "raw data is
   rarely chart-shaped"). Each transform links its core reference page.
5. **Styling and theming** — the styling pipeline as one concept:
   column → `as` semantic role → `theme.line[as] ?? default`; style and
   scale are separate channels _by design_ (philosophy link);
   `cssVarTheme`/`useChartTheme` for design tokens and dark mode; the
   decision table (link to Theming). Customization is the #1
   post-onboarding question everywhere (ECharts orders Style second;
   Recharts' "Customize" is its first guide) — the ch. 1 teaser feeds
   the early appetite; the full pipeline needs ch. 3–4's vocabulary.
6. **Reading and selecting values: cursors, readouts, zoom** — `cursor`
   modes tour (line → point → inline → flag → crosshair),
   `onTrackerChanged` for off-chart readouts, `cursorTime`, controlled
   `trackerPosition` — and the chapter's payoff: the **select-to-zoom
   loop** (region cursor → `onRegionSelect` → `setRange`, back button =
   zoom out, ~20 lines). A time-series tutorial in which the learner
   never changes the visible range would be a hole; this closes it and
   completes the controlled-state story. First sight of the indicator
   law and the pills-vs-flags vocabulary.
7. **Marking up charts: annotations and indicators** — place a
   `Baseline`, a `Region`, a `Marker`; the two-register idea in one
   paragraph (marks are turquoise, data is foam — link to the model
   page); a `YAxisIndicator` on the latest value. Editing/creating is
   deferred to the Annotations & indicators section.
8. **Live charts** — the one indirection every live chart needs:
   `LiveSeries` → `useSnapshot(source, {throttle})` → immutable
   snapshot → chart, taught on the running example gone live —
   **partitioned per host**, so the ops shape is the default shape.
   Explicitly teaches the re-render model (chart renders on snapshot
   cadence, not event cadence), the memoize-your-projections footgun,
   eviction/window links into core live docs, and the honesty note
   that live sources are append-only (a forming candle is
   re-aggregation — see the financial guide). `createLiveValue` for
   the high-frequency price-tag pill. This chapter exists because a
   doc that shows `live.on('event') → chart` teaches the wrong model.
9. **Beyond the time axis** — the x axis is inferred from the data,
   never declared: `ValueSeries` (`byValue`/`fromColumns`) → linear
   value axis (vol smile, pace curves); `categories`/`transposeRow` →
   category axis (new in 0.43); `calendar` → trading-time axis
   (sessions, collapsed gaps). One rendered example each, then links to
   the three deep reference pages. Closes B5 at the tutorial level.
   The recap deliberately lands on the **Chart types index and the
   Gallery** — Scatter/BoxPlot/Candlestick never star in the track, and
   this is where learners discover them.

### 5a. The Overview page (evaluator-first)

The rewritten `charts/index.mdx` is ordered for the 15-minute
evaluator, not the learner (the learner's door is one click away):
**live hero charts** — the first thing the evaluator does is touch one
and watch the crosshair, hover highlight, and selection just work;
that moment is the pitch to the developer about to vibe-code their own
custom SVG page — → one realistic ~20-line snippet (the source of the
chart they just touched, per §9.2) → compact capability matrix (the
cheat sheet's short cut) → **"Why @pond-ts/charts / when not to use
it"** — the honest positioning paragraph: canvas +
streaming-first + the transform pipeline on one side; "you adopt the
pond TimeSeries data model, width is explicit, pre-1.0" on the other,
with the exit path ("plain arrays and no transforms → Recharts; the
bridge stub is here") — → a "used in production for" line (activity
dashboards, a financial terminal, ops telemetry) → versioning link →
the two doors (Learn / cheat sheet).

---

## 6. Reference sections — templates and sourcing

**Per-chart-type template** (every Chart types page, same order,
AG/Victory-style):

1. Live hero embed + one-line "when to use"
2. Minimal usage snippet (the hero's own source, §9.2)
3. **Data contract** — which series kinds (its row of the support
   matrix), which columns the layer reads, which adapter shapes it
   (`bandFromTimeSeries`, `OhlcColumns`, …). The pond-specific
   must-have: these contracts exist today only as JSDoc in `data.ts`.
4. **Compact props table** — every public prop, one line each, linked
   to typedoc anchors (the returning user's scan target)
5. Variants — one subsection per prop/mode, mirroring the story
   fan-out (`curve`, `gaps`, `baseline`, `variant`, `colorBy`, …),
   each with a live embed. **Guardrail:** a variant subsection is a state
   description + minimal snippet; data _shaping_ is delegated by link
   to ch. 4 / Data adapters — the moment a variant explains
   `aggregate`, it has become a tutorial and gets cut back.
6. Interaction behavior — cursor participation (incl. the
   BoxPlot-vs-Candlestick x-snap asymmetry), selection/hover support
   (`id`-gated; today only Bar + Scatter)
7. Theming slots (`theme.<kind>`, the `as` roles it consumes)
8. Cautions — sharp edges inline (doji exact-equality; histogram is a
   BarChart mode, not a component; …)
9. Footer links: Storybook group deep-link **+ story source on
   GitHub**, related guides/recipes, typedoc page

Notes: BarChart's page unifies what Storybook splits across
Bar/Histogram/CategoryAxis files — one page, three modes, every knob.
Where story coverage is thin (Area, Band, BoxPlot), the docs page still
fans out every prop; commissioning the missing stories is a noted
follow-up, not a blocker.

**Cross-cutting section pages** follow a lighter template: concept
intro → rendered taxonomy (e.g. all 7 cursor modes side by side) →
per-variant subsections → controlled/uncontrolled patterns → cautions →
links. Sourcing is direct from the story groups listed in §3.

**The honesty list** (aggregated on the cheat sheet, stated inline where
relevant; from the ground reports _and_ the real consumer friction
records): selection is single-select only; annotations don't snap to
data samples yet; no auto-decimation yet; horizontal category axes
throw; `onRegionSelect` emits the neutral `[number, number]` pair
(post-0.43 contract); **live sources are append-only** (no
snapshot-replace; forming-bar updates are re-aggregation); **no
built-in legend or empty-state chrome** (consumers build their own
today); **interaction is mouse-only** (no keyboard/touch access to
cursor/selection yet); y-axes are linear only (no log/symlog); width is
an explicit number (no responsive mode — recipe covers the pattern).

---

## 7. Design philosophy (two pages)

- **Composed, not configured** — why there is no `Chart({data, type})`;
  layers/registries; what the composition buys (multi-row, dual-axis,
  shared interaction state); and the constructive ending the
  config-driven ops persona needs: composition is what makes
  _generating charts from config_ a 30-line function in your codebase —
  linked to that recipe, not refused.
- **Design invariants** — one consolidated page: style-vs-scale
  channels (and Scatter's signed-off encoding exception); the
  two-register annotation model + brightness-as-depth; the indicator
  law; honest rendering (gap modes, bands always break, empty-bin
  honesty); the axis is inferred from the data; z-order = declaration
  order. Each invariant: three sentences of law + one render + links to
  where it bites.

---

## 8. Guides and recipes — the how-to library

**Genre contract — keyed on scope, not voice** (the v1 draft keyed it
on narration and violated its own rule; scope is the reader-facing
distinction):

- **How-to guide** = end-to-end _scenario_ (multi-technique,
  multi-section). When it came from an experiment it keeps the
  first-person friction narrative and companion repo (the CLAUDE.md
  loop); story-seeded guides are legitimate without one.
- **Recipe** = one technique, one page, ≤ ~150 lines, third person,
  no companion repo.

Existing content re-dispositioned against that test in §4 (three
"recipes" are actually guides and move shelves).

**New guide roster** (each maps to a consumer track; phasing per §11):

1. **A financial price chart, end to end** [P3 — pulled forward; the
   highest-persona-value artifact in the roster] — OHLC data →
   `aggregate` rollups → `Candlestick` variants → volume row →
   trading-time axis → crosshair + `showOHLC` + live price pill —
   **including the forming-bar pattern** (append + re-aggregate).
   (Tidal track; `ScenarioPriceVolume` story + tradingAxis fixture are
   the seed.)
2. **A live ops dashboard on @pond-ts/charts** [P4] — partitioned
   LiveSeries → `useSnapshot` → multi-row layout → rolling baselines →
   region select-to-zoom. The charts-native successor to the Recharts
   dashboard guide. (SPARC/dashboard track; LiveSine + MultiPanelLayout
   stories are the seed.)
3. **Annotating a chart: inspect, edit, create** [P4] — the three
   interaction workflows with a toolbar, `onCreate`, controlled
   `selected`/`editing`, synced legend. (Annotations/Scenarios story
   group is the seed.)
4. **Charts on a value axis** [P4] — vol smile by strike
   (`ValueSeries.fromColumns` + Scatter) and pace-by-distance
   (`byValue` + scan). Closes B5 at guide level. (estela + Tidal.)

Cut from this wave: "Observing pond-ts in production" — it's already
specified in PLAN's core documentation backlog, isn't charts work, and
would compete with the flagship guides for budget. It stays in the core
backlog; ch. 8 cross-links its topics.

**Recipe roster** (cheap, high-frequency questions; ordered):
responsive width via ResizeObserver [P1 — the most-confirmed
multi-consumer wall, PLAN #14]; hoisting `format` callbacks / prop
identity [P2 — pairs with the ch. 2 caution]; dark-mode toggle wiring;
external readout panel; selection wiring; bucket-snapped select-to-zoom;
**generating charts from config** (the ops persona's pattern);
**testing your charts** (the repo's own Playwright/visual-baseline
pattern, offered to consumers — cheap and differentiated);
export-to-PNG (`canvas.toDataURL`).

Growth model: each future experiment lands a guide (existing CLAUDE.md
contract); each recurring friction-note lands a recipe. The IA gives
both a permanent, navigable home.

---

## 9. Examples & media strategy (live embeds first — v2.2)

Committed for this buildout:

1. **Live chart embeds are the primary medium.** The docs site takes a
   workspace dependency on `@pond-ts/charts` + `pond-ts` and mounts
   real chart components in MDX (client-only mounting —
   `<BrowserOnly>`/lazy — since the canvas draws in the browser; pages
   SSG fine and hydrate alive). House rules for every embed:
   - **Interaction always on** — cursors, hover highlighting,
     selection. "Alive and beautiful" is the standing acceptance bar;
     an embed with interaction disabled is a bug. Things a reader
     touches are the sell.
   - **Theme follows the site natively** — embeds use
     `useChartTheme`/`cssVarTheme` against the site's own CSS tokens,
     and Docusaurus's dark-mode toggle stamps `data-theme` — which is
     _exactly_ what `useChartTheme` watches. Every page dogfoods the
     theming bridge, and the dual light/dark-image problem evaporates.
   - **Deterministic inline data** — seeded generators, never
     `Math.random()`/`Date.now()` at render (hydration mismatch +
     flaky visuals; same hazard the living-examples retro recorded).
   - **Streaming demos are genuinely live** (ch. 8's chart ticks),
     with a pause affordance.
   - Widths are fixed or use the measured-width recipe pattern —
     dogfooding again.
2. **Single-source examples: the code you read is the chart you
   touch.** Each embed is a real `.tsx` file under
   `website/src/examples/`, imported twice — once as the mounted
   component, once as displayed source (raw import into the code
   block). The site build type-checks and _runs_ every example by
   construction — a stronger guarantee than the tangle→tsc plan it
   replaces for embedded examples. Plain non-embedded fences (shell,
   fragments-of-guides) keep the tangle→tsc gate. This satisfies RFC
   #285's trustworthy-examples goal for embeds by construction; the
   RFC's remaining scope (editable code, Twoslash, bespoke teaching
   widgets like `<WindowExplorer>`) stays open and deferred.
3. **Deploy Storybook — the disciplined API-surface walk.** Build
   `packages/charts` Storybook in CI and publish under the docs site
   (e.g. `/storybook/`), linked from every reference page footer. Role
   division, now crisp: the **docs site** is alive-and-narrative
   (curated, teaching- and scenario-oriented, every chart touchable);
   **Storybook** is the structured walk across the API surface — many
   small examples of how each knob works, one story per prop/state,
   API-adjacent. That role demands more discipline than the current
   tree has (user assessment: "kind of chaotic in some areas"), so a
   **story-discipline pass** is real work in this wave, not
   opportunistic cleanup (reversing the v2 demotion): normalize the
   tree (`Layout` vs `Layouts/Multi-Panel`; retire or fold the legacy
   top-level `Interactions` group into `Cursors/*`), unify BarChart's
   knob coverage (today split across Bar/Histogram/CategoryAxis with
   no complete view), centralize theming stories under
   `Charts/Theming`, and fill the thin fan-outs (Area, Band, BoxPlot
   lack the selection/cursor/styling variants the pattern prescribes).
   Structural normalization rides the P1 restyle PR (one baseline
   regen); coverage fill lands in P2–P3, ahead of the reference pages
   that source from those groups.
4. **Static renders demoted to a supporting role** — needed only where
   a live mount can't go: social/OG cards, the README, and any
   print/llms context. Small script over the existing
   Playwright/static-Storybook infrastructure, on demand rather than
   as the primary pipeline.

5. **One look (v2.1, user direction)** — a single canonical **docs
   chart theme** (`docsTheme` — NOT exported from the package barrel;
   the docs site is itself a charts consumer and follows the "no
   consumer themes in the package" rule) is used by **every live embed,
   story, and static render site-wide**. Aesthetic target: the
   super-professional neutral terminal look — the Tidal-style
   dark-grey/light pairing — in light and dark: embeds follow the
   site's color mode natively via `useChartTheme` (§9.1); the few
   static renders emit both variants. `docsTheme` is built from the
   site's own CSS custom properties via `cssVarTheme` — dogfooding the
   exact bridge the Theming page documents.
   **The one exception:** pages that teach theming itself (Learn ch. 5,
   the Theming page, theming recipes) demonstrate re-theming using an
   estela-flavored palette as the worked "consumer brand" example — the
   before/after contrast against `docsTheme` IS the lesson. Everywhere
   else, visual continuity is part of the professionalism: one look,
   every page.

   **This includes a pass over Storybook itself** (user direction): all
   ~221 stories adopt `docsTheme` — replacing today's mix of
   `defaultTheme`, the fixture `twoColorTheme`/`darkTheme`, and
   scattered local themes — so the deployed Storybook and the docs
   images genuinely share one look. Exceptions mirror the docs rule:
   theming-demonstration stories (`Charts/Theming`, `CssVarTheme`,
   `LineChart.Themed`/`SemanticFoam`, the Histogram theme-role story,
   `Candlestick.MarketColors`/`.Estela`) keep their contrast role.
   Two mechanical consequences: (a) `docsTheme`'s single source of
   truth moves into `packages/charts` as a dev-only fixture
   (build-excluded like the existing `*.fixture.ts`, never exported
   from the barrel) so stories and the website render pipeline consume
   the same object — `website/` derives its CSS tokens from it rather
   than the reverse; (b) restyling the stories invalidates the
   Playwright visual-regression baselines, so the pass regenerates the
   Linux baselines once, in the same PR — planned cost, not a surprise.

Explicitly deferred (RFC #285's remaining scope): in-page _editable_
code (Sandpack/StackBlitz), Twoslash inline types, and bespoke
interactive teaching widgets (`<WindowExplorer>`-class). Live chart
embeds — originally listed here — moved into this wave by user
direction (v2.2); the embed mechanism (§9.1–9.2) was designed so those
future upgrades slot in without rework.

---

## 10. Site infrastructure changes

- **Sidebar**: implement §3 in `sidebars.ts`; recipes category added
  (B2); charts category expanded; financial section added (B7).
- **Typedoc**: add `typedoc.financial.json`; `/api` landing lists all
  five packages (B7).
- **Redirects**: add `@docusaurus/plugin-client-redirects` + a redirect
  map; standing rule: re-homed pages keep or redirect their slugs.
- **llms.txt**: generate `llms.txt` / `llms-full.txt` from the docs
  build (Docusaurus plugin) — this project's own consumers are agents;
  the cheat sheet + verified fences make the site unusually
  agent-consumable, so expose them.
- **Homepage**: "Explore an example" CTA → the Gallery; a second CTA →
  Learn ch. 1; rendered-chart hero once the image pipeline exists.
- **Site visual theme (v2.1, user direction)**: the Docusaurus site
  itself gets a design pass — custom CSS tokens, typography, landing
  page polish — in the same neutral professional register as
  `docsTheme`, in both light and dark. Site chrome and chart renders
  read as one designed system. Scoped as a P1 line item, not its own
  phase: this wave is mostly about getting the content in place, and
  the theme pass rides the credibility wave once, up front.
- **Dark mode**: enable site-wide (RESOLVED per user direction — the
  site and `docsTheme` ship light + dark from P1).
- **Search**: add local search plugin now (zero-config, covers the
  ~85-page site this plan produces); consider Algolia DocSearch once
  content stabilizes. Typedoc sub-sites keep their own search.
- **Deploy cadence**: unchanged (docs deploy on `v*` tags +
  `gh workflow run docs.yml` for doc-only pushes), but each phase below
  ends with a manual docs deploy so content ships without waiting for a
  release.
- **Versioning**: stay unversioned (single current version) — the
  packages release lock-step and the site already tracks latest npm;
  revisit only if a 1.0 happens.

---

## 11. Phasing

Each phase is independently shippable and ends with a docs deploy.
Sizing assumes the established MDX page cost (reference page ≈ a
half-day equivalent; guide ≈ the known 400–600-line effort). The
ordering principle, post-review: **proof first, tasks early** — four of
five personas arrive task-first or proof-first, so the Gallery ships in
P1 and the financial hub + flagship guide land ahead of the general
reference fan-out.

- **P0 — Hygiene (1 small PR, do immediately, no dependencies)**
  Fix B1 (shrink `advanced/charting.mdx` to stub + banner), B3
  (Candlestick + adapters in the index table; delete the nonexistent
  `shape` claim), B7's cheap half (`typedoc.financial.json`, `/api`
  landing lists five packages), B8 (`intro.mdx` site map), re-home
  recipes into the sidebar (B2), fix the homepage CTA target.
  Pure-chore review tier.
- **P1 — Foundation (the credibility wave)**
  **Live-embed infrastructure** (workspace dep + client-only mounting
  - the single-source example pattern, §9.1–9.2); the Storybook
    `docsTheme` restyle + tree normalization over all non-theming
    stories (+ one-time visual-baseline regeneration — a
    `packages/charts` PR, dev-only files); deployed Storybook; the site
    visual-theme pass (§10); **Gallery** (live cards); Overview rewrite
    (evaluator-first, §5a); Learn chapters 1–5; the responsive-width
    recipe; financial section stub (Overview + calendar quickstart);
    redirects plugin; llms.txt; local search.
    Exit criteria: a new user goes zero→styled multi-row chart without
    leaving the site, every step alive under the pointer — and an
    evaluator touches a working crosshair within two clicks.
- **P2 — Interaction + the doc-debt burn-down**
  Learn chapters 6–9; Interaction section (3 pages); Annotations &
  indicators section (4–6 pages); **Financial charts hub** (+
  TradingView vocabulary bridge); Missing data & gaps; value-axis
  content at tutorial + reference level (B5, PLAN's top priority);
  the prop-identity recipe; story-coverage fill for the groups these
  sections source from (§9.3). This clears B6 entirely — and it's the
  phase where the live embeds earn their keep: cursor, selection, and
  annotation pages are _demonstrations_, not descriptions.
- **P3 — Reference fan-out + flagship guide**
  Chart types (7 pages + index); Axes & layout (5); Theming (decision
  table first); Data adapters; **Cheat sheet**; Rendering & performance
  (including the measured perf envelope — the accepted #395 docs
  deliverable); Design philosophy (2); Accessibility; Troubleshooting;
  Coming from react-timeseries-charts; **Guide #1 (financial, end to
  end)**; remaining story-coverage fill (Area/Band/BoxPlot fan-outs,
  §9.3) ahead of their chart-type pages.
- **P4 — Guides library completion**
  Guides #2–4 + the remaining recipe roster.
- **P5 — Aspirational (separate decisions, not this plan)**
  RFC #285's remaining scope (editable code, Twoslash, bespoke
  teaching widgets), Algolia, fit-package docs parity, keyboard/touch
  interaction docs as the library grows them.

Suggested review protocol per phase: P0 is chore-tier; P1–P4 PRs get
the standard Layer 1 + Layer 2 review; the §3a ownership rule ("link,
don't restate") joins the Layer 1 checklist for docs PRs.

---

## 12. Open decisions before build

1. **Storybook hosting** — same GitHub Pages site under `/storybook/`
   (recommended: one deploy, one URL space) vs a separate
   Pages/Chromatic deployment?
2. **Dark mode site-wide** — RESOLVED (user direction, v2.1): yes;
   site theme and `docsTheme` ship light + dark from P1.
3. **Search** — local plugin now (recommended), Algolia later?
4. **The Recharts dashboard guide** — RESOLVED (user direction,
   v2.3): retire/replace when guide #2 lands; third-party charting
   content is exclusive to the bridge page.
5. **Value-axis naming** — the value-axis RFC explicitly defers the
   naming question ("value axis" vs "domain axis" vs "monotonic axis")
   to "a docs forcing-function" — this plan is that forcing function.
   Recommendation: standardize on **"value axis"** everywhere (matches
   `ValueSeries`, the shipped `byValue`, and the existing Start-here
   concept page), record it in the Glossary.
6. **`estelaTheme` export** — the docs will not document it (recorded
   "no consumer themes" decision); flagging the lingering export as a
   cleanup candidate for a library PR — remove now or at 0.44? Note
   the theming pages' estela-flavored worked example (§9.5) is defined
   inline in the docs, so it survives the export's removal either way.
7. **Learn-track running example** — server-metrics series
   (recommended; gives partitioning and live a natural role) vs
   weather-only?
8. **@pond-ts/financial docs depth** — this plan adds the minimal
   section (quickstart + typedoc). Full per-operator docs for financial
   would be its own wave — defer until the Tidal guide surfaces what's
   needed (recommended), or scope now?

---

## Provenance — adversarial review of this plan

Per repo convention, the v1 draft was red-teamed before being handed
over, by three independent review agents:

- **Ground-truth pass** (repo-verification lens): ~60 factual claims
  checked against source; no blockers; three wording fixes folded in
  (31 story groups, not 25; B3's `shape` value is nonexistent, not
  merely superseded; B4 scoped to `@pond-ts/charts` output).
- **Pedagogy pass** (instructional-design lens): drove §3a (content
  ownership), the scope-based genre contract (§8), the accessibility /
  troubleshooting / RTC-migration pages, the ch. 1 "bring your own
  data" + ch. 3 task-first inversion, the ch. 6 zoom loop, the merged
  Annotations & indicators section, and the §6 template guardrails.
- **Consumer-persona pass** (estela / Tidal / SPARC / evaluator /
  AI-agent lenses): caught B7 (`@pond-ts/financial` invisible — the
  v1 draft itself said "four packages"), drove the Gallery (P1), the
  Financial charts hub (P2), the Missing data & gaps page, the
  evaluator-first Overview, the cheat sheet + llms.txt + redirects,
  the expanded honesty list, and the cuts (philosophy 5→2 pages,
  guide #5 out of the wave, story-retitling demoted to opportunistic).

The full survey and grounding reports exist in the session workspace;
this document is the durable artifact.

**v2.1 (2026-07-11, user review):** pjm17971 approved v2 and added the
visual-design direction now integrated as §9.5 + §10: one neutral,
super-professional look (Tidal-style dark-grey/light terminal
aesthetic) for the site chrome AND every chart render, in light and
dark — except on pages teaching theming itself, where an
estela-flavored palette is the worked re-theming example. Extended in
the same review: the pass covers Storybook itself — all non-theming
stories adopt `docsTheme` (single source of truth as a dev-only
fixture in `packages/charts`; one-time visual-baseline regeneration).
Explicitly guidance-level: the wave's priority remains getting the
content in place. Resolves open decision #2 (dark mode: yes).

**v2.3 (2026-07-12, user review, round 3):** the third-party
charting policy (§3a): the bridge page assumes `@pond-ts/charts` is
the charting answer and is the sole home for third-party-chart-package
data portability (Recharts example sanctioned there, nowhere else);
the Recharts dashboard guide's disposition hardened to
retire-on-replacement (resolves open decision #4). Enforced in the
same pass: the three stray mentions (intro.mdx, ingesting-messy-data,
reshape link text) neutralized.

**v2.2 (2026-07-11, user review, round 2):** two directives, both
overriding v2 scoping calls. (1) **Live chart embeds are in this
wave** — "charts are alive when you touch them"; cursors, hover
highlighting, and selection always working; every chart an opportunity
to convince someone this beats vibe-coding their own custom page of
SVG slop — that is now the site's stated conversion thesis (§1 P3,
§5a). The v1/v2 deferral had conflated embeds with RFC #285's
editable-code scope; unbundled in §9.1–9.2 (single-source examples:
the code you read is the chart you touch). Static renders demoted to
social-card/README duty. (2) **Storybook stays the structured,
API-adjacent walk across the surface — and must get disciplined**
(coverage and layout are "kind of chaotic in some areas"): the
story-discipline pass is real planned work again (§9.3), reversing the
v2 demotion of story cleanup to opportunistic — tree normalization
rides P1, coverage fill rides P2–P3 ahead of the pages that source
from it.
