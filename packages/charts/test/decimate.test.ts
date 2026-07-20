import { describe, expect, it } from 'vitest';
import { scaleLinear } from 'd3-scale';
import {
  deviceBucketCount,
  shouldDecimate,
  pixelEdges,
  gapKeyEdges,
  mergeGapEdges,
  m4Polyline,
  decimateM4,
  decimateBand,
} from '../src/decimate.js';
import type { ChartSeries, BandSeries } from '../src/data.js';
import type { Scale } from '../src/line.js';

const cs = (x: number[], y: number[]): ChartSeries => ({
  x: Float64Array.from(x),
  y: Float64Array.from(y),
  length: x.length,
});
const band = (x: number[], lower: number[], upper: number[]): BandSeries => ({
  x: Float64Array.from(x),
  lower: Float64Array.from(lower),
  upper: Float64Array.from(upper),
  length: x.length,
});

/** A d3 linear scale over `[lo, hi]` → CSS-pixel range `[0, widthCss]` (the real
 *  chart shape — a value→px map, invertible), so `decimateM4` reads its range +
 *  invert. `widthCss` defaults to the domain span (an identity map). */
const pxScale = (lo: number, hi: number, widthCss = hi - lo): Scale =>
  scaleLinear().domain([lo, hi]).range([0, widthCss]) as unknown as Scale;

/** A minimal ctx stub: just a backing width (device-pixel bucket count). */
const stubCtx = (widthPx: number): CanvasRenderingContext2D =>
  ({ canvas: { width: widthPx } }) as unknown as CanvasRenderingContext2D;

describe('deviceBucketCount', () => {
  it('reads W off the canvas backing width', () => {
    expect(deviceBucketCount(stubCtx(1600))).toBe(1600);
  });

  it('falls back to W=0 for a bare ctx', () => {
    expect(deviceBucketCount({} as CanvasRenderingContext2D)).toBe(0);
  });
});

describe('shouldDecimate', () => {
  it('is true once visible points exceed k × device columns', () => {
    const ctx = stubCtx(800); // W=800
    expect(
      shouldDecimate(cs(Array(2001).fill(0), Array(2001).fill(0)), ctx),
    ).toBe(true); // 2001 > 2×800
    expect(
      shouldDecimate(cs(Array(1500).fill(0), Array(1500).fill(0)), ctx),
    ).toBe(false); // 1500 < 1600
  });

  it('is false when the canvas has no width (a test ctx)', () => {
    expect(
      shouldDecimate(
        cs(Array(1e6).fill(0), Array(1e6).fill(0)),
        {} as CanvasRenderingContext2D,
      ),
    ).toBe(false);
  });
});

describe('pixelEdges', () => {
  it('inverts uniform pixel positions to key space — affine scale', () => {
    // An affine invert `px => px*8` over a 100px range → key edges 0..800,
    // uniform (an affine scale's uniform pixel columns ARE a uniform key split).
    const e = pixelEdges((px) => px * 8, 100, 4);
    expect(Array.from(e)).toEqual([0, 200, 400, 600, 800]);
  });

  it('follows a NON-affine scale so buckets stay one pixel wide', () => {
    // A piecewise invert: the first half of the pixel range maps into a *narrow*
    // key band [0,10], the second half into a *wide* one [10,810] (a
    // trading-time-style compressed gap). Uniform key edges would misalign; the
    // inverted edges track the scale, so each stays one pixel column.
    const invert = (px: number) =>
      px <= 50 ? (px / 50) * 10 : 10 + (px - 50) * 16;
    const e = pixelEdges(invert, 100, 4);
    // px 0,25,50,75,100 → key 0,5,10,410,810 (not a uniform 0..810 split).
    expect(Array.from(e)).toEqual([0, 5, 10, 410, 810]);
  });
});

describe('gapKeyEdges', () => {
  it('emits (first-NaN, first-finite-after) for a wide interior gap', () => {
    // x 0..6; NaN at 2,3,4 → interior gap bounded by x[1]=1 and x[5]=5.
    const s = cs([0, 1, 2, 3, 4, 5, 6], [0, 1, NaN, NaN, NaN, 5, 6]);
    // minSpan 1: the gap (x[5]-x[1] = 4) qualifies → edges [x[2]=2, x[5]=5].
    expect(gapKeyEdges(s, 1)).toEqual([2, 5]);
  });

  it('skips a gap narrower than one pixel column', () => {
    // Same single-NaN gap but minSpan 10 → x[3]-x[1] = 2 < 10 → no edges.
    const s = cs([0, 1, 2, 3], [0, 1, NaN, 3]);
    expect(gapKeyEdges(s, 10)).toEqual([]);
  });

  it('skips leading and trailing NaN runs (no bridge to preserve)', () => {
    const s = cs([0, 1, 2, 3, 4], [NaN, NaN, 2, 3, NaN]);
    expect(gapKeyEdges(s, 1)).toEqual([]);
  });
});

describe('mergeGapEdges', () => {
  const pixels = Float64Array.from([0, 10, 20, 30]);

  it('folds in-range gap boundaries into the sorted, deduped edge list', () => {
    expect(Array.from(mergeGapEdges(pixels, [12, 18], 0, 30))).toEqual([
      0, 10, 12, 18, 20, 30,
    ]);
  });

  it('drops gap boundaries outside (lo, hi) and dedupes coincident ones', () => {
    // -5 and 40 are out of range; 20 coincides with a pixel edge → deduped.
    expect(Array.from(mergeGapEdges(pixels, [-5, 20, 40], 0, 30))).toEqual([
      0, 10, 20, 30,
    ]);
  });

  it('returns the same array (no allocation) when no gap boundary is in range', () => {
    expect(mergeGapEdges(pixels, [], 0, 30)).toBe(pixels);
  });
});

describe('m4Polyline', () => {
  it('emits first/min/max/last per live column at left/mid/mid/right', () => {
    // 2 columns over edges [0,10,20]; col0 min1 max9 first2 last8, col1 all NaN.
    const edges = Float64Array.from([0, 10, 20]);
    const out = m4Polyline(
      edges,
      Float64Array.from([1, NaN]),
      Float64Array.from([9, NaN]),
      Float64Array.from([2, NaN]),
      Float64Array.from([8, NaN]),
      2,
    );
    // col0 → (0,2)(5,1)(5,9)(10,8); col1 empty → no trailing break (nothing after).
    expect(Array.from(out.x)).toEqual([0, 5, 5, 10]);
    expect(Array.from(out.y)).toEqual([2, 1, 9, 8]);
  });

  it('emits a single NaN break for an interior empty column', () => {
    // 3 columns: live, empty, live.
    const edges = Float64Array.from([0, 10, 20, 30]);
    const out = m4Polyline(
      edges,
      Float64Array.from([1, NaN, 3]),
      Float64Array.from([2, NaN, 4]),
      Float64Array.from([1, NaN, 3]),
      Float64Array.from([2, NaN, 4]),
      3,
    );
    // col0 (4 pts) → NaN break (1) → col2 (4 pts) = 9 points; the middle y is NaN.
    expect(out.length).toBe(9);
    expect(Number.isNaN(out.y[4]!)).toBe(true);
    // exactly one break (no doubled NaN).
    expect(Array.from(out.y).filter((v) => Number.isNaN(v))).toHaveLength(1);
  });
});

describe('decimateM4', () => {
  it('returns the same object when the series is already sparse', () => {
    const s = cs([0, 1, 2], [5, 6, 7]);
    expect(decimateM4(s, pxScale(0, 2), stubCtx(800))).toBe(s);
  });

  it('returns the same object when the scale has no domain', () => {
    const s = cs(
      Array.from({ length: 5000 }, (_, i) => i),
      Array.from({ length: 5000 }, (_, i) => i),
    );
    expect(decimateM4(s, ((v: number) => v) as Scale, stubCtx(800))).toBe(s);
  });

  it('bins a dense series to ~4 points per column preserving column extremes', () => {
    // 8000 samples on [0, 8000); W=4 columns (a tiny canvas) so each column
    // spans 2000 samples. Value = the sample index, so column b's min is its
    // first sample (2000·b) and max its last (2000·b + 1999).
    const n = 8000;
    const s = cs(
      Array.from({ length: n }, (_, i) => i),
      Array.from({ length: n }, (_, i) => i),
    );
    const out = decimateM4(s, pxScale(0, n), stubCtx(4), 2); // W=4
    // 4 live columns × 4 points = 16, far fewer than 8000.
    expect(out.length).toBe(16);
    // Each column emits [first, min, max, last]; column b at y[4b..4b+3].
    // Column 0 covers key [0,2000): first=0, min=0, max=1999, last=1999.
    expect(out.y[1]).toBe(0); // min of column 0
    expect(out.y[2]).toBe(1999); // max of column 0
    // Column 3 covers [6000,8000]: first/min 6000, max/last 7999 (edge inclusive).
    expect(out.y[13]).toBe(6000); // min of column 3
    expect(out.y[14]).toBe(7999); // max of column 3
  });
});

describe('decimateBand', () => {
  it('returns the same object when the band is already sparse', () => {
    const b = band([0, 1, 2], [0, 1, 2], [5, 6, 7]);
    expect(decimateBand(b, pxScale(0, 2), stubCtx(800))).toBe(b);
  });

  it('bins to one point per column: min(lower) / max(upper) — the widest envelope', () => {
    // 8000 samples on [0,8000); W=4 → each column spans 2000 samples.
    // lower[i]=i (min at column start), upper[i]=i+1000 (max at column end).
    const n = 8000;
    const x = Array.from({ length: n }, (_, i) => i);
    const b = band(
      x,
      x.map((i) => i),
      x.map((i) => i + 1000),
    );
    const out = decimateBand(b, pxScale(0, n), stubCtx(4), 2); // W=4
    expect(out.length).toBe(4);
    // Column 0 covers [0,2000): min lower = 0, max upper = 1999+1000 = 2999.
    expect(out.lower[0]).toBe(0);
    expect(out.upper[0]).toBe(2999);
    // Column 3 covers [6000,8000]: min lower = 6000, max upper = 7999+1000 = 8999.
    expect(out.lower[3]).toBe(6000);
    expect(out.upper[3]).toBe(8999);
    // Envelope never inverts — upper ≥ lower per column.
    for (let c = 0; c < out.length; c += 1) {
      expect(out.upper[c]!).toBeGreaterThanOrEqual(out.lower[c]!);
    }
  });

  it('emits NaN on an empty column (a gap → the fill break)', () => {
    // A gap: no samples in the middle of the key range. W=4 over [0,40];
    // samples only at 0..5 and 35..40, so the middle columns are empty.
    const x = [0, 1, 2, 3, 4, 5, 35, 36, 37, 38, 39, 40];
    const b = band(
      x,
      x.map(() => 1),
      x.map(() => 2),
    );
    const out = decimateBand(b, pxScale(0, 40), stubCtx(4), 1); // W=4, colWidth 10
    // Column 1 [10,20) and column 2 [20,30) have no samples → NaN edges.
    expect(Number.isNaN(out.lower[1]!)).toBe(true);
    expect(Number.isNaN(out.upper[2]!)).toBe(true);
  });
});

describe('decimateM4 — session-break edge union', () => {
  it('unions boundary instants into the bucket edges (splits the straddling bucket)', () => {
    // 8000 samples, W=4 → buckets [0,2000),[2000,4000),[4000,6000),[6000,8000].
    const n = 8000;
    const s = cs(
      Array.from({ length: n }, (_, i) => i),
      Array.from({ length: n }, (_, i) => i),
    );
    const noBreak = decimateM4(s, pxScale(0, n), stubCtx(4), 2);
    // A break at 3000 splits [2000,4000) into two buckets → one extra bucket →
    // 4 more emitted points (first/min/max/last), so the sessions never merge.
    const withBreak = decimateM4(s, pxScale(0, n), stubCtx(4), 2, [3000]);
    expect(withBreak.length).toBe(noBreak.length + 4);
    // A break outside the visible domain is dropped (no extra edge).
    const outside = decimateM4(s, pxScale(0, n), stubCtx(4), 2, [-100]);
    expect(outside.length).toBe(noBreak.length);
  });
});
