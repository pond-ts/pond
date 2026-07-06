# RFC: Financial charts — a first-class `<Candlestick>` (and the OHLC-bar variant)

> _Drafted by the pond-ts library agent (Claude) from pjm17971's spec,
> 2026-07-05. Tidal is the driving consumer (the financial counterpart of
> estela). A build spec + API proposal for red-team — the component shape is
> pjm17971's; this RFC grounds it against the current `BoxPlot` / theme / tracker
> code, resolves the two forks pjm17971 flagged, and carries one amendment (the
> theme defaults). **Not a commitment** (CLAUDE.md → Strategic RFCs); adopted
> phases land in PLAN.md._

## 1. Motivation — the friction, verified

Tidal renders OHLC candlesticks today by **abusing `BoxPlot`**, and every step
of that abuse is real (verified against the source):

1. **OHLC → 5 quantile slots.** `BoxPlot` takes `lower`/`q1`/`median`/`q3`/`upper`
   (`BoxPlot.tsx:19`) — the consumer remaps open/high/low/close onto quantile
   names that don't mean what they say.
2. **A `withColumn` pass to derive body extents.** The body is `min(open,close)`
   → `max(open,close)`, which `BoxPlot` can't compute — the consumer precomputes
   `bodyLo`/`bodyHi` columns before the layer sees them. (`BoxPlot` draws, it
   doesn't compute — by design.)
3. **Two overlaid layers for green/red.** There is **no per-box style hook** —
   a `BoxPlot` layer resolves _one_ theme role (`theme.box[as] ?? default`) for
   _all_ its boxes (`BoxPlot.tsx:124`). Direction colouring means splitting the
   data into an up-layer and a down-layer.
4. **Tracker labels by column, not `as`.** `BoxPlot.sampleAt` hardcodes the
   column names as sample labels (`BoxPlot.tsx:149`), unlike `LineChart` which
   uses `as ?? column` — so the legend/readout merge keys on raw names (this is
   friction **F-charts-8 §3**).

A first-class component erases all four. `BoxPlot shape='solid'` (shipped) is a
_visual_ stopgap — it gives the candle look but still needs the quantile remap,
the body precompute, the two layers, and the column-name tracker. This RFC is
the real thing: an OHLC-native component that **only draws**, keeping windowing
in `aggregate(Sequence.calendar(...))` exactly as `BoxPlot` keeps quantiles out.

## 2. The component

```ts
export interface CandlestickProps<S extends SeriesSchema> {
  series: TimeSeries<S>;

  // OHLC column names — default to the conventional ones, so a standard
  // OHLCV series needs none of these: <Candlestick series={s} />
  open?: string; // default 'open'
  high?: string; // default 'high'
  low?: string; // default 'low'
  close?: string; // default 'close'

  as?: string; // semantic id → theme.candle[as]; ALSO the tracker sample label
  axis?: string; // scale selection, as elsewhere

  /** 'candle' = filled body + wicks (default); 'bar' = OHLC tick bars (left tick
   *  open, right tick close); 'hollow' = up hollow / down filled. */
  variant?: 'candle' | 'bar' | 'hollow';

  /** 'direction' = rising/falling from open vs close (default, market convention);
   *  'series' = one colour off the `as` entry, no green/red (keeps "colour =
   *  series" when a candle sits alongside coloured lines). */
  colorBy?: 'direction' | 'series';

  gap?: number; // px inset between candles, per BarChart/BoxPlot
}
```

Mirrors the library's conventions: OHLC named like `BandChart`'s `lower`/`upper`
(defaulted, so the common case is `<Candlestick series={s} />`); `as` / `axis` /
`gap` identical to every other layer; `variant` bundles the render modes the way
`BoxPlot` already bundles `shape: whisker | solid | none`.

**Draw-only + keying (the important design line).** The layer computes the body
extents `min/max(open,close)` **internally, per mark** (cheap) — the consumer
never runs the `withColumn` dance. It accepts **point-keyed OR interval-keyed**
series: for interval keys the candle spans `[begin, end)` like `BoxPlot`; for
point keys it derives a neighbour-spaced width like `BarChart`. This is the big
ergonomic win over `BoxPlot` (which is interval-keyed only): **raw daily OHLCV
feeds straight in, no `aggregate` pass**. Aggregated bars are the identical call
on a coarser series (`aggregate(Sequence.calendar('week'|'month'), …)`).

## 3. Theme — with one amendment

The up/down colours live in the theme, not consumer overlays, so direction
colouring is a design decision and not hand-mixed hex:

```ts
interface CandleStyle {
  rising: { body: string; wick: string };
  falling: { body: string; wick: string };
  neutral?: { body: string; wick: string }; // doji (open === close)
  bodyWidth?: number; // fraction of the slot
  wickWidth: number;
}
// ChartTheme gains:  candle: { default: CandleStyle; [semantic: string]: CandleStyle }
```

This slot shape is structurally identical to `band`'s `outer`/`inner` and slots
into `ChartTheme` via the established pattern (`theme.candle[as] ?? default`,
`ScatterChart`/`BoxPlot`-style resolution) — no new mechanism.

**Amendment (the one real tension).** Charts must not bake in a consumer's brand
([[charts-no-consumer-themes]]). So `defaultTheme.candle` ships **neutral,
non-brand defaults — not literal market green/red.** But unlike `line.default`
(one colour), a candle is _unreadable_ with a single colour: rising vs falling
**must differ** to mean anything. Resolution: the neutral default is a
**distinguishable-but-unbranded pair** (a desaturated up/down), renderable out of
the box; Tidal supplies the real market green/red from its own CSS tokens via
`cssVarTheme`. Charts owns the _type_ + a renderable neutral default; the market
palette is a consumer decision — canon preserved.

`colorBy: 'series'` stays: when a candle sits beside coloured lines, "colour =
series" wins and the green/red question doesn't arise.

## 4. Tracker — resolving fork 1

**Fork 1 (pjm17971): full `{open,high,low,close}` on hover?** — **Yes.** And it's
the _same feature_ as the "snap to the box, show a y-pill per OHLC" ask. The
plumbing already exists: `sampleAt` returns an **array** and the tracker fans one
y-pill per sample (`BandChart` returns 2, `BoxPlot` returns 5 — verified). So:

- `Candlestick.sampleAt` returns up to **four** value samples (O/H/L/C). Each is a
  **value-only** y-axis pill — respecting THE LAW (an indicator shows the axis
  _value_, never a label; [[charts-wave-status]]).
- **Primary/legend readout keys on `as`** and shows **close** (the conventional
  "the price"), so the legend merge keys on the series id like every other layer.
  This is where the F-charts-8 §3 fix is a **prerequisite** — the tracker sample
  label must be `as ?? column`, not the raw column name (the same fix `BandChart`
  and `BoxPlot` need; batched into the follow-on wave).
- **Opt-in richer readout** renders all four O/H/L/C pills (a `showOHLC`-style
  flag) for a full quote on hover.

**One gotcha (the "crosshairs don't grab box plots" friction).** `BoxPlot` is
_excluded from x-snap_ because it sets `cursorFlag` (`Layers.tsx:377` skips
`cursorFlag` layers). `Candlestick` **must participate in x-snap** — snap the
vertical to the candle's x — i.e. it must not inherit `BoxPlot`'s cursorFlag
exclusion. That's what makes the cursor actually land on candles.

## 5. Variants — resolving fork 2

**Fork 2 (pjm17971): bundle the OHLC-bar look, or a separate `<OHLCBar>`?** —
**Bundle**, via `variant`. Same data contract (OHLC), same theme
(rising/falling), same tracker, same hit-test — a separate component duplicates
the whole surface for a _rendering_ difference. Precedent is right there:
`BoxPlot` bundles `whisker`/`solid`/`none` as `shape` variants of one component.
`variant: 'candle' | 'bar' | 'hollow'` is the same move, one import, one mental
model. (Split only if the bar needed a different _data_ contract — it doesn't.)

## 6. Relationship to `BoxPlot`

`<Candlestick>` **supersedes `BoxPlot shape='solid'` for OHLC** and leaves
`BoxPlot` for genuine box-and-whisker statistics. It can reuse `box.ts` body/wick
geometry internally (the body rect + the wick line are the same primitives), but
exposes the OHLC contract, direction colouring, point-key acceptance, and the
`as`-keyed tracker. `solid` isn't ripped out (someone may use the look on
non-OHLC data), it just stops being the OHLC path.

## 7. Adjacent — the trading-calendar axis (forward context, out of scope)

Tidal's _other_ first-order need (PLAN → Tidal §) is a **trading-calendar x-axis**
that skips weekends / non-trading days and intraday overnight gaps — a
non-wall-clock x adjacent to the value-axis machinery. It's a real financial-chart
requirement but a **separate axis concern**, not part of the candle mark. Noted
here so the financial-charts surface is legible as a whole; its own RFC when Tidal
pulls on it.

## 8. Scope / phasing

- **Phase 1 — `<Candlestick variant='candle'>`.** OHLC props + internal body
  extents + point/interval keying + `theme.candle` (neutral default) +
  `colorBy: 'direction' | 'series'` + `as`-keyed tracker (close). Depends on the
  F-charts-8 §3 tracker-`as` fix.
- **Phase 2 — `variant: 'bar' | 'hollow'`** and the opt-in 4-pill OHLC readout.
- **Cross-cutting dependency:** the tracker-label-by-`as` fix and interval-mark
  x-snap participation are shared with `BoxPlot`/`BandChart` — land them in the
  follow-on charts wave so candlestick inherits them.

## 9. Open questions for red-team

1. **Doji / `neutral`.** When `open === close` (or within an epsilon), draw the
   `neutral` style — is a config epsilon worth it, or is exact-equality fine?
2. **Default tracker richness.** Close-only pill by default with opt-in O/H/L/C
   (proposed), or all four always? Four pills can crowd a dense chart.
3. **Volume.** OHLC**V** — is a paired volume sub-panel in scope for the
   financial-charts surface, or strictly a separate `BarChart` row the consumer
   composes? (Lean: consumer composes; the library shouldn't fuse panels.)
4. **`bodyWidth`/`gap` interaction** with the neighbour-derived span on
   point-keyed series — what's the sensible default candle width vs the slot?

## Amendment 1 — Phase 1 adopted + shipped

> _Built by the pond-ts library agent (Claude), 2026-07-06, on
> `feat/charts-candlestick`. Phase 1 (§8) is now in `@pond-ts/charts` and
> recorded as a commitment in PLAN.md; this RFC stays as the "why". Handing the
> component to Tidal to drive the next friction wave._

**What shipped.** `<Candlestick>` (`src/Candlestick.tsx`) + geometry/draw
(`src/ohlc.ts`) + the `OhlcSeries`/`ohlcFromTimeSeries` reader (`src/data.ts`) +
the `theme.candle` slot (`CandleStyle`, neutral defaults on both in-repo themes).
`variant: candle|bar|hollow`, `colorBy: direction|series`, `gap`, and `showOHLC`
(the §9-Q2 opt-in four-pill readout — folded into Phase 1 since it's trivial and
Tidal wants the full quote). Point-keyed raw OHLCV and interval-keyed rollups
both feed in; the neighbour-spacing math is shared with `BarChart` via an
extracted `neighbourSpans` helper. 28 unit tests over the geometry/draw; a
feature-axis Storybook fan-out (per-variant, colour, doji, gap, keying, cursor,
theme + a price/volume two-panel scenario).

**Resolution of the §4 cursor gotcha (the one real design fork in the build).**
The RFC framed the OHLC readout as a `BoxPlot`-style consolidated `cursorFlag`
and warned that Candlestick "must not inherit BoxPlot's `cursorFlag` x-snap
exclusion." The cleaner resolution the code takes: Candlestick implements **plain
`sampleAt` (like `BandChart`), and does _not_ implement `cursorFlag` at all.**
Both the crosshair x-snap (`Layers.tsx`) and the per-series y-pills key off
"layer has no `cursorFlag`", so a candle joins **both** for free — the reticle
lands on candles and each price shows as a value pill — with **zero changes to
`context.ts`/`Layers.tsx`**. Consequence: follow-on wave item **(c)
"interval/OHLC marks join x-snap"** is **moot for Candlestick** (it never opted
out); (c) survives only as a `BoxPlot` concern. The default readout is the
single `close` pill keyed on `as`; `showOHLC` fans all four.

**Open questions, as resolved for Phase 1:** Q1 (doji) — **exact equality**, no
config epsilon (a doji draws a 1px `neutral` body). Q2 (tracker richness) —
**close-only default, `showOHLC` opt-in** (shipped). Q3 (volume) — **consumer
composes** a separate `<BarChart>` row (the scenario story shows it); the library
does not fuse panels. Q4 (`bodyWidth`) — **`0.8` of the slot** by default (the
theme sets `0.7`); the wick sits at the slot centre, `gap` insets the slot.

**Carried, not built:** selection/`hitTest` (rides the selection RFC, not this
one) and the follow-on wave (tracker-label-by-`as` §F-charts-8, BoxPlot
line-shape, clamp-on-ingest). **One breaking edge to flag at release:**
`ChartTheme.candle` is a **required** slot — an external hand-built theme must
add it (human-approval gate per CLAUDE.md, since it's a public-type widening).
