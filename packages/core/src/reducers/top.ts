import type { ColumnValue, ScalarValue } from '../schema/index.js';
import type { ReducerDef } from './types.js';
import {
  SORT_RANGE_MAX,
  dictStrings,
  packedNumbers,
  reduceCellsByRead,
  sortedFinite,
} from './cells.js';

const TOP_RE = /^top(\d+)$/;

/**
 * Parse a `'topN'` reducer name (e.g. `'top3'`) into its integer N.
 * Returns `undefined` if the string isn't a valid top-N name. Used by the
 * reducer registry to dispatch parameterized reducer names.
 */
export function parseTopN(name: string): number | undefined {
  const match = TOP_RE.exec(name);
  if (!match) return undefined;
  const n = Number(match[1]);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

/**
 * Deterministic scalar ordering used to break ties when multiple values
 * share a frequency count. Numbers before strings before booleans; within
 * a kind, JS default comparison.
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

/**
 * Materialize the top N values from a frequency map.
 * Order: frequency descending, ties broken by `compareScalars`.
 */
function topFromCounts(
  counts: Map<ScalarValue, number>,
  n: number,
): ScalarValue[] {
  return topFromEntries(Array.from(counts.entries()), n);
}

/** {@link topFromCounts} over `[value, count]` pairs with distinct values. */
function topFromEntries(
  entries: Array<[ScalarValue, number]>,
  n: number,
): ScalarValue[] {
  entries.sort((a, b) => {
    if (a[1] !== b[1]) return b[1] - a[1];
    return compareScalars(a[0], b[0]);
  });
  const out: ScalarValue[] = [];
  const limit = Math.min(n, entries.length);
  for (let i = 0; i < limit; i += 1) out.push(entries[i]![0]);
  return out;
}

/**
 * Factory: returns a `ReducerDef` that emits the top N values by
 * frequency, sorted by count descending with deterministic tie-break.
 * Used internally by `resolveReducer` when parsing a `'topN'` string name.
 *
 * Array-kind inputs are flattened one level so "top tags this minute"
 * works when the source column is a tag-list array — elements are counted
 * across all arrays in the bucket.
 */
export function topReducer(n: number): ReducerDef {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError(`top requires a positive integer N, got ${n}`);
  }
  const reduce = (defined: ReadonlyArray<ColumnValue>): ScalarValue[] => {
    const counts = new Map<ScalarValue, number>();
    for (const v of defined) incrementCounts(counts, v);
    return topFromCounts(counts, n);
  };
  return {
    outputKind: 'array',
    reduce,
    reduceCellRange(col, start, end) {
      const values = packedNumbers(col);
      if (values !== null && end - start <= SORT_RANGE_MAX) {
        // Small range: sort, and count each run of equal values (`0` for a
        // run of signed zeros, as a `Map` key stores it).
        const sorted = sortedFinite(values, start, end);
        const entries: Array<[ScalarValue, number]> = [];
        for (let k = 0; k < sorted.length; ) {
          const v = sorted[k]!;
          let j = k + 1;
          while (j < sorted.length && sorted[j] === v) j += 1;
          entries.push([v === 0 ? 0 : v, j - k]);
          k = j;
        }
        return topFromEntries(entries, n);
      }
      if (values !== null) {
        // A run of equal values is one map update. Runs merge across
        // missing cells; `-0` and `0` are one key either way (a `Map`
        // treats them as equal), so the counts are `reduce`'s exactly.
        const counts = new Map<ScalarValue, number>();
        let run = 0;
        let current = 0;
        for (let i = start; i < end; i += 1) {
          const v = values[i]!;
          if (v - v !== 0) continue;
          if (run > 0 && v === current) {
            run += 1;
            continue;
          }
          if (run > 0) counts.set(current, (counts.get(current) ?? 0) + run);
          current = v;
          run = 1;
        }
        if (run > 0) counts.set(current, (counts.get(current) ?? 0) + run);
        return topFromCounts(counts, n);
      }
      const strings = dictStrings(col);
      if (strings !== null) {
        // Count codes, then add each code's count under its string (a
        // dictionary may hold one string under two codes).
        const dict = strings.dictionary!;
        const codes = strings.indices!;
        const validity = strings.validity;
        const byCode = new Map<number, number>();
        for (let i = start; i < end; i += 1) {
          if (validity !== undefined && !validity.isDefined(i)) continue;
          const code = codes[i]!;
          byCode.set(code, (byCode.get(code) ?? 0) + 1);
        }
        const counts = new Map<ScalarValue, number>();
        for (const [code, c] of byCode) {
          const s = dict[code]!;
          counts.set(s, (counts.get(s) ?? 0) + c);
        }
        return topFromCounts(counts, n);
      }
      return reduceCellsByRead(reduce, col, start, end);
    },
    bucketState() {
      const counts = new Map<ScalarValue, number>();
      return {
        add(v) {
          incrementCounts(counts, v);
        },
        snapshot() {
          return topFromCounts(counts, n);
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
          return topFromCounts(counts, n);
        },
      };
    },
  };
}

/**
 * Ergonomic helper: `top(3)` returns the literal `'top3'` typed as
 * `` `top${3}` ``. Use wherever an `AggregateReducer` name is accepted:
 *
 * ```ts
 * series.aggregate(Sequence.every('1m'), { host: top(3) });
 * series.arrayAggregate('tags', top(5));
 * ```
 *
 * Equivalent to typing the string literal `'top3'` directly.
 */
export function top<N extends number>(n: N): `top${N}` {
  return `top${n}` as `top${N}`;
}
