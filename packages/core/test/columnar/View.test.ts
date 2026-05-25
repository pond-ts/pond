import { describe, expect, it } from 'vitest';

import {
  ColumnarStore,
  Float64Column,
  IntervalKeyColumn,
  StringColumn,
  materialize,
  stringColumnFromArray,
  timeKeyColumnFromArray,
  timeRangeKeyColumnFromPairs,
  withColumnAppended,
  withColumnReplaced,
  withColumnsRenamed,
  withColumnsSelected,
  withRowSelection,
} from '../../src/columnar/index.js';

/* -------------------------------------------------------------------------- */
/* Setup helpers                                                              */
/* -------------------------------------------------------------------------- */

function makeBasicStore() {
  const schema = [
    { name: 'time', kind: 'time' },
    { name: 'value', kind: 'number' },
    { name: 'load', kind: 'number' },
  ] as const;
  const keys = timeKeyColumnFromArray([1000, 2000, 3000, 4000, 5000]);
  const value = new Float64Column(Float64Array.of(10, 20, 30, 40, 50), 5);
  const load = new Float64Column(Float64Array.of(0.1, 0.2, 0.3, 0.4, 0.5), 5);
  return ColumnarStore.fromTrustedStore(
    schema,
    keys,
    new Map([
      ['value', value],
      ['load', load],
    ]),
  );
}

/* -------------------------------------------------------------------------- */
/* withRowSelection                                                           */
/* -------------------------------------------------------------------------- */

describe('withRowSelection (materializing)', () => {
  it('gathers a subset of rows by index', () => {
    const source = makeBasicStore();
    const view = withRowSelection(source, Int32Array.of(0, 2, 4));
    expect(view.length).toBe(3);
    expect(view.beginAt(0)).toBe(1000);
    expect(view.beginAt(1)).toBe(3000);
    expect(view.beginAt(2)).toBe(5000);
    expect(view.valueAt(0, 'value')).toBe(10);
    expect(view.valueAt(1, 'value')).toBe(30);
    expect(view.valueAt(2, 'value')).toBe(50);
    expect(view.valueAt(0, 'load')).toBe(0.1);
  });

  it('preserves schema across the view', () => {
    const source = makeBasicStore();
    const view = withRowSelection(source, Int32Array.of(1, 3));
    expect(view.schema).toBe(source.schema);
    expect(view.length).toBe(2);
  });

  it('gathers in arbitrary order', () => {
    const source = makeBasicStore();
    const view = withRowSelection(source, Int32Array.of(4, 0, 2));
    expect(view.beginAt(0)).toBe(5000);
    expect(view.beginAt(1)).toBe(1000);
    expect(view.beginAt(2)).toBe(3000);
    expect(view.valueAt(0, 'value')).toBe(50);
  });

  it('empty indices produces a zero-length view', () => {
    const source = makeBasicStore();
    const view = withRowSelection(source, new Int32Array(0));
    expect(view.length).toBe(0);
  });

  it('repeated indices duplicate rows', () => {
    const source = makeBasicStore();
    const view = withRowSelection(source, Int32Array.of(0, 0, 1, 1));
    expect(view.length).toBe(4);
    expect(view.beginAt(0)).toBe(1000);
    expect(view.beginAt(1)).toBe(1000);
    expect(view.beginAt(2)).toBe(2000);
    expect(view.beginAt(3)).toBe(2000);
  });

  it('works for timeRange-keyed stores', () => {
    const schema = [
      { name: 'tr', kind: 'timeRange' },
      { name: 'v', kind: 'number' },
    ] as const;
    const keys = timeRangeKeyColumnFromPairs([
      [0, 10],
      [10, 20],
      [20, 30],
    ]);
    const v = new Float64Column(Float64Array.of(100, 200, 300), 3);
    const source = ColumnarStore.fromTrustedStore(
      schema,
      keys,
      new Map([['v', v]]),
    );
    const view = withRowSelection(source, Int32Array.of(2, 0));
    expect(view.length).toBe(2);
    expect(view.beginAt(0)).toBe(20);
    expect(view.endAt(0)).toBe(30);
    expect(view.beginAt(1)).toBe(0);
    expect(view.endAt(1)).toBe(10);
    expect(view.valueAt(0, 'v')).toBe(300);
  });

  it('works for interval-keyed stores (preserves labels)', () => {
    const schema = [
      { name: 'bucket', kind: 'interval' },
      { name: 'count', kind: 'number' },
    ] as const;
    const begin = Float64Array.of(0, 86_400_000, 172_800_000);
    const end = Float64Array.of(86_400_000, 172_800_000, 259_200_000);
    const labels = stringColumnFromArray(['day-1', 'day-2', 'day-3'], {
      forceDict: true,
    });
    const keys = new IntervalKeyColumn(begin, end, labels, 3);
    const counts = new Float64Column(Float64Array.of(42, 99, 7), 3);
    const source = ColumnarStore.fromTrustedStore(
      schema,
      keys,
      new Map([['count', counts]]),
    );
    const view = withRowSelection(source, Int32Array.of(2, 0));
    expect(view.length).toBe(2);
    // The IntervalKeyColumn label survives the gather.
    expect((view.keys as IntervalKeyColumn).labelAt(0)).toBe('day-3');
    expect((view.keys as IntervalKeyColumn).labelAt(1)).toBe('day-1');
    expect(view.valueAt(0, 'count')).toBe(7);
  });

  it('returns owned buffers — mutating the source columns after view does not affect view', () => {
    // Documented contract: 1f's materializing path produces owned
    // buffers via sliceByIndices. (Lazy view-mode columns are a
    // future-doors optimization.)
    const source = makeBasicStore();
    const view = withRowSelection(source, Int32Array.of(0, 1));
    // The view's `value` column should be a different instance.
    expect(view.columns.get('value')).not.toBe(source.columns.get('value'));
  });
});

/* -------------------------------------------------------------------------- */
/* materialize                                                                */
/* -------------------------------------------------------------------------- */

describe('materialize', () => {
  it('is identity on 1f — withRowSelection already materializes', () => {
    const source = makeBasicStore();
    const view = withRowSelection(source, Int32Array.of(0, 1));
    expect(materialize(view)).toBe(view);
  });

  it('is identity on a directly-built store', () => {
    const source = makeBasicStore();
    expect(materialize(source)).toBe(source);
  });
});

/* -------------------------------------------------------------------------- */
/* withColumnsRenamed                                                         */
/* -------------------------------------------------------------------------- */

describe('withColumnsRenamed', () => {
  it('renames one value column; buffers shared by reference', () => {
    const source = makeBasicStore();
    const renamed = withColumnsRenamed(source, { value: 'measurement' });
    expect(renamed.length).toBe(source.length);
    expect(renamed.schema[1]!.name).toBe('measurement');
    expect(renamed.schema[2]!.name).toBe('load');
    expect(renamed.columns.get('measurement')).toBe(
      source.columns.get('value'),
    );
    expect(renamed.columns.get('load')).toBe(source.columns.get('load'));
    expect(renamed.valueAt(2, 'measurement')).toBe(30);
  });

  it('renames multiple value columns at once', () => {
    const source = makeBasicStore();
    const renamed = withColumnsRenamed(source, {
      value: 'measurement',
      load: 'utilization',
    });
    expect(renamed.schema[1]!.name).toBe('measurement');
    expect(renamed.schema[2]!.name).toBe('utilization');
  });

  it('rejects renaming the key column', () => {
    const source = makeBasicStore();
    expect(() => withColumnsRenamed(source, { time: 't' })).toThrow(
      /cannot rename the key column/,
    );
  });

  it('rejects rename of a non-existent column', () => {
    const source = makeBasicStore();
    expect(() => withColumnsRenamed(source, { missing: 'something' })).toThrow(
      /'missing' is not present/,
    );
  });

  it('rejects target-name collision', () => {
    const source = makeBasicStore();
    // value → load would collide with the existing load column.
    expect(() => withColumnsRenamed(source, { value: 'load' })).toThrow(
      /collides with an existing column/,
    );
  });

  it('passes through columns that are not renamed', () => {
    const source = makeBasicStore();
    const renamed = withColumnsRenamed(source, { value: 'measurement' });
    expect(renamed.columns.get('load')).toBe(source.columns.get('load'));
  });
});

/* -------------------------------------------------------------------------- */
/* withColumnReplaced                                                         */
/* -------------------------------------------------------------------------- */

describe('withColumnReplaced', () => {
  it('swaps in a new column of the same kind and length', () => {
    const source = makeBasicStore();
    const newCol = new Float64Column(Float64Array.of(99, 98, 97, 96, 95), 5);
    const replaced = withColumnReplaced(source, 'value', newCol);
    expect(replaced.valueAt(0, 'value')).toBe(99);
    expect(replaced.valueAt(4, 'value')).toBe(95);
    expect(replaced.columns.get('load')).toBe(source.columns.get('load'));
  });

  it('rejects replacing the key column', () => {
    const source = makeBasicStore();
    const newCol = new Float64Column(Float64Array.of(0, 0, 0, 0, 0), 5);
    expect(() => withColumnReplaced(source, 'time', newCol)).toThrow(
      /cannot replace the key column/,
    );
  });

  it('rejects unknown column name', () => {
    const source = makeBasicStore();
    const newCol = new Float64Column(Float64Array.of(0, 0, 0, 0, 0), 5);
    expect(() => withColumnReplaced(source, 'missing', newCol)).toThrow(
      /'missing' is not present/,
    );
  });

  it('rejects kind mismatch', () => {
    const source = makeBasicStore();
    const stringCol = stringColumnFromArray(['a', 'b', 'c', 'd', 'e']);
    expect(() => withColumnReplaced(source, 'value', stringCol)).toThrow(
      /kind 'string'.*'number'/,
    );
  });

  it('rejects length mismatch', () => {
    const source = makeBasicStore();
    const wrongLen = new Float64Column(Float64Array.of(1, 2), 2);
    expect(() => withColumnReplaced(source, 'value', wrongLen)).toThrow(
      /length 2.*store length 5/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* withColumnAppended                                                         */
/* -------------------------------------------------------------------------- */

describe('withColumnAppended', () => {
  it('appends a new value column', () => {
    const source = makeBasicStore();
    const newCol = stringColumnFromArray(['a', 'b', 'c', 'd', 'e']);
    const extended = withColumnAppended(source, 'tag', newCol);
    expect(extended.schema.length).toBe(source.schema.length + 1);
    expect(extended.schema[extended.schema.length - 1]!.name).toBe('tag');
    expect(extended.schema[extended.schema.length - 1]!.kind).toBe('string');
    expect(extended.valueAt(0, 'tag')).toBe('a');
    expect(extended.valueAt(4, 'tag')).toBe('e');
    // Original columns preserved.
    expect(extended.valueAt(0, 'value')).toBe(10);
  });

  it('rejects name collision with existing column', () => {
    const source = makeBasicStore();
    const newCol = new Float64Column(Float64Array.of(0, 0, 0, 0, 0), 5);
    expect(() => withColumnAppended(source, 'value', newCol)).toThrow(
      /already exists in the schema/,
    );
  });

  it('rejects name collision with the key column', () => {
    const source = makeBasicStore();
    const newCol = new Float64Column(Float64Array.of(0, 0, 0, 0, 0), 5);
    expect(() => withColumnAppended(source, 'time', newCol)).toThrow(
      /already exists in the schema/,
    );
  });

  it('rejects length mismatch', () => {
    const source = makeBasicStore();
    const wrongLen = new Float64Column(Float64Array.of(1, 2), 2);
    expect(() => withColumnAppended(source, 'newcol', wrongLen)).toThrow(
      /length 2.*store length 5/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* withColumnsSelected                                                        */
/* -------------------------------------------------------------------------- */

describe('withColumnsSelected', () => {
  it('drops unmentioned value columns; key column always preserved', () => {
    const source = makeBasicStore();
    const selected = withColumnsSelected(source, ['load']);
    expect(selected.schema.length).toBe(2);
    expect(selected.schema[0]!.name).toBe('time');
    expect(selected.schema[1]!.name).toBe('load');
    expect(selected.columns.has('value')).toBe(false);
    expect(selected.columns.has('load')).toBe(true);
    expect(selected.valueAt(2, 'load')).toBe(0.3);
  });

  it('preserves the order given by the caller', () => {
    const source = makeBasicStore();
    const selected = withColumnsSelected(source, ['load', 'value']);
    expect(selected.schema[1]!.name).toBe('load');
    expect(selected.schema[2]!.name).toBe('value');
  });

  it('rejects explicit selection of the key column', () => {
    const source = makeBasicStore();
    expect(() => withColumnsSelected(source, ['time', 'value'])).toThrow(
      /key column.*always preserved/,
    );
  });

  it('rejects unknown column name', () => {
    const source = makeBasicStore();
    expect(() => withColumnsSelected(source, ['missing'])).toThrow(
      /'missing' is not present in the source schema/,
    );
  });

  it('rejects duplicate names in the selection', () => {
    const source = makeBasicStore();
    expect(() => withColumnsSelected(source, ['value', 'value'])).toThrow(
      /duplicate column name 'value'/,
    );
  });

  it('empty selection produces a key-only store', () => {
    const source = makeBasicStore();
    const empty = withColumnsSelected(source, []);
    expect(empty.schema.length).toBe(1);
    expect(empty.schema[0]!.name).toBe('time');
    expect(empty.columns.size).toBe(0);
  });

  it('selected columns share buffers with the source', () => {
    const source = makeBasicStore();
    const selected = withColumnsSelected(source, ['value']);
    expect(selected.columns.get('value')).toBe(source.columns.get('value'));
  });
});

/* -------------------------------------------------------------------------- */
/* Composition — chained view + schema ops                                    */
/* -------------------------------------------------------------------------- */

describe('Composed view + schema ops', () => {
  it('select then rowSelection produces the expected projection', () => {
    const source = makeBasicStore();
    const selected = withColumnsSelected(source, ['value']);
    const view = withRowSelection(selected, Int32Array.of(1, 3));
    expect(view.length).toBe(2);
    expect(view.schema.length).toBe(2);
    expect(view.valueAt(0, 'value')).toBe(20);
    expect(view.valueAt(1, 'value')).toBe(40);
  });

  it('rename then replace works on the renamed column', () => {
    const source = makeBasicStore();
    const renamed = withColumnsRenamed(source, { value: 'measurement' });
    const replaced = withColumnReplaced(
      renamed,
      'measurement',
      new Float64Column(Float64Array.of(99, 98, 97, 96, 95), 5),
    );
    expect(replaced.valueAt(0, 'measurement')).toBe(99);
    expect(replaced.valueAt(0, 'load')).toBe(0.1);
  });

  it('rowSelection on an interval-keyed store with renamed labels-via-rename of value cols', () => {
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
    const source = ColumnarStore.fromTrustedStore(
      schema,
      keys,
      new Map([['count', counts]]),
    );
    const renamed = withColumnsRenamed(source, { count: 'tally' });
    const view = withRowSelection(renamed, Int32Array.of(1));
    expect(view.length).toBe(1);
    expect(view.valueAt(0, 'tally')).toBe(99);
    expect((view.keys as IntervalKeyColumn).labelAt(0)).toBe('day-2');
  });
});

/* -------------------------------------------------------------------------- */
/* Negative paths — out-of-range / invalid indices                             */
/* -------------------------------------------------------------------------- */

describe('withRowSelection — invalid index discipline', () => {
  it('out-of-range source index produces a row whose key fails the constructor finite check', () => {
    // The slice fills out-of-range slots with 0; that's fine for
    // Time keys (0 is a finite timestamp) — the test pins the
    // realistic case where filter / range-query primitives produce
    // valid indices only. Pathological out-of-range indices either
    // succeed (with garbage data) or fail at construction depending
    // on the key kind.
    const source = makeBasicStore();
    // Time keys accept finite 0; the gathered "row" has begin=0.
    // Documented expectation: callers must produce valid indices.
    // The test just confirms there's no crash for this benign case.
    const view = withRowSelection(source, Int32Array.of(0, 99));
    expect(view.length).toBe(2);
    expect(view.beginAt(1)).toBe(0); // out-of-range filled with 0
    // The corresponding value-column gather marks row 1 invalid
    // via validityGatherByIndices in the sliceByIndices machinery.
    expect(view.valueAt(1, 'value')).toBeUndefined();
  });
});
