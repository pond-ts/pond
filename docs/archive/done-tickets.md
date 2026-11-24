# Archived tickets

Finished tickets taken out of `PLAN.md` by Planner, newest at the bottom. Each one is kept as it read when it came out.

## 2026-11-21

From `PLAN.md`, pond-rs — native Rust core:

- **[PND-ARROWREQ]** — pond-ts `fromArrow` declares every value column
  required, even one with nulls, so its own `toJSON` → `fromJSON` round trip
  then throws ("row 1 col 1 (v) is required"). Reproduced 2026-10-17 with a
  nullable Float64 column `[1, null]`. Proposed fix: take `required` from the
  Arrow field's nullability, as pond-rs now does (Codex review of pond-rs,
  finding 5), so both read the same file to the same schema. Until then they
  differ on every pyarrow / polars file (both mark fields nullable by
  default): pond-rs reads such columns as optional, pond-ts as required.
  - _Archived: Done in pull request #942 (wave "Columnar optionals") on 2026-11-19._
- **[PND-MAPREQ]** — pond-ts `mapColumns` keeps a column marked required
  even when the mapping leaves a gap (a non-finite result is stored as a
  gap), so its own `toJSON` → `fromJSON` round trip then throws ("row 3 col
  1 (value) is required"). Repro: parity case `mapColumns-overflow`
  (`v => v * 1e308 + 1e308` on a required column). Same class as
  [PND-ARROWREQ]. pond-rs makes the column optional when a gap appears;
  pond-ts should do the same. Found 2026-10-19 (pond-rs R1b step 3b).
  - _Archived: Done in pull request #942 (wave "Columnar optionals") on 2026-11-19._
- **[PND-COLSREQ]** — pond-ts `fromColumns` ignores `required`: a column
  the schema marks required (the default) is read with its gaps and stays
  marked required, so the series' own `toJSON` → `fromJSON` round trip
  then throws. Same class as [PND-ARROWREQ] / [PND-MAPREQ]. pond-rs marks
  such a column optional. Found 2026-10-20 (pond-rs R1b step 8d2).
  - _Archived: Done in pull request #942 (wave "Columnar optionals") on 2026-11-19._
- **[PND-COLLAPSEREQ]** — pond-ts `collapse` marks its output column
  required, but a non-finite result (`0 / 0`) or a reducer returning
  `undefined` leaves gaps in it, and the series then fails to reload
  through `fromJSON`. The reducer's type returns `ScalarValue` (no
  `undefined`), so the fix (output `required: false`, typed `R |
undefined`, or required only when it has no gaps) changes a public
  type and needs a yes. pond-rs marks it required only when it has no
  gaps. Found 2026-10-21 (pond-rs R1b step 8i).
  - _Archived: Done in pull request #942 (wave "Columnar optionals") on 2026-11-19._

## 2026-11-24

From `docs/plans/PND_CHARTS_PLAN.md`, Two families, not four issues:

### [PND-ANNROLE] — Annotation **roles**: a resting mark's alpha is a role question

`theme.annotation.depth` is `[1, 0.7, 0.4]`, so a **resting** annotation draws
at 0.4 alpha. That is a level, and the evidence says the thing it is trying to
express is a **role**.

**Two consumers overrode it in opposite directions in the same week**, each
locally, neither reporting it until asked:

| consumer                       | what annotations are for them                             | override                                    |
| ------------------------------ | --------------------------------------------------------- | ------------------------------------------- |
| measles gallery card (pond-ts) | the three vaccine dates **are** the argument              | crimson `#d81e5b`, `depth: [1, 0.95, 0.85]` |
| estela                         | a **focus wash** behind data when a lap/split is selected | `fillOpacity: 0.07`, foam                   |

That is the whole case. No single resting alpha serves both, because they are
not the same _kind_ of mark: one is an argument the reader must not miss, the
other is a wash that must not compete with the data on top of it. A level can
only be wrong for one of them.

`<Marker role>` / `<Zone role>` already exist and read
`theme.annotation.roles[role]` (`color`, optionally `fillOpacity`) — but the
**site theme defines no roles**, so `role` currently has nothing to select and
both consumers fell back to patching `theme.annotation` wholesale.

**The work:** define an annotation role vocabulary in the shipped themes with
its own depth ramp per role — at minimum a _wash_ (quiet, sits behind data) and
an _argument_ (loud, resting stays legible) — and extend `roles[role]` to carry
`depth` rather than only `color` / `fillOpacity`. Estela says it would adopt
immediately and drop its local override; the measles card would drop its
per-chart theme spread.

Two things to get right rather than assume:

- **Naming by intent, not by loudness.** `wash` / `argument` survives a theme
  change; `subtle` / `strong` becomes a lie the moment a theme rebalances.
- **The default has to stay put.** `[1, 0.7, 0.4]` is right for the common case
  (annotations secondary to a line), so an unrolled mark must not move.

**Shipped** in #834 (on the wave base). `annotation.roles[role]` may now carry
`depth` (its own three-level ramp), and `color` became optional, so a role
without one takes the register hue. `defaultTheme` and `estelaTheme` ship
`wash` (edges rest at 0.2, fill 0.06; estela's is a 7% foam tint) and
`argument` (rests at 0.85). Marks with no role keep `[1, 0.7, 0.4]`. The measles
gallery card moved to `role="argument"`, and estela's handoff
(`docs/notes/estela-fit-swap-2026-10.md`) points its `theme.annotation`
override at `<Region role="wash">`. Wave "Path to 1.0" added the story fan-out
#834 left out: `Annotations/Marker` `RoleArgument` / `RoleWash` and
`Annotations/Region` `RoleWash` / `RoleWashSelected` / `RoleArgument`. These
render `defaultTheme`, so each shipped role can be seen and reviewed against the
default. They are pinned by `test/annotation-stories.test.tsx`.

Related friction from the same exchange, **not yet tracked**: estela reserves
x-axis height by hand (`ChartRow height={h - X_AXIS_H}` plus a matching
`<XAxis height>`), got the arithmetic wrong once, and shipped labels overlapping
its own controls. Their framing is the right one — the axis should participate
in row layout rather than the consumer subtracting for it, which makes that
whole class of mismeasurement unrepresentable. Estela is filing it.
  - _Archived: Done in pull request #836 (wave "Path to 1.0") on 2026-10-27._
### [PND-XAXISOWN] — a mounted `<XAxis>` should win over the container's

pjm, on the third sighting: _"I wonder if when you add an XAxis that wins over
the container (or it warns at the prop conflict), this is like the 3rd time I've
seen that issue."_

`showAxis` defaults to `true`, so `<ChartContainer>` renders an x-axis strip the
declaration never mentions. Mount an explicit `<XAxis>` and you get **two**, and
nothing says so — the consumer has to already know to pass `showAxis={false}`.

**Three sightings, and they are one root cause: the container renders an axis
the declaration does not mention.**

1. `<GalleryCard height>` carries a comment warning that the caller "must budget
   for the auto-rendered time-axis strip… the stage clips anything taller,
   silently cutting off axis labels."
2. [PND-AXISGUT] / [#607] — estela hand-subtracts `X_AXIS_H` for that same
   strip, got it wrong once, and shipped overlapping labels.
3. The `ValueXLog` stories in this wave drew two x axes until `showAxis={false}`
   was added — as does every other story in `Axes.stories.tsx`, which is the
   tell: **the whole file works around the default.**

**Proposed:** a mounted `<XAxis>` takes precedence and the implicit strip stands
down, with `showAxis` kept as the explicit override. Nobody mounts an `<XAxis>`
_wanting_ a second one, so precedence is what the declaration already means.
Failing that, warn on the conflict — but silence is the one option the evidence
rules out.

Worth doing with [PND-AXISGUT], since both are "the implicit axis is invisible
to the layout and to the declaration", and a mounted-wins rule makes the height
reservation question answerable — the container would know whether an axis is
present rather than assuming one.

It is also the concrete cost of the shape pjm named while building [PND-XLOG]:
had at least one `<XAxis>` been **mandatory**, there would be no implicit strip
to conflict with, the scale props would live on it, and x would mirror y.

**Stated against the ownership test** ([PND-XLOG] above): container props earn
their place by defining the **mapping or the domain**, which is what forces them
to be shared across stacked rows. `showAxis` defines neither. It is "does the
container draw a strip" — presentation, which landed on the container only
because it was x-shaped, at a time when nothing distinguished "x-related" from
"scale-defining". So the precise complaint is **not that the default is
annoying; it is that the prop is on the wrong object**, and the two-axes
collision is what that misplacement looks like from a consumer's seat. Useful
because it sets the fix's direction: presentation belongs with `<XAxis>`, so
**Unblocked — build it.** The `<Domain>` RFC
([`docs/rfcs/container-decomposition.md`](../rfcs/container-decomposition.md))
would have made this task cease to exist, so it was held pending that
decision. That RFC was **declined on review 2026-08-13**: its central
evidence was overstated by 46%, and the reviewer's explicit finding was that
`xAxis="auto"` **is not wasted work** — it fixes a live bug while the larger
design fails review. Nothing is waiting on anything now.

Consumer evidence, gathered while measuring the RFC's blast radius: **Tidal
passes `showAxis` at 2 of 2 sites and estela at 5 of 14.** Every consumer we
can measure is working around the implicit strip.

mounted-wins is the correction and `showAxis` is the compatibility shim, rather
than mounted-wins being a special case bolted onto a prop that stays where it
is.

**Shipped (wave "Path to 1.0") — mounted wins.** A declared `<XAxis>`
registers with the container (`registerXAxis`, in a layout effect, so the
implicit strip is gone before first paint). `showAxis` now defaults to
*undefined*, meaning "draw the implicit strip iff nothing is declared". The
container's own strip renders inside an internal `ImplicitXAxisContext` so it
does not count itself. `showAxis={false}` behaves as before. `showAxis={true}`
plus a declared axis keeps both and dev-warns: honouring an explicit request
beats overriding it, and the warning is the "warn at the conflict" half of the
ask. Every `showAxis={false}` in `Axes.stories.tsx` (the tell) is gone, and
the GalleryCard comment and the axes/layout/cheat-sheet docs are updated.
Other stories' `showAxis={false}` were left alone: it is still correct there,
and a sweep is churn. **Not done here:** [PND-AXISGUT]'s height reservation,
which this makes answerable (the container now knows whether an axis is
declared) but does not implement. Nothing else in `ChartContainer` reads
`showAxis` (checked); the managed-`height` strip subtraction is pinned by a
structural test.

**Intended visual diffs.** Two story files mounted an axis without
`showAxis={false}` and were drawing a duplicate strip, which is now gone: every
`charts-barchart-category-stack--*` story, and every
`performance-decimation--*` story. Neither has a committed e2e snapshot. The
only e2e spec that touches them, `decimation.spec.ts`, compares
`performance-decimation--default` against `--off`, and both lose the strip the
same way, so no baselines needed regenerating. The `axes--x-axis-*` and
`axes--value-x-*` stories dropped their `showAxis={false}` but still draw one
axis, so they are visually unchanged.
  - _Archived: Done in pull request #836 (wave "Path to 1.0") on 2026-10-27._

From `PLAN.md`, Chart example friction:

- **[PND-CATID]** — **Split category display label from category identity.**
  The split has shipped (wave "Path to 1.0", #836): `CategoryDatum.key`,
  `mark` carries the key, the axis and readouts draw the label. Left, two
  questions the implementation put to the owner: (a) `sameMark` keeps
  `label` in a keyed category's identity, so an entry holding only a key, or
  a stale label, highlights on the canvas but fails `selectionContains`
  against a fresh hit (accept as documented, or let a mark say whether its
  label is identity); (b) duplicate keys still collapse to one slot
  silently (add a dev warning?). Write-up in
  [PND_CHARTS_PLAN.md](docs/plans/PND_CHARTS_PLAN.md#pnd-catid--split-category-display-label-from-category-identity).
  - _Archived: Done in pull request #836 (wave "Path to 1.0") on 2026-10-27._

