import type { Float64Column } from '../columnar/index.js';
import { countFinite } from './blocked.js';
import type { ReducerDef } from './types.js';

/**
 * Counts the defined cells of `col[start, end)`. A missing cell is a
 * non-finite value in the buffer ([PND-NANREP]).
 *
 * **Deliberately not shared with `reduceColumn`.** The whole-column form
 * answers from the column's cached `missingCount` (one scan on first ask,
 * O(1) after); a sub-range has no such cache and must walk.
 */
function countRange(col: Float64Column, start: number, end: number): number {
  if (col.allFinite) return end - start;
  return countFinite(col._values, start, end);
}

/**
 * Counts non-null values for the source column.
 *
 * **Duplicates do not collapse.** When multiple events share the
 * same temporal key (e.g. `hostCount` events pushed under one
 * `new Date()` per tick), each contributes independently to the
 * count — `count` walks the input values, not unique keys.
 * `host: 'count'` over four same-ts events with `host` defined
 * returns `4`, not `1`.
 *
 * Behavior is consistent across batch (`reduce`, `aggregate`),
 * rolling (`rolling`), and live (`LiveAggregation`,
 * `LiveRollingAggregation`) — all walk the per-column value array
 * after `aggregateValues` filters undefined cells.
 *
 * To count events regardless of column nullability, target a
 * required column (the partition column or the time-key sibling
 * is conventional). For a "rows in this window" semantic, any
 * required value column produces the same result.
 */
export const count: ReducerDef = {
  outputKind: 'number',
  reduce(defined) {
    return defined.length;
  },
  reduceColumnRange: countRange,
  reduceColumn(col) {
    // `missingCount` is cached on the column (and `0` without a scan when
    // `allFinite`), so repeated counts of one column are O(1).
    return col.length - col.missingCount;
  },
  bucketState() {
    let n = 0;
    return {
      add(v) {
        if (v !== undefined) n++;
      },
      snapshot() {
        return n;
      },
    };
  },
  rollingState() {
    let n = 0;
    return {
      add(_i, v) {
        if (v !== undefined) n++;
      },
      remove(_i, v) {
        if (v !== undefined) n--;
      },
      snapshot() {
        return n;
      },
    };
  },
};
