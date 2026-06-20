/**
 * `@pond-ts/charts` — the visualization end of pond.
 *
 * Canvas-rendered, streaming-first time-series charts with a
 * react-timeseries-charts-style declarative layout. The architecture (hard
 * layers: adapter → typed-array store → decimator → chunked Path2D cache →
 * canvas renderer → React shell) is documented in the charts RFC at
 * `docs/rfcs/charts.md`; the milestone plan lives in `PLAN.md`.
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
export { LineChart } from './LineChart.js';
export type { LineChartProps } from './LineChart.js';
export { BandChart } from './BandChart.js';
export type { BandChartProps } from './BandChart.js';
export { AreaChart } from './AreaChart.js';
export type { AreaChartProps } from './AreaChart.js';
export { BoxPlot } from './BoxPlot.js';
export type { BoxPlotProps } from './BoxPlot.js';

export {
  fromTimeSeries,
  bandFromTimeSeries,
  boxFromTimeSeries,
} from './data.js';
export type { ChartSeries, BandSeries, BoxSeries, BoxColumns } from './data.js';

export type { Curve } from './curve.js';

export { defaultTheme, estelaTheme } from './theme.js';
export type {
  ChartTheme,
  LineStyle,
  BandStyle,
  AreaStyle,
  BoxStyle,
} from './theme.js';

// Public interaction types — the callback params for the tracker + selection
// (`onTrackerChanged`, `onSelect`) and the `readout` mode.
export type {
  ReadoutMode,
  TrackerInfo,
  TrackerSample,
  SelectInfo,
} from './context.js';
