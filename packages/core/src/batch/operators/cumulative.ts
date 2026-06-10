import {
  type Column,
  type ColumnarStore,
  type ColumnSchema,
  float64ColumnFromArray,
  withColumnReplaced,
} from '../../columnar/index.js';
import type { SeriesSchema } from '../../schema/index.js';

/**
 * A cumulative accumulator — a built-in name or a custom fold
 * `(acc, value) => next`. Mirrors `TimeSeries.cumulative`'s spec values.
 */
export type CumulativeReducer =
  | 'sum'
  | 'max'
  | 'min'
  | 'count'
  | ((acc: number, value: number) => number);

function buildApply(
  reducer: CumulativeReducer,
): (acc: number | undefined, value: number) => number {
  if (typeof reducer === 'function') {
    return (acc, v) => (acc === undefined ? v : reducer(acc, v));
  }
  switch (reducer) {
    case 'sum':
      return (acc, v) => (acc ?? 0) + v;
    case 'count':
      return (acc) => (acc ?? 0) + 1;
    case 'max':
      return (acc, v) => (acc === undefined || v > acc ? v : acc);
    case 'min':
      return (acc, v) => (acc === undefined || v < acc ? v : acc);
  }
}

/**
 * **Step 4 — column-native `cumulative` (extracted operator).** Running
 * accumulation per target column, computed straight off the columnar store:
 * read each target's cells (storage-agnostic `read(i)`), fold a running
 * accumulator, replace the column — no `series.events` materialization, no
 * per-row `Event`. Non-target columns + the key axis pass through untouched
 * (`withColumnReplaced` references the unchanged columns + keys zero-copy).
 *
 * Matches the row path's semantics exactly: a defined numeric cell updates
 * the accumulator; a missing / undefined cell **carries** the current
 * accumulator (does not reset it), and the output is `undefined` only until
 * the first defined value (`float64ColumnFromArray` derives validity from the
 * `undefined`s). A stored NaN is a defined number — applied, matching the old
 * `typeof raw === 'number'` check.
 *
 * Returns the reshaped store + the output schema (targets widened to optional
 * `number`). The result-schema cast is the single trust boundary; the
 * `TimeSeries.cumulative` method wraps the store via `#fromTrustedStore`.
 */
export function cumulativeOp<
  S extends SeriesSchema,
  OutSchema extends SeriesSchema,
>(
  store: ColumnarStore<S>,
  schema: S,
  spec: Readonly<Record<string, CumulativeReducer>>,
): { store: ColumnarStore<OutSchema>; schema: OutSchema } {
  const entries = Object.entries(spec);
  if (entries.length === 0) {
    throw new Error('cumulative() requires at least one column');
  }
  const targetSet = new Set(entries.map(([name]) => name));
  const outSchema = Object.freeze(
    schema.map((col, i) =>
      i === 0 || !targetSet.has(col.name)
        ? col
        : { ...col, kind: 'number' as const, required: false as const },
    ),
  ) as unknown as OutSchema;

  const n = store.length;
  let result = store as unknown as ColumnarStore<ColumnSchema>;
  for (const [name, reducer] of entries) {
    const col: Column = store.columns.get(name)!;
    const apply = buildApply(reducer);
    const out: (number | undefined)[] = new Array(n);
    let acc: number | undefined;
    for (let i = 0; i < n; i += 1) {
      const raw = col.read(i) as number | undefined;
      if (typeof raw === 'number') acc = apply(acc, raw);
      out[i] = acc;
    }
    result = withColumnReplaced(result, name, float64ColumnFromArray(out));
  }
  return {
    store: result as unknown as ColumnarStore<OutSchema>,
    schema: outSchema,
  };
}
