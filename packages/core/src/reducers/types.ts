import type { Float64Column } from '../columnar/index.js';
import type { ColumnValue } from '../schema/index.js';

/**
 * Incremental state for a single column within one aggregation bucket.
 * Created fresh per bucket. Values are fed in via `add()` as events are
 * assigned to the bucket; `snapshot()` reads the current result without
 * consuming the state.
 */
export type AggregateBucketState = {
  add(value: ColumnValue | undefined): void;
  snapshot(): ColumnValue | undefined;
};

/**
 * Incremental state for a single column within a sliding rolling window.
 * Unlike `AggregateBucketState`, this must also support `remove()` so
 * values can leave the window efficiently. `index` is a monotonically
 * increasing event counter used to identify which value to evict.
 */
export type RollingReducerState = {
  add(index: number, value: ColumnValue | undefined): void;
  remove(index: number, value: ColumnValue | undefined): void;
  snapshot(): ColumnValue | undefined;
};

/**
 * Complete definition of a named reducer. Every built-in reducer (sum,
 * avg, median, etc.) implements this interface. Each definition provides
 * three capabilities:
 *
 * - `reduce` — batch reduction over a materialized array of values.
 *   Used by `TimeSeries.reduce()`.
 *
 * - `bucketState` — factory for incremental bucket state. Used by
 *   `TimeSeries.aggregate()` where events stream into buckets one at a
 *   time. Only needs `add` + `snapshot` (values never leave a bucket).
 *
 * - `rollingState` — factory for incremental sliding-window state. Used
 *   by `TimeSeries.rolling()` where events both enter and leave the
 *   window. Must support `add`, `remove`, and `snapshot`.
 *
 * `outputKind` tells the aggregate schema builder what kind the reducer
 * produces: `'number'` for reducers that always emit a number (sum, avg),
 * `'source'` to preserve the source column kind (first, last, keep), or
 * `'array'` for reducers that collapse a bucket into a list of values
 * (unique).
 */
export type ReducerDef = {
  outputKind: 'number' | 'source' | 'array';

  /**
   * Batch reduce over a complete value array. `defined` contains all
   * non-undefined values (any type); `numeric` contains only the number
   * values. Both are pre-filtered from the raw event data — reducers do
   * not need to filter themselves.
   */
  reduce(
    defined: ReadonlyArray<ColumnValue>,
    numeric: ReadonlyArray<number>,
  ): ColumnValue | undefined;

  /**
   * **Phase 4.7 step 3 column-fast-path.** Optional — when present and
   * the input is a packed `Float64Column`, callers may take this path
   * instead of materializing `defined` / `numeric` arrays from row-API
   * events. Skips both the lazy `series.events` materialization and the
   * `defined`/`numeric` filter passes (which together dominate
   * reduction cost on large series).
   *
   * Numeric reducers (`sum` / `count` / `min` / `max` / `avg` /
   * `stdev` / `median` / `percentile`) implement this. Reducers that
   * preserve source kind (`first` / `last` / `keep`) or build arrays
   * (`unique` / `top` / `samples`) don't — their fast path goes through
   * `reduce(defined, numeric)` over the raw values.
   *
   * Implementations should:
   * - Honor `col.validity` — skip rows where `validity.isDefined(i)` is
   *   false (or use `col.validity === undefined` to know "all defined").
   * - Iterate the underlying `col.values: Float64Array` directly. The
   *   whole point is to avoid the per-cell object access of the
   *   row-API path.
   *
   * Falls back to the `reduce(defined, numeric)` path whenever:
   * - The column kind isn't `'number'` (string / boolean / array
   *   reducers).
   * - The column storage isn't `'packed'` (chunked columns — caller
   *   can `materialize()` first, or this reducer skips the fast path).
   * - The reducer doesn't define `reduceColumn` (e.g., `first` /
   *   `last`).
   *
   * Caller is responsible for the dispatch check; the reducer's
   * `reduceColumn` may assume the column is a packed `Float64Column`.
   */
  reduceColumn?(col: Float64Column): ColumnValue | undefined;

  /** Return a fresh incremental state for one aggregation bucket. */
  bucketState(): AggregateBucketState;

  /** Return a fresh incremental state for one rolling window column. */
  rollingState(): RollingReducerState;
};
