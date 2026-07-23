import {
  type Column as ColumnarColumn,
  type ColumnarStore,
  type ColumnSchema,
  ValueKeyColumn,
  withRowRange,
} from '../columnar/index.js';
import { ValidationError } from '../core/errors.js';
import { ingestColumnsToStore } from './operators/ingest-columns.js';
import type {
  ValueSeriesColumnName,
  ValueSeriesSchema,
} from '../schema/index.js';

/**
 * A **value-keyed series** — the closed value-axis counterpart of
 * `TimeSeries`. Its key is a monotonic non-time axis (distance, cumulative
 * work, …). Two doors in: **project** a `TimeSeries` onto one of its monotonic
 * columns (`TimeSeries.byValue(axis)` — a track re-keyed by cumulative
 * distance), or **construct directly** from columnar arrays
 * ({@link ValueSeries.fromColumns}) when the data is natively value-keyed and
 * never had a meaningful time key per row — cross-sectional data such as an
 * options chain keyed by strike or a spectrum keyed by frequency.
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
   * Not for general use; construct a `ValueSeries` via `TimeSeries.byValue` or
   * {@link ValueSeries.fromColumns}.
   */
  static fromTrustedStore<VS extends ValueSeriesSchema>(
    name: string,
    schema: VS,
    store: ColumnarStore<ColumnSchema>,
  ): ValueSeries<VS> {
    return new ValueSeries(name, schema, store);
  }

  /**
   * Example: `ValueSeries.fromColumns({ name, schema, columns })`.
   *
   * The **direct columnar door** into value-land — for data that is *natively*
   * value-keyed and never had a meaningful per-row time key: an options chain
   * keyed by strike, a spectrum keyed by frequency, a profile keyed by depth.
   * (Data that starts life time-keyed projects in via `TimeSeries.byValue`
   * instead; before this door existed, cross-sectional callers had to launder
   * their axis through a fake `time` column just to reach
   * `TimeSeries.fromColumns` + `byValue`.)
   *
   * The exact `TimeSeries.fromColumns` contract, with the axis in place of
   * time — the two doors share one ingest engine. `schema[0]` is the
   * `'value'`-kind **axis** column; each `columns` entry is one column's
   * values, keyed by schema column name and aligned by index. Values may be a
   * plain `number[]` **or** a `Float64Array`; a value cell is a gap (missing)
   * iff it's `null`/`undefined` or non-finite — identical rule for both input
   * types.
   *
   * **`Float64Array` inputs are adopted, not copied** (zero-copy): the
   * resulting series' columns alias the caller's buffers; pass a fresh buffer
   * if that matters. (**`sort` disables the adoption** — a reorder needs its
   * own buffers.)
   *
   * **Ordering.** The axis must be **defined, finite, and non-decreasing** —
   * it becomes the index (the same contract `byValue` enforces with
   * `assertMonotonicAxis`), so an out-of-order axis throws by default. Pass
   * **`sort: true`** to sort the rows by axis value before construction — the
   * stable sort every unordered snapshot wants (e.g. a keyed live feed that
   * delivers rows in update order, not axis order).
   *
   * **Value columns:** `number` and `string`, matching `TimeSeries.fromColumns`.
   *
   * @throws ValidationError on a non-`'value'` axis kind, a missing column, a
   *   length mismatch, an unsupported value-column kind, or an out-of-order axis
   *   when `sort` is not set. Throws RangeError on a non-finite
   *   (`null`/`NaN`/`±Infinity`) axis cell — sorting can't make it valid — or
   *   a duplicate column name (the axis name repeated among the value columns).
   */
  static fromColumns<VS extends ValueSeriesSchema>(input: {
    name: string;
    schema: VS;
    columns: Record<
      string,
      | ReadonlyArray<number | null | undefined>
      | Float64Array
      | ReadonlyArray<string | null | undefined>
    >;
    /**
     * Sort the rows by axis value before construction (off by default), for a
     * payload whose rows aren't guaranteed ordered. Stable; disables the
     * `Float64Array` zero-copy adoption (columns are reordered into fresh
     * buffers).
     */
    sort?: boolean;
  }): ValueSeries<VS> {
    const { name, schema, columns, sort = false } = input;

    const keyDef = (schema as ValueSeriesSchema)[0];
    if (keyDef === undefined) {
      throw new ValidationError(
        'ValueSeries.fromColumns: schema must have at least an axis column',
      );
    }
    if (keyDef.kind !== 'value') {
      throw new ValidationError(
        `ValueSeries.fromColumns: schema[0] '${keyDef.name}' must be the 'value'-kind axis column; got '${keyDef.kind}'`,
      );
    }

    const store = ingestColumnsToStore({
      op: 'ValueSeries.fromColumns',
      keyNoun: 'axis values',
      schema: schema as unknown as ColumnSchema,
      columns,
      sort,
      makeKey: (begin, count) => new ValueKeyColumn(begin, count),
    });
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
