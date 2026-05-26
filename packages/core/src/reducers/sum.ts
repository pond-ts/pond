import type { ReducerDef } from './types.js';

export const sum: ReducerDef = {
  outputKind: 'number',
  reduce(_d, numeric) {
    return numeric.reduce((s, v) => s + v, 0);
  },
  reduceColumn(col) {
    const values = col.values;
    const validity = col.validity;
    let s = 0;
    if (validity === undefined) {
      // Hot path: every cell defined; no per-row branch.
      for (let i = 0; i < col.length; i += 1) s += values[i]!;
      return s;
    }
    // Inline bitmap check rather than method dispatch — same pattern
    // the chart-friction-spike notes flagged for hot draw loops.
    const bits = validity.bits;
    for (let i = 0; i < col.length; i += 1) {
      if ((bits[i >> 3]! & (1 << (i & 7))) !== 0) s += values[i]!;
    }
    return s;
  },
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
