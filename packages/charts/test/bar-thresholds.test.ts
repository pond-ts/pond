import { describe, expect, it } from 'vitest';
import {
  bandSpan,
  drawBars,
  drawStacks,
  normalizeThresholds,
  type BandLadder,
} from '../src/bars.js';
import { recordingContext, type CtxCall } from './canvas-mock.js';
import type { BarSeries, StackedBarSeries } from '../src/data.js';
import type { BarStyle } from '../src/theme.js';

/**
 * Threshold banding ([PND-BANDBAR2]) — one bar coloured **along its length**
 * against a ladder, replacing the N-overlaid-layers overpaint recipe.
 *
 * The load-bearing guarantee these tests pin is that a banded bar is still
 * **one bar**: the bands are draw-only geometry, so the hit rect is untouched.
 * That is the whole reason this is a mark rather than a documented recipe.
 */

const bars = (begin: number[], end: number[], y: number[]): BarSeries => ({
  begin: Float64Array.from(begin),
  end: Float64Array.from(end),
  y: Float64Array.from(y),
  length: begin.length,
});

const identity = (v: number) => v;
const style: BarStyle = {
  fill: '#flat',
  opacity: 0.85,
  highlight: '#fff',
  gap: 0,
  minWidth: 1,
  outlineWidth: 2,
};

/** `fillStyle` set → `fillRect` args, in draw order. */
function paints(calls: CtxCall[]): { fill: string; rect: number[] }[] {
  const out: { fill: string; rect: number[] }[] = [];
  let fill = '';
  for (const c of calls) {
    if (c.type === 'set' && c.name === 'fillStyle') fill = c.args[0] as string;
    if (c.type === 'call' && c.name === 'fillRect') {
      out.push({ fill, rect: c.args as number[] });
    }
  }
  return out;
}

describe('normalizeThresholds', () => {
  it('sorts an out-of-order ladder rather than rejecting it', () => {
    // The bands are defined by their boundaries, so [2, 1] and [1, 2] describe
    // the same three bands — there is no second reading to guess at.
    expect(normalizeThresholds([2, 1])).toEqual([1, 2]);
  });

  it('drops non-finite entries, which would swallow every band above them', () => {
    expect(normalizeThresholds([1, NaN, 3, Infinity])).toEqual([1, 3]);
  });

  it('returns null for no usable ladder, so the caller keeps the flat path', () => {
    expect(normalizeThresholds(undefined)).toBeNull();
    expect(normalizeThresholds([])).toBeNull();
    expect(normalizeThresholds([NaN, Infinity])).toBeNull();
  });
});

describe('bandSpan', () => {
  const ladder = [1, 2];

  it('splits a bar that crosses the whole ladder into three spans', () => {
    expect(bandSpan(0, 3, ladder, 0)).toEqual([0, 1]);
    expect(bandSpan(0, 3, ladder, 1)).toEqual([1, 2]);
    expect(bandSpan(0, 3, ladder, 2)).toEqual([2, 3]);
  });

  it('truncates the band the value stops inside', () => {
    expect(bandSpan(0, 1.5, ladder, 1)).toEqual([1, 1.5]);
  });

  it('returns null for a band the bar never reaches', () => {
    // A bar that stops at 1.5 contributes nothing to the third band — which is
    // what lets the draw loop skip it rather than emitting a zero-height rect.
    expect(bandSpan(0, 1.5, ladder, 2)).toBeNull();
    expect(bandSpan(0, 0, ladder, 0)).toBeNull();
  });

  it('bands a negative bar symmetrically, walking the ladder downward', () => {
    // The ±3.5 diverging case: no negative breakpoints needed.
    expect(bandSpan(0, -3, ladder, 0)).toEqual([0, -1]);
    expect(bandSpan(0, -3, ladder, 1)).toEqual([-1, -2]);
    expect(bandSpan(0, -3, ladder, 2)).toEqual([-2, -3]);
  });

  it('measures from a non-zero baseline, not from zero', () => {
    // An explicit <YAxis min> above zero rests bars on the axis floor; the
    // ladder is a distance travelled from wherever the bar starts.
    expect(bandSpan(10, 12.5, ladder, 0)).toEqual([10, 11]);
    expect(bandSpan(10, 12.5, ladder, 2)).toEqual([12, 12.5]);
  });

  it('puts everything in the top band when the ladder is empty above it', () => {
    expect(bandSpan(0, 99, [], 0)).toEqual([0, 99]);
  });
});

describe('drawBars with a threshold ladder', () => {
  const ladder: BandLadder = {
    thresholds: [1, 2],
    colors: ['#ok', '#warn', '#alarm'],
  };
  const cs = bars([0, 1], [1, 2], [3, 0.5]);

  it('paints one rect per band reached, in ladder order', () => {
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      cs,
      identity,
      identity,
      style,
      0,
      0,
      undefined,
      null,
      null,
      false,
      undefined,
      ladder,
    );
    const p = paints(calls);
    // Bar 0 (value 3) crosses all three bands; bar 1 (value 0.5) only the first.
    expect(p.map((q) => q.fill)).toEqual(['#ok', '#warn', '#alarm', '#ok']);
    // Every band of a bar shares the bar's x-span, and they tile its length.
    expect(p[0]!.rect[0]).toBe(p[1]!.rect[0]);
    expect(p[0]!.rect[2]).toBe(p[1]!.rect[2]);
  });

  it('does not draw a band the bar never reaches', () => {
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      bars([0], [1], [0.5]),
      identity,
      identity,
      style,
      0,
      0,
      undefined,
      null,
      null,
      false,
      undefined,
      ladder,
    );
    expect(paints(calls)).toHaveLength(1);
  });

  it('yields to binColors, the more specific per-bar answer', () => {
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      bars([0], [1], [3]),
      identity,
      identity,
      style,
      0,
      0,
      undefined,
      null,
      null,
      false,
      ['#perbar'],
      ladder,
    );
    const p = paints(calls);
    expect(p).toHaveLength(1);
    expect(p[0]!.fill).toBe('#perbar');
  });

  it('suppresses envelope decimation, as binColors does', () => {
    // One envelope rect cannot carry a gradient, so a banded layer draws every
    // visible bar even with decimation left on.
    const { ctx, calls } = recordingContext();
    const stats = drawBars(
      ctx,
      cs,
      identity,
      identity,
      style,
      0,
      0,
      undefined,
      null,
      null,
      true,
      undefined,
      ladder,
    );
    expect(stats.decimated).toBe(false);
    expect(paints(calls).length).toBeGreaterThan(0);
  });

  it('outlines a selected bar in the band its value reached', () => {
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      bars([0], [1], [3]),
      identity,
      identity,
      style,
      0,
      0,
      'sid',
      { id: 'sid', key: 0 },
      null,
      false,
      undefined,
      ladder,
    );
    const stroke = calls.filter(
      (c) => c.type === 'set' && c.name === 'strokeStyle',
    );
    expect(stroke.at(-1)!.args[0]).toBe('#alarm');
  });

  it('draws the flat fill when no ladder is supplied (unchanged path)', () => {
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      bars([0], [1], [3]),
      identity,
      identity,
      style,
      0,
      0,
      undefined,
      null,
      null,
      false,
    );
    expect(paints(calls).map((q) => q.fill)).toEqual(['#flat']);
  });
});

describe('drawStacks with a threshold ladder', () => {
  const ladder: BandLadder = {
    thresholds: [1, 2],
    colors: ['#ok', '#warn', '#alarm'],
  };
  const stackStyle = { fills: ['#grp'], opacity: 1, outlineWidth: 2 };

  /** A one-group stack — what `categoryStack` builds, and every horizontal bar. */
  const single = (values: number[]): StackedBarSeries => ({
    begin: Float64Array.from(values.map((_, i) => i)),
    end: Float64Array.from(values.map((_, i) => i + 1)),
    values: Float64Array.from(values),
    groups: ['v'],
    length: values.length,
  });

  it('bands a vertical categorical bar along y', () => {
    const { ctx, calls } = recordingContext();
    drawStacks(
      ctx,
      single([3]),
      'vertical',
      identity,
      identity,
      stackStyle,
      0,
      1,
      undefined,
      null,
      null,
      ladder,
    );
    const p = paints(calls);
    expect(p.map((q) => q.fill)).toEqual(['#ok', '#warn', '#alarm']);
    // Vertical: every band shares the bin's x-span and slices y.
    expect(p[0]!.rect[0]).toBe(p[2]!.rect[0]);
    expect(p[0]!.rect[2]).toBe(p[2]!.rect[2]);
    expect(p[0]!.rect[1]).not.toBe(p[2]!.rect[1]);
  });

  it('bands a horizontal bar along x — the transposed case', () => {
    const { ctx, calls } = recordingContext();
    drawStacks(
      ctx,
      single([3]),
      'horizontal',
      identity,
      identity,
      stackStyle,
      0,
      1,
      undefined,
      null,
      null,
      ladder,
    );
    const p = paints(calls);
    expect(p.map((q) => q.fill)).toEqual(['#ok', '#warn', '#alarm']);
    // Horizontal: every band shares the bin's y-span and slices x.
    expect(p[0]!.rect[1]).toBe(p[2]!.rect[1]);
    expect(p[0]!.rect[3]).toBe(p[2]!.rect[3]);
    expect(p[0]!.rect[0]).not.toBe(p[2]!.rect[0]);
  });

  it('is ignored on a genuine multi-group stack', () => {
    // A segment that is already one slice of a total has no defined banding —
    // it must fall through to the group fill rather than be half-applied.
    const twoGroup: StackedBarSeries = {
      begin: Float64Array.from([0]),
      end: Float64Array.from([1]),
      values: Float64Array.from([2, 3]),
      groups: ['a', 'b'],
      length: 1,
    };
    const { ctx, calls } = recordingContext();
    drawStacks(
      ctx,
      twoGroup,
      'vertical',
      identity,
      identity,
      { fills: ['#a', '#b'], opacity: 1, outlineWidth: 2 },
      0,
      1,
      undefined,
      null,
      null,
      ladder,
    );
    expect(paints(calls).map((q) => q.fill)).toEqual(['#a', '#b']);
  });

  it('yields to binFills on the stacked path too', () => {
    const { ctx, calls } = recordingContext();
    drawStacks(
      ctx,
      single([3]),
      'vertical',
      identity,
      identity,
      { ...stackStyle, binFills: ['#perbin'] },
      0,
      1,
      undefined,
      null,
      null,
      ladder,
    );
    expect(paints(calls).map((q) => q.fill)).toEqual(['#perbin']);
  });
});
