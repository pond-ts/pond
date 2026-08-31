import { describe, expect, it } from 'vitest';
import { wilderValues } from '../src/kernels/wilder.js';

/*
 * `wilderValues` is tested directly, not only through `rsi`, because it is a
 * SHARED kernel: ATR and ADX are slated to build on the same smoother, and a
 * regression in its seed or its gap handling would surface in those as a
 * wrong indicator rather than as an obviously broken one. RSI's oracle pins
 * the composition; this pins the piece.
 */

const arr = (...xs: number[]) => Float64Array.from(xs);
/** Read back with NaN as `undefined`, which is how a study sees it. */
const read = (x: Float64Array) =>
  Array.from(x, (v) => (Number.isNaN(v) ? undefined : v));

describe('wilderValues', () => {
  it('seeds on the arithmetic mean of the first `period` samples', () => {
    // The seed IS the definition — a first-sample seed is a different
    // indicator (7+ RSI points, per the study docs), so pin the value.
    const out = read(wilderValues(arr(1, 2, 3, 4, 5), 3));
    expect(out[0]).toBeUndefined();
    expect(out[1]).toBeUndefined();
    expect(out[2]).toBe(2); // mean(1,2,3)
    expect(out[3]).toBeCloseTo((2 * 2 + 4) / 3, 12);
  });

  it('carries (prev·(n−1) + x)/n after the seed', () => {
    const out = read(wilderValues(arr(10, 10, 10, 40), 3));
    expect(out[2]).toBe(10);
    expect(out[3]).toBeCloseTo((10 * 2 + 40) / 3, 12);
  });

  it('honours `start`, so a diff-derived array seeds from index 1', () => {
    // Index 0 of a difference array has no predecessor. `start` lets the
    // caller say so without shifting its arrays.
    const out = read(wilderValues(arr(999, 1, 2, 3, 4), 3, 1));
    expect(out[2]).toBeUndefined(); // still warming: seed needs 1..3
    expect(out[3]).toBe(2); // mean(1,2,3) — the 999 at index 0 is ignored
  });

  it('steps over a LEADING gap instead of being poisoned by it', () => {
    // The chaining case: a source study's own warm-up. A recursion carries
    // state forever, so a NaN in the seed window would empty the entire
    // output rather than delaying it.
    const out = read(wilderValues(arr(NaN, NaN, 3, 3, 3, 30), 3));
    expect(out[3]).toBeUndefined(); // seed window is 2..4
    expect(out[4]).toBe(3);
    expect(out[5]).toBeCloseTo((3 * 2 + 30) / 3, 12);
  });

  it('propagates an INTERIOR gap to the end', () => {
    // Inherent: there is no state to carry across a hole. Documented as such
    // rather than silently filled.
    const out = read(wilderValues(arr(1, 1, 1, NaN, 1, 1), 3));
    expect(out[2]).toBe(1);
    expect(out[3]).toBeUndefined();
    expect(out[5]).toBeUndefined();
  });

  it('is all-missing when the period exceeds the samples available', () => {
    expect(read(wilderValues(arr(1, 2, 3), 5))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    // …including when `start` is what pushes the seed off the end.
    expect(read(wilderValues(arr(1, 2, 3), 3, 1))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('handles an all-gap input, an empty input, and an out-of-range start', () => {
    expect(read(wilderValues(arr(NaN, NaN, NaN), 2))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(wilderValues(new Float64Array(0), 3)).toHaveLength(0);
    expect(read(wilderValues(arr(1, 2, 3), 2, 99))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('degenerates to the identity at period 1', () => {
    // α = 1/1: the recursion keeps no history, so each value is its own
    // average. Worth pinning — it is the boundary the study's `assertPeriod`
    // allows through.
    expect(read(wilderValues(arr(5, 9, 2), 1))).toEqual([5, 9, 2]);
  });

  it('preserves length and allocates one output', () => {
    const input = arr(1, 2, 3, 4, 5, 6, 7);
    const out = wilderValues(input, 3);
    expect(out).toHaveLength(input.length);
    expect(out).not.toBe(input);
    expect(Array.from(input)).toEqual([1, 2, 3, 4, 5, 6, 7]); // input untouched
  });
});
