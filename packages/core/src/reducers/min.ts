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
    // **NaN parity with row API.** The row-API path uses
    //   numeric.reduce((a, b) => a <= b ? a : b)
    // which has surprising NaN behavior: on `[1, NaN, 2]` it returns
    // `2` because the first `1 <= NaN` is false (returning NaN),
    // then `NaN <= 2` is also false (returning 2). The "natural"
    // column-side loop `if (v < lo) lo = v` would instead return
    // `1` (NaN comparisons always false → NaN is skipped). The two
    // paths diverge on NaN-bearing input.
    //
    // We mirror the row-API comparison expression exactly to
    // preserve the parity claim, even though both paths exhibit
    // surprising results on NaN (which can only reach a `kind:
    // 'number'` column via trusted construction — `assertCellKind`
    // rejects it at public intake). Closed Codex review finding on
    // PR #153. A principled "filter NaN consistently across both
    // paths" fix is a separate concern tracked in the followup
    // issue.
    const values = col.values;
    const validity = col.validity;
    let lo: number | undefined;
    if (validity === undefined) {
      if (col.length === 0) return undefined;
      lo = values[0]!;
      for (let i = 1; i < col.length; i += 1) {
        const v = values[i]!;
        lo = lo <= v ? lo : v;
      }
      return lo;
    }
    const bits = validity.bits;
    for (let i = 0; i < col.length; i += 1) {
      if ((bits[i >> 3]! & (1 << (i & 7))) === 0) continue;
      const v = values[i]!;
      lo = lo === undefined ? v : lo <= v ? lo : v;
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
