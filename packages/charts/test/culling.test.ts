import { describe, expect, it } from 'vitest';
import { scaleLinear } from 'd3-scale';
import {
  scaleDomain,
  visiblePointWindow,
  visibleSpanWindow,
  visiblePointRange,
  visibleSpanRange,
  cullChartSeries,
  cullBandSeries,
} from '../src/culling.js';
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

/** A d3 linear scale as the draw-path `Scale` — callable AND carrying `.domain()`. */
const scale = (lo: number, hi: number): Scale =>
  scaleLinear().domain([lo, hi]).range([0, 100]) as unknown as Scale;

describe('scaleDomain', () => {
  it('reads a d3 linear scale domain, ascending', () => {
    expect(scaleDomain(scale(10, 50))).toEqual([10, 50]);
  });

  it('coerces a scaleTime [Date, Date] domain to ms', () => {
    const s = scaleLinear()
      .domain([new Date(1000), new Date(9000)] as unknown as number[])
      .range([0, 1]) as unknown as Scale;
    expect(scaleDomain(s)).toEqual([1000, 9000]);
  });

  it('returns null for a bare function scale (no .domain)', () => {
    expect(scaleDomain(((v: number) => v) as Scale)).toBeNull();
  });

  it('returns null for a non-numeric (category) domain', () => {
    const s = { domain: () => ['a', 'b', 'c'] } as unknown as Scale;
    expect(scaleDomain(s)).toBeNull();
  });

  it('sorts a reversed domain ascending', () => {
    const s = { domain: () => [80, 20] } as unknown as Scale;
    expect(scaleDomain(s)).toEqual([20, 80]);
  });
});

describe('visiblePointWindow', () => {
  // x = [0,10,20,30,40,50,60,70,80,90], length 10
  const x = Float64Array.from({ length: 10 }, (_, i) => i * 10);

  it('includes one entry + one exit point around the visible range', () => {
    // view [25, 55] → in-range indices 3(30),4(40),5(50); +1 each side → [2, 7)
    expect(visiblePointWindow(x, 10, 25, 55)).toEqual([2, 7]);
  });

  it('keeps the exit point when the range ends exactly on a sample', () => {
    // view [25, 50] → in-range 3,4,5 (50 included via >= is upperBound of 50 = 6);
    // +1 → start 2, end 7
    expect(visiblePointWindow(x, 10, 25, 50)).toEqual([2, 7]);
  });

  it('keeps the entry point when the range starts exactly on a sample', () => {
    // view [30, 55] → lowerBound(30)=3 → start 2; upperBound(55)=6 → end 7
    expect(visiblePointWindow(x, 10, 30, 55)).toEqual([2, 7]);
  });

  it('returns the whole series when the view covers it', () => {
    expect(visiblePointWindow(x, 10, -100, 1000)).toEqual([0, 10]);
  });

  it('clamps the entry margin at the left edge', () => {
    // view [0, 25] → lowerBound(0)=0 → start max(0,-1)=0; upperBound(25)=3 → end 4
    expect(visiblePointWindow(x, 10, 0, 25)).toEqual([0, 4]);
  });

  it('clamps the exit margin at the right edge', () => {
    // view [75, 90] → lowerBound(75)=8 → start 7; upperBound(90)=10 → end 10
    expect(visiblePointWindow(x, 10, 75, 90)).toEqual([7, 10]);
  });

  it('yields a one-point off-screen slice when the series is entirely left of view', () => {
    // hi < x[0]: everything left → [length-1, length]
    expect(visiblePointWindow(x, 10, 200, 300)).toEqual([9, 10]);
  });

  it('yields a one-point off-screen slice when the series is entirely right of view', () => {
    // lo > x[last]: everything right → [0, 1]
    expect(visiblePointWindow(x, 10, -300, -200)).toEqual([0, 1]);
  });

  it('handles an empty series', () => {
    expect(visiblePointWindow(new Float64Array(0), 0, 0, 100)).toEqual([0, 0]);
  });

  it('honours a wider margin', () => {
    // view [45, 55] margin 2 → in-range 5; ±2 → start 3, end 8
    expect(visiblePointWindow(x, 10, 45, 55, 2)).toEqual([3, 8]);
  });
});

describe('cullChartSeries', () => {
  const series = cs([0, 10, 20, 30, 40, 50], [0, 1, 2, 3, 4, 5]);

  it('slices to the visible window as a zero-copy view', () => {
    // view [22, 38] → in-range 30; entry 20 + exit 40 → indices [2, 5)
    const view = cullChartSeries(series, scale(22, 38));
    expect(Array.from(view.x)).toEqual([20, 30, 40]);
    expect(Array.from(view.y)).toEqual([2, 3, 4]);
    expect(view.length).toBe(3);
    // Zero-copy: the view aliases the source buffer.
    expect(view.x.buffer).toBe(series.x.buffer);
  });

  it('returns the same object (no allocation) when the whole series is visible', () => {
    expect(cullChartSeries(series, scale(-10, 100))).toBe(series);
  });

  it('returns the same object when the scale exposes no domain (test stub)', () => {
    expect(cullChartSeries(series, ((v: number) => v) as Scale)).toBe(series);
  });

  it('returns the same object for an empty series', () => {
    const empty = cs([], []);
    expect(cullChartSeries(empty, scale(0, 10))).toBe(empty);
  });

  it('extends the left boundary past an edge gap to the nearest finite anchor', () => {
    // Finite 0/10, then a NaN run 20/30/40, finite from 50. View [35, 60] would
    // bisect the slice to start at x=30 (NaN); the anchor at x=10 is 3 points
    // off-screen. The extension must walk back to include it so the boundary
    // gap stays interior (else 'none'/'dashed' break at the edge).
    const gappy = cs(
      [0, 10, 20, 30, 40, 50, 60],
      [0, 10, NaN, NaN, NaN, 50, 60],
    );
    const view = cullChartSeries(gappy, scale(35, 60));
    // Slice starts at the finite anchor x=10, not the NaN at x=30.
    expect(view.x[0]).toBe(10);
    expect(Number.isFinite(view.y[0]!)).toBe(true);
  });

  it('extends the right boundary past a trailing edge gap to the next finite anchor', () => {
    const gappy = cs(
      [0, 10, 20, 30, 40, 50, 60, 70],
      [0, 10, 20, NaN, NaN, NaN, 60, 70],
    );
    const view = cullChartSeries(gappy, scale(0, 25));
    // A genuine partial slice (x=70 stops the walk): it ends on the finite
    // anchor x=60, not the NaN run at 30/40/50.
    expect(view.length).toBeLessThan(gappy.length);
    expect(view.x[view.length - 1]).toBe(60);
    expect(Number.isFinite(view.y[view.length - 1]!)).toBe(true);
  });
});

describe('cullBandSeries', () => {
  const bs = band([0, 10, 20, 30, 40], [0, 1, 2, 3, 4], [10, 11, 12, 13, 14]);

  it('culls lower/upper in lockstep with x', () => {
    const view = cullBandSeries(bs, scale(15, 25)); // in-range 20; +1 → [1,4)
    expect(Array.from(view.x)).toEqual([10, 20, 30]);
    expect(Array.from(view.lower)).toEqual([1, 2, 3]);
    expect(Array.from(view.upper)).toEqual([11, 12, 13]);
    expect(view.length).toBe(3);
  });

  it('returns the same object when fully visible', () => {
    expect(cullBandSeries(bs, scale(-10, 100))).toBe(bs);
  });
});

describe('visibleSpanWindow', () => {
  // 6 contiguous unit-width marks: begin 0,10,…,50, end = begin+10.
  const begin = Float64Array.from([0, 10, 20, 30, 40, 50]);
  const end = Float64Array.from([10, 20, 30, 40, 50, 60]);

  it('includes marks whose span overlaps the view, +1 margin', () => {
    // view [22, 38] → marks [20,30] and [30,40] overlap; +1 margin → [1, 5)
    expect(visibleSpanWindow(begin, end, 6, 22, 38)).toEqual([1, 5]);
  });

  it('keeps a wide bar that starts left of the view but reaches into it', () => {
    // A single wide mark spanning [0, 100] plus narrow ones after.
    const b = Float64Array.from([0, 100, 110, 120]);
    const e = Float64Array.from([100, 110, 120, 130]);
    // view [40, 60] → only the wide [0,100] mark overlaps; its begin (0) is 1
    // mark left of lowerBound(40)=1, so the end-walk pulls it in. +1 margin
    // clamps at 0 on the left. right: upperBound(60)=1 → +1 → 2.
    expect(visibleSpanWindow(b, e, 4, 40, 60)).toEqual([0, 2]);
  });

  it('excludes a mark starting past the right edge', () => {
    // view [-5, 15] → marks [0,10] and [10,20] overlap. upperBound(15)=2,
    // +1 → 3; left lowerBound(-5)=0, -1 margin clamp → 0.
    expect(visibleSpanWindow(begin, end, 6, -5, 15)).toEqual([0, 3]);
  });

  it('returns the whole set when the view covers it', () => {
    expect(visibleSpanWindow(begin, end, 6, -100, 1000)).toEqual([0, 6]);
  });

  it('handles an empty series', () => {
    expect(
      visibleSpanWindow(new Float64Array(0), new Float64Array(0), 0, 0, 9),
    ).toEqual([0, 0]);
  });
});

describe('visiblePointRange', () => {
  const x = Float64Array.from([0, 10, 20, 30, 40, 50]);
  // A 1px == 1 data-unit scale (range mirrors domain) so a pixel `padPx` maps
  // straight to data units and the arithmetic is legible.
  const px1 = (lo: number, hi: number): Scale =>
    scaleLinear().domain([lo, hi]).range([lo, hi]) as unknown as Scale;

  it('returns the visible index window against a domain scale', () => {
    // view [22, 38] → in-range 30; entry 20 + exit 40 → [2, 5)
    expect(visiblePointRange(x, 6, scale(22, 38))).toEqual([2, 5]);
  });

  it('widens the window by padPx pixels, converted to data via invert', () => {
    // view [25, 35], no pad → [2, 5) (x=20,30,40). An 8px radius pad (⇒ 8 data
    // units on this 1:1 scale) reaches x=10 and x=50 → [1, 6). This is the fat-
    // edge-mark case: the disc overlaps the plot though the centre is a further
    // sample out.
    expect(visiblePointRange(x, 6, px1(25, 35))).toEqual([2, 5]);
    expect(visiblePointRange(x, 6, px1(25, 35), 8)).toEqual([1, 6]);
  });

  it('honours the px→data ratio of a non-1:1 scale', () => {
    // scale(25, 35): domain span 10 over a 100px range ⇒ 0.1 data/px, so 8px is
    // only 0.8 data units — too small to reach a neighbour, window stays [2, 5).
    // 80px ⇒ 8 data units reaches x=10 and x=50 → [1, 6). Proves the pad is
    // converted through the scale, not taken as raw data units.
    expect(visiblePointRange(x, 6, scale(25, 35), 8)).toEqual([2, 5]);
    expect(visiblePointRange(x, 6, scale(25, 35), 80)).toEqual([1, 6]);
  });

  it('skips the pad (keeps the domain window) when the scale has no invert', () => {
    // A domain-bearing stub with no `.invert()` — the pad can't be converted, so
    // it degrades to the plain index window, never a dropped mark.
    const noInvert = Object.assign((v: number) => v, {
      domain: () => [25, 35],
    }) as unknown as Scale;
    expect(visiblePointRange(x, 6, noInvert, 8)).toEqual([2, 5]);
  });

  it('returns the full range when the scale has no domain (test stub)', () => {
    // The pad is irrelevant with no domain — the whole series draws.
    expect(visiblePointRange(x, 6, ((v: number) => v) as Scale, 8)).toEqual([
      0, 6,
    ]);
  });

  it('returns [0,0] for an empty series', () => {
    expect(visiblePointRange(new Float64Array(0), 0, scale(0, 9), 8)).toEqual([
      0, 0,
    ]);
  });
});

describe('visibleSpanRange', () => {
  const begin = Float64Array.from([0, 10, 20, 30, 40, 50]);
  const end = Float64Array.from([10, 20, 30, 40, 50, 60]);

  it('returns the visible span window against a domain scale', () => {
    expect(visibleSpanRange(begin, end, 6, scale(22, 38))).toEqual([1, 5]);
  });

  it('returns the full range when the scale has no domain (test stub)', () => {
    expect(
      visibleSpanRange(begin, end, 6, ((v: number) => v) as Scale),
    ).toEqual([0, 6]);
  });
});
