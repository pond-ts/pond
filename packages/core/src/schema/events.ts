import type { Event } from '../core/event.js';
import type { Interval } from '../core/interval.js';
import type { Time } from '../core/time.js';
import type { TimeRange } from '../core/time-range.js';
import type { EventKey } from '../core/temporal.js';
import type {
  ArrayValue,
  ColumnDef,
  ColumnValue,
  FirstColKind,
  FirstColumn,
  NormalizedValueForKind,
  RowForSchema,
  SeriesSchema,
  ValueColumn,
} from './series.js';

/**
 * What an ingest door does when a row's key is **earlier** than the row before
 * it. pond requires keys in non-decreasing order (bisect-based operators —
 * `crop`, `atTime`, range queries — rely on it); this option decides how a
 * violation is handled. Accepted by every loader: `new TimeSeries({ … })`,
 * `TimeSeries.fromJSON` / `fromColumns` / `fromArrow`, and
 * `ValueSeries.fromJSON` / `fromColumns` / `fromArrow`.
 *
 * - **`'throw'`** (default) — reject the input with a `ValidationError` naming
 *   the first out-of-order row. A backwards key is usually a corruption
 *   signal; nothing is reordered or rewritten.
 * - **`'sort'`** — stable-sort the rows by key before construction (equal keys
 *   keep their input order). Every column travels with its key. On the
 *   columnar doors this disables `Float64Array` zero-copy adoption (rows are
 *   permuted into fresh buffers). Two-edged keys sort by `(begin, end)`.
 * - **`'clamp'`** — keep every row **in place** and carry the key forward: a
 *   row whose key is earlier than the previous row's (already-clamped) key is
 *   given that previous key — `key[i] = max(key[i], key[i - 1])`, i.e. the
 *   running maximum. Ties are not violations and pass through unchanged, and a
 *   clamped row ties its predecessor (it does not get a nudged-later key). The
 *   values are untouched, so a lone backwards blip in a noisy time feed lands
 *   on its neighbour's timestamp rather than being moved elsewhere in the
 *   series. **This rewrites keys** — the series no longer holds the timestamp
 *   the source sent for a clamped row — and an early *forward* outlier
 *   (`0, 1000, 2, 3`) plateaus every row after it at the outlier (`0, 1000,
 *   1000, 1000`); use `'sort'` when the rows are merely out of order rather
 *   than noisy. Supported for single-edged keys only (`time`, and a
 *   `ValueSeries` `value` axis): a `timeRange` / `interval` key throws, since
 *   there is no one right way to clamp a two-edged key (move `begin` only and
 *   it can pass `end`; shift the whole span and the duration-preserving guess
 *   is still a guess). Non-finite keys are still rejected, never clamped.
 *   Value-column `Float64Array`s stay zero-copy adopted; the key column is
 *   copied before the first rewrite, so a caller's buffer is never mutated.
 */
export type OnOutOfOrder = 'throw' | 'sort' | 'clamp';

export type TimeSeriesInput<S extends SeriesSchema> = {
  name: string;
  schema: S;
  rows: ReadonlyArray<RowForSchema<S>>;
  /**
   * How to handle a row whose key is earlier than the previous row's — see
   * {@link OnOutOfOrder}. Default `'throw'`. (This is what
   * `TimeSeries.fromEvents` does with `'sort'` unconditionally.)
   */
  onOutOfOrder?: OnOutOfOrder;
  /**
   * @deprecated Use `onOutOfOrder: 'sort'`. Kept for one release as an alias:
   * `sort: true` means `onOutOfOrder: 'sort'`. Passing both with conflicting
   * meanings (e.g. `sort: true, onOutOfOrder: 'clamp'`) throws.
   */
  sort?: boolean;
};

export type NormalizedRowForSchema<
  S extends readonly ColumnDef<string, string>[],
> = {
  [I in keyof S]: S[I] extends ColumnDef<any, infer K>
    ? I extends '0'
      ? NormalizedValueForKind<K> // key column is always present
      : S[I] extends { required: false }
        ? NormalizedValueForKind<K> | undefined
        : NormalizedValueForKind<K>
    : never;
};

type DataValueForColumn<C extends ColumnDef<string, string>> =
  C extends ColumnDef<any, infer K>
    ? C['required'] extends false
      ? NormalizedValueForKind<K> | undefined
      : NormalizedValueForKind<K>
    : never;

type NormalizedDataValueForColumn<C extends ColumnDef<string, string>> =
  C extends ColumnDef<any, infer K>
    ? K extends FirstColKind
      ? EventKeyForKind<K>
      : C['required'] extends false
        ? NormalizedValueForKind<K> | undefined
        : NormalizedValueForKind<K>
    : never;

type DataColumnsForSchema<S extends SeriesSchema> = S extends readonly [
  FirstColumn,
  ...infer Rest,
]
  ? Rest extends readonly ValueColumn[]
    ? Rest
    : never
  : never;

export type NormalizedObjectRowForSchema<S extends SeriesSchema> = Partial<{
  [C in S[number] as C['name']]: NormalizedDataValueForColumn<C>;
}>;

export type NormalizedObjectRow = Readonly<
  Record<string, EventKey | ColumnValue | undefined>
>;

export type EventDataForSchema<S extends SeriesSchema> = {
  [C in DataColumnsForSchema<S>[number] as C['name']]: DataValueForColumn<C>;
};

/**
 * Wide-row shape returned by `TimeSeries.toPoints()`: `ts` plus every
 * value column from the schema. Each value column is `T | undefined`
 * regardless of the schema's `required` flag.
 *
 * Why ignore `required`? Charting workflows are the dominant consumer.
 * Even on a `required: true` schema, transformed series can produce
 * rows with `undefined` cells — `baseline()` adds optional `avg` /
 * `sd` / `upper` / `lower` columns, `align()` produces gaps before
 * the first source event, and aggregations on partial buckets emit
 * `undefined` for some reducers. Chart libraries handle the
 * `T | undefined` shape natively (rendering gaps via
 * `connectNulls={false}`); narrowing to `T` would force every caller
 * to widen back. If you have a fully-required schema and want strict
 * narrowing, work with `EventDataForSchema<S>` directly instead of
 * `toPoints()`.
 *
 * Caveat: a value column literally named `ts` would collide with the
 * timestamp key. The library doesn't currently guard against this;
 * pick a different column name if it matters.
 */
export type PointRowForSchema<S extends SeriesSchema> = { ts: number } & {
  [C in DataColumnsForSchema<S>[number] as C['name']]:
    | NormalizedValueForKind<C['kind']>
    | undefined;
};

export type EventKeyForKind<K extends FirstColKind> = K extends 'time'
  ? Time
  : K extends 'timeRange'
    ? TimeRange
    : K extends 'interval'
      ? Interval
      : never;

export type EventKeyForSchema<S extends SeriesSchema> =
  S[0] extends ColumnDef<any, infer K>
    ? K extends FirstColKind
      ? EventKeyForKind<K>
      : EventKey
    : EventKey;

export type EventForSchema<S extends SeriesSchema> = Event<
  EventKeyForSchema<S>,
  EventDataForSchema<S>
>;

export interface LiveSource<S extends SeriesSchema> {
  readonly name: string;
  readonly schema: S;
  readonly length: number;
  at(index: number): EventForSchema<S> | undefined;
  on(type: 'event', fn: (event: EventForSchema<S>) => void): () => void;
}
