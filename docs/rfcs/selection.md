# RFC: Selection model — click-select any series, and snap-follows-selection

> _Drafted by the pond-ts library agent (Claude) from pjm17971's spec and
> Tidal's need, 2026-07-05. A design + API proposal for red-team (Tidal is the
> driving consumer). **Not a commitment** (see CLAUDE.md → Strategic RFCs) — the
> phases adopted into PLAN.md become the contract, the rest is forward-looking
> context. Grounded in the shipped selection surface (`selected`/`onSelect`,
> #252) and verified against the current `select.ts` / `Layers.tsx` behaviour._
>
> **Revision note (2026-07-05, same day).** The v1 draft below asserted **single**
> selection ("Not multi-select", §4). pjm17971 overturned that within the hour:
> Tidal's **compare mode** selects a _group_ (a primary series + its compare
> series) from one gesture and dims the rest — selection must be a **set**, with a
> **mode**. See **Amendment 1**; §4's single-select bullet is superseded there.

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

- **~~Not multi-select.~~ Superseded by Amendment 1.** _(v1 said: one `selected`
  at the container; if Tidal later needs multi, a separate RFC. "Later" was ~1
  hour — Tidal's compare mode needs multi now, so the model is a set + a mode.
  Kept visible per the RFC convention; see Amendment 1.)_
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

## Amendment 1 (2026-07-05) — multi-selection + a selection mode (Tidal compare)

> _pjm17971, ~1 hour after the v1 draft. Retracts the single-selection framing
> (§4) and the "widen to a set" caution — the driving use case needs a set now._

**The forcing case.** Tidal has a **compare mode**. With compare on, selecting a
series **chip** selects _two_ series at once — the **primary** (drawn solid) and
its **compare** series (drawn dashed) — and **dims every other series**. So a
single user gesture yields a multi-member selection, and non-selected series must
visibly recede. Single `SelectInfo | null` can't express either half.

### A1.1 The model — a set + a mode

Selection becomes an **ordered set** of `SelectInfo`, driven by a **mode** that
governs what a direct select does:

- **`replace`** (default — the v1 single-select feel): selecting a series clears
  the set and selects just it.
- **`add`** (accumulate / toggle): selecting a series **adds** it; selecting an
  **already-selected** series **removes** it (toggle off).
- **Empty-area click clears the whole set** — in both modes (generalizes the
  existing deselect-on-empty).

`selectionMode: 'replace' | 'add'` is a **container prop**, defaulting to
`'replace'` so a chart with no mode set behaves exactly as v1 described. Tidal
flips it to `'add'` while compare is on. (A consumer that prefers the OS idiom can
wire a modifier — ⌘/Ctrl-click ⇒ add — by toggling the prop; the library doesn't
hard-code a modifier. See open question A1.6.)

### A1.2 Where the compare _pairing_ lives — consumer, not library

The library's primitive is deliberately just **{ set, mode, dim }**. It does
**not** learn about "compare pairs" or a "primary vs compare" distinction:

- **Grouped select (chip → 2 series)** is the **consumer** driving the controlled
  set. Tidal's chip handler sets `selected` to `[primary, compare]` in one update;
  the library stores and renders it. The library's `replace`/`add`/`toggle`
  semantics apply to **direct chart clicks** (one series at a time); grouped
  selection is expressed through the controlled prop, so the two never fight.
- **Primary-vs-compare styling (solid vs dashed)** is **consumer styling** of an
  **ordered** set (insertion order; the primary is simply first). The library
  holds order, not a "primary" flag — nothing in snap or hit-test needs one.

This keeps the library general (any consumer gets multi-select + dim) while Tidal
composes "compare" on top without the library growing a domain concept.

### A1.3 Focus / dim — promoted from Phase 3 to core

v1 parked focus/dim as a maybe. Compare **requires** it, and because the library
owns the canvas, dim must be a **library** capability, not consumer restyling:
when the selection set is **non-empty**, non-selected selectable layers render at
a theme **`focus.dimOpacity`** (selected layers draw normally). Dim keys off the
set being non-empty regardless of _how_ it was set (chip or click). Open
questions: does dim apply to _all_ non-selected layers or only same-axis /
selectable ones (A1.6)?

### A1.4 API migration

- **`selected?: SelectInfo | null` → `selected?: readonly SelectInfo[]`** (empty
  array = none; insertion-ordered). This **widens the shipped `selected` prop**
  (#252) — a **breaking public change**, so it takes the human-approval gate when
  implemented. Because the prop is one day old and only estela's bar layer reads
  it, I lean **widen it now** rather than add a parallel `selection` prop and
  carry two; a one-release `selected: SelectInfo` → `[it]` shim covers stragglers.
- **`onSelect?: (selection: readonly SelectInfo[]) => void`** — reports the
  **resulting set** (the library has already applied the mode + toggle for a chart
  click), so a controlled consumer just stores it. (No need to also emit the raw
  delta; the consumer diffs if it cares.)
- **`selectionMode?: 'replace' | 'add'`** (default `'replace'`).
- **`hovered` stays singular** — hover is inherently one mark under the pointer;
  only committed selection is a set.

> **Correction note — blast radius (pond-ts library agent, 2026-07-05).** Two
> facts in the first bullet above are off, and both cut _against_ "just widen it,
> it's too new to matter":
>
> - **Citation.** `selected`/`onSelect` shipped in **#252** (shared interaction
>   groundwork, chart-type wave), not #343 — #343 added the transient
>   `hovered`/`onHover` _hover_ analog (`F-charts-bar-interaction`; see PLAN's own
>   record). Fixed inline above and in the header.
> - **Age / readership.** The prop is **not one day old**: #252 landed ~2 weeks
>   ago and has been **public on npm since v0.31.x** (~1 week). And it isn't read
>   by "only estela's bar layer" — **Tidal reads the selection surface too** (its
>   compare mode is the very forcing case for this amendment). So the widen is a
>   real breaking change to a published, multi-consumer prop.
>
> This doesn't sink "widen in place" (still likely correct — the surface is young
> and the shim is cheap), but the human-approval gate (A1.6 Q10) must weigh the
> **actual** blast radius, and the one-release `SelectInfo → [it]` shim reads as
> **required**, not optional.

### A1.5 Snap-follows-selection, generalized

§3.2 generalizes cleanly: `snap target = the selected set (if non-empty) else the
nearest layer`. The vertical snaps to the nearest sample **among selected
series**, and the cursor shows a value pill **per selected series** (the same
multi-pill fan `sampleAt` already supports). No "primary" needed — nearest-among-
selected is unambiguous.

### A1.6 New open questions

7. **Mode surface.** Prop (`selectionMode`, proposed) vs a built-in modifier-key
   (⌘/Ctrl-click ⇒ add) vs both. Tidal's is app-state (the compare toggle), which
   argues prop; the modifier is a consumer wiring on top.
8. **Dim scope.** Dim _all_ non-selected layers, or only selectable / same-axis
   ones? (An axis-label or a context band probably shouldn't dim.) And is
   `focus.dimOpacity` one global value or per-role?
9. **Primary as a library concept?** Proposed **no** — ordered set, consumer
   styles first-as-primary. Revisit only if snap or a future feature needs the
   library to distinguish primary from compare.
10. **`selected` migration.** Widen in place (breaking, proposed) vs a new
    `selection: SelectInfo[]` prop with `selected` deprecated. The human-approval
    gate on the public-type change decides.
