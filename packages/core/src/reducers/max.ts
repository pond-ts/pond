import type { ReducerDef } from './types.js';
import { rollingMonotoneDeque } from './rolling.js';

export const max: ReducerDef = {
  outputKind: 'number',
  reduce(_d, numeric) {
    return numeric.length === 0
      ? undefined
      : numeric.reduce((a, b) => (a >= b ? a : b));
  },
  reduceColumn(col) {
    const values = col._values;
    const validity = col.validity;
    let hi: number | undefined;
    // Fast path: every defined cell is finite (`Float64Column.allFinite`),
    // so we seed `hi` from the first defined cell and run a plain `v > hi`
    // compare with NO per-element `Number.isFinite` guard and NO in-loop
    // `hi === undefined` check (the seed hoists it out). No NaN to mishandle,
    // also sidesteps the position-dependent `a>=b?a:b` extremum bug the policy
    // fixed (docs/notes/reducer-nan-policy.md). The pre-policy column loop,
    // recovered.
    if (col.allFinite) {
      const len = col.length;
      if (len === 0) return undefined;
      if (validity === undefined) {
        hi = values[0]!;
        for (let i = 1; i < len; i += 1) {
          const v = values[i]!;
          if (v > hi) hi = v;
        }
        return hi;
      }
      const bits = validity.bits;
      for (let i = 0; i < len; i += 1) {
        if ((bits[i >> 3]! & (1 << (i & 7))) === 0) continue;
        const v = values[i]!;
        if (hi === undefined || v > hi) hi = v;
      }
      return hi;
    }
    // Guarded path: skip non-finite cells (reducer non-finite policy) —
    // matches `bucketState`'s `v > hi`.
    if (validity === undefined) {
      for (let i = 0; i < col.length; i += 1) {
        const v = values[i]!;
        if (Number.isFinite(v) && (hi === undefined || v > hi)) hi = v;
      }
      return hi;
    }
    const bits = validity.bits;
    for (let i = 0; i < col.length; i += 1) {
      if ((bits[i >> 3]! & (1 << (i & 7))) === 0) continue;
      const v = values[i]!;
      if (Number.isFinite(v) && (hi === undefined || v > hi)) hi = v;
    }
    return hi;
  },
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
