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
  };
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
