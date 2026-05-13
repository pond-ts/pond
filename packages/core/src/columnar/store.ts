/**
 * `ColumnarStore<S>` — the framework's primary read-only data
 * container.
 *
 * **Pure columnar substrate.** The framework knows about typed
 * arrays, columns, key buffers, and indexed access. It does **not**
 * know about `Event`, `EventKey`, `Time`, `TimeRange`, `Interval`,
 * or any other row-API value type. Row-shaped materialization
 * (Event instances, the lazy per-row cache, the five public-API
 * invariants from the RFC, `toRows` / `toObjects` exports) lives in
 * the row-API adapter at `packages/core/src/series-store.ts`
 * (`SeriesStore<S>`), which wraps a `ColumnarStore` + schema.
 *
 * `ColumnarStore<S>` composes:
 * - A `KeyColumn` (from `key-column.ts`) — pure typed-buffer key
 *   storage (`begin`, `end`, optional `labels` for intervals).
 * - A `ReadonlyMap<columnName, Column>` of value columns.
 * - A declared `schema: S` (a `SeriesSchema` from `types.ts`).
 *
 * Provides:
 * - Direct typed-buffer access: `beginAt(i)`, `endAt(i)`,
 *   `valueAt(rowIndex, columnName)`.
 * - Structural validation at construction: column kinds match
 *   schema, lengths agree, no extras, no duplicates.
 * - Defensive ownership of the columns map.
 *
 * No `eventAt`, no `toEvents`, no `Symbol.iterator`, no caching.
 * Those concerns live one layer up.
 *
 * Framework-internal; not exported from `packages/core/src/index.ts`.
 */

import type { SeriesSchema } from '../types.js';
import type { Column } from './column.js';
import type { KeyColumn } from './key-column.js';

/** Options accepted by `ColumnarStore.fromTrustedStore`. */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface FromTrustedStoreOptions {
  // Placeholder for future options. Row-API concerns (eventCache,
  // identity preservation across derivation) live at the
  // `SeriesStore` layer, not here.
}

/**
 * Primary read-only columnar store. Construction goes through the
 * named factory below; the constructor is private to keep the
 * column / key / schema shape consistent.
 */
export class ColumnarStore<S extends SeriesSchema = SeriesSchema> {
  readonly schema: S;
  readonly length: number;
  readonly keys: KeyColumn;
  readonly columns: ReadonlyMap<string, Column>;

  private constructor(
    schema: S,
    keys: KeyColumn,
    columns: ReadonlyMap<string, Column>,
  ) {
    this.schema = schema;
    this.keys = keys;
    this.length = keys.length;
    this.columns = columns;
  }

  /**
   * Trusted-construction factory. Accepts a pre-built key column,
   * a `ReadonlyMap` of value columns keyed by column name, and a
   * declaring `schema`. Validates the structural invariants:
   *
   * - Key column's `kind === schema[0].kind`.
   * - Schema column names are unique.
   * - Every schema value column is present in `columns` with a
   *   matching `kind` and `length === keys.length`.
   * - The columns map contains no extra entries beyond the schema.
   *
   * No row-shaped or event-shaped validation; those concerns live
   * at the row-API adapter layer (`SeriesStore<S>`).
   *
   * **Defensive ownership.** The columns map is copied into an
   * owned `Map` at construction; the caller can't mutate the store
   * by mutating the source map after the fact.
   */
  static fromTrustedStore<S extends SeriesSchema>(
    schema: S,
    keys: KeyColumn,
    columns: ReadonlyMap<string, Column>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    options?: FromTrustedStoreOptions,
  ): ColumnarStore<S> {
    const expectedLength = keys.length;
    // Validate the key column's kind matches schema[0].
    const firstDef = schema[0]!;
    if (keys.kind !== firstDef.kind) {
      throw new RangeError(
        `ColumnarStore: key column kind '${keys.kind}' does not match schema[0].kind '${firstDef.kind}'`,
      );
    }
    // Reject duplicate column names in the schema — the columns map
    // lookup would silently last-write-wins otherwise.
    const seenNames = new Set<string>();
    for (let i = 0; i < schema.length; i += 1) {
      const name = schema[i]!.name;
      if (seenNames.has(name)) {
        throw new RangeError(
          `ColumnarStore: duplicate schema column name '${name}'`,
        );
      }
      seenNames.add(name);
    }
    // Validate that every schema value column is present with the
    // declared kind.
    for (let i = 1; i < schema.length; i += 1) {
      const def = schema[i]!;
      const col = columns.get(def.name);
      if (col === undefined) {
        throw new RangeError(
          `ColumnarStore: schema column '${def.name}' is not present in the columns map`,
        );
      }
      if (col.length !== expectedLength) {
        throw new RangeError(
          `ColumnarStore: column '${def.name}' length ${col.length} does not match keys.length ${expectedLength}`,
        );
      }
      if (col.kind !== def.kind) {
        throw new RangeError(
          `ColumnarStore: column '${def.name}' kind is '${col.kind}' but schema declares '${def.kind}'`,
        );
      }
    }
    // Reject extra columns not declared in the schema.
    for (const [name] of columns) {
      if (!seenNames.has(name) || name === firstDef.name) {
        throw new RangeError(
          `ColumnarStore: columns map contains '${name}' which is not declared in the schema`,
        );
      }
    }
    // Defensively own the columns map. `ReadonlyMap` is a TS marker
    // only; the caller can mutate the map post-construction unless
    // we copy. Mirrors the PR #134 round-2 defensive-ownership
    // pattern established by `ArrayColumn` cells.
    const ownedColumns = new Map<string, Column>(columns);
    return new ColumnarStore<S>(schema, keys, ownedColumns);
  }

  /** Direct key-column read: begin timestamp at row `i`. */
  beginAt(i: number): number {
    return this.keys.beginAt(i);
  }

  /** Direct key-column read: end timestamp at row `i`. */
  endAt(i: number): number {
    return this.keys.endAt(i);
  }

  /**
   * Returns the value at `(rowIndex, columnName)` directly from the
   * column. Bounds-checks the row index; out-of-range throws
   * `RangeError`. Invalid cells within range return `undefined`
   * (matching the underlying `column.read` contract).
   */
  valueAt(rowIndex: number, columnName: string): unknown {
    if (rowIndex < 0 || rowIndex >= this.length) {
      throw new RangeError(
        `ColumnarStore.valueAt out of range: ${rowIndex} not in [0, ${this.length})`,
      );
    }
    const col = this.columns.get(columnName);
    if (col === undefined) {
      throw new RangeError(
        `ColumnarStore.valueAt: column '${columnName}' not present`,
      );
    }
    return col.read(rowIndex);
  }
}
