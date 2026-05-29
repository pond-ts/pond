import { describe, expect, it } from 'vitest';

import {
  ArrayColumn,
  BooleanColumn,
  ColumnarRingBuffer,
  ColumnarStore,
  Float64Column,
  IntervalKeyColumn,
  StringColumn,
  TimeKeyColumn,
  TimeRangeKeyColumn,
  arrayColumnFromArray,
  booleanColumnFromArray,
  float64ColumnFromArray,
  stringColumnFromArray,
  timeKeyColumnFromArray,
  timeRangeKeyColumnFromPairs,
} from '../../src/columnar/index.js';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const TIME_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
  { name: 'flag', kind: 'boolean' },
] as const;

function makeTimeBatch(
  beginMs: ReadonlyArray<number>,
  values: ReadonlyArray<number>,
  flags: ReadonlyArray<boolean>,
) {
  return ColumnarStore.fromTrustedStore(
    TIME_SCHEMA,
    timeKeyColumnFromArray(beginMs),
    new Map<string, Float64Column | BooleanColumn>([
      ['value', float64ColumnFromArray(values)],
      ['flag', booleanColumnFromArray(flags)],
    ]),
  );
}

/* -------------------------------------------------------------------------- */
/* Construction                                                                */
/* -------------------------------------------------------------------------- */

describe('ColumnarRingBuffer construction', () => {
  it('initial length 0, capacity = min(retention, 64) by default', () => {
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 100 });
    expect(ring.length).toBe(0);
    expect(ring.capacity).toBe(64);
    expect(ring.retention).toBe(100);
    expect(ring.lazyGrowth).toBe(true);
  });

  it('eager mode pre-allocates retention', () => {
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, {
      retention: 100,
      lazyGrowth: false,
    });
    expect(ring.capacity).toBe(100);
  });

  it('retention < 64 caps initial capacity at retention', () => {
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 8 });
    expect(ring.capacity).toBe(8);
  });

  it('rejects retention beyond MAX_COLUMN_LENGTH', () => {
    expect(
      () =>
        new ColumnarRingBuffer(TIME_SCHEMA, {
          retention: 2 ** 31,
        }),
    ).toThrow(RangeError);
  });

  it('rejects retention negative / non-integer', () => {
    expect(
      () => new ColumnarRingBuffer(TIME_SCHEMA, { retention: -1 }),
    ).toThrow(RangeError);
    expect(
      () => new ColumnarRingBuffer(TIME_SCHEMA, { retention: 1.5 }),
    ).toThrow(RangeError);
  });

  it('rejects empty schema', () => {
    expect(() => new ColumnarRingBuffer([], { retention: 10 })).toThrow(
      RangeError,
    );
  });

  it('rejects a schema whose first column is not a key kind', () => {
    expect(
      () =>
        new ColumnarRingBuffer(
          [
            { name: 'value', kind: 'number' },
            { name: 'flag', kind: 'boolean' },
          ] as const,
          { retention: 10 },
        ),
    ).toThrow(RangeError);
  });

  it('rejects intervalLabelKind on non-interval schemas', () => {
    expect(
      () =>
        new ColumnarRingBuffer(TIME_SCHEMA, {
          retention: 10,
          intervalLabelKind: 'string',
        }),
    ).toThrow(RangeError);
  });

  it('requires intervalLabelKind on interval schemas', () => {
    expect(
      () =>
        new ColumnarRingBuffer([{ name: 'tile', kind: 'interval' }] as const, {
          retention: 10,
        }),
    ).toThrow(RangeError);
  });

  // Regression: Codex round 4's medium finding. The constructor
  // previously cast `def.kind` to `ColumnKind` without runtime
  // validation; `initValueRing` fell through to 'array' for any
  // unknown kind, so a typo or schema-drift bug (e.g. a value
  // column declaring `kind: 'timeRange'`) survived construction
  // and only blew up at first `snapshot()` via
  // `ColumnarStore.fromTrustedStore`'s kind check. The error
  // should fire at the misconfiguration site.
  it('rejects invalid value-column kinds at construction', () => {
    expect(
      () =>
        new ColumnarRingBuffer(
          [
            { name: 'time', kind: 'time' },
            { name: 'window', kind: 'timeRange' }, // key kind in a value slot
          ] as const,
          { retention: 10 },
        ),
    ).toThrow(/is not a valid value-column kind/);
    expect(
      () =>
        new ColumnarRingBuffer(
          [
            { name: 'time', kind: 'time' },
            { name: 'x', kind: 'notakind' as 'number' },
          ] as const,
          { retention: 10 },
        ),
    ).toThrow(/is not a valid value-column kind/);
  });
});

/* -------------------------------------------------------------------------- */
/* appendBatch + snapshot — Time keys                                          */
/* -------------------------------------------------------------------------- */

describe('appendBatch + snapshot (Time keys)', () => {
  it('snapshot of an empty ring is an empty store', () => {
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 100 });
    const snap = ring.snapshot();
    expect(snap.length).toBe(0);
    expect(snap.schema).toBe(ring.schema);
    expect(snap.keys).toBeInstanceOf(TimeKeyColumn);
  });

  it('appends a single batch and snapshots in order', () => {
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 100 });
    ring.appendBatch(
      makeTimeBatch([1000, 2000, 3000], [10, 20, 30], [true, false, true]),
    );
    expect(ring.length).toBe(3);
    const snap = ring.snapshot();
    expect(snap.length).toBe(3);
    expect(snap.beginAt(0)).toBe(1000);
    expect(snap.beginAt(2)).toBe(3000);
    expect(snap.valueAt(0, 'value')).toBe(10);
    expect(snap.valueAt(2, 'value')).toBe(30);
    expect(snap.valueAt(1, 'flag')).toBe(false);
  });

  it('appends multiple batches and snapshots in arrival order', () => {
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 100 });
    ring.appendBatch(makeTimeBatch([1000, 2000], [10, 20], [true, false]));
    ring.appendBatch(makeTimeBatch([3000], [30], [true]));
    ring.appendBatch(makeTimeBatch([4000, 5000], [40, 50], [false, true]));
    expect(ring.length).toBe(5);
    const snap = ring.snapshot();
    expect(snap.length).toBe(5);
    for (let i = 0; i < 5; i += 1) {
      expect(snap.beginAt(i)).toBe((i + 1) * 1000);
      expect(snap.valueAt(i, 'value')).toBe((i + 1) * 10);
    }
  });

  it('skips empty batches without side effects', () => {
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 100 });
    ring.appendBatch(makeTimeBatch([1000], [10], [true]));
    const beforeCap = ring.capacity;
    ring.appendBatch(makeTimeBatch([], [], []));
    expect(ring.length).toBe(1);
    expect(ring.capacity).toBe(beforeCap);
  });

  it('grows capacity to hold rows beyond initial 64', () => {
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 500 });
    expect(ring.capacity).toBe(64);
    // Two batches of 50 — pushes past 64.
    const t0 = Array.from({ length: 50 }, (_, i) => 1000 + i);
    const v0 = Array.from({ length: 50 }, (_, i) => i * 10);
    const f0 = Array.from({ length: 50 }, (_, i) => i % 2 === 0);
    ring.appendBatch(makeTimeBatch(t0, v0, f0));
    expect(ring.length).toBe(50);
    expect(ring.capacity).toBe(64);
    const t1 = Array.from({ length: 50 }, (_, i) => 2000 + i);
    const v1 = Array.from({ length: 50 }, (_, i) => 500 + i * 10);
    const f1 = Array.from({ length: 50 }, () => true);
    ring.appendBatch(makeTimeBatch(t1, v1, f1));
    expect(ring.length).toBe(100);
    expect(ring.capacity).toBeGreaterThanOrEqual(100);
    expect(ring.capacity).toBeLessThanOrEqual(500);
    const snap = ring.snapshot();
    expect(snap.length).toBe(100);
    expect(snap.beginAt(0)).toBe(1000);
    expect(snap.beginAt(49)).toBe(1049);
    expect(snap.beginAt(50)).toBe(2000);
    expect(snap.beginAt(99)).toBe(2049);
  });

  it('evicts oldest rows when length reaches retention', () => {
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 5 });
    ring.appendBatch(
      makeTimeBatch(
        [1, 2, 3, 4, 5],
        [10, 20, 30, 40, 50],
        [true, false, true, false, true],
      ),
    );
    expect(ring.length).toBe(5);
    ring.appendBatch(makeTimeBatch([6, 7], [60, 70], [false, false]));
    expect(ring.length).toBe(5);
    const snap = ring.snapshot();
    // First two rows evicted; last 5 remain.
    expect(Array.from((snap.keys as TimeKeyColumn).begin)).toEqual([
      3, 4, 5, 6, 7,
    ]);
    expect(snap.valueAt(0, 'value')).toBe(30);
    expect(snap.valueAt(4, 'value')).toBe(70);
  });

  it('appending a batch larger than retention keeps only the last `retention` rows', () => {
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 3 });
    ring.appendBatch(
      makeTimeBatch(
        [1, 2, 3, 4, 5, 6, 7],
        [10, 20, 30, 40, 50, 60, 70],
        [true, false, true, false, true, false, true],
      ),
    );
    expect(ring.length).toBe(3);
    const snap = ring.snapshot();
    expect(Array.from((snap.keys as TimeKeyColumn).begin)).toEqual([5, 6, 7]);
  });

  it('multiple appends after eviction produce correct circular ordering', () => {
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 4 });
    ring.appendBatch(
      makeTimeBatch([1, 2, 3, 4], [10, 20, 30, 40], [true, true, true, true]),
    );
    ring.appendBatch(makeTimeBatch([5], [50], [false]));
    ring.appendBatch(makeTimeBatch([6, 7], [60, 70], [false, false]));
    // After: rows [4, 5, 6, 7] remain.
    const snap = ring.snapshot();
    expect(Array.from((snap.keys as TimeKeyColumn).begin)).toEqual([
      4, 5, 6, 7,
    ]);
    expect(snap.valueAt(0, 'value')).toBe(40);
    expect(snap.valueAt(3, 'value')).toBe(70);
    expect(snap.valueAt(2, 'flag')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* evictPrefix                                                                 */
/* -------------------------------------------------------------------------- */

describe('evictPrefix', () => {
  it('drops the oldest n rows', () => {
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 10 });
    ring.appendBatch(
      makeTimeBatch(
        [1, 2, 3, 4, 5],
        [10, 20, 30, 40, 50],
        [true, false, true, false, true],
      ),
    );
    ring.evictPrefix(2);
    expect(ring.length).toBe(3);
    const snap = ring.snapshot();
    expect(Array.from((snap.keys as TimeKeyColumn).begin)).toEqual([3, 4, 5]);
    expect(snap.valueAt(0, 'value')).toBe(30);
  });

  it('clears the ring when n >= length', () => {
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 10 });
    ring.appendBatch(makeTimeBatch([1, 2], [10, 20], [true, true]));
    ring.evictPrefix(100);
    expect(ring.length).toBe(0);
    const snap = ring.snapshot();
    expect(snap.length).toBe(0);
  });

  it('n === 0 is a no-op', () => {
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 10 });
    ring.appendBatch(makeTimeBatch([1, 2], [10, 20], [true, true]));
    ring.evictPrefix(0);
    expect(ring.length).toBe(2);
  });

  it('rejects negative or non-integer n', () => {
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 10 });
    expect(() => ring.evictPrefix(-1)).toThrow(RangeError);
    expect(() => ring.evictPrefix(1.5)).toThrow(RangeError);
  });

  it('post-evict appendBatch fills correctly without growth churn', () => {
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 10 });
    ring.appendBatch(
      makeTimeBatch([1, 2, 3], [10, 20, 30], [true, false, true]),
    );
    ring.evictPrefix(2);
    ring.appendBatch(makeTimeBatch([4, 5], [40, 50], [false, false]));
    const snap = ring.snapshot();
    expect(Array.from((snap.keys as TimeKeyColumn).begin)).toEqual([3, 4, 5]);
    expect(snap.valueAt(0, 'value')).toBe(30);
    expect(snap.valueAt(2, 'value')).toBe(50);
  });
});

/* -------------------------------------------------------------------------- */
/* Validity tracking through eviction                                          */
/* -------------------------------------------------------------------------- */

describe('validity tracking through eviction', () => {
  it('snapshot validity reflects undefined cells after eviction', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;
    const ring = new ColumnarRingBuffer(schema, { retention: 10 });
    // batch with some undefined cells
    const valCol = float64ColumnFromArray([10, null, 30, undefined, 50]);
    const batch = ColumnarStore.fromTrustedStore(
      schema,
      timeKeyColumnFromArray([1, 2, 3, 4, 5]),
      new Map([['value', valCol]]),
    );
    ring.appendBatch(batch);
    const snap = ring.snapshot();
    expect(snap.valueAt(0, 'value')).toBe(10);
    expect(snap.valueAt(1, 'value')).toBeUndefined();
    expect(snap.valueAt(2, 'value')).toBe(30);
    expect(snap.valueAt(3, 'value')).toBeUndefined();
    expect(snap.valueAt(4, 'value')).toBe(50);
    const v = snap.columns.get('value') as Float64Column;
    expect(v.validity).toBeDefined();
    expect(v.validity!.definedCount).toBe(3);
  });

  it('snapshot drops the bitmap when all cells are defined', () => {
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 10 });
    ring.appendBatch(
      makeTimeBatch([1, 2, 3], [10, 20, 30], [true, false, true]),
    );
    const snap = ring.snapshot();
    const v = snap.columns.get('value') as Float64Column;
    expect(v.validity).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* TimeRange and Interval keys                                                 */
/* -------------------------------------------------------------------------- */

describe('TimeRange keys', () => {
  const TR_SCHEMA = [
    { name: 'window', kind: 'timeRange' },
    { name: 'value', kind: 'number' },
  ] as const;

  it('appends and snapshots TimeRange-keyed batches', () => {
    const ring = new ColumnarRingBuffer(TR_SCHEMA, { retention: 10 });
    const batch = ColumnarStore.fromTrustedStore(
      TR_SCHEMA,
      timeRangeKeyColumnFromPairs([
        [1000, 2000],
        [2000, 3000],
        [3000, 4000],
      ]),
      new Map([['value', float64ColumnFromArray([10, 20, 30])]]),
    );
    ring.appendBatch(batch);
    const snap = ring.snapshot();
    expect(snap.keys).toBeInstanceOf(TimeRangeKeyColumn);
    expect(snap.beginAt(0)).toBe(1000);
    expect(snap.endAt(0)).toBe(2000);
    expect(snap.beginAt(2)).toBe(3000);
    expect(snap.endAt(2)).toBe(4000);
  });
});

describe('Interval keys (string labels)', () => {
  const I_SCHEMA = [
    { name: 'tile', kind: 'interval' },
    { name: 'value', kind: 'number' },
  ] as const;

  it('appends and snapshots intervals with string labels', () => {
    const ring = new ColumnarRingBuffer(I_SCHEMA, {
      retention: 10,
      intervalLabelKind: 'string',
    });
    const labels = stringColumnFromArray(['1d-1000', '1d-1001', '1d-1002']);
    const batch = ColumnarStore.fromTrustedStore(
      I_SCHEMA,
      new IntervalKeyColumn(
        Float64Array.of(1000, 2000, 3000),
        Float64Array.of(2000, 3000, 4000),
        labels,
        3,
      ),
      new Map([['value', float64ColumnFromArray([10, 20, 30])]]),
    );
    ring.appendBatch(batch);
    const snap = ring.snapshot();
    expect(snap.keys).toBeInstanceOf(IntervalKeyColumn);
    expect((snap.keys as IntervalKeyColumn).labelKind).toBe('string');
    expect((snap.keys as IntervalKeyColumn).labelAt(0)).toBe('1d-1000');
    expect((snap.keys as IntervalKeyColumn).labelAt(2)).toBe('1d-1002');
  });

  it('rejects a batch with mismatched labelKind', () => {
    const ring = new ColumnarRingBuffer(I_SCHEMA, {
      retention: 10,
      intervalLabelKind: 'string',
    });
    const numericLabels = new Float64Column(Float64Array.of(0, 1, 2), 3);
    const batch = ColumnarStore.fromTrustedStore(
      I_SCHEMA,
      new IntervalKeyColumn(
        Float64Array.of(1000, 2000, 3000),
        Float64Array.of(2000, 3000, 4000),
        numericLabels,
        3,
      ),
      new Map([['value', float64ColumnFromArray([10, 20, 30])]]),
    );
    expect(() => ring.appendBatch(batch)).toThrow(/labelKind/);
  });
});

describe('Interval keys (numeric labels)', () => {
  const I_SCHEMA = [
    { name: 'tile', kind: 'interval' },
    { name: 'value', kind: 'number' },
  ] as const;

  it('appends and snapshots intervals with numeric labels through eviction', () => {
    const ring = new ColumnarRingBuffer(I_SCHEMA, {
      retention: 3,
      intervalLabelKind: 'number',
    });
    function makeBatch(
      begins: number[],
      ends: number[],
      labels: number[],
      values: number[],
    ) {
      return ColumnarStore.fromTrustedStore(
        I_SCHEMA,
        new IntervalKeyColumn(
          Float64Array.from(begins),
          Float64Array.from(ends),
          new Float64Column(Float64Array.from(labels), labels.length),
          labels.length,
        ),
        new Map([['value', float64ColumnFromArray(values)]]),
      );
    }
    ring.appendBatch(
      makeBatch([1000, 2000], [2000, 3000], [100, 101], [10, 20]),
    );
    ring.appendBatch(
      makeBatch([3000, 4000], [4000, 5000], [102, 103], [30, 40]),
    );
    expect(ring.length).toBe(3);
    const snap = ring.snapshot();
    const keys = snap.keys as IntervalKeyColumn;
    expect(keys.labelAt(0)).toBe(101);
    expect(keys.labelAt(1)).toBe(102);
    expect(keys.labelAt(2)).toBe(103);
  });
});

/* -------------------------------------------------------------------------- */
/* String + Array value columns                                                */
/* -------------------------------------------------------------------------- */

describe('String value columns', () => {
  const SCHEMA = [
    { name: 'time', kind: 'time' },
    { name: 'host', kind: 'string' },
  ] as const;

  it('appends and snapshots string columns', () => {
    const ring = new ColumnarRingBuffer(SCHEMA, { retention: 10 });
    const batch = ColumnarStore.fromTrustedStore(
      SCHEMA,
      timeKeyColumnFromArray([1, 2, 3]),
      new Map([['host', stringColumnFromArray(['a', 'b', 'a'])]]),
    );
    ring.appendBatch(batch);
    const snap = ring.snapshot();
    expect(snap.columns.get('host')).toBeInstanceOf(StringColumn);
    expect(snap.valueAt(0, 'host')).toBe('a');
    expect(snap.valueAt(1, 'host')).toBe('b');
    expect(snap.valueAt(2, 'host')).toBe('a');
  });

  it('snapshot rebuilds dict encoding when cardinality warrants', () => {
    const ring = new ColumnarRingBuffer(SCHEMA, { retention: 100 });
    // 20 rows, 2 distinct values → dict-encoded.
    const hosts = Array.from({ length: 20 }, (_, i) =>
      i % 2 === 0 ? 'us-east' : 'us-west',
    );
    const batch = ColumnarStore.fromTrustedStore(
      SCHEMA,
      timeKeyColumnFromArray(Array.from({ length: 20 }, (_, i) => 1000 + i)),
      new Map([['host', stringColumnFromArray(hosts)]]),
    );
    ring.appendBatch(batch);
    const snap = ring.snapshot();
    const host = snap.columns.get('host') as StringColumn;
    expect(host.isDictEncoded).toBe(true);
  });
});

describe('Array value columns', () => {
  const SCHEMA = [
    { name: 'time', kind: 'time' },
    { name: 'tags', kind: 'array' },
  ] as const;

  it('appends and snapshots array columns with defensive freeze', () => {
    const ring = new ColumnarRingBuffer(SCHEMA, { retention: 10 });
    const tags = arrayColumnFromArray([['a', 'b'], ['c'], null, ['d']]);
    const batch = ColumnarStore.fromTrustedStore(
      SCHEMA,
      timeKeyColumnFromArray([1, 2, 3, 4]),
      new Map([['tags', tags]]),
    );
    ring.appendBatch(batch);
    const snap = ring.snapshot();
    expect(snap.columns.get('tags')).toBeInstanceOf(ArrayColumn);
    expect(snap.valueAt(0, 'tags')).toEqual(['a', 'b']);
    expect(snap.valueAt(1, 'tags')).toEqual(['c']);
    expect(snap.valueAt(2, 'tags')).toBeUndefined();
    expect(snap.valueAt(3, 'tags')).toEqual(['d']);
    // Defensive freeze: returned cell is frozen.
    const cell = snap.valueAt(0, 'tags') as readonly unknown[];
    expect(Object.isFrozen(cell)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Schema mismatch                                                             */
/* -------------------------------------------------------------------------- */

describe('appendBatch schema validation', () => {
  it('rejects batch with different schema length', () => {
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 10 });
    const altSchema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;
    const batch = ColumnarStore.fromTrustedStore(
      altSchema,
      timeKeyColumnFromArray([1]),
      new Map([['value', float64ColumnFromArray([10])]]),
    );
    expect(() =>
      ring.appendBatch(batch as unknown as ColumnarStore<typeof TIME_SCHEMA>),
    ).toThrow(/schema length/);
  });

  it('rejects batch with different column kind', () => {
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 10 });
    const altSchema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'string' },
      { name: 'flag', kind: 'boolean' },
    ] as const;
    const batch = ColumnarStore.fromTrustedStore(
      altSchema,
      timeKeyColumnFromArray([1]),
      new Map([
        ['value', stringColumnFromArray(['x'])],
        ['flag', booleanColumnFromArray([true])],
      ]),
    );
    expect(() =>
      ring.appendBatch(batch as unknown as ColumnarStore<typeof TIME_SCHEMA>),
    ).toThrow(/kind/);
  });
});

/* -------------------------------------------------------------------------- */
/* Snapshot decoupling                                                         */
/* -------------------------------------------------------------------------- */

describe('snapshot decoupling from the ring', () => {
  it('subsequent appends do not affect a prior snapshot', () => {
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 100 });
    ring.appendBatch(makeTimeBatch([1, 2], [10, 20], [true, false]));
    const snap = ring.snapshot();
    expect(snap.length).toBe(2);
    ring.appendBatch(makeTimeBatch([3, 4], [30, 40], [true, false]));
    // Snapshot length unchanged.
    expect(snap.length).toBe(2);
    expect(snap.valueAt(1, 'value')).toBe(20);
    expect(ring.length).toBe(4);
  });

  it('snapshots after eviction reflect the current window only', () => {
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 3 });
    ring.appendBatch(
      makeTimeBatch(
        [1, 2, 3, 4, 5],
        [10, 20, 30, 40, 50],
        [true, false, true, false, true],
      ),
    );
    expect(ring.length).toBe(3);
    const snap = ring.snapshot();
    expect(Array.from((snap.keys as TimeKeyColumn).begin)).toEqual([3, 4, 5]);
  });

  // Regression: L2 review caught the missing test for "snapshot
  // survives buffer replacement under growth." Growth allocates
  // fresh typed-array buffers and discards the old ones; if
  // snapshot were aliasing the old buffers, this test would fail
  // because the post-growth reads would return either nothing or
  // the wrong values.
  it('snapshots survive a subsequent ring growth event', () => {
    // retention 500 so growth actually fires (initial cap = 64 < 500).
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 500 });
    // 50 rows — under initial capacity 64.
    const t0 = Array.from({ length: 50 }, (_, i) => 1000 + i);
    const v0 = Array.from({ length: 50 }, (_, i) => i * 10);
    const f0 = Array.from({ length: 50 }, (_, i) => i % 2 === 0);
    ring.appendBatch(makeTimeBatch(t0, v0, f0));
    expect(ring.capacity).toBe(64);
    const snap = ring.snapshot();
    expect(snap.length).toBe(50);
    // Append enough to force growth.
    const t1 = Array.from({ length: 50 }, (_, i) => 2000 + i);
    const v1 = Array.from({ length: 50 }, (_, i) => 500 + i * 10);
    const f1 = Array.from({ length: 50 }, () => true);
    ring.appendBatch(makeTimeBatch(t1, v1, f1));
    expect(ring.capacity).toBeGreaterThan(64);
    // Snapshot is unaffected — buffers were copied at snapshot time.
    expect(snap.length).toBe(50);
    expect(snap.beginAt(0)).toBe(1000);
    expect(snap.beginAt(49)).toBe(1049);
    expect(snap.valueAt(0, 'value')).toBe(0);
    expect(snap.valueAt(49, 'value')).toBe(490);
    expect(snap.valueAt(0, 'flag')).toBe(true);
  });

  // Regression: L2 review caught the missing growth-while-
  // physically-wrapped test. Evict-then-fill leaves the logical
  // rows straddling the physical wrap point; a subsequent grow
  // must unroll the circular buffer into linear order without
  // dropping the wrapped portion or shuffling rows.
  it('grows correctly when the live window is physically wrapped', () => {
    const SCHEMA = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;
    function batch(begin: number[], values: number[]) {
      return ColumnarStore.fromTrustedStore(
        SCHEMA,
        timeKeyColumnFromArray(begin),
        new Map([['value', float64ColumnFromArray(values)]]),
      );
    }
    // retention 200 → initial lazy capacity 64.
    const ring = new ColumnarRingBuffer(SCHEMA, { retention: 200 });
    // Phase 1: fill exactly to capacity 64. No growth yet.
    const t0 = Array.from({ length: 64 }, (_, i) => 1000 + i);
    const v0 = Array.from({ length: 64 }, (_, i) => i);
    ring.appendBatch(batch(t0, v0));
    expect(ring.capacity).toBe(64);
    // Phase 2: evict 20 → head=20, length=44, free slots=20 (in the
    // 64-cap buffer).
    ring.evictPrefix(20);
    expect(ring.length).toBe(44);
    // Phase 3: append exactly the 20 free slots. New writes wrap
    // physically (positions 0..19). No growth yet — required (64)
    // equals capacity (64).
    const t1 = Array.from({ length: 20 }, (_, i) => 2000 + i);
    const v1 = Array.from({ length: 20 }, (_, i) => 1000 + i);
    ring.appendBatch(batch(t1, v1));
    expect(ring.length).toBe(64);
    expect(ring.capacity).toBe(64);
    // Phase 4: append a 50-row batch — required (114) > capacity
    // (64), so growth fires WHILE the live window is physically
    // wrapped (head=20, length=64). `#grow` must unroll the
    // circular buffer into a fresh linear buffer at the new
    // capacity, preserving logical row order.
    const t2 = Array.from({ length: 50 }, (_, i) => 3000 + i);
    const v2 = Array.from({ length: 50 }, (_, i) => 5000 + i);
    ring.appendBatch(batch(t2, v2));
    expect(ring.length).toBe(114);
    expect(ring.capacity).toBeGreaterThanOrEqual(114);
    // Snapshot — every row in logical order, regardless of the
    // pre-grow wrap.
    const snap = ring.snapshot();
    expect(snap.length).toBe(114);
    // Rows 0..43: the 44 surviving rows from phase 1 (indices
    // 20..63 of the initial 64-row batch).
    for (let i = 0; i < 44; i += 1) {
      expect(snap.beginAt(i)).toBe(1000 + 20 + i);
      expect(snap.valueAt(i, 'value')).toBe(20 + i);
    }
    // Rows 44..63: the 20 rows from phase 3.
    for (let i = 0; i < 20; i += 1) {
      expect(snap.beginAt(44 + i)).toBe(2000 + i);
      expect(snap.valueAt(44 + i, 'value')).toBe(1000 + i);
    }
    // Rows 64..113: the 50 rows from phase 4 (post-growth).
    for (let i = 0; i < 50; i += 1) {
      expect(snap.beginAt(64 + i)).toBe(3000 + i);
      expect(snap.valueAt(64 + i, 'value')).toBe(5000 + i);
    }
  });

  // Regression: addressing the L2 medium-confidence finding on the
  // string/array stale-cell desync. After a full clear (either
  // `evictPrefix(n >= length)` or a batch larger than retention),
  // any later writes whose source cell is undefined must leave the
  // ring's `values[i]` truly undefined — otherwise the snapshot
  // leaks the prior batch's strings/arrays via the string/array
  // "presence === defined" discriminator.
  it('clears string/array slot data after full clear (no stale leakage)', () => {
    const SCHEMA = [
      { name: 'time', kind: 'time' },
      { name: 'host', kind: 'string' },
      { name: 'tags', kind: 'array' },
    ] as const;
    const ring = new ColumnarRingBuffer(SCHEMA, { retention: 4 });
    // Batch 1: every cell defined.
    ring.appendBatch(
      ColumnarStore.fromTrustedStore(
        SCHEMA,
        timeKeyColumnFromArray([1, 2, 3]),
        new Map([
          ['host', stringColumnFromArray(['old1', 'old2', 'old3'])],
          ['tags', arrayColumnFromArray([['a'], ['b'], ['c']])],
        ]),
      ),
    );
    // Full clear via evictPrefix(n >= length).
    ring.evictPrefix(10);
    expect(ring.length).toBe(0);
    // Batch 2: cells are EXPLICITLY undefined. Without
    // `#clearAllSlots` wiping the prior strings/arrays, the new
    // undefined writes would leave the prior values in the
    // physical slots, and snapshot would surface them.
    ring.appendBatch(
      ColumnarStore.fromTrustedStore(
        SCHEMA,
        timeKeyColumnFromArray([10, 20]),
        new Map([
          ['host', stringColumnFromArray([null, null])],
          ['tags', arrayColumnFromArray([null, null])],
        ]),
      ),
    );
    const snap = ring.snapshot();
    expect(snap.length).toBe(2);
    expect(snap.valueAt(0, 'host')).toBeUndefined();
    expect(snap.valueAt(1, 'host')).toBeUndefined();
    expect(snap.valueAt(0, 'tags')).toBeUndefined();
    expect(snap.valueAt(1, 'tags')).toBeUndefined();
  });

  // Regression: Codex round 3's high finding. `appendBatch` must
  // grow BEFORE applying destructive ops (clear / evict) — if
  // growth threw under memory pressure with the prior order, the
  // retained rows would already be gone. We can't deterministically
  // provoke a typed-array allocation failure in JS, but we CAN
  // verify the path that requires growth (batch overflow with
  // capacity below retention) succeeds and leaves the ring in
  // the correct state. The structural ordering is then the proof
  // of atomicity.
  it('eviction-induced growth path produces correct final state (grow-before-evict order)', () => {
    // retention 50 → initial lazy capacity 50 (under the
    // DEFAULT_INITIAL_CAPACITY of 64).
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 50 });
    // Phase 1: fill to retention.
    const t0 = Array.from({ length: 50 }, (_, i) => 1000 + i);
    const v0 = Array.from({ length: 50 }, (_, i) => i);
    const f0 = Array.from({ length: 50 }, (_, i) => i % 2 === 0);
    ring.appendBatch(makeTimeBatch(t0, v0, f0));
    expect(ring.length).toBe(50);
    // Phase 2: append a single row. Triggers eviction (1 row).
    // Even though no growth fires (capacity === retention), the
    // ordering invariant is exercised — the planned evict happens
    // before write, after the (no-op) grow check.
    ring.appendBatch(makeTimeBatch([2000], [999], [true]));
    expect(ring.length).toBe(50);
    const snap = ring.snapshot();
    // Oldest row (1000) is gone; newest is 2000.
    expect(snap.beginAt(0)).toBe(1001);
    expect(snap.beginAt(49)).toBe(2000);
    expect(snap.valueAt(49, 'value')).toBe(999);
  });

  it('batch-larger-than-retention path: growth precedes the clear', () => {
    // retention 100 → initial capacity 64. Appending 80 rows
    // requires growth AND clears the prior 50 rows. The new
    // ordering grows first, then clears.
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 100 });
    ring.appendBatch(
      makeTimeBatch(
        Array.from({ length: 50 }, (_, i) => 1000 + i),
        Array.from({ length: 50 }, (_, i) => i),
        Array.from({ length: 50 }, () => true),
      ),
    );
    expect(ring.length).toBe(50);
    expect(ring.capacity).toBe(64);
    // Now append 120 rows (> retention 100). Only the last 100
    // make it in; the prior 50 are entirely replaced.
    ring.appendBatch(
      makeTimeBatch(
        Array.from({ length: 120 }, (_, i) => 5000 + i),
        Array.from({ length: 120 }, (_, i) => 5000 + i),
        Array.from({ length: 120 }, () => false),
      ),
    );
    expect(ring.length).toBe(100);
    expect(ring.capacity).toBeGreaterThanOrEqual(100);
    const snap = ring.snapshot();
    // First retained row of the new batch is at index 20 of the
    // 120-row batch (since the last 100 win).
    expect(snap.beginAt(0)).toBe(5020);
    expect(snap.beginAt(99)).toBe(5119);
    expect(snap.valueAt(99, 'value')).toBe(5119);
  });
});

/* -------------------------------------------------------------------------- */
/* _appendRowTrusted — row-shape streaming intake (Step 7 prerequisite)        */
/* -------------------------------------------------------------------------- */

describe('_appendRowTrusted (Time keys)', () => {
  it('appends a single row and snapshots it', () => {
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 100 });
    ring._appendRowTrusted(1000, 1000, undefined, [10, true]);
    expect(ring.length).toBe(1);
    const snap = ring.snapshot();
    expect(snap.length).toBe(1);
    expect(snap.beginAt(0)).toBe(1000);
    expect(snap.valueAt(0, 'value')).toBe(10);
    expect(snap.valueAt(0, 'flag')).toBe(true);
  });

  it('appends multiple rows in order via repeated calls', () => {
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 100 });
    for (let i = 0; i < 5; i += 1) {
      const begin = (i + 1) * 1000;
      ring._appendRowTrusted(begin, begin, undefined, [
        (i + 1) * 10,
        i % 2 === 0,
      ]);
    }
    expect(ring.length).toBe(5);
    const snap = ring.snapshot();
    for (let i = 0; i < 5; i += 1) {
      expect(snap.beginAt(i)).toBe((i + 1) * 1000);
      expect(snap.valueAt(i, 'value')).toBe((i + 1) * 10);
      expect(snap.valueAt(i, 'flag')).toBe(i % 2 === 0);
    }
  });

  it('evicts oldest row when length reaches retention', () => {
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 3 });
    // Fill to retention.
    ring._appendRowTrusted(1, 1, undefined, [10, true]);
    ring._appendRowTrusted(2, 2, undefined, [20, false]);
    ring._appendRowTrusted(3, 3, undefined, [30, true]);
    expect(ring.length).toBe(3);
    // Push past retention.  Row 1 evicts.
    ring._appendRowTrusted(4, 4, undefined, [40, false]);
    expect(ring.length).toBe(3);
    const snap = ring.snapshot();
    expect(snap.beginAt(0)).toBe(2);
    expect(snap.beginAt(2)).toBe(4);
    expect(snap.valueAt(0, 'value')).toBe(20);
    expect(snap.valueAt(2, 'value')).toBe(40);
  });

  it('grows capacity from the default 64 as needed', () => {
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 500 });
    expect(ring.capacity).toBe(64);
    for (let i = 0; i < 100; i += 1) {
      ring._appendRowTrusted(i, i, undefined, [i, true]);
    }
    expect(ring.length).toBe(100);
    expect(ring.capacity).toBeGreaterThanOrEqual(100);
    expect(ring.capacity).toBeLessThanOrEqual(500);
    const snap = ring.snapshot();
    expect(snap.beginAt(0)).toBe(0);
    expect(snap.beginAt(99)).toBe(99);
  });

  it('preserves `undefined` for nullable value cells', () => {
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 100 });
    ring._appendRowTrusted(1000, 1000, undefined, [undefined, undefined]);
    ring._appendRowTrusted(2000, 2000, undefined, [20, true]);
    const snap = ring.snapshot();
    expect(snap.valueAt(0, 'value')).toBeUndefined();
    expect(snap.valueAt(0, 'flag')).toBeUndefined();
    expect(snap.valueAt(1, 'value')).toBe(20);
    expect(snap.valueAt(1, 'flag')).toBe(true);
  });

  it('mixes cleanly with appendBatch', () => {
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 100 });
    ring._appendRowTrusted(1000, 1000, undefined, [10, true]);
    ring.appendBatch(makeTimeBatch([2000, 3000], [20, 30], [false, true]));
    ring._appendRowTrusted(4000, 4000, undefined, [40, false]);
    expect(ring.length).toBe(4);
    const snap = ring.snapshot();
    expect(snap.beginAt(0)).toBe(1000);
    expect(snap.beginAt(1)).toBe(2000);
    expect(snap.beginAt(2)).toBe(3000);
    expect(snap.beginAt(3)).toBe(4000);
    expect(snap.valueAt(0, 'value')).toBe(10);
    expect(snap.valueAt(3, 'value')).toBe(40);
  });
});

describe('_appendRowTrusted (TimeRange keys)', () => {
  it('writes begin + end for timeRange schemas', () => {
    const schema = [
      { name: 'window', kind: 'timeRange' },
      { name: 'value', kind: 'number' },
    ] as const;
    const ring = new ColumnarRingBuffer(schema, { retention: 10 });
    ring._appendRowTrusted(1000, 2000, undefined, [42]);
    ring._appendRowTrusted(2000, 3000, undefined, [43]);
    const snap = ring.snapshot();
    expect(snap.length).toBe(2);
    expect(snap.beginAt(0)).toBe(1000);
    expect(snap.endAt(0)).toBe(2000);
    expect(snap.beginAt(1)).toBe(2000);
    expect(snap.endAt(1)).toBe(3000);
  });
});

describe('_appendRowTrusted (Interval keys, string labels)', () => {
  it('writes string labels alongside begin + end', () => {
    const schema = [
      { name: 'period', kind: 'interval' },
      { name: 'value', kind: 'number' },
    ] as const;
    const ring = new ColumnarRingBuffer(schema, {
      retention: 10,
      intervalLabelKind: 'string',
    });
    ring._appendRowTrusted(1000, 2000, 'foo', [1]);
    ring._appendRowTrusted(2000, 3000, 'bar', [2]);
    const snap = ring.snapshot();
    expect(snap.length).toBe(2);
    const keys = snap.keys as IntervalKeyColumn;
    expect(keys.labelAt(0)).toBe('foo');
    expect(keys.labelAt(1)).toBe('bar');
  });
});

describe('_appendRowTrusted (Interval keys, numeric labels)', () => {
  it('writes numeric labels into the Float64 label slot', () => {
    const schema = [
      { name: 'period', kind: 'interval' },
      { name: 'value', kind: 'number' },
    ] as const;
    const ring = new ColumnarRingBuffer(schema, {
      retention: 10,
      intervalLabelKind: 'number',
    });
    ring._appendRowTrusted(1000, 2000, 42, [1]);
    ring._appendRowTrusted(2000, 3000, 99, [2]);
    const snap = ring.snapshot();
    const keys = snap.keys as IntervalKeyColumn;
    expect(keys.labelAt(0)).toBe(42);
    expect(keys.labelAt(1)).toBe(99);
  });
});

describe('_appendRowTrusted (String value columns)', () => {
  it('writes string values', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'name', kind: 'string' },
    ] as const;
    const ring = new ColumnarRingBuffer(schema, { retention: 10 });
    ring._appendRowTrusted(1000, 1000, undefined, ['alpha']);
    ring._appendRowTrusted(2000, 2000, undefined, ['beta']);
    ring._appendRowTrusted(3000, 3000, undefined, [undefined]);
    const snap = ring.snapshot();
    expect(snap.valueAt(0, 'name')).toBe('alpha');
    expect(snap.valueAt(1, 'name')).toBe('beta');
    expect(snap.valueAt(2, 'name')).toBeUndefined();
  });
});

describe('_appendRowTrusted (Array value columns)', () => {
  it('defensively freezes incoming array cells', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'samples', kind: 'array' },
    ] as const;
    const ring = new ColumnarRingBuffer(schema, { retention: 10 });
    const incoming = [1, 2, 3];
    ring._appendRowTrusted(1000, 1000, undefined, [incoming]);
    // Caller can mutate their original — the ring's copy is frozen.
    incoming.push(4);
    const snap = ring.snapshot();
    const cell = snap.valueAt(0, 'samples') as ReadonlyArray<number>;
    expect(cell).toEqual([1, 2, 3]);
    expect(Object.isFrozen(cell)).toBe(true);
  });

  it('writes undefined for missing array cells', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'samples', kind: 'array' },
    ] as const;
    const ring = new ColumnarRingBuffer(schema, { retention: 10 });
    ring._appendRowTrusted(1000, 1000, undefined, [undefined]);
    const snap = ring.snapshot();
    expect(snap.valueAt(0, 'samples')).toBeUndefined();
  });
});

describe('_appendRowTrusted — eviction recency under sustained push', () => {
  it('a single-row append past retention preserves the most-recent rows', () => {
    // After length === retention, every subsequent _appendRowTrusted
    // evicts one. The ring's order must remain consistent: oldest at
    // index 0, newest at index length-1.
    //
    // Note: failure-atomic semantics (a throw mid-call leaves the
    // ring unchanged) are not provokable at the JS runtime level —
    // the structural ordering of stage → grow → evict → write IS
    // the proof, mirroring how `appendBatch`'s tests cover the same
    // property. The describe name says what this test does, not the
    // property the structural ordering provides.
    const ring = new ColumnarRingBuffer(TIME_SCHEMA, { retention: 3 });
    for (let i = 1; i <= 10; i += 1) {
      ring._appendRowTrusted(i * 1000, i * 1000, undefined, [i, true]);
    }
    expect(ring.length).toBe(3);
    const snap = ring.snapshot();
    expect(snap.beginAt(0)).toBe(8 * 1000);
    expect(snap.beginAt(2)).toBe(10 * 1000);
    expect(snap.valueAt(0, 'value')).toBe(8);
    expect(snap.valueAt(2, 'value')).toBe(10);
  });
});
