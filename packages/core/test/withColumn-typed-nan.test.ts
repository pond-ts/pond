import { describe, expect, it } from 'vitest';
import { TimeSeries, ValidationError } from '../src/index.js';

/* -------------------------------------------------------------------------- */
/* [PND-WCNAN] — `withColumn` accepts a Float64Array where NaN means missing.  */
/*                                                                             */
/* The asymmetry is the point, so it gets pinned from both sides:              */
/*                                                                             */
/*   Float64Array                 NaN  → a gap    (a typed buffer has no       */
/*                                                 `undefined` slot, so NaN is */
/*                                                 the only way to say it)     */
/*   Array<number | undefined>    NaN  → rejected  (it already has `undefined`,*/
/*                                                 so a NaN is a mistake)      */
/*   either                  ±Infinity → rejected  (not a gap; the numeric     */
/*                                                 intake contract excludes it)*/
/*                                                                             */
/* A boxed array that accepted NaN would silently reinterpret a caller's       */
/* arithmetic error as "no data", which is why only the typed door changed.    */
/* -------------------------------------------------------------------------- */

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
] as const;

const series = (n: number) =>
  new TimeSeries({
    name: 's',
    schema,
    rows: Array.from({ length: n }, (_, i) => [i * 1000, i] as const) as never,
  });

describe('[PND-WCNAN] Float64Array intake treats NaN as missing', () => {
  it('maps NaN cells to missing and keeps the rest', () => {
    const s = series(5);
    const values = Float64Array.from([1, NaN, 3, NaN, 5]);
    const out = s.withColumn('derived', values);
    const col = out.column('derived');
    expect(col.at(0)).toBe(1);
    expect(col.at(1)).toBeUndefined();
    expect(col.at(2)).toBe(3);
    expect(col.at(3)).toBeUndefined();
    expect(col.at(4)).toBe(5);
    expect(col.nullCount()).toBe(2);
  });

  it('produces the same column a boxed array with undefined would', () => {
    const s = series(6);
    const typed = s.withColumn(
      'd',
      Float64Array.from([NaN, NaN, 3, 4, NaN, 6]),
    );
    const boxed = s.withColumn('d', [undefined, undefined, 3, 4, undefined, 6]);
    for (let i = 0; i < 6; i += 1) {
      expect(typed.column('d').at(i)).toStrictEqual(boxed.column('d').at(i));
    }
    expect(typed.column('d').nullCount()).toBe(boxed.column('d').nullCount());
  });

  it('allocates no validity bitmap when no cell is NaN', () => {
    const out = series(4).withColumn('d', Float64Array.from([1, 2, 3, 4]));
    const col = out.column('d');
    expect(col.validity).toBeUndefined();
    expect(col.hasMissing()).toBe(false);
  });

  it('claims allFinite, so downstream reductions keep the fast path', () => {
    const out = series(4).withColumn('d', Float64Array.from([1, NaN, 3, 4]));
    const col = out.column('d');
    expect((col as unknown as { allFinite: boolean }).allFinite).toBe(true);
    expect(col.sum()).toBe(8);
    expect(col.mean()).toBe(8 / 3);
  });

  it('handles an all-NaN column as all-missing', () => {
    const out = series(3).withColumn('d', Float64Array.from([NaN, NaN, NaN]));
    const col = out.column('d');
    expect(col.nullCount()).toBe(3);
    expect(col.sum()).toBe(0);
    expect(col.mean()).toBeUndefined();
  });

  it('does not alias the caller’s buffer', () => {
    // `fromColumns` documents adoption; `withColumn` has always copied, and
    // starting to alias would mean a later write mutates a built series.
    const s = series(3);
    const buf = Float64Array.from([1, 2, 3]);
    const out = s.withColumn('d', buf);
    buf[1] = 999;
    expect(out.column('d').at(1)).toBe(2);
  });
});

describe('[PND-WCNAN] what stays rejected', () => {
  it('rejects +Infinity in a Float64Array', () => {
    const s = series(3);
    expect(() =>
      s.withColumn('d', Float64Array.from([1, Infinity, 3])),
    ).toThrow(ValidationError);
    expect(() =>
      s.withColumn('d', Float64Array.from([1, Infinity, 3])),
    ).toThrow(/index 1 is Infinity/);
  });

  it('rejects -Infinity in a Float64Array', () => {
    const s = series(3);
    expect(() =>
      s.withColumn('d', Float64Array.from([1, -Infinity, 3])),
    ).toThrow(/index 1 is -Infinity/);
  });

  it('still rejects NaN in a BOXED array — it has undefined for that', () => {
    // The asymmetry, pinned. Accepting NaN here too would silently
    // reinterpret a caller's arithmetic slip as "no data".
    const s = series(3);
    expect(() => s.withColumn('d', [1, NaN, 3])).toThrow(ValidationError);
  });

  it('still rejects Infinity in a boxed array', () => {
    const s = series(3);
    expect(() => s.withColumn('d', [1, Infinity, 3])).toThrow(ValidationError);
  });

  it('still rejects a length mismatch', () => {
    const s = series(3);
    expect(() => s.withColumn('d', Float64Array.from([1, 2]))).toThrow(
      RangeError,
    );
  });
});

describe('[PND-WCNAN] the resulting column composes', () => {
  it('survives a downstream operator that rebuilds the column', () => {
    const out = series(6)
      .withColumn('d', Float64Array.from([NaN, 2, 4, 8, NaN, 32]))
      .cumulative({ d: 'sum' });
    // Leading NaN is a gap: the accumulator has nothing until index 1.
    expect(out.column('d').at(0)).toBeUndefined();
    expect(out.column('d').at(1)).toBe(2);
    expect(out.column('d').at(3)).toBe(14);
    // The index-4 gap carries the accumulator rather than resetting it.
    expect(out.column('d').at(4)).toBe(14);
    expect(out.column('d').at(5)).toBe(46);
  });

  it('round-trips through a second withColumn', () => {
    const first = series(4).withColumn('a', Float64Array.from([1, NaN, 3, 4]));
    const values = first.column('a').toFloat64Array();
    // `toFloat64Array` returns the raw buffer including gap slots, which
    // read as 0 rather than NaN — so this is not a lossless round trip
    // today. Pinned as the current contract, not as an endorsement.
    expect(values[1]).toBe(0);
    const second = first.withColumn('b', values);
    expect(second.column('b').at(1)).toBe(0);
    expect(second.column('b').nullCount()).toBe(0);
  });
});
