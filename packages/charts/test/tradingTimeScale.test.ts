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
    boundaries: (from, to) => {
      const out: number[] = [];
      for (let i = 1; i < segments.length; i++) {
        const start = segments[i]![0];
        if (start > segments[i - 1]![1] && start > from && start < to) {
          out.push(start);
        }
      }
      return out;
    },
  };
  return self;
}

/** A provider with no boundaries (a single live span) — exercises the
 *  even-spacing tick fallback when there is no calendar structure. */
function singleSpanProvider(a: number, b: number): DiscontinuityProvider {
  const self: DiscontinuityProvider = {
    distance: (from, to) =>
      Math.min(b, Math.max(a, to)) - Math.min(b, Math.max(a, from)),
    offset: (v, amt) => Math.min(b, Math.max(a, v)) + amt,
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

  it('ticks are the session opens (date anchors), not arbitrary times', () => {
    // Two sessions → the left edge (S0) + the one collapse point (S1).
    expect(scale.ticks(10)).toEqual([S0, S1]);
    // None falls inside the collapsed gap.
    for (const t of scale.ticks(10)) {
      expect(t > S0 + 6 * H && t < S1).toBe(false);
    }
  });

  it('decimates session opens toward ~count when there are many', () => {
    const many = segmentProvider(
      Array.from({ length: 30 }, (_, i) => [i * 10 * H, i * 10 * H + 6 * H]),
    );
    const s = scaleTradingTime(many)
      .domain([0, 30 * 10 * H])
      .range([0, 1200]);
    // 30 sessions decimated toward ~6 (every 5th).
    expect(s.ticks(6).length).toBeLessThanOrEqual(7);
    expect(s.ticks(6).length).toBeGreaterThan(3);
  });

  it('tickFormat shows a date at a session open, a time elsewhere', () => {
    // Real session instants so the formats are legible.
    const jan = Date.UTC(2026, 0, 5, 9, 30);
    const feb = Date.UTC(2026, 1, 2, 9, 30);
    const cal = segmentProvider([
      [jan, jan + 6 * H],
      [feb, feb + 6 * H],
    ]);
    const s = scaleTradingTime(cal)
      .domain([jan, feb + 6 * H])
      .range([0, 1200]);
    const fmt = s.tickFormat();
    expect(fmt(new Date(feb))).toMatch(/Feb/); // the Feb-2 session open → a date
    expect(fmt(new Date(jan + 3 * H))).not.toMatch(/Jan|Feb/); // mid-session → a time
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

  it('extrapolates within the calendar but clamps beyond its extremes', () => {
    // Domain is the second session only; the first session is in-calendar but
    // before the domain → negative pixel (extrapolated, so it gets culled).
    const s = scaleTradingTime(provider)
      .domain([S1, S1 + 6 * H])
      .range([0, 600]);
    expect(s(S1 - 100 * H)).toBeLessThan(0); // a live instant before the domain
    // Beyond the calendar's absolute start there is no trading time → clamps.
    expect(s(S0 - 50 * H)).toBe(s(S0)); // both pin to the same edge pixel
  });

  it('returns a single tick for count < 1', () => {
    const s = scaleTradingTime(provider)
      .domain([S0, S1 + 6 * H])
      .range([0, 1200]);
    expect(s.ticks(0)).toEqual([S0]);
  });

  it('falls back to interior even-spaced ticks with no calendar boundaries', () => {
    // A single-span provider has no session opens → the even-spacing fallback,
    // with endpoints excluded so none sits on the plot edge.
    const s = scaleTradingTime(singleSpanProvider(0, 1000))
      .domain([0, 1000])
      .range([0, 1200]);
    const px = s.ticks(6).map((t) => s(t));
    expect(px.length).toBe(5); // count-1 interior
    expect(Math.min(...px)).toBeGreaterThan(0);
    expect(Math.max(...px)).toBeLessThan(1200);
  });
});
