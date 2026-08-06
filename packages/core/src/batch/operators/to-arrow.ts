import {
  bitmapByteCount,
  BooleanColumn,
  ChunkedBooleanColumn,
  ChunkedFloat64Column,
  ChunkedStringColumn,
  type Column as ColumnarColumn,
  Float64Column,
  materializeChunkedBoolean,
  materializeChunkedFloat64,
  materializeChunkedString,
  StringColumn,
} from '../../columnar/index.js';
import type { ColumnarStore } from '../../columnar/index.js';
import { ValidationError } from '../../core/errors.js';
import { KEY_END_SUFFIX, KEY_LABEL_SUFFIX } from './flat-keys.js';

/**
 * Zero-copy **export** to the Apache Arrow memory layout — the counterpart of
 * `fromArrow`, and the other half of [PND-TOARROW].
 *
 * ## Why this is a buffer handoff and not a conversion
 *
 * pond's columnar substrate is already Arrow-shaped, which is the whole
 * point of this door:
 *
 * - the **validity bitmap** is `bits[i >> 3] & (1 << (i & 7))` — LSB-first,
 *   one bit per value, a set bit meaning valid. That is Arrow's validity
 *   layout exactly.
 * - a **numeric column** is a contiguous `Float64Array` → Arrow `Float64`.
 * - a **boolean column** is a packed bitmap, same convention → Arrow `Bool`.
 * - a **dict-encoded string column** is `Int32Array` indices plus a string
 *   dictionary → Arrow `Dictionary<Int32, Utf8>`.
 *
 * So `toArrow` hands back the buffers pond is already holding. Nothing is
 * copied, reshaped, or re-encoded.
 *
 * ## Why it returns buffers rather than an Arrow `Table`
 *
 * For the same reason `fromArrow` takes a duck-typed table: **pond does not
 * depend on `apache-arrow`**, and adding a dependency to hand data *out*
 * would be a strange price for interop. The caller brings their own Arrow
 * and assembles per field, narrowing on `type` first (the union means
 * `f.values` doesn't typecheck against `makeData`'s `data:` unnarrowed):
 *
 * ```ts
 * import { makeData, makeVector, Float64 } from 'apache-arrow';
 * const { fields } = series.toArrow();
 * const f = fields.find((x) => x.name === 'close')!;
 * if (f.type !== 'float64' && f.type !== 'timestamp') throw new Error(f.type);
 * const vec = makeVector(
 *   makeData({
 *     type: new Float64(),
 *     length: f.length,
 *     nullCount: f.nullCount,
 *     nullBitmap: f.nullBitmap,
 *     data: f.values, // narrowed to Float64Array by the guard above
 *   }),
 * );
 * ```
 *
 * From there a consumer can reach whatever engine they like — polars,
 * DuckDB, arrow-js — for work pond does not do well. Measured motivation:
 * polars is 4–9× faster on whole-column reductions. This makes that
 * reachable without pond depending on any of it, and without the user
 * paying a re-ingest to get there. See
 * `docs/notes/polars-as-core-assessment-2026-07.md`.
 *
 * ## The aliasing contract
 *
 * **The returned buffers are pond's live storage, not copies.** Writing to
 * one corrupts the series it came from — a `TimeSeries` is immutable by
 * contract, not by defensive cloning. This is the same read-only contract
 * `column(name)`, `keyColumn()` and `toFloat64Array()` already carry;
 * `toArrow` does not weaken it, but it does hand the buffers to another
 * library, so it is worth restating. Copy first (`new Float64Array(values)`)
 * if the consumer mutates in place.
 */

/** Arrow type a pond column's buffers are already laid out for. */
export type ArrowExportType =
  | 'float64'
  | 'timestamp'
  | 'bool'
  | 'utf8'
  | 'dictionary';

interface ArrowExportFieldBase {
  readonly name: string;
  readonly length: number;
  /** Slots the bitmap marks invalid. `0` ⇒ `nullBitmap` is absent. */
  readonly nullCount: number;
  /**
   * LSB-first validity bitmap, one bit per slot, 1 = valid — Arrow's
   * `nullBitmap` with no translation. Absent when every slot is valid
   * (pond's "all defined ⇒ no bitmap" convention, which Arrow also allows).
   */
  readonly nullBitmap?: Uint8Array;
}

/**
 * One exported column. Discriminated by `type` so the values buffer is
 * correctly typed per Arrow type rather than a loose union.
 */
export type ArrowExportField =
  | (ArrowExportFieldBase & {
      /**
       * `'timestamp'` marks a key edge: the values are **epoch milliseconds
       * held as `f64`**, not int64. Arrow's `Timestamp` is int64, so a
       * consumer who wants a true temporal column converts — the buffer is
       * handed over as `Float64Array` because that is what pond holds and
       * converting would cost the copy this door exists to avoid.
       */
      readonly type: 'float64' | 'timestamp';
      readonly values: Float64Array;
    })
  | (ArrowExportFieldBase & {
      /** Packed bits, LSB-first, 1 = true — Arrow `Bool` as-is. */
      readonly type: 'bool';
      readonly values: Uint8Array;
    })
  | (ArrowExportFieldBase & {
      /**
       * The one shape that is **not** zero-copy: a string column pond chose
       * not to dictionary-encode is a plain array of JS strings, and Arrow
       * `Utf8` wants offsets into a UTF-8 byte buffer. The array is handed
       * over as-is; building the Arrow buffers is the consumer's encode.
       */
      readonly type: 'utf8';
      readonly values: ReadonlyArray<string | null>;
    })
  | (ArrowExportFieldBase & {
      /** Arrow `Dictionary<Int32, Utf8>` — indices zero-copy. */
      readonly type: 'dictionary';
      readonly values: Int32Array;
      readonly dictionary: ReadonlyArray<string>;
    });

export interface ArrowExport {
  /** Row count. Every field has this `length`. */
  readonly length: number;
  /** Key edge(s) first, then value columns in schema order. */
  readonly fields: readonly ArrowExportField[];
}

/** Options for {@link TimeSeries.toArrow}. */
export interface ToArrowOptions {
  /**
   * Value columns to export, in this order. Default: every value column, in
   * schema order. The key field(s) are always included — without them the
   * rows have nothing to line up against.
   */
  columns?: readonly string[];
}

// The suffixes a two-edged key's fields take. Imported, not redeclared:
// `fromColumns` / `toColumns` / `fromArrow` read the same two constants, so
// the four doors cannot drift into speaking different dialects of the same
// convention. See `./flat-keys.ts`.
const END_SUFFIX = KEY_END_SUFFIX;
const LABEL_SUFFIX = KEY_LABEL_SUFFIX;

function nullCountOf(col: {
  length: number;
  validity?: { definedCount: number };
}): number {
  return col.validity === undefined
    ? 0
    : col.length - col.validity.definedCount;
}

/** The validity bitmap trimmed to the bytes this column's length needs. */
function bitmapOf(col: {
  length: number;
  validity?: { bits: Uint8Array };
}): Uint8Array | undefined {
  const bits = col.validity?.bits;
  if (bits === undefined) return undefined;
  const needed = bitmapByteCount(col.length);
  return bits.length === needed ? bits : bits.subarray(0, needed);
}

/** A `Float64Array` trimmed to `length` — capacity-grown columns over-allocate. */
function valuesOf(values: Float64Array, length: number): Float64Array {
  return values.length === length ? values : values.subarray(0, length);
}

function numericField(
  name: string,
  col: Float64Column,
  type: 'float64' | 'timestamp',
): ArrowExportField {
  const bitmap = bitmapOf(col);
  return {
    name,
    type,
    length: col.length,
    nullCount: nullCountOf(col),
    ...(bitmap === undefined ? {} : { nullBitmap: bitmap }),
    values: valuesOf(col._values, col.length),
  };
}

/** A key edge (`begin` / `end`) — always fully defined, so never a bitmap. */
function keyEdgeField(
  name: string,
  edge: Float64Array,
  length: number,
  type: 'float64' | 'timestamp',
): ArrowExportField {
  return { name, type, length, nullCount: 0, values: valuesOf(edge, length) };
}

function stringField(name: string, col: StringColumn): ArrowExportField {
  const bitmap = bitmapOf(col);
  const base = {
    name,
    length: col.length,
    nullCount: nullCountOf(col),
    ...(bitmap === undefined ? {} : { nullBitmap: bitmap }),
  };
  if (col.indices !== undefined && col.dictionary !== undefined) {
    return {
      ...base,
      type: 'dictionary',
      values: col.indices,
      dictionary: col.dictionary,
    };
  }
  // Fallback storage: a plain array. `undefined` (a gap) becomes `null`,
  // which is what an Arrow consumer expects alongside the bitmap.
  const fallback = col.fallback ?? [];
  const values = new Array<string | null>(col.length);
  for (let i = 0; i < col.length; i += 1) values[i] = fallback[i] ?? null;
  return { ...base, type: 'utf8', values };
}

function booleanField(name: string, col: BooleanColumn): ArrowExportField {
  const bitmap = bitmapOf(col);
  const needed = bitmapByteCount(col.length);
  return {
    name,
    type: 'bool',
    length: col.length,
    nullCount: nullCountOf(col),
    ...(bitmap === undefined ? {} : { nullBitmap: bitmap }),
    values:
      col.values.length === needed
        ? col.values
        : col.values.subarray(0, needed),
  };
}

/**
 * Materialize a chunked column into its packed form. **The one copy this
 * door makes**, and unavoidable: chunked storage is several buffers, and
 * an Arrow field is one. Named here so the cost is visible rather than
 * hidden behind "zero-copy".
 */
function packed(col: ColumnarColumn): ColumnarColumn {
  if (col instanceof ChunkedFloat64Column)
    return materializeChunkedFloat64(col);
  if (col instanceof ChunkedStringColumn) return materializeChunkedString(col);
  if (col instanceof ChunkedBooleanColumn)
    return materializeChunkedBoolean(col);
  return col;
}

function valueField(name: string, raw: ColumnarColumn): ArrowExportField {
  const col = packed(raw);
  if (col instanceof Float64Column) return numericField(name, col, 'float64');
  if (col instanceof StringColumn) return stringField(name, col);
  if (col instanceof BooleanColumn) return booleanField(name, col);
  throw new ValidationError(
    `toArrow: column '${name}' is a '${col.kind}' column — toArrow supports ` +
      `'number', 'string' and 'boolean' columns; drop it or select a ` +
      `supported subset via { columns: [...] }`,
  );
}

/**
 * Build the Arrow-layout view of a store. Kept out of the class so the
 * conversion is unit-testable without it, mirroring `arrowToColumns`.
 */
export function storeToArrow(
  store: ColumnarStore,
  options: ToArrowOptions = {},
): ArrowExport {
  const keys = store.keys;
  const keyName = store.schema[0]!.name;
  const length = store.length;
  const fields: ArrowExportField[] = [];

  // Key edges. A `time` / `value` key is one field; a `timeRange` or
  // `interval` key is two, because Arrow has no interval-of-time type.
  if (keys.kind === 'time' || keys.kind === 'value') {
    const type = keys.kind === 'time' ? 'timestamp' : 'float64';
    fields.push(keyEdgeField(keyName, keys.begin, length, type));
  } else {
    fields.push(keyEdgeField(keyName, keys.begin, length, 'timestamp'));
    fields.push(
      keyEdgeField(`${keyName}${END_SUFFIX}`, keys.end, length, 'timestamp'),
    );
  }

  const requested =
    options.columns ?? store.schema.slice(1).map((def) => def.name);

  // Every output field name must be unique. Arrow tolerates duplicate field
  // names and `getChild` then silently picks one — so a collision (with a
  // synthesized key-edge name, or a name simply requested twice) is an error
  // here, not a quirk there. `taken` grows as names are claimed, so a
  // duplicate `columns` entry is caught the same way a key clash is.
  const taken = new Set(fields.map((f) => f.name));
  for (const name of requested) {
    if (taken.has(name)) {
      throw new ValidationError(
        `toArrow: field name '${name}' would appear twice — it collides ` +
          `with a key field (a '${keys.kind}' key exports as '${keyName}'` +
          (keys.kind === 'time' || keys.kind === 'value'
            ? ''
            : ` + '${keyName}${END_SUFFIX}'`) +
          `) or with an earlier entry in { columns: [...] }`,
      );
    }
    taken.add(name);
  }

  for (const name of requested) {
    const col = store.columns.get(name);
    if (col === undefined) {
      throw new ValidationError(`toArrow: column '${name}' not found`);
    }
    fields.push(valueField(name, col));
  }

  // An interval key carries labels; they are part of the key's identity
  // (an `aggregate` result is the motivating case), so they ride along.
  // (`taken` already holds every exported name, so this also catches a
  // requested column called `<key>Label`. A schema column of that name that
  // was NOT requested doesn't collide — the output then has one field of
  // that name, the labels — but it is a confusing schema to export; the
  // error only fires when both would actually appear.)
  if (keys.kind === 'interval') {
    const labelName = `${keyName}${LABEL_SUFFIX}`;
    if (taken.has(labelName)) {
      throw new ValidationError(
        `toArrow: interval labels export as '${labelName}', which collides ` +
          `with an exported column of the same name — rename the column or ` +
          `select it out via { columns: [...] }`,
      );
    }
    fields.push(valueField(labelName, keys.labels));
  }

  return { length, fields };
}
