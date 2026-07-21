# PND_CHARTS_PLAN — `@pond-ts/charts` remaining work

> Breakout plan for the **Charts** roadmap section in [PLAN.md](../../PLAN.md).
> Architecture: [docs/rfcs/charts.md](../rfcs/charts.md). Full shipped history
> of the canvas wave (M0–M4, chart types, decimator, cursor model, annotations,
> trading-time axis, categorical axis):
> [docs/archive/charts-wave-2026.md](../archive/charts-wave-2026.md).

The canvas wave (kicked off 2026-06-17) shipped the rendering spine, seven
chart types, the full interaction stack (cursor modes, pan/zoom, selection
Phase 1, annotations), the M4 decimator (pan-FPS cliff closed to 1M points),
the trading-time axis, and the categorical axis Phase 1. The package is still
`"private": true`; what remains is landing the built-but-unmerged work,
Phase-2 slices of the adopted RFCs, and the M5 parity gate that flips the
first publish.

## Tasks

### [PND-CATAX] — Land categorical axis Phase 1

The three PRs (band-scale foundation, `transposeRow` reader, per-column
`mark` identity + label policy) are **built and verified on
`feat/charts-categorical-axis` but not yet pushed**. Landing sequence per PR:
self-review → Layer-2 → a Codex pass (a new scale primitive warrants it); the
`SelectInfo.mark` widening needs the human-approval gate. The RFC's own owed
Codex red-team (§12.3) runs in parallel.

Deferred beyond Phase 1 (stay RFC-only until adopted): the metric branch
(value-x coordinates — Tidal/Estela), the cursor binding / head-row (Phase 2),
label rotation. RFC:
[docs/rfcs/categorical-axis.md](../rfcs/categorical-axis.md).

### [PND-PARITY] — M5 estela parity + first publish

Faithful `DataChart` reproduction on real activity data; prove no-regressions;
hand the production swap to the estela agent; flip `private: false` and
publish. Known M5 gates collected along the way:

- **Statistical bands** (named an M5-parity gate in the decimator wave).
- **Theme tokens required → optional-with-default** so a new chart type isn't
  a breaking `ChartTheme` change (deferred from the chart-type wave).
- Shared **axis-headroom** policy (no layer's auto-fit pads the top edge);
  BarChart hover-vs-select wide-bucket JSDoc (same deferral list).
- Open decision: how the estela swap is coordinated across the two agents.

### [PND-SELECT] — Selection Phase 2

Phase 1 (series-`id` identity, id-gates-interactivity) shipped. Phase 2, per
[docs/rfcs/selection.md](../rfcs/selection.md) A2/A3: the
`SelectInfo | null → readonly SelectInfo[]` widen + `selectionMode`
(multi-select, re-motivated as "pin several series to read");
`LineChart.hitTest` threshold nearest-point; the
`snapToClosest | snapToClosestSelected` prop; theme-referenced dim state.
The widen is a breaking public change — human-approval gate; estela's bar is
the sole external reader (shim for estela only).

### [PND-DECIM] — Decimator Phase 5

Bench-ordered remainder of the decimation plan
([docs/notes/charts-decimator-assessment-2026-07.md](../notes/charts-decimator-assessment-2026-07.md)):
candlestick decimation with Tidal as the driving consumer; Path2D cache
(M4.4) only if the pan bench still misses (it doesn't, except `three`-at-1M).
Backlog, documented: non-linear-`curve` decimation (a smoothing curve distorts
the 4-points-per-column polyline; fix = decimate then re-smooth). LTTB stays
an explicit opt-in; M4 is the auto-on default. The one-time competitive
head-to-head (uPlot + published AG Charts / klishevich) stays optional.

### [PND-BOXPLT] — Finish BoxPlot

The G3/G4 direction from the vol-smile review
([docs/notes/vol-smile-followups-2026-07.md](../notes/vol-smile-followups-2026-07.md)):
per-x range marks (bid/ask error bars) = finish `BoxPlot`, not a new mark —
`ValueSeries` widening, point-key neighbour-spacing width, optional
`q1`/`median`/`q3` for an honest range-only mode, px `offset` prop for same-x
call/put pairing. Plus the follow-on-wave items: a line-only /
stem-without-caps `shape` variant, and reconciling the `cursorFlag` x-snap
exclusion so crosshairs grab box plots (Candlestick never opted out; this
remains BoxPlot-only).

**Selection `id` — DONE** (#508 triage item 5). `<BoxPlot id>` extends the
shipped id-gated discrete contract via `boxAt` — rect-containment (the
interval-mark analog of `barAt`), not the still-RFC continuous-layer
threshold — returning a `SelectInfo` keyed on the box's `x` (span begin);
selected/hovered boxes outline (reusing `theme.box.stroke`, no new token).
**Scoped to BoxPlot only:** the geometry is a per-mark `boxAt`, consistent
with the existing `barAt`/`stackAt`/`ohlcIndexAtTime` idiom — the _contract_
(id-gated `hitTest`→`SelectInfo` + `registerSelectable`) is what's reused, not
a shared geometry abstraction. Candlestick would add its own `ohlcAt` under
the same contract when it gains selection (deferred — not requested by the
report; the earlier "shared geometry helper" framing is superseded by the
per-mark idiom the codebase already uses). **Still open in this wave:**
`ValueSeries` widening, range-only mode polish, px `offset`, line-only shape,
and the `cursorFlag` x-snap reconciliation.

### [PND-LEGEND] — `<Legend>` wave — DONE

Shipped (#512, after the #511 label prerequisite): the sender's #508 design
sketch built as specced — per-layer resolved `SwatchSpec` registration on all
seven marks (line/area/band/scatter/box/bar/candle; a **stacked bar registers
one row per group** with its resolved fill), container-level registry +
`rowOrder`, zero-config `<Legend placement>` card over the rows block,
`legend={false | 'name'}` per-layer opt-out/rename, optional `theme.legend`
slot (token-derived fallback — no theme type break, unlike the required
`candle` slot's gate), `items` escape hatch (standalone mode included).
**Deltas held:** row identity keys `id ?? label` (A2.2), interactions id-gated
via the shipped frame contract (hover echo + select toggle; the legend's
series-scoped `SelectInfo` carries `NaN` provenance, documented), show/hide
stays consumer-side (`onRowClick` is the override hook). Decisions of note:
the swatch/helpers module is `swatch.ts` (a `legend.ts` beside `Legend.tsx`
collides on case-insensitive filesystems); a one-group stacked shape
(horizontal single, categorical) registers under the layer identity, not the
`categoryStack` `'value'` sentinel.

**Follow-up (design pass, `feat/charts-legend-headless`, [Unreleased]):** a
**headless `useChartLegend()`** — the same rows as data (`selected`/`hovered`
state) plus chart-synced `hover`/`select`, the axis `gutters`, and
`cursorTime` (the values-in-the-legend seam: `series.nearest(cursorTime)`);
`<Legend>` re-renders through the same `buildChartLegend` core. Card polish
from the first live review: plot-area-inset placement, selection reads by
**contrast** (selected bold, others dulled — not a decorated selected row),
canonical three-dash line swatch, centred rounded bar swatch. **Row-scoping:
scope follows placement** — a `<Legend>` / `useChartLegend()` inside a
`<Layers>` scopes to that `<ChartRow>` (rowKey filter via `RowContext`) and
anchors to that row's plot (the plot cell is already `position: relative`);
container-level stays all-rows. New docs page
`website/docs/charts/interaction/legend.mdx` (card + headless live examples;
one-row-per-group + row-scoping in prose). New exports `useChartLegend` /
`ChartLegend` / `LegendRow` / `LegendItem` (rows group items by chart row).

### [PND-ANROLE] — Per-annotation colour via theme role map

#508 item 3. Inline per-mark colour rejected (same discipline as the per-box
red/green reject: colour = theme role, not call-site). Shape:
`theme.annotation.roles?: Record<string, { color; fillOpacity? }>` + a
`role?: string` prop on the three marks, resolving `roles[role] ??
annotation`; the depth ramp applies within the role's hue. `cssVarTheme` role
mapping lands in the same pass.

### [PND-YTICKS] — `YAxis` tick density — DONE

Shipped (#508 item 4). `<YAxis tickCount>` pins an explicit auto-tick target;
omitted, the count is **height-derived** (`resolveYTickCount(height)` ≈ 1
tick / 48px, floored at 2) so a short strip isn't crushed with a tall row's
density — the y mirror of the 0.44.1 width-derived x axis. Explicit `ticks`
still overrides both. **Key design point:** the count is resolved once per
axis in `ChartRow` (`row.tickCounts`) and read by the `<YAxis>` labels, the
readout formatter (`formats`), and the `Layers` gridlines — a single source
replacing the three hardcoded `5`s (`YAxis` `TICK_COUNT`, `ChartRow`
`AXIS_TICK_COUNT`, `Layers` `GRID_TICKS`) that previously agreed only by
convention, so label / gridline / readout can no longer drift.

### [PND-CURSOR] — Cursor/readout polish backlog

Deferred-until-a-design-call items, none blocking: scatter `inline`
**2D-nearest** readout (needs the pointer's y — a cursor-model change);
scatter flag staff from the dot's top for large encoded marks; the "‹ VAL"
callout; chip-vs-chip de-overlap (inline, and box+line in one row);
the **y-oriented region cursor** for horizontal histograms
([docs/notes/y-oriented-region-cursor-2026-07.md](../notes/y-oriented-region-cursor-2026-07.md),
parked until a real consumer needs it); the **`pointercancel` clear-only
fix** — the region cursor currently commits the span on `pointercancel`
(pre-existing; should clear instead — Layer-2 follow-up from #509). Timezone
control for the cursor readout is tracked with the trading-time work
([PND-TCAL] in [PND_FINANCIAL_PLAN.md](PND_FINANCIAL_PLAN.md)).

**Done from this backlog:** tracker-label-by-`as` (F-charts-8 §3) shipped in
#511 — BandChart edges and Candlestick `showOHLC` pills adopted BoxPlot's
`"<as> <role>"` qLabel convention (`iv lower`, `SPY high`), so readout/legend
merge keys are the series identity; no-`as` labels unchanged. This was the
[PND-LEGEND] label-source prerequisite.

### [PND-AXES] — Axis backlog + value-axis naming follow-up

Pull each in as a chart needs it, not before: time-label `align` place-prop
(`center`/`left`/`right`); wall-clock vs relative (elapsed) time axis; custom
labels at custom ticks (estela's intervals/splits); `<YAxis>` label position +
rotation; d3 scale variety (log / pow / sqrt). The deferred **value-axis
naming follow-up** rides here: `timeFormat` (needs an `<XAxis format>` →
cursor-readout coupling), `onTimeRangeChange`, the internal
`ContainerFrame.timeRange` field — one naming+neutrality pass
([docs/rfcs/value-axis.md](../rfcs/value-axis.md)).

### [PND-VALAX] — Value axis: remaining chart types + algebra growth

Box/Candlestick are still time-only on the x axis; widen them to
`ValueSeries` when a consumer pulls (BoxPlot's widening is part of
[PND-BOXPLT]). The `ValueSeries` **algebra grows late**, gated on a second
value-axis consumer (geo), not estela-alone — the type is the real
consolidation ([docs/rfcs/value-axis.md](../rfcs/value-axis.md)).

### [PND-THEME] — `cssVarTheme` candle mapping

LOW; from Tidal's F-charts-4. Deliverable: a candle branch in the
`CssVarTheme` story (rising/falling/neutral body+wick) + a documented
`--*-candle-*` var-name convention so the market palette is one declarative
overlay like the other slots — not new per-slot plumbing (the overlay is
already generic). Earns its keep when the next consumer adopts candles.

### [PND-WIDTH] — Responsive sizing / fill

Container currently needs an explicit px width (`F-charts-width`; estela is
the second consumer to hit it). The `useMeasuredWidth` `ResizeObserver`
pattern is documented as a recipe (#445); the library-side question is
whether `ChartContainer` should own a fill/auto-width mode.

### [PND-ANNRFC] — Annotations RFC write-up

The annotations system shipped (#306/#308/#309) and the staffed cursor-flag
landed (#270/#272), but the short `docs/rfcs/annotations.md` the owner asked
for ("to formalize") was never written. Confirm it is still wanted, then
write it as the durable design record (two registers, depth model, three
interaction modes, the interaction-mode W1/W2/W3 split).

## Core carry-forwards surfaced by charts

Tracked in [PND_CORE_PLAN.md](PND_CORE_PLAN.md): bundle-safe column-API
augmentation + validity-aware `toFloat64Array({ missing })` (F-1, two
consumers), `hasAnyDefined()`/`allMissing()`, the protobuf columnar wire
([PND-WIRE]), and `fromColumns({ onOutOfOrder })` clamp-on-ingest
([PND-INGEST] there).

## Open bug candidates (needs-repro)

- **Canvas async-width first mount** (#508 item 6): does NOT reproduce at the
  React/jsdom level (identical draw-op sequences on a ParentSize-style mount,
  plain + StrictMode; pin test landed in #510). Cause is below React or
  consumer-side; next step is Tidal's minimal browser repro (offered in the
  report).

## Parking lot (deferred, needs a second signal)

- `F-charts-area-gap-split` — a separate `outlineGaps` prop; cuts against the
  deliberate "area fill stays honest" design.
- `F-charts-theme-double-declare` — a vars-first `cssVarTheme` mode; mostly
  consumer-side, current shape buys the stable-ref + free dark toggle.
- Column → semantic-identifier **app-level registry** (global `column → as`
  mapping); composes above the per-chart `as` prop; estela adoption decides.
- Band gap treatment (a filled envelope's break wants its own design; bands
  always break honestly for now).
- M4.3 brush — skipped, no drivers.
