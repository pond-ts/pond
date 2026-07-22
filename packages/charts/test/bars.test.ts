import { describe, expect, it } from 'vitest';
import { scaleLinear } from 'd3-scale';
import {
  barAt,
  barExtent,
  barIndexAtTime,
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
      null,
    );
    // x: [0*2, 10*2] = [0,20] → x0=0, width=20. y: value=100-40=60, base=100-0=100
    // → yTop=60, height=40.
    const fill = calls.find((c) => c.name === 'fillRect');
    expect(fill?.args).toEqual([0, 60, 20, 40]);
  });

  it('highlights + outlines the bar matching BOTH the series id and key', () => {
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      bars([0, 1], [1, 2], [10, 20]),
      identity,
      identity,
      style,
      0,
      0,
      'count', // this layer's series id
      { key: 1, id: 'count' }, // selects the second bar of this series
      null,
    );
    // the highlighted bar fills with the highlight colour and gets a strokeRect.
    expect(calls.some((c) => c.type === 'set' && c.args[0] === '#fff')).toBe(
      true,
    );
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(1);
  });

  it('does NOT highlight a key match with a different series id (other series)', () => {
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
      { key: 1, id: 'other' }, // same key, different series id → no highlight
      null,
    );
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(0);
    expect(calls.some((c) => c.type === 'set' && c.args[0] === '#fff')).toBe(
      false,
    );
  });

  it('never highlights when the layer has no series id (display-only)', () => {
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      bars([0, 1], [1, 2], [10, 20]),
      identity,
      identity,
      style,
      0,
      0,
      undefined, // no id → not selectable
      { key: 1, id: 'count' }, // a selection exists, but this layer can't match
      { key: 1, id: 'count' },
    );
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(0);
    expect(calls.some((c) => c.type === 'set' && c.args[0] === '#fff')).toBe(
      false,
    );
  });

  it('highlights a hovered bar with fill only — no outline (that is select)', () => {
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
      null, // nothing selected
      { key: 1, id: 'count' }, // hover the second bar
    );
    // hovered bar fills with the highlight colour...
    expect(calls.some((c) => c.type === 'set' && c.args[0] === '#fff')).toBe(
      true,
    );
    // ...but is NOT outlined — the outline is reserved for the committed select.
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(0);
  });

  it('outlines a bar that is both selected and hovered (select wins)', () => {
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
      { key: 1, id: 'count' }, // selected...
      { key: 1, id: 'count' }, // ...and hovered — the same bar
    );
    // highlight fill + the select outline (the select branch still draws it).
    expect(calls.some((c) => c.type === 'set' && c.args[0] === '#fff')).toBe(
      true,
    );
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(1);
  });
});

describe('barIndexAtTime', () => {
  // Three contiguous bars: [0,10], [10,20], [20,30].
  const cs = bars([0, 10, 20], [10, 20, 30], [5, 6, 7]);

  it('returns the bar whose span contains the time', () => {
    expect(barIndexAtTime(cs, 5)).toBe(0);
    expect(barIndexAtTime(cs, 15)).toBe(1);
    expect(barIndexAtTime(cs, 25)).toBe(2);
  });

  it('stays on the same bar past its midpoint (not nearest-by-begin)', () => {
    // 18 is in the right half of bar 1 ([10,20]); nearest-by-begin would flip to
    // bar 2 (begin 20 nearer than begin 10). Containment keeps it on bar 1 — the
    // flag-on-the-wrong-bar fix.
    expect(barIndexAtTime(cs, 18)).toBe(1);
  });

  it('returns the left bar at a shared edge (end[i] === begin[i+1])', () => {
    expect(barIndexAtTime(cs, 10)).toBe(0);
    expect(barIndexAtTime(cs, 20)).toBe(1);
  });

  it('returns -1 outside every bar span', () => {
    expect(barIndexAtTime(cs, -1)).toBe(-1);
    expect(barIndexAtTime(cs, 31)).toBe(-1);
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

describe('drawBars — viewport culling (Phase 2)', () => {
  // 6 contiguous unit bars: begin 0,10,…,50; end = begin+10.
  const ramp = () =>
    bars([0, 10, 20, 30, 40, 50], [10, 20, 30, 40, 50, 60], [1, 2, 3, 4, 5, 6]);

  it('fills only the bars whose span overlaps the visible window (+1 each side)', () => {
    const { ctx, calls } = recordingContext();
    // view [22, 38] → spans [20,30] and [30,40] overlap; +1 margin → indices [1,5)
    // → 4 bars of 6.
    drawBars(
      ctx,
      ramp(),
      scaleWithDomain(22, 38),
      identity,
      style,
      0,
      0,
      'count',
      null,
      null,
    );
    expect(calls.filter((c) => c.name === 'fillRect')).toHaveLength(4);
  });

  it('matches selection by the original begin key after culling', () => {
    const { ctx, calls } = recordingContext();
    // Select the bar at begin=30 (index 3). Within the culled window it must
    // still light up (highlight fill + outline stroke), keyed on its real begin.
    drawBars(
      ctx,
      ramp(),
      scaleWithDomain(22, 55),
      identity,
      style,
      0,
      0,
      'count',
      { key: 30, id: 'count' },
      null,
    );
    // The selected bar strokes an outline; a mis-keyed cull would miss it.
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(1);
  });

  it('fills all bars when the scale has no domain (test stub)', () => {
    const { ctx, calls } = recordingContext();
    drawBars(ctx, ramp(), identity, identity, style, 0, 0, 'count', null, null);
    expect(calls.filter((c) => c.name === 'fillRect')).toHaveLength(6);
  });
});

/**
 * `drawBars` M4 column decimation ([PND-MARKDEC]): once the visible bars are
 * denser than ~2 per device pixel, they're drawn as one envelope rect per pixel
 * column instead of every bar. Needs a real invertible scale + a sized ctx (a
 * bare scale / unsized ctx never decimates — the other bars tests stay full-res).
 */
describe('drawBars — M4 column decimation', () => {
  const pxScale = (lo: number, hi: number, widthCss = hi - lo) =>
    scaleLinear().domain([lo, hi]).range([0, widthCss]) as unknown as (
      v: number,
    ) => number;
  // A recording ctx with a device-pixel backing width so decimation can fire.
  const sizedCtx = (widthPx: number) => {
    const rec = recordingContext();
    (rec.ctx as unknown as { canvas: { width: number } }).canvas = {
      width: widthPx,
    };
    return rec;
  };
  // `n` unit bars over [0, n], value = index (all positive).
  const dense = (n: number): BarSeries =>
    bars(
      Array.from({ length: n }, (_, i) => i),
      Array.from({ length: n }, (_, i) => i + 1),
      Array.from({ length: n }, (_, i) => i),
    );

  it('draws one envelope rect per non-empty column when dense', () => {
    const { ctx, calls } = sizedCtx(4); // W=4
    // 100 bars ≫ 2×4 → decimate to ≤4 column rects.
    const stats = drawBars(
      ctx,
      dense(100),
      pxScale(0, 100),
      (v) => v,
      style,
      0,
      0,
      'count',
      null,
      null,
    );
    expect(calls.filter((c) => c.name === 'fillRect')).toHaveLength(4);
    expect(stats).toEqual({ sourceCount: 100, drawnCount: 4, decimated: true });
  });

  it('draws every bar full-resolution below the density threshold', () => {
    const { ctx, calls } = sizedCtx(800); // W=800; 100 bars < 2×800
    const stats = drawBars(
      ctx,
      dense(100),
      pxScale(0, 100),
      (v) => v,
      style,
      0,
      0,
      'count',
      null,
      null,
    );
    expect(calls.filter((c) => c.name === 'fillRect')).toHaveLength(100);
    expect(stats).toEqual({
      sourceCount: 100,
      drawnCount: 100,
      decimated: false,
    });
  });

  it('draws every bar when decimate is off, even at density', () => {
    const { ctx, calls } = sizedCtx(4);
    const stats = drawBars(
      ctx,
      dense(100),
      pxScale(0, 100),
      (v) => v,
      style,
      0,
      0,
      'count',
      null,
      null,
      false, // decimate off
    );
    expect(calls.filter((c) => c.name === 'fillRect')).toHaveLength(100);
    expect(stats.decimated).toBe(false);
  });

  it('suppresses the per-bar selection highlight when decimated', () => {
    const { ctx, calls } = sizedCtx(4);
    // A selection matching a source bar: at full res it would strokeRect; when
    // decimated the aggregate columns aren't individually selectable, so no stroke.
    drawBars(
      ctx,
      dense(100),
      pxScale(0, 100),
      (v) => v,
      style,
      0,
      0,
      'count',
      { key: 42, id: 'count' },
      null,
    );
    expect(calls.some((c) => c.name === 'strokeRect')).toBe(false);
    // The envelope fill uses the flat `fill`, never the `highlight`.
    expect(
      calls.some(
        (c) =>
          c.type === 'set' &&
          c.name === 'fillStyle' &&
          c.args?.[0] === style.highlight,
      ),
    ).toBe(false);
  });
});
