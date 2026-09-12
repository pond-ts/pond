---
name: pond-charts
description: Drawing time-series data in a React app — line, area, band, bar, scatter, box plot, candlestick or heat-map charts over timestamped rows, live-updating charts fed by a stream, cursors and readouts, drag-to-select or zoom, annotations (regions, markers, baselines) — using @pond-ts/charts, which reads a pond-ts TimeSeries / LiveSeries directly on a canvas. Use whenever a TypeScript/React project needs to plot time series and pond-ts is (or could be) in its dependencies.
---

# Charts with `@pond-ts/charts`

Canvas-rendered, declarative React charts that consume a pond series with no
adapter layer. Point count is a rendering cost, not a DOM-node count, so
hundreds of thousands of points are fine.

```sh
npm install @pond-ts/charts @pond-ts/react pond-ts   # all three at the same version; React 18 or 19
```

## Compose: container → row → layers

```tsx
import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  BandChart,
  BarChart,
  YAxis,
} from '@pond-ts/charts';

<ChartContainer width={width} cursor="crosshair" panZoom>
  <ChartRow height={260}>
    <YAxis id="cpu" format=".0%" />
    <Layers>
      <BandChart series={bands} lower="lower" upper="upper" axis="cpu" />
      <LineChart series={bands} column="avg" axis="cpu" />
    </Layers>
  </ChartRow>
  <ChartRow height={120}>
    <YAxis id="req" />
    <Layers>
      <BarChart series={perMinute} column="requests" axis="req" />
    </Layers>
  </ChartRow>
</ChartContainer>;
```

- `width` is a number of CSS pixels, or `'auto'` to measure the parent. `'auto'`
  needs a parent with a **definite** width (a flex child without `min-width: 0`
  or a content-sized box measures 0 and the chart stays blank, no error). Pass a
  number when the width is known — it skips the measure pass. Recipe:
  <https://pond-ts.org/docs/recipes/responsive-width>.
- Rows stack vertically and **share the x scale**: pan, zoom and cursor move
  together. Omit `range` to auto-fit the data; pass `[begin, end]` to pin it.
- The x-axis kind is **inferred from the series**: a `TimeSeries` gives a time
  axis, a `ValueSeries` (`series.byValue('distance')`) gives a value axis, with
  no prop change.
- Do the maths in pond first — `rolling`, `aggregate`, `align`, `baseline` —
  then hand the result to a layer. Layers draw columns; they do not compute.

## Layer → data contract

| Layer          | Reads                                                                      | Note                                                          |
| -------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `LineChart`    | one numeric `column`                                                       | `curve` smooths drawing only; denoise data with `smooth()`    |
| `AreaChart`    | one `column`, filled down to `baseline` (a number)                         | fill colour comes from `theme.area`, not a prop               |
| `BandChart`    | `lower` + `upper` columns                                                  | always breaks on a gap                                        |
| `ScatterChart` | `column` (+ optional `radius` / `color`)                                   | selectable when the layer is given an `id` prop               |
| `BarChart`     | `series` **xor** `bins` **xor** `categories`; `column` **xor** `columns[]` | one-of rules throw; `orientation="horizontal"` for histograms |
| `BoxPlot`      | `lower`+`upper` required; `q1`/`q3`/`median` optional                      | does **not** compute quantiles — reduce first                 |
| `Candlestick`  | `open`/`high`/`low`/`close` (defaults to those names)                      | `TimeSeries` only; any missing price ⇒ no candle              |
| `HeatMap`      | a `series` of binned rows (one row per x-bin, one column per y-row)        | 2-D; see the docs page                                        |

Gaps: represent missing data as `undefined` / `NaN` in the series, never as
zero; line/area take a `gaps` prop for how to render them.

## Live data

A `LiveSeries` renders through the same layers. In React, own it with
`useLiveSeries` (returns `[live, snapshot]`) or read a throttled snapshot of
any live view with `useSnapshot`; pass the snapshot as `series`. Push into
`live`; the chart re-renders on the snapshot cadence, not per event.

## Interaction and annotation

- Container `cursor`: `'line' | 'point' | 'inline' | 'flag' | 'crosshair' | 'region' | 'none'`; per-row override on `ChartRow`.
- `panZoom` on the container for drag-pan + wheel-zoom.
- `<Selector>` / `<MultiSelector>` mount selection on bar and scatter layers; `<RangeCursor>` for a draggable span.
- Annotations as layers: `<Region>`, `<Marker>`, `<Baseline>`, `<Zone>`; `<YAxisIndicator>` pins a live value on the axis.
- Trading-time axis: pass `calendar={tradingCalendar}` on the container so
  closed hours collapse (needs `@pond-ts/financial`).

## Theming

Omit `theme` to get `defaultTheme`. Pass one `ChartTheme` object on the
container (`theme={{ ...defaultTheme, line: { ... } }}`), or derive one from
CSS variables with `cssVarTheme(defaultTheme, (readVar) => ({ line: {
default: { color: readVar('--accent') } } }))` — every slot is `{ default:
Style, [semantic]: Style }` and a `LineStyle` has `color` / `width`, an
`AreaStyle` adds `fill` / `fillOpacity`. Never colour per component when a
theme slot exists.

## Pitfalls

1. `width` as a `%` string, or `'auto'` inside a content-sized parent — nothing draws, no error.
2. Feeding raw ticks to a chart and expecting smoothing — use `rolling` /
   `aggregate` upstream.
3. `BarChart` given both `series` and `bins`, or `column` and `columns` — throws by design.
4. `BoxPlot` given raw values — it draws the quantiles you already computed.
5. Rebuilding point arrays per frame for a custom draw — use
   `series.column(name).toFloat64Array()` (zero-copy).
6. Mismatched versions across `pond-ts`, `@pond-ts/react`, `@pond-ts/charts`.

## Read next

- Cheat sheet (whole surface on one page): <https://pond-ts.org/docs/charts/cheat-sheet>
- Learn charts (nine short chapters): <https://pond-ts.org/docs/learn-charts>
- Single-file dump of the charts docs: <https://pond-ts.org/llms-charts.txt>
- `node_modules/@pond-ts/charts/API.md` — every export with its source file.
