import type { ColumnValue, ScalarValue } from '../schema/index.js';
import type { ReducerDef } from './types.js';
import { dictStrings, packedNumbers, reduceCellsByRead } from './cells.js';

function isScalar(v: ColumnValue | undefined): v is ScalarValue {
  return (
    typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean'
  );
}

/** Push each scalar from `v` into `out`; flattens a single level of array. */
function collectInto(out: ScalarValue[], v: ColumnValue | undefined): void {
  if (v === undefined) return;
  if (isScalar(v)) {
    out.push(v);
    return;
  }
  for (const element of v) {
    if (isScalar(element)) out.push(element);
  }
}

/**
 * All defined scalar values from a bucket, returned as an array in
 * arrival order (duplicates preserved). Array-kind inputs are
 * flattened one level: a bucket of `[['a','b'], ['b','c']]` produces
 * `['a','b','b','c']`. This makes "give me every value the rolling
 * window has seen" work naturally on either scalar or tag-list
 * columns.
 *
 * Sits beside `unique` (which deduplicates) and `top${N}` (which
 * bounds and frequency-orders). Reach for `samples` when you need
 * the full value list, with duplicates and arrival order preserved
 * — typically because a downstream computation needs the raw
 * values (anomaly density against a baseline, custom thresholding,
 * histogramming).
 *
 * **Use on bounded windows.** Memory is O(window size); per-event
 * cost is O(1) `add` and O(1) `remove` (Map-keyed by event index);
 * `snapshot` is O(N) for the array copy.
 */
export const samples: ReducerDef = {
  outputKind: 'array',
  reduce(defined) {
    const out: ScalarValue[] = [];
    for (const v of defined) collectInto(out, v);
    return out;
  },
  reduceCellRange(col, start, end) {
    const values = packedNumbers(col);
    if (values !== null) {
      const out: ScalarValue[] = [];
      for (let i = start; i < end; i += 1) {
        const v = values[i]!;
        if (v - v === 0) out.push(v);
      }
      return out;
    }
    const strings = dictStrings(col);
    if (strings !== null) {
      const dict = strings.dictionary!;
      const codes = strings.indices!;
      const validity = strings.validity;
      const out: ScalarValue[] = [];
      for (let i = start; i < end; i += 1) {
        if (validity !== undefined && !validity.isDefined(i)) continue;
        out.push(dict[codes[i]!]!);
      }
      return out;
    }
    return reduceCellsByRead(samples.reduce, col, start, end);
  },
  bucketState() {
    const items: ScalarValue[] = [];
    return {
      add(v) {
        collectInto(items, v);
      },
      snapshot() {
        return items.slice();
      },
    };
  },
  rollingState() {
    // Map keyed by event index so `remove` is O(1). `Array.from(map.values())`
    // returns insertion order, which matches arrival order.
    //
    // Stored value is `ScalarValue | ScalarValue[]`: scalar source columns
    // (the common case at kHz × N-partition load) skip wrapping each event
    // in a 1-element array, dropping one allocation per `add`. Only
    // array-kind sources need a sub-array (so a single event's contributions
    // can be dropped together on `remove(index)`).
    const items = new Map<number, ScalarValue | ScalarValue[]>();
    return {
      add(index, v) {
        if (v === undefined) return;
        if (isScalar(v)) {
          items.set(index, v);
          return;
        }
        // Array-kind source: flatten one level, store the sub-array so
        // remove(index) drops every contribution from this event.
        const collected: ScalarValue[] = [];
        for (const element of v) {
          if (isScalar(element)) collected.push(element);
        }
        if (collected.length > 0) items.set(index, collected);
      },
      remove(index, _v) {
        items.delete(index);
      },
      snapshot() {
        const out: ScalarValue[] = [];
        for (const v of items.values()) {
          if (Array.isArray(v)) {
            for (const x of v) out.push(x);
          } else {
            out.push(v);
          }
        }
        return out;
      },
    };
  },
};
