import {
  type Column,
  type ValidityBitmap,
  Float64Column,
  bitmapByteCount,
  validityFromBits,
} from '../../columnar/index.js';

/**
 * Unboxed read/write helpers for element-wise numeric operators —
 * [PND-BOXFREE].
 *
 * **What these replace.** `cumulative`, `diff` / `rate` / `pctChange`,
 * `shift` and `fill` were column-native only in the sense of not
 * materialising `Event`s. Each still walked its source with the
 * polymorphic `col.read(i)`, wrote into a boxed
 * `Array<number | undefined>`, and handed that to
 * `float64ColumnFromArray` — which then walks the boxed array **twice
 * more**, once for the values and once inside `validityFromPredicate`
 * for the bitmap.
 *
 * So a single column cost `n` megamorphic reads, `n` boxed slots, and
 * `3n` array traversals to produce something the source already had as a
 * `Float64Array`. Measured against a plain typed-array loop doing the
 * same work: **9.9× on gappy data, 17.1× dense** for `diff`
 * (`spikes/columnar-wasm/REPORT.md` §9.3). At 1M rows × 4 columns that is
 * ~294 ms against ~16 ms.
 *
 * **What they don't do.** No callback per cell — a closure invocation
 * per element is most of what made the old path slow, so handing one
 * back would give the cost a new name rather than remove it. Each
 * operator keeps its own tight loop and uses these for the ends: read
 * the source unboxed via {@link packedNumericSource}, collect into a
 * {@link NumericOutput}, and finalise.
 */

/**
 * A packed numeric column's raw buffers, for operators that want to walk
 * it without `read(i)`.
 *
 * Returns `null` when the column is not a packed `Float64Column` —
 * chunked storage, or a string / boolean / array column. Callers fall
 * back to their existing boxed path, which stays correct for those and
 * is not the hot case.
 */
export type PackedNumericSource = {
  readonly values: Float64Array;
  /** `null` ⇒ every cell defined (the framework's no-bitmap convention). */
  readonly bits: Uint8Array | null;
  readonly allFinite: boolean;
};

export function packedNumericSource(col: Column): PackedNumericSource | null {
  if (col.kind !== 'number' || col.storage !== 'packed') return null;
  const f = col as Float64Column;
  return {
    values: f._values,
    bits: f.validity?.bits ?? null,
    allFinite: f.allFinite,
  };
}

/** True when cell `i` of a packed source is defined. */
export function isDefinedAt(bits: Uint8Array | null, i: number): boolean {
  return bits === null || (bits[i >> 3]! & (1 << (i & 7))) !== 0;
}

/**
 * Accumulates a numeric output column into a `Float64Array` plus a
 * validity bitmap, with no boxing.
 *
 * The bitmap is allocated up front rather than lazily on the first
 * missing cell. That is `ceil(n / 8)` bytes — 125 KB for a million rows,
 * against the ~8 MB of pointers the boxed array cost — and it removes
 * the back-fill branch from the hot loop, which is the whole point. If
 * every cell turns out to be defined, `finish` drops it and the column
 * carries no bitmap, preserving the "all defined ⇒ no bitmap"
 * convention that the rest of the substrate branches on.
 */
export class NumericOutput {
  readonly values: Float64Array;
  readonly bits: Uint8Array;
  readonly length: number;
  #defined = 0;

  constructor(length: number) {
    this.length = length;
    this.values = new Float64Array(length);
    this.bits = new Uint8Array(bitmapByteCount(length));
  }

  /**
   * Writes a defined cell.
   *
   * A non-finite value (`NaN`, `±Infinity`) is **not** written: the
   * cell stays missing. That is the non-finite-means-missing rule
   * ([PND-NANREP], see `Float64Column`) — an operator's own arithmetic
   * (`Infinity - Infinity`, a sum that overflows, a custom fold) can
   * produce one, and it must read back as a gap, not as a defined cell.
   * Each cell is written at most once per output, so skipping leaves the
   * bit clear without an explicit reset. Every written cell is therefore
   * finite, which is what lets {@link finish} claim `allFinite`.
   */
  set(i: number, value: number): void {
    // `value - value !== 0` is true exactly for NaN and ±Infinity.
    if (value - value !== 0) return;
    this.values[i] = value;
    this.bits[i >> 3]! |= 1 << (i & 7);
    this.#defined += 1;
  }

  /**
   * Writes a defined cell already known to be finite — the caller has
   * proven it (e.g. a running count), so the non-finite check in
   * {@link set} is not needed here.
   */
  setFinite(i: number, value: number): void {
    this.values[i] = value;
    this.bits[i >> 3]! |= 1 << (i & 7);
    this.#defined += 1;
  }

  /** Cells never written stay undefined; no call is needed to skip one. */
  finish(): Float64Column {
    let validity: ValidityBitmap | undefined;
    if (this.#defined !== this.length) {
      validity = validityFromBits(this.bits, this.length);
    }
    // Every written cell is finite (`set` drops non-finite values).
    return new Float64Column(this.values, this.length, validity, true);
  }
}

/**
 * Builds a numeric column from a `Float64Array` in which **a non-finite
 * value means missing** — [PND-WCNAN], [PND-NANREP].
 *
 * The asymmetry with the boxed intake is deliberate and is the whole
 * point. A `ReadonlyArray<number | undefined>` already has a missing
 * marker (`undefined`), so a `NaN` in one is a mistake and stays
 * rejected. A `Float64Array` has no such slot: the only way to express a
 * gap in a typed buffer is `NaN`, so a producer holding one was forced to
 * box into `(number | undefined)[]` purely to say "no value here".
 *
 * That box is the cost this removes. Every `@pond-ts/financial` study
 * produces a length-preserving column with an `undefined` warm-up head,
 * and every one of them was boxing a whole column to express it — 8.28 ms
 * of `sma(20)`'s 22 ms at 500k bars. The dashboard adapter hit the same
 * wall from the other side (~25 ms/tick at 360k rows).
 *
 * `±Infinity` is a gap here too, exactly like `NaN`: a non-finite number
 * in a number column means missing, everywhere (see `Float64Column`). It
 * used to be rejected; it now follows how this door treats `NaN`, as
 * `fromColumns` always has. (The boxed door rejects both alike.)
 *
 * The buffer is **copied, not adopted**. `TimeSeries.fromColumns` adopts,
 * but it is documented as the zero-copy door and callers opt into that by
 * choosing it. `withColumn` has always copied, and silently starting to
 * alias a caller's array would mean a later write through it mutates an
 * already-constructed series. The copy is a memcpy against what was a
 * per-cell boxing walk, so the win survives it.
 */
export function float64ColumnFromTypedArray(
  values: Float64Array,
): Float64Column {
  const length = values.length;
  const owned = new Float64Array(length);
  const bits = new Uint8Array(bitmapByteCount(length));
  let defined = 0;
  for (let i = 0; i < length; i += 1) {
    const v = values[i]!;
    // `v - v !== 0` is true exactly for NaN and ±Infinity — the gap marker.
    if (v - v !== 0) continue;
    owned[i] = v;
    bits[i >> 3]! |= 1 << (i & 7);
    defined += 1;
  }
  const validity =
    defined === length ? undefined : validityFromBits(bits, length);
  // Every defined cell passed the finite test above.
  return new Float64Column(owned, length, validity, true);
}
