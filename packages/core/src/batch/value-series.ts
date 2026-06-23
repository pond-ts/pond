import {
  type Column as ColumnarColumn,
  type ColumnarStore,
  type ColumnSchema,
  ValueKeyColumn,
  withRowRange,
} from '../columnar/index.js';
import type {
  ValueSeriesColumnName,
  ValueSeriesSchema,
} from '../schema/index.js';

/**
 * A **value-keyed series** — the closed value-axis counterpart of
 * `TimeSeries`. Its key is a monotonic non-time axis (distance, cumulative
 * work, …) rather than time, produced by `TimeSeries.byValue(axis)`.
 *
 * `ValueSeries` carries the **ordering-based** operators (read the axis, read
 * value columns, nearest-by-value, slice-by-value) — the part of the series
 * algebra that was never really about time (RFC `value-axis.md` §5). The
 * calendar/clock operators (`Sequence.every`, tz formatting) are deliberately
 * absent: a value axis has no wall-clock semantics, and the disjoint
 * `ValueSeriesSchema` makes them type-impossible here.
 *
 * Minimal by design (RFC §7: adopt the type early, grow the algebra as a second
 * value-axis consumer earns it). Wraps the columnar store directly — a value
 * row is an `(axis, …values)` tuple, not a `Time`-keyed `Event`, so it does not
 * go through the time-only `SeriesStore` / EventKey layer.
 */
export class ValueSeries<VS extends ValueSeriesSchema> {
  readonly name: string;
  readonly schema: VS;
  readonly #store: ColumnarStore<ColumnSchema>;

  /**
   * @internal Trusted construction — `store` must be value-keyed and structurally
   * match `schema` (the invariant `TimeSeries.byValue` / `byValueOp` establish).
   * Not for general use; construct a `ValueSeries` via `TimeSeries.byValue`.
   */
  static fromTrustedStore<VS extends ValueSeriesSchema>(
    name: string,
    schema: VS,
    store: ColumnarStore<ColumnSchema>,
  ): ValueSeries<VS> {
    return new ValueSeries(name, schema, store);
  }

  private constructor(
    name: string,
    schema: VS,
    store: ColumnarStore<ColumnSchema>,
  ) {
    this.name = name;
    this.schema = Object.freeze(schema.slice()) as unknown as VS;
    this.#store = store;
  }

  /** Number of rows. */
  get length(): number {
    return this.#store.length;
  }

  /** The axis (key) column's name — e.g. `'cumDist'`. */
  get axisName(): VS[0]['name'] {
    return this.schema[0]!.name as VS[0]['name'];
  }

  /**
   * The axis values (the x of every row), in axis order. **Zero-copy** — the
   * returned `Float64Array` is the live key buffer; treat it as read-only.
   */
  axisValues(): Float64Array {
    return (this.#store.keys as ValueKeyColumn).begin;
  }

  /** The axis value at row `i`. Throws if out of range. */
  axisAt(i: number): number {
    return (this.#store.keys as ValueKeyColumn).beginAt(i);
  }

  /** A value column by name, for direct columnar reads (`.read(i)`, `.values()`). */
  column(name: ValueSeriesColumnName<VS>): ColumnarColumn | undefined {
    return this.#store.columns.get(name as string);
  }

  /**
   * Index of the row whose axis value is **closest** to `value` — the
   * value-axis cursor primitive. The axis is non-decreasing, so this is a
   * binary search. Returns `-1` for an empty series; clamps to the first / last
   * row when `value` is outside the axis extent.
   */
  nearestIndex(value: number): number {
    const n = this.length;
    if (n === 0) return -1;
    const ax = this.axisValues();
    const lo = lowerBound(ax, n, value);
    if (lo === 0) return 0;
    if (lo === n) return n - 1;
    return value - ax[lo - 1]! <= ax[lo]! - value ? lo - 1 : lo;
  }

  /**
   * The contiguous sub-series whose axis value lies in `[lo, hi)` — the
   * value-axis cull (pan / zoom on a value x). Binary-searches the bounds and
   * zero-copy slices the store. `lo >= hi` (or a range outside the extent)
   * yields an empty series.
   */
  sliceByValue(lo: number, hi: number): ValueSeries<VS> {
    const ax = this.axisValues();
    const n = this.length;
    const loIdx = lowerBound(ax, n, lo);
    const hiIdx = lowerBound(ax, n, hi);
    const sliced = withRowRange(this.#store, loIdx, hiIdx);
    return ValueSeries.fromTrustedStore(this.name, this.schema, sliced);
  }
}

/** First index `i` in `ax[0..n)` with `ax[i] >= target` (lower bound). */
function lowerBound(ax: Float64Array, n: number, target: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ax[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
