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
    // **NaN parity with row API.** Mirror the row-API expression
    //   numeric.reduce((a, b) => a >= b ? a : b)
    // exactly. See `min.ts` for the full rationale. Closed Codex
    // review finding on PR #153.
    const values = col.values;
    const validity = col.validity;
    let hi: number | undefined;
    if (validity === undefined) {
      if (col.length === 0) return undefined;
      hi = values[0]!;
      for (let i = 1; i < col.length; i += 1) {
        const v = values[i]!;
        hi = hi >= v ? hi : v;
      }
      return hi;
    }
    const bits = validity.bits;
    for (let i = 0; i < col.length; i += 1) {
      if ((bits[i >> 3]! & (1 << (i & 7))) === 0) continue;
      const v = values[i]!;
      hi = hi === undefined ? v : hi >= v ? hi : v;
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
