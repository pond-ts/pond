import { describe, expect, it } from 'vitest';
import { Event, Sequence, Time, TimeSeries } from '../src/index.js';
import { bucketStateFor, rollingStateFor } from '../src/reducers/index.js';
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

// `fromEvents` is the only entry that lets non-finite reach a numeric column
// — the public constructor's intake rejects it. (Computed writers like
// `cumulative` overflow are the real-world source; this is the test injection.)
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

// `Float64Column.allFinite` lets `reduceColumn` skip the per-element finite
// guard. The flag MUST be DATA-DERIVED — a computed writer that packs a
// non-finite cell must leave it `false`, or the fast path would (wrongly)
// include the non-finite cell and diverge from the documented policy.
//
// `cumulative` with a custom fold is the permissive computed-writer path
// (docs/notes/reducer-nan-policy.md, middle layer): it packs honest non-finite
// via `float64ColumnFromArray`, which derives `allFinite` from the values. A
// fold injecting `Infinity` yields a packed `Float64Column` with a non-finite
// cell whose `allFinite` is `false` → reducers take the guarded path → the
// non-finite is skipped, matching the `fromEvents` equivalent. Were the flag
// wrongly `true`, the fast path would include `Infinity` and these assertions
// would fail (sum / max → Infinity, count → 3).
describe('reducer non-finite policy — allFinite is data-derived on computed columns', () => {
  // Fold yields [10, Infinity, 30] (the first value is used as-is; the fold
  // injects Infinity only at value 20). Finite cells are 10 and 30.
  const injectInf = (_acc: number, v: number): number =>
    v === 20 ? Infinity : v;

  function cumulativeWithInfinity(): TimeSeries<typeof schema> {
    return makeSeries([10, 20, 30]).cumulative({
      value: injectInf,
    }) as unknown as TimeSeries<typeof schema>;
  }

  // The reference: a column carrying the SAME post-fold values via the
  // (builder) intake path — also `allFinite: false`, guarded, policy-correct.
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
    it(`${c.name}: computed non-finite column skips Infinity (matches fromEvents)`, () => {
      const computed = cumulativeWithInfinity();
      // The computed column's reduce must equal the documented policy value...
      expect(computed.reduce('value', c.name)).toBe(c.expected);
      // ...and the `fromEvents` equivalent carrying the same cells.
      expect(makeSeries(reference).reduce('value', c.name)).toBe(c.expected);
      // The columnar aggregate fast path (also `reduceColumn`) agrees too.
      expect(aggregateAll(computed, c.name)).toBe(c.expected);
    });
  }

  it('the injected column genuinely carries a non-finite cell', () => {
    // Guards the test itself: if the fold ever stopped producing Infinity the
    // cases above would still pass vacuously. Confirm the packed value is Inf.
    const computed = cumulativeWithInfinity();
    expect(computed.at(1)?.get('value' as never)).toBe(Infinity);
  });
});
