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
> **Amendment 2 (2026-08-08)** records three further reviews — two **consumers**
> (the `<HeatMap>`/gallery build, and estela's chart ↔ list ↔ map surface) and a
> fresh **Fable** red-team. The split survives all of them. A2 corrects two
> claims in the reviews themselves, gives A1.3 and A1.4 concrete **shapes**, and
> opens four questions (Q9–Q12), two of which are **scope calls**: whether the
> list family shares this vocabulary, and whether the annotation `<Region>` is
> the name that should move.
>
> **Amendment 3 (2026-08-08)** takes A2's two scope calls — the **list family is
> in scope** (one interaction vocabulary across the whole API) and **no
> namespacing** — and records a requirement that materially widens §8: the region
> is **2-D on scatter and heat map**, 1-D everywhere else, for both zoom and
> select. The drag treatment is **per-layer** (heat map outlines, scatter dims),
> which resolves Q11. Systematic Storybook coverage of the full combination is a
> **shipping gate** on every step.
>
> **Amendment 4 (2026-08-08)** settles the names — `<Selector>` /
> `<MultiSelector>` / `<RangeCursor>`, with `Region` staying the annotation —
> and **consolidates the whole decided surface into A4.2**, which is what an
> implementer should read. Three questions remain open and all three gate the
> sweep: span-minus-point, the 2-D descriptor shape, and grid indexing.
>
> **Amendment 5 (2026-08-08)** closes **Q12**, the critical path. Both options
> the RFC had named turn out to be unusable — the exclusion channel is
> _incorrect_ under overlapping sweeps, and replace-after-sweep fails the
> workload that motivated sweeps. Adopted instead: the sweep reports **both**
> marks and a span, and a span is edited by **demoting** it to its marks. This
> also corrects A3.3 — the heat map's second axis is ordinal, not an interval.
>
> Reading order for the interaction surface: `cursor.md` (what cursors draw) →
> `selection.md` v1 → its A1–A5 → this RFC §1–§12 → A1 → A2 → A3 → A4 → **A5 is
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

## Amendment 2 (2026-08-08) — three more reviews: two consumers and a fresh red-team

> _Reviews on [Discussion #611](https://github.com/pond-ts/pond/discussions/611)
> by the **Claude use-case agent** (consumer — built `<HeatMap>` and the gallery
> cards against this surface), the **Estela agent** (consumer — a chart ↔ list ↔
> map surface driving controlled `selected`/`hovered` externally), and the
> **Fable agent** (fresh red-team, Claude Fable 5). Source claims verified by the
> pond-ts library agent (Claude). Reading order: §1–§12 → A1 → **A2 is
> current**._

**The split survived a third and fourth read.** Nothing in these reviews
weakens §1, §4, §7 or §8's architecture; all three endorse the direction. What
they add is evidence, two proposed shapes for the passes A1 said were owed, and
four new open questions — two of which are scope calls this RFC cannot make for
itself.

### A2.1 Corrections to the reviews (verified against the source)

Two review claims are wrong. Recorded because both would propagate if left.

1. **`<HeatMap>` does not read `selected` singular.** The use-case review
   reports having shipped it that way. It didn't: `HeatMap.tsx` maps the **full
   set**, with a `[PND-MULTISEL]` comment saying so. What _is_ singular there is
   **`hovered`** — and that is correct on `main` today, because the hover
   widening is unmerged (A1.1). So it is not a defect, it is §10 step 1 pending.
   **Codex's Q7 correction stands unchanged: two layers, not three**
   (`ScatterChart`, `BoxPlot`).

2. **"Hover is singular, selection is a set" is not the current rule.** The
   use-case review cites `selection.md` L247 for it. That line is **A1.4 of
   `selection.md`**, and **A4.2 explicitly supersedes it** — hover became plural
   precisely because a sweep preview is plural. The current rule is **both are
   sets**.

   This **inverts** the review's conclusion about
   [#608](https://github.com/pond-ts/pond/issues/608): `<BarList>`'s hover should
   mirror a **plural** canvas hover, not a singular one. Worth stating loudly,
   because "one rule with four exceptions" was the right observation attached to
   the wrong rule.

### A2.2 New evidence for the direction (accepted; no change needed)

- **The `<XAxis>` seam (Fable) — the strongest argument for mounting, and the
  RFC missed it.** The crosshair's x-time pill is drawn by `<XAxis>`, gated on
  `container.cursor === 'crosshair'` — the **container default**, which a
  per-row override never reaches, so **a row-level crosshair has no time
  pill**. Verified; and the code comment states it outright ("Gated on the
  container default, so a per-row `cursor` override doesn't reach here"), so
  this is a **documented** limitation rather than an undiscovered bug. Either
  way the point lands: one cursor's parts are spread across three files
  coordinating by string equality. A registered spec makes them local again and
  deletes this seam as a side effect.
- **Turning the cursor _off_ (use-case) — an argument for §7 the RFC doesn't
  make.** Every shipped heat map sets `cursor="none"`, because on a grid the
  cell outline answers both axes while a shared vertical line answers only x —
  a weaker second cursor competing with the one that works. Under the mounted
  model that stops being a magic string and becomes _not mounting a cursor_,
  visible in the JSX.
- **`panZoom2D` (use-case) — dated evidence for §4.** The mode replaced by
  `panZoomX`/`panZoomY`/`panZoomXY` claimed both axes and then silently fell
  back to y-only wherever x was a category axis. A composed API would have let
  that combination be built; **enumerating is what caught it.**
- **estela hand-coded the disambiguation.** Its drag-to-zoom is
  `cursor="region"` + `onRegionSelect`, and it **disables region entirely in bar
  mode** (`regionOn = !!onRegionSelect && !barMode`) because "drag over bars"
  has two legitimate meanings the prop pile could not express. `<RegionCursor>`
  / `<RegionSelector>` is that workaround, promoted into the API.
- **A1.2 confirmed load-bearing by a multi-surface consumer.** estela drives the
  chart's `selected`/`hovered` from external state — a locked list row, a map
  hover — so **the chart is usually not the gesture origin**. Had controlled
  highlighting required a mounted `<Selector>`, that wiring would break. Both
  reviews independently reached A1.2's formulation: mounting is right for the
  **gesture**, wrong for the **state**.

### A2.3 A1.3 has a shape: render slots, resolved geometry, declared snap

**Adopted as the working shape** (Fable's proposal; the author flags it as a
shape to attack, not a validated design).

Three optional render slots on a registered `CursorSpec` — the axis/layer
registration idiom rather than a render-prop bag:

```ts
interface CursorSpec {
  readonly snapX?: 'none' | 'sample' | 'sequence'; // resolved BY the container
  renderPlot?(f: ResolvedCursorFrame): ReactNode; // SVG overlay, per row
  renderYGutter?(f: ResolvedCursorFrame): ReactNode; // DOM, per row + axis
  renderXAxis?(f: ResolvedCursorFrame): ReactNode; // DOM, on the axis
}
```

`<XAxis>` then stops asking "is the mode `crosshair`?" and asks "did the mounted
cursor register an x-axis slot?" — which is A2.2's seam closing.

Two departures from §5, both improvements:

- **No scales, formats or side maps in the contract.** §5 handed raw materials
  (`xScale`, `yScales`, `formats`, `axisSides`) and then worried — correctly —
  that this publishes a slice of `Layers`. Hand **finished measurements**
  instead: per-sample `{ px, py, axisId, side, formatted, color, label }`, plus
  the renderer's own row key alongside the hovered one. Strictly smaller public
  surface, same expressive power **for a cursor** — a thing that draws at the
  pointer. A thing that draws at arbitrary data positions is an annotation and
  has its own family.
- **Snap must be _declared_, not implemented.** This is the structural finding,
  and it explains why §5 could never have worked: the x-snap consults each
  layer's `sampleAt` in the hovered row and writes the result into the
  **shared** `cursorX` every other row reads. A user-authored component has
  neither the layers nor the right to write that value. **Container resolves;
  slots draw.** §5 put resolution on the wrong side of the contract.

**Q3's litmus order, adopted:** the flag cursor first (stacked flags are the
layout-heaviest slot body), then our own crosshair with **zero mode-string gates
left** in `Layers` / `XAxis`, then SR's gapped one. The rewrite is not
validation overhead — it is the commit that deletes the cross-file string
coupling.

### A2.4 A1.4 has a shape, and the question that decides it

A1.4 addressed **emission**. Fable identifies the half it missed: **the return
path**. The committed set comes back through `selected`, and every draw-path
membership test is linear over that set per mark — **by documented design**
(`bars.ts`: _"a selection is a handful of marks a person clicked, not a data
structure"_). The sweep is precisely the feature that ends that assumption.

The use-case review supplies the magnitude, and it is worse than §8's "100k
points on a continuous axis" because **a grid multiplies**: the shipped measles
card is 50 × 81 = 4,050 cells; the Niño grid at day resolution is 365 × 45 =
16,425. A half-sweep is ~8k `SelectInfo`, and per-cell scans against that are
~10⁸ comparisons **per repaint** — after the emission fix, because this is the
feedback path.

**Proposed currency** — the descriptor must be something `selected` _accepts_,
not merely something `onSelect` reports:

```ts
type SelectionEntry = SelectInfo | SpanSelection;
interface SpanSelection {
  readonly id: string; // the layer, as ever
  readonly span: readonly [number, number]; // axis units — the pair §6 already reports
}
```

Membership for a span entry is an **interval test** on the mark's key — O(1) per
mark, nothing to scan. Enumeration stays available and is O(log n + k) on a
time-sorted series. This also right-sizes the withdrawn §12 bullet: the **1-D
continuous** range query is nearly free _because events are sorted_; the
genuinely new indexing work is the **2-D grid** case. **Category axes keep marks
as the currency** — slot counts are bounded, so §8's CATRANGE argument survives
untouched.

**estela's constraint, accepted:** keep the range path range-shaped. The
zoom case wants a cheap `[start, end]` and never the swept points enumerated —
so the marks-payload problem must stay inside `<RegionSelector>` and not push a
descriptor onto `<RegionCursor>`'s range.

### A2.5 Q2 corrected — the snap owner is per-**container**, not per-row

A1.6 recorded Codex's "one gesture/snapping owner per **row**". Fable corrects
it against the source and is right: `cursorX` is **one shared container value**,
written by whichever row the pointer is in after consulting that row's layers.
Today's rule is nearest-mount-wins (`row.cursor ?? container.cursor`) with the
**hovered row's** policy deciding the shared line for everyone — and that is the
semantics to keep. **Stack render-only presets freely; snap and gesture resolve
to the hovered row's innermost mount; dev-warn on two gesture-owning cursors in
one scope.**

### A2.6 §7.1's dev warning can't tell its two populations apart

**Accepted — small and clearly right.** After A1.2, "id-bearing layer + click
resolves + no `<Selector>`" is _also_ the exact runtime signature of the
**endorsed** controlled-highlight setup. Fix: **suppress the warning when
`selected` is supplied.** Otherwise the deprecation window spends its loudness
on the people already doing the right thing.

### A2.7 A1.5's precedence rule is bigger than the two bands

**Accepted.** A drag already has multiple claimants resolved by ad-hoc ordering
in `handlePointerDown`: annotation-create capture, then the region gesture
(preempting pan, or hiding behind shift _only while pan is on_), then pan armed
behind slop — with mark-edit's `DragArea` layered above. **Turning claimants
into components makes that implicit ordering public API.** So A1.5's single
brush engine should own **all** drag claims, pan included, not merely arbitrate
`<RegionCursor>` vs `<RegionSelector>`.

### A2.8 New open questions

**Q9 — is the list family (`<BarList>` / `<BoxList>`) in scope for this
interaction model?** Raised by estela, which wants an explicit in-or-out call
rather than discovering the inconsistency post-1.0. `<BarList>` is a DOM table
with its own `selected` + `onRowClick` and, per #608, **no hover in either
direction** — `ListTable` holds hover in internal state a consumer can neither
read nor drive. If 1.0 declares "the interaction surface", the list should not
be the one surface speaking a different dialect when it freezes. Note A2.1's
correction: the mirror target is **plural** hover.

**Q10 — should the _annotation_ `<Region>` be renamed instead?** Two of the
three colliding names (`RegionCursor`, `RegionSelector`, `Region`) are **new**,
so the cheapest fix may be renaming the incumbent while pre-1.0 still allows it.
Fable also argues against Codex's namespaced `Cursor.Region` on the grounds that
**nothing in `@pond-ts/charts` exports a namespaced compound today** — the
annotation family is flat — so it would introduce a new idiom to solve a naming
problem, and flat `*Cursor` names keep the 1:1 parity with the mode strings that
§9's migration table leans on. The use-case review widens the scope: **`mark` is
already overloaded three ways** (`<Marker>` the annotation, `SelectInfo.mark`
the reorder-stable identity, `StackMark` the internal one), so Q6/Q10 is a
chance to fix an existing overload rather than a naming choice local to regions.

**Q11 — where does a layer's own hover affordance sit in the model?** The
use-case review's case is "**no cursor**, plus a layer-drawn live treatment" —
the heat-map cell outline, which is doing the cursor's job on both axes. If Q2
stays "one cursor", the model must say **explicitly** that a layer drawing its
own live treatment is not a cursor, or the next person doing this reads the
restriction as forbidding it.

**Q12 — span-minus-point: the question inside A1.4's question.** A4.1 keeps set
arithmetic with the consumer, and spans make exactly one operation hard:
⌘-clicking a mark **out** of a span selection. Span-minus-point is not
representable in `(SelectInfo | SpanSelection)[]` without either an exclusion
channel (`SpanSelection.exclude?`) or a documented rule that **any click after a
sweep replaces**. Either is defensible; neither is written down; **and the
answer decides whether the descriptor can be the round-trip currency at all.**
This blocks A2.4, which blocks §10 step 5.

## Amendment 3 (2026-08-08) — scope calls, and the region is 2-D

> _Dispositions by pjm17971 in response to A2's Q9/Q10, plus new requirements
> that materially widen §8. Reading order: §1–§12 → A1 → A2 → **A3 is
> current**._

### A3.1 Q9 resolved — the list family is **in scope**

> _"Lists are in scope, it should work the same way across the whole API."_

`<BarList>` / `<BoxList>` share this interaction vocabulary. Not a parallel
model, not an island that freezes with a different dialect at 1.0 — **the same
one**. Concretely, that means [#608](https://github.com/pond-ts/pond/issues/608)
is not a standalone list feature request but a **conformance item** under this
RFC: `ListTable`'s hover moves out of internal state and onto the same
`hovered` / `onHover` channel the canvas layers use.

Carry A2.1's correction through: the mirror target is **plural** hover, not the
singular rule the review cited from a superseded line.

**Consequence for §10:** a conformance pass across every interactive surface
joins the sequencing — the canvas layers, the list family, and (per Q7) the two
layers still reading a single selection.

### A3.2 Q10 partly resolved — no namespacing

> _"No namespacing."_

Codex's `Cursor.Crosshair` / `Selection.Brush` compound proposal is **rejected**.
Flat names, consistent with Fable's argument: nothing in `@pond-ts/charts`
exports a namespaced compound today (the annotation family is flat `Region` /
`Marker` / `Zone`), so it would introduce a new idiom to solve a naming problem,
and flat `*Cursor` names keep the 1:1 parity with the mode strings §9's
migration table leans on.

**Still open:** flat names settle the _form_ but not the **collision**.
`RegionCursor` / `RegionSelector` / `Region` (annotation) remain three flat names
in one namespace, and `mark` is still overloaded three ways (`<Marker>` the
annotation, `SelectInfo.mark` the identity, `StackMark` the internal). Since two
of the three colliding region names are **new**, renaming the incumbent
annotation is still the cheapest fix available while pre-1.0 allows it. **Q10
stays open on that narrower question.**

### A3.3 The region is **2-D** on scatter and heat map — this widens §8

> _"Scatter chart region select is 2d, so is heat map… drag to zoom behavior (2d
> on scatter and heatmap), 1d elsewhere."_

§8 assumed a sweep is an **x-span**. That is true for bars, lines, candles and
the list family, and **false for the two layers whose marks live in two
dimensions**. `selection.md` A4.4 Q14 flagged this as an open question ("x-only
or a 2-D rubber band?") and guessed it would be "a materially bigger thing and
probably its own RFC." It isn't a separate RFC — it is a **requirement of this
one**, and it lands on both region components:

|                    | 1-D (bars, lines, candles, lists) | 2-D (scatter, heat map)   |
| ------------------ | --------------------------------- | ------------------------- |
| `<RegionCursor>`   | x-span → zoom the view            | x+y rect → zoom both axes |
| `<RegionSelector>` | marks whose x falls in the span   | marks inside the rect     |

**The payload can no longer be a bare pair.** `onRegionSelect` reports
`readonly [number, number]` today (§6 preserves it). A 2-D region has no
faithful encoding in that shape. Proposed: **one uniform shape with an optional
y**, rather than a polymorphic union a consumer has to narrow —

```ts
interface RegionSpan {
  readonly x: readonly [number, number]; // axis units, as today
  readonly y?: readonly [number, number]; // present only on a 2-D drag
}
```

**And A2.4's descriptor needs the same treatment.** `SpanSelection` as proposed
carries a single `span`; a rect needs both axes, and the membership test becomes
two interval tests instead of one — still O(1) per mark, which is the property
that made the descriptor worth proposing:

```ts
interface SpanSelection {
  readonly id: string;
  readonly x: readonly [number, number];
  readonly y?: readonly [number, number];
}
```

**Two dimensions is not one thing, either.** Scatter is continuous × continuous;
a heat map is **binned x × ordinal rows**. The rect test is the same shape but
the indexing is not, and A2.4 already named the 2-D grid case as "the genuinely
new indexing work". This confirms it as **required rather than hypothetical** —
and the use-case review's arithmetic (the Niño grid at 365 × 45 = 16,425 cells)
is the case it has to survive.

**estela's constraint still holds and now matters more:** the 1-D zoom path
wants a cheap span and no enumeration. A 2-D rect must not drag a descriptor
into the 1-D path that never needed one.

### A3.4 The drag treatment is **per-layer** — which resolves Q11

> _"Heat map outlines a rect, scatter dims, as the region is dragged over it."_

Two layers, two idioms, same state. This settles **Q11** — the use-case review's
"where does a layer's own hover affordance sit?" — and it settles it in the
layer's favour:

**The library owns the _state_; the layer owns the _treatment_.** The frame
carries plural `hovered` (the marks a release would commit); each layer renders
that in its own vocabulary. A heat map outlines the covered rect because
[HeatMap.tsx](../../packages/charts/src/HeatMap.tsx) already reasons that "the
cell under the pointer takes an outline, which says both axes at once… the cell
outline is the whole affordance." A scatter **dims what is not covered**,
because with hundreds of overlapping discs, marking the excluded set reads
better than outlining the included one.

This is the existing `selected > hovered > dimmed > rest` precedence chain
(#606) applied per layer — not new machinery. What A2.8's Q11 asked for is the
**statement**, and it is this: a layer drawing its own live treatment is **not a
cursor** and does not compete with the pick-one rule. It is a layer rendering
container state, exactly as it already renders `selected`.

**It also retires the last of A4.2's phrasing.** "The bars under the sweep show
the hover treatment" was right about the state and too specific about the look —
there is no single sweep treatment to specify, only a per-layer one to theme.

### A3.5 Systematic Storybook coverage is a **shipping gate**, not a follow-up

> _"The implementation should be done with systematic storybooks demoing the full
> combination: selections and cursors, drag to zoom behavior (2d on scatter and
> heatmap), 1d elsewhere and so on across the whole api surface."_

This is CLAUDE.md's "Storybook stories: systematic feature coverage" rule
applied to the widest surface it has yet had to cover — and the rule earns its
keep here for exactly the reason it was written: the charts #325 → #326 fan-out
"immediately surfaced a dozen-plus real bugs that spot-check examples had
hidden." A combination this large is where a knob with no dedicated story is a
knob nobody discovers.

The matrix is the product of, at minimum:

- **cursor** — each preset × mounted-at-container vs mounted-in-row × none
- **selector** — none / `<Selector>` / `<RegionSelector>`
- **dimensionality** — 1-D (bars, lines, candles, lists) × 2-D (scatter, heat
  map)
- **gesture** — click, sweep, sweep + modifier, drag-to-zoom, and each against
  pan enabled and disabled
- **surface** — canvas layers **and** the list family (A3.1)

**No step of §10 counts as landed without its slice of that matrix.** The stories
are not documentation of the feature; on a combination surface they are the
review technique that finds the combination bugs — and `panZoom2D` silently
degrading on a category axis (A2.2) is the local proof.

### A3.6 Consequences for the sequencing

- **§8 / §10 step 5 widens** to cover 2-D. It was already blocked on Q12
  (span-minus-point); it is now additionally blocked on the 2-D descriptor shape
  and the grid indexing A3.3 confirms is required.
- **A conformance pass joins §10** — the list family (A3.1) plus the two layers
  from Q7 — so that "the same way across the whole API" is true when it freezes.
- **The Storybook matrix (A3.5) gates every step**, not the end of the project.

Nothing above changes §1–§7. The split, the mounted model, picking over
composing, and A1.2's state-on-the-container all stand as written.

## Amendment 4 (2026-08-08) — names settled, and the document wrapped

> _Naming dispositions by pjm17971, who reserves the right to decide it was a
> bad call later. This amendment closes Q6 and Q10 and consolidates four
> amendments' worth of decisions into one implementable surface — A4.2 is what
> an implementer should read; §1–§12 and A1–A3 are the reasoning behind it.
> Reading order: §1–§12 → A1 → A2 → A3 → **A4 is current**._

### A4.1 Q6 / Q10 resolved — the names

| component         | gesture                 | reports                                  |
| ----------------- | ----------------------- | ---------------------------------------- |
| `<Selector>`      | click (+ modifiers)     | **one** `SelectInfo \| null` + modifiers |
| `<MultiSelector>` | drag across, 1-D or 2-D | **many** `SelectInfo[]` + modifiers      |
| `<RangeCursor>`   | hover, and drag         | a **range** (`{ x, y? }`)                |

**`Region` stays the annotation.** The collision is resolved by moving the two
**new** names rather than renaming the incumbent — which was Q10's cheapest
option and needs no migration for anyone.

**Why `<RangeCursor>` is the strongest name in the set:** it is named for what
it emits, and what it emits is the shape the container already accepts —
`ChartContainer.range` is `readonly [number, number] | TimeRange`. Drag-to-zoom
becomes `onDragRelease={setRange}`. It also draws a real semantic line against
the annotation: **`Region` is a fixed mark at data coordinates; `Range` is a
live extent.**

**`<Selector>` / `<MultiSelector>` are named for payload cardinality** — one hit
versus many — which is the RFC's own naming principle (the one that dissolved
CATRANGE: name the payload, not the geometry). Recorded because it was
contested: an earlier round argued for `<SweepSelector>` on the grounds that the
gesture is invariant while a result count is not, and that `MultiSelector`
might read as a capability boundary — implying `<Selector>` cannot participate
in multi-selection, when a consumer building a multi-selection from
`<Selector>` + ⌘ is exactly what #606 shipped. **That misreading is a docs
problem, not a naming one**, and the payload difference is real: `<Selector>`
genuinely reports one hit, `<MultiSelector>` genuinely reports a list.

> **Cursor presets keep flat `*Cursor` names** (A3.2, no namespacing):
> `<LineCursor>`, `<PointCursor>`, `<InlineCursor>`, `<FlagCursor>`,
> `<CrosshairCursor>`, `<RangeCursor>`. The 1:1 parity with the mode strings
> they deprecate is what §9's migration table leans on.

### A4.2 The decided surface — read this, then the reasoning

Everything settled across §1–§12 and A1–A4, in one place:

```tsx
<ChartContainer
  range={view}                              // view window — unchanged
  selected={sel}                            // consumer-owned state (A1.2)
  hovered={hov}                             //   ⤷ NOT moved onto the selectors
  trackerPosition={t}                       // cross-chart sync — stays (Q4)
  onTrackerChanged={setT}
>
  {/* CURSORS — pick one, mount at container or in a row */}
  <CrosshairCursor snap showTime />
  <RangeCursor
    sequence={daily}                        // bucket shape + snap; omit ⇒ freeform
    enableDrag                              // defaults to !!onDragRelease; the OFF switch
    dragModifier="shift"                    // only enforced while pan is on
    onDragRelease={setRange}                // {x, y?} — y only on a 2-D drag
  />

  {/* SELECTORS — pick one; mounting is what enables the plot gesture (§7.1) */}
  <Selector      onHover={(hit)  => …} onSelect={(hit,  mods) => …} />
  <MultiSelector onHover={(hits) => …} onSelect={(hits, mods) => …} sequence={daily} />

  <ChartRow>
    <YAxis … />
    <Layers><BarChart id="a" … /></Layers>
  </ChartRow>
</ChartContainer>
```

**The rules that govern it:**

1. **Mounting enables the gesture; the container holds the state.** A
   `<Selector>` must be mounted for a plot click to do anything (§7.1) —
   controlled highlighting via `selected`/`hovered` keeps working without one
   (A1.2). The dev warning suppresses when `selected` is supplied (A2.6).
2. **The library reports; the consumer decides.** One hit or many, plus the
   modifiers held. pond applies no policy to ⌘ or shift and holds no set (A4.1
   of `selection.md`).
3. **A layer `id` is identity; the mount is enablement.** An untagged layer is
   never hit-tested, so `SelectInfo.id` is never undefined — "nothing here" is a
   null hit (Q8).
4. **Cursors are picked, not composed** (§4), with a documented contract for the
   one you have to build yourself (§5 / A2.3) — render slots, resolved
   geometry, **declared** snap. Container resolves; slots draw.
5. **One cursor owns snap and gesture**, resolved to the hovered row's innermost
   mount; render-only presets may stack (A2.5). A layer drawing its own live
   treatment is **not** a cursor (A3.4).
6. **Dimensionality follows the layer**: 1-D for bars, lines, candles and lists;
   2-D for scatter and heat map — for both zoom and select (A3.3).
7. **The layer owns the treatment**: heat map outlines the covered rect, scatter
   dims what is not covered, bars use the `selected > hovered > dimmed > rest`
   chain. Same state, per-layer vocabulary (A3.4).
8. **One brush engine owns every drag claim** — pan included — rather than
   today's ad-hoc ordering in `handlePointerDown` (A1.5 / A2.7).
9. **The whole API speaks this**, lists included (A3.1).

### A4.3 Still open — and what each one blocks

| #       | question                                                                                                                                                                                                                                                                 | blocks        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| **Q12** | **Span-minus-point.** ⌘-clicking a mark _out_ of a span selection is not representable in `(SelectInfo \| SpanSelection)[]` without an exclusion channel or a documented replace-after-sweep rule. Decides whether the descriptor can be the round-trip currency at all. | A2.4 → step 5 |
| **Q13** | **The 2-D descriptor shape.** `{ x, y? }` is proposed (A3.3) for both the payload and `SpanSelection`; unvalidated.                                                                                                                                                      | step 5        |
| **Q14** | **Grid indexing.** Confirmed required, not hypothetical — the 16,425-cell case (A2.4/A3.3).                                                                                                                                                                              | step 5        |
| Q2      | Multiple render-only cursors — allowed, with one gesture owner (A2.5). Formulation settled; unexercised.                                                                                                                                                                 | —             |
| Q3      | When the cursor contract goes public. Litmus order adopted (A2.3): flag cursor → our crosshair with zero mode-string gates → SR's.                                                                                                                                       | step 6        |
| Q4      | Do the tracker props follow the cursors out? Proposed **no**.                                                                                                                                                                                                            | —             |

Q12 is one decision, not a project, and it is the critical path. Q13 and Q14
are design work that cannot start until it lands.

### A4.4 Order of work

1. **`hovered` widened to a set** — written and pushed, unblocked by everything
   above.
2. **Cursor components + the deprecation shim** — mechanical; presets register
   the specs `Layers` already reads. Deletes the `<XAxis>` string-gate seam
   (A2.2) as a side effect.
3. **`<RangeCursor>`** — absorbs the drag props with honest names.
4. **`<Selector>`** — the #606 surface re-homed, plus §7.1's warning.
5. **`<MultiSelector>`** — the genuinely new capability. **Blocked on
   Q12 → Q13 → Q14.**
6. **Publish the cursor contract** — after our own cursors are written against
   it (Q3).
7. **Conformance pass** — the list family (A3.1) and the two layers still
   reading a single selection (Q7).

**Every step carries its slice of the Storybook matrix** (A3.5) — cursor preset
× mount point × selector × dimensionality × gesture × surface. A step without
its stories is not landed. Steps 2–4 are each shippable behind the shim, which
is what turns one breaking release into several additive ones.

## Amendment 5 (2026-08-08) — Q12 resolved: both currencies, demote on edit

> _Analysis by a **Fable agent**, commissioned to settle Q12; adopted by
> pjm17971. Q12 was the critical path — it decided whether a compact descriptor
> can be the round-trip currency for sweeps. Reading order: §1–§12 → A1 → A2 →
> A3 → A4 → **A5 is current**._

### A5.1 The two options the RFC named were both wrong

**(a) The exclusion channel is _incorrect_, not merely costly.** A2.4 and A4.3
offered `SpanSelection.exclude?: SelectInfo[]` as a live candidate. It fails on
**overlapping additive sweeps**: a mark excluded from span A is still inside
span B, so union semantics silently re-include it. Per-span exclusion is
therefore wrong, and the repair — a single global exclude list — turns
`selected` into an **include/exclude algebra pond has to evaluate**, which is
set arithmetic encoded in the data structure and against A4.1's grain. Follow it
one step further (⌘-drag to remove a _range_) and the type goes recursive.

It also reintroduces the very friction the marks-currency was built to kill: the
consumer has to work out **which** span contains the clicked mark,
re-implementing the interval test in axis units — the inverse-band-scale problem
that `selection.md` A4.2 named as the whole reason to report marks. Killing it
on the click path and reinstating it on the edit path is no improvement.

**(b) "Replace after a sweep" fails the workload that motivated sweeps.** Under
A4.1 pond cannot _enforce_ replace anyway — it would be documentation asking
consumers not to want the thing. And the driving case wants exactly the thing: a
terminal sweeps a session of bars, then knocks two outliers out of the
selection. Replace vaporises the sweep on the first ⌘-click.

### A5.2 Adopted: (d) both currencies, demote on edit

The sweep's commit reports **the marks and the span**. A span is editable **only
as a whole**; to edit _inside_ one, the consumer swaps the span entry for the
hits it stashed at commit time and filters — plain array arithmetic, no algebra,
and pond still computes no policy.

```ts
interface SpanSelection {
  readonly kind: 'span';
  readonly id: string; // the layer, as ever
  readonly x: readonly [number, number]; // axis units
  readonly y?: readonly [number, number]; // continuous 2-D (scatter)
  readonly rows?: readonly string[]; // ordinal 2-D (heat map)
}
type SelectionEntry = SelectInfo | SpanSelection;

// ChartContainer — the union widens once more, still non-breaking
selected?: SelectInfo | readonly SelectionEntry[] | null;

// <MultiSelector> — marks stay the currency (A4.2); the span rides along
onSelect?: (
  hits: readonly SelectInfo[],
  modifiers: SelectModifiers,
  span: SpanSelection,
) => void;

// exported: the same predicate the layers run, so consumers never
// re-implement the interval test
function selectionContains(
  sel: readonly SelectionEntry[],
  hit: SelectInfo,
): boolean;
```

**The hits are free at commit time.** A1.4's delta-tracked live preview _is_ the
materialised set, so emitting them on release costs an array copy rather than a
range query. Consumers who never sweep see no change at all — the 0-1-mark case
keeps the existing linear short-circuit.

**Per-repaint cost:** a span entry is one or two interval tests, O(1) per mark;
mark entries keep today's linear scan, whose `bars.ts` comment ("a selection is
a handful of marks a person clicked, not a data structure") stays true because
sweeps no longer produce mark entries.

### A5.3 This corrects A3.3 — the heat map's second axis is not an interval

A3.3 proposed a uniform `{ x, y? }` for both 2-D layers. **That is wrong for the
heat map**, and the mistake was assuming "2-D" names one shape.

A heat-map cell's second coordinate in `SelectInfo` is its **ordinal `label`** —
`heat.ts` matches on `mark`/`label`, not a slot index. A numeric y-interval would
therefore be **untestable from a hit** (there is no number on the hit to test)
and **unstable under reorder** (slot indices renumber; the whole point of
mark-identity is that they don't). Hence the third field, `rows?: readonly
string[]`.

So: **scatter is continuous × continuous and fits an interval; the heat map is
continuous × ordinal and does not.** Only the first of the two 2-D layers takes
`y`.

### A5.4 What this forecloses — stated before it bites

- **Live durability across an edit.** A demoted span is frozen marks, so bars
  streaming into the original range are **not** selected. Only an exclusion
  algebra keeps "this range, minus these prints" live under new data, and A5.1
  is the reason we are not having one. A streaming consumer must re-sweep or
  re-derive.
- **Richer shapes as round-trip currency.** Every new entry `kind` is a
  membership test **every** layer must implement; that conformance matrix should
  stay at two. A future lasso commits marks, not a `LassoSelection`.
- **Eager hits on release.** The signature pins the preview machinery to
  maintaining a materialised set. A million-point canvas wanting a
  never-enumerate release path would need a breaking lazy accessor.

### A5.5 What it unblocks

**Q12 closed. Q13 closed** — A5.2's types are the 2-D descriptor shape, with
A5.3's correction. **Q14 (grid indexing) remains open** and is now concrete
rather than hypothetical: the heat map needs a range query over binned-x ×
ordinal-rows, against the 16,425-cell case.

The descriptor is also **separable from the gesture**: `SelectionEntry`,
`selectionContains`, the container normalisation, and each layer's span-aware
membership test can land **before** `<MultiSelector>` exists, tested by passing
spans through the controlled `selected` prop. That makes it a step of its own,
between §10's steps 4 and 5.
