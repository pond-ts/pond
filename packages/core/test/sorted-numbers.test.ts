/**
 * `sortedNumbers` (median / percentile) must order exactly like
 * `slice().sort((a, b) => a - b)` — including which of `-0` / `0` comes
 * first, since a stable sort keeps their input order and a percentile can
 * land on either.
 */
import { describe, expect, it } from 'vitest';
import { sortedNumbers } from '../src/reducers/percentile.js';

describe('sortedNumbers', () => {
  it('matches a stable comparator sort, signed zeros included', () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let trial = 0; trial < 2000; trial += 1) {
      const n = Math.floor(rand() * 40);
      const xs = Array.from({ length: n }, () => {
        const r = rand();
        return r < 0.15 ? -0 : r < 0.3 ? 0 : Math.floor(rand() * 9) - 4;
      });
      const want = xs.slice().sort((a, b) => a - b);
      const got = sortedNumbers(xs);
      expect(got.length).toBe(want.length);
      for (let i = 0; i < n; i += 1) {
        expect(Object.is(got[i], want[i]), `trial ${trial} at ${i}`).toBe(true);
      }
    }
  });
});
