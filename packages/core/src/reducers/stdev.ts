import type { Float64Column } from '../columnar/index.js';
import {
  STDEV_SPLIT,
  stdevBigLane,
  stdevBigLaneAdd,
  stdevBigLaneRemove,
  stdevWithBigLane,
} from './overflow-lanes.js';
import type { ReducerDef } from './types.js';
import { WindowStdev } from './window-accumulators.js';

/**
 * Population standard deviation, computed by **Welford's online variance** in
 * every add-only path (`reduce`, `reduceColumn`, `bucketState`) so the result is
 * independent of which path runs.
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
 * `rollingState` (the sliding window, which must also *remove* values) does
 * not use Welford: Welford's reverse step rounds on every remove and the
 * error piles up for as long as the window stays non-empty ([PND-ROLLSTD]).
 * It keeps double-double sums of shifted values instead (`WindowStdev`,
 * `./window-accumulators.ts`), which agree with the add-only Welford paths to
 * floating-point noise, and removes *by value*, so it stays correct under the
 * live layer's reorder-mode eviction (which removes the sorted-prefix, not the
 * oldest-arrived event).
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

/**
 * Population standard deviation of the defined (and, on the guarded
 * path, finite) cells of `col[start, end)`, via Welford's recurrence —
 * the same recurrence `reduce` / `bucketState` use, which is what keeps
 * the columnar, row and live paths from drifting (see the module note).
 *
 * The single column kernel: `reduceColumn` is this at `(0, length)`. See
 * the note on `sumRange` for why it is a standalone function rather than
 * a method delegating through `this`.
 *
 * `n` counts only finite contributors, so `n === 0` (no finite cells in
 * the range) → `undefined`.
 */
function stdevRange(
  col: Float64Column,
  start: number,
  end: number,
): number | undefined {
  const values = col._values;
  let n = 0;
  let mean = 0;
  let m2 = 0;
  // Fast path: every cell is finite (`Float64Column.allFinite`), so the
  // Welford recurrence runs over every cell with no per-element finite
  // test. Same recurrence as the guarded path → identical result.
  if (col.allFinite) {
    for (let i = start; i < end; i += 1) {
      const v = values[i]!;
      n += 1;
      const delta = v - mean;
      mean += delta / n;
      m2 += delta * (v - mean);
    }
    return n === 0 ? undefined : Math.sqrt(Math.max(0, m2 / n));
  }
  // Guarded path: skip missing (non-finite) cells ([PND-NANREP]); `n`
  // counts only contributors so `n === 0` → `undefined`.
  for (let i = start; i < end; i += 1) {
    const v = values[i]!;
    if (v - v !== 0) continue;
    n += 1;
    const delta = v - mean;
    mean += delta / n;
    m2 += delta * (v - mean);
  }
  return n === 0 ? undefined : Math.sqrt(Math.max(0, m2 / n));
}

export const stdev: ReducerDef = {
  outputKind: 'number',
  reduce(_d, numeric) {
    const w = welfordStdev();
    for (let i = 0; i < numeric.length; i += 1) w.add(numeric[i]!);
    return w.result();
  },
  reduceColumn(col) {
    return stdevRange(col, 0, col.length);
  },
  reduceColumnRange: stdevRange,
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
    // Sliding-window population stdev from double-double running sums of
    // shifted values (`WindowStdev`, `./window-accumulators.ts`) —
    // [PND-ROLLSTD]. The previous Welford add/delete state rounded on every
    // add and every remove and never took the error back, so it drifted
    // for as long as the window stayed non-empty; a window that drained to
    // two close values could read 25% off. The double-double sums keep each
    // step's rounding error, so add-then-remove leaves the remaining
    // values' sums to ~2^-104, at any magnitude. That also retires the old
    // "outlier eviction" limitation: removing a value far outside the
    // remaining spread no longer cancels away the small remainder.
    //
    // Removal is **by value, not by position**. That matters for the live
    // layer: `LiveReduce` shares this state, and a `reorder`-mode source
    // with retention evicts the sorted-prefix — which may be a later arrival,
    // not the oldest — so a positional (FIFO) remove would corrupt the window.
    // The batch rolling driver removes strictly oldest-first — a special case.
    //
    // Non-finite / missing cells arrive as `undefined` (the factory wrapper
    // applies the non-finite policy); `add`/`remove` both skip them
    // symmetrically so they never enter `n`.
    //
    // Values at or above `STDEV_SPLIT` (2^480) go to a separate, exact
    // lane, so an overflow can't stick in the sums after the huge values
    // leave the window, and removing one never cancels — see
    // `./overflow-lanes.ts`.
    const w = new WindowStdev();
    const big = stdevBigLane();
    return {
      add(_i, v) {
        if (typeof v !== 'number') return;
        if (!(v < STDEV_SPLIT && v > -STDEV_SPLIT)) {
          stdevBigLaneAdd(big, v);
          return;
        }
        w.add(v);
      },
      remove(_i, v) {
        if (typeof v !== 'number') return;
        if (!(v < STDEV_SPLIT && v > -STDEV_SPLIT)) {
          stdevBigLaneRemove(big, v);
          return;
        }
        w.remove(v);
      },
      snapshot() {
        if (big.n !== 0) {
          return stdevWithBigLane(w.n, w.mean() ?? 0, w.m2(), big);
        }
        return w.stdev();
      },
    };
  },
};
