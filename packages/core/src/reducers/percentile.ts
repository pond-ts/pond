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
  return reducePercentileColumnRange(col, q, 0, col.length);
}

/**
 * Range-scoped percentile — `reducePercentileColumn` restricted to
 * `col[start, end)`. The bucketed callers (`aggregate`) use this so they
 * do not have to materialise a `Float64Column` slice per bucket.
 *
 * The dense gather buffer is sized to the range's defined count, so a
 * bucket allocates in proportion to itself rather than to the column —
 * the same size the slice path would have gathered, minus the slice.
 *
 * Sizing the buffer costs a `countInRange` popcount on the bitmap path,
 * where the whole-column form could have read the cached `definedCount`.
 * That is deliberate: it is an O(range/8) pass in front of an O(k) gather
 * and an O(k log k) sort, so it is dominated (measured at 0.20% of a
 * 1M-row `median()`), and paying it keeps one implementation instead of
 * two that could disagree about which cells qualify.
 */
export function reducePercentileColumnRange(
  col: Float64Column,
  q: number,
  start: number,
  end: number,
): number | undefined {
  const validity = col.validity;
  const values = col._values;
  const width = end - start;
  let dense: Float64Array;
  let denseLength = 0;
  // Fast path: every defined cell is finite (`Float64Column.allFinite`),
  // so we gather defined cells with no per-element `Number.isFinite`
  // filter (reducer non-finite policy, docs/notes/reducer-nan-policy.md).
  // The subsequent `Float64Array.sort` is the same NaN-free intrinsic
  // either way → identical order, identical percentile.
  if (col.allFinite) {
    if (validity === undefined) {
      if (width <= 0) return undefined;
      dense = new Float64Array(width);
      for (let i = start; i < end; i += 1) {
        dense[denseLength] = values[i]!;
        denseLength += 1;
      }
    } else {
      const definedCount = validity.countInRange(start, end);
      if (definedCount === 0) return undefined;
      dense = new Float64Array(definedCount);
      const bits = validity.bits;
      for (let i = start; i < end; i += 1) {
        if ((bits[i >> 3]! & (1 << (i & 7))) === 0) continue;
        dense[denseLength] = values[i]!;
        denseLength += 1;
      }
    }
  } else if (validity === undefined) {
    // Guarded path: filter non-finite before the sort.
    if (width <= 0) return undefined;
    dense = new Float64Array(width);
    for (let i = start; i < end; i += 1) {
      const v = values[i]!;
      if (!Number.isFinite(v)) continue;
      dense[denseLength] = v;
      denseLength += 1;
    }
  } else {
    const definedCount = validity.countInRange(start, end);
    if (definedCount === 0) return undefined;
    dense = new Float64Array(definedCount);
    const bits = validity.bits;
    for (let i = start; i < end; i += 1) {
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
    reduceColumnRange(col, start, end) {
      return reducePercentileColumnRange(col, q, start, end);
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
