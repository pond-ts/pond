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

export type TimeSeriesInput<S extends SeriesSchema> = {
  name: string;
  schema: S;
  rows: ReadonlyArray<RowForSchema<S>>;
  /**
   * Sort `rows` by key on construction. Off by default — pond requires rows
   * in non-decreasing key order and throws otherwise. Set `true` when
   * ingesting unsorted data (messy CSVs, merged sources) rather than
   * pre-sorting yourself. The sort is **stable**, so rows with equal keys keep
   * their input order. (This is what `TimeSeries.fromEvents` does
   * unconditionally; `sort` brings the same convenience to the row
   * constructor.)
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
