# PND_DOCS_PLAN — docs site, landing, and API reference

> Breakout plan for the **Docs** roadmap section in [PLAN.md](../../PLAN.md).
> The full docs-site plan (19-agent research + adversarial review + user
> directives) is
> [docs/notes/charts-docs-site-plan-2026-07.md](../notes/charts-docs-site-plan-2026-07.md)
> (v2.2); the core-docs/landing plan is
> [docs/notes/core-and-landing-docs-plan-2026-07.md](../notes/core-and-landing-docs-plan-2026-07.md).
> Shipped history of all three waves (docs-site P0–P3 shipped items, core
> concept figures #490, in-site API reference rollout):
> [docs/archive/docs-waves-2026-07.md](../archive/docs-waves-2026-07.md).

Standing rules for every docs PR in these waves:

- **Content-ownership rule:** every cross-cutting concept has one canonical
  page; everything else links (ownership table in the plan note §3a).
- **Live embeds** are the acceptance bar ("alive and beautiful"); one look
  (Pond brand system); Storybook is the disciplined API-adjacent knob walk;
  third-party charting stays quarantined to the bridge page.
- Doc-only changes deploy without a release:
  `gh workflow run docs.yml --ref main`.

## Tasks

### [PND-STORY] — P2 finish: prop-identity recipe + story-coverage fill

The last open P2 item. #464 landed the tree normalization (top-level
`Axes/` `Annotations/` `Cursors/` `Indicators/` `Gaps/` groups) as
scaffolding, but the coverage fill itself — new stories for thin groups the
reference pages source from — and the prop-identity recipe have not landed.

### [PND-DOCP3] — P3 remaining reference pages

Shipped so far: Axes (#474), Layout (#475), Chart types ×8 (#476), Gaps
(#477), Financial hub (#483), Theming + Cheat sheet (#487). Remaining:
**Data adapters, Rendering & performance** (the measured perf envelope — the
accepted #395 docs deliverable), **Design philosophy** (2 pages),
**Accessibility, Troubleshooting, Coming-from-RTC migration**, and the
**financial end-to-end guide** (OHLC → rollups → volume row → live
forming-bar pattern). Note: P3's "Axes & layout" section should absorb/link
the pulled-forward `charts/axes/value-axis` page rather than duplicate it.

### [PND-GUIDES] — P4 guides library completion

Ops-dashboard, annotation workflows, and value-axis guides + remaining
recipes. The Recharts-based dashboard guide retires when the charts-native
dashboard guide replaces it.

### [PND-LAND] — Landing story + remaining core concept pages

The core docs & landing wave (#490, v0.48.1) shipped the `ConceptViz` shell
and figures for aggregate/reduce, byColumn, byValue, align, sampling,
smoothing, anomaly detection, rolling, plus the Concepts-page SVG redraws.
Remaining: the **landing-page story** and any core pages beyond the
transforms set — roster in the plan note. The landing story now uses the
**core-hub-with-three-branches** framing (core → react · charts · domain,
others possible), not a vertical stack.

Also carries an **IA restructure** (plan note §5d): `Start here` becomes a
two-page platform on-ramp — **Introduction** (full platform walkthrough, THE
story) + **Getting started** (one whole-stack worked example, hero = the
running result). `Concepts` and `Creating series` move into `pond-ts (core)`.
Core section gains an **Introduction** + **Mental model** front, and its API
spine is the **three core series types** — `TimeSeries` / `LiveSeries` /
`ValueSeries`, each a "… deep dive" (the first two renamed, `ValueSeries` new:
core has no narrative page for it today).

**Shipped on `docs/core-ia-restructure`** (not yet merged — landing/intro pages
are human-review-gated): the IA moves + redirects, the three new core pages
written (core Introduction, Mental model, ValueSeries deep dive), the Concepts
index slimmed to its primitives table, and **Getting started rewritten as a
whole-stack ride walkthrough** — hand-built series → `smooth` → `byColumn`
histogram → `@pond-ts/fit` `computePower` (NP/IF/TSS/zones) → charts with
legend, crosshair cursor, NP baseline, and the power breakdown underneath. The
hero is `website/src/examples/getting-started-ride.tsx` (seeded fixture in
`lib/ride-fixtures.ts`); every number quoted on the page was computed from the
real pipeline, not estimated. This added **`@pond-ts/fit` as a website
dependency** (it had none — the plan's L4 "fit is a name with no home").

Still to write: the **top-level Introduction** platform story (§5a/§5c), which
is the remaining narrative gap.

### [PND-APIREF] — In-site API reference completion

The pilot replaced `/api` typedoc sub-sites for core + charts. Remaining
backlog: `{@link}` renders as code, not resolved cross-page links;
type-printer `unknown` fallback; `TimeSeries`-scale pages need collapsed
generics + grouped method categories; the **react / fit / financial**
tranches (their typedoc sub-sites stay live until parity). Library docs
chore surfaced by the rollout: `TimeSeries` / `LiveSeries` / `LiveView` lack
class-level docstrings in source.

### [PND-OBSDOC] — "Observing pond-ts in production" how-to

The remaining documentation-backlog items, landed as one MDX pass
(~200–400 lines, no version bump needed):

- **`pushMany` is the throughput-critical primitive** — call out in
  `live-series.mdx` (per-event forwarding reaches ~14% of bench peak;
  producer-side wire batching recovers it).
- **Bench-vs-real-world callout** on the benchmarks page / README —
  the framing paragraph is written in
  [docs/notes/bench-vs-real-world.md](../notes/bench-vs-real-world.md).
- **GC observation snippet** (`PerformanceObserver` over `'gc'`).
- **No-NaN guarantee from numeric reducers** (`undefined`, never
  `NaN`/`Infinity`, for empty/cold/below-threshold windows).
- **Same-timestamp behavior per ordering mode** (ties accepted under
  `'reorder'`/`'drop'`; throws under `'strict'`).
- **Side-channel latency-measurement pattern** (`Map<eventKey, pushedAtMs>`).
- **Manual counter vs rolling** note in the rolling reference (a manual
  counter off `live.on('batch')` is strictly cheaper for cumulative counts).

(The former highest-priority backlog item — value-axis docs — shipped across
#382/#383/#421/#446 and the `charts/value-axis` reference page; done.)

### [PND-VSDOC] — `creating.mdx` gets its `ValueSeries` section — SHIPPED

Filed by [PND-VSIO] against PR #564, which had restructured the ingest page
around JSON / columnar / Arrow and deliberately skipped `ValueSeries` on the
grounds that a section following the page's own shape would be "two-thirds
empty" — at the time its whole surface was `fromColumns`. [PND-VSIO] filled
the other two-thirds, so the section earned its place and landed in the same
PR (#564, after merging main).

**Decisions worth keeping:**

- **A peer `## ValueSeries` section, not woven through.** The alternative was
  covering the value-keyed twin inline in each of JSON / Columnar / Arrow.
  Rejected: it roughly doubles every section to say "and the same again with
  an axis", and it buries the `TimeSeries` narrative the page is actually
  organized around. The peer section mirrors the page's shape in miniature
  (JSON / Columnar / Arrow subsections) and leads with a twin-door table, so
  the repetition is one table rather than three paragraphs.
- **The section documents only the divergences.** Shared behaviour (`sort`,
  gap rules, adopt-vs-copy, monotonic-key contract) is stated once as "reread
  the sections above and substitute the axis for time." What's spelled out is
  only what actually differs: no timestamp parsing / no `parse.timeZone`,
  `axis` required on `fromArrow`, the axis read unscaled, and `toColumns()`.
- **The `TimeSeries.toColumns()` asymmetry was stated, not hidden — and then
  it evaporated.** The section originally said plainly that `toColumns` was
  `ValueSeries`-only, and why (store-generic exporter, but the two-edged
  `timeRange` / `interval` wire shape undecided — [PND-TSCOLS]). [PND-TSCOLS]
  then shipped it and [PND-FLATKEY] decided the wire shape, both while this
  PR was open, so the asymmetry and its explanation came back out. The
  instinct still generalizes: **document a gap with its reason rather than
  omitting it**, and the prose stays cheap to retract when the gap closes —
  a paragraph naming a specific parked decision is easy to find and delete,
  where a silent omission leaves nothing to notice.
- **The deep dive stays the tour.** `value-series.mdx` (rewritten by
  [PND-VSIO] into Doors in / Doors out) keeps door-by-door depth plus reading
  and slicing; `creating.mdx` cross-links to it rather than competing.
  Content-ownership rule applied.
