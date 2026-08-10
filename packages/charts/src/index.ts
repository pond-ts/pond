/**
 * `@pond-ts/charts` — the visualization end of pond.
 *
 * Canvas-rendered, streaming-first time-series charts with a
 * react-timeseries-charts-style declarative layout: compose
 * `<ChartContainer>` → `<ChartRow>` → `<Layers>` → draw layers
 * (line/area/band/scatter/bar/box/candle), plus the standalone DOM row lists
 * ({@link BarList} / {@link BoxList}). **The data contract is the pond series
 * itself** — every layer takes a `TimeSeries` / `ValueSeries` (or a
 * partition `Map`, `byColumn` bins, category records) directly and shapes
 * internally; an adapter you must call when starting from a series is an API
 * failure (`docs/notes/charts-api-review-2026-08.md`). The exported `from*`
 * view builders are **interop escape hatches** for non-pond data only.
 *
 * Architecture (typed-array store → decimator → canvas renderer → React
 * shell): `docs/rfcs/charts.md`; roadmap: `PLAN.md`. {@link Canvas} is the
 * low-level DPR-aware primitive the rows sit on.
 *
 * @packageDocumentation
 */

export { Canvas } from './Canvas.js';
export type { CanvasProps, CanvasDraw } from './Canvas.js';

export { ChartContainer } from './ChartContainer.js';
export type { ChartContainerProps } from './ChartContainer.js';
export { ChartRow } from './ChartRow.js';
export type { ChartRowProps } from './ChartRow.js';
export { Layers } from './Layers.js';
export type { LayersProps } from './Layers.js';
export { YAxis } from './YAxis.js';
export type { YAxisProps } from './YAxis.js';
export { XAxis } from './XAxis.js';
export type { XAxisProps } from './XAxis.js';
// The derived-unit relabeling an `<XAxis transform>` takes (strike↔moneyness,
// σ↔delta) — exported so consumers can name/share their transforms.
export type { AxisTransform } from './derivedTicks.js';
export { TimeAxis } from './TimeAxis.js';
export { CategoryAxis } from './CategoryAxis.js';
// Heat map — a grid of cells, bins on x and the series' columns as rows,
// colour encoding the value ([PND-HEATMAP]). A single column is a stripe,
// drawn by the same path.
export { HeatMap } from './HeatMap.js';
export type { HeatMapProps } from './HeatMap.js';
export { bandedColor, heatValueExtent } from './heat.js';
export type { HeatStyle } from './heat.js';
export type { AxisFormat, CursorFormat } from './format.js';
export { LineChart } from './LineChart.js';
export type { LineChartProps } from './LineChart.js';
export { BandChart } from './BandChart.js';
export type { BandChartProps } from './BandChart.js';
export { AreaChart } from './AreaChart.js';
export type { AreaChartProps } from './AreaChart.js';
export { ScatterChart } from './ScatterChart.js';
export type { ScatterChartProps } from './ScatterChart.js';
export { BoxPlot } from './BoxPlot.js';
export type { BoxPlotProps } from './BoxPlot.js';
export { BarChart } from './BarChart.js';
export type { BarChartProps } from './BarChart.js';
export { Candlestick } from './Candlestick.js';
export type { CandlestickProps } from './Candlestick.js';
export type { CandleVariant, ColorBy } from './ohlc.js';
// The list family — DOM-rendered *ranked row lists* (the react-timeseries-charts
// `HorizontalBarChart` shape, reconceived as a table): one row per entity, a
// proportional bar / five-number box line per configured column, data cells,
// custom sort, per-row expander. Standalone — no <ChartContainer> (the in-plot
// horizontal bars remain `<BarChart orientation="horizontal">`).
export { BarList } from './BarList.js';
export type { BarListProps } from './BarList.js';
export { BoxList } from './BoxList.js';
export type { BoxListProps } from './BoxList.js';
export { listRowsFromTimeSeries, listRowsFromValueSeries } from './list.js';
export type {
  ListRow,
  ListValue,
  ListCellSpec,
  ListMarker,
  ListSortDirection,
  ListRowsOptions,
  BarListColumn,
  BoxListColumn,
} from './list.js';

// The series key: rows enumerate the registered layers' resolved styles.
export { Legend } from './Legend.js';
export type { LegendProps, LegendPlacement } from './Legend.js';
export type { SwatchSpec, LegendItemInput } from './swatch.js';
// The headless legend — the same rows + hover/select sync as data, for
// consumers who design their own key (horizontal strips, ticker-compare,
// values-in-the-legend).
export { useChartLegend } from './useChartLegend.js';
export type { ChartLegend, LegendRow, LegendItem } from './useChartLegend.js';
export { scaleTradingTime } from './tradingTimeScale.js';
export type {
  TradingTimeScale,
  DiscontinuityProvider,
  TimeGrain,
} from './tradingTimeScale.js';
// The ordinal category (band) scale — the transpose view's "columns on x" axis.
export { scaleBand } from './bandScale.js';
export type { ScaleBand } from './bandScale.js';

// Annotations — user-authored marks in the turquoise register (distinct from the
// data): a shaded x span, a horizontal value line, a vertical x line, and a
// shaded y span (`<Zone>` — value-axis classifications: AQI categories, HR zones).
export { Region, Baseline, Marker, Zone } from './annotations.js';
export type {
  RegionProps,
  BaselineProps,
  MarkerProps,
  ZoneProps,
} from './annotations.js';
// The vocabulary a consumer's create toolbar needs: the armed-tool kind and the
// shape `onCreate` reports (`<ChartContainer creating={kind} onCreate={…}>`).
export type { AnnotationKind, CreateSpec } from './context.js';
// Axis indicators — a value pill pinned to an axis edge (the ChartIQ live tag).
// `createLiveValue` is the high-frequency, isolated-repaint update path.
export { YAxisIndicator, createLiveValue } from './indicators.js';
export type { YAxisIndicatorProps, LiveValue } from './indicators.js';

export {
  fromTimeSeries,
  bandFromTimeSeries,
  boxFromTimeSeries,
  barsFromTimeSeries,
  barsFromBins,
  ohlcFromTimeSeries,
  // Stacked / histogram readers — assemble a StackedBarSeries from pond's own
  // aggregation output: a Map of grouped series, a wide series, or byColumn bins.
  stacksFromGroups,
  stacksFromColumns,
  stacksFromBins,
  // Categorical row-read: one bar per `{ label, value }` on the category axis.
  categoryStack,
  // The transpose reader — one row of a wide series read across into categories.
  transposeRow,
} from './data.js';
export type {
  ChartSeries,
  BandSeries,
  BoxSeries,
  BoxColumns,
  BarSeries,
  OhlcSeries,
  OhlcColumns,
  StackedBarSeries,
  BinRecord,
  StacksFromBinsOptions,
  CategoryDatum,
  RowAt,
  TransposeRowOptions,
} from './data.js';
// The histogram bar orientation (`'vertical'` | `'horizontal'`).
export type { Orientation } from './bars.js';

// Scatter's data-driven point encoding (radius / colour from columns via
// scales) — the deliberate, signed-off exception to single-channel styling.
export type { RadiusEncoding, ColorEncoding } from './encoding.js';

export type { Curve } from './curve.js';

// Shared gap-rendering mode for the gap-aware draw layers (line / area / band).
export type { GapMode } from './gaps.js';

// `<LineChart decimate>` control — M4 viewport decimation (default on).
export type { DecimateOption } from './decimate.js';

export { defaultTheme, estelaTheme } from './theme.js';
export type {
  ChartTheme,
  LineStyle,
  BandStyle,
  AreaStyle,
  ScatterStyle,
  ScatterStates,
  BoxStyle,
  BoxStates,
  BoxLadder,
  HeatStates,
  CandleStyle,
  BarStyle,
} from './theme.js';

// CSS-custom-property → ChartTheme bridge: build a theme from a design system's
// tokens (`cssVarTheme`), and a hook that re-resolves it on a `data-theme`
// toggle so a canvas chart follows dark/light (`useChartTheme`).
export { cssVarTheme } from './css-theme.js';
export type { ChartThemeOverrides, VarReader } from './css-theme.js';
export { useChartTheme } from './useChartTheme.js';
export type { UseChartThemeOptions } from './useChartTheme.js';

// Cursor presets — the mounted-component successors of the `cursor` string
// modes (interaction RFC §4/A4.1): mount one as a child of <ChartContainer>
// (the default for every row) or inside a <ChartRow> (the per-row override).
// The underlying CursorSpec / ResolvedCursorFrame contract stays unpublished
// until the presets have proven it (RFC Q3).
export {
  LineCursor,
  PointCursor,
  InlineCursor,
  FlagCursor,
  CrosshairCursor,
  RangeCursor,
} from './cursors.js';
export type {
  LineCursorProps,
  PointCursorProps,
  InlineCursorProps,
  FlagCursorProps,
  CrosshairCursorProps,
  RangeCursorProps,
} from './cursors.js';
// Click-select as a mounted component (interaction RFC §7): mounting
// `<Selector>` is what enables a plot click at all — `selected` / `hovered`
// stay on `<ChartContainer>` (A1.2), so controlled highlighting needs none.
// `<MultiSelector>` (RFC §8) is its sweep superset: a click still selects one
// mark, a drag sweeps many and releases `(hits, modifiers, span)` (A5.2).
export { Selector, MultiSelector } from './selectors.js';
export type { SelectorProps, MultiSelectorProps } from './selectors.js';

// Public interaction types — the callback params for the tracker + selection
// (`onTrackerChanged`, `onSelect`), the `cursor` mode, and the span a
// `<RangeCursor>` drag releases (`onDragRelease` — `{ x: [lo, hi], y? }`,
// RFC A3.3's uniform 1-D/2-D shape).
export type {
  CursorMode,
  TrackerInfo,
  TrackerSample,
  SelectInfo,
  SelectModifiers,
  RangeSpan,
  SpanSelection,
  SelectionEntry,
} from './context.js';

// Span-selection membership (interaction RFC A5.2) — the same predicate the
// layers run per mark, exported so a consumer editing a mixed `selected` array
// never re-implements the interval test, plus the entry discriminant.
export { selectionContains, isSpanSelection, sameMark } from './span.js';

// Draw-stats observability — the `onDrawStats` callback's frame + per-layer line.
export type { DrawStatsFrame, LayerDrawInfo } from './context.js';
