import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';
import {
  ColumnarStore,
  concatSorted,
  float64ColumnFromArray,
  timeKeyColumnFromArray,
} from '../src/columnar/index.js';
import { mapOp } from '../src/batch/operators/map.js';

/* -------------------------------------------------------------------------- */
/* mapColumns — per-cell column value transform (column-native).               */
/*                                                                             */
/* The column-scoped counterpart of the event-based map(): mapColumns applies  */
/* (value) => newValue per column, same kind in/out, reading the columns       */
/* directly (no per-row Event). These tests pin the value transform across     */
/* kinds, missing-cell carry, schema stability, and — via a direct mapOp call  */
/* — chunked-storage input + the stored-NaN case the public method can't make. */
/* -------------------------------------------------------------------------- */

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number', required: false },
  { name: 'host', kind: 'string' },
  { name: 'on', kind: 'boolean' },
] as const;

function make() {
  return new TimeSeries({
    name: 's',
    schema,
    rows: [
      [0, 10, 'a', true],
      [1000, undefined, 'b', false], // gap in v
      [2000, 30, 'c', true],
    ] as any,
  });
}

describe('TimeSeries.mapColumns', () => {
  it('transforms a numeric column per cell', () => {
    const r = make().mapColumns({ v: (x) => x * 2 });
    expect(r.at(0)!.get('v')).toBe(20);
    expect(r.at(2)!.get('v')).toBe(60);
  });

  it('carries missing cells (mapper not called on undefined)', () => {
    let calls = 0;
    const r = make().mapColumns({
      v: (x) => {
        calls += 1;
        return x + 1;
      },
    });
    expect(r.at(0)!.get('v')).toBe(11);
    expect(r.at(1)!.get('v')).toBeUndefined(); // gap carried, untouched
    expect(r.at(2)!.get('v')).toBe(31);
    expect(calls).toBe(2); // only the two defined cells
  });

  it('maps multiple columns in one pass', () => {
    const r = make().mapColumns({ v: (x) => x + 100, on: (b) => !b });
    expect(r.at(0)!.get('v')).toBe(110);
    expect(r.at(0)!.get('on')).toBe(false);
    expect(r.at(2)!.get('on')).toBe(false);
  });

  it('maps a string column (same-kind, all kinds)', () => {
    const r = make().mapColumns({ host: (s) => s.toUpperCase() });
    expect(r.at(0)!.get('host')).toBe('A');
    expect(r.at(2)!.get('host')).toBe('C');
  });

  it('maps an array column (array builder branch)', () => {
    const s = new TimeSeries({
      name: 'arr',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'tags', kind: 'array' },
      ] as const,
      rows: [
        [0, [1, 2]],
        [1000, [3]],
      ] as any,
    });
    const r = s.mapColumns({ tags: (xs) => [...(xs as number[]), 9] });
    expect(r.at(0)!.get('tags')).toEqual([1, 2, 9]);
    expect(r.at(1)!.get('tags')).toEqual([3, 9]);
  });

  it('leaves non-mapped columns and the key untouched', () => {
    const r = make().mapColumns({ v: (x) => x * 2 });
    expect(r.at(0)!.get('host')).toBe('a'); // untouched
    expect(Array.from(r.keyColumn().begin)).toEqual([0, 1000, 2000]);
    // schema unchanged (same kinds, same names)
    expect(r.schema.map((c) => c.name)).toEqual(['time', 'v', 'host', 'on']);
  });

  it('produces a store the columnar reduce fast path can read', () => {
    const r = make().mapColumns({ v: (x) => x * 2 }); // 20, (gap), 60
    expect(r.reduce('v', 'sum')).toBe(80);
    expect(r.column('v').sum()).toBe(80);
  });

  it('leaves the source series untouched', () => {
    const s = make();
    s.mapColumns({ v: (x) => x * 999 });
    expect(s.at(0)!.get('v')).toBe(10);
  });

  it('throws on an empty mapping', () => {
    expect(() => (make() as any).mapColumns({})).toThrow(
      /requires at least one column/,
    );
  });

  // Audit v2 §1.3: a mapper that writes NaN into a packed numeric column made
  // aggregate(min) return 3 via the fast path but 1 via the row path on the
  // same bucket. Rejecting NaN at write closes the divergence at the source.
  it('rejects a mapper that produces NaN (no packed-NaN reducer divergence)', () => {
    const s = new TimeSeries({
      name: 'd',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows: [
        [0, 1],
        [1000, 2],
        [2000, 3],
      ] as any,
    });
    expect(() => s.mapColumns({ v: (x) => (x === 2 ? NaN : x) })).toThrow(
      /non-finite/,
    );
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

describe('mapOp on inputs the method cannot produce', () => {
  it('maps a chunked-storage column (storage-agnostic)', () => {
    const chunked = concatSorted([
      numStore([0, 1000], [10, 20]),
      numStore([2000, 3000], [30, 40]),
    ]);
    expect(chunked.columns.get('v')!.storage).toBe('chunked'); // guard

    const { store } = mapOp(
      chunked,
      chunked.schema,
      new Map([['v', (x: unknown) => (x as number) * 10]]),
    );
    expect(store.length).toBe(4);
    expect(store.valueAt(0, 'v')).toBe(100);
    expect(store.valueAt(3, 'v')).toBe(400);
  });

  it('invokes the mapper on a stored NaN (defined value) — and can clean it to a finite value', () => {
    const withNaN = numStore([0, 1000, 2000], [10, NaN, 30]);
    let sawNaN = false;
    const { store } = mapOp(
      withNaN,
      withNaN.schema,
      new Map([
        [
          'v',
          (x: unknown) => {
            if (Number.isNaN(x)) {
              sawNaN = true;
              return 0; // clean the NaN to a finite value
            }
            return (x as number) + 1;
          },
        ],
      ]),
    );
    expect(sawNaN).toBe(true); // NaN is a defined value → mapper invoked
    expect(store.valueAt(0, 'v')).toBe(11);
    expect(store.valueAt(1, 'v')).toBe(0); // cleaned
    expect(store.valueAt(2, 'v')).toBe(31);
  });

  it('rejects a non-finite numeric mapper result (NaN / ±Infinity) at write', () => {
    // Passing a stored NaN straight through would poison the packed column.
    const withNaN = numStore([0, 1000, 2000], [10, NaN, 30]);
    expect(() =>
      mapOp(
        withNaN,
        withNaN.schema,
        new Map([['v', (x: unknown) => x as number]]),
      ),
    ).toThrow(/non-finite/);

    // A finite source whose mapper produces non-finite output also throws.
    const finite = numStore([0, 1000], [1, 2]);
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(() =>
        mapOp(finite, finite.schema, new Map([['v', () => bad]])),
      ).toThrow(/non-finite/);
    }

    // A finite mapper on the same source is unaffected (no false positive).
    const { store } = mapOp(
      finite,
      finite.schema,
      new Map([['v', (x: unknown) => (x as number) * 10]]),
    );
    expect(store.valueAt(0, 'v')).toBe(10);
    expect(store.valueAt(1, 'v')).toBe(20);
  });
});
