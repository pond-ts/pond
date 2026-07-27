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
 * Below this length, finish with an insertion sort instead of another
 * partition. Standard quickselect practice: partitioning has enough
 * per-call overhead that a short run is cheaper to sort outright, and
 * sorting the tail also leaves the neighbouring rank in place, which the
 * two-rank interpolation path needs.
 */
const SELECT_INSERTION_THRESHOLD = 16;

/**
 * In-place Hoare-partition quickselect over a `Float64Array` slice.
 * Places the `k`th smallest element at index `k` and returns it;
 * everything left of `k` compares `<=` it.
 *
 * **Why not just sort.** A percentile needs one or two order statistics,
 * not a total order. `Float64Array.prototype.sort()` is O(n log n);
 * quickselect is O(n) expected. Measured on 1M cells this is the
 * difference between ~78 ms and ~7 ms.
 *
 * **Median-of-three pivot, deliberately.** The columnar data this runs
 * on is frequently already sorted or nearly so — a monotonic key column,
 * a `cumulative` result, a `byValue` materialisation. A first-element or
 * middle-element pivot degrades to O(n²) on exactly those inputs, which
 * would turn a chart frame into a hang. Median-of-three makes the
 * adversarial case an unlikely one rather than the common one.
 *
 * The caller has already filtered non-finite cells (reducer non-finite
 * policy), so plain `<` / `>` comparisons give the same total order as
 * the `Float64Array` sort intrinsic they replace, and no NaN can reach
 * the comparisons to make the partition loop misbehave.
 */
function quickselect(
  a: Float64Array,
  k: number,
  lo: number,
  hi: number,
): number {
  let left = lo;
  let right = hi;
  while (left < right) {
    if (right - left < SELECT_INSERTION_THRESHOLD) {
      for (let i = left + 1; i <= right; i += 1) {
        const v = a[i]!;
        let j = i - 1;
        while (j >= left && a[j]! > v) {
          a[j + 1] = a[j]!;
          j -= 1;
        }
        a[j + 1] = v;
      }
      return a[k]!;
    }
    // Median-of-three, as three compare-swaps, leaving the median of the
    // sampled values at `mid`.
    const mid = (left + right) >> 1;
    if (a[mid]! < a[left]!) {
      const t = a[mid]!;
      a[mid] = a[left]!;
      a[left] = t;
    }
    if (a[right]! < a[left]!) {
      const t = a[right]!;
      a[right] = a[left]!;
      a[left] = t;
    }
    if (a[right]! < a[mid]!) {
      const t = a[right]!;
      a[right] = a[mid]!;
      a[mid] = t;
    }
    const pivot = a[mid]!;
    let i = left;
    let j = right;
    while (i <= j) {
      while (a[i]! < pivot) i += 1;
      while (a[j]! > pivot) j -= 1;
      if (i <= j) {
        const t = a[i]!;
        a[i] = a[j]!;
        a[j] = t;
        i += 1;
        j -= 1;
      }
    }
    if (k <= j) right = j;
    else if (k >= i) left = i;
    else return a[k]!;
  }
  return a[k]!;
}

/**
 * Reads the `q`th percentile out of an **unsorted** dense slice,
 * mutating it. Same interpolation as {@link percentileOfSorted}, so the
 * column path and the row path agree by construction.
 *
 * When the rank falls between two elements, the upper one is selected
 * first: that leaves everything smaller in the left partition, so the
 * second selection only searches that prefix instead of the whole array.
 */
function percentileOfUnsorted(dense: Float64Array, q: number): number {
  const k = dense.length;
  const rank = (q / 100) * (k - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return quickselect(dense, lo, 0, k - 1);
  const vHi = quickselect(dense, hi, 0, k - 1);
  const vLo = quickselect(dense, lo, 0, hi);
  return vLo + (vHi - vLo) * (rank - lo);
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
  // Quickselect, not a full sort: a percentile needs one or two order
  // statistics, and sorting to get them is O(n log n) work for an O(n)
  // question. Non-finite cells were excluded upstream by policy, so the
  // plain comparisons inside `quickselect` induce the same total order
  // the `Float64Array.sort` intrinsic did — and therefore the same order
  // as the row path's `Array.sort((a, b) => a - b)`.
  return percentileOfUnsorted(dense.subarray(0, denseLength), q);
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
