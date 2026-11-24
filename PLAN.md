# Plan

**Open work lives in Linear**: team **Pond** (`POND`), one project per
package. This file is the thin index above it: the road to 1.0, one
paragraph per work area saying where its issues are, the active-experiments
roster, and the cross-cutting rules.

| Project                                                               | Covers                                                                        |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [Core](https://linear.app/pondts/project/core-56ab562a7fc7)           | `pond-ts` (batch, live, columnar, streaming, time zones) and `@pond-ts/react` |
| [Charts](https://linear.app/pondts/project/charts-57e76455bf22)       | `@pond-ts/charts`, chart accessibility, consumer friction reports             |
| [Docs](https://linear.app/pondts/project/docs-e90d5dd41988)           | the docs site, API reference, agent adoption                                  |
| [Process](https://linear.app/pondts/project/process-af5982fb3c62)     | `@pond-ts/process` and the process demo                                       |
| [Financial](https://linear.app/pondts/project/financial-8b09ced936c3) | `@pond-ts/financial` studies and trading time                                 |
| [Ecosystem](https://linear.app/pondts/project/ecosystem-d581b8c07207) | `@pond-ts/fit`, server / node adapters                                        |
| [Rust](https://linear.app/pondts/project/rust-d615b34b262d)           | `pond-rs`, `@pond-ts/wasm`, `pond-timeseries` (Python)                        |

Where everything else lives:

- **Tasks** — Linear (above). A task's write-up is its issue description; its
  outcome (decision + reasoning, PR link) is the closing comment.
- **Old `[PND-XXXXXX]` IDs** — every open task in this file moved to Linear on
  2026-11-24 with its tag kept at the start of the issue title, so searching
  Linear for `PND-PARITY` finds it.
  [docs/archive/linear-migration.md](docs/archive/linear-migration.md) maps
  each ID to its issue. New issues use Linear identifiers only.
- **Frozen breakout plans** — [docs/plans/](docs/plans/) (`PND_*_PLAN.md`):
  the reasoning behind shipped work, frozen at the migration. Do not add to
  them.
- **Strategic RFCs** — [docs/rfcs/](docs/rfcs/) (forward-looking context, not
  commitments; only work adopted into Linear is a commitment).
- **Shipped history** — [CHANGELOG.md](CHANGELOG.md) for releases;
  [docs/archive/](docs/archive/) for the frozen phase/wave logs.
- **Evergreen rules** —
  [docs/notes/design-principles.md](docs/notes/design-principles.md).

Maintenance: close the Linear issue when a task completes, with the outcome in
the closing comment; open an issue in the owning project when new work surfaces.
Edit this file only when a work area's direction changes. A lost session
should never erase the current state of the project.

---

## The road to 1.0

_Owner's framing, recorded 2026-08-13. This is the horizon every scheduling
decision below is measured against, so it belongs here rather than in a
transcript._

**1.0 is roughly three to six months out**, gated on shipping milestones
rather than a date:

- **Tidal** ships in some form (possibly folded into a larger product).
- **estela** ships — that surface is already mature.
- **charts** land in **Ignite** and **SPARC**.
- **ESnet** possibly migrates off `react-timeseries-charts` — outside our
  control, but wanted.

**The gate is "does the API look stable".** If it does at that point, that is
1.0.

**Coverage estimate:** RFCs + the plan (now Linear) account for perhaps
**95% of the final surface**. The remaining 5% comes from experiments first and then real
consumers — it is discovered, not designed.

**Why 1.0 is a real boundary, and not just a version number:** after it, the
API is no longer one person's to change. Everything the pre-1.0 window
permits reduces to that. This is not a forever project; it is moving fast and
deliberately toward a fixed point.

**The scheduling consequence, which is easy to get backwards.** The 95% and
the 5% need _opposite_ treatment:

- **Discovery work waits for consumers.** The last 5% is exactly what
  experiments and real integrations surface; designing it early guesses.
- **Structural work must precede them.** Anything that reshapes the existing
  95% — a component-tree change, a prop relocation across components — gets
  monotonically more expensive as each consumer integrates, and cannot be
  justified by consumer signal because that signal never asks for it.

So a restructure is not "deferred until we learn more". It is either done
early or not done. The worked example is
[`docs/rfcs/container-decomposition.md`](docs/rfcs/container-decomposition.md),
which argued exactly that — and was then **declined on review**, which is the
more useful half of the lesson.

**The rule above is sound; it is also the shape of a trap.** "Structural work
must precede consumers" is a real constraint, and it manufactures urgency
that can outrun the evidence. That RFC reached "decide in weeks" while its
own §10 questions were unresolved, and its central evidence — a 38-prop
partition — turned out to be **overstated by 46%**, every error in the
direction that made its case look stronger. A Codex adversarial pass caught
it against the source in one run.

So the rule needs its own guard: **urgency is a reason to review harder, not
to review less.** When a structural change argues that the window is closing,
that is precisely when its evidence should be checked line-by-line by
someone who did not write it — because the argument's own logic discourages
waiting for the falsifying signal.

---

---

## Work areas

### `@pond-ts/charts`

The canvas wave shipped the rendering spine, seven chart types, interactions,
the decimator (line/area/band M4 + viewport culling, **released in v0.49.0**),
and the trading-time + categorical axes; the package is **published**
(`@pond-ts/charts` on npm, `private: false`). Remaining: the interaction
tail, Phase-2 RFC slices, and the M5 parity gate for the stable /
estela-parity milestone. Shipped write-ups that used to sit here are in the
breakout plan. Frozen plan:
[PND_CHARTS_PLAN.md](docs/plans/PND_CHARTS_PLAN.md) · RFC:
[charts.md](docs/rfcs/charts.md).

**Open issues:** Linear project [Charts](https://linear.app/pondts/project/charts-57e76455bf22) (label `charts`).

### Time zones

Two asks, in order: an **arbitrary IANA zone on the chart time axis** and
**aggregations in that zone**. Phase 1 shipped both on 2026-09-13
(`TimeZone`, `quarter` / `year` calendar units, `<ChartContainer timeZone>`,
`TradingCalendar.timeZone`; outcomes in the breakout plan). Design: a zone
is a parameter, never state on `Time` / `TimeRange` / `Interval`; **one**
zone-arithmetic implementation in core, consumed by charts, so the bucket
`aggregate` used and the tick that labels it are the same instant; defaults
do not move (core UTC, charts viewer-local); the d3 specifier strings stay
the format API. What is left is Phase 2. Frozen plan:
[PND_TIMEZONE_PLAN.md](docs/plans/PND_TIMEZONE_PLAN.md).

**Open issues:** Linear project [Core](https://linear.app/pondts/project/core-56ab562a7fc7) (label `timezones`).

### Docs site, landing, and API reference

The docs-site wave shipped P0–P1 and most of P2/P3 (Learn track, the
interaction and annotations reference sections, Axes/Layout/Chart-types, the
financial hub, and the in-site API reference for core + charts). Frozen plan:
[PND_DOCS_PLAN.md](docs/plans/PND_DOCS_PLAN.md) · plan notes:
[charts-docs-site-plan-2026-07.md](docs/notes/charts-docs-site-plan-2026-07.md),
[core-and-landing-docs-plan-2026-07.md](docs/notes/core-and-landing-docs-plan-2026-07.md).

**Open issues:** Linear project [Docs](https://linear.app/pondts/project/docs-e90d5dd41988) (label `docs-site`).

### Agent adoption

Pond is built by agents and its next consumers are agents: a session told
"compute per-host rolling p95 from this CSV and chart it" in a repo that has
never heard of pond picks a library in thirty seconds from what it knows, what
it can find (`npm search`, the npm page, `llms.txt`, a docs MCP), and what its
harness hands it (an installed skill, an `AGENTS.md`). Baseline 2026-09-12:
zero npm keywords on every package, `pond-ts` **last** in `npm search "time
series"`, not indexed by Context7, a bare-URL `llms.txt` with a 1.2 MB full
dump, dead docs links in two shipped READMEs and eight docs pages.
[PND-ADOPTMETA] / [PND-ADOPTLINKS] / [PND-LLMSTXT] / [PND-AGENTGUIDE] shipped
(#722 + owner-applied GitHub topics; outcomes in the breakout). Frozen plan:
[PND_ADOPTION_PLAN.md](docs/plans/PND_ADOPTION_PLAN.md) (baseline table,
per-task reasoning, deferred alternatives).

**Open issues:** Linear project [Docs](https://linear.app/pondts/project/docs-e90d5dd41988) (label `adoption`).

### Accessibility — audit and fixes, library-wide

Pond's interaction surface grew one gesture at a time — cursors, selection, the
sweep, the 2-D rect, the list range gesture — and each landed with its own
keyboard story or none. Nobody has yet walked the **whole** surface from a
keyboard or a screen reader. Frozen plan (and the finding register):
[PND_A11Y_PLAN.md](docs/plans/PND_A11Y_PLAN.md).

**Open issues:** Linear project [Charts](https://linear.app/pondts/project/charts-57e76455bf22) (label `a11y`).

### Agent workloads — the defensible bench

[`docs/notes/agent-workloads-2026-07.md`](docs/notes/agent-workloads-2026-07.md)
distils a real derivatives-analytics catalog into six generic data shapes, six
practitioner personas, and twelve questions written the way an agent receives
them — each with the plan a process graph would compose, what it stresses, and
whether pond can do it today. Acceptance gate: **< 100 ms over 500k–1M points**.

The finding that reorders the roadmap: **the gaps are shape problems, not speed
problems.** Rolling studies, aggregation, calendars, histograms and folds — the
things these questions lean on hardest — pond already does well. What blocks
questions is missing _primitives_: unpivoting a wide row into a value-axis
series (a term structure is the object these people think in), tall→wide pivot,
and ranking across partitions.

**Open issues:** Linear project [Core](https://linear.app/pondts/project/core-56ab562a7fc7) (label `agent-bench`).

### Numerical classes (RFC — not adopted)

[`docs/rfcs/numerical-classes.md`](docs/rfcs/numerical-classes.md) argues that
accuracy under partitioning is a **property of an operator's form**, not a
measurement of a workload — prompted by a shipped `zScore` accuracy figure that
turned out to be an artifact of the author's own test data (a Codex pass found
a legal input giving **38% relative error** where the docs claimed 2.6e-6).

Three classes (exact / bounded / unbounded), a composition rule that makes them
survive arbitrary agent-assembled pipelines, and enforcement in the registry
alongside `unit` — because a docstring is not a control surface for an agent.
The unit of classification is the **11 kernels**, not the ~120 studies, so the
work is bounded and future studies inherit. Two consequences fall out before
any code: K7 (rolling regression) and K8 (bivariate moments) are `unbounded`,
and K6 (path-dependent state machines) is not partitionable at all.

Extended to the **whole** composable surface, not just the financial kernels:
core operators (`align`/`fill`/`aggregate`/`diff`/`pctChange`/…), the transforms
an agent reaches for when exploring visually (`byValue`, `byColumn` histograms),
and the folds that become facts. Two findings there stand independent of any
parallelism: **`pctChange` is unbounded and already shipped unflagged** (it
divides by the previous value), and a fourth idea is needed — **discretising**
operators (bins, ranks, crossings, `argmax`) turn _any_ upstream inexactness
into a categorical difference, so `bollinger` → "crossed the band" is discretely
unstable on `main` today from blocked summation alone, with no workers involved.

Not a commitment. Red-team it before anything commits to it.

### pond-rs — native Rust core

[`docs/rfcs/pond-rs.md`](docs/rfcs/pond-rs.md) — a native Rust implementation
of pond's core and financial studies, for agents writing Rust, with a WASM
bridge back into pond-ts later where it measurably pays. Building started
2026-10-17; decisions, defaults (crate `pond-rs`, `jiff` for time zones) and
shipped outcomes in [PND_RUST_PLAN.md](docs/plans/PND_RUST_PLAN.md). R0 to R3
(batch core, financial studies, live layer) are complete; the R4 bridges
(`@pond-ts/wasm` on npm, `pond-timeseries` on PyPI), column expressions
([PND-EXPR]) and the R5 port of `@pond-ts/process` (crate `pond-process`, not
yet on crates.io) are built. The pond-ts bugs found while porting are Core
issues (label `rs-parity`).

**Open issues:** Linear project [Core](https://linear.app/pondts/project/core-56ab562a7fc7) (label `rs-parity`); [Docs](https://linear.app/pondts/project/docs-e90d5dd41988) (label `docs-site`); [Financial](https://linear.app/pondts/project/financial-8b09ced936c3) (labels `studies`, `trading-time`); [Rust](https://linear.app/pondts/project/rust-d615b34b262d) (label `pond-rs`).

### `@pond-ts/financial`

Calendar engine + trading-time axis + the first studies batch (10 studies,
pandas-oracle-verified) have shipped. Frozen plan:
[PND_FINANCIAL_PLAN.md](docs/plans/PND_FINANCIAL_PLAN.md) · assessment:
[financial-indicators-assessment-2026-07.md](docs/notes/financial-indicators-assessment-2026-07.md).

**Open issues:** Linear project [Financial](https://linear.app/pondts/project/financial-8b09ced936c3) (labels `studies`, `trading-time`).

### Live layer

Robustness debt plus the queued composition workstreams. Frozen plan:
[PND_LIVE_PLAN.md](docs/plans/PND_LIVE_PLAN.md).

**Open issues:** Linear project [Core](https://linear.app/pondts/project/core-56ab562a7fc7) (label `live`); [Rust](https://linear.app/pondts/project/rust-d615b34b262d) (label `wasm`).

### Streaming semantics (Phase 4.5)

Adopted milestones A–D from [streaming.md](docs/rfcs/streaming.md): explicit
time, lateness, finality, keyed state, structured change metadata. B/C/D were
sequenced behind the columnar substrate, whose batch side is now complete.
Frozen plan: [PND_STREAMING_PLAN.md](docs/plans/PND_STREAMING_PLAN.md).

**Open issues:** Linear project [Core](https://linear.app/pondts/project/core-56ab562a7fc7) (label `streaming`).

### Columnar substrate (remaining levers)

Batch columnar is complete; live columnar sits at a defensible
retention-boundary waypoint. Everything left is friction-gated with a named
consumer signal. Frozen plan:
[PND_COLUMNAR_PLAN.md](docs/plans/PND_COLUMNAR_PLAN.md).

**Open issues:** Linear project [Core](https://linear.app/pondts/project/core-56ab562a7fc7) (labels `columnar`, `core-backlog`).

### `@pond-ts/process` — declarative processing graph

A package that turns "compute these derived series" from imperative calls into
a declarative graph: plans arrive as data, a registry is the schema, identity is
content-addressed, and one request serves both a renderer and an LLM tool
caller. Design: [process.md](docs/rfcs/process.md) (RFC — context, not a
commitment). Frozen plan (task detail, and the measurements each task was
sized against): [PND_PROCESS_PLAN.md](docs/plans/PND_PROCESS_PLAN.md).

Ordering note: `PROCIDENT`'s slider half blocks any interactive (slider-style)
consumer. `PROCCOL`, `PROCKERN`, `PROCJOIN`, `PROCRANGE` and `PROCSLOT` have
shipped (write-ups in the breakout plan). The engine landed in
[#544](https://github.com/pond-ts/pond/pull/544); the package **published as
experimental at v0.55.0** after the 2026-08 audit hardening, which resolved
[PND-PROCSUB] (outcome in the breakout plan).

**Open issues:** Linear project [Process](https://linear.app/pondts/project/process-af5982fb3c62) (label `process`).

### Process demo — composer / request / results

A three-panel web app (`apps/process-demo`) where a prompt becomes a process
plan, the plan resolves against a bound dataset, and the result is charted.
Its job was to **decide the library's shape**, and **every milestone has
landed (M0–M6)**; what each one decided is recorded in
[PND_PROCESS_DEMO_PLAN.md](docs/plans/PND_PROCESS_DEMO_PLAN.md). The library
questions it left open live in the process section above ([PND-PROCIDENT]'s
slider half, [PND-PROCSCHEMA]'s units); [PND-PROCSLOT] has since shipped.

### Ecosystem (Phase 6)

Adapters and deployment-shape packages, after the streaming milestones they
depend on. Frozen plan:
[PND_ECOSYSTEM_PLAN.md](docs/plans/PND_ECOSYSTEM_PLAN.md).

**Open issues:** Linear project [Ecosystem](https://linear.app/pondts/project/ecosystem-d581b8c07207) (labels `adapters`, `fit`).

### Chart example friction

Friction found by **building real chart examples** rather than by reading the
API — the Gallery wave's replica of a production network dashboard
(`charts/gallery/site-traffic-dashboard`) drove most of it. Each item cost a
debugging cycle or forced a workaround that shipped in the example. Two bugs
found the same way were fixed in-wave (`AreaStyle.flatFill` for stacked areas,
and the `grid` / `sessionDividers` / `xKind` repaint dependencies), which is the
argument for the rest.

**Open issues:** Linear project [Charts](https://linear.app/pondts/project/charts-57e76455bf22) (label `friction`).

---

## Active experiments

Canonical roster (philosophy in CLAUDE.md; detail + queued coordination in
[PND_EXPERIMENTS_PLAN.md](docs/plans/PND_EXPERIMENTS_PLAN.md); full histories
in [docs/archive/experiments-2026.md](docs/archive/experiments-2026.md)):

| Track               | Agent  | Status / next                                                                                                                |
| ------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Tidal (financial)   | Claude | Most active loop; drives [PND-STUDY] + charts friction, now also `@pond-ts/process` (derive seam); auto-woken on npm publish |
| estela (geo/power)  | Claude | fit export decision made (`docs/notes/estela-fit-swap-2026-10.md`); next: adopt fit + charts from npm, delete local copy     |
| Dashboard           | Claude | Next: adopt `@pond-ts/charts`, report gaps/perf vs its hand-rolled charts                                                    |
| gRPC pipeline       | Claude | Revived 2026-10 on pond-rs; Node vs Rust race + writeup done; remaining: M5 extraction sweep → [PND-SERVER]                  |
| Webapp telemetry    | Codex  | In production; watch for friction reports                                                                                    |
| Charts experiment   | Claude | First `@pond-ts/charts` package consumer; annotation dogfood, ongoing                                                        |
| Robustness audits   | fresh  | Re-run as the available model improves; residue → [PND-AUDIT] ([PND-LIVFIX] shipped 2026-09-06)                              |
| Cold-start adoption | fresh  | [PND-COLDSTART] run 1 done 2026-09-12; run 1b (arms C/D, local build of the [PND-PARTCOL] fix) passed; npm re-run pending    |

---

## Cross-cutting work

These happen throughout rather than being scheduled:

- keep Linear current whenever a meaningful milestone lands (close the
  issue with its outcome; open issues for new work)
- keep the docs site aligned with shipped behavior
- add end-to-end examples whenever a major capability lands
- keep API reference generation working in CI
- expand tests alongside every new public API
- **check the keyboard and screen-reader path for any new interaction** — a
  gesture is not finished because a sighted mouse user can drive it; record
  what you find (fixed or not) on the `[PND-A11Y]` issue (Charts, label
  `a11y`)
- prefer benchmark-backed changes for performance-sensitive core refactors
