/**
 * Direct unit tests for the `stdev` reducer's incremental `bucketState`
 * (audit v2 §1.1). `bucketState` is shared by the batch `aggregate()` row
 * path AND the live layer (`LiveAggregation`, the partitioned variants), so
 * pinning it here covers both drivers at once.
 *
 * It was a one-pass `sq/n − mean²` accumulator, which cancels catastrophically
 * on near-equal large-magnitude values (returning 0, or a negative variance →
 * `sqrt` → NaN that the validating constructor then rejected). It is now
 * Welford's online variance: O(1) per add, no buffer, `m2 ≥ 0` by
 * construction. `reduce` and `reduceColumn` now share the same recurrence, so
 * all three batch paths agree (bit-for-bit on same-ordered input).
 */
import { describe, expect, it } from 'vitest';
import { stdev } from '../src/reducers/stdev.js';

// Drive the incremental contract: add each value, then read the snapshot.
function bucket(values: number[]): number | undefined {
  const state = stdev.bucketState();
  for (const v of values) state.add(v);
  return state.snapshot() as number | undefined;
}

// The `reduce` path (now the same Welford recurrence) — bucketState must match
// it on the same input.
function viaReduce(values: number[]): number | undefined {
  return stdev.reduce(values, values) as number | undefined;
}

describe('stdev.bucketState — Welford online variance (audit §1.1)', () => {
  it('matches the reduce path on ordinary data', () => {
    const xs = [2, 4, 4, 4, 5, 5, 7, 9]; // textbook population stdev = 2
    expect(bucket(xs)).toBeCloseTo(2, 12);
    expect(bucket(xs)).toBe(viaReduce(xs)); // same recurrence → bit-identical
  });

  it('does not cancel on near-equal large-magnitude values (was 0)', () => {
    const xs = [1e10, 1e10 + 1, 1e10 + 2, 1e10 + 3]; // pop stdev = sqrt(5/4)
    expect(bucket(xs)).toBeCloseTo(Math.sqrt(5 / 4), 9);
    expect(bucket(xs)).toBe(viaReduce(xs));
  });

  it('matches the reduce path at the 2^52 precision boundary (was a cross-path split)', () => {
    const base = 2 ** 52;
    const xs = [base, base + 1, base + 2, base + 3]; // pop stdev = sqrt(5/4)
    expect(bucket(xs)).toBeCloseTo(Math.sqrt(5 / 4), 9);
    expect(bucket(xs)).toBe(viaReduce(xs));
  });

  it('stays finite where the one-pass formula went negative → NaN', () => {
    const xs = [5e7 + 0.1, 5e7 + 0.2, 5e7 + 0.3]; // pop stdev = sqrt(0.02/3)
    const v = bucket(xs)!;
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeCloseTo(Math.sqrt(0.02 / 3), 6);
  });

  it('returns undefined for an empty bucket', () => {
    expect(bucket([])).toBeUndefined();
  });

  it('returns 0 for a single value and for all-equal values', () => {
    expect(bucket([42])).toBe(0);
    expect(bucket([7, 7, 7, 7])).toBe(0);
  });

  it('ignores non-numeric adds (the typeof guard)', () => {
    const state = stdev.bucketState();
    state.add(2);
    state.add('x' as unknown as number); // skipped
    state.add(4);
    state.add(undefined as unknown as number); // skipped
    expect(state.snapshot()).toBeCloseTo(1, 12); // pop stdev of [2, 4] = 1
  });
});
