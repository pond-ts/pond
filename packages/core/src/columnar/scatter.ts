/**
 * `scatterByPartition` — partition a `ColumnarStore<S>` by the
 * value of one of its scalar value columns.
 *
 * **Use case.** `LivePartitionedSeries` (RFC V3 commitment #5)
 * receives mixed-partition batches over the wire and needs to
 * route each row to its target partition. `scatterByPartition`
 * is the framework primitive — given a batch and a column name,
 * it returns `Map<ScalarValue, ColumnarStore<S>>` keyed by the
 * unique values in that column.
 *
 * **Scalar-only.** The partition column must be `number` /
 * `boolean` / `string`. `array` columns are rejected — arrays
 * can't be JS Map keys without losing identity-vs-equality
 * disambiguation, and partitioning by array-valued cells isn't
 * a useful pattern in practice.
 *
 * **Invalid cells: caller chooses.** Rows whose partition cell
 * is `undefined` (validity-bit-clear) can't be routed to any
 * bucket — they have no partition key. Default behavior is to
 * **throw** on the first encountered undefined cell so the
 * producer/schema-drift bug is loud rather than silent. Pass
 * `{ onUndefined: 'drop' }` in options for the lax behavior
 * (rows excluded from every bucket; aggregate output length can
 * be less than the input's). Closed Codex round 2's medium
 * finding on PR #149 — the previous silent-drop default would
 * make rows vanish from `LivePartitionedSeries` routing with no
 * error or recovery hook.
 *
 * **NaN partition values are bucketed under `NaN`.** Numeric
 * columns can contain `NaN` cells via trusted-construction paths
 * (the row-API rejects `NaN` at intake; `Float64Column`'s direct
 * constructor accepts it). JS `Map` uses `SameValueZero`
 * equality, which treats `NaN === NaN`, so NaN is a stable Map
 * key. We **bucket** NaN rows under the `NaN` key rather than
 * dropping them — same reasoning as the undefined-throws default:
 * silently discarding defined cells is observability-poor for
 * routing. Callers who want stricter NaN semantics can check
 * `Number.isNaN(key)` on the result keys.
 *
 * **Order preservation within a partition.** Each output sub-store
 * preserves the relative order of rows from the input — the
 * partition row indices are gathered in ascending order. Cross-
 * partition order is unspecified (the result is a `Map`).
 *
 * **Result type.** `Map<ScalarValue, ColumnarStore<S>>`. JS `Map`
 * uses `SameValueZero` equality, which treats `+0 === -0` and
 * `NaN === NaN`. `+0` / `-0` collapse to a single bucket
 * (acceptable for partition routing); `NaN` is its own stable
 * bucket per above.
 *
 * Framework-internal; not exported from `packages/core/src/index.ts`.
 */

import type { ScalarValue, ColumnSchema } from './types.js';
import { ColumnarStore } from './store.js';
import { withRowSelection } from './view.js';

/**
 * Behavior for rows whose partition cell is `undefined`.
 *
 * - `'throw'` (default) — reject the call with a `RangeError`
 *   that names the offending row index. Catches producer/
 *   schema-drift bugs at the framework boundary.
 * - `'drop'` — silently exclude those rows from every bucket.
 *   Caller is responsible for noticing if `Σ buckets.length <
 *   source.length` matters.
 */
export type OnUndefinedPartition = 'throw' | 'drop';

export interface ScatterByPartitionOptions {
  /** See `OnUndefinedPartition`. Defaults to `'throw'`. */
  onUndefined?: OnUndefinedPartition;
}

/**
 * Partitions a store by `partitionColumn`. The partition column
 * must be a value column (i.e., `partitionColumn !== schema[0].name`)
 * of kind `'number'` / `'boolean'` / `'string'`. Empty input
 * returns an empty Map.
 */
export function scatterByPartition<S extends ColumnSchema>(
  source: ColumnarStore<S>,
  partitionColumn: string,
  options?: ScatterByPartitionOptions,
): Map<ScalarValue, ColumnarStore<S>> {
  // Validate `onUndefined` up front. Without this, a typo
  // (`{ onUndefined: 'drpo' }`) or a config-driven caller passing
  // a stale string would silently fall through to drop behavior
  // — exactly the silent-data-loss path the default 'throw' is
  // meant to prevent. Closed Codex round 3's medium finding on
  // PR #149.
  const onUndefinedRaw = options?.onUndefined;
  const onUndefined: OnUndefinedPartition =
    onUndefinedRaw === undefined ? 'throw' : onUndefinedRaw;
  if (onUndefined !== 'throw' && onUndefined !== 'drop') {
    throw new RangeError(
      `scatterByPartition: options.onUndefined must be 'throw' or 'drop', got ${JSON.stringify(onUndefinedRaw)}`,
    );
  }
  const keyName = source.schema[0]!.name;
  if (partitionColumn === keyName) {
    throw new RangeError(
      `scatterByPartition: '${partitionColumn}' is the key column; partitioning by the key column is not supported (every row would be a singleton)`,
    );
  }
  // Locate the partition column's def.
  let partitionDef: { name: string; kind: string } | undefined;
  for (let i = 1; i < source.schema.length; i += 1) {
    if (source.schema[i]!.name === partitionColumn) {
      partitionDef = source.schema[i]!;
      break;
    }
  }
  if (partitionDef === undefined) {
    throw new RangeError(
      `scatterByPartition: column '${partitionColumn}' is not present in the source schema`,
    );
  }
  if (partitionDef.kind === 'array') {
    throw new TypeError(
      `scatterByPartition: column '${partitionColumn}' has kind 'array'; partitioning by array-valued cells is not supported`,
    );
  }
  // Bucket row indices by the partition column's value. Track
  // insertion order so each bucket's row-index list stays sorted
  // ascending (rows visited in their natural order).
  const buckets = new Map<ScalarValue, number[]>();
  const partitionCol = source.columns.get(partitionColumn)!;
  for (let i = 0; i < source.length; i += 1) {
    const value = partitionCol.read(i);
    if (value === undefined) {
      if (onUndefined === 'throw') {
        throw new RangeError(
          `scatterByPartition: row ${i} has an undefined value in partition column '${partitionColumn}'; pass { onUndefined: 'drop' } to exclude such rows silently`,
        );
      }
      // 'drop' — exclude from every bucket.
      continue;
    }
    // NaN is a stable Map key under SameValueZero — bucket rather
    // than drop. See module header.
    // We've narrowed by kind to scalar (number / boolean / string);
    // the `unknown` from `column.read` is one of those three.
    const key = value as ScalarValue;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(i);
  }
  // Materialize each bucket via `withRowSelection`. Schema is
  // preserved on each output.
  const result = new Map<ScalarValue, ColumnarStore<S>>();
  for (const [key, rowIndices] of buckets) {
    const indices = new Int32Array(rowIndices);
    result.set(key, withRowSelection(source, indices) as ColumnarStore<S>);
  }
  return result;
}
