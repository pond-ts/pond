/**
 * View / derivation primitives for `ColumnarStore<S>`.
 *
 * Five framework-level ops that produce a derived store from an
 * existing one. The shape of each return is a fully-formed
 * `ColumnarStore<S>` — consumers see no difference from a
 * directly-constructed store, only the typed-buffer payloads
 * change.
 *
 * **Materializing semantics for 1f.** This sub-step ships the
 * materializing implementation: `withRowSelection` walks the
 * `indices` once per column, building owned typed-array buffers
 * via each column's `sliceByIndices`. `materialize` is therefore
 * identity at this sub-step — there is no view-mode wrapper to
 * compact yet. A future sub-step may add lazy view-mode columns
 * (the framework brief calls this out as the path to "Read-only
 * chains skip materialization entirely") if benches show the
 * per-derivation copy cost is material. The current contract is
 * correct and useful; lazy is an optimization door.
 *
 * Schema ops (`withColumnsRenamed`, `withColumnReplaced`,
 * `withColumnAppended`, `withColumnsSelected`) are genuinely
 * zero-copy on the column buffers — they compose a fresh schema
 * and columns `Map` while keeping the same column instances.
 *
 * Framework-internal; not exported from `packages/core/src/index.ts`.
 */

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
 * **Out-of-range index discipline.** The constructor downstream
 * validates the gathered key column (finite timestamps,
 * defined interval labels, etc.). Out-of-range source indices
 * will surface as constructor `RangeError`s rather than silent
 * placeholder rows. Callers should produce `indices` from filter
 * / range-query primitives that emit only valid source rows.
 *
 * Cost: O(K) gather per column where K is `indices.length`.
 */
export function withRowSelection<S extends ColumnSchema>(
  source: ColumnarStore<S>,
  indices: Int32Array,
): ColumnarStore<S> {
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
 * Compacts a view-store into owned typed-array buffers. At
 * sub-step 1f this is **identity** — `withRowSelection` already
 * produces owned buffers, so `materialize` returns the input as
 * is. The function exists as a stable surface for callers
 * (downstream operators in step 2+) that want to defensively
 * materialize without knowing whether a store is a view; a
 * future sub-step adding lazy view-mode columns can change the
 * implementation without breaking that contract.
 */
export function materialize<S extends ColumnSchema>(
  view: ColumnarStore<S>,
): ColumnarStore<S> {
  // No-op for 1f. Documented in the module header.
  return view;
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
  const seenTargets = new Set<string>([keyName]);
  for (let i = 1; i < source.schema.length; i += 1) {
    const name = source.schema[i]!.name;
    const renamed = renames[name] !== undefined ? renames[name]! : name;
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
    const renamed =
      renames[def.name] !== undefined ? renames[def.name]! : def.name;
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
 * regardless of `names`. Buffers are shared.
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
