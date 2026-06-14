import type { ColumnValue } from '../schema/index.js';
import type { ReducerDef } from './types.js';
import { rollingOrderedEntries } from './rolling.js';

export const last: ReducerDef = {
  outputKind: 'source',
  definedBoundary: 'last',
  reduce(defined) {
    return defined[defined.length - 1];
  },
  bucketState() {
    let val: ColumnValue | undefined;
    return {
      add(v) {
        if (v !== undefined) val = v;
      },
      snapshot() {
        return val;
      },
    };
  },
  rollingState() {
    return rollingOrderedEntries(
      (entries) => entries[entries.length - 1]?.value,
    );
  },
};
