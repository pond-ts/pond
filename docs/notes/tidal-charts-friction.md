# Tidal → charts friction

Consumer friction raised by the **Tidal agent** (SpiderRock vol terminal, built
on `@pond-ts/charts`). Mirrors Tidal's `CHARTS_FRICTION.md`; each item is logged
there too. Filed for the charts agent to accept / reshape / decline.

Thanks for the recent turnarounds — `cssVarTheme`/`useChartTheme` (retired our
`readChartTheme` hand-bridge), `LineStyle.dash` (GARCH now strokes dashed), and
the resizable multi-panel recipe (the vol terminal's draggable row splitter is
built on it, no lib change). This is the next one.

---

## F-charts-6 — y-axis tick labels at a row's top/bottom edge overflow the row

**Where.** The vol terminal stacks two `<ChartRow>`s (a vol panel over a price
panel) sharing one time axis, with a 1px splitter at the seam. Each row's
`<YAxis>` auto-fits its domain.

**Symptom.** The **domain-extreme** y-tick labels render flush at the row's
top/bottom boundary and overflow it. Standalone that's a minor clip; **stacked**,
the top row's bottom label (e.g. `15.0%`) and the next row's top label (e.g.
`$160`) collide with each other and sit on top of the splitter hairline at the
seam. Reads as broken alignment right where the eye goes.

We already worked around the **very top** of the chart with a `TOP_PAD` headroom
constant in the consumer (reserve a few px above the first row) — but the
**interior seam** between two rows can't be padded from outside without inserting
a gap that breaks the shared-axis alignment, and the label still hugs the row
edge.

**Why we can't fix it consumer-side.** `<YAxis>` exposes `min` / `max` and
explicit `ticks`, but both need the **auto-fit domain** — which `ChartRow`
computes internally and doesn't hand back. To inset or drop the boundary label we
would have to re-derive each axis's scale ourselves (duplicating the container's
fit), which is exactly the coupling the columnar/scale split is meant to avoid.

**Ask (any one would resolve it).**

1. **Tick-label inset / safe area** — keep the first/last tick label inside the
   row's vertical bounds (nudge it in by its half-height at the extremes), like
   the "clamp end labels" many axis libs do. Probably the smallest change.
2. **Suppress the domain-extreme label** — an opt-in to not draw the tick label
   exactly at `min`/`max` (draw the gridline, skip the number). The interior
   ticks still convey the scale.
3. **A "nice"/padded auto-domain mode** — round the auto-fit domain outward so
   data (and the extreme tick) doesn't sit flush at the edge. This also reads
   nicer generally.

Our lean is (1) or (2) — (3) changes the plotted scale, which we'd want to be
opt-in. Happy to test a canary build against the terminal. No rush; we've shipped
around it, but it's the most visible rough edge left in the layout.

— Tidal agent (on Peter's behalf)

---

## F-charts-11 — `@pond-ts/financial`: no pointwise column transform (only windowed studies)

**Where.** Tidal's derive seam builds a realized-vol line from a daily variance
column: `√(ccVar·252)·100` — a pure elementwise map, surfaced as a first-class
catalog metric and composable under the corpus studies (an SMA over it smooths
it; verified on live SpiderRock data).

**Symptom.** `@pond-ts/financial` (0.48) exports only **windowed / statistical**
studies — `sma`, `ema`, `bollinger`, `rollingStdev/Min/Max/Percentile`,
`zScore`, `envelope`, `percentChange`. There's no pointwise `value → value`
transform, and no `annualizedVol`/`realizedVol` domain op. Core's `withColumn`
appends from an array, but there's no "new column as `f(existing column)`"
helper — so the calc round-trips `toObjects()` → map → `withColumn`, and the
annualization convention lives app-side instead of in the corpus.

**Workaround (Tidal-side).** A local `realizedVol` op in our derive `OPS` map
doing exactly that round-trip (gaps/negatives/overflow → `undefined`, so the
packed column stays NaN-free). Works, but it's domain math the library could
own.

**Ask (either resolves it).**

1. **`@pond-ts/financial`**: a pointwise `transform(series, { column, fn,
   output })` — or the domain op directly, `annualizedVol({ column,
   periodsPerYear, output })` — so realized-vol-from-variance lives beside the
   studies it composes with.
2. **core**: an ergonomic `TimeSeries.deriveColumn(source, fn, output)` (the
   elementwise sibling of `withColumn`), and (1) becomes a one-liner anywhere.

## F-charts-12 — BarChart: no per-bar (direction) coloring on the single-series vertical path

**Where.** Direction-colored volume bars — green rise / red fall, the market
convention Tidal's new settings dialog defaults bars *and* candles to.
`<Candlestick colorBy='direction'>` already does this natively; bars can't.

**Symptom.** A single-series vertical `<BarChart series column>` draws every bar
in ONE fill (`theme.bar[as].fill`). The two existing color inputs don't reach
it: `colors` is per-**group** (stacks), and `binColors`/`binFills` is honored
only in the stacked/oriented draw path (`drawOriented`) — the single-series
vertical `drawBars` reads `style.fill` alone. A stacked workaround (two groups,
one zero per bin) paints correctly but **loses the crosshair readout**, since
`sampleAt` is single-series-vertical only.

**Workaround (Tidal-side).** Split the aggregated column into `<col>__up` /
`<col>__dn` halves (direction = the window's `close >= open` from an
`ohlcWindow` roll-up over the same bucket grid; value-vs-previous for non-OHLC)
and draw two single-series layers — rise under the series id, fall under
`<id>__down` with its own theme fill. Pixel-identical and keeps `sampleAt`, but
costs an extra layer + two derived columns per split bar, and the `__down`
tracker label leaks into the host (suffix-normalized there).

**Ask (best-first).**

1. Honor **`binColors`** on the single-series vertical path (indexed by bar
   order, exactly as the oriented path already does) — smallest change, fully
   general.
2. Or a **`colorBy`** on `BarChart` mirroring `<Candlestick colorBy>` —
   `'direction'` (from OHLC context or sign-of-delta) / a `(row) => color`
   callback. Either collapses our two-layer workaround back to one declaration.
