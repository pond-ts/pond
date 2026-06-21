import { describe, expect, it } from 'vitest';
import {
  barAt,
  barExtent,
  barRect,
  drawBars,
  resolveBarBaseline,
} from '../src/bars.js';
import { recordingContext } from './canvas-mock.js';
import type { BarSeries } from '../src/data.js';
import type { BarStyle } from '../src/theme.js';

/** A bar series from parallel begin/end/value arrays. */
const bars = (begin: number[], end: number[], y: number[]): BarSeries => ({
  begin: Float64Array.from(begin),
  end: Float64Array.from(end),
  y: Float64Array.from(y),
  length: begin.length,
});

const identity = (v: number) => v;
const style: BarStyle = {
  fill: '#abc',
  opacity: 0.85,
  highlight: '#fff',
  gap: 0,
  minWidth: 1,
  outlineWidth: 2,
};

/** A scale carrying a d3-style `.domain()`, for resolveBarBaseline. */
function scaleWithDomain(lo: number, hi: number): (v: number) => number {
  const f = (v: number) => v;
  (f as unknown as { domain: () => number[] }).domain = () => [lo, hi];
  return f;
}

describe('barExtent', () => {
  it('widens the value extent to include 0 (the baseline)', () => {
    // all-positive values → extent floored at 0 so bars rest on a visible line.
    expect(barExtent(bars([0, 1, 2], [1, 2, 3], [10, 20, 30]))).toEqual([
      0, 30,
    ]);
  });

  it('keeps a negative floor / positive ceiling when the data straddles 0', () => {
    expect(barExtent(bars([0, 1], [1, 2], [-5, 8]))).toEqual([-5, 8]);
  });

  it('floors an all-negative series at 0 (the baseline above it)', () => {
    expect(barExtent(bars([0, 1], [1, 2], [-30, -10]))).toEqual([-30, 0]);
  });

  it('ignores NaN (gap) values', () => {
    expect(barExtent(bars([0, 1, 2], [1, 2, 3], [10, NaN, 30]))).toEqual([
      0, 30,
    ]);
  });

  it('returns null when no value is finite', () => {
    expect(barExtent(bars([0, 1], [1, 2], [NaN, NaN]))).toBeNull();
  });
});

describe('resolveBarBaseline', () => {
  it('rests on the zero line when the domain spans 0', () => {
    expect(resolveBarBaseline(scaleWithDomain(0, 100))).toBe(0);
    expect(resolveBarBaseline(scaleWithDomain(-50, 50))).toBe(0);
  });

  it('rests on the axis floor when the domain sits above 0', () => {
    // explicit <YAxis min={10}> → no zero line in view; rest on the floor.
    expect(resolveBarBaseline(scaleWithDomain(10, 100))).toBe(10);
  });

  it('hangs from the axis top when the domain sits below 0', () => {
    expect(resolveBarBaseline(scaleWithDomain(-100, -10))).toBe(-10);
  });

  it('reads a descending [hi, lo] domain (range-flipped scale) the same way', () => {
    // a y pixel scale's domain is conventionally [lo, hi] with range [h,0]; guard
    // the normalization anyway so an inverted domain still clamps correctly.
    expect(resolveBarBaseline(scaleWithDomain(100, 10))).toBe(10);
  });

  it('falls back to 0 with no domain accessor', () => {
    expect(resolveBarBaseline(identity)).toBe(0);
  });
});

describe('barRect', () => {
  it('spans the key [begin,end] in x and value→baseline in y', () => {
    // value 30 with baseline 0, identity scales → rect x[0,2], y top=value(=30
    // here, identity) is below base(0) on screen? identity makes larger y lower,
    // so yTop = min(30, 0) = 0, yBottom = max = 30.
    const rect = barRect(bars([0], [2], [30]), 0, identity, identity, 0, 0, 1);
    expect(rect).toEqual([0, 2, 0, 30]);
  });

  it('normalizes y for a value below the baseline (negative bar)', () => {
    // value -10, baseline 0 → yTop=min(-10,0)=-10, yBottom=max=0.
    const rect = barRect(bars([0], [2], [-10]), 0, identity, identity, 0, 0, 1);
    expect(rect).toEqual([0, 2, -10, 0]);
  });

  it('insets the x-span by the gap', () => {
    const rect = barRect(bars([0], [10], [5]), 0, identity, identity, 0, 4, 1);
    expect(rect?.[0]).toBe(2);
    expect(rect?.[1]).toBe(8);
  });

  it('returns null for a gap (non-finite value)', () => {
    expect(
      barRect(bars([0], [2], [NaN]), 0, identity, identity, 0, 0, 1),
    ).toBeNull();
  });
});

describe('drawBars', () => {
  it('fills one rect per finite bar, skipping gaps', () => {
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      bars([0, 1, 2], [1, 2, 3], [10, NaN, 30]),
      identity,
      identity,
      style,
      0,
      0,
      'count',
      null,
    );
    // two finite bars → two fillRect; the NaN bar is skipped.
    expect(calls.filter((c) => c.name === 'fillRect')).toHaveLength(2);
    // bracketed by save/restore so the alpha doesn't leak.
    const names = calls.filter((c) => c.type === 'call').map((c) => c.name);
    expect(names[0]).toBe('save');
    expect(names[names.length - 1]).toBe('restore');
  });

  it('applies the fill colour + opacity', () => {
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      bars([0], [1], [10]),
      identity,
      identity,
      style,
      0,
      0,
      'count',
      null,
    );
    expect(
      calls.find((c) => c.type === 'set' && c.name === 'globalAlpha')?.args,
    ).toEqual([0.85]);
    expect(
      calls.find((c) => c.type === 'set' && c.name === 'fillStyle')?.args,
    ).toEqual(['#abc']);
  });

  it('maps the rect through the scales (x*2, y flipped)', () => {
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      bars([0], [10], [40]),
      (t) => t * 2,
      (v) => 100 - v,
      style,
      0, // baseline
      0,
      'count',
      null,
    );
    // x: [0*2, 10*2] = [0,20] → x0=0, width=20. y: value=100-40=60, base=100-0=100
    // → yTop=60, height=40.
    const fill = calls.find((c) => c.name === 'fillRect');
    expect(fill?.args).toEqual([0, 60, 20, 40]);
  });

  it('highlights + outlines the bar matching BOTH key and label', () => {
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      bars([0, 1], [1, 2], [10, 20]),
      identity,
      identity,
      style,
      0,
      0,
      'count',
      { key: 1, label: 'count' }, // selects the second bar
    );
    // the highlighted bar fills with the highlight colour and gets a strokeRect.
    expect(calls.some((c) => c.type === 'set' && c.args[0] === '#fff')).toBe(
      true,
    );
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(1);
  });

  it('does NOT highlight a key match with a different label (other series)', () => {
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      bars([0, 1], [1, 2], [10, 20]),
      identity,
      identity,
      style,
      0,
      0,
      'count',
      { key: 1, label: 'other' }, // same key, different series → no highlight
    );
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(0);
    expect(calls.some((c) => c.type === 'set' && c.args[0] === '#fff')).toBe(
      false,
    );
  });
});

describe('barAt', () => {
  const cs = bars([0, 10, 20], [5, 15, 25], [30, 50, 20]);

  it('returns [index, begin, value] for a click inside a bar', () => {
    // bar 1: x in [10,15], y between baseline(0) and value(50) → click (12, 25).
    expect(barAt(cs, 12, 25, identity, identity, 0, 0, 1)).toEqual([1, 10, 50]);
  });

  it('hits the first bar (x in [0,5], y in [0,30])', () => {
    expect(barAt(cs, 2, 10, identity, identity, 0, 0, 1)).toEqual([0, 0, 30]);
  });

  it('misses in the x-gap between bars', () => {
    // x=7 falls between bar 0 ([0,5]) and bar 1 ([10,15]).
    expect(barAt(cs, 7, 10, identity, identity, 0, 0, 1)).toBeNull();
  });

  it('misses above the bar (y beyond the value)', () => {
    // bar 1 reaches value 50; y=60 is past it (identity: larger y is "below"
    // the value pixel, i.e. outside the [0,50] rect).
    expect(barAt(cs, 12, 60, identity, identity, 0, 0, 1)).toBeNull();
  });

  it('skips a gap bar (non-finite value)', () => {
    const g = bars([0, 10], [5, 15], [NaN, 50]);
    // a click where the gap bar would be → no hit on it.
    expect(barAt(g, 2, 10, identity, identity, 0, 0, 1)).toBeNull();
    // the finite neighbour still hits.
    expect(barAt(g, 12, 25, identity, identity, 0, 0, 1)).toEqual([1, 10, 50]);
  });
});
