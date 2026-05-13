import { describe, expect, it } from 'vitest';

import {
  ColumnarStore,
  Float64Column,
  IntervalKeyColumn,
  stringColumnFromArray,
  timeKeyColumnFromArray,
  timeRangeKeyColumnFromPairs,
} from '../../src/columnar/index.js';

/**
 * Tests for the framework-layer `ColumnarStore<S>` — pure indexed
 * columnar substrate. No `Event` / `EventKey` materialization;
 * those concerns live in the row-API adapter at
 * `src/series-store.ts` (`SeriesStore<S>`) and are tested there.
 *
 * The five public-API invariants from the RFC (events identity,
 * at(i) reference stability, etc.) are pinned in
 * `test/series-store.test.ts`, not here.
 */

/* -------------------------------------------------------------------------- */
/* Construction & schema validation                                           */
/* -------------------------------------------------------------------------- */

function makeBasicStore() {
  const schema = [
    { name: 'time', kind: 'time' },
    { name: 'value', kind: 'number' },
    { name: 'load', kind: 'number' },
  ] as const;
  const keys = timeKeyColumnFromArray([1000, 2000, 3000]);
  const value = new Float64Column(Float64Array.of(10, 20, 30), 3);
  const load = new Float64Column(Float64Array.of(0.5, 0.75, 0.9), 3);
  const columns = new Map([
    ['value', value],
    ['load', load],
  ]);
  return {
    schema,
    keys,
    columns,
    store: ColumnarStore.fromTrustedStore(schema, keys, columns),
  };
}

describe('ColumnarStore.fromTrustedStore', () => {
  it('builds a typed store from schema + keys + columns map', () => {
    const { store } = makeBasicStore();
    expect(store.length).toBe(3);
    expect(store.schema[0]!.name).toBe('time');
    expect(store.columns.size).toBe(2);
  });

  it('rejects column-length mismatch', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;
    const keys = timeKeyColumnFromArray([1, 2, 3]);
    const wrong = new Float64Column(Float64Array.of(10, 20), 2);
    expect(() =>
      ColumnarStore.fromTrustedStore(schema, keys, new Map([['value', wrong]])),
    ).toThrow(/length 2 does not match keys.length 3/);
  });

  it('rejects missing schema-declared column', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;
    const keys = timeKeyColumnFromArray([1, 2]);
    expect(() =>
      ColumnarStore.fromTrustedStore(schema, keys, new Map()),
    ).toThrow(/'value' is not present/);
  });

  it('rejects column kind mismatch', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'string' },
    ] as const;
    const keys = timeKeyColumnFromArray([1, 2]);
    const numCol = new Float64Column(Float64Array.of(1, 2), 2);
    expect(() =>
      ColumnarStore.fromTrustedStore(
        schema,
        keys,
        new Map([['value', numCol]]),
      ),
    ).toThrow(/kind is 'number' but schema declares 'string'/);
  });

  it('rejects key-column kind mismatch with schema[0]', () => {
    const schema = [
      { name: 'tr', kind: 'timeRange' },
      { name: 'v', kind: 'number' },
    ] as const;
    const keys = timeKeyColumnFromArray([1, 2]);
    const v = new Float64Column(Float64Array.of(10, 20), 2);
    expect(() =>
      ColumnarStore.fromTrustedStore(schema, keys, new Map([['v', v]])),
    ).toThrow(
      /key column kind 'time' does not match schema\[0\].kind 'timeRange'/,
    );
  });

  it('rejects duplicate schema column names', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'dup', kind: 'number' },
      { name: 'dup', kind: 'string' },
    ] as const;
    const keys = timeKeyColumnFromArray([1, 2]);
    const value = new Float64Column(Float64Array.of(1, 2), 2);
    expect(() =>
      ColumnarStore.fromTrustedStore(schema, keys, new Map([['dup', value]])),
    ).toThrow(/duplicate schema column name 'dup'/);
  });

  it('rejects extra columns not in the schema', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;
    const keys = timeKeyColumnFromArray([1, 2]);
    const value = new Float64Column(Float64Array.of(1, 2), 2);
    const extra = new Float64Column(Float64Array.of(0, 0), 2);
    const columns = new Map([
      ['value', value],
      ['rogue', extra],
    ]);
    expect(() => ColumnarStore.fromTrustedStore(schema, keys, columns)).toThrow(
      /'rogue' which is not declared in the schema/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Defensive ownership                                                        */
/* -------------------------------------------------------------------------- */

describe('Defensive ownership of columns map', () => {
  it('mutating the source columns map after construction does not affect the store', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;
    const keys = timeKeyColumnFromArray([1, 2, 3]);
    const value = new Float64Column(Float64Array.of(10, 20, 30), 3);
    const sourceMap = new Map([['value', value]]);
    const store = ColumnarStore.fromTrustedStore(schema, keys, sourceMap);

    sourceMap.delete('value');
    sourceMap.set('rogue', new Float64Column(Float64Array.of(0, 0, 0), 3));

    expect(store.valueAt(1, 'value')).toBe(20);
    expect(store.columns.has('value')).toBe(true);
    expect(store.columns.has('rogue')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Direct accessors                                                           */
/* -------------------------------------------------------------------------- */

describe('Direct accessors', () => {
  it('beginAt / endAt delegate to the key column', () => {
    const { store } = makeBasicStore();
    expect(store.beginAt(1)).toBe(2000);
    expect(store.endAt(1)).toBe(2000); // time keys: end === begin
  });

  it('valueAt reads through the named column', () => {
    const { store } = makeBasicStore();
    expect(store.valueAt(0, 'value')).toBe(10);
    expect(store.valueAt(2, 'load')).toBe(0.9);
  });

  it('valueAt throws on unknown column name', () => {
    const { store } = makeBasicStore();
    expect(() => store.valueAt(0, 'missing')).toThrow(/'missing' not present/);
  });

  it('valueAt throws on out-of-range rowIndex', () => {
    const { store } = makeBasicStore();
    expect(() => store.valueAt(-1, 'value')).toThrow(/out of range/);
    expect(() => store.valueAt(99, 'value')).toThrow(/out of range/);
  });

  it('valueAt returns undefined for invalid cells within range', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'string' },
    ] as const;
    const keys = timeKeyColumnFromArray([1, 2, 3]);
    const value = stringColumnFromArray(['a', undefined, 'b']);
    const store = ColumnarStore.fromTrustedStore(
      schema,
      keys,
      new Map([['value', value]]),
    );
    expect(store.valueAt(1, 'value')).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Edge cases                                                                  */
/* -------------------------------------------------------------------------- */

describe('Edge cases', () => {
  it('zero-length store: length is 0, valueAt throws', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;
    const keys = timeKeyColumnFromArray([]);
    const value = new Float64Column(new Float64Array(0), 0);
    const store = ColumnarStore.fromTrustedStore(
      schema,
      keys,
      new Map([['value', value]]),
    );
    expect(store.length).toBe(0);
    expect(() => store.valueAt(0, 'value')).toThrow(/out of range/);
  });

  it('key-only schema: store works with empty columns map', () => {
    const schema = [{ name: 'time', kind: 'time' }] as const;
    const keys = timeKeyColumnFromArray([1, 2, 3]);
    const store = ColumnarStore.fromTrustedStore(schema, keys, new Map());
    expect(store.length).toBe(3);
    expect(store.beginAt(1)).toBe(2);
  });

  it('interval-keyed store with full schema', () => {
    const schema = [
      { name: 'bucket', kind: 'interval' },
      { name: 'count', kind: 'number' },
    ] as const;
    const begin = Float64Array.of(0, 86_400_000);
    const end = Float64Array.of(86_400_000, 172_800_000);
    const labels = stringColumnFromArray(['day-1', 'day-2'], {
      forceDict: true,
    });
    const keys = new IntervalKeyColumn(begin, end, labels, 2);
    const counts = new Float64Column(Float64Array.of(42, 99), 2);
    const store = ColumnarStore.fromTrustedStore(
      schema,
      keys,
      new Map([['count', counts]]),
    );
    expect(store.length).toBe(2);
    expect(store.valueAt(1, 'count')).toBe(99);
    expect(store.beginAt(0)).toBe(0);
    expect(store.endAt(0)).toBe(86_400_000);
  });

  it('timeRange-keyed store', () => {
    const schema = [
      { name: 'tr', kind: 'timeRange' },
      { name: 'v', kind: 'number' },
    ] as const;
    const keys = timeRangeKeyColumnFromPairs([
      [0, 10],
      [10, 20],
    ]);
    const v = new Float64Column(Float64Array.of(100, 200), 2);
    const store = ColumnarStore.fromTrustedStore(
      schema,
      keys,
      new Map([['v', v]]),
    );
    expect(store.beginAt(1)).toBe(10);
    expect(store.endAt(1)).toBe(20);
  });
});
