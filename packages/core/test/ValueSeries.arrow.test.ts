import { describe, expect, it } from 'vitest';
import {
  Float64,
  Int64,
  Table,
  Utf8,
  makeData,
  makeVector,
  tableFromArrays,
  tableFromIPC,
  tableToIPC,
  vectorFromArray,
} from 'apache-arrow';
import { ValidationError, ValueSeries } from '../src/index.js';
import type { Float64Column } from '../src/index.js';

/**
 * `ValueSeries.fromArrow` / `toArrow` — the Arrow doors on the value axis,
 * against REAL apache-arrow tables (structural fakes can't validate what
 * `Vector.toArray()` actually hands back per column kind, which is exactly
 * what the duck-typed reader depends on).
 *
 * The value door differs from the time one in three ways, and those are what
 * these tests pin: the axis is named explicitly (no `'time'` convention), it
 * is read **unscaled** (an axis carries no `TimeUnit`), and `schema[0]` comes
 * out `'value'`-kind — a `ValueSeries`, not a `TimeSeries` whose clock holds
 * strike prices.
 */

const CHAIN = [
  { name: 'strike', kind: 'value' },
  { name: 'iv', kind: 'number' },
  { name: 'venue', kind: 'string' },
] as const;

function readCol(
  vs: ValueSeries<never>,
  name: string,
): Array<number | string | boolean | undefined> {
  const c = vs.column(name as never)!;
  return Array.from({ length: vs.length }, (_, i) => c.read(i));
}

describe('ValueSeries.fromArrow', () => {
  it('keys on the named axis and derives a value-kind schema', () => {
    const table = new Table({
      strike: vectorFromArray([90, 95, 100], new Float64()),
      iv: vectorFromArray([0.31, 0.27, 0.25], new Float64()),
      venue: vectorFromArray(['cme', 'cme', 'ice'], new Utf8()),
    });
    const vs = ValueSeries.fromArrow(table as never, {
      name: 'chain',
      axis: 'strike',
    });
    expect(vs).toBeInstanceOf(ValueSeries);
    expect(vs.name).toBe('chain');
    expect(vs.axisName).toBe('strike');
    expect(vs.schema.map((c) => [c.name, c.kind])).toEqual([
      ['strike', 'value'],
      ['iv', 'number'],
      ['venue', 'string'],
    ]);
    expect(Array.from(vs.axisValues())).toEqual([90, 95, 100]);
    expect(readCol(vs as never, 'iv')).toEqual([0.31, 0.27, 0.25]);
    expect(readCol(vs as never, 'venue')).toEqual(['cme', 'cme', 'ice']);
  });

  it("defaults the name to 'arrow'", () => {
    const table = tableFromArrays({ strike: Float64Array.from([1, 2]) });
    expect(ValueSeries.fromArrow(table as never, { axis: 'strike' }).name).toBe(
      'arrow',
    );
  });

  it('takes an int64 axis at face value — no unit scaling', () => {
    // The time door would read a Timestamp's raw int64 through its TimeUnit.
    // An axis has no unit: 90 means 90, not 90 seconds.
    const table = new Table({
      strike: vectorFromArray([90n, 95n], new Int64()),
      iv: vectorFromArray([0.31, 0.27], new Float64()),
    });
    const vs = ValueSeries.fromArrow(table as never, { axis: 'strike' });
    expect(Array.from(vs.axisValues())).toEqual([90, 95]);
  });

  it('adopts a single-chunk Float64 axis buffer zero-copy', () => {
    const axis = Float64Array.from([90, 95, 100]);
    const table = tableFromArrays({
      strike: axis,
      iv: Float64Array.from([0.31, 0.27, 0.25]),
    });
    const vs = ValueSeries.fromArrow(table as never, { axis: 'strike' });
    // Same memory, not a copy — the point of the columnar door.
    expect(vs.axisValues().buffer).toBe(
      (table.getChild('strike')!.toArray() as Float64Array).buffer,
    );
  });

  it('reads nulls in a value column as gaps', () => {
    const table = new Table({
      strike: vectorFromArray([90, 95, 100], new Float64()),
      iv: vectorFromArray([0.31, null, 0.25], new Float64()),
      venue: vectorFromArray(['cme', null, 'ice'], new Utf8()),
    });
    const vs = ValueSeries.fromArrow(table as never, { axis: 'strike' });
    expect(readCol(vs as never, 'iv')).toEqual([0.31, undefined, 0.25]);
    expect(readCol(vs as never, 'venue')).toEqual(['cme', undefined, 'ice']);
  });

  it('selects a column subset, in the given order', () => {
    const table = new Table({
      strike: vectorFromArray([90, 95], new Float64()),
      iv: vectorFromArray([0.31, 0.27], new Float64()),
      oi: vectorFromArray([120, 340], new Float64()),
    });
    const vs = ValueSeries.fromArrow(table as never, {
      axis: 'strike',
      columns: ['oi'],
    });
    expect(vs.schema.map((c) => c.name)).toEqual(['strike', 'oi']);
  });

  it('sorts an unordered table when asked', () => {
    const table = new Table({
      strike: vectorFromArray([100, 90, 95], new Float64()),
      iv: vectorFromArray([0.25, 0.31, 0.27], new Float64()),
    });
    const vs = ValueSeries.fromArrow(table as never, {
      axis: 'strike',
      sort: true,
    });
    expect(Array.from(vs.axisValues())).toEqual([90, 95, 100]);
    expect(readCol(vs as never, 'iv')).toEqual([0.31, 0.27, 0.25]);
  });

  it('round-trips through IPC bytes', () => {
    const source = tableFromArrays({
      strike: Float64Array.from([90, 95, 100]),
      iv: Float64Array.from([0.31, 0.27, 0.25]),
    });
    const vs = ValueSeries.fromArrow(
      tableFromIPC(tableToIPC(source)) as never,
      { axis: 'strike' },
    );
    expect(Array.from(vs.axisValues())).toEqual([90, 95, 100]);
    expect(readCol(vs as never, 'iv')).toEqual([0.31, 0.27, 0.25]);
  });

  describe('rejects', () => {
    const table = () =>
      new Table({
        strike: vectorFromArray([90, 95], new Float64()),
        iv: vectorFromArray([0.31, 0.27], new Float64()),
      });

    it('a missing axis option', () => {
      expect(() =>
        ValueSeries.fromArrow(table() as never, {} as never),
      ).toThrow(/no axis column — pass \{ axis: '<column>' \}/);
    });

    it('an axis naming a field the table does not have', () => {
      expect(() =>
        ValueSeries.fromArrow(table() as never, { axis: 'nope' }),
      ).toThrow(/axis column 'nope' not found in the table schema/);
    });

    it('a null in the axis', () => {
      const withNull = new Table({
        strike: vectorFromArray([90, null, 100], new Float64()),
        iv: vectorFromArray([0.31, 0.27, 0.25], new Float64()),
      });
      expect(() =>
        ValueSeries.fromArrow(withNull as never, { axis: 'strike' }),
      ).toThrow(/axis column 'strike' has 1 null value\(s\)/);
    });

    it('a non-numeric axis column', () => {
      const strings = new Table({
        strike: vectorFromArray(['a', 'b'], new Utf8()),
        iv: vectorFromArray([0.31, 0.27], new Float64()),
      });
      expect(
        () => ValueSeries.fromArrow(strings as never, { axis: 'strike' }),
        // Refused on its declared type, before any bytes are read.
      ).toThrow(
        /column 'strike' has Arrow type Utf8, which pond cannot read as a key/,
      );
    });

    it('the axis listed again as a value column', () => {
      expect(() =>
        ValueSeries.fromArrow(table() as never, {
          axis: 'strike',
          columns: ['strike'],
        }),
      ).toThrow(/column 'strike' is the axis and can't also be a value column/);
    });

    it('a value column the table does not have', () => {
      expect(() =>
        ValueSeries.fromArrow(table() as never, {
          axis: 'strike',
          columns: ['nope'],
        }),
      ).toThrow(/column 'nope' not found in the table/);
    });

    it('an out-of-order axis without sort, naming the axis noun', () => {
      const unordered = new Table({
        strike: vectorFromArray([100, 90], new Float64()),
        iv: vectorFromArray([0.25, 0.31], new Float64()),
      });
      const fail = () =>
        ValueSeries.fromArrow(unordered as never, { axis: 'strike' });
      expect(fail).toThrow(ValidationError);
      expect(fail).toThrow(/fromArrow: key column 'strike' is out of order/);
      expect(fail).toThrow(/axis values must be non-decreasing/);
    });

    it('an empty table', () => {
      expect(() =>
        ValueSeries.fromArrow(new Table({}) as never, { axis: 'strike' }),
      ).toThrow(/table has no columns/);
    });
  });
});

describe('ValueSeries.toArrow', () => {
  it('exports the axis as a plain float64 field, not a timestamp', () => {
    const vs = ValueSeries.fromColumns({
      name: 'chain',
      schema: CHAIN,
      columns: {
        strike: [90, 95, 100],
        iv: [0.31, 0.27, 0.25],
        venue: ['cme', 'cme', 'ice'],
      },
    });
    const out = vs.toArrow();
    expect(out.length).toBe(3);
    // `venue` is `'utf8'`, not `'dictionary'`: pond's dict-encode heuristic
    // doesn't pay at three rows. The point of this assertion is the axis —
    // a `'value'` key exports as a plain `float64` field, where a time key
    // would have come out `'timestamp'`.
    expect(out.fields.map((f) => [f.name, f.type])).toEqual([
      ['strike', 'float64'],
      ['iv', 'float64'],
      ['venue', 'utf8'],
    ]);
  });

  it('hands over the live buffers — no copy', () => {
    const axis = Float64Array.from([90, 95, 100]);
    const vs = ValueSeries.fromColumns({
      name: 'chain',
      schema: [
        { name: 'strike', kind: 'value' },
        { name: 'iv', kind: 'number' },
      ] as const,
      columns: { strike: axis, iv: Float64Array.from([0.31, 0.27, 0.25]) },
    });
    const field = vs.toArrow().fields.find((f) => f.name === 'strike')!;
    expect(field.values).toBe(vs.axisValues());
    expect((field.values as Float64Array).buffer).toBe(axis.buffer);
  });

  it('selects a column subset', () => {
    const vs = ValueSeries.fromColumns({
      name: 'chain',
      schema: CHAIN,
      columns: {
        strike: [90, 95],
        iv: [0.31, 0.27],
        venue: ['cme', 'ice'],
      },
    });
    expect(vs.toArrow({ columns: ['iv'] }).fields.map((f) => f.name)).toEqual([
      'strike',
      'iv',
    ]);
  });

  it('carries the validity bitmap for a gapped column', () => {
    const vs = ValueSeries.fromColumns({
      name: 'chain',
      schema: [
        { name: 'strike', kind: 'value' },
        { name: 'iv', kind: 'number', required: false },
      ] as const,
      columns: { strike: [90, 95, 100], iv: [0.31, null, 0.25] },
    });
    const field = vs.toArrow().fields.find((f) => f.name === 'iv')!;
    expect(field.nullCount).toBe(1);
    expect(field.nullBitmap).toBeInstanceOf(Uint8Array);
  });

  it('exports the slice, not the source rows behind it', () => {
    const vs = ValueSeries.fromColumns({
      name: 'chain',
      schema: [
        { name: 'strike', kind: 'value' },
        { name: 'iv', kind: 'number' },
      ] as const,
      columns: { strike: [90, 95, 100], iv: [0.31, 0.27, 0.25] },
    });
    const out = vs.sliceByValue(95, 200).toArrow();
    expect(out.length).toBe(2);
    const strike = out.fields.find((f) => f.name === 'strike')!;
    expect(Array.from(strike.values as Float64Array)).toEqual([95, 100]);
  });

  it('toArrow → real Table → fromArrow keeps the original storage', () => {
    // The pair's reason to exist, end to end — the value-axis counterpart of
    // the TimeSeries round trip: export, assemble a REAL Arrow table from the
    // handed-over buffers, re-import, and the result is backed by the ORIGINAL
    // series' memory rather than merely equal to it.
    const vs = ValueSeries.fromColumns({
      name: 'chain',
      schema: [
        { name: 'strike', kind: 'value' },
        { name: 'iv', kind: 'number', required: false },
      ] as const,
      columns: {
        strike: Float64Array.from([90, 95, 100, 105]),
        iv: [0.31, null, 0.25, 0.26],
      },
    });
    const out = vs.toArrow();
    const strike = out.fields.find((f) => f.name === 'strike')!;
    const iv = out.fields.find((f) => f.name === 'iv')!;
    const table = new Table({
      strike: makeVector(
        makeData({
          type: new Float64(),
          length: strike.length,
          data: strike.values as Float64Array,
        }),
      ),
      iv: makeVector(
        makeData({
          type: new Float64(),
          length: iv.length,
          nullCount: iv.nullCount,
          nullBitmap: iv.nullBitmap,
          data: iv.values as Float64Array,
        }),
      ),
    });

    const back = ValueSeries.fromArrow(table as never, {
      name: 'chain',
      axis: 'strike',
    });
    const before = vs.column('iv') as unknown as Float64Column;
    const after = back.column('iv' as never) as unknown as Float64Column;
    // The value column survives as the SAME buffer (the null-bearing adopt
    // path), and the axis shares memory (arrow re-wraps the view per call).
    expect(after._values).toBe(before._values);
    expect(back.axisValues().buffer).toBe(vs.axisValues().buffer);
    expect(back.toRows()).toEqual(vs.toRows());
  });
});
