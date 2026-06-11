import {
  type Column,
  type ColumnarStore,
  type ColumnSchema,
  booleanColumnFromArray,
  float64ColumnFromArray,
  stringColumnFromArray,
  withColumnAppended,
  withColumnsSelected,
} from '../../columnar/index.js';
import type { ScalarValue, SeriesSchema } from '../../schema/index.js';

/** The reducer's row input — the keyed columns' values for one row. */
export type CollapseReducer = (values: Record<string, unknown>) => ScalarValue;

/** Builds the single output column from the reducer results + inferred kind. */
function buildScalarColumn(
  kind: 'number' | 'boolean' | 'string',
  values: (ScalarValue | undefined)[],
): Column {
  switch (kind) {
    case 'number':
      return float64ColumnFromArray(values as (number | undefined)[]);
    case 'boolean':
      return booleanColumnFromArray(values as (boolean | undefined)[]);
    case 'string':
      return stringColumnFromArray(values as (string | undefined)[]);
  }
}

/**
 * **Step 4 — column-native `collapse` (extracted operator).** Reduces
 * the `keys` columns into a single `output` column, one value per row,
 * reading **only the keyed columns** off the store (storage-agnostic
 * `read(i)`) — no `series.events` materialization, no per-row `Event`.
 * The kept columns + the key axis pass through by reference.
 *
 * Unlike the pure folds (`cumulative`, `diff`, `shift`), `collapse`
 * still calls the user reducer per row over a small `{ key: value }`
 * object, so the win is the more modest "read only the keyed columns +
 * drop the Event allocation + share the kept columns" rather than a
 * full vectorization — but the materialization tax is still removed.
 *
 * Semantics (matching the row path):
 * - the reducer receives the keyed columns' values for the row
 *   (`undefined` for a missing cell), and returns a `ScalarValue`;
 * - the output column's kind is inferred from the **first row's**
 *   result (`number` / `boolean` / else `string`) — an empty series
 *   yields a `string` output column, matching the old `nextEvents[0]?`
 *   inference;
 * - **`append: false`** (default) drops the keyed columns and appends
 *   `output`; **`append: true`** keeps every value column and appends
 *   `output`.
 *
 * Returns the reshaped store + the output schema; the result-schema
 * cast is the single trust boundary, and the `TimeSeries.collapse`
 * method wraps the store via `#fromTrustedStore`. An `output` name
 * that collides with a kept column throws via `withColumnAppended`.
 *
 * NB: `buildScalarColumn` overlaps `fillOp`'s `buildFilledColumn` and
 * `mapOp`'s `columnFromValuesByKind` — three callers now; a shared
 * `columnFromValuesByKind` helper is the flagged follow-up.
 */
export function collapseOp<
  S extends SeriesSchema,
  OutSchema extends SeriesSchema,
>(
  store: ColumnarStore<S>,
  schema: S,
  keys: readonly string[],
  output: string,
  reducer: CollapseReducer,
  append: boolean,
): { store: ColumnarStore<OutSchema>; schema: OutSchema } {
  const n = store.length;
  const keyedCols = keys.map((k) => store.columns.get(k)!);

  const out: (ScalarValue | undefined)[] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const values: Record<string, unknown> = {};
    for (let j = 0; j < keys.length; j += 1) {
      values[keys[j]!] = keyedCols[j]!.read(i);
    }
    out[i] = reducer(values);
  }

  // Output kind from the first row's result (matches the old
  // `typeof nextEvents[0]?.get(output)` inference; empty ⇒ 'string').
  const first = n > 0 ? out[0] : undefined;
  const outKind =
    typeof first === 'number'
      ? 'number'
      : typeof first === 'boolean'
        ? 'boolean'
        : 'string';
  const outColumn = buildScalarColumn(outKind, out);

  const keptDefs = append
    ? schema.slice(1)
    : schema.slice(1).filter((c) => !keys.includes(c.name));
  const keptNames = keptDefs.map((c) => c.name);

  // key + kept value columns (zero-copy), then append the output column.
  const selected = withColumnsSelected(
    store as unknown as ColumnarStore<ColumnSchema>,
    keptNames,
  );
  const result = withColumnAppended(selected, output, outColumn);

  const outSchema = Object.freeze([
    schema[0],
    ...keptDefs,
    { name: output, kind: outKind },
  ]) as unknown as OutSchema;

  return {
    store: result as unknown as ColumnarStore<OutSchema>,
    schema: outSchema,
  };
}
