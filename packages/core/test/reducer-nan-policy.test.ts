import { describe, expect, it } from 'vitest';
import { Event, Sequence, Time, TimeSeries } from '../src/index.js';
import { bucketStateFor, rollingStateFor } from '../src/reducers/index.js';
import {
  ColumnarStore,
  Float64Column,
  concatSorted,
  timeKeyColumnFromArray,
} from '../src/columnar/index.js';
import type { ColumnValue } from '../src/schema/index.js';

// Parity matrix for the reducer non-finite policy
// (docs/notes/reducer-nan-policy.md): a non-finite numeric (NaN / ±Inf) is
// treated as missing — skipped — uniformly across all four execution paths.
// This both pins the policy's values and is the standing drift-defense that
// the stdev incident (#1.1) and the min/max divergence proved we needed.
//
// The four paths and how each is reached here:
//   - reduceColumn  → `series.reduce(col, name)` / `series.aggregate(...)` on a
//                     packed numeric column (the columnar fast path).
//   - reduce (row)  → `series.reduce(col, 'first'|'last')` — no `reduceColumn`,
//                     so it routes through the row pre-filter.
//   - bucketState   → the `bucketStateFor(name)` factory, fed directly.
//   - rollingState  → `series.rolling(window, ...)` and `rollingStateFor`.

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
] as const;

// Since [PND-NANREP] no public door can put a non-finite value into a number
// column: `fromEvents` (this helper) stores `NaN` / `±Infinity` as **missing**,
// and so does every computed writer. So a series built here carries gaps where
// the input had non-finite values, and the series-level legs below pin that
// the answers are the policy's. The reducer factories are still fed raw
// non-finite values directly (`bucketValue` / `rollingValue`), and the column
// API's guarded loops are reached through the trusted `Float64Column`
// constructor (the only way left to build a column holding one).
function makeSeries(
  values: ReadonlyArray<number | undefined>,
): TimeSeries<typeof schema> {
  return TimeSeries.fromEvents(
    values.map((v, i) =>
      v === undefined
        ? new Event(new Time(i * 1000), {})
        : new Event(new Time(i * 1000), { value: v }),
    ),
    { schema, name: 's' },
  );
}

// One-bucket aggregate value (covers the whole series → one row).
function aggregateAll(
  series: TimeSeries<typeof schema>,
  name: string,
): unknown {
  const out = series.aggregate(Sequence.every('1h'), { value: name } as never);
  return out.length === 0 ? undefined : out.at(0)?.get('value' as never);
}

// Rolling value at the last event (window spans the whole series → all events).
function rollingAll(series: TimeSeries<typeof schema>, name: string): unknown {
  const out = series.rolling('1h', { value: name } as never);
  return out.length === 0
    ? undefined
    : out.at(out.length - 1)?.get('value' as never);
}

// Feed the incremental factories directly to exercise bucket + rolling state.
function bucketValue(
  name: string,
  values: ReadonlyArray<number | undefined>,
): ColumnValue | undefined {
  const state = bucketStateFor(name);
  for (const v of values) state.add(v);
  return state.snapshot();
}
function rollingValue(
  name: string,
  values: ReadonlyArray<number | undefined>,
): ColumnValue | undefined {
  const state = rollingStateFor(name);
  values.forEach((v, i) => state.add(i, v));
  return state.snapshot();
}

// Finite values are 1, 2, 3; the rest (NaN, +Inf, -Inf, undefined) are skipped.
const MIXED = [1, NaN, 2, Infinity, undefined, 3, -Infinity];
const ALL_NON_FINITE = [NaN, Infinity, -Infinity];

describe('reducer non-finite policy — values', () => {
  const cases: Array<{
    name: string;
    mixed: number | undefined;
    close?: boolean;
    allNonFinite: number | undefined;
  }> = [
    { name: 'sum', mixed: 6, allNonFinite: 0 },
    { name: 'count', mixed: 3, allNonFinite: 0 },
    { name: 'avg', mixed: 2, allNonFinite: undefined },
    { name: 'min', mixed: 1, allNonFinite: undefined },
    { name: 'max', mixed: 3, allNonFinite: undefined },
    { name: 'median', mixed: 2, allNonFinite: undefined },
    { name: 'p95', mixed: 2.9, close: true, allNonFinite: undefined },
    {
      name: 'stdev',
      mixed: Math.sqrt(2 / 3),
      close: true,
      allNonFinite: undefined,
    },
  ];

  for (const c of cases) {
    it(`${c.name}: all paths skip non-finite and agree (mixed)`, () => {
      const series = makeSeries(MIXED);
      const fromReduce = series.reduce('value', c.name); // reduceColumn (packed)
      const fromAggregate = aggregateAll(series, c.name); // reduceColumn fast path
      const fromRolling = rollingAll(series, c.name); // rollingState
      const fromBucket = bucketValue(c.name, MIXED); // bucketState
      const fromRollingState = rollingValue(c.name, MIXED); // rollingState (unit)

      if (c.close) {
        expect(fromReduce as number).toBeCloseTo(c.mixed as number, 10);
        expect(fromAggregate as number).toBeCloseTo(c.mixed as number, 10);
        expect(fromRolling as number).toBeCloseTo(c.mixed as number, 10);
        expect(fromBucket as number).toBeCloseTo(c.mixed as number, 10);
        expect(fromRollingState as number).toBeCloseTo(c.mixed as number, 10);
      } else {
        expect(fromReduce).toBe(c.mixed);
        expect(fromAggregate).toBe(c.mixed);
        expect(fromRolling).toBe(c.mixed);
        expect(fromBucket).toBe(c.mixed);
        expect(fromRollingState).toBe(c.mixed);
      }
    });

    it(`${c.name}: all-non-finite input → ${String(c.allNonFinite)} on every path`, () => {
      const series = makeSeries(ALL_NON_FINITE);
      expect(series.reduce('value', c.name)).toBe(c.allNonFinite);
      expect(aggregateAll(series, c.name)).toBe(c.allNonFinite);
      expect(bucketValue(c.name, ALL_NON_FINITE)).toBe(c.allNonFinite);
      expect(rollingValue(c.name, ALL_NON_FINITE)).toBe(c.allNonFinite);
    });
  }
});

describe('reducer non-finite policy — first/last (row path + boundary scan)', () => {
  it('first skips a non-finite leading cell', () => {
    // values[0] = NaN; first finite/defined is 2.
    const series = makeSeries([NaN, 2, 3]);
    expect(series.reduce('value', 'first')).toBe(2); // row reduce (no reduceColumn)
    expect(aggregateAll(series, 'first')).toBe(2); // aggregate boundary scan
  });

  it('last skips a non-finite trailing cell', () => {
    const series = makeSeries([1, 2, Infinity]);
    expect(series.reduce('value', 'last')).toBe(2);
    expect(aggregateAll(series, 'last')).toBe(2);
  });
});

describe('reducer non-finite policy — finite data is unchanged', () => {
  it('matches the plain result when no non-finite values are present', () => {
    const series = makeSeries([1, 2, 3, 4]);
    expect(series.reduce('value', 'sum')).toBe(10);
    expect(series.reduce('value', 'avg')).toBe(2.5);
    expect(series.reduce('value', 'min')).toBe(1);
    expect(series.reduce('value', 'max')).toBe(4);
    expect(series.reduce('value', 'count')).toBe(4);
    expect(aggregateAll(series, 'sum')).toBe(10);
    expect(rollingAll(series, 'sum')).toBe(10);
  });
});

// A computed writer can no longer pack a non-finite cell: a non-finite
// number in a number column means missing ([PND-NANREP]). `cumulative` with
// a custom fold injecting `Infinity` stores that row as **missing**, so the
// column is `allFinite` (fast path) and the reducers see a gap. The answers
// are the same ones the policy gave when the cell was a skipped `Infinity`.
describe('reducer non-finite policy — a computed non-finite result is stored as missing', () => {
  // Fold yields [10, Infinity, 30] (the first value is used as-is; the fold
  // injects Infinity only at value 20). Finite cells are 10 and 30.
  const injectInf = (_acc: number, v: number): number =>
    v === 20 ? Infinity : v;

  function cumulativeWithInfinity(): TimeSeries<typeof schema> {
    return makeSeries([10, 20, 30]).cumulative({
      value: injectInf,
    }) as unknown as TimeSeries<typeof schema>;
  }

  // The reference: the same post-fold values through `fromEvents`, which
  // also stores the `Infinity` as missing.
  const reference = [10, Infinity, 30];

  const cases: Array<{ name: string; expected: number | undefined }> = [
    { name: 'sum', expected: 40 },
    { name: 'count', expected: 2 },
    { name: 'avg', expected: 20 },
    { name: 'min', expected: 10 },
    { name: 'max', expected: 30 },
    { name: 'median', expected: 20 },
  ];

  for (const c of cases) {
    it(`${c.name}: computed non-finite result is a gap (matches fromEvents)`, () => {
      const computed = cumulativeWithInfinity();
      // The computed column's reduce must equal the documented policy value...
      expect(computed.reduce('value', c.name)).toBe(c.expected);
      // ...and the `fromEvents` equivalent carrying the same cells.
      expect(makeSeries(reference).reduce('value', c.name)).toBe(c.expected);
      // The columnar aggregate fast path (also `reduceColumn`) agrees too.
      expect(aggregateAll(computed, c.name)).toBe(c.expected);
    });
  }

  it('the injected Infinity is stored as missing; the column is allFinite', () => {
    const computed = cumulativeWithInfinity();
    const col = computed.column('value') as Float64Column;
    expect(computed.at(1)?.get('value' as never)).toBeUndefined();
    expect(col.allFinite).toBe(true);
    // count + nullCount === length: the gap is counted once, as missing.
    expect(col.count()).toBe(2);
    expect(col.nullCount()).toBe(1);
  });
});

// Exercises the `allFinite: true` FAST reduceColumn loop directly and pins it
// against the guarded loop. Row-API intake → `allFinite: true` (the guard is
// skipped); `fromEvents` → builder → `allFinite: false` (guarded). On finite
// data the two loops must agree exactly. The broad suite covers the fast path
// implicitly; this is the explicit drift-defense between the two variants.
describe('reducer non-finite policy — allFinite fast path == guarded path', () => {
  const finite = [5, 1, 9, 3];
  const fastPath = new TimeSeries({
    name: 's',
    schema,
    rows: finite.map((v, i) => [i * 1000, v]),
  });
  const guardedPath = makeSeries(finite);

  it('intake column is allFinite (fast); fromEvents column is not (guarded)', () => {
    expect((fastPath.column('value') as Float64Column).allFinite).toBe(true);
    expect((guardedPath.column('value') as Float64Column).allFinite).toBe(
      false,
    );
  });

  for (const name of [
    'sum',
    'count',
    'avg',
    'min',
    'max',
    'median',
    'p95',
    'stdev',
  ]) {
    it(`${name}: fast path === guarded path on finite data`, () => {
      // Same arithmetic, guard merely skipped → bit-identical result.
      expect(fastPath.reduce('value', name)).toBe(
        guardedPath.reduce('value', name),
      );
      expect(aggregateAll(fastPath, name)).toBe(
        aggregateAll(guardedPath, name) as never,
      );
    });
  }

  it('sanity: known values on the fast path', () => {
    expect(fastPath.reduce('value', 'sum')).toBe(18);
    expect(fastPath.reduce('value', 'min')).toBe(1);
    expect(fastPath.reduce('value', 'max')).toBe(9);
    expect(fastPath.reduce('value', 'count')).toBe(4);
  });
});

// The column-API reductions: `min`/`max`/`sum`/`mean`/`stdev`/`median`/
// `percentile` delegate to the (fixed) reducer `reduceColumn`, but `minMax()`
// and `bin('minMax')` inline a fused loop, and chunked `count()` had an O(1)
// shortcut — all three bypassed the policy until this PR. Codex flagged them.
describe('reducer non-finite policy — column-API minMax / bin / chunked count', () => {
  // A column holding a defined Infinity, `allFinite: false`. Only the trusted
  // constructor can build one now ([PND-NANREP]); the guarded loops stay, so
  // keep pinning them. Cells: [10, Infinity, 30].
  function computedCol(): Float64Column {
    return new Float64Column(Float64Array.from([10, Infinity, 30]), 3);
  }

  it('minMax() skips non-finite and agrees with [min(), max()]', () => {
    const col = computedCol();
    expect(col.minMax()).toEqual([10, 30]); // not [10, Infinity]
    expect(col.minMax()).toEqual([col.min(), col.max()]);
  });

  it("bin('minMax') channels agree with bin('min') / bin('max')", () => {
    const col = computedCol(); // 3 cells, 1 bin
    const mm = col.bin(1, 'minMax');
    expect(Array.from(mm.lo)).toEqual(Array.from(col.bin(1, 'min')));
    expect(Array.from(mm.hi)).toEqual(Array.from(col.bin(1, 'max')));
    expect(mm.hi[0]).toBe(30); // Infinity skipped, not the bin max
  });

  it('chunked count() skips non-finite (matches the reducer/materialized count)', () => {
    const numStore = (times: number[], values: Array<number | undefined>) =>
      ColumnarStore.fromTrustedStore(
        [
          { name: 'time', kind: 'time' },
          { name: 'v', kind: 'number' },
        ] as const,
        timeKeyColumnFromArray(times),
        // Trusted constructor: the only way to hold a defined non-finite
        // cell ([PND-NANREP]); `float64ColumnFromArray` would store a gap.
        new Map([
          [
            'v',
            new Float64Column(
              Float64Array.from(values as number[]),
              values.length,
            ),
          ],
        ]),
      );
    const chunked = concatSorted([
      numStore([1000, 2000], [10, Infinity]),
      numStore([3000, 4000], [30, NaN]),
    ]);
    const col = chunked.columns.get('v')!;
    expect(col.storage).toBe('chunked'); // guard
    // Cells [10, Infinity, 30, NaN] → 2 finite defined cells.
    expect((col as unknown as { count(): number }).count()).toBe(2);
  });
});
