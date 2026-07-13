/**
 * Tests for the **count-based** (`{ count: N }`) window on `TimeSeries.rolling`
 * — the N-bar window keyed on row position, not a time span (G1). The headline
 * guarantee: it reduces exactly `N` rows regardless of the time between them, so
 * an N-bar study stays correct across session gaps where a duration window spans
 * the wrong number of rows.
 */
import { describe, expect, it } from 'vitest';
import { Sequence, TimeSeries } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
] as const;

/** `n` rows at 1ms spacing, value = row index. */
function evenSeries(n = 6) {
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < n; i += 1) rows.push([i, i]);
  return new TimeSeries({ name: 'v', schema, rows });
}

/** 5 rows with a large time gap between rows 2 and 3 (a "session gap"): a
 *  duration window straddling the gap sees a different row count than a count
 *  window, which is the whole point. */
function gappedSeries() {
  return new TimeSeries({
    name: 'v',
    schema,
    rows: [
      [0, 10],
      [1, 20],
      [2, 30],
      [1_000_000, 40],
      [1_000_001, 50],
    ] as Array<[number, number]>,
  });
}

describe('TimeSeries.rolling { count } — trailing', () => {
  it('reduces the last N rows, with a partial window during warmup', () => {
    const r = evenSeries(6).rolling({ count: 3 }, { v: 'avg' });
    expect(r.length).toBe(6);
    // partial windows at the start (fewer than N rows), then the full 3-row avg.
    expect(r.at(0)!.get('v')).toBe(0); // [0]
    expect(r.at(1)!.get('v')).toBe(0.5); // [0,1]
    expect(r.at(2)!.get('v')).toBe(1); // [0,1,2]
    expect(r.at(3)!.get('v')).toBe(2); // [1,2,3]
    expect(r.at(4)!.get('v')).toBe(3); // [2,3,4]
    expect(r.at(5)!.get('v')).toBe(4); // [3,4,5]
  });

  it('counts N ROWS across a time gap — a duration window does not', () => {
    const s = gappedSeries();
    // Count window: the row after the gap still averages 2 rows (30, 40).
    const byCount = s.rolling({ count: 2 }, { v: 'avg' });
    expect(byCount.at(3)!.get('v')).toBe(35); // (30 + 40) / 2 — two bars
    // Duration window of ~2ms: the same row sees only itself (prev is 10^6 ms
    // away), so it averages 40. This divergence is exactly why count exists.
    const byDuration = s.rolling(2, { v: 'avg' });
    expect(byDuration.at(3)!.get('v')).toBe(40);
  });

  it('minSamples: N suppresses the warmup rows (the conventional N-bar warmup)', () => {
    const r = evenSeries(6).rolling(
      { count: 3 },
      { v: 'avg' },
      { minSamples: 3 },
    );
    expect(r.at(0)!.get('v')).toBeUndefined();
    expect(r.at(1)!.get('v')).toBeUndefined();
    expect(r.at(2)!.get('v')).toBe(1); // first full 3-row window
    expect(r.at(5)!.get('v')).toBe(4);
  });

  it('carries multiple reducers off one window (the Bollinger shape)', () => {
    const r = evenSeries(6).rolling(
      { count: 3 },
      { mid: { from: 'v', using: 'avg' }, sd: { from: 'v', using: 'stdev' } },
      { minSamples: 3 },
    );
    // window [2,3,4] → mean 3; population stdev of {2,3,4} = sqrt(2/3).
    expect(r.at(4)!.get('mid')).toBeCloseTo(3, 10);
    expect(r.at(4)!.get('sd')).toBeCloseTo(Math.sqrt(2 / 3), 10);
  });

  it('works with a custom reducer over the row window', () => {
    const r = evenSeries(5).rolling(
      { count: 2 },
      {
        v: {
          from: 'v',
          using: (vals: ReadonlyArray<number | undefined>) => vals.length,
        },
      },
    );
    expect(r.at(0)!.get('v')).toBe(1); // partial: 1 row
    expect(r.at(4)!.get('v')).toBe(2); // full: 2 rows
  });
});

describe('TimeSeries.rolling { count } — leading & centered', () => {
  it('leading takes the current row plus the next N-1', () => {
    const r = evenSeries(6).rolling(
      { count: 3 },
      { v: 'avg' },
      { alignment: 'leading' },
    );
    expect(r.at(0)!.get('v')).toBe(1); // [0,1,2]
    expect(r.at(3)!.get('v')).toBe(4); // [3,4,5]
    expect(r.at(4)!.get('v')).toBe(4.5); // [4,5] clamped
    expect(r.at(5)!.get('v')).toBe(5); // [5] clamped
  });

  it('centered spans N rows around each, biased leading on even N', () => {
    const odd = evenSeries(6).rolling(
      { count: 3 },
      { v: 'avg' },
      { alignment: 'centered' },
    );
    expect(odd.at(2)!.get('v')).toBe(2); // [1,2,3]
    // even N=4 → leftSpan 1, rightSpan 2: row 2 spans [1,2,3,4].
    const even = evenSeries(6).rolling(
      { count: 4 },
      { v: 'avg' },
      { alignment: 'centered' },
    );
    expect(even.at(2)!.get('v')).toBe(2.5); // (1+2+3+4)/4
  });
});

describe('TimeSeries.rolling { count } — validation & shape', () => {
  it('preserves schema and length like a duration window', () => {
    const base = evenSeries(6).rolling(3, { v: 'avg' });
    const counted = evenSeries(6).rolling({ count: 3 }, { v: 'avg' });
    expect(counted.schema).toEqual(base.schema);
    expect(counted.length).toBe(base.length);
  });

  it('throws on a non-integer or non-positive count', () => {
    expect(() => evenSeries().rolling({ count: 0 }, { v: 'avg' })).toThrow(
      /positive integer/,
    );
    expect(() => evenSeries().rolling({ count: 2.5 }, { v: 'avg' })).toThrow(
      /positive integer/,
    );
    expect(() => evenSeries().rolling({ count: -3 }, { v: 'avg' })).toThrow(
      /positive integer/,
    );
  });

  it('throws when combined with a sequence (per-row only)', () => {
    expect(() =>
      // @ts-expect-error — count is not a valid sequence-form window
      evenSeries().rolling(Sequence.every('1ms'), { count: 3 }, { v: 'avg' }),
    ).toThrow(/not supported with a sequence/);
  });

  it('count: 1 reduces each row on its own (window is just that row)', () => {
    const r = evenSeries(4).rolling({ count: 1 }, { v: 'avg' });
    expect([0, 1, 2, 3].map((i) => r.at(i)!.get('v'))).toEqual([0, 1, 2, 3]);
  });

  it('count larger than the series clamps to the rows present', () => {
    // count 10 over 4 rows, trailing → every window is [0, i]; no row ever
    // reaches 10 samples, so with the default gate each still emits.
    const r = evenSeries(4).rolling({ count: 10 }, { v: 'avg' });
    expect(r.at(0)!.get('v')).toBe(0); // [0]
    expect(r.at(3)!.get('v')).toBe(1.5); // [0,1,2,3]
    // minSamples: 10 then suppresses every row (never that many present).
    const gated = evenSeries(4).rolling(
      { count: 10 },
      { v: 'avg' },
      { minSamples: 10 },
    );
    expect([0, 1, 2, 3].every((i) => gated.at(i)!.get('v') === undefined)).toBe(
      true,
    );
  });

  it('an empty series yields an empty result (no throw)', () => {
    const empty = new TimeSeries({ name: 'v', schema, rows: [] });
    const r = empty.rolling({ count: 3 }, { v: 'avg' });
    expect(r.length).toBe(0);
  });
});
