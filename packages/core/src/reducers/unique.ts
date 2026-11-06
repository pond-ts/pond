import type { ColumnValue, ScalarValue } from '../schema/index.js';
import type { ReducerDef } from './types.js';
import {
  SORT_RANGE_MAX,
  dictStrings,
  packedNumbers,
  reduceCellsByRead,
  sortedFinite,
} from './cells.js';

/**
 * Sort scalar values into a stable, deterministic order:
 *   numbers < strings < booleans,
 * within each bucket use the language's default comparison.
 *
 * Having a stable sort makes bucket-to-bucket comparisons and test
 * expectations predictable even when the input order varies.
 */
function compareScalars(a: ScalarValue, b: ScalarValue): number {
  const ta = typeof a;
  const tb = typeof b;
  if (ta !== tb) {
    const rank = (t: string): number =>
      t === 'number' ? 0 : t === 'string' ? 1 : 2;
    return rank(ta) - rank(tb);
  }
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function isScalar(v: ColumnValue | undefined): v is ScalarValue {
  return (
    typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean'
  );
}

/** Push each scalar from `v` into `set`; flattens a single level of array. */
function collectInto(set: Set<ScalarValue>, v: ColumnValue | undefined): void {
  if (v === undefined) return;
  if (isScalar(v)) {
    set.add(v);
    return;
  }
  for (const element of v) {
    if (isScalar(element)) set.add(element);
  }
}

function incrementCounts(
  counts: Map<ScalarValue, number>,
  v: ColumnValue | undefined,
): void {
  if (v === undefined) return;
  if (isScalar(v)) {
    counts.set(v, (counts.get(v) ?? 0) + 1);
    return;
  }
  for (const element of v) {
    if (isScalar(element)) {
      counts.set(element, (counts.get(element) ?? 0) + 1);
    }
  }
}

function decrementCounts(
  counts: Map<ScalarValue, number>,
  v: ColumnValue | undefined,
): void {
  if (v === undefined) return;
  if (isScalar(v)) {
    const next = (counts.get(v) ?? 0) - 1;
    if (next <= 0) counts.delete(v);
    else counts.set(v, next);
    return;
  }
  for (const element of v) {
    if (!isScalar(element)) continue;
    const next = (counts.get(element) ?? 0) - 1;
    if (next <= 0) counts.delete(element);
    else counts.set(element, next);
  }
}

function snapshotSet(set: Set<ScalarValue>): ScalarValue[] {
  const out = Array.from(set);
  out.sort(compareScalars);
  return out;
}

/**
 * Distinct non-undefined scalar values from a bucket, returned as a sorted
 * array. Array-kind inputs are _flattened_ one level: a bucket of
 * `[['a','b'], ['b','c']]` produces `['a','b','c']`. This makes "what
 * distinct tags showed up this minute?" work naturally when the source is
 * already a tag-list array column.
 */
export const unique: ReducerDef = {
  outputKind: 'array',
  reduce(defined) {
    const set = new Set<ScalarValue>();
    for (const v of defined) collectInto(set, v);
    return snapshotSet(set);
  },
  reduceCellRange(col, start, end) {
    const values = packedNumbers(col);
    if (values !== null && end - start <= SORT_RANGE_MAX) {
      // Sort, then keep one of each run of equal values (`0` for a run of
      // signed zeros, as a `Set` stores it).
      const sorted = sortedFinite(values, start, end);
      const out: number[] = [];
      for (let k = 0; k < sorted.length; k += 1) {
        const v = sorted[k]!;
        if (k === 0 || v !== sorted[k - 1]) out.push(v === 0 ? 0 : v);
      }
      return out;
    }
    if (values !== null) {
      const set = new Set<ScalarValue>();
      for (let i = start; i < end; i += 1) {
        const v = values[i]!;
        if (v - v === 0) set.add(v);
      }
      // Distinct finite numbers: a typed sort gives `compareScalars`'
      // order (ascending; a `Set` already folded `-0` into `0`).
      return Array.from(Float64Array.from(set as Set<number>).sort());
    }
    const strings = dictStrings(col);
    if (strings !== null) {
      // Each distinct code once, then its string (a dictionary may hold one
      // string under two codes; the set merges them).
      const dict = strings.dictionary!;
      const codes = strings.indices!;
      const validity = strings.validity;
      const seen = new Set<number>();
      const set = new Set<ScalarValue>();
      for (let i = start; i < end; i += 1) {
        if (validity !== undefined && !validity.isDefined(i)) continue;
        const code = codes[i]!;
        if (seen.has(code)) continue;
        seen.add(code);
        set.add(dict[code]!);
      }
      // Distinct strings: the default sort compares UTF-16 code units, as
      // `compareScalars`' `<` does.
      return Array.from(set).sort();
    }
    return reduceCellsByRead(unique.reduce, col, start, end);
  },
  bucketState() {
    const set = new Set<ScalarValue>();
    return {
      add(v) {
        collectInto(set, v);
      },
      snapshot() {
        return snapshotSet(set);
      },
    };
  },
  rollingState() {
    const counts = new Map<ScalarValue, number>();
    return {
      add(_i, v) {
        incrementCounts(counts, v);
      },
      remove(_i, v) {
        decrementCounts(counts, v);
      },
      snapshot() {
        const out = Array.from(counts.keys());
        out.sort(compareScalars);
        return out;
      },
    };
  },
};
