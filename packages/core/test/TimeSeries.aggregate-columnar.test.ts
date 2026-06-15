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
      max: { from: 'value', using: 'max' },
      stdev: { from: 'value', using: 'stdev' },
      med: { from: 'value', using: 'median' },
      p95: { from: 'value', using: 'p95' },
    });
    // buckets: [0,1000)=7, [1000,2000)/[2000,3000)/[3000,4000)=empty, [4000,5000)=9
    expect(vals(r, 'count')).toEqual([1, 0, 0, 0, 1]);
    expect(vals(r, 'sum')).toEqual([7, 0, 0, 0, 9]);
    expect(vals(r, 'avg')).toEqual([7, undefined, undefined, undefined, 9]);
    expect(vals(r, 'min')).toEqual([7, undefined, undefined, undefined, 9]);
    expect(vals(r, 'max')).toEqual([7, undefined, undefined, undefined, 9]);
    // The sort/variance reducers are the likeliest place reduceColumn(empty)
    // could diverge from a zero-add bucket snapshot — pin the empty buckets
    // (indices 1–3) explicitly for each.
    for (const name of ['stdev', 'med', 'p95']) {
      expect(vals(r, name).slice(1, 4)).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
    }
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

/* -------------------------------------------------------------------------- */
/* stdev — numerical stability across paths (audit v2 §1.1).                    */
/*                                                                             */
/* The fast path (reduceColumn) and the row path (bucketState) must agree.      */
/* Pre-fix bucketState used one-pass `sq/n − mean²`, which cancels              */
/* catastrophically on near-equal large values — so aggregate('stdev') silently */
/* changed result (or crashed with NaN) when an unrelated mapping flipped the   */
/* all-or-nothing fast path to the row path. All batch paths now share one      */
/* Welford recurrence, so they agree regardless of magnitude.                   */
/* -------------------------------------------------------------------------- */
describe('aggregate(stdev) — path-independent (audit §1.1)', () => {
  const seq = Sequence.every('1s');
  const STDEV_5_4 = Math.sqrt(5 / 4); // ≈ 1.118033988749895

  // A bucket of four consecutive integers offset by `base`: population stdev is
  // always sqrt(5/4), but large `base` stresses floating-point precision.
  const cluster = (base: number): Row[] =>
    [0, 1, 2, 3].map((k, i) => [i * 200, base + k, 'a'] as Row);

  // fast = pure numeric built-in (columnar fast path); row = forced to the row
  // path (Welford bucketState) by an unrelated string-source mapping that
  // disqualifies the all-or-nothing fast path for the whole call.
  const bothPaths = (rows: Row[]) => {
    const s = series(rows);
    const fast = s.aggregate(seq, { sd: { from: 'value', using: 'stdev' } });
    const row = s.aggregate(seq, {
      sd: { from: 'value', using: 'stdev' },
      hc: { from: 'host', using: 'count' },
    });
    return {
      fast: (vals(fast, 'sd') as number[])[0]!,
      row: (vals(row, 'sd') as number[])[0]!,
    };
  };

  it('fast path and forced row path agree on near-equal large values (was 1.118 vs 0)', () => {
    const { fast, row } = bothPaths(cluster(1e10));
    expect(fast).toBeCloseTo(STDEV_5_4, 9);
    expect(row).toBeCloseTo(STDEV_5_4, 9); // pre-fix row path: 0
    expect(Math.abs(row - fast) / fast).toBeLessThan(1e-12);
  });

  it('fast and row paths agree at the 2^52 precision boundary (Codex finding)', () => {
    // Before the paths were unified, reduceColumn (two-pass) computed 1.2247
    // here — its `Σv/n` mean rounds at 2^52 spacing — while Welford bucketState
    // computed the correct 1.118. An unrelated mapping flipping the path then
    // changed stdev ~8.7%. One shared recurrence closes that.
    const { fast, row } = bothPaths(cluster(2 ** 52));
    expect(fast).toBeCloseTo(STDEV_5_4, 9);
    expect(row).toBeCloseTo(STDEV_5_4, 9);
    expect(Math.abs(row - fast) / fast).toBeLessThan(1e-12);
  });

  it('forced row path stays finite on cancellation-prone data (was NaN→throw)', () => {
    // [5e7+0.1, 5e7+0.2, 5e7+0.3] → pop stdev = sqrt(0.02/3) ≈ 0.0816. The
    // old one-pass formula computed a negative variance → sqrt → NaN, which
    // the validating constructor then rejected. Welford's M2 ≥ 0.
    const s = series([
      [0, 5e7 + 0.1, 'a'],
      [200, 5e7 + 0.2, 'a'],
      [400, 5e7 + 0.3, 'a'],
    ]);
    const row = s.aggregate(seq, {
      sd: { from: 'value', using: 'stdev' },
      hc: { from: 'host', using: 'count' }, // force the row path
    });
    const v = (vals(row, 'sd') as number[])[0];
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeCloseTo(Math.sqrt(0.02 / 3), 6);
  });
});

/* -------------------------------------------------------------------------- */
/* rolling(stdev) — numerically stable sliding window.                         */
/*                                                                             */
/* rollingState needs `remove`, which plain one-pass `sq/n − mean²` can't do   */
/* stably — it cancelled on near-equal large values ([1e10, …] → 0 or a        */
/* negative variance → NaN) and drifted on large trending data. The two-stack  */
/* Welford-Chan aggregator gives the bucket path's accuracy on the window:     */
/* m2 ≥ 0, no cancellation, no shift-reference drift, agreeing to FP noise.    */
/* -------------------------------------------------------------------------- */
describe('rolling(stdev) — numerically stable sliding window', () => {
  const STDEV_5_4 = Math.sqrt(5 / 4); // ≈ 1.118033988749895

  // Population stdev over a plain array (the ground truth).
  const popStdev = (xs: number[]): number => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  };

  it('full window on near-equal large values → 1.118, not 0/NaN (was the deferred one-pass)', () => {
    // Four consecutive integers offset by 1e10: pop stdev is sqrt(5/4)
    // regardless of offset, but 1e10 makes `sq/n − mean²` cancel to 0 (or a
    // negative variance → NaN). A '10s' window covers all four at the last event.
    const s = series(
      [0, 1, 2, 3].map((k, i) => [i * 1000, 1e10 + k, 'a'] as Row),
    );
    const out = s.rolling('10s', { sd: { from: 'value', using: 'stdev' } });
    const last = out.at(out.length - 1)!.get('sd') as number;
    expect(Number.isFinite(last)).toBe(true);
    expect(last).toBeCloseTo(STDEV_5_4, 9);
  });

  it('every sliding window matches brute-force pop stdev on large trending data', () => {
    // Cumulative-distance-like trend at 1e9 scale (where the shift-reference
    // one-pass drifted): a 3s trailing window slides add+remove across 12
    // points. Each output must equal the population stdev of its half-open
    // trailing window {j : j > i − 3} to floating-point noise.
    const base = 1e9;
    const vs = Array.from({ length: 12 }, (_, i) => base + i * 7);
    const s = series(vs.map((v, i) => [i * 1000, v, 'a'] as Row));
    const out = s.rolling('3s', { sd: { from: 'value', using: 'stdev' } });
    for (let i = 0; i < vs.length; i += 1) {
      const win = vs.slice(Math.max(0, i - 2), i + 1);
      const got = out.at(i)!.get('sd') as number;
      expect(Number.isFinite(got)).toBe(true);
      expect(got).toBeCloseTo(popStdev(win), 9);
    }
  });

  it('rolling full-window stdev agrees with aggregate (bucket) stdev', () => {
    // Same cancellation-prone data, both batch paths → identical sqrt(5/4).
    const rows = [0, 1, 2, 3].map((k, i) => [i * 1000, 1e10 + k, 'a'] as Row);
    const s = series(rows);
    const rolled = s.rolling('10s', { sd: { from: 'value', using: 'stdev' } });
    const bucketed = s.aggregate(Sequence.every('10s'), {
      sd: { from: 'value', using: 'stdev' },
    });
    const r = rolled.at(rolled.length - 1)!.get('sd') as number;
    const b = bucketed.at(0)!.get('sd') as number;
    expect(r).toBeCloseTo(STDEV_5_4, 9);
    expect(b).toBeCloseTo(STDEV_5_4, 9);
    expect(Math.abs(r - b) / b).toBeLessThan(1e-12);
  });

  it('recovers the residual stdev after a realistic spike leaves the window', () => {
    // Outlier eviction is the subtractive-variance weak spot (see stdev.ts):
    // removing a value far outside the residual spread cancels `m2`. For
    // realistic magnitudes it is negligible — a 1000× spike enters then slides
    // off a 3-event window, and once gone the residual stdev still matches a
    // fresh computation of the trailing window. (Only pathological spikes —
    // ~1e7×+ the residual stdev — corrupt the running accumulator.)
    const rows: Row[] = [];
    for (let i = 0; i < 12; i += 1) {
      rows.push([i * 1000, i === 4 ? 1000 : 1 + (i % 3), 'a'] as Row);
    }
    const s = series(rows);
    const out = s.rolling('3s', { sd: { from: 'value', using: 'stdev' } });
    const vals = rows.map((r) => r[1]);
    // i=8: half-open '3s' window = {6,7,8}; the spike at i=4 is long gone.
    const got = out.at(8)!.get('sd') as number;
    expect(got).toBeCloseTo(popStdev(vals.slice(6, 9)), 9);
  });
});
