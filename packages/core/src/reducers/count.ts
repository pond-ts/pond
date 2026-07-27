import type { Float64Column } from '../columnar/index.js';
import type { ReducerDef } from './types.js';

/**
 * Counts the defined (and, on the guarded path, finite) cells of
 * `col[start, end)`.
 *
 * **Deliberately not shared with `reduceColumn`.** The whole-column form
 * answers the bitmap case in O(1) from `validity.definedCount`, which is
 * cached at bitmap construction. A sub-range has no such cache and must
 * popcount via `countInRange` — still far cheaper than materialising a
 * slice (whose `PackedValidityBitmap` constructor popcounts *and* copies
 * the bits), but genuinely a different algorithm. Collapsing the two
 * would have turned `Float64Column.count()` from O(1) into O(n/8).
 */
function countRange(col: Float64Column, start: number, end: number): number {
  const values = col._values;
  const validity = col.validity;
  // Fast path: every defined cell is finite, so "defined" and "defined
  // AND finite" coincide and the popcount is exact.
  if (col.allFinite) {
    return validity === undefined
      ? end - start
      : validity.countInRange(start, end);
  }
  // Guarded path: walk — the non-finite policy excludes non-finite cells,
  // which a popcount would count as present.
  let n = 0;
  if (validity === undefined) {
    for (let i = start; i < end; i += 1) {
      if (Number.isFinite(values[i]!)) n += 1;
    }
    return n;
  }
  const bits = validity.bits;
  for (let i = start; i < end; i += 1) {
    if ((bits[i >> 3]! & (1 << (i & 7))) !== 0 && Number.isFinite(values[i]!)) {
      n += 1;
    }
  }
  return n;
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
    const values = col._values;
    const validity = col.validity;
    // Fast path: every defined cell is finite (`Float64Column.allFinite`),
    // so "defined" and "defined AND finite" coincide — the O(1) shortcut
    // is exact again (`definedCount`, or `col.length` when no bitmap).
    // This is the O(N)→O(1) recovery the non-finite policy cost count
    // (docs/notes/reducer-nan-policy.md).
    if (col.allFinite) {
      return validity === undefined ? col.length : validity.definedCount;
    }
    // Guarded path: O(N) scan, NOT the `definedCount` shortcut — the
    // non-finite policy excludes non-finite cells, and `definedCount`
    // counts them as present, so a defined-but-NaN cell would over-count.
    // Walk and count valid AND finite cells.
    let n = 0;
    if (validity === undefined) {
      for (let i = 0; i < col.length; i += 1) {
        if (Number.isFinite(values[i]!)) n += 1;
      }
      return n;
    }
    const bits = validity.bits;
    for (let i = 0; i < col.length; i += 1) {
      if (
        (bits[i >> 3]! & (1 << (i & 7))) !== 0 &&
        Number.isFinite(values[i]!)
      ) {
        n += 1;
      }
    }
    return n;
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
