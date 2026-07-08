import { describe, expect, it } from 'vitest';
import {
  scaleTradingTime,
  type DiscontinuityProvider,
} from '../src/tradingTimeScale.js';

/**
 * A minimal segment-based provider, inline so the charts test stays decoupled
 * from `@pond-ts/financial` (a real `TradingCalendar.discontinuities()` provider
 * satisfies the same structural shape). Live domain = sorted `[start, end)`
 * spans; everything between is excised.
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

const H = 3_600_000;
// Two 6-hour sessions with a long overnight gap between them.
const S0 = 0;
const S1 = 100 * H; // a big wall-clock gap
const provider = segmentProvider([
  [S0, S0 + 6 * H],
  [S1, S1 + 6 * H],
]);

describe('scaleTradingTime', () => {
  const scale = scaleTradingTime(provider)
    .domain([S0, S1 + 6 * H])
    .range([0, 1200]);

  it('maps the domain endpoints to the range endpoints', () => {
    expect(scale(S0)).toBe(0);
    expect(scale(S1 + 6 * H)).toBe(1200);
  });

  it('collapses the overnight gap — both sessions get equal pixel width', () => {
    // Total trading time = 12h over 1200px → 100px/hour. Each 6h session = 600px.
    expect(scale(S0 + 6 * H)).toBeCloseTo(600, 6); // end of session 0
    expect(scale(S1)).toBeCloseTo(600, 6); // start of session 1 — same pixel
    expect(scale(S1 + 3 * H)).toBeCloseTo(900, 6); // mid session 1
  });

  it('is proportional within a session', () => {
    expect(scale(S0 + 3 * H)).toBeCloseTo(300, 6);
    expect(scale(S0 + 1 * H)).toBeCloseTo(100, 6);
  });

  it('invert round-trips a live instant', () => {
    for (const t of [S0 + H, S0 + 5 * H, S1 + H, S1 + 5 * H]) {
      expect(scale.invert(scale(t))).toBeCloseTo(t, 3);
    }
  });

  it('invert of a pixel in the collapsed gap lands at a session edge', () => {
    // The 600px point is the shared boundary; invert resolves to a live instant
    // (the start of session 1, since the boundary resolves up).
    const t = scale.invert(600);
    expect(t).toBe(S1);
  });

  it('ticks are evenly spaced in pixels (uniform in trading time)', () => {
    const ticks = scale.ticks(6);
    const px = ticks.map((t) => scale(t));
    for (let i = 1; i < px.length; i++) {
      expect(px[i]! - px[i - 1]!).toBeCloseTo(200, 6); // 1200px / 6
    }
    // …and none of the tick instants falls inside the collapsed gap.
    for (const t of ticks) {
      const inGap = t > S0 + 6 * H && t < S1;
      expect(inGap).toBe(false);
    }
  });

  it('tickFormat delegates to a d3 time format', () => {
    const fmt = scale.tickFormat();
    expect(typeof fmt(new Date(S0))).toBe('string');
  });

  it('domain/range are getter/setters and copy is independent', () => {
    const s = scaleTradingTime(provider);
    expect(s.domain([10, 20])).toBe(s); // setter returns the scale (chainable)
    expect(s.domain()).toEqual([10, 20]); // getter
    s.range([0, 100]);
    const c = s.copy();
    c.domain([30, 40]);
    expect(s.domain()).toEqual([10, 20]); // original unchanged
    expect(c.range()).toEqual([0, 100]); // copied range carried over
  });

  it('is a degenerate no-op on a zero-width domain', () => {
    const s = scaleTradingTime(provider).domain([S0, S0]).range([0, 1200]);
    expect(s(S0)).toBe(0);
  });
});
