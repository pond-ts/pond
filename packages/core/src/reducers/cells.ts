import type { Column, Float64Column, StringColumn } from '../columnar/index.js';
import type { ColumnValue } from '../schema/index.js';
import type { ReducerDef } from './types.js';

/**
 * Shared pieces for `ReducerDef.reduceCellRange` — the range kernels of the
 * reducers that have no numeric column kernel (`keep`, `difference`,
 * `unique`, `top${N}`, `samples`).
 */

/** The typed buffer of a packed number column, else `null`. */
export function packedNumbers(col: Column): Float64Array | null {
  return col.kind === 'number' && col.storage === 'packed'
    ? (col as Float64Column)._values
    : null;
}

/** A dictionary-encoded packed string column, else `null`. */
export function dictStrings(col: Column): StringColumn | null {
  return col.kind === 'string' &&
    col.storage === 'packed' &&
    (col as StringColumn).dictionary !== undefined
    ? (col as StringColumn)
    : null;
}

/**
 * The general case: read the cells, drop missing and non-finite ones the
 * way `aggregateValues` does, and call `reduce` — so a kernel's fallback is
 * the row path's answer by construction.
 */
export function reduceCellsByRead(
  reduce: ReducerDef['reduce'],
  col: Column,
  start: number,
  end: number,
): ColumnValue | undefined {
  const defined: ColumnValue[] = [];
  const numeric: number[] = [];
  for (let i = start; i < end; i += 1) {
    const v = col.read(i) as ColumnValue | undefined;
    if (v === undefined) continue;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) continue;
      numeric.push(v);
    }
    defined.push(v);
  }
  return reduce(defined, numeric);
}

/**
 * Ranges up to this many cells are reduced by sorting a copy of their
 * finite values instead of hashing them: per call, a `Set` / `Map` costs
 * more than a typed sort of a small range (60-row buckets: 4x faster).
 * Bigger ranges keep the hash, which wins when values repeat a lot.
 */
export const SORT_RANGE_MAX = 4096;

let scratch = new Float64Array(SORT_RANGE_MAX);

/**
 * The finite values of `values[start, end)`, sorted ascending, in a shared
 * scratch buffer (valid until the next call). `-0` sorts before `0`; they
 * compare equal (`===`), so callers treating equal neighbours as one value
 * must write `0` for both, as a `Set` / `Map` key would.
 */
export function sortedFinite(
  values: Float64Array,
  start: number,
  end: number,
): Float64Array {
  if (scratch.length < end - start) scratch = new Float64Array(end - start);
  let n = 0;
  for (let i = start; i < end; i += 1) {
    const v = values[i]!;
    if (v - v === 0) scratch[n++] = v;
  }
  return scratch.subarray(0, n).sort();
}
