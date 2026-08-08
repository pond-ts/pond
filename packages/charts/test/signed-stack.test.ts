import { describe, expect, it } from 'vitest';
import {
  drawStacks,
  segmentRect,
  stackAt,
  stackValueExtent,
} from '../src/bars.js';
import { recordingContext } from './canvas-mock.js';
import type { StackedBarSeries } from '../src/data.js';

/**
 * [PND-SIGNSTACK] — the **signed stacked histogram**: several series per bin
 * whose values may be either sign, positives stacking **up** from a zero line
 * and negatives **down** from it. Net flow by category, inflow/outflow,
 * buy/sell pressure by venue.
 *
 * A multi-group stack used to skip negative segments outright, and skip them
 * *silently* — no clamp, no warning, no throw. Every remaining segment then
 * stacked up as though the dropped ones had never been in the data, so a
 * mixed-sign series rendered as a confident, wrong, all-positive chart. These
 * tests pin the two running totals and, just as importantly, that the drawn
 * and hit geometry still agree.
 */

const identity = (v: number) => v;

/** A one-bin stack over `values`, one group each. */
const bin = (values: number[]): StackedBarSeries => ({
  begin: Float64Array.from([0]),
  end: Float64Array.from([1]),
  values: Float64Array.from(values),
  groups: values.map((_, i) => `g${i}`),
  length: 1,
});

describe('two running totals per bin', () => {
  it('stacks positives up and negatives down from the baseline', () => {
    // +3 then -4 then +2: the positives occupy [0,3] and [3,5]; the negative
    // [-4,0]. The +2 must NOT start at 3-4 = -1.
    const ss = bin([3, -4, 2]);
    const at = (g: number, cum: number) =>
      segmentRect(ss, 0, g, 'vertical', identity, identity, cum, 0, 1);
    expect([at(0, 0)![2], at(0, 0)![3]]).toEqual([0, 3]);
    expect([at(1, 0)![2], at(1, 0)![3]]).toEqual([-4, 0]);
    expect([at(2, 3)![2], at(2, 3)![3]]).toEqual([3, 5]);
  });

  it('draws every segment of a mixed-sign bin, not just the positives', () => {
    // The headline regression: three segments in, three rects out.
    const { ctx, calls } = recordingContext();
    drawStacks(
      ctx,
      bin([3, -4, 2]),
      'vertical',
      identity,
      identity,
      { fills: ['#a', '#b', '#c'], opacity: 1, outlineWidth: 1 },
      0,
      1,
      undefined,
      [],
      [],
    );
    expect(calls.filter((c) => c.name === 'fillRect')).toHaveLength(3);
  });

  it('reports an extent that contains what it draws', () => {
    // An extent stopping at 0 below would clip the negative segments — the two
    // halves of this fix have to move together.
    expect(stackValueExtent(bin([3, -4, 2]))).toEqual([-4, 5]);
  });

  it('leaves an all-positive stack bit-identical', () => {
    // The conventional case never touches the downward total.
    const ss = bin([3, 2, 5]);
    expect(stackValueExtent(ss)).toEqual([0, 10]);
    const r = segmentRect(ss, 0, 2, 'vertical', identity, identity, 5, 0, 1);
    expect([r![2], r![3]]).toEqual([5, 10]);
  });

  it('handles an all-negative stack', () => {
    expect(stackValueExtent(bin([-3, -2]))).toEqual([-5, 0]);
  });

  it('keeps a gap out of both totals', () => {
    expect(stackValueExtent(bin([3, NaN, -2]))).toEqual([-2, 3]);
  });
});

describe('hit geometry follows the drawn geometry', () => {
  const ss = bin([3, -4, 2]);
  const style = { fills: ['#a', '#b', '#c'], opacity: 1, outlineWidth: 1 };

  it('hits the negative segment where it is actually drawn', () => {
    // Previously unhittable, because it was never drawn. py = -2 is inside the
    // negative segment's [-4, 0] span.
    const hit = stackAt(ss, 0.5, -2, 'vertical', identity, identity, 0, 1);
    expect(hit).not.toBeNull();
    expect(hit![1]).toBe(1); // group index
    expect(hit![4]).toBe(-4); // its value
  });

  it('hits the segment stacked above a negative one at its true position', () => {
    // g2 (+2) sits at [3, 5] — above g0, unaffected by the negative below.
    const hit = stackAt(ss, 0.5, 4, 'vertical', identity, identity, 0, 1);
    expect(hit).not.toBeNull();
    expect(hit![1]).toBe(2);
  });

  it('transposes for a horizontal signed stack', () => {
    const hit = stackAt(ss, -2, 0.5, 'horizontal', identity, identity, 0, 1);
    expect(hit).not.toBeNull();
    expect(hit![1]).toBe(1);
  });
});
