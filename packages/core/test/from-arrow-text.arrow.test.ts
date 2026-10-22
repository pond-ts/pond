/**
 * `fromArrow` reads `Utf8` / `Dictionary<Utf8>` value columns straight from
 * their buffers ([PND-ARROWTEXT]). Each case checks the result against what
 * the old path built: apache-arrow's own `toArray()` per row, then
 * `stringColumnFromArray` over those strings.
 */
import { describe, expect, it } from 'vitest';
import {
  Dictionary,
  Int8,
  Int32,
  Table,
  Utf8,
  Vector,
  makeData,
  makeVector,
  vectorFromArray,
} from 'apache-arrow';
import { TimeSeries, ValueSeries } from '../src/index.js';
import {
  type StringColumn,
  stringColumnFromArray,
} from '../src/columnar/index.js';

const enc = new TextEncoder();

/** A `Utf8` chunk from raw bytes per row (`null` = a null row). */
function utf8Data(cells: ReadonlyArray<Uint8Array | null>) {
  const n = cells.length;
  const offsets = new Int32Array(n + 1);
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    offsets[i] = total;
    total += cells[i]?.length ?? 0;
  }
  offsets[n] = total;
  const bytes = new Uint8Array(total);
  const bitmap = new Uint8Array(Math.ceil(n / 8) + 8);
  let nulls = 0;
  cells.forEach((c, i) => {
    if (c === null) nulls += 1;
    else {
      bytes.set(c, offsets[i]!);
      bitmap[i >> 3]! |= 1 << (i & 7);
    }
  });
  return makeData({
    type: new Utf8(),
    length: n,
    nullCount: nulls,
    ...(nulls > 0 ? { nullBitmap: bitmap } : {}),
    valueOffsets: offsets,
    data: bytes,
  });
}

function tableWith(column: Vector) {
  const time = new Float64Array(column.length).map((_, i) => i);
  return new Table({ time: makeVector(time), s: column });
}

/** The old path's answer for a column. */
function expected(column: Vector): StringColumn {
  const raw = column.toArray() as Array<string | null>;
  return stringColumnFromArray(raw);
}

function describeColumn(c: StringColumn) {
  return {
    dictionary: c.dictionary === undefined ? undefined : [...c.dictionary],
    indices:
      c.indices === undefined
        ? undefined
        : [...c.indices].map((v, i) =>
            c.validity && !c.validity.isDefined(i) ? null : v,
          ),
    fallback: c.fallback === undefined ? undefined : [...c.fallback],
    values: Array.from({ length: c.length }, (_, i) => c.read(i)),
  };
}

function check(column: Vector) {
  const series = TimeSeries.fromArrow(tableWith(column));
  const got = series.column('s') as StringColumn;
  expect(got.kind).toBe('string');
  expect(describeColumn(got)).toEqual(describeColumn(expected(column)));
  return got;
}

describe('fromArrow text columns read from buffers', () => {
  it('decodes like apache-arrow: byte-order mark dropped, bad bytes → U+FFFD', () => {
    const cells = [
      enc.encode('﻿bom'),
      new Uint8Array([0xef, 0xbb, 0xbf, 0x41]),
      enc.encode('A'),
      new Uint8Array([0xff]),
      new Uint8Array([0xfe]),
      enc.encode('�'),
      enc.encode('日本'),
      enc.encode(''),
      null,
      enc.encode('x'.repeat(10_000)),
    ];
    const got = check(makeVector(utf8Data(cells)));
    // Three byte runs decode to 'A' / U+FFFD each and are merged by text.
    expect(got.read(1)).toBe('A');
    expect(got.read(3)).toBe('�');
    expect(got.read(4)).toBe('�');
    expect(got.read(8)).toBeUndefined();
    expect(got.read(7)).toBe('');
  });

  it('picks dictionary or plain storage the same way', () => {
    const low = Array.from({ length: 40 }, (_, i) => `k${i % 3}`);
    const high = Array.from({ length: 40 }, (_, i) => `u${i}`);
    expect(check(vectorFromArray(low, new Utf8())).dictionary).toEqual([
      'k0',
      'k1',
      'k2',
    ]);
    expect(check(vectorFromArray(high, new Utf8())).fallback).toBeDefined();
    // Under 16 rows stays plain even with one value.
    expect(
      check(vectorFromArray(['a', 'a', 'a'], new Utf8())).fallback,
    ).toBeDefined();
  });

  it('handles a slice (null bits at an offset) and several chunks', () => {
    const cells = Array.from({ length: 50 }, (_, i) =>
      i % 7 === 0 ? null : enc.encode(`v${i % 5}`),
    );
    check(makeVector(utf8Data(cells)).slice(3, 41));
    check(
      new Vector([utf8Data(cells.slice(0, 20)), utf8Data(cells.slice(20))]),
    );
  });

  it('keeps more distinct values than the first hash table holds', () => {
    const values = Array.from({ length: 5000 }, (_, i) => `id-${i % 3000}`);
    check(vectorFromArray(values, new Utf8()));
  });

  it('switches to row-by-row decoding once most rows are distinct', () => {
    // Past 65,536 rows with most of them distinct, the rest of the column is
    // decoded as strings (an all-ASCII chunk in one call, sliced per row).
    const cells = Array.from({ length: 140_000 }, (_, i) =>
      i % 11 === 0 ? null : enc.encode(i === 100_000 ? 'é-日本' : `id-${i}`),
    );
    const ascii = cells.map((c, i) => (i === 100_000 ? enc.encode('z') : c));
    check(makeVector(utf8Data(ascii)));
    check(
      new Vector([
        utf8Data(cells.slice(0, 70_000)),
        utf8Data(cells.slice(70_000, 120_000)),
        utf8Data(cells.slice(120_000)),
      ]),
    );
    check(makeVector(utf8Data(ascii)).slice(5, 139_000));
  });

  it('reads Dictionary<Utf8>: repeated and null entries, null rows', () => {
    const dictionary = makeVector(
      utf8Data([enc.encode('b'), null, enc.encode('a'), enc.encode('b')]),
    );
    const indices = new Int8Array(40).map((_, i) => (i * 7) % 4);
    const bitmap = new Uint8Array(13).fill(0xff);
    bitmap[0] = 0b1111_1011; // row 2 null
    const data = makeData({
      type: new Dictionary(new Utf8(), new Int8()),
      length: 40,
      nullCount: 1,
      nullBitmap: bitmap,
      data: indices,
      dictionary,
    });
    const got = check(makeVector(data));
    // 'b' twice in the dictionary is one value.
    expect(got.dictionary).toEqual(['b', 'a']);
    check(
      vectorFromArray(
        ['x', 'y', null, 'x'],
        new Dictionary(new Utf8(), new Int32()),
      ),
    );
  });

  it('turns an all-null or empty text column into a number column, as before', () => {
    for (const column of [
      vectorFromArray([null, null], new Utf8()),
      vectorFromArray([], new Utf8()),
    ]) {
      const series = TimeSeries.fromArrow(tableWith(column));
      expect(series.schema[1]).toEqual({ name: 's', kind: 'number' });
      expect(series.column('s')!.kind).toBe('number');
    }
  });

  it('sorts rows under ordering: reorder', () => {
    const table = new Table({
      time: makeVector(new Float64Array([3, 1, 2])),
      s: vectorFromArray(['c', null, 'b'], new Utf8()),
    });
    const series = TimeSeries.fromArrow(table, { ordering: 'reorder' });
    expect(series.toArray().map((e) => e.get('s'))).toEqual([
      undefined,
      'b',
      'c',
    ]);
  });

  it('reads interval labels and ValueSeries columns too', () => {
    const table = new Table({
      interval: makeVector(new Float64Array([0, 10])),
      intervalEnd: makeVector(new Float64Array([5, 15])),
      intervalLabel: vectorFromArray(['p', '﻿q'], new Utf8()),
      s: vectorFromArray(['m', 'n'], new Utf8()),
    });
    const series = TimeSeries.fromArrow(table, { keyKind: 'interval' });
    expect(series.toArray().map((e) => [e.key().value, e.get('s')])).toEqual([
      ['p', 'm'],
      ['q', 'n'],
    ]);
    const vs = ValueSeries.fromArrow(
      new Table({
        axis: makeVector(new Float64Array([1, 2])),
        s: vectorFromArray(['x', null], new Utf8()),
      }),
      { axis: 'axis' },
    );
    expect(vs.toJSON().rows).toEqual([
      [1, 'x'],
      [2, null],
    ]);
  });
});
