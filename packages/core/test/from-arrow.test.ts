import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';
import type {
  ArrowTableLike,
  ArrowVectorLike,
  FromArrowOptions,
} from '../src/index.js';

// ── Minimal structural fakes standing in for an apache-arrow `Table` ──
//
// pond duck-types the Arrow surface (see `from-arrow.ts`), so a hand-built
// object matching {@link ArrowTableLike} exercises the exact code path a real
// decoded `Table` hits — without pulling `apache-arrow` into the dep tree.

function vector(
  values: ReadonlyArray<number | bigint | null>,
  backing:
    | Float64Array
    | Float32Array
    | Int32Array
    | BigInt64Array
    | BigUint64Array,
): ArrowVectorLike {
  const nullCount = values.filter((v) => v === null).length;
  return {
    length: values.length,
    nullCount,
    toArray: () => backing,
    get: (i) => values[i] ?? null,
  };
}

/** Value column backed by a `Float64Array` (Arrow `Float64`, the adopt path). */
function f64(values: ReadonlyArray<number | null>): ArrowVectorLike {
  const backing = Float64Array.from(values.map((v) => (v == null ? NaN : v)));
  return vector(values, backing);
}

/** int64 column (Arrow `Int64` / `Timestamp`) — backed by a `BigInt64Array`. */
function i64(values: ReadonlyArray<bigint | null>): ArrowVectorLike {
  const backing = BigInt64Array.from(values.map((v) => v ?? 0n));
  return vector(values, backing);
}

/**
 * String column (Arrow `Utf8`) — `toArray()` returns a plain `Array`, the shape
 * that tells fromArrow to build a `StringColumn`.
 */
function str(values: ReadonlyArray<string | null>): ArrowVectorLike {
  return {
    length: values.length,
    nullCount: values.filter((v) => v === null).length,
    toArray: () => values.slice(),
    get: (i) => values[i] ?? null,
  };
}

interface FieldSpec {
  name: string;
  vector: ArrowVectorLike;
  /** Arrow `TimeUnit` ordinal, set on a timestamp field's type. */
  unit?: number;
}

function table(
  numRows: number,
  specs: ReadonlyArray<FieldSpec>,
): ArrowTableLike {
  const byName = new Map(specs.map((s) => [s.name, s.vector]));
  return {
    numRows,
    schema: {
      fields: specs.map((s) => ({
        name: s.name,
        type: s.unit === undefined ? {} : { unit: s.unit },
      })),
    },
    getChild: (name) => byName.get(name) ?? null,
  };
}

function build(
  numRows: number,
  specs: ReadonlyArray<FieldSpec>,
  options?: FromArrowOptions,
) {
  return TimeSeries.fromArrow(table(numRows, specs), options);
}

/** Read a whole value column as a plain array (`undefined` for missing). */
function col(
  series: ReturnType<typeof build>,
  name: string,
): Array<number | string | undefined> {
  const c = series.column(name as never);
  return Array.from({ length: series.length }, (_, i) => c.at(i));
}

describe('TimeSeries.fromArrow', () => {
  it('adopts Float64 columns and defaults the time key to the "time" field', () => {
    const series = build(3, [
      { name: 'time', vector: f64([0, 1000, 2000]) },
      { name: 'value', vector: f64([10, 20, 30]) },
    ]);
    expect(series.length).toBe(3);
    expect(series.schema.map((c) => [c.name, c.kind])).toEqual([
      ['time', 'time'],
      ['value', 'number'],
    ]);
    expect(col(series, 'value')).toEqual([10, 20, 30]);
    expect(series.first()!.key().begin()).toBe(0);
    expect(series.last()!.key().begin()).toBe(2000);
  });

  it('adopts the Float64 backing array zero-copy (no defensive copy)', () => {
    const backing = Float64Array.from([1, 2, 3]);
    const valueVec: ArrowVectorLike = {
      length: 3,
      nullCount: 0,
      toArray: () => backing,
      get: (i) => backing[i]!,
    };
    const series = build(3, [
      { name: 'time', vector: f64([0, 1, 2]) },
      { name: 'value', vector: valueVec },
    ]);
    // Mutating the adopted buffer is visible through the series — proves the
    // Float64Array was adopted, not copied (the documented zero-copy path).
    backing[0] = 999;
    expect(series.column('value').at(0)).toBe(999);
  });

  it('converts int64 timestamps BigInt-free (two-int32 recombination)', () => {
    // Real millisecond epoch stamps around 2023 — exercise the hi/lo split
    // (values well above 2^32 so the high word is non-zero).
    const base = 1_700_000_000_000n;
    const series = build(3, [
      { name: 'time', vector: i64([base, base + 1000n, base + 2000n]) },
      { name: 'value', vector: f64([1, 2, 3]) },
    ]);
    expect([
      series.at(0)!.key().begin(),
      series.at(1)!.key().begin(),
      series.at(2)!.key().begin(),
    ]).toEqual([Number(base), Number(base) + 1000, Number(base) + 2000]);
  });

  it('scales the time unit from the Arrow Timestamp field (seconds → ms)', () => {
    const series = build(2, [
      { name: 'time', vector: i64([1_700_000_000n, 1_700_000_060n]), unit: 0 },
      { name: 'value', vector: f64([1, 2]) },
    ]);
    expect(series.at(0)!.key().begin()).toBe(1_700_000_000_000);
    expect(series.at(1)!.key().begin()).toBe(1_700_000_060_000);
  });

  it('scales microseconds and nanoseconds to ms', () => {
    const us = build(1, [
      { name: 'time', vector: i64([1_700_000_000_000_000n]), unit: 2 },
      { name: 'v', vector: f64([1]) },
    ]);
    expect(us.at(0)!.key().begin()).toBe(1_700_000_000_000);

    const ns = build(1, [
      { name: 'time', vector: i64([1_700_000_000_000_000_000n]), unit: 3 },
      { name: 'v', vector: f64([1]) },
    ]);
    // ns → ms loses sub-ms precision; ms magnitude is exact.
    expect(ns.at(0)!.key().begin()).toBeCloseTo(1_700_000_000_000, 0);
  });

  it('honours an explicit timeUnit over the field-declared unit', () => {
    const series = build(
      1,
      [
        // Field declares milliseconds (unit 1) but the caller overrides to s.
        { name: 'time', vector: i64([1_700_000_000n]), unit: 1 },
        { name: 'v', vector: f64([1]) },
      ],
      { timeUnit: 'second' },
    );
    expect(series.at(0)!.key().begin()).toBe(1_700_000_000_000);
  });

  it('names the time column explicitly via { time }', () => {
    const series = build(
      2,
      [
        { name: 'ts', vector: f64([0, 5]) },
        { name: 'price', vector: f64([100, 101]) },
      ],
      { time: 'ts' },
    );
    expect(series.schema[0]!.name).toBe('ts');
    expect(col(series, 'price')).toEqual([100, 101]);
  });

  it('maps nulls in value columns to NaN (missing), not 0', () => {
    const series = build(3, [
      { name: 'time', vector: f64([0, 1, 2]) },
      { name: 'value', vector: f64([10, null, 30]) },
    ]);
    expect(series.column('value').at(1)).toBeUndefined();
    expect(col(series, 'value')).toEqual([10, undefined, 30]);
  });

  it('selects a numeric subset (in order) via { columns }', () => {
    const series = build(
      2,
      [
        { name: 'time', vector: f64([0, 1]) },
        { name: 'a', vector: f64([1, 2]) },
        { name: 'b', vector: f64([3, 4]) },
        { name: 'c', vector: f64([5, 6]) },
      ],
      { columns: ['c', 'a'] },
    );
    expect(series.schema.map((c) => c.name)).toEqual(['time', 'c', 'a']);
  });

  it('sorts an unordered table with { sort: true }', () => {
    const series = build(
      3,
      [
        { name: 'time', vector: f64([20, 0, 10]) },
        { name: 'value', vector: f64([2, 0, 1]) },
      ],
      { sort: true },
    );
    expect([
      series.at(0)!.key().begin(),
      series.at(1)!.key().begin(),
      series.at(2)!.key().begin(),
    ]).toEqual([0, 10, 20]);
    expect(col(series, 'value')).toEqual([0, 1, 2]);
  });

  it('converts Int32 / Float32 value columns to Float64', () => {
    const i32 = vector([1, 2, 3], Int32Array.from([1, 2, 3]));
    const f32 = vector([1.5, 2.5, 3.5], Float32Array.from([1.5, 2.5, 3.5]));
    const series = build(3, [
      { name: 'time', vector: f64([0, 1, 2]) },
      { name: 'count', vector: i32 },
      { name: 'ratio', vector: f32 },
    ]);
    expect(col(series, 'count')).toEqual([1, 2, 3]);
    expect(col(series, 'ratio')).toEqual([1.5, 2.5, 3.5]);
  });

  it('ingests Utf8 columns as string columns alongside numerics', () => {
    const series = build(3, [
      { name: 'time', vector: f64([0, 1, 2]) },
      { name: 'symbol', vector: str(['AAPL', 'MSFT', 'AAPL']) },
      { name: 'price', vector: f64([100, 200, 110]) },
    ]);
    expect(series.schema.map((c) => [c.name, c.kind])).toEqual([
      ['time', 'time'],
      ['symbol', 'string'],
      ['price', 'number'],
    ]);
    expect(col(series, 'symbol')).toEqual(['AAPL', 'MSFT', 'AAPL']);
    expect(col(series, 'price')).toEqual([100, 200, 110]);
  });

  it('maps nulls in string columns to missing', () => {
    const series = build(3, [
      { name: 'time', vector: f64([0, 1, 2]) },
      { name: 'label', vector: str(['a', null, 'c']) },
    ]);
    expect(col(series, 'label')).toEqual(['a', undefined, 'c']);
  });

  it('keeps string columns aligned when sorting by key', () => {
    const series = build(
      3,
      [
        { name: 'time', vector: f64([20, 0, 10]) },
        { name: 'symbol', vector: str(['c', 'a', 'b']) },
      ],
      { sort: true },
    );
    expect(col(series, 'symbol')).toEqual(['a', 'b', 'c']);
  });

  describe('errors', () => {
    it('throws when no time column can be resolved', () => {
      expect(() => build(1, [{ name: 'value', vector: f64([1]) }])).toThrow(
        /no time column/,
      );
    });

    it('throws naming a column that is neither numeric nor string', () => {
      // A list/struct vector: toArray() yields an Array of non-string objects.
      const listVec: ArrowVectorLike = {
        length: 2,
        nullCount: 0,
        toArray: () => [[1, 2], [3]],
        get: () => null,
      };
      expect(() =>
        build(2, [
          { name: 'time', vector: f64([0, 1]) },
          { name: 'tags', vector: listVec },
        ]),
      ).toThrow(/'tags' has a non-string value/);
    });

    it('throws on a null in the time key', () => {
      expect(() =>
        build(2, [
          { name: 'time', vector: i64([0n, null]) },
          { name: 'value', vector: f64([1, 2]) },
        ]),
      ).toThrow(/time column 'time' has 1 null/);
    });

    it('throws when an explicit time column is missing', () => {
      expect(() =>
        build(1, [{ name: 'value', vector: f64([1]) }], { time: 'ts' }),
      ).toThrow(/time column 'ts' not found/);
    });

    it('throws on an empty table', () => {
      expect(() => build(0, [])).toThrow(/no columns/);
    });
  });
});
