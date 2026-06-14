import type { ColumnValue } from '../schema/index.js';
import type { ReducerDef } from './types.js';
import { rollingOrderedEntries } from './rolling.js';

export const first: ReducerDef = {
  outputKind: 'source',
  definedBoundary: 'first',
  reduce(defined) {
    return defined[0];
  },
  bucketState() {
    let val: ColumnValue | undefined;
    return {
      add(v) {
        if (val === undefined && v !== undefined) val = v;
      },
      snapshot() {
        return val;
      },
    };
  },
  rollingState() {
    return rollingOrderedEntries((entries, head) => entries[head]?.value);
  },
};
