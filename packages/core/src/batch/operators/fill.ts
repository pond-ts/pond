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
import type { FillStrategy } from '../../schema/reshape.js';
import type { ScalarValue, SeriesSchema } from '../../schema/index.js';

/**
 * A fill strategy resolved to its operator-ready form: a built-in
 * strategy keyword, or a literal value to place in every gap cell.
 * (The method resolves the public `FillStrategy | FillMapping` input
 * into a per-column map of these before delegating.)
 */
export type ResolvedFillSpec =
  | { mode: FillStrategy }
  | { mode: 'literal'; value: ScalarValue };

/** Does `value`'s runtime type match the column's declared kind? */
function valueMatchesKind(value: unknown, kind: string): boolean {
  switch (kind) {
    case 'number':
      return typeof value === 'number';
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    default:
      return false;
  }
}

/** Rebuilds a filled value array into a column of the given kind. */
function buildFilledColumn(kind: string, values: unknown[]): Column {
  switch (kind) {
    case 'number':
      return float64ColumnFromArray(values as (number | undefined)[]);
    case 'string':
      return stringColumnFromArray(values as (string | undefined)[]);
    case 'boolean':
      return booleanColumnFromArray(values as (boolean | undefined)[]);
    case 'array':
      // ArrayValue cells; the cast is the kind dispatch's trust point.
      return arrayColumnFromArray(values as never);
    default:
      throw new TypeError(`fill: unsupported column kind '${kind}'`);
  }
}

/**
 * **Step 4 — column-native `fill` (extracted operator).** Gap-fills
 * value columns straight off the columnar store: read each target's
 * cells (storage-agnostic `read(i)`), walk contiguous `undefined`
 * runs, apply the per-column strategy, and replace only the columns
 * that actually changed — no `series.events` materialization, no
 * per-row `Event`. Untouched columns + the key axis pass through by
 * reference.
 *
 * Matches the row path's semantics exactly:
 * - **Gap walk.** Each maximal run of `undefined` cells is one gap.
 *   `linear` needs both neighbors, `hold` needs a left neighbor,
 *   `bfill` needs a right neighbor; `zero` / `literal` need none. A
 *   gap missing its required neighbor is left unfilled.
 * - **`limit` / `maxGap`** are all-or-nothing per gap: a gap longer
 *   than `limit` cells, or whose temporal span exceeds `maxGap` ms,
 *   is skipped entirely. The span uses both neighbors for interior
 *   gaps, the available neighbor + the gap edge for edge gaps.
 * - **Strategies.** `hold` carries the left value, `bfill` the right;
 *   `zero` writes 0; `literal` writes the supplied value; `linear`
 *   interpolates by time (`tspan === 0` ⇒ the left value). `zero` and
 *   `linear` are **numeric-only** — on a non-numeric column they
 *   silently skip (the column is left untouched, not rebuilt).
 *
 * Unlike the numeric folds (`cumulative`, `diff`), `fill` preserves
 * each column's **kind** — `hold` / `bfill` / `literal` apply to any
 * kind — so a changed column is rebuilt with the kind-appropriate
 * builder (`buildFilledColumn`). A `literal` whose runtime type
 * doesn't match the column kind throws when it would be placed
 * (gap-dependent, matching the old path where the kind-broken cell
 * surfaced as a `SeriesStore` construction error) — with a clearer,
 * column-named message here.
 *
 * The schema is unchanged (fill never widens or drops); the cast is
 * the single trust boundary, and the `TimeSeries.fill` method wraps
 * the store via `#fromTrustedStore`.
 */
export function fillOp<S extends SeriesSchema>(
  store: ColumnarStore<S>,
  schema: S,
  specs: ReadonlyMap<string, ResolvedFillSpec>,
  limit: number | undefined,
  maxGapMs: number | undefined,
): { store: ColumnarStore<S>; schema: S } {
  const n = store.length;
  if (n === 0 || specs.size === 0) {
    return { store, schema };
  }

  const colKind = new Map<string, string>();
  for (let i = 1; i < schema.length; i += 1) {
    colKind.set(schema[i]!.name, schema[i]!.kind);
  }

  // Times are needed only for `linear` and `maxGap`; build once, lazily.
  let times: number[] | undefined;
  const getTimes = (): number[] => {
    if (times === undefined) {
      times = new Array<number>(n);
      for (let i = 0; i < n; i += 1) times[i] = store.beginAt(i);
    }
    return times;
  };

  let result = store as unknown as ColumnarStore<ColumnSchema>;
  for (const [name, spec] of specs) {
    const col = store.columns.get(name);
    if (col === undefined) continue;
    const kind = colKind.get(name)!;
    // `zero` / `linear` are numeric-only: skip non-numeric columns
    // entirely (leave the original column, no rebuild).
    if ((spec.mode === 'zero' || spec.mode === 'linear') && kind !== 'number') {
      continue;
    }

    const values = new Array<unknown>(n);
    for (let i = 0; i < n; i += 1) values[i] = col.read(i);

    let changed = false;
    let i = 0;
    while (i < n) {
      if (values[i] !== undefined) {
        i += 1;
        continue;
      }
      const start = i;
      while (i < n && values[i] === undefined) i += 1;
      const end = i; // exclusive
      const length = end - start;
      const hasPrev = start > 0;
      const hasNext = end < n;

      let strategyOk: boolean;
      switch (spec.mode) {
        case 'linear':
          strategyOk = hasPrev && hasNext;
          break;
        case 'hold':
          strategyOk = hasPrev;
          break;
        case 'bfill':
          strategyOk = hasNext;
          break;
        default:
          strategyOk = true; // zero, literal
      }
      if (!strategyOk) continue;

      if (limit !== undefined && length > limit) continue;
      if (maxGapMs !== undefined) {
        const t = getTimes();
        let span: number;
        if (hasPrev && hasNext) {
          span = t[end]! - t[start - 1]!;
        } else if (hasPrev) {
          span = t[end - 1]! - t[start - 1]!;
        } else if (hasNext) {
          span = t[end]! - t[start]!;
        } else {
          span = 0;
        }
        if (span > maxGapMs) continue;
      }

      switch (spec.mode) {
        case 'hold': {
          const v = values[start - 1];
          for (let j = start; j < end; j += 1) values[j] = v;
          changed = true;
          break;
        }
        case 'bfill': {
          const v = values[end];
          for (let j = start; j < end; j += 1) values[j] = v;
          changed = true;
          break;
        }
        case 'zero': {
          for (let j = start; j < end; j += 1) values[j] = 0;
          changed = true;
          break;
        }
        case 'literal': {
          // Gap-dependent kind check: throws exactly when a kind-broken
          // literal would be placed (matching the old SeriesStore-intake
          // error), with a clearer column-named message.
          if (!valueMatchesKind(spec.value, kind)) {
            throw new RangeError(
              `fill: literal value ${JSON.stringify(spec.value)} for column '${name}' does not match its kind '${kind}'`,
            );
          }
          for (let j = start; j < end; j += 1) values[j] = spec.value;
          changed = true;
          break;
        }
        case 'linear': {
          const before = values[start - 1] as number;
          const after = values[end] as number;
          const t = getTimes();
          const t0 = t[start - 1]!;
          const t1 = t[end]!;
          const tspan = t1 - t0;
          for (let j = start; j < end; j += 1) {
            values[j] =
              tspan === 0
                ? before
                : before + (after - before) * ((t[j]! - t0) / tspan);
          }
          changed = true;
          break;
        }
      }
    }

    if (changed) {
      result = withColumnReplaced(
        result,
        name,
        buildFilledColumn(kind, values),
      );
    }
  }

  return { store: result as unknown as ColumnarStore<S>, schema };
}
