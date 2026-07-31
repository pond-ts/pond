import { describe, expect, it } from 'vitest';
import { TimeSeries, ValidationError } from '../src/index.js';

/**
 * **The flattened key convention on the ingest side** — `fromColumns` reading
 * a two-edged key back out of the extra columns named off it
 * (`timeRange` + `timeRangeEnd`, `interval` + `intervalEnd` + `intervalLabel`).
 *
 * The export half lives in `TimeSeries.toColumns.test.ts`; this file is the
 * door's own contract: what it requires, what it rejects, and the ordering /
 * sorting rules that only apply once a key has two edges. See
 * `src/batch/operators/flat-keys.ts` for why the shape is flattened rather
 * than paired.
 */

const RANGE = [
  { name: 'timeRange', kind: 'timeRange' },
  { name: 'load', kind: 'number' },
] as const;

const INTERVAL = [
  { name: 'interval', kind: 'interval' },
  { name: 'load', kind: 'number' },
] as const;

describe('fromColumns — flattened timeRange key', () => {
  it('builds a range-keyed series from begin + end columns', () => {
    const series = TimeSeries.fromColumns({
      name: 'ranges',
      schema: RANGE,
      columns: {
        timeRange: [0, 60_000, 120_000],
        timeRangeEnd: [60_000, 120_000, 180_000],
        load: [1, 2, 3],
      },
    });
    expect(series.length).toBe(3);
    expect(series.schema[0]!.kind).toBe('timeRange');
    expect(series.at(0)!.key().begin()).toBe(0);
    expect(series.at(0)!.key().end()).toBe(60_000);
    expect(series.at(2)!.get('load')).toBe(3);
  });

  it('adopts Float64Array edges zero-copy, same as a point key', () => {
    const begin = Float64Array.from([0, 60_000]);
    const end = Float64Array.from([60_000, 120_000]);
    const series = TimeSeries.fromColumns({
      name: 'ranges',
      schema: RANGE,
      columns: { timeRange: begin, timeRangeEnd: end, load: [1, 2] },
    });
    expect(series.keyColumn().begin).toBe(begin);
    expect(series.keyColumn().end).toBe(end);
  });

  it('requires the second edge — a half-specified key is an error', () => {
    const fail = () =>
      TimeSeries.fromColumns({
        name: 'ranges',
        schema: RANGE,
        columns: { timeRange: [0, 60_000], load: [1, 2] },
      });
    expect(fail).toThrow(ValidationError);
    expect(fail).toThrow(/missing key column 'timeRangeEnd'/);
    expect(fail).toThrow(/flattens to 'timeRange' \+ 'timeRangeEnd'/);
  });

  it('rejects an edge of the wrong length', () => {
    expect(() =>
      TimeSeries.fromColumns({
        name: 'ranges',
        schema: RANGE,
        columns: { timeRange: [0, 1], timeRangeEnd: [1], load: [1, 2] },
      }),
    ).toThrow(/'timeRangeEnd' length 1 does not match 'timeRange' length 2/);
  });

  it('rejects begin > end (the key column enforces it)', () => {
    expect(() =>
      TimeSeries.fromColumns({
        name: 'ranges',
        schema: RANGE,
        columns: { timeRange: [100], timeRangeEnd: [50], load: [1] },
      }),
    ).toThrow(RangeError);
  });

  it('orders by (begin, end) — equal begins must not go backwards', () => {
    const fail = () =>
      TimeSeries.fromColumns({
        name: 'ranges',
        schema: RANGE,
        columns: {
          timeRange: [0, 0],
          timeRangeEnd: [90, 30],
          load: [1, 2],
        },
      });
    expect(fail).toThrow(ValidationError);
    expect(fail).toThrow(/equal begins 0, but end 30 < 90/);
  });

  it('sort: true permutes by (begin, end), edges travelling together', () => {
    const series = TimeSeries.fromColumns({
      name: 'ranges',
      schema: RANGE,
      columns: {
        timeRange: [120_000, 0, 0],
        timeRangeEnd: [180_000, 90_000, 30_000],
        load: [3, 1, 2],
      },
      sort: true,
    });
    expect(
      Array.from({ length: 3 }, (_, i) => [
        series.at(i)!.key().begin(),
        series.at(i)!.key().end(),
        series.at(i)!.get('load'),
      ]),
    ).toEqual([
      [0, 30_000, 2],
      [0, 90_000, 1],
      [120_000, 180_000, 3],
    ]);
  });
});

describe('fromColumns — flattened interval key', () => {
  const columns = {
    interval: [0, 60_000],
    intervalEnd: [60_000, 120_000],
    intervalLabel: ['morning', 'evening'],
    load: [1, 2],
  };

  it('builds an interval-keyed series from begin + end + label', () => {
    const series = TimeSeries.fromColumns({
      name: 'shifts',
      schema: INTERVAL,
      columns,
    });
    expect(series.schema[0]!.kind).toBe('interval');
    expect(series.at(0)!.key().begin()).toBe(0);
    expect(series.at(0)!.key().end()).toBe(60_000);
    expect(series.toRows()[0]![0]).toMatchObject({ value: 'morning' });
  });

  it('takes numeric labels too — what aggregate produces', () => {
    const series = TimeSeries.fromColumns({
      name: 'buckets',
      schema: INTERVAL,
      columns: { ...columns, intervalLabel: [0, 60_000] },
    });
    expect(series.toRows()[1]![0]).toMatchObject({ value: 60_000 });
  });

  it('requires the label column', () => {
    const { intervalLabel: _dropped, ...rest } = columns;
    expect(() =>
      TimeSeries.fromColumns({
        name: 'shifts',
        schema: INTERVAL,
        columns: rest,
      }),
    ).toThrow(/missing key column 'intervalLabel'/);
  });

  it('rejects a missing label — a label is part of the key', () => {
    expect(() =>
      TimeSeries.fromColumns({
        name: 'shifts',
        schema: INTERVAL,
        columns: { ...columns, intervalLabel: ['morning', null] },
      }),
    ).toThrow(/interval label at index 1 is missing/);
  });

  it('rejects mixed label types, the same way the row door does', () => {
    // RangeError (not ValidationError) for parity with the row path, so a
    // caller catching by class sees one behaviour across both doors.
    expect(() =>
      TimeSeries.fromColumns({
        name: 'shifts',
        schema: INTERVAL,
        columns: { ...columns, intervalLabel: ['morning', 42] as never },
      }),
    ).toThrow(RangeError);
  });

  it('takes a Float64Array of labels, adopting the buffer', () => {
    // Unambiguous — a typed array can only mean numeric labels — and it is the
    // only spelling a binary or Arrow decoder has for them. An earlier version
    // rejected it, which broke `fromArrow({ keyKind: 'interval' })` on exactly
    // the series `aggregate` produces (Layer-2 review of #567).
    const labels = Float64Array.from([0, 60_000]);
    const series = TimeSeries.fromColumns({
      name: 'buckets',
      schema: INTERVAL,
      columns: { ...columns, intervalLabel: labels },
    });
    expect(series.toRows()[1]![0]).toMatchObject({ value: 60_000 });
    expect(series.toColumns().columns.intervalLabel).toEqual([0, 60_000]);
  });

  it('rejects a NaN label — what a null becomes after a decode', () => {
    expect(() =>
      TimeSeries.fromColumns({
        name: 'buckets',
        schema: INTERVAL,
        columns: { ...columns, intervalLabel: Float64Array.from([0, NaN]) },
      }),
    ).toThrow(/interval label at index 1 is NaN/);
  });

  it('agrees with the row door, cell for cell', () => {
    const viaColumns = TimeSeries.fromColumns({
      name: 'shifts',
      schema: INTERVAL,
      columns,
    });
    const viaRows = new TimeSeries({
      name: 'shifts',
      schema: INTERVAL,
      rows: [
        [['morning', 0, 60_000], 1],
        [['evening', 60_000, 120_000], 2],
      ],
    });
    expect(viaColumns.toRows()).toEqual(viaRows.toRows());
    expect(viaColumns.toColumns()).toEqual(viaRows.toColumns());
  });
});

describe('fromColumns — key kind gate', () => {
  it("rejects a 'value' axis, pointing at the ValueSeries door", () => {
    expect(() =>
      TimeSeries.fromColumns({
        name: 'nope',
        schema: [
          { name: 'strike', kind: 'value' },
          { name: 'iv', kind: 'number' },
        ] as never,
        columns: { strike: [90], iv: [0.3] },
      }),
    ).toThrow(
      /is 'value'; a TimeSeries key is 'time', 'timeRange' or 'interval'/,
    );
  });
});
