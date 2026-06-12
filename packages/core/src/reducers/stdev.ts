import type { ReducerDef } from './types.js';

/**
 * Population standard deviation, computed by **Welford's online variance** in
 * every batch path so the result is independent of which path runs.
 *
 * `aggregate('stdev')` takes the columnar fast path (`reduceColumn`) or falls
 * back to the row path (`bucketState`) depending on whether *every* mapped
 * column qualifies — an all-or-nothing decision. If those paths used different
 * formulas they would disagree on the same data:
 * - the original `bucketState` one-pass `sq/n − mean²` cancels catastrophically
 *   on near-equal large values (`[1e10, 1e10+1, 1e10+2, 1e10+3]` → 0 instead of
 *   ≈1.118, or a negative variance → `sqrt` → NaN the constructor then threw on);
 * - even the textbook two-pass `Σv/n`-then-deviations disagrees with Welford
 *   once `Σv` loses precision — at `2^52` the summed mean rounds and the two-pass
 *   stdev drifts ~8.7% from the true value.
 *
 * Welford's running mean avoids both, is O(1) per element with no buffer (so the
 * live layer that shares `bucketState` stays O(1)), and `m2 ≥ 0` by construction
 * (the `Math.max(0, …)` only absorbs FP round-off, never a gross negative). Using
 * the one recurrence in `reduce`, `reduceColumn`, and `bucketState` makes them
 * agree to floating-point noise — bit-for-bit when they see the values in the
 * same order, which the bucketed paths do.
 *
 * `rollingState` is the exception: its sliding window needs `remove`, which
 * Welford can't do stably (windowed removal drifts), so it keeps the one-pass
 * `sq/n − mean²` (with its clamp). A stable rolling stdev is a deferred item.
 */

// Welford accumulator: `add` each value, then read `result()` for the
// population stdev (`undefined` if nothing was added). Shared by `reduce` and
// `bucketState`; `reduceColumn` inlines the same recurrence over its typed
// array (a hot fast path) — the cross-path tests guard the two against drift.
function welfordStdev() {
  let n = 0;
  let mean = 0;
  let m2 = 0;
  return {
    add(v: number): void {
      n += 1;
      const delta = v - mean;
      mean += delta / n;
      m2 += delta * (v - mean);
    },
    result(): number | undefined {
      return n === 0 ? undefined : Math.sqrt(Math.max(0, m2 / n));
    },
  };
}

export const stdev: ReducerDef = {
  outputKind: 'number',
  reduce(_d, numeric) {
    const w = welfordStdev();
    for (let i = 0; i < numeric.length; i += 1) w.add(numeric[i]!);
    return w.result();
  },
  reduceColumn(col) {
    // Inlined Welford (mirrors `welfordStdev`) over the packed array — a single
    // pass, skipping gaps via the validity bitmask. One division per element vs
    // the old two-pass's two divisionless scans, but identical to the other
    // paths' recurrence so the fast path and row path cannot diverge.
    const values = col._values;
    const validity = col.validity;
    let n = 0;
    let mean = 0;
    let m2 = 0;
    if (validity === undefined) {
      const len = col.length;
      if (len === 0) return undefined;
      for (let i = 0; i < len; i += 1) {
        const v = values[i]!;
        n += 1;
        const delta = v - mean;
        mean += delta / n;
        m2 += delta * (v - mean);
      }
    } else {
      if (validity.definedCount === 0) return undefined;
      const bits = validity.bits;
      const len = col.length;
      for (let i = 0; i < len; i += 1) {
        if ((bits[i >> 3]! & (1 << (i & 7))) === 0) continue;
        const v = values[i]!;
        n += 1;
        const delta = v - mean;
        mean += delta / n;
        m2 += delta * (v - mean);
      }
    }
    return Math.sqrt(Math.max(0, m2 / n));
  },
  bucketState() {
    const w = welfordStdev();
    return {
      add(v) {
        if (typeof v === 'number') w.add(v);
      },
      snapshot() {
        return w.result();
      },
    };
  },
  rollingState() {
    // One-pass `sq/n − mean²` with the `Math.max(0, …)` clamp. Unlike the other
    // paths this has a `remove` for the sliding window, which Welford can't do
    // stably — a stable rolling stdev is deferred (see the module note above).
    let s = 0;
    let sq = 0;
    let n = 0;
    return {
      add(_i, v) {
        if (typeof v === 'number') {
          s += v;
          sq += v * v;
          n++;
        }
      },
      remove(_i, v) {
        if (typeof v === 'number') {
          s -= v;
          sq -= v * v;
          n--;
        }
      },
      snapshot() {
        if (n === 0) return undefined;
        const mean = s / n;
        return Math.sqrt(Math.max(0, sq / n - mean * mean));
      },
    };
  },
};
