import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cumDist', kind: 'number' },
  { name: 'hr', kind: 'number' },
  { name: 'ele', kind: 'number' },
] as const;

// A short ride: cumulative distance is monotonic in time order.
function makeTrack() {
  return new TimeSeries({
    name: 'ride',
    schema,
    rows: [
      [0, 0, 120, 100],
      [1000, 500, 130, 110],
      [2000, 1200, 140, 108],
      [3000, 2000, 150, 130],
    ],
  });
}

describe('TimeSeries.byValue → ValueSeries', () => {
  describe('projection', () => {
    it('re-keys onto the value axis and drops it from the value columns', () => {
      const vs = makeTrack().byValue('cumDist');
      expect(vs.axisName).toBe('cumDist');
      expect(vs.length).toBe(4);
      // axis values are the cumDist column, in order
      expect(Array.from(vs.axisValues())).toEqual([0, 500, 1200, 2000]);
      expect(vs.axisAt(2)).toBe(1200);
      // the other value columns survive
      expect(vs.column('hr')?.read(0)).toBe(120);
      expect(vs.column('ele')?.read(3)).toBe(130);
      // schema: axis key + remaining value columns (cumDist dropped from values)
      expect(vs.schema.map((c) => c.name)).toEqual(['cumDist', 'hr', 'ele']);
      expect(vs.schema[0]!.kind).toBe('value');
      // the axis is the KEY now, not a value column
      expect((vs as { column: (n: string) => unknown }).column('cumDist')).toBe(
        undefined,
      );
    });

    it('carries the source name through', () => {
      expect(makeTrack().byValue('cumDist').name).toBe('ride');
    });
  });

  describe('assertMonotonicAxis (the projection contract)', () => {
    it('throws on a non-decreasing violation', () => {
      const t = new TimeSeries({
        name: 'bad',
        schema: [
          { name: 'time', kind: 'time' },
          { name: 'd', kind: 'number' },
        ] as const,
        rows: [
          [0, 0],
          [1000, 500],
          [2000, 300], // goes backwards
        ],
      });
      expect(() => t.byValue('d')).toThrow(/non-decreasing/);
    });

    it('throws on a missing axis cell (the index cannot have gaps)', () => {
      const t = new TimeSeries({
        name: 'gap',
        schema: [
          { name: 'time', kind: 'time' },
          { name: 'd', kind: 'number', required: false },
        ] as const,
        rows: [
          [0, 0],
          [1000, undefined],
          [2000, 500],
        ],
      });
      expect(() => t.byValue('d')).toThrow(/defined and finite/);
    });

    it('allows a flat (equal) step — non-decreasing, not strictly increasing', () => {
      const t = new TimeSeries({
        name: 'flat',
        schema: [
          { name: 'time', kind: 'time' },
          { name: 'd', kind: 'number' },
          { name: 'v', kind: 'number' },
        ] as const,
        rows: [
          [0, 0, 1],
          [1000, 500, 2],
          [2000, 500, 3], // equal — allowed
          [3000, 900, 4],
        ],
      });
      const vs = t.byValue('d');
      expect(Array.from(vs.axisValues())).toEqual([0, 500, 500, 900]);
    });
  });

  describe('nearestIndex (the value-axis cursor primitive)', () => {
    const vs = makeTrack().byValue('cumDist'); // axis [0, 500, 1200, 2000]

    it('returns the closest row by axis value', () => {
      expect(vs.nearestIndex(600)).toBe(1); // |500-600|=100 < |1200-600|=600
      expect(vs.nearestIndex(1100)).toBe(2); // |1200-1100|=100 < |500-1100|=600
    });

    it('picks the lower row on an exact midpoint tie', () => {
      // midpoint of 500 and 1200 is 850 → equal distance → lower index
      expect(vs.nearestIndex(850)).toBe(1);
    });

    it('clamps to the first / last row outside the extent', () => {
      expect(vs.nearestIndex(-100)).toBe(0);
      expect(vs.nearestIndex(99999)).toBe(3);
    });

    it('returns -1 for an empty series', () => {
      const empty = makeTrack().byValue('cumDist').sliceByValue(10, 10);
      expect(empty.length).toBe(0);
      expect(empty.nearestIndex(0)).toBe(-1);
    });
  });

  describe('sliceByValue (the value-axis cull)', () => {
    const vs = makeTrack().byValue('cumDist'); // axis [0, 500, 1200, 2000]

    it('keeps rows whose axis value is in [lo, hi)', () => {
      const mid = vs.sliceByValue(400, 1300);
      expect(Array.from(mid.axisValues())).toEqual([500, 1200]);
      expect(mid.length).toBe(2);
      // value columns sliced in lockstep
      expect(mid.column('hr')?.read(0)).toBe(130);
      expect(mid.column('hr')?.read(1)).toBe(140);
    });

    it('is half-open: hi is exclusive, lo inclusive', () => {
      // [500, 1200): includes 500, excludes 1200
      const s = vs.sliceByValue(500, 1200);
      expect(Array.from(s.axisValues())).toEqual([500]);
    });

    it('yields an empty series for an empty / inverted range', () => {
      expect(vs.sliceByValue(600, 600).length).toBe(0);
      expect(vs.sliceByValue(1300, 400).length).toBe(0);
    });

    it('preserves the axis name and schema', () => {
      const s = vs.sliceByValue(0, 1300);
      expect(s.axisName).toBe('cumDist');
      expect(s.schema.map((c) => c.name)).toEqual(['cumDist', 'hr', 'ele']);
    });
  });

  describe('type-level surface', () => {
    it('gates calendar/aggregate ops off ValueSeries, and types column names', () => {
      const vs = makeTrack().byValue('cumDist');
      // valid value-column name
      expect(vs.column('hr')).toBeDefined();
      // @ts-expect-error — 'cumDist' is the axis (key), not a value column
      vs.column('cumDist');
      // @ts-expect-error — not a column
      vs.column('nope');
      // @ts-expect-error — calendar/aggregate ops do not exist on ValueSeries
      vs.aggregate;
      // @ts-expect-error — byColumn is a TimeSeries op, not on ValueSeries
      vs.byColumn;
    });
  });

  describe('edge cases — empty and single-row source', () => {
    it('projects an empty source to an empty ValueSeries', () => {
      const empty = new TimeSeries({ name: 'e', schema, rows: [] }).byValue(
        'cumDist',
      );
      expect(empty.length).toBe(0);
      expect(Array.from(empty.axisValues())).toEqual([]);
      expect(empty.nearestIndex(0)).toBe(-1);
      expect(empty.sliceByValue(0, 100).length).toBe(0);
    });

    it('projects a single-row source', () => {
      const one = new TimeSeries({
        name: '1',
        schema,
        rows: [[0, 500, 130, 110]],
      }).byValue('cumDist');
      expect(one.length).toBe(1);
      expect(one.axisAt(0)).toBe(500);
      expect(one.column('hr')?.read(0)).toBe(130);
      // nearestIndex always lands on the only row, regardless of side
      expect(one.nearestIndex(-100)).toBe(0);
      expect(one.nearestIndex(500)).toBe(0);
      expect(one.nearestIndex(9999)).toBe(0);
      // sliceByValue includes / excludes the lone row by its axis value
      expect(one.sliceByValue(0, 600).length).toBe(1);
      expect(one.sliceByValue(600, 700).length).toBe(0);
    });
  });
});
