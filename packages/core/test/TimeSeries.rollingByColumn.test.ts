/**
 * Tests for `TimeSeries.rollingByColumn` — windowed value-axis aggregation
 * (docs/notes/rolling-by-column.md). The sliding-window sibling of `byColumn`:
 * for each row, reduce the rows whose axis-column value lies within `±radius`,
 * returning one record per row (positionally aligned with the series).
 */
import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'dist', kind: 'number' }, // monotonic axis (cumulative distance)
  { name: 'val', kind: 'number' },
] as const;

type Row = readonly [number, number, number];

const make = (rows: readonly Row[]) =>
  new TimeSeries({ name: 'ride', schema, rows: rows as Row[] });

// Gap schema: `dist` / `val` are `required: false`, so the constructor accepts
// `undefined` cells and records them in the validity bitmap (a required column
// rejects `undefined` at intake). Only the tuple TYPE still forbids it → cast.
const gapSchema = [
  { name: 'time', kind: 'time' },
  { name: 'dist', kind: 'number', required: false },
  { name: 'val', kind: 'number', required: false },
] as const;
const withGaps = (
  rows: ReadonlyArray<
    readonly [number, number | undefined, number | undefined]
  >,
) => new TimeSeries({ name: 'ride', schema: gapSchema, rows: rows as never });

describe('TimeSeries.rollingByColumn — centered window basics', () => {
  it('reduces the centered ±radius window at each row', () => {
    const s = make([
      [0, 0, 10],
      [1, 10, 20],
      [2, 20, 30],
      [3, 30, 40],
      [4, 40, 50],
    ]);
    const out = s.rollingByColumn(
      'dist',
      { radius: 10 },
      {
        n: { from: 'val', using: 'count' },
        sum: { from: 'val', using: 'sum' },
        avg: { from: 'val', using: 'avg' },
        lo: { from: 'val', using: 'min' },
        hi: { from: 'val', using: 'max' },
      },
    );
    expect(out).toEqual([
      { n: 2, sum: 30, avg: 15, lo: 10, hi: 20 }, // dist 0: window {0,10}
      { n: 3, sum: 60, avg: 20, lo: 10, hi: 30 }, // dist 10: {0,10,20}
      { n: 3, sum: 90, avg: 30, lo: 20, hi: 40 }, // dist 20: {10,20,30}
      { n: 3, sum: 120, avg: 40, lo: 30, hi: 50 }, // dist 30: {20,30,40}
      { n: 2, sum: 90, avg: 45, lo: 40, hi: 50 }, // dist 40: {30,40}
    ]);
  });

  it('window bounds are inclusive on both ends', () => {
    // radius 10, neighbour exactly 10 away → included.
    const s = make([
      [0, 0, 1],
      [1, 10, 1],
      [2, 21, 1], // 21 is > 10 from dist 10 → excluded from row 1's window
    ]);
    const out = s.rollingByColumn(
      'dist',
      { radius: 10 },
      {
        n: { from: 'val', using: 'count' },
      },
    );
    expect(out.map((r) => r.n)).toEqual([2, 2, 1]);
  });

  it('output is positionally aligned: one record per row', () => {
    const s = make([
      [0, 0, 1],
      [1, 5, 1],
      [2, 9, 1],
    ]);
    const out = s.rollingByColumn(
      'dist',
      { radius: 100 },
      {
        n: { from: 'val', using: 'count' },
      },
    );
    expect(out).toHaveLength(3);
  });

  it('ties on the axis: equal-valued rows share one window', () => {
    const s = make([
      [0, 5, 1],
      [1, 5, 2],
      [2, 5, 3],
    ]);
    const out = s.rollingByColumn(
      'dist',
      { radius: 1 },
      {
        n: { from: 'val', using: 'count' },
        sum: { from: 'val', using: 'sum' },
      },
    );
    expect(out).toEqual([
      { n: 3, sum: 6 },
      { n: 3, sum: 6 },
      { n: 3, sum: 6 },
    ]);
  });

  it('radius spanning the whole series → every window is the full series', () => {
    const s = make([
      [0, 0, 10],
      [1, 10, 20],
      [2, 20, 30],
    ]);
    const out = s.rollingByColumn(
      'dist',
      { radius: 1000 },
      {
        n: { from: 'val', using: 'count' },
        sum: { from: 'val', using: 'sum' },
      },
    );
    expect(out).toEqual([
      { n: 3, sum: 60 },
      { n: 3, sum: 60 },
      { n: 3, sum: 60 },
    ]);
  });

  it('tiny radius → window is just the row itself', () => {
    const s = make([
      [0, 0, 10],
      [1, 10, 20],
      [2, 20, 30],
    ]);
    const out = s.rollingByColumn(
      'dist',
      { radius: 0.5 },
      {
        sum: { from: 'val', using: 'sum' },
      },
    );
    expect(out.map((r) => r.sum)).toEqual([10, 20, 30]);
  });
});

describe('TimeSeries.rollingByColumn — two-pointer sweep correctness', () => {
  it('matches hand-computed window counts/sums across a 10-row sweep', () => {
    const rows: Row[] = [];
    for (let i = 0; i < 10; i += 1) rows.push([i, i, i]); // dist = val = i
    const out = make(rows).rollingByColumn(
      'dist',
      { radius: 2 },
      {
        n: { from: 'val', using: 'count' },
        sum: { from: 'val', using: 'sum' },
      },
    );
    // counts: rows within ±2 of each dist
    expect(out.map((r) => r.n)).toEqual([3, 4, 5, 5, 5, 5, 5, 5, 4, 3]);
    expect(out[0]!.sum).toBe(0 + 1 + 2);
    expect(out[4]!.sum).toBe(2 + 3 + 4 + 5 + 6);
    expect(out[9]!.sum).toBe(7 + 8 + 9);
  });

  it('first/last (index-based eviction reducers) track the sliding window', () => {
    // first/last remove by arrival index — correct HERE because the two-pointer
    // evicts in axis order, which for a sorted axis is strictly-increasing
    // index = arrival order. Pin it: as the window slides, the evicted low rows
    // must drop out of `first` (the live reorder+retention bug this family has
    // can't surface here — docs/notes/live-columnar-assessment-2026-06.md).
    const rows: Row[] = [];
    for (let i = 0; i < 5; i += 1) rows.push([i, i, i * 10]);
    const out = make(rows).rollingByColumn(
      'dist',
      { radius: 1 },
      {
        f: { from: 'val', using: 'first' },
        l: { from: 'val', using: 'last' },
      },
    );
    // windows: {0,1},{0,1,2},{1,2,3},{2,3,4},{3,4} → first/last by index
    expect(out.map((r) => r.f)).toEqual([0, 0, 10, 20, 30]);
    expect(out.map((r) => r.l)).toEqual([10, 20, 30, 40, 40]);
  });
});

describe('TimeSeries.rollingByColumn — percentile band (the estela rollingSpread shape)', () => {
  it('produces an ordered p5 ≤ p25 ≤ median ≤ p75 ≤ p95 band per row', () => {
    const rows: Row[] = [];
    for (let i = 0; i < 30; i += 1) rows.push([i, i, (i % 7) * 10]); // sawtooth value
    const out = make(rows).rollingByColumn(
      'dist',
      { radius: 5 },
      {
        lo: { from: 'val', using: 'p5' },
        iqlo: { from: 'val', using: 'p25' },
        mid: { from: 'val', using: 'median' },
        iqhi: { from: 'val', using: 'p75' },
        hi: { from: 'val', using: 'p95' },
      },
    );
    expect(out).toHaveLength(30);
    for (const r of out) {
      const { lo, iqlo, mid, iqhi, hi } = r as Record<string, number>;
      expect(lo).toBeLessThanOrEqual(iqlo);
      expect(iqlo).toBeLessThanOrEqual(mid);
      expect(mid).toBeLessThanOrEqual(iqhi);
      expect(iqhi).toBeLessThanOrEqual(hi);
    }
  });

  it('median is robust to a single spike inside the window', () => {
    const s = make([
      [0, 0, 10],
      [1, 1, 10],
      [2, 2, 1000], // spike
      [3, 3, 10],
      [4, 4, 10],
    ]);
    const out = s.rollingByColumn(
      'dist',
      { radius: 10 },
      {
        mid: { from: 'val', using: 'median' },
      },
    );
    // every window contains all 5 rows → median of [10,10,10,10,1000] = 10
    expect(out.map((r) => r.mid)).toEqual([10, 10, 10, 10, 10]);
  });
});

describe('TimeSeries.rollingByColumn — missing / undefined handling', () => {
  it('a missing-axis row is excluded from windows and emits the empty snapshot', () => {
    const s = withGaps([
      [0, 0, 10],
      [1, undefined, 20], // no axis position
      [2, 20, 30],
    ]);
    const out = s.rollingByColumn(
      'dist',
      { radius: 10 },
      {
        n: { from: 'val', using: 'count' },
        sum: { from: 'val', using: 'sum' },
      },
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ n: 1, sum: 10 }); // val 20 (missing-axis row) excluded
    expect(out[1]!.n).toBe(0); // missing-axis row → empty window
    expect(out[2]).toEqual({ n: 1, sum: 30 });
  });

  it('a defined-axis row with a missing SOURCE value still anchors a window; the value is skipped', () => {
    const s = withGaps([
      [0, 0, 10],
      [1, 10, undefined], // valid axis, missing source value
      [2, 20, 30],
    ]);
    const out = s.rollingByColumn(
      'dist',
      { radius: 10 },
      {
        n: { from: 'val', using: 'count' },
        sum: { from: 'val', using: 'sum' },
      },
    );
    expect(out[0]).toEqual({ n: 1, sum: 10 }); // window {row0,row1}; row1 val skipped
    expect(out[1]).toEqual({ n: 2, sum: 40 }); // window {0,1,2}; defined 10,30
    expect(out[2]).toEqual({ n: 1, sum: 30 }); // window {row1,row2}; row1 val skipped
  });

  it('empty snapshots on missing-axis rows are fresh per row (array reducers do not alias)', () => {
    // An array-kind reducer's empty value is `[]`; a cached/shared empty would
    // alias one array across every missing-axis row. Two adjacent missing-axis
    // rows must get DISTINCT empty arrays.
    const s = withGaps([
      [0, 0, 1],
      [1, undefined, 2],
      [2, undefined, 3],
      [3, 10, 4],
    ]);
    const out = s.rollingByColumn(
      'dist',
      { radius: 100 },
      {
        s: { from: 'val', using: 'samples' },
      },
    );
    expect(out[1]!.s).toEqual([]);
    expect(out[2]!.s).toEqual([]);
    expect(out[1]!.s).not.toBe(out[2]!.s); // distinct instances, no aliasing
  });

  it('a missing-axis row between finite rows: the shared deque resumes correctly', () => {
    // The missing row hits the `continue` path and does NOT touch the shared
    // window state — so the next finite row must resume the min/max deque (and
    // its eviction) as if the missing row were absent.
    const s = withGaps([
      [0, 0, 50],
      [1, 10, 10],
      [2, undefined, 999], // excluded from every window
      [3, 20, 20],
      [4, 30, 5],
    ]);
    const out = s.rollingByColumn(
      'dist',
      { radius: 15 },
      {
        lo: { from: 'val', using: 'min' },
        hi: { from: 'val', using: 'max' },
      },
    );
    // windows by dist (±15): {0,10}, {0,10,20}, —, {10,20,30}, {20,30}
    expect(out.map((r) => r.lo)).toEqual([10, 10, undefined, 5, 5]);
    expect(out.map((r) => r.hi)).toEqual([50, 50, undefined, 20, 20]);
  });
});

describe('TimeSeries.rollingByColumn — custom-function reducer', () => {
  it('supports a custom function over the window values', () => {
    const s = make([
      [0, 0, 10],
      [1, 10, 20],
      [2, 20, 30],
    ]);
    const out = s.rollingByColumn(
      'dist',
      { radius: 10 },
      {
        // sum of squares — exercises the buffering rolling adapter
        ss: {
          from: 'val',
          using: (vals: readonly unknown[]) =>
            (vals as number[]).reduce((a, b) => a + b * b, 0),
        },
      },
    );
    expect(out.map((r) => r.ss)).toEqual([
      10 * 10 + 20 * 20, // {10,20}
      10 * 10 + 20 * 20 + 30 * 30, // {10,20,30}
      20 * 20 + 30 * 30, // {20,30}
    ]);
  });
});

describe('TimeSeries.rollingByColumn — validation', () => {
  it('empty series → []', () => {
    const out = make([]).rollingByColumn(
      'dist',
      { radius: 10 },
      {
        n: { from: 'val', using: 'count' },
      },
    );
    expect(out).toEqual([]);
  });

  it('throws on a non-decreasing axis, naming the offending row', () => {
    const s = make([
      [0, 0, 1],
      [1, 10, 2],
      [2, 5, 3], // descends
    ]);
    expect(() =>
      s.rollingByColumn(
        'dist',
        { radius: 1 },
        { n: { from: 'val', using: 'count' } },
      ),
    ).toThrow(/non-decreasing.*row 2/s);
  });

  it('throws on a non-positive or non-finite radius', () => {
    const s = make([[0, 0, 1]]);
    const m = { n: { from: 'val', using: 'count' } } as const;
    expect(() => s.rollingByColumn('dist', { radius: 0 }, m)).toThrow(
      /positive finite/,
    );
    expect(() => s.rollingByColumn('dist', { radius: -5 }, m)).toThrow(
      /positive finite/,
    );
    expect(() => s.rollingByColumn('dist', { radius: NaN }, m)).toThrow(
      /positive finite/,
    );
    expect(() => s.rollingByColumn('dist', { radius: Infinity }, m)).toThrow(
      /positive finite/,
    );
  });

  it('throws on an unknown axis column', () => {
    const s = make([[0, 0, 1]]);
    expect(() =>
      // cast past the compile-time NumericColumnNameForSchema guard
      s.rollingByColumn(
        'nope' as never,
        { radius: 1 },
        { n: { from: 'val', using: 'count' } },
      ),
    ).toThrow(/unknown column/);
  });

  it('throws when the axis column is not numeric', () => {
    const s2 = new TimeSeries({
      name: 's',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'label', kind: 'string' },
        { name: 'val', kind: 'number' },
      ] as const,
      rows: [
        [0, 'a', 1],
        [1, 'b', 2],
      ] as ReadonlyArray<readonly [number, string, number]> as never,
    });
    expect(() =>
      s2.rollingByColumn(
        'label' as never,
        { radius: 1 },
        { n: { from: 'val', using: 'count' } },
      ),
    ).toThrow(/must be a number column/);
  });
});

describe('TimeSeries.rollingByColumn — { at } explicit centers (F-rolling-by-row)', () => {
  const ride = () =>
    make([
      [0, 0, 10],
      [1, 10, 20],
      [2, 20, 30],
      [3, 30, 40],
      [4, 40, 50],
    ]);

  it('evaluates the window at each explicit center → one record per center', () => {
    const out = ride().rollingByColumn(
      'dist',
      { radius: 10, at: [5, 25, 45] },
      {
        n: { from: 'val', using: 'count' },
        sum: { from: 'val', using: 'sum' },
      },
    );
    expect(out).toHaveLength(3); // one per center, NOT per row
    expect(out).toEqual([
      { n: 2, sum: 30 }, // center 5: window [-5,15] → dist 0,10
      { n: 2, sum: 70 }, // center 25: [15,35] → dist 20,30
      { n: 1, sum: 50 }, // center 45: [35,55] → dist 40
    ]);
  });

  it('at = the row axis values reproduces the per-row result', () => {
    const s = ride();
    const perRow = s.rollingByColumn(
      'dist',
      { radius: 10 },
      {
        n: { from: 'val', using: 'count' },
      },
    );
    const atRows = s.rollingByColumn(
      'dist',
      { radius: 10, at: [0, 10, 20, 30, 40] },
      {
        n: { from: 'val', using: 'count' },
      },
    );
    expect(atRows).toEqual(perRow); // [2,3,3,3,2]
  });

  it('a center with no rows in range yields the empty value', () => {
    const out = ride().rollingByColumn(
      'dist',
      { radius: 6, at: [5, 1000] },
      {
        n: { from: 'val', using: 'count' },
      },
    );
    expect(out.map((r) => r.n)).toEqual([2, 0]); // center 1000 → empty window
  });

  it('throws on non-ascending or non-finite centers', () => {
    const s = ride();
    const m = { n: { from: 'val', using: 'count' } } as const;
    expect(() =>
      s.rollingByColumn('dist', { radius: 1, at: [10, 5] }, m),
    ).toThrow(/non-decreasing/);
    expect(() =>
      s.rollingByColumn('dist', { radius: 1, at: [NaN] }, m),
    ).toThrow(/finite/);
  });
});
