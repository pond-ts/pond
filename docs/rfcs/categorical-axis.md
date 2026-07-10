# RFC: The categorical axis — a transpose view over a wide time×category series

> **Status:** draft, for red-team. **Not a commitment** (see CLAUDE.md →
> Strategic RFCs). Explores where a categorical x-axis (ticker / account / expiry
> on x) belongs in `@pond-ts/charts`, and argues it is the **transpose** of the
> time view rather than a new scale grafted on.
>
> **Original draft:** the pond-ts library agent (Claude), prompted by pjm17971,
> grounded in the SPARC summary-chart recon (issue #395) and the histogram
> feature (`feat/charts-histograms`). Review notes from the relevant library /
> use-case agents attach in §12 per the `streaming.md` pattern.
>
> **Relationship to `value-axis.md`:** that RFC deliberately scopes a **monotonic
> numeric** non-time axis and names "arbitrary non-monotonic x" a non-goal. This
> RFC does **not** reopen that — see §4. The category axis is not a generic string
> scale; its domain is the **columns of the series**.

## 1. The driver

SPARC (web-platform `packages/sparc`) shipped ~2,000 lines of bespoke chart code —
four summary charts over live per-tick aggregate data — without engaging
`@pond-ts/charts`. The friction report (#395) asked the library to own a
**categorical x-axis** (item 2), **stacking** (item 3), a **snapshot-replace
source** (item 1), **multi-selection** (item 4), and **threshold colour** (item
6). This RFC is the reconciliation of those asks into one model.

A direct read of the four charts on `gp/main-sparc-riskbuckets-1` (their real
specs, not the report's paraphrase):

| Chart | spec | x-field | Kind |
| --- | --- | --- | --- |
| `SummaryDivergingChart` | `autoHedgeSpec.ts` | **`ticker`** | categorical — signed bar per ticker, coloured by \|ratio\| threshold band |
| `SummaryCountChart` | `symbolRiskCountersSpec.ts` | **`ticker`** / `accnt` / `riskEngine` (selectable) | categorical — count per value |
| `SummaryBarChart` | `autoVegaDirSpec.ts` | `ekey` (expiry) | categorical — **stacked** by notice type |
| `SummaryHistogram` | `executionSpec.ts` | `fillMinuteOfDay` | **numeric** — binned minute-of-day |

Two corrections to the report fall straight out of this table and shape the RFC:

- **"All four are categorical" is "three of four."** The histogram is a **binned
  numeric (time-of-day)** axis — a linear scale over `fillMinuteOfDay`, re-binned
  client-side, with a brush. It is *not* a category-axis case; it is the case the
  shipped histogram work (a binned monotonic axis) already covers. The category
  axis is driven by the **other three**.
- **"Signed stacking" (item 3) is a phantom.** SPARC's only diverging chart is a
  **signed single bar** from a zero centre, coloured by a `|ratio|` threshold band
  (`autoHedgeSpec` `numer`/`denom`/`cap`; bands gray→yellow→orange→red). That is
  **item 6 (threshold colour) + a signed bar**, not a signed *stack*. The only
  real stack (`SummaryBarChart`) is floored-at-zero, non-signed — exactly what
  `feat/charts-histograms` shipped. So "signed stacking" should be dropped as a
  requirement.

## 2. Where development is today

A cold reader should know what exists versus what this RFC proposes. Nothing
below is speculative; the transpose (§3) is the only genuinely new idea.

**Published — `@pond-ts/charts` (v0.41.0).** The substrate the transpose reuses
is already shipped:

- The **container / row / layers** model, with one **shared x** (time or value)
  the whole container scrubs, and the draw layers (`LineChart`, `AreaChart`,
  `BandChart`, `ScatterChart`, `BarChart`, `BoxPlot`, `Candlestick`).
- The **cursor / tracker**: a crosshair that, at time *t*, resolves each layer's
  value — i.e. it already **selects a row at a cursor time** and reads across it.
  This is precisely the row-selector §5 needs, pointed at columns instead of
  layers.
- **Selection**: `SelectInfo` carries a stable series **`id`**; `selected` /
  `hovered` are controllable; interactivity is `id`-gated (selection RFC Phase 1,
  `selection.md`). **Multi-select** (`selectedKeys` / `selectionMode`, facet 4)
  is drafted in `selection.md` **but not built.**

**Published — core data primitives.** The whole *data* side of the transpose is
already there: `aggregate(Sequence.every('5m'), …)` → interval-keyed rows;
`byColumn({ width | edges }, …)` → value-bin records; `partitionBy({ groups })`
and `pivotByGroup` → grouped / wide; `withColumn`. Producing "a wide time×category
matrix" needs no new operator.

**In flight — `feat/charts-histograms` (this work; built + verified, NOT yet
merged or released).** Extends `<BarChart>` with:

- **Stacking** — a group-by dimension → per-segment bars, from three sources: a
  wide series (`columns`), a `Map<group, TimeSeries>` (the
  `partitionBy().aggregate().toMap()` shape), or a `byColumn` **`bins`** array.
  Per-segment `SelectInfo` identity `(id, key, label=group)`, no public-type
  change.
- A **`horizontal`** orientation (bars grow right, bins on a y band axis).
- A band axis expressed today as **ordinal unit slots + `<YAxis ticks>`** labels
  — the same "ordinal-index hack" SPARC hand-rolls, not yet a first-class scale.
- Readers `stacksFromGroups` / `stacksFromColumns` / `stacksFromBins`
  (`StackedBarSeries`).

The load-bearing bridge (picked up in §8): its **`bins` path already renders "a
row of `{category: value}`" on a band axis** (the heart-rate-zones story). That is
a *degenerate transpose* — one row, categories on an axis, but sourced from
`byColumn` rather than from a series' own columns, and with no cursor.

## 3. The observation: a categorical bar chart is the transpose

A `TimeSeries` is a matrix: **rows are timestamps, columns are channels.** Every
draw layer we have reads a **column down** the matrix — time on x, the column's
cells as the marks:

```
         AAPL  MSFT  GOOG          columns (channels)
  t0      12    9     4
  t1      15    8     5
  t2      11    9     6            read DOWN: x = rows (time), one line/bar per column
```

A categorical bar chart reads a **row across** it — fix one timestamp, spread the
*columns* along x, that row's cells become the bar heights:

```
  t2  ->  AAPL=11   MSFT=9   GOOG=6    read ACROSS: x = columns, one bar per column, one row
```

Same data, rotated 90°. **"Ticker on the x-axis" is "the schema's columns on the
x-axis, at one instant."** The categorical bar chart is not a new chart species;
it is the existing bar layer pointed at a **row** instead of a **column**.

## 4. Why this does not reopen the value-axis non-goal

`value-axis.md` excludes an arbitrary non-monotonic x because such a scale has to
be *grafted on* — its domain comes from nowhere in pond's grain. The transpose
view has no such problem: **its domain is the series' column names.** The axis is
the *schema*, a finite ordered set the series already carries — not a runtime
string scale invented per chart.

So the move this RFC proposes is deliberately narrow. Not "add a `kind:
'category'` band scale that eats any `string[]`." Instead: **"let a draw layer
read a row, and lay that row's columns along a discrete axis whose domain is the
column set."** That is bounded, typed, and emerges from the grain — the bar
`value-axis.md` set. A generic string band scale remains a non-goal.

## 5. The row-selector is the existing time cursor

The unlock (pjm17971): **the rows are real index keys.** You get them the normal
way — `aggregate(Sequence.every('5m'), …)` buckets the stream into interval-keyed
rows; each row is a 5-minute bucket. So "which row does the categorical chart
show?" is not a new concept — it is **the time cursor we already have.** The
crosshair that today reads a value off each line at time *t* would, in the
transpose view, select the *row* at *t* and hand its columns to the bar layer.

That makes the two views one series seen through one cursor:

- **read down** → lines / area over time (columns as channels)
- **read across at _t_** → bars over categories (one row)
- the container's **shared x-cursor binds them**: scrub the time axis and the
  bars animate; the **head row is the live snapshot.**

Everything that manages *what is in a row* — `aggregate` / `align` / `fill` /
`partitionBy`, live retention, the tracker that resolves a row at a cursor time —
**is already in play.** The categorical chart is a projection of the matrix at a
time-slice, not a parallel data path.

## 6. One spine, five facets

The #395 asks are facets of this single model:

| #395 ask | Transpose facet |
| --- | --- |
| **2 — category axis** | the columns of the selected row, laid on a discrete axis (domain = column set) |
| **1 — snapshot-replace source** | the **head row** of an aggregated live series — not a new source, the row at the live cursor |
| **4 — multi-selection** | selecting **columns**; `SelectInfo.id = columnName`, which maps directly to a filter chip |
| **3 — stacking** | a per-cell sub-breakdown → the shipped stacking, pointed at columns (floored-at-zero) |
| **6 — threshold colour** | a per-bar colour from the cell's own value band (theme tokens, the signed-off scatter-exception shape) |

Item 1 in particular *dissolves*: "snapshot-replace 1,500 keyed rows per tick" is
"the head row of a wide live series advancing," which the streaming layer already
models. The novelty this RFC actually introduces is small: **a row-reading draw
mode + a column-domain discrete axis + the cursor binding.**

## 7. The typing question (a declared column set)

The one genuine friction (pjm17971: "solvable, a typing issue"): tickers are
**high-cardinality and churn** — AAPL appears, a stale symbol drops. A fixed wide
schema fights that.

The resolution keeps the churn in the **data layer**, where the machinery already
lives. Bound the column set the same way `partitionBy` / `pivotByGroup` already
do — a **declared `{groups}`** (a watchlist), or a **top-N-by-value + "other"**
rollup, applied as a transform *before* the chart. The chart then renders
*whatever columns the row carries*; it does not own category discovery. So the
axis stays **bounded** (N + maybe "other") and the columns stay **typed**, and the
dynamism is a `pivotByGroup({ groups })` / a `limitColumns`-style concern, not a
scale concern.

Open sub-question for red-team: is "top-N + other" a new core transform, or does
it compose from `reduce` + `pivotByGroup` today? (See §11.)

## 8. Relationship to the shipped histogram work

`feat/charts-histograms` extended `<BarChart>` with **stacking** and a
**`horizontal`** orientation over **monotonic** axes (time buckets, value bands).
It is the first increment of this spine, and it is forward-compatible:

- Its **`bins`** path already renders **"a row of `{category: value}`"** — a
  `byColumn` result laid on an ordinal band axis (the heart-rate-zones story).
  That is a *degenerate transpose*: one row, categories on an axis, sourced from
  `byColumn` rather than from a series' actual columns. The generalization this
  RFC names is **"source that row from a series row / the schema's columns"** and
  bind the row to a time cursor.
- Its **stacking** (`columns`, per-segment `SelectInfo` identity `(id, key,
  label=group)`) is the facet-3 mechanism; here it is pointed at columns.
- What is genuinely *new* beyond the shipped work: the **row selector** (cursor
  binding / head-row for live) and the **column-domain axis** (item 2 proper).

So the sequencing is clean: stacking + band axis shipped (monotonic); this RFC is
the **transpose + cursor + column-domain** layer that turns the same primitives
toward the categorical charts.

## 9. Non-goals and corrections

- **Not a generic arbitrary-string band scale.** The domain is the column set
  (§4). A free `string[]` scale stays out.
- **Not a heatmap.** Both-axes-categorical dense grids remain a DOM-table concern
  (#395 item 14, already recorded as a charts non-goal). A stacked transpose
  (columns × one sub-group dim) is in scope; a full 2D category×category grid is
  not.
- **Not signed stacking.** Dropped per §1 — SPARC needs signed *single* bars +
  threshold colour, not signed stacks.
- **Does not reopen monotonic-numeric-x.** `value-axis.md` is unchanged.

## 10. Path to adoption (if taken up now)

Phases become commitments only when adopted into PLAN.md (CLAUDE.md → Strategic
RFCs). The striking thing about the runway is how little is genuinely *new*: one
scale primitive; everything else re-points the shipped substrate in §2.

- **Phase 0 — shipped increment (pending merge).** `feat/charts-histograms`:
  stacking + the band axis over **monotonic** axes. Lands the segment geometry,
  the per-segment `SelectInfo` identity, and the `bins` degenerate-transpose
  reader. Closes the non-signed half of **item 3**.
- **Phase 1 — the row read (the minimal categorical chart).** Let the bar layer
  read a single **row** (an `Event`, or a wide series' row) and lay its
  **columns** on a discrete axis whose domain is the **column set**. Static row
  (`latest`, or an explicit `at={time}`). _New surface:_ the column-domain axis —
  the one genuinely new scale (kept bounded per §7). Closes **item 2**.
- **Phase 2 — cursor binding + live head-row.** Bind the row selector to the
  shared time cursor, so a sibling time chart's crosshair drives which row the
  bars show, and default to the **head row** for a live series. _Reuses_ the
  tracker from §2. Dissolves **item 1**. Gated on the container-coexistence
  question (§11.3) — this is where the linked-view is won or deferred.
- **Phase 3 — the facets.** Column **multi-select** (`SelectInfo.id =
  columnName`; **gated on selection RFC Phase 2**), **threshold colour** (item 6,
  the signed-off scatter-exception shape → theme tokens), the **stacked
  transpose** (columns × one sub-group dim, reusing `StackedBarSeries`), and
  **legend metadata** (item 3 remainder). Closes **items 4 and 6**.
- **Phase 4 — bounding + scale.** The data-layer column bound (declared
  `{groups}` / top-N + "other", §7) and the **only-changed-marks** repaint at
  tick rate (**item 11**), riding the streaming change-model. Closes the perf
  envelope.

**Critical path:** Phase 1's column-domain axis is the *sole* new scale
primitive. Phases 0, 2, 3, 4 are re-pointings of shipped machinery (stacking, the
tracker, selection, `aggregate` / `pivotByGroup`, the streaming change-model).
That is both the argument for the whole thing being *small* if taken up, and the
argument for sequencing Phase 1 first — it carries the only real design risk.

## 11. Open questions (for red-team)

1. **Column-domain source.** Schema-declared (`{groups}`) vs runtime-discovered.
   Is "top-N-by-value + other" a core transform, or `reduce` + `pivotByGroup`
   composition? Where does churn get absorbed?
2. **Standalone categorical chart (no time chart present).** What selects the
   row — `latest`, an explicit `at={time}` prop, or a bound external cursor? The
   live case wants "head row"; a static report wants a pinned row.
3. **Container x-kind coexistence.** A categorical x is conceptually a third
   x-kind, but it is really *columns*, decoupled from the shared **time** x that
   the cursor scrubs. The histogram RFC work found `horizontal` forces the
   container to a value-x (standalone). Does a categorical/transpose row-view
   likewise stand alone in its own container, with the *time* cursor living on a
   sibling time chart that drives it? Or does one container hold both a time row
   (down-view) and a category row (across-view) bound by one cursor? The latter is
   the powerful linked-view; it needs the container to carry both a scrubbing time
   axis **and** a column axis at once.
4. **Stacking composition.** A second category dimension per cell (columns ×
   sub-groups) → a stacked transpose. Does the shipped `StackedBarSeries` grid
   carry that directly (columns = bins, sub-groups = stack), or is a distinct
   shape needed?
5. **Selection + legend.** `SelectInfo.id = columnName` for multi-select (facet
   4); the shipped stacking still owes **legend metadata** (item 3 remainder) —
   design it here so the transpose and the stack agree.
6. **Performance.** 1,500 columns at 5 Hz replace, repainting only marks whose
   cell changed (#395 item 11). The transpose reads one row, so per-tick work is
   O(columns in view), but the *diff* granularity (which bars changed) needs the
   change-model the streaming RFC is building.

## 12. Review notes

_(To be layered per the `streaming.md` pattern — library agent, the SPARC / web-
platform use-case agent, and a Codex adversarial pass. Each attaches its own
section here; the author amends inline above with a changelog rather than merging
competing rewrites.)_
