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
  #allFinite = true;

  constructor(length: number) {
    this.length = length;
    this.values = new Float64Array(length);
    this.bits = new Uint8Array(bitmapByteCount(length));
  }

  /**
   * Writes a defined cell. Tracks finiteness so the resulting column can
   * claim `allFinite` honestly — a wrongly-`true` flag makes reducers
   * take the unguarded path and silently include a non-finite cell (see
   * `Float64Column.allFinite`'s safety contract), so it is derived here
   * rather than assumed from the source.
   */
  set(i: number, value: number): void {
    this.values[i] = value;
    this.bits[i >> 3]! |= 1 << (i & 7);
    this.#defined += 1;
    if (!Number.isFinite(value)) this.#allFinite = false;
  }

  /**
   * Writes a defined cell already known to be finite — the caller has
   * proven it (e.g. a difference of two cells from an `allFinite`
   * source cannot be NaN, though it can overflow to ±Infinity, so this
   * is only for cases where that has been ruled out).
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
    return new Float64Column(
      this.values,
      this.length,
      validity,
      this.#allFinite,
    );
  }
}
