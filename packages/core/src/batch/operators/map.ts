import {
  type Column,
  type ColumnarStore,
  type ColumnSchema,
  arrayColumnFromArray,
  booleanColumnFromArray,
  float64ColumnFromArray,
  stringColumnFromArray,
  withColumnReplaced,
} from '../../columnar/index.js';
import type { SeriesSchema } from '../../schema/index.js';

/**
 * A per-cell value transform: `(value) => newValue`, where the output
 * is the **same kind** as the input (number→number, string→string,
 * …). The `TimeSeries.mapColumns` method types each column's mapper
 * against that column's value type; the operator erases to
 * `(value: unknown) => unknown` at the trust boundary.
 */
export type ColumnMapper = (value: unknown) => unknown;

/**
 * Rebuilds a mapped value array into a column of the given kind.
 *
 * NB: this is the same kind→builder dispatch as `fillOp`'s
 * `buildFilledColumn`. Two callers now (fill + map) — a candidate for
 * a shared `columnFromValuesByKind` helper in a follow-up; kept local
 * here to keep this PR focused on the new operator.
 */
function columnFromValuesByKind(kind: string, values: unknown[]): Column {
  switch (kind) {
    case 'number':
      return float64ColumnFromArray(values as (number | undefined)[]);
    case 'string':
      return stringColumnFromArray(values as (string | undefined)[]);
    case 'boolean':
      return booleanColumnFromArray(values as (boolean | undefined)[]);
    case 'array':
      return arrayColumnFromArray(values as never);
    default:
      throw new TypeError(`mapColumns: unsupported column kind '${kind}'`);
  }
}

/**
 * **Step 4 — column-native `mapColumns` (extracted operator).** Applies
 * a per-cell value transform to one or more columns, straight off the
 * columnar store: read each target's cells (storage-agnostic
 * `read(i)`), apply the mapper to each **defined** value, rebuild the
 * column — no `series.events` materialization, no per-row `Event`.
 * Non-mapped columns + the key axis pass through by reference.
 *
 * Semantics:
 * - **Missing cells carry.** The mapper is called only on defined
 *   values; a missing (`undefined`) cell stays missing (the mapper is
 *   not invoked).
 * - **A non-finite numeric result is missing.** For a `number` column,
 *   a mapper result of `NaN` or `±Infinity` is stored as a **missing**
 *   cell (reads back `undefined`) — the rule that a non-finite number in
 *   a number column means missing ([PND-NANREP], see `Float64Column`).
 *   `float64ColumnFromArray` enforces it. (This used to throw a
 *   `RangeError`.) A source column never holds a non-finite value, so
 *   the mapper only ever sees finite numbers.
 * - **Same kind, schema-stable.** The mapper returns the column's own
 *   kind (the method's type enforces `(value: T) => T`), so the output
 *   column keeps its kind and the schema is unchanged. The result is
 *   rebuilt with the kind-appropriate builder.
 *
 * The schema is returned unchanged; the cast is the single trust
 * boundary, and the `TimeSeries.mapColumns` method wraps the store via
 * `#fromTrustedStore`.
 *
 * A mapper that — only by defeating the `(value: T) => T` type —
 * returns `undefined`, or a value of the wrong kind (e.g. a string
 * from a numeric mapper via an `as` cast), produces a cell the
 * same-kind builder can't store: `columnFromValuesByKind` coerces it
 * to missing, so the cell reads back as a gap the declared schema may
 * not advertise. Both are type-illegal inputs, not handled specially.
 */
export function mapOp<S extends SeriesSchema>(
  store: ColumnarStore<S>,
  schema: S,
  spec: ReadonlyMap<string, ColumnMapper>,
): { store: ColumnarStore<S>; schema: S } {
  const n = store.length;
  if (n === 0 || spec.size === 0) {
    return { store, schema };
  }

  const colKind = new Map<string, string>();
  for (let i = 1; i < schema.length; i += 1) {
    colKind.set(schema[i]!.name, schema[i]!.kind);
  }

  let result = store as unknown as ColumnarStore<ColumnSchema>;
  for (const [name, fn] of spec) {
    const col = store.columns.get(name);
    if (col === undefined) continue;
    const kind = colKind.get(name)!;
    const out = new Array<unknown>(n);
    for (let i = 0; i < n; i += 1) {
      const v = col.read(i);
      if (v === undefined) {
        out[i] = undefined;
        continue;
      }
      // A non-finite number result is stored as missing by the numeric
      // builder (`float64ColumnFromArray`) — no check needed here.
      const mapped = fn(v);
      out[i] = mapped;
    }
    result = withColumnReplaced(
      result,
      name,
      columnFromValuesByKind(kind, out),
    );
  }

  return { store: result as unknown as ColumnarStore<S>, schema };
}
