import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';

/* -------------------------------------------------------------------------- */
/* Step 4 — column-native slice().                                             */
/*                                                                             */
/* slice() now reshapes the store's row range via withRowRange instead of      */
/* materializing this.events. The public contract is Array.prototype.slice     */
/* (negative indices from the end, ToInteger truncation, out-of-range clamp),  */
/* which withRowRange does NOT implement — slice() normalizes to an absolute   */
/* [start, end) first. These tests pin that normalization (the risk surface)   */
/* plus the store-reshape fidelity (values, key, validity, non-numeric cols).  */
/* -------------------------------------------------------------------------- */

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number', required: false },
  { name: 'host', kind: 'string' },
] as const;

function make() {
  return new TimeSeries({
    name: 's',
    schema,
    rows: [
      [0, 10, 'a'],
      [1000, undefined, 'b'], // gap in v
      [2000, 30, 'c'],
      [3000, 40, 'd'],
      [4000, 50, 'e'],
    ] as any,
  });
}

describe('column-native slice()', () => {
  it('takes a positional half-open range', () => {
    const r = make().slice(1, 4);
    expect(r.length).toBe(3);
    expect(Array.from(r.keyColumn().begin)).toEqual([1000, 2000, 3000]);
    expect(r.at(0)!.get('host')).toBe('b');
    expect(r.at(2)!.get('v')).toBe(40);
  });

  it('preserves validity through the slice', () => {
    const r = make().slice(0, 3); // rows 0..2 incl. the row-1 gap
    expect(r.at(0)!.get('v')).toBe(10);
    expect(r.at(1)!.get('v')).toBeUndefined(); // gap survives
    expect(r.at(2)!.get('v')).toBe(30);
  });

  it('defaults: no args is a full copy, begin-only runs to the end', () => {
    expect(make().slice().length).toBe(5);
    expect(make().slice(2).length).toBe(3);
    expect(make().slice(2).at(0)!.get('v')).toBe(30);
  });

  it('negative begin counts from the end', () => {
    const r = make().slice(-2); // last two
    expect(r.length).toBe(2);
    expect(Array.from(r.keyColumn().begin)).toEqual([3000, 4000]);
  });

  it('negative end counts from the end', () => {
    const r = make().slice(1, -1); // [1, 4)
    expect(r.length).toBe(3);
    expect(Array.from(r.keyColumn().begin)).toEqual([1000, 2000, 3000]);
  });

  it('both-negative range', () => {
    const r = make().slice(-3, -1); // indices 2,3
    expect(Array.from(r.keyColumn().begin)).toEqual([2000, 3000]);
  });

  it('truncates non-integer indices toward zero (ToInteger)', () => {
    const r = make().slice(1.9, 4.9); // → [1, 4)
    expect(r.length).toBe(3);
    expect(Array.from(r.keyColumn().begin)).toEqual([1000, 2000, 3000]);
  });

  it('clamps and empties out-of-range / inverted ranges', () => {
    expect(make().slice(0, 100).length).toBe(5); // end clamps to length
    expect(make().slice(10).length).toBe(0); // begin past end → empty
    expect(make().slice(3, 1).length).toBe(0); // begin > end → empty
    expect(make().slice(-100).length).toBe(5); // begin clamps to 0
  });

  it('matches Array.prototype.slice across a sweep of index pairs', () => {
    const s = make();
    const keys = [0, 1000, 2000, 3000, 4000];
    const pairs: Array<[number | undefined, number | undefined]> = [
      [undefined, undefined],
      [1, 3],
      [-2, undefined],
      [1, -1],
      [-3, -1],
      [0, 100],
      [10, undefined],
      [3, 1],
      [-100, 2],
    ];
    for (const [b, e] of pairs) {
      const got = Array.from(s.slice(b, e).keyColumn().begin);
      const want = keys.slice(b, e);
      expect(got).toEqual(want);
    }
  });

  it('the sliced store feeds the columnar reduce fast path', () => {
    // 10 + (gap) + 30 + 40 + 50 → slice(2) → 30+40+50 = 120
    expect(make().slice(2).reduce('v', 'sum')).toBe(120);
  });

  it('leaves the parent untouched', () => {
    const s = make();
    s.slice(1, 2);
    expect(s.length).toBe(5);
  });
});
