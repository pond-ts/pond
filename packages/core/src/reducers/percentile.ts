import type { Float64Column } from '../columnar/index.js';
import type { ReducerDef } from './types.js';
import { rollingSortedArray } from './rolling.js';

export function percentileOfSorted(sorted: number[], q: number): number {
  const rank = (q / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
}

export function parsePercentile(op: string): number | undefined {
  if (op.length > 1 && op.charCodeAt(0) === 112) {
    const q = Number(op.slice(1));
    if (q >= 0 && q <= 100) return q;
  }
  return undefined;
}

/**
 * Shared `reduceColumn` body for percentile-shaped reducers
 * (`median`, `p50`, `p95`, etc.). Walks the validity bitmap to
 * gather defined cells into a dense `Float64Array`, detecting NaN
 * cells in the same pass; sorts and reads the percentile from
 * the sorted view.
 *
 * **NaN parity with row API.** Two sort behaviors diverge:
 *
 * - `Array.prototype.sort((a, b) => a - b)` (row-API path) returns
 *   NaN from the comparator on NaN inputs; V8 treats this as
 *   "equal" and leaves NaN cells in undefined order — the
 *   resulting percentile is whatever cell happens to land at the
 *   computed rank, possibly NaN itself.
 * - `Float64Array.prototype.sort()` (typed-array intrinsic) puts
 *   NaN deterministically at the end of the sorted view — the
 *   percentile rank then reads a non-NaN cell unless the rank
 *   lands in the NaN suffix.
 *
 * The first-pass NaN detection lets us use `Float64Array.sort`'s
 * 2× speedup for the common no-NaN case (full parity with row API
 * because both produce identical sorted orders when no NaN
 * present), and fall back to `Array.sort` with comparator only
 * when NaN is present (preserving bug-for-bug row-API parity on
 * the rare contract-violating input).
 *
 * NaN can only reach a `kind: 'number'` column via trusted
 * construction (`fromEvents`); the public `assertCellKind`
 * rejects it at intake. Closed Codex review finding on PR #153 —
 * earlier L2 fix that filtered NaN was correct in spirit but
 * introduced a *different* divergence from the row API. A
 * principled "filter NaN consistently across both paths" fix is
 * tracked in the followup issue.
 */
export function reducePercentileColumn(
  col: Float64Column,
  q: number,
): number | undefined {
  const validity = col.validity;
  const values = col.values;
  let dense: Float64Array;
  let denseLength = 0;
  let hasNaN = false;
  if (validity === undefined) {
    if (col.length === 0) return undefined;
    dense = new Float64Array(col.length);
    for (let i = 0; i < col.length; i += 1) {
      const v = values[i]!;
      if (Number.isNaN(v)) hasNaN = true;
      dense[denseLength] = v;
      denseLength += 1;
    }
  } else {
    const definedCount = validity.definedCount;
    if (definedCount === 0) return undefined;
    dense = new Float64Array(definedCount);
    const bits = validity.bits;
    for (let i = 0; i < col.length; i += 1) {
      if ((bits[i >> 3]! & (1 << (i & 7))) === 0) continue;
      const v = values[i]!;
      if (Number.isNaN(v)) hasNaN = true;
      dense[denseLength] = v;
      denseLength += 1;
    }
  }
  if (denseLength === 0) return undefined;
  if (hasNaN) {
    // Match row-API exactly via `Array.sort` with comparator —
    // diverges from `Float64Array.sort` on NaN ordering.
    const arr = Array.from(dense.subarray(0, denseLength));
    arr.sort((a, b) => a - b);
    return percentileOfSorted(arr, q);
  }
  // No NaN: `Float64Array.sort` is parity-correct (same total
  // order as `Array.sort` with comparator) and ~2× faster.
  const view = dense.subarray(0, denseLength);
  view.sort();
  const rank = (q / 100) * (denseLength - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return view[lo]!;
  return view[lo]! + (view[hi]! - view[lo]!) * (rank - lo);
}

export function percentileReducer(q: number): ReducerDef {
  return {
    outputKind: 'number',
    reduce(_d, numeric) {
      if (numeric.length === 0) return undefined;
      const sorted = numeric.slice().sort((a, b) => a - b);
      return percentileOfSorted(sorted, q);
    },
    reduceColumn(col) {
      return reducePercentileColumn(col, q);
    },
    bucketState() {
      const collected: number[] = [];
      return {
        add(v) {
          if (typeof v === 'number') collected.push(v);
        },
        snapshot() {
          if (collected.length === 0) return undefined;
          const sorted = collected.slice().sort((a, b) => a - b);
          return percentileOfSorted(sorted, q);
        },
      };
    },
    rollingState() {
      const arr = rollingSortedArray();
      return {
        add: arr.add,
        remove: arr.remove,
        snapshot() {
          return arr.sorted.length === 0
            ? undefined
            : percentileOfSorted(arr.sorted, q);
        },
      };
    },
  };
}
