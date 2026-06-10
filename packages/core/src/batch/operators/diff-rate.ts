import {
  type Column,
  type ColumnarStore,
  type ColumnSchema,
  float64ColumnFromArray,
  withColumnReplaced,
  withRowRange,
} from '../../columnar/index.js';
import type { SeriesSchema } from '../../schema/index.js';

/**
 * Successive-difference family selector. `diff` is the raw delta
 * `curr - prev`; `rate` divides by the elapsed seconds between the
 * two rows' begins; `pctChange` divides by the previous value.
 */
export type DiffRateMode = 'diff' | 'rate' | 'pctChange';

/**
 * **Step 4 — column-native `diff` / `rate` / `pctChange` (extracted
 * operator).** Successive differences per target column, computed
 * straight off the columnar store: read each target's cells
 * (storage-agnostic `read(i)`), fold the per-row difference, replace
 * the column — no `series.events` materialization, no per-row
 * `Event`. Non-target columns + the key axis pass through untouched
 * (`withColumnReplaced` references the unchanged columns + keys
 * zero-copy).
 *
 * Matches the row path's semantics exactly:
 * - Row 0 has no predecessor, so each target is `undefined` there.
 * - Row `i ≥ 1`: with both `prev` and `curr` defined numbers,
 *   `delta = curr - prev`; `diff` emits `delta`, `rate` emits
 *   `delta / dt` (`dt` = `(begin[i] − begin[i−1]) / 1000` seconds,
 *   `undefined` when `dt === 0`), `pctChange` emits `delta / prev`
 *   (`undefined` when `prev === 0`). If either side is missing /
 *   non-numeric, the output is `undefined`. A stored `NaN` is a
 *   defined number (`typeof raw === 'number'`), so it participates.
 *
 * **`drop`.** `drop: false` (default) keeps the predecessor-less
 * first row (its targets `undefined`, its other columns + key
 * intact). `drop: true` removes that row entirely — every column
 * **and** the key slice to `[1, n)` via `withRowRange`, the row-range
 * substrate built for exactly this. The full-length result is built
 * first (the `drop: false` shape); `drop: true` just appends the
 * trailing one-row slice, so the two paths share all the fold logic.
 *
 * Returns the reshaped store + the output schema (targets widened to
 * optional `number`). The result-schema cast is the single trust
 * boundary; the `TimeSeries` method wraps the store via
 * `#fromTrustedStore`.
 *
 * A non-numeric target name is unreachable through the typed surface
 * (`NumericColumnNameForSchema<S>`); defeating that constraint makes
 * the all-`undefined` replacement column `kind: 'number'`, so
 * `withColumnReplaced`'s kind guard throws a `RangeError` naming the
 * column — fail-fast over the old path's silent all-`undefined`.
 */
export function diffRateOp<
  S extends SeriesSchema,
  OutSchema extends SeriesSchema,
>(
  store: ColumnarStore<S>,
  schema: S,
  mode: DiffRateMode,
  cols: readonly string[],
  drop: boolean,
): { store: ColumnarStore<OutSchema>; schema: OutSchema } {
  if (cols.length === 0) {
    throw new Error(`${mode}() requires at least one column name`);
  }
  const targetSet = new Set(cols);
  const outSchema = Object.freeze(
    schema.map((col, i) =>
      i === 0 || !targetSet.has(col.name)
        ? col
        : { ...col, kind: 'number' as const, required: false as const },
    ),
  ) as unknown as OutSchema;

  const n = store.length;

  // For `rate`, the elapsed-seconds divisor depends only on the row
  // index, not the target — precompute it once rather than per
  // (target, row). dt[0] is unused (row 0 has no predecessor).
  let dt: Float64Array | undefined;
  if (mode === 'rate' && n > 0) {
    dt = new Float64Array(n);
    for (let i = 1; i < n; i += 1) {
      dt[i] = (store.beginAt(i) - store.beginAt(i - 1)) / 1000;
    }
  }

  let result = store as unknown as ColumnarStore<ColumnSchema>;
  for (const name of cols) {
    const col: Column = store.columns.get(name)!;
    const out: (number | undefined)[] = new Array(n);
    if (n > 0) out[0] = undefined; // first row: no predecessor
    for (let i = 1; i < n; i += 1) {
      const prev = col.read(i - 1) as number | undefined;
      const curr = col.read(i) as number | undefined;
      if (typeof curr === 'number' && typeof prev === 'number') {
        const delta = curr - prev;
        if (mode === 'pctChange') {
          out[i] = prev !== 0 ? delta / prev : undefined;
        } else if (mode === 'rate') {
          const d = dt![i]!;
          out[i] = d !== 0 ? delta / d : undefined;
        } else {
          out[i] = delta;
        }
      } else {
        out[i] = undefined;
      }
    }
    result = withColumnReplaced(result, name, float64ColumnFromArray(out));
  }

  // drop:true removes the predecessor-less first row from every column
  // + the key. (n === 0 has no row to drop; the guard keeps the empty
  // store untouched rather than slicing [1, 0).)
  if (drop && n > 0) {
    result = withRowRange(result, 1, n);
  }

  return {
    store: result as unknown as ColumnarStore<OutSchema>,
    schema: outSchema,
  };
}
