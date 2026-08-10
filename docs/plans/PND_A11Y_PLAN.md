# PND_A11Y_PLAN — accessibility audit and fixes, library-wide

> Breakout plan for the **Accessibility** section in [PLAN.md](../../PLAN.md).
> Interaction design: [docs/rfcs/interaction.md](../rfcs/interaction.md).

Pond's interaction surface has grown one gesture at a time — cursors,
selection, the sweep, the 2-D rect, the list range gesture — and each landed
with its own keyboard story or none. Nobody has yet looked at the **whole**
surface from a keyboard or a screen reader and asked what it announces. This
plan is where that audit accumulates.

**The standing rule that produced it:** a feature is not finished because a
sighted mouse user can drive it. The specific trap this plan exists to break
is the one below — selection now _exists_ on the list family and a screen
reader cannot hear it, which was noticed only because the pointer work forced
a keyboard pass right after it.

**Method.** Audit per surface, not per component: what does a keyboard user
do here, what does a screen reader say, and what does the DOM claim. Record
findings here as they are found — including the ones deliberately not fixed,
with the reason — so a later pass does not re-derive them. Fixes land as
their own PRs; this file is the register, not the changelog.

## Findings

### The list family: selection exists and is inaudible

Found 2026-08-10, while landing the list range gesture and its keyboard
parity ([PND-INTERACTCONF]). Both `<BarList>` and `<BoxList>` now support
single and multi-row selection by pointer and keyboard, and **none of it is
exposed to assistive technology.**

**`aria-selected` is not valid on a plain `<tr>`.** The list renders a real
`<table>`, whose implicit role is `table`, and a `<tr>`'s implicit `row` role
only supports `aria-selected` inside a `grid` or `treegrid`. So the state that
paints as a band and a rail has no programmatic equivalent at all: a screen
reader user can move through the rows and select them and never be told which
are selected.

**Why it was not fixed in the same pass, and this is the load-bearing part.**
The obvious repair is `role="grid"` on the table, which makes `aria-selected`
valid on the rows. But `grid` promises **cell-level** navigation — Left/Right
between cells, and the whole
[ARIA grid pattern](https://www.w3.org/WAI/ARIA/apg/patterns/grid/) around it —
and the list implements row-level arrows only. Promoting the role without the
navigation tells assistive technology a lie about what the widget can do,
which is worse than the current silence: a user who is told this is a grid
will try to navigate it as one.

So the honest options are both bigger than a prop:

1. **Implement the grid pattern properly** — cell focus, Left/Right, the
   `role="grid"` + `aria-multiselectable` + `aria-selected` triple. Most
   faithful to what the list already is (a table of data cells), and the most
   work.
2. **Rebuild the interactive list as `role="listbox"`** with rows as
   `option`s. `aria-selected` is native there and the row-level arrows the
   list already has are exactly the listbox pattern. But it discards table
   semantics — the thing the list family exists for ("Renders a real
   `<table>` — the point of the list family is table semantics") — and a
   listbox option is not supposed to contain a grid of cells.

Neither is a small change and the choice is a real design decision, so it
wants deciding rather than defaulting.

**Also open on the same surface:**

- **No roving tabindex.** Every interactive row is `tabIndex={0}`, so a
  100-row list is 100 tab stops. Both patterns above make one row tabbable
  and let the arrows do the rest. Worth noting this is a **behaviour change**
  for anyone tabbing through rows today, not a pure improvement.
- **The drag-range gesture is pointer-only by design**, and touch is
  excluded deliberately (a vertical drag over a list is how a touch device
  scrolls). Keyboard parity covers the keyboard; **touch has no range
  affordance at all** — a long-press or an explicit multi-select mode is
  unbuilt. That is an accessibility gap as much as a feature gap: on a
  touch-only device the multi-select is unreachable.
- **Focus visibility.** Rows rely on the UA focus ring. It has not been
  checked against the selection band and rail — a ring that reads as
  "selected" or disappears against `selectedBand` would make the keyboard
  path ambiguous exactly when it matters.

### The canvas: not yet audited

`<ChartContainer>` and the layer stack are a `<canvas>` with pointer
handlers. Selection, the sweep, the 2-D rect, pan/zoom and the cursors are
all mouse-driven, and there is no keyboard path to any of them. What a
screen reader should be told about a chart at all is a design question this
plan has not opened yet — the honest first step is an inventory of what
exists, not a fix.

Recorded here so the audit's scope is not silently "the lists".

## Tasks

_None yet — the audit's first pass is the finding register above. Fixes
become `[PND-XXXXXX]` tasks in [PLAN.md](../../PLAN.md) once the decisions
they depend on are made._
