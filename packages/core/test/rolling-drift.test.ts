import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';
import { rollingStateFor } from '../src/reducers/index.js';
import { exactStdev, exactSum } from './exact-stats.js';

/**
 * [PND-ROLLSTD] — rolling `sum` / `avg` / `stdev` must not drift.
 *
 * A sliding window adds each value as it enters and removes it as it
 * leaves. The old states did that in plain doubles (a running sum; Welford's
 * add / reverse-delete), so every step's rounding error stayed in the
 * accumulator for as long as the window was non-empty. The error is sized
 * by the values that passed *through* the window, so it shows worst when a
 * window drains to a few close values: on the pond-rs R1a bench (1M rows) a
 * two-value window read stdev 0.000442 for a true 0.000354 (25% off), and a
 * one-value window's average was 9.4e-10 off the value itself.
 *
 * Every check here is against an exact `BigInt` oracle, not another
 * floating-point method.
 */

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random walk like the bench's price columns: 100 + Σ N(0, 0.1)-ish. */
function walk(rand: () => number, length: number, start = 100): number[] {
  const out: number[] = [];
  let v = start;
  for (let i = 0; i < length; i += 1) {
    v += (rand() + rand() + rand() - 1.5) * 0.2;
    out.push(v);
  }
  return out;
}

const relErr = (got: number, want: number): number =>
  want === 0 ? Math.abs(got) : Math.abs(got - want) / Math.abs(want);

describe('[PND-ROLLSTD] rolling accumulators do not drift', () => {
  it('stdev: a long-lived window drained to two close values is exact', () => {
    // 200k values through a 300-value FIFO window (never empty), then the
    // two survivors are the bench's worst row. The old Welford delete read
    // them ~25% off here; the exact answer is 0.000355.
    const values = walk(mulberry32(1), 200_000);
    values.push(126.31951, 126.32022);
    const state = rollingStateFor('stdev');
    const W = 300;
    for (let i = 0; i < values.length; i += 1) {
      state.add(i, values[i]!);
      if (i >= W) state.remove(i - W, values[i - W]!);
    }
    // Drain everything but the last two.
    for (let i = values.length - W; i < values.length - 2; i += 1) {
      state.remove(i, values[i]!);
    }
    const want = exactStdev([126.31951, 126.32022]);
    expect(relErr(state.snapshot() as number, want)).toBeLessThan(1e-12);
  });

  it('avg / sum: a long-lived window drained to one value reads that value', () => {
    const values = walk(mulberry32(2), 200_000);
    for (const name of ['avg', 'sum'] as const) {
      const state = rollingStateFor(name);
      const W = 300;
      for (let i = 0; i < values.length; i += 1) {
        state.add(i, values[i]!);
        if (i >= W) state.remove(i - W, values[i - W]!);
      }
      for (let i = values.length - W; i < values.length - 1; i += 1) {
        state.remove(i, values[i]!);
      }
      expect(state.snapshot(), name).toBe(values[values.length - 1]);
    }
  });

  it('time-window rolling on gappy data matches the exact answer on every row', () => {
    // The bench shape at test size: a random walk with ~5% missing cells
    // and an outage longer than the window, so windows drain and refill.
    const rand = mulberry32(3);
    const n = 4_000;
    const vals = walk(rand, n).map((v, i) =>
      (i >= 2_000 && i < 2_400) || rand() < 0.05 ? undefined : v,
    );
    const time = vals.map((_, i) => i * 1000);
    const series = TimeSeries.fromColumns({
      name: 'walk',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number', required: false },
      ] as const,
      columns: { time, v: vals },
    });
    const out = series.rolling('5m', {
      a: { from: 'v', using: 'avg' },
      s: { from: 'v', using: 'sum' },
      sd: { from: 'v', using: 'stdev' },
    });
    let lo = 0;
    for (let i = 0; i < n; i += 1) {
      while (time[lo]! <= time[i]! - 300_000) lo += 1;
      const win: number[] = [];
      for (let j = lo; j <= i; j += 1) {
        if (vals[j] !== undefined) win.push(vals[j]!);
      }
      const row = out.at(i)!;
      if (win.length === 0) {
        expect(row.get('sd'), `row ${i}`).toBeUndefined();
        continue;
      }
      const sum = exactSum(win);
      // One rounding of an exact sum — the sum is correctly rounded.
      expect(row.get('s'), `sum row ${i}`).toBe(sum);
      expect(
        relErr(row.get('a') as number, sum / win.length),
        `avg row ${i}`,
      ).toBeLessThan(1e-15);
      expect(
        Math.abs((row.get('sd') as number) - exactStdev(win)),
        `stdev row ${i}`,
      ).toBeLessThanOrEqual(exactStdev(win) * 1e-14);
    }
  });

  it('stdev: large offsets, trends and outlier eviction stay exact', () => {
    // Cases the old states documented as limits: large magnitudes, a
    // strong trend (the shift has to follow the mean), and evicting a value
    // far outside the remaining spread (subtractive variance cancels): here
    // 1e5 over a spread of ~3e-4, a ratio of ~3e8 — the old state read 0.
    const rand = mulberry32(4);
    const streams: Array<[string, number[]]> = [
      ['offset 1e10', walk(rand, 5_000, 1e10)],
      ['trend', Array.from({ length: 5_000 }, (_, i) => i * 1e3 + rand())],
      [
        'outliers',
        Array.from({ length: 5_000 }, (_, i) =>
          i % 97 === 0 ? 1e5 : 1 + rand() * 1e-3,
        ),
      ],
    ];
    for (const [label, values] of streams) {
      const state = rollingStateFor('stdev');
      const W = 40;
      for (let i = 0; i < values.length; i += 1) {
        state.add(i, values[i]!);
        if (i >= W) state.remove(i - W, values[i - W]!);
        const win = values.slice(Math.max(0, i - W + 1), i + 1);
        const want = exactStdev(win);
        expect(
          relErr(state.snapshot() as number, want),
          `${label} step ${i}`,
        ).toBeLessThan(1e-13);
      }
    }
  });

  it('stdev: removal by value, in any order, is exact (live reorder eviction)', () => {
    const rand = mulberry32(5);
    const values = walk(rand, 2_000, 1e6);
    const state = rollingStateFor('stdev');
    values.forEach((v, i) => state.add(i, v));
    const remaining = [...values];
    while (remaining.length > 1) {
      // Remove a random survivor, not the oldest.
      const k = Math.floor(rand() * remaining.length);
      const [v] = remaining.splice(k, 1);
      state.remove(0, v!);
      if (remaining.length >= 2 && remaining.length % 50 === 0) {
        expect(
          relErr(state.snapshot() as number, exactStdev(remaining)),
          `${remaining.length} left`,
        ).toBeLessThan(1e-13);
      }
    }
    expect(state.snapshot()).toBe(0);
  });

  it('stdev: a constant window reads exactly 0 even after the mean moved', () => {
    const state = rollingStateFor('stdev');
    const values = [...walk(mulberry32(6), 1_000), 42.5, 42.5, 42.5];
    values.forEach((v, i) => state.add(i, v));
    for (let i = 0; i < values.length - 3; i += 1) state.remove(i, values[i]!);
    expect(state.snapshot()).toBe(0);
  });
});
