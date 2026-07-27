import type { Float64Column } from '../columnar/index.js';
import type { ReducerDef } from './types.js';
import { rollingMonotoneDeque } from './rolling.js';

/**
 * Smallest defined (and, on the guarded path, finite) value in
 * `col[start, end)`, or `undefined` when the range has no contributor.
 *
 * The single column kernel — `reduceColumn` is this at `(0, length)`. See
 * the note on `sumRange` for why it is a standalone function rather than
 * a method delegating through `this`.
 */
function minRange(
  col: Float64Column,
  start: number,
  end: number,
): number | undefined {
  const values = col._values;
  const validity = col.validity;
  let lo: number | undefined;
  // Fast path: every defined cell is finite (`Float64Column.allFinite`),
  // so we seed `lo` from the first defined cell and run a plain `v < lo`
  // compare with NO per-element `Number.isFinite` guard and NO in-loop
  // `lo === undefined` check (the seed hoists it out). There is no NaN to
  // mishandle, so this also sidesteps the position-dependent `a<=b?a:b`
  // extremum bug the policy fixed (docs/notes/reducer-nan-policy.md). This
  // is the pre-policy column loop, recovered.
  if (col.allFinite) {
    if (end <= start) return undefined;
    if (validity === undefined) {
      lo = values[start]!;
      for (let i = start + 1; i < end; i += 1) {
        const v = values[i]!;
        if (v < lo) lo = v;
      }
      return lo;
    }
    const bits = validity.bits;
    for (let i = start; i < end; i += 1) {
      if ((bits[i >> 3]! & (1 << (i & 7))) === 0) continue;
      const v = values[i]!;
      if (lo === undefined || v < lo) lo = v;
    }
    return lo;
  }
  // Guarded path: skip non-finite cells (reducer non-finite policy) —
  // matches `bucketState`'s `v < lo`.
  if (validity === undefined) {
    for (let i = start; i < end; i += 1) {
      const v = values[i]!;
      if (Number.isFinite(v) && (lo === undefined || v < lo)) lo = v;
    }
    return lo;
  }
  const bits = validity.bits;
  for (let i = start; i < end; i += 1) {
    if ((bits[i >> 3]! & (1 << (i & 7))) === 0) continue;
    const v = values[i]!;
    if (Number.isFinite(v) && (lo === undefined || v < lo)) lo = v;
  }
  return lo;
}

export const min: ReducerDef = {
  outputKind: 'number',
  reduce(_d, numeric) {
    return numeric.length === 0
      ? undefined
      : numeric.reduce((a, b) => (a <= b ? a : b));
  },
  reduceColumn(col) {
    return minRange(col, 0, col.length);
  },
  reduceColumnRange: minRange,
  bucketState() {
    let lo: number | undefined;
    return {
      add(v) {
        if (typeof v === 'number' && (lo === undefined || v < lo)) lo = v;
      },
      snapshot() {
        return lo;
      },
    };
  },
  rollingState() {
    return rollingMonotoneDeque((existing, incoming) => existing <= incoming);
  },
};
