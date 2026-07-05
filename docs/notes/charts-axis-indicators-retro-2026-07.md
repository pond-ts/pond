# Charts axis-indicator + free-crosshair wave — retrospective

_Written 2026-07-03, after v0.38.0 + v0.39.0 shipped. First-person notes from
the pond-ts library agent (Claude) on the `@pond-ts/charts` wave that added
axis price-tags, a free-form crosshair, and the annotation-indicator polish
that Tidal ("table stakes for the financial crowd") drove._

This is the _why_, not the _what_ — the changelog and the `charts-wave-status`
memory carry the what. This file is for the design instincts that earned their
keep, the dead ends we walked back, and the process scars worth not
re-earning.

---

## The one load-bearing idea: an indicator shows the axis value, nothing else

This is the design law of the whole wave, and it took **three separate
corrections from pjm17971 to land in my head**, so it goes first and in bold:

> **An indicator only ever shows the value on the axis. Never a custom label.**

I kept reaching for the wrong shape. #323 shipped "the annotation indicator
pill echoes a custom label" — I thought an indicator was "a pill, and you can
put text in it." Wrong. An indicator is _the axis coordinate rendered as a
pill_. Its entire job is to answer "where on the axis is this thing." The
custom label already has a home: the in-plot chip (the flag). An indicator that
showed a label would be a second, redundant chip fighting the first.

So this wave **reverted #323's echo** — Marker and Baseline indicators now
always render the formatted value, and the custom label stays on the flag. Two
registers, cleanly separated:

- **In-plot chip / flag** — the human label ("Alert", "Lap 3", "225 W target").
- **Axis pill / indicator** — the coordinate (`14:32:05`, `225`, `1,204m`).

Corollaries that all fall out of the same law, each of which I _also_ had to be
told:

- **`Labelled` and `InsidePlacement` don't exist on `YAxisIndicator`.** I'd
  added a `label` prop and a `placement:'inside'` option. Both deleted. There
  is no label to place; the value goes on the axis. What survived is
  `pointer?:boolean` — an optional `◂` that points from the pill toward the
  plot. That's the _only_ decoration an indicator earns.
- **Pills line up with their tick-label neighbours.** An axis pill sits at the
  same offset as a bare tick label (`pillOffset === labelOffset` in
  `XAxis.tsx`). It should read as "a tick that happens to be highlighted," not
  as a floating annotation. The misalignment was **worst on the x-axis** — the
  x tick labels are horizontal and dense, so a pill even 4px off screamed.

If a future session is tempted to let an indicator carry text: don't. That's
the flag's job. This has been re-litigated enough.

## The flag's time never has a chip background

Adjacent law, same taste. A cursor **flag** has a filled chip for its _value_,
but the **time** portion of a flag is bare text on a transparent ground —
"time on a flag never has a chip background" (pjm17971, with a screenshot). And
the flag chip itself is **square — no rounded corners** (`flagChipStyle`
`borderRadius: '0'`). Rounded corners are for the axis pills (`3px`); the flag
reads as a tag pinned to a staff, not a pill.

The distinction I internalised: **axis pills are pills** (solid fill, contrast
text, rounded, they belong to the axis). **Flags are tags** (square, they
belong to the plot and fly from a staff). Two vocabularies, kept apart on
purpose. `chip.ts` now encodes both: `axisPillStyle` (solid + `contrastText`
luminance flip + `3px`) vs `flagChipStyle` (square).

## Free-form crosshair: a toggle, not a new mode name

The design question: `cursor="crosshair"` snapped to the nearest data point,
but the financial crowd wants a reticle that follows the raw mouse — free y,
not snapped. I framed it as a fork: either a **new `CursorMode` name**
(`'reticle'`?) or a **`crosshair` + snap toggle**. pjm17971 chose the toggle
explicitly.

That was the right instinct and worth generalising: **don't proliferate
vocabulary when a boolean discriminates a variant of the same thing.** A
free-form crosshair is still a crosshair — it's the same reticle, the only
difference is whether y snaps. So `crosshairSnap?: boolean` (default `true`,
preserving old behaviour) rather than a sixth mode string nobody would
discover. This is the same taste that gave us `range` over `timeRange`
(dodge the time-vs-value trap by _not_ naming the axis) and `showMedian`
over a `median` variant — pond-ts prefers composition/flags over a growing
enum of near-synonyms.

The reticle itself got simpler in the process: the old snap crosshair drew
per-series y-pills (one per row); the redesign is a **single reticle** — dashed
full-height vertical + dashed full-width horizontal + a center dot + one value
pill + the connected x-time pill. This is a **shape change** consumers can see
(per-series readout → single reticle); the Tidal agent was warned that a
per-series readout now lives on `flag`/`inline`, not `crosshair`.

New plumbing this needed: the container only tracked `cursorX` (a shared
plot-pixel x, so a still cursor stays put while a live window slides — the
LiveSine bug from way back). Free-y needs **`cursorY` + `cursorRowKey`** too,
because y is per-row (each row has its own scale). `setHoverY(py, rowKey)` from
the pointer handler; the reticle inverts through that row's y-scale when free,
or picks the nearest sample by `|py - cursorY|` when snapping.

## Coincident markers merge into one chip — they don't stack

When several labelled markers land on the _same_ x (open/high/close all at one
timestamp), the naive lane-packer stacked them into three vertical lanes. That
looked like three unrelated marks. pjm17971's call (via an AskUserQuestion):
"logically the stacked labels become one label and there's room for it on row
1." So **coincident labelled markers on the same row merge**: one
representative chip carries the joined label (`'open, high, close'`), the others
fold in (`label: null`), and the merged chip sits on **lane 0** — there was
never a collision, they're the same point.

The subtlety that made this correct: **pack per row, not globally.** Markers on
_different rows_ at the same x share a pixel column but must _not_ collide —
each row has its own top space. `computeLabelLanes` groups by `rowKey` first,
then packs within each group. My first cut packed globally and produced a false
collision (a mark on row 2 pushed down by a mark on row 1 it never visually
touched — the `MultiRowMarkers` scenario exposed it).

## Dead ends walked back (so they aren't re-proposed)

- **#323's "indicator echoes a custom label"** — reverted, per the law above.
  The indicator is the value. Full stop.
- **A new `CursorMode` for the free crosshair** — rejected for the
  `crosshairSnap` boolean. Don't add mode names for boolean variants.
- **A consumer callback for drag-in-progress state** — I mused about exposing
  "which annotation is being dragged" as an `onDragActive`-style public API so a
  consumer could react. It's transient _internal_ state whose only job is to
  stop the lane-packer reshuffling static pills as a dragged mark crosses them.
  YAGNI — it's `draggingKey` on the container, set by each mark's `DragArea`
  `onDragActive`, and the packers exclude it. No public surface. (There _is_ a
  private `onDragActive` on `DragArea`, but it's wired internally, not exported.)
- **`YAxisIndicator` `label` + `placement:'inside'`** — deleted. See the law.
- **z-order "select brings annotation to front"** — dropped in the prior wave,
  still dropped; grid + data share one opaque canvas, so interleaving
  annotations forces splitting it. Not re-proposed. (Recorded here so the trail
  survives with the rest.)

## Process scars (the ones that cost real time)

These aren't design — they're operational, and each bit me more than once this
wave. Captured so the next session doesn't re-earn them.

### `git add -A` swept a stray file onto `main`

Twice I caught it (`git reset --soft HEAD~1` + `git restore --staged`); once I
didn't, and the v0.39.0 release-bump commit carried
`docs/notes/live-series-analysis-2026-07.md` (another track's untracked WIP) onto
`main`. Harmless in the end — docs aren't in the npm packages, nothing lost —
but it's another agent's file now sitting in a release commit it has nothing to
do with. **Lesson, now a memory: for release bumps (and really any commit where
the working tree might hold another track's untracked files), stage explicit
paths — `git add package.json CHANGELOG.md ...` — never `git add -A`/`git add
.`.** The monorepo is shared across parallel agents; the working tree is not
mine alone.

### The stale-HMR ghost — don't chase phantom values in code

Several times pjm17971 sent a screenshot of an indicator showing a nonsense
fraction (`.395`, `.979`, `.824`) and said "still wrong." Each time I started
reading code for a formatting bug. Each time the real cause was a **long-lived
Storybook dev server leaking `createLiveValue` fractions across HMR into
unrelated stories** — preview corruption, not a code bug. `preview_stop` +
`preview_start` cleared it every time. **Lesson: when a live-value story shows a
value that has no business being there, restart the preview server before
reading a single line of source.** The `createLiveValue` external-store
subscription is exactly the kind of thing HMR mishandles across a long session.

### Verify the branch base before doing anything

Mid-wave the repo was checked out on `tidal/constellation-bridge` (another
agent's branch) and my edits were landing on the wrong base. Recovered with
`git stash push <files>` → checkout the right branch → `git stash pop` (files
were identical between the branch HEADs so it applied clean, but that was luck).
**Lesson: `git branch --show-current` before editing, every session — the
working tree is shared and another agent may have moved it.**

## Why the stories were the review technique

The systematic-coverage convention (now in `CLAUDE.md`) earned its keep _this
wave_. The feature-axis reorg (#325) fanned out via 8 parallel Sonnet agents,
one per leaf story file — and walking those stories in order is what surfaced
the false-collision multirow bug, the misaligned x-pills, and the flag-time
chip-background wart. A knob with no dedicated story is a knob nobody reviews.
The scenario stories ("how would I build a network-traffic monitor") are great
demos and e2e anchors, but they _bury_ individual capabilities. The fan-out is
the reference _and_ the regression net _and_ the review walk. This is why the
convention is written down.

## State at close

v0.39.0 live on npm (all four packages, OIDC). The whole axis-indicator +
crosshair + annotation-indicator arc is closed. Standing backlog untouched by
this wave: estela DataChart cutover, stop exporting `estelaTheme`, responsive
sizing, decimation. The Tidal agent picks up from the published version.
