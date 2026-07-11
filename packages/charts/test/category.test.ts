import { describe, expect, it } from 'vitest';
import { categoryStack, type StackedBarSeries } from '../src/data.js';
import {
  drawStacks,
  stackValueExtent,
  segmentRect,
  type StackStyle,
} from '../src/bars.js';
import { recordingContext } from './canvas-mock.js';

const identity = (v: number) => v;
const style = (fills: string[]): StackStyle => ({
  fills,
  opacity: 0.85,
  outlineWidth: 2,
});

describe('categoryStack', () => {
  it('builds unit slots + carries the labels as stable marks', () => {
    const ss = categoryStack([
      { label: 'AAPL', value: 10 },
      { label: 'MSFT', value: 20 },
      { label: 'GOOG', value: 30 },
    ]);
    expect(Array.from(ss.begin)).toEqual([0, 1, 2]);
    expect(Array.from(ss.end)).toEqual([1, 2, 3]);
    expect(Array.from(ss.values)).toEqual([10, 20, 30]);
    expect(ss.groups).toEqual(['value']);
    expect(ss.marks).toEqual(['AAPL', 'MSFT', 'GOOG']);
  });

  it('reads a non-finite value as a gap (NaN)', () => {
    const ss = categoryStack([{ label: 'x', value: NaN }]);
    expect(Number.isNaN(ss.values[0]!)).toBe(true);
  });
});

describe('single-series (categorical) negative values', () => {
  const identity = (v: number) => v;

  it('stackValueExtent spans a negative bar so its floor is in the domain', () => {
    const ss = categoryStack([
      { label: 'P&L', value: -5 },
      { label: 'Fees', value: 2 },
    ]);
    // Both ends tracked (0 pulled in via the seeds) — the negative is NOT dropped.
    expect(stackValueExtent(ss)).toEqual([-5, 2]);
  });

  it('all-negative single series spans [min, 0]', () => {
    const ss = categoryStack([
      { label: 'a', value: -3 },
      { label: 'b', value: -8 },
    ]);
    expect(stackValueExtent(ss)).toEqual([-8, 0]);
  });

  it('segmentRect draws a negative bar below the baseline (not a gap)', () => {
    const ss = categoryStack([{ label: 'P&L', value: -5 }]);
    // identity scales: baseline yScale(0)=0, value yScale(-5)=-5 → [-5, 0].
    const rect = segmentRect(ss, 0, 0, 'vertical', identity, identity, 0, 0, 1);
    expect(rect).not.toBeNull();
    const [, , yTop, yBottom] = rect!;
    expect(yTop).toBe(-5);
    expect(yBottom).toBe(0);
  });

  it('drawStacks fills the negative bar', () => {
    const ss = categoryStack([
      { label: 'P&L', value: -5 },
      { label: 'Fees', value: 2 },
    ]);
    const { ctx, calls } = recordingContext();
    drawStacks(
      ctx,
      ss,
      'vertical',
      identity,
      identity,
      { fills: ['#0a0'], opacity: 1, outlineWidth: 2 },
      0,
      1,
      undefined,
      null,
      null,
    );
    // Both bars fill — the negative one is not silently skipped.
    expect(calls.filter((c) => c.name === 'fillRect').length).toBe(2);
  });

  it('a true multi-group stack (G>1) still drops a negative segment', () => {
    // Two groups → stacking; a negative segment is a gap (undefined in a stack).
    const ss: StackedBarSeries = {
      begin: new Float64Array([0]),
      end: new Float64Array([1]),
      groups: ['up', 'down'],
      values: new Float64Array([3, -4]), // group 'down' is negative
      length: 1,
    };
    expect(stackValueExtent(ss)).toEqual([0, 3]); // negative ignored, floor stays 0
    // The negative segment (g=1) is a gap.
    expect(
      segmentRect(ss, 0, 1, 'vertical', identity, identity, 3, 0, 1),
    ).toBeNull();
  });
});

describe('drawStacks — stable per-mark selection (categorical axis)', () => {
  const draw = (marks: string[], sel: { id: string; mark: string }) => {
    const ss = categoryStack(
      marks.map((label, i) => ({ label, value: 10 + i })),
    );
    const { ctx, calls } = recordingContext();
    drawStacks(
      ctx,
      ss,
      'vertical',
      identity,
      identity,
      style(['#0a0']),
      0,
      1,
      'chart', // the layer id
      { id: 'chart', key: -1, label: 'ignored', mark: sel.mark },
      null,
    );
    // The outlined bar is the selected one — count its strokeRect.
    return calls.filter((c) => c.name === 'strokeRect').length;
  };

  it('outlines the bar whose mark matches — keyed on the name, not the slot', () => {
    // 'MSFT' is at slot 1 here…
    expect(draw(['AAPL', 'MSFT', 'GOOG'], { id: 'chart', mark: 'MSFT' })).toBe(
      1,
    );
  });

  it('follows the column across a reorder (the stable-id win)', () => {
    // …and at slot 0 here. Same selection {mark:'MSFT'} still highlights exactly
    // one bar — it tracks the column name, not the renumbered slot index.
    expect(draw(['MSFT', 'AAPL', 'GOOG'], { id: 'chart', mark: 'MSFT' })).toBe(
      1,
    );
  });

  it('does not match a mark that is not present', () => {
    expect(draw(['AAPL', 'MSFT'], { id: 'chart', mark: 'TSLA' })).toBe(0);
  });

  it('does not match a mark from a different layer id', () => {
    const ss = categoryStack([{ label: 'AAPL', value: 10 }]);
    const { ctx, calls } = recordingContext();
    drawStacks(
      ctx,
      ss,
      'vertical',
      identity,
      identity,
      style(['#0a0']),
      0,
      1,
      'chart',
      { id: 'other', key: -1, label: 'x', mark: 'AAPL' }, // right mark, wrong layer
      null,
    );
    expect(calls.filter((c) => c.name === 'strokeRect').length).toBe(0);
  });
});
