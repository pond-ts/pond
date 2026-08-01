import { describe, expect, it } from 'vitest';
import {
  Binary,
  Bool,
  DateDay,
  Decimal,
  Float16,
  Float32,
  Float64,
  Int32,
  Int64,
  Null,
  Table,
  TimeUnit,
  Timestamp,
  Uint8,
  Utf8,
  makeData,
  makeVector,
  vectorFromArray,
} from 'apache-arrow';
import { TimeSeries, ValidationError, ValueSeries } from '../src/index.js';

/**
 * **The Arrow type support matrix**, against real `apache-arrow`.
 *
 * `fromArrow` reads a column by the *runtime shape* of `vector.toArray()`,
 * which is correct for the types below and **silently wrong** outside them —
 * Arrow's physical layouts do not all store one machine word per logical
 * value. Two measured cases before the declared-type gate existed:
 *
 * - `Decimal128(scale 2)` — 4 `uint32` words per value. A dense column threw a
 *   *length mismatch* (right outcome, wrong reason); a column with **one null**
 *   took the per-element path, matched on length, and ingested `123.45` as
 *   `12345`.
 * - `Float16` — one `uint16` word that isn't an integer. Length matched, so
 *   nothing caught it: `1.5` ingested as `15872`, its half-float bit pattern.
 *
 * These tests pin the whole matrix, supported and refused alike, so a future
 * change to the reader can't quietly re-open the silent-corruption class.
 */

function tableWith(column: ReturnType<typeof vectorFromArray>, rows: number) {
  return new Table({
    time: makeVector(Float64Array.from({ length: rows }, (_, i) => i * 1000)),
    col: column,
  }) as never;
}

/** A `Decimal128` vector — `values` are the raw unscaled integers. */
function decimalVector(values: number[], nullBitmap?: Uint8Array) {
  const words = new Uint32Array(values.length * 4);
  values.forEach((v, i) => (words[i * 4] = v));
  return makeVector(
    makeData({
      type: new Decimal(10, 2, 128),
      length: values.length,
      data: words,
      nullCount: nullBitmap ? 1 : 0,
      nullBitmap,
    }),
  );
}

describe('fromArrow — supported types read correctly', () => {
  const cases: Array<[string, ReturnType<typeof vectorFromArray>, unknown[]]> =
    [
      ['Float64', vectorFromArray([1.5, 2.5], new Float64()), [1.5, 2.5]],
      ['Float32', vectorFromArray([1.5, 2.5], new Float32()), [1.5, 2.5]],
      ['Int32', vectorFromArray([1, 2], new Int32()), [1, 2]],
      ['Int64', vectorFromArray([1n, 2n], new Int64()), [1, 2]],
      ['Uint8', vectorFromArray([1, 2], new Uint8()), [1, 2]],
      ['Utf8', vectorFromArray(['a', 'b'], new Utf8()), ['a', 'b']],
      // Arrow's idiomatic low-cardinality string encoding — and what pond's own
      // `toArrow` emits, so this row is the export/ingest round trip.
      ['Dictionary<Utf8>', vectorFromArray(['a', 'b']), ['a', 'b']],
      [
        'Date32',
        vectorFromArray([new Date(0), new Date(86_400_000)], new DateDay()),
        [0, 86_400_000],
      ],
      [
        'Timestamp(ms)',
        vectorFromArray([1000n, 2000n], new Timestamp(TimeUnit.MILLISECOND)),
        [1000, 2000],
      ],
    ];

  for (const [label, vector, expected] of cases) {
    it(`reads ${label}`, () => {
      const series = TimeSeries.fromArrow(tableWith(vector, expected.length));
      expect(series.toColumns().columns.col).toEqual(expected);
    });
  }
});

describe('fromArrow — refused types name themselves', () => {
  it('Decimal — dense (was: a misleading length-mismatch error)', () => {
    const fail = () =>
      TimeSeries.fromArrow(tableWith(decimalVector([150, 250]), 2));
    expect(fail).toThrow(ValidationError);
    expect(fail).toThrow(/column 'col' has Arrow type Decimal/);
    expect(fail).toThrow(/cannot round-trip exactly/);
  });

  it('Decimal — with a null (was: SILENT, 123.45 ingesting as 12345)', () => {
    // The dangerous one: this path produced exactly `rows` values, so the
    // length check never fired and the raw unscaled integer went straight in.
    const bitmap = new Uint8Array([0b00000001]);
    const fail = () =>
      TimeSeries.fromArrow(tableWith(decimalVector([12345, 0], bitmap), 2));
    expect(fail).toThrow(/column 'col' has Arrow type Decimal/);
  });

  it('Float16 — (was: SILENT, 1.5 ingesting as 15872)', () => {
    // Length matched, so only the declared type distinguishes it from Float64.
    const fail = () =>
      TimeSeries.fromArrow(
        tableWith(vectorFromArray([1.5, 2.5], new Float16()), 2),
      );
    expect(fail).toThrow(/column 'col' has Arrow type Float/);
    expect(fail).toThrow(/cast it to Float32 or Float64/);
  });

  it('Bool — names the ingest-engine reason, not a shape one', () => {
    const fail = () =>
      TimeSeries.fromArrow(
        tableWith(vectorFromArray([true, false], new Bool()), 2),
      );
    expect(fail).toThrow(/has Arrow type Bool/);
    expect(fail).toThrow(/'number' and 'string' value columns only/);
  });

  it('Binary', () => {
    const fail = () =>
      TimeSeries.fromArrow(
        tableWith(vectorFromArray([new Uint8Array([1])], new Binary()), 1),
      );
    expect(fail).toThrow(/has Arrow type Binary/);
  });

  it('Null', () => {
    const fail = () =>
      TimeSeries.fromArrow(
        tableWith(vectorFromArray([null, null], new Null()), 2),
      );
    expect(fail).toThrow(/has Arrow type Null/);
    expect(fail).toThrow(/carries no values to read/);
  });

  it('List and Struct', () => {
    expect(() =>
      TimeSeries.fromArrow(
        tableWith(vectorFromArray([[1, 2], [3]]) as never, 2),
      ),
    ).toThrow(/has Arrow type List/);
    expect(() =>
      TimeSeries.fromArrow(tableWith(vectorFromArray([{ a: 1 }]) as never, 1)),
    ).toThrow(/has Arrow type Struct/);
  });
});

describe('fromArrow — the key is gated too', () => {
  it('refuses a Decimal time key', () => {
    const table = new Table({ time: decimalVector([0, 1000]) }) as never;
    expect(() => TimeSeries.fromArrow(table)).toThrow(
      /column 'time' has Arrow type Decimal, which pond cannot read as a key/,
    );
  });

  it('refuses a Utf8 key, and says to pass it as a value column', () => {
    const table = new Table({
      time: vectorFromArray(['a', 'b'], new Utf8()),
    }) as never;
    expect(() => TimeSeries.fromArrow(table)).toThrow(
      /cannot read as a key.*pass it as a value column instead/s,
    );
  });

  it('refuses a Decimal value axis on the ValueSeries door', () => {
    const table = new Table({
      strike: makeVector(Float64Array.from([90, 95])),
      iv: decimalVector([31, 27]),
    }) as never;
    expect(() => ValueSeries.fromArrow(table, { axis: 'strike' })).toThrow(
      /column 'iv' has Arrow type Decimal/,
    );
  });

  it('refuses a Float16 axis', () => {
    const table = new Table({
      strike: vectorFromArray([1.5, 2.5], new Float16()),
    }) as never;
    expect(() => ValueSeries.fromArrow(table, { axis: 'strike' })).toThrow(
      /column 'strike' has Arrow type Float, which pond cannot read as a key/,
    );
  });
});
