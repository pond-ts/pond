import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';
import {
  ColumnarStore,
  concatSorted,
  float64ColumnFromArray,
  timeKeyColumnFromArray,
} from '../src/columnar/index.js';
import { shiftOp } from '../src/batch/operators/shift.js';

/* -------------------------------------------------------------------------- */
/* Step 4 — column-native shift() guarantees.                                  */
/*                                                                             */
/* shift now builds each target's shifted array straight off the store         */
/* (out[i] = col.read(i-n), else undefined-pad) instead of materializing       */
/* this.events. Row-level behavior is pinned by shift.test.ts (11 tests,       */
/* unchanged, all pass). This file pins the column-native edges: the           */
/* undefined-pad validity origin, full-pad when |n| ≥ length, non-target/key   */
/* passthrough, the output feeding the reduce fast path, and — via a direct    */
/* shiftOp call — chunked-storage input.                                       */
/* -------------------------------------------------------------------------- */

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

function make() {
  return new TimeSeries({
    name: 's',
    schema,
    rows: [
      [0, 10, 'a'],
      [1000, 20, 'b'],
      [2000, 30, 'c'],
      [3000, 40, 'd'],
    ],
  });
}

describe('column-native shift()', () => {
  it('positive n lags: leading rows pad to undefined', () => {
    const r = make().shift('v', 1); // v: [undef, 10, 20, 30]
    expect(r.at(0)!.get('v')).toBeUndefined();
    expect(r.at(1)!.get('v')).toBe(10);
    expect(r.at(3)!.get('v')).toBe(30);
    expect(r.column('v').read(0)).toBeUndefined(); // validity at the column reader
  });

  it('negative n leads: trailing rows pad to undefined', () => {
    const r = make().shift('v', -1); // v: [20, 30, 40, undef]
    expect(r.at(0)!.get('v')).toBe(20);
    expect(r.at(2)!.get('v')).toBe(40);
    expect(r.at(3)!.get('v')).toBeUndefined();
  });

  it('pads the whole column when |n| >= length', () => {
    const r = make().shift('v', 10);
    expect(r.length).toBe(4);
    for (let i = 0; i < 4; i += 1) expect(r.at(i)!.get('v')).toBeUndefined();
  });

  it('n === 0 is identity for the values', () => {
    const r = make().shift('v', 0);
    expect(r.at(0)!.get('v')).toBe(10);
    expect(r.at(3)!.get('v')).toBe(40);
  });

  it('leaves non-target columns + key untouched', () => {
    const r = make().shift('v', 1);
    expect(r.at(0)!.get('host')).toBe('a'); // host unshifted
    expect(r.at(3)!.get('host')).toBe('d');
    expect(Array.from(r.keyColumn().begin)).toEqual([0, 1000, 2000, 3000]);
  });

  it('produces a store the columnar reduce fast path can read', () => {
    const r = make().shift('v', 1); // [undef, 10, 20, 30]
    expect(r.reduce('v', 'sum')).toBe(60); // undefined skipped
    expect(r.column('v').sum()).toBe(60);
  });

  it('leaves the source series untouched', () => {
    const s = make();
    s.shift('v', 2);
    expect(s.at(0)!.get('v')).toBe(10);
  });
});

/* -------------------------------------------------------------------------- */
/* Direct operator — chunked input (unreachable through the method).           */
/* -------------------------------------------------------------------------- */

describe('shiftOp on a chunked-storage store', () => {
  it('shifts across a chunked column', () => {
    const numStore = (times: number[], values: number[]) =>
      ColumnarStore.fromTrustedStore(
        [
          { name: 'time', kind: 'time' },
          { name: 'v', kind: 'number' },
        ] as const,
        timeKeyColumnFromArray(times),
        new Map([['v', float64ColumnFromArray(values)]]),
      );
    const chunked = concatSorted([
      numStore([0, 1000], [10, 20]),
      numStore([2000, 3000], [30, 40]),
    ]);
    expect(chunked.columns.get('v')!.storage).toBe('chunked'); // guard

    const { store } = shiftOp(chunked, chunked.schema, ['v'], 1);
    expect(store.valueAt(0, 'v')).toBeUndefined(); // leading pad
    expect(store.valueAt(1, 'v')).toBe(10);
    expect(store.valueAt(2, 'v')).toBe(20); // crosses the chunk boundary
    expect(store.valueAt(3, 'v')).toBe(30);
  });
});
