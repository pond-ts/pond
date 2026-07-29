import { describe, expect, it } from 'vitest';
import {
  BoundedSequence,
  Interval,
  Sequence,
  TimeSeries,
  ValidationError,
} from '../src/index.js';

/* -------------------------------------------------------------------------- */
/* [PND-IVLCOL] — aggregate() builds its interval-keyed result columnar.       */
/*                                                                             */
/* The columnar fast path used to compute each bucket in typed arrays, box     */
/* the answer into a frozen `[Interval, …]` row, and let                       */
/* `new TimeSeries({ rows })` walk those rows straight back into columns.      */
/* It now assembles a `ColumnarStore` and adopts it via trusted construction.  */
/*                                                                             */
/* Trusted construction skips row intake — so these tests pin the checks row   */
/* intake used to perform on aggregate's behalf. Every one of them would pass  */
/* trivially against the old path; they exist because the new path could       */
/* silently stop doing them.                                                   */
/* -------------------------------------------------------------------------- */

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number', required: false },
  { name: 'host', kind: 'string', required: false },
  { name: 'up', kind: 'boolean', required: false },
] as const;

type Row = readonly [
  number,
  number | undefined,
  string | undefined,
  boolean | undefined,
];

const series = (rows: Row[]) =>
  new TimeSeries({ name: 's', schema, rows: rows as Row[] });

const minute = Sequence.every(60_000);

describe('[PND-IVLCOL] aggregate columnar output — empty buckets', () => {
  // The single design decision the change forced: an empty bucket is
  // `undefined` on the row path and `NaN` in a Float64Array. Resolved in
  // favour of preserving the row path's answer, via a validity bitmap.
  const gappy = () =>
    series([
      [0, 1, 'a', true],
      [10_000, 3, 'a', false],
      // nothing in [60s, 120s) — the middle bucket is empty
      [120_000, 5, 'b', true],
    ]);

  it('reports an empty bucket as undefined, not NaN', () => {
    const out = gappy().aggregate(minute, { value: 'avg' });
    expect(out.length).toBe(3);
    expect(out.at(0)!.get('value')).toBe(2);
    expect(out.at(1)!.get('value')).toBeUndefined();
    expect(out.at(2)!.get('value')).toBe(5);
  });

  it('marks the empty bucket missing in the column, not merely NaN-valued', () => {
    const out = gappy().aggregate(minute, { value: 'avg' });
    const col = out.column('value');
    expect(col.at(1)).toBeUndefined();
    expect(col.hasMissing()).toBe(true);
    expect(col.nullCount()).toBe(1);
    // A NaN sentinel would have left the cell "defined" and counted it.
    expect(col.count()).toBe(2);
  });

  it('keeps reducers whose empty value is defined (sum / count) defined', () => {
    const out = gappy().aggregate(minute, { value: 'sum' });
    expect(out.at(1)!.get('value')).toBe(0);
    expect(out.column('value').hasMissing()).toBe(false);
  });

  it('allocates no validity bitmap when every bucket is populated', () => {
    const dense = series([
      [0, 1, 'a', true],
      [60_000, 2, 'b', false],
    ]);
    const col = dense.aggregate(minute, { value: 'avg' }).column('value');
    expect(col.validity).toBeUndefined();
    expect(col.hasMissing()).toBe(false);
  });

  it('handles an all-missing source column (bitmap starts at bucket 0)', () => {
    const allMissing = series([
      [0, undefined, 'a', true],
      [10_000, undefined, 'a', false],
    ]);
    const out = allMissing.aggregate(minute, { value: 'avg' });
    expect(out.at(0)!.get('value')).toBeUndefined();
    expect(out.column('value').nullCount()).toBe(1);
  });
});

describe('[PND-IVLCOL] aggregate columnar output — intake checks preserved', () => {
  it('still rejects a non-finite reducer result, with the row path’s message', () => {
    // `sum` over two near-MAX_VALUE cells overflows to +Infinity. Row
    // intake rejected that via assertCellKind; trusted construction has
    // to reject it too, or a non-finite cell lands in a column stamped
    // `allFinite: true` and every downstream reducer reads garbage.
    const overflowing = series([
      [0, Number.MAX_VALUE, 'a', true],
      [10_000, Number.MAX_VALUE, 'a', true],
    ]);
    expect(() => overflowing.aggregate(minute, { value: 'sum' })).toThrow(
      ValidationError,
    );
    expect(() => overflowing.aggregate(minute, { value: 'sum' })).toThrow(
      /row 0 col 1: expected finite number/,
    );
  });

  it('stamps numeric output columns allFinite so downstream reductions stay fast', () => {
    const out = series([
      [0, 1, 'a', true],
      [10_000, 3, 'a', false],
    ]).aggregate(minute, { value: 'avg' });
    const col = out.column('value');
    expect(col.storage).toBe('packed');
    // Not cosmetic: `allFinite: false` silently deoptimises every
    // reduction of an aggregate result to the guarded path.
    expect((col as { allFinite: boolean }).allFinite).toBe(true);
  });

  it('produces a series whose rows re-read identically through the row API', () => {
    const out = series([
      [0, 1, 'a', true],
      [10_000, 3, 'b', false],
    ]).aggregate(minute, { value: 'avg', host: 'first', up: 'last' });
    const event = out.at(0)!;
    expect(event.get('value')).toBe(2);
    expect(event.get('host')).toBe('a');
    expect(event.get('up')).toBe(false);
    // Event identity is stable across repeat access (the store's lazy
    // per-row cache must survive trusted adoption).
    expect(out.at(0)).toBe(out.at(0));
  });
});

describe('[PND-IVLCOL] aggregate columnar output — interval keys', () => {
  it('carries numeric bucket labels through as the interval label', () => {
    const out = series([[0, 1, 'a', true]]).aggregate(minute, {
      value: 'avg',
    });
    const key = out.at(0)!.key() as Interval;
    expect(key.begin()).toBe(0);
    expect(key.end()).toBe(60_000);
    expect(key.value).toBe(0);
    expect(out.firstColumnKind).toBe('interval');
  });

  it('carries string bucket labels through a BoundedSequence', () => {
    const labelled = new BoundedSequence([
      new Interval({ value: 'morning', start: 0, end: 60_000 }),
      new Interval({ value: 'noon', start: 60_000, end: 120_000 }),
    ]);
    const out = series([
      [0, 1, 'a', true],
      [70_000, 5, 'b', false],
    ]).aggregate(labelled, { value: 'avg' });
    expect((out.at(0)!.key() as Interval).value).toBe('morning');
    expect((out.at(1)!.key() as Interval).value).toBe('noon');
    expect(out.at(1)!.get('value')).toBe(5);
  });

  it('rejects a sequence mixing string and numeric labels', () => {
    const mixed = new BoundedSequence([
      new Interval({ value: 'morning', start: 0, end: 60_000 }),
      new Interval({ value: 42, start: 60_000, end: 120_000 }),
    ]);
    expect(() =>
      series([[0, 1, 'a', true]]).aggregate(mixed, { value: 'avg' }),
    ).toThrow(RangeError);
    expect(() =>
      series([[0, 1, 'a', true]]).aggregate(mixed, { value: 'avg' }),
    ).toThrow(/must use one label type throughout/);
  });

  it('produces an empty interval-keyed series when the range yields no buckets', () => {
    const empty = new TimeSeries({ name: 's', schema, rows: [] as Row[] });
    const out = empty.aggregate(minute, { value: 'avg' });
    expect(out.length).toBe(0);
    expect(out.firstColumnKind).toBe('interval');
  });
});

describe('[PND-IVLCOL] aggregate columnar output — non-numeric outputs', () => {
  // `first`/`last` preserve the source kind, so the columnar output path
  // has to build string / boolean columns too — not only Float64.
  const mixedKinds = () =>
    series([
      [0, 1, 'a', true],
      [10_000, 2, undefined, undefined],
      [60_000, 3, 'b', false],
    ]);

  it('builds string output columns, preserving missing cells', () => {
    const out = mixedKinds().aggregate(minute, { host: 'last' });
    // Bucket 0's last *defined* host is 'a' (row 1's is missing).
    expect(out.at(0)!.get('host')).toBe('a');
    expect(out.at(1)!.get('host')).toBe('b');
    expect(out.column('host').hasMissing()).toBe(false);
  });

  it('builds boolean output columns, preserving missing cells', () => {
    const out = mixedKinds().aggregate(minute, { up: 'first' });
    expect(out.at(0)!.get('up')).toBe(true);
    expect(out.at(1)!.get('up')).toBe(false);
  });

  it('marks a bucket with no defined string cell as missing', () => {
    const noHost = series([
      [0, 1, undefined, true],
      [10_000, 2, undefined, true],
    ]);
    const out = noHost.aggregate(minute, { host: 'first' });
    expect(out.at(0)!.get('host')).toBeUndefined();
    expect(out.column('host').nullCount()).toBe(1);
  });

  it('builds array output columns via the row path (unique is not columnar)', () => {
    // `unique` has neither reduceColumn nor definedBoundary, so the whole
    // call falls back to rows. Pinned here so the fallback stays wired.
    const out = mixedKinds().aggregate(minute, { host: 'unique' });
    expect(out.at(0)!.get('host')).toEqual(['a']);
    expect(out.at(1)!.get('host')).toEqual(['b']);
  });
});

describe('[PND-IVLCOL] aggregate columnar output — parity with the row path', () => {
  // A custom-function reducer forces the row path; an exact built-in
  // equivalent takes the columnar one. Comparing the two output series
  // pins the whole change end to end rather than field by field.
  const numbersOf = (xs: ReadonlyArray<unknown>): number[] =>
    xs.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

  const data = () =>
    series([
      [0, 1, 'a', true],
      [10_000, undefined, 'a', false],
      [20_000, 3, undefined, true],
      // gap: bucket 1 empty
      [120_000, 7, 'c', false],
      [130_000, 9, 'c', true],
    ]);

  const cases: Array<
    [string, string, (xs: ReadonlyArray<unknown>) => unknown]
  > = [
    ['sum', 'sum', (xs) => numbersOf(xs).reduce((a, b) => a + b, 0)],
    ['count', 'count', (xs) => numbersOf(xs).length],
    [
      'avg',
      'avg',
      (xs) => {
        const n = numbersOf(xs);
        return n.length === 0
          ? undefined
          : n.reduce((a, b) => a + b, 0) / n.length;
      },
    ],
    [
      'min',
      'min',
      (xs) => {
        const n = numbersOf(xs);
        return n.length === 0 ? undefined : Math.min(...n);
      },
    ],
    [
      'max',
      'max',
      (xs) => {
        const n = numbersOf(xs);
        return n.length === 0 ? undefined : Math.max(...n);
      },
    ],
  ];

  for (const [name, builtIn, custom] of cases) {
    it(`matches the row path for '${name}', including the empty bucket`, () => {
      const columnar = data().aggregate(minute, { value: builtIn });
      const rowPath = data().aggregate(minute, { value: custom });
      expect(columnar.length).toBe(rowPath.length);
      for (let i = 0; i < columnar.length; i += 1) {
        expect(columnar.at(i)!.get('value')).toStrictEqual(
          rowPath.at(i)!.get('value'),
        );
        const a = columnar.at(i)!.key() as Interval;
        const b = rowPath.at(i)!.key() as Interval;
        expect([a.begin(), a.end(), a.value]).toEqual([
          b.begin(),
          b.end(),
          b.value,
        ]);
      }
    });
  }

  it('matches the row path through a downstream transform', () => {
    // The result is consumed, not just inspected — trusted construction
    // has to leave a store every operator can read.
    const columnar = data()
      .aggregate(minute, { value: 'sum' })
      .filter((e) => (e.get('value') as number) > 0);
    expect(columnar.length).toBe(2);
    expect(columnar.column('value').sum()).toBe(20);
  });
});
