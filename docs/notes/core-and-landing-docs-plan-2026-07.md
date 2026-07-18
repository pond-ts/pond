# Core-library & landing-page docs plan — pond as an analytics **and** visualization platform

_pond-ts docs agent (Claude), 2026-07-17 · status: **PROPOSED, not adopted**._
_Companion to [`charts-docs-site-plan-2026-07.md`](charts-docs-site-plan-2026-07.md)
(the in-flight charts wave, ADOPTED) and the living-examples retro
([`living-examples-retro-2026-07.md`](living-examples-retro-2026-07.md), RFC #285).
Per the RFC-vs-PLAN layering: this note is context to red-team; nothing here is a
commitment until pjm17971 adopts it into PLAN.md._

---

## 0. The one-sentence thesis

**Pond is an analytics _and_ visualization platform.** `pond-ts` (core) is the
typed time-series **foundation**; `@pond-ts/charts` is the **major middle layer**;
`@pond-ts/financial` and `@pond-ts/fit` are **domain libraries on top**;
`@pond-ts/react` is the live-binding glue. That layered picture — foundation →
visualization → domain — is what a visitor must **come away with when they land**,
and it is exactly what the current site does _not_ convey.

Everything below serves that single outcome.

## 1. What's wrong today (verified against the live tree)

The charts wave has been landing beautifully — `docs/charts/**` and
`docs/learn-charts/**` embed live, touchable charts on nearly every page. That
throws the two untouched surfaces into sharp relief:

| #   | Problem                                                                                                                                                                                                            | Where                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| C1  | **The core transform pages render zero output.** `rolling`, `aggregate`, `smooth`, `baseline`/`outliers`, `align`, `reshape`, `sampling`, `cleaning` — every one explains the op and shows `toPoints()` as a **text/JSON fence**. The reader never _sees_ the smoothed line, the rolling band, the detected spikes. The "visualization platform" claim is invisible precisely where the analytics live. | `docs/pond-ts/transforms/*.mdx` |
| L1  | **The homepage undersells to a primitive library.** Tagline "Typed time series primitives"; hero is a logo + three **text** feature cards; **no chart, no layering, no visualization in the pitch.** A lander comes away with "a typed TS time-series lib," not "a platform." | `src/pages/index.tsx`, `src/components/HomepageFeatures` |
| L2  | **No layering story anywhere on the funnel.** Nothing on the homepage, the `/api` landing (a flat five-button list), or the section indexes tells the reader that core→charts→domain is a deliberate stack. The architecture is real (ARCHITECTURE.md) and load-bearing to the pitch, and it is nowhere a visitor can see it. | `src/pages/api.tsx`, section `index.mdx`s |
| L3  | **The core section index is thin prose** — a table of contents, no rendered payoff. `financial/index.mdx` already opens with a live calendar-aware candlestick (#445); the **core** index, the front door to the foundation, opens with nothing to look at. | `docs/pond-ts/index.mdx` |
| L4  | **`@pond-ts/fit` is a name with no home.** Sidebar entry + an API link, no section content, no embedded chart — yet the thesis names it a first-class domain library "on top." (The charts plan explicitly scoped fit out; the _platform positioning_ can't.) | `docs/fit/**` |

C1 is the centerpiece. L1–L4 are the framing that makes C1 legible as "the
foundation of a platform" rather than "one more page of transforms."

## 2. Scope, and the seam with the in-flight charts wave

**This plan owns:** the homepage & `/api` landing (`src/pages/`,
`HomepageFeatures`), the site-level positioning (`start-here/intro.mdx`), the
**core** docs (`docs/pond-ts/**`), and the **section-landing framing** for every
package (the layer-locator header + one payoff chart), including a minimal `fit`
landing.

**This plan does _not_ touch** `docs/charts/**` or `docs/learn-charts/**` — the
charts agent owns those and is mid-wave (charts-plan P2, ~4/7). The clean
division of labor:

> **In the charts docs, the _chart_ is the subject and the operator is a
> supporting actor. In the core docs, the _operator_ is the subject and the
> chart is the evidence.** A core-doc embed shows _the analytic result_ with the
> smallest possible chart and **links the charts section for the "how"** — it
> never re-teaches charting API. This is the §3a "link, don't restate" rule
> (already on the docs-PR checklist) applied to the core/charts boundary.

**Explicit scope boundary — the core section is _not_ the end-to-end tutorial.**
A fuller, detailed pond→charts end-to-end example is a separate artifact (its
natural home is a how-to guide, or the charts learn track) and is **out of scope
here** (user direction). The core section deliberately stops at the concept figure:
one operator, its knob, the visible result. When a reader wants the whole
data→analytics→rendered-dashboard build, the core page _links out_ to that
example rather than growing into it.

**This plan reuses, never forks, the charts wave's shipped machinery** (#435):
the `<ChartExample>` single-source pattern, the `example-sources` plugin, the
`file:` workspace deps, and `docsTheme`/`useSiteChartTheme` (the brand viz ramp
from #437/#438). New core embeds are just new `src/examples/core-*.tsx` files
through the exact same door. Where an example component already exists
(`learn-04-rolling-band`, `gallery-histogram`, …) core pages **reuse it** rather
than duplicate — single-source, per the embed contract.

**Third-party charting stays quarantined** to the bridge page
(`advanced/charting.mdx`) per the standing v2.3 policy. Every core embed uses
`@pond-ts/charts`.

## 3. The discipline: "a lot of charts" ≠ "chart everything"

The user's directive is heavy chart embedding in the core docs to _show the
analytics working_. The living-examples RFC's hardest-won lesson is the guardrail
on that directive, and folding it in up front is what keeps this from producing a
wall of indistinguishable line charts:

- **Presentation ladder — the cheapest form that _teaches_:** `table → bar →
  line → interactive`. The 118-method survey (RFC Appendix A) landed at **table
  47 / line 16 / interactive 16 / none 39 / bar 0-as-primary**. A third of the
  surface honestly earns **no figure** — I/O, scalar accessors, boolean
  predicates. **The honest "—" is a deliverable, not a gap.**
- **For `reduce`, `collapse`, `join`, `materialize`, `diff` the exact _rows_ are
  the lesson** — a table beats a line, because a line _swallows_ the very cells
  that teach: `materialize`'s empty buckets, `join`'s outer blanks, the leading
  `undefined` of `diff`/`rolling`, the `minSamples` warm-up gate. So the table
  tier needs an **`<ExampleOutput>` component that renders missing data as a
  deliberate em-dash, never a blank** (RFC's load-bearing primitive; not present
  in `src/components/` today — build it in Phase B).
- **Determinism:** seeded generators, format to _displayed_ precision before
  asserting, never `Math.random()`/`Date.now()` at render (the charts wave
  already codified this in the embed house rules — inherit it).
- **Core-param controls are in this wave (user direction), and that's a clean
  unbundling — not a violation of the RFC deferral.** RFC #285 defers editable
  _code_ sandboxes (Sandpack/Twoslash) and open-ended teaching playgrounds. A knob
  wired to a single pond option (`window`, `sigma`, …) is a different, bounded
  animal — the reader turns a labeled control, never edits code — exactly the way
  live _embeds_ were unbundled from editable code in the charts wave (v2.2). The
  RFC's actual deferred scope stays deferred; the core-param widget rides in.

Net: "a lot of charts" is really **"a lot of _shown output_, each in the medium
that teaches it."** For the core surface that is _mostly_ charts (the transform
family is unusually visual) but pointedly _not all_ — and calling that out is
what makes the chart-heavy pages land instead of blur.

### 3a. Two embed registers — the **concept animation** vs. the code sample

This is the load-bearing distinction for the core docs, and it is _not_ the
charts wave's embed. The charts wave ships `<ChartExample>`: chart **plus its
source code**, full interaction on, "the code you read is the chart you touch" —
because there the chart _is_ the subject. The core docs want the **opposite
emphasis**:

> A **concept animation**: a stripped-down, **codeless** chart embed that
> _visualizes the operation being described_ — no source panel, minimal chrome,
> and, where the operator's meaning is temporal, **animated / live**. For
> `aggregate`, that's streaming points flowing along the time axis with each
> bucket's **bar materializing as its window fills** — the reader watches
> aggregation _happen_. About the concept, not the chart.

Why this is the right call and now buildable:

- **The emphasis is inverted on purpose.** The charts-docs house rule
  "interaction always on, show the source" exists to _sell the chart library_.
  Here we deliberately **drop both** — no code, cursor/hover/selection off unless
  a specific concept needs them — so nothing on the page says "look at this
  charting API." That is the cleanest possible version of the §2 seam (operator is
  the subject; chart is evidence): with no code and no chrome, the embed _can't_
  be mistaken for a charts tutorial.
- **The pieces exist now** (user confirmation): `LiveSeries` + `aggregate`/
  `rolling`/`baseline` + `BarChart`/`LineChart`/`BandChart` compose into a
  self-driving concept loop. The animation dogfoods the live path end to end.
- **Precedent — the predecessor's own realtime demo**
  ([`react-timeseries-charts#/example/realtime`](https://software.es.net/react-timeseries-charts/#/example/realtime)):
  events stream in fast, pond buckets them live into a scrolling window, and each
  interval's **bar accretes as its bucket fills**, then the window scrolls. That is
  _exactly_ the `aggregate` concept animation — and pond-ts is the successor to
  that pondjs + react-timeseries-charts stack, so this is us **rebuilding the demo
  that sold the predecessor**, now as a codeless teaching figure embedded in the
  operator's own doc page instead of a standalone example. The realtime demo is the
  visual target for the `aggregate` pilot; the rest of the ⟳ family follows its
  shape.
- **It replaces the ASCII "Diagram candidate" boxes** already sitting in the core
  pages (`rolling.mdx` literally carries `ASCII first pass; Excalidraw replacement
  welcome`). The concept animation _is_ that replacement — a live figure, not a
  static drawing.
- **Two facets, both in-scope: autoplay _and_ core-param controls.** A concept
  figure drives itself (autoplay + pause), and where the operator has a meaningful
  knob it also exposes **a control the reader turns** — and watches the analytic
  recompute. This is not decoration; **the control _is_ the pedagogy**: you learn
  what `aggregate` does by dragging its window and seeing buckets coarsen; what
  `baseline` does by raising σ and watching outliers stop tripping. (Earlier drafts
  filed this under a deferred "Phase C" — user direction, this message, pulls it
  into the base: the params are the point.)
- **The load-bearing invariant: every control maps to a pond _core_ option, never
  a chart prop.** `window`, `alignment`, `sigma`, `alpha`, bucket size, `minSamples`
  — yes. `bar width`, `color`, axis format, cursor mode — **never** (that's the
  charts section's subject). One glance at a figure's controls should read as "these
  are the operator's knobs," which is the §2 seam made literally visible.
- **Dual mandate — teach _and_ sell, at once.** The figures exist to teach the
  differences between core concepts, and _because_ they render through the real
  `@pond-ts/charts` in the brand `docsTheme`, they are simultaneously the platform
  pitch: beautiful, simple visualizations proving pond core + charts are one system.
  The core section sells by _showing the analytics gorgeous_, not by explaining the
  chart.

So §4's "line / bar / band" entries below are, unless noted, **codeless concept
figures** — autoplay where temporal (⟳), plus a core-param control where the
operator has one — not code-bearing `<ChartExample>` embeds. The table tier keeps
`<ExampleOutput>` (rows are static and _are_ the lesson — animating them adds
nothing).

## 4. Per-page medium assignment (the spine of the core-docs work)

The concrete, high-value artifact — the RFC's survey re-run against the pages
that actually exist. Each core page gets a **primary medium** and a one-line
reason. **Every chart entry below is a codeless concept animation (§3a)** unless
it says "table" or "none"; the ones marked **⟳** are _self-driving / streaming_
(the reader watches the operation happen). "→ interactive" marks the Phase-C
escalation (a draggable handle added on top of the same autoplay figure).

| Core page (`docs/pond-ts/`)          | Primary medium                 | What the reader sees / why                                                                                             |
| ------------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `transforms/queries`                 | table (+ none)                 | select/filter — the surviving rows are the lesson; the honest-`undefined` renderer earns its first outing             |
| `transforms/transformations` (`map`) | table                          | column in → column out; rows show the transform, a chart adds nothing                                                 |
| `transforms/alignment` (`align`)     | **⟳ line → interactive**       | resample onto a grid: raw points stream in behind, the aligned line snaps to grid on top. The archetype "window" figure |
| `transforms/aggregation` (`aggregate`)| **⟳ bar → interactive**       | the flagship: **points stream in; each bucket's bar accretes as its window fills, then the window scrolls** — the predecessor's realtime demo, rebuilt (§3a); Phase C adds a draggable bucket width |
| `transforms/reshape` (`collapse`/`reduce`) | **table**                 | exact columns collapsing is the whole point; a chart hides it                                                          |
| `transforms/rolling`                 | **⟳ line + band → interactive** | rolling avg tracks the streaming raw; avg/sd → a band that breathes; the `minSamples` warm-up shows as an honest leading gap. Window archetype |
| `transforms/sampling`                | line (points) / table          | downsample: show _which_ points survive vs. the dense source                                                          |
| `transforms/smoothing` (`smooth`/EWMA)| **⟳ line → interactive**      | jagged raw streams in, the smoothed line eases behind it; drag α / window in Phase C                                   |
| `transforms/anomaly-detection` (`baseline`/`outliers`) | **⟳ band + markers** | the baseline band forms and **outlier markers light up as spikes cross it** — the highest-value figure in the set: it _shows_ detection happening |
| `transforms/cleaning` (`fill`/dedup) | **table (+ line-with-gaps)**   | the honest `undefined → filled` cell; the gap that closes. Links the charts "Missing data & gaps" page for the visual |
| `transforms/reducer-reference`       | none / small table             | it's a vocabulary lookup; the aggregate/rolling pages carry the figures                                               |
| `live/live-series`                   | **⟳ live ticking chart**       | a genuinely-live concept animation (pause affordance), reusing the charts wave's live path                            |
| `live/live-transforms`               | number/table (+ optional live) | incremental views are scalar-shaped; a big readout, not a series                                                      |
| `live/triggering`                    | number/table                   | trigger firing is an event log, not a curve                                                                           |
| `advanced/columns`                   | table                          | array-column shape is structural                                                                                      |
| `advanced/arrays`                    | table                          | ditto                                                                                                                 |
| `advanced/charting`                  | _(unchanged — bridge page)_    | owned by the charts wave / third-party policy; leave it                                                               |

This table is the review contract for Phase B: **a page that reaches for a line
where its row above says "table" has to justify it**, and vice versa. It's the
same knob-by-knob discipline the Storybook fan-out uses, pointed at medium choice.

## 5. Landing & positioning (the "come away with a platform" fix)

Three surfaces, one message: **foundation → visualization → domain**.

### 5a. Homepage (`src/pages/index.tsx` + `HomepageFeatures`)

1. **Hero gets a live chart.** The first thing a visitor sees is a real,
   touchable pond chart (reuse a Gallery embed — e.g. the baseline-band + outliers
   or the ops-dashboard card), rendered in the brand `docsTheme`, dark/light
   native. This is the charts wave's own conversion thesis ("charts are alive when
   you touch them") pulled to the **very top of the funnel**, where it does the
   most work. Retagline from "Typed time series primitives" → the
   analytics-**and**-visualization-platform line.
2. **Replace the three text cards with the layering story.** A stack/constellation
   visual: **core** (foundation) · **charts** (middle) · **financial + fit**
   (domain) · **react** (glue) — each a card that states its one job and links its
   section. This single change is what makes visitors _come away with_ the
   platform model. (Site chrome already carries the brand system from #437/#438,
   so this rides the existing look.)
3. **The pipeline on one screen.** A compact "raw rows → `aggregate`/`baseline` →
   rendered chart" strip — the data→analytics→chart motion as one gesture, viewed
   from the platform vantage (the charts plan tells the same story from the chart
   side; this is its mirror from the foundation side).

### 5b. `/api` landing (`src/pages/api.tsx`)

Group the five packages **by layer** (Foundation · Visualization · Domain · React
glue) instead of a flat button row. Even the API index should reflect the
architecture — cheap, and it reinforces the model on a page evaluators reliably hit.

### 5c. Section landings — one consistent "you are here" header + one payoff chart

Every package index gets (a) a small **layer-locator** ("Foundation layer · sits
under `@pond-ts/charts`") and (b) at least one embedded chart showing that
package's payoff. Concretely:

- **`start-here/intro.mdx`** — reframe the opener from "Typed time-series
  primitives" to the platform thesis + a full **layer map of doors** (extends the
  charts plan's "two doors" into the whole stack).
- **`pond-ts/index.mdx` (core)** — open with a **live chart of a core analytic**
  (baseline band + outliers is the strongest single proof) so the foundation's
  front door _shows the analytics_, matching what `financial/index.mdx` already
  does (#445). Fixes L3.
- **`financial/index.mdx`** — already strong (#445); add only the layer-locator
  header for consistency.
- **`fit/index.mdx`** — new minimal landing (parallel to what financial got):
  layer-locator + a live **activity/pace** chart + a short quickstart. Full
  per-operator fit docs stay a separate later wave; this closes L4 at the
  positioning level only.
- **`react/index.mdx`** — layer-locator ("the live-binding glue"); it already has
  hook content.

## 6. Component work

- **`<ConceptViz>`** — the headline new component and the core-docs workhorse: a
  stripped, **codeless** chart mount (§3a). No source panel; minimal chrome
  (only the axes/labels the concept needs); interaction off by default; an
  **autoplay streaming driver** (seeded, client-only via `<BrowserOnly>`, rAF
  loop, **pause/replay affordance**) for the temporal operators. It mounts real
  `LiveSeries` + `@pond-ts/charts` pieces and reuses `docsTheme`/`useSiteChartTheme`
  for one look — but it is **not** `<ChartExample>` (which shows code and keeps
  interaction on). Each operator's figure is a small `core-<op>.tsx` driver fed
  into `<ConceptViz>`.
- **`<ExampleOutput>`** — the table-tier renderer with the honest em-dash
  `undefined` cell (RFC's required primitive). New, in `src/components/`. The
  table rows of §4 depend on it.
- **`<LayerMap>` / homepage layer cards** — the constellation visual for §5a.2 and
  the §5c section headers (one component, two placements).
- **Core-param controls** — a `controls` facet of `<ConceptViz>` (not a separate
  component): a small labeled control strip whose every knob is bound to a **pond
  core option** (`window`/`sigma`/`alpha`/`alignment`/bucket size/`minSamples`),
  re-running the operator on change. The windowing family (aggregate/rolling/align/
  smooth/baseline) is one interaction, so one control-strip shell covers 5–6 pages.
  In-scope this wave (user direction); build order is autoplay figure first, control
  second (§7).

No new _embed infrastructure_ (the `file:` deps, `example-sources` plugin, and
theme bridge are all shipped, #435) — `<ConceptViz>` is a new _presentation_
component riding that infra, deliberately thinner and codeless where
`<ChartExample>` is code-forward.

## 7. Phasing (proof-first, non-colliding with charts P2–P4)

Each phase independently shippable, each ends with a docs deploy
(`gh workflow run docs.yml --ref main`).

- **Phase A — Positioning (small, highest leverage, do first).** Homepage rebuild
  (hero live chart + layer story + pipeline strip), `/api` layer grouping,
  `intro.mdx` reframe, the layer-locator header on every section index, and the
  core index's opening live chart (L1–L3, L4-positioning). Reuses existing Gallery
  embeds — little new example code. This is the "what people come away with" fix
  and it lands before the heavier core-docs work.
- **Phase B — Core docs: show the analytics (concept figures + tables).** Build
  `<ConceptViz>` (autoplay + the core-param control facet) and `<ExampleOutput>`
  first, then work the §4 table page by page: a purpose-built `core-<op>.tsx` driver
  (⟳ where temporal, plus its one core-param control) for the visual operators, an
  honest `<ExampleOutput>` table where the rows are the lesson, nothing where
  nothing helps. **`aggregate` is the pilot** — streaming points → bars accreting →
  a draggable `window` control — and it de-risks both the live-bar path and the
  control facet in one figure. The bulk of the wave. Closes C1.
- **Phase C — Control rollout across the windowing family + polish.** Not a
  "should we?" gate anymore (resolved by user direction) — just the sequencing tail:
  extend the shared control-strip shell across the remaining windowing pages
  (rolling/align/smooth/baseline), add any second-order knobs (`alignment`,
  `minSamples`), and tune motion/pause/reset affordances. Cheap once the
  `aggregate` pilot's shell exists.
- **Phase D — Domain landings + fit minimal section.** The `fit` landing (L4),
  financial layer-locator, react layer-locator. Full fit/financial per-operator
  depth stays deferred (its own wave, once a consumer track surfaces the need —
  same discipline the charts plan used for financial).

## 8. Guardrails (join the docs-PR review checklist for this wave)

1. **Operator is the subject; chart is the evidence — and codeless (§3a).** Core
   concept figures show **no source code** and keep chrome/interaction stripped. An
   embed that shows charting code or turns into a chart demo has crossed into the
   charts agent's lane — cut it back and link the charts page.
2. **Medium matches §4.** A chart where the table says "table" (or vice versa)
   needs a written justification in the PR; animate (⟳) only where the operator's
   meaning is temporal.
3. **Missing data renders visibly** — em-dash, never blank (the honest-`undefined`
   rule).
4. **Purpose-built figures, shared fixtures.** The concept drivers are new and
   deliberately stripped — do _not_ reuse the code-bearing `learn-*`/`gallery-*`
   `<ChartExample>` components (wrong register). Do share seeded data
   generators/fixtures under `src/examples/lib/` rather than re-authoring them.
5. **Third-party charting stays on the bridge page** — every core embed is
   `@pond-ts/charts`.
6. **Link, don't restate** — one canonical owner per cross-cutting concept
   (gaps → the charts "Missing data & gaps" page; value axis → the concept page; …).

## 9. Open decisions before build

1. **Interactive core-param controls — RESOLVED (user direction, this session):**
   in-scope this wave, as a facet of `<ConceptViz>`, with the invariant that every
   control binds to a pond core option, never a chart prop. Build order is autoplay
   figure first (`aggregate` pilot), control second; no separate go/no-go gate.
2. **`fit` depth** — minimal landing now (recommended), full per-operator docs
   deferred to a consumer-driven wave?
3. **Homepage hero chart — which Gallery embed?** (baseline-band+outliers reads as
   "analytics"; ops-dashboard reads as "platform"; financial candlestick reads as
   "domain reach.") _Recommendation: baseline+outliers — it's the analytics thesis
   in one picture._
4. **Adopt into PLAN.md as a sibling wave to the charts buildout, or fold in as its
   extension?** _Recommendation: sibling "Core & landing docs wave," since it has a
   different owner-surface and can run in parallel without touching charts pages._
5. **Red-team before adoption?** Per repo convention this note should get the
   multi-agent review pass (library / pedagogy / consumer-persona lenses, + a Codex
   adversarial read) before it becomes a PLAN commitment — same cadence the charts
   plan followed. pjm's call on whether to run it.

---

_Provenance: grounded in a first-hand read of `src/pages/`, `HomepageFeatures`,
`pond-ts/index.mdx`, the core transform pages, `sidebars.ts`, and the charts wave's
shipped embed infra (#435/#441/#443/#445/#446), plus the charts-docs-site plan and
the living-examples retro. Not yet red-teamed._
