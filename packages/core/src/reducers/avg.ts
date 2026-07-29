import type { Float64Column } from '../columnar/index.js';
import { BLOCKED_MIN, blockedSum, blockedSumMasked } from './blocked.js';
import type { ReducerDef } from './types.js';

/**
 * Arithmetic mean of the defined (and, on the guarded path, finite)
 * cells of `col[start, end)`; `undefined` when the range has no
 * contributor.
 *
 * **Deliberately not shared with `reduceColumn`,** for the same reason as
 * `count`: the whole-column form takes its divisor from the cached
 * `validity.definedCount` in O(1), while a sub-range has to popcount it
 * with `countInRange`. Sharing one body would have made
 * `Float64Column.mean()` do an O(n/8) pass it does not need.
 *
 * The numerator follows `sum`: runs of at least {@link BLOCKED_MIN} on
 * the `allFinite` paths accumulate into eight partial sums, which may
 * differ from the sequential result in the last ulp (see
 * `./blocked.ts`). Only the summation changes — the divisor is counted
 * exactly as before.
 */
function avgRange(
  col: Float64Column,
  start: number,
  end: number,
): number | undefined {
  const values = col._values;
  const validity = col.validity;
  let s = 0;
  let n = 0;
  // Fast path: every defined cell is finite (`Float64Column.allFinite`),
  // so every defined cell is a valid contributor — plain accumulate, and
  // the divisor is the range's defined count. Drops the per-element
  // finite guard the non-finite policy otherwise requires.
  if (col.allFinite) {
    if (validity === undefined) {
      if (end <= start) return undefined;
      if (end - start >= BLOCKED_MIN) {
        return blockedSum(values, start, end) / (end - start);
      }
      for (let i = start; i < end; i += 1) s += values[i]!;
      return s / (end - start);
    }
    const bits = validity.bits;
    if (end - start >= BLOCKED_MIN) {
      s = blockedSumMasked(values, bits, start, end);
    } else {
      for (let i = start; i < end; i += 1) {
        if ((bits[i >> 3]! & (1 << (i & 7))) !== 0) s += values[i]!;
      }
    }
    const defined = validity.countInRange(start, end);
    return defined === 0 ? undefined : s / defined;
  }
  // Guarded path: divide by the count of *finite* contributors, not the
  // defined count — a non-finite cell is skipped per policy, so it must
  // not inflate the divisor.
  if (validity === undefined) {
    for (let i = start; i < end; i += 1) {
      const v = values[i]!;
      if (Number.isFinite(v)) {
        s += v;
        n += 1;
      }
    }
    return n === 0 ? undefined : s / n;
  }
  const bits = validity.bits;
  for (let i = start; i < end; i += 1) {
    if ((bits[i >> 3]! & (1 << (i & 7))) !== 0) {
      const v = values[i]!;
      if (Number.isFinite(v)) {
        s += v;
        n += 1;
      }
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
    const values = col._values;
    const validity = col.validity;
    let s = 0;
    let n = 0;
    // Fast path: every defined cell is finite (`Float64Column.allFinite`),
    // so every defined cell is a valid contributor — plain accumulate, and
    // the divisor is `definedCount` (or `col.length`). Drops the
    // per-element finite guard the reducer non-finite policy
    // (docs/notes/reducer-nan-policy.md) otherwise requires.
    if (col.allFinite) {
      if (validity === undefined) {
        if (col.length === 0) return undefined;
        if (col.length >= BLOCKED_MIN) {
          return blockedSum(values, 0, col.length) / col.length;
        }
        for (let i = 0; i < col.length; i += 1) s += values[i]!;
        return s / col.length;
      }
      const bits = validity.bits;
      if (col.length >= BLOCKED_MIN) {
        s = blockedSumMasked(values, bits, 0, col.length);
      } else {
        for (let i = 0; i < col.length; i += 1) {
          if ((bits[i >> 3]! & (1 << (i & 7))) !== 0) s += values[i]!;
        }
      }
      const count = validity.definedCount;
      return count === 0 ? undefined : s / count;
    }
    // Guarded path: divide by the count of *finite* contributors, not
    // `definedCount` — a non-finite cell is skipped per policy, so it must
    // not inflate the divisor.
    if (validity === undefined) {
      for (let i = 0; i < col.length; i += 1) {
        const v = values[i]!;
        if (Number.isFinite(v)) {
          s += v;
          n += 1;
        }
      }
      return n === 0 ? undefined : s / n;
    }
    const bits = validity.bits;
    for (let i = 0; i < col.length; i += 1) {
      if ((bits[i >> 3]! & (1 << (i & 7))) !== 0) {
        const v = values[i]!;
        if (Number.isFinite(v)) {
          s += v;
          n += 1;
        }
      }
    }
    return n === 0 ? undefined : s / n;
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
    let s = 0;
    let n = 0;
    return {
      add(_i, v) {
        if (typeof v === 'number') {
          s += v;
          n++;
        }
      },
      remove(_i, v) {
        if (typeof v === 'number') {
          s -= v;
          n--;
        }
      },
      snapshot() {
        return n === 0 ? undefined : s / n;
      },
    };
  },
};
