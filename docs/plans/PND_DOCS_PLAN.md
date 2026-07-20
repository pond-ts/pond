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
transforms set — roster in the plan note.

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
