/**
 * Framework-local type vocabulary.
 *
 * The columnar substrate defines its own column / schema / scalar
 * type shapes so it isn't tied to pond-ts row-API vocabulary.
 * `SeriesSchema` (the row-API library type) is structurally
 * compatible with `ColumnSchema` here, so the row-API adapter at
 * `src/series-store.ts` passes through its own `S extends
 * SeriesSchema` parameter without type-level friction.
 *
 * Framework-internal; not exported from `packages/core/src/index.ts`.
 */

/** Value-column kinds — the four scalar storage shapes. */
export type ColumnKind = 'number' | 'boolean' | 'string' | 'array';

/** Key-column kinds — the three temporal axis shapes. */
export type KeyKind = 'time' | 'timeRange' | 'interval';

/**
 * Any column kind — value or key. `ColumnDef`'s `kind` field is
 * widened to this so a single tuple type can describe both the
 * first (key) entry and the subsequent value entries.
 */
export type AnyColumnKind = ColumnKind | KeyKind;

/**
 * A column definition — name + kind. Optional `required` flag is
 * row-API metadata that the framework doesn't act on but tolerates
 * for structural compatibility with `SeriesSchema`.
 */
export type ColumnDef<
  Name extends string = string,
  Kind extends string = AnyColumnKind,
> = {
  readonly name: Name;
  readonly kind: Kind;
  readonly required?: boolean;
};

/**
 * The framework's schema type — `readonly ColumnDef[]`. The first
 * entry's `kind` must be a `KeyKind`; subsequent entries must be
 * `ColumnKind` (value kinds). The framework validates this
 * structure at `ColumnarStore.fromTrustedStore`.
 *
 * Structurally compatible with `SeriesSchema` from
 * `packages/core/src/types.ts`, but doesn't depend on it.
 */
export type ColumnSchema = readonly ColumnDef[];

/** Scalar values — what an `ArrayValue` element can be. */
export type ScalarValue = number | string | boolean;

/**
 * Array-kind column cell value. Matches the pond-ts row-API
 * `ArrayValue` shape but lives in the framework's vocabulary so
 * the framework doesn't import from `../types.js`.
 */
export type ArrayValue = ReadonlyArray<ScalarValue>;
