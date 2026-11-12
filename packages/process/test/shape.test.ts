import { describe, expect, it } from 'vitest';
import { ChunkedFloat64Column, Float64Column, TimeSeries } from 'pond-ts';
import {
  bind,
  createRegistry,
  packColumn,
  run,
  type OpDef,
  type ParamValue,
} from '../src/index.js';
import { binStart } from '../src/plan/folds.js';

// `shape` cuts the rows into equal row bins with core's
// `Float64Column.bin` and reports each bin's last value at the bin's end
// time ([PND-SHAPEEND]).

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const day = (i: number) => new Date(T0 + i * DAY).toISOString().slice(0, 10);

const series = (n: number) =>
  TimeSeries.fromJSON({
    name: 'px',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'px', kind: 'number' },
    ] as const,
    rows: Array.from({ length: n }, (_, i) => [T0 + i * DAY, 10 + i]),
  });

/** px with the rows `gap` names missing, packed or chunked. */
const gappy = (gap: (i: number) => boolean, chunked = false): OpDef => ({
  name: chunked ? 'chunkedGaps' : 'gaps',
  family: 'transform',
  summary: 'px with some rows missing.',
  params: {},
  inputs: [{ role: 'source' }],
  outputs: [{ id: '', unit: 'inherit' }],
  run: (ctx) => {
    const n = ctx.series.length;
    const v = Array.from({ length: n }, (_, i) =>
      gap(i) ? undefined : 10 + i,
    );
    if (!chunked) return v;
    // Two chunks, so the fold sees a column that is not packed and
    // takes the boxed path.
    const half = n >> 1;
    return new ChunkedFloat64Column([
      packColumn(v.slice(0, half)),
      packColumn(v.slice(half)),
    ]) as unknown as ReturnType<OpDef['run']>;
  },
});

function shapeOf(
  n: number,
  params: Record<string, ParamValue>,
  over: OpDef | undefined = undefined,
): { points: number; series: [string, number][] } {
  let registry = createRegistry();
  if (over !== undefined) registry = registry.define(over);
  const graph = bind(series(n), { registry, units: { px: '%' } });
  const input = over === undefined ? 'px' : { op: over.name, inputs: ['px'] };
  const res = run(graph, {
    plan: [],
    select: [{ on: { op: 'shape', params, inputs: [input] } }],
  });
  expect(res.skipped).toEqual([]);
  const { points, series: s } = res.facts[0] as unknown as {
    points: number;
    series: [string, number][];
  };
  return { points, series: s };
}

describe('shape — equal row bins', () => {
  it('binStart is core bin’s own split', () => {
    // Values are row numbers, so each bin's first/last channel is the
    // row it starts and ends on.
    for (const n of [1, 2, 3, 7, 10, 41, 103, 399, 1000]) {
      const rows = new Float64Array(n).map((_, i) => i);
      const col = new Float64Column(rows, n, true);
      for (let bins = 1; bins <= Math.min(n, 60); bins += 1) {
        const { first, last } = col.bin(bins, 'minMaxFirstLast');
        for (let i = 0; i < bins; i += 1) {
          expect(first[i], `n=${n} bins=${bins} bin ${i}`).toBe(
            binStart(i, n, bins),
          );
          expect(last[i], `n=${n} bins=${bins} bin ${i}`).toBe(
            binStart(i + 1, n, bins) - 1,
          );
        }
      }
    }
  });

  it('ends on the newest row when rows are not a multiple of points', () => {
    const out = shapeOf(103, { points: 10 });
    expect(out.points).toBe(10);
    expect(out.series).toHaveLength(10);
    // The newest row is the last bin's last row.
    expect(out.series.at(-1)).toEqual([day(102), 112]);
    // The first point is the first bin's last value, not row 0: bin 0 is
    // rows [0, 10).
    expect(out.series[0]).toEqual([day(9), 19]);
  });

  it('never returns more points than asked, and covers every row', () => {
    for (const [n, want] of [
      [399, 200],
      [401, 400],
      [1000, 40],
      [41, 40],
    ] as const) {
      const out = shapeOf(n, { points: want });
      expect(out.points).toBe(want);
      expect(out.series.at(-1)![0]).toBe(day(n - 1));
    }
  });

  it('gives one point per row when there are fewer rows than points', () => {
    const out = shapeOf(5, { points: 40 });
    expect(out.series).toEqual([0, 1, 2, 3, 4].map((i) => [day(i), 10 + i]));
  });

  it('answers an empty series with no points', () => {
    expect(shapeOf(0, { points: 40 })).toMatchObject({
      points: 0,
      series: [],
    });
  });
});

describe('shape — gaps', () => {
  // Bins of 4 rows over 12; row 3 is missing, rows 4–7 all are.
  const gap = (i: number) => i === 3 || (i >= 4 && i <= 7);

  for (const chunked of [false, true]) {
    const path = chunked ? 'chunked' : 'packed';

    it(`a bin ending on a gap keeps the bin end time (${path})`, () => {
      const out = shapeOf(12, { points: 3 }, gappy(gap, chunked));
      // Bin 0 is rows 0–3: its last defined value is row 2's, stamped
      // with row 3's time, the bin's end.
      expect(out.series[0]).toEqual([day(3), 12]);
    });

    it(`drops a bin with no defined value (${path})`, () => {
      const out = shapeOf(12, { points: 3 }, gappy(gap, chunked));
      // Bin 1 (rows 4–7) is all gaps: left out, so `points` is 2.
      expect(out).toEqual({
        points: 2,
        series: [
          [day(3), 12],
          [day(11), 21],
        ],
      });
    });
  }
});
