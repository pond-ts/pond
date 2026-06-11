import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';
import {
  ColumnarStore,
  concatSorted,
  float64ColumnFromArray,
  timeKeyColumnFromArray,
} from '../src/columnar/index.js';
import { collapseOp } from '../src/batch/operators/collapse.js';

/* -------------------------------------------------------------------------- */
/* Step 4 — column-native collapse() guarantees.                               */
/*                                                                             */
/* collapse now runs the reducer over the keyed columns read straight off the  */
/* store (no per-row Event; kept columns + key pass through by reference; the   */
/* output column is appended). The existing collapse tests in TimeSeries.test  */
/* pin the basic row behavior. This file pins the column-native specifics:     */
/* append drop/keep, output-kind inference (number/boolean/string), missing    */
/* keyed cells reaching the reducer as undefined, collapse-all, passthrough,    */
/* reduce round-trip, and — via a direct collapseOp call — chunked input.       */
/* -------------------------------------------------------------------------- */

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'in', kind: 'number' },
  { name: 'out', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

function make() {
  return new TimeSeries({
    name: 's',
    schema,
    rows: [
      [0, 10, 20, 'a'],
      [1000, 30, 50, 'b'],
    ],
  });
}

describe('column-native collapse()', () => {
  it('append:false drops the keyed columns, keeps the rest, appends output', () => {
    const c = make().collapse(
      ['in', 'out'],
      'total',
      ({ in: i, out }) => i + out,
    );
    expect(c.schema.map((col) => col.name)).toEqual(['time', 'host', 'total']);
    expect(c.at(0)!.get('total')).toBe(30);
    expect(c.at(1)!.get('total')).toBe(80);
    expect(c.at(0)!.get('host')).toBe('a'); // non-keyed kept
  });

  it('append:true keeps every value column and appends output', () => {
    const c = make().collapse(
      ['in', 'out'],
      'total',
      ({ in: i, out }) => i + out,
      { append: true },
    );
    expect(c.schema.map((col) => col.name)).toEqual([
      'time',
      'in',
      'out',
      'host',
      'total',
    ]);
    expect(c.at(0)!.get('in')).toBe(10); // keyed col still present
    expect(c.at(0)!.get('total')).toBe(30);
  });

  it('infers the output column kind from the first result', () => {
    const numC = make().collapse(
      ['in', 'out'],
      'r',
      ({ in: i, out }) => i + out,
    );
    expect(numC.schema.find((c) => c.name === 'r')!.kind).toBe('number');

    const boolC = make().collapse(
      ['in', 'out'],
      'r',
      ({ in: i, out }) => i < out,
    );
    expect(boolC.schema.find((c) => c.name === 'r')!.kind).toBe('boolean');
    expect(boolC.at(0)!.get('r')).toBe(true);

    const strC = make().collapse(
      ['in', 'out'],
      'r',
      ({ in: i, out }) => `${i}/${out}`,
    );
    expect(strC.schema.find((c) => c.name === 'r')!.kind).toBe('string');
    expect(strC.at(1)!.get('r')).toBe('30/50');
  });

  it('passes a missing keyed cell to the reducer as undefined', () => {
    const s = new TimeSeries({
      name: 'gappy',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'in', kind: 'number', required: false },
        { name: 'out', kind: 'number' },
      ] as const,
      rows: [
        [0, 10, 20],
        [1000, undefined, 50], // in is missing
      ] as any,
    });
    const c = s.collapse(['in', 'out'], 'r', ({ in: i, out }) =>
      i === undefined ? -1 : i + out,
    );
    expect(c.at(0)!.get('r')).toBe(30);
    expect(c.at(1)!.get('r')).toBe(-1); // reducer saw in === undefined
  });

  it('collapses every value column → key + output only', () => {
    const s = new TimeSeries({
      name: 'all',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'in', kind: 'number' },
        { name: 'out', kind: 'number' },
      ] as const,
      rows: [
        [0, 10, 20],
        [1000, 30, 50],
      ],
    });
    const c = s.collapse(['in', 'out'], 'total', ({ in: i, out }) => i + out);
    expect(c.schema.map((col) => col.name)).toEqual(['time', 'total']);
    expect(Array.from(c.keyColumn().begin)).toEqual([0, 1000]);
    expect(c.at(1)!.get('total')).toBe(80);
  });

  it('produces a store the columnar reduce fast path can read', () => {
    const c = make().collapse(
      ['in', 'out'],
      'total',
      ({ in: i, out }) => i + out,
    );
    expect(c.reduce('total', 'sum')).toBe(110); // 30 + 80
    expect(c.column('total').sum()).toBe(110);
  });

  it('leaves the source series untouched', () => {
    const s = make();
    s.collapse(['in', 'out'], 'total', ({ in: i, out }) => i + out);
    expect(s.schema.map((col) => col.name)).toEqual([
      'time',
      'in',
      'out',
      'host',
    ]);
    expect(s.at(0)!.get('in')).toBe(10);
  });
});

/* -------------------------------------------------------------------------- */
/* Direct operator — chunked input.                                            */
/* -------------------------------------------------------------------------- */

describe('collapseOp on a chunked-storage store', () => {
  it('reduces keyed columns across chunked storage', () => {
    const twoCol = (times: number[], ins: number[], outs: number[]) =>
      ColumnarStore.fromTrustedStore(
        [
          { name: 'time', kind: 'time' },
          { name: 'in', kind: 'number' },
          { name: 'out', kind: 'number' },
        ] as const,
        timeKeyColumnFromArray(times),
        new Map([
          ['in', float64ColumnFromArray(ins)],
          ['out', float64ColumnFromArray(outs)],
        ]),
      );
    const chunked = concatSorted([
      twoCol([0, 1000], [10, 30], [20, 50]),
      twoCol([2000, 3000], [1, 2], [3, 4]),
    ]);
    expect(chunked.columns.get('in')!.storage).toBe('chunked'); // guard

    const { store, schema } = collapseOp(
      chunked,
      chunked.schema,
      ['in', 'out'],
      'total',
      (v) => (v.in as number) + (v.out as number),
      false,
    );
    expect(schema.map((c) => c.name)).toEqual(['time', 'total']);
    expect(store.valueAt(0, 'total')).toBe(30);
    expect(store.valueAt(3, 'total')).toBe(6); // 2 + 4, across the chunk boundary
  });
});
