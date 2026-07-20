import { describe, expect, it } from 'vitest';
import { scaleLinear } from 'd3-scale';
import {
  contextDpr,
  deviceBucketCount,
  shouldDecimate,
  pixelEdges,
  m4Polyline,
  decimateM4,
} from '../src/decimate.js';
import type { ChartSeries } from '../src/data.js';
import type { Scale } from '../src/line.js';

const cs = (x: number[], y: number[]): ChartSeries => ({
  x: Float64Array.from(x),
  y: Float64Array.from(y),
  length: x.length,
});

/** A d3 linear scale carrying `.domain()`, mapping the domain onto itself. */
const domainScale = (lo: number, hi: number): Scale =>
  scaleLinear().domain([lo, hi]).range([lo, hi]) as unknown as Scale;

/** A minimal ctx stub: a backing width (device px) + a DPR transform. */
const stubCtx = (widthPx: number, dpr = 1): CanvasRenderingContext2D =>
  ({
    canvas: { width: widthPx },
    getTransform: () => ({ a: dpr }),
  }) as unknown as CanvasRenderingContext2D;

describe('contextDpr / deviceBucketCount', () => {
  it('reads DPR off the transform and W off the canvas width', () => {
    const ctx = stubCtx(1600, 2);
    expect(contextDpr(ctx)).toBe(2);
    expect(deviceBucketCount(ctx)).toBe(1600);
  });

  it('falls back to dpr=1 and W=0 for a bare ctx', () => {
    const bare = {} as CanvasRenderingContext2D;
    expect(contextDpr(bare)).toBe(1);
    expect(deviceBucketCount(bare)).toBe(0);
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
  it('spans [lo, hi] with W+1 ascending edges, last pinned to hi', () => {
    const e = pixelEdges(0, 100, 4);
    expect(Array.from(e)).toEqual([0, 25, 50, 75, 100]);
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
    expect(decimateM4(s, domainScale(0, 2), stubCtx(800))).toBe(s);
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
    const out = decimateM4(s, domainScale(0, n), stubCtx(4), 2); // W=4
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
