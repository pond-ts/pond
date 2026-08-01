/**
 * Affine-scale fast path (charts perf, [PND-AFFINE]). A chart's continuous
 * scales — `scaleLinear` (value axis, every y axis), `scaleTime`, and the
 * **gap-free** `scaleTradingTime(identityProvider())` (the default continuous
 * time axis) — map data→pixels affinely. The per-point draw loops in
 * `drawLine` / `drawArea` can then evaluate the map inline over the typed
 * arrays instead of paying a d3-scale closure call (deinterpolate → interpolate)
 * per point — the ~37% of stroke-bound frame self-time the 2026-07 external
 * bench profile attributed to `scale()` (see
 * `docs/notes/charts-bench-vs-scichart-suite-2026-07.md`, finding 1).
 *
 * The map is stored and evaluated in the **rebased** form
 * `px = (v − v0)·k + p0` (v0 = the domain's low endpoint, p0 = scale(v0)) —
 * the same association d3's own deinterpolate → interpolate uses — never
 * expanded to `k·v + b`. The expanded form is catastrophically ill-conditioned
 * on epoch-millisecond domains: with t ≈ 1.8e12 and a deeply zoomed window,
 * `k·t` and `b` are huge near-cancelling terms whose rounding (½ ULP of `k·t`)
 * survives the cancellation — ~0.16 px reconstruction error at a 1 ms window,
 * ~24 px at 1 µs (measured). Under the expanded form the interior probe below
 * caught that drift and *rejected* the scale, so deep-zoomed frames silently
 * lost the fast path; the rebased form evaluates to ≲1e-9 px of the exact
 * d3 path at every zoom depth, so the fast path stays engaged.
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

/**
 * Coefficients of an affine pixel map in rebased form:
 * `px = (value − v0)·k + p0`. `v0` is the domain's low endpoint and `p0` its
 * pixel image, so the multiply sees the O(span) offset `value − v0` (exact for
 * in-domain values, by Sterbenz cancellation) rather than an O(1e12) absolute
 * epoch value — see the module comment for why the expanded `k·value + b`
 * form must not be reintroduced.
 */
export interface Affine {
  readonly k: number;
  readonly v0: number;
  readonly p0: number;
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
 * yet far above the float-reconstruction noise of the rebased
 * `(v − v0)·k + p0` against d3's own evaluation (≲1e-9 px at any domain
 * magnitude or zoom depth — both sides subtract the domain origin before
 * multiplying), so an exactly-affine scale is never rejected.
 */
const PROBE_EPSILON = 1e-3;

/**
 * The affine coefficients `{ k, v0, p0 }` with `scale(v) === (v − v0)·k + p0`
 * for all `v`, or `null` when the scale is not affine over its domain (a
 * real-gap `scaleTradingTime`, a non-linear axis) or exposes no numeric
 * domain/range (a bare `(v) => v` test stub, a `scaleBand` category axis).
 * `null` ⇒ the caller keeps the d3-scale path.
 *
 * Recovered from the domain/range endpoints (`k` from the two extremes, the
 * `(v0, p0)` base pinning the low end), then verified at
 * {@link PROBE_FRACTIONS}. Every probe must map finite and within
 * {@link PROBE_EPSILON} of the reconstruction — so a scale that returns
 * non-numbers for an interior value (a `scaleBand`) or bends away from the
 * endpoint line (trading gaps, log) is rejected.
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
  const span = hi - lo;
  for (const t of PROBE_FRACTIONS) {
    const v = lo + t * span;
    const p = scale(v);
    // Probe the exact rebased expression the draw loops evaluate, so what is
    // verified is what runs.
    if (
      !Number.isFinite(p) ||
      Math.abs(p - ((v - lo) * k + pLo)) > PROBE_EPSILON
    ) {
      return null;
    }
  }
  return { k, v0: lo, p0: pLo };
}
