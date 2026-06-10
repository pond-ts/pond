import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';

/* -------------------------------------------------------------------------- */
/* Step 4 — column-native cumulative() guarantees.                             */
/*                                                                             */
/* cumulative() now folds the running accumulator straight off the store's    */
/* columns (cumulativeOp + withColumnReplaced + #fromTrustedStore) instead of  */
/* materializing this.events into per-row Events. The behavioral parity cases  */
/* (sum/max/min/count/custom, mid-series gaps, multi-column, groupBy, empty,   */
/* single) are already pinned by TimeSeries.cumulative.test.ts and pass        */
/* unchanged against this impl. This file pins only the edges the column-      */
/* native path introduces or makes newly load-bearing:                         */
/*                                                                             */
/*  - validity ORIGIN: a leading gap ⇒ output undefined until the first        */
/*    defined value (float64ColumnFromArray derives the bit from the undefined */
/*    accumulator). The old test only covered a defined first value.           */
/*  - per-column validity independence across multiple targets.               */
/*  - the output store is well-formed for the columnar consumers — the reduce  */
/*    fast path reads it, and .events rematerializes from it.                  */
/*  - a stored NaN is a DEFINED number (typeof raw === 'number'): it survives  */
/*    as a defined cell and a downstream op applies it rather than carrying.   */
/* -------------------------------------------------------------------------- */

const optSchema = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number', required: false },
  { name: 'label', kind: 'string' },
] as const;

describe('column-native cumulative()', () => {
  it('emits undefined until the first defined value (leading gap)', () => {
    const s = new TimeSeries({
      name: 'lead-gap',
      schema: optSchema,
      rows: [
        [0, undefined, 'a'],
        [1000, undefined, 'b'],
        [2000, 10, 'c'],
        [3000, 20, 'd'],
      ] as any,
    });
    const c = s.cumulative({ value: 'sum' });
    expect(c.at(0)!.get('value')).toBeUndefined();
    expect(c.at(1)!.get('value')).toBeUndefined();
    expect(c.at(2)!.get('value')).toBe(10);
    expect(c.at(3)!.get('value')).toBe(30);
    // the gap cells read undefined through the column reader too, not just
    // through the point accessor — confirms the output validity bitmap.
    const col = c.column('value');
    expect(col.read(0)).toBeUndefined();
    expect(col.read(2)).toBe(10);
  });

  it('derives validity per target independently', () => {
    const s = new TimeSeries({
      name: 'multi-validity',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'a', kind: 'number', required: false },
        { name: 'b', kind: 'number' },
      ] as const,
      rows: [
        [0, undefined, 100], // a gap, b dense
        [1000, 5, 200],
        [2000, 7, 300],
      ] as any,
    });
    const c = s.cumulative({ a: 'sum', b: 'sum' });
    // a: undefined until row 1, then 5, 12
    expect(c.at(0)!.get('a')).toBeUndefined();
    expect(c.at(1)!.get('a')).toBe(5);
    expect(c.at(2)!.get('a')).toBe(12);
    // b: dense from row 0 — its validity is unaffected by a's gap
    expect(c.at(0)!.get('b')).toBe(100);
    expect(c.at(2)!.get('b')).toBe(600);
  });

  it('produces a store the columnar reduce fast path can read', () => {
    const s = new TimeSeries({
      name: 'reduce-consumer',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'value', kind: 'number' },
      ] as const,
      rows: [
        [0, 1],
        [1000, 2],
        [2000, 3],
      ],
    });
    const c = s.cumulative({ value: 'sum' }); // values: 1, 3, 6
    expect(c.reduce('value', 'sum')).toBe(10);
    expect(c.reduce('value', 'max')).toBe(6);
    expect(c.column('value').sum()).toBe(10);
  });

  it('rematerializes events from the column-native store', () => {
    const s = new TimeSeries({
      name: 'events-out',
      schema: optSchema,
      rows: [
        [0, 10, 'a'],
        [1000, 20, 'b'],
        [2000, 30, 'c'],
      ] as any,
    });
    const c = s.cumulative({ value: 'sum' });
    const events = c.events;
    expect(events.map((e) => e.get('value'))).toEqual([10, 30, 60]);
    // the non-target string column survives the column-native rebuild
    expect(events.map((e) => e.get('label'))).toEqual(['a', 'b', 'c']);
    expect(c.events).toBe(events); // identity-stable
  });

  it('treats a stored NaN as a defined value a downstream op applies', () => {
    const s = new TimeSeries({
      name: 'nan-chain',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'value', kind: 'number' },
      ] as const,
      rows: [
        [0, 10],
        [1000, 20],
        [2000, 30],
      ],
    });
    // A custom fold injects NaN after the first value: [10, NaN, NaN].
    const withNaN = s.cumulative({ value: () => NaN });
    expect(withNaN.at(0)!.get('value')).toBe(10);
    expect(withNaN.at(1)!.get('value')).toBeNaN();
    // The NaN cell is DEFINED, not missing — reads NaN, not undefined.
    expect(withNaN.column('value').read(1)).toBeNaN();

    // A downstream cumulative reads that NaN; typeof NaN === 'number', so it
    // is APPLIED (not carried as a gap): sum from row 1 onward stays NaN.
    const chained = withNaN.cumulative({ value: 'sum' });
    expect(chained.at(0)!.get('value')).toBe(10);
    expect(chained.at(1)!.get('value')).toBeNaN();
    expect(chained.at(2)!.get('value')).toBeNaN();
  });

  it('leaves the source series untouched', () => {
    const s = new TimeSeries({
      name: 'src',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'value', kind: 'number' },
      ] as const,
      rows: [
        [0, 10],
        [1000, 20],
      ],
    });
    const c = s.cumulative({ value: 'sum' });
    // source unchanged
    expect(s.at(0)!.get('value')).toBe(10);
    expect(s.at(1)!.get('value')).toBe(20);
    // derived has the running sum
    expect(c.at(1)!.get('value')).toBe(30);
  });
});
