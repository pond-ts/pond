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
 * **Invalid cells dropped.** Rows whose partition cell is
 * `undefined` (validity-bit-clear) are excluded from every
 * output partition — they belong to no bucket. The output
 * `Map<ScalarValue, ...>` therefore never contains
 * `undefined` as a key, but its sub-stores' aggregate length
 * can be less than the input's `length`.
 *
 * **NaN partition values are bucketed under `NaN`.** Numeric
 * columns can contain `NaN` cells via trusted-construction paths
 * (the row-API rejects `NaN` at intake; `Float64Column`'s direct
 * constructor accepts it). JS `Map` uses `SameValueZero`
 * equality, which treats `NaN === NaN`, so NaN is a stable Map
 * key. We **bucket** NaN rows under the `NaN` key rather than
 * dropping them — silently discarding defined cells would be
 * observability-poor for the `LivePartitionedSeries` routing
 * use case, where a producer mis-emitting `NaN` partition values
 * needs to be visible to its consumer. Callers who want stricter
 * semantics can pre-filter or check `Number.isNaN(key)` on the
 * result keys.
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
 * Partitions a store by `partitionColumn`. The partition column
 * must be a value column (i.e., `partitionColumn !== schema[0].name`)
 * of kind `'number'` / `'boolean'` / `'string'`. Empty input
 * returns an empty Map.
 */
export function scatterByPartition<S extends ColumnSchema>(
  source: ColumnarStore<S>,
  partitionColumn: string,
): Map<ScalarValue, ColumnarStore<S>> {
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
    if (value === undefined) continue;
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
