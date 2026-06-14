import type { ReducerDef } from './types.js';
import { rollingMonotoneDeque } from './rolling.js';

export const min: ReducerDef = {
  outputKind: 'number',
  reduce(_d, numeric) {
    return numeric.length === 0
      ? undefined
      : numeric.reduce((a, b) => (a <= b ? a : b));
  },
  reduceColumn(col) {
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
      const len = col.length;
      if (len === 0) return undefined;
      if (validity === undefined) {
        lo = values[0]!;
        for (let i = 1; i < len; i += 1) {
          const v = values[i]!;
          if (v < lo) lo = v;
        }
        return lo;
      }
      const bits = validity.bits;
      for (let i = 0; i < len; i += 1) {
        if ((bits[i >> 3]! & (1 << (i & 7))) === 0) continue;
        const v = values[i]!;
        if (lo === undefined || v < lo) lo = v;
      }
      return lo;
    }
    // Guarded path: skip non-finite cells (reducer non-finite policy) —
    // matches `bucketState`'s `v < lo`.
    if (validity === undefined) {
      for (let i = 0; i < col.length; i += 1) {
        const v = values[i]!;
        if (Number.isFinite(v) && (lo === undefined || v < lo)) lo = v;
      }
      return lo;
    }
    const bits = validity.bits;
    for (let i = 0; i < col.length; i += 1) {
      if ((bits[i >> 3]! & (1 << (i & 7))) === 0) continue;
      const v = values[i]!;
      if (Number.isFinite(v) && (lo === undefined || v < lo)) lo = v;
    }
    return lo;
  },
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
