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
the 5% need *opposite* treatment:

- **Discovery work waits for consumers.** The last 5% is exactly what
  experiments and real integrations surface; designing it early guesses.
- **Structural work must precede them.** Anything that reshapes the existing
  95% — a component-tree change, a prop relocation across components — gets
  monotonically more expensive as each consumer integrates, and cannot be
  justified by consumer signal because that signal never asks for it.

So a restructure is not "deferred until we learn more". It is either done
early or not done. The live worked example is
[`docs/rfcs/container-decomposition.md`](docs/rfcs/container-decomposition.md),
whose whole conclusion turns on this: 98% of its blast radius is our own code
**today**, and the milestones above are precisely the events that spend it.

---

## Roadmap

### `@pond-ts/charts`

The canvas wave shipped the rendering spine, seven chart types, interactions,
the decimator (line/area/band M4 + viewport culling, **released in v0.49.0**),
and the trading-time + categorical axes; the package is **published**
(`@pond-ts/charts` on npm, `private: false`). Remaining: land built work,
Phase-2 RFC slices, and the M5 parity gate for the stable / estela-parity
milestone. Plan:
[PND_CHARTS_PLAN.md](docs/plans/PND_CHARTS_PLAN.md) · RFC:
[charts.md](docs/rfcs/charts.md).

- **[PND-CATAX]** — Land categorical axis Phase 1. Three PRs are built and
  verified on `feat/charts-categorical-axis` but not pushed; land with
  Layer-2 + Codex review, human gate on the `SelectInfo.mark` widening.
- **[PND-PARITY]** — M5 estela parity (the stable milestone; the package
  already publishes pre-parity). Faithful `DataChart` reproduction on real
  activity data, no regressions. Gates: statistical bands, theme tokens
  optional-with-default, shared axis-headroom policy.
- **[PND-INTERACT]** — **SHIPPED 2026-08-08.** The interaction surface is now
  mounted components: six flat cursor presets, `<Selector>` / `<MultiSelector>`,
  `<RangeCursor>` with its drag, one brush recognizer owning the claim ordering,
  and the `SpanSelection` currency — all behind deprecation shims that keep the
  thirteen old props working for one minor. `[PND-CATRANGE]` folded in as
  designed: category axes sweep in slot units. Red-teamed by Codex, a Fable
  agent and two consumers ([#611](https://github.com/pond-ts/pond/discussions/611));
  RFC **A8** records everything building it taught. Remaining tail below.
- **[PND-INTERACT2D]** — **2-D region select and zoom on scatter + heat map.**
  The rect on the two layers whose marks live in two dimensions, for both
  `<RangeCursor>` (zoom) and `<MultiSelector>` (select). Q14's design is settled
  (RFC A7.6/A7.7): **no spatial index on either layer** — the heat map is two
  binary searches plus closed-form row slots, scatter is a sorted-x cut plus a
  scan — and nothing persists outside a drag. Three things it must carry:
  **inherit A8.1's repaint lesson** (re-price every membership scan before
  lighting a grid preview — the 1-D case cost 6.2 s/frame before it was fixed);
  **settle spans-plural-or-topmost** before copying `SpanSelection`'s
  single-`id` shape; and it **also closes horizontal-bar sweeps**, which are a
  y-window and therefore 2-D machinery (A8.4). Both layers now have full
  `Selector/{Scatter,HeatMap}` **and** `MultiSelector/{Scatter,HeatMap}` matrix
  columns, both fixtures declaring `sweep: true`.

  **Owner decisions, 2026-08-09** — these settle the shape, so the remaining
  work is implementation rather than design:
  - **It is the same `<MultiSelector>`, not a new component.** "Yes it's
    different but to a user it's natural" — a drag draws a rectangle, and the
    _layer_ declares whether it reads one or two dimensions. Nothing new is
    mounted and no prop is added; the consumer's markup for a scatter is the
    markup for a bar.
  - **The heat map snaps in both dimensions** — bin columns on x, row slots on
    y, so the rect lands on cell edges exactly as the 1-D band lands on bin
    edges (A7.6's edge rule, in two axes).
  - **Scatter is free** — an unsnapped rect in data space, because a point has
    no cell to snap to.

  With the layer declaring its own dimensionality, **spans-plural-or-topmost
  resolves the way the 1-D case already does**: the topmost sweep-capable layer
  claims the drag, and the commit carries that layer's `id`. The descriptor
  needs nothing new either — `SpanSelection.y` (scatter's continuous window)
  and `.rows` (the heat map's ordinal set) already exist and
  `spanMatchesAny` already tests them.

  **The visual model (owner, 2026-08-09).** The gesture:
  - **At rest** — a **small grey crosshair**: a compact `+` at the pointer,
    _not_ full-plot rules.
  - **Dragging** — a second small crosshair pins at the anchor, with a **blue
    rect** spanning between the two. So the 2-D brush is the 1-D band's
    analog: the same "here is what you have grabbed", in both axes.

  **Small is the point, not a size preference.** A full-plot crosshair is a
  value-reading instrument — it exists to project the pointer onto both axes.
  This crosshair marks a _corner of a rect_, and the rect already draws its own
  edges out to those axes, so full-length rules would add two more
  plot-spanning lines to a picture that already has them. The compact `+` says
  "here", which is all a corner needs to say.

  Scatter point states:

  | state                         | fill  | mark                         |
  | ----------------------------- | ----- | ---------------------------- |
  | rest                          | green | —                            |
  | under the live drag rect      | green | outlined, so it reads larger |
  | selected (committed)          | blue  | outlined                     |
  | outside a non-empty selection | —     | ghosted                      |

  Two things this settles beyond the pixels:
  - **The resting colour moves off cerulean (`#0284c7`) to green.** That is the
    bar palette's rule for the third time: rest cannot be blue, because blue
    has to mean _committed_. It is a `defaultTheme.scatter` change, not a
    per-story one.
  - **Preview grows; selection recolours.** The live-rect state keeps its hue
    and gains an outline — the candle's move — while the committed state takes
    blue, which is available here because a scatter point's colour is not
    load-bearing the way a candle's direction is. So the preview and the commit
    are distinguishable without the preview borrowing the committed colour.

  **Heat map: one outline around the selection, not one per cell.** The
  selected block gets a single perimeter; the cells inside keep their ramp
  colour and simply sit within it.

  That asymmetry with scatter is _derived_, not a second opinion. Because the
  heat map snaps in **both** dimensions, a selection is always a contiguous
  rectangle of cells — so "the outline of the selection" is a well-defined
  single shape. A scatter's selected points are scattered by construction and
  have no shared perimeter, so there each point is outlined individually. Same
  rule (outline what is selected), different geometry to outline.

  It is also the fix for the thing that makes a per-cell treatment unreadable:
  a bordered grid of cells is mostly border, and the interior lines say
  nothing — every one of them is interior to the selection.

  **The heat map ghosts with a flat overlay, not opacity.** Unselected cells
  take a **white veil at 62%**; the selected region takes one perimeter.

  This corrects an earlier note here that said the heat map must not ghost at
  all, on the grounds that alpha and value are the same channel so dimming
  moves cells along the ramp. The concern is real but the conclusion was too
  strong, and the design answers it: a **flat overlay is uniform and
  monotonic**, so every cell lightens by the same transform and the ramp's
  _order_ survives inside the ghosted set. What remains is only a cross-set
  ambiguity — a veiled dark cell can match a resting mid one — and the
  perimeter is what tells you which set you are reading.

  "Not opacity" is load-bearing beyond the arithmetic: on a white ground the
  two are numerically close, but opacity composites with whatever is _behind_
  the cell (gridlines, a non-white background, another layer), so the same
  value would veil to different colours in different charts. A flat overlay
  is a property of the cell.

  Full state table:

  | mark                | rest                  | dimmed                        | hover                                     | selected                                              |
  | ------------------- | --------------------- | ----------------------------- | ----------------------------------------- | ----------------------------------------------------- |
  | **heat map cell**   | ramp value, no chrome | white veil 62%                | 2px white **+** 2px `#12564E` double ring | — (the _region_ carries it)                           |
  | **heat map region** | —                     | —                             | —                                         | 2px `#3F5BE0` perimeter, one outline around the union |
  | **scatter point**   | 9px `#2A9D8F`         | 5px · opacity `.34` (shrinks) | 11px `#4FD0BE` + 2px halo                 | 9px `#3F5BE0` + 2px halo                              |

  Three details in that table are decisions, not values:
  - **The cell hover is a double ring** — white _and_ dark teal, 2px each. A
    single ring cannot work on a ramp: white vanishes at the light end and dark
    teal at the dark end, so the pair guarantees one of them reads wherever the
    cell happens to sit. This is the same problem `binFills` bars have and a
    better answer than theirs.
  - **A dimmed point shrinks (9px → 5px) as well as fading.** Alpha alone at
    `.34` would thin the cloud to near-nothing; shrinking keeps its _shape_
    readable, which is the thing a scatter's unselected field is for.
  - **Hover grows (11px) and selection does not (9px).** Size carries hover
    because it is the channel a lone pointer-over can afford to spend; the
    committed state spends hue instead and keeps its resting size, so a
    selection does not reflow the cloud. Both take a 2px halo, which is what
    keeps overlapping points countable once they are the same colour.

  The point palette is the shared one again: `#2A9D8F` is the bar's resting
  teal and `#3F5BE0` its selection blue, so a selected point beside a selected
  bar reads as one act.

  **Shipped so far — the cut and the gesture.** `sweep2D` (the rect cut, with
  y in its delta gate), `beginSweep` on both layers, the gesture tracking y
  alongside x and committing the second channel, and the brush rect with a
  small `+` on each end of the drag diagonal. Both fixtures declare
  `sweep: true` and the two `MultiSelector` columns are walkable.

  Three findings from that pass, recorded in the charts breakout plan: a point
  layer's span must be the **drag window**, not `[first.key, last.key]` (the
  half-open test drops its own last point); a 2-D sweep's slop must be on the
  **distance**, or a straight-down drag can never start; and a 2-D layer
  publishes **no resting block**, because the block is a column and the drag
  beside it captures a rect.

  **Also shipped — the scatter palette.** `theme.scatter.*.states` (an
  optional group, `BoxStyle.states`' shape), the rest colour off cerulean to
  `#2A9D8F` at 9px, and the whole table above wired into `drawScatter`. Two
  notes worth keeping: a live point is deferred **whole** rather than
  re-ringed, because its fill _and_ radius change and a resting neighbour
  drawn later would otherwise paint over the grown body; and the state radii
  are applied as the **ratio** to the base radius, so a data-driven `radius`
  encoding is not flattened to one size the moment a point goes live.

  **Also shipped — the heat map states.** A new optional `theme.heat` slot
  carrying only the states (the geometry still comes from `theme.bar`, which
  is right: a cell is a bar's slot with colour instead of height). The
  live drag and the committed outline answer differently (owner, 2026-08-09,
  after one wrong turn — see below):
  - **Dragging** — the brush shows the **snapped** rect it is about to take
    (`SweepSession.snap`), so the preview cannot promise a set the release
    will not deliver. A scatter's cut is free, so its brush stays on the
    pointer.
  - **Released** — the new rect joins what is already selected and the
    outline **merges**: one perimeter around the union, from suppressing each
    cell edge whose neighbour is also selected. No connectivity pass, so
    disconnected pieces get one outline each and a hole gets its own, and no
    false edge where a selection runs off-screen.

  **The wrong turn, for the record.** A diagram showing two overlapping
  grid-snapped rectangles was read as "one outline per selection _act_, acts
  do not merge", and shipped that way (`27df067`) before the owner corrected
  it: the diagram was the **drag**, not the commit. What it was really saying
  is that the drag rect snaps — the thing that was actually missing — and the
  per-act reading was reverted. Worth keeping because the mistake is not
  obvious in hindsight: both readings produce overlapping rectangles in a
  still image, and only the moment they appear tells them apart.

  **Also shipped — the perf gate** (`scripts/perf-interact2d.mjs`, 18
  scenarios). It found what it was written to look for and one thing it was
  not:
  - **The A8.1 shape, unfixed on both 2-D layers.** A sweep lights its covered
    marks through the plural `hovered`, so the draw's membership test runs
    once per visible mark over the whole set — 100k points with 50k covered
    measured **4.0 s per frame**. `bars.ts` solved this with a per-draw set
    index at 16 entries; scatter and the heat map never got one. They have one
    now: **4042 ms → 14.7 ms** (scatter) and **2.64 ms → 1.01 ms** (heat).
  - **The heat map recomputed what its neighbour grid already knew** — the
    cell loop redid the label compare and the span test per cell even though
    the perimeter pre-pass had answered them. Reading the grid back: −10% on a
    45,000-cell selected repaint.
  - **A "floor" scenario that was measuring the worst case.** `CUT-GATED`
    wiggled the pointer across an exact key, and the press-edge pullback
    flipped the covered run on every other move — 9,999 re-cuts out of 10,000
    while claiming to be the delta-gated floor. Caught by instrumenting rather
    than by reading the number, which looked plausible. Fixed, it is 25 ns per
    gated move.

  What remains costed, not fixed: the states path adds ~70–90% to a _selected_
  heat repaint (1.4 ms at 365×45, 4.6 ms at 45,000 cells) — the veil is one
  extra `fillRect` per unselected cell. That is inside frame budget and only
  happens when there is a selection, so it is documented in the bench header
  rather than optimised away.

  **Shipped — the resting crosshair, and with it the whole of
  [PND-INTERACT2D]'s visual model.** A rect-sweeping row now rests as a small
  grey `+` and the drag pins the same mark at its anchor, so the gesture reads
  as picking up what was already under the cursor. It replaces the resting
  _band_, which a 2-D row should never have had — the band previews the snap
  block, and the block is a whole column while the drag captures a rect.

  The fact is declared on the layer (`RowLayer.sweepsRect`) rather than
  derived from a session, because at rest there is no drag to build one for
  and snapshotting the layer's arrays to answer a yes/no question is the wrong
  shape. It is the same fact `SweepSession.twoD` reports, so
  `test/sweep-capabilities.test.ts` pins their agreement across every
  sweep-capable layer — and does it by building the real session rather than
  reading the flag back, or the test would agree with itself.

- **[PND-HSWEEP]** — **The transposed sweep: horizontal bars.** `beginSweep` is
  wired **vertical-only** on every bar path, so a horizontal `<BarChart>` (bins
  on y, value on x) cannot sweep at all — the gap A8.4 named against the
  original friction report, and the one [PND-INTERACT2D] said it would close
  and didn't. Picked up ahead of the list family because it is the same
  currency as everything that already sweeps, where a list's is not.

  **It is 1-D, not 2-D** (owner + design, 2026-08-10). A8.4 called a horizontal
  bin cut "2-D machinery", which is true of the _plumbing_ and false of the
  _gesture_: a vertical bar's sweep ignores the value axis entirely (drag
  anywhere horizontally, take whole columns), so its transpose must ignore the
  value axis too — drag anywhere vertically, take whole rows. A rect on a
  horizontal bar would be value-filtering, a capability vertical bars don't
  have, and would break "the consumer's markup for a scatter is the markup for
  a bar" from the other side. **`sweep1D` is therefore reused verbatim** — it
  takes key-axis units and does not care which screen axis they came from.

  **What that costs is one new declaration, `RowLayer.sweepAxis: 'x' | 'y'`**
  (default `'x'`), orthogonal to the `sweepsRect` that shipped with
  [PND-INTERACT2D]. Both fields are real in all four combinations — (x, band) a
  vertical bar, (y, band) a horizontal bar, (x, rect) a scatter or vertical
  heat map, (y, rect) a horizontal heat map — which is why this is a second
  boolean-ish axis rather than a three-valued `sweepKind` enum. The gesture
  reads it to decide which pointer axis to invert, where the slop lives
  (`|dy|`, not `|dx|`), and which way to draw the band.

  **The band is row-local when the cut is on y.** The x band is container state
  because x is shared across rows; a y band is measured against one row's own
  axis, exactly as [PND-INTERACT2D]'s rect is. It is drawn by the same
  `renderBrushBand` with transposed geometry, keeping §8.1's identical-pixels
  promise.

  **Snapping does not come from `cursorBuckets`.** The x path snaps its window
  through the shared bin channel, which on a horizontal chart carries the
  _value_ axis (`binIntervals` is published vertical-only, deliberately). The y
  band takes its geometry from `SweepSession.extent()` instead — the
  snapped-outward extent the session already computes — which is the same move
  `snappedRect()` made for the rect, and is strictly better than the x path's:
  the band is derived from the cut rather than agreed with it.

  **A categorical bin axis needs no special case, and that is a finding rather
  than an assumption.** The vertical categorical path puts its bins on a d3
  **band** scale, whose `invert` snaps a pixel to the slot _centre_ — which is
  exactly why it publishes `binIntervals`, so its band can still snap outward
  to slot edges. Transposed, the bins land on y as a plain linear scale over
  `[0, N]` and only the _ticks_ are categorical (`binCategories`, consumed by
  `<YAxis>`), so `yScale.invert` is continuous and the extent-derived band
  lands on slot boundaries by construction. Pinned by tests and a story rather
  than left as a reading.

  **Not in scope, and declared rather than discovered:** the **horizontal heat
  map** is the (y, rect) corner and stays closed — `HeatMap` returns `[]` from
  `hitTest` when horizontal, so it cannot select at all, let alone sweep, and
  that is a `[PND-HCAT]`-shaped gap rather than this one. The **resting block
  preview** for a y-cutting row (the grey band over the block a press would
  take) needs the resting-block machinery transposed too; until it is, a
  y-sweeping row must **suppress** the resting band rather than draw the x one,
  which would advertise a column the drag will never select.

- **[PND-INTERACTCONF]** — **The conformance tail.** The **list family** joins
  the sweep. (`<BoxPlot>` has now joined: a box is an aggregation owning one
  `[begin, end)` column, so it publishes `binIntervals` + `beginSweep` and
  sweeps exactly as a bar — a bar that simply isn't grounded to the axis. Its
  pixel `offset` still complicates the key-space cut, and that is now
  `[PND-BOXHIT]`'s territory since the same shift is what makes two paired
  boxes' hit rects overlap.) `format` is a container-wide channel and
  cannot be honoured per-row without reworking the readout plumbing (A8.4).
  Then **remove the deprecation shims** one minor after they land.

  **The four columns [PND-INTERACT2D] did not reach** (owner, 2026-08-10).
  The wave took the column marks (bar, stack, box, candle) and the two 2-D
  layers (scatter, heat map); these are what is left, and they split into two
  quite different problems:
  - **`<BoxList>` and `<BarList>`** — the list family. **The framing above
    was wrong, corrected 2026-08-10 on inspection.** It read "same currency
    as the rest, so this is conformance rather than design: publish
    `hitTest` + `beginSweep`, add the matrix columns". `hitTest` and
    `beginSweep` are **`RowLayer` members**, consumed by `Layers.tsx`'s
    canvas pointer surface — and the list family has no layer to put them
    on. Both components render an **HTML `<table>`** and are explicitly
    standalone ("no `<ChartContainer>`; there is no time axis here"): no
    canvas, no `registerLayer`, no scale to invert a pointer through, no
    `SweepSession` plumbing reaching them. None of [PND-HSWEEP]'s
    `sweepAxis: 'y'` work transfers either, for the same reason — it lives
    in the canvas gesture.

    So this is **design, not conformance**, and it is a second interaction
    surface rather than a missing column of the first. What a list drag
    wants to be is the spreadsheet / file-manager idiom — press on row _i_,
    drag to row _j_, take the run — which is an ordinal cut over row order
    (PLAN guessed that part right) but implemented against `<tr>` pointer
    events, not against `sweep1D`. There is no key axis for a `SpanSelection`
    to describe, and no layer `id` for one to carry.

    **The currency is now in place** (owner-approved 2026-08-10; a public
    type widening, so it was a human gate). `selected` on both `<BarList>`
    and `<BoxList>` takes `string | readonly string[] | null` — the same
    union `hovered` already took, with the same normalization and the same
    "no set arithmetic" contract. Additive: every existing caller passes a
    `string` or `null`. The asymmetry it closes is the tell for why it is
    the right shape — `hovered` went plural precisely _because_ a sweep
    lights several marks at once, so the list had the receiving half of the
    gesture and not the committing half.

    **The row-chart state ladder** (owner spec, 2026-08-10). The visual
    language for the states above, and the analogue of the scatter / heat-map
    palettes from [PND-INTERACT2D]. Two elements the row has that a canvas
    mark does not: the **band** (the whole row stripe, label gutter through
    trailing value) and the **rail** (a 3px inset left edge).

    | State                    | Treatment                                                          |
    | ------------------------ | ------------------------------------------------------------------ |
    | rest                     | band transparent · fill `#2A9D8F`                                  |
    | dimmed                   | fill opacity `.32` · **track unchanged**                           |
    | hover                    | band `#F6F6F3` · rail `#4FD0BE`                                    |
    | selected (single-metric) | band `#EEF1FD` · rail 3px `#3F5BE0` · fill goes blue too           |
    | selected (multi-metric)  | band + rail **only** — hue is identity, so chrome carries it alone |
    | target marker            | ink `#1C1C1A` · 3px — never blue                                   |

    Four rules, each with its reason, because the reason is what generalises:
    - **The row is the target, not the bar.** Label gutter, track and
      trailing value are one hit area, **≥44px tall**. A vertical bar chart
      can make the mark the target because every mark spans the full column
      width; a row chart cannot — a 4% row is a 30px sliver.
    - **The band carries selection alone.** Band + rail must read as selected
      with **no help from the fill**, because in a multi-metric row the fill
      cannot change. Design the single-metric case that way too and one
      treatment covers every row chart in the library. (This is the channel
      rule the wave already runs on: state may only use a channel the mark is
      not already using for data.)
    - **Track is chrome, so it never dims.** The unfilled remainder is a
      _scale_, not a measurement — dimming it alongside the fill destroys the
      shared baseline that makes rows comparable. Full strength in every
      state, tinted to its metric.
    - **Reserve blue even from markers.** Targets, thresholds and reference
      ticks go to ink. On a bullet row the marker sits _inside_ the mark that
      selection recolors, so a blue tick is the one collision the rest of the
      language cannot absorb.

    **Shipped 2026-08-10.** The register is `ChartTheme.list` — five values,
    optional, and back-compatible when omitted (a theme without it keeps the
    borrowed hover band, the annotation rail and no dimmed state). Only the
    two band tints and the marker ink are new: a selected fill takes
    `BarStyle.highlight` and a dimmed one `BarStyle.dimmed`, both of which the
    interaction-state palette already carried, so a consumer who themes their
    bars gets a coherent list without theming it twice. **The rail is
    deliberately not per-metric** — one rail, many metrics — so it lives in
    the register rather than resolving through `bar[as]`.

    Two judgement calls worth recording. **A `<BoxList>` gets no "fill goes
    blue"**: a box has four inks (whisker, body, median, tick) so the phrase
    has no single referent, and rule 2 says chrome alone is sufficient by
    design — its dimmed state recedes body/median/tick and leaves the range
    band, which is the box list's track. **The 44px is gated on
    interactivity**: a read-only list has no target to make tappable, and
    forcing the height there would be a layout change for nothing.

    Revert-verified with three rule-specific mutations (fill carries selection
    on a multi-metric row / the track dims with the fill / hover borrows the
    selection rail); each reds exactly its own rule's test.

    **What the ladder did NOT cover, and why.** The spec's **target marker**
    (`ink #1C1C1A · 3px`, never blue) is a _bullet-row_ element — a per-row
    target sitting inside the mark. `<BarList markers>` today draws a
    reference rule through **every** row, which is a different thing. The
    register carries `markerInk` for it, but the per-row bullet target itself
    is unbuilt.

    **Gap against what `ListTable` rendered before** (verified 2026-08-10):
    - **rail on selected** — exists, as `boxShadow: inset 3px 0 0 accent`.
    - **band on hover** — exists, but reaches through `theme.legend.border`,
      an unrelated token `[PND-CHFRIC]` already flags.
    - **band on selected** — missing (selection is rail-only today).
    - **rail on hover** — missing (hover is band-only today).
    - **dimmed** — missing entirely; no state exists for "something else is
      selected", which is the one the track rule is _about_.
    - **single- vs multi-metric fill** — no distinction; the glyph fill is
      not selection-aware at all.
    - **per-row target marker** — `<BarList markers>` draws vertical rules
      across _every_ row, which is not the bullet-row target the spec means.

    **The literal hexes are the argument for a list theme slot.** Six values
    that a consumer cannot currently reach — `[PND-CHFRIC]` already notes the
    list's colours are only addressable through unrelated tokens. They should
    land in `defaultTheme` under the list's own key rather than as constants,
    or the stories cannot render the default the way CLAUDE.md requires.

    **The gesture shipped 2026-08-10** — `onRowSelect(rows, modifiers)` on both
    sisters, mount-enabled per A4.2 rule 1 and a strict superset of
    `onRowClick` exactly as `<MultiSelector>` is of `<Selector>`.

    Decisions worth keeping:
    - **Crossing into another row makes it a range**, not a pixel slop. A row
      is tall and discrete, so that is the question the gesture actually turns
      on; asking it directly means a press-and-release can never commit a range
      and a horizontal wobble (meaningless on a stack of rows) never can
      either. It needs no coordinates — per-row `pointerenter` answers it,
      which is also why there is no pointer capture (capture would route every
      later event to the pressed row and the others would never hear the
      pointer arrive; a window `pointerup` covers release-outside instead).
    - **`ranged` is positional, not historical** — it tracks where the pointer
      _is_, so wandering away and back is a click again. Found by
      revert-verification: the original `if (i !== d.anchor) ranged = true`
      guard was **redundant** (nothing could ever clear the flag), which is why
      that mutation survived while the others reddened. Making it positional
      turned dead code into real, tested behaviour.
    - **`additive` is `metaKey || ctrlKey`**, character-for-character what
      `Layers` resolves for a canvas select. A `navigator.platform` sniff was
      written first and rejected: whatever the better rule is, a list and a
      chart in the same app must not disagree about what "add to selection"
      means. (Note `SelectModifiers.additive`'s doc claims a per-OS rule the
      canvas does not implement — a doc/behaviour mismatch predating this.)
    - **A held press owns the hover channel**, gated on the press being armed
      rather than on the run having started: hover is delegated at the
      `<table>` while the range extends per row, and React dispatches the
      ancestor's handler **first**, so a `ranged` check let the very crossing
      that starts a run report a hover on its way past. `endDrag` hands the
      channel back to the row the pointer ended on, or `null` when the release
      was off the rows.
    - **No shift-click policy.** `shiftKey` is reported and given no
      behaviour, per `SelectModifiers`' own note that an ordinal range is a
      gesture, not a modifier.
    - **Native text selection is suppressed for the press only** (owner
      reported it: dragging painted the browser's selection colour across the
      labels, competing with the band and rail for the same meaning). Scoped to
      the press rather than the list because a data list's labels are hostnames
      and ticker symbols that people copy — a range gesture must not cost the
      list its selectable text. It has to be state rather than the gesture ref,
      because the style must be in the DOM before the browser starts extending
      a selection on the first move; `pointerdown` is discrete, so React
      flushes it in time.
    - **Touch is excluded from the gesture.** A vertical drag over a list on a
      touch device is how you SCROLL, and claiming it for a range would make
      the list impossible to scroll past. Touch keeps click-to-select (still
      reported through `onRowSelect`); a touch range wants its own affordance —
      a long-press or an explicit multi-select mode — rather than stealing the
      one gesture the platform already spent. **Unbuilt.**

    **Keyboard parity shipped 2026-08-10.** ↑/↓ move, Home/End jump,
    Enter/Space select (with modifiers, so ⌘/Ctrl-Enter adds), Shift with any
    movement key extends.
    - **On a keyboard the range IS a modifier**, which only looks like it
      contradicts `SelectModifiers`' "an ordinal range is a gesture, not a
      modifier". That note is about not overloading a _pointer_ chord that
      already means something else (a region drag); a keyboard has no competing
      gesture, and Shift-Arrow is the one range idiom every platform teaches.
    - **One anchor, shared with the pointer**, so a click can be finished with
      the keyboard. It holds across repeats (a plain move re-anchors, a
      shift-extend does not) — otherwise Shift-↓ slides a two-row window down
      the list instead of growing one run.
    - **Focus is the browser's**, not a mirrored index in state: arrows focus
      the row element and read `document.activeElement` implicitly. A second
      copy of "what has focus" is one more thing to desynchronise.
    - **The row lookup is `:scope > tbody > tr[data-list-row]`** — an expanded
      row's detail may hold a whole nested list whose rows carry the same
      attribute, and a descendant query would navigate somebody else's rows.
      (`handlePointerOver` guards the same hazard.)

    **Still open, and deliberately not done here:**
    - **No roving tabindex.** Every interactive row is still `tabIndex={0}`, so
      a 100-row list is 100 tab stops — the ARIA listbox pattern would make one
      row tabbable and let the arrows do the rest. It is the better pattern and
      it is a _behaviour change_ to existing keyboard flow, so it is worth
      asking for rather than slipping in beside a feature.
    - **No ARIA selection semantics.** `aria-selected` is not valid on a plain
      `<tr>`; making it valid means `role="grid"`, which promises cell-level
      Left/Right navigation this does not implement. Promoting the role without
      the navigation would be a worse lie than the current silence, so the
      honest fix is the whole grid pattern or a `role="listbox"` rebuild —
      neither of which belongs inside this task.

    **Superseded — what was open before the gesture landed:**
    - **Drag over `<tr>` rows** — press on row _i_, drag to row _j_, take
      the run. Pointer events on the table rows, not `sweep1D`: a list has
      no key axis and no scale to invert through. A row's `key` is its
      identity, so the committed value is a **key array**, not a
      `SpanSelection` (which needs a numeric interval and a layer `id`,
      neither of which a list has).
    - **The commit channel.** `onRowClick(row)` reports one row and carries
      no modifiers. A range release needs something plural — most likely a
      sibling callback rather than a widening, since the two report
      different things (one row vs a run) and a click must stay a click.
    - **Keyboard parity.** Rows are already focusable with Enter / Space
      activating them; a range select wants Shift-click and a Shift-arrow
      extend, and that is worth settling _with_ the pointer gesture rather
      than after it.

  - **`<LineChart>` and `<AreaChart>`** — **design settled 2026-08-10**, see
    `[PND-TRACESEL]` below.

- **[PND-TRACESEL]** — **Selection on a continuous trace** — `<LineChart>` /
  `<AreaChart>`, the last two columns of the selection matrix. **Design settled
  2026-08-10; the premise is that a trace has no marks, and every answer below
  follows from taking that seriously rather than working around it.**
  - **A sweep commits a `SpanSelection` with NO hits.** The span _is_ the
    selection. Empty `hits` is not a shortfall: a trace's samples are not marks
    (they are usually undrawn, and at any real density there are many per
    pixel), so "the samples you swept" is a set the user never expressed.
    Materialising them would also be exactly the **A8.1 cliff** — 100k
    `SelectInfo`s per drag frame — and a consumer who wants them already has
    the span and their own series, which is one `crop` in pond. **Deferred
    alternative, considered and rejected:** hits as the covered samples, via
    `sweep1D` with `begin === end` (scatter's point-layer shape). It is the
    obvious move and it is the expensive one.
  - **A click commits a series-scoped `SelectInfo`** — `key`/`value` `NaN`,
    because no sample was selected, which is what that convention already
    means. **And it carries a stable `mark`, which is the seam that makes this
    work with no currency change at all:** `sameMark` checks `mark` _before_
    falling back to `key`, so two clicks anywhere on the trace are the same
    mark and the documented deselect-toggle policy works. Without a `mark` it
    would not — `NaN !== NaN`, so `selectionContains` can never match a
    series-scoped entry against itself. The `<Legend>` emits no `mark` and so
    still "names no mark", exactly as its doc says; a trace opts in.
  - **The visual state uses WEIGHT, not hue** — the channel rule again, and the
    same answer `<Candlestick>` got. A line's **colour is its identity** (it is
    how a reader tells one series from another), so state cannot live there.
    `LineStyle` gains `selectedWidth` and `dimmedOpacity`; nothing else moves.
  - **`sweepsRect: false`, `sweepAxis: 'x'`.** A trace is 1-D in x and the
    value axis says nothing about what a drag covered.

  **What this needs in the kernel:** a third session builder beside `sweep1D` /
  `sweep2D` — one whose `extent()` is the drag window and whose `hits()` is
  always empty. Small, and clearly earned rather than speculative: it is the
  only shape that expresses "this layer has a range but no marks".

  **Shipped 2026-08-10.** `sweepSpan` in the kernel, `traceHitIndex` (distance
  to the drawn polyline, bisected then two segments — `O(log N)`, not a scan)
  and `areaHitIndex` (inside the fill, edge interpolated so the boundary
  follows the drawn slope). 27 tests, revert-verified on all three load-bearing
  claims: dropping the stable `mark` reds the deselect test, measuring to the
  nearest vertex instead of the segment reds three, and dropping the bounds
  clamp reds two. Verified in the browser too — a sweep commits
  `span mem [01-10 → 01-26)` with **0 marks**, and clicking one line then
  clicking the same line at a **different x** deselects it, which is the whole
  point of the `mark`.

  **Two things found while building it, worth keeping:**
  - **A `TimeSeries` cannot hold a gap in a number column** — NaN, `null` and
    `undefined` are all rejected by validation. So a gap only ever reaches a
    chart as NaN in the `Float64Array` an operator produced, and the gap cases
    in both hit tests are pinned at the **unit** level against a raw
    `ChartSeries` because that is the only honest place for them.
  - **Topmost-wins reads worse on a trace than on a bar.** With two lines in a
    row, a sweep commits a span on whichever layer is topmost (A8.4's
    single-`id` resolution). For column marks that is fine — you were pointing
    at marks. A trace sweep points at _nothing_, so "which trace did I sweep?"
    has no pointer answer, and the choice is genuinely arbitrary to the reader.
    Not a regression and not new machinery, but the trace case is where the
    single-span limitation starts to show. **Resolved, not deferred** — the
    owner hit it immediately ("when you drag a window both series highlight but
    only one selects. Both should select"), so a sweep now commits **one span
    per trace** and `onSelect` took the plural currency ([PND-INTERACTDOCS],
    #635). The "revisit if a consumer hits it" wording above is kept as the
    record of what we predicted; the prediction was wrong about the timescale.

  **Open, and owed a perf commit:** `sliceTrace` **does** fall under the repo's
  perf gate, contrary to what PR #634's body claimed — a fresh-eyes review
  caught it. It pushes into two `number[]`s and allocates two `Float64Array`s
  per partitioned frame, sized by the window, so a fully-swept large trace is a
  per-frame loop over the whole series. `sweepSpan` and the `O(log N)` hit tests
  are genuinely exempt; this is not. The fix is to slice from the
  **already-decimated** polyline (or reuse buffers across frames) plus
  `scripts/perf-trace-sweep.mjs` and a before/after table, per the gate.

  **The visual state SHIPPED** (2026-08-10, the commit after — it was held back
  one pass because it is a `defaultTheme` change). `LineStyle` gained
  `selectedWidth` / `hoverWidth` / `dimmedOpacity` / `spanColor`; `AreaStyle`
  those plus `selectedFillOpacity`, because an area's mark is its fill so its
  channels are fill strength and edge weight rather than weight alone. The
  partition is live during the drag, a line's emphasised segment strokes an
  interpolated slice so its ends take a round cap, and `spanColor` applies only
  when a **single** trace is swept (with two, both would go blue and identity
  would be in question again inside the window).

  **Found while testing the stories, fixed 2026-08-10:** two defects that both
  came from a **pre-existing guard not learning about the new capability**, a
  pattern worth watching for on any wave that widens what a layer can do.
  - **A `<Fragment>` child swallows the injected declaration index**, so the
    elements inside register at `0`, the stable sort leaves the tie in _mount_
    order, and the stack looks correct until mount and declaration order
    disagree. It had reached **four** call sites, three of which
    **demonstrate** ordering — the `LineSweep` story, the reviewer-mandated
    `spans[0]`-is-topmost test, and two perf stories (one a band-behind-line
    stack holding by mount luck) — plus the site-traffic gallery page, which
    taught the pattern in prose. Both injection sites now warn: `<Layers>` and
    **`<ChartRow>`**, where a fragment costs more because the `side` sort can't
    see a `<YAxis>` through it and the axes land in the plot rather than a
    gutter. The second site was a Layer-2 review find — the first pass named
    the bug class and fixed one of its two homes.
  - **The container's "wired but nothing is selectable" guard accused every
    correctly-wired trace chart**, because traces never joined the selectable
    registry, and its remedy named three components the consumer hadn't
    mounted. Both trace layers now register on `id`.

    Worth noting how each was found: the first by a **React console warning**
    the story had been emitting all along, the second by that same console read
    — neither by a test, and neither by two rounds of adversarial review. The
    cheap habit is to read the console on a story you are about to demo.

- **[PND-INTERACTDOCS]** — **The interaction wave's docs pass, and the
  `onSelect` collapse it blocks on.** Owner-listed 2026-08-10.
  **Shipped 2026-08-10.**

  **The `onSelect` collapse** (before the docs pass, after #634 merged): `span`
  and `spans` are one `spans: readonly SpanSelection[]` argument, and **empty
  now carries what `null` used to** — a click, or a sweep that covered nothing.

  Worth keeping, because it corrected a bad call: #634 shipped the plural as a
  _fourth_ argument, reasoning that widening the third would churn 23 call
  sites. That reasoning was wrong — `selectors.tsx` does not exist at
  `v0.57.0`, so `<MultiSelector>` and `<Selector>` had **never been
  published** and every one of those sites was in-repo. A deprecation shim for
  an API nobody has is pure cost. (Contrast `<BarList>/<BoxList> selected`,
  which **is** released — that widening genuinely needed the owner gate. Both
  were framed as compatibility questions without checking the tag.) Shipped as
  #635, and its own fresh-eyes review caught two more things: two duplicate
  JSDoc blocks left after the migration (one documented the removed `span:
null` contract verbatim), and an ordering test that had gone tautological —
  it compared `spans[0]` to a field the test harness _derived_ from `spans[0]`,
  so it could never fail. Both fixed before merge (`866fb06`).

  **The docs pass.** One page rewritten (`selection-and-hover.mdx` was making
  claims the wave had made false — single-select only, `BarChart`/`ScatterChart`
  only), one new page added
  (`interaction/sweeps-and-multi-select.mdx` — the sweep gesture, `SpanSelection`,
  demote-on-edit, the trace-sweep case), and six more updated with the row
  selection story, the trace state channels, and cross-references:
  `interaction/cursors-and-readouts.mdx`, `interaction/legend.mdx`,
  `interaction/pan-zoom-and-range-selection.mdx`, `types/lists.mdx` (plural
  `selected`/`hovered`, `onRowSelect`, the keyboard table, `theme.list`),
  `theming.mdx` (the channel rule stated once at the top, then per-mark; the new
  `line`/`area` state tokens), `learn-charts/06-cursors-readouts-zoom.mdx` (a
  short section distinguishing a `region` time-range drag from a
  `<MultiSelector>` mark-range drag — same gesture, same drag band, different
  question).

  **Checked and left alone, deliberately:** `gallery/volume-history.mdx` uses
  `onRegionSelect` (the cursor's time-range callback) — unrelated to the
  collapsed currency. `how-to-guides/categorical-charts.mdx` and
  `histograms.mdx` use the legacy `<ChartContainer onSelect>` (single hit) —
  also unaffected. `annotation.spanEdge` stays **undocumented on the public
  theming page** — its own doc comment already says "not settled" (canvas-side
  rules vs. an SVG-overlay annotation, a real mismatch), so writing it up as a
  finished feature would be documenting past the point the code has actually
  reached. Revisit when `[PND-ANNSNAP]` resolves it.

  **A Layer-2 review find surfaced two more sites of the same bug class**
  while this pass was in flight (`#636`, `ac2dd85`): `<ChartRow>`'s axis
  injection had no fragment guard either, two perf stories and the
  site-traffic gallery snippet still used the pattern. See `[PND-TRACESEL]`
  below for the write-up; the gallery MDX fix landed as part of this task.

  Docs-build CI does **not** typecheck MDX code blocks — every snippet above
  was checked by hand against the actual exported types, not trusted to CI.

- **[PND-INTERACTOWN]** — **`<Selector>` wraps its scope and owns its state.**
  Owner feedback on reading the docs pages, 2026-08-10. **Shipped 2026-08-10**
  (PR #638). `<ChartContainer selected>` / `hovered` / `onSelect` / `onHover`
  removed outright — no shim, pre-1.0 — and moved onto `<Selector>` /
  `<MultiSelector>`, which also gained `children` (they wrap their scope) and
  `enabled` (default `true`; `false` kills the gesture but keeps the state).
  **This reverses A1.2, accepted two days earlier**, and the reversal's argument
  is that §7.1 already required mounting a selector, so the common chart wired
  one concept in two places. Full write-up: `docs/rfcs/interaction.md`
  Amendment 10.

  **The reviews are the interesting record here**, because the design change was
  the easy part and the React plumbing was not:
  - Moving controlled state onto a child means it reaches the container by
    **registration**, not by prop — so the container's state is now driven by a
    descendant's effect. Two consequences, both found by review rather than by
    tests: a passive effect made it a **commit late** (stale paint on change,
    unselected flash on mount), and a passive _cleanup_ against a layout
    _register_ left a removed selector owning state for one commit and let a
    keyed remount hand out the old value. Both halves are `useLayoutEffect` now,
    and the symmetry is the point.
  - The entry carries the controlled values, so an inline `selected={[hit]}`
    mints a fresh entry every render. Harmless alone — a container-only update
    doesn't re-run the caller's JSX — but a **descendant that consumes the
    container context** (`useChartLegend()`) does, giving registry update →
    context change → re-render → re-register, unbounded. Fixed by value-equality
    in `registerSelector`, the same guard `registerAxis`/`axisSpecEqual` has
    carried for the same reason.
  - Giving a component `children` made it a **wrapper**, and wrappers defeat
    both index-injection sites: inside `<ChartRow>` an axis nested in one is
    invisible to the `child.type === YAxis` sort (renders mid-row), and inside
    `<Layers>` a draw layer nested in one loses its z-order index. Same class as
    the fragment trap `[PND-TRACESEL]` records, with a cause the fragment guard
    structurally cannot see. Both sites warn now.

  **Left open, deliberately:** `enabled` is all-or-nothing and cannot express
  "hover yes, click no" — a real gap named in review, recorded rather than
  patched with a second prop. And the layout-vs-passive cleanup fix is **not
  test-pinned**: the difference is paint timing and jsdom paints nothing, so it
  rests on React's documented phase semantics. Worth knowing if it is ever
  refactored.

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
- **[PND-SELECT]** — Selection Phase 2: multi-select widen + `selectionMode`,
  `LineChart.hitTest`, snap-follows-selection prop, theme-referenced dim.
  Breaking widen → human gate. RFC: [selection.md](docs/rfcs/selection.md).
- **[PND-DECIM]** — Decimator Phase 5 (finish-the-wave): candlestick + box
  decimation (Tidal-anchored), document the `three`-at-1M render floor
  (Path2D doesn't help pan), then the "large time series" how-to + release.
- **[PND-HOVCTX]** — Split cursor position out of the `ContainerFrame` context
  (external bench 2026-07 follow-up, profile-verified): cursor lives in
  `useState` on `ChartContainer` and is a frame field, so every mousemove
  rebuilds the frame and re-renders **all** context consumers (both `YAxis`,
  `Legend`, `Bar`/`Box`) even though only the SVG overlay moved — measured 4
  React commits/event, ~0.68 ms vs uPlot's 0.13 ms. A dedicated `CursorContext`
  ({cursorX,cursorY,cursorRowKey} — the per-move-varying fields; the cursor
  _time_ is derived locally per consumer) leaves the config consumers untouched
  on hover. This is why #524 (which stopped the _canvas_ repaint) left hover
  "still kind of slow".
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
- **[PND-WIDTH]** — **SHIPPED 2026-08-12, closed.** `<ChartContainer
width="auto">`, and an omitted `width` means the same. Three consumers hit
  the explicit-px requirement; the third was multiplying the same ~25-line
  measure-and-gate hook across seven panes. The documented responsive-width
  recipe became the implementation, which also closed the recipe's sharpest
  edge **by construction** — the measured box is one the library owns, so it
  can never be the caller's padded box. Outcome in
  [PND_CHARTS_PLAN.md](docs/plans/PND_CHARTS_PLAN.md#pnd-ignite--ignite-charts-friction-2026-08-11).
- **[PND-LIVELYR]** — Live-source-aware layer inputs (same report, ask #4):
  charts layers take only `TimeSeries`, forcing a fresh per-tick handle
  (`snapshot.partitionBy().toMap()`) per host. A `LiveView`-aware input — or
  a documented cheap-handle idiom for live charts — closes it. Overlaps
  [PND-PARITY] / the live layer.
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
- **[PND-VSDOC]** — Give `creating.mdx` its `ValueSeries` section. PR #564
  restructured the ingest page around JSON / columnar / Arrow and
  deliberately skipped `ValueSeries` because its whole surface was
  `fromColumns` — "two-thirds empty". [PND-VSIO] filled the other
  two-thirds (`fromJSON` / `fromArrow` in, `toJSON` / `toColumns` /
  `toArrow` out), so the section now has content: one subsection per door
  shape, cross-linked to the deep dive.
- **[PND-OBSDOC]** — "Observing pond-ts in production" how-to: the
  documentation-backlog items (pushMany guidance, bench-honesty callout, GC
  snippet, no-NaN guarantee, tie semantics, latency pattern) as one MDX pass.

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

- **[PND-SHIFTFRAME]** — **Shipped.** `rollingDeviationSd` in
  `packages/financial/src/kernels/rolling.ts`; `zScore` rewired onto it.
  Worst relative error against an exact reference over 200k rows:
  `1e15 + ((i%7)−3)` **1.0e+0 → 4.1e-15**, `1e9 + sin` **4.1e+0 → 4.9e-12**,
  benign random walk **3.9e-6 → 4.4e-11**. Three things the plan did not
  anticipate, all worth carrying forward:
  - **Welford needed shifting too.** The first cut shifted only the mean and
    left σ on the raw values, which improved the pathological case by three
    orders of magnitude and stopped there — `d = x − wMean` is the same
    subtraction of two near-equal large numbers. Welford is stable relative
    to the _conditioning_ of the problem, and raw large-magnitude values are
    what make it ill-conditioned. "Variance is translation-invariant so
    Welford is fine" was the wrong reading, and only an exact reference
    caught it.
  - **The fix cost `zScore` its parallelism.** The stable kernel returns a
    deviation, not a mean, so `withWorkers` no longer hooks it: the study
    went from the fastest accelerated one (2.44×) to sequential. Accepted —
    a 2.44× on an answer that could be 100% wrong is not a speedup — but it
    says a numerical class is not a full account of an operator. See
    [`docs/rfcs/numerical-classes.md`](docs/rfcs/numerical-classes.md), where
    this is now the tested case rather than the hypothetical one.

    It also cost a test canary, which is the more general lesson: four tests
    proved the parallel path had run by observing that `zScore` disagreed
    with the sequential answer. That only ever worked because the accelerated
    result was inferior, and it evaporated the moment that was fixed.
    Replaced with `parallelDispatches()`, an explicit count.

  - **A constant rebuild interval was wrong at both ends**, found by a Codex
    pass and fixed in `20639a4`. The kernel rebuilt its incremental state
    every 1024 rows. Too rarely for a short window — at `period 2`, where
    every non-flat window has `|z|` exactly 1, drift through ~500 turnovers
    reached **1.7e-6**, breaking the `<1e-9` claim outright. Too often for a
    long one — the rebuild is `O(period)`, so firing it on a row count made
    the kernel `O(N + N·period/1024)`: **81 ms at `period 100k`** against 7 ms
    at `period 20`, with the "flat in `period`" claim only ever tested to 1024. Rebuilding once per **window turnover** (`period` rows) fixes both
    with one rule, and is _faster_ — the magnitude heuristic it replaced was
    computing a `sqrt` on every row. Now 22.8–26.1 ns/row across `period` 2 to
    100k. The lesson for the next kernel: a threshold in rows is a threshold
    in the wrong unit when the work per row scales with a window.

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

- **[PND-SPLITCOST]** — **Shipped.** `partitionBy`+`toMap` **18.1 → 12.7 ms**
  at 500×1000 (**25.2 → 12.4 ms** interleaved, **33.9 → 22.3 ms** at 1M), and
  `_distinctPartitionKeys` **4.9 → 1.0 ms** (9.2 → 1.2 interleaved). Two
  changes: a **dict-encoded fast path** (a dictionary-backed string column
  already carries an integer per row, so grouping indexes an array instead of
  building and hashing a key string per row — symbols are exactly what dict
  encoding is for) and a **two-pass fill** (count, then fill an exactly sized
  `Int32Array`, replacing a boxed push per row plus a copy per group).
  Benchmark: `packages/core/scripts/perf-partition.mjs`, which also covers the
  interleaved layout so the fast path is not measured only where it flatters.
  Q11 is now 36.5 ms with the split at 30% (was 43%). Remaining, unmeasured:
  the ~7 ms of `withRowSelection` + `TimeSeries` construction per group — a
  contiguous-range slice could avoid the gather where partitions happen to be
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

- **[PND-STUDY]** — Studies Phase-1 breadth: RSI, MACD, ATR(+bands),
  stochastics, %R, Donchian, OBV, VWAP, HV, momentum/ROC — each with the
  TA-Lib + pandas oracle and a fluent method.
- **[PND-SFOLD]** — K6 stateful-fold kernel for Phase-3 studies
  (PSAR/SuperTrend); design when a consumer pulls.
- **[PND-TCAL]** — Trading-time deferred items: point-key slot widths on the
  discontinuous axis, exchange-tz tick grain, cursor timezone control,
  overnight sessions in `fromRules`.

### Live layer

Robustness debt plus the queued composition workstreams. Plan:
[PND_LIVE_PLAN.md](docs/plans/PND_LIVE_PLAN.md).

- **[PND-LIVFIX]** — **The standing live-correctness P1**: listener error
  isolation, re-entrancy, unbounded partitions, chained dispose, and the
  reorder+retention windowed-extrema bug. Confirmed wrong-answer behavior,
  not optimization.
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
- **[PND-KERNEL]** — Kernel algorithm wins surfaced by the Rust/WASM spike
  (`spikes/columnar-wasm/`, report + benchmarks committed). The spike says
  **not now, not in this order** on porting the substrate (revised from an
  earlier "no-go" — see REPORT.md §9: a Rust core is worth 1.3–4.3× on the
  numeric kernel, and 2.2–2.6× end to end on the reduce family, but the
  TypeScript work below is 5–10× larger and comes first). The control
  experiment isolated four wins that are pure algorithm and land in
  TypeScript. Two have shipped:
  - **Quickselect for `reducePercentileColumn`** — measured 12.9× on
    `median`/`p95` at 1M rows.
  - **Blocked (8-accumulator) `sum`/`mean`** — 2.51× dense, 2.22× through a
    validity bitmap, **`close.mean()` 0.47 ms → 0.19 ms** end to end. The
    semantics decision this was blocked on is made and recorded in
    [blocked-summation.md](docs/notes/blocked-summation.md): reassociate
    above a 32-cell threshold, leave shorter runs bit-identical. Worth
    noting the direction — blocked summation is _more_ accurate than
    sequential (error grows as O((n/k)·ε + k·ε) rather than O(n·ε)), so the
    trade was speed **and** precision against reproducibility of the exact
    previous bits, not speed against accuracy.

  Remaining: a branchless finite guard for `allFinite: false` reductions,
  and blocking the guarded sum path (measured **1.84×**, deliberately not
  taken — after [PND-WCNAN] almost nothing lands there; see the note).

  **Correction: the 4-lane `Float64Column.minMax` is _not_ bit-identical**,
  as this entry previously claimed. `+0` and `-0` compare equal, so
  `lo <= x ? lo : x` keeps whichever the traversal reached first, and
  lane-parallel traversal reaches a different one — verified: 16 cells, all
  `1` except `values[1] = +0` and `values[4] = -0`, sequential gives `+0`
  and 4-lane gives `-0` (`===` equal, `Object.is` not — and vitest's `toBe`
  uses `Object.is`). `minMax` explicitly commits to matching
  `[col.min(), col.max()]` (PR #153), so the lane form would break that
  commitment on `±0` input for 1.27–1.50× on an operation already costing
  0.49 ms. Not worth it as scoped; if it is ever wanted, it needs a signed
  zero fixup in the combine, not a straight lane split.

  Acceptance benchmarks already exist in
  `spikes/columnar-wasm/bench/controls.mjs`; each control is checked against
  pond-ts's answer before it is timed.

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

Ordering note: `PROCIDENT` blocks any interactive consumer, `PROCCOL` is a
force multiplier for both `PROCIDENT` and `PROCRANGE`, and `PROCRANGE` is
blocked by `PROCKERN` in `@pond-ts/financial`. The engine landed in
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
  for what was a plan-layer map. **Blocking for any interactive consumer.**
- **[PND-PROCCACHE]** — **Shipped**, and half of it turned out to be already
  built. `bind(…, { budgetBytes })` caps retained node values engine-wide,
  LRU, enforced after each run; `retainedBytes` / `evictions` observe it.
  60 distinct params × 200k rows, one process per configuration:
  **arrayBuffers 104 → 42 MB** (2.5×), retained 93 → 11 MB, 60 nodes → 7,
  with repeats still hitting and no eviction churn. **No rss figure**: the
  replacement 1.2× did not survive re-measurement either — across five
  forked pairs bounded rss exceeded unbounded in two. Freed buffers are not
  promptly returned to the OS and the bound series is the floor, so rss
  cannot support a direction at this scale.

  **Two review findings worth keeping.** Eviction originally deleted the
  node from `#nodes` and stopped there — but `Outlet.#downstream` is a
  strong `Set<Inlet>` with a back-reference, so an evicted node stayed
  reachable from the source and **nothing was freed**; re-asking an evicted
  spec compiled a _second_ node onto the same source, growing memory without
  bound while `ids.length` stayed flat. Every test in the suite passed
  throughout, because they all asserted the graph's own bookkeeping.
  Eviction now disconnects the inlets, and there is a test that counts what
  is actually attached to the source outlet.

  And the first headline number here was **5.6× of pure measurement-order
  artifact**: two configurations timed in one process, the second starting
  from the first's heap. The benchmark now forks a process per
  configuration. Same class of error as a JIT warm-up, one level up — and
  the correction needed a second correction, because the replacement rss
  figure was not reproducible either. The lesson is narrower than "fork the
  process": **rss is the wrong instrument for this question**, since a
  freed buffer need not be returned to the OS. Measure `arrayBuffers`.

  **The half not to rebuild:** the ticket wanted an op to declare which Ins
  key its result. `specId` is already content-addressed over op, params and
  inputs, so the same question hits the same node by construction — a per-op
  key would sit beside a correct one. What was genuinely missing is the
  capacity, and the ticket is right that it cannot be the op's: a per-op cap
  is a per-op promise and nothing supervises the total.

  **The open question is closed: bytes, not entries.** Entries are not the
  unit anyone has a limit in (one node over 1M rows outweighs fifty over
  5,000), and bytes only became knowable once [PND-PROCCOL] made node values
  columns. Eviction skips a node whose consumer still holds its outlet —
  dropping it frees nothing and forces a recompile.

- **[PND-PROCSEL]** — Selective per-Out invalidation already works: a
  bollinger-shaped node changing `stdDev` leaves `middle`'s version untouched
  and its consumer idle, because the op hands back the same instance. Document
  it, and let the registry declare which params each output depends on so the
  corpus gets it by declaration rather than by hand. Sharpens the RFC's "the
  cutoff cannot fire" — true for whole-series identity compares, false per-Out.
- **[PND-PROCCOL]** — **Shipped.** Node _column_ outputs were already packed;
  what stayed boxed was the **fold context**, which densified an
  `Array<number | undefined>` per input per version. `columnView` gives folds
  a zero-copy borrowed view, `FoldContext.numeric(role)` hands it over, and
  `FoldContext.values` became a **lazy getter** so an untouched role costs
  nothing. All four built-in folds migrated. 20 folds × 500k rows: warm run
  **606 → 383 ms**, heap at peak **35 → 25 MB**, rss **204 → 173 MB**.

  **The result is about fold shape, not representation, and the distinction
  is the reusable part.** Columnar is _not_ faster to read — a buffer walk
  reaches parity with a boxed array, and `Column.scan()` is **4.7× slower
  than either** because it takes a callback per cell. The 1.58× is the
  densify disappearing for folds that read a few cells: `last` reads **one**
  and was paying to densify 500,000. A whole-column fold gets the memory win
  and nothing else. Core's design principles recommend `scan` as the
  columnar read path, which is worth revisiting on this evidence.

  Also worth keeping: measuring `heapUsed` _after_ a `gc()` reported ~0 MB
  for both paths and said nothing, because the densified arrays are garbage
  the moment the fold returns. What costs pause time is garbage produced,
  not bytes retained — so the benchmark samples the heap before collecting.

- **[PND-PROCTERM]** — **Shipped**, though the win was not where the ticket
  looked. It framed this as the _terminal_ rebuilding a series so a
  reduction had a column to read — and that part was already handled: a
  facts-only request has an empty `needed` set and assembles nothing. The
  live cost was one layer down, in **every node's `compute`**, which widened
  the source with `appendColumn` per nested input so an op could call the
  corpus normally. A fold needs no series at all; the column it reads is
  already in its inputs.

  What made it expensive is a core gap: `appendColumn` **boxes a gapped
  column**, because core's `withColumn` takes values rather than a column —
  22.4 ms per column at 1M rows, and every rolling study is gapped. The
  costly path was the ordinary one. Exposing `withColumnAppended` would
  remove the fallback for column-producing ops too, which still pay it.

  20 folds × 500k rows: **383 → 129 ms** (2.96×), rss 173 → 113 MB; with
  [PND-PROCCOL] together, **606 → 129 ms**. The old 52×/441× figures were
  measured against a different baseline (whole-series assembly per
  reduction, at 1M rows) and are not comparable to these.

  Reductions read node values directly, and a renderer pulls
  per-study arrays. Sharp edge: the terminal must resolve the closure of every
  id a selector mentions, including `crossings`' `against` — assembling only
  the column-selectors yields a fact with no value rather than an error.

- **[PND-PROCJOIN]** — Make the join a node: n series in, one aligned column
  set out, alignment policy in the id (inner vs as-of changes the answer). This
  is what lets a cross-source spec exist at all — separate graphs cannot hold
  one, and hand-combining misaligned instruments silently pairs different
  dates. Needs no engine change; `Graph` has no per-graph boundary today.
- **[PND-PROCHIST]** — **Shipped.** `requiredHistory(registry, plan)` plus a
  per-op `OpDef.lookback`. On an 8-study stack over 500k rows with a 5,000-row
  display: **97 → 1.3 ms/tick, 75×** (10 → 773 ticks/sec), **zero truncated
  cells** at the derived tail and **exactly one** at a tail one row shorter —
  so the bound is tight rather than merely safe, which is the half of the
  acceptance bar that arithmetic alone would have passed.

  Two design calls worth keeping. Lookbacks **sum along a nested chain**
  (`sma(20)` over `sma(50)` is 69, not 50); a max under-provisions by exactly
  the amount that yields defined, plausible, truncated answers. And an
  undeclared lookback reports `known: false` naming the op instead of
  defaulting to zero — a missing declaration and an element-wise op are the
  same value with opposite meanings.

  **Interaction with [PND-PROCKERN], found by measuring rather than
  predicted:** a sliced tail agrees to ≤5.8e-13, _not_ bit-for-bit. Slicing
  builds a new shorter series, which re-indexes every row, and the rolling
  kernel pins its accumulator rebuilds to absolute row index. So PROCKERN's
  bit-identity covers **a range of the same column** — which is what
  PROCRANGE does — and does not extend to a re-indexed copy. Worth stating
  before PROCRANGE lands, because the two are easy to conflate.

- **[PND-PROCRANGE]** — **Mechanism shipped; the ceiling is not reached.**
  `setSourceFrom(series, changedFrom)` plus an opt-in `OpDef.runRange`.
  500k rows, 5 studies, 20 ticks: **209 → 55 ms/tick (4×)**, bit-identical to
  a from-scratch pass every tick.

  **The purity question resolved better than expected.** Rather than
  `markDirty()` carrying a payload and `compute` reading its own last output
  as state, the previous output is passed **as an argument** — so an op stays
  a pure function of declared inputs and `explain` keeps describing what a
  value depends on. The mutable part lives in the graph, which is a cache and
  was already stateful. No purity was traded.

  **Opt-in, and that is the safety property.** An incremental result must be
  bit-identical to a from-scratch one or answers depend on edit history —
  invisible to any test that only computes from scratch. True for
  [PND-PROCKERN]'s range-exact kernel; **false** for `median`, percentiles,
  `min`, `max`. Declaring nothing means full recomputes: correct, slower.

  **Remaining, and it is the larger half of the projected win:** 4× against a
  projected 26×/~7000×. The gap is in the _op_, not the graph — a `runRange`
  that copies the whole prefix out of `previous` before patching is O(n) per
  tick, which is what the plan meant by "reallocating its output array". This
  needs a **capacity-buffer contract** so an op can extend the previous column
  rather than rebuild it, on top of [PND-PROCCOL]'s packed values.

  **A correction to the plan's range formula.** It said an upstream dirty
  range `[a,b)` becomes `[a-lookback, b)`. For a **trailing** window a change
  at row `r` dirties output cells `[r, r+period)` — _forward_ — and since the
  graph always recomputes to the series end, `[changedFrom, length)` already
  covers it. Removing the backward widening fails no trailing-window test,
  which is how this was found. The widening is kept because it is what makes a
  **non-causal** op correct, and the graph cannot tell the two apart; there is
  now a centered-window test that fails without it.

- **[PND-PROCKERN]** — **Shipped**, and it turned out to be a correctness
  task wearing a performance task's clothes. `rollingMeanSdInto` in
  `packages/financial/src/kernels/ranged.ts` fills any `[lo, hi)` with the
  exact bits a full pass writes — a 100-row fill is **3964× cheaper** than
  recomputing the column and **bit-identical**, which is the ceiling
  [PND-PROCRANGE] can now aim at.

  **The finding that reorders PROCRANGE:** a ranged recompute on the old
  sweep differed on _every cell_ of the range (~1e-10 relative), because an
  accumulator carries rounding history from row 0. PROCRANGE's recorded "26×
  with identical results" was therefore not achievable as specified — the
  value would have depended on which ranges happened to be dirty, i.e. on
  edit history rather than data. Two callers with the same data would
  disagree. Fixed by rebuilding the accumulators every `period` rows and
  pinning the rebuilds to **absolute** row index, so a ranged sweep
  reconstructs the state a full sweep held; read-back is ≤ `2·period`.

  Three things came free, and one nearly went wrong:
  - **`withWorkers` is now bit-identical** to sequential for every study, at
    any magnitude. The whole per-study accuracy table collapses — chunk
    boundaries stopped existing rather than being characterised better.
  - **Everything got faster**: `bollinger(20)` **46.5 → 18.4 ms** (avg and σ
    fuse into one sweep instead of core running two reducers), `envelope`
    13.1 → 10.6, `sma` 6.7 → 6.2, the 5-study stack 58.3 → 49.9.
  - **Accuracy improved at every magnitude**, 3.6e-3 → 4.4e-16 at 1e15 —
    which retires the `bollinger` instability logged as debt below.
  - **The near-miss:** aligning the rebuilds _without_ also shifting the
    frame made large-magnitude σ **worse** (3.6e-3 → 1.7e-2), because
    rebuilding more often only re-does ill-conditioned arithmetic more
    often. Caught by measuring rather than reasoning. The two are one
    change, not two.

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
- **[PND-PROCPAR]** — Worker-thread parallelism. Two shapes; the **throughput**
  half has shipped and the **latency** half has not.

  **Shipped: `HostPool` (`@pond-ts/process/pool`)** — whole requests routed
  across workers, each holding a long-lived `Host`. No engine change: a plan
  is JSON, a registry is a module both isolates import, and a result's columns
  travel as transferable buffers. Measured
  (`packages/process/scripts/perf-pool.mjs`): **3.1–4.0× on distinct requests**
  at every size from 0.5 to 10 ms each — but **~0.01× on repeated ones**, where
  the in-process memo returns the same column for nothing and a pool ships
  every answer regardless. **Cache-hit rate decides it, not request size**; an
  earlier "crossover below 2 ms" reading was a warm-up artifact (one warm-up
  request per worker against a JIT-warm baseline — the same V8 tier cliff
  `blocked-summation.md` documents). Also measured: the same op writing a
  `Float64Array` rather than `new Array(n)` beats eight workers on the boxed
  version from a single thread, so op shape matters more than worker count.

  **Also open: parallel-scan kernels ([PND-SCANKERN], new).** The note's
  "sequential recurrences cannot be helped" was wrong. `y[i] = a·y[i-1] + b[i]`
  is the textbook parallel-scan case; measured (`spikes/parallel-scan/`) EMA
  over 2M rows goes **4.45 → 1.42 ms (3.14×)** with **99.91% of cells
  bit-identical** — a decaying recurrence's correction term underflows to zero
  a few hundred cells into each chunk, so most cells are literally the same
  arithmetic. Two barriers, no log-depth tree. Needs **no process-engine
  change** (raw workers over a `SharedArrayBuffer`), so it belongs to the
  kernels and is not blocked behind the injection seam. Costs: ~72 µs per
  barrier, so it needs work above ~150 µs and will not pay below ~100k rows;
  and SAB-backed (or copied) inputs. The prize is not `ema` — already 2.08 ms
  — but that the same reasoning reaches the operations that _are_ slow, and
  that "inherently sequential" is a far weaker claim than it looks.

  **Rolling windows partition — SHIPPED as [PND-SCANKERN].**
  `withWorkers` in `@pond-ts/financial/parallel` (Node-only, opt-in at ingest;
  studies stay synchronous via `Atomics.wait`, which is also why it is absent
  in browsers). One accelerator hook on `rollingColumns` serves `sma`,
  `envelope`, `bollinger` and `zScore`. Measured over 500k bars, 8 workers:
  1.83× / 1.32× / 1.86× / 2.45×, three-study stack 1.98×. Answers shift
  slightly — 3.9e-14 to 5.1e-13 for everything except **`zScore` at 2.6e-6
  across ~0.8% of cells**, which divides by a near-zero rolling σ; documented
  as the reason the opt-in is a choice rather than a default. Below 100k rows a
  registered series still runs sequentially, bit-identical. The bare kernel
  partitions 13.8× (`spikes/parallel-rolling/`); the gap to the shipped numbers
  is the arena copies and each study's own pointwise arithmetic, both of which
  stay on the main thread so that one hook can serve every study without a
  second copy of any study's logic. Remaining in this family: `ema` /
  `cumulative` via parallel scan (`spikes/parallel-scan/`, 3.14× measured,
  99.91% bit-identical), not yet wired to a study.

  **Remaining: the latency half** — split one composite query's nodes across
  workers (spike measured 2.42× on the 5-study stack, bit-identical). Blocked
  on an engine change the spike did not surface: a node's value can only be
  produced by its own `compute`, which is contractually pure, so a result
  computed in another isolate **has nowhere to land**. That injection seam, plus
  a ready-set scheduler over the compiled DAG and the financial studies as
  registry ops over shared rolling primitives (mean/std dedup → estimated ~15 ms
  critical path, polars-mt territory), is the rest of this ticket. Full
  assessment:
  [worker-threads-assessment-2026-07.md](docs/notes/worker-threads-assessment-2026-07.md).

### Process demo — composer / request / results

A three-panel web app where a prompt becomes a process plan, the plan resolves
against a bound dataset, and the result is charted — clicking a node in the
pipeline shows that node's output. It is a demo, but its primary job is to
**decide the library's shape**: six open tickets in the process section rest on
questions no argument settles, and each milestone here answers one. Plan:
[PND_PROCESS_DEMO_PLAN.md](docs/plans/PND_PROCESS_DEMO_PLAN.md).

Pinned before any code: the bound graph is **long-lived, wherever it lives** —
per-request construction is what is fatal, not any particular host. A long-lived
worker and a long-lived server prove different things (client-side execution and
an off-main-thread UI, versus the MCP shape with one cache shared across
sessions). The worker topology is **coupled to [PND-PROCCOL]**: crossing a
thread boundary costs 48.6 ms per 500k-value answer boxed versus 0.5 ms
transferred, so without columns a worker spends more time marshalling than
computing. `as` names an output rather than windowing it; `registry.toJsonSchema()`
is the agent's contract, not a hand-written prompt.

- **[PND-DEMOM0]** — The plan layer, headless: `bind`, registry, `specId`,
  `run`, `explain`, typed and tested. Decides [PND-PROCSUB] (does anything
  outside the plan layer still import the engine?) and [PND-PROCIDENT] (`run()`
  cannot be written without choosing how a param is identified).
- **[PND-DEMOM1]** — A long-lived host (worker or server) holding
  `Map<datasetId, BoundGraph>`, one seeded dataset, submit-and-return, still
  no UI. Response carries **per-node
  computed-vs-cached and a duration** — the architecture is invisible without
  it. Decides [PND-PROCTERM].
- **[PND-DEMOM2]** — Three panels, `raw` tabs only; agent composes plans from
  the registry schema. Decides [PND-PROCSCHEMA]: is the projection enough to
  compose valid plans unaided, and can the agent self-correct from `skipped`
  reasons? Landed as `apps/process-demo`, outside the root `workspaces` so a
  demo build never gates a release. The composer sits behind a seam: without
  `ANTHROPIC_API_KEY` it falls back to an offline keyword matcher that exercises
  every panel and **settles nothing about the registry**, and says so.
- **[PND-DEMOM3]** — Results charts via `@pond-ts/charts`, chosen by key kind
  (time → line, multi-output → band). Decided the remainder of [PND-PROCCOL],
  and **not as the fork it was framed as**: charts already traverses columnar,
  so the layers' `series` + `column` signature was fine — what was wrong was
  assembling on the producer side, where a `TimeSeries` cannot cross a wire.
  Landed `run({ assemble: false })` + `RunResult.columns`; the browser rebuilds
  with `TimeSeries.fromColumns`, which adopts buffers zero-copy. Drawing costs
  **transport, not compute** (5.72 MB for two studies at 150k rows vs 5 ms to
  encode) — a second argument for the worker topology. [PND-LIVELYR] did not
  bite.
- **[PND-DEMOM4]** — Pipeline graph with clickable nodes (React Flow + dagre),
  labelled by `explain` and badged cached/Nms; clicking shows that node's
  output. **Landed, and the "costs almost nothing" claim held** — clicking a
  node is one more `columns: true` selector on an id the response already
  names, including a _nested_ spec that never appears at the plan's top level.
  Two additions, both the response failing to describe its own graph:
  `NodeTiming.inputs` (the edges — underivable without reimplementing
  `specId`) and `NodeTiming.pulled` (`nodes` had reported only the subset a
  selector reached, so the view drew a plan with branches missing).

- **[PND-DEMOM5]** — Conversational refinement: follow-up prompts that adjust an
  existing plan. **Landed, and it decided [PND-PROCIDENT].** "smoother" → "try
  200 instead" → "back to how it was" returns in **2.811 ms against 75.071 ms
  cold**, the node a straight cache hit at 0.004 ms — because a
  content-addressed `sma(50)` is never invalidated by a detour, only unused.
  Three nodes resident afterwards is the bill, and the case for
  [PND-PROCCACHE]'s engine-wide budget. The capacity dial is deliberately not
  here: there is no node cache to tune yet, and rushing one to make a demo
  slider work would let the demo design the library.

### Ecosystem (Phase 6)

Adapters and deployment-shape packages, after the streaming milestones they
depend on. Plan:
[PND_ECOSYSTEM_PLAN.md](docs/plans/PND_ECOSYSTEM_PLAN.md).

- **[PND-SERVER]** — `@pond-ts/server` extraction from the gRPC experiment's
  aggregator shape (WS-snapshot-then-deltas, coalesce strategy, slow-client
  policy). Depends on [PND-FINAL] + [PND-KEYED].
- **[PND-NODE]** — Node stream adapters + third-party chart bridge helpers
  (`toRecharts`, `toObservablePlot`).
- **[PND-FITPUB]** — `@pond-ts/fit` first-publish pass: deliberate export
  list, units-preference home, then publish and hand estela the swap.

---

## Active experiments

Canonical roster (philosophy in CLAUDE.md; detail + queued coordination in
[PND_EXPERIMENTS_PLAN.md](docs/plans/PND_EXPERIMENTS_PLAN.md); full histories
in [docs/archive/experiments-2026.md](docs/archive/experiments-2026.md)):

| Track              | Agent  | Status / next                                                                     |
| ------------------ | ------ | --------------------------------------------------------------------------------- |
| Tidal (financial)  | Claude | Most active loop; drives [PND-STUDY] + charts friction; auto-woken on npm publish |
| estela (geo/power) | Claude | Waiting on [PND-FITPUB]; then adopts fit + charts from npm, deletes local copy    |
| Dashboard          | Claude | Next: adopt `@pond-ts/charts`, report gaps/perf vs its hand-rolled charts         |
| gRPC pipeline      | Claude | M3.5 realized; remaining: writeup + M5 extraction sweep (3 RFCs → [PND-SERVER])   |
| Webapp telemetry   | Codex  | In production; watch for friction reports                                         |
| Charts experiment  | Claude | First `@pond-ts/charts` package consumer; annotation dogfood, ongoing             |
| Robustness audits  | fresh  | Re-run as the available model improves; residue → [PND-LIVFIX], [PND-AUDIT]       |

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

- **[PND-HEATMAP]** — A **heat map draw layer** for `@pond-ts/charts`. Raised by
  pjm off the Gallery's climate-stripes card: the bar-based version says the
  right thing but wants to be a grid of cells, with a **day / month / year
  granularity toggle** re-binning the same series. The shape is a
  two-dimensional bin — time along x, a second dimension down y (calendar
  position, category, or value bucket), colour encoding the aggregate — and it
  is the one common time-series display pond has no primitive for. It composes
  with work already shipped: `Sequence.calendar` supplies the honest
  day/week/month binning, `partitionBy` + `aggregate` produce the cells, and the
  sequential ramp is the colour channel. The design questions are whether the y
  dimension is a category axis or a derived calendar coordinate, how a cell
  reports to the cursor, and whether the granularity toggle is a prop or a
  re-binned series the caller passes. Write-up in
  [PND_CHARTS_PLAN.md](docs/plans/PND_CHARTS_PLAN.md).

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
  real against it — all three workarounds deleted, with two verification gaps
  recorded honestly (the symlog **tick ladder** and the pan/zoom knee are
  unexercised, because their chart hides its y axis and does not zoom).
  [PND-BINSWATCH] is now partially resolved on the stack path only. Itemised, with
  each workaround and its cost, in
  [PND_CHARTS_PLAN.md](docs/plans/PND_CHARTS_PLAN.md#pnd-sparcfric--sparc-charts-friction-2026-08).

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
