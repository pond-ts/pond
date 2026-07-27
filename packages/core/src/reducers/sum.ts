import type { Float64Column } from '../columnar/index.js';
import type { ReducerDef } from './types.js';

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
      for (let i = start; i < end; i += 1) s += values[i]!;
      return s;
    }
    const bits = validity.bits;
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
  },
};
