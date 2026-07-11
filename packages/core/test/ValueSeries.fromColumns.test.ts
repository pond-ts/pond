import { describe, expect, it } from 'vitest';
import { TimeSeries, ValueSeries } from '../src/index.js';

/**
 * `ValueSeries.fromColumns` — the direct columnar door into value-land, for
 * natively value-keyed (cross-sectional) data: an options chain keyed by
 * strike, a spectrum keyed by frequency. Mirrors the `TimeSeries.fromColumns`
 * contract (shared ingest engine) with the axis in place of time; these tests
 * pin the door-specific parts (axis-kind gate, error prefixes/nouns) and the
 * equivalence with the projection door (`TimeSeries.byValue`).
 */

const SMILE = [
  { name: 'strike', kind: 'value' },
  { name: 'iv', kind: 'number' },
  { name: 'oi', kind: 'number' },
] as const;

describe('ValueSeries.fromColumns', () => {
  it('constructs a value-keyed series from plain arrays', () => {
    const vs = ValueSeries.fromColumns({
      name: 'smile',
      schema: SMILE,
      columns: {
        strike: [90, 95, 100, 105, 110],
        iv: [0.31, 0.27, 0.25, 0.26, 0.29],
        oi: [120, 340, 900, 410, 150],
      },
    });
    expect(vs).toBeInstanceOf(ValueSeries);
    expect(vs.length).toBe(5);
    expect(vs.axisName).toBe('strike');
    expect(Array.from(vs.axisValues())).toEqual([90, 95, 100, 105, 110]);
    expect(vs.column('iv')?.read(2)).toBe(0.25);
    expect(vs.column('oi')?.read(0)).toBe(120);
  });

  it('the ordering operators work on the result (nearestIndex, sliceByValue)', () => {
    const vs = ValueSeries.fromColumns({
      name: 'smile',
      schema: SMILE,
      columns: {
        strike: [90, 95, 100, 105, 110],
        iv: [0.31, 0.27, 0.25, 0.26, 0.29],
        oi: [1, 2, 3, 4, 5],
      },
    });
    expect(vs.nearestIndex(101)).toBe(2);
    expect(vs.nearestIndex(0)).toBe(0);
    expect(vs.nearestIndex(999)).toBe(4);
    const win = vs.sliceByValue(95, 110);
    expect(Array.from(win.axisValues())).toEqual([95, 100, 105]);
    expect(win.column('iv')?.read(0)).toBe(0.27);
  });

  it('sort: true orders rows by axis value, remapping every column together', () => {
    // Update-order delivery (a keyed live snapshot), not axis order.
    const vs = ValueSeries.fromColumns({
      name: 'smile',
      schema: SMILE,
      columns: {
        strike: [105, 90, 110, 100, 95],
        iv: [0.26, 0.31, 0.29, 0.25, 0.27],
        oi: [4, 1, 5, 3, 2],
      },
      sort: true,
    });
    expect(Array.from(vs.axisValues())).toEqual([90, 95, 100, 105, 110]);
    expect(vs.column('iv')?.read(0)).toBe(0.31);
    expect(vs.column('oi')?.read(4)).toBe(5);
  });

  it('sort is stable — rows sharing an axis value keep input order', () => {
    const vs = ValueSeries.fromColumns({
      name: 'dup',
      schema: SMILE,
      columns: {
        strike: [100, 90, 100, 90],
        iv: [1, 2, 3, 4],
        oi: [0, 0, 0, 0],
      },
      sort: true,
    });
    expect(Array.from(vs.axisValues())).toEqual([90, 90, 100, 100]);
    expect(vs.column('iv')?.read(0)).toBe(2);
    expect(vs.column('iv')?.read(1)).toBe(4);
    expect(vs.column('iv')?.read(2)).toBe(1);
    expect(vs.column('iv')?.read(3)).toBe(3);
  });

  it('allows equal (non-decreasing) axis values without sort', () => {
    const vs = ValueSeries.fromColumns({
      name: 'plateau',
      schema: SMILE,
      columns: { strike: [90, 90, 95], iv: [1, 2, 3], oi: [0, 0, 0] },
    });
    expect(vs.length).toBe(3);
  });

  it('matches the projection door: fromColumns ≡ fromColumns(time-laundered) + byValue', () => {
    // The workaround this door replaces: strike passed twice, once as a fake
    // epoch-ms key just to reach TimeSeries.fromColumns' sort + validation.
    const strike = [105, 90, 110, 100, 95];
    const iv = [0.26, 0.31, 0.29, 0.25, 0.27];
    const laundered = TimeSeries.fromColumns({
      name: 'smile',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'strike', kind: 'number' },
        { name: 'iv', kind: 'number' },
      ] as const,
      columns: { time: strike, strike, iv },
      sort: true,
    }).byValue('strike');
    const direct = ValueSeries.fromColumns({
      name: 'smile',
      schema: [
        { name: 'strike', kind: 'value' },
        { name: 'iv', kind: 'number' },
      ] as const,
      columns: { strike, iv },
      sort: true,
    });
    expect(direct.axisName).toBe(laundered.axisName);
    expect(Array.from(direct.axisValues())).toEqual(
      Array.from(laundered.axisValues()),
    );
    for (let i = 0; i < direct.length; i += 1) {
      expect(direct.column('iv')?.read(i)).toBe(
        laundered.column('iv')?.read(i),
      );
    }
  });

  it('treats null/undefined/NaN value cells as gaps, for number[] and Float64Array alike', () => {
    const viaArray = ValueSeries.fromColumns({
      name: 'gaps',
      schema: SMILE,
      columns: {
        strike: [90, 95, 100],
        iv: [0.3, null, 0.25],
        oi: [1, 2, NaN],
      },
    });
    const viaTyped = ValueSeries.fromColumns({
      name: 'gaps',
      schema: SMILE,
      columns: {
        strike: Float64Array.from([90, 95, 100]),
        iv: Float64Array.from([0.3, NaN, 0.25]),
        oi: Float64Array.from([1, 2, NaN]),
      },
    });
    expect(viaArray.column('iv')?.read(1)).toBeUndefined();
    expect(viaTyped.column('iv')?.read(1)).toBeUndefined();
    expect(viaArray.column('oi')?.read(2)).toBeUndefined();
    expect(viaTyped.column('oi')?.read(2)).toBeUndefined();
  });

  it('adopts (does not copy) Float64Array columns — mutation is visible', () => {
    const iv = Float64Array.from([0.3, 0.27, 0.25]);
    const vs = ValueSeries.fromColumns({
      name: 'adopt',
      schema: SMILE,
      columns: {
        strike: Float64Array.from([90, 95, 100]),
        iv,
        oi: Float64Array.from([1, 2, 3]),
      },
    });
    iv[0] = 0.99;
    expect(vs.column('iv')?.read(0)).toBe(0.99);
  });

  it('sort: true copies instead of adopting', () => {
    const iv = Float64Array.from([0.25, 0.3]);
    const vs = ValueSeries.fromColumns({
      name: 'copy',
      schema: SMILE,
      columns: {
        strike: Float64Array.from([100, 90]),
        iv,
        oi: Float64Array.from([1, 2]),
      },
      sort: true,
    });
    iv[0] = 0.99;
    expect(vs.column('iv')?.read(1)).toBe(0.25);
  });

  it('throws on an out-of-order axis without sort', () => {
    expect(() =>
      ValueSeries.fromColumns({
        name: 'bad',
        schema: SMILE,
        columns: { strike: [100, 90], iv: [1, 2], oi: [1, 2] },
      }),
    ).toThrow(/out of order.*axis values/);
  });

  it('throws on a non-value axis kind', () => {
    expect(() =>
      ValueSeries.fromColumns({
        name: 'bad',
        // A time-kind first column is the TimeSeries door, not this one.
        schema: [
          { name: 'time', kind: 'time' },
          { name: 'iv', kind: 'number' },
        ] as unknown as typeof SMILE,
        columns: { time: [1, 2], iv: [1, 2] },
      }),
    ).toThrow(/'value'-kind axis/);
  });

  it('throws on a non-finite axis cell, even with sort', () => {
    for (const strike of [
      [90, NaN, 100],
      [90, null, 100],
      [90, Infinity, 100],
    ]) {
      expect(() =>
        ValueSeries.fromColumns({
          name: 'bad',
          schema: SMILE,
          columns: { strike, iv: [1, 2, 3], oi: [1, 2, 3] },
          sort: true,
        }),
      ).toThrow();
    }
  });

  it('throws on a missing column and on a length mismatch', () => {
    expect(() =>
      ValueSeries.fromColumns({
        name: 'bad',
        schema: SMILE,
        columns: { strike: [90, 95], iv: [1, 2] },
      }),
    ).toThrow(/missing column 'oi'/);
    expect(() =>
      ValueSeries.fromColumns({
        name: 'bad',
        schema: SMILE,
        columns: { strike: [90, 95], iv: [1, 2, 3], oi: [1, 2] },
      }),
    ).toThrow(/length/);
  });

  it('throws on a duplicate axis name among the value columns', () => {
    expect(() =>
      ValueSeries.fromColumns({
        name: 'bad',
        schema: [
          { name: 'strike', kind: 'value' },
          { name: 'strike', kind: 'number' },
        ] as unknown as typeof SMILE,
        columns: { strike: [90, 95] },
      }),
    ).toThrow(/duplicate/);
  });

  it('constructs an empty series from empty columns', () => {
    const vs = ValueSeries.fromColumns({
      name: 'empty',
      schema: SMILE,
      columns: { strike: [], iv: [], oi: [] },
    });
    expect(vs.length).toBe(0);
    expect(vs.nearestIndex(100)).toBe(-1);
  });
});
