import type { Float64Column } from '../columnar/index.js';
import { BLOCKED_MIN, blockedSum, blockedSumMasked } from './blocked.js';
import { SUM_SCALE, SUM_SPLIT, SUM_UNSCALE } from './overflow-lanes.js';
import type { ReducerDef, RollingReducerState } from './types.js';

/**
 * Sums the defined (and, on the guarded path, finite) cells of
 * `col[start, end)`.
 *
 * The single column kernel: `reduceColumn` is this at `(0, length)` and
 * `reduceColumnRange` is this directly, so the whole-column and bucketed
 * paths cannot drift. Declared as a standalone function rather than a
 * method delegating through `this`, because callers detach the reducer
 * (`const reduce = def.reduceColumnRange`) and a `this`-bound body would
 * break when they do.
 *
 * Runs of at least {@link BLOCKED_MIN} cells on the `allFinite` paths
 * accumulate into eight independent partial sums (see `./blocked.ts`),
 * which is 2.2–2.5× faster and — because floating-point addition is not
 * associative — may differ from the sequential result in the last ulp.
 * Shorter runs stay sequential and so stay bit-identical.
 */
function sumRange(col: Float64Column, start: number, end: number): number {
  const values = col._values;
  const validity = col.validity;
  let s = 0;
  // Fast path: the column proved every defined cell is finite
  // (`Float64Column.allFinite`), so we can drop the per-element
  // `Number.isFinite` guard the reducer non-finite policy
  // (docs/notes/reducer-nan-policy.md) otherwise requires — plain
  // accumulate, identical result.
  if (col.allFinite) {
    if (validity === undefined) {
      if (end - start >= BLOCKED_MIN) return blockedSum(values, start, end);
      for (let i = start; i < end; i += 1) s += values[i]!;
      return s;
    }
    const bits = validity.bits;
    if (end - start >= BLOCKED_MIN) {
      return blockedSumMasked(values, bits, start, end);
    }
    for (let i = start; i < end; i += 1) {
      if ((bits[i >> 3]! & (1 << (i & 7))) !== 0) s += values[i]!;
    }
    return s;
  }
  // Guarded path: finiteness not proven, skip non-finite per policy.
  if (validity === undefined) {
    for (let i = start; i < end; i += 1) {
      const v = values[i]!;
      if (Number.isFinite(v)) s += v;
    }
    return s;
  }
  // Inline bitmap check rather than method dispatch — same pattern
  // the chart-friction-spike notes flagged for hot draw loops.
  const bits = validity.bits;
  for (let i = start; i < end; i += 1) {
    if ((bits[i >> 3]! & (1 << (i & 7))) !== 0) {
      const v = values[i]!;
      if (Number.isFinite(v)) s += v;
    }
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
    let s = 0;
    let big = 0; // Σ v·2^-960 over the |v| ≥ SUM_SPLIT values
    let bigN = 0;
    return {
      add(_i, v) {
        if (typeof v !== 'number') return;
        if (v < SUM_SPLIT && v > -SUM_SPLIT) s += v;
        else {
          big += v * SUM_SCALE;
          bigN += 1;
        }
      },
      remove(_i, v) {
        if (typeof v !== 'number') return;
        if (v < SUM_SPLIT && v > -SUM_SPLIT) s -= v;
        else if (--bigN === 0) big = 0;
        else big -= v * SUM_SCALE;
      },
      snapshot() {
        return bigN === 0 ? s : s + big * SUM_UNSCALE;
      },
    };
  },
};
