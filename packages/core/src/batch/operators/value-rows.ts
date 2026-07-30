/**
 * Row ↔ columnar conversion for `ValueSeries` — the row doors' engine room.
 *
 * `ValueSeries` has no `Event` layer (a value row is an `(axis, …values)`
 * tuple, not a `Time`-keyed `Event`), so its row doors can't reuse the
 * time-side `parseJsonRows` / `toRows` helpers, which mint `Time` / `TimeRange`
 * / `Interval` keys. What they *do* share is the strictness contract: every
 * defined value cell goes through the same {@link assertCellKind} the
 * time-keyed row intake uses, so "what a row door accepts" stays one fact
 * rather than two similar-looking copies (that function's own doc explains
 * why it is exported).
 *
 * Ingest transposes rows into `RawColumns` and hands off to the shared
 * columnar engine (`ingestColumnsToStore`) — one ingest engine for every
 * `ValueSeries` door, so `sort`, the monotonicity check, and the packing rules
 * are identical no matter which shape the data arrived in.
 *
 * **Cost.** Ingest is O(N·C) — one pass, one cell-kind check per cell, no
 * re-scan. Export is likewise O(N·C) with one array (or object) allocated per
 * row; the columnar exports below are O(N) per column with no per-row
 * allocation at all. See `scripts/perf-value-series-io.mjs`.
 */
import type { ColumnarStore, ValueKeyColumn } from '../../columnar/index.js';
import { ValidationError } from '../../core/errors.js';
import type { ColumnDef, ValueSeriesSchema } from '../../schema/index.js';
import { assertCellKind } from '../validate.js';
import type { RawColumns } from './ingest-columns.js';

/** A JSON-shape row in either accepted form. */
type AnyRow = ReadonlyArray<unknown> | Readonly<Record<string, unknown>>;

/**
 * Reads the cells of one row in schema order, whichever shape it arrived in.
 * A tuple row is returned as-is; an object row is read into `scratch`, one
 * array reused for every row rather than one allocated per row (the object
 * door is already the slower of the two — see the perf script — and there is
 * no reason for it to also be the allocating one).
 *
 * Object-row lookups go through `Object.hasOwn`, not a bare `record[name]`:
 * for a column named `toString` / `valueOf` / … a bare read walks
 * `Object.prototype` and picks up the inherited **function** for a row that
 * simply omits that key, turning "missing cell" into a confusing kind error.
 * (Same hazard `withColumnsRenamed` documents in `columnar/view.ts`.)
 */
function cellsOf(
  row: AnyRow,
  schema: ValueSeriesSchema,
  op: string,
  index: number,
  scratch: Array<unknown>,
): ReadonlyArray<unknown> {
  if (Array.isArray(row)) {
    if (row.length !== schema.length) {
      throw new ValidationError(
        `${op}: row ${index} expected ${schema.length} values, got ${row.length}`,
      );
    }
    return row;
  }
  if (typeof row !== 'object' || row === null) {
    throw new ValidationError(
      `${op}: row ${index} must be an array or an object keyed by column name`,
    );
  }
  const record = row as Readonly<Record<string, unknown>>;
  for (let c = 0; c < schema.length; c += 1) {
    const name = schema[c]!.name;
    scratch[c] = Object.hasOwn(record, name) ? record[name] : undefined;
  }
  return scratch;
}

/**
 * Transpose JSON-shape rows into the columnar payload the shared ingest engine
 * takes, validating as it goes.
 *
 * - **Axis cell** (position 0): must be a **finite number**. Unlike the
 *   time-keyed door there is no string parsing to fall back on — a value axis
 *   has no calendar to interpret `'2026-01-01'` against — so anything else is
 *   an error naming the row, not a silent `NaN`.
 * - **Value cells:** `null` and `undefined` both mean *missing*; a column
 *   declared `required` (the default) rejects them. Anything defined is
 *   checked against the declared kind by `assertCellKind`, so a non-finite
 *   number is **rejected** here rather than quietly becoming a gap — the row
 *   door is the strict one, exactly as on `TimeSeries.fromJSON`. (The columnar
 *   doors keep the looser "non-finite ⇒ gap" rule; that asymmetry is
 *   pre-existing and deliberate.)
 *
 * Ordering is **not** checked here — that (and `sort`) belongs to the shared
 * engine, so every door reports it the same way.
 */
export function valueRowsToColumns(
  op: string,
  schema: ValueSeriesSchema,
  rows: ReadonlyArray<AnyRow>,
): RawColumns {
  const width = schema.length;
  const count = rows.length;
  const axisName = schema[0]!.name;

  const axis = new Float64Array(count);
  const valueBufs: Array<Array<unknown>> = [];
  for (let c = 1; c < width; c += 1) valueBufs.push(new Array<unknown>(count));
  const scratch = new Array<unknown>(width);

  for (let i = 0; i < count; i += 1) {
    const cells = cellsOf(rows[i]!, schema, op, i, scratch);

    const rawAxis = cells[0];
    if (typeof rawAxis !== 'number' || !Number.isFinite(rawAxis)) {
      throw new ValidationError(
        `${op}: row ${i} axis '${axisName}' must be a finite number; got ` +
          `${describe(rawAxis)}`,
      );
    }
    axis[i] = rawAxis;

    for (let c = 1; c < width; c += 1) {
      const def = schema[c] as ColumnDef<string, string>;
      // `null` is the wire spelling of a gap; `undefined` is the JS one. Both
      // land as `undefined`, which `assertCellKind` passes and the engine
      // packs as missing.
      const value = cells[c] === null ? undefined : cells[c];
      if (value === undefined && def.required !== false) {
        throw new ValidationError(
          `${op}: row ${i} col ${c} (${def.name}) is required`,
        );
      }
      assertCellKind(def.kind, value, i, c);
      valueBufs[c - 1]![i] = value;
    }
  }

  const columns: RawColumns = { [axisName]: axis };
  for (let c = 1; c < width; c += 1) {
    columns[schema[c]!.name] = valueBufs[c - 1]! as RawColumns[string];
  }
  return columns;
}

/** Short, safe rendering of a rejected cell for an error message. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  return typeof value;
}

/**
 * The axis buffer of a value-keyed store. Read straight off the key column
 * rather than through `beginAt(i)` so the export loops below stay a typed-array
 * index rather than a method call per row.
 */
function axisOf(store: ColumnarStore): Float64Array {
  return (store.keys as ValueKeyColumn).begin;
}

/**
 * Export rows as tuples. `json: true` emits the wire spelling of a gap
 * (`null`); otherwise gaps stay `undefined` — the only difference between
 * `toJSON({ rowFormat: 'array' })` and `toRows()`, since a value axis needs no
 * key normalization on the way out.
 */
export function valueStoreToRows(
  schema: ValueSeriesSchema,
  store: ColumnarStore,
  json: boolean,
): ReadonlyArray<ReadonlyArray<unknown>> {
  const axis = axisOf(store);
  const count = store.length;
  const columns = valueColumnsOf(schema, store);
  const gap = json ? null : undefined;

  const out = new Array<ReadonlyArray<unknown>>(count);
  for (let i = 0; i < count; i += 1) {
    const row = new Array<unknown>(schema.length);
    row[0] = axis[i]!;
    for (let c = 0; c < columns.length; c += 1) {
      const value = columns[c]!.read(i);
      row[c + 1] = value === undefined ? gap : value;
    }
    out[i] = Object.freeze(row);
  }
  return out;
}

/** Export rows as objects keyed by column name. `json` as in {@link valueStoreToRows}. */
export function valueStoreToObjects(
  schema: ValueSeriesSchema,
  store: ColumnarStore,
  json: boolean,
): ReadonlyArray<Readonly<Record<string, unknown>>> {
  const axis = axisOf(store);
  const count = store.length;
  const columns = valueColumnsOf(schema, store);
  const names = schema.slice(1).map((def) => def.name);
  const gap = json ? null : undefined;

  const out = new Array<Readonly<Record<string, unknown>>>(count);
  for (let i = 0; i < count; i += 1) {
    const row: Record<string, unknown> = { [schema[0]!.name]: axis[i]! };
    for (let c = 0; c < columns.length; c += 1) {
      const value = columns[c]!.read(i);
      row[names[c]!] = value === undefined ? gap : value;
    }
    out[i] = Object.freeze(row);
  }
  return out;
}

/** The value columns in schema order — resolved once, outside the row loop. */
function valueColumnsOf(schema: ValueSeriesSchema, store: ColumnarStore) {
  const columns = [];
  for (let c = 1; c < schema.length; c += 1) {
    const name = schema[c]!.name;
    const column = store.columns.get(name);
    if (column === undefined) {
      // Unreachable through the public doors — `ColumnarStore.fromTrustedStore`
      // rejects a schema column with no matching column at construction.
      throw new ValidationError(`column '${name}' is not present in the store`);
    }
    columns.push(column);
  }
  return columns;
}
