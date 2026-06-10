import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';
import {
  ColumnarStore,
  concatSorted,
  float64ColumnFromArray,
  timeKeyColumnFromArray,
} from '../src/columnar/index.js';
import { fillOp } from '../src/batch/operators/fill.js';

/* -------------------------------------------------------------------------- */
/* Step 4 — column-native fill() guarantees.                                   */
/*                                                                             */
/* fillOp walks each column's gaps straight off the store and rebuilds only    */
/* the columns that change (withColumnReplaced), preserving each column's      */
/* KIND. The row-level behavior across all strategies (hold/bfill/zero/linear/ */
/* literal, limit, maxGap, edges) is already pinned by fill.test.ts (47 tests, */
/* unchanged, all pass against this impl). This file pins what the column-     */
/* native path makes load-bearing or newly reachable:                          */
/*  - the multi-KIND rebuild — boolean / array columns (the old suite only     */
/*    exercises number + string), via buildFilledColumn's kind dispatch.       */
/*  - the kind-mismatched-literal throw (documented but previously untested):  */
/*    column-native must reproduce the old intake error.                       */
/*  - DIRECT fillOp tests for what the method can't show: the only-rebuild-    */
/*    changed zero-copy passthrough, and chunked-storage input.                */
/* -------------------------------------------------------------------------- */

describe('column-native fill() — multi-kind rebuild', () => {
  it('hold-fills a boolean column (boolean builder branch)', () => {
    const s = new TimeSeries({
      name: 'bool',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'flag', kind: 'boolean', required: false },
      ] as const,
      rows: [
        [0, true],
        [1000, undefined],
        [2000, false],
        [3000, undefined],
      ] as any,
    });
    const f = s.fill({ flag: 'hold' });
    expect(f.at(0)!.get('flag')).toBe(true);
    expect(f.at(1)!.get('flag')).toBe(true); // held
    expect(f.at(2)!.get('flag')).toBe(false);
    expect(f.at(3)!.get('flag')).toBe(false); // held
  });

  it('bfill-fills an array column (array builder branch)', () => {
    const s = new TimeSeries({
      name: 'arr',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'tags', kind: 'array', required: false },
      ] as const,
      rows: [
        [0, undefined],
        [1000, [3, 4]],
      ] as any,
    });
    const f = s.fill({ tags: 'bfill' });
    expect(f.at(0)!.get('tags')).toEqual([3, 4]); // back-filled
    expect(f.at(1)!.get('tags')).toEqual([3, 4]);
  });

  it('fills with a kind-matched string literal', () => {
    const s = new TimeSeries({
      name: 'lit',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'host', kind: 'string', required: false },
      ] as const,
      rows: [
        [0, 'a'],
        [1000, undefined],
        [2000, 'c'],
      ] as any,
    });
    // 'unknown' is not a strategy keyword → literal value.
    const f = s.fill({ host: 'unknown' });
    expect(f.at(1)!.get('host')).toBe('unknown');
  });

  it('throws when a literal does not match the column kind', () => {
    // 'banana' (non-keyword string) → literal on a numeric column. The old
    // path surfaced this as a SeriesStore intake error; column-native throws
    // with a clearer column-named message when the literal would be placed.
    const s = new TimeSeries({
      name: 'mismatch',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'value', kind: 'number', required: false },
      ] as const,
      rows: [
        [0, 10],
        [1000, undefined], // a gap, so the literal is actually placed
        [2000, 30],
      ] as any,
    });
    expect(() => (s as any).fill({ value: 'banana' })).toThrow(
      /does not match its kind 'number'/,
    );
  });

  it('does NOT throw on a kind-mismatched literal when there is no gap to fill', () => {
    // Gap-dependent, matching the old path: no placement → no error.
    const s = new TimeSeries({
      name: 'no-gap',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'value', kind: 'number' },
      ] as const,
      rows: [
        [0, 10],
        [1000, 20],
      ],
    });
    expect(() => (s as any).fill({ value: 'banana' })).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Direct operator — passthrough optimization + inputs the method can't show.  */
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

describe('fillOp passthrough + chunked input', () => {
  it('leaves an unchanged column as the same instance (no rebuild)', () => {
    const store = numStore([0, 1000, 2000], [10, 20, 30]); // no gaps
    const { store: out } = fillOp(
      store,
      store.schema,
      new Map([['v', { mode: 'hold' }]]),
      undefined,
      undefined,
    );
    // Nothing changed → the column passes through by reference, not rebuilt.
    expect(out.columns.get('v')).toBe(store.columns.get('v'));
  });

  it('hold-fills across a chunked column (storage-agnostic)', () => {
    // concatSorted → CHUNKED; the gap spans the chunk boundary (idx 1 and 2).
    const chunked = concatSorted([
      numStore([0, 1000], [10, undefined]),
      numStore([2000, 3000], [undefined, 40]),
    ]);
    expect(chunked.columns.get('v')!.storage).toBe('chunked'); // guard

    const { store } = fillOp(
      chunked,
      chunked.schema,
      new Map([['v', { mode: 'hold' }]]),
      undefined,
      undefined,
    );
    expect(store.valueAt(0, 'v')).toBe(10);
    expect(store.valueAt(1, 'v')).toBe(10); // held across the chunk boundary
    expect(store.valueAt(2, 'v')).toBe(10);
    expect(store.valueAt(3, 'v')).toBe(40);
  });
});
