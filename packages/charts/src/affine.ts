/**
 * Affine-scale fast path (charts perf, [PND-AFFINE]). A chart's continuous
 * scales — `scaleLinear` (value axis, every y axis), `scaleTime`, and the
 * **gap-free** `scaleTradingTime(identityProvider())` (the default continuous
 * time axis) — map data→pixels by a single `px = k·v + b`. The per-point draw
 * loops in `drawLine` / `drawArea` can then multiply-add inline over the typed
 * arrays instead of paying a d3-scale closure call (deinterpolate → interpolate)
 * per point — the ~37% of stroke-bound frame self-time the 2026-07 external
 * bench profile attributed to `scale()` (see
 * `docs/notes/charts-bench-vs-scichart-suite-2026-07.md`, finding 1).
 *
 * The affine coefficients are recovered from the scale's own domain/range
 * endpoints, then **verified affine** by probing interior points: a scale that
 * deviates (a `scaleTradingTime` with *collapsed* gaps, or a future
 * log/pow/sqrt axis) is rejected — the caller falls back to the exact d3-scale
 * path — while a genuinely affine scale (including a gap-free trading axis) is
 * accepted and reproduced to floating-point precision. The verification is what
 * keeps the fast path a pure optimization: it never draws a non-affine scale as
 * a straight line.
 */

import type { Scale } from './line.js';

/** Coefficients of an affine pixel map `px = k·value + b`. */
export interface Affine {
  readonly k: number;
  readonly b: number;
}

/**
 * Irregular interior sample fractions for the affinity probe. Deliberately not
 * `[0.25, 0.5, 0.75]` — a piecewise-linear scale (trading time) can have
 * breakpoints that a symmetric, round-fraction probe set slips between; the
 * jittered spread makes a false "affine" verdict on a real-gap scale
 * astronomically unlikely (and the e2e visual-regression layer is the backstop,
 * the same net that guards M4).
 */
const PROBE_FRACTIONS = [0.1213, 0.2857, 0.4391, 0.6137, 0.7649, 0.8831];

/**
 * Pixel tolerance for the affinity probe. Far below a sub-pixel (so a real
 * non-affine deviation — a collapsed trading gap or a log curve is many pixels)
 * yet far above the float-reconstruction noise of `k·v + b` on wide domains
 * (~1e-9 px), so an exactly-affine scale is never rejected.
 */
const PROBE_EPSILON = 1e-3;

/**
 * The affine coefficients `{ k, b }` with `scale(v) === k·v + b` for all `v`, or
 * `null` when the scale is not affine over its domain (a real-gap
 * `scaleTradingTime`, a non-linear axis) or exposes no numeric domain/range (a
 * bare `(v) => v` test stub, a `scaleBand` category axis). `null` ⇒ the caller
 * keeps the d3-scale path.
 *
 * Recovered from the domain/range endpoints (`k` from the two extremes, `b`
 * pinning the low end), then verified at {@link PROBE_FRACTIONS}. Every probe
 * must map finite and within {@link PROBE_EPSILON} of the reconstruction — so a
 * scale that returns non-numbers for an interior value (a `scaleBand`) or bends
 * away from the endpoint line (trading gaps, log) is rejected.
 */
export function affineOf(scale: Scale): Affine | null {
  const s = scale as unknown as {
    domain?: () => unknown[];
    range?: () => number[];
  };
  const d = s.domain?.();
  const r = s.range?.();
  if (d === undefined || r === undefined || d.length < 2 || r.length < 2) {
    return null;
  }
  const lo = +(d[0] as number);
  const hi = +(d[d.length - 1] as number);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) return null;
  const pLo = scale(lo);
  const pHi = scale(hi);
  if (!Number.isFinite(pLo) || !Number.isFinite(pHi)) return null;
  const k = (pHi - pLo) / (hi - lo);
  const b = pLo - k * lo;
  const span = hi - lo;
  for (const t of PROBE_FRACTIONS) {
    const v = lo + t * span;
    const p = scale(v);
    if (!Number.isFinite(p) || Math.abs(p - (k * v + b)) > PROBE_EPSILON) {
      return null;
    }
  }
  return { k, b };
}
