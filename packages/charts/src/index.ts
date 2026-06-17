/**
 * `@pond-ts/charts` — the visualization end of pond.
 *
 * Canvas-rendered, streaming-first time-series charts with a
 * react-timeseries-charts-style declarative layout. The architecture (hard
 * layers: adapter → typed-array store → decimator → chunked Path2D cache →
 * canvas renderer → React shell) is documented in the charts RFC at
 * `docs/rfcs/charts.md`; the milestone plan lives in `PLAN.md`.
 *
 * **M0.5 — testing harness.** The public surface so far is the low-level
 * {@link Canvas} primitive every draw layer sits on; it is the proving ground
 * for the four-layer test stack (unit mock-context, Storybook stories,
 * Playwright behavior, Playwright visual regression). The chart components
 * (`ChartContainer`, `ChartRow`, `LineChart`, …) land in M1.
 *
 * @packageDocumentation
 */

export { Canvas } from './Canvas.js';
export type { CanvasProps, CanvasDraw } from './Canvas.js';
