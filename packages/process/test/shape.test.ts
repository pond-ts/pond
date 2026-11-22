import { describe, expect, it } from 'vitest';
import { ChunkedFloat64Column, Float64Column, TimeSeries } from 'pond-ts';
import {
  bind,
  change,
  createRegistry,
  packColumn,
  run,
  specId,
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

const SHAPE_HOWS = [
  'sample',
  'mean',
  'median',
  'min',
  'max',
  'minMax',
  'minMaxFirstLast',
] as const;

const series = (n: number) =>
  TimeSeries.fromJSON({
    name: 'px',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'px', kind: 'number' },
    ] as const,
    rows: Array.from({ length: n }, (_, i) => [T0 + i * DAY, 10 + i]),
  });

/** A column of `f(row)` (undefined is a gap), packed or chunked. */
const derived = (
  f: (i: number) => number | undefined,
  chunked = false,
): OpDef => ({
  name: chunked ? 'chunkedDerived' : 'derived',
  family: 'transform',
  summary: 'A column made up per row.',
  params: {},
  inputs: [{ role: 'source' }],
  outputs: [{ id: '', unit: 'inherit' }],
  run: (ctx) => {
    const n = ctx.series.length;
    const v = Array.from({ length: n }, (_, i) => f(i));
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

/** The bodies of `folds` over px (or `over` of px), in order. */
function factsOf(
  n: number,
  folds: { op: string; params?: Record<string, ParamValue> }[],
  over: OpDef | undefined = undefined,
): Record<string, unknown>[] {
  let registry = createRegistry().define(change);
  if (over !== undefined) registry = registry.define(over);
  const graph = bind(series(n), { registry, units: { px: '%' } });
  const input = over === undefined ? 'px' : { op: over.name, inputs: ['px'] };
  const res = run(graph, {
    plan: [],
    select: folds.map((f) => ({ on: { ...f, inputs: [input] } })),
  });
  expect(res.skipped).toEqual([]);
  return res.facts as unknown as Record<string, unknown>[];
}

function shapeOf(
  n: number,
  params: Record<string, ParamValue>,
  over: OpDef | undefined = undefined,
): { points: number; series: [string, ...number[]][] } {
  const fact = factsOf(n, [{ op: 'shape', params }], over)[0]!;
  return {
    points: fact['points'] as number,
    series: fact['series'] as [string, ...number[]][],
  };
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
  const px = (i: number) => (i >= 3 && i <= 7 ? undefined : 10 + i);

  for (const chunked of [false, true]) {
    const path = chunked ? 'chunked' : 'packed';

    it(`a bin ending on a gap keeps the bin end time (${path})`, () => {
      const out = shapeOf(12, { points: 3 }, derived(px, chunked));
      // Bin 0 is rows 0–3: its last defined value is row 2's, stamped
      // with row 3's time, the bin's end.
      expect(out.series[0]).toEqual([day(3), 12]);
    });

    it(`drops a bin with no defined value (${path})`, () => {
      const out = shapeOf(12, { points: 3 }, derived(px, chunked));
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

describe('shape — how', () => {
  // Two bins of 10 rows; row 5 is a spike that sampling misses.
  const spiky = derived((i) => (i === 5 ? 1000 : 10 + i));
  const cases: [string, [string, ...number[]][]][] = [
    [
      'sample',
      [
        [day(9), 19],
        [day(19), 29],
      ],
    ],
    [
      'mean',
      [
        [day(9), 113],
        [day(19), 24.5],
      ],
    ],
    [
      'median',
      [
        [day(9), 15],
        [day(19), 24.5],
      ],
    ],
    [
      'min',
      [
        [day(9), 10],
        [day(19), 20],
      ],
    ],
    [
      'max',
      [
        [day(9), 1000],
        [day(19), 29],
      ],
    ],
    [
      'minMax',
      [
        [day(9), 10, 1000],
        [day(19), 20, 29],
      ],
    ],
    [
      'minMaxFirstLast',
      [
        [day(9), 10, 1000, 10, 19],
        [day(19), 20, 29, 20, 29],
      ],
    ],
  ];

  for (const [how, series] of cases) {
    it(`${how}: one point per bin, shaped like core bin's output`, () => {
      expect(shapeOf(20, { points: 2, how }, spiky)).toEqual({
        points: 2,
        series,
      });
    });
  }

  it('defaults to sample', () => {
    expect(shapeOf(20, { points: 2 }, spiky)).toEqual(
      shapeOf(20, { points: 2, how: 'sample' }, spiky),
    );
  });

  // Bins of 4 rows over 12, the middle one all gaps.
  const px = (i: number) => (i >= 4 && i <= 7 ? undefined : 10 + i);
  for (const [how] of cases) {
    for (const chunked of [false, true]) {
      it(`${how}: drops an all-gap bin, so points counts bins (${chunked ? 'chunked' : 'packed'})`, () => {
        const out = shapeOf(12, { points: 3, how }, derived(px, chunked));
        expect(out.points).toBe(2);
        expect(out.series.map((p) => p[0])).toEqual([day(3), day(11)]);
        expect(out.series.flat()).not.toContain(NaN);
      });
    }
  }

  it('refuses a reducer whose empty bin is not a gap', () => {
    for (const how of ['sum', 'count', 'p95', 'last']) {
      const graph = bind(series(10), { registry: createRegistry() });
      const res = run(graph, {
        plan: [],
        select: [{ on: { op: 'shape', params: { how }, inputs: ['px'] } }],
        onError: 'collect',
      });
      expect(res.skipped[0]!.reason, how).toMatch(/shape\.how must be one of/);
    }
  });

  it('lands in the id, so each how is its own answer', () => {
    const registry = createRegistry();
    const id = (params?: Record<string, ParamValue>) =>
      specId(registry, {
        op: 'shape',
        ...(params && { params }),
        inputs: ['px'],
      });
    expect(id()).toBe('p1:shape(px;how=sample,points=40)');
    expect(id({ how: 'sample' })).toBe(id());
    expect(id({ how: 'minMax' })).toBe('p1:shape(px;how=minMax,points=40)');
  });
});

describe('shape — gaps inside bins, every how', () => {
  // Bins of 4 rows over 12. Every bin has a gap but none is all gaps, so
  // nothing is dropped and every reducer must skip the gaps itself. A
  // column that claimed `allFinite` while holding gaps would let NaN into
  // these values (and drop the bin), or count the gaps.
  //   bin 0, rows 0–3:  5, –, 9, 1
  //   bin 1, rows 4–7:  4, 8, –, –   (ends on two gaps)
  //   bin 2, rows 8–11: –, 7, 3, 6   (starts on a gap)
  const cells = [5, undefined, 9, 1, 4, 8, undefined, undefined];
  const px = (i: number) => (i < 8 ? cells[i] : [undefined, 7, 3, 6][i - 8]);
  const ends = [day(3), day(7), day(11)];
  const cases: [string, number[][]][] = [
    ['sample', [[1], [8], [6]]],
    ['mean', [[5], [6], [5.333333]]],
    ['median', [[5], [6], [6]]],
    ['min', [[1], [4], [3]]],
    ['max', [[9], [8], [7]]],
    [
      'minMax',
      [
        [1, 9],
        [4, 8],
        [3, 7],
      ],
    ],
    [
      'minMaxFirstLast',
      [
        [1, 9, 5, 1],
        [4, 8, 4, 8],
        [3, 7, 7, 6],
      ],
    ],
  ];

  for (const [how, values] of cases) {
    for (const chunked of [false, true]) {
      it(`${how} skips gaps inside a bin (${chunked ? 'chunked' : 'packed'})`, () => {
        expect(shapeOf(12, { points: 3, how }, derived(px, chunked))).toEqual({
          points: 3,
          series: values.map((v, i) => [ends[i], ...v]),
        });
      });
    }
  }

  for (const chunked of [false, true]) {
    const path = chunked ? 'chunked' : 'packed';

    it(`the newest point is stamped with the newest row even when it is a gap (${path})`, () => {
      // Row 9, the newest, is a gap; row 8 is the last value. The point
      // still ends the line at row 9's time, while the scale's `last`
      // says where the value really came from.
      const over = derived((i) => (i === 9 ? undefined : 10 + i), chunked);
      const fact = factsOf(
        10,
        [{ op: 'shape', params: { points: 5 } }],
        over,
      )[0]!;
      expect((fact['series'] as unknown[]).at(-1)).toEqual([day(9), 18]);
      expect(fact['last']).toEqual({ value: 18, at: day(8) });
    });

    it(`an all-gap series gives no points for any how (${path})`, () => {
      for (const [how] of cases) {
        const fact = factsOf(
          9,
          [{ op: 'shape', params: { points: 3, how } }],
          derived(() => undefined, chunked),
        )[0]!;
        expect(fact, how).toMatchObject({
          points: 0,
          first: null,
          last: null,
          min: null,
          max: null,
          series: [],
        });
      }
    });

    it(`an empty series gives no points for any how (${path})`, () => {
      // Core `bin(0)` throws; shape must answer instead.
      for (const [how] of cases) {
        expect(
          shapeOf(
            0,
            { points: 40, how },
            derived(() => 1, chunked),
          ),
          how,
        ).toEqual({ points: 0, series: [] });
      }
    });
  }

  it('the scale is the same whatever the how', () => {
    const scales = cases.map(([how]) => {
      const { first, last, min, max } = factsOf(
        12,
        [{ op: 'shape', params: { points: 3, how } }],
        derived(px),
      )[0]!;
      return { first, last, min, max };
    });
    expect(scales[0]).toEqual({
      first: { value: 5, at: day(0) },
      last: { value: 6, at: day(11) },
      min: { value: 1, at: day(3) },
      max: { value: 9, at: day(2) },
    });
    for (const s of scales) expect(s).toEqual(scales[0]);
  });
});

describe('shape — sizes', () => {
  it('one row is one point, for every how', () => {
    const widths: Record<string, number> = { minMax: 2, minMaxFirstLast: 4 };
    for (const how of SHAPE_HOWS) {
      const out = shapeOf(1, { points: 40, how });
      expect(out.points, how).toBe(1);
      expect(out.series, how).toEqual([
        [day(0), ...Array<number>(widths[how] ?? 1).fill(10)],
      ]);
    }
  });

  it('exactly as many rows as points is one point per row', () => {
    const out = shapeOf(40, { points: 40 });
    expect(out.series).toEqual(
      Array.from({ length: 40 }, (_, i) => [day(i), 10 + i]),
    );
  });

  it('a prime row count splits the way core bin does', () => {
    // 37 rows into 5 bins: core's split is [0,7) [7,14) [14,22) [22,29)
    // [29,37), so the bins end on rows 6, 13, 21, 28 and 36.
    const out = shapeOf(37, { points: 5, how: 'minMaxFirstLast' });
    expect(out.series).toEqual([
      [day(6), 10, 16, 10, 16],
      [day(13), 17, 23, 17, 23],
      [day(21), 24, 31, 24, 31],
      [day(28), 32, 38, 32, 38],
      [day(36), 39, 46, 39, 46],
    ]);
  });

  it('takes points at either end of its range and refuses outside it', () => {
    expect(shapeOf(500, { points: 2 }).points).toBe(2);
    expect(shapeOf(500, { points: 400 }).points).toBe(400);
    for (const points of [1, 401, 2.5]) {
      const graph = bind(series(10), { registry: createRegistry() });
      const res = run(graph, {
        plan: [],
        select: [{ on: { op: 'shape', params: { points }, inputs: ['px'] } }],
        onError: 'collect',
      });
      expect(res.facts, String(points)).toEqual([]);
      expect(res.skipped[0]!.reason, String(points)).toMatch(/shape\.points/);
    }
  });

  it('stamps an intraday series with full instants at each bin end', () => {
    const FIVE_MIN = 300_000;
    const intraday = TimeSeries.fromJSON({
      name: 'px',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'px', kind: 'number' },
      ] as const,
      rows: Array.from({ length: 7 }, (_, i) => [T0 + i * FIVE_MIN, i]),
    });
    const graph = bind(intraday, { registry: createRegistry() });
    const res = run(graph, {
      plan: [],
      select: [{ on: { op: 'shape', params: { points: 3 }, inputs: ['px'] } }],
    });
    // 7 rows into 3 bins: [0,2) [2,4) [4,7).
    expect(res.facts[0]!['series']).toEqual([
      ['2026-01-01T00:05:00Z', 1],
      ['2026-01-01T00:15:00Z', 3],
      ['2026-01-01T00:30:00Z', 6],
    ]);
  });
});

describe('shape — scale', () => {
  const scaleOf = (n: number, over?: OpDef) => {
    const { first, last, min, max } = factsOf(
      n,
      [{ op: 'shape', params: { points: 2 } }],
      over,
    )[0]!;
    return { first, last, min, max };
  };

  it('reports first, last, min and max over the whole series', () => {
    // Row 5's spike is in neither sampled point (rows 9 and 19), and is
    // still the max: the scale is the series', not the points'.
    const spiky = derived((i) => (i === 5 ? 1000 : 10 + i));
    const fact = factsOf(
      20,
      [{ op: 'shape', params: { points: 2 } }],
      spiky,
    )[0]!;
    expect(fact['series']).toEqual([
      [day(9), 19],
      [day(19), 29],
    ]);
    expect(scaleOf(20, spiky)).toEqual({
      first: { value: 10, at: day(0) },
      last: { value: 29, at: day(19) },
      min: { value: 10, at: day(0) },
      max: { value: 1000, at: day(5) },
    });
  });

  for (const chunked of [false, true]) {
    it(`skips gaps at either end (${chunked ? 'chunked' : 'packed'})`, () => {
      const px = derived((i) => (i < 2 || i > 7 ? undefined : 10 - i), chunked);
      expect(scaleOf(10, px)).toEqual({
        first: { value: 8, at: day(2) },
        last: { value: 3, at: day(7) },
        min: { value: 3, at: day(7) },
        max: { value: 8, at: day(2) },
      });
    });
  }

  it('is in the same format as change and extremes', () => {
    const px = derived((i) => (i === 0 || i === 6 ? undefined : (i * 7) % 5));
    const [shape, changed, range] = factsOf(
      8,
      [{ op: 'shape' }, { op: 'change' }, { op: 'extremes' }],
      px,
    );
    expect(shape).toMatchObject({
      first: changed!['first'],
      last: changed!['last'],
      min: range!['min'],
      max: range!['max'],
    });
  });

  it('is null per field with no defined value', () => {
    const none = { first: null, last: null, min: null, max: null };
    expect(
      scaleOf(
        6,
        derived(() => undefined),
      ),
    ).toEqual(none);
    expect(scaleOf(0)).toEqual(none);
  });
});
