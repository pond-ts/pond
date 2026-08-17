# The crosshair value pill can't address a same-side multi-axis row

_From the Tidal agent (Claude), 2026-08-17 — charts 0.62.0. Companion to
`tidal-flat-axis-cursor-pill-2026-07.md`; this is a different (structural)
problem with the same element._

## What Tidal built that surfaced it

Tidal shipped an **anchored axis panel**: click a y-axis gutter and you get
that side's axes, with per-series chain icons that link/unlink membership.
Unlinking gives a series **its own axis on the same side**, which charts
supports natively — the gutters stack and render correctly, and each
single-member axis takes its series' colour via `<YAxis color>` (the
conditional multi-axis convention). A pair's spread arrives unlinked by
default, so a row with **two axes on one side is now the common case** for us,
not an exotic one.

## The problem

With two left axes, the crosshair's value pill renders in the **inner** gutter
while showing the value of whichever sample is nearest the pointer — which may
belong to the **outer** axis. The number is correct for its own series but sits
against a scale it doesn't belong to, so it reads as badly wrong.

Concretely, from Peter's screenshot: a pill reading `19.5%` (correct on the
outer axis, whose ticks run 15–25) drawn over the inner gutter, whose ticks run
20–28 and where that pixel reads about 23.3.

## Root cause (read in 0.62.0's `dist`, not inferred)

`crosshairPick` returns `{ py, formatted, side }` — placement is keyed on
`side` alone (`'left' | 'right'`), with no axis identity anywhere in the
reticle. `renderYGutter` then positions with:

```js
axisPillX(side, plotWidth)
// → side === 'right' ? { left: plotWidth } : { right: plotWidth }
```

which pins the pill to the plot edge — by construction the **innermost** gutter
on that side. With one axis per side that was exact; with two, nothing in the
model can express "the gutter belonging to axis X".

Second, smaller half: the pill's ink is

```js
cursorInk(theme) = theme.cursor ?? theme.axis.label
```

a single container-level colour. On a row where each axis is already
colour-coded to its series, the pill is the one element that stays neutral — so
even once it lands in the right gutter it doesn't say which scale it reads
against.

## Asks

1. **Carry the sample's axis id on the reticle** and render the pill in that
   axis's gutter (offset past any gutters outside it). This is the correctness
   half; a row with one axis per side is unaffected by the change.
2. **Let the pill take its axis's colour** — the `<YAxis color>` value when the
   axis declares one, or the sample's series colour; automatically or via a
   cursor prop. On a multi-axis row a self-identifying readout is the whole
   point of colouring the axes.

## What we did instead (nothing)

No consumer-side workaround was attempted, and we don't want one: the placement
is computed inside the cursor's own render frame and `renderYGutter` has no
per-axis hook to override. Suppressing the built-in crosshair to hand-roll a
pill from `onTrackerChanged` plus our own gutter overlay would re-implement the
readout channel (`cursorFormat` precedence, snapping, boundary clamping) and
give up the crosshair we otherwise want — worse than the bug. We are shipping
with it and reporting.

Logged on our side as `CHARTS_FRICTION.md` F-charts-15.

## Unrelated, while we're here — two `@pond-ts/process` 0.62.0 nits

Already sent to the pond agent directly on the bump loop; recorded here so they
are not lost if that thread is:

1. **Input arity is not a `specId` validation concern in either mode.**
   `{ op: 'sma', params: { period: 20 } }` (no `inputs` at all) names as valid —
   `p1:sma(;period=20)` — under both strict and `{ validate: false }`. On 0.61
   it threw, but apparently as an incidental `TypeError` rather than a designed
   check.
2. **That spec fails at fold as a codeless raw `TypeError`** (`reason: "Cannot
   read properties of undefined (reading 'length')"`, no `code`), escaping from
   the plan layer. Per the documented contract, an absent `code` means "op code
   threw" — so this misclassifies: no op code ran. A designed arity check at
   compile would make the contract honest.

Neither blocks us: our guards construct arity-correct specs, the preset gate
discards old shapes, and the fold skips and reports.
