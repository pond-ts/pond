/**
 * `concatSorted` — zero-copy concat of N temporally-disjoint stores.
 *
 * Each input store contributes its value-column buffers as **chunks**
 * of the output's value columns. The key column is **materialized**
 * (one flat begin/end buffer for the output) — keys are tiny
 * relative to value columns and materializing them keeps the
 * `keyAt(i)` accessor uniform regardless of how many inputs were
 * concatenated.
 *
 * **Inputs must be temporally disjoint.** For `time` keys: every
 * input's last begin must precede the next input's first begin
 * (strict, because Time has zero duration — coincident timestamps
 * across stores would corrupt ordering). For `timeRange` and
 * `interval` keys: every input's last end must be `<=` the next
 * input's first begin (boundary-touch is OK on half-open
 * intervals).
 *
 * **Sortedness within each input is trusted.** The framework's
 * `TimeKeyColumn` / `TimeRangeKeyColumn` / `IntervalKeyColumn`
 * constructors don't validate intra-store ordering; the row-API
 * adapter enforces it at intake. `concatSorted` mirrors that
 * boundary — it checks cross-store disjointness only.
 *
 * **Schema compatibility.** All inputs must declare the same schema
 * (structural equality on name + kind, in the same order). The
 * output's `schema` reference is the first input's.
 *
 * **N = 0** throws (no schema to infer). **N = 1** returns the input
 * as-is. **N ≥ 2** builds the chunked output described above.
 *
 * **Flattening nested chunks.** When an input already has a chunked
 * value column (e.g., it was the output of a prior `concatSorted`),
 * its inner chunks are pulled out and concatenated into the output's
 * chunk list. The chunked-column data structure stays one level
 * deep — chunks are always plain.
 *
 * Framework-internal; not exported from `packages/core/src/index.ts`.
 */

import { ArrayColumn } from './array-column.js';
import {
  ChunkedArrayColumn,
  ChunkedBooleanColumn,
  ChunkedFloat64Column,
  ChunkedStringColumn,
} from './chunked-column.js';
import { BooleanColumn, Float64Column, type Column } from './column.js';
import {
  IntervalKeyColumn,
  TimeKeyColumn,
  TimeRangeKeyColumn,
  type KeyColumn,
} from './key-column.js';
import { StringColumn, stringColumnFromArray } from './string-column.js';
import { ColumnarStore } from './store.js';
import type { ColumnSchema } from './types.js';
import { validateColumnLength } from './validity.js';

/**
 * Concatenates an ordered list of temporally-disjoint stores into a
 * single logical store whose value columns are zero-copy chunked.
 */
export function concatSorted<S extends ColumnSchema>(
  stores: ReadonlyArray<ColumnarStore<S>>,
): ColumnarStore<S> {
  if (stores.length === 0) {
    throw new RangeError(
      'concatSorted: requires at least one input store (output schema is unknowable from empty input)',
    );
  }
  if (stores.length === 1) {
    return stores[0]!;
  }
  validateSchemaCompat(stores);
  validateDisjointKeys(stores);
  const baseSchema = stores[0]!.schema;
  const totalLength = computeTotalLength(stores);
  const keys = concatKeyColumns(stores, totalLength);
  const newColumns = new Map<string, Column>();
  for (let c = 1; c < baseSchema.length; c += 1) {
    const def = baseSchema[c]!;
    const name = def.name;
    switch (def.kind) {
      case 'number':
        newColumns.set(name, concatNumberColumns(stores, name));
        break;
      case 'boolean':
        newColumns.set(name, concatBooleanColumns(stores, name));
        break;
      case 'string':
        newColumns.set(name, concatStringColumns(stores, name));
        break;
      case 'array':
        newColumns.set(name, concatArrayColumns(stores, name));
        break;
      default:
        throw new TypeError(
          `concatSorted: schema column '${name}' has unsupported kind '${def.kind}'`,
        );
    }
  }
  return ColumnarStore.fromTrustedStore(baseSchema, keys, newColumns);
}

/* -------------------------------------------------------------------------- */
/* Validation helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Validates that every input store has a schema structurally
 * compatible with `stores[0]` — same length, same `(name, kind)`
 * per position. Reference-equal schemas short-circuit (the
 * common case when a producer derives every store from the same
 * literal). Throws `RangeError` on the first mismatch.
 */
function validateSchemaCompat<S extends ColumnSchema>(
  stores: ReadonlyArray<ColumnarStore<S>>,
): void {
  const baseSchema = stores[0]!.schema;
  for (let s = 1; s < stores.length; s += 1) {
    const sSchema = stores[s]!.schema;
    if (sSchema === baseSchema) continue;
    if (sSchema.length !== baseSchema.length) {
      throw new RangeError(
        `concatSorted: store ${s} schema length ${sSchema.length} does not match store 0 schema length ${baseSchema.length}`,
      );
    }
    for (let i = 0; i < baseSchema.length; i += 1) {
      const baseDef = baseSchema[i]!;
      const sDef = sSchema[i]!;
      if (sDef.name !== baseDef.name) {
        throw new RangeError(
          `concatSorted: store ${s} schema[${i}].name '${sDef.name}' does not match store 0 '${baseDef.name}'`,
        );
      }
      if (sDef.kind !== baseDef.kind) {
        throw new RangeError(
          `concatSorted: store ${s} schema[${i}].kind '${sDef.kind}' does not match store 0 '${baseDef.kind}'`,
        );
      }
    }
  }
}

/**
 * Validates that every non-empty input store is temporally
 * disjoint from the previous non-empty store. Empty stores are
 * skipped (they have no keys to compare). Per key kind:
 *
 * - `time` — reject `prev.lastBegin >= next.firstBegin`. Strict
 *   because Time has zero duration; coincident timestamps across
 *   stores would silently collapse the row-API's ordering
 *   invariant.
 * - `timeRange` / `interval` — reject `prev.maxEnd > next.firstBegin`.
 *   Half-open intervals tolerate boundary touch
 *   (`maxEnd === firstBegin` is fine).
 *
 * Uses `maxEnd` (running max across all rows) rather than the
 * last row's end — see `maxEndOfStore` for why.
 */
function validateDisjointKeys<S extends ColumnSchema>(
  stores: ReadonlyArray<ColumnarStore<S>>,
): void {
  const keyKind = stores[0]!.schema[0]!.kind;
  // Skip empty stores in the comparison — they have no keys to compare.
  let prevNonEmpty:
    | { storeIndex: number; lastBegin: number; maxEnd: number }
    | undefined;
  for (let s = 0; s < stores.length; s += 1) {
    const store = stores[s]!;
    if (store.length === 0) continue;
    const firstBegin = store.keys.beginAt(0);
    if (prevNonEmpty !== undefined) {
      let violated = false;
      let detail = '';
      if (keyKind === 'time') {
        // Strict: Time has no duration; coincident timestamps across
        // stores would silently collapse the row-API's ordering
        // invariant. Reject equal as well as inverted.
        if (prevNonEmpty.lastBegin >= firstBegin) {
          violated = true;
          detail = `store ${prevNonEmpty.storeIndex} ends at ${prevNonEmpty.lastBegin}, store ${s} starts at ${firstBegin}`;
        }
      } else {
        // TimeRange / Interval: half-open intervals, boundary-touch
        // (`maxEnd === firstBegin`) is OK. Reject strict overlap.
        //
        // **Why `maxEnd`, not `lastEnd`.** The framework's
        // `TimeRangeKeyColumn` / `IntervalKeyColumn` validate only
        // intra-row `begin <= end` and don't enforce cross-row
        // non-overlap (that's a row-API concern). A valid
        // begin-sorted store like `[[0,100], [10,20]]` has its
        // maximum end at row 0, not the last row — so checking
        // `endAt(length - 1)` would let `[30, ...]` start a next
        // store that overlaps row 0's `[0,100]` interval. We track
        // the running max of `endAt(i)` instead. O(N) per store at
        // concat time, which is dominated by the value-column
        // chunk collection anyway.
        if (prevNonEmpty.maxEnd > firstBegin) {
          violated = true;
          detail = `store ${prevNonEmpty.storeIndex} max end ${prevNonEmpty.maxEnd}, store ${s} starts at ${firstBegin}`;
        }
      }
      if (violated) {
        throw new RangeError(
          `concatSorted: inputs must be temporally disjoint (${detail})`,
        );
      }
    }
    prevNonEmpty = {
      storeIndex: s,
      lastBegin: store.keys.beginAt(store.length - 1),
      maxEnd: maxEndOfStore(store, keyKind),
    };
  }
}

/**
 * Returns the maximum `endAt(i)` across every row in the store.
 * For `time` keys we can short-circuit on the last row (Time has
 * end === begin, and begins are sorted within a store). For
 * `timeRange` / `interval` we scan every row — see the rationale
 * in `validateDisjointKeys`.
 */
function maxEndOfStore<S extends ColumnSchema>(
  store: ColumnarStore<S>,
  keyKind: string,
): number {
  if (store.length === 0) {
    // Caller guards against empty stores reaching this path.
    return -Infinity;
  }
  if (keyKind === 'time') {
    // For Time, end === begin, and begin is sorted; last row carries the max.
    return store.keys.endAt(store.length - 1);
  }
  let maxEnd = store.keys.endAt(0);
  for (let i = 1; i < store.length; i += 1) {
    const e = store.keys.endAt(i);
    if (e > maxEnd) maxEnd = e;
  }
  return maxEnd;
}

/**
 * Sums the lengths of every input store and validates the
 * aggregate against `MAX_COLUMN_LENGTH`. Without this check, two
 * individually valid stores could sum past the cap and trigger an
 * opaque typed-array allocation failure (worst case: OOM) inside
 * `concatKeyColumns` instead of a predictable `RangeError`.
 * Closed Codex round 1's medium finding on PR #148.
 */
function computeTotalLength<S extends ColumnSchema>(
  stores: ReadonlyArray<ColumnarStore<S>>,
): number {
  let total = 0;
  for (let s = 0; s < stores.length; s += 1) {
    total += stores[s]!.length;
  }
  validateColumnLength(total, 'concatSorted aggregate');
  return total;
}

/* -------------------------------------------------------------------------- */
/* Key column concatenation — produces a flat (materialized) key column.      */
/* -------------------------------------------------------------------------- */

/**
 * Materializes the output's key column by concatenating every
 * input store's key buffers. Always produces a flat (linear) key
 * — chunked key columns are deferred for v1.0; materializing
 * keys costs O(N) but keeps the snapshot's `keyAt(i)` accessor
 * uniform regardless of how many inputs were merged.
 *
 * Per key kind:
 * - `time` — concatenates `begin` only.
 * - `timeRange` — concatenates `begin` + `end`.
 * - `interval` — concatenates `begin` + `end` + labels. All
 *   inputs must share the same `labelKind` (rejected otherwise).
 *   String labels gather into a flat array and run through
 *   `stringColumnFromArray` so the dict-vs-fallback heuristic
 *   sees the unified vocabulary; numeric labels concatenate as
 *   a flat `Float64Array`.
 */
function concatKeyColumns<S extends ColumnSchema>(
  stores: ReadonlyArray<ColumnarStore<S>>,
  totalLength: number,
): KeyColumn {
  const firstKeys = stores[0]!.keys;
  if (firstKeys instanceof TimeKeyColumn) {
    const begin = new Float64Array(totalLength);
    let cursor = 0;
    for (let s = 0; s < stores.length; s += 1) {
      const k = stores[s]!.keys as TimeKeyColumn;
      begin.set(k.begin.subarray(0, k.length), cursor);
      cursor += k.length;
    }
    return new TimeKeyColumn(begin, totalLength);
  }
  if (firstKeys instanceof TimeRangeKeyColumn) {
    const begin = new Float64Array(totalLength);
    const end = new Float64Array(totalLength);
    let cursor = 0;
    for (let s = 0; s < stores.length; s += 1) {
      const k = stores[s]!.keys as TimeRangeKeyColumn;
      begin.set(k.begin.subarray(0, k.length), cursor);
      end.set(k.end.subarray(0, k.length), cursor);
      cursor += k.length;
    }
    return new TimeRangeKeyColumn(begin, end, totalLength);
  }
  if (firstKeys instanceof IntervalKeyColumn) {
    const baseLabelKind = firstKeys.labelKind;
    for (let s = 1; s < stores.length; s += 1) {
      const k = stores[s]!.keys as IntervalKeyColumn;
      if (k.labelKind !== baseLabelKind) {
        throw new TypeError(
          `concatSorted: store ${s} has interval labelKind '${k.labelKind}', expected '${baseLabelKind}' (matching store 0)`,
        );
      }
    }
    const begin = new Float64Array(totalLength);
    const end = new Float64Array(totalLength);
    let cursor = 0;
    for (let s = 0; s < stores.length; s += 1) {
      const k = stores[s]!.keys as IntervalKeyColumn;
      begin.set(k.begin.subarray(0, k.length), cursor);
      end.set(k.end.subarray(0, k.length), cursor);
      cursor += k.length;
    }
    let labels: StringColumn | Float64Column;
    if (baseLabelKind === 'string') {
      // Gather all labels into a flat array, let `stringColumnFromArray`
      // pick the encoding (dict vs fallback) for the concatenated whole.
      const gathered = new Array<string | undefined>(totalLength);
      let lc = 0;
      for (let s = 0; s < stores.length; s += 1) {
        const k = stores[s]!.keys as IntervalKeyColumn;
        const labelCol = k.labels as StringColumn;
        for (let j = 0; j < k.length; j += 1) {
          gathered[lc] = labelCol.read(j);
          lc += 1;
        }
      }
      labels = stringColumnFromArray(gathered);
    } else {
      const flat = new Float64Array(totalLength);
      let lc = 0;
      for (let s = 0; s < stores.length; s += 1) {
        const k = stores[s]!.keys as IntervalKeyColumn;
        const labelCol = k.labels as Float64Column;
        flat.set(labelCol.values.subarray(0, k.length), lc);
        lc += k.length;
      }
      labels = new Float64Column(flat, totalLength);
    }
    return new IntervalKeyColumn(begin, end, labels, totalLength);
  }
  // Defensive fallback — exhaustiveness.
  throw new TypeError(
    `concatSorted: unrecognized KeyColumn kind '${(firstKeys as { kind: string }).kind}'`,
  );
}

/* -------------------------------------------------------------------------- */
/* Value column concatenation — produces chunked columns.                     */
/* -------------------------------------------------------------------------- */

/**
 * Collects each input store's value column at `name` into a flat
 * list of plain chunks, then wraps them as a single
 * `ChunkedFloat64Column`. Empty stores contribute nothing
 * (length-0 chunks are skipped). Already-chunked inputs are
 * **flattened** — their inner chunks are pulled out and pushed
 * directly so the output's chunk structure stays one level
 * deep. This keeps row→chunk lookup O(log chunks) regardless of
 * how many `concatSorted` calls compose into the input.
 *
 * The sibling helpers (`concatBooleanColumns`, `concatStringColumns`,
 * `concatArrayColumns`) follow the same pattern — kind-specific
 * functions exist because the chunk types differ; the logic is
 * identical.
 */
function concatNumberColumns<S extends ColumnSchema>(
  stores: ReadonlyArray<ColumnarStore<S>>,
  name: string,
): ChunkedFloat64Column {
  const chunks: Float64Column[] = [];
  for (let s = 0; s < stores.length; s += 1) {
    const col = stores[s]!.columns.get(name)!;
    if (col.length === 0) continue;
    if (col.storage === 'packed') {
      chunks.push(col as Float64Column);
    } else {
      const inner = (col as ChunkedFloat64Column).chunks;
      for (let i = 0; i < inner.length; i += 1) {
        const c = inner[i]!;
        if (c.length > 0) chunks.push(c);
      }
    }
  }
  return new ChunkedFloat64Column(chunks);
}

/** Boolean variant of `concatNumberColumns` — see that helper for the pattern. */
function concatBooleanColumns<S extends ColumnSchema>(
  stores: ReadonlyArray<ColumnarStore<S>>,
  name: string,
): ChunkedBooleanColumn {
  const chunks: BooleanColumn[] = [];
  for (let s = 0; s < stores.length; s += 1) {
    const col = stores[s]!.columns.get(name)!;
    if (col.length === 0) continue;
    if (col.storage === 'packed') {
      chunks.push(col as BooleanColumn);
    } else {
      const inner = (col as ChunkedBooleanColumn).chunks;
      for (let i = 0; i < inner.length; i += 1) {
        const c = inner[i]!;
        if (c.length > 0) chunks.push(c);
      }
    }
  }
  return new ChunkedBooleanColumn(chunks);
}

/** String variant of `concatNumberColumns` — see that helper for the pattern. */
function concatStringColumns<S extends ColumnSchema>(
  stores: ReadonlyArray<ColumnarStore<S>>,
  name: string,
): ChunkedStringColumn {
  const chunks: StringColumn[] = [];
  for (let s = 0; s < stores.length; s += 1) {
    const col = stores[s]!.columns.get(name)!;
    if (col.length === 0) continue;
    if (col.storage === 'packed') {
      chunks.push(col as StringColumn);
    } else {
      const inner = (col as ChunkedStringColumn).chunks;
      for (let i = 0; i < inner.length; i += 1) {
        const c = inner[i]!;
        if (c.length > 0) chunks.push(c);
      }
    }
  }
  return new ChunkedStringColumn(chunks);
}

/** Array variant of `concatNumberColumns` — see that helper for the pattern. */
function concatArrayColumns<S extends ColumnSchema>(
  stores: ReadonlyArray<ColumnarStore<S>>,
  name: string,
): ChunkedArrayColumn {
  const chunks: ArrayColumn[] = [];
  for (let s = 0; s < stores.length; s += 1) {
    const col = stores[s]!.columns.get(name)!;
    if (col.length === 0) continue;
    if (col.storage === 'packed') {
      chunks.push(col as ArrayColumn);
    } else {
      const inner = (col as ChunkedArrayColumn).chunks;
      for (let i = 0; i < inner.length; i += 1) {
        const c = inner[i]!;
        if (c.length > 0) chunks.push(c);
      }
    }
  }
  return new ChunkedArrayColumn(chunks);
}
