/**
 * Tests for `TimeSeries.byColumn` — value-axis aggregation
 * (docs/notes/bycolumn-value-axis.md). Buckets rows by the *value* of a
 * numeric column ({ width } even bins or { edges } explicit) and reduces each
 * bin to a `{ start, end, ...aggregates }` record.
 */
import { describe, expect, it } from 'vitest';
import { Event, Time, TimeSeries } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'dist', kind: 'number' }, // monotonic axis (cumulative distance)
  { name: 'ele', kind: 'number' },
  { name: 'watts', kind: 'number' }, // non-monotonic axis
] as const;

type Row = readonly [number, number, number, number];

const make = (rows: Row[]) =>
  new TimeSeries({ name: 'ride', schema, rows: rows as Row[] });

describe('TimeSeries.byColumn — { width } (monotonic → contiguous splits)', () => {
  it('buckets by even width with correct [start,end) and aggregates', () => {
    const s = make([
      [0, 0, 100, 0],
      [1000, 400, 110, 0],
      [2000, 900, 105, 0],
      [3000, 1500, 130, 0],
      [4000, 2100, 120, 0],
    ]);
    const bins = s.byColumn(
      'dist',
      { width: 1000 },
      {
        gain: { from: 'ele', using: 'sum' },
        n: { from: 'ele', using: 'count' },
      },
    );
    expect(bins).toEqual([
      { start: 0, end: 1000, gain: 315, n: 3 }, // 100+110+105
      { start: 1000, end: 2000, gain: 130, n: 1 },
      { start: 2000, end: 3000, gain: 120, n: 1 },
    ]);
  });

  it('emits contiguous bins, filling interior gaps with the empty value', () => {
    const s = make([
      [0, 0, 100, 0],
      [1000, 100, 110, 0],
      [2000, 5500, 130, 0], // jumps to bin 5, bins 1–4 empty
    ]);
    const bins = s.byColumn(
      'dist',
      { width: 1000 },
      {
        gain: { from: 'ele', using: 'sum' },
        avg: { from: 'ele', using: 'avg' },
      },
    );
    expect(bins.map((b) => [b.start, b.end])).toEqual([
      [0, 1000],
      [1000, 2000],
      [2000, 3000],
      [3000, 4000],
      [4000, 5000],
      [5000, 6000],
    ]);
    // bin 0: two rows; interior bins empty; bin 5: one row.
    expect(bins[0]!.gain).toBe(210);
    expect(bins[0]!.avg).toBe(105);
    expect(bins[2]!.gain).toBe(0); // sum empty → 0
    expect(bins[2]!.avg).toBeUndefined(); // avg empty → undefined
    expect(bins[5]!.gain).toBe(130);
  });

  it('honors origin', () => {
    const s = make([
      [0, 600, 1, 0],
      [1000, 1400, 1, 0],
      [2000, 1600, 1, 0],
    ]);
    // origin 500, width 1000 → bins [500,1500), [1500,2500)
    const bins = s.byColumn(
      'dist',
      { width: 1000, origin: 500 },
      { n: { from: 'ele', using: 'count' } },
    );
    expect(bins).toEqual([
      { start: 500, end: 1500, n: 2 }, // 600, 1400
      { start: 1500, end: 2500, n: 1 }, // 1600
    ]);
  });
});

describe('TimeSeries.byColumn — { width } (non-monotonic → histogram)', () => {
  it('buckets a fluctuating column into a histogram', () => {
    const s = make([
      [0, 0, 0, 100],
      [1000, 0, 0, 250],
      [2000, 0, 0, 120],
      [3000, 0, 0, 300],
      [4000, 0, 0, 110],
    ]);
    const bins = s.byColumn(
      'watts',
      { width: 100 },
      { secs: { from: 'watts', using: 'count' } },
    );
    // occupied bins: [100,200) ×3 (100,120,110), [200,300) ×1 (250), [300,400) ×1 (300)
    expect(bins).toEqual([
      { start: 100, end: 200, secs: 3 },
      { start: 200, end: 300, secs: 1 },
      { start: 300, end: 400, secs: 1 },
    ]);
  });
});

describe('TimeSeries.byColumn — { edges } (explicit zones)', () => {
  it('one bin per [edge_i, edge_{i+1}); emits all bins incl. empty', () => {
    const s = make([
      [0, 0, 0, 100],
      [1000, 0, 0, 250],
      [2000, 0, 0, 120],
      [3000, 0, 0, 300],
      [4000, 0, 0, 110],
    ]);
    const bins = s.byColumn(
      'watts',
      { edges: [0, 150, 250, 400] },
      { secs: { from: 'watts', using: 'count' } },
    );
    expect(bins).toEqual([
      { start: 0, end: 150, secs: 3 }, // 100, 120, 110
      { start: 150, end: 250, secs: 0 }, // empty zone
      { start: 250, end: 400, secs: 2 }, // 250, 300
    ]);
  });

  it('drops values outside [first, last) edge', () => {
    const s = make([
      [0, 0, 0, 50], // < 100 → dropped
      [1000, 0, 0, 150], // bin 0
      [2000, 0, 0, 350], // >= 300 → dropped
      [3000, 0, 0, 250], // bin 1
    ]);
    const bins = s.byColumn(
      'watts',
      { edges: [100, 200, 300] },
      { secs: { from: 'watts', using: 'count' } },
    );
    expect(bins).toEqual([
      { start: 100, end: 200, secs: 1 },
      { start: 200, end: 300, secs: 1 },
    ]);
  });
});

describe('TimeSeries.byColumn — edges + drops', () => {
  it('drops a row whose bin value is missing', () => {
    // fromEvents lets a `dist` cell be absent.
    const s = TimeSeries.fromEvents(
      [
        new Event(new Time(0), { dist: 100, ele: 10, watts: 0 }),
        new Event(new Time(1000), { ele: 20, watts: 0 }), // dist missing → dropped
        new Event(new Time(2000), { dist: 1100, ele: 30, watts: 0 }),
      ],
      { schema, name: 'ride' },
    );
    const bins = s.byColumn(
      'dist',
      { width: 1000 },
      {
        gain: { from: 'ele', using: 'sum' },
        n: { from: 'ele', using: 'count' },
      },
    );
    expect(bins).toEqual([
      { start: 0, end: 1000, gain: 10, n: 1 }, // only row 0 (row 1 dropped)
      { start: 1000, end: 2000, gain: 30, n: 1 }, // row 2
    ]);
  });

  it('returns [] for an empty series', () => {
    expect(
      make([]).byColumn(
        'dist',
        { width: 1000 },
        { n: { from: 'ele', using: 'count' } },
      ),
    ).toEqual([]);
  });
});

describe('TimeSeries.byColumn — Codex regressions', () => {
  it('keeps negative width bins for values below origin (default 0)', () => {
    // floor((v-0)/100): -150 → -2, -50 → -1, 50 → 0. The width path must NOT
    // treat a negative bin index as "out of range" (only edges drops).
    const s = make([
      [0, -150, 1, 0],
      [1000, -50, 1, 0],
      [2000, 50, 1, 0],
    ]);
    const bins = s.byColumn(
      'dist',
      { width: 100 },
      { n: { from: 'ele', using: 'count' } },
    );
    expect(bins).toEqual([
      { start: -200, end: -100, n: 1 },
      { start: -100, end: 0, n: 1 },
      { start: 0, end: 100, n: 1 },
    ]);
  });

  it('does not alias the empty array value across empty bins', () => {
    // dist 0 → bin 0, dist 3000 → bin 3; bins 1 & 2 are empty. An array-kind
    // reducer's empty value must be a fresh array per bin, not one shared ref.
    const s = make([
      [0, 0, 1, 0],
      [1000, 3000, 1, 0],
    ]);
    const bins = s.byColumn(
      'dist',
      { width: 1000 },
      { vals: { from: 'ele', using: 'unique' } },
    );
    expect(bins[1]!.vals).toEqual([]);
    expect(bins[2]!.vals).toEqual([]);
    expect(bins[1]!.vals).not.toBe(bins[2]!.vals); // distinct instances
  });
});

describe('TimeSeries.byColumn — validation', () => {
  const s = make([[0, 0, 0, 0]]);

  it('rejects a non-positive / non-finite width', () => {
    expect(() =>
      s.byColumn('dist', { width: 0 }, { n: { from: 'ele', using: 'count' } }),
    ).toThrow(/positive finite/);
    expect(() =>
      s.byColumn('dist', { width: -1 }, { n: { from: 'ele', using: 'count' } }),
    ).toThrow(/positive finite/);
  });

  it('rejects non-ascending / too-few edges', () => {
    expect(() =>
      s.byColumn(
        'dist',
        { edges: [10] },
        { n: { from: 'ele', using: 'count' } },
      ),
    ).toThrow(/at least 2/);
    expect(() =>
      s.byColumn(
        'dist',
        { edges: [10, 5] },
        { n: { from: 'ele', using: 'count' } },
      ),
    ).toThrow(/ascending/);
  });

  it('rejects a non-numeric bin column', () => {
    const withStr = new TimeSeries({
      name: 's',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'host', kind: 'string' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows: [[0, 'a', 1]],
    });
    expect(() =>
      (withStr as never as TimeSeries<typeof schema>).byColumn(
        'host' as never,
        { width: 1 },
        { n: { from: 'v' as never, using: 'count' } },
      ),
    ).toThrow(/must be a number column/);
  });
});
