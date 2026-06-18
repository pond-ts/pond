import {
  curveBasis,
  curveLinear,
  curveMonotoneX,
  curveNatural,
  curveStep,
  type CurveFactory,
} from 'd3-shape';

/**
 * Render-time path interpolation for a line / band — how the path is drawn
 * *between* points, a pure view concern (it does not change the data; denoising
 * is pond's `smooth()`, upstream). Sparse aggregated bands look angular as a
 * polyline; a curve smooths the path (RTC's `interpolation`).
 *
 * - `linear` (default) — straight segments; passes through every point.
 * - `monotone` — smooth, monotone in x, **passes through** points (safe default
 *   curve for time series — no overshoot).
 * - `natural` — smooth natural cubic spline, passes through points.
 * - `basis` — B-spline; smoothest, but **approximates** (does not touch points).
 * - `step` — right-angle steps.
 */
export type Curve = 'linear' | 'monotone' | 'natural' | 'basis' | 'step';

const CURVES: Record<Curve, CurveFactory> = {
  linear: curveLinear,
  monotone: curveMonotoneX,
  natural: curveNatural,
  basis: curveBasis,
  step: curveStep,
};

/** Resolve a {@link Curve} name to its d3 curve factory; `undefined` → linear. */
export function resolveCurve(curve?: Curve): CurveFactory {
  return CURVES[curve ?? 'linear'];
}
