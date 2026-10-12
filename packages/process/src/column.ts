/**
 * Column-valued node support — [PND-PROCCOL].
 *
 * An op computes a study by calling into the corpus, which returns a
 * `TimeSeries` whose new column is already **packed** (a `Float64Array`
 * in which a missing cell is `NaN`). The obvious adapter then unpacks that into a
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
 * reduction on a hot path should walk `toFloat64Array()` directly rather
 * than call `scan`. (Measured when number columns still carried a
 * validity bitmap; they now mark a gap with `NaN` — [PND-NANREP].)
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
import type { Column, SeriesSchema } from 'pond-ts';

/** Bytes a validity bitmap needs for `length` cells. */
function bitmapByteCount(length: number): number {
  return Math.ceil(length / 8);
}

/** `true` for a finite number — `NaN - NaN` and `Infinity - Infinity` are `NaN`. */
function isFinite(v: number): boolean {
  return v - v === 0;
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
    validity?: { length: number; bits?: { length: number } };
    chunks?: readonly unknown[];
    chunkOffsets?: { BYTES_PER_ELEMENT?: number; length: number };
  };
  // The bitmap's REAL bytes, not the minimum its cell count implies: a
  // bitmap over a larger buffer retains that buffer. A number column has
  // no bitmap of its own (a gap is `NaN` in the buffer, [PND-NANREP]) —
  // its `validity` is derived on demand, so reading it here would build
  // one just to size it.
  const validity = anyColumn.kind === 'number' ? undefined : anyColumn.validity;
  const validityBytes =
    validity === undefined
      ? 0
      : (validity.bits?.length ?? bitmapByteCount(validity.length));
  // A chunked column owns no value buffer of its own — its bytes are its
  // chunks' (each a packed column, sized recursively) plus the aggregate
  // validity bitmap (non-number kinds) and the chunk-offset index built
  // at construction.
  // Reading `_values` here returned 0 for every chunked column, while
  // the doc above promised the sum — an undercount a byte budget would
  // treat as free.
  const chunks = anyColumn.chunks;
  if (Array.isArray(chunks)) {
    const offsets = anyColumn.chunkOffsets;
    let total =
      validityBytes +
      (offsets === undefined
        ? 0
        : offsets.length * (offsets.BYTES_PER_ELEMENT ?? 4));
    for (const chunk of chunks) total += columnBytes(chunk as Column);
    return total;
  }
  const values = anyColumn._values;
  if (values === undefined) return 0;
  const perElement = values.BYTES_PER_ELEMENT ?? 8;
  // The BACKING buffer's capacity, not the column's logical length — a
  // one-row column viewing an 8 MB buffer retains 8 MB, and sizing it
  // at 8 bytes is exactly the undercount that defeats a byte budget.
  return values.length * perElement + validityBytes;
}

/**
 * Packs loose values into a `Float64Column`.
 *
 * For an op whose kernel returns an array — the financial kernels are
 * array-out (`rollingValues`, `emaValues`) — this confines the boxing to
 * one pass, instead of the boxed array being retained as the node value.
 *
 * A non-finite value (`NaN`, `±Infinity`) is treated as **missing** —
 * `NaN` is what a study's warm-up means, and a non-finite number in a
 * number column means missing ([PND-NANREP]) — and never packed as a
 * defined cell. Every defined cell is therefore finite and the column is
 * `allFinite`.
 */
export function packColumn(
  values: ArrayLike<number | undefined | null>,
): Float64Column {
  const length = values.length;
  const buffer = new Float64Array(length);
  let defined = 0;

  for (let i = 0; i < length; i += 1) {
    const v = values[i];
    if (v === undefined || v === null || !isFinite(v)) {
      buffer[i] = NaN;
      continue;
    }
    buffer[i] = v;
    defined += 1;
  }
  // Gapless ⇔ every cell finite, which is the `allFinite` promise.
  return new Float64Column(buffer, length, defined === length);
}

/**
 * Appends a column to a series under `name` — the renderer path, where a
 * caller genuinely wants one `TimeSeries` carrying several studies.
 *
 * **A packed column round-trips without boxing**, via the column's own
 * `Float64Array`: a gap there is `NaN`, which core's `withColumn` reads as
 * missing on a `Float64Array` ([PND-WCNAN], [PND-NANREP]). Only a column
 * with no `toFloat64Array` (a value that arrived some other way) pays a
 * boxing pass.
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
    kind?: string;
    toFloat64Array?: () => Float64Array;
  };
  if (packed.kind === 'number' && typeof packed.toFloat64Array === 'function') {
    return wide.withColumn(name, packed.toFloat64Array());
  }

  const boxed = new Array<number | undefined>(column.length);
  for (let i = 0; i < column.length; i += 1) {
    const v = (column as unknown as { at(i: number): number | undefined }).at(
      i,
    );
    boxed[i] = v === undefined || !isFinite(v) ? undefined : v;
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
  /** The values; a missing cell is `NaN` ([PND-NANREP]). */
  readonly values: Float64Array;
  readonly definedCount: number;
  readonly allFinite: boolean;
}

export function columnBuffers(column: Column): ColumnBuffers | undefined {
  const packed = column as unknown as {
    kind: string;
    storage?: string;
    length: number;
    _values?: Float64Array;
    missingCount?: number;
    allFinite?: boolean;
  };
  if (packed.kind !== 'number' || packed.storage !== 'packed') return undefined;
  const values = packed._values;
  if (!(values instanceof Float64Array)) return undefined;

  const length = packed.length;
  return {
    length,
    // `slice`, not `subarray`: the result is transferred, and transferring
    // a view detaches the buffer it borrows from — here, the live memo.
    values: values.slice(0, length),
    definedCount: length - (packed.missingCount ?? 0),
    allFinite: packed.allFinite ?? false,
  };
}

/** Rebuilds a column from {@link columnBuffers}, adopting the buffer. */
export function columnFromBuffers(wire: ColumnBuffers): Float64Column {
  return new Float64Column(wire.values, wire.length, wire.allFinite);
}

/**
 * A **zero-copy** read view over a packed numeric column — [PND-PROCCOL].
 *
 * The counterpart to {@link columnBuffers}, which copies because its
 * result crosses a thread. This one borrows: `values` is a `subarray` of
 * the column's own storage, valid only while the memo
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
 * | buffer + bitmap (pre-NANREP)  | 0.96 |
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
  /** Column storage. A missing cell is `NaN` ([PND-NANREP]). */
  readonly values: Float64Array;
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
    missingCount?: number;
  };
  if (packed.kind !== 'number' || packed.storage !== 'packed') return undefined;
  const values = packed._values;
  if (!(values instanceof Float64Array)) return undefined;

  const length = packed.length;
  const view = values.subarray(0, length);
  const defined = (i: number): boolean =>
    i >= 0 && i < length && isFinite(view[i]!);
  return {
    length,
    values: view,
    definedCount: length - (packed.missingCount ?? 0),
    defined,
    at: (i) => (defined(i) ? view[i] : undefined),
  };
}

/**
 * A writable output buffer for a ranged recompute — [PND-PROCRANGE].
 *
 * The rows an op keeps unchanged are already here, copied as one block.
 * The op fills `[from, to)` and nothing else.
 *
 * A missing cell is `NaN` in `values` ([PND-NANREP]), so the gaps in the
 * kept prefix travel with the values in the same copy. (Before number
 * columns marked gaps with `NaN`, packed storage held `0` at a missing
 * cell and copying only the values turned every warm-up gap into a
 * defined zero — 1,875 wrong cells on a 5-study pass.)
 */
export interface RangeOutput {
  /**
   * Length `to`. `[0, from)` already carries the previous output; every
   * other cell starts missing (`NaN`). An op may write a run of cells
   * here directly; a non-finite value written this way is a gap, the
   * same as through {@link RangeOutput.set}.
   */
  readonly values: Float64Array;
  /**
   * Writes a cell. A non-finite value (`NaN`, `±Infinity`) marks the cell
   * **missing** instead (same as {@link RangeOutput.clear}) — core's rule
   * that a non-finite number in a number column means missing
   * ([PND-NANREP]).
   */
  set(i: number, v: number): void;
  /**
   * Marks a cell missing.
   *
   * **Only needed to undo a {@link RangeOutput.set} made in the same
   * pass.** Cells in `[from, to)` start missing, so clearing one the op
   * never set does nothing — which is why an empty `clear` passed the
   * whole suite until a set-then-clear case was written (Layer 2, PR
   * #573).
   */
  clear(i: number): void;
}

/**
 * Prepares a {@link RangeOutput} of `length`, carrying `[0, keep)` from
 * `prior` with one `Float64Array.set` — gaps included, as `NaN`.
 */
export function prepareRange(
  length: number,
  keep: number,
  prior: ColumnView | undefined,
): RangeOutput {
  const values = new Float64Array(length);
  // Clamped to `length` as well as to the prior: a series that SHRANK
  // gives `keep > length`, and `values.set` then throws
  // `RangeError: offset is out of bounds` before the op ever runs.
  const copy = prior === undefined ? 0 : Math.min(keep, prior.length, length);
  if (prior !== undefined && copy > 0) {
    values.set(prior.values.subarray(0, copy));
  }
  values.fill(NaN, copy);
  return {
    values,
    set(i, v) {
      // Non-finite means missing; store the canonical `NaN` gap.
      values[i] = isFinite(v) ? v : NaN;
    },
    clear(i) {
      values[i] = NaN;
    },
  };
}

/**
 * Seals a {@link RangeOutput} into a column.
 *
 * The same pass enforces non-finite-means-missing ([PND-NANREP]) for cells
 * an op wrote straight into `values`: a `±Infinity` is folded to the
 * canonical `NaN` gap. The column is `allFinite` exactly when no cell is
 * missing.
 */
export function sealRange(out: RangeOutput, length: number): Float64Column {
  const values = out.values;
  let defined = 0;
  for (let i = 0; i < length; i += 1) {
    const v = values[i]!;
    if (isFinite(v)) defined += 1;
    else values[i] = NaN;
  }
  return new Float64Column(values, length, defined === length);
}
