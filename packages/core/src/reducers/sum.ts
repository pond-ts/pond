import type { Float64Column } from '../columnar/index.js';
import { BLOCKED_MIN, blockedSum, blockedSumFinite } from './blocked.js';
import { LanedSum } from './overflow-lanes.js';
import type { ReducerDef, RollingReducerState } from './types.js';

/**
 * Sums the defined cells of `col[start, end)`. A missing cell is a
 * non-finite value in the buffer ([PND-NANREP]), so "defined" and
 * "finite" are the same test.
 *
 * The single column kernel: `reduceColumn` is this at `(0, length)` and
 * `reduceColumnRange` is this directly, so the whole-column and bucketed
 * paths cannot drift. Declared as a standalone function rather than a
 * method delegating through `this`, because callers detach the reducer
 * (`const reduce = def.reduceColumnRange`) and a `this`-bound body would
 * break when they do.
 *
 * Runs of at least {@link BLOCKED_MIN} cells accumulate into eight
 * independent partial sums (see `./blocked.ts`), which is 2.2–2.5× faster
 * and — because floating-point addition is not associative — may differ
 * from the sequential result in the last ulp. Shorter runs stay
 * sequential and so stay bit-identical.
 */
function sumRange(col: Float64Column, start: number, end: number): number {
  const values = col._values;
  let s = 0;
  // Fast path: the column proved every cell is finite
  // (`Float64Column.allFinite`), so we drop the per-element finite test —
  // plain accumulate, identical result.
  if (col.allFinite) {
    if (end - start >= BLOCKED_MIN) return blockedSum(values, start, end);
    for (let i = start; i < end; i += 1) s += values[i]!;
    return s;
  }
  // Guarded path: skip missing (non-finite) cells.
  if (end - start >= BLOCKED_MIN) return blockedSumFinite(values, start, end);
  for (let i = start; i < end; i += 1) {
    const v = values[i]!;
    if (v - v === 0) s += v;
  }
  return s;
}

/**
 * The single-accumulator running sum — `sum`'s `rollingState` without the
 * overflow lanes. **Not overflow-safe**: once `s` reaches ±Infinity it stays
 * there. Only the packed count-window sweep (`batch/aggregate-columns.ts`)
 * uses it, because that sweep notices the first non-finite answer and
 * re-runs the column with the laned state — so ordinary columns skip the
 * per-cell lane compare. Callers pass only finite numbers (or `undefined`).
 */
export function plainRollingSum(): RollingReducerState {
  let s = 0;
  return {
    add(_i, v) {
      if (typeof v === 'number') s += v;
    },
    remove(_i, v) {
      if (typeof v === 'number') s -= v;
    },
    snapshot() {
      return s;
    },
  };
}

export const sum: ReducerDef = {
  outputKind: 'number',
  reduce(_d, numeric) {
    return numeric.reduce((s, v) => s + v, 0);
  },
  reduceColumn(col) {
    return sumRange(col, 0, col.length);
  },
  reduceColumnRange: sumRange,
  bucketState() {
    let s = 0;
    return {
      add(v) {
        if (typeof v === 'number') s += v;
      },
      snapshot() {
        return s;
      },
    };
  },
  rollingState() {
    // Two lanes so an overflow can't stick in the running sum after the
    // huge values leave the window — see `./overflow-lanes.ts`. `s` is the
    // old accumulator, bit for bit, for every value below `SUM_SPLIT`.
    const s = new LanedSum();
    return {
      add(_i, v) {
        if (typeof v === 'number') s.add(v);
      },
      remove(_i, v) {
        if (typeof v === 'number') s.remove(v);
      },
      snapshot() {
        return s.total();
      },
    };
  },
};
