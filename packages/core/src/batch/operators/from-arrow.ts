import {
  bitmapByteCount,
  type Column as ColumnarColumn,
  Float64Column,
  validityFromBits,
} from '../../columnar/index.js';
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
   * Backing values. For a **single-chunk** numeric column this is the typed
   * array itself (`Float64Array`, `Int32Array`, `BigInt64Array`, …), adopted
   * where possible; for a string column (Arrow `Utf8`) it is a plain `Array` of
   * strings. Any other shape (list/struct) is rejected by
   * {@link TimeSeries.fromArrow}. A **multi-chunk** vector (a table decoded from
   * a multi-record-batch IPC stream) concatenates into a fresh array here — so
   * such tables are correct but pay a copy, and the zero-copy/aliasing note
   * does not apply to them.
   */
  toArray(): unknown;
  /**
   * Per-slot access, used only on the (rare) null-containing numeric slow path.
   * Typed to match a real Arrow `Vector.get` across column kinds (a `Utf8`
   * vector returns `string`), so a genuine `apache-arrow` `Table` satisfies
   * this interface structurally.
   */
  get(index: number): number | bigint | string | null | undefined;
  /**
   * The vector's backing chunks. Optional — a bare structural stand-in need
   * not provide it, and the reader falls back to {@link get} when it is
   * absent or in a shape that cannot be adopted. Read only to take the
   * zero-copy path for a **null-bearing** numeric column; see
   * {@link adoptNumericWithNulls}.
   */
  readonly data?: ReadonlyArray<ArrowDataLike | null | undefined>;
}

/**
 * Structural view of one Arrow `Data` chunk — the buffers behind a vector.
 * Every field is optional: this is duck-typed off a real `apache-arrow`
 * `Data`, and any shape we do not recognise simply declines the zero-copy
 * path rather than throwing.
 */
export interface ArrowDataLike {
  /** Logical start of this chunk within its buffers. Non-zero ⇒ a slice. */
  readonly offset?: number;
  readonly length?: number;
  /** The values buffer. A `Float64Array` is the adoptable case. */
  readonly values?: unknown;
  /** Arrow's validity bitmap: LSB-first, one bit per slot, 1 = valid. */
  readonly nullBitmap?: Uint8Array | null;
}

/** Structural view of an Arrow `Field` (`schema.fields[i]`). */
export interface ArrowFieldLike {
  readonly name: string;
  /**
   * The field's `DataType`. We read `typeId` (the Arrow `Type` enum) to detect
   * a `Timestamp` (= 10), whose `toArray()` is raw-unit and so needs `unit`
   * (a `TimeUnit`) to scale; every other kind is read straight off `toArray()`.
   * Both are optional so a bare structural stand-in — and a real `DataType`,
   * which carries far more — satisfy the shape.
   */
  readonly type: { readonly typeId?: number; readonly unit?: number };
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

// Arrow `Type` enum ordinal for `Timestamp` (a stable wire-level contract).
// Only `Timestamp` needs unit scaling: its `toArray()` hands back the raw int64
// values in the declared `TimeUnit`. Arrow's `Date32`/`Date64` `toArray()`, by
// contrast, is already normalized to epoch-**ms** JS numbers by the logical
// vector view — so a `Date` key is scale-1, NOT days/ms-from-a-DateUnit. (An
// earlier version read `.unit` blind and scaled Date32 as seconds; verified
// against real `apache-arrow` in `from-arrow.arrow.test.ts`, that was wrong.)
const ARROW_TYPE_TIMESTAMP = 10;

const TWO_POW_32 = 4294967296;

/**
 * Resolve the raw-unit → milliseconds multiplier for the time key. An explicit
 * `timeUnit` always wins. Otherwise: a `Timestamp` (`typeId` 10, or a bare
 * structural input carrying a `unit` but no `typeId` — overwhelmingly a
 * timestamp) is scaled by its `TimeUnit`, since its `toArray()` is raw-unit
 * int64. Everything else — `Date` (arrow already normalizes its `toArray()` to
 * epoch-ms), plain int/float epoch-ms columns — is taken as milliseconds
 * (scale 1).
 */
function resolveMsScale(
  field: ArrowFieldLike,
  override: ArrowTimeUnit | undefined,
): number {
  if (override !== undefined) return MS_SCALE[override];
  const type = field.type ?? {};
  const typeId = typeof type.typeId === 'number' ? type.typeId : undefined;
  const unit = typeof type.unit === 'number' ? type.unit : undefined;

  if (
    typeId === ARROW_TYPE_TIMESTAMP ||
    (typeId === undefined && unit !== undefined)
  ) {
    return MS_SCALE[TIME_UNIT_BY_ORDINAL[unit ?? 1] ?? 'millisecond'];
  }
  return 1;
}

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

// Detected once: is this host little-endian? Arrow IPC is always LE, but the
// buffer a BigInt64Array exposes is in *host* byte order, so a big-endian host
// (vanishingly rare for Node, but real) needs the two int32 halves swapped.
const HOST_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * Convert an int64 column to `Float64Array` **without BigInt**. We alias the
 * buffer as `Int32Array` and recombine each pair `hi * 2^32 + (lo >>> 0)` —
 * exact for the ±2^53 range that covers every realistic epoch timestamp
 * (ms ≈ 1.7e12, µs ≈ 1.7e15). This is the ~30ms `Number(bigint)` ×N cost the
 * fromArrow note called out, reclaimed: the per-element work is two array reads
 * and a multiply-add, no BigInt boxing.
 *
 * Signedness follows the source: `BigUint64Array`'s high word is read unsigned
 * (so a `Uint64` ≥ 2^63 stays positive rather than flipping negative);
 * `BigInt64Array`'s stays signed (so pre-epoch / negative values recombine
 * correctly). Half order follows {@link HOST_LITTLE_ENDIAN}. Values beyond
 * ±2^53 (a huge id/count, or a nanosecond stamp) round to the nearest double —
 * inherent to `Float64Column` storage, same as `Number(bigint)` would give.
 */
function int64ToFloat64(
  source: BigInt64Array | BigUint64Array,
  scale: number,
): Float64Array {
  const count = source.length;
  const out = new Float64Array(count);
  const halves = new Int32Array(source.buffer, source.byteOffset, count * 2);
  const unsigned = source instanceof BigUint64Array;
  const loOff = HOST_LITTLE_ENDIAN ? 0 : 1;
  const hiOff = HOST_LITTLE_ENDIAN ? 1 : 0;
  if (scale === 1) {
    for (let j = 0; j < count; j += 1) {
      const lo = halves[j * 2 + loOff]! >>> 0;
      const hiRaw = halves[j * 2 + hiOff]!;
      const hi = unsigned ? hiRaw >>> 0 : hiRaw;
      out[j] = hi * TWO_POW_32 + lo;
    }
  } else {
    for (let j = 0; j < count; j += 1) {
      const lo = halves[j * 2 + loOff]! >>> 0;
      const hiRaw = halves[j * 2 + hiOff]!;
      const hi = unsigned ? hiRaw >>> 0 : hiRaw;
      out[j] = (hi * TWO_POW_32 + lo) * scale;
    }
  }
  return out;
}

/** A read value column, tagged with the pond kind its data maps to. */
type ReadColumn =
  | { kind: 'number'; values: Float64Array }
  | { kind: 'string'; values: Array<string | null> }
  /**
   * A fully-built column, adopted from Arrow's buffers with no copy. Handed
   * to the ingest engine as-is rather than through `RawColumns`.
   */
  | { kind: 'number'; column: Float64Column };

/**
 * True when every cell the bitmap marks **defined** holds a finite value.
 *
 * This is both the `Float64Column.allFinite` proof and the gate on adopting
 * Arrow's buffers at all — see {@link adoptNumericWithNulls} for why those
 * are the same question.
 *
 * Walks a byte at a time so a fully-defined byte (`0xff`) — the common case
 * even in a column with gaps — costs one load and one compare for eight
 * cells, and an all-null byte (`0x00`) is skipped outright.
 */
function definedCellsAllFinite(
  values: Float64Array,
  bits: Uint8Array,
  count: number,
): boolean {
  const fullBytes = count >> 3;
  for (let byte = 0; byte < fullBytes; byte += 1) {
    const m = bits[byte]!;
    if (m === 0) continue;
    const base = byte << 3;
    if (m === 255) {
      for (let k = 0; k < 8; k += 1) {
        if (!Number.isFinite(values[base + k]!)) return false;
      }
    } else {
      for (let k = 0; k < 8; k += 1) {
        if ((m & (1 << k)) !== 0 && !Number.isFinite(values[base + k]!)) {
          return false;
        }
      }
    }
  }
  for (let i = fullBytes << 3; i < count; i += 1) {
    if (
      (bits[i >> 3]! & (1 << (i & 7))) !== 0 &&
      !Number.isFinite(values[i]!)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Adopt a **null-bearing** `Float64` Arrow column's buffers directly, with
 * no copy — the counterpart of the `nullCount === 0` fast path, which has
 * always adopted its values buffer.
 *
 * This works because **Arrow's validity bitmap and pond's are the same
 * layout**: LSB-first, one bit per slot, a set bit meaning valid. So both
 * buffers can become the `Float64Column`'s storage as they stand. Slots
 * behind a null bit keep whatever Arrow left there, which is exactly what
 * `Float64Column` documents ("buffer slots corresponding to invalid cells
 * hold an arbitrary value; callers must consult `validity`").
 *
 * Measured on 500k rows with 4% nulls: **15.47 ms → 0.55 ms (28×)** against
 * the `get()`-per-element path, which is ~10× slower than the dense path it
 * otherwise matches.
 *
 * Returns `null` — falling back to {@link numericWithNulls} — for anything
 * it cannot adopt faithfully:
 *
 * - **more than one chunk**, or a `data` array in an unrecognised shape;
 * - a **non-zero chunk offset** (a sliced vector — its bits start mid-buffer,
 *   and pond's bitmap has no offset);
 * - a values buffer that is **not a `Float64Array`** (an int32/int64 column
 *   needs converting, so there is nothing to adopt);
 * - a **missing or too-short** null bitmap;
 * - a `nullCount` that **disagrees** with the bitmap's own popcount, which
 *   means we have misread the vector;
 * - a **defined cell holding a non-finite value**.
 *
 * That last one is a semantics gate, not a safety one, and it is the
 * subtle case. pond's every other numeric intake maps a defined `NaN` to a
 * **gap** (`validityFromPredicate(Number.isFinite)`), including the dense
 * Arrow path right next to this one. Adopting a buffer with a non-null
 * `NaN` in it would leave that cell *defined* instead — so the same table
 * would ingest differently depending on whether adoption happened to be
 * possible. Declining keeps one answer. It costs a scan we were doing
 * anyway: "every defined cell is finite" is simultaneously the adoption
 * gate and the `allFinite` proof.
 */
function adoptNumericWithNulls(
  vector: ArrowVectorLike,
  count: number,
): Float64Column | null {
  const chunks = vector.data;
  if (!Array.isArray(chunks) || chunks.length !== 1) return null;
  const chunk = chunks[0];
  if (chunk == null) return null;
  if ((chunk.offset ?? 0) !== 0) return null;

  const values = chunk.values;
  if (!(values instanceof Float64Array) || values.length < count) return null;

  const bits = chunk.nullBitmap;
  if (!(bits instanceof Uint8Array) || bits.length < bitmapByteCount(count)) {
    return null;
  }

  // `validityFromBits` popcounts on construction, so this cross-check of the
  // vector's own `nullCount` is free.
  const validity = validityFromBits(bits, count);
  if (validity.definedCount !== count - vector.nullCount) return null;

  if (!definedCellsAllFinite(values, bits, count)) return null;
  return new Float64Column(values, count, validity, true);
}

/**
 * Read a numeric column carrying nulls, mapping null → `NaN` (missing). This is
 * the slow path: per-element `get()`, and for an int64 column also the
 * `Number(bigint)` boxing the two-int32 recombination avoids — the BigInt-free
 * fast path is null-free-only. Acceptable given how rare a nulled int64 column
 * is; a dense numeric column never lands here.
 */
function numericWithNulls(vector: ArrowVectorLike): Float64Array {
  const count = vector.length;
  const out = new Float64Array(count);
  for (let j = 0; j < count; j += 1) {
    const v = vector.get(j);
    out[j] = v == null ? NaN : Number(v);
  }
  return out;
}

/** Copy a string array's values, mapping null/undefined → missing. */
function readStrings(raw: ReadonlyArray<unknown>): Array<string | null> {
  const out = new Array<string | null>(raw.length);
  for (let j = 0; j < raw.length; j += 1) {
    const v = raw[j];
    out[j] = v == null ? null : (v as string);
  }
  return out;
}

/** Build a `Float64Array` from a plain number array, null/undefined → `NaN`. */
function readNumbersFromArray(raw: ReadonlyArray<unknown>): Float64Array {
  const out = new Float64Array(raw.length);
  for (let j = 0; j < raw.length; j += 1) {
    const v = raw[j];
    out[j] = v == null ? NaN : Number(v);
  }
  return out;
}

/**
 * Classify a plain `Array` (what `toArray()` returns for non-typed-array
 * columns) by its first defined element. Arrow hands back an `Array<string>`
 * for `Utf8`/`LargeUtf8` and an `Array<number>` (epoch-ms) for `Date32`/`Date64`
 * — the element type is the only reliable discriminator. All-null → `'number'`
 * (an all-missing `Float64Column`); a non-string/number element → `'other'`
 * (a list/struct vector), rejected by the caller.
 */
function classifyArray(
  raw: ReadonlyArray<unknown>,
): 'number' | 'string' | 'other' {
  for (let j = 0; j < raw.length; j += 1) {
    const v = raw[j];
    if (v == null) continue;
    if (typeof v === 'number') return 'number';
    if (typeof v === 'string') return 'string';
    return 'other';
  }
  return 'number';
}

/**
 * Read one value column, inferring its pond kind from what `toArray()` hands
 * back. Numeric fast paths: `Float64Array` adopted as-is (zero copy), other
 * number typed arrays copy through the `Float64Array` constructor (no map fn —
 * stays off V8's slow iterable path), int64 recombines BigInt-free; a numeric
 * column carrying nulls takes the per-element `get()` path (null → `NaN`). A
 * plain `Array` is classified by content: `Array<string>` (Arrow `Utf8`) →
 * `StringColumn` downstream (dict-encoded when it pays), `Array<number>` (a
 * normalized `Date` column, epoch-ms) → `Float64Column`. Anything else (a
 * list/struct vector) throws, naming the column.
 */
function readColumn(
  vector: ArrowVectorLike,
  name: string,
  allowAdopt: boolean,
): ReadColumn {
  const raw = vector.toArray();
  if (isNumberTypedArray(raw)) {
    if (vector.nullCount > 0) {
      const adopted = allowAdopt
        ? adoptNumericWithNulls(vector, vector.length)
        : null;
      if (adopted !== null) return { kind: 'number', column: adopted };
      return { kind: 'number', values: numericWithNulls(vector) };
    }
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
    const kind = classifyArray(raw);
    if (kind === 'string') return { kind: 'string', values: readStrings(raw) };
    if (kind === 'number')
      return { kind: 'number', values: readNumbersFromArray(raw) };
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
  // Arrow `Date32`/`Date64` `toArray()` yields a plain `Array<number>` already
  // normalized to epoch-ms (scale is 1 for a Date key; see resolveMsScale).
  if (Array.isArray(raw) && classifyArray(raw) === 'number') {
    const out = readNumbersFromArray(raw);
    if (scale !== 1) for (let j = 0; j < out.length; j += 1) out[j]! *= scale;
    return out;
  }
  throw new ValidationError(
    `fromArrow: time column '${name}' is not a numeric or temporal Arrow column`,
  );
}

/**
 * Translate an Arrow `Table` into what the columnar ingest engine takes.
 * Kept separate from the static so the conversion is unit-testable without
 * the class and so the Arrow-shaped types live in one place.
 *
 * Returns two channels. `columns` is the ordinary `RawColumns` payload, all
 * `Float64Array`, so ingest takes its zero-copy adoption path throughout.
 * `adopted` carries columns already built straight from Arrow's buffers —
 * the null-bearing numeric case (see {@link adoptNumericWithNulls}), which
 * has no `RawColumns` representation because `RawColumns` cannot carry a
 * validity bitmap. A column name appears in exactly one of the two.
 */
export function arrowToColumns(
  table: ArrowTableLike,
  options: FromArrowOptions = {},
): {
  name: string;
  schema: SeriesSchema;
  columns: RawColumns;
  adopted: ReadonlyMap<string, ColumnarColumn>;
} {
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

  // Time unit → ms scale, gated on the Arrow type family (see resolveMsScale).
  const scale = resolveMsScale(timeField, options.timeUnit);

  // Value column selection: explicit `columns` (in order), else every non-time
  // field. Every selected column must be numeric (checked in readValueColumn).
  const valueNames =
    options.columns ??
    fields.map((f) => f.name).filter((name) => name !== timeName);

  const columns: RawColumns = {
    [timeName]: readTimeColumn(timeVector, timeName, scale),
  };
  const adopted = new Map<string, ColumnarColumn>();
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
    // Sorting permutes rows into fresh buffers, so there would be nothing
    // left to adopt — decide it here, once, rather than handing the ingest
    // engine a column it would have to take apart again.
    const result = readColumn(vector, name, options.sort !== true);
    if ('column' in result) adopted.set(name, result.column);
    else columns[name] = result.values;
    schema.push({ name, kind: result.kind });
  }

  return {
    name: options.name ?? 'arrow',
    schema: schema as unknown as SeriesSchema,
    columns,
    adopted,
  };
}
