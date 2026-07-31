/**
 * **Columnar-JSON export** — the struct-of-arrays counterpart of
 * `ingestColumnsToStore`, and the plain-JSON sibling of `storeToArrow`.
 *
 * Two columnar doors out, for two different consumers:
 *
 * - {@link storeToColumns} (here) — one **plain array per column**, gaps as
 *   `null`. `JSON.stringify`-safe, so it is the wire shape for a columnar
 *   payload over HTTP / a WebSocket / `postMessage`, and it is exactly what
 *   the `fromColumns` door takes back.
 * - `storeToArrow` — the **buffers themselves**, zero-copy, for another
 *   columnar engine in the same process. No JSON, no per-cell walk.
 *
 * Reach for this one when the destination speaks JSON; reach for `toArrow`
 * when it speaks Arrow. A columnar payload is worth the trouble over row
 * tuples when the consumer is itself column-oriented, or when the numbers are
 * dense enough that N small arrays beat N×C-element rows on both size and
 * parse time.
 *
 * **Gaps are `null`, not `NaN`.** `JSON.stringify(NaN)` is `null` anyway (and
 * `Float64Array` stringifies to an object, not an array), so the conversion
 * has to happen somewhere; doing it here keeps the emitted payload honest
 * about what the ingest side will read back as missing.
 *
 * **Cost:** O(N) per column, no per-row allocation — C arrays for C columns,
 * against the N frozen tuples the row exports allocate.
 */
import type { ColumnarStore } from '../../columnar/index.js';
import { ValidationError } from '../../core/errors.js';
import type { ColumnValue } from '../../schema/index.js';
import { flatKeyNames } from './flat-keys.js';

/** One exported column: the cells in row order, `null` where the cell is a gap. */
export type JsonColumn = Array<ColumnValue | null>;

/**
 * Build the columnar-JSON view of a store: `{ [columnName]: values }`, the key
 * included under its own name(s) so the payload is self-contained.
 *
 * Store-generic — `TimeSeries.toColumns` and `ValueSeries.toColumns` are the
 * same walk over the same substrate — and **every key kind exports**. A point
 * key (`time` / `value`) is one column; a two-edged key flattens into extra
 * columns named off it (`timeRange` + `timeRangeEnd`, `interval` +
 * `intervalEnd` + `intervalLabel`), which is the same convention `storeToArrow`
 * emits and `ingestColumnsToStore` reads. See `./flat-keys.ts` for why the
 * flattened spelling rather than pairs.
 *
 * The payload's `schema` still declares the **logical** key
 * (`{ name: 'timeRange', kind: 'timeRange' }`), not the physical edges — so it
 * round-trips as the series' own schema, and the edge columns are decoded from
 * it rather than described by it.
 */
export function storeToColumns(
  store: ColumnarStore,
): Record<string, JsonColumn> {
  const keys = store.keys;
  const keyDef = store.schema[0]!;
  const keyNames = flatKeyNames(keyDef);
  const count = store.length;
  const out: Record<string, JsonColumn> = {};

  // Key edges: always defined (every key column rejects non-finite cells at
  // construction), so no validity walk and no `null` case.
  out[keyNames.begin] = edgeColumn(keys.begin, count);
  if (keyNames.end !== undefined) {
    out[keyNames.end] = edgeColumn(keys.end, count);
  }
  if (keyNames.label !== undefined) {
    // An interval's labels are a real column (dict-encoded strings or a
    // numeric buffer), so they read like any other — but they are part of the
    // key's identity, never a gap.
    const labels = (
      keys as { labels: { read(i: number): ColumnValue | undefined } }
    ).labels;
    const values = new Array<ColumnValue | null>(count);
    for (let i = 0; i < count; i += 1) values[i] = labels.read(i) ?? null;
    out[keyNames.label] = values;
  }

  for (let c = 1; c < store.schema.length; c += 1) {
    const name = store.schema[c]!.name;
    const column = store.columns.get(name);
    if (column === undefined) {
      // Unreachable via the public doors — `ColumnarStore.fromTrustedStore`
      // rejects a schema column with no matching column at construction.
      throw new ValidationError(`toColumns: column '${name}' not found`);
    }
    const values = new Array<ColumnValue | null>(count);
    for (let i = 0; i < count; i += 1) {
      const value = column.read(i);
      values[i] = value === undefined ? null : value;
    }
    out[name] = values;
  }

  return out;
}

/** One key edge as a plain array — trimmed to the store's logical length. */
function edgeColumn(edge: Float64Array, count: number): JsonColumn {
  const values = new Array<ColumnValue | null>(count);
  for (let i = 0; i < count; i += 1) values[i] = edge[i]!;
  return values;
}
