# Container Decomposition — `<Domain>`, and where chart props actually live

**Status:** planning note. Nothing here is committed.

**Relationship to PLAN.md:** This RFC is strategic context, not a
commitment. [PLAN.md](../../PLAN.md) is the binding source of truth for what
is actually being built; anything adopted into PLAN is a commitment, and the
rest of this document is forward-looking. See
[CLAUDE.md → Strategic RFCs](../../CLAUDE.md) for the layering.

**Authorship:** developed in conversation. Each section carries inline
attribution; this table is the index for cold readers.

| Section                                              | Contributor                    |
| ---------------------------------------------------- | ------------------------------ |
| The actual decision (supersedes §1–§7's framing)     | pjm17971                       |
| §1 The symptom                                       | pond-ts library agent (Claude) |
| §2 The test that finds the boundary                  | pjm17971 (framing) + Claude    |
| §3 The proposed shape                                | pjm17971                       |
| §4 The partition                                     | pond-ts library agent (Claude) |
| §5 Annotations are layers                            | pjm17971 (framing) + Claude    |
| §6 What it eliminates / §7 What it unlocks           | pond-ts library agent (Claude) |
| §8 What it costs                                     | pond-ts library agent (Claude) |
| §9 The cheap alternative                             | pjm17971 (framing) + Claude    |
| §10 Open questions / §11 Non-goals                   | pond-ts library agent (Claude) |

**Audience:** future contributors deciding whether `<ChartContainer>` should
be split, and if so where the seams go. Also the record of *why* the current
shape drifted, which matters more than the proposal.

**Thesis:** `<ChartContainer>` carries **38 props** covering four unrelated
responsibilities. That is not the result of bad decisions — each prop went
there for a locally correct reason. It is the result of there being **no
component named for the thing most of them describe**. A mechanical test
("does this prop define the mapping or the domain?") partitions the 38 almost
perfectly, and the group it isolates is large enough (24 of 38) to deserve a
name. Calling it `<Domain>` makes the shared-x layout requirement
**syntactic** instead of a comment, and removes two tracked bugs by
construction rather than by fixing them.

**But the design case is the easy half, and this RFC deliberately leads with
the wrong question.** See "The actual decision" immediately below, which
supersedes the framing of §1–§7.

---

## The actual decision

_pjm17971_

> I doubt this is as much about being right as it is about deciding if such a
> large change is possible. Selection model changes last week weren't a big
> deal because selections are an opt-in feature that most people never use.
> Useful to those that do. This breaks every chart ever written. But we're
> pre-1.0 for exactly this reason. So in the end that's probably the call.

This reframes the document. §1–§7 argue that `<Domain>` is *correct*, and
that argument is largely settled — the partition in §4 is exhaustive and
checkable, and §5 closes the recursion. **Correctness is not the constraint.
Blast radius is.**

**The calibration that matters, and it corrects a false comfort in §8.** That
section cites [PND-INTERACT] as precedent: thirteen props migrated behind
deprecation shims kept for one minor, and it worked. But it worked because
**selection is opt-in and most consumers never touched it** — a small blast
radius wearing a large diff. Shims were not what made it cheap. Reading it as
"we have done migrations of this size before" is exactly the wrong lesson,
and §8 half-invites that reading.

This is a different category:

| | reach |
| --- | --- |
| [PND-INTERACT] (selection) | consumers who opted into selection |
| `<Domain>` | **every chart ever written** |

There is no opt-out and no shim that expresses it, because the change is to
the component tree rather than to props on a component.

**Pre-1.0 is the answer to "are we allowed."** That is precisely what the
window is for, and it is the strongest argument in the document — stronger
than anything in §1–§7, because it addresses the real objection rather than
the design.

**It also means the option expires.** Post-1.0 this becomes a v2 migration,
which in practice means never. So the decision is not "is `<Domain>` worth
doing" evaluated in the abstract; it is "is `<Domain>` worth doing **while we
still can**," and every release closer to 1.0 raises the price. That
asymmetry should be weighed explicitly, because "not now" and "no" are the
same answer here.

The consequence for §9: if the call is yes, `xAxis="auto"` is not a
competing option, it is **wasted work on a prop that stops existing** — and
worse, it spends the goodwill of a breaking change on the wrong break. Decide
this first.

---

## §1 The symptom

_pond-ts library agent (Claude)_

`ChartContainerProps` has 38 fields. Four landed in the last week alone
(`xScale`, `categories`, `width`, plus `useChartFrame()` publishing container
geometry). Nothing about that week was careless — every one of the four had a
consumer behind it and a defensible home.

The symptom is not the count. It is that **three tracked issues are all the
same shape**, and all three are the container doing something the declaration
never asked for:

- **[PND-XAXISOWN]** — the container renders an x-axis strip nobody
  declared, so mounting `<XAxis>` gives you two. Three independent sightings.
  The tell: every story in `Axes.stories.tsx` passes `showAxis={false}` to
  work around the default.
- **[PND-AXISGUT]** ([#607]) — that same implicit strip does not participate
  in layout, so callers hand-subtract its height. A consumer got the
  subtraction wrong and shipped overlapping labels.
- **Friction #24** — `Layers.tsx` computes
  `editingActive = container.editAnnotations || container.annotations.some((a) => a.editing)`
  and forces `cursorParts('none')`. One `<Marker editing>` silently kills
  hover readouts for **every layer in the row**.

Each has a local fix. The observation this RFC rests on is that the local
fixes are all patching the same underlying fact: the container is the only
object in scope, so anything shared ends up on it, whether or not it belongs
to the same concern.

## §2 The test that finds the boundary

_pjm17971 (framing) + pond-ts library agent (Claude)_

This came out of correcting a **circular justification** the library shipped
in [#653]. Asked why the log-scale prop went on the container rather than
`<XAxis scale>`, the TSDoc said:

> there is one x scale shared by every row, and the container builds it

The second clause is an implementation fact standing in for a reason — it
builds it because we put it there. It would read identically if the decision
had been wrong.

The non-circular version is a **layout requirement**:

> The rows are stacked vertically, so a given pixel column must mean the same
> x in every one of them — otherwise the stack does not line up and a cursor
> at one pixel reads a different value per row.

`<YAxis>` is the genuine opposite for the same reason: each row carries its
own quantity, so its scale *must* be per-row. The asymmetry between the two
axes is forced by the layout, not chosen.

That yields a mechanical test:

> **Does this prop define the mapping or the domain?**
> If yes, it must be shared across stacked rows, and belongs to whatever
> owns the shared x. If no, it does not have to be shared, and the burden
> is on it to justify living on a shared object.

The test was derived to settle one prop. It turned out to partition all 38,
which is the actual finding — and the reason this RFC exists rather than a
one-line doc fix. A test that only explains the decision you already made is
worth nothing; this one made predictions about props nobody was arguing
about.

It also confirmed itself in the plumbing, which is worth more than the
argument: **`<YAxis>` registers with its row** (`registerAxis` in
`ChartRow.tsx`) because it defines a scale the row needs. **`<XAxis>`
registers with nothing** — it only reads context, because it defines nothing.
The codebase already sorted the two axes the way the test does.

## §3 The proposed shape

_pjm17971_

```tsx
<ChartContainer width="auto">
  <Domain range={series.timeRange()} scale="linear" calendar={tradingDays}>
    <ChartRow>…</ChartRow>
    <XAxis format={formatter} label="Time" align="center" />
  </Domain>
</ChartContainer>
```

The move is not "fewer props." It is that **the scope of sharing becomes the
JSX nesting.** §2's layout requirement is currently a comment in a TSDoc
block; here a reader sees it in the markup and needs no rationale. `<Domain>`
wraps exactly the rows over which x is shared, and `<XAxis>` is a declared
sibling of those rows — placed by declaration order, which is already how
`side` works today.

## §4 The partition

_pond-ts library agent (Claude)_

Applying §2's test to all 38 props. This is the concrete claim; it is
checkable and it is where the proposal earns or loses.

| Destination                       | Props                                                                                                                                       | n     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| **`<Domain>`** — mapping + domain | `range` `categories` `xScale` `calendar` `spacing` `discontinuities` `bandAlign` `maxBandWidth` `origin` `snap` `panZoom` `bounds` `minDuration` `onTimeRangeChange` | 14    |
| **`<Domain>`** — shared-x effects | `cursor` `cursorSequence` `trackerPosition` `onTrackerChanged` `cursorTime` `crosshairSnap` `grid` `sessionDividers` `timeFormat` `cursorFormat` | 10    |
| **`<Layers>`** — see §5           | `editAnnotations` `creating` `onCreate` `onSelectAnnotation` `onHoverAnnotation` `onEditAnnotation`                                          | 6     |
| **`<ChartContainer>`** — the box  | `width` `rowGap` `theme` `children` `onDrawStats`                                                                                            | 5     |
| **deleted**                       | `showAxis` (§6)                                                                                                                             | 1     |
| **already deprecated**            | `onRegionSelect` `regionSelectModifier`                                                                                                     | 2     |
|                                   |                                                                                                                                             | **38** |

The container keeps **5 of 38**, and the five are coherent: the box, its
theme, its children, its row spacing, and a draw-stats hook.

The second Domain group is the one to argue with. `grid`, `timeFormat` and
`sessionDividers` are presentational, so they fail a naïve reading of the
test. They are grouped here because each is *derived from* the shared x — the
gridlines sit on its ticks, the format renders its values, the dividers come
from its calendar. A presentational prop that cannot be evaluated without the
shared scale is scoped by that scale whether or not it defines it. **If that
reasoning is wrong, this group is the RFC's weakest joint** and should be
attacked first.

`width` is worth calling out for the opposite reason: it is neither mapping
nor domain, and under today's API that makes it an anomaly on a container
otherwise full of scale props. Under this split it stops being an anomaly and
becomes the container's actual job. That the test explains an existing
oddity, rather than needing an exception for it, is mild evidence the seam is
real.

## §5 Annotations are layers

_pjm17971 (framing) + pond-ts library agent (Claude)_

The observation that makes the decomposition close. Six annotation props sit
on the container; `<Marker>`, `<Zone>` and `<Region>` are declared components
that read `RowContext` and mount **inside a row** — structurally, they are
already layers.

They register with the container, and there is a real mechanism reason, not
accretion. From `context.ts`:

> annotations register it so the container can draw a mark's guide on the
> _other_ rows (a row skips its own marks)

A marker declared in row 1 drops a guide line down rows 2..n. The state is
hoisted so the projection has somewhere to live.

**That reason does not defend the container — it argues for `<Domain>`.** A
vertical guide at x=T across rows is only coherent where x is shared, which
is exactly what `<Domain>` scopes. So the cross-row half lands *inside* the
proposal rather than against it:

- **the mark** is a layer → `<Layers>`, beside `<LineChart>` and the rest
- **the guide projection** is Domain-scoped, because shared-x is what makes
  it mean anything
- the container sheds all six props

This section is load-bearing for the whole RFC. Before it, the decomposition
had no natural stopping point — annotations, cursors and selection formed a
third cluster that was neither box nor domain, and "why is `editAnnotations`
on the container?" had no better answer than "where else?". With annotations
resolved as layers and cursors resolved as shared-x effects (§4), every prop
has a home and the recursion terminates:

| level               | owns                                                       |
| ------------------- | ---------------------------------------------------------- |
| `<ChartContainer>`  | the box — `width`, `theme`, `rowGap`                       |
| `<Domain>`          | shared x — scale, domain, viewport, cross-row projections  |
| `<ChartRow>`        | y scales                                                   |
| `<Layers>`          | marks, annotations among them                              |

**It also fixes Friction #24 by construction.** Today a per-mark `editing`
prop has a row-wide consequence because the container is the only place the
state can live, so `Layers.tsx` reads it globally. With the mark as a layer,
the scope is explicit and the non-local surprise stops being expressible. The
current plan entry proposes documenting this behaviour; under §3 there is
nothing to document.

## §6 What it eliminates

_pond-ts library agent (Claude)_

**[PND-XAXISOWN] and [PND-AXISGUT] cease to exist** rather than getting
fixed. With `<XAxis>` a declared sibling inside `<Domain>`, there is no
implicit strip: nothing to collide with, no `showAxis`, no height to
hand-subtract, and no detection problem (below).

That last one matters, because the cheap fix in §9 has a genuine
implementation wrinkle and this design does not. Making a mounted `<XAxis>`
win requires the container to *detect* one, and today nothing can — `<XAxis>`
registers with nothing (§2). Two routes, both with costs:

- **Scan `children` synchronously** (`React.Children`, compare element type)
  — no flash, no registration, but sees only *direct* children. An `<XAxis>`
  inside a consumer's own wrapper is invisible and silently yields two axes
  again: the same failure, rarer and harder to diagnose.
- **Register in an effect** — sees any depth, but the container renders its
  implicit axis on pass one and drops it on pass two: a flash plus layout
  shift on every chart.

Under §3 the question does not arise. A declared axis is visible in the
declaration.

## §7 What it unlocks

_pond-ts library agent (Claude)_

**Multiple domains in one container.** Two `<Domain>` elements = two
independent x scales stacked in one chart. Today this is a hard error — a
container throws on a mixed `xKind`, and `ChartContainer.tsx` documents that
as deliberate.

Worked example: a trading-days price series above a calendar-days macro
series. Currently unbuildable without two containers, which then cannot share
width, theme, or a synchronized cursor.

**Honest caveat:** this is a capability the design falls out of, not a
demand anyone has filed. It should be weighed as a tiebreaker, not a
justification. If it turns out to be the main argument, the RFC is weak — see
§10.

## §8 What it costs

_pond-ts library agent (Claude)_

- **Every consumer's markup changes.** Not a type widening or a deprecation
  shim — a structural edit to every chart in every codebase.
- **Every story, every doc, every gallery card, the entire website.** The
  charts package alone has a large story tree, and the docs site is built
  from live examples.
- **An extra nesting level for the simple case.** "Hello world" gets deeper,
  which is a real DX cost paid by every new user to buy correctness most of
  them will never think about.
- **`useChartFrame()` just shipped** ([PND-IGNITEFRAME], this week)
  publishing resolved container geometry as public API. This RFC moves who
  owns that geometry. Either the hook's shape changes one release after
  shipping, or it keeps a container-shaped surface over a decomposed
  implementation. Neither is free, and the timing is unfortunate.
- **The interaction wave is _not_ usable precedent** — see "The actual
  decision" above. [PND-INTERACT] migrated thirteen props behind deprecation
  shims for one minor, but it was cheap because **selection is opt-in and
  most consumers never touched it**: a small blast radius wearing a large
  diff. This change reaches every chart, and shims cannot express a change to
  the component tree. Citing it as "we have done this before" is the wrong
  lesson.

Pre-1.0 permits the break. The question is whether it earns one of this size
— and, per "The actual decision", whether it earns one *now*, since the
permission expires at 1.0.

## §9 The cheap alternative

_pjm17971 (framing) + pond-ts library agent (Claude)_

The most-felt symptom has a one-day fix, and it should be understood as a
genuine competitor rather than a stopgap:

```tsx
<ChartContainer xAxis="auto" />  // default; "hide" opts out
```

The reasoning that got here is worth preserving, because it **corrects an
earlier overstatement in this same conversation.** The library agent argued
`showAxis` was "on the wrong object" — presentation that had landed on the
container merely because it was x-shaped. pjm's correction:

> Hard to say the default in a time series visualization library is no time
> axis.

Which kills the claim. A default can only live on the thing that exists when
nothing is declared; you cannot hang "should there be an axis" on a component
nobody mounted. `showAxis` is on the **right** object. What is wrong is its
**shape** — a boolean cannot express "auto", so it has to mean "always", and
"always" is what collides with a mounted `<XAxis>`.

`xAxis="auto" | "hide"` also mirrors `width="auto"`, which is not decoration:
both are the container absorbing a job every consumer was doing badly, with
`"auto"` naming the let-the-library-decide branch. The wrapper alternative
fails identically in both cases — a `<ResponsiveChart>` or `<DefaultAxes>`
wrapper is discoverable only by reading docs, whereas a default is
discoverable by doing nothing.

**The two options are mutually exclusive in practice.** If §3 lands,
`xAxis="auto"` was wasted work — the prop it fixes stops existing. If §3 does
not land within a couple of releases, `xAxis="auto"` should be built
immediately, because three sightings is enough.

This is the decision the RFC exists to force. It is a scheduling question,
not an aesthetic one.

## §10 Open questions

_pond-ts library agent (Claude)_

Genuine uncertainties, not rhetorical ones. Reviewers should start here.

**Two feasibility questions outrank everything below**, per "The actual
decision". The design questions are tractable; these decide the outcome.

- **A. How many charts exist to break? — measured 2026-08-13.** Counting
  *opening tags only*, brace- and string-aware, excluding `node_modules`,
  `dist` and `build`:

  | codebase                    | sites   | files   | spread props |
  | --------------------------- | ------- | ------- | ------------ |
  | `packages/` (story tree)    | 690     | 141     | **27**       |
  | `website/` (docs, examples) | 206     | 134     | 1            |
  | estela (real consumer)      | 14      | 11      | 0            |
  |                             | **910** | **286** | **28**       |

  _(A naive `grep -c` reports 958/315; the delta is build artefacts the
  walk excludes. Closing tags do **not** inflate it — `</ChartContainer>`
  does not match the pattern.)_

  Three consequences, and they are the RFC's most load-bearing facts:

  1. **A codemod is a precondition, not an open question.** 910 hand-edits
     will not happen. §10.6 is therefore promoted: if a codemod cannot do
     the common case, the answer to this RFC is no, independent of §1–§7.
  2. **28 sites spread props onto the container**, e.g.
     `<ChartContainer width={W} showAxis={false} {...props}>`. **A codemod
     cannot split those** — it cannot know statically whether `props`
     carries `range` (moves to `<Domain>`) or `theme` (stays). Each is a
     hand edit or needs a runtime shim. Mitigating: **all 28 are ours**
     (story helpers and fixtures), and estela has **zero** — so the hazard
     is concentrated exactly where we control it, and the pattern to check
     for in external code is now known.
  3. **98% of the blast radius is ours, which cuts _for_ the change.** 896
     of 910 sites are pond's own stories and docs. estela — a real consumer
     of six months — is **14 sites in 11 files**, and uses only six
     container props (`theme`, `width`, `range`, `showAxis`, `origin`,
     `onTrackerChanged`, plus `cursor`), of which four move. That is an
     afternoon, not a migration. External consumers are a smaller set today
     than they will ever be again — the expiry argument from a second
     direction.
- **B. How long is the pre-1.0 window, honestly?** The option expires at 1.0.
  If 1.0 is far off, this can wait for demand; if it is near, "later" means
  "never" and the decision is now. That date is not this RFC's to set, but
  the RFC cannot be judged without it.

Design questions, in rough order of how much damage a wrong answer does:

1. **Is `<Domain>` optional?** If it can be omitted for the simple case, the
   container must supply an implicit one — and we have reinvented exactly the
   implicit-vs-declared problem §6 claims to kill, one level up. If it is
   mandatory, every chart pays the nesting. **There may be no good answer
   here, and if so that is close to fatal.**
2. **Is §4's second group right?** `grid`, `timeFormat`, `sessionDividers`
   are presentational-but-scale-derived. If that category does not hold, ten
   props have no clear home and the partition is much less clean than
   claimed.
3. **Does multiple-domains have real demand?** §7 is a falling-out, not a
   request. If nobody wants it, one of the two positive arguments evaporates.
4. **What happens to `useChartFrame()`?** It publishes container geometry and
   shipped days ago (§8).
5. **Do two domains share one `<XAxis>` or get one each?** Probably each, but
   the shared-cursor story across domains is undesigned.
6. **Can the migration be mechanical?** A codemod that wraps rows in
   `<Domain>` and moves ~24 props is plausible for the common case and
   probably not for charts that compute props conditionally. Without a
   credible codemod, §8's cost estimate is optimistic.
7. **Is "the container is the only object in scope" actually the cause?**
   §1 asserts this. It fits three data points. Three is not many.

## §11 Non-goals

_pond-ts library agent (Claude)_

- **Not a rename-only exercise.** If the outcome is `<Domain>` with the same
  38 props reachable from the same place, nothing was gained.
- **Not y-axis symmetry.** `<YAxis>` is per-row *by requirement* (§2); making
  x and y look alike for tidiness would break the thing the asymmetry
  encodes.
- **Not a v1.0 gate.** This can land pre-1.0 or never; it is not on the
  critical path to a stable release.
- **Not an argument that the current API is bad.** Every prop went where it
  went for a locally correct reason. The claim is narrower: there was no
  component named for what most of them describe, so they went to the only
  object in scope.

---

## Review notes

_Reviewers: append your section below with inline attribution, following the
`streaming.md` convention — layer responses as new sections rather than
editing the above, so the contributor chain stays visible for cold readers._

[#607]: https://github.com/pond-ts/pond/issues/607
[#653]: https://github.com/pond-ts/pond/pull/653
