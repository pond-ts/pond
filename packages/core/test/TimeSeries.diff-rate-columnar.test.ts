import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';
import {
  ColumnarStore,
  Float64Column,
  concatSorted,
  float64ColumnFromArray,
  timeKeyColumnFromArray,
} from '../src/columnar/index.js';
import { diffRateOp } from '../src/batch/operators/diff-rate.js';

/* -------------------------------------------------------------------------- */
/* Step 4 — column-native diff / rate / pctChange guarantees.                  */
/*                                                                             */
/* diffRateOp folds successive differences straight off the store's columns    */
/* (withColumnReplaced + withRowRange for drop:true) instead of materializing  */
/* this.events. The row-level behavior (single/multi diff+rate+pctChange,      */
/* drop:true, empty, single-event, zero-gap, groupBy) is already pinned by     */
/* diff-rate.test.ts + pctChange.test.ts (31 tests, unchanged, all pass        */
/* against this impl). This file pins only what the column-native path makes   */
/* load-bearing or newly reachable:                                            */
/*  - a mid-series gap breaks the diff on BOTH the gap row and the row after   */
/*    it (its predecessor is missing) — and the output validity reflects that. */
/*  - the output store feeds the columnar reduce fast path + rematerializes.   */
/*  - drop:true slices the right row across key + every column (withRowRange). */
/*  - DIRECT operator tests for inputs the public method can't produce:        */
/*    chunked-storage stores (concat is events-based → packed) and a stored    */
/*    NaN. The operator reads via col.read(i) specifically to be storage-      */
/*    agnostic; nothing else exercises that.                                   */
/* -------------------------------------------------------------------------- */

const gappySchema = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number', required: false },
  { name: 'host', kind: 'string' },
] as const;

describe('column-native diff/rate (through the method)', () => {
  it('a gap breaks the diff on the gap row and the row after it', () => {
    const s = new TimeSeries({
      name: 'gappy',
      schema: gappySchema,
      rows: [
        [1000, 10, 'a'],
        [2000, undefined, 'a'], // gap
        [3000, 30, 'a'],
        [4000, 40, 'a'],
      ] as any,
    });
    const d = s.diff('value');
    expect(d.at(0)!.get('value')).toBeUndefined(); // no predecessor
    expect(d.at(1)!.get('value')).toBeUndefined(); // curr missing
    expect(d.at(2)!.get('value')).toBeUndefined(); // prev (row 1) missing
    expect(d.at(3)!.get('value')).toBe(10); // 40 - 30
    // validity is reflected at the column reader too.
    expect(d.column('value').read(3)).toBe(10);
    expect(d.column('value').read(1)).toBeUndefined();
  });

  it('produces a store the columnar reduce fast path can read', () => {
    const s = new TimeSeries({
      name: 'reduce-consumer',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'value', kind: 'number' },
      ] as const,
      rows: [
        [1000, 10],
        [2000, 30],
        [3000, 60],
        [4000, 100],
      ],
    });
    const d = s.diff('value'); // [undefined, 20, 30, 40]
    expect(d.reduce('value', 'sum')).toBe(90); // undefined skipped
    expect(d.column('value').sum()).toBe(90);
    expect(d.reduce('value', 'max')).toBe(40);
  });

  it('rematerializes events from the column-native store', () => {
    const s = new TimeSeries({
      name: 'events-out',
      schema: gappySchema,
      rows: [
        [1000, 10, 'a'],
        [2000, 30, 'b'],
        [4000, 60, 'c'],
      ] as any,
    });
    const d = s.diff('value');
    const events = d.events;
    expect(events.map((e) => e.get('value'))).toEqual([undefined, 20, 30]);
    expect(events.map((e) => e.get('host'))).toEqual(['a', 'b', 'c']);
    expect(d.events).toBe(events); // identity-stable
  });

  it('drop:true slices the right row across key + every column (2 → 1)', () => {
    const s = new TimeSeries({
      name: 'drop2to1',
      schema: gappySchema,
      rows: [
        [1000, 10, 'a'],
        [2000, 30, 'b'],
      ] as any,
    });
    const d = s.diff('value', { drop: true });
    expect(d.length).toBe(1);
    expect(d.at(0)!.get('value')).toBe(20); // 30 - 10
    expect(d.at(0)!.get('host')).toBe('b'); // row 1's other columns
    expect(Array.from(d.keyColumn().begin)).toEqual([2000]); // row 1's key
  });
});

/* -------------------------------------------------------------------------- */
/* Direct operator — inputs the public method can't produce.                   */
/* -------------------------------------------------------------------------- */

const numStore = (times: number[], values: Array<number | undefined>) =>
  ColumnarStore.fromTrustedStore(
    [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    timeKeyColumnFromArray(times),
    new Map([['v', float64ColumnFromArray(values)]]),
  );

describe('diffRateOp on inputs the method cannot produce', () => {
  it('folds correctly over a chunked-storage store', () => {
    // concatSorted of two disjoint stores yields zero-copy CHUNKED columns —
    // a shape the public method never builds (concat is events-based → packed).
    // The operator reads via col.read(i), so it must work regardless.
    const chunked = concatSorted([
      numStore([1000, 2000], [10, 30]),
      numStore([3000, 4000], [60, 100]),
    ]);
    expect(chunked.columns.get('v')!.storage).toBe('chunked'); // guard: really chunked

    const { store } = diffRateOp(chunked, chunked.schema, 'diff', ['v'], false);
    expect(store.length).toBe(4);
    expect(store.valueAt(0, 'v')).toBeUndefined();
    expect(store.valueAt(1, 'v')).toBe(20);
    expect(store.valueAt(2, 'v')).toBe(30);
    expect(store.valueAt(3, 'v')).toBe(40);
  });

  it('drop:true row-slices a chunked store correctly', () => {
    const chunked = concatSorted([
      numStore([1000, 2000], [10, 30]),
      numStore([3000, 4000], [60, 100]),
    ]);
    const { store } = diffRateOp(chunked, chunked.schema, 'diff', ['v'], true);
    expect(store.length).toBe(3); // first row dropped
    expect(store.beginAt(0)).toBe(2000);
    expect(store.valueAt(0, 'v')).toBe(20);
    expect(store.valueAt(2, 'v')).toBe(40);
  });

  it('treats a stored NaN as a defined value that participates', () => {
    // A defined NaN can't arrive through batch intake (validate.ts rejects it),
    // only mid-pipeline. Built directly here: typeof NaN === 'number', so the
    // diff applies it rather than treating it as a gap.
    const withNaN = numStore([1000, 2000, 3000], [10, NaN, 30]);
    expect(withNaN.columns.get('v')!.read(1)).toBeNaN(); // defined NaN

    const { store } = diffRateOp(withNaN, withNaN.schema, 'diff', ['v'], false);
    expect(store.valueAt(0, 'v')).toBeUndefined(); // no predecessor
    expect(store.valueAt(1, 'v')).toBeNaN(); // NaN - 10 = NaN (applied)
    expect(store.valueAt(2, 'v')).toBeNaN(); // 30 - NaN = NaN (applied)
  });
});
