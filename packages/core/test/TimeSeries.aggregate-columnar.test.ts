import { describe, expect, it } from 'vitest';
import { Sequence, TimeSeries } from '../src/index.js';

/* -------------------------------------------------------------------------- */
/* Step 3B — aggregate() columnar fast path parity + edges.                    */
/*                                                                             */
/* A built-in reducer (`'sum'`) takes the columnar fast path                   */
/* (tryAggregateColumnarTimeKeyed); an exact custom-function equivalent        */
/* forces the row path (typeof reducer !== 'string' → null). Asserting the     */
/* two produce identical output directly pins the columnar bucket walk +       */
/* empty-bucket handling against the row path. Float-sensitive reducers        */
/* (stdev/median/percentile) use hand-computed values instead.                 */
/* -------------------------------------------------------------------------- */

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

type Row = readonly [number, number, string];

function series(rows: Row[]) {
  return new TimeSeries({ name: 't', schema, rows: rows as Row[] });
}

// Extract one output column's bucket values (materializes — test only).
function vals(result: TimeSeries<any>, name: string): Array<unknown> {
  return Array.from({ length: result.length }, (_, i) =>
    result.at(i)!.get(name),
  );
}

// Exact custom-function equivalents of the built-ins (force the row path).
const numbersOf = (xs: ReadonlyArray<unknown>): number[] =>
  xs.filter((v): v is number => typeof v === 'number' && !Number.isNaN(v));
const customSum = (xs: ReadonlyArray<unknown>) =>
  numbersOf(xs).reduce((a, b) => a + b, 0);
const customCount = (xs: ReadonlyArray<unknown>) => numbersOf(xs).length;
const customMin = (xs: ReadonlyArray<unknown>) => {
  const n = numbersOf(xs);
  return n.length ? Math.min(...n) : undefined;
};
const customMax = (xs: ReadonlyArray<unknown>) => {
  const n = numbersOf(xs);
  return n.length ? Math.max(...n) : undefined;
};
const customAvg = (xs: ReadonlyArray<unknown>) => {
  const n = numbersOf(xs);
  return n.length ? n.reduce((a, b) => a + b, 0) / n.length : undefined;
};

const PARITY: Array<[string, (xs: ReadonlyArray<unknown>) => unknown]> = [
  ['sum', customSum],
  ['count', customCount],
  ['min', customMin],
  ['max', customMax],
  ['avg', customAvg],
];

// Data shapes that exercise the bucket walk: dense multi-event buckets,
// sparse (empty buckets between data), single-event floor, and a boundary
// event exactly on a bucket edge.
const SHAPES: Array<[string, Row[]]> = [
  [
    'dense multi-event buckets',
    [
      [0, 1, 'a'],
      [200, 2, 'a'],
      [400, 3, 'a'],
      [800, 5, 'a'],
      [1000, 10, 'a'],
      [1200, 20, 'a'],
      [1400, 30, 'a'],
      [2500, 100, 'a'],
    ],
  ],
  [
    'sparse — empty buckets between data',
    [
      [0, 7, 'a'],
      [5000, 9, 'a'],
      [9000, 11, 'a'],
    ],
  ],
  [
    'single-event floor (1 event per bucket)',
    [
      [0, 1, 'a'],
      [1000, 2, 'a'],
      [2000, 3, 'a'],
      [3000, 4, 'a'],
    ],
  ],
  [
    'event exactly on a bucket boundary',
    [
      [0, 1, 'a'],
      [999, 2, 'a'],
      [1000, 3, 'a'],
      [2000, 4, 'a'],
    ],
  ],
];

describe('aggregate() columnar fast path — parity with the row path', () => {
  for (const [shapeName, rows] of SHAPES) {
    for (const [reducer, custom] of PARITY) {
      it(`${reducer} matches the row path: ${shapeName}`, () => {
        const s = series(rows);
        const seq = Sequence.every('1s');
        const fast = s.aggregate(seq, {
          out: { from: 'value', using: reducer },
        });
        const row = s.aggregate(seq, { out: { from: 'value', using: custom } });
        expect(vals(fast, 'out')).toEqual(vals(row, 'out'));
        // Same bucket count both ways.
        expect(fast.length).toBe(row.length);
      });
    }
  }
});

describe('aggregate() columnar fast path — hand-computed values', () => {
  const s = series([
    [0, 1, 'a'],
    [200, 2, 'a'],
    [400, 3, 'a'],
    [800, 5, 'a'], // bucket [0,1000): 1,2,3,5
    [1000, 10, 'a'],
    [1200, 20, 'a'],
    [1400, 30, 'a'], // bucket [1000,2000): 10,20,30
    [2500, 100, 'a'], // bucket [2000,3000): 100
  ]);
  const seq = Sequence.every('1s');

  it('sum / avg / count / min / max per bucket', () => {
    const r = s.aggregate(seq, {
      sum: { from: 'value', using: 'sum' },
      avg: { from: 'value', using: 'avg' },
      count: { from: 'value', using: 'count' },
      min: { from: 'value', using: 'min' },
      max: { from: 'value', using: 'max' },
    });
    expect(vals(r, 'sum')).toEqual([11, 60, 100]);
    expect(vals(r, 'avg')).toEqual([11 / 4, 20, 100]);
    expect(vals(r, 'count')).toEqual([4, 3, 1]);
    expect(vals(r, 'min')).toEqual([1, 10, 100]);
    expect(vals(r, 'max')).toEqual([5, 30, 100]);
  });

  it('median / p95 per bucket', () => {
    const r = s.aggregate(seq, {
      med: { from: 'value', using: 'median' },
      p95: { from: 'value', using: 'p95' },
    });
    // bucket [0,1000) sorted = [1,2,3,5] → median = (2+3)/2 = 2.5
    expect((vals(r, 'med') as number[])[0]).toBeCloseTo(2.5, 10);
    // bucket [2000,3000) single value → median = p95 = 100
    expect((vals(r, 'med') as number[])[2]).toBe(100);
    expect((vals(r, 'p95') as number[])[2]).toBe(100);
  });

  it('empty buckets reduce to the reducer empty-value (parity)', () => {
    // sparse: one event, then a long gap → interior buckets empty.
    const sp = series([
      [0, 7, 'a'],
      [4000, 9, 'a'],
    ]);
    const r = sp.aggregate(seq, {
      sum: { from: 'value', using: 'sum' },
      count: { from: 'value', using: 'count' },
      avg: { from: 'value', using: 'avg' },
      min: { from: 'value', using: 'min' },
    });
    // buckets: [0,1000)=7, [1000,2000)/[2000,3000)/[3000,4000)=empty, [4000,5000)=9
    expect(vals(r, 'count')).toEqual([1, 0, 0, 0, 1]);
    expect(vals(r, 'sum')).toEqual([7, 0, 0, 0, 9]);
    expect(vals(r, 'avg')).toEqual([7, undefined, undefined, undefined, 9]);
    expect(vals(r, 'min')).toEqual([7, undefined, undefined, undefined, 9]);
  });
});

describe('aggregate() columnar fast path — row-path fallbacks', () => {
  const s = series([
    [0, 1, 'a'],
    [200, 2, 'b'],
    [1000, 3, 'a'],
  ]);
  const seq = Sequence.every('1s');

  it('mixed built-in + custom mapping falls back, stays correct', () => {
    const r = s.aggregate(seq, {
      sum: { from: 'value', using: 'sum' }, // built-in
      n: { from: 'value', using: (xs) => numbersOf(xs).length }, // custom → row path
    });
    expect(vals(r, 'sum')).toEqual([3, 3]);
    expect(vals(r, 'n')).toEqual([2, 1]);
  });

  it('non-numeric source (count over a string column) falls back, stays correct', () => {
    const r = s.aggregate(seq, {
      hosts: { from: 'host', using: 'count' }, // string source → not packed Float64 → row path
    });
    expect(vals(r, 'hosts')).toEqual([2, 1]);
  });
});
