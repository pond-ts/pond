import type { ColumnValue } from '../schema/index.js';
import type { ReducerDef } from './types.js';
import { dictStrings, packedNumbers, reduceCellsByRead } from './cells.js';

export const keep: ReducerDef = {
  outputKind: 'source',
  reduce(defined) {
    if (defined.length === 0) return undefined;
    const ref = defined[0]!;
    for (let i = 1; i < defined.length; i++) {
      if (defined[i] !== ref) return undefined;
    }
    return ref;
  },
  reduceCellRange(col, start, end) {
    // Stops at the first value that differs from the first defined one.
    const values = packedNumbers(col);
    if (values !== null) {
      let i = start;
      while (i < end && values[i]! - values[i]! !== 0) i += 1;
      if (i === end) return undefined;
      const ref = values[i]!;
      for (i += 1; i < end; i += 1) {
        const v = values[i]!;
        if (v - v === 0 && v !== ref) return undefined;
      }
      return ref;
    }
    const strings = dictStrings(col);
    if (strings !== null) {
      // Equal codes are equal strings; different codes are compared as
      // strings (a dictionary may hold one string twice).
      const dict = strings.dictionary!;
      const codes = strings.indices!;
      const validity = strings.validity;
      let i = start;
      while (i < end && validity !== undefined && !validity.isDefined(i)) {
        i += 1;
      }
      if (i === end) return undefined;
      const refCode = codes[i]!;
      const ref = dict[refCode]!;
      for (i += 1; i < end; i += 1) {
        if (validity !== undefined && !validity.isDefined(i)) continue;
        const code = codes[i]!;
        if (code !== refCode && dict[code] !== ref) return undefined;
      }
      return ref;
    }
    return reduceCellsByRead(keep.reduce, col, start, end);
  },
  bucketState() {
    let ref: ColumnValue | undefined;
    let hasDefined = false;
    let allSame = true;
    return {
      add(v) {
        if (v === undefined) return;
        if (!hasDefined) {
          ref = v;
          hasDefined = true;
        } else if (v !== ref) allSame = false;
      },
      snapshot() {
        return hasDefined && allSame ? ref : undefined;
      },
    };
  },
  rollingState() {
    const counts = new Map<ColumnValue, number>();
    return {
      add(_i, v) {
        if (v === undefined) return;
        counts.set(v, (counts.get(v) ?? 0) + 1);
      },
      remove(_i, v) {
        if (v === undefined) return;
        const c = counts.get(v)! - 1;
        if (c === 0) counts.delete(v);
        else counts.set(v, c);
      },
      snapshot() {
        return counts.size === 1 ? counts.keys().next().value : undefined;
      },
    };
  },
};
