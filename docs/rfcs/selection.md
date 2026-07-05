# RFC: Selection model — click-select any series, and snap-follows-selection

> _Drafted by the pond-ts library agent (Claude) from pjm17971's spec and
> Tidal's need, 2026-07-05. A design + API proposal for red-team (Tidal is the
> driving consumer). **Not a commitment** (see CLAUDE.md → Strategic RFCs) — the
> phases adopted into PLAN.md become the contract, the rest is forward-looking
> context. Grounded in the shipped selection surface (`selected`/`onSelect`,
> #343) and verified against the current `select.ts` / `Layers.tsx` behaviour._

## 1. The question, and the bar

`@pond-ts/charts` grew a **selection surface** in the estela/charts waves:
`ChartContainer` carries a single controlled `selected?: SelectInfo | null` +
`onSelect`, plus the transient `hovered`/`onHover` pair (#343). Today only
**discrete-mark** layers participate — `BarChart` and `ScatterChart` implement
`hitTest` (pixel containment against a bar rect / a disc); `LineChart`,
`BandChart`, `AreaChart`, and `BoxPlot` are **not selectable** at all
(`select.ts:resolveSelection` walks layers top-down and calls the optional
`hitTest?`, which those layers don't implement).

Tidal's terminal wants the user to select a series **two ways, driving one
selection**: by clicking its **chip** (a legend/list control, external to the
chart) _or_ by **clicking the series directly on the chart** — and once a series
is selected, the cursor should **follow it**. That's the gap: a line has no
discrete mark to click, and cursor-snap and selection are, today, completely
independent subsystems.

The bar pjm17971 set: **one selection model, container-level, single** — no new
selection vocabulary, no per-layer selection state, no multi-select. The chip
path and the click path resolve to the _same_ `selected`. The novelty is
narrow and behavioural: make continuous series **clickable**, and make **snap
respect a selection when one exists**.

## 2. What exists today (verified)

- **Single, container-level selection.** `ContainerFrame.selected: SelectInfo |
null` — one mark across all rows (`context.ts`). `SelectInfo = { key, value,
color, label }`, keyed by the mark's `begin` ms; `label` is already `as ??
column` (`context.ts:397`).
- **Controlled + uncontrolled.** `selected` prop (controlled) or internal state;
  `onSelect(hit | null)` fires on every resolved click. The **chip path already
  works** — a chip click sets the controlled `selected` prop; nothing new needed
  there.
- **Deselect-on-empty-click already works.** A click that hit-tests to no mark
  calls `select(null)` (`Layers.tsx:474` — guarded by `DRAG_SLOP` so it doesn't
  fire at the end of a pan/drag).
- **Selectable layers = Bar + Scatter only.** `hitTest` is discrete-mark pixel
  containment; there is **no "closest point on a series within a threshold"**
  hit-test anywhere.
- **Snap and selection are independent.** The crosshair x-snap walks layers and
  snaps to the _first_ layer's nearest `sampleAt` (`Layers.tsx:377`), using the
  raw pointer; selection hit-tests with the raw pointer too, but the two never
  reference each other. `crosshairSnap` governs only the y reticle.

So two of pjm17971's four points are **already satisfied** (single
container-level selection; empty-click deselect). The RFC is really about the
other two.

## 3. Proposal

### 3.1 Series hit-testing — closest point within a threshold

Add an opt-in `hitTest` to the continuous layers (`LineChart` first; then
`BandChart`/`AreaChart`/`Candlestick`) that reuses the **same nearest-point
logic the crosshair already uses** (`sampleAt` + `series.nearest`), gated by a
**pixel distance threshold**: a click selects the series' nearest sample iff the
pointer is within `selectThresholdPx` of the drawn mark (Euclidean in screen
space, so a click "on the line" hits and a click in open space misses and
deselects).

- **Resolution stays topmost-wins** — `resolveSelection` already walks layers in
  reverse z-order and returns the first hit; a threshold hit-test slots in
  unchanged. When two series are both within threshold, the **top** one wins (z
  = declaration order, matching the RTC convention pjm17971 set —
  [[user-authored-pondjs-rtc]]).
- **`SelectInfo` is unchanged** — the selected sample yields `{ key, value,
color, label = as ?? column }`, identical to what a bar click produces. The
  chip path and the click path are now genuinely interchangeable.
- **Threshold** — a container-level `selectThresholdPx` (default ~8–10 px,
  matching a comfortable click target). Open question 6.1 covers whether it's
  worth exposing.

### 3.2 Snap-follows-selection

Introduce the **one new coupling**: when `selected != null`, the crosshair
x-snap and the y reticle restrict to the **selected series' layer** instead of
"first layer wins."

- **No selection (default):** today's behaviour — snap to the first/nearest
  layer, y-pill picks nearest sample. Unchanged.
- **Selection active:** the vertical snaps to the selected series' nearest
  sample x; the y reticle reads the selected series' value; other layers still
  draw but the cursor "belongs to" the selected series. This is what makes
  clicking a line _and then scrubbing_ read that line, which is the Tidal
  interaction.

This is a clean, documentable rule (`snap target = selected layer ?? nearest
layer`) and is the main thing to red-team, because it changes default cursor
behaviour the moment something is selected.

### 3.3 The chip path (no code)

A chip is just an external control that sets the controlled `selected` prop —
already supported. The RFC only needs to guarantee that a chip-driven selection
and a click-driven selection are the **same `SelectInfo` identity** (they are:
both key on `begin` + `label = as ?? column`), so §3.2's snap-follows-selection
works regardless of _how_ the selection was made.

## 4. Consistency / what this is NOT

- **Not multi-select.** One `selected` at the container. If Tidal later needs
  multi, that's a separate RFC — don't speculatively widen `SelectInfo` to a set.
- **No new vocabulary.** Reuses `selected`/`onSelect`/`SelectInfo` and the
  existing `resolveSelection` walk. The only additions are per-layer `hitTest`
  implementations and one branch in the snap loop.
- **Annotations selection stays its own channel.** `onSelectAnnotation` is a
  distinct overlay concern (turquoise register, [[charts-annotations-design]]);
  this RFC is data-series selection. Reconciling the two is open question 6.4.

## 5. Scope / phasing

- **Phase 1 — clickable series.** `LineChart.hitTest` (threshold nearest-point);
  wire into the existing `resolveSelection`. Lands series click-select with zero
  change to the snap subsystem. Immediately useful (chips already work; this adds
  direct click).
- **Phase 2 — snap-follows-selection.** The §3.2 coupling. Behavioural; wants the
  e2e real-pointer harness (the one the annotation panZoom work established).
- **Phase 3 (maybe) — focus/dim.** Deemphasize non-selected series (a Tidal
  "focus mode"). Out of scope unless Tidal pulls; noted so it isn't designed into
  a corner.

## 6. Open questions for red-team

1. **Threshold: fixed or configurable?** Default `selectThresholdPx ≈ 8`. Expose
   per-container, or keep internal until a consumer needs it (YAGNI lean)?
2. **Overlap tie-break.** Topmost-z wins (proposed) vs geometrically-nearest
   wins. Topmost matches selection today; nearest matches "what the eye clicked."
   Which surprises less?
3. **Band/area click target.** A `BandChart` is an area — does a click anywhere
   inside the band select it, or only near an edge? (Lines are unambiguous; areas
   aren't.)
4. **Annotation vs series selection.** Keep two channels (`onSelect` vs
   `onSelectAnnotation`) or unify? Two channels is honest (different registers)
   but a consumer wiring "what's selected?" has to watch both.
5. **Keyboard/Escape deselect.** Empty-click deselects; should `Escape` too?
   (Canvas focus semantics — probably a consumer concern, flag only.)
6. **Snap-follows-selection default.** Is restricting the cursor to the selected
   series the right default, or should it be opt-in (`snapFollowsSelection`)? The
   Tidal interaction wants it on; a multi-series dashboard might want the cursor
   to keep reading all series even with one selected.
