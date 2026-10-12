import { type Column, Float64Column } from '../../columnar/index.js';

/**
 * Unboxed read/write helpers for element-wise numeric operators —
 * [PND-BOXFREE].
 *
 * **What these replace.** `cumulative`, `diff` / `rate` / `pctChange`,
 * `shift` and `fill` were column-native only in the sense of not
 * materialising `Event`s. Each still walked its source with the
 * polymorphic `col.read(i)`, wrote into a boxed
 * `Array<number | undefined>`, and handed that to
 * `float64ColumnFromArray` — which then walked the boxed array **twice
 * more**, once for the values and once for the validity bitmap.
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
 * A packed numeric column's raw buffer, for operators that want to walk
 * it without `read(i)`. A missing cell is a non-finite value in `values`
 * ([PND-NANREP]), so the finite test `v - v === 0` is also the defined
 * test — and arithmetic on a missing cell yields `NaN`, which
 * {@link NumericOutput.set} drops, so many loops need no test at all.
 *
 * Returns `null` when the column is not a packed `Float64Column` —
 * chunked storage, or a string / boolean / array column. Callers fall
 * back to their existing boxed path, which stays correct for those and
 * is not the hot case.
 */
export type PackedNumericSource = {
  readonly values: Float64Array;
  /** `true` ⇒ no missing cell and every cell finite. */
  readonly allFinite: boolean;
};

export function packedNumericSource(col: Column): PackedNumericSource | null {
  if (col.kind !== 'number' || col.storage !== 'packed') return null;
  const f = col as Float64Column;
  return { values: f._values, allFinite: f.allFinite };
}

/**
 * Accumulates a numeric output column into a `Float64Array`, with no
 * boxing. The buffer starts all-`NaN` (all missing); written cells
 * become defined, and a cell never written stays missing.
 */
export class NumericOutput {
  readonly values: Float64Array;
  readonly length: number;
  #defined = 0;

  constructor(length: number) {
    this.length = length;
    this.values = new Float64Array(length).fill(NaN);
  }

  /**
   * Writes a defined cell.
   *
   * A non-finite value (`NaN`, `±Infinity`) is **not** written: the
   * cell stays missing. That is the non-finite-means-missing rule
   * ([PND-NANREP], see `Float64Column`) — an operator's own arithmetic
   * (`Infinity - Infinity`, a sum that overflows, a custom fold, or any
   * arithmetic touching a missing `NaN` input) can produce one, and it
   * must read back as a gap, not as a defined cell. Each cell is written
   * at most once per output. Every written cell is therefore finite,
   * which is what lets {@link finish} claim `allFinite` when every cell
   * was written.
   */
  set(i: number, value: number): void {
    // `value - value !== 0` is true exactly for NaN and ±Infinity.
    if (value - value !== 0) return;
    this.values[i] = value;
    this.#defined += 1;
  }

  /**
   * Writes a defined cell already known to be finite — the caller has
   * proven it (e.g. a running count), so the non-finite check in
   * {@link set} is not needed here.
   */
  setFinite(i: number, value: number): void {
    this.values[i] = value;
    this.#defined += 1;
  }

  /** Cells never written stay missing; no call is needed to skip one. */
  finish(): Float64Column {
    return new Float64Column(
      this.values,
      this.length,
      this.#defined === this.length,
    );
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
  const owned = values.slice();
  let allFinite = true;
  for (let i = 0; i < length; i += 1) {
    const v = owned[i]!;
    // `v - v !== 0` is true exactly for NaN and ±Infinity — the gap
    // marker. `±Infinity` is canonicalised to `NaN` so a missing cell has
    // one spelling.
    if (v - v !== 0) {
      owned[i] = NaN;
      allFinite = false;
    }
  }
  return new Float64Column(owned, length, allFinite);
}
