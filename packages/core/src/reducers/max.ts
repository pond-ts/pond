import type { Float64Column } from '../columnar/index.js';
import type { ReducerDef } from './types.js';
import { rollingMonotoneDeque } from './rolling.js';

/**
 * Largest defined value in `col[start, end)`, or `undefined` when the
 * range has no contributor. A missing cell is a non-finite value in the
 * buffer ([PND-NANREP]).
 *
 * The single column kernel — `reduceColumn` is this at `(0, length)`. See
 * the note on `sumRange` for why it is a standalone function rather than
 * a method delegating through `this`.
 */
function maxRange(
  col: Float64Column,
  start: number,
  end: number,
): number | undefined {
  const values = col._values;
  // Fast path: every cell is finite (`Float64Column.allFinite`), so we
  // seed `hi` from the first cell and run a plain `v > hi` compare
  // with NO per-element finite test and NO in-loop `hi === undefined`
  // check (the seed hoists it out). There is no NaN to mishandle, so this
  // also sidesteps the position-dependent `a<=b?a:b` extremum bug the
  // policy fixed (docs/notes/reducer-nan-policy.md).
  if (col.allFinite) {
    if (end <= start) return undefined;
    let hi = values[start]!;
    for (let i = start + 1; i < end; i += 1) {
      const v = values[i]!;
      if (v > hi) hi = v;
    }
    return hi;
  }
  // Guarded path: skip missing (non-finite) cells — matches
  // `bucketState`'s `v > hi`.
  let hi: number | undefined;
  for (let i = start; i < end; i += 1) {
    const v = values[i]!;
    if (v - v === 0 && (hi === undefined || v > hi)) hi = v;
  }
  return hi;
}

export const max: ReducerDef = {
  outputKind: 'number',
  reduce(_d, numeric) {
    return numeric.length === 0
      ? undefined
      : numeric.reduce((a, b) => (a >= b ? a : b));
  },
  reduceColumn(col) {
    return maxRange(col, 0, col.length);
  },
  reduceColumnRange: maxRange,
  bucketState() {
    let hi: number | undefined;
    return {
      add(v) {
        if (typeof v === 'number' && (hi === undefined || v > hi)) hi = v;
      },
      snapshot() {
        return hi;
      },
    };
  },
  rollingState() {
    return rollingMonotoneDeque((existing, incoming) => existing >= incoming);
  },
};
