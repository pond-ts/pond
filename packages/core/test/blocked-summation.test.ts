/**
 * Blocked (reassociated) summation — `src/reducers/blocked.ts`.
 *
 * Three things need pinning, and only one of them is "is the number
 * right":
 *
 * 1. **The gap-skipping path is correct.** `blockedSumFinite` sums a
 *    range in eight lanes, skipping missing cells (stored as NaN, or any
 *    non-finite value — [PND-NANREP]), with a scalar tail for the last
 *    `< 8` cells. Every off-by-one in that split is a silently wrong
 *    sum, so the bulk of this file is a randomized differential test
 *    against a dead-simple scalar reference over every alignment of
 *    start, end, and gap pattern.
 * 2. **The threshold holds.** Runs below `BLOCKED_MIN` must stay
 *    bit-identical to what pond-ts returned before blocking existed —
 *    that is what keeps the exact-equality row-path parity tests
 *    meaningful rather than merely passing.
 * 3. **The accuracy claim is real.** `blocked.ts` asserts the blocked
 *    result is *generally more accurate* than the sequential one, not
 *    merely faster. That is a checkable claim, so it is checked.
 */

import { describe, expect, it } from 'vitest';
import {
  BLOCKED_MIN,
  blockedSum,
  blockedSumFinite,
} from '../src/reducers/blocked.js';
import { Float64Column } from '../src/columnar/index.js';
import '../src/column.js';

/** Deliberately naive reference — the thing the kernel must agree with. */
function scalarSum(values: Float64Array, start: number, end: number): number {
  let s = 0;
  for (let i = start; i < end; i += 1) s += values[i]!;
  return s;
}

function scalarSumFinite(
  values: Float64Array,
  start: number,
  end: number,
): number {
  let s = 0;
  for (let i = start; i < end; i += 1) {
    if (Number.isFinite(values[i]!)) s += values[i]!;
  }
  return s;
}

/** Deterministic PRNG so a failure reproduces. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('blockedSum — dense', () => {
  it('agrees with the scalar reference on exactly-representable values', () => {
    // Small integers sum exactly in f64, so grouping cannot matter and
    // the two must agree to the bit at every length.
    const n = 1000;
    const values = new Float64Array(n);
    for (let i = 0; i < n; i += 1) values[i] = (i % 97) - 48;
    for (const end of [0, 1, 7, 8, 9, 15, 16, 31, 32, 33, 63, 64, 999, 1000]) {
      expect(blockedSum(values, 0, end)).toBe(scalarSum(values, 0, end));
    }
  });

  it('agrees at every start offset (no dependence on alignment)', () => {
    const n = 512;
    const values = new Float64Array(n);
    for (let i = 0; i < n; i += 1) values[i] = (i % 13) - 6;
    for (let start = 0; start < 40; start += 1) {
      expect(blockedSum(values, start, n)).toBe(scalarSum(values, start, n));
    }
  });

  it('an empty range sums to zero', () => {
    const values = new Float64Array([1, 2, 3]);
    expect(blockedSum(values, 0, 0)).toBe(0);
    expect(blockedSum(values, 2, 2)).toBe(0);
  });
});

describe('blockedSumFinite — alignment', () => {
  it('agrees with the scalar reference across random ranges and gaps', () => {
    // The real test. Randomized over start alignment, end alignment,
    // range length, and gap density — including no gaps and all gaps.
    // Gaps are a mix of NaN and ±Infinity: all three read as missing.
    const n = 4096;
    const next = rng(0xc0ffee);
    const GAPS = [NaN, Infinity, -Infinity];

    for (const density of [0, 0.02, 0.25, 0.5, 0.95, 1]) {
      const values = new Float64Array(n);
      for (let i = 0; i < n; i += 1) {
        values[i] = next() < density ? GAPS[i % 3]! : (i % 211) - 105;
      }
      for (let trial = 0; trial < 400; trial += 1) {
        const start = Math.floor(next() * n);
        const end = start + Math.floor(next() * (n - start));
        expect(blockedSumFinite(values, start, end)).toBe(
          scalarSumFinite(values, start, end),
        );
      }
    }
  });

  it('agrees on every (start, end) pair in a small window', () => {
    // Exhaustive rather than random over a window wide enough to cover
    // head-only, head+tail-no-body, and head+body+tail splits.
    const n = 40;
    // A deliberately awkward pattern: full runs, empty runs, ragged.
    const pattern = [
      0b11111111, 0b00000000, 0b10110101, 0b11111111, 0b00001111,
    ];
    const values = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      values[i] = (pattern[i >> 3]! & (1 << (i & 7))) !== 0 ? i + 1 : NaN;
    }
    for (let start = 0; start <= n; start += 1) {
      for (let end = start; end <= n; end += 1) {
        expect(blockedSumFinite(values, start, end)).toBe(
          scalarSumFinite(values, start, end),
        );
      }
    }
  });
});

describe('the BLOCKED_MIN threshold', () => {
  it('leaves sub-threshold runs bit-identical to sequential', () => {
    // Values chosen so grouping *does* change the answer — a large
    // value that swamps the small ones unless they are summed apart.
    // Below the threshold the reducer must still take the scalar path,
    // so its answer must equal the naive one to the bit.
    const n = BLOCKED_MIN - 1;
    const values = new Float64Array(n);
    values[0] = 1e16;
    for (let i = 1; i < n; i += 1) values[i] = 1;
    const col = new Float64Column(values, n, true);
    expect(col.sum()).toBe(scalarSum(values, 0, n));
  });

  it('sums at and above the threshold via the blocked kernel', () => {
    const n = BLOCKED_MIN;
    const values = new Float64Array(n);
    for (let i = 0; i < n; i += 1) values[i] = i + 1;
    const col = new Float64Column(values, n, true);
    // Exact for these magnitudes either way; this pins the wiring, not
    // the rounding.
    expect(col.sum()).toBe((n * (n + 1)) / 2);
  });

  it('keeps small-bucket aggregate answers exact', () => {
    // The property the row-path parity tests depend on: buckets small
    // enough to check by hand are still summed in order.
    const values = new Float64Array([1e16, 1, 1, 1, -1e16]);
    const col = new Float64Column(values, 5, true);
    expect(col.sum()).toBe(scalarSum(values, 0, 5));
  });
});

describe('accuracy — blocking is tighter, not looser', () => {
  it('is closer to the true sum than sequential on a long run', () => {
    // 1e6 copies of 0.1. The exact answer is 100000. Sequential
    // accumulation drifts because the running total grows until adding
    // 0.1 loses low bits; eight shorter chains each drift less.
    const n = 1_000_000;
    const values = new Float64Array(n).fill(0.1);
    const exact = 100_000;
    const sequential = Math.abs(scalarSum(values, 0, n) - exact);
    const blocked = Math.abs(blockedSum(values, 0, n) - exact);
    expect(blocked).toBeLessThan(sequential);
  });

  it('handles a run where sequential loses a value entirely', () => {
    // 1e16 first, then 1s. In sequential order every 1 is absorbed
    // (1e16 + 1 === 1e16 at f64 spacing 2). Blocked keeps seven of the
    // eight chains small, so their contribution survives.
    const n = 8192;
    const values = new Float64Array(n).fill(1);
    values[0] = 1e16;
    expect(scalarSum(values, 0, n)).toBe(1e16);
    expect(blockedSum(values, 0, n)).toBeGreaterThan(1e16);
  });
});

describe('reducer wiring', () => {
  it('sum and mean agree with the scalar reference on a gapped column', () => {
    const n = 1000;
    const values = new Float64Array(n);
    // Every 13th cell missing — gaps that do not land on lane edges.
    let defined = 0;
    for (let i = 0; i < n; i += 1) {
      values[i] = i % 13 === 0 ? NaN : (i % 71) - 35;
      if (i % 13 !== 0) defined += 1;
    }
    const col = new Float64Column(values, n);
    const expected = scalarSumFinite(values, 0, n);
    expect(col.sum()).toBe(expected);
    expect(col.mean()).toBe(expected / defined);
  });

  it('an all-missing column still means undefined', () => {
    const n = 100;
    const values = new Float64Array(n).fill(NaN);
    const col = new Float64Column(values, n);
    expect(col.sum()).toBe(0);
    expect(col.mean()).toBeUndefined();
  });
});
