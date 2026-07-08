import { describe, expect, it } from 'vitest';
import {
  panRange,
  zoomRange,
  panRangeTrading,
  zoomRangeTrading,
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
    expect(zoomRange([0, 100], 25, 0.001, 10)).toEqual([22.5, 32.5]);
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
});
