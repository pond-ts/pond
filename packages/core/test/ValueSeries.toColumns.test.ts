import { describe, expect, it } from 'vitest';
import { TimeSeries, ValueSeries } from '../src/index.js';

/**
 * `ValueSeries.toColumns` — the columnar-JSON door out, and the exact inverse
 * of `fromColumns`. What these pin: the envelope shape (axis included under
 * its own name), the gap spelling (`null`, because `NaN` is not JSON), and the
 * round trip back through `fromColumns` without a cast.
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

function smile() {
  return ValueSeries.fromColumns({
    name: 'smile',
    schema: SMILE,
    columns: {
      strike: [90, 95, 100],
      iv: [0.31, 0.27, 0.25],
      venue: ['cme', 'cme', 'ice'],
    },
  });
}

describe('ValueSeries.toColumns', () => {
  it('emits one array per column, the axis under its own name', () => {
    const out = smile().toColumns();
    expect(out.name).toBe('smile');
    expect(out.schema).toEqual(SMILE);
    expect(out.columns).toEqual({
      strike: [90, 95, 100],
      iv: [0.31, 0.27, 0.25],
      venue: ['cme', 'cme', 'ice'],
    });
  });

  it('spells gaps as null in both numeric and string columns', () => {
    const vs = ValueSeries.fromColumns({
      name: 'chain',
      schema: SPARSE,
      // NaN is the columnar spelling of a gap on the way in…
      columns: {
        strike: [90, 95, 100],
        iv: new Float64Array([NaN, 0.27, NaN]),
        venue: ['cme', null, 'ice'],
      },
    });
    // …and null on the way out, so the payload is JSON.
    expect(vs.toColumns().columns).toEqual({
      strike: [90, 95, 100],
      iv: [null, 0.27, null],
      venue: ['cme', null, 'ice'],
    });
  });

  it('round-trips back through fromColumns, cell for cell', () => {
    const vs = ValueSeries.fromColumns({
      name: 'chain',
      schema: SPARSE,
      columns: {
        strike: [90, 95, 100],
        iv: [0.31, null, 0.25],
        venue: ['cme', 'cme', null],
      },
    });
    // No cast: `toColumns()`'s output type is assignable to `fromColumns`'s
    // input. That assignability IS the round-trip contract.
    const back = ValueSeries.fromColumns(vs.toColumns());
    expect(back.name).toBe(vs.name);
    expect(back.schema).toEqual(vs.schema);
    expect(back.toRows()).toEqual(vs.toRows());
  });

  it('survives a real JSON.stringify round trip', () => {
    const vs = smile();
    const wire = JSON.parse(JSON.stringify(vs.toColumns()));
    const back = ValueSeries.fromColumns(wire);
    expect(back.toRows()).toEqual(vs.toRows());
  });

  it('carries the same data as toJSON, transposed', () => {
    const vs = smile();
    const { columns } = vs.toColumns();
    const rows = vs.toJSON().rows;
    for (let i = 0; i < vs.length; i += 1) {
      expect([columns.strike[i], columns.iv[i], columns.venue[i]]).toEqual(
        rows[i],
      );
    }
  });

  it('exports the slice, not the source buffers behind it', () => {
    const window = smile().sliceByValue(95, 200);
    expect(window.toColumns().columns).toEqual({
      strike: [95, 100],
      iv: [0.27, 0.25],
      venue: ['cme', 'ice'],
    });
  });

  it('emits empty arrays for an empty series (still ingestable)', () => {
    const empty = smile().sliceByValue(1000, 2000);
    const out = empty.toColumns();
    expect(out.columns).toEqual({ strike: [], iv: [], venue: [] });
    expect(ValueSeries.fromColumns(out).length).toBe(0);
  });

  it('emits a boolean column carried in by projection', () => {
    // `byValue` passes every non-axis column through, so a ValueSeries can
    // hold kinds `fromColumns` won't take back. Export still works — the
    // asymmetry is caught at the type level, not by throwing here.
    const vs = new TimeSeries({
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
    expect(vs.toColumns().columns).toEqual({
      cumDist: [0, 500],
      moving: [false, true],
    });
  });

  it('is a fresh payload, not a view onto live storage', () => {
    const vs = smile();
    const out = vs.toColumns();
    out.columns.iv[0] = 999;
    expect(vs.column('iv')?.read(0)).toBe(0.31);
  });
});
