import {
  type Column,
  type ColumnarStore,
  type ColumnSchema,
  float64ColumnFromArray,
  withColumnReplaced,
} from '../../columnar/index.js';
import type { SeriesSchema } from '../../schema/index.js';

/**
 * **Step 4 — column-native `shift` (extracted operator).** Shifts each
 * target numeric column's values by `n` rows, straight off the
 * columnar store: row `i` takes the value at row `i − n` (storage-
 * agnostic `col.read`), or `undefined` when that source row is out of
 * range — no `series.events` materialization, no per-row `Event`.
 * Non-target columns + the key axis pass through by reference.
 *
 * `n > 0` shifts forward (a lag: the first `n` rows pad to
 * `undefined`); `n < 0` shifts backward (a lead: the last `|n|` rows
 * pad); `n === 0` is identity. `n` beyond the row count pads the whole
 * column. The padding is why targets widen to optional `number` in the
 * output schema.
 *
 * Returns the reshaped store + the output schema; the result-schema
 * cast is the single trust boundary, and the `TimeSeries.shift` method
 * wraps the store via `#fromTrustedStore`.
 *
 * A non-numeric target is unreachable through the typed surface
 * (`NumericColumnNameForSchema<S>`); defeating that constraint makes the
 * `Float64Column` replacement collide with the existing column's kind, so
 * `withColumnReplaced`'s kind guard throws a `RangeError` naming the column
 * — fail-fast, matching `cumulativeOp` / `diffRateOp`.
 */
export function shiftOp<S extends SeriesSchema, OutSchema extends SeriesSchema>(
  store: ColumnarStore<S>,
  schema: S,
  cols: readonly string[],
  n: number,
): { store: ColumnarStore<OutSchema>; schema: OutSchema } {
  if (cols.length === 0) {
    throw new Error('shift() requires at least one column name');
  }
  if (!Number.isInteger(n)) {
    throw new Error('shift() requires an integer offset');
  }
  const targetSet = new Set(cols);
  const outSchema = Object.freeze(
    schema.map((col, i) =>
      i === 0 || !targetSet.has(col.name)
        ? col
        : { ...col, kind: 'number' as const, required: false as const },
    ),
  ) as unknown as OutSchema;

  const len = store.length;
  let result = store as unknown as ColumnarStore<ColumnSchema>;
  for (const name of cols) {
    const col: Column = store.columns.get(name)!;
    const out: (number | undefined)[] = new Array(len);
    for (let i = 0; i < len; i += 1) {
      const srcIdx = i - n;
      out[i] =
        srcIdx >= 0 && srcIdx < len
          ? (col.read(srcIdx) as number | undefined)
          : undefined;
    }
    result = withColumnReplaced(result, name, float64ColumnFromArray(out));
  }

  return {
    store: result as unknown as ColumnarStore<OutSchema>,
    schema: outSchema,
  };
}
