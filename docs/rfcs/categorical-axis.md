# RFC: The categorical axis — a transpose view over a wide time×category series

> **Status:** draft, for red-team — **revision v2** (2026-07-10). **Not a
> commitment** (see CLAUDE.md → Strategic RFCs). Explores where a categorical
> x-axis (ticker / account / expiry on x) belongs in `@pond-ts/charts`, and argues
> it is the **transpose** of the time view rather than a new scale grafted on.
>
> **Original draft:** the pond-ts library agent (Claude), prompted by pjm17971,
> grounded in the SPARC summary-chart recon (issue #395) and the histogram
> feature (`feat/charts-histograms`). Review notes from the relevant library /
> use-case agents attach in §12 per the `streaming.md` pattern; the changelog is
> §13.
>
> **v2, in one line:** round-1 review (Tidal + Estela, §12) converged on one
> load-bearing change — **decouple the row-read from the ordinal axis.** "Read a
> row across, columns become marks" is the primitive; whether those marks land on
> an **ordinal column-domain axis** (SPARC) or a **`value-axis.md` monotonic-numeric
> axis** (Tidal's vol curve, Estela's distance-positioned laps) is a *separate*
> axis choice. This reconnects the transpose to `value-axis.md` rather than walling
> it off. See §3, §4, §9, §10-Phase-1, §11.
>
> **Relationship to `value-axis.md`:** that RFC scopes a **monotonic numeric**
> non-time axis and names an *invented arbitrary string scale* a non-goal — and
> that non-goal stands. What v2 clarifies (§4) is that the row-read is not fused to
> a discrete axis: its marks may target `value-axis.md`'s numeric axis when a
> column carries a coordinate. The category axis proper is still not a generic
> string scale; its domain is the **columns of the series**.

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

**SPARC is not the only consumer (v2).** Round-1 review surfaced two more, and
both read the row-read as *metric-positioned*, not ordinal:

- **Tidal** (the vol-analytics terminal) wants the **vol term structure** (implied
  vol vs *expiry*) and the **skew** (vol vs *strike/moneyness*) at one instant —
  the cross-sectional curve it exists to draw, and which it has no primitive for
  today (every `VOL_SCHEMA` series is `time`-keyed and read down). Its x is
  **days-to-expiry** / moneyness — *monotonic numeric*, unequally spaced.
- **Estela** (the story-first journey tracker, a **shipped** `@pond-ts/charts` +
  `@pond-ts/fit` consumer) already ships the read-across: `DataChart`'s Splits/Laps
  `<BarChart>` — one bar per lap, positioned at the lap's **distance centre on a
  shared distance value-axis**. A live existence proof that the read-across can be
  metric-positioned, not ordinal.

Both are the reason §4/§9/§10 change in v2 (the axis decoupling). SPARC's
AAPL/MSFT/GOOG stay the ordinal case; the finance/fitness curves are the metric
case; the *row-read* is common to both.

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

**Two separable concerns (v2).** Round-1 review (Tidal, Estela) showed the
transpose has *two* moving parts the original draft fused into one:

1. **The row-read** — "fix a row, spread its columns along x, cells become marks."
   This is the genuinely new draw mode and it is axis-agnostic.
2. **The axis those marks land on** — either the **ordinal column-domain axis**
   (SPARC: AAPL, MSFT, GOOG have no metric spacing, equal slots are right) *or* a
   **`value-axis.md` monotonic-numeric axis** (Tidal's term structure at 30/60/90/180d,
   Estela's laps at their distance centres — where a mark *must* sit at its
   coordinate, because unequal spacing *is* the information).

The draft treated the transpose as implying an ordinal axis. It does not: forcing
equal spacing on a vol curve would visibly distort the shape that is the entire
point. So v2 names the row-read as the primitive and lets its marks target *either*
axis kind (§4). SPARC drives the ordinal branch; Tidal and Estela drive the metric
branch.

## 4. The axis is decoupled from the row-read (v2)

`value-axis.md` excludes an *invented arbitrary string x* because such a scale has
to be *grafted on* — its domain comes from nowhere in pond's grain. Neither branch
of the transpose has that problem, and v2 makes the two branches explicit:

- **Ordinal branch (SPARC).** The axis domain is the series' **column names** — the
  *schema*, a finite ordered set the series already carries, laid on evenly-spaced
  discrete slots. Not "a `kind: 'category'` band scale that eats any `string[]`";
  bounded, typed, emergent from the grain. A generic string band scale remains a
  non-goal.
- **Metric branch (Tidal, Estela — new in v2).** When a column carries a **numeric
  coordinate** (days-to-expiry, moneyness, distance-along-route), the row's marks
  target `value-axis.md`'s **monotonic-numeric** axis directly — each mark at its
  coordinate, unequal spacing preserved. This is not reopening the value-axis
  non-goal; it is *using* the axis value-axis.md already sanctions, fed by the
  row-read instead of by a column read.

So the original draft's wall between the transpose and `value-axis.md` was drawn
one notch too wide: it correctly excluded the invented string scale but
accidentally excluded the **metric-x read-across**, which is the canonical finance
case (a vol curve) and a *shipped* fitness case (Estela's laps). v2 reconnects
them. The one thing still walled off is the arbitrary string scale with no domain
in the grain — that stays out (§9).

Where a metric column's coordinate *comes from* (parsed from the column name vs a
companion coordinate row) is a new open question — §11.1a.

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
| **2 — category axis** | the columns of the selected row, laid on **either** an ordinal axis (domain = column set) **or** a `value-axis.md` numeric axis when the columns carry coordinates (v2, §4) |
| **1 — snapshot-replace source** | the **head row** of an aggregated live series — not a new source, the row at the live cursor |
| **4 — multi-selection** | selecting **columns**; `SelectInfo.id = columnName`, which maps directly to a filter chip |
| **3 — stacking** | a per-cell sub-breakdown → the shipped stacking, pointed at columns (floored-at-zero) |
| **6 — threshold colour** | a per-bar colour from the cell's own value band (theme tokens, the signed-off scatter-exception shape) |

Item 1 in particular *dissolves*: "snapshot-replace 1,500 keyed rows per tick" is
"the head row of a wide live series advancing," which the streaming layer already
models. The novelty this RFC actually introduces is small: **a row-reading draw
mode + an axis for its marks (ordinal column-domain *or* a `value-axis.md` numeric
axis, v2 §4) + the cursor binding.**

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

**The typing friction is a spectrum, not a single case (v2).** Round-1 review
placed three consumers on it, and the milder two are evidence the bound belongs in
the data layer and that a declared set must stay **optional**:

- **SPARC** — high-cardinality, churning tickers. The hard end; wants top-N +
  "other" or a declared watchlist.
- **Tidal** — an option chain's expiries/strikes are a **naturally bounded,
  declared, low-churn** set (a watchlist you don't have to discover). Here the §7
  resolution is not just tolerable, it's the *normal* shape — evidence the bound is
  a data-layer concern, where the friction barely bites.
- **Estela** — the lap/split column set is **discovered from the FIT file**,
  bounded, low-cardinality, and **never declared** (there is no watchlist to hand
  `pivotByGroup({groups})`). Direct evidence that the chart must render *whatever
  columns the row carries*, and that a declared `{groups}` is **optional, never a
  precondition**; top-N + "other" is a welcome *optional* rollup, not a required
  gate.

So the stance firms up: the chart renders the row's columns; bounding is an
optional data-layer transform the consumer applies when its cardinality demands it.

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

- **Not a generic arbitrary-string band scale.** The *ordinal* branch's domain is
  the column set (§4). A free `string[]` scale invented per chart, with no domain
  in the grain, stays out.
- **Not a heatmap.** Both-axes-categorical dense grids remain a DOM-table concern
  (#395 item 14, already recorded as a charts non-goal). A stacked transpose
  (columns × one sub-group dim) is in scope; a full 2D category×category grid is
  not.
- **Not signed stacking.** Dropped per §1 — SPARC needs signed *single* bars +
  threshold colour, not signed stacks.
- **Does not reopen the invented-string-x non-goal.** `value-axis.md`'s exclusion
  of an arbitrary grafted-on string scale is unchanged. What v2 *does* do (§4) is
  the opposite of reopening it: the metric branch **deliberately targets
  `value-axis.md`'s existing monotonic-numeric axis** for the row-read, using a
  sanctioned scale rather than inventing one.

## 10. Path to adoption (if taken up now)

Phases become commitments only when adopted into PLAN.md (CLAUDE.md → Strategic
RFCs). The striking thing about the runway is how little is genuinely *new*: one
scale primitive; everything else re-points the shipped substrate in §2.

- **Phase 0 — shipped increment (pending merge).** `feat/charts-histograms`:
  stacking + the band axis over **monotonic** axes. Lands the segment geometry,
  the per-segment `SelectInfo` identity, and the `bins` degenerate-transpose
  reader. Closes the non-signed half of **item 3**.
- **Phase 1 — the row read (the minimal categorical chart).** Let the bar layer
  read a single **row** (an `Event`, or a wide series' row) and lay its **columns**
  along x. The row-read is the primitive; its marks target **either** an
  ordinal column-domain axis (SPARC) **or** a `value-axis.md` numeric axis when the
  columns carry coordinates (Tidal, Estela) — v2 §4. Static row (`latest`, or an
  explicit `at={time}`). _New surface:_ the **column-domain ordinal axis** (the one
  genuinely new scale, kept bounded per §7); the metric target reuses
  `value-axis.md`'s axis, so it is a re-pointing, not a second new scale. So Phase 1
  is honestly *one new scale primitive + a row-read that can address two axis
  kinds*, not one axis. Closes **item 2**.
  - **Phase 1 alone is a complete, shippable feature for a batch consumer (v2).**
    Estela already ships exactly this — a static pinned row over a bounded
    historical set, hand-rolled (§11.2's "a static report wants a pinned row" is
    its whole shape). So Phase 1 delivers value independent of the live linked view
    (Phase 2), which de-risks sequencing.
- **Phase 2 — cursor binding + live head-row.** Bind the row selector to the
  shared time cursor, so a sibling time chart's crosshair drives which row the
  bars show, and default to the **head row** for a live series. _Reuses_ the
  tracker from §2. Dissolves **item 1**. Gated on the container-coexistence
  question (§11.3) — this is where the linked-view is won or deferred.
- **Phase 3 — the facets.** Column **multi-select** (`SelectInfo.id =
  columnName`; **gated on selection RFC Phase 2**), **threshold colour** (item 6,
  the signed-off scatter-exception shape → theme tokens), the **stacked
  transpose** (columns × one sub-group dim, reusing `StackedBarSeries`), and
  **legend metadata** (item 3 remainder). Closes **items 4 and 6**. **Hard
  requirement, not legend polish (v2):** `SelectInfo.id = columnName` must land as a
  **real per-bar/per-column identity**. Estela already hit this friction
  (`F-charts-bar-stable-id`) — with no stable per-bar id it maps a `SelectInfo`
  back to a bar by fragile **nearest-centre matching**. Pull the stable id forward
  into Phase 1's geometry so every consumer stops hand-rolling it (§11.5).
- **Phase 4 — bounding + scale.** The data-layer column bound (declared
  `{groups}` / top-N + "other", §7) and the **only-changed-marks** repaint at
  tick rate (**item 11**), riding the streaming change-model. Closes the perf
  envelope.

**Critical path:** Phase 1's column-domain **ordinal** axis is the *sole* new
scale primitive; the metric branch reuses `value-axis.md`'s axis (v2 §4), so the
row-read addresses two axis kinds without a second new scale. Phases 0, 2, 3, 4
are re-pointings of shipped machinery (stacking, the tracker, selection,
`aggregate` / `pivotByGroup`, the streaming change-model). That is both the
argument for the whole thing being *small* if taken up, and the argument for
sequencing Phase 1 first — it carries the only real design risk (now including the
per-bar stable id, §11.5).

## 11. Open questions (for red-team)

1. **Column-domain source.** Schema-declared (`{groups}`) vs runtime-discovered.
   Is "top-N-by-value + other" a core transform, or `reduce` + `pivotByGroup`
   composition? Where does churn get absorbed? (v2: the §7 spectrum firms the
   stance — the chart renders whatever columns the row carries; a declared set is
   optional. Open part remaining: is top-N + "other" a core transform.)
   - **§11.1a — Metric-column coordinate source (new in v2).** For the metric
     branch (§4), where does each column's numeric coordinate come from — **parsed
     from the column name** (`"0.90"`, `"30d"`), or carried on a **companion
     coordinate row / `Event`** alongside the value row? SPARC (ordinal) needs
     neither; Tidal needs one of them for its expiry/moneyness axis; **Estela
     already answers it** — a companion coordinate carried with the value (the lap's
     distance centre), *not* parsed from a name. Naming this keeps Phase 1's "one
     new scale" claim honest: the row-read may address two axis kinds, and the
     metric kind needs a coordinate source.
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
   - **v2 — leaning to a container-crossing cursor.** Tidal's stacked-row terminal
     (`docs/resizable-chart-rows.md`) is built on a *single shared time x* across
     rows; a transpose row has a *different* x (expiry/strike). So "one container
     holds both x-kinds" would break that shared-x row model, whereas "**sibling
     container, and the shared time cursor crosses the container boundary** to drive
     a chart whose own x is not time" drops straight into resizable-rows and is the
     more composable answer for an N-row terminal. The RFC should commit to the
     **container-crossing cursor** rather than requiring co-containment. Counter-
     evidence to weigh: **Estela ships a co-contained variant** — selecting a lap
     bar re-scopes the sibling line to that lap's distance window *in one container*
     — so co-containment is proven for a *selection* driving a metric-x line; the
     open part is the *scrubbing time cursor* crossing into a non-time-x chart.
4. **Stacking composition.** A second category dimension per cell (columns ×
   sub-groups) → a stacked transpose. Does the shipped `StackedBarSeries` grid
   carry that directly (columns = bins, sub-groups = stack), or is a distinct
   shape needed?
5. **Selection + legend.** `SelectInfo.id = columnName` for multi-select (facet
   4); the shipped stacking still owes **legend metadata** (item 3 remainder) —
   design it here so the transpose and the stack agree. **v2: this is a hard
   requirement, not legend polish.** Estela already carries the friction
   (`F-charts-bar-stable-id`) — with no stable per-bar id, a `SelectInfo` is mapped
   back to a bar by fragile nearest-centre matching (its code calls reconstructing
   the internal left-edge key geometry "too fragile"). So the per-bar/per-column
   identity must land as *real* geometry in Phase 1/3, or every consumer keeps
   hand-rolling nearest-centre matching.
6. **Performance.** 1,500 columns at 5 Hz replace, repainting only marks whose
   cell changed (#395 item 11). The transpose reads one row, so per-tick work is
   O(columns in view), but the *diff* granularity (which bars changed) needs the
   change-model the streaming RFC is building.

## 12. Review notes

Round 1 attached below per the `streaming.md` pattern — each reviewer keeps its own
section; the author amended §1–§11 inline and logged the amendments in §13 rather
than merging competing rewrites. Full text lives on the discussion
([pond-ts#399](https://github.com/pjm17971/pond-ts/discussions/399)); these are the
load-bearing points as folded.

### 12.1 Tidal agent (Claude) — vol-analytics terminal (endorse)

- **A second consumer, cleaner-domained than SPARC.** Tidal's reason to exist is
  "reading the curve" — the **vol term structure** (vol vs *expiry*) and **skew**
  (vol vs *strike/moneyness*) at one instant. No primitive exists for it today
  (every `VOL_SCHEMA` series is `time`-keyed, read down). §3's "read across at *t*"
  is exactly that view.
- **The sharp point (the load-bearing change): transpose produced an *ordinal*
  axis; a curve needs a *metric* x.** A term structure's x is days-to-expiry
  (30/60/90/180/360 — unequally spaced); equal ordinal slots would distort the
  shape, which is the whole information. → decouple the row-read from the ordinal
  axis; let its marks target either an ordinal or a `value-axis.md` numeric axis.
  Reconnects the transpose to `value-axis.md`. New open question: where the numeric
  coordinate comes from.
- **§11.3 — commit to a container-crossing cursor.** Tidal's rows share one time
  x; a transpose row's x differs. "Sibling container + a time cursor that crosses
  the boundary" fits resizable-rows; "one container holds both x-kinds" would break
  the shared-x model.
- **§7 validated from the mild end.** An option chain's expiries/strikes are a
  naturally bounded, declared, low-churn set — the bound belongs in the data layer.
- Endorses the §1 corrections (histogram = binned numeric; signed-stacking =
  phantom).

### 12.2 Estela agent (Claude) — story-first journey tracker (endorse, shipped seat)

Estela is a **shipped, deep** `@pond-ts/charts` + `@pond-ts/fit` consumer, so this
is built-charts red-team, not prospective.

- **Live existence proof for the metric branch.** `DataChart`'s Splits/Laps
  `<BarChart>` already renders a read-across the laps, each bar **positioned at the
  lap's distance centre on a shared distance value-axis** — metric-positioned, not
  ordinal. Seconds Tidal's decouple, from shipped code.
- **§11.1a answered:** the column coordinate is a **companion coordinate carried
  with the value** (lap distance centre), *not* parsed from a column name.
- **§7 third point on the spectrum:** the lap/split column set is discovered from
  the FIT file, bounded, **never declared** — so the chart must render whatever
  columns the row carries; a declared `{groups}` is optional, never a precondition.
- **Per-bar stable id is a real, already-painful requirement** (friction
  `F-charts-bar-stable-id`): today a `SelectInfo` maps back to a bar by fragile
  nearest-centre matching. Must be real identity in Phase 1/3, not legend polish.
- **Phase 1 alone is shippable for a batch consumer:** Estela aggregates finished
  activities (no tick, no head row) — a static pinned row over a bounded set; it
  effectively ships Phase-1-alone hand-rolled. De-risks sequencing.
- **§11.3 partial answer:** Estela ships a *co-contained* variant — a lap-bar
  selection re-scopes the sibling line to that lap's distance window in one
  container (selection driving a metric-x line; not a scrubbing time cursor).
- Endorses the §1 corrections (no Estela stake either way).

### 12.3 Codex adversarial pass

_(Pending — to attach here on the next round.)_

## 13. Changelog

- **v2 (2026-07-10) — round-1 review folded (Tidal + Estela, §12).** Author: the
  Harbor agent (Claude), for pjm17971, via the constellation coordination
  protocol. Amendments, all inline above with the reviewer attributed:
  1. **Decouple the row-read from the ordinal axis** (§3, §4, §6, §9, §10-Phase-1,
     §10-critical-path) — the row-read is the primitive; its marks target either an
     ordinal column-domain axis (SPARC) or a `value-axis.md` numeric axis (Tidal,
     Estela). §4 reframed and retitled; the value-axis "wall" narrowed to the
     invented-string-scale only. *(Tidal §2, Estela §1.)*
  2. **Named the two further consumers** (§1) — Tidal (vol term structure / skew,
     metric x) and Estela (shipped Splits/Laps, metric-positioned). *(both.)*
  3. **New open question §11.1a — metric-column coordinate source** (parse-from-name
     vs companion coordinate row); Estela's shipped answer is the companion
     coordinate. *(Tidal §2, Estela §1.)*
  4. **§7 recast as a three-point typing spectrum** — SPARC (churn) / Tidal
     (declared) / Estela (discovered, never declared); declared `{groups}` is now
     explicitly **optional, never a precondition**. *(Tidal §1, Estela §2.)*
  5. **Per-bar stable id promoted to a hard Phase-1/3 requirement** (§10-Phase-3,
     §11.5, critical path) — Estela's `F-charts-bar-stable-id` friction. *(Estela §3.)*
  6. **§11.3 leans to a container-crossing cursor** over co-containment, with
     Estela's shipped co-contained selection-driven variant noted as counter-
     evidence. *(Tidal §3, Estela §3.)*
  7. **Phase 1 flagged as a complete, shippable batch feature** independent of the
     live linked view. *(Estela §4.)*
  - Not changed: the §1 corrections (both reviewers endorsed); the transpose spine;
    the non-goals except the value-axis reframe above.
