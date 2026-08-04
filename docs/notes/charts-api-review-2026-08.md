# Bar / box / chart / list API review — 2026-08-02

Owner-supplied holistic review of the chart-family APIs after the list-family
wave (#585/#587). Preserved verbatim below the summary; the actionable items
are tracked as **[PND-CHARTAPI]**, **[PND-BARSEM]**, **[PND-HCAT]**, and
**[PND-VSADAPT]** in [PND_CHARTS_PLAN.md](../plans/PND_CHARTS_PLAN.md), with
the unambiguous documentation errors fixed in the intake PR that added this
note.

**Verdict (condensed):** excellent data seam (charts consume pond objects
directly; adapters are quasi-internal), good composition model, uneven
behavioral and type seam. The happy path is ~8/10; switching among bars,
histograms, horizontal bars, categories, and lists drops toward 6/10 because
internal modes leak into user-visible behavior.

**The four structural findings:**

1. **The typed library loses its column types at the chart boundary.**
   Column props are bare `string` on schema-generic components (core already
   exports `NumericColumnNameForSchema<S>`), and `BarChartProps` models every
   source/column prop as independently optional, validating combinations at
   render. `<BarChart series column="typo" />` compiles. Highest-value fix:
   mode unions + schema-derived column names, same JSX. → [PND-CHARTAPI]
2. **Behavior depends on the acquisition path, not the visible mark.**
   `series+column` routes through `drawBars`; `bins`/`categories`/horizontal/
   wide-columns route through `drawStacks` — changing hit targets, cursor
   availability, `BarStyle.hover` applicability, identity, and decimation for
   visually identical marks. Normalize capabilities on "one-segment vertical
   bar", not on the input prop. → [PND-BARSEM]
3. **Horizontal categorical bars are missing** (`categories` is
   vertical-only); the gallery funnel hand-builds ordinal bins + `i + 0.5`
   ticks to work around it. A funnel is a plot, not a `BarList`. → [PND-HCAT]
4. **Docs/export inconsistencies:** ValueSeries adapters documented but not
   exported (the export-vs-demote decision is [PND-VSADAPT]); `API.md` said
   `horizontal?` for `orientation` (fixed in this PR); the learn track said
   bars _require_ interval keys while point-keyed neighbour spans are
   supported (fixed in this PR); the `index.ts` package header still
   describes the M1 adapt-first state (rides with [PND-VSADAPT], which
   touches the same file).

**Endorsed as-is by the review (no action):** histogram stays a `BarChart`
mode; `BarList`/`BoxList` stay separate DOM tables; `BoxPlot` never computes
quantiles; [PND-LIVELYR] continues separately.

---

## Verbatim review

For a static `TimeSeries`, the happy path is genuinely seamless:

```tsx
<ChartContainer width={640}>
  <ChartRow height={220}>
    <Layers>
      <BarChart series={series} column="cpu" />
    </Layers>
  </ChartRow>
</ChartContainer>
```

The range, x-axis kind, and implicit y-axis are inferred; point-keyed bars
get sensible width from neighbour spacing. `BoxPlot` similarly consumes
quantile columns directly.

Holistically, though, I'd describe the API as:

- **Excellent data seam**
- **Good composition model**
- **Uneven behavioral and type seam**

The basic experience is about 8/10. Switching among bars, histograms,
horizontal bars, categories, and lists drops closer to 6/10 because internal
modes leak into user-visible behavior.

### Shape-by-shape

| Goal                    | Current route                                          | Assessment                                   |
| ----------------------- | ------------------------------------------------------ | -------------------------------------------- |
| Time bars               | `TimeSeries → <BarChart series column>`                | Very clean                                   |
| Box plot                | `aggregate(...) → <BoxPlot series lower…upper>`        | Clean and explicit                           |
| Histogram               | `series.byColumn(...) → <BarChart bins column>`        | Natural pond pipeline                        |
| Stacked time bars       | `partitionBy().aggregate().toMap() → <BarChart>`       | Particularly good; alignment is automatic    |
| Horizontal numeric bins | `bins + orientation="horizontal"`                      | Works, but owns a separate value-x container |
| Horizontal categories   | `bins + ordinal + manually coordinated YAxis ticks`    | Noticeably awkward                           |
| Ranked entity rows      | `listRowsFromTimeSeries → BarList`, or facts → BoxList | Correct architecture, one shaping step       |
| Live source             | snapshot/memoize into a `TimeSeries`                   | Not seamless yet; tracked as [PND-LIVELYR]   |

The gallery funnel exposes the horizontal-category gap: it manually converts
stages into ordinal bins and separately builds `i + 0.5` ticks because
`categories + horizontal` is rejected (`website/src/examples/gallery-funnel.tsx`).

### What is working well

The strongest decision is that chart components accept pond objects
directly. Consumers normally never call `barsFromTimeSeries` or
`boxFromTimeSeries`; those are internal normalization layers. Box
distributions are `aggregate → BoxPlot`; histograms are `byColumn → BarChart
bins`; time bars are `aggregate → BarChart series`.

Two larger architectural calls endorsed: histogram should remain a
`BarChart` mode, not a separate component; `BarList`/`BoxList` should remain
separate DOM tables (sorting, links, aligned cells, and expanders are table
semantics — #585 made the right split); `BoxPlot` should not compute
quantiles.

### Where the API stops feeling seamless

1. **The typed library loses its column types at the chart boundary.**
   `BarChartProps`, `BoxPlotProps`, and the other layers are generic over the
   schema, but column props are plain `string`. `<BarChart series={series}
column="typo" />` and `<BoxPlot series={series} lower="host"
upper="missing" />` compile and fail at runtime — out of character when
   core exports `NumericColumnNameForSchema<S>`. `BarChart` also models every
   source and column prop as independently optional, then validates legal
   combinations during rendering. Highest-value improvement: same JSX, but
   `BarChartProps` as a discriminated union of valid flat shapes with column
   names constrained to numeric schema columns.
2. **Behavior depends on the acquisition path, not just the visible mark.**
   `series + column` uses `drawBars`; `bins`, `categories`, horizontal bars,
   and wide columns use `drawStacks` — changing whole-slot vs drawn-segment
   hit targets, cursor/readout availability, whether `BarStyle.hover`
   applies, stable-identity behavior, and decimation. `BarStyle.hover`'s
   narrow scope needs a substantial warning in its own type documentation;
   #584 similarly had to document that only direct single-series vertical
   bars get full-height slot hits. Capabilities should follow normalized
   visual semantics — "one-segment vertical bar" — rather than which input
   prop produced it.
3. **Horizontal categorical bars are missing.** `categories` is
   vertical-only, although horizontal categories are a natural funnel /
   ranking / comparison form. The renderer already handles horizontal
   stacks; the missing work is primarily the categorical y-axis and the
   interaction contract. `BarList` does not eliminate this need.
4. **Concrete documentation/export inconsistencies.** Docs advertise
   `fromValueSeries`, `barsFromValueSeries`, and `boxFromValueSeries`, but
   the package root exports only the `TimeSeries` adapters (and the package
   exposes only `"."`, so `data.ts` is unreachable). `API.md` still calls
   the bar prop `horizontal?`; the real API is `orientation`. The learning
   track says bars require interval keys and must be aggregated first, while
   the implementation supports point-keyed bars through neighbour-derived
   spans. The package header still describes the old M1/adapt-first state.

### What I would do next

In order: (1) consistency cleanup — export the documented ValueSeries
adapters or stop documenting them as public, then correct `API.md` and the
point-key bar teaching; (2) type-only hardening — valid-mode unions and
schema-derived numeric column names, no runtime or JSX redesign; (3)
normalize one-segment bar behavior — direct-series and one-column-bin bars
share interaction/style capabilities where axis semantics permit; (4) add
horizontal categories — the gallery funnel is sufficient evidence; (5)
continue [PND-LIVELYR] separately.

**Yes, pond makes a `TimeSeries` easy to visualize. The remaining problem is
not getting data onto the canvas; it is making all the visually similar bar
modes equally type-guided and behaviorally predictable.**
