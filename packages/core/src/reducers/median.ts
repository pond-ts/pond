import type { ReducerDef } from './types.js';
import { rollingSortedArray } from './rolling.js';
import { percentileOfSorted, reducePercentileColumn } from './percentile.js';

export const median: ReducerDef = {
  outputKind: 'number',
  reduce(_d, numeric) {
    if (numeric.length === 0) return undefined;
    const sorted = numeric.slice().sort((a, b) => a - b);
    return percentileOfSorted(sorted, 50);
  },
  reduceColumn(col) {
    return reducePercentileColumn(col, 50);
  },
  bucketState() {
    const collected: number[] = [];
    return {
      add(v) {
        if (typeof v === 'number') collected.push(v);
      },
      snapshot() {
        if (collected.length === 0) return undefined;
        const sorted = collected.slice().sort((a, b) => a - b);
        return percentileOfSorted(sorted, 50);
      },
    };
  },
  rollingState() {
    const arr = rollingSortedArray();
    return {
      add: arr.add,
      remove: arr.remove,
      snapshot() {
        return arr.sorted.length === 0
          ? undefined
          : percentileOfSorted(arr.sorted, 50);
      },
    };
  },
};
