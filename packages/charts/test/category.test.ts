import { describe, expect, it } from 'vitest';
import { categoryStack } from '../src/data.js';
import { drawStacks, type StackStyle } from '../src/bars.js';
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
