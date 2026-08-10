# PND_A11Y_PLAN — accessibility audit and fixes, library-wide

> Breakout plan for the **Accessibility** section in [PLAN.md](../../PLAN.md).
> Interaction design: [docs/rfcs/interaction.md](../rfcs/interaction.md).

Pond's interaction surface has grown one gesture at a time — cursors,
selection, the sweep, the 2-D rect, the list range gesture — and each landed
with its own keyboard story or none. This plan is the register for a
library-wide audit of the whole thing.

**The standing rule that produced it:** a feature is not finished because a
sighted mouse user can drive it. The trap it exists to break is the one below —
selection now _exists_ on the list family and a screen reader cannot hear it,
noticed only because the pointer work forced a keyboard pass right after it.

**Method.** Audit per surface, not per component: what can a keyboard user do,
what does a screen reader hear, and what does the DOM claim. Record findings
here as they are found — **including the ones deliberately not fixed, with the
reason** — so a later pass does not re-derive them. Fixes land as their own
PRs; this file is the register, not the changelog.

**Provenance.** First pass 2026-08-10: three parallel read-only audits (list
family / canvas surface / theme contrast + tooling), integrated here. Findings
are marked **Verified** (confirmed against the code or computed) or
**Suspected** (needs a real screen reader, a browser, or a measurement). Do not
promote a Suspected finding without checking it — one claim in this file's first
draft was wrong (see _Corrections_).

## Corrections to earlier claims in this file

- **`aria-selected` is _not_ invalid on a `<tr>`.** The first draft of this
  register said it was, and repeated it. It is in fact a **supported property
  of role `row`** — but it is
  [_"only relevant if the row is in an interactive container, such as a grid or
  treegrid, but not relevant if the row is in a table"_](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/row_role).
  So on our `role=table` it is **legal and inert**, not invalid — setting it
  would be silent rather than broken, and `role=table` has no home for
  `aria-multiselectable` either. The conclusion survives unchanged (do not
  claim `role=grid` without the navigation it promises), but the reason is
  "announces nothing", not "is forbidden". **Verified** against MDN; the
  normative ARIA text is worth quoting directly before anyone acts on it.

## The list family

`<BarList>` / `<BoxList>` / `ListTable` — a real `<table>`, deliberately.

### Fixed in the same pass as the audit

- **The row stole its children's keys.** `keydown` bubbles, so a key pressed on
  the expander `<button>` reached the row's handler, which `preventDefault`ed
  Enter/Space and selected the row instead of expanding it — and a cancelled
  keydown also suppresses a button's own Space activation. Arrows yanked focus
  out of the button onto a row. Fixed by scoping the row handler to
  `e.target === e.currentTarget`, which also protects any interactive content a
  consumer puts in a `render` cell. Five tests; revert-verified. **Verified.**
- **Every chevron had the same accessible name** ("Expand row"), so a screen
  reader's control list was N indistinguishable buttons. Now named for its row;
  state stays on `aria-expanded`. **Verified.**

### Open — selection is inaudible, and so is the affordance

**Nothing about selection reaches assistive technology.** Worse than the
original framing: it is not only the _state_ that is silent but the
**affordance** — the row is a `<tr tabIndex={0} onClick>` with no `button`,
`link` or `option` role and no hint of activation, so in browse mode a screen
reader user is never told the row does anything. **Verified.**

**Researched 2026-08-10, and there is a clear answer.** Prior art settles the
grid-vs-listbox question more sharply than the first draft's "two options, pick
one".

**Reject `listbox`, on spec grounds rather than taste.** An `option` may not
contain interactive content, and our rows contain the expander `<button>` — this
is the documented reason Adobe did not use `listbox` for their own list
component ([react-spectrum#1327](https://github.com/adobe/react-spectrum/issues/1327)).
It also discards the column semantics we chose deliberately, and Adrian Roselli
notes both the APG examples and the native control have
[_"tested poorly with users for more than two decades"_](http://adrianroselli.com/2022/05/under-engineered-multi-selects.html).

**On `role="grid"`, the cell-navigation question is APG, not spec.** Nothing in
the ARIA `grid` definition mandates Left/Right. The
[APG grid pattern](https://www.w3.org/WAI/ARIA/apg/patterns/grid/) states it
declaratively ("Right Arrow: Moves focus one cell to the right…") and reserves
"Optionally" for _layout_ grids only — so **there is no APG-sanctioned row-only
grid variant**. The first draft's instinct ("declaring the role without the
navigation lies to AT") is right as pattern conformance, wrong as a spec
violation. Sarah Higley's
[Grids Part 1](https://sarahmhigley.com/writing/grids-part1/) leans our case
grid-ward anyway: _"A table that is primarily static content, but with the
primary purpose is to select rows… would lean towards being a grid."_

**The clever escape hatch exists and does not fit us.** React Aria's `GridList`
is `role="grid"` with **`aria-colcount="1"`** and one `gridcell` per row — in a
one-column grid, row-level arrows _are_ complete cell navigation, so nothing is
promised unfulfilled. Verified in
[`useGridList.ts`](https://github.com/adobe/react-spectrum/blob/main/packages/react-aria/src/gridlist/useGridList.ts).
But `aria-colcount=1` is honest for a list and would be **a lie for
`<BarList>`**, which has real data cells and column semantics. We cannot borrow
the fig leaf.

**Both libraries that chose grid also paid for cell navigation** — AG Grid
(`treegrid` when grouping, `grid` otherwise, `aria-selected` on rows _and_
cells) and [MUI X DataGrid](https://mui.com/x/react-data-grid/accessibility/),
whose keymap is nearly ours already ("Shift+Arrow Up/Down: Select the current
row and adjacent rows"). **Nobody in the surveyed set ships a multi-column
row-only grid.** TanStack prescribes no ARIA at all; Glide Data Grid's own
README disclaims its a11y.

**Recommendation (researcher confidence: high).** `role="grid"` +
`aria-multiselectable` + `aria-selected` on `<tr>` + `aria-rowcount`/
`aria-rowindex`, **and implement Left/Right cell navigation** — roughly a day,
genuinely useful for reading a wide row, and it converts the role from a lie
into a promise kept. Note `aria-selected` on `<tr>` is harmless either way, so
it can ship as belt-and-braces immediately.

**Two things the role alone does not buy, and the first is not optional:**

- **A live-region selection announcer with a count.** React Aria ships
  `useGridSelectionAnnouncement` whose own comment is the rationale: _"Many
  screen readers do not announce when items in a grid are selected/deselected.
  We do this using an ARIA live region."_ It announces the changed row by name
  and **always appends a count** in multiple mode
  (`"{count, plural, one {# item selected} other {# items selected}}."`), so
  Shift-Arrow over 40 rows says "…40 items selected". **This is the single most
  directly applicable finding in the whole audit: `aria-selected` alone is
  demonstrably insufficient**, and the strings are copyable, which answers the
  first draft's worry about inventing wording.
- **An opt-in checkbox column** (researcher confidence: medium). It is the only
  selection signal every AT announces natively, and it doubles as the touch
  answer — AG Grid, MUI and TanStack all fall back to per-row checkboxes.
  Adobe instead uses long-press with `aria-describedby` = _"Long press to enter
  selection mode."_ Roselli
  [argues](http://adrianroselli.com/2020/07/aria-grid-as-an-anti-pattern.html)
  for checkboxes over `grid` entirely. Treat as opt-in, not mandatory — it is a
  real design cost for a charting component.

**Caveat worth carrying:** row selection is under-specified even _inside_ a
grid — [w3c/aria#1008](https://github.com/w3c/aria/issues/1008) (open since 2019) and [w3c/aria#2403](https://github.com/w3c/aria/issues/2403), which
reports "some screen readers don't seem to convey that information". Which is
the second argument for the announcer: do not rely on the role alone.

### Open — the table is unnavigable as a table

- **No headers, no accessible name.** No `<caption>`, `<thead>`, `<th>`, `role`
  or `aria-label`. The label cell is a `<td>`, not `<th scope="row">`, and
  `ListCellSpec` has **no header field at all** — a consumer literally cannot
  supply column headers. A screen reader in table mode gets "row 3, column 4,
  15.3" with no column name and no row name, and the table is anonymous in the
  page's table list. This directly contradicts `ListTable`'s own docstring
  claim of "screen-reader-legible rows". `<th scope="row">` for the label is
  nearly free; column headers need a new `ListCellSpec.header` + `<thead>` and
  a decision about the glyph column and about breaking existing story layouts.
  **Verified.**
- **The quantity is purely visual in `<BarList>`.** The bar is nested empty
  `<div>`s with a percentage width — no text, no label, no `title`. The widest
  cell in the row reads as **blank**. Numbers reach text only if the consumer
  adds `before`/`after` cells. `<BoxList>` prints the current value when
  `format` is given, but never the five-number summary. Marker crossings are
  the dotted rule alone. The library cannot know units or formatting, so there
  is no safe mandatory default — options are an opt-in
  `accessibleValue?: (row) => string` rendered visually-hidden, or documenting
  that a text cell is mandatory and making every example use one. **Verified.**
- **Sorting is invisible.** `sortBy` reorders at render with no header, so no
  `aria-sort` and no statement that the list is ranked or by what — the
  component's primary semantic. Rides on the header work above. **Verified.**
- **The marker label strip is a fake data row** — a `<tr>` of empty cells with
  one holding absolutely-positioned labels. Screen readers count it as data and
  read a run of blanks. It is chrome: it belongs in a `<caption>`, a `<thead>`,
  or outside the table. **Verified.**
- **Nothing is announced on selection change.** A drag or Shift-Arrow that
  takes 12 rows produces no announcement and no focus change. A polite live
  region is cheap, but the message wording ("12 rows selected") is something
  the library would be inventing, and it needs a localisation answer.
  **Verified** (no `aria-live` anywhere in the package).

### Open — the register's other three original claims, as corrected

- **No roving tabindex — confirmed, and understated.** With `renderExpanded`
  every row contributes **two** tab stops (row + chevron), so a 100-row list is 200. Changing it is a behaviour change, not a pure improvement.
- **Touch has no range gesture — confirmed, but "multi-select is unreachable
  on touch" was overstated.** A tap still fires `onRowSelect([row], mods)` and
  the consumer owns all set arithmetic, so tap-to-toggle multi-select is
  implementable today. What is missing is a _built-in range_ gesture, and
  `additive` is always false on touch.
- **Focus visibility — confirmed, worse than stated, and it is TWO tests.**
  Per [Understanding Focus Appearance](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html),
  **2.4.13** measures the change of contrast between focused and unfocused
  states (≥3:1 on the same pixels) and **1.4.11** measures the indicator
  against _adjacent_ colours — so the ring must be evaluated against **both**
  the unselected and the selected row background. A ring tuned to the default
  ground commonly fails 1.4.11 once a selection tint sits under it; a two-tone
  ring (dark stroke + light offset halo) survives both. The shell sets no
  focus style and no `:focus-visible` rule, and `theme.list` has no focus
  token — so a consumer cannot fix a bad focus ring by theming either. Needs
  checking against `selectedBand` (WCAG 2.4.11/2.4.13).

### Low vision

`whiteSpace: 'nowrap'` on every text cell with no overflow container forces
page-level horizontal scrolling at 200–400% zoom (WCAG 1.4.10). Fonts are
absolute px from `theme.font.size`, so the list ignores the browser font size;
making that relative is a cross-cutting theme decision because the canvas
measures in px. **Verified.**

## The canvas surface

A repo-wide grep for `tabIndex|role=|aria-|onKeyDown` across
`packages/charts/src` returns **five hits, all outside the plot**. This is not
a set of gaps; it is an unstarted surface — and the project already knows:
`docs/rfcs/charts.md` parks an "offscreen `<table>` data fallback for keyboard
/ AT" in v1.1.

- **There is no keyboard path to any chart interaction.** The plot is a `<div>`
  with pointer handlers and no `tabIndex`, so it never receives a keypress. A
  keyboard-only user cannot select, sweep, rect-select, pan, zoom, move a
  cursor, or create/drag/delete an annotation. Additive selection needs
  meta/ctrl **plus** a pointer with no equivalent. **Fails WCAG 2.1.1 (A)
  outright.** The verbs are already context methods so wiring is modest;
  **choosing the focus model — plot? row? mark? series? — is a design project**,
  not a patch. **Verified.**
- **The `<canvas>` claims nothing.** No role, no accessible name, no fallback
  content, no `<figure>`/`<figcaption>` anywhere in the package. The entire
  visualisation is an empty inline box to a screen reader. An `aria-label` +
  `<figure>` on `ChartContainer` and `role="img"` on the canvas is **cheap and
  the highest-value single move on this surface.** **Verified.**
- **Legend chips are interactive `<div>`s** — `onClick`, `cursor: pointer`, no
  `tabIndex`, no `role="button"`, no `aria-pressed`, and the swatch `<svg>` is
  not `aria-hidden`. Credit where due: selection is encoded non-chromatically
  (`fontWeight: 600`), but unselected rows at `opacity: 0.45` push their labels
  under contrast minimums. Small, self-contained fix, and the pattern already
  exists in `ListTable`. **Verified.**
- **Annotation handles are pointer-only** — transparent `<rect>`s with pointer
  handlers, no `tabIndex`/`role`/`onKeyDown`/name. Selecting, editing or
  dragging a `<Marker>`/`<Region>`/`<Baseline>` is unreachable by keyboard and
  invisible to AT. **Verified.**
- **Hit targets are far under WCAG 2.5.8 (24×24)** — handles are 6×18 with a
  5px pad, edge grabs 8px. Cheap in code, but at 24px adjacent handles on a
  narrow region overlap, so it needs a design call. **Every drag gesture is
  pointer-only with no alternative**, which also **fails WCAG 2.5.7 (Dragging
  Movements)**. **Verified.**
- **Axis tick labels are real text, and that is a genuine asset.** Two caveats,
  both **Suspected**: y-tick DOM order is scale order (visually bottom→top), so
  reading order may be inverted; and an axis is an unlabelled bag of numbers
  with no grouping. `role="group"` + `aria-label` on the axis box is cheap.
- **Readout chips and y-gutter pills are unlabelled and silent** — no
  `role="status"`, no `aria-live`. Academic while there is no keyboard route to
  producing one; it becomes the _first_ thing to fix the moment there is.
  **Verified.**
- **Motion is genuinely fine.** No CSS transitions, no decorative animation,
  nothing auto-moves; `requestAnimationFrame` only coalesces pointer moves.
  `prefers-reduced-motion` is absent and there is nothing it would gate. **Not
  a finding.**

## Contrast — measured, and the conformance line is not where I first put it

WCAG 2.1 relative luminance, alpha composited before measuring. `defaultTheme`
sets no `background`, so marks sit on the page ground; measured against
**white**, and every number changes on a non-white host. `font.size: 11`, so
**all** text takes the 4.5:1 threshold — nothing here qualifies for 3:1.

**A correction to this file's first draft, and it matters.** I originally marked
every under-3:1 state transition as a failure. SC 1.4.11 says otherwise, twice,
[verbatim](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html):

> This success criterion does not require that changes in color that
> differentiate between states of an individual component meet the 3:1 contrast
> ratio when they do not appear next to each other.

> Therefore, additional author-supplied visual treatments for hover are not
> "required to identify" the hover state. Those treatments can be considered
> supplemental and do not themselves need to contrast 3:1 against the
> background.

So **hover is exempt**, explicitly. Rest→hover at 1.47:1 is _conformant_. What
the criterion does cover is "visual information required to identify … states"
against **adjacent** colours — and in a chart a selected bar and an unselected
bar sit side by side, so that pair is adjacent and the state is arguably
required to understand the graphic. Keep the two apart below: **conformance**
is narrow, **quality** is where most of this lives. Do not report quality items
as violations.

### Text — one clear failure (SC 1.4.3, unambiguous)

| Token                      | Colour                   | Ratio    | Verdict                                                           |
| -------------------------- | ------------------------ | -------- | ----------------------------------------------------------------- |
| axis **title**             | `#64748b` @ opacity 0.85 | **3.56** | **fails 1.4.3** (needs 4.5)                                       |
| `axis.label` (ticks)       | `#64748b`                | 4.76     | passes **on white only** — an `#f1f5f9` ground gives 4.45, a fail |
| `estelaTheme` `axis.label` | `#4E6B6B` on `#06191D`   | **3.13** | **fails 1.4.3**                                                   |

Everything else measured (band labels, legend text, list ink, marker labels)
clears 4.5:1 comfortably.

### Marks and states

| Pair                                               | Ratio       | Reading                                                                                                      |
| -------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| `bar.fill` `#2A9D8F` vs white                      | 3.32        | passes as a graphical object                                                                                 |
| `bar.highlight` `#3F5BE0` vs white                 | 5.55        | passes                                                                                                       |
| **`highlight` → `fill`, bars side by side**        | **1.67**    | **the real concern** — adjacent, and state-identifying                                                       |
| `hover` → `fill`                                   | 1.47        | _conformant_ (hover is supplemental); poor quality                                                           |
| `dimmed` → `fill`                                  | 2.34        | quality                                                                                                      |
| ramp `groups[1]` `#5379be` → `groups[3]` `#b5604e` | **1.02**    | **worst finding in the theme** — luminance-identical, and exactly the pair that collapses under deuteranopia |
| `brush.fill` / `brush.edge` vs white               | 1.10 / 1.99 | a live drag preview is information, not decoration                                                           |

**A selected bar is the same brightness as an unselected one.** And **the
outline that was supposed to be the second cue is a no-op**: `bars.ts` strokes
`style.selectedOutline ?? fill`, and `defaultTheme` sets no `selectedOutline`,
so it strokes the selected fill over the selected fill. Setting
`bar.default.selectedOutline` to a contrasting ink is **one token and the
cheapest real win in this file**. It moves visual baselines, which per CLAUDE.md
is the point of the `defaultTheme` rule.

### The `list` register, measured separately

The contrast audit ran against a worktree predating `theme.list`, so its
list-colour numbers describe the old ad-hoc values. Measured here instead:

| Token / pair                                 | Ratio       | Reading                                             |
| -------------------------------------------- | ----------- | --------------------------------------------------- |
| `selectedRail` `#3F5BE0` vs white            | 5.55        | passes                                              |
| `selectedRail` vs `selectedBand`             | **4.92**    | passes — **this is what carries selection**         |
| `markerInk` `#1C1C1A` vs white               | 17.07       | passes                                              |
| `hoverRail` `#4FD0BE` vs white / vs its band | 1.89 / 1.75 | hover is supplemental ⇒ conformant, but weak        |
| `hoverBand` / `selectedBand` vs white        | 1.08 / 1.13 | washes, by design                                   |
| `selectedBand` vs `hoverBand`                | **1.04**    | the two bands are indistinguishable from each other |

**Read:** the ladder's _selection_ is perceivable without colour — the rail
carries it at 4.92:1, which vindicates the "band + rail" belt and braces,
because the band alone at 1.13:1 would not. **Hover has no strong cue**: band
1.08, rail 1.75 against that band, bands 1.04 apart. Conformant, but a
low-vision user gets no hover feedback. A darker `hoverRail` is the fix and it
is a change to a shipped default.

## Prior art — what other libraries actually do

Researched 2026-08-10. This is the section to read **before** designing anything
on the canvas surface, because the field has already converged and we should
copy rather than invent.

**The minimum credible answer is not keyboard navigation — it is a text
alternative plus a real data table.** That is the consensus across Highcharts'
own [10 guidelines](https://www.highcharts.com/article/10-guidelines-for-dataviz-accessibility/),
the [A11Y Collective](https://www.a11y-collective.com/blog/accessible-charts/),
and Chartability's critical tests. Highest-value single move for us: a
visually-hidden (or toggle-revealed) `<table>` of the plotted data plus a
summary description, with the canvas labelled. **This is already parked in
`docs/rfcs/charts.md` for v1.1 — the research says promote it, it is tier one,
not tier two.**

**Canvas is not an excuse.** The accepted pattern is canvas + a parallel
semantic DOM layer, and it ships in production:

- **AG Charts** (canvas) has a full keyboard model with announcements from the
  focused element ([docs](https://www.ag-grid.com/charts/javascript/accessibility/)).
- **[Data Navigator](https://github.com/cmudig/data-navigator)** (IEEE TVCG
  2024, [paper](https://arxiv.org/abs/2308.08475)) is the generalised, citable
  form: semantic HTML positioned over the graphic, explicitly so "png, svg,
  canvas, and even webgl" become navigable. Model = **Structure** (a graph of
  nodes and edges defining navigation paths) + **Input** + **Rendering**. If we
  build a focus model, this is the design to start from.
- **ECharts** is the weak floor — one generated `aria-label` on the container,
  no keyboard nav, off by default. **Chart.js** is the null case: its own docs
  say canvas content is inaccessible and it is up to you.

**The keyboard model to copy** — Highcharts `'normal'` mode, which AG Charts
converged on independently, and which matches the ARIA "one tab stop, arrows
inside" convention that Recharts also argues for:

> container is **one tab stop**; `←/→` moves between points within a series;
> `↑/↓` moves between series; `Home/End` first/last; `PageUp/PageDown` by a
> page; `Enter`/`Space` activates; `Esc` leaves; visible focus ring;
> wrap-around; remember the last-focused point per series.

Worth stealing AG Charts' documented honesty too: points are traversed in
**declared** order, which may not match visual order.

**Decal / pattern fills** are real and cheap (ECharts `aria.decal`, Highcharts
pattern fills — opt-in in both), but a small win next to structure.
**Sonification** ships only in Highcharts, opt-in, built with the Georgia Tech
Sonification Lab. **Do not build this.**

**[Chartability](https://chartability.fizz.studio/)** (Elavsky, EuroVis 2022) is
50 testable questions under POUR+CAF, with a ~14-test critical pass in 20–40
minutes. It is renderer-agnostic and never lets canvas off the hook. **Its
critical ten is the checklist this plan should actually be scored against**, and
its most relevant finding: **87.5% of audited charts failed contrast.**

One caution on sources: a blog claiming Plotly ships arrow-key mark navigation
by default **contradicts Plotly's own issue tracker** (open since 2016). Prefer
vendor docs and issue trackers over listicles.

## Tooling — there is none, and the obvious first move is the wrong one

No axe, no `jest-axe`/`vitest-axe`, no `@axe-core/playwright`, no
`@storybook/addon-a11y`, and **no ESLint at all** in the repo, so
`eslint-plugin-jsx-a11y` has no host. The 20+ Playwright specs are visual
regression and perf only — no `getByRole`, no `aria-` assertion anywhere.

**The coverage figure, stated properly.** Deque's own study found axe-core
covered **57% of issues by volume** across 13,000+ pages
([deque.com](https://www.deque.com/blog/automated-testing-study-identifies-57-percent-of-digital-accessibility-issues/)).
That is instances, not success criteria, and it is inflated by a few rule types
recurring thousands of times. The older 30–40% lore is the success-criteria
framing. Both are vendor-published — treat 57% as "issues you can count".

**Bokeh already ran the experiment we were about to run, and removed axe-core.**
Across ~114 examples axe found ~7 unique issue classes, **all in the surrounding
widgets and toolbar**; plots without toolbars reported **zero**, because
everything was canvas. They pulled it citing false confidence: accessibility
tests "might make the team think accessibility is 'handled' when canvas
elements (the core product) are completely untested"
([bokeh#14057](https://github.com/bokeh/bokeh/discussions/14057)). That is our
exact situation, so **axe is demoted below the token test** and, if adopted,
must be scoped to chrome with the limitation written down.

Ordered:

1. **A theme-token contrast unit test.** Pure arithmetic over the theme object
   (`wcag-contrast` or `colorjs.io`), no DOM, no canvas problem. Assert every
   text token ≥4.5:1 against its ground and every _adjacent-in-a-chart_ pair
   ≥3:1. **This is the only mechanism that can ever cover the mark colours** —
   axe cannot see canvas — and it covers `defaultTheme`, which nothing else
   renders. ~half a day.
2. **`eslint-plugin-jsx-a11y`** — needs an ESLint host first. Catches what axe
   structurally cannot: `onClick` on a `<div>` with no role or key handler, in
   code paths no story covers. That is precisely the legend-chip and
   annotation-handle class above. ~1 hour plus fixes.
3. **`@axe-core/playwright` on a few e2e pages, `exclude`-ing canvas**, aimed at
   legends, tooltips and controls — and **documented as not covering the
   charts**, per Bokeh.
4. **Storybook a11y addon at warn-not-fail** over the fan-out. Known blind spot:
   it runs before async components finish rendering, producing false negatives.
   Lowest value per unit of noise here.
5. **A manual keyboard + screen-reader pass on one interactive chart.** Bokeh's
   conclusion was that this beats maintaining automation on a canvas product.

## Priorities

**Cheap, high value — do these first:**

0. **`aria-selected` on `<tr>` plus a live-region announcer with a count.** The
   announcer is the highest-value item in this file: it is what actually makes
   selection audible, the role alone is documented as insufficient, and React
   Aria's strings can be copied rather than invented. `aria-selected` is inert
   on `role=table` but harmless, so it can land now and become meaningful the
   moment the role changes.
1. `bar.default.selectedOutline` — one token; makes selection non-chromatic.
2. `aria-label` + `<figure>` on `ChartContainer`, `role="img"` on the canvas —
   turns a blank into a named object.
3. Legend chips → `role="button"` + `tabIndex` + `aria-pressed` + Enter/Space.
4. Axis title contrast (opacity default, or a darker ink).
5. `<th scope="row">` for the list's label cell.
6. The theme-token contrast test (tooling item 2), so 1 and 4 cannot regress.

**Medium, needs a small design decision:** live-region announcement for list
selection; a `theme.list` focus token + focus style; annotation hit targets
toward 24px; a darker `hoverRail`; column headers via `ListCellSpec.header`.

**Now scoped rather than open-ended** — the research turned two of these from
"design project" into "known pattern, known cost":

- **`role="grid"` + cell navigation** for the list family — ~a day, pattern
  settled. Was "the grid-vs-listbox decision".
- **The offscreen `<table>` data fallback** for charts — already in
  `docs/rfcs/charts.md` for v1.1, and the research says it is **tier one**: the
  single highest-value move on the canvas surface, ahead of keyboard nav.

**Still genuinely large design projects:** a focus model and keyboard grammar
for the plot (copy Highcharts' `normal` mode; Data Navigator is the general
form); non-pointer alternatives to every drag; a touch range affordance
(checkboxes or long-press).

## Open questions

- **~~Grid vs listbox~~ — answered**, see the list-family section. What remains
  for the owner is only whether to also ship the **opt-in checkbox column**
  (medium confidence, a real design cost for a charting component, and
  simultaneously the touch answer).
- **How far to take the canvas.** From "text alternative + data-table fallback"
  to "full keyboard navigation model" is a large range, and it is a product
  decision about who the charts are for. The research narrows it usefully: the
  fallback is tier one and the keyboard model tier two, so this is a question
  of _when_, not _whether_.
- **Whether a chart mark is a "graphical object" whose selection state is
  "required to understand the content"** under SC 1.4.11. It reads that way,
  which is what makes the 1.67:1 selected-vs-rest bar pair a plausible
  violation rather than only a quality problem — but it is a judgement call and
  should not be asserted as a failure anywhere public without a second opinion.

## Tasks

_None yet — fixes become `[PND-XXXXXX]` tasks in [PLAN.md](../../PLAN.md) as
the decisions above are made._
