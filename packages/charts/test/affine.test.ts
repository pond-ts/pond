import { describe, expect, it } from 'vitest';
import { scaleLinear, scaleTime, scaleBand } from 'd3-scale';
import { affineOf } from '../src/affine.js';
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

describe('affineOf', () => {
  it('recovers k, b from a scaleLinear and reproduces it exactly', () => {
    const s = scaleLinear()
      .domain([0, 100])
      .range([0, 800]) as unknown as Scale;
    const a = affineOf(s);
    expect(a).not.toBeNull();
    // px = 8·v + 0.
    expect(a!.k).toBeCloseTo(8, 12);
    expect(a!.b).toBeCloseTo(0, 12);
    for (const v of [0, 13, 42.5, 99.9, 100]) {
      expect(a!.k * v + a!.b).toBeCloseTo(s(v), 9);
    }
  });

  it('handles a flipped, offset range (like a real y axis)', () => {
    const s = scaleLinear()
      .domain([-50, 50])
      .range([600, 40]) as unknown as Scale;
    const a = affineOf(s)!;
    for (const v of [-50, -12.3, 0, 27, 50]) {
      expect(a.k * v + a.b).toBeCloseTo(s(v), 9);
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
    expect(a.k * mid + a.b).toBeCloseTo(s(mid), 6);
  });

  it('accepts the gap-free default trading axis (identity provider)', () => {
    const s = scaleTradingTime(identityProvider())
      .domain([0, 1000])
      .range([0, 500]) as unknown as Scale;
    const a = affineOf(s);
    expect(a).not.toBeNull();
    // Identity trading time == real time == affine: px = 0.5·v.
    for (const v of [0, 137, 500, 863, 1000]) {
      expect(a!.k * v + a!.b).toBeCloseTo(s(v), 6);
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
