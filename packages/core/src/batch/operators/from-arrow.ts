import { ValidationError } from '../../core/errors.js';
import type { SeriesSchema } from '../../schema/index.js';
import type { RawColumns } from './ingest-columns.js';

/**
 * Structural view of an Apache Arrow `Vector`. pond does **not** depend on
 * `apache-arrow` — the caller brings their own Arrow (`tableFromIPC(...)`) and
 * hands the decoded `Table` to {@link TimeSeries.fromArrow}. We duck-type the
 * small slice of the vector surface we read: the length, the null count, and
 * `toArray()` (which for a contiguous numeric column returns the backing typed
 * array — the zero-copy handoff pond adopts).
 */
export interface ArrowVectorLike {
  readonly length: number;
  /** Number of null slots; `0` unlocks the fast (validity-free) path. */
  readonly nullCount: number;
  /**
   * Backing values. For a single-chunk numeric column this is the typed array
   * itself (`Float64Array`, `Int32Array`, `BigInt64Array`, …), adopted where
   * possible; for a string column (Arrow `Utf8`) it is a plain `Array` of
   * strings. Any other shape (list/struct) is rejected by
   * {@link TimeSeries.fromArrow}.
   */
  toArray(): unknown;
  /** Per-slot access, used only on the (rare) null-containing slow path. */
  get(index: number): number | bigint | null | undefined;
}

/** Structural view of an Arrow `Field` (`schema.fields[i]`). */
export interface ArrowFieldLike {
  readonly name: string;
  /**
   * The field's `DataType`. We read `unit` when present (Arrow `Timestamp`
   * types carry a `TimeUnit`) to scale the time column to milliseconds; every
   * other type detail is inferred from the typed array `toArray()` returns.
   */
  readonly type: { readonly unit?: number } & Record<string, unknown>;
}

/** Structural view of an Arrow `Schema`. */
export interface ArrowSchemaLike {
  readonly fields: ReadonlyArray<ArrowFieldLike>;
}

/** Structural view of an Arrow `Table` — the input to {@link TimeSeries.fromArrow}. */
export interface ArrowTableLike {
  readonly numRows: number;
  readonly schema: ArrowSchemaLike;
  getChild(name: string): ArrowVectorLike | null | undefined;
}

/** Options for {@link TimeSeries.fromArrow}. */
export interface FromArrowOptions {
  /** Series name. Default `'arrow'`. */
  name?: string;
  /**
   * Which Arrow column is the time key. Default: the field named `'time'`.
   * Throws if neither `time` is given nor a `'time'` field exists.
   */
  time?: string;
  /**
   * Unit of the time column's raw integer values. Default: read from the Arrow
   * `Timestamp` field's `TimeUnit` when present, otherwise `'millisecond'`.
   * An explicit value here always wins over the field's declared unit.
   */
  timeUnit?: ArrowTimeUnit;
  /**
   * Value columns to include, in order. Default: every non-time field. Each
   * must be numeric (→ `Float64Column`) or a string column (→ `StringColumn`);
   * any other Arrow type (list/struct/…) throws, naming it. Pass this to select
   * a supported subset out of a mixed table.
   */
  columns?: readonly string[];
  /**
   * Sort rows by time key before construction (off by default — Arrow feeds
   * are usually already time-ordered). Forwarded to `fromColumns`; disables
   * zero-copy adoption when set (rows are permuted into fresh buffers).
   */
  sort?: boolean;
}

export type ArrowTimeUnit =
  | 'second'
  | 'millisecond'
  | 'microsecond'
  | 'nanosecond';

// Arrow's `TimeUnit` enum, keyed by its wire ordinal (unit read off a
// `Timestamp` DataType). SECOND=0, MILLISECOND=1, MICROSECOND=2, NANOSECOND=3.
const TIME_UNIT_BY_ORDINAL: Record<number, ArrowTimeUnit> = {
  0: 'second',
  1: 'millisecond',
  2: 'microsecond',
  3: 'nanosecond',
};

// Multiplier taking one raw unit to milliseconds (pond's `Time` key is epoch
// ms). Nanoseconds divide by 1e6, so sub-ms precision below the double's
// integer range is discarded — expected at ms resolution.
const MS_SCALE: Record<ArrowTimeUnit, number> = {
  second: 1000,
  millisecond: 1,
  microsecond: 1 / 1000,
  nanosecond: 1 / 1_000_000,
};

const TWO_POW_32 = 4294967296;

/**
 * Numeric typed-array constructors Arrow's `toArray()` can hand back. A
 * `BigInt64Array` / `BigUint64Array` is numeric but needs the BigInt-free
 * recombination; the rest are plain-number typed arrays.
 */
function isBigIntArray(
  value: unknown,
): value is BigInt64Array | BigUint64Array {
  return value instanceof BigInt64Array || value instanceof BigUint64Array;
}

function isNumberTypedArray(
  value: unknown,
): value is
  | Float64Array
  | Float32Array
  | Int32Array
  | Int16Array
  | Int8Array
  | Uint32Array
  | Uint16Array
  | Uint8Array
  | Uint8ClampedArray {
  return (
    value instanceof Float64Array ||
    value instanceof Float32Array ||
    value instanceof Int32Array ||
    value instanceof Int16Array ||
    value instanceof Int8Array ||
    value instanceof Uint32Array ||
    value instanceof Uint16Array ||
    value instanceof Uint8Array ||
    value instanceof Uint8ClampedArray
  );
}

/**
 * Convert an int64 column to `Float64Array` **without BigInt**. Arrow stores
 * int64 little-endian; we alias the buffer as `Int32Array` and recombine each
 * pair `hi * 2^32 + (lo >>> 0)` — exact for the ±2^53 range that covers every
 * realistic epoch timestamp (ms ≈ 1.7e12, µs ≈ 1.7e15). This is the ~30ms
 * `Number(bigint)` ×N cost the fromArrow note called out, reclaimed: the
 * per-element work is two array reads and a multiply-add, no BigInt boxing.
 *
 * (Little-endian assumption matches Arrow IPC and every platform Node runs on;
 * `hi` stays signed so pre-epoch timestamps recombine correctly.)
 */
function int64ToFloat64(
  source: BigInt64Array | BigUint64Array,
  scale: number,
): Float64Array {
  const count = source.length;
  const out = new Float64Array(count);
  const halves = new Int32Array(source.buffer, source.byteOffset, count * 2);
  if (scale === 1) {
    for (let j = 0; j < count; j += 1) {
      const lo = halves[j * 2]! >>> 0;
      const hi = halves[j * 2 + 1]!;
      out[j] = hi * TWO_POW_32 + lo;
    }
  } else {
    for (let j = 0; j < count; j += 1) {
      const lo = halves[j * 2]! >>> 0;
      const hi = halves[j * 2 + 1]!;
      out[j] = (hi * TWO_POW_32 + lo) * scale;
    }
  }
  return out;
}

/** A read value column, tagged with the pond kind its data maps to. */
type ReadColumn =
  | { kind: 'number'; values: Float64Array }
  | { kind: 'string'; values: Array<string | null> };

/** Read a numeric column carrying nulls, mapping null → `NaN` (missing). */
function numericWithNulls(vector: ArrowVectorLike): Float64Array {
  const count = vector.length;
  const out = new Float64Array(count);
  for (let j = 0; j < count; j += 1) {
    const v = vector.get(j);
    out[j] = v == null ? NaN : Number(v);
  }
  return out;
}

/** Copy a string column's `toArray()`, mapping null/undefined → missing. */
function readStrings(
  raw: ReadonlyArray<unknown>,
  name: string,
): Array<string | null> {
  const out = new Array<string | null>(raw.length);
  for (let j = 0; j < raw.length; j += 1) {
    const v = raw[j];
    if (v == null) out[j] = null;
    else if (typeof v === 'string') out[j] = v;
    else
      throw new ValidationError(
        `fromArrow: column '${name}' has a non-string value at index ${j} — ` +
          `fromArrow supports 'number' and 'string' columns`,
      );
  }
  return out;
}

/**
 * Read one value column, inferring its pond kind from what `toArray()` hands
 * back. Numeric fast paths: `Float64Array` adopted as-is (zero copy), other
 * number typed arrays copy through the `Float64Array` constructor (no map fn —
 * stays off V8's slow iterable path), int64 recombines BigInt-free; a numeric
 * column carrying nulls takes the per-element `get()` path (null → `NaN`). A
 * plain `Array` is a string column (Arrow `Utf8`/`LargeUtf8`) → `StringColumn`
 * downstream, dict-encoded when it pays. Anything else (a list/struct vector)
 * throws, naming the column.
 */
function readColumn(vector: ArrowVectorLike, name: string): ReadColumn {
  const raw = vector.toArray();
  if (isNumberTypedArray(raw)) {
    if (vector.nullCount > 0)
      return { kind: 'number', values: numericWithNulls(vector) };
    return {
      kind: 'number',
      values: raw instanceof Float64Array ? raw : new Float64Array(raw),
    };
  }
  if (isBigIntArray(raw)) {
    if (vector.nullCount > 0)
      return { kind: 'number', values: numericWithNulls(vector) };
    return { kind: 'number', values: int64ToFloat64(raw, 1) };
  }
  if (Array.isArray(raw)) {
    return { kind: 'string', values: readStrings(raw, name) };
  }
  throw new ValidationError(
    `fromArrow: value column '${name}' is neither numeric nor string — ` +
      `fromArrow supports 'number' and 'string' columns; drop it or select a ` +
      `supported subset via { columns: [...] }`,
  );
}

/** Read the time column into an epoch-ms `Float64Array`, scaled by unit. */
function readTimeColumn(
  vector: ArrowVectorLike,
  name: string,
  scale: number,
): Float64Array {
  if (vector.nullCount > 0) {
    throw new ValidationError(
      `fromArrow: time column '${name}' has ${vector.nullCount} null value(s) ` +
        `— time keys must be present`,
    );
  }
  const raw = vector.toArray();
  if (isBigIntArray(raw)) return int64ToFloat64(raw, scale);
  if (raw instanceof Float64Array) {
    if (scale === 1) return raw;
    const out = new Float64Array(raw.length);
    for (let j = 0; j < raw.length; j += 1) out[j] = raw[j]! * scale;
    return out;
  }
  if (isNumberTypedArray(raw)) {
    const out = new Float64Array(raw);
    if (scale !== 1) for (let j = 0; j < out.length; j += 1) out[j]! *= scale;
    return out;
  }
  throw new ValidationError(
    `fromArrow: time column '${name}' is not a numeric Arrow column`,
  );
}

/**
 * Translate an Arrow `Table` into the `{ name, schema, columns }` triple that
 * `TimeSeries.fromColumns` ingests. Kept separate from the static so the
 * conversion is unit-testable without the class and so the Arrow-shaped types
 * live in one place. The returned columns are all `Float64Array`, so
 * `fromColumns` takes its zero-copy adoption path throughout.
 */
export function arrowToColumns(
  table: ArrowTableLike,
  options: FromArrowOptions = {},
): { name: string; schema: SeriesSchema; columns: RawColumns } {
  const fields = table.schema?.fields;
  if (!fields || fields.length === 0) {
    throw new ValidationError('fromArrow: table has no columns');
  }

  // Resolve the time column: explicit `time`, else a field named 'time'.
  const timeName =
    options.time ??
    (fields.some((f) => f.name === 'time') ? 'time' : undefined);
  if (timeName === undefined) {
    throw new ValidationError(
      "fromArrow: no time column — pass { time: '<column>' } or include a " +
        "field named 'time'",
    );
  }
  const timeField = fields.find((f) => f.name === timeName);
  if (timeField === undefined) {
    throw new ValidationError(
      `fromArrow: time column '${timeName}' not found in the table schema`,
    );
  }
  const timeVector = table.getChild(timeName);
  if (timeVector == null) {
    throw new ValidationError(
      `fromArrow: time column '${timeName}' has no vector`,
    );
  }

  // Time unit: explicit option wins, else the field's declared TimeUnit, else
  // milliseconds.
  const unit: ArrowTimeUnit =
    options.timeUnit ??
    (typeof timeField.type?.unit === 'number'
      ? (TIME_UNIT_BY_ORDINAL[timeField.type.unit] ?? 'millisecond')
      : 'millisecond');
  const scale = MS_SCALE[unit];

  // Value column selection: explicit `columns` (in order), else every non-time
  // field. Every selected column must be numeric (checked in readValueColumn).
  const valueNames =
    options.columns ??
    fields.map((f) => f.name).filter((name) => name !== timeName);

  const columns: RawColumns = {
    [timeName]: readTimeColumn(timeVector, timeName, scale),
  };
  const schema: Array<{ name: string; kind: 'time' | 'number' | 'string' }> = [
    { name: timeName, kind: 'time' },
  ];
  for (const name of valueNames) {
    if (name === timeName) {
      throw new ValidationError(
        `fromArrow: column '${name}' is the time key and can't also be a ` +
          `value column`,
      );
    }
    const vector = table.getChild(name);
    if (vector == null) {
      throw new ValidationError(
        `fromArrow: column '${name}' not found in the table`,
      );
    }
    const result = readColumn(vector, name);
    columns[name] = result.values;
    schema.push({ name, kind: result.kind });
  }

  return {
    name: options.name ?? 'arrow',
    schema: schema as unknown as SeriesSchema,
    columns,
  };
}
