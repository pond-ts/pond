import { describe, expect, it } from 'vitest';
import {
  panRange,
  zoomRange,
  panRangeTrading,
  zoomRangeTrading,
  clampToBounds,
  type ViewportDiscontinuity,
} from '../src/viewport.js';

/**
 * A two-session provider with a collapsed gap: live spans [0,100) and [200,300),
 * so 100 units of trading time straddle a 100-unit dead gap. Enough to prove the
 * trading-time pan/zoom move by *trading* time, not raw ms.
 */
const provider: ViewportDiscontinuity = (() => {
  const liveMs = (t: number): number => {
    if (t <= 0) return 0;
    if (t >= 300) return 200;
    if (t < 100) return t;
    if (t < 200) return 100; // inside the collapsed gap
    return 100 + (t - 200);
  };
  const instantFor = (L: number): number => {
    if (L <= 0) return 0;
    if (L >= 200) return 300;
    return L < 100 ? L : 200 + (L - 100);
  };
  return {
    distance: (a, b) => liveMs(b) - liveMs(a),
    offset: (v, amt) => instantFor(liveMs(v) + amt),
  };
})();

describe('panRange', () => {
  it('shifts the range by dt (caller signs the gesture)', () => {
    expect(panRange([100, 200], 50)).toEqual([150, 250]);
    expect(panRange([100, 200], -30)).toEqual([70, 170]);
  });
});

describe('clampToBounds', () => {
  const bounds = [0, 1000] as const;

  it('leaves a range already inside the extent untouched', () => {
    expect(clampToBounds([200, 400], bounds)).toEqual([200, 400]);
  });

  it('slides a range past the left edge back in, preserving span', () => {
    expect(clampToBounds([-50, 150], bounds)).toEqual([0, 200]);
  });

  it('slides a range past the right edge back in, preserving span', () => {
    expect(clampToBounds([900, 1100], bounds)).toEqual([800, 1000]);
  });

  it('clamps a range wider than the extent to the full bounds (zoom-out ceiling)', () => {
    expect(clampToBounds([-200, 1200], bounds)).toEqual([0, 1000]);
    // exactly the extent width → also the full bounds
    expect(clampToBounds([500, 1500], bounds)).toEqual([0, 1000]);
  });

  it('treats a degenerate extent (hi <= lo) as no constraint', () => {
    expect(clampToBounds([10, 20], [100, 100])).toEqual([10, 20]);
    expect(clampToBounds([10, 20], [100, 50])).toEqual([10, 20]);
  });
});

describe('zoomRange', () => {
  it('zooms in (factor < 1) holding the centre pivot fixed', () => {
    expect(zoomRange([0, 100], 50, 0.5)).toEqual([25, 75]);
  });

  it('zooms out (factor > 1)', () => {
    expect(zoomRange([0, 100], 50, 2)).toEqual([-50, 150]);
  });

  it('holds an off-centre pivot fixed', () => {
    // pivot 20 stays at the same fractional position (0.2) of the new window.
    expect(zoomRange([0, 100], 20, 0.5)).toEqual([10, 60]);
  });

  it('clamps to minDuration (the zoom-in floor), keeping the pivot fraction', () => {
    // factor 0.001 would give a ~0.1ms span; floor is 10, pivot frac 0.25.
    // The exact floor result is [22.5, 32.5], snapped to whole ms (below).
    expect(zoomRange([0, 100], 25, 0.001, 10)).toEqual([23, 33]);
  });
});

describe('view ranges are whole milliseconds', () => {
  // A wheel-zoom derives its range from pixel positions through
  // `xScale.invert()`, so the numbers are fractional by construction. The epoch
  // millisecond is this model's atomic unit, and something downstream was
  // entitled to assume it: `Temporal.Instant` refuses a non-integer epoch ms, so
  // a calendar `cursorSequence` threw on an ordinary scroll. Rounding at the
  // source closes the class rather than the one symptom.

  it('rounds a zoomed range, so a scroll never yields a fraction', () => {
    const [lo, hi] = zoomRange(
      [1_700_000_000_000, 1_700_000_010_000],
      1.7e12 + 3333.7,
      0.5,
    );
    expect(Number.isInteger(lo)).toBe(true);
    expect(Number.isInteger(hi)).toBe(true);
  });

  it('rounds a panned range', () => {
    const [lo, hi] = panRange([1_000, 5_000], -0.37);
    expect([lo, hi]).toEqual([1_000, 5_000]);
    const [lo2, hi2] = panRange([1_000, 5_000], 12.6);
    expect([lo2, hi2]).toEqual([1_013, 5_013]);
    expect(Number.isInteger(lo2) && Number.isInteger(hi2)).toBe(true);
  });

  it('never collapses a sub-millisecond span to zero width', () => {
    // Both ends round to 10; a zero-width range is a division by zero in every
    // scale built from it, so the floor opens it to the 1ms atom instead.
    const [lo, hi] = panRange([10.4, 10.6], 0);
    expect(hi - lo).toBe(1);
    expect([lo, hi]).toEqual([10, 11]);

    // Same via zoom, with a minDuration finer than the model can represent.
    const [zlo, zhi] = zoomRange([10.4, 10.6], 10.5, 0.5, 0.001);
    expect(zhi - zlo).toBe(1);
    expect(Number.isInteger(zlo) && Number.isInteger(zhi)).toBe(true);
  });

  it('preserves a minDuration of 1ms or more exactly through the snap', () => {
    for (const min of [1, 2, 10, 1000]) {
      // A pivot fraction that puts both ends on .5 boundaries — the worst case
      // for a naive round-both-ends, which can drop a whole millisecond.
      const [lo, hi] = zoomRange([0, 100], 25.5, 1e-9, min);
      expect(hi - lo).toBeGreaterThanOrEqual(min);
    }
  });

  it('leaves an already-integral range untouched', () => {
    expect(zoomRange([0, 100], 50, 0.5)).toEqual([25, 75]);
    expect(panRange([0, 100], 25)).toEqual([25, 125]);
  });

  it('passes a degenerate range through without inventing width', () => {
    // hi === lo is not a positive span, so there is nothing to protect; widening
    // it would fabricate a view the caller never asked for.
    expect(panRange([10.2, 10.2], 0)).toEqual([10, 10]);
  });
});

describe('panRangeTrading', () => {
  it('shifts by trading time within a session', () => {
    // [10,40] = 30 trading units, all in session 0. +0.5 → +15 trading.
    expect(panRangeTrading([10, 40], 0.5, provider)).toEqual([25, 55]);
  });

  it('preserves the trading span while panning across the collapsed gap', () => {
    // [50,250] straddles the gap (100 trading units). +0.2 → +20 trading; both
    // ends advance 20 trading, the dead gap consuming no motion.
    const [lo, hi] = panRangeTrading([50, 250], 0.2, provider);
    expect([lo, hi]).toEqual([70, 270]);
    expect(provider.distance(lo, hi)).toBe(100); // span preserved
  });

  it('stops at the END edge preserving span (regression: Codex P1)', () => {
    // Panning forward past the last session stops at [200,300] with the trading
    // span (100) intact — no shrink/collapse as the right boundary is reached.
    expect(panRangeTrading([50, 250], 0.8, provider)).toEqual([200, 300]);
    expect(panRangeTrading([50, 250], 2, provider)).toEqual([200, 300]);
  });

  it('stops at the START edge preserving span', () => {
    expect(panRangeTrading([50, 250], -0.8, provider)).toEqual([0, 200]);
  });
});

describe('zoomRangeTrading', () => {
  it('zooms in around a pivot in trading time', () => {
    // Domain [0,300] = 200 trading units, pivot at the gap boundary (t=100,
    // trading-mid). factor 0.5 halves the trading distance each side (50 each):
    // d0 = offset(100,−50)=50; d1 = offset(100,+50)=250.
    expect(zoomRangeTrading([0, 300], 100, 0.5, provider)).toEqual([50, 250]);
  });

  it('floors the visible trading time at minLive', () => {
    const [lo, hi] = zoomRangeTrading([0, 300], 100, 0.0001, provider, 20);
    // ~20 trading units visible, centred on the pivot's trading position.
    expect(provider.distance(lo, hi)).toBeCloseTo(20, 6);
  });

  it('honors the minLive floor at a calendar edge by redistributing (Codex P2)', () => {
    // Pivot at the very start: the left half of the floor can't exist, so the
    // whole floor goes right — span stays 20, not the clamped-away 10.
    const [lo, hi] = zoomRangeTrading([0, 0], 0, 0.001, provider, 20);
    expect(provider.distance(lo, hi)).toBeCloseTo(20, 6);
  });

  it('preserves the zoomed trading span when a side clamps at the edge', () => {
    // Zoom out with the pivot near the start: the left side clamps at 0, its
    // shortfall shifts to the right so the visible span is the full requested
    // amount (pivot fraction drifts at the edge — inherent, documented).
    const [lo, hi] = zoomRangeTrading([10, 60], 20, 3, provider);
    const wantSpan =
      provider.distance(10, 20) * 3 + provider.distance(20, 60) * 3;
    expect(provider.distance(lo, hi)).toBeCloseTo(wantSpan, 6);
  });
});

describe('ViewportOptions — value and log domains ([PND-XLOG])', () => {
  describe('snap: false — a value axis is not milliseconds', () => {
    it('keeps a fractional domain instead of rounding it away', () => {
      // A power–duration curve over [0.5, 10800] seconds. The default snap
      // would put the floor at 0 — which is not merely coarse, it is the value
      // a log scale cannot represent.
      const [lo, hi] = panRange([0.5, 10800], 0.25, { snap: false });
      expect(lo).toBeCloseTo(0.75, 10);
      expect(hi).toBeCloseTo(10800.25, 10);
    });

    it('does not collapse a sub-unit domain to a single integer', () => {
      const [lo, hi] = zoomRange([0.001, 1], 0.03, 0.5, 1e-9, { snap: false });
      expect(hi).toBeGreaterThan(lo);
      expect(lo).toBeGreaterThan(0); // survives as a log-representable floor
    });

    it('still snaps by default, so a time axis is untouched', () => {
      expect(panRange([10.4, 10.6], 0)).toEqual([10, 11]);
    });
  });

  describe('log: true — the arithmetic moves into log space', () => {
    it('holds the pivot under the cursor, which linear zoom does not', () => {
      // The guarantee zoom exists for. Linear arithmetic on a log domain drags
      // the value under the pointer sideways.
      const range: [number, number] = [1, 10000];
      const pivot = 100;
      const before =
        (Math.log(pivot) - Math.log(range[0])) /
        (Math.log(range[1]) - Math.log(range[0]));
      const [lo, hi] = zoomRange(range, pivot, 0.5, 1, { log: true });
      const after =
        (Math.log(pivot) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
      expect(after).toBeCloseTo(before, 10);
    });

    it('zooms multiplicatively — equal decades in, equal decades out', () => {
      const [lo, hi] = zoomRange([1, 10000], 100, 0.5, 1, { log: true });
      // Four decades halved about the centre leaves two, centred on 100.
      expect(Math.log10(hi / lo)).toBeCloseTo(2, 10);
      expect(Math.sqrt(lo * hi)).toBeCloseTo(100, 6);
    });

    it('never produces a non-positive bound', () => {
      // The failure that makes this more than a polish item: a log scale is
      // undefined at zero, so an additive zoom-out is not just wrong but fatal.
      const [lo] = zoomRange([1, 10000], 2, 8, 1, { log: true });
      expect(lo).toBeGreaterThan(0);
    });

    it('pans by a ratio, so the same drag moves the same visual distance', () => {
      // Additively, +100s near the 1s end walks off the plot and near the 3h
      // end barely moves. In log space both are the same number of decades.
      const range: [number, number] = [1, 10000];
      const span = range[1] - range[0];
      const [lo, hi] = panRange(range, span * 0.25, { log: true });
      expect(Math.log10(hi / lo)).toBeCloseTo(4, 10); // width preserved
      expect(lo).toBeGreaterThan(range[0]); // and it moved
    });

    it('leaves a non-positive or degenerate range alone rather than NaN-ing', () => {
      expect(zoomRange([0, 10], 5, 0.5, 1, { log: true })).toEqual([0, 10]);
      expect(panRange([-5, 5], 1, { log: true })).toEqual([-5, 5]);
    });
  });
});
