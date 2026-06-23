import {
  ColumnarStore,
  type Column,
  type ColumnSchema,
  Float64Column,
  ValueKeyColumn,
} from '../../columnar/index.js';

/**
 * Validates that the `axis` column is a usable value axis — **every cell
 * defined + finite + non-decreasing** — and returns the `Float64Array` to key
 * on. Throws otherwise.
 *
 * This is the monotonicity contract for `byValue`: it lives on the *projection*,
 * not on `ValueKeyColumn` or `byColumn` (Codex review #1). An order-free
 * value-bin aggregation has no monotonic precondition, but promoting a column to
 * the *index* of a series does — and a missing/non-finite cell can't be placed
 * in the ordering, so (unlike a value column, where a gap is fine) the axis must
 * be dense.
 *
 * **Zero-copy fast path (Lever 1).** A packed {@link Float64Column} (every batch
 * value column is one) already holds a contiguous backing buffer. Once the scan
 * has proven `[0, n)` is dense + finite, that buffer *is* the key data, so we
 * hand back a `subarray(0, n)` view rather than allocating and copying a fresh
 * array — the source axis column and the new key then share it read-only (the
 * same zero-copy contract as a slice). `_values.length` can exceed the logical
 * length (capacity-grown columns), hence the `subarray`. A chunked column has no
 * single contiguous buffer, so it falls back to materializing one.
 *
 * The validation read-loop is unavoidable here (it enforces dense + finite +
 * sorted). A future `{ assumeSorted }` fast path could skip it for a
 * caller-guaranteed axis (e.g. a `scan`-produced cumulative distance); that's a
 * trusted-construction seam, deferred until a re-projection hot path earns it.
 */
function assertMonotonicAxis(
  store: ColumnarStore<ColumnSchema>,
  axis: string,
): Float64Array {
  const col: Column | undefined = store.columns.get(axis);
  if (col === undefined) {
    throw new RangeError(`byValue: unknown column '${axis}'`);
  }
  const n = store.length;
  let prev = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const v = col.read(i);
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new RangeError(
        `byValue: axis '${axis}' must be defined and finite at every row to be the index; ` +
          `row ${i} is ${v === undefined ? 'missing' : String(v)}`,
      );
    }
    if (v < prev) {
      throw new RangeError(
        `byValue: axis '${axis}' must be non-decreasing; row ${i} (${v}) < previous (${prev})`,
      );
    }
    prev = v;
  }

  // Validation passed → `[0, n)` is dense + finite. Reuse the packed backing
  // buffer zero-copy; materialize only for a (rare) chunked axis column.
  if (col instanceof Float64Column) {
    return col._values.subarray(0, n);
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = col.read(i) as number;
  }
  return out;
}

/**
 * **Column-native `byValue`** — the raw `TimeSeries → ValueSeries` projection
 * (RFC `value-axis.md` §6). Re-keys the store onto the monotonic `axis` column
 * (a no-op reindex: the rows already sit in axis order, since the axis is
 * non-decreasing in storage order) and **drops `axis` from the value columns**
 * — it is now the key, and `fromTrustedStore` rejects the duplicate name
 * otherwise. The non-axis value columns + their buffers are shared by reference
 * (zero-copy); only the key column is newly allocated.
 *
 * Returns the reshaped store + the value-keyed output schema. The schema cast
 * is the trust boundary; `TimeSeries.byValue` wraps the store in a
 * `ValueSeries` with the precise `ValueKeyedSchema<S, Axis>` type.
 */
export function byValueOp(
  store: ColumnarStore<ColumnSchema>,
  schema: ColumnSchema,
  axis: string,
): { store: ColumnarStore<ColumnSchema>; schema: ColumnSchema } {
  const values = assertMonotonicAxis(store, axis);
  // `fromValidatedSubarray`, not `new ValueKeyColumn` — `assertMonotonicAxis`
  // already proved finiteness, so skip the constructor's redundant finite scan.
  const keyCol = ValueKeyColumn.fromValidatedSubarray(values, store.length);

  // Drop the axis column from the value columns (it becomes the key).
  const newColumns = new Map<string, Column>(store.columns);
  newColumns.delete(axis);

  const newSchema: ColumnSchema = [
    { name: axis, kind: 'value' as const },
    ...schema.slice(1).filter((c) => c.name !== axis),
  ];

  const newStore = ColumnarStore.fromTrustedStore(
    newSchema,
    keyCol,
    newColumns,
  );
  return { store: newStore, schema: newSchema };
}
