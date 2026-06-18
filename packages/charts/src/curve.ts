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
 * - `monotone` — smooth, monotone in x, **passes through** points (no overshoot;
 *   best for **lines**). It assumes *increasing* x, so on a band — whose lower
 *   edge is drawn right→left — it smooths the two edges asymmetrically; prefer a
 *   symmetric curve for bands.
 * - `natural` — smooth natural cubic spline, passes through points; **symmetric**
 *   (direction-independent), so a good band curve.
 * - `basis` — B-spline; smoothest and symmetric, but **approximates** (does not
 *   touch points). The classic band/envelope curve.
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
