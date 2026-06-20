import { describe, expect, it } from 'vitest';
import { barSpanPx } from '../src/range.js';

/** 1px per ms, so pixel math reads off the ms values directly. */
const identity = (v: number) => v;

describe('barSpanPx', () => {
  it('spans [begin, end] with no gap', () => {
    expect(barSpanPx(10, 30, identity)).toEqual([10, 30]);
  });

  it('insets by gapPx/2 each side', () => {
    expect(barSpanPx(10, 30, identity, 4)).toEqual([12, 28]);
  });

  it('normalizes an inverted scale (begin maps right of end)', () => {
    const reversed = (v: number) => 100 - v;
    expect(barSpanPx(10, 30, reversed)).toEqual([70, 90]);
  });

  it('collapses a sub-min span to a centred minimal mark (never inverts)', () => {
    // raw span 2px, gap 4 → inset would invert; centre a 1px mark instead.
    const [x0, x1] = barSpanPx(10, 12, identity, 4, 1);
    expect(x1).toBeGreaterThan(x0);
    expect((x0 + x1) / 2).toBeCloseTo(11);
    expect(x1 - x0).toBeCloseTo(1);
  });
});
