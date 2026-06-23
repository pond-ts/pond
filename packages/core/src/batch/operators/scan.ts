import {
  type Column,
  type ColumnarStore,
  type ColumnSchema,
  float64ColumnFromArray,
  withColumnAppended,
  withColumnReplaced,
} from '../../columnar/index.js';
import type { SeriesSchema } from '../../schema/index.js';

/**
 * The step function for {@link TimeSeries.scan} — the classic `mapAccumL`:
 * given the carried accumulator, the current (defined) source value, and the
 * row index, return the next accumulator and this row's numeric output. The
 * accumulator type `A` is **decoupled** from the numeric output, which is what
 * `cumulative` — where the accumulator *is* the output *is* a `number` — cannot
 * express (e.g. hysteresis elevation gain carries `(ref, gain)` but emits only
 * `gain`).
 */
export type ScanStep<A> = (
  acc: A,
  value: number,
  index: number,
) => readonly [next: A, output: number];

/**
 * **Column-native `scan`** — a typed-accumulator running fold, the
 * generalization of `cumulativeOp`. Threads `acc: A` (any value, seeded from
 * `init`) across the source column's defined cells, emits one numeric `output`
 * per row, and either **replaces** the source column (`output === undefined`,
 * `cumulative`'s convention) or **appends** a new column (`output` named,
 * `withColumn`'s convention; the source stays intact). Reads straight off
 * `Column.read(i)` — no event materialization, one pass, **O(n)**.
 *
 * Semantics are inherited from `cumulativeOp` so `scan` is consistent, not a
 * new dialect:
 * - A **defined numeric cell** calls `step(acc, value, i)`; the accumulator and
 *   the last-emitted output both advance.
 * - A **missing / undefined cell** does *not* call `step`: the accumulator is
 *   carried unchanged and the row re-emits the last output, so the output holds
 *   flat across a gap (exactly as `cumulative`'s accumulator holds). The output
 *   is `undefined` only until the first defined value produces one
 *   (`float64ColumnFromArray` derives validity from the `undefined`s).
 * - A **stored `NaN`** is a defined number — `step` is called with it, and a
 *   computed non-finite output lands as a defined cell. This is the
 *   *trusted-compute* path (matching `cumulative`), not the validated
 *   `withColumn` intake; the step author owns output finiteness.
 *
 * Returns the reshaped store + the output schema. The result-schema cast is the
 * single trust boundary; `TimeSeries.scan` wraps the store via
 * `#fromTrustedStore`. A non-numeric source is unreachable through the typed
 * surface (`scan<Source extends NumericColumnNameForSchema<S>>`); on the
 * replace path it fails fast (`withColumnReplaced`'s kind guard), matching
 * `cumulative`.
 */
export function scanOp<
  S extends SeriesSchema,
  OutSchema extends SeriesSchema,
  A,
>(
  store: ColumnarStore<S>,
  schema: S,
  source: string,
  step: ScanStep<A>,
  init: A,
  output: string | undefined,
): { store: ColumnarStore<OutSchema>; schema: OutSchema } {
  const col: Column | undefined = store.columns.get(source);
  if (col === undefined) {
    throw new RangeError(`scan: unknown column '${source}'`);
  }

  const n = store.length;
  const out: (number | undefined)[] = new Array(n);
  let acc = init;
  let last: number | undefined;
  for (let i = 0; i < n; i += 1) {
    const raw = col.read(i) as number | undefined;
    if (typeof raw === 'number') {
      const r = step(acc, raw, i);
      acc = r[0];
      last = r[1];
    }
    out[i] = last;
  }
  const column = float64ColumnFromArray(out);
  const base = store as unknown as ColumnarStore<ColumnSchema>;

  // Output omitted ⇒ replace the source column in place (cumulative's
  // convention; the source is widened to optional `number`).
  if (output === undefined) {
    const result = withColumnReplaced(base, source, column);
    const outSchema = Object.freeze(
      schema.map((c, i) =>
        i === 0 || c.name !== source
          ? c
          : { ...c, kind: 'number' as const, required: false as const },
      ),
    ) as unknown as OutSchema;
    return {
      store: result as unknown as ColumnarStore<OutSchema>,
      schema: outSchema,
    };
  }

  // Output named ⇒ append a new column, leaving the source intact. The name
  // must not collide with the key or an existing value column (the schema
  // includes the key at index 0). `withColumnAppended` re-checks, but the
  // explicit guard gives a scan-specific message pointing at the replace path.
  if (schema.some((c) => c.name === output)) {
    throw new RangeError(
      `scan: output column '${output}' already exists; omit options.output to replace the source column`,
    );
  }
  const result = withColumnAppended(base, output, column);
  const outSchema = Object.freeze([
    ...schema,
    { name: output, kind: 'number' as const },
  ]) as unknown as OutSchema;
  return {
    store: result as unknown as ColumnarStore<OutSchema>,
    schema: outSchema,
  };
}
