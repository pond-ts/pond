/**
 * `@pond-ts/charts` — the visualization end of pond.
 *
 * Canvas-rendered, streaming-first time-series charts with a
 * react-timeseries-charts-style declarative layout. The architecture (hard
 * layers: adapter → typed-array store → decimator → chunked Path2D cache →
 * canvas renderer → React shell) is documented in the charts RFC at
 * `docs/rfcs/charts.md`; the milestone plan lives in `PLAN.md`.
 *
 * **M0 — skeleton.** This package currently exports only its identity marker so
 * the build emits a `.d.ts` and the monorepo plumbing (build / test / format /
 * release) is wired. The rendering spine — the typed-array store, the
 * `ChartContainer` / `ChartRow` layout shell, and the first `LineChart` draw
 * layer — lands in M1.
 *
 * @packageDocumentation
 */

/**
 * Package identity marker. A placeholder export so the M0 skeleton has a public
 * surface to build and test against; it is replaced by the real chart API
 * (`ChartContainer`, `ChartRow`, `LineChart`, …) in M1.
 */
export const PACKAGE_NAME = '@pond-ts/charts';
