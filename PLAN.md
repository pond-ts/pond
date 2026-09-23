# Plan

This document is the **roadmap of future work only**. Each work section below
gives a one-paragraph summary and a link to its breakout plan
(`docs/plans/PND_*_PLAN.md`), which carries the full context per task. Work is
broken into tasks named `[PND-XXXXXX]`.

Where everything else lives:

- **Breakout plans** — [docs/plans/](docs/plans/) (`PND_*_PLAN.md`, one per
  work section; the long write-ups live there, not here).
- **Strategic RFCs** — [docs/rfcs/](docs/rfcs/) (forward-looking context, not
  commitments; only tasks adopted here are commitments).
- **Shipped history** — [CHANGELOG.md](CHANGELOG.md) for releases;
  [docs/archive/](docs/archive/) for the frozen phase/wave logs that used to
  live in this file (design decisions, shipped milestone detail, walkbacks).
- **Evergreen rules** —
  [docs/notes/design-principles.md](docs/notes/design-principles.md) (design
  principles + semantics to preserve; these hold across all new work).

Maintenance: when a task completes, remove it here and record the outcome
(decision + reasoning) in its breakout plan; add new tasks with a `PND-` ID.
A lost session should never erase the current state of the project.

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

**Coverage estimate:** RFCs + this plan account for perhaps **95% of the
final surface**. The remaining 5% comes from experiments first and then real
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

## Roadmap

### `@pond-ts/charts`

The canvas wave shipped the rendering spine, seven chart types, interactions,
the decimator (line/area/band M4 + viewport culling, **released in v0.49.0**),
and the trading-time + categorical axes; the package is **published**
(`@pond-ts/charts` on npm, `private: false`). Remaining: the interaction
tail, Phase-2 RFC slices, and the M5 parity gate for the stable /
estela-parity milestone. Shipped write-ups that used to sit here are in the
breakout plan. Plan:
[PND_CHARTS_PLAN.md](docs/plans/PND_CHARTS_PLAN.md) · RFC:
[charts.md](docs/rfcs/charts.md).

- **[PND-PARITY]** — M5 estela parity (the stable milestone; the package
  already publishes pre-parity). Faithful `DataChart` reproduction on real
  activity data, no regressions. Gates: statistical bands, theme tokens
  optional-with-default, shared axis-headroom policy.
- **[PND-HSWEEP]** — Horizontal `<BarChart>` sweep **shipped** (write-up in
  the breakout plan). Declared out of scope then, and still open: a
  **horizontal heat map** can click-select but cannot sweep (`beginSweep`
  returns `null` when horizontal, `HeatMap.tsx`), and a y-sweeping row has **no
  resting-block preview** — it suppresses the resting band rather than draw
  the x one, which would advertise a column the drag never selects.

- **[PND-INTERACTCONF]** — **The conformance tail.** The list family's
  selection currency, state ladder (`theme.list`), range gesture and keyboard
  parity shipped 2026-08-10, and `<BoxPlot>` joined the sweep (write-up in the
  breakout plan). Left:
  - `format` is a container-wide channel and cannot be honoured per row
    without reworking the readout plumbing (A8.4).
  - The list's **per-row bullet target marker** — `theme.list` carries
    `markerInk` for it, but the mark itself is unbuilt (`<BarList markers>`
    draws a rule through every row, which is a different thing). Roving
    tabindex, ARIA selection semantics and a touch range affordance are
    tracked under [PND-A11Y].

- **[PND-TRACESEL]** — Selection on `<LineChart>` / `<AreaChart>` **shipped
  2026-08-10** (write-up in the breakout plan). **Owed: a perf commit.**
  `sliceTrace` (`packages/charts/src/line.ts`) allocates per partitioned frame,
  sized by the swept window, so it falls under the repo's perf gate — contrary
  to what PR #634's body claimed. Fix: slice from the already-decimated
  polyline (or reuse buffers across frames), plus
  `scripts/perf-trace-sweep.mjs` and a before/after table. Not written as of
  v0.70.0.

- **[PND-TRACECYCLE]** — **Hotkeys to cycle which series a window selects.**
  Owner idea, 2026-08-10: `all → series1 → series2 → all`, with a hotkey to
  **keep** the current one or **exclude** it.

  Worth recording because it is a _third_ answer to the question a trace sweep
  cannot answer by pointing. The first two were z-order (topmost-wins —
  arbitrary to the reader) and take-everything (shipped, [PND-TRACESEL]).
  Cycling is better than either: it hands the ambiguity to the user instead of
  resolving it by a rule they cannot see, and it needs no new currency — plural
  spans already exist, so cycling is a _filter_ over the set the gesture
  produced.

  Open: whether cycling happens **during** the drag (the preview narrows as you
  tab) or **after** the commit (the selection narrows); which keys, given the
  plot surface is not focusable at all today ([PND-A11Y]); and whether
  keep/exclude are separate keys or a modifier on the cycle. The focus problem
  is the real blocker — there is no keyboard path to a chart, so this task
  depends on [PND-A11Y]'s focus model rather than standing alone.

- **[PND-ANNSNAP]** — **A snap-target registry, and selection ↔ annotation.**
  Owner design sketch, 2026-08-10. Two halves that share one mechanism.

  **The scenario both halves are for** is written up as RFC **Amendment 9** —
  a pace + elevation chart where a lap bar windows both traces, and a swept
  segment is saved ("Chalk hill climb"), listed with stats, and clicked to
  return to. Read it before designing: it is what makes lap boundaries the
  motivating snap contributor and "save the range" a real step rather than a
  nice-to-have.

  **The mechanism: `<ChartContainer snap>`, with targets contributed by
  sources.** A mode, not a per-gesture prop — and the consumer enumerates
  nothing, because the sources already know where their edges are. Same
  "declared, resolved by the container" shape as cursor snap policy and
  `binIntervals`.

  **This is a SECOND channel, deliberately not the existing one.** A **range
  cursor is not bound by it** — an _interval sequence_ is what the range cursor
  follows, and that is a **tiling** that partitions the axis ("which bucket am I
  in"). Snap targets are a **sparse set of edges** ("what is the nearest one,
  if it is close enough"). Different question, different resolution, so
  conflating them into `cursorBuckets` would break the range cursor to serve
  the sweep.

  **The target sources** (owner's list):
  - **series that are intervals or time-ranges** — a bar / bin / box layer's
    `[begin, end)` edges. Already published as `binIntervals`, so this
    contributor exists and only needs re-pointing.
  - **category marks** — the unit slots `[i, i+1)`; also already `binIntervals`.
  - **annotation edges** — a `<Region>`'s `from`/`to` and a `<Marker>`'s `at`.
    (A `<Baseline>` is a y value and so is not an x target.)
  - **session boundaries** — the trading calendar's collapse instants, which
    `<LineChart>` already computes for its own drawing and the container holds
    as `discontinuities`.
  - **sweep selection edges** — an existing span's own boundaries. **This is
    the elegant one:** sweeping up to an existing span's edge lands flush on
    it, so regions merge _exactly_ rather than approximately — which is a
    better answer to "sweeps merge regions" than a `mergeSpans` tolerance
    could be, because the coincidence is made true at gesture time instead of
    reconciled afterwards.

  **The two actions:**
  - **Promote a sweep to annotation(s)** — to save the range. Note the plural:
    a trace sweep now commits one span per trace ([PND-TRACESEL]), so promoting
    yields several annotations, and "which ones" is a question.
  - **Select within an annotation** — the inverse, making selections and
    annotations interconvertible.

  **Open questions, and the first two must be answered before any code:**
  1. **Precedence among targets.** With five contributors a pixel is often
     near several. "Nearest in pixels" is the obvious rule and probably right,
     but ties need a tie-break and it may be that an annotation edge should
     beat a bin edge regardless of distance (the user placed the annotation
     deliberately; the bin edge is just data shape).
  2. **The radius is in pixels, so it is view-dependent.** Zoomed out, many
     targets fall inside it and snapping becomes unpredictable; zoomed in,
     nothing does. Needs an explicit rule, and probably a cap on how far the
     cut may move from where the pointer actually is.
  3. **A span must not snap to its own edge.** Sweep edges being targets means
     the live preview's own boundaries enter the target set _during_ the drag
     that is creating them — a feedback loop that would pin the cut to itself.
     The preview spans have to be excluded from their own snap resolution.
  4. **`snap` as a boolean vs a set of kinds.** A boolean is the right first
     shape (the repo does not add speculative options), but "snap to
     annotations but not to bins" is a plausible early ask, so the widening
     path should be obvious before the boolean ships.
  5. **What activates "select within an annotation".** A `<Region>` is already
     draggable when `onChange` is given, so a click on one is partly spoken
     for.

  **A visual experiment is in the tree, unsettled** (2026-08-10): light-orange
  vertical rules at a committed window's edges,
  `theme.annotation.spanEdge` + `strokeSpanEdges`, drawn from each trace layer.
  It previews what promoting a sweep to an annotation would look like, and it
  reads well on both a line and an area. **Two things about it are wrong and
  need deciding before it stays:**
  - **A real annotation cannot sit there.** Annotations render in the **SVG
    overlay above** the canvas; these are canvas-side _under_ the trace ink,
    because "underneath" is what was asked for. So the experiment shows a look
    the annotation register cannot currently produce. Either the rules move
    above the ink, or the register gains a canvas-underlay pass.
  - **It collided with the brush band, twice.** Mid-drag the band strokes its
    own edges at the same two x positions, and at rest the **resting block
    band** did too — so each boundary carried two vertical rules a pixel apart,
    reading as one muddy smear. Fixed by making the rules committed-only and by
    suppressing the resting block band on a span-only row, which was a bug in
    its own right: that band previews "a drag here selects this block", and a
    trace has no blocks. The lesson generalises — **a boundary should be marked
    once**, and three separate things now want to mark one.
  - **Every spanned layer draws its own copy** at the same x. They are opaque so
    the overdraw is idempotent, but that is a workaround for the rules living on
    the wrong owner: a window's edges belong to the row, not to each trace in
    it. Two traces currently stroke the same two lines twice.

  **Note on scope:** promoting a sweep to an annotation may not need library
  machinery at all — `onCreate({kind: 'region'})` exists and a consumer holding
  the span can create it in a line, which is the same call made for
  `mergeSpans` and the lists' set arithmetic. **Snapping cannot be done
  consumer-side**, because it has to happen _during_ the drag. That asymmetry
  is the argument for building the registry and leaving promotion to policy.

- **[PND-CURSORAPI]** — **Publish the cursor contract** (RFC Q3), under A7.1's
  litmus rather than by argument: every built-in **and** SpiderRock's gapped
  crosshair written against it with nothing needing a new slot. The surface
  count has already been found short **twice** — three slots became four when
  the inline/flag chips turned out to be DOM in plot space — so the contract
  publishes on evidence, not on a claim of sufficiency.
- **[PND-SELECT]** — Selection Phase 2 remainder. Most of the phase shipped
  under other tasks: multi-select as `<MultiSelector>` plus the plural
  `onSelect` ([PND-INTERACT], [PND-INTERACTDOCS]), a `LineChart` hit test
  ([PND-TRACESEL]), and theme `dimmed` states. **Still unbuilt:**
  `selectionMode` and the `snapToClosest | snapToClosestSelected` prop —
  re-decide whether either is still wanted now that `<MultiSelector>` exists.
  RFC: [selection.md](docs/rfcs/selection.md).
- **[PND-BOXPLT]** — Finish BoxPlot: ValueSeries widening, range-only mode,
  px `offset` for same-x pairs, line-only shape, join the cursor x-snap, and
  selection `id` via rect-containment `hitTest` (#508 item 5; Candlestick
  takes the same geometry helper).
- **[PND-BOXHIT]** — **`<BoxPlot>`'s hit area is the mark's bounding box, not
  its ink — and on `shape="whisker"` those differ by 25×.** Measured at box
  centre: with the solid shape, ink and hit are both ~50px wide everywhere
  (they agree). With the whisker shape, in the p75→p95 region the drawn stem is
  **2px** while the hit is **50px** — so clicking visually empty plot beside a
  stem selects the box. That directly contradicts the bar rule shipped this
  same wave, where a click above the ink is the _deselect_ path, so the two
  layers now disagree about what empty space means. Sharpest under `offset`
  (paired call/put boxes), where two ±4px-shifted boxes have near-identical hit
  rects and layer order decides the winner.
- **[PND-HITMODE]** — **The stacked/categorical `hitTest` ignores `mode`, so
  hover is ink-only there.** The single-series path takes `(px, py, xScale,
yScale, mode)` and uses `mode` to let hover claim the whole slot while
  select requires the drawn ink (#582's continuous hover model); the stacked
  path takes no `mode` and is ink-only for both. So hovering above a short bar
  reports nothing on a categorical or stacked chart and reports the bar on a
  time-axis one. Carries a design question — which segment an above-the-ink
  hover should report on a stack — which is why it isn't a one-liner.
- **[PND-ORDCURSOR]** — **`<RangeCursor>` on an ordinal axis takes the row's
  cursor with it.** It gates on a continuous x (`brush.tsx`), so on a category
  axis mounting one is not merely inert — the row ends up with no cursor at
  all. Either draw a slot-band there or make the mount a no-op that leaves the
  row's other cursor alone; silently removing a cursor is the one option that
  isn't defensible.
- **[PND-TICKGAP]** — **The trading axis's tick budget doesn't bound label
  spacing under collapse.** `TRADING_TICK_PX` budgets 65px of plot per tick and
  picks the finest grain that fits, but a wall-clock anchor that falls in
  closed time gets relocated to the session open — a `00:00` anchor lands at
  09:30, ~33px from that session's `12:00` label. The budget measures
  wall-clock spacing while the axis draws in trading time, so it does not bound
  what it thinks it bounds. Visible in every `MultiSelector/TradingSessions`
  story.
- **[PND-CURSOR]** — Cursor/readout polish backlog (scatter 2D-nearest,
  chip de-overlap, y-oriented region cursor, `pointercancel` clear-only
  fix).
- **[PND-AXES]** — Axis backlog (label align, custom ticks, scale variety) +
  the deferred value-axis naming follow-up. (Relative/elapsed time is done —
  `<ChartContainer origin>`; **symlog is done** — `<YAxis scale="symlog"
linearWindow>`, [PND-SYMLOG]. [PND-AXISMIRROR] (a mirrored second axis) is
  **declined 2026-08-11** — the reporting consumer dropped dual mirrored axes
  across their whole set, so the ask has no consumer; reasoning in the breakout
  plan.)
- **[PND-VALAX]** — Value axis: widen Box/Candlestick x; grow the
  `ValueSeries` algebra only when a second consumer (geo) pulls.
- **[PND-THEME]** — `cssVarTheme` candle mapping (LOW; worked example + var
  naming convention, no new plumbing).
- **[PND-LIVELYR]** — Live-source-aware layer inputs (same report, ask #4):
  charts layers take only `TimeSeries`, forcing a fresh per-tick handle
  (`snapshot.partitionBy().toMap()`) per host. A `LiveView`-aware input — or
  a documented cheap-handle idiom for live charts — closes it. Overlaps
  [PND-PARITY] / the live layer.
- **[PND-XOFFSET]** — Per-layer bar offset and forward projection space
  (the assessment's **C2**), plus a crossing-band fill (**C3**). `ichimoku`
  now ships its spans keyed to the bar they are computed from and
  `ichimokuOffsets` says how far to draw them (+26 forward, chikou −26
  back); Alligator / Gator would use the same lever. Charts needs (a)
  x-domain padding measured in **bars** past the last datum and (b) a
  per-layer `xOffsetBars` — trivial on a daily grid, calendar arithmetic
  intraday (it lands on `scaleTradingTime`) — and (c) a `BandChart` mode
  that fills between two _crossing_ columns with the colour flipping by
  which is on top (the cloud; generally useful for price-vs-MA shading).
  Data side is done; this is the charts half. Breakout:
  `docs/plans/PND_CHARTS_PLAN.md`.
- **[PND-ANNRFC]** — Write the short `docs/rfcs/annotations.md` design
  record the owner asked for (confirm still wanted).
- **[PND-APIREV-REST]** — What the 2026-08 API review left open after
  [PND-CHARTAPI] / [PND-BARSEM] / [PND-HCAT] / [PND-VSADAPT] shipped
  (#590/#592/#593/#594; note:
  [charts-api-review-2026-08.md](docs/notes/charts-api-review-2026-08.md)):
  - **The union-typed-series limitation.** A layer's props are a union _per
    series kind_, so a value typed as `TimeSeries<A> | ValueSeries<B>` (a
    wrapper forwarding whatever it is given) matches no member and must be
    narrowed or cast — `DurationAxis.stories.tsx` is the worked example. The
    owner chose this over the single-generic alternative (`LineChartProps<Sr>`,
    which distributes over the union but changes every props type's public
    generic parameters); both are verified in
    `spikes/charts-type-seam/REPORT.md`. Revisit only if a real consumer hits it.
  - **A Codex adversarial pass on the type work**, recommended by the Layer-2
    reviewer at medium confidence and not yet run. The class it flags is real:
    the type seam twice shipped guarantees that looked right and were inert
    (the two-generic widening; the loose-vs-no-numeric conflation), so "it
    compiles" is not evidence "it checks".
  - **`<BarChart categories>` selection/readout on the horizontal axis** — the
    capability landed but its interaction contract was not exercised beyond
    the geometry; and **the gallery funnel** still hand-builds its ordinal
    bins + `i + 0.5` ticks because it lives on the unmerged
    `feat/gallery-track-g` branch. Simplify it when those meet.
  - **`categories` + horizontal + a multi-group stack** is untried; only the
    one-segment case has a story.

### Time zones

Two asks, in order: an **arbitrary IANA zone on the chart time axis** (ticks
on that zone's midnights / Mondays / month starts, labels, bands, grid and
cursor readouts all in it — today everything is runtime-local with no knob),
and **aggregations in that zone** (`Sequence.calendar(unit, { timeZone })`
already buckets day / week / month DST-correctly in batch; the gaps are
`quarter` / `year`, unit validation, the live path, and the zone being
unrecoverable from the output). Design: a zone is a parameter, never state on
`Time` / `TimeRange` / `Interval`; **one** zone-arithmetic implementation in
core, consumed by charts, so the bucket `aggregate` used and the tick that
labels it are the same instant; defaults do not move (core UTC, charts
viewer-local); the d3 specifier strings stay the format API. Plan:
[PND_TIMEZONE_PLAN.md](docs/plans/PND_TIMEZONE_PLAN.md).

- **Phase 1 shipped 2026-09-13** — [PND-TZCAL] (#728: `TimeZone`,
  `quarter` / `year`, unit validation), [PND-TZAXIS] + [PND-TZFIN] (#732:
  `<ChartContainer timeZone>`, `<XAxis timeZone>` for a second strip in
  another zone, `TradingCalendar.timeZone`), [PND-TZTEST] (#721 Sydney CI
  leg + #733 non-UTC operator sweep), [PND-TZDOCS] (docs PR). Outcomes and
  the decisions the build settled are in the breakout plan.
- **Phase 2, consumer-gated:** **[PND-TZLIVE]** calendar sequences on
  `LiveAggregation` / `Trigger.clock` (today a `TypeError`); **[PND-TZFLOW]**
  the zone flows from the sequence to the aggregate's output so the chart can
  default to it; **[PND-TZDAYGRID]** sub-day grids anchored at zone-local
  midnight.

### Docs site, landing, and API reference

The docs-site wave shipped P0–P1 and most of P2/P3 (Learn track, the
interaction and annotations reference sections, Axes/Layout/Chart-types, the
financial hub, and the in-site API reference for core + charts). Plan:
[PND_DOCS_PLAN.md](docs/plans/PND_DOCS_PLAN.md) · plan notes:
[charts-docs-site-plan-2026-07.md](docs/notes/charts-docs-site-plan-2026-07.md),
[core-and-landing-docs-plan-2026-07.md](docs/notes/core-and-landing-docs-plan-2026-07.md).

- **[PND-STORY]** — P2 finish: story-coverage fill for thin Storybook groups
  plus the prop-identity recipe (#464 landed only the tree scaffolding).
- **[PND-DOCP3]** — P3 remaining reference pages: Data adapters, Rendering &
  performance, Design philosophy ×2, Accessibility, Troubleshooting, RTC
  migration, the financial end-to-end guide.
- **[PND-GUIDES]** — P4 guides library: ops-dashboard, annotation workflows,
  value-axis guides + remaining recipes.
- **[PND-LAND]** — Landing-page story + remaining core concept pages beyond
  the transforms set.
- **[PND-APIREF]** — In-site API reference completion: `{@link}` resolution,
  react/fit/financial tranches, big-page ergonomics, missing class-level
  docstrings.
- **[PND-OBSDOC]** — "Observing pond-ts in production" how-to: the
  documentation-backlog items (pushMany guidance, bench-honesty callout, GC
  snippet, no-NaN guarantee, tie semantics, latency pattern) as one MDX pass.

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
(#722 + owner-applied GitHub topics; outcomes in the breakout). Plan:
[PND_ADOPTION_PLAN.md](docs/plans/PND_ADOPTION_PLAN.md) (baseline table,
per-task reasoning, deferred alternatives).

- **[PND-SKILL]** — The in-repo Claude Code plugin marketplace shipped in the
  first tranche (#722). Remaining: Cursor rules + a Codex snippet, deferred
  until the skill has survived one cold-start run.
- **[PND-PREDECESSORS]** — Point the two unmaintained predecessors at their
  successors. `esnet/pond` (`pondjs`, last release 2019, ~10.5k downloads /
  month) and `esnet/react-timeseries-charts` (last release 2019, ~6.4k / month)
  still outdraw pond 4:1 and mention no successor anywhere. Drafts — an issue
  and a README notice per repo, in the original author's voice — are in
  `docs/adoption/predecessors/`. Posted: both issues and the
  react-timeseries-charts README PR (URLs in the breakout); **owner action
  open:** the `esnet/pond` README PR.
- **[PND-COLDSTART]** — The measurement loop: fresh headless agents, one
  realistic task, four harness arms (nothing / pond in deps / skills / skills
  - a competitor). **Run 1 (2026-09-12, n = 1 per arm):** the no-harness arm
    never mentioned pond; the deps arm read the tarball `AGENTS.md`; both skill
    arms chose pond within seven turns, one uninstalling `arquero` to do so.
    Write-up and next steps:
    [cold-start-adoption-2026-09.md](docs/notes/cold-start-adoption-2026-09.md);
    harness in `docs/adoption/cold-start/`. [PND-PARTCOL] (the library friction
    it surfaced) shipped; re-run of arms C/D against the fix pending.
- **[PND-CHOOSE]** — "When to use pond" page (vs hand-rolled / arquero /
  danfo / polars-node; vs uPlot / Recharts for charts) plus a task → method
  index phrased the way an agent receives the job. Source:
  `docs/notes/agent-workloads-2026-07.md` §3.
- **[PND-ERRLINKS]** — Errors agents hit carry the fix and a `pond-ts.org`
  URL. Deferred until [PND-COLDSTART] shows which errors are actually hit.

### Accessibility — audit and fixes, library-wide

Pond's interaction surface grew one gesture at a time — cursors, selection, the
sweep, the 2-D rect, the list range gesture — and each landed with its own
keyboard story or none. Nobody has yet walked the **whole** surface from a
keyboard or a screen reader. Plan (and the finding register):
[PND_A11Y_PLAN.md](docs/plans/PND_A11Y_PLAN.md).

- **[PND-A11Y]** — **Audit the interaction surface, then fix.** Per surface,
  not per component: what can a keyboard user do, what does a screen reader
  say, and what does the DOM claim. Findings accumulate in the breakout plan
  as they are found — including the ones deliberately not fixed and why — so a
  later pass does not re-derive them.

  **The finding that prompted it:** the list family now supports single and
  multi-row selection by pointer _and_ keyboard, and **none of it is exposed to
  assistive technology.** `aria-selected` is not valid on a plain `<tr>`, and
  the obvious repair (`role="grid"`) promises cell-level Left/Right navigation
  the list does not implement — telling assistive technology a lie about the
  widget is worse than the current silence. The honest options are implementing
  the full ARIA grid pattern or rebuilding the interactive list as a
  `listbox`, and that is a design decision rather than a prop. Also open on the
  same surface: no roving tabindex (a 100-row list is 100 tab stops), no touch
  affordance for a range at all, and unverified focus visibility against the
  selection band.

  **The canvas is in scope and unaudited.** Every chart gesture is
  mouse-driven with no keyboard path, and what a screen reader should be told
  about a chart is a question this has not opened. The first step there is an
  inventory, not a fix — recorded so the audit's scope is not silently "the
  lists".

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

- **[PND-AGENTBENCH]** — **Built and measured** —
  `packages/financial/scripts/perf-agent-bench.mjs`. Q11 (500 symbols × 1000
  bars, per-symbol `zScore`, rank across symbols) answers in **39 ms**, and
  **79 ms at 1M points** — both inside the 100 ms gate, so **pond is the client,
  not the viewer**: a resident panel answers a 7-question flurry in 266 ms
  against ~140–350 ms of round trips for the same questions, and that is before
  any caching. Two findings reorder what comes next:
  - **`withWorkers` does nothing here (1.00×)** — it partitions _within_ a
    series, and every partition is 1000 rows, far below `MIN_ROWS`. The panel
    shape wants parallelism _across_ partitions. Right idea, wrong axis.
  - **`partitionBy`+`toMap` is 43–44% of the time and it is serial.** The
    studies are only ~53%, so the Amdahl ceiling for partition-level
    parallelism is **2.0×**, not 8×. Making the split cheaper is worth as much
    as threading it, and is worth doing first.

  Remaining: a flurry variant driven through the process graph, to measure the
  content-addressed cache rather than infer it (repetition is 68% of the work in
  a realistic 21-from-7 session).

- **[PND-SPLITCOST]** — `partitionBy`+`toMap` speed-up **shipped** (18.1 →
  12.7 ms at 500×1000; write-up in
  [PND_CORE_PLAN.md](docs/plans/PND_CORE_PLAN.md)). Remaining, unmeasured: the
  ~7 ms of `withRowSelection` + `TimeSeries` construction per group — a
  contiguous-range slice could skip the gather where partitions happen to be
  consecutive.
- **[PND-UNPIVOT]** — Ingest a **long** value-axis result cleanly (tenor/strike
  as a key column). Narrowed by the ClickHouse boundary in §8 of the note:
  unpivot and pivot are `arrayZip`+`ARRAY JOIN` and conditional aggregation
  respectively, so they belong in the query — pond's job is to receive the long
  shape, not reshape a wide row in JS.
- **[PND-XSECT]** — Rank/reduce across partitions. `partitionBy` gets you
  per-symbol; nothing ranks across.

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

### `@pond-ts/financial`

Calendar engine + trading-time axis + the first studies batch (10 studies,
pandas-oracle-verified) have shipped. Plan:
[PND_FINANCIAL_PLAN.md](docs/plans/PND_FINANCIAL_PLAN.md) · assessment:
[financial-indicators-assessment-2026-07.md](docs/notes/financial-indicators-assessment-2026-07.md).

- **[PND-STUDY]** — **105 studies shipped** — every corpus row that needed
  only a kernel (batch-by-batch history in the breakout plan). What remains of
  the 124 is gated on core or charts, not on `@pond-ts/financial`:
  - **G5 — forward displacement past the series end** (2): Alligator and Gator
    Oscillator, a small batch once [PND-XOFFSET] gives the offset somewhere to
    land.
  - **G6 — repainting studies** (4): Darvas Box, Fractal Chaos Bands and
    Oscillator, Williams Fractals. Ship batch-only with a documented
    "confirmed at bar N" column (ZigZag is the precedent), or wait for a live
    repaint contract — a decision.
  - **G4 — calendar-gated** (2): Projected Aggregate Volume and Projected
    Volume at Time; low value, deferred.
  - Six skipped by decision. Package-wide questions, none blocking: `ema()`'s
    seed vs TA-Lib's, a monotonic-deque fast path for core's rolling
    min/max, and `rollingValues`' inconsistent answer to a misnamed column.
- **[PND-STUDYCAT]** — Runtime study catalog **shipped complete in v0.67.0**
  (all 109 fluent methods; F-charts-27 resolved in #736). **Open only for a
  decision:** F-charts-26 (no per-output _mark_ — nothing says `macdHist` is a
  histogram or pairs `bbUpper`/`bbLower` as a band) and F-charts-28
  (`nearest` on charts' `TrackerSample`), which are one question about how
  much rendering meaning belongs in a data package. Close this task, or split
  those two out, once that is decided.
- **[PND-TCAL]** — Trading-time deferred items: point-key slot widths on the
  discontinuous axis, overnight sessions in `fromRules`. (Exchange-tz tick
  grain and cursor timezone control moved to [PND-TZFIN] / [PND-TZAXIS] in
  the Time zones section.)

### Live layer

Robustness debt plus the queued composition workstreams. Plan:
[PND_LIVE_PLAN.md](docs/plans/PND_LIVE_PLAN.md).

- **[PND-LATE]** — Late-event propagation through stateful live transforms
  (needs a reorder-aware event payload; overlaps [PND-CHANGE]).
- **[PND-LJOIN]** — Live merge / join across sources.
- **[PND-LALIGN]** — Live `align` + `materialize` (bounded-lag design);
  prerequisite-or-sibling of [PND-LJOIN].
- **[PND-LDEDUP]** — Live dedupe converging on the batch `keep` shape.
- **[PND-BUFWIN]** — Buffer-as-window Tier 1 (`live.reduce` sugar,
  `timeRange`, `eventRate`, naming) + Tier 3 slicing later.
- **[PND-TRIG]** — Trigger taxonomy: `Trigger.any` composition; the
  `Trigger.idle` wall-clock RFC moment (gate on a second signal).
- **[PND-RESV]** — Live-side reservoir sampling; gated on [PND-CHANGE]'s
  exact-removal eviction channel.
- **[PND-TAPOBS]** — Evaluate `tap()` per-partition observer now that fused
  rolling shipped.

### Streaming semantics (Phase 4.5)

Adopted milestones A–D from [streaming.md](docs/rfcs/streaming.md): explicit
time, lateness, finality, keyed state, structured change metadata. B/C/D were
sequenced behind the columnar substrate, whose batch side is now complete.
Plan: [PND_STREAMING_PLAN.md](docs/plans/PND_STREAMING_PLAN.md).

- **[PND-CHANGE]** — Milestone A: `LiveChange` source-side change model
  (append/reorder/evict), internal-first, 5% perf budget. Foundational;
  unblocks [PND-RESV] and [PND-LATE].
- **[PND-REPAIR]** — Milestone B: capability-based late repair. Design-ready
  but driver-light by empirical test — wait for a consumer whose measurement
  style surfaces it.
- **[PND-FINAL]** — Milestone C: output finality (`append`/`upsert`),
  wire-safe `AggregateEmission`, stable output IDs. Prerequisite for
  [PND-SERVER].
- **[PND-KEYED]** — Milestone D: `keyBy/window/aggregate` builder with
  per-key grace, stable identity, `keyTtl`.

### Columnar substrate (remaining levers)

Batch columnar is complete; live columnar sits at a defensible
retention-boundary waypoint. Everything left is friction-gated with a named
consumer signal. Plan:
[PND_COLUMNAR_PLAN.md](docs/plans/PND_COLUMNAR_PLAN.md).

- **[PND-COLOUT]** — Column-native output (§A): removes the dominant
  emit-side allocation slice; spike plan exists.
- **[PND-COLBOOL]** — `boolean` / array value columns through the columnar
  ingest engine. `ingestColumnsToStore` takes `number` and `string` only, so
  a series carrying either kind exports through `toColumns` / `toArrow` but
  cannot come back — the round trip is a compile error on the columnar door
  and a throw on `ValueSeries.fromJSON`. On `TimeSeries` those kinds are
  ordinary (the row constructor takes them), so this bites more often than
  the `ValueSeries` case that surfaced it. The engine work is small — a
  `'boolean'` branch building a packed bitmap and an `'array'` branch over
  `arrayColumnFromArray`, plus the sort permutation for both — but it widens
  `RawColumns` and `fromColumns`' contract, so it wants its own PR.
  Friction-gated: no consumer has asked yet.
- **[PND-TSJSONT]** — narrow `TimeSeries.toJSON`'s return type on
  `rowFormat`, as `LiveSeries.toJSON` already does. Long blocked by the
  TS2394 cascade, which [PND-TSCOLS] isolated: the trigger is a
  key-remapped mapped type in a **method return position on `TimeSeries`**,
  and a method-level type parameter defers past it (the workaround
  `toColumns` now uses, written up on its doc comment). Unblocked, but it
  changes an existing public return type, so it needs its own decision.
  While in there: `toJSON()`'s **tuple** rows measure consistently _slower_
  than its object rows (25.9 ms vs 18.6 ms at 100k × 6) — the tuple path
  allocates a `.map()` plus a spread per row where the object path writes
  properties into one literal. Probably a free win.
- **[PND-REORD]** — Columnar reorder corral (§B): unearned, RFC context
  until a signal arrives.
- **[PND-LROLL]** — Live rolling columnar reducer state (Step 3C-live): the
  only lever for the gRPC ceiling; parked at 2.1× headroom.
- **[PND-PLANNR]** — Aggregate planner (step 5): friction-gated.
- **[PND-DICT]** — Dictionary/string reducer adaptation (step 6):
  friction-gated.
- **[PND-KERNEL]** — Algorithm wins from the Rust/WASM spike
  (`spikes/columnar-wasm/`). Quickselect percentiles (12.9×) and blocked
  `sum`/`mean` (2.5×) shipped; the write-up and the `minMax` ±0 correction
  are in the breakout plan. Remaining: a branchless finite guard for
  `allFinite: false` reductions, and blocking the guarded sum path (1.84×
  measured, deliberately not taken). Acceptance benchmarks:
  `spikes/columnar-wasm/bench/controls.mjs`.

- **[PND-NANREP]** — Audit whether the validity bitmap earns its keep on
  **numeric** columns. Measured on a 1M column with 4% missing, same values
  and same answer, varying only how "missing" is encoded: dense (no bitmap)
  0.936 ms, **bitmap 1.398 ms (1.49×)**, **NaN-in-buffer 1.118 ms (1.19×)** —
  so the bitmap representation costs ~25% more than NaN on a scan kernel.
  Worse, the two encodings now coexist in the hottest path: after
  [PND-STUDYBOX] one `sma(20)` converts bitmap→NaN (0.81 ms) and back
  NaN→bitmap (1.32 ms), **2.12 ms of pure representation churn, ~21% of the
  call**.

  What the bitmap genuinely earns: it is **irreplaceable for string / boolean /
  array columns** (no NaN to borrow), and it gives `count()` / `nullCount()` /
  `hasMissing()` an O(1) answer from the cached `definedCount` — though a NaN
  scheme could cache the same integer.

  What it buys on numeric columns is thinner than it looks: the ability to
  distinguish a _defined_ NaN from a gap. The reducer non-finite policy already
  treats both as missing, row intake rejects non-finite outright, `fromColumns`
  maps it to a gap, and `withColumn`'s typed door now does too — so a defined
  NaN only arises from an operator's own arithmetic overflow, and only shows up
  through `at(i)` / `scan()` on an `allFinite: false` column.

  Not a small change: it moves an observable semantic. Scope it as a design
  note first, with the `at(i)` behaviour on `allFinite: false` columns as the
  decision point. Ties to [PND-WCNAN], which already chose NaN-as-missing for
  typed intake.

- **[PND-AGENTQ]** — The measured shape of the current agent workload, kept as
  the standing acceptance benchmark:
  `packages/financial/scripts/perf-agent-queries.mjs` (500k 1-minute OHLCV
  bars, resident, per-query latency). Run it before and after anything
  touching studies, `rolling`, or the reducers.

  A 5-study strategy pass has gone **318 ms → 84 ms (3.78×)** across
  [PND-ROLLKERN] and [PND-STUDYBOX]; summary facts were already under 3 ms and
  are unchanged. Studies remain the dominant cost by an order of magnitude, so
  they stay the place effort belongs. Current: `bollinger(20)` 31.5 ms,
  `zScore(20)` 26.5 ms, `envelope(20)` 12.5 ms, `sma(20)` 10.5 ms,
  `percentChange()` 4.5 ms, `ema(20)` 3.9 ms.

  **Against the pandas oracle** (`scripts/perf-vs-oracle.mjs`, the timing
  counterpart to the correctness oracle): the strategy pass has gone from
  **5.6× slower than pandas to 1.64×**, and `median` / `percentile` are now
  _faster_ than pandas (0.98× / 0.85×) on the back of the quickselect change.
  Worst case is 2.39×. Two architectural differences explain most of what is
  left and are the honest next question: pandas tracks missing values as
  **inline NaN** in the same float64 buffer where pond-ts tests a **validity
  bit per cell**, and pandas mutates a frame in place where every pond-ts
  operation returns a new immutable series.

  Next candidates, in the order the numbers suggest: a `stdev` specialisation
  in the rolling kernel (now the dominant per-row cost in `bollinger` /
  `zScore`, and the one reducer deliberately left on the state path because its
  order-independent Welford delete is not worth duplicating carelessly);
  `ema`, which is now the only study that did not move because it composes on
  `smooth` rather than the rolling kernel; and re-asking the Rust question
  against this new baseline (`spikes/columnar-wasm/REPORT.md` §10).

- **[PND-BOXFREE]** — Element-wise operators box every cell. **`cumulative`,
  `diff`, `rate` and `pctChange` are done (4.0–7.1×); `fill`, `shift` and
  `mapColumns` remain.** They are column-native only in the
  sense of not materialising `Event`s: they still read each cell through the
  polymorphic `read(i)` into a `ReadonlyArray<number | undefined>` and rebuild
  via `float64ColumnFromArray`. Measured **~10–20× slower per column than a
  plain typed-array walk** (exact `diff` control: 9.9× on gappy data, 17.1×
  dense; `rate`/`fill`/`shift` fitted at 16–27×). At 1M rows × 4 columns
  `diff` costs ~294 ms against ~16 ms for the same work unboxed. This is the
  largest single performance finding from the Rust/WASM spike and has nothing
  to do with Rust — see `spikes/columnar-wasm/REPORT.md` §9.3. Each operator
  needs its own validity write, since the boxed array is currently how
  validity gets derived; [PND-IVLCOL] is the worked example of that shape.
- **[PND-COLAPI]** — Make the column-API augmentation bundle-safe (F-1,
  HIGH — methods tree-shake out of browser bundles) + validity-aware
  `toFloat64Array({ missing })` + `hasAnyDefined()`. Two consumers each.
- **[PND-WIRE]** — Protobuf columnar wire codec + `SeriesUpdate` streaming
  append; design settled, build when the binary WS feed consumer arrives.
- **[PND-INGEST]** — `fromColumns({ onOutOfOrder: 'throw'|'sort'|'clamp' })`;
  fold the day-old `sort` boolean into the enum.
- **[PND-TSVAR]** — `TimeSeries<S>` variance refactor (`toJSON` narrowing,
  `required: false` rows); try the extracted-serializer path first.
- **[PND-GATHER]** — Dashboard snapshot-cost queue:
  `partitionBy().toMap()` gather-only, `column.dropMissing()`, two doc
  nudges.
- **[PND-AUDIT]** — v2-audit P2 backlog (papercuts, parity matrix, CI TZ
  matrix + perf-in-CI, schema helpers, bundle re-pin).
- **[PND-CITYPE]** — Widen CI type-checking to `test/` (the v0.14.2 slip
  class); ~half a day of existing-error cleanup first.
- **[PND-PERF]** — Low-priority micro-perf leftovers from the original
  audit; address incrementally.
- **[PND-REACT]** — React remainders: `dt = 0` docs, dashboard-guide fixes,
  `useSyncExternalStore` migration.

### `@pond-ts/process` — declarative processing graph

A package that turns "compute these derived series" from imperative calls into
a declarative graph: plans arrive as data, a registry is the schema, identity is
content-addressed, and one request serves both a renderer and an LLM tool
caller. Design: [process.md](docs/rfcs/process.md) (RFC — context, not a
commitment). Task detail, and the measurements each task is sized against:
[PND_PROCESS_PLAN.md](docs/plans/PND_PROCESS_PLAN.md).

Ordering note: `PROCIDENT`'s slider half blocks any interactive (slider-style)
consumer, and `PROCJOIN` is now on Tidal's path (see its entry). `PROCCOL` and
`PROCKERN` have shipped (write-ups in the breakout plan). The engine landed in
[#544](https://github.com/pond-ts/pond/pull/544); the package **published as
experimental at v0.55.0** after the 2026-08 audit hardening, which resolved
[PND-PROCSUB] (outcome in the breakout plan).

- **[PND-PROCIDENT]** — Decide how node identity is assigned, which decides
  cache lifetime. Content-addressed params accumulate by design (right for the
  MCP shape, where a repeated question should hit cache); params-as-Ins are
  bounded by the plan's shape (right for a UI, where a superseded slider
  position is worthless). Measured over a 200-position sweep: 200 nodes /
  310 MB of buffers versus 1 node / 6 MB — flat rather than linear in sweep
  length. The RFC's two consumers want opposite policies, so this is a design
  call, not a leak to patch; an earlier framing of this ticket blamed the graph
  for what was a plan-layer map. The conversational half was decided by the
  process demo's M5 (content-addressing, bounded by [PND-PROCCACHE]'s
  engine-wide budget); **the slider half is still open and blocks any
  interactive consumer.**
- **[PND-PROCSEL]** — Selective per-Out invalidation already works: a
  bollinger-shaped node changing `stdDev` leaves `middle`'s version untouched
  and its consumer idle, because the op hands back the same instance. Document
  it, and let the registry declare which params each output depends on so the
  corpus gets it by declaration rather than by hand. Sharpens the RFC's "the
  cutoff cannot fire" — true for whole-series identity compares, false per-Out.
- **[PND-PROCJOIN]** — Make the join a node: n series in, one aligned column
  set out, alignment policy in the id (inner vs as-of changes the answer). This
  is what lets a cross-source spec exist at all — separate graphs cannot hold
  one, and hand-combining misaligned instruments silently pairs different
  dates. Needs no engine change; `Graph` has no per-graph boundary today.
  **Now on a consumer's path:** Tidal is building pair charts (A vs B, often
  across tickers) on `process` and joins the legs by hand meanwhile. Its two
  design asks — each input names `(binding, column)`, and invalidation is
  tracked per source — plus a unit rule for multi-input ops are in
  [tidal-process-consumer-positions-2026-08.md](docs/notes/tidal-process-consumer-positions-2026-08.md).
- **[PND-PROCRANGE]** — Range recompute: **mechanism shipped**
  (`setSourceFrom` + opt-in `OpDef.runRange`, 209 → 55 ms/tick, bit-identical
  to a from-scratch pass). **Remaining, the larger half of the win:** 4×
  against a projected 26×. The gap is in the op — a `runRange` that copies the
  whole prefix out of `previous` is O(n) per tick — so it needs a
  **capacity-buffer contract** letting an op extend its previous column rather
  than rebuild it.
- **[PND-PROCREG]** — Plan rehydration across processes. Ids round-trip, a
  compiled graph does not; persisted views recompile from the stored plan.
  Deliberately no `fromJSON` yet. Two verified properties must become stated
  requirements: `specId` is invariant under param key order, and an omitted
  param collides with its explicit default.
- **[PND-PROCSCHEMA]** — The schema projection is the caller's contract. M2 found
  the recursive `$ref` was **not embeddable** — it resolves against the document
  root, so the projection silently dangled inside a tool's `input_schema`; fixed
  with `toJsonSchema({ base })`. Open: the projection carries no units, in either
  direction, so a caller cannot know `annualise` refuses a raw price without a
  `describe()` table in the prompt.
- **[PND-PROCSLOT]** — Caller-assigned **slots**, separating topology from value.
  Params are part of a node's id but do not change the shape, so the format uses
  one identity for two jobs. A slot (`bb`) is stable across a param edit and
  names a position; `specId` still keys the cache. Fixes `on` restating whole
  nested specs, makes refinement a patch, stops the pipeline view re-laying-out
  on a param change, and lets surfaced outputs carry the requester's own names
  — which is what a Tidal card is. Slots are an alias layer, not a replacement:
  M5's 2.811 ms return trip works _because_ the node persisted under its content
  id. Connections stay on the node (no full node editor is wanted); how a slot
  reference is disambiguated from a source column name is open.
- **[PND-PROCSOURCE]** — Harden the new opaque async-source boundary. The first
  slice (`defineSource`, `SourceRegistry`, `Host.runAsync`) keeps loaders and
  credentials host-side, preserves a bound graph across equal revisions, and
  coalesces concurrent calls for one source identity. Remaining:
  cancellation/freshness policy, source schema projection for remote composers,
  and a measured revision contract.
- **[PND-LIVESRC]** — Core-side: `LiveAggregation` does not satisfy
  `LiveSource<S>`, because its `on('event')` overload widens the listener's
  event type. Narrow the overload, or give the incremental operators their own
  named contract. Touches a public type — needs sign-off.
- **[PND-PROCPAR]** — Worker-thread parallelism. Shipped: `HostPool`
  (throughput, 3.1–4.0× on distinct requests) and `withWorkers` rolling
  partitions ([PND-SCANKERN]). **Remaining:** (1) the **latency half** —
  split one query's nodes across workers (spike: 2.42×, bit-identical).
  Blocked on an engine change: a node's value can only come from its own pure
  `compute`, so a result computed in another worker has nowhere to land; it
  needs a way to inject that value plus a ready-set scheduler over the
  compiled graph. (2) Wire `ema` / `cumulative` to the parallel-scan kernel
  (`spikes/parallel-scan/`, 3.14× measured, 99.91% bit-identical).
  Assessment:
  [worker-threads-assessment-2026-07.md](docs/notes/worker-threads-assessment-2026-07.md).

### Process demo — composer / request / results

A three-panel web app (`apps/process-demo`) where a prompt becomes a process
plan, the plan resolves against a bound dataset, and the result is charted.
Its job was to **decide the library's shape**, and **every milestone has
landed (M0–M6)**; what each one decided is recorded in
[PND_PROCESS_DEMO_PLAN.md](docs/plans/PND_PROCESS_DEMO_PLAN.md). The library
questions it left open live in the process section above ([PND-PROCIDENT]'s
slider half, [PND-PROCSCHEMA]'s units, [PND-PROCSLOT]).

### Ecosystem (Phase 6)

Adapters and deployment-shape packages, after the streaming milestones they
depend on. Plan:
[PND_ECOSYSTEM_PLAN.md](docs/plans/PND_ECOSYSTEM_PLAN.md).

- **[PND-SERVER]** — `@pond-ts/server` extraction from the gRPC experiment's
  aggregator shape (WS-snapshot-then-deltas, coalesce strategy, slow-client
  policy). Depends on [PND-FINAL] + [PND-KEYED].
- **[PND-NODE]** — Node stream adapters + third-party chart bridge helpers
  (`toRecharts`, `toObservablePlot`).
- **[PND-FITPUB]** — `@pond-ts/fit` first-publish pass. The package is
  already public and on npm (`private: false`, published lock-step with the
  rest; 0.70.0 is current), so what is left is the deliberate part: decide
  which of `simplify`, `elevationProfile`, `profileByDistance` and
  `rollingSpread` get a public path (all four are in `src/geo/` and none is
  exported today), the units-preference home, then hand estela the swap.

---

## Active experiments

Canonical roster (philosophy in CLAUDE.md; detail + queued coordination in
[PND_EXPERIMENTS_PLAN.md](docs/plans/PND_EXPERIMENTS_PLAN.md); full histories
in [docs/archive/experiments-2026.md](docs/archive/experiments-2026.md)):

| Track               | Agent  | Status / next                                                                                                                |
| ------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Tidal (financial)   | Claude | Most active loop; drives [PND-STUDY] + charts friction, now also `@pond-ts/process` (derive seam); auto-woken on npm publish |
| estela (geo/power)  | Claude | Waiting on [PND-FITPUB]'s export decision (fit is already on npm); then adopts fit + charts from npm, deletes local copy     |
| Dashboard           | Claude | Next: adopt `@pond-ts/charts`, report gaps/perf vs its hand-rolled charts                                                    |
| gRPC pipeline       | Claude | M3.5 realized; remaining: writeup + M5 extraction sweep (3 RFCs → [PND-SERVER])                                              |
| Webapp telemetry    | Codex  | In production; watch for friction reports                                                                                    |
| Charts experiment   | Claude | First `@pond-ts/charts` package consumer; annotation dogfood, ongoing                                                        |
| Robustness audits   | fresh  | Re-run as the available model improves; residue → [PND-AUDIT] ([PND-LIVFIX] shipped 2026-09-06)                              |
| Cold-start adoption | fresh  | [PND-COLDSTART] run 1 done 2026-09-12; re-run of arms C/D against the [PND-PARTCOL] fix pending                              |

---

## Chart example friction

Friction found by **building real chart examples** rather than by reading the
API — the Gallery wave's replica of a production network dashboard
(`charts/gallery/site-traffic-dashboard`) drove most of it. Each item cost a
debugging cycle or forced a workaround that shipped in the example. Two bugs
found the same way were fixed in-wave (`AreaStyle.flatFill` for stacked areas,
and the `grid` / `sessionDividers` / `xKind` repaint dependencies), which is the
argument for the rest.

- **[PND-CHFRIC]** — Charts friction from the Gallery examples: `BoxStyle.strokeWidth`
  is declared but never read (the list's tick is hard-coded 3px); `BoxList` has no
  value-label gutter, no band-radius knob, no header row and one ink for every
  column; the list's text and hover colours are reachable only through unrelated
  theme tokens (`axis.band.label`, `legend.border`); `<Legend>` is always an
  in-plot overlay; theme roles fall back **silently** per primitive; `panZoom`
  uncontrolled ignores later `range` props; `<YAxis label>` defaults to the axis
  id. The cursor is the recurring theme: `CursorMode`'s docs promise a
  per-series crosshair the implementation doesn't draw, `TrackerSample.label`
  reports a theme role rather than a column, a layer can't opt out of the
  readout (so one column drawn twice raises two identical flags), the x-axis
  time pill is gated on `crosshair` so the **default** `line` cursor shows no
  position either, and `<BarChart>` has no `readout` prop — so a chart whose
  colour carries the value has a pill reading its layout constant. Two more
  from the scrubbable wind rose: **`PartitionedTimeSeries` has no `reduce`**
  (a core gap — "collapse each partition to one scalar" is the histogram case
  and has no direct form, only `toMap()` plus a `TimeSeries.reduce` per group),
  and `<CategoryAxis>`'s label thinning is an **estimated** glyph width that
  lands on the wrong side at Gallery-card width, printing all sixteen sector
  names into one smear. The Niño 3.4 overlay adds a **core** cluster around a
  series whose columns are named at runtime (one per year): `select` is
  variadic and silently returns an empty series when handed an array, a
  `collapse` key that names no column is an unguarded `TypeError` rather than a
  named error, `TimeSeries<SeriesSchema>` resolves its data-column names to
  `never` so no method compiles against it, and `collapse`'s result type
  survives only while it is inferred. Plus the second card in one track to want
  a **y-span annotation** — threshold bands have to be drawn as N `<Baseline>`s
  because `<Region>` is x-only. Itemised, with the workaround each one forced,
  in [PND_CHARTS_PLAN.md](docs/plans/PND_CHARTS_PLAN.md#pnd-chfric--chart-example-friction).

- **[PND-SPARCFRIC]** — A **17-item friction survey** from an external consumer
  planning the replacement of seven hand-rolled SVG charts with pond
  compositions, assessed against 0.56.2 and written to be taken upstream as-is.
  Four items are corroborating second reports of work already tracked
  ([PND-SELECT], [PND-WIDTH], [PND-CHFRIC]'s `<YAxis label>` default, [PND-AXES]
  for symlog + a mirrored axis), which is itself signal on their priority. The
  owner's ordering for the rest: **(1) [PND-BANDBAR2]** first-class threshold
  banding along one bar's length, **(2) [PND-AXISHIDE]** `<YAxis hide>`,
  **(3) [PND-BANDPACK]** `maxBandWidth` + `bandAlign`, then **(4)** the three
  items that **mislead rather than merely block** — [PND-SIGNSTACK]
  (mixed-sign stacks silently render all-positive), [PND-CATEMPH] (the theme
  accepts emphasis colours the category path never reads), [PND-TICKUNIT]
  (`bins` silently forecloses the duration tick ladder). That last grouping is
  the report's own best finding: three independent items where the library did
  something defensible, the chart rendered, and the consumer had no way to see
  which branch was taken. **All four groups are now shipped** (see the breakout
  plan for what each landed as); what remains is the "decided at the regroup"
  set — [PND-CATRANGE], [PND-THEMEBASE], [PND-BINSWATCH], [PND-TICKCENSUS],
  [PND-BARCAP] — plus the deferred **dev-mode warning sweep**, which the trio
  argued for as one pass rather than three fixes and which only [PND-BANDBAR2]
  and [PND-SYMLOG] actually got. **[PND-CATSTACK], [PND-BARWIDTH] and
  [PND-SYMLOG] shipped 2026-08-11** as stack #644, and the consumer migrated for
  real against it on 0.59.0 — all three workarounds deleted (net −218/+91 lines of
  consumer code), the **tick ladder** since verified on one domain via a story they
  added for the axis their product hides, and the pan/zoom knee still unexercised
  because their chart does not zoom.
  [PND-BINSWATCH] is now partially resolved on the stack path only. Itemised, with
  each workaround and its cost, in
  [PND_CHARTS_PLAN.md](docs/plans/PND_CHARTS_PLAN.md#pnd-sparcfric--sparc-charts-friction-2026-08).

- **[PND-CATID]** — **Split category display label from category identity.**
  Second SPARC filing (2026-08-14, alongside the shipped [PND-CATFIT] label
  fit): a category's `label` is today ALSO its selection identity
  (`SelectInfo.mark`), so two categories that render the same string silently
  merge into one mark, and a consumer with duplicate-prone keys carries a
  `uniqueLabels` + `keyOfLabel` side-channel that produced two real bugs in
  their migration in one week. Sketch: `CategoryDatum.key?: string` (defaults
  to `label`), `mark` carries the key, the axis/readouts draw the label; the
  container `categories` prop widens likewise. **Public type widening on the
  selection currency — owner gate required.** Write-up in
  [PND_CHARTS_PLAN.md](docs/plans/PND_CHARTS_PLAN.md#pnd-catid--split-category-display-label-from-category-identity).

- **[PND-IGNITE]** — A **third** external consumer survey: 28 distinct entries
  (`PG-n`, merged from 39 raw) across seven planned financial panes, assessed
  against 0.59.0, **zero blocking**. Prioritized for the library rather than
  for the consumer — by leverage, by whether the workaround _duplicates
  library-internal state_, by breadth, and by cost shape. Its P0 argument is a
  **drift** argument: two themes force the consumer to re-derive geometry the
  library already computed, correct only until the library changes how a gutter
  is sized or how bands are packed, at which point their chrome silently
  misaligns with no type error and no test failure. **Three of its four
  one-line asks shipped 2026-08-12** in two PRs — [PND-IGNITEFRAME]
  (`useChartFrame()`, publishing the plot rect / gutters / scales / band
  edges), [PND-WIDTH] (`<ChartContainer width="auto">`, **closed** — third
  consumer, and the recipe became the implementation), and [PND-IGNITECAT]
  (`<ChartContainer categories>`, so any value-keyed layer can share an ordinal
  axis). Triage corrected the report's own ordering on two counts: **theme B
  was the cheaper P0**, because `scaleBand`'s domain is already numeric so a
  value-keyed layer lands where the bars do; and theme A's placement half was
  already structurally supported, leaving only the numbers missing. **PG-16
  reopens [PND-AXISMIRROR]**, declined 2026-08-11 for want of a consumer, one
  day before this arrived. Remaining, in the report's order: the in-plot
  `<CustomLayer>` (theme A's better option, now that the frame exists), a
  **ramp swatch** in the legend (PG-4, P1, cheap — a pure function of `colors`
  and `domain`), then P2's style escape hatches, band gap-parity and the
  axis-parity pass. Itemised, with each correction and what shipping did _not_
  close, in
  [PND_CHARTS_PLAN.md](docs/plans/PND_CHARTS_PLAN.md#pnd-ignite--ignite-charts-friction-2026-08-11).

- **[PND-ANNROLE] — annotation roles.** `theme.annotation.depth` draws a
  resting mark at 0.4 alpha, and **two consumers overrode that in opposite
  directions in one week**: the measles gallery card went louder (the vaccine
  dates _are_ the argument), estela went much quieter (`fillOpacity: 0.07`, a
  focus wash behind selected data). Both patched `theme.annotation` wholesale
  because the shipped themes define no `roles`, so the existing `<Marker role>`
  / `<Zone role>` had nothing to select. A single resting alpha cannot serve
  both — it is a role question, not a level question. Define a role vocabulary
  (at minimum _wash_ and _argument_) carrying its own depth ramp. Estela would
  adopt immediately and drop its override. Detail in
  [PND_CHARTS_PLAN.md](docs/plans/PND_CHARTS_PLAN.md#pnd-annrole--annotation-roles-a-resting-marks-alpha-is-a-role-question).

- **The estela two-families wave.** Four reports that are two families, not four
  asks — **X/Y asymmetry** and **`<BarList>` lags `<BarChart>`** — each with the
  same character: the mechanism exists and only points one way. **Shipped
  2026-08-12** as [#653]: [PND-XLOG] (landed as `<ChartContainer xScale>`, not
  `<XAxis scale>` — the container owns the one shared x scale) and
  [PND-LISTCOLOR] (`<BarList barColors>`, keyed on `row.key` so a `sortBy`
  cannot repaint the ramp onto the wrong rows). **Still open:**
  [PND-AXISGUT] / [#607] (the X strip doesn't participate in layout — the Y
  gutter does), [PND-LISTHOVER] / [#608] (the list has selection but no hover),
  [PND-CASTDOC] (the union-per-series-kind cast has no prose), and
  **[PND-XAXISOWN]** — a mounted `<XAxis>` should win over the container's
  implicit strip, or warn at the conflict. That last one has **three sightings
  now** (a `<GalleryCard>` comment telling callers to budget for the auto-strip,
  estela's #607 mis-subtraction, and stories drawing two axes); the tell is that
  every story in `Axes.stories.tsx` passes `showAxis={false}` to work around a
  default. It pairs with [PND-AXISGUT], since mounted-wins is what makes the
  height-reservation question answerable at all.

  Newly surfaced by that wave: **[PND-XSYMKNEE]** — x `'symlog'` uses d3's
  default knee (absolute 1) with no `linearWindow` counterpart, so on a
  `[0, 5_000_000]` domain the linear band is invisible and on a `[0, 3]` domain
  it swallows a third of the axis. Detail for all of these in
  [PND_CHARTS_PLAN.md](docs/plans/PND_CHARTS_PLAN.md#two-families-not-four-issues).

[#607]: https://github.com/pond-ts/pond/issues/607
[#608]: https://github.com/pond-ts/pond/issues/608
[#653]: https://github.com/pond-ts/pond/pull/653

---

## Cross-cutting work

These happen throughout rather than being scheduled:

- keep this roadmap current whenever a meaningful milestone lands (move
  completed tasks' outcomes into their breakout plan)
- keep the docs site aligned with shipped behavior
- add end-to-end examples whenever a major capability lands
- keep API reference generation working in CI
- expand tests alongside every new public API
- **check the keyboard and screen-reader path for any new interaction** — a
  gesture is not finished because a sighted mouse user can drive it; record
  what you find (fixed or not) in
  [PND_A11Y_PLAN.md](docs/plans/PND_A11Y_PLAN.md)
- prefer benchmark-backed changes for performance-sensitive core refactors
