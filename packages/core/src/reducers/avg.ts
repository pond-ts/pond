import type { ReducerDef } from './types.js';

export const avg: ReducerDef = {
  outputKind: 'number',
  reduce(_d, numeric) {
    return numeric.length === 0
      ? undefined
      : numeric.reduce((s, v) => s + v, 0) / numeric.length;
  },
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
        for (let i = 0; i < col.length; i += 1) s += values[i]!;
        return col.length === 0 ? undefined : s / col.length;
      }
      const bits = validity.bits;
      for (let i = 0; i < col.length; i += 1) {
        if ((bits[i >> 3]! & (1 << (i & 7))) !== 0) s += values[i]!;
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
