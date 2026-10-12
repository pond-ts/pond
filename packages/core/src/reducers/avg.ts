import type { Float64Column } from '../columnar/index.js';
import {
  BLOCKED_MIN,
  blockedSum,
  blockedSumFinite,
  countFinite,
} from './blocked.js';
import { LanedSum } from './overflow-lanes.js';
import type { ReducerDef } from './types.js';

/**
 * Arithmetic mean of the defined cells of `col[start, end)`; `undefined`
 * when the range has no contributor. A missing cell is a non-finite value
 * in the buffer ([PND-NANREP]), so it neither adds to the sum nor counts
 * toward the divisor.
 *
 * **Deliberately not shared with `reduceColumn`,** for the same reason as
 * `count`: the whole-column form takes its divisor from the column's
 * cached `missingCount`, while a sub-range has to count it.
 *
 * The numerator follows `sum`: runs of at least {@link BLOCKED_MIN}
 * accumulate into eight partial sums, which may differ from the
 * sequential result in the last ulp (see `./blocked.ts`). Only the
 * summation changes — the divisor is counted exactly.
 */
function avgRange(
  col: Float64Column,
  start: number,
  end: number,
): number | undefined {
  if (end <= start) return undefined;
  const values = col._values;
  let s = 0;
  // Fast path: every cell is finite (`Float64Column.allFinite`) — plain
  // accumulate, and the divisor is the range length.
  if (col.allFinite) {
    if (end - start >= BLOCKED_MIN) {
      return blockedSum(values, start, end) / (end - start);
    }
    for (let i = start; i < end; i += 1) s += values[i]!;
    return s / (end - start);
  }
  // Guarded path: skip missing cells, and divide by the count of
  // contributors.
  if (end - start >= BLOCKED_MIN) {
    const n = countFinite(values, start, end);
    return n === 0 ? undefined : blockedSumFinite(values, start, end) / n;
  }
  let n = 0;
  for (let i = start; i < end; i += 1) {
    const v = values[i]!;
    if (v - v === 0) {
      s += v;
      n += 1;
    }
  }
  return n === 0 ? undefined : s / n;
}

export const avg: ReducerDef = {
  outputKind: 'number',
  reduce(_d, numeric) {
    return numeric.length === 0
      ? undefined
      : numeric.reduce((s, v) => s + v, 0) / numeric.length;
  },
  reduceColumnRange: avgRange,
  reduceColumn(col) {
    const length = col.length;
    if (length === 0) return undefined;
    const values = col._values;
    // Fast path: every cell is finite (`Float64Column.allFinite`) — plain
    // accumulate over the whole column, divided by its length.
    if (col.allFinite) {
      if (length >= BLOCKED_MIN) return blockedSum(values, 0, length) / length;
      let s = 0;
      for (let i = 0; i < length; i += 1) s += values[i]!;
      return s / length;
    }
    // Guarded path: the divisor is the defined count, from the column's
    // cached `missingCount`.
    const n = length - col.missingCount;
    if (n === 0) return undefined;
    if (length >= BLOCKED_MIN) return blockedSumFinite(values, 0, length) / n;
    let s = 0;
    for (let i = 0; i < length; i += 1) {
      const v = values[i]!;
      if (v - v === 0) s += v;
    }
    return s / n;
  },
  bucketState() {
    let s = 0;
    let n = 0;
    return {
      add(v) {
        if (typeof v === 'number') {
          s += v;
          n++;
        }
      },
      snapshot() {
        return n === 0 ? undefined : s / n;
      },
    };
  },
  rollingState() {
    // Same two-lane running sum as `sum`'s rollingState, so an overflow
    // can't stick after the huge values leave — see `./overflow-lanes.ts`.
    // The mean is still sum-then-divide, so a window whose *sum* overflows
    // reads missing even if its mean is representable (`[MAX, MAX]`) —
    // the same answer `reduce` gives.
    const s = new LanedSum();
    let n = 0;
    return {
      add(_i, v) {
        if (typeof v !== 'number') return;
        n++;
        s.add(v);
      },
      remove(_i, v) {
        if (typeof v !== 'number') return;
        n--;
        s.remove(v);
      },
      snapshot() {
        return n === 0 ? undefined : s.total() / n;
      },
    };
  },
};
