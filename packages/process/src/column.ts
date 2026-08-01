/**
 * Column-valued node support — [PND-PROCCOL].
 *
 * An op computes a study by calling into the corpus, which returns a
 * `TimeSeries` whose new column is already **packed** (a `Float64Array`
 * plus a validity bitmap). The obvious adapter then unpacks that into a
 * boxed `Array<number | undefined>` to use as the node's value. Keeping
 * the `Column` instead is worth doing for **memory and sizeability**: 20
 * SMAs over 500k rows cost 271 MB of GC-managed heap boxed versus 42 MB
 * as columns (rss 466 MB vs 353 MB — the bytes move to `arrayBuffers`
 * rather than vanish).
 *
 * It is **not** worth doing for read throughput, which measurement
 * contradicted: folding a max over 500k cells took 0.91 ms over the boxed
 * array, 0.96 ms walking the buffer plus validity bits, and 4.27 ms via
 * `Column.scan()` — whose per-cell callback costs more than either. A
 * reduction on a hot path should walk `toFloat64Array()` and the bits
 * directly rather than call `scan`.
 *
 * What that needs, and pond does not expose, is here:
 *
 * - {@link columnBytes} — a value's retained size, so a cache budget can
 *   be expressed in bytes rather than entries ([PND-PROCCACHE]).
 * - {@link packColumn} — build a packed column from loose values, for an
 *   op whose kernel hands back an array.
 * - {@link appendColumn} — put a column back onto a series for the
 *   renderer path, avoiding the round trip where the column is gapless.
 * - {@link columnBuffers} / {@link columnFromBuffers} — the buffer pair a
 *   column *is*, for moving one across an isolate boundary
 *   ([PND-PROCPAR]).
 */

import { Float64Column, TimeSeries } from 'pond-ts';
import type { Column, SeriesSchema, ValidityBitmap } from 'pond-ts';

/** Bytes a validity bitmap needs for `length` cells. */
function bitmapByteCount(length: number): number {
  return Math.ceil(length / 8);
}

/**
 * A `ValidityBitmap` built outside core.
 *
 * The interface is structural — `bits` / `length` / `definedCount` /
 * `isDefined` / `countInRange`, all public — so a producer can implement
 * it without reaching into `pond-ts`'s internals. Core's own factory
 * (`createValidityBitmap`) is deliberately not exported; this is the
 * supported way to construct one from outside.
 */
class PackedValidity implements ValidityBitmap {
  readonly bits: Uint8Array;
  readonly length: number;
  readonly definedCount: number;

  constructor(bits: Uint8Array, length: number, definedCount: number) {
    this.bits = bits;
    this.length = length;
    this.definedCount = definedCount;
  }

  isDefined(i: number): boolean {
    if (i < 0 || i >= this.length) return false;
    return (this.bits[i >> 3]! & (1 << (i & 7))) !== 0;
  }

  countInRange(start: number, end: number): number {
    const lo = Math.max(0, start);
    const hi = Math.min(this.length, end);
    let n = 0;
    for (let i = lo; i < hi; i += 1) if (this.isDefined(i)) n += 1;
    return n;
  }
}

/**
 * Retained size of a column value, in bytes.
 *
 * Approximate by construction — it counts the backing buffers a packed
 * column owns, which is what a cache budget is actually trying to bound,
 * and ignores per-object overhead. A chunked column reports the sum of
 * its chunks. A column whose kind this cannot size returns `0` rather
 * than guessing, so a budget treats it as free instead of evicting on a
 * fabricated number.
 *
 * Bytes rather than entries is the point: a 500k-row result and a scalar
 * both count as one entry, and only one of them matters.
 */
export function columnBytes(column: Column): number {
  const anyColumn = column as unknown as {
    length: number;
    kind: string;
    _values?: { BYTES_PER_ELEMENT?: number; length: number };
    validity?: { length: number };
    chunks?: readonly unknown[];
  };
  // A chunked column owns no buffer of its own — its bytes are its
  // chunks' (each a packed column, sized recursively) plus the aggregate
  // validity bitmap built at construction. Reading `_values` here
  // returned 0 for every chunked column, while the doc above promised
  // the sum — an undercount a byte budget would treat as free.
  const chunks = anyColumn.chunks;
  if (Array.isArray(chunks)) {
    let total = anyColumn.validity
      ? bitmapByteCount(anyColumn.validity.length)
      : 0;
    for (const chunk of chunks) total += columnBytes(chunk as Column);
    return total;
  }
  const values = anyColumn._values;
  if (values === undefined) return 0;
  const perElement = values.BYTES_PER_ELEMENT ?? 8;
  const bytes = anyColumn.length * perElement;
  const validity = anyColumn.validity;
  return bytes + (validity ? bitmapByteCount(validity.length) : 0);
}

/**
 * Packs loose values into a `Float64Column`.
 *
 * For an op whose kernel returns an array — the financial kernels are
 * array-out (`rollingValues`, `emaValues`) — this confines the boxing to
 * one pass, instead of the boxed array being retained as the node value.
 *
 * `NaN` is treated as **missing**, matching what a study's warm-up
 * means, and never packed as a defined cell: core's reducer non-finite
 * policy requires that a column flagged `allFinite` contain no `NaN`,
 * and a wrongly-set flag makes reducers take an unguarded path and
 * silently return a wrong result. `allFinite` is therefore computed by
 * inspecting every defined cell, not assumed.
 */
export function packColumn(
  values: ArrayLike<number | undefined | null>,
): Float64Column {
  const length = values.length;
  const buffer = new Float64Array(length);
  const bits = new Uint8Array(bitmapByteCount(length));
  let defined = 0;
  let allFinite = true;

  for (let i = 0; i < length; i += 1) {
    const v = values[i];
    if (v === undefined || v === null || Number.isNaN(v)) continue;
    buffer[i] = v;
    bits[i >> 3]! |= 1 << (i & 7);
    defined += 1;
    if (!Number.isFinite(v)) allFinite = false;
  }

  // No gaps: omit the bitmap entirely rather than carry an all-ones one.
  // A gapless column is also the case `appendColumn` can round-trip
  // without boxing, so this is worth detecting.
  if (defined === length)
    return new Float64Column(buffer, length, undefined, allFinite);
  return new Float64Column(
    buffer,
    length,
    new PackedValidity(bits, length, defined),
    allFinite,
  );
}

/**
 * Appends a column to a series under `name` — the renderer path, where a
 * caller genuinely wants one `TimeSeries` carrying several studies.
 *
 * **A gapless column round-trips without boxing**, via the column's own
 * `Float64Array`. A column *with* gaps cannot: core's `withColumn` takes
 * values, not a column, and rejects a non-finite cell, so a warm-up has
 * to be expressed as `undefined` in a boxed array. Core appends columns
 * directly internally (`withColumnAppended`) but does not expose it;
 * until it does, a gapped column pays one boxing pass here.
 *
 * Since most studies have a warm-up, that fallback is the common case —
 * which is exactly why assembly should be requested rather than assumed
 * ([PND-PROCTERM]). A facts-only request never calls this.
 */
export function appendColumn<S extends SeriesSchema>(
  series: TimeSeries<S>,
  name: string,
  column: Column,
): TimeSeries<SeriesSchema> {
  if (column.length !== series.length) {
    throw new RangeError(
      `appendColumn '${name}': column length ${column.length} does not match series length ${series.length}`,
    );
  }
  const wide = series as unknown as {
    withColumn(
      n: string,
      v: ReadonlyArray<number | undefined> | Float64Array,
    ): TimeSeries<SeriesSchema>;
  };

  const packed = column as unknown as {
    validity?: ValidityBitmap;
    toFloat64Array?: () => Float64Array;
  };
  if (
    packed.validity === undefined &&
    typeof packed.toFloat64Array === 'function'
  ) {
    return wide.withColumn(name, packed.toFloat64Array());
  }

  const boxed = new Array<number | undefined>(column.length);
  for (let i = 0; i < column.length; i += 1) {
    const v = (column as unknown as { at(i: number): number | undefined }).at(
      i,
    );
    boxed[i] = v === undefined || Number.isNaN(v as number) ? undefined : v;
  }
  return wide.withColumn(name, boxed);
}

/**
 * The buffer pair a packed numeric column **is** — for moving one across
 * an isolate boundary ([PND-PROCPAR]).
 *
 * `RunResult.columns` is already described as the wire-shaped answer: a
 * `Float64Array` plus a validity bitmap. This makes that literal, so a
 * worker can hand a result back as two transferable buffers rather than
 * 500k boxed values (48.6 ms per answer boxed vs 0.5 ms transferred).
 *
 * **The buffers are copies, deliberately.** A column's own buffers are
 * shared with the node's memo, and transferring a buffer *detaches* it in
 * the sending isolate — which would silently empty the cache the worker
 * exists to keep warm. One `slice()` per surfaced column is the price of
 * the cache staying valid, and it is still the cheap direction.
 *
 * Falls back to `undefined` for a column this cannot express (chunked
 * storage, or a non-numeric kind), so a caller can box that one rather
 * than the pool failing over a column it did not need packed.
 */
export interface ColumnBuffers {
  readonly length: number;
  readonly values: Float64Array;
  /** Absent ⇒ every cell defined (the framework's no-bitmap convention). */
  readonly bits?: Uint8Array;
  readonly definedCount: number;
  readonly allFinite: boolean;
}

export function columnBuffers(column: Column): ColumnBuffers | undefined {
  const packed = column as unknown as {
    kind: string;
    storage?: string;
    length: number;
    _values?: Float64Array;
    validity?: ValidityBitmap;
    allFinite?: boolean;
  };
  if (packed.kind !== 'number' || packed.storage !== 'packed') return undefined;
  const values = packed._values;
  if (!(values instanceof Float64Array)) return undefined;

  const length = packed.length;
  const validity = packed.validity;
  return {
    length,
    // `slice`, not `subarray`: the result is transferred, and transferring
    // a view detaches the buffer it borrows from — here, the live memo.
    values: values.slice(0, length),
    ...(validity === undefined
      ? {}
      : { bits: validity.bits.slice(0, bitmapByteCount(length)) }),
    definedCount: validity === undefined ? length : validity.definedCount,
    allFinite: packed.allFinite ?? false,
  };
}

/** Rebuilds a column from {@link columnBuffers}, adopting both buffers. */
export function columnFromBuffers(wire: ColumnBuffers): Float64Column {
  return new Float64Column(
    wire.values,
    wire.length,
    wire.bits === undefined
      ? undefined
      : new PackedValidity(wire.bits, wire.length, wire.definedCount),
    wire.allFinite,
  );
}

/**
 * A **zero-copy** read view over a packed numeric column — [PND-PROCCOL].
 *
 * The counterpart to {@link columnBuffers}, which copies because its
 * result crosses a thread. This one borrows: `values` and `bits` are
 * `subarray`s of the column's own storage, valid only while the memo
 * that produced the column holds it. Read, never retain.
 *
 * `undefined` for anything not packed numeric — a string column, or a
 * value that arrived boxed — so a caller keeps its slow path.
 *
 * ## Why a view rather than `scan`
 *
 * Measured folding a max over 500k cells:
 *
 * | read path                     | ms   |
 * | ----------------------------- | ---- |
 * | boxed `(number\|undefined)[]` | 0.91 |
 * | `Column.scan()`               | 4.27 |
 * | buffer + bitmap               | 0.96 |
 *
 * The columnar form is **not faster to read** — a buffer walk only
 * reaches parity with the boxed array, and `scan` is 4.7× slower than
 * either because it takes a callback per cell. The case for it is that
 * it does not *allocate*: no `Array` of 500k boxed slots per version,
 * and nothing at all for a fold like `latest`, which reads one cell.
 * Core's design principles recommend `scan` as the columnar read path,
 * which is worth revisiting on this evidence.
 */
export interface ColumnView {
  readonly length: number;
  /** Column storage. A cell is meaningful only where {@link ColumnView.defined}. */
  readonly values: Float64Array;
  /** Absent ⇒ every cell is defined. */
  readonly bits?: Uint8Array;
  readonly definedCount: number;
  defined(i: number): boolean;
  at(i: number): number | undefined;
}

export function columnView(column: Column): ColumnView | undefined {
  const packed = column as unknown as {
    kind: string;
    storage?: string;
    length: number;
    _values?: Float64Array;
    validity?: ValidityBitmap;
  };
  if (packed.kind !== 'number' || packed.storage !== 'packed') return undefined;
  const values = packed._values;
  if (!(values instanceof Float64Array)) return undefined;

  const length = packed.length;
  const validity = packed.validity;
  const view = values.subarray(0, length);
  if (validity === undefined) {
    return {
      length,
      values: view,
      definedCount: length,
      defined: () => true,
      at: (i) => (i >= 0 && i < length ? view[i] : undefined),
    };
  }
  const bits = validity.bits;
  // LSB-first, one bit per cell — pond's layout, and Arrow's.
  const defined = (i: number): boolean =>
    i >= 0 && i < length && (bits[i >> 3]! & (1 << (i & 7))) !== 0;
  return {
    length,
    values: view,
    bits,
    definedCount: validity.definedCount,
    defined,
    at: (i) => (defined(i) ? view[i] : undefined),
  };
}

/**
 * A writable output buffer for a ranged recompute — [PND-PROCRANGE].
 *
 * The rows an op keeps unchanged are already here, values **and**
 * validity, copied as blocks. The op fills `[from, to)` and nothing else.
 *
 * This exists because carrying a prefix forward correctly is harder than
 * it looks and the obvious shortcut is silently wrong. Packed storage
 * holds `0` at a missing cell, not `NaN`, so copying only `values` turns
 * every warm-up gap in the prefix into a defined zero — measured at 1,875
 * wrong cells on a 5-study pass, caught by a from-scratch comparison
 * rather than by any type. Validity has to move with the values, and
 * doing that per cell is the `O(n)` walk the whole ticket exists to
 * remove.
 */
export interface RangeOutput {
  /** Length `to`. `[0, from)` already carries the previous output. */
  readonly values: Float64Array;
  /**
   * Validity bits, LSB-first, already carrying `[0, from)`.
   *
   * Exposed so an op can write a run of cells as bytes rather than
   * through {@link RangeOutput.set} per cell; most ops want `set`.
   */
  readonly bits: Uint8Array;
  /** Marks a cell present, with its value. */
  set(i: number, v: number): void;
  /**
   * Marks a cell missing.
   *
   * **Only needed to undo a {@link RangeOutput.set} made in the same
   * pass.** Cells in `[from, to)` start unset and an unwritten cell
   * seals as missing, so clearing one the op never set does nothing —
   * which is why an empty `clear` passed the whole suite until a
   * set-then-clear case was written (Layer 2, PR #573).
   */
  clear(i: number): void;
}

/** Bytes needed for `length` validity bits. */
export function validityByteCount(length: number): number {
  return (length + 7) >> 3;
}

/**
 * Prepares a {@link RangeOutput} of `length`, carrying `[0, keep)` from
 * `prior` — a `Float64Array.set` for the values and a byte-wise copy for
 * the bitmap, with the straddling byte masked.
 */
export function prepareRange(
  length: number,
  keep: number,
  prior: ColumnView | undefined,
): RangeOutput {
  const values = new Float64Array(length);
  const bits = new Uint8Array(validityByteCount(length));
  // Clamped to `length` as well as to the prior: a series that SHRANK
  // gives `keep > length`, and `values.set` then throws
  // `RangeError: offset is out of bounds` before the op ever runs.
  const copy = prior === undefined ? 0 : Math.min(keep, prior.length, length);
  if (prior !== undefined && copy > 0) {
    values.set(prior.values.subarray(0, copy));
    if (prior.bits === undefined) {
      // No bitmap ⇒ every prior cell was defined.
      for (let i = 0; i < copy; i += 1) bits[i >> 3]! |= 1 << (i & 7);
    } else {
      const whole = copy >> 3;
      bits.set(prior.bits.subarray(0, whole));
      // The byte straddling `copy` carries bits past it that belong to
      // rows this range is about to rewrite — mask them off.
      const rest = copy & 7;
      if (rest !== 0) bits[whole] = prior.bits[whole]! & ((1 << rest) - 1);
    }
  }
  return {
    values,
    bits,
    set(i, v) {
      values[i] = v;
      bits[i >> 3]! |= 1 << (i & 7);
    },
    clear(i) {
      values[i] = 0;
      bits[i >> 3]! &= ~(1 << (i & 7));
    },
  };
}

/** Seals a {@link RangeOutput} into a column, counting validity once. */
export function sealRange(out: RangeOutput, length: number): Float64Column {
  const bits = out.bits;
  let defined = 0;
  let allFinite = true;
  for (let i = 0; i < length; i += 1) {
    if ((bits[i >> 3]! & (1 << (i & 7))) === 0) continue;
    defined += 1;
    if (!Number.isFinite(out.values[i]!)) allFinite = false;
  }
  if (defined === length)
    return new Float64Column(out.values, length, undefined, allFinite);
  return new Float64Column(
    out.values,
    length,
    new PackedValidity(bits, length, defined),
    allFinite,
  );
}
