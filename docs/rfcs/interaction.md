# RFC: Interaction surface — cursors and selectors as mounted components

> _Drafted by the pond-ts library agent (Claude) from pjm17971's design,
> 2026-08-08. **Not a commitment** (see CLAUDE.md → Strategic RFCs) — what lands
> in PLAN.md is the contract, the rest is forward-looking context._
>
> **This RFC reopens a resolved decision.** `cursor.md` → "Crosshair-line:
> resolved — container default + per-row override" settled the cursor API as a
> **string prop** (`CursorMode`), and that is what shipped. This proposes
> replacing it with **mounted components**. `cursor.md` remains the authority on
> what each cursor _draws_ (the per-chart-type taxonomy, the flag staff
> geometry, the axis-matched formatting); only its **API shape** section is
> superseded here.
>
> **It also revises `selection.md` Amendment 4.** A4.2 proposed drag-to-select
> as `<Select>`, "a sibling of `<Region>` / `<Zone>` in the annotation family."
> This RFC keeps A4.2's load-bearing choice intact — **the sweep reports marks,
> not a range** — but re-homes the component: it belongs with the interaction
> primitives as a direct child of `<ChartContainer>`, not with the annotations.
> A4.2's reasoning about CATRANGE, plural hover, and modifier-on-release carries
> forward unchanged.
>
> Reading order for the interaction surface: `cursor.md` (what cursors draw) →
> `selection.md` v1 → A1 → A2 → A3 → A4 → **this RFC is current on API shape**.

## 1. The question

`@pond-ts/charts` has two interaction subsystems that were built at different
times, for different reasons, and have never been named as different things:

- **Cursors** — data-aware marks that _read_. They follow the pointer, snap to
  data, and display an x and/or y. They hold no state; they commit nothing.
- **Selectors** — gestures that _build state_. They interpret clicks and drags,
  report what the user picked, and hand the consumer something to keep.

Today both are expressed as **props on `<ChartContainer>`**, which is why they
blur. The tell is a single prop name: **`onRegionSelect`** — a selection
callback that lives on a cursor mode. It is the reason `regionSelectModifier`
exists, the reason `region` is the only mode with a gesture, and the reason
"how do you select a cursor" has two unrelated answers.

The cost is concentrated in one place. Interaction currently occupies
**twelve props on `ChartContainer` plus one on `ChartRow`** — most of the
container's public interaction surface — with no structure indicating which
belong together:

| prop                           | subsystem                  |
| ------------------------------ | -------------------------- |
| `cursor` (+ `ChartRow.cursor`) | cursor                     |
| `cursorSequence`               | cursor (region only)       |
| `cursorTime`                   | cursor                     |
| `cursorFormat`                 | cursor                     |
| `crosshairSnap`                | cursor (crosshair only)    |
| `onRegionSelect`               | **selection, on a cursor** |
| `regionSelectModifier`         | **selection, on a cursor** |
| `selected`                     | selection                  |
| `hovered`                      | selection                  |
| `onSelect`                     | selection                  |
| `trackerPosition`              | readout / cross-chart sync |
| `onTrackerChanged`             | readout / cross-chart sync |

Four of those (`cursorSequence`, `crosshairSnap`, and both region props) are
**mode-conditional** — inert unless a sibling prop holds a particular string.
That is the shape a type system cannot express and a doc comment has to
apologize for, and every one of them currently does.

## 2. What exists today (verified against the source)

- **`CursorMode` is a 7-value string union** (`context.ts:872`) —
  `none | line | point | inline | flag | crosshair | region`, default `line`.
  Set on the container, overridable per row.
- **The modes are not a clean decomposition.** `cursorParts` (`tracker.ts:98`)
  reduces a mode to `{ line, dots, chip, band }`, but the two most distinctive
  modes escape it: `crosshair` returns `line: false, dots: false` and is drawn
  bespoke by `Layers` (dashed vertical + full-width horizontal + centre dot +
  axis pill); `region` returns `band: true` and is likewise drawn specially.
  **Five of seven modes decompose; the two that matter most do not.** This is
  load-bearing for §4.
- **The region drag is enabled by callback presence.** `Layers.tsx:556` gates on
  the cursor being `region`, `onRegionSelect` being set, and the x axis being
  `time` or `value`. Supplying the callback _is_ the switch. Category axes are
  excluded outright — the `[PND-CATRANGE]` hole.
- **Click-select is implicit.** Any layer with an `id` is selectable (A3), and
  `ChartContainer`'s `select()` updates internal state whether or not an
  `onSelect` prop exists. **Nothing is mounted to enable it.** §7 has to decide
  deliberately whether this survives.
- **`selected` and `hovered` are sets** as of #606 / the `hovered` widening —
  `readonly SelectInfo[]` on the frame, accepting a single `SelectInfo`, an
  array, or `null` as a prop.
- **The library performs no set arithmetic** (A4.1). It reports the hit and the
  modifiers; the consumer computes the next set. That contract is settled and
  this RFC does not revisit it.

## 3. The split

|                   | **Cursor**                             | **Selector**                    |
| ----------------- | -------------------------------------- | ------------------------------- |
| purpose           | reads                                  | commits                         |
| state             | none — ephemeral, follows the pointer  | builds state the consumer keeps |
| data awareness    | snaps x, snaps to points, displays x/y | hit-tests marks                 |
| draws             | line, dot, chip, flag, band            | (borrows a cursor's look)       |
| callback currency | a position / a range                   | `SelectInfo[]` + modifiers      |
| how many mounted  | one                                    | one                             |

Both become **mounted components**, children of `<ChartContainer>`:

```tsx
<ChartContainer>
  <FlagCursor showTime />
  <ChartRow>…</ChartRow>
</ChartContainer>
```

Per-row cursors become a matter of **where you mount it** — strictly more
expressive than `<ChartRow cursor>`, and it deletes that prop:

```tsx
<ChartContainer>
  <ChartRow>
    <CrosshairCursor />
  </ChartRow>
  <ChartRow>{/* no cursor here */}</ChartRow>
</ChartContainer>
```

`cursor="none"` becomes _mounting nothing_, which is the correct way to spell
"nothing."

**This is in-grain, not a new pattern.** `<YAxis>` already registers an
`AxisSpec` with its row via `registerAxis(key, spec)`; layers register via
`registerLayer`. A cursor registering a spec with the container is the same
idiom the codebase already runs on twice.

> **Names throughout this RFC are placeholders.** `<FlagCursor>` vs `<Flag>` vs
> `<CursorFlag>` is a real decision (the `Cursor` suffix disambiguates against
> the annotation family, which already owns `<Region>`) and is deferred to Q6.

## 4. Cursors are **picked**, not composed

An earlier draft of this design proposed decomposing the modes into composable
parts (`<CursorLine> + <CursorPoints> + <CursorAxisPills>`) on the grounds that
the enum was already a bit-space in disguise. **That is rejected**, for two
reasons — the second of which is visible in the code.

**Composition transfers cost from the one user who wants something odd to the
library that must maintain every combination.** A consumer should pick a cursor
from the docs and drop it into the declaration. Line + chip with no dots is not
a thing anyone has asked for; supporting it is a combinatorial promise we would
be making to nobody.

**And the enum was never actually a bit-space.** `cursorParts`' `crosshair`
case returns `line: false, dots: false` — for the mode that visibly has both —
because `Layers` draws the reticle itself. `region` is likewise bespoke. The
implementation had already outgrown the decomposition; composing the parts
would have been re-deriving a scheme the code walked away from.

So the components are **presets, roughly 1:1 with today's modes**:

| today                | proposed                        |
| -------------------- | ------------------------------- |
| `cursor="line"`      | `<LineCursor />`                |
| `cursor="point"`     | `<PointCursor />`               |
| `cursor="inline"`    | `<InlineCursor />`              |
| `cursor="flag"`      | `<FlagCursor />`                |
| `cursor="crosshair"` | `<CrosshairCursor snap />`      |
| `cursor="region"`    | `<RegionCursor sequence={…} />` |
| `cursor="none"`      | _mount nothing_                 |

The mode-conditional props go where they are no longer conditional:
`crosshairSnap` → `<CrosshairCursor snap>`, `cursorSequence` →
`<RegionCursor sequence>`, `cursorTime` → `showTime` on the cursors that have a
readout, `cursorFormat` → `format` alongside it. Each becomes a prop that is
always meaningful on the component that carries it, which is the entire point.

## 5. The cursor **contract** — the load-bearing new API

Rejecting composition creates an obligation: a consumer who needs a cursor we
did not ship must be able to build one. This is the part of the RFC that
commits the most, and it should be scoped honestly.

**The motivating case is real.** SpiderRock's legacy chart tool has a crosshair
with a **gap at the centre** — `———— ○ ————` — so the reticle never occludes
the point it is reading. That is not a combination of our parts. It is a
different cursor, and no amount of prop surface would have anticipated it.

**The proposal:** publish the cursor contract as a documented type, so a
user-authored cursor is a component like ours with no privileged access.

```tsx
interface CursorRenderProps {
  readonly cursorX: number | null; // plot pixel, shared across rows
  readonly cursorY: number | null; // plot pixel, row-local
  readonly rowKey: symbol | null; // which row the pointer is in
  readonly samples: readonly CursorSample[]; // per series: x, y, value, colour, label
  readonly xScale: XScale;
  readonly yScales: ReadonlyMap<string, YScale>;
  readonly formats: ReadonlyMap<string, (v: number) => string>;
  readonly axisSides: ReadonlyMap<string, 'left' | 'right'>;
  readonly plotWidth: number;
  readonly rowHeight: number;
  readonly theme: ChartTheme;
}
```

A cursor returns SVG into the existing overlay. The gapped crosshair is then
~20 lines in consumer space, and — the real test — **our own cursors are
written against the same contract**, so it cannot rot. If `<CrosshairCursor>`
needs something the contract does not expose, that is a bug in the contract.

**The honest cost, and the reason this needs its own decision:** most of the
above is currently internal. `CursorFrame` is public but thin (`cursorX`,
`cursorY`, `cursorRowKey`); the per-layer readout samples are computed inside
`Layers` and exposed to nobody; `XScale`/`YScale`/`ChartTheme` are public but
`formats`/`axisSides` are frame-internal. **Publishing this makes a slice of
`Layers`' internals a supported API** and pins the sample shape for the life of
the major version. That is a larger commitment than the component rename, and
it is the piece most likely to constrain us later.

**Mitigation to consider (Q3):** ship the components first with the contract
_unpublished_, and publish it once our own five cursors have been rewritten
against it and it has survived contact with the SR crosshair. The extension
point is the reason composition was rejected — but it does not have to land in
the same release as the rename.

## 6. `<RegionCursor>` — a cursor that builds a range

**A region is, deliberately, two things: a cursor and a drag that fires and
resets.** An earlier draft tried to separate them — pushing the drag onto a
selector and leaving the cursor pure. That is wrong: `sequence` determines
both the cursor's shape and its snap, and the drag that produces a range is
built from those same buckets. Splitting them would require the two halves to
share a bucket realization across a component boundary for no gain.

```tsx
<RegionCursor
  sequence={daily}              // bucket shape + snap; omit ⇒ line + freeform drag
  enableDrag
  dragModifier="shift"          // only enforced while pan is on
  onDragRelease={([lo, hi]) => …}  // fires once, then the cursor resets
/>
```

This replaces `onChange` doing all the work. `onDragRelease` names **when** it
fires and **that it does not persist** — the two facts today's `onRegionSelect`
leaves to a doc comment.

**On `enableDrag` — resolved (pjm17971, 2026-08-08).** As an _enabler_ it is
redundant, since the presence of `onDragRelease` is already the switch (that is
exactly how `onRegionSelect` works today). It earns its place as a **disabler**
— freezing the gesture without unwiring the callback, which is otherwise a
`useCallback` dance. So: **default it to `!!onDragRelease` and document it as
the off switch**, not the on switch.

The payload stays a **neutral numeric pair in axis units** (epoch ms on a time
axis, the axis value otherwise), as today. That decision is settled and good.

## 7. `<Selector>` — click to select marks

```tsx
<Selector
  onHover={(hit) => …}                    // what is under the pointer
  onSelect={(hit, modifiers) => …}        // what was clicked, and with what held
/>
```

This is the surface that shipped in #606, re-homed. The contract is unchanged
and settled (A4.1): **the library reports, the consumer decides.** `modifiers`
carries `additive` (the platform-idiomatic add chord) plus the raw keys; the
consumer computes the next set and feeds it back as `selected`. pond performs
no set arithmetic and holds no opinion about what ⌘-click means.

### 7.1 Mounting `<Selector>` is **required** — the deliberate break

**Resolved (pjm17971, 2026-08-08), and this is a behaviour break rather than a
prop move.** Click-select is currently _implicit_: any layer with an `id` is
selectable, and the container maintains an uncontrolled `selected` even with no
`onSelect` wired. Requiring `<Selector>` means **every chart that highlights on
click today goes inert on upgrade** — a regression no type error catches.

Accepted anyway, with regrets, on three grounds:

**Selection behaviour should be intentional.** This RFC is itself the evidence:
selection turned out to be a whole subsystem — modifiers, a set, a de-emphasis
slot, a sweep gesture, precedence against hover and dim. A subsystem that large
should not switch itself on because a layer happened to be given an `id`.

**The counterfactual is worse.** The only other way to let a consumer _choose_
their selection behaviour is to keep growing the container's prop surface —
`selectMode="region"`, `regionSelectOnHover={…}`, and the modal, conditional
props that follow. That is the shape §1 is trying to get out of, and adding to
it to avoid one upgrade cost buys a permanent problem with a temporary one.

**The timing is as good as it will ever get.** Pre-1.0, and the affected
subsystem is selection in a library used mostly for _showing_ data — the
population that never selects anything is the majority, and for them the break
is a no-op.

**Softening the landing.** A dev warning fires when a layer has an `id`, a
click resolves to a hit, and no `<Selector>` is mounted — loud on the exact
path that would otherwise go quiet, and matching the dev-warning approach
already used for the `binColors`/`thresholds` conflict. Proposed to be
**scoped to the deprecation window** rather than permanent: once mounting is
the established model, an `id` without a `<Selector>` is a legitimate
configuration (identity without enablement — see Q8), and warning on it forever
would be noise.

## 8. `<RegionSelector>` — sweep to select marks

```tsx
<RegionSelector
  sequence={daily}                          // snap the sweep to buckets
  onHover={(hits) => …}                     // the live list, updating as you drag
  onSelect={(hits, modifiers) => …}         // on release
/>
```

**Everything `<Selector>` does, plus a drag.** A single click still selects one
mark; a drag sweeps, the hover list updates as it goes, and release commits the
list along with the modifiers held.

**The payload is marks, not a range — and that is what folds in
`[PND-CATRANGE]`** rather than working around it. A4.2's reasoning stands
verbatim: the category-axis exclusion exists only while the callback's currency
is a numeric range. Report `SelectInfo[]` and ordinal and continuous become the
_same_ gesture, slot-snapping stops being a special case because nobody sees
slot indices, and the consumer never re-implements the inverse of the band
scale — which is the friction PND-CATRANGE actually names.

**Live preview reuses `hovered`.** The bars under the sweep show the hover
treatment, several at once. This is why `hovered` had to become a set, and why
that work lands first (§10). The precedence chain unified in #606 —
selected outranks hovered outranks dimmed outranks the rest — already handles a
mark that is both.

### 8.1 Two components, one visual — resolved, and it is the good outcome

`<RegionCursor>` and `<RegionSelector>` render the same shaded band. A user
watching one being dragged across a plot **cannot tell which they are holding**
— identical pixels, different semantics, different callback currency.

**Resolved (pjm17971, 2026-08-08): keep them separate, and it is not a
reluctant trade.** The alternative is a single component that is simultaneously
a grey band tracking a sequence, a drag-to-zoom mechanism, and a multi-selection
tool. **We could not reason about that as library authors**, which is a reliable
signal nobody could reason about it as a user either. Splitting a thing that
does three jobs into two things that each do one is the win; the shared visual
is the cost, and it is the smaller number.

**The docs placement _is_ the disambiguation.** They do not go on one page side
by side (an earlier draft of this section proposed that, wrongly — it puts them
in competition and makes the reader choose before they know what they want).
They go where their purpose lives:

- **`<RegionCursor>`** is documented with the cursors, and cross-referenced from
  pan/zoom interactions. A reader arrives at it asking "how do I show the
  session under the pointer / zoom to a span."
- **`<RegionSelector>`** is documented as part of selection. A reader arrives at
  it asking "how does the user pick a run of bars."

Each then **calls out the other**: _same visual language, different purpose._ A
reader who lands on either has their question answered and is told the other
exists — which is strictly better than one page that answers neither question
until you have read both halves.

**Why the drag doesn't collide with click-select** (verified,
`multiselect.test.tsx`): the two are separated by **movement**, not by
modifier. A drag past `DRAG_SLOP` makes the click handler bail. A shift-click
that never moves selects and commits no region. This is also why #606 exposes
`shiftKey` raw and derives no `range` flag from it.

## 9. Migration — the eggs

| today                  | becomes                         |
| ---------------------- | ------------------------------- |
| `cursor`               | mount a cursor component        |
| `ChartRow.cursor`      | mount it inside the row         |
| `cursorSequence`       | `<RegionCursor sequence>`       |
| `cursorTime`           | `showTime` on the cursor        |
| `cursorFormat`         | `format` on the cursor          |
| `crosshairSnap`        | `<CrosshairCursor snap>`        |
| `onRegionSelect`       | `<RegionCursor onDragRelease>`  |
| `regionSelectModifier` | `<RegionCursor dragModifier>`   |
| `onSelect`             | `<Selector onSelect>`           |
| `selected`             | `<Selector selected>`           |
| `hovered`              | `<Selector hovered>`            |
| `trackerPosition`      | **stays on the container** (Q4) |
| `onTrackerChanged`     | **stays on the container** (Q4) |

**The frame does not move.** `ContainerFrame.selected` / `.hovered` /
`.cursorBuckets` / `CursorFrame` stay exactly where they are; only the
_authoring_ surface changes. Components register specs, the container
assembles the same frame, `Layers` reads the same fields. This is what keeps
the change tractable — and it means **the in-flight `hovered` widening is not
wasted**: `<Selector hovered>` needs plural hover for sweep preview exactly as
much as the container prop does. The widening is a prerequisite either way;
only its front door moves.

**`selected` / `onSelect` / `hovered` shipped in v0.57.0** — days before this
draft. Moving them is defensible (better to break at 0.58 than carry the shape
to 1.0), but the driving consumer has code on those props _now_, so the
deprecation window matters more than usual.

**Proposed deprecation:** both surfaces work for one minor. The old props
synthesize the equivalent component internally and emit a dev warning naming
the replacement. Remove one minor later. Pre-1.0 this is generous by the
project's own standards; the size of the surface justifies it.

## 10. Sequencing

1. **Widen `hovered` to a set.** Already done and pushed
   (`feat/charts-hovered-set`). A prerequisite for any sweep preview,
   independently useful, and unaffected by everything else here.
2. **Cursor components + the deprecation shim.** Mechanical: the modes become
   presets registering the specs `Layers` already reads. No behaviour change.
3. **`<RegionCursor>`.** Absorbs the drag props with real names.
4. **`<Selector>`.** The #606 surface re-homed, plus the Q1 decision and its
   dev warning.
5. **`<RegionSelector>`.** The genuinely new capability — the sweep, the live
   plural hover, the commit. Closes `[PND-CATRANGE]`.
6. **Publish the cursor contract** (Q3) — after our own cursors are written
   against it.

Steps 2–5 are each independently shippable behind the shim, which is the main
argument for the deprecation window: it turns one breaking release into four
additive ones.

## 11. Open questions

> **Resolved 2026-08-08 (pjm17971), numbering kept stable:**
> **Q1** — `<Selector>` **is** required; the break is accepted deliberately
> (§7.1). **Q8** below is the question that resolution created.
> Two further points settled in the same pass: `enableDrag` defaults to
> `!!onDragRelease` and is documented as the _off_ switch (§6), and the
> two-components-one-visual overlap is kept and disambiguated by **docs
> placement** rather than by a shared page (§8.1).

**Q2 — can more than one cursor be mounted?** The model says one. Two mounted
cursors should presumably be a dev warning rather than a stack of overlays —
but "a region band _and_ a crosshair" is a plausible ask (shade the session,
read the point). If that is legitimate, the "pick one" model needs an
exception, and §4's argument weakens.

**Q3 — when does the cursor contract become public?** §5. Ship the components
first and publish the contract once our own cursors are written against it, or
publish together? Publishing later is safer and delays the SR crosshair.

**Q4 — do `trackerPosition` / `onTrackerChanged` follow the cursors out?**
Proposed: no. They are the cross-chart **sync** channel, not cursor
configuration — the `trackerPosition`/`onTrackerChanged` pair is how N charts
share one time, and it works with no cursor mounted at all. But `trackerPosition`
resolving through `resolveCursorX` makes the boundary less clean than the
argument implies.

**Q5 — does `<RegionSelector>` subsume `<RegionCursor>`'s drag?** Both drag,
both snap to a sequence, and they differ only in what the release produces. If
a consumer wants a range **and** the marks in it, they mount both and get two
overlapping bands. Worth checking whether that case is real before shipping two
draggable region components.

**Q6 — naming.** `<FlagCursor>` vs `<Flag>` vs `<CursorFlag>`. The `Cursor`
suffix disambiguates against the annotation family, which already owns
`<Region>` and `<Zone>` — and `<RegionCursor>` / `<RegionSelector>` / `<Region>`
(annotation) in one namespace is a genuine collision risk.

**Q7 — do the scatter/heatmap/boxplot layers get fixed here?** They currently
read `selected[0]`, ignoring the rest of the set — a known gap from #606. It is
independent of this RFC, but a reader will assume "selectors" fixed it.

**Q8 — what does a layer `id` mean once `<Selector>` is required? Resolved
(pjm17971, 2026-08-08): nothing changes.** _If you want to know what you
hovered or selected, give the layer an `id` and we'll tell you._ A3's rule
stands as written; mounting a `<Selector>` and tagging a layer are not two
gates on one capability, they are enablement and identity, and both were
already required.

Worth recording _why_ this needs no new machinery, because the alternatives
both have a cost and neither has to be paid. Making `id` **mandatory** is wrong
in a library where selection is opt-in and most consumers only display data.
Reporting hits from **untagged** layers means a `SelectInfo` with an undefined
`id`, which will eventually crash somebody's callback. The existing behaviour
is the third option and it is already correct: `resolveSelection` only
hit-tests layers that have an `id`, so a click on an untagged layer returns
`null` — the same value as a click on empty space, which is already the
deselect path (`Layers.tsx`, `handleClick`). **`SelectInfo.id` is therefore
never undefined**; "no identifiable mark here" is a null hit, not an object
with a hole in it.

Consequence for §7.1: the dev warning stays **deprecation-scoped**. An
`id`-bearing layer with no `<Selector>` mounted is a legitimate configuration
(highlightable from a legend chip or a controlled `selected` prop, inert to
plot clicks), so warning on it permanently would flag a supported setup.

## 12. What this is NOT

- **Not a theming change.** The dimmed/hover/selected precedence chain and the
  theme slots are settled (#606) and untouched.
- **Not set arithmetic in the library.** A4.1's contract holds: pond reports the
  hit and the modifiers, the consumer computes the set.
- **Not new hit-testing.** Layers implement `hitTest` as they do today; the
  sweep calls it more often, that is all.
- **Not a change to what cursors draw.** `cursor.md`'s per-chart-type taxonomy,
  the flag staff geometry, and axis-matched formatting all stand. This is an
  API-shape RFC.
- **Not a new layer or draw path.** Cursors remain a DOM/SVG overlay above the
  data canvas, so hovering still never repaints the data.
