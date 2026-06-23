import {
  ColumnarStore,
  type Column,
  type ColumnSchema,
  ValueKeyColumn,
} from '../../columnar/index.js';

/**
 * Reads the `axis` column into a `Float64Array`, asserting it is a valid value
 * axis: **every cell defined + finite + non-decreasing**. Throws otherwise.
 *
 * This is the monotonicity contract for `byValue` — it lives on the
 * *projection*, not on `ValueKeyColumn` or `byColumn` (Codex review #1): an
 * order-free value-bin aggregation has no monotonic precondition, but promoting
 * a column to the *index* of a series does. A missing/non-finite cell can't be
 * placed in the ordering, so (unlike a value column, where a gap is fine) the
 * axis must be dense.
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
  const out = new Float64Array(n);
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
    out[i] = v;
    prev = v;
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
  const keyCol = new ValueKeyColumn(values, store.length);

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
