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
> **Amendment 1 (2026-08-08)** records the Codex red-team ([Discussion
> #611](https://github.com/pond-ts/pond/discussions/611)) and its dispositions.
> It corrects five factual errors in §1/§2/§9/§12/Q7, moves `selected` /
> `hovered` **back onto the container** (selectors report; the consumer owns the
> state), and marks §5's cursor contract and §8's sweep algorithm as **owing
> another pass** before they can be scheduled.
>
> Reading order for the interaction surface: `cursor.md` (what cursors draw) →
> `selection.md` v1 → its A1–A5 → this RFC §1–§12 → **this RFC's Amendment 1 is
> current on API shape**.

## 1. The question

`@pond-ts/charts` has two interaction subsystems that were built at different
times, for different reasons, and have never been named as different things:

- **Cursors** — data-aware marks that _read_. They follow the pointer, snap to
  data, and display an x and/or y. They hold no state of their own. _(One
  documented exception: a region cursor also produces a range on drag-release —
  §6, and A1.5 on why the exception is kept rather than designed away.)_
- **Selectors** — gestures that _report_. They interpret clicks and drags and
  hand back what the user picked. They hold no state either: the **consumer**
  keeps the selection and feeds it back to the container (A1.2).

Today both are expressed as **props on `<ChartContainer>`**, which is why they
blur. The tell is a single prop name: **`onRegionSelect`** — a selection
callback that lives on a cursor mode. It is the reason `regionSelectModifier`
exists, the reason `region` is the only mode with a gesture, and the reason
"how do you select a cursor" has two unrelated answers.

The cost is concentrated in one place. Interaction currently occupies
**thirteen props on `ChartContainer` plus one on `ChartRow`** — most of the
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
| `onHover`                      | selection                  |
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
- **`selected` is a set; `hovered` is not.** #606 widened `selected` to
  `readonly SelectInfo[]` on the frame, accepting a single `SelectInfo`, an
  array, or `null` as a prop. **`hovered` is still `SelectInfo | null`**
  (`context.ts`) — the widening is written and pushed but **unmerged** (§10
  step 1). _(Corrected in A1.1; the original text cited the widening as though
  it had shipped.)_
- **The library performs no set arithmetic** (A4.1). It reports the hit and the
  modifiers; the consumer computes the next set. That contract is settled and
  this RFC does not revisit it.

## 3. The split

|                   | **Cursor**                             | **Selector**                   |
| ----------------- | -------------------------------------- | ------------------------------ |
| purpose           | reads                                  | reports what was picked        |
| state             | none — ephemeral, follows the pointer  | none — the _consumer_ keeps it |
| data awareness    | snaps x, snaps to points, displays x/y | hit-tests marks                |
| draws             | line, dot, chip, flag, band            | (borrows a cursor's look)      |
| callback currency | a position / a range                   | `SelectInfo[]` + modifiers     |
| how many mounted  | one                                    | one                            |

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

| today                  | becomes                           |
| ---------------------- | --------------------------------- |
| `cursor`               | mount a cursor component          |
| `ChartRow.cursor`      | mount it inside the row           |
| `cursorSequence`       | `<RegionCursor sequence>`         |
| `cursorTime`           | `showTime` on the cursor          |
| `cursorFormat`         | `format` on the cursor            |
| `crosshairSnap`        | `<CrosshairCursor snap>`          |
| `onRegionSelect`       | `<RegionCursor onDragRelease>`    |
| `regionSelectModifier` | `<RegionCursor dragModifier>`     |
| `onSelect`             | `<Selector onSelect>`             |
| `onHover`              | `<Selector onHover>`              |
| `selected`             | **stays on the container** (A1.2) |
| `hovered`              | **stays on the container** (A1.2) |
| `trackerPosition`      | **stays on the container** (Q4)   |
| `onTrackerChanged`     | **stays on the container** (Q4)   |

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

**Q7 — do the scatter/boxplot layers get fixed here?** _(Corrected in A1.1 —
the original claimed all three read `selected[0]`, which is wrong for two of
them.)_ **`ScatterChart`** does read `selected[0]`, ignoring the rest.
**`BoxPlot`** takes the first selection matching its own series id — narrower
than `selected[0]` but still single. **`HeatMap` already maps the full set** and
needs nothing. So it is two layers, not three. Independent of this RFC, but a
reader will assume "selectors" fixed it.

**Q8 — what does a layer `id` mean once `<Selector>` is required? Resolved
(pjm17971, 2026-08-08): nothing changes.** _If you want to know what you
hovered or selected, give the layer an `id` and we'll tell you._ A3's rule
stands as written; mounting a `<Selector>` and tagging a layer are not two
gates on one capability, they are enablement and identity, and both were
already required.

_(A1.2 corrects two errors here: the original said mounting and tagging "were
both already required", which contradicts §7.1 — mounting is **new**; and it
justified id-without-`<Selector>` by pointing at a controlled `selected` prop
that §9 had moved onto the absent `<Selector>`. That circularity is gone now
that `selected`/`hovered` stay on the container.)_

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
- ~~**Not new hit-testing.** Layers implement `hitTest` as they do today; the
  sweep calls it more often, that is all.~~ **Withdrawn — this was wrong.**
  `RowLayer.hitTest(px, py)` answers about **one point**; enumerating the marks
  under a swept band is a **range query**, which no layer implements. The sweep
  _does_ need new hit-testing. See **A1.4**.
- **Not a change to what cursors draw.** `cursor.md`'s per-chart-type taxonomy,
  the flag staff geometry, and axis-matched formatting all stand. This is an
  API-shape RFC.
- **Not a new layer or draw path.** Cursors remain a DOM/SVG overlay above the
  data canvas, so hovering still never repaints the data.

## Amendment 1 (2026-08-08) — the Codex audit, and where it lands

> _Red-team by Codex ([Discussion
> #611](https://github.com/pond-ts/pond/discussions/611)), verified against the
> source by the pond-ts library agent (Claude); dispositions by pjm17971. The
> review reported **high** confidence and was right on **every** factual claim
> it made — five source-checkable corrections, all confirmed. Reading order:
> §1–§12 → **A1 is current**._

### A1.1 Factual corrections (all verified, all fixed in place)

The audit caught five errors in a document whose §2 claims to be "verified
against the source". All five are now corrected in the body; recorded here so
the failure mode is visible rather than quietly patched.

1. **`hovered` is not yet a set.** §2 cited the widening as shipped. It is
   written and pushed but **unmerged** — `context.ts` on `main` still has
   `hovered: SelectInfo | null`. The RFC was reading its own branch.
2. **`onHover` was missed entirely** — so the surface is **thirteen** container
   props, not twelve, and §9's migration table was short a row. It was missed
   because the prop inventory was gathered by grepping for the names already
   known, which cannot discover a name you have forgotten.
3. **Q7 was wrong about two of three layers.** `ScatterChart` does read
   `selected[0]`; `BoxPlot` takes the first selection matching **its own series
   id** (narrower, still single); **`HeatMap` already maps the full set.** Two
   layers need fixing, not three.
4. **The §12 "not new hit-testing" bullet was false** — withdrawn, see A1.4.
5. **Two internal contradictions in Q8** — "both were already required"
   contradicted §7.1, and the justification for id-without-`<Selector>` leaned
   on a controlled `selected` prop that §9 had moved onto the very component
   that isn't mounted. Both resolved by A1.2.

### A1.2 `selected` / `hovered` stay on the container — selectors only report

**Accepted (pjm17971, 2026-08-08), and it was always the intended API**; §9 got
it wrong by sweeping the state props along with the gesture props.

> Selectors hit-test and report. The consumer manages selection and hover
> change. The consumer sets selection and hover **on the container**.

The audit reached the same place from the other direction, proposing it as the
"third option" §7.1 had not seen: keep the state on the container, and let
`<Selector>` gate only plot hit-testing and callbacks.

**Why this is right and not merely a smaller break.** _What is selected_ is not
a gesture. Conflating them is what produced Q8's circularity — a rule that
justified itself by pointing at a prop the same document had relocated. Once
state lives on the container and gestures are what you mount, the two questions
separate cleanly and Q8 stops needing an argument at all.

**§7.1 survives intact.** Selection behaviour is still intentional; mounting is
still required for a click on the plot to do anything. What changes is that
**controlled highlighting keeps working without a `<Selector>`** — a legend chip
or an external filter can still light marks up, which is exactly the
`id`-without-`<Selector>` configuration Q8 wanted to call legitimate. The break
narrows to precisely the thing being made intentional: the plot gesture.

### A1.3 The cursor contract is under-specified — §5 fails its own example

**Accepted.** The contract as sketched **cannot reproduce the built-in
crosshair**, which makes the gapped-crosshair claim unsupported.

The audit's finding: the production crosshair spans **three surfaces** — the SVG
reticle in `Layers`, the DOM value pill in the y gutter, and the DOM time pill
on `<XAxis>`. "A cursor returns SVG into the overlay" cannot express that. A
_raw-pointer_ gapped crosshair is buildable from §5; the **snapped, multi-axis
production** one is not.

`CursorRenderProps` is also thin where it needs to be specific: `CursorSample`
is sketched with no axis id and no resolved `px` / `py` / `format` / `side`;
`rowKey` names the hovered row but a renderer also needs **its own** row key;
and the x-axis kind and formatter are absent entirely.

**Disposition:** either expose resolved reticle geometry, per-sample axis
metadata, and explicit **render slots** for the gutter and the x-axis — or
narrow §5's claim to what a single overlay surface can honestly deliver. This
strengthens Q3's answer: the contract must not be published until every
built-in **and** the SR gapped crosshair are written against it. If our own
crosshair cannot be expressed in it, it is not a contract, it is a wish.

### A1.4 The sweep needs a range query, not more point hit-tests

**Accepted; §12's bullet is withdrawn.** `RowLayer.hitTest(px, py)` answers one
point. Enumerating the marks under a swept band is a **range/spatial query**,
and no layer implements one. This is new work the RFC claimed was free.

The cost is worse than the missing query. Materializing and emitting up to
100k `SelectInfo` objects **per pointermove** is per-frame allocation the
consumer then has to process; an indexed `O(log n + k)` query fixes the lookup
but not the payload.

**Direction:** keep the live preview **internal**, coalesce to animation frames,
and update by **crossed-mark deltas** rather than re-emitting the set. The
committed selection may be materialized once on release — but for large
continuous sets the result should be able to carry a compact **extent/query
descriptor** instead of forcing eager enumeration. That descriptor is a new
design question this RFC did not open, and it should be settled before
`<RegionSelector>` is scheduled.

### A1.5 `<RegionCursor>` keeps its drag — held, with the factoring taken

**Held (pjm17971, 2026-08-08): "I see the alternatives as worse."** The audit
argued that a cursor which commits contradicts the RFC's own definition, and
that sharing bucket realization is an internal factoring problem rather than a
reason to erase the boundary. The public shape stands: a region is deliberately
a cursor **and** a drag that fires and resets, and `<RegionCursor>` /
`<RegionSelector>` remain two components (§8.1).

**What is taken from the finding — the implementation half, which is
uncontroversial:**

- **One brush recognizer**, not two. Both components drive the same gesture
  engine; only what it emits on release differs (a range vs. marks).
- **One shared band renderer**, so the two cannot visually drift — which §8.1's
  whole argument depends on.
- **A precedence rule**, or a dev error, when both are mounted. §8.1 explains
  why they look alike; it does not arbitrate two components claiming the same
  drag, and the audit was right that docs cannot cover that gap.

**The definition is corrected rather than the design.** §1 and §3 now state that
a region cursor is the **documented exception** to "cursors commit nothing",
instead of asserting a purity the design does not have. **This partially
resolves Q5**: one engine internally, two components publicly.

### A1.6 Recorded opinions on the open questions

Codex's positions, kept for the next reader; **not** adopted except where
stated above:

- **Q2** — allow multiple _render-only_ cursor presets with deterministic DOM
  order, but only **one gesture/snapping owner per row**. This is a sharper
  formulation than the RFC's "pick one" and probably supersedes it.
- **Q3** — publish only after every built-in **and** the SR gapped crosshair use
  the exact contract. Adopted in A1.3.
- **Q4** — keep the sync state on the container/frame; it exists without cursor
  presentation. Suggests a less visual name before 1.0.
- **Q5** — one brush engine. Adopted as A1.5's implementation half; the
  two-component public surface is not.
- **Q6** — namespaced roles (`Cursor.Crosshair`, `Cursor.Region`,
  `Selection.Click`, `Selection.Brush`), keeping the annotation `Region`. Open.
- **Q7** — fix `ScatterChart` and `BoxPlot` before advertising plural or sweep
  selection; `HeatMap` needs nothing.

**Verdict recorded:** _"Proceed with mounted presets and the cursor/selector
distinction, but not this contract. The direction is 1.0-worthy; the
state/gesture boundary, sweep algorithm, and extension surface need another
pass first."_ A1.2 settles the state/gesture boundary. A1.3 and A1.4 are the
two passes still owed, and both must land before §10's steps 4 and 5 are
scheduled.
