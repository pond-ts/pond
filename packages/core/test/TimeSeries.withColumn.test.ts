/**
 * Tests for `TimeSeries.withColumn` — attach a computed numeric column
 * (estela F-geo-1). Appends a `Float64Array` / `(number|undefined)[]` as a new
 * `number` column so downstream pond ops can reference it; validates the
 * numeric intake contract (finite-or-missing) and widens the schema type.
 */
import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';
import { ValidationError } from '../src/core/errors.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'lat', kind: 'number' },
] as const;

type Row = readonly [number, number];

const make = (rows: readonly Row[]) =>
  new TimeSeries({ name: 'track', schema, rows: rows as Row[] });

const base = () =>
  make([
    [0, 10],
    [1, 20],
    [2, 30],
    [3, 40],
  ]);

const colOf = (s: ReturnType<typeof base> | TimeSeries<never>, name: string) =>
  [...s].map((e) => e.get(name as never));

describe('TimeSeries.withColumn — attach', () => {
  it('appends a Float64Array as a new number column, readable downstream', () => {
    const s2 = base().withColumn('cumDist', new Float64Array([0, 5, 12, 20]));
    expect(colOf(s2, 'cumDist')).toEqual([0, 5, 12, 20]);
    expect(colOf(s2, 'lat')).toEqual([10, 20, 30, 40]); // existing column intact
  });

  it('appends a (number|undefined)[] and records missing cells in the validity bitmap', () => {
    const s2 = base().withColumn('g', [1, undefined, 3, undefined]);
    expect(colOf(s2, 'g')).toEqual([1, undefined, 3, undefined]);
    // count over the new column excludes the missing cells
    const out = s2.byColumn(
      'lat',
      { width: 100 },
      {
        n: { from: 'g', using: 'count' },
      },
    );
    expect(out[0]!.n).toBe(2); // only the two defined cells
  });

  it('leaves the original series unchanged (returns a new series)', () => {
    const s = base();
    const s2 = s.withColumn('cumDist', new Float64Array([0, 5, 12, 20]));
    expect(s.schema).toHaveLength(2); // time, lat
    expect(s2.schema).toHaveLength(3); // + cumDist
    expect(s2.schema[2]).toMatchObject({ name: 'cumDist', kind: 'number' });
  });

  it('appends an OPTIONAL column, so a later strict-intake rebuild tolerates its gaps', () => {
    // Regression: withColumn used to mark the column `required`, so a gap
    // (undefined) packed via trusted construction crashed the next operator
    // that rebuilds rows through strict intake (`smooth`) — breaking a column
    // with a warm-up (a rolling study fed into an EMA). The column is optional.
    const withGap = base().withColumn('g', [1, undefined, 3, undefined]);
    expect(withGap.schema[2]).toMatchObject({ required: false });
    // The strict-intake rebuild no longer throws on the gapped column…
    const smoothed = withGap.smooth('lat', 'ema', { alpha: 0.5, output: 'e' });
    expect(colOf(smoothed, 'g')).toEqual([1, undefined, 3, undefined]); // preserved
    expect(smoothed.at(0)!.get('e')).toBe(10); // ema still computed
  });
});

describe('TimeSeries.withColumn — composition (the F-geo-1 seam)', () => {
  it('attach a derived axis, then rollingByColumn over it (type widens to include the new column)', () => {
    // The compile proves the widening: `rollingByColumn('cumDist', …)` only
    // typechecks if `withColumn` added `cumDist` to the schema as a numeric col.
    const s2 = base().withColumn(
      'cumDist',
      new Float64Array([0, 100, 250, 400]),
    );
    const out = s2.rollingByColumn(
      'cumDist',
      { radius: 150 },
      {
        n: { from: 'lat', using: 'count' },
      },
    );
    expect(out.map((r) => r.n)).toEqual([2, 3, 3, 2]);
  });

  it('attach a derived axis, then byColumn over it', () => {
    const s2 = base().withColumn(
      'cumDist',
      new Float64Array([0, 100, 250, 400]),
    );
    const out = s2.byColumn(
      'cumDist',
      { width: 200 },
      {
        n: { from: 'lat', using: 'count' },
      },
    );
    expect(out.map((r) => [r.start, r.end, r.n])).toEqual([
      [0, 200, 2],
      [200, 400, 1],
      [400, 600, 1],
    ]);
  });

  it('chains: two derived columns attached in sequence', () => {
    const s3 = base()
      .withColumn('cumDist', new Float64Array([0, 100, 250, 400]))
      .withColumn('speed', new Float64Array([5, 6, 7, 8]));
    expect(s3.schema).toHaveLength(4);
    expect(colOf(s3, 'speed')).toEqual([5, 6, 7, 8]);
    expect(colOf(s3, 'cumDist')).toEqual([0, 100, 250, 400]);
  });
});

describe('TimeSeries.withColumn — validation', () => {
  it('throws when values length does not match the series length', () => {
    expect(() => base().withColumn('x', new Float64Array([1, 2, 3]))).toThrow(
      /values length 3 does not match series length 4/,
    );
  });

  it('rejects non-finite values (NaN / ±Infinity), matching intake', () => {
    expect(() => base().withColumn('x', [1, 2, NaN, 4])).toThrow(
      ValidationError,
    );
    expect(() =>
      base().withColumn('x', new Float64Array([1, 2, Infinity, 4])),
    ).toThrow(ValidationError);
  });

  it('throws when the name collides with an existing column', () => {
    expect(() =>
      base().withColumn('lat' as never, new Float64Array([1, 2, 3, 4])),
    ).toThrow(/already exists/);
  });

  it('throws when the name collides with the key column', () => {
    expect(() =>
      base().withColumn('time' as never, new Float64Array([1, 2, 3, 4])),
    ).toThrow(/already exists/);
  });

  it('rejects a reserved column name', () => {
    expect(() =>
      base().withColumn('__proto__' as never, new Float64Array([1, 2, 3, 4])),
    ).toThrow();
  });

  it('attaches to an empty series', () => {
    const empty = make([]);
    const s2 = empty.withColumn('cumDist', new Float64Array([]));
    expect(s2.schema).toHaveLength(3);
    expect([...s2]).toHaveLength(0);
  });
});
