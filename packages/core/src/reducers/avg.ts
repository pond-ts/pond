import type { ReducerDef } from './types.js';

export const avg: ReducerDef = {
  outputKind: 'number',
  reduce(_d, numeric) {
    return numeric.length === 0
      ? undefined
      : numeric.reduce((s, v) => s + v, 0) / numeric.length;
  },
  reduceColumn(col) {
    const values = col.values;
    const validity = col.validity;
    if (validity === undefined) {
      if (col.length === 0) return undefined;
      let s = 0;
      for (let i = 0; i < col.length; i += 1) s += values[i]!;
      return s / col.length;
    }
    const definedCount = validity.definedCount;
    if (definedCount === 0) return undefined;
    const bits = validity.bits;
    let s = 0;
    for (let i = 0; i < col.length; i += 1) {
      if ((bits[i >> 3]! & (1 << (i & 7))) !== 0) s += values[i]!;
    }
    return s / definedCount;
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
