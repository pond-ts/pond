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
 * - **Numeric results must be finite.** For a `number` column, a mapper
 *   result of `NaN` or `±Infinity` throws a `RangeError` at write —
 *   matching construction intake (`assertCellKind`), which rejects
 *   non-finite numbers. This keeps packed numeric columns NaN-free, so
 *   the columnar fast-path and the row-path reducers can never diverge
 *   on the same bucket (the bug audit v2 §1.3 reproduced). A stored
 *   `NaN` *is* a defined value, so the mapper is still invoked on it —
 *   use that to clean it (map `NaN` to a finite number, or to
 *   `undefined` for a missing cell). (Array columns are not
 *   element-checked here; they don't feed the numeric reducers.)
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
 * (A non-finite *number* from a numeric mapper is the one same-kind
 * case that throws rather than coerces — it would corrupt the packed
 * column, not read back as a gap.)
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
    // Numeric columns reject a non-finite (NaN / ±Infinity) mapper result at
    // write, matching construction intake (assertCellKind). A packed NaN would
    // otherwise be unreachable-by-assumption for the reduce kernels and diverge
    // the fast path from the row path (audit v2 §1.3). Hoisted out of the loop
    // so non-numeric columns pay nothing.
    const rejectNonFinite = kind === 'number';
    const out = new Array<unknown>(n);
    for (let i = 0; i < n; i += 1) {
      const v = col.read(i);
      if (v === undefined) {
        out[i] = undefined;
        continue;
      }
      const mapped = fn(v);
      if (
        rejectNonFinite &&
        typeof mapped === 'number' &&
        !Number.isFinite(mapped)
      ) {
        throw new RangeError(
          `mapColumns: the mapper for column '${name}' returned a non-finite ` +
            `number (${mapped}) at row ${i}. Numeric columns reject NaN and ` +
            `±Infinity at write, consistent with intake — a packed NaN would ` +
            `diverge the fast-path and row-path reducers on the same data. ` +
            `Map to a finite number, or to undefined for a missing cell.`,
        );
      }
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
