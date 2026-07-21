/**
 * `@pond-ts/charts` — the visualization end of pond.
 *
 * Canvas-rendered, streaming-first time-series charts with a
 * react-timeseries-charts-style declarative layout. The architecture (hard
 * layers: adapter → typed-array store → decimator → canvas renderer → React
 * shell) is documented in the charts RFC at `docs/rfcs/charts.md`; the
 * milestone plan lives in `PLAN.md`. (A Path2D path cache was explored and
 * deferred — it doesn't help the pan case, which re-decimates every frame; see
 * the [PND-DECIM] floor decision.)
 *
 * **M1 — rendering spine.** The layout shell + the first draw layer:
 * `<ChartContainer>` (time axis) → `<ChartRow>` (y-axis + canvas) →
 * `<LineChart>` (a gap-aware line), fed from a pond `TimeSeries` via
 * {@link fromTimeSeries}. Axes, themes, the variance band, and interactions
 * land in M2–M4. {@link Canvas} is the low-level DPR-aware primitive the rows
 * sit on.
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
// data): a shaded span, a horizontal value line, a vertical x line.
export { Region, Baseline, Marker } from './annotations.js';
export type { RegionProps, BaselineProps, MarkerProps } from './annotations.js';
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
  BoxStyle,
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

// Public interaction types — the callback params for the tracker + selection
// (`onTrackerChanged`, `onSelect`) and the `cursor` mode.
export type {
  CursorMode,
  TrackerInfo,
  TrackerSample,
  SelectInfo,
} from './context.js';

// Draw-stats observability — the `onDrawStats` callback's frame + per-layer line.
export type { DrawStatsFrame, LayerDrawInfo } from './context.js';
