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

/** One exported column: the cells in row order, `null` where the cell is a gap. */
export type JsonColumn = Array<ColumnValue | null>;

/**
 * Build the columnar-JSON view of a store: `{ [columnName]: values }`, the key
 * column included under its own name so the payload is self-contained.
 *
 * Store-generic — `TimeSeries.toColumns` and `ValueSeries.toColumns` are the
 * same walk over the same substrate — but **single-edge keys only** (`time` /
 * `value`), which are one number per row and need no naming decision.
 *
 * A two-edged key (`timeRange` / `interval`) throws. It *could* flatten into
 * synthesized `<key>End` / `<key>Label` columns the way `storeToArrow` does,
 * and that shape was considered; it was rejected because **no ingest door
 * reads it back**. `fromColumns` builds one key buffer from one column, so a
 * flattened payload would be an export-only dialect — and this door's whole
 * value is that its output is `fromColumns`' input. Two other candidate
 * spellings (an array-of-pairs key column, and reusing `serializeJsonKey`'s
 * row vocabulary) were rejected for the same reason. The error names the two
 * ways out, both of which exist today. (Only the `TimeSeries` door can reach
 * that error — a `ValueSeries`' key is always the single-edge `'value'` axis —
 * which is why the message may safely name `asTime`.)
 */
export function storeToColumns(
  store: ColumnarStore,
): Record<string, JsonColumn> {
  const keys = store.keys;
  const keyName = store.schema[0]!.name;
  if (keys.kind !== 'time' && keys.kind !== 'value') {
    throw new ValidationError(
      `toColumns: the '${keys.kind}' key spans two edges, and no columnar ` +
        `ingest door reads such a key back — collapse it first ` +
        `(series.asTime({ at: 'begin' })), or use toJSON(), whose row envelope ` +
        `does carry range and interval keys`,
    );
  }

  const count = store.length;
  const out: Record<string, JsonColumn> = {};

  // The key: always defined (both key kinds reject non-finite cells at
  // construction), so no validity walk and no `null` case.
  const axis = keys.begin;
  const keyValues = new Array<ColumnValue | null>(count);
  for (let i = 0; i < count; i += 1) keyValues[i] = axis[i]!;
  out[keyName] = keyValues;

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
