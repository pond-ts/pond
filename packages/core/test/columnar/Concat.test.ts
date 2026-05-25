import { describe, expect, it } from 'vitest';

import {
  ChunkedBooleanColumn,
  ChunkedFloat64Column,
  ChunkedStringColumn,
  ColumnarStore,
  Float64Column,
  IntervalKeyColumn,
  StringColumn,
  TimeKeyColumn,
  TimeRangeKeyColumn,
  booleanColumnFromArray,
  concatSorted,
  float64ColumnFromArray,
  materialize,
  stringColumnFromArray,
  timeKeyColumnFromArray,
  timeRangeKeyColumnFromPairs,
} from '../../src/columnar/index.js';

/* -------------------------------------------------------------------------- */
/* Test setup                                                                  */
/* -------------------------------------------------------------------------- */

const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
  { name: 'flag', kind: 'boolean' },
] as const;

function makeTimeStore(
  beginMs: ReadonlyArray<number>,
  values: ReadonlyArray<number>,
  flags: ReadonlyArray<boolean>,
) {
  expect(beginMs.length).toBe(values.length);
  expect(beginMs.length).toBe(flags.length);
  const keys = timeKeyColumnFromArray(beginMs);
  const valCol = float64ColumnFromArray(values);
  const flagCol = booleanColumnFromArray(flags);
  return ColumnarStore.fromTrustedStore(
    SCHEMA,
    keys,
    new Map([
      ['value', valCol],
      ['flag', flagCol],
    ]),
  );
}

/* -------------------------------------------------------------------------- */
/* concatSorted — Time keys                                                    */
/* -------------------------------------------------------------------------- */

describe('concatSorted (Time keys)', () => {
  it('concatenates two disjoint stores; keys materialized, values chunked', () => {
    const s1 = makeTimeStore(
      [1000, 2000, 3000],
      [10, 20, 30],
      [true, false, true],
    );
    const s2 = makeTimeStore([4000, 5000], [40, 50], [false, true]);
    const out = concatSorted([s1, s2]);
    expect(out.length).toBe(5);
    expect(out.schema).toBe(s1.schema);
    expect(out.keys).toBeInstanceOf(TimeKeyColumn);
    expect(Array.from((out.keys as TimeKeyColumn).begin)).toEqual([
      1000, 2000, 3000, 4000, 5000,
    ]);
    const value = out.columns.get('value')!;
    expect(value).toBeInstanceOf(ChunkedFloat64Column);
    expect(value.storage).toBe('chunked');
    expect(value.length).toBe(5);
    expect(value.read(0)).toBe(10);
    expect(value.read(2)).toBe(30);
    expect(value.read(3)).toBe(40);
    expect(value.read(4)).toBe(50);
    const flag = out.columns.get('flag')!;
    expect(flag).toBeInstanceOf(ChunkedBooleanColumn);
    expect(flag.read(0)).toBe(true);
    expect(flag.read(4)).toBe(true);
  });

  it('N=1 returns the input as-is', () => {
    const s1 = makeTimeStore([1000, 2000], [10, 20], [true, false]);
    const out = concatSorted([s1]);
    expect(out).toBe(s1);
  });

  it('N=3 concatenates in order; value chunks count matches inputs', () => {
    const s1 = makeTimeStore([1000], [10], [true]);
    const s2 = makeTimeStore([2000, 3000], [20, 30], [false, true]);
    const s3 = makeTimeStore([4000], [40], [true]);
    const out = concatSorted([s1, s2, s3]);
    expect(out.length).toBe(4);
    const value = out.columns.get('value') as ChunkedFloat64Column;
    expect(value.chunks.length).toBe(3);
    expect(value.read(0)).toBe(10);
    expect(value.read(3)).toBe(40);
  });

  it('flattens nested chunked inputs (concat of concat)', () => {
    const a = makeTimeStore([1000], [10], [true]);
    const b = makeTimeStore([2000], [20], [false]);
    const c = makeTimeStore([3000], [30], [true]);
    const ab = concatSorted([a, b]);
    const abc = concatSorted([ab, c]);
    const value = abc.columns.get('value') as ChunkedFloat64Column;
    // Expect three chunks (a, b, c) — not nested.
    expect(value.chunks.length).toBe(3);
    for (const chunk of value.chunks) {
      expect(chunk).toBeInstanceOf(Float64Column);
    }
    expect(value.read(0)).toBe(10);
    expect(value.read(2)).toBe(30);
  });

  it('skips empty input stores entirely (no zero-length chunks)', () => {
    const empty = makeTimeStore([], [], []);
    const s2 = makeTimeStore([1000, 2000], [10, 20], [true, false]);
    const out = concatSorted([empty, s2]);
    expect(out.length).toBe(2);
    const value = out.columns.get('value') as ChunkedFloat64Column;
    expect(value.chunks.length).toBe(1);
    expect(value.read(0)).toBe(10);
  });

  it('throws on overlapping Time keys (coincident timestamps across stores)', () => {
    const s1 = makeTimeStore([1000, 2000], [10, 20], [true, false]);
    const s2 = makeTimeStore([2000, 3000], [99, 30], [true, true]);
    expect(() => concatSorted([s1, s2])).toThrow(/temporally disjoint/);
  });

  it('throws when later store precedes earlier', () => {
    const s1 = makeTimeStore([3000, 4000], [30, 40], [true, true]);
    const s2 = makeTimeStore([1000, 2000], [10, 20], [false, false]);
    expect(() => concatSorted([s1, s2])).toThrow(/temporally disjoint/);
  });

  it('throws on empty input list', () => {
    expect(() => concatSorted([])).toThrow(/at least one input/);
  });

  it('throws on schema length mismatch', () => {
    const s1 = makeTimeStore([1000], [10], [true]);
    // Build s2 with a different schema (an extra column).
    const altSchema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;
    const s2 = ColumnarStore.fromTrustedStore(
      altSchema,
      timeKeyColumnFromArray([2000]),
      new Map([['value', float64ColumnFromArray([20])]]),
    );
    expect(() => concatSorted([s1 as unknown as typeof s2, s2])).toThrow(
      /schema length/,
    );
  });

  it('throws on schema column kind mismatch', () => {
    const s1 = makeTimeStore([1000], [10], [true]);
    const altSchema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'string' }, // 'string' vs 'number'
      { name: 'flag', kind: 'boolean' },
    ] as const;
    const s2 = ColumnarStore.fromTrustedStore(
      altSchema,
      timeKeyColumnFromArray([2000]),
      new Map([
        ['value', stringColumnFromArray(['x'])],
        ['flag', booleanColumnFromArray([true])],
      ]),
    );
    expect(() => concatSorted([s1 as unknown as typeof s2, s2])).toThrow(
      /kind/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* concatSorted — TimeRange keys (boundary-touch allowed)                      */
/* -------------------------------------------------------------------------- */

describe('concatSorted (TimeRange keys)', () => {
  const TR_SCHEMA = [
    { name: 'window', kind: 'timeRange' },
    { name: 'value', kind: 'number' },
  ] as const;

  function makeTRStore(
    pairs: ReadonlyArray<readonly [number, number]>,
    values: ReadonlyArray<number>,
  ) {
    const keys = timeRangeKeyColumnFromPairs(pairs);
    const valCol = float64ColumnFromArray(values);
    return ColumnarStore.fromTrustedStore(
      TR_SCHEMA,
      keys,
      new Map([['value', valCol]]),
    );
  }

  it('boundary-touch (lastEnd === nextBegin) is allowed', () => {
    const s1 = makeTRStore(
      [
        [1000, 2000],
        [2000, 3000],
      ],
      [10, 20],
    );
    const s2 = makeTRStore(
      [
        [3000, 4000],
        [4000, 5000],
      ],
      [30, 40],
    );
    const out = concatSorted([s1, s2]);
    expect(out.length).toBe(4);
    expect(out.keys).toBeInstanceOf(TimeRangeKeyColumn);
    expect((out.keys as TimeRangeKeyColumn).endAt(3)).toBe(5000);
  });

  it('strict overlap (lastEnd > nextBegin) throws', () => {
    const s1 = makeTRStore(
      [
        [1000, 2500],
        [2500, 3000],
      ],
      [10, 20],
    );
    const s2 = makeTRStore([[2000, 4000]], [99]);
    expect(() => concatSorted([s1, s2])).toThrow(/temporally disjoint/);
  });

  // Regression: Codex round-1 finding. The framework's
  // `TimeRangeKeyColumn` allows begin-sorted stores whose maximum
  // `endAt(i)` does not occur at the last row — e.g. a long-running
  // row 0 (`[1000, 5000]`) followed by a short row 1 (`[2000, 2500]`)
  // is structurally valid even though the max end is at row 0. The
  // disjointness check must scan all `endAt` values; relying on
  // `endAt(length - 1)` alone would let a next store starting at
  // 3000 slip through despite overlapping row 0's range.
  it('rejects next-store overlap that is hidden by a non-final long-running row', () => {
    const s1 = makeTRStore(
      [
        [1000, 5000],
        [2000, 2500],
      ],
      [10, 20],
    );
    const s2 = makeTRStore([[3000, 6000]], [30]);
    expect(() => concatSorted([s1, s2])).toThrow(/temporally disjoint/);
  });

  it('accepts the same shape when next-store begin clears the actual max end', () => {
    const s1 = makeTRStore(
      [
        [1000, 5000],
        [2000, 2500],
      ],
      [10, 20],
    );
    const s2 = makeTRStore([[5000, 6000]], [30]); // boundary-touch on max end.
    const out = concatSorted([s1, s2]);
    expect(out.length).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/* concatSorted — Interval keys (with string and numeric labels)              */
/* -------------------------------------------------------------------------- */

describe('concatSorted (Interval keys)', () => {
  it('concatenates interval stores with string labels (label dictionary rebuilt)', () => {
    const labelsA = stringColumnFromArray(['1d-1000', '1d-1001']);
    const a = ColumnarStore.fromTrustedStore(
      [
        { name: 'tile', kind: 'interval' },
        { name: 'value', kind: 'number' },
      ] as const,
      new IntervalKeyColumn(
        Float64Array.of(1000, 2000),
        Float64Array.of(2000, 3000),
        labelsA,
        2,
      ),
      new Map([['value', float64ColumnFromArray([10, 20])]]),
    );
    const labelsB = stringColumnFromArray(['1d-1002', '1d-1000']);
    const b = ColumnarStore.fromTrustedStore(
      [
        { name: 'tile', kind: 'interval' },
        { name: 'value', kind: 'number' },
      ] as const,
      new IntervalKeyColumn(
        Float64Array.of(3000, 4000),
        Float64Array.of(4000, 5000),
        labelsB,
        2,
      ),
      new Map([['value', float64ColumnFromArray([30, 40])]]),
    );
    const out = concatSorted([a, b]);
    expect(out.length).toBe(4);
    const outKeys = out.keys as IntervalKeyColumn;
    expect(outKeys.labelKind).toBe('string');
    expect(outKeys.labelAt(0)).toBe('1d-1000');
    expect(outKeys.labelAt(2)).toBe('1d-1002');
    expect(outKeys.labelAt(3)).toBe('1d-1000');
  });

  it('rejects mixed labelKind across inputs', () => {
    const numericA = ColumnarStore.fromTrustedStore(
      [
        { name: 'tile', kind: 'interval' },
        { name: 'value', kind: 'number' },
      ] as const,
      new IntervalKeyColumn(
        Float64Array.of(1000),
        Float64Array.of(2000),
        new Float64Column(Float64Array.of(0), 1),
        1,
      ),
      new Map([['value', float64ColumnFromArray([10])]]),
    );
    const stringB = ColumnarStore.fromTrustedStore(
      [
        { name: 'tile', kind: 'interval' },
        { name: 'value', kind: 'number' },
      ] as const,
      new IntervalKeyColumn(
        Float64Array.of(2000),
        Float64Array.of(3000),
        stringColumnFromArray(['1d-2000']),
        1,
      ),
      new Map([['value', float64ColumnFromArray([20])]]),
    );
    expect(() => concatSorted([numericA, stringB])).toThrow(/labelKind/);
  });
});

/* -------------------------------------------------------------------------- */
/* materialize — actually compacts chunked stores now                          */
/* -------------------------------------------------------------------------- */

describe('materialize (compacts chunked columns)', () => {
  it('compacts a chunked store into a plain one', () => {
    const s1 = makeTimeStore([1000, 2000], [10, 20], [true, false]);
    const s2 = makeTimeStore([3000, 4000], [30, 40], [false, true]);
    const chunked = concatSorted([s1, s2]);
    const value = chunked.columns.get('value')!;
    expect(value.storage).toBe('chunked');
    const plain = materialize(chunked);
    expect(plain.length).toBe(4);
    expect(plain.schema).toBe(chunked.schema);
    expect(plain.keys).toBe(chunked.keys);
    const newValue = plain.columns.get('value')!;
    expect(newValue).toBeInstanceOf(Float64Column);
    expect(newValue.storage).toBe('packed');
    expect(newValue.read(0)).toBe(10);
    expect(newValue.read(3)).toBe(40);
    const newFlag = plain.columns.get('flag')!;
    expect(newFlag.storage).toBe('packed');
    expect(newFlag.read(0)).toBe(true);
    expect(newFlag.read(3)).toBe(true);
  });

  it('is identity for a store with only plain columns', () => {
    const s = makeTimeStore([1000, 2000], [10, 20], [true, false]);
    const out = materialize(s);
    expect(out).toBe(s);
  });

  it('preserves aggregate validity through compaction', () => {
    // Manually build a chunked column with mixed validity.
    const c0 = float64ColumnFromArray([10, null, 30]);
    const c1 = float64ColumnFromArray([40, 50]);
    const chunked = new ChunkedFloat64Column([c0, c1]);
    const s = ColumnarStore.fromTrustedStore(
      [
        { name: 'time', kind: 'time' },
        { name: 'value', kind: 'number' },
      ] as const,
      timeKeyColumnFromArray([1000, 2000, 3000, 4000, 5000]),
      new Map([['value', chunked]]),
    );
    const plain = materialize(s);
    const v = plain.columns.get('value')!;
    expect(v.storage).toBe('packed');
    expect(v.read(0)).toBe(10);
    expect(v.read(1)).toBeUndefined();
    expect(v.read(2)).toBe(30);
    expect(v.read(3)).toBe(40);
    expect(v.read(4)).toBe(50);
  });
});

/* -------------------------------------------------------------------------- */
/* Type-only import to silence unused-import lints                             */
/* -------------------------------------------------------------------------- */

describe('chunked-string concat path', () => {
  it('produces a ChunkedStringColumn output and is read-correct', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'label', kind: 'string' },
    ] as const;
    const a = ColumnarStore.fromTrustedStore(
      schema,
      timeKeyColumnFromArray([1000, 2000]),
      new Map([['label', stringColumnFromArray(['x', 'y'])]]),
    );
    const b = ColumnarStore.fromTrustedStore(
      schema,
      timeKeyColumnFromArray([3000, 4000]),
      new Map([['label', stringColumnFromArray(['z', 'x'])]]),
    );
    const out = concatSorted([a, b]);
    const label = out.columns.get('label')!;
    expect(label).toBeInstanceOf(ChunkedStringColumn);
    expect(label.read(0)).toBe('x');
    expect(label.read(2)).toBe('z');
    expect(label.read(3)).toBe('x');
    // Ensure StringColumn import is exercised.
    const plain = materialize(out);
    expect(plain.columns.get('label')).toBeInstanceOf(StringColumn);
  });
});
