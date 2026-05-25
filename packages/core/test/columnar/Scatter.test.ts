import { describe, expect, it } from 'vitest';

import {
  ColumnarStore,
  Float64Column,
  TimeKeyColumn,
  arrayColumnFromArray,
  booleanColumnFromArray,
  float64ColumnFromArray,
  scatterByPartition,
  stringColumnFromArray,
  timeKeyColumnFromArray,
} from '../../src/columnar/index.js';

/* -------------------------------------------------------------------------- */
/* Setup                                                                       */
/* -------------------------------------------------------------------------- */

const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'host', kind: 'string' },
  { name: 'value', kind: 'number' },
  { name: 'flag', kind: 'boolean' },
] as const;

function makeStore(
  begin: ReadonlyArray<number>,
  hosts: ReadonlyArray<string | null | undefined>,
  values: ReadonlyArray<number | null | undefined>,
  flags: ReadonlyArray<boolean | null | undefined>,
) {
  return ColumnarStore.fromTrustedStore(
    SCHEMA,
    timeKeyColumnFromArray(begin),
    new Map([
      ['host', stringColumnFromArray(hosts)],
      ['value', float64ColumnFromArray(values)],
      ['flag', booleanColumnFromArray(flags)],
    ]),
  );
}

/* -------------------------------------------------------------------------- */
/* scatterByPartition                                                          */
/* -------------------------------------------------------------------------- */

describe('scatterByPartition (string partition column)', () => {
  it('buckets rows by unique partition value', () => {
    const source = makeStore(
      [1000, 2000, 3000, 4000, 5000],
      ['us-east', 'us-west', 'us-east', 'us-east', 'us-west'],
      [10, 20, 30, 40, 50],
      [true, false, true, false, true],
    );
    const buckets = scatterByPartition(source, 'host');
    expect(buckets.size).toBe(2);
    const east = buckets.get('us-east')!;
    expect(east.length).toBe(3);
    expect(Array.from((east.keys as TimeKeyColumn).begin)).toEqual([
      1000, 3000, 4000,
    ]);
    expect(east.valueAt(0, 'value')).toBe(10);
    expect(east.valueAt(2, 'value')).toBe(40);
    const west = buckets.get('us-west')!;
    expect(west.length).toBe(2);
    expect(Array.from((west.keys as TimeKeyColumn).begin)).toEqual([
      2000, 5000,
    ]);
    expect(west.valueAt(1, 'value')).toBe(50);
  });

  it('preserves schema in each output sub-store', () => {
    const source = makeStore([1000, 2000], ['a', 'b'], [10, 20], [true, false]);
    const buckets = scatterByPartition(source, 'host');
    for (const sub of buckets.values()) {
      expect(sub.schema).toBe(source.schema);
    }
  });

  it('throws on undefined partition values by default (loud failure)', () => {
    const source = makeStore(
      [1000, 2000, 3000, 4000],
      ['a', null, 'a', undefined],
      [10, 20, 30, 40],
      [true, false, true, false],
    );
    expect(() => scatterByPartition(source, 'host')).toThrow(
      /undefined value in partition column 'host'/,
    );
  });

  it('drops rows with undefined partition value when onUndefined is "drop"', () => {
    const source = makeStore(
      [1000, 2000, 3000, 4000],
      ['a', null, 'a', undefined],
      [10, 20, 30, 40],
      [true, false, true, false],
    );
    const buckets = scatterByPartition(source, 'host', { onUndefined: 'drop' });
    expect(buckets.size).toBe(1);
    const a = buckets.get('a')!;
    expect(a.length).toBe(2);
    expect(a.valueAt(0, 'value')).toBe(10);
    expect(a.valueAt(1, 'value')).toBe(30);
  });

  it('empty source produces an empty Map', () => {
    const source = makeStore([], [], [], []);
    const buckets = scatterByPartition(source, 'host');
    expect(buckets.size).toBe(0);
  });

  it('single-row source produces a single-bucket Map', () => {
    const source = makeStore([1000], ['solo'], [10], [true]);
    const buckets = scatterByPartition(source, 'host');
    expect(buckets.size).toBe(1);
    expect(buckets.get('solo')!.length).toBe(1);
  });
});

describe('scatterByPartition (numeric partition column)', () => {
  it('buckets by numeric partition value', () => {
    const source = makeStore(
      [1000, 2000, 3000, 4000],
      ['a', 'b', 'c', 'd'],
      [1, 2, 1, 2],
      [true, false, true, false],
    );
    const buckets = scatterByPartition(source, 'value');
    expect(buckets.size).toBe(2);
    const one = buckets.get(1)!;
    expect(one.length).toBe(2);
    expect(one.valueAt(0, 'host')).toBe('a');
    expect(one.valueAt(1, 'host')).toBe('c');
    const two = buckets.get(2)!;
    expect(two.length).toBe(2);
    expect(two.valueAt(0, 'host')).toBe('b');
    expect(two.valueAt(1, 'host')).toBe('d');
  });

  it('buckets defined NaN partition values under the NaN key (Map SameValueZero)', () => {
    // Build via trusted construction with a NaN cell.
    const valCol = new Float64Column(Float64Array.of(1, NaN, 1, NaN), 4);
    const source = ColumnarStore.fromTrustedStore(
      SCHEMA,
      timeKeyColumnFromArray([1, 2, 3, 4]),
      new Map([
        ['host', stringColumnFromArray(['a', 'b', 'c', 'd'])],
        ['value', valCol],
        ['flag', booleanColumnFromArray([true, false, true, false])],
      ]),
    );
    const buckets = scatterByPartition(source, 'value');
    expect(buckets.size).toBe(2);
    const one = buckets.get(1)!;
    expect(one.length).toBe(2);
    expect(one.valueAt(0, 'host')).toBe('a');
    expect(one.valueAt(1, 'host')).toBe('c');
    // NaN bucket — Map.get(NaN) works under SameValueZero.
    const nanBucket = buckets.get(NaN)!;
    expect(nanBucket.length).toBe(2);
    expect(nanBucket.valueAt(0, 'host')).toBe('b');
    expect(nanBucket.valueAt(1, 'host')).toBe('d');
    // The Map's NaN key is the actual NaN value.
    const keys = [...buckets.keys()];
    expect(keys.some((k) => typeof k === 'number' && Number.isNaN(k))).toBe(
      true,
    );
  });

  it('drops rows with undefined numeric partition values when onUndefined is "drop"', () => {
    const valCol = float64ColumnFromArray([1, null, 1, undefined]);
    const source = ColumnarStore.fromTrustedStore(
      SCHEMA,
      timeKeyColumnFromArray([1, 2, 3, 4]),
      new Map([
        ['host', stringColumnFromArray(['a', 'b', 'c', 'd'])],
        ['value', valCol],
        ['flag', booleanColumnFromArray([true, false, true, false])],
      ]),
    );
    const buckets = scatterByPartition(source, 'value', {
      onUndefined: 'drop',
    });
    expect(buckets.size).toBe(1);
    expect(buckets.get(1)!.length).toBe(2);
  });
});

describe('scatterByPartition (boolean partition column)', () => {
  it('produces at most two buckets', () => {
    const source = makeStore(
      [1, 2, 3, 4, 5],
      ['a', 'b', 'c', 'd', 'e'],
      [10, 20, 30, 40, 50],
      [true, false, true, true, false],
    );
    const buckets = scatterByPartition(source, 'flag');
    expect(buckets.size).toBe(2);
    expect(buckets.get(true)!.length).toBe(3);
    expect(buckets.get(false)!.length).toBe(2);
  });

  it('uniform partition produces one bucket', () => {
    const source = makeStore(
      [1, 2, 3],
      ['a', 'b', 'c'],
      [10, 20, 30],
      [true, true, true],
    );
    const buckets = scatterByPartition(source, 'flag');
    expect(buckets.size).toBe(1);
    expect(buckets.get(true)!.length).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

describe('scatterByPartition errors', () => {
  it('rejects the key column as partition column', () => {
    const source = makeStore([1, 2], ['a', 'b'], [10, 20], [true, false]);
    expect(() => scatterByPartition(source, 'time')).toThrow(/key column/);
  });

  it('rejects a non-existent column name', () => {
    const source = makeStore([1, 2], ['a', 'b'], [10, 20], [true, false]);
    expect(() => scatterByPartition(source, 'nope')).toThrow(/not present/);
  });

  it('rejects an invalid onUndefined option (typo guard)', () => {
    const source = makeStore([1, 2], ['a', 'b'], [10, 20], [true, false]);
    // `'drpo'` is a typical typo for `'drop'`. Without explicit
    // validation, this would silently fall through to the drop
    // branch — exactly the silent-data-loss path that the
    // 'throw' default is meant to prevent.
    expect(() =>
      scatterByPartition(source, 'host', {
        onUndefined: 'drpo' as unknown as 'throw' | 'drop',
      }),
    ).toThrow(/options.onUndefined must be 'throw' or 'drop'/);
  });

  it('rejects array-kind partition columns', () => {
    const SCHEMA_WITH_ARRAY = [
      { name: 'time', kind: 'time' },
      { name: 'tags', kind: 'array' },
    ] as const;
    const source = ColumnarStore.fromTrustedStore(
      SCHEMA_WITH_ARRAY,
      timeKeyColumnFromArray([1, 2]),
      new Map([['tags', arrayColumnFromArray([['a'], ['b']])]]),
    );
    expect(() => scatterByPartition(source, 'tags')).toThrow(/array/);
  });
});

/* -------------------------------------------------------------------------- */
/* Order preservation                                                          */
/* -------------------------------------------------------------------------- */

describe('scatter order preservation', () => {
  it("each bucket's rows preserve the input's relative order", () => {
    const source = makeStore(
      [10, 20, 30, 40, 50, 60],
      ['z', 'a', 'z', 'b', 'a', 'z'],
      [1, 2, 3, 4, 5, 6],
      [true, false, true, false, true, false],
    );
    const buckets = scatterByPartition(source, 'host');
    const z = buckets.get('z')!;
    expect(Array.from((z.keys as TimeKeyColumn).begin)).toEqual([10, 30, 60]);
    const a = buckets.get('a')!;
    expect(Array.from((a.keys as TimeKeyColumn).begin)).toEqual([20, 50]);
    const b = buckets.get('b')!;
    expect(Array.from((b.keys as TimeKeyColumn).begin)).toEqual([40]);
  });
});
