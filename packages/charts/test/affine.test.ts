import { describe, expect, it } from 'vitest';
import { scaleLinear, scaleTime, scaleBand } from 'd3-scale';
import { affineOf, type Affine } from '../src/affine.js';
import { strokeAffinePolyline } from '../src/line.js';
import { fillAffineArea } from '../src/area.js';
import {
  scaleTradingTime,
  identityProvider,
  type DiscontinuityProvider,
} from '../src/tradingTimeScale.js';
import type { Scale } from '../src/line.js';

/**
 * A minimal segment-based discontinuity provider (live domain = sorted
 * `[start, end)` spans, everything between excised) — the same inline shape
 * `tradingTimeScale.test.ts` uses, so a real-gap trading scale can be built
 * without depending on `@pond-ts/financial`.
 */
function segmentProvider(
  segments: ReadonlyArray<readonly [number, number]>,
): DiscontinuityProvider {
  const cum = [0];
  for (const [a, b] of segments) cum.push(cum[cum.length - 1]! + (b - a));
  const total = cum[cum.length - 1]!;
  const liveMs = (t: number): number => {
    if (t <= segments[0]![0]) return 0;
    if (t >= segments[segments.length - 1]![1]) return total;
    for (let i = 0; i < segments.length; i++) {
      const [a, b] = segments[i]!;
      if (t < a) return cum[i]!;
      if (t < b) return cum[i]! + (t - a);
    }
    return total;
  };
  const instantFor = (L: number): number => {
    if (L <= 0) return segments[0]![0];
    if (L >= total) return segments[segments.length - 1]![1];
    for (let i = 0; i < segments.length; i++) {
      if (L < cum[i + 1]!) return segments[i]![0] + (L - cum[i]!);
    }
    return segments[segments.length - 1]![1];
  };
  const self: DiscontinuityProvider = {
    distance: (from, to) => liveMs(to) - liveMs(from),
    offset: (v, amt) => instantFor(liveMs(v) + amt),
    clampUp: (t) => t,
    clampDown: (t) => t,
    copy: () => self,
  };
  return self;
}

/** Evaluate the rebased affine map exactly as the draw loops do. */
function px(a: Affine, v: number): number {
  return (v - a.v0) * a.k + a.p0;
}

describe('affineOf', () => {
  it('recovers the rebased coefficients from a scaleLinear and reproduces it exactly', () => {
    const s = scaleLinear()
      .domain([0, 100])
      .range([0, 800]) as unknown as Scale;
    const a = affineOf(s);
    expect(a).not.toBeNull();
    // px = (v − 0)·8 + 0.
    expect(a!.k).toBeCloseTo(8, 12);
    expect(a!.v0).toBe(0);
    expect(a!.p0).toBe(0);
    for (const v of [0, 13, 42.5, 99.9, 100]) {
      expect(px(a!, v)).toBeCloseTo(s(v), 9);
    }
  });

  it('handles a flipped, offset range (like a real y axis)', () => {
    const s = scaleLinear()
      .domain([-50, 50])
      .range([600, 40]) as unknown as Scale;
    const a = affineOf(s)!;
    for (const v of [-50, -12.3, 0, 27, 50]) {
      expect(px(a, v)).toBeCloseTo(s(v), 9);
    }
    // A flipped axis has a negative slope.
    expect(a.k).toBeLessThan(0);
  });

  it('accepts a scaleTime (affine over epoch-ms input)', () => {
    const t0 = Date.UTC(2026, 0, 1);
    const t1 = Date.UTC(2026, 0, 8);
    const s = scaleTime()
      .domain([new Date(t0), new Date(t1)])
      .range([0, 700]) as unknown as Scale;
    const a = affineOf(s)!;
    expect(a).not.toBeNull();
    const mid = (t0 + t1) / 2;
    expect(px(a, mid)).toBeCloseTo(s(mid), 6);
  });

  it('accepts the gap-free default trading axis (identity provider)', () => {
    const s = scaleTradingTime(identityProvider())
      .domain([0, 1000])
      .range([0, 500]) as unknown as Scale;
    const a = affineOf(s);
    expect(a).not.toBeNull();
    // Identity trading time == real time == affine: px = 0.5·v.
    for (const v of [0, 137, 500, 863, 1000]) {
      expect(px(a!, v)).toBeCloseTo(s(v), 6);
    }
  });

  it('REJECTS a real-gap trading scale (piecewise, non-affine)', () => {
    // Two live sessions [0,100] and [900,1000] with a big collapsed gap between
    // — a mid-domain instant maps far off the endpoint line.
    const s = scaleTradingTime(
      segmentProvider([
        [0, 100],
        [900, 1000],
      ]),
    )
      .domain([0, 1000])
      .range([0, 800]) as unknown as Scale;
    expect(affineOf(s)).toBeNull();
  });

  it('REJECTS a non-linear (log-like) scale', () => {
    // A scale carrying domain/range but a log pixel map — must probe non-affine.
    const lo = 1;
    const hi = 1000;
    const px = (v: number) => (Math.log(v) / Math.log(hi)) * 600;
    const s = Object.assign((v: number) => px(v), {
      domain: () => [lo, hi],
      range: () => [0, 600],
    }) as unknown as Scale;
    expect(affineOf(s)).toBeNull();
  });

  it('returns null for a bare function scale (no domain / range)', () => {
    expect(affineOf(((v: number) => v) as Scale)).toBeNull();
  });

  it('returns null when only one of domain / range is present', () => {
    const onlyDomain = Object.assign((v: number) => v, {
      domain: () => [0, 10],
    }) as unknown as Scale;
    const onlyRange = Object.assign((v: number) => v, {
      range: () => [0, 10],
    }) as unknown as Scale;
    expect(affineOf(onlyDomain)).toBeNull();
    expect(affineOf(onlyRange)).toBeNull();
  });

  it('returns null for a degenerate (zero-width) domain', () => {
    const s = scaleLinear().domain([5, 5]).range([0, 800]) as unknown as Scale;
    expect(affineOf(s)).toBeNull();
  });

  it('returns null for a scaleBand (probe lands on a non-member → non-finite)', () => {
    const s = scaleBand()
      .domain(['a', 'b', 'c'])
      .range([0, 300]) as unknown as Scale;
    expect(affineOf(s)).toBeNull();
  });
});

/**
 * Deep-zoom precision regression (`docs/notes/nanosecond-time-assessment-2026-08.md`
 * §5.4): on an epoch-millisecond domain zoomed to a sub-second window, the
 * expanded `k·v + b` reconstruction the fast path used to run is
 * ill-conditioned — `k·v` and `b` are huge near-cancelling terms, leaving
 * ~0.16 px of rounding residue at a 1 ms window and ~24 px at 1 µs. The
 * interior probe detected that drift and returned `null`, so deep-zoomed
 * frames silently fell back to the slow d3 path. The rebased
 * `(v − v0)·k + p0` form matches the exact scale at every zoom depth, so
 * `affineOf` must now ACCEPT these scales and reproduce them to well under a
 * thousandth of a pixel.
 */
describe('affine fast path at deep zoom (sub-ms windows on epoch domains)', () => {
  // ~2026-08-01 in epoch ms, with a fractional-ms origin to be adversarial.
  const T0 = Date.UTC(2026, 7, 1, 13, 30, 21, 123) + 0.4567;
  const WIDTH = 1000;
  const EPS_PX = 1e-6; // far below visible; measured residue is ~0 px

  /** Sample values across [lo, lo+span] (they quantize to representable ms). */
  function samples(lo: number, span: number, n = 200): number[] {
    const out: number[] = [];
    for (let i = 0; i <= n; i += 1) out.push(lo + (i / n) * span);
    return out;
  }

  for (const [label, spanMs] of [
    ['1 s window', 1000],
    ['1 ms window (the default minDuration zoom floor)', 1],
    ['1 µs window (minDuration = 1e-3)', 1e-3],
  ] as const) {
    it(`accepts a scaleLinear over a ${label} at epoch magnitude and matches it exactly`, () => {
      const s = scaleLinear()
        .domain([T0, T0 + spanMs])
        .range([0, WIDTH]) as unknown as Scale;
      const a = affineOf(s);
      // The old expanded form was rejected by its own probe at the ms/µs
      // windows — losing the fast path (the 1 s row is a control: both forms
      // pass there). The rebased form must be accepted…
      expect(a).not.toBeNull();
      // …and agree with the exact d3 evaluation everywhere in the window.
      for (const v of samples(T0, spanMs)) {
        expect(Math.abs(px(a!, v) - s(v))).toBeLessThan(EPS_PX);
      }
    });
  }

  it('accepts a scaleTime over a 1 ms window (integer-ms endpoints)', () => {
    const t0 = Date.UTC(2026, 7, 1, 13, 30, 21, 123);
    const s = scaleTime()
      .domain([new Date(t0), new Date(t0 + 1)])
      .range([0, WIDTH]) as unknown as Scale;
    const a = affineOf(s);
    expect(a).not.toBeNull();
    for (const v of samples(t0, 1)) {
      expect(Math.abs(px(a!, v) - s(v))).toBeLessThan(EPS_PX);
    }
  });

  /** A 2D-recording context stub: captures every moveTo/lineTo position. */
  function recordingCtx(): {
    ctx: CanvasRenderingContext2D;
    pts: Array<[number, number]>;
  } {
    const pts: Array<[number, number]> = [];
    const ctx = {
      moveTo: (x: number, y: number) => pts.push([x, y]),
      lineTo: (x: number, y: number) => pts.push([x, y]),
      closePath: () => {},
    } as unknown as CanvasRenderingContext2D;
    return { ctx, pts };
  }

  it('strokeAffinePolyline positions match the exact scales at a sub-ms domain', () => {
    const spanMs = 1e-3; // 1 µs visible window
    const xScale = scaleLinear()
      .domain([T0, T0 + spanMs])
      .range([0, WIDTH]) as unknown as Scale;
    const yScale = scaleLinear()
      .domain([0, 100])
      .range([400, 0]) as unknown as Scale;
    const ax = affineOf(xScale)!;
    const ay = affineOf(yScale)!;
    expect(ax).not.toBeNull();
    const n = 32;
    const xs = new Float64Array(samples(T0, spanMs, n));
    const ys = new Float64Array(xs.length);
    for (let i = 0; i < ys.length; i += 1) ys[i] = 10 + (80 * i) / n;
    const { ctx, pts } = recordingCtx();
    strokeAffinePolyline(ctx, xs, ys, ax, ay);
    expect(pts.length).toBe(xs.length);
    for (let i = 0; i < pts.length; i += 1) {
      expect(Math.abs(pts[i]![0] - xScale(xs[i]!))).toBeLessThan(EPS_PX);
      expect(Math.abs(pts[i]![1] - yScale(ys[i]!))).toBeLessThan(EPS_PX);
    }
  });

  it('fillAffineArea positions (top edge + baseline closes) match the exact scales', () => {
    const spanMs = 1e-3;
    const xScale = scaleLinear()
      .domain([T0, T0 + spanMs])
      .range([0, WIDTH]) as unknown as Scale;
    const yScale = scaleLinear()
      .domain([0, 100])
      .range([400, 0]) as unknown as Scale;
    const ax = affineOf(xScale)!;
    const ay = affineOf(yScale)!;
    const n = 16;
    const xs = new Float64Array(samples(T0, spanMs, n));
    const ys = new Float64Array(xs.length);
    for (let i = 0; i < ys.length; i += 1) ys[i] = 20 + (60 * i) / n;
    const baselinePx = yScale(0);
    const { ctx, pts } = recordingCtx();
    fillAffineArea(ctx, xs, ys, baselinePx, ax, ay);
    // Top edge (one point per sample) + the two baseline closing points.
    expect(pts.length).toBe(xs.length + 2);
    for (let i = 0; i < xs.length; i += 1) {
      expect(Math.abs(pts[i]![0] - xScale(xs[i]!))).toBeLessThan(EPS_PX);
      expect(Math.abs(pts[i]![1] - yScale(ys[i]!))).toBeLessThan(EPS_PX);
    }
    // Baseline drop under the last point, then flat back to the first x.
    const last = xs.length - 1;
    expect(Math.abs(pts[last + 1]![0] - xScale(xs[last]!))).toBeLessThan(
      EPS_PX,
    );
    expect(pts[last + 1]![1]).toBe(baselinePx);
    expect(Math.abs(pts[last + 2]![0] - xScale(xs[0]!))).toBeLessThan(EPS_PX);
    expect(pts[last + 2]![1]).toBe(baselinePx);
  });
});
