/**
 * View / derivation primitives for `ColumnarStore<S>`.
 *
 * Five framework-level ops that produce a derived store from an
 * existing one. The shape of each return is a fully-formed
 * `ColumnarStore<S>` — consumers see no difference from a
 * directly-constructed store, only the typed-buffer payloads
 * change.
 *
 * **Materializing semantics.** `withRowSelection` walks the
 * `indices` once per column, building owned typed-array buffers
 * via each column's `sliceByIndices`. `materialize` walks each
 * value column; chunked columns (added at sub-step 1g) compact
 * into their plain counterparts; plain columns pass through
 * unchanged. The shape is "lazy compact at request"; reducers and
 * other hot-path callers explicitly opt in by calling
 * `materialize(view)` before narrowing on `storage === 'packed'`.
 *
 * Schema ops (`withColumnsRenamed`, `withColumnReplaced`,
 * `withColumnAppended`, `withColumnsSelected`) are genuinely
 * zero-copy on the column buffers — they compose a fresh schema
 * and columns `Map` while keeping the same column instances.
 *
 * Framework-internal; not exported from `packages/core/src/index.ts`.
 */

import {
  type ChunkedArrayColumn,
  type ChunkedBooleanColumn,
  type ChunkedFloat64Column,
  type ChunkedStringColumn,
  materializeChunkedArray,
  materializeChunkedBoolean,
  materializeChunkedFloat64,
  materializeChunkedString,
} from './chunked-column.js';
import type { Column } from './column.js';
import {
  IntervalKeyColumn,
  TimeKeyColumn,
  TimeRangeKeyColumn,
  type KeyColumn,
} from './key-column.js';
import { ColumnarStore } from './store.js';
import type { AnyColumnKind, ColumnDef, ColumnSchema } from './types.js';

/**
 * Returns a new `ColumnarStore` whose rows are
 * `source[indices[i]]` for each `i` in `[0, indices.length)`. The
 * keys and every value column are gathered through
 * `sliceByIndices`. Schema is preserved.
 *
 * **Index validation.** Every entry in `indices` must be in the
 * half-open range `[0, source.length)`. Out-of-range indices
 * throw `RangeError` at the call site, before any slicing
 * happens. This is a uniform safety floor across all key kinds
 * — Time keys would otherwise silently produce `Time(0)` epoch
 * rows for bad indices, and a downstream `withColumnsSelected([])`
 * would erase the value-column validity that might have flagged
 * the bug.
 *
 * Cost: O(K) validate + O(K) gather per column where K is
 * `indices.length`.
 */
export function withRowSelection<S extends ColumnSchema>(
  source: ColumnarStore<S>,
  indices: Int32Array,
): ColumnarStore<S> {
  // Eager index bounds check. Catches out-of-range indices before
  // they manufacture phantom epoch rows (Time keys silently fill
  // with 0 via `sliceByIndices`; the constructor would then accept
  // them as finite timestamps). Closes the silent-data-corruption
  // path under `withColumnsSelected([])` where no value-column
  // validity could surface the bad index.
  for (let i = 0; i < indices.length; i += 1) {
    const idx = indices[i]!;
    if (idx < 0 || idx >= source.length) {
      throw new RangeError(
        `withRowSelection: indices[${i}] = ${idx} is out of range for source length ${source.length}`,
      );
    }
  }
  const newKeys = sliceKeyColumnByIndices(source.keys, indices);
  const newColumns = new Map<string, Column>();
  for (let c = 1; c < source.schema.length; c += 1) {
    const def = source.schema[c]!;
    const col = source.columns.get(def.name)!;
    newColumns.set(def.name, col.sliceByIndices(indices));
  }
  return ColumnarStore.fromTrustedStore(source.schema, newKeys, newColumns);
}

/**
 * Compacts a store into plain (packed) value columns. Walks each
 * value column; any column with `storage === 'chunked'` is
 * compacted into its plain counterpart. Stores with only plain
 * columns are returned as-is (the same instance) — no allocation,
 * no `fromTrustedStore` rebuild.
 *
 * **Key column.** The key column is unaffected — keys are always
 * materialized (chunked key columns are deferred; `concatSorted`
 * builds a flat key buffer regardless of value-column chunking).
 *
 * **Use case.** Reducers (step 2+) and hot-path callers that want
 * to dereference `Float64Column.values` / `StringColumn.indices`
 * directly first call `materialize` so the narrow on
 * `storage === 'packed'` is unconditional. Read/scan callers can
 * skip this — chunked columns route through chunk lookup
 * transparently.
 */
export function materialize<S extends ColumnSchema>(
  view: ColumnarStore<S>,
): ColumnarStore<S> {
  let hasChunked = false;
  for (const col of view.columns.values()) {
    if (col.storage === 'chunked') {
      hasChunked = true;
      break;
    }
  }
  if (!hasChunked) return view;
  const newColumns = new Map<string, Column>();
  for (let c = 1; c < view.schema.length; c += 1) {
    const def = view.schema[c]!;
    const col = view.columns.get(def.name)!;
    if (col.storage === 'packed') {
      newColumns.set(def.name, col);
      continue;
    }
    // Discriminate on `kind` to call the right materialize helper.
    switch (col.kind) {
      case 'number':
        newColumns.set(
          def.name,
          materializeChunkedFloat64(col as ChunkedFloat64Column),
        );
        break;
      case 'boolean':
        newColumns.set(
          def.name,
          materializeChunkedBoolean(col as ChunkedBooleanColumn),
        );
        break;
      case 'string':
        newColumns.set(
          def.name,
          materializeChunkedString(col as ChunkedStringColumn),
        );
        break;
      case 'array':
        newColumns.set(
          def.name,
          materializeChunkedArray(col as ChunkedArrayColumn),
        );
        break;
      default: {
        // Exhaustiveness — should be unreachable.
        const exhaust: never = col;
        throw new TypeError(
          `materialize: unrecognized column kind '${(exhaust as { kind: string }).kind}'`,
        );
      }
    }
  }
  return ColumnarStore.fromTrustedStore(view.schema, view.keys, newColumns);
}

/* -------------------------------------------------------------------------- */
/* Schema ops — zero-copy on column buffers, compose a fresh map + schema.    */
/* -------------------------------------------------------------------------- */

/**
 * Renames one or more value columns. Buffers are shared by
 * reference; only the schema entries and columns map keys
 * change. Renaming the key column (`schema[0]`) is rejected —
 * the key column's name is bound to its kind and lives at a
 * dedicated index.
 */
export function withColumnsRenamed<S extends ColumnSchema>(
  source: ColumnarStore<S>,
  renames: Readonly<Record<string, string>>,
): ColumnarStore<ColumnSchema> {
  const keyName = source.schema[0]!.name;
  if (Object.prototype.hasOwnProperty.call(renames, keyName)) {
    throw new RangeError(
      `withColumnsRenamed: cannot rename the key column '${keyName}'`,
    );
  }
  // Validate every source column in `renames` actually exists and
  // every target name is unique within the new schema.
  //
  // **Own-property lookups.** `renames[name]` via bracket access
  // walks `Object.prototype`, so a source column named `toString`
  // / `hasOwnProperty` / `valueOf` / etc. with an empty
  // `renames: {}` would pick up the inherited function as the
  // "rename target" and silently corrupt the schema. Every lookup
  // routes through `hasOwnProperty.call` to bypass the prototype
  // chain.
  const has = (k: string): boolean =>
    Object.prototype.hasOwnProperty.call(renames, k);
  const lookupRename = (name: string): string =>
    has(name) ? renames[name]! : name;
  const seenTargets = new Set<string>([keyName]);
  for (let i = 1; i < source.schema.length; i += 1) {
    const name = source.schema[i]!.name;
    const renamed = lookupRename(name);
    if (seenTargets.has(renamed)) {
      throw new RangeError(
        `withColumnsRenamed: target column name '${renamed}' collides with an existing column`,
      );
    }
    seenTargets.add(renamed);
  }
  for (const sourceName of Object.keys(renames)) {
    if (sourceName === keyName) continue;
    let found = false;
    for (let i = 1; i < source.schema.length; i += 1) {
      if (source.schema[i]!.name === sourceName) {
        found = true;
        break;
      }
    }
    if (!found) {
      throw new RangeError(
        `withColumnsRenamed: source column '${sourceName}' is not present in the schema`,
      );
    }
  }
  const newSchema: ColumnDef[] = [];
  const newColumns = new Map<string, Column>();
  for (let i = 0; i < source.schema.length; i += 1) {
    const def = source.schema[i]!;
    if (i === 0) {
      newSchema.push(def);
      continue;
    }
    const renamed = lookupRename(def.name);
    newSchema.push({ name: renamed, kind: def.kind });
    newColumns.set(renamed, source.columns.get(def.name)!);
  }
  return ColumnarStore.fromTrustedStore(
    newSchema as ColumnSchema,
    source.keys,
    newColumns,
  );
}

/**
 * Replaces one value column with a new one of the same kind and
 * length. The schema is preserved; the columns map points at the
 * new column instance at `name`. Other columns share by reference.
 */
export function withColumnReplaced<S extends ColumnSchema>(
  source: ColumnarStore<S>,
  name: string,
  column: Column,
): ColumnarStore<S> {
  const keyName = source.schema[0]!.name;
  if (name === keyName) {
    throw new RangeError(
      `withColumnReplaced: cannot replace the key column '${keyName}'`,
    );
  }
  let def: ColumnDef | undefined;
  for (let i = 1; i < source.schema.length; i += 1) {
    if (source.schema[i]!.name === name) {
      def = source.schema[i]!;
      break;
    }
  }
  if (def === undefined) {
    throw new RangeError(
      `withColumnReplaced: column '${name}' is not present in the schema`,
    );
  }
  if (column.kind !== def.kind) {
    throw new RangeError(
      `withColumnReplaced: replacement column kind '${column.kind}' does not match schema kind '${def.kind}' for '${name}'`,
    );
  }
  if (column.length !== source.length) {
    throw new RangeError(
      `withColumnReplaced: replacement column length ${column.length} does not match store length ${source.length}`,
    );
  }
  const newColumns = new Map<string, Column>();
  for (let i = 1; i < source.schema.length; i += 1) {
    const colName = source.schema[i]!.name;
    newColumns.set(
      colName,
      colName === name ? column : source.columns.get(colName)!,
    );
  }
  return ColumnarStore.fromTrustedStore(source.schema, source.keys, newColumns);
}

/**
 * Appends a new value column to the schema. The new column must
 * match `source.length`. Other columns share by reference.
 */
export function withColumnAppended<S extends ColumnSchema>(
  source: ColumnarStore<S>,
  name: string,
  column: Column,
): ColumnarStore<ColumnSchema> {
  if (column.length !== source.length) {
    throw new RangeError(
      `withColumnAppended: new column length ${column.length} does not match store length ${source.length}`,
    );
  }
  for (let i = 0; i < source.schema.length; i += 1) {
    if (source.schema[i]!.name === name) {
      throw new RangeError(
        `withColumnAppended: column name '${name}' already exists in the schema`,
      );
    }
  }
  const newSchema: ColumnDef[] = [];
  for (let i = 0; i < source.schema.length; i += 1) {
    newSchema.push(source.schema[i]!);
  }
  newSchema.push({ name, kind: column.kind as AnyColumnKind });
  const newColumns = new Map<string, Column>(source.columns);
  newColumns.set(name, column);
  return ColumnarStore.fromTrustedStore(
    newSchema as ColumnSchema,
    source.keys,
    newColumns,
  );
}

/**
 * Returns a new store containing only the named value columns
 * (in the supplied order). The key column is always preserved
 * regardless of `names`. Buffers are shared by reference.
 *
 * Empty `names` is **allowed** and produces a key-only store
 * (schema length 1, columns map empty). That's the natural
 * "drop every value column" projection and matches the framework
 * design's "select" primitive shape.
 */
export function withColumnsSelected<S extends ColumnSchema>(
  source: ColumnarStore<S>,
  names: ReadonlyArray<string>,
): ColumnarStore<ColumnSchema> {
  const keyName = source.schema[0]!.name;
  // Build a lookup of name → def for the source's value columns.
  const sourceValueDefs = new Map<string, ColumnDef>();
  for (let i = 1; i < source.schema.length; i += 1) {
    sourceValueDefs.set(source.schema[i]!.name, source.schema[i]!);
  }
  const newSchema: ColumnDef[] = [source.schema[0]!];
  const newColumns = new Map<string, Column>();
  const seen = new Set<string>();
  for (const name of names) {
    if (name === keyName) {
      throw new RangeError(
        `withColumnsSelected: '${name}' is the key column and is always preserved; do not list it explicitly`,
      );
    }
    if (seen.has(name)) {
      throw new RangeError(
        `withColumnsSelected: duplicate column name '${name}' in selection`,
      );
    }
    const def = sourceValueDefs.get(name);
    if (def === undefined) {
      throw new RangeError(
        `withColumnsSelected: column '${name}' is not present in the source schema`,
      );
    }
    seen.add(name);
    newSchema.push(def);
    newColumns.set(name, source.columns.get(name)!);
  }
  return ColumnarStore.fromTrustedStore(
    newSchema as ColumnSchema,
    source.keys,
    newColumns,
  );
}

/* -------------------------------------------------------------------------- */
/* Internal — key-column slice dispatch.                                       */
/* -------------------------------------------------------------------------- */

function sliceKeyColumnByIndices(
  keys: KeyColumn,
  indices: Int32Array,
): KeyColumn {
  if (keys instanceof TimeKeyColumn) {
    return keys.sliceByIndices(indices);
  }
  if (keys instanceof TimeRangeKeyColumn) {
    return keys.sliceByIndices(indices);
  }
  if (keys instanceof IntervalKeyColumn) {
    return keys.sliceByIndices(indices);
  }
  // Defensive fallback — exhaustiveness check.
  throw new TypeError(
    `withRowSelection: unrecognized KeyColumn kind '${(keys as { kind: string }).kind}'`,
  );
}
