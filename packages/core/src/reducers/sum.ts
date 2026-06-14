import type { ReducerDef } from './types.js';

export const sum: ReducerDef = {
  outputKind: 'number',
  reduce(_d, numeric) {
    return numeric.reduce((s, v) => s + v, 0);
  },
  reduceColumn(col) {
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
        for (let i = 0; i < col.length; i += 1) s += values[i]!;
        return s;
      }
      const bits = validity.bits;
      for (let i = 0; i < col.length; i += 1) {
        if ((bits[i >> 3]! & (1 << (i & 7))) !== 0) s += values[i]!;
      }
      return s;
    }
    // Guarded path: finiteness not proven, skip non-finite per policy.
    if (validity === undefined) {
      for (let i = 0; i < col.length; i += 1) {
        const v = values[i]!;
        if (Number.isFinite(v)) s += v;
      }
      return s;
    }
    // Inline bitmap check rather than method dispatch — same pattern
    // the chart-friction-spike notes flagged for hot draw loops.
    const bits = validity.bits;
    for (let i = 0; i < col.length; i += 1) {
      if ((bits[i >> 3]! & (1 << (i & 7))) !== 0) {
        const v = values[i]!;
        if (Number.isFinite(v)) s += v;
      }
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
