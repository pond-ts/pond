import { describe, expect, it } from 'vitest';
import { dropFront, removeFront } from '../src/live/array-front.js';

describe('removeFront / dropFront', () => {
  for (const [size, n] of [
    [10, 0],
    [10, 1],
    [10, 2],
    [10, 3],
    [10, 9],
    [10, 10],
    [100, 5],
    // Past the in-place shift limit: one item shifts, more splice.
    [40_000, 1],
    [40_000, 3],
    [40_000, 9_000],
  ] as const) {
    it(`removes ${n} of ${size} (both paths agree with splice)`, () => {
      const items = Array.from({ length: size }, (_, i) => i);
      const spliced = items.slice();
      const expected = spliced.splice(0, n);
      const a = items.slice();
      expect(removeFront(a, n)).toEqual(expected);
      expect(a).toEqual(spliced);
      const b = items.slice();
      dropFront(b, n);
      expect(b).toEqual(spliced);
    });
  }
  it('a negative count removes nothing', () => {
    const items = [1, 2];
    expect(removeFront(items, -1)).toEqual([]);
    dropFront(items, -1);
    expect(items).toEqual([1, 2]);
  });
});
