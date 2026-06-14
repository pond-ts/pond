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
 * gather defined **and finite** cells into a dense `Float64Array`,
 * sorts with the typed-array intrinsic, and reads the percentile
 * from the sorted view.
 *
 * Non-finite cells (`NaN` / `±Infinity`) are excluded by the
 * reducer non-finite policy (docs/notes/reducer-nan-policy.md) —
 * uniformly, across every path. With non-finite filtered out
 * before the sort, `Float64Array.prototype.sort()` (the numeric,
 * NaN-free intrinsic, ~2× faster than `Array.sort` with a
 * comparator) produces the same total order as the row path's
 * `Array.sort((a, b) => a - b)` over the same finite values — so
 * there is no longer any NaN-ordering seam to special-case.
 *
 * Empty (no defined+finite values) → `undefined`.
 */
export function reducePercentileColumn(
  col: Float64Column,
  q: number,
): number | undefined {
  const validity = col.validity;
  const values = col._values;
  let dense: Float64Array;
  let denseLength = 0;
  // Fast path: every defined cell is finite (`Float64Column.allFinite`),
  // so we gather defined cells with no per-element `Number.isFinite`
  // filter (reducer non-finite policy, docs/notes/reducer-nan-policy.md).
  // The subsequent `Float64Array.sort` is the same NaN-free intrinsic
  // either way → identical order, identical percentile.
  if (col.allFinite) {
    if (validity === undefined) {
      if (col.length === 0) return undefined;
      dense = new Float64Array(col.length);
      for (let i = 0; i < col.length; i += 1) {
        dense[denseLength] = values[i]!;
        denseLength += 1;
      }
    } else {
      const definedCount = validity.definedCount;
      if (definedCount === 0) return undefined;
      dense = new Float64Array(definedCount);
      const bits = validity.bits;
      for (let i = 0; i < col.length; i += 1) {
        if ((bits[i >> 3]! & (1 << (i & 7))) === 0) continue;
        dense[denseLength] = values[i]!;
        denseLength += 1;
      }
    }
  } else if (validity === undefined) {
    // Guarded path: filter non-finite before the sort.
    if (col.length === 0) return undefined;
    dense = new Float64Array(col.length);
    for (let i = 0; i < col.length; i += 1) {
      const v = values[i]!;
      if (!Number.isFinite(v)) continue;
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
      if (!Number.isFinite(v)) continue;
      dense[denseLength] = v;
      denseLength += 1;
    }
  }
  if (denseLength === 0) return undefined;
  // Non-finite excluded upstream by policy → `Float64Array.sort` (numeric,
  // NaN-free) gives the same order as the row path's comparator sort.
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
