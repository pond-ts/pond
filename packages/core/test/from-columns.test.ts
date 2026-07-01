import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';

const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'open', kind: 'number' },
  { name: 'close', kind: 'number', required: false },
] as const;

describe('TimeSeries.fromColumns', () => {
  it('builds a series from number[] columns (JSON-columnar path)', () => {
    const ts = TimeSeries.fromColumns({
      name: 't',
      schema: SCHEMA,
      columns: {
        time: [1000, 2000, 3000],
        open: [10, 20, 30],
        close: [1.5, null, 3.5],
      },
    });
    expect(ts.length).toBe(3);
    expect(ts.firstColumnKind).toBe('time');
    expect(ts.at(0)?.begin()).toBe(1000);
    expect(ts.at(2)?.begin()).toBe(3000);
    expect(ts.at(0)?.data().open).toBe(10);
    expect(ts.at(2)?.data().close).toBe(3.5);
    // the `null` cell is a gap
    expect(ts.at(1)?.data().close).toBeUndefined();
  });

  it('adopts Float64Array columns (protobuf / fixed-point path), NaN = gap', () => {
    const ts = TimeSeries.fromColumns({
      name: 't',
      schema: SCHEMA,
      columns: {
        time: Float64Array.from([1000, 2000, 3000]),
        open: Float64Array.from([10, 20, 30]),
        close: Float64Array.from([1.5, NaN, 3.5]),
      },
    });
    expect(ts.length).toBe(3);
    expect(ts.at(1)?.data().open).toBe(20);
    expect(ts.at(1)?.data().close).toBeUndefined(); // NaN → missing
    expect(ts.at(2)?.data().close).toBe(3.5);
  });

  it('matches the row-tuple constructor for the same data', () => {
    const cols = TimeSeries.fromColumns({
      name: 't',
      schema: SCHEMA,
      columns: {
        time: [1000, 2000, 3000],
        open: [10, 20, 30],
        close: [1.5, null, 3.5],
      },
    });
    const rows = new TimeSeries({
      name: 't',
      schema: SCHEMA,
      rows: [
        [1000, 10, 1.5],
        [2000, 20, undefined], // raw row constructor uses `undefined` for missing
        [3000, 30, 3.5],
      ] as never,
    });
    expect(cols.length).toBe(rows.length);
    for (let i = 0; i < rows.length; i++) {
      expect(cols.at(i)?.begin()).toBe(rows.at(i)?.begin());
      expect(cols.at(i)?.data().open).toBe(rows.at(i)?.data().open);
      expect(cols.at(i)?.data().close).toBe(rows.at(i)?.data().close);
    }
  });

  it('throws on a missing column', () => {
    expect(() =>
      TimeSeries.fromColumns({
        name: 't',
        schema: SCHEMA,
        columns: { time: [1000, 2000], open: [10, 20] }, // no `close`
      }),
    ).toThrow(/close/);
  });

  it('throws on a length mismatch', () => {
    expect(() =>
      TimeSeries.fromColumns({
        name: 't',
        schema: SCHEMA,
        columns: { time: [1000, 2000], open: [10], close: [1.5, 2.5] },
      }),
    ).toThrow(/length/);
  });

  it('throws on a non-time key (v1 scope)', () => {
    expect(() =>
      TimeSeries.fromColumns({
        name: 't',
        schema: [
          { name: 'k', kind: 'number' },
          { name: 'v', kind: 'number' },
        ] as const,
        columns: { k: [1, 2], v: [10, 20] },
      }),
    ).toThrow(/time/);
  });

  it('throws on a non-number value column (v1 scope)', () => {
    expect(() =>
      TimeSeries.fromColumns({
        name: 't',
        schema: [
          { name: 'time', kind: 'time' },
          { name: 'label', kind: 'string' },
        ] as const,
        columns: { time: [1000, 2000], label: ['a', 'b'] as never },
      }),
    ).toThrow(/number/);
  });

  it('throws on out-of-order timestamps (non-decreasing invariant, like fromJSON)', () => {
    const badTime = {
      time: [1000, 3000, 2000],
      open: [10, 20, 30],
      close: [1, 2, 3],
    };
    // number[] path
    expect(() =>
      TimeSeries.fromColumns({ name: 't', schema: SCHEMA, columns: badTime }),
    ).toThrow(/out of order/);
    // Float64Array path — same guard
    expect(() =>
      TimeSeries.fromColumns({
        name: 't',
        schema: SCHEMA,
        columns: {
          time: Float64Array.from([1000, 3000, 2000]),
          open: Float64Array.from([10, 20, 30]),
          close: Float64Array.from([1, 2, 3]),
        },
      }),
    ).toThrow(/out of order/);
    // parity: the same unsorted data via fromJSON also rejects
    expect(() =>
      TimeSeries.fromJSON({
        name: 't',
        schema: SCHEMA,
        rows: [
          [1000, 10, 1],
          [3000, 20, 2],
          [2000, 30, 3],
        ] as never,
      }),
    ).toThrow(/out of order/);
  });

  it('allows equal (non-decreasing, not strictly increasing) timestamps', () => {
    const ts = TimeSeries.fromColumns({
      name: 't',
      schema: SCHEMA,
      columns: {
        time: [1000, 1000, 2000],
        open: [10, 11, 20],
        close: [1, 1, 2],
      },
    });
    expect(ts.length).toBe(3);
  });

  it('treats NaN as a gap identically for number[] and Float64Array value columns', () => {
    const viaArray = TimeSeries.fromColumns({
      name: 't',
      schema: SCHEMA,
      columns: {
        time: [1000, 2000, 3000],
        open: [10, 20, 30],
        close: [1, NaN, 3],
      },
    });
    const viaTyped = TimeSeries.fromColumns({
      name: 't',
      schema: SCHEMA,
      columns: {
        time: Float64Array.from([1000, 2000, 3000]),
        open: Float64Array.from([10, 20, 30]),
        close: Float64Array.from([1, NaN, 3]),
      },
    });
    // NaN is a gap either way — not a stored-but-non-finite value.
    expect(viaArray.at(1)?.data().close).toBeUndefined();
    expect(viaTyped.at(1)?.data().close).toBeUndefined();
  });

  it('adopts (does not copy) Float64Array columns — pre-read mutation is visible', () => {
    const buf = Float64Array.from([1000, 2000, 3000]);
    const ts = TimeSeries.fromColumns({
      name: 't',
      schema: SCHEMA,
      columns: {
        time: buf,
        open: Float64Array.from([10, 20, 30]),
        close: Float64Array.from([1, 2, 3]),
      },
    });
    // Mutate before any read of row 0 (the row-level eventCache memoizes on
    // first access, which would otherwise mask the aliasing this test proves).
    buf[0] = 500;
    expect(ts.at(0)?.begin()).toBe(500);
  });

  it('throws on a non-finite timestamp key', () => {
    expect(() =>
      TimeSeries.fromColumns({
        name: 't',
        schema: SCHEMA,
        columns: {
          time: Float64Array.from([1000, NaN, 3000]),
          open: Float64Array.from([10, 20, 30]),
          close: Float64Array.from([1, 2, 3]),
        },
      }),
    ).toThrow();
  });
});
