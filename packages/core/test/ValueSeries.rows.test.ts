import { describe, expect, it } from 'vitest';
import { TimeSeries, ValidationError, ValueSeries } from '../src/index.js';

/**
 * The `ValueSeries` **row** doors — `fromJSON` in, `toJSON` / `toRows` /
 * `toObjects` out. The columnar door already had a home
 * (`ValueSeries.fromColumns.test.ts`); this file pins the row shape: what the
 * strict door rejects, what a gap looks like on each side of the wire, and
 * that every export door round-trips back through its own ingress.
 */

const SMILE = [
  { name: 'strike', kind: 'value' },
  { name: 'iv', kind: 'number' },
  { name: 'venue', kind: 'string' },
] as const;

const SPARSE = [
  { name: 'strike', kind: 'value' },
  { name: 'iv', kind: 'number', required: false },
  { name: 'venue', kind: 'string', required: false },
] as const;

/** A ValueSeries carrying a `boolean` column — only reachable by projection. */
function projectedWithBoolean() {
  return new TimeSeries({
    name: 'ride',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'cumDist', kind: 'number' },
      { name: 'moving', kind: 'boolean' },
    ] as const,
    rows: [
      [0, 0, false],
      [1000, 500, true],
    ],
  }).byValue('cumDist');
}

function smile() {
  return ValueSeries.fromJSON({
    name: 'smile',
    schema: SMILE,
    rows: [
      [90, 0.31, 'cme'],
      [95, 0.27, 'cme'],
      [100, 0.25, 'ice'],
    ],
  });
}

describe('ValueSeries.fromJSON', () => {
  it('builds from tuple rows, keyed on the axis', () => {
    const vs = smile();
    expect(vs).toBeInstanceOf(ValueSeries);
    expect(vs.name).toBe('smile');
    expect(vs.axisName).toBe('strike');
    expect(vs.length).toBe(3);
    expect(Array.from(vs.axisValues())).toEqual([90, 95, 100]);
    expect(vs.column('iv')?.read(1)).toBe(0.27);
    expect(vs.column('venue')?.read(2)).toBe('ice');
  });

  it('builds from object rows keyed by column name', () => {
    const vs = ValueSeries.fromJSON({
      name: 'smile',
      schema: SMILE,
      rows: [
        { strike: 90, iv: 0.31, venue: 'cme' },
        { strike: 95, iv: 0.27, venue: 'cme' },
      ],
    });
    expect(Array.from(vs.axisValues())).toEqual([90, 95]);
    expect(vs.column('iv')?.read(0)).toBe(0.31);
    expect(vs.column('venue')?.read(1)).toBe('cme');
  });

  it('agrees with fromColumns cell for cell — one ingest engine', () => {
    const viaRows = smile();
    const viaColumns = ValueSeries.fromColumns({
      name: 'smile',
      schema: SMILE,
      columns: {
        strike: [90, 95, 100],
        iv: [0.31, 0.27, 0.25],
        venue: ['cme', 'cme', 'ice'],
      },
    });
    expect(viaRows.toRows()).toEqual(viaColumns.toRows());
    expect(Array.from(viaRows.axisValues())).toEqual(
      Array.from(viaColumns.axisValues()),
    );
  });

  it('null is a gap on an optional column, on both row shapes', () => {
    const tuples = ValueSeries.fromJSON({
      name: 'chain',
      schema: SPARSE,
      rows: [
        [90, null, 'cme'],
        [95, 0.27, null],
      ],
    });
    const objects = ValueSeries.fromJSON({
      name: 'chain',
      schema: SPARSE,
      rows: [
        { strike: 90, iv: null, venue: 'cme' },
        { strike: 95, iv: 0.27, venue: null },
      ],
    });
    for (const vs of [tuples, objects]) {
      expect(vs.column('iv')?.read(0)).toBeUndefined();
      expect(vs.column('iv')?.read(1)).toBe(0.27);
      expect(vs.column('venue')?.read(0)).toBe('cme');
      expect(vs.column('venue')?.read(1)).toBeUndefined();
    }
  });

  it('an omitted key on an object row is a gap, not a zero', () => {
    const vs = ValueSeries.fromJSON({
      name: 'chain',
      schema: SPARSE,
      // `iv` simply absent — the object-row spelling of a gap.
      rows: [{ strike: 90, venue: 'cme' }] as never,
    });
    expect(vs.column('iv')?.read(0)).toBeUndefined();
  });

  it('an object row omitting a prototype-named column reads as a gap', () => {
    // `record['toString']` walks Object.prototype and finds a FUNCTION for a
    // row that simply omits the key. The lookup is own-property-only, so this
    // is a gap like any other rather than a confusing kind error.
    const vs = ValueSeries.fromJSON({
      name: 'odd',
      schema: [
        { name: 'strike', kind: 'value' },
        { name: 'toString', kind: 'string', required: false },
      ] as const,
      rows: [{ strike: 90 }, { strike: 95, toString: 'cme' }] as never,
    });
    expect(vs.column('toString')?.read(0)).toBeUndefined();
    expect(vs.column('toString')?.read(1)).toBe('cme');
  });

  it('sort: true orders rows by axis value', () => {
    const vs = ValueSeries.fromJSON({
      name: 'smile',
      schema: SMILE,
      rows: [
        [100, 0.25, 'ice'],
        [90, 0.31, 'cme'],
        [95, 0.27, 'cme'],
      ],
      sort: true,
    });
    expect(Array.from(vs.axisValues())).toEqual([90, 95, 100]);
    // every column travels with its row
    expect(vs.toRows()).toEqual([
      [90, 0.31, 'cme'],
      [95, 0.27, 'cme'],
      [100, 0.25, 'ice'],
    ]);
  });

  describe('rejects', () => {
    const build = (rows: unknown) => () =>
      ValueSeries.fromJSON({
        name: 'smile',
        schema: SMILE,
        rows: rows as never,
      });

    it('an out-of-order axis, naming the door and the noun', () => {
      const fail = build([
        [100, 0.25, 'ice'],
        [90, 0.31, 'cme'],
      ]);
      expect(fail).toThrow(ValidationError);
      expect(fail).toThrow(/ValueSeries\.fromJSON: key column 'strike'/);
      expect(fail).toThrow(/axis values must be non-decreasing/);
    });

    it('a non-numeric axis cell — there is no calendar to parse against', () => {
      expect(build([['90', 0.31, 'cme']])).toThrow(
        /row 0 axis 'strike' must be a finite number; got "90"/,
      );
    });

    it('a null axis cell', () => {
      expect(build([[null, 0.31, 'cme']])).toThrow(
        /row 0 axis 'strike' must be a finite number; got null/,
      );
    });

    it('a NaN axis cell', () => {
      expect(build([[NaN, 0.31, 'cme']])).toThrow(
        /row 0 axis 'strike' must be a finite number; got NaN/,
      );
    });

    it('a non-finite number in a value column (the strict-door rule)', () => {
      // The columnar doors treat this as a gap; the row door rejects it,
      // exactly as TimeSeries.fromJSON does.
      expect(build([[90, Infinity, 'cme']])).toThrow(
        /row 0 col 1: expected finite number/,
      );
    });

    it('a value of the wrong kind', () => {
      expect(build([[90, 'not-a-number', 'cme']])).toThrow(
        /row 0 col 1: expected finite number/,
      );
      expect(build([[90, 0.31, 42]])).toThrow(/row 0 col 2: expected string/);
    });

    it('a missing cell on a required column', () => {
      expect(build([[90, null, 'cme']])).toThrow(
        /row 0 col 1 \(iv\) is required/,
      );
    });

    it('a row of the wrong width', () => {
      expect(build([[90, 0.31]])).toThrow(/row 0 expected 3 values, got 2/);
    });

    it('a row that is neither array nor object', () => {
      expect(build([42])).toThrow(
        /row 0 must be an array or an object keyed by column name/,
      );
    });

    it('a schema whose first column is not the value axis', () => {
      expect(() =>
        ValueSeries.fromJSON({
          name: 'nope',
          schema: [
            { name: 'time', kind: 'time' },
            { name: 'iv', kind: 'number' },
          ] as never,
          rows: [[0, 1]] as never,
        }),
      ).toThrow(
        /ValueSeries\.fromJSON: schema\[0\] 'time' must be the 'value'-kind axis/,
      );
    });
  });
});

describe('ValueSeries row exports', () => {
  it('toRows returns tuples in axis order, gaps as undefined', () => {
    const vs = ValueSeries.fromColumns({
      name: 'chain',
      schema: SPARSE,
      columns: {
        strike: [90, 95],
        iv: [null, 0.27],
        venue: ['cme', null],
      },
    });
    expect(vs.toRows()).toEqual([
      [90, undefined, 'cme'],
      [95, 0.27, undefined],
    ]);
  });

  it('toObjects returns schema-keyed objects, gaps as undefined', () => {
    const vs = ValueSeries.fromColumns({
      name: 'chain',
      schema: SPARSE,
      columns: { strike: [90, 95], iv: [null, 0.27], venue: ['cme', null] },
    });
    expect(vs.toObjects()).toEqual([
      { strike: 90, iv: undefined, venue: 'cme' },
      { strike: 95, iv: 0.27, venue: undefined },
    ]);
  });

  it('toJSON emits the fromJSON envelope, gaps as null', () => {
    const vs = ValueSeries.fromColumns({
      name: 'chain',
      schema: SPARSE,
      columns: { strike: [90, 95], iv: [null, 0.27], venue: ['cme', null] },
    });
    const json = vs.toJSON();
    expect(json.name).toBe('chain');
    expect(json.schema).toEqual(SPARSE);
    expect(json.rows).toEqual([
      [90, null, 'cme'],
      [95, 0.27, null],
    ]);
    // and it survives a real serialization round trip
    expect(JSON.parse(JSON.stringify(json)).rows).toEqual(json.rows);
  });

  it('toJSON({ rowFormat: "object" }) emits object rows', () => {
    const json = smile().toJSON({ rowFormat: 'object' });
    expect(json.rows).toEqual([
      { strike: 90, iv: 0.31, venue: 'cme' },
      { strike: 95, iv: 0.27, venue: 'cme' },
      { strike: 100, iv: 0.25, venue: 'ice' },
    ]);
  });

  it('round-trips through JSON.stringify in both row formats', () => {
    const vs = smile();
    for (const options of [
      undefined,
      { rowFormat: 'object' } as const,
    ] as const) {
      const wire = JSON.parse(
        JSON.stringify(
          options === undefined ? vs.toJSON() : vs.toJSON(options),
        ),
      );
      const back = ValueSeries.fromJSON(wire);
      expect(back.name).toBe(vs.name);
      expect(back.toRows()).toEqual(vs.toRows());
    }
  });

  it('exports rows of a sliced series, not of the whole source', () => {
    const window = smile().sliceByValue(95, 200);
    expect(window.toRows()).toEqual([
      [95, 0.27, 'cme'],
      [100, 0.25, 'ice'],
    ]);
    expect(window.toJSON().rows).toHaveLength(2);
  });

  it('exports an empty series as an empty row list', () => {
    const empty = smile().sliceByValue(1000, 2000);
    expect(empty.length).toBe(0);
    expect(empty.toRows()).toEqual([]);
    expect(empty.toObjects()).toEqual([]);
    expect(empty.toJSON().rows).toEqual([]);
    expect(ValueSeries.fromJSON(empty.toJSON()).length).toBe(0);
  });

  it('exported rows are frozen', () => {
    const [row] = smile().toRows();
    expect(Object.isFrozen(row)).toBe(true);
  });

  it('exports a projected series — boolean columns and all', () => {
    // `byValue` carries every non-axis column through, including kinds the
    // direct doors don't ingest. The row exports read them fine.
    const vs = projectedWithBoolean();
    expect(vs.toRows()).toEqual([
      [0, false],
      [500, true],
    ]);
    expect(vs.toJSON().rows).toEqual([
      [0, false],
      [500, true],
    ]);
  });

  it('…but that JSON does not come back: fromJSON throws, naming the column', () => {
    // The row leg's half of the boolean-column asymmetry. `toJSON` types its
    // boolean cells honestly, so the payload IS assignable to `fromJSON`'s
    // input (unlike the columnar leg, which the type system rejects outright)
    // — the ingest engine takes number/string value columns only, so the
    // failure is a runtime one. Pinned here because "it compiles" would
    // otherwise read as "it works".
    const json = projectedWithBoolean().toJSON();
    expect(() => ValueSeries.fromJSON(json)).toThrow(ValidationError);
    expect(() => ValueSeries.fromJSON(json)).toThrow(
      /supports 'number' and 'string' value columns; column 'moving' is 'boolean'/,
    );
  });
});
