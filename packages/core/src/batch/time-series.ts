import type {
  AlignSchema,
  MaterializeSchema,
  ArrayAggregateAppendSchema,
  ArrayAggregateReplaceSchema,
  ArrayColumnNameForSchema,
  ArrayExplodeAppendSchema,
  ArrayExplodeReplaceSchema,
  ArrayValue,
  BaselineSchema,
  AggregateFunction,
  AggregateReducer,
  AggregateOutputMap,
  AggregateOutputSpec,
  AggregateMap,
  AggregateSchema,
  CollapseSchema,
  EventDataForSchema,
  EventForSchema,
  FirstColKind,
  IntervalKeyedSchema,
  JsonObjectRowForSchema,
  JsonRowFormat,
  JsonRowForSchema,
  TimeSeriesJsonOutputArray,
  TimeSeriesJsonOutputObject,
  JsonValueForKind,
  JoinConflictMode,
  JoinManySchema,
  JoinSchema,
  JoinType,
  NumericColumnNameForSchema,
  NormalizedObjectRow,
  NormalizedObjectRowForSchema,
  NormalizedRowForSchema,
  PivotByGroupSchema,
  PointRowForSchema,
  PrefixedJoinManySchema,
  PrefixedJoinSchema,
  ReduceResult,
  RenameMap,
} from '../schema/index.js';
import type {
  AggregateOutputMapResultSchema,
  RollingOutputMapSchema,
} from '../schema/index.js';
import type {
  RenameSchema,
  RollingAlignment,
  RollingSchema,
  ColumnValue,
  CustomAggregateReducer,
  DedupeKeep,
  DiffSchema,
  FillMapping,
  FillStrategy,
  ScalarKind,
  ScalarValue,
  SmoothMethod,
  SmoothAppendSchema,
  SmoothSchema,
  SelectSchema,
  SeriesSchema,
  TimeKeyedSchema,
  TimeSeriesJsonInput,
  TimeSeriesInput,
  TimeRangeKeyedSchema,
  ValueColumn,
  ValueColumnKindForName,
  ValueColumnNameForSchema,
  ValueColumnsForSchema,
} from '../schema/index.js';
import {
  isAggregateOutputSpec,
  normalizeAggregateColumns,
  tryAggregateColumnarTimeKeyed,
} from './aggregate-columns.js';
import {
  cumulativeOp,
  type CumulativeReducer,
} from './operators/cumulative.js';
import { diffRateOp, type DiffRateMode } from './operators/diff-rate.js';
import { fillOp, type ResolvedFillSpec } from './operators/fill.js';
import { mapOp, type ColumnMapper } from './operators/map.js';
import { shiftOp } from './operators/shift.js';
import { collapseOp, type CollapseReducer } from './operators/collapse.js';
import { BoundedSequence } from '../sequence/bounded-sequence.js';
import {
  parseTimestampString,
  type TimeZoneOptions,
} from '../core/calendar.js';
import { Interval } from '../core/interval.js';
import { Time } from '../core/time.js';
import { TimeRange } from '../core/time-range.js';
import type {
  EventKey,
  IntervalInput,
  IntervalValue,
  TemporalLike,
  TimeRangeInput,
  TimestampInput,
} from '../core/temporal.js';
import { compareEventKeys } from '../core/temporal.js';
import { Event } from '../core/event.js';
import { PartitionedTimeSeries } from './partitioned-time-series.js';
import type { BatchSampleStrategy } from '../sequence/sample.js';
import { Sequence } from '../sequence/sequence.js';
import {
  type Column as ColumnarColumn,
  type ColumnarStore,
  type ColumnSchema,
  Float64Column,
  IntervalKeyColumn,
  StringColumn,
  TimeKeyColumn,
  TimeRangeKeyColumn,
  float64ColumnFromArray,
  stringColumnFromArray,
  withColumnsRenamed,
  withColumnsSelected,
  withKeyColumn,
  withRowRange,
} from '../columnar/index.js';
import type { KeyColumnForSchema, PublicColumnForKind } from '../column.js';
import { SeriesStore } from '../live/series-store.js';
import { validateAndNormalize } from './validate.js';
import type { DurationInput } from '../core/duration.js';
import { parseDuration } from '../core/duration.js';
import {
  resolveReducer,
  type AggregateBucketState,
  type RollingReducerState,
} from '../reducers/index.js';

type RangeLike = EventKey | TimeRangeInput | IntervalInput;
type BoundaryLike = EventKey | TimestampInput;
/**
 * Accepted shape for key-position queries (`bisect`, `includesKey`,
 * `atOrBefore`, `atOrAfter` on `TimeSeries` / `LiveSeries` /
 * `LiveView`). Normalised through {@link toKey}.
 */
export type KeyLike =
  | EventKey
  | TimestampInput
  | TimeRangeInput
  | IntervalInput;
type SeriesRangeLike = TemporalLike | { timeRange(): TimeRange | undefined };
type AlignMethod = 'hold' | 'linear';
type AlignSample = 'begin' | 'center' | 'end';
type SequenceLike = Sequence | BoundedSequence;
type ErrorJoinOptions = { type?: JoinType; onConflict?: 'error' };
type PrefixJoinOptions<Prefixes extends readonly string[]> = {
  type?: JoinType;
  onConflict: 'prefix';
  prefixes: Prefixes;
};
type AlignCursor = { index: number };
type JoinOptions = ErrorJoinOptions | PrefixJoinOptions<readonly string[]>;
type PivotByGroupOptions = { aggregate?: AggregateReducer };
type PivotByGroupOptionsTyped<Groups extends readonly string[]> =
  PivotByGroupOptions & { groups: Groups };
type SeriesTuple = readonly [
  TimeSeries<SeriesSchema>,
  ...TimeSeries<SeriesSchema>[],
];

type SchemasForSeriesTuple<T extends SeriesTuple> = {
  [I in keyof T]: T[I] extends TimeSeries<infer Schema> ? Schema : never;
} extends infer Result
  ? Result extends readonly [SeriesSchema, ...SeriesSchema[]]
    ? Result
    : never
  : never;

// JSON ↔ typed-row primitives live in `./json.js`. Both `TimeSeries`
// and `LiveSeries` reach for them; extracted to break the import cycle
// that would otherwise form (Event needs them, TimeSeries imports
// Event).
import { parseJsonRows, serializeJsonKey, serializeJsonValue } from './json.js';

type PrefixesForSeriesTuple<T extends SeriesTuple> = {
  [I in keyof T]: string;
} extends infer Result
  ? Result extends readonly [string, ...string[]]
    ? Result
    : never
  : never;

function toRows<S extends SeriesSchema>(
  schema: S,
  events: ReadonlyArray<EventForSchema<S>>,
): TimeSeriesInput<S>['rows'] {
  return events.map((event) => {
    const data = event.data();
    return Object.freeze([
      event.key(),
      ...schema
        .slice(1)
        .map((column) => data[column.name as keyof typeof data]),
    ]) as TimeSeriesInput<S>['rows'][number];
  }) as TimeSeriesInput<S>['rows'];
}

function toObjects<S extends SeriesSchema>(
  schema: S,
  events: ReadonlyArray<EventForSchema<S>>,
): ReadonlyArray<NormalizedObjectRow> {
  const keyColumn = schema[0]!;
  const dataColumns = schema.slice(1);
  return events.map((event) => {
    const row: Record<string, unknown> = {
      [keyColumn.name]: event.key(),
    };
    const data = event.data();

    for (const column of dataColumns) {
      row[column.name] = data[column.name as keyof typeof data];
    }

    return Object.freeze(row) as NormalizedObjectRowForSchema<S>;
  }) as ReadonlyArray<NormalizedObjectRow>;
}

function isEventKey(value: unknown): value is EventKey {
  return (
    typeof value === 'object' &&
    value !== null &&
    'begin' in value &&
    'end' in value
  );
}

function toBoundaryTimestamp(value: BoundaryLike): number {
  if (isEventKey(value)) {
    return value.begin();
  }
  return value instanceof Date ? value.getTime() : value;
}

export function toKey(value: KeyLike): EventKey {
  if (isEventKey(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length === 2) {
      return new TimeRange(value as TimeRangeInput);
    }
    return new Interval(value as IntervalInput);
  }
  if (typeof value === 'object' && value !== null) {
    if ('value' in value) {
      return new Interval(value as Extract<KeyLike, { value: unknown }>);
    }
    if ('start' in value && 'end' in value) {
      return new TimeRange(value as TimeRangeInput);
    }
  }
  return new Time(value as TimestampInput);
}

function toSelectionRange(value: RangeLike): TimeRange {
  if (value instanceof TimeRange) {
    return value;
  }
  if (value instanceof Interval) {
    return value.timeRange();
  }
  if (isEventKey(value)) {
    return new TimeRange({ start: value.begin(), end: value.end() });
  }
  if (Array.isArray(value)) {
    if (value.length === 2) {
      return new TimeRange(value as TimeRangeInput);
    }
    return new Interval(value as IntervalInput).timeRange();
  }
  if ('value' in value) {
    return new Interval(
      value as Extract<RangeLike, { value: unknown }>,
    ).timeRange();
  }
  return new TimeRange(value as TimeRangeInput);
}

function toOptionalSeriesRange(value: SeriesRangeLike): TimeRange | undefined {
  if (
    typeof value === 'object' &&
    value !== null &&
    'timeRange' in value &&
    typeof value.timeRange === 'function'
  ) {
    return value.timeRange() ?? undefined;
  }
  return toSelectionRange(value as RangeLike);
}

function makeAlignedSchema<S extends SeriesSchema>(schema: S): AlignSchema<S> {
  return Object.freeze([
    { name: 'interval', kind: 'interval' as const },
    ...schema.slice(1).map((column) => ({
      ...column,
      required: false as const,
    })),
  ]) as AlignSchema<S>;
}

function makeMaterializedSchema<S extends SeriesSchema>(
  schema: S,
): MaterializeSchema<S> {
  return Object.freeze([
    { name: 'time', kind: 'time' as const },
    ...schema.slice(1).map((column) => ({
      ...column,
      required: false as const,
    })),
  ]) as MaterializeSchema<S>;
}

function sampleTime(interval: Interval, sample: AlignSample): number {
  switch (sample) {
    case 'begin':
      return interval.begin();
    case 'center':
      return interval.begin() + interval.duration() / 2;
    case 'end':
      return interval.end();
  }
}

function eventAnchorTime(key: EventKey): number {
  return key instanceof Time ? key.begin() : key.timeRange().midpoint();
}

function loessAt(
  x: number,
  anchors: ReadonlyArray<number>,
  values: ReadonlyArray<number>,
  span: number,
): number | undefined {
  if (anchors.length === 0) {
    return undefined;
  }

  if (anchors.length === 1) {
    return values[0];
  }

  const neighborCount = Math.max(
    2,
    Math.min(anchors.length, Math.ceil(span * anchors.length)),
  );
  let start = 0;
  if (neighborCount < anchors.length) {
    let low = 0;
    let high = anchors.length - neighborCount;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (x - anchors[mid]! > anchors[mid + neighborCount]! - x) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    start = low;
  }

  const end = start + neighborCount;
  const bandwidth = Math.max(
    Math.abs(x - anchors[start]!),
    Math.abs(anchors[end - 1]! - x),
  );

  if (bandwidth === 0) {
    const coincidentStart = lowerBound(anchors, x);
    const coincidentEnd = upperBound(anchors, x);
    let coincidentSum = 0;
    for (let index = coincidentStart; index < coincidentEnd; index++) {
      coincidentSum += values[index]!;
    }
    return coincidentSum / (coincidentEnd - coincidentStart);
  }

  let weightedCount = 0;
  let sumW = 0;
  let sumWX = 0;
  let sumWY = 0;
  let sumWXX = 0;
  let sumWXY = 0;

  for (let index = start; index < end; index++) {
    const pointX = anchors[index]!;
    const pointY = values[index]!;
    const distance = Math.abs(pointX - x);
    const ratio = distance / bandwidth;
    const weight = ratio >= 1 ? 0 : (1 - ratio ** 3) ** 3;
    if (weight === 0) {
      continue;
    }
    weightedCount += 1;
    sumW += weight;
    sumWX += weight * pointX;
    sumWY += weight * pointY;
    sumWXX += weight * pointX * pointX;
    sumWXY += weight * pointX * pointY;
  }

  if (weightedCount === 0 || sumW === 0) {
    return undefined;
  }

  const denominator = sumW * sumWXX - sumWX * sumWX;
  if (Math.abs(denominator) < Number.EPSILON) {
    return sumWY / sumW;
  }

  const intercept = (sumWY * sumWXX - sumWX * sumWXY) / denominator;
  const slope = (sumW * sumWXY - sumWX * sumWY) / denominator;
  return intercept + slope * x;
}

function lowerBound(values: ReadonlyArray<number>, target: number): number {
  let low = 0;
  let high = values.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid]! < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function upperBound(values: ReadonlyArray<number>, target: number): number {
  let low = 0;
  let high = values.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid]! <= target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function makeSmoothSchema<
  S extends SeriesSchema,
  Target extends NumericColumnNameForSchema<S>,
>(schema: S, target: Target): SmoothSchema<S, Target>;
function makeSmoothSchema<
  S extends SeriesSchema,
  Target extends NumericColumnNameForSchema<S>,
  Name extends string,
>(schema: S, target: Target, output: Name): SmoothAppendSchema<S, Name>;
function makeSmoothSchema<
  S extends SeriesSchema,
  Target extends NumericColumnNameForSchema<S>,
>(
  schema: S,
  target: Target,
  output?: string,
): SmoothSchema<S, Target> | SmoothAppendSchema<S, string> {
  if (output === undefined || output === target) {
    return Object.freeze([
      schema[0],
      ...schema.slice(1).map((column) =>
        column.name === target
          ? {
              name: column.name,
              kind: 'number' as const,
              required: false as const,
            }
          : column,
      ),
    ]) as unknown as SmoothSchema<S, Target>;
  }

  if (schema.slice(1).some((column) => column.name === output)) {
    throw new TypeError(`smooth output column '${output}' already exists`);
  }

  return Object.freeze([
    schema[0],
    ...schema.slice(1),
    { name: output, kind: 'number' as const, required: false as const },
  ]) as unknown as SmoothAppendSchema<S, string>;
}

function toBoundedSequence(
  sequence: SequenceLike,
  range: TemporalLike,
  sample: AlignSample,
): BoundedSequence {
  return sequence instanceof BoundedSequence
    ? sequence
    : sequence.bounded(range, { sample });
}

function isTimeKeyed<S extends SeriesSchema>(series: TimeSeries<S>): boolean {
  return series.firstColumnKind === 'time';
}

function bucketContainsHalfOpen(bucket: Interval, timestamp: number): boolean {
  return timestamp >= bucket.begin() && timestamp < bucket.end();
}

function bucketOverlapsHalfOpen(bucket: Interval, event: EventKey): boolean {
  if (event.begin() === event.end()) {
    return bucketContainsHalfOpen(bucket, event.begin());
  }
  return event.begin() < bucket.end() && bucket.begin() < event.end();
}

function aggregateValues(
  operation: AggregateFunction,
  values: ReadonlyArray<ColumnValue | undefined>,
): ColumnValue | undefined {
  const defined = values.filter(
    (value): value is ColumnValue => value !== undefined,
  );
  const numeric = defined.filter(
    (value): value is number => typeof value === 'number',
  );
  return resolveReducer(operation).reduce(defined, numeric);
}

/**
 * Phase 4.7 step 3 — column-fast-path entry for `series.reduce(col,
 * reducer)`. When the reducer defines `reduceColumn` and the column
 * is a packed `Float64Column`, skip `series.events` materialization
 * + the row-API `defined` / `numeric` filter passes; walk the
 * underlying typed array directly. Falls back to `null` for the
 * caller to take the row-API path otherwise (mixed kinds, chunked
 * storage, reducers that don't have a column fast path like
 * `first` / `last`).
 */
function tryReduceColumnFastPath(
  reducer: AggregateReducer,
  column: import('../columnar/index.js').Column | undefined,
): { ok: true; value: ColumnValue | undefined } | { ok: false } {
  if (!isBuiltInAggregateReducer(reducer)) return { ok: false };
  if (column === undefined) return { ok: false };
  if (column.kind !== 'number' || column.storage !== 'packed') {
    return { ok: false };
  }
  const def = resolveReducer(reducer);
  if (def.reduceColumn === undefined) return { ok: false };
  return { ok: true, value: def.reduceColumn(column) };
}

function isBuiltInAggregateReducer(
  reducer: AggregateReducer,
): reducer is AggregateFunction {
  return typeof reducer === 'string';
}

function applyAggregateReducer(
  reducer: AggregateReducer,
  values: ReadonlyArray<ColumnValue | undefined>,
): ColumnValue | undefined {
  return isBuiltInAggregateReducer(reducer)
    ? aggregateValues(reducer, values)
    : (reducer as CustomAggregateReducer)(values);
}

// `normalizeAggregateColumns`, `isAggregateOutputSpec`, and the
// `AggregateColumnSpec` shape are extracted to `aggregate-columns.ts`
// so the live accumulators (LiveRollingAggregation, LiveAggregation,
// LivePartitionedSyncRolling) share the same normalisation. See the
// import below.

function createAggregateBucketState(
  operation: AggregateFunction,
): AggregateBucketState {
  return resolveReducer(operation).bucketState();
}

/**
 * Resolve the output column kind for an `arrayAggregate` call. Numeric
 * reducers always emit `'number'`; `'unique'` emits `'array'`; everything
 * else (including custom reducers) falls back to `'string'` unless the
 * caller supplies an explicit `kind`.
 */
function resolveArrayAggregateKind(
  reducer: AggregateReducer,
  explicitKind: ScalarKind | undefined,
): ScalarKind {
  if (explicitKind !== undefined) return explicitKind;
  if (typeof reducer === 'string') {
    const def = resolveReducer(reducer);
    if (def.outputKind === 'number') return 'number';
    if (def.outputKind === 'array') return 'array';
  }
  return 'string';
}

function createRollingReducerState(
  operation: AggregateFunction,
): RollingReducerState {
  return resolveReducer(operation).rollingState();
}

function duplicateValueColumnNames(
  schemas: ReadonlyArray<SeriesSchema>,
): string[] {
  const counts = new Map<string, number>();
  for (const schema of schemas) {
    for (const column of schema.slice(1)) {
      counts.set(column.name, (counts.get(column.name) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort();
}

function assertDistinctValueColumns(
  schemas: ReadonlyArray<SeriesSchema>,
  message: string,
): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const schema of schemas) {
    for (const column of schema.slice(1)) {
      if (seen.has(column.name)) {
        duplicates.add(column.name);
      } else {
        seen.add(column.name);
      }
    }
  }
  if (duplicates.size > 0) {
    throw new TypeError(`${message}: ${[...duplicates].sort().join(', ')}`);
  }
}

function buildConflictRenameMap(
  schema: SeriesSchema,
  duplicates: ReadonlySet<string>,
  prefix: string,
): Partial<Record<string, string>> {
  const renameMap: Partial<Record<string, string>> = {};
  for (const column of schema.slice(1)) {
    if (duplicates.has(column.name)) {
      renameMap[column.name] = `${prefix}_${column.name}`;
    }
  }
  return renameMap;
}

function prepareSeriesForJoin<T extends SeriesTuple>(
  series: T,
  options: JoinOptions,
): T {
  const conflictMode: JoinConflictMode = options.onConflict ?? 'error';
  const duplicates = duplicateValueColumnNames(
    series.map((item) => item.schema),
  );

  if (duplicates.length === 0) {
    return series;
  }

  if (conflictMode === 'error') {
    throw new TypeError(
      `cannot join series with duplicate column names: ${duplicates.join(', ')}`,
    );
  }

  const prefixOptions = options as PrefixJoinOptions<readonly string[]>;

  if (prefixOptions.prefixes.length !== series.length) {
    throw new TypeError(
      `prefix conflict handling requires exactly ${series.length} prefixes`,
    );
  }

  const duplicateSet = new Set(duplicates);
  const renamedSeries = series.map((item, index) => {
    const renameMap = buildConflictRenameMap(
      item.schema,
      duplicateSet,
      prefixOptions.prefixes[index]!,
    );
    return item.rename(renameMap);
  }) as unknown as T;

  assertDistinctValueColumns(
    renamedSeries.map((item) => item.schema),
    'prefix conflict handling still produced duplicate column names',
  );

  return renamedSeries;
}

/**
 * An immutable ordered collection of typed events sharing a common schema.
 *
 * @example
 * ```ts
 * const schema = [
 *   { name: "time", kind: "time" },
 *   { name: "cpu", kind: "number" },
 *   { name: "host", kind: "string" },
 * ] as const;
 *
 * const series = new TimeSeries({
 *   name: "cpu-usage",
 *   schema,
 *   rows: [[new Date("2025-01-01T00:00:00.000Z"), 0.42, "api-1"]],
 * });
 *
 * series.first()?.get("cpu"); // 0.42
 * series.timeRange(); // overall extent of the series
 * series.within(new TimeRange({ start: 0, end: Date.now() })); // fully contained events
 * series.align(Sequence.every("1m")); // uses the series range over an epoch-anchored minute grid
 * ```
 */
/**
 * Module-private sentinel used to route already-built `SeriesStore`
 * instances through the public constructor without re-validating.
 * The Symbol is unforgeable — external callers can't construct a
 * `TimeSeries` with a `_trustedStore` because they can't reach the
 * Symbol's identity. This replaces the `Object.create(prototype)`
 * pattern that used to bypass the constructor (incompatible with ES
 * private fields, which are installed only when a constructor
 * actually runs).
 */
const TRUSTED_STORE_SENTINEL: unique symbol = Symbol(
  'TimeSeries.trustedStoreSentinel',
);

/**
 * Internal extension of `TimeSeriesInput` carrying a pre-built
 * `SeriesStore`. Recognized by the constructor via the sentinel
 * Symbol; recognized only inside this module.
 */
type TrustedStoreInput<S extends SeriesSchema> = {
  readonly name: string;
  readonly schema: S;
  readonly [TRUSTED_STORE_SENTINEL]: SeriesStore<S>;
};

export class TimeSeries<S extends SeriesSchema> {
  readonly name: string;
  readonly schema: S;
  /**
   * The columnar-backed row-API store. Holds the validated key
   * column, value columns, and the lazy `Map<rowIndex, Event>` cache
   * that keeps `event` identity stable across `at(i)` / `events[i]`
   * / iteration. Replaces the previous `readonly events: Event[]`
   * field (sub-step 2a of the columnar TimeSeries integration).
   */
  readonly #store: SeriesStore<S>;

  /**
   * Example: `TimeSeries.joinMany([cpu.align(seq), memory.align(seq), errors.align(seq)])`.
   * Performs an exact-key n-ary join across many series.
   *
   * Use `join(...)` for the binary case and `joinMany(...)` when you want to build one wide series
   * from several aligned or aggregated inputs. This avoids repeated manual pairwise joins in
   * feature-building, reporting, and dashboard pipelines.
   *
   * Defaults:
   * - `type`: `"outer"`
   * - `onConflict`: `"error"`
   */
  static joinMany<const T extends SeriesTuple>(
    series: T,
    options?: ErrorJoinOptions,
  ): TimeSeries<JoinManySchema<SchemasForSeriesTuple<T>>>;
  static joinMany<
    const T extends SeriesTuple,
    const Prefixes extends PrefixesForSeriesTuple<T>,
  >(
    series: T,
    options: PrefixJoinOptions<Prefixes>,
  ): TimeSeries<PrefixedJoinManySchema<SchemasForSeriesTuple<T>, Prefixes>>;
  static joinMany<const T extends SeriesTuple>(
    series: T,
    options: JoinOptions = {},
  ): any {
    const prepared = prepareSeriesForJoin(
      series as unknown as SeriesTuple,
      options,
    );
    const [first, ...rest] = prepared;
    let joined: TimeSeries<SeriesSchema> = first;

    for (const next of rest) {
      joined =
        options.type === undefined
          ? (joined.join(next) as unknown as TimeSeries<SeriesSchema>)
          : (joined.join(next, {
              type: options.type,
            }) as unknown as TimeSeries<SeriesSchema>);
    }

    return joined;
  }

  /**
   * Example: `TimeSeries.fromJSON({ name, schema, rows, parse: { timeZone: "Europe/Madrid" } })`.
   * Creates a typed series from JSON-style row arrays or object rows keyed by schema column names.
   *
   * `null` values are treated as missing values. Ambiguous local timestamp strings are parsed using
   * the supplied `parse.timeZone`, which defaults to `UTC`.
   */
  static fromJSON<S extends SeriesSchema>(
    input: TimeSeriesJsonInput<S> & { parse?: TimeZoneOptions },
  ): TimeSeries<S> {
    return new TimeSeries({
      name: input.name,
      schema: input.schema,
      rows: parseJsonRows(input.schema, input.rows, input.parse),
    });
  }

  /**
   * Example: `TimeSeries.fromEvents(events, { schema, name })`.
   * Builds a typed series from an array of `Event` instances. The events
   * are sorted by key before construction, so callers don't need to
   * pre-sort. The schema is taken on trust — callers should pass the
   * same schema the events were originally produced under.
   *
   * **Trust contract:** no validation against the declared schema. If
   * the caller passes events from a different schema, the series
   * builds successfully and downstream `event.get('col')` calls will
   * return undefined / produce confusing errors at access time. Most
   * callers come from `groupBy(...).values()` or other pond-ts
   * transforms and can't hit this; if you're constructing events by
   * hand, prefer `new TimeSeries({ schema, rows })` or
   * `TimeSeries.fromJSON(...)`, both of which validate.
   *
   * Closes the round-trip after `groupBy(col, fn)` + per-group transforms:
   *
   * ```ts
   * const groups = series.groupBy('host', (g) =>
   *   g.fill({ cpu: 'linear' }, { limit: 2 }),
   * );
   * const allEvents = [...groups.values()].flatMap((g) => [...g.events]);
   * const merged = TimeSeries.fromEvents(allEvents, {
   *   name: series.name,
   *   schema: series.schema,
   * });
   * ```
   *
   * For combining multiple same-schema series in one call, prefer
   * `TimeSeries.concat([...])` — it does the events-spread for you.
   */
  static fromEvents<S extends SeriesSchema>(
    events: ReadonlyArray<EventForSchema<S>>,
    options: { schema: S; name: string },
  ): TimeSeries<S> {
    const sorted = [...events].sort((a, b) =>
      compareEventKeys(a.key(), b.key()),
    );
    return TimeSeries.#fromTrustedEvents(options.name, options.schema, sorted);
  }

  /**
   * Example: `TimeSeries.concat([s1, s2, s3])`.
   * Concatenates the events of N same-schema `TimeSeries` instances and
   * returns one wider series with all events sorted by key. This is the
   * "row-append" / vertical-stack counterpart to `joinMany` (column-merge
   * by key) and the inverse of the per-group fan-out pattern from
   * `groupBy(col, fn)`. Matches `Array.prototype.concat` /
   * `pandas.concat(axis=0)` / SQL `UNION ALL` semantics.
   *
   * Schemas must match column-by-column on `name` and `kind` only —
   * the `required` flag is intentionally not part of the structural
   * check, since `required: false` only widens cell types and doesn't
   * affect the concat contract. Other mismatches throw upfront. The
   * concatenated series's `name` is taken from the first input.
   *
   * Event references survive the concat unchanged (no clones), so
   * `concat.at(0)` is the same `Event` instance as the corresponding
   * source-series event. Tied keys preserve input order via stable
   * sort — `concat([a, b])` puts a's events before b's at any shared
   * key.
   *
   * Coming from pondjs: `TimeSeries.timeSeriesListMerge(...)`'s
   * concatenation case maps to `TimeSeries.concat([...])`. Its
   * column-union case maps to `TimeSeries.joinMany([...])`.
   *
   * ```ts
   * const groups = series.groupBy('host', (g) =>
   *   g.fill({ cpu: 'linear' }, { limit: 2 }),
   * );
   * const concat = TimeSeries.concat([...groups.values()]);
   * // same schema as the source; events from all hosts re-sorted by time.
   * ```
   *
   * For combining series with different schemas (e.g. CPU and memory
   * sources) by joining on the time key, use `TimeSeries.joinMany([...])`
   * instead.
   */
  static concat<S extends SeriesSchema>(
    series: ReadonlyArray<TimeSeries<S>>,
  ): TimeSeries<S> {
    if (series.length === 0) {
      throw new TypeError(
        'TimeSeries.concat requires at least one input series.',
      );
    }
    const head = series[0]!;
    for (let i = 1; i < series.length; i += 1) {
      const other = series[i]!;
      if (other.schema.length !== head.schema.length) {
        throw new TypeError(
          `TimeSeries.concat: schema length mismatch at index ${i} ` +
            `(${head.schema.length} vs ${other.schema.length}).`,
        );
      }
      for (let c = 0; c < head.schema.length; c += 1) {
        const headCol = head.schema[c]!;
        const otherCol = other.schema[c]!;
        if (headCol.name !== otherCol.name || headCol.kind !== otherCol.kind) {
          throw new TypeError(
            `TimeSeries.concat: schema mismatch at column ${c} ` +
              `("${headCol.name}: ${headCol.kind}" vs ` +
              `"${otherCol.name}: ${otherCol.kind}").`,
          );
        }
      }
    }
    const allEvents: EventForSchema<S>[] = [];
    for (const s of series) {
      for (const event of s.events) allEvents.push(event);
    }
    allEvents.sort((a, b) => compareEventKeys(a.key(), b.key()));
    return TimeSeries.#fromTrustedEvents(head.name, head.schema, allEvents);
  }

  /** Example: `new TimeSeries({ name, schema, rows })`. Creates an immutable time series from a schema and row-oriented input data. */
  constructor(input: TimeSeriesInput<S>) {
    this.name = input.name;
    // Trusted-store fast path. Only this module's
    // `#fromTrustedEvents` static can produce inputs carrying the
    // sentinel Symbol; external callers always land in the
    // validating branch below.
    const trustedInput = input as unknown as Partial<TrustedStoreInput<S>>;
    const trustedStore = trustedInput[TRUSTED_STORE_SENTINEL];
    if (trustedStore !== undefined) {
      this.schema = input.schema;
      this.#store = trustedStore;
    } else {
      this.schema = Object.freeze(input.schema.slice()) as S;
      // `SeriesStore.fromValidatedRows` runs the column-native
      // intake (`validateAndNormalizeColumnar`) — same validation
      // rules as the pre-2a row-shape `validateAndNormalize` but
      // writes directly into columnar buffers without allocating
      // Event objects + frozen data dicts. Events lazy-materialize
      // on first `eventAt(i)` access via the store's per-row cache.
      this.#store = SeriesStore.fromValidatedRows(
        this.schema,
        input.rows,
      ) as SeriesStore<S>;
    }
    Object.freeze(this);
  }

  /**
   * Example: `series.toJSON({ rowFormat: "object" })`.
   * Serializes the series into the JSON-friendly shape accepted by `TimeSeries.fromJSON(...)`.
   *
   * Timestamps are emitted as numbers to avoid time zone ambiguity. Missing payload values are
   * emitted as `null`. By default rows are emitted as arrays; use `rowFormat: "object"` for rows
   * keyed by schema column names.
   *
   * Return type is the broader `TimeSeriesJsonInput<SeriesSchema>`
   * union — `result.rows` is typed as
   * `ReadonlyArray<JsonRowForSchema<S> | JsonObjectRowForSchema<S>>`
   * regardless of which `rowFormat` was passed. Consumers either
   * cast or use the narrowed shape types
   * `TimeSeriesJsonOutputArray<S>` / `TimeSeriesJsonOutputObject<S>`
   * declared in `./types.js` for downstream typing.
   *
   * **Why no overload narrowing here?** A narrowed-overload pair
   * (return-type-keyed on `rowFormat`) cascades TS2394 errors
   * through several unrelated overload sets in this file
   * (`pivotByGroup`, `rolling`, `arrayAggregate`, `arrayExplode`).
   * The cascade is specific to `TimeSeries.toJSON`'s shape and has
   * defeated several time-boxed attempts to isolate. The
   * counterpart on {@link LiveSeries.toJSON} DOES narrow — for
   * the networked snapshot path, the ergonomic win is already
   * there. Re-attempt if a TS upgrade or refactor unblocks the
   * cascade.
   */
  toJSON(
    options: { rowFormat?: JsonRowFormat } = {},
  ): TimeSeriesJsonInput<SeriesSchema> {
    const rowFormat = options.rowFormat ?? 'array';
    const dataColumns = this.schema.slice(1);

    if (rowFormat === 'object') {
      const keyColumn = this.schema[0]!;
      const rows = this.events.map((event) => {
        const row: Record<string, unknown> = {
          [keyColumn.name]: serializeJsonKey(
            keyColumn.kind,
            event.key(),
            rowFormat,
          ),
        };
        const data = event.data();

        for (const column of dataColumns) {
          row[column.name] = serializeJsonValue(
            data[column.name as keyof typeof data],
          );
        }

        return Object.freeze(row) as JsonObjectRowForSchema<SeriesSchema>;
      });

      return {
        name: this.name,
        schema: this.schema as SeriesSchema,
        rows,
      };
    }

    const rows = this.events.map((event) => {
      const data = event.data();
      return Object.freeze([
        serializeJsonKey(this.schema[0]!.kind, event.key(), rowFormat),
        ...dataColumns.map((column) =>
          serializeJsonValue(data[column.name as keyof typeof data]),
        ),
      ]) as JsonRowForSchema<SeriesSchema>;
    });

    return {
      name: this.name,
      schema: this.schema as SeriesSchema,
      rows,
    };
  }

  /**
   * Builds a series from event data that has already been validated
   * and ordered by the caller. Routes through the regular constructor
   * via the `TRUSTED_STORE_SENTINEL` sentinel — necessary because ES
   * private fields (the `#store` slot) can only be installed by a
   * running constructor; the previous `Object.create(prototype)` shape
   * is no longer viable.
   *
   * Intentionally private. Callers are transforms that preserve the
   * existing event order and normalized key invariants.
   */
  static #fromTrustedEvents<NextSchema extends SeriesSchema>(
    name: string,
    schema: NextSchema,
    events: ReadonlyArray<EventForSchema<NextSchema>>,
  ): TimeSeries<NextSchema> {
    const frozenSchema = Object.freeze(schema.slice()) as NextSchema;
    const store = SeriesStore.fromTrustedEvents(
      frozenSchema,
      events as unknown as ReadonlyArray<
        Parameters<typeof SeriesStore.fromTrustedEvents>[1][number]
      >,
    ) as SeriesStore<NextSchema>;
    const trustedInput: TrustedStoreInput<NextSchema> = {
      name,
      schema: frozenSchema,
      [TRUSTED_STORE_SENTINEL]: store,
    };
    return new TimeSeries<NextSchema>(
      trustedInput as unknown as TimeSeriesInput<NextSchema>,
    );
  }

  /**
   * Column-native trusted constructor — the counterpart to
   * {@link TimeSeries.#fromTrustedEvents} for transforms that reshape
   * the columnar store directly (`select`, and future pure-reshape
   * ops) instead of rebuilding from events. Wraps a pre-built,
   * already-validated `ColumnarStore` in a fresh `SeriesStore` (no
   * per-row event materialization, no re-validation) and installs it
   * via the trusted-store sentinel. Events lazy-materialize from the
   * new store on demand. The caller guarantees `columnarStore`'s
   * shape matches `schema` — that assertion is the single cast, the
   * trust boundary (Step 4).
   */
  static #fromTrustedStore<NextSchema extends SeriesSchema>(
    name: string,
    schema: NextSchema,
    columnarStore: ColumnarStore<ColumnSchema>,
  ): TimeSeries<NextSchema> {
    const frozenSchema = Object.freeze(schema.slice()) as NextSchema;
    const store = SeriesStore.fromTrustedStore(
      columnarStore as unknown as ColumnarStore<NextSchema>,
    ) as SeriesStore<NextSchema>;
    const trustedInput: TrustedStoreInput<NextSchema> = {
      name,
      schema: frozenSchema,
      [TRUSTED_STORE_SENTINEL]: store,
    };
    return new TimeSeries<NextSchema>(
      trustedInput as unknown as TimeSeriesInput<NextSchema>,
    );
  }

  /**
   * Example: `series.events`. Returns the full event array.
   *
   * Lazy under the hood: the array is built once by walking the
   * columnar store's per-row event cache and is memoized inside the
   * store so `series.events === series.events` holds (preserving
   * the identity invariant prior code relied on). Same per-row
   * identity as `series.at(i)` — `series.at(i) === series.events[i]`
   * for every valid `i`.
   *
   * Replaces the previous `readonly events` field (sub-step 2a). The
   * cast widens `SeriesEvent` (the store's event type) to
   * `EventForSchema<S>` (TimeSeries's narrower per-schema type);
   * structurally identical — both are `Event<EventKey, Schema>`.
   */
  get events(): ReadonlyArray<EventForSchema<S>> {
    return this.#store.toEvents() as unknown as ReadonlyArray<
      EventForSchema<S>
    >;
  }

  /** Example: `series.firstColumnKind`. Returns the first-column kind from the series schema. */
  get firstColumnKind(): FirstColKind {
    return this.schema[0]!.kind;
  }

  /**
   * Example (chart / typed-array consumer):
   * ```ts
   * const col = series.column('cpu');     // Float64Column | ChunkedFloat64Column
   * const xs = series.keyColumn().begin;  // Float64Array
   * const ys = col.toFloat64Array();      // Float64Array (storage-agnostic)
   * for (let i = 0; i < ys.length; i += 1) ctx.lineTo(xs[i], ys[i]);
   * ```
   *
   * Returns the public column class for a named value column. The
   * schema-narrowed `Name` parameter (RFC §7.2) constrains `name`
   * to a value column declared in the schema; typos and key-column
   * names fail to compile rather than returning `undefined` at
   * runtime. The return type narrows on the schema's declared kind
   * for that column — `Float64Column | ChunkedFloat64Column` for
   * `'number'`, `BooleanColumn | ChunkedBooleanColumn` for
   * `'boolean'`, etc. No `| undefined`.
   *
   * The columns expose a high-level method surface (`at(i)`,
   * `slice(s, e)`, `min()` / `max()` / `mean()` / etc.,
   * `toFloat64Array()` for numeric storage-agnostic gather,
   * `bin(W, reducer)` for the chart per-pixel downsampler) plus
   * substrate-level fields for hot-path code (`length`,
   * `validity`, etc.).
   *
   * Use `keyColumn()` for the key axis (returns `TimeKeyColumn` /
   * `TimeRangeKeyColumn` / `IntervalKeyColumn` narrowed by the
   * schema's first-column kind).
   *
   * **Read-only buffer contract.** The methods that hand back a
   * typed array (`toFloat64Array()`, `keyColumn().begin`, etc.)
   * share storage with the column. Writing to those buffers
   * corrupts the trusted-construction substrate. The framework
   * doesn't defensively clone on read.
   *
   * **Phase 4.7 step 8b (2026-05-27): schema-narrowed signature.**
   * `name` is constrained to a schema-valid value column at compile
   * time — typos and key-column names fail to compile rather than
   * returning `undefined` at runtime. The return type narrows by
   * kind: `series.column('value')` (where `value` is `kind: 'number'`)
   * returns `Float64Column | ChunkedFloat64Column`, with all the
   * scalar-reduction methods mounted by `src/column.ts`
   * (`.min()`, `.max()`, `.mean()`, etc.). `series.column('host')`
   * (`kind: 'string'`) returns `StringColumn | ChunkedStringColumn`,
   * without the numeric methods. Both packed and chunked variants
   * carry the full method surface — chunked delegates reductions
   * to `materialize().method()` for v1; see
   * `docs/rfcs/column-api.md` §7.2 for the design and §7.4 for the
   * type-level acceptance tests.
   */
  column<Name extends ValueColumnNameForSchema<S>>(
    name: Name,
  ): PublicColumnForKind<ValueColumnKindForName<S, Name>>;
  column(name: string): ColumnarColumn | undefined {
    return this.#store.store.columns.get(name);
  }

  /**
   * Example: `series.keyColumn().begin`. Returns the underlying
   * `KeyColumn` (a `TimeKeyColumn` / `TimeRangeKeyColumn` /
   * `IntervalKeyColumn` discriminated by the schema's first
   * column kind).
   *
   * **Phase 4.7 spike API — shape not yet stable.** Companion to
   * `column(name)` for chart / typed-array consumers that need
   * direct access to the time axis. Per-variant fields:
   *
   * - **`TimeKeyColumn`** — `begin: Float64Array` (end === begin
   *   semantically; same buffer reference).
   * - **`TimeRangeKeyColumn`** — `begin: Float64Array` +
   *   `end: Float64Array`.
   * - **`IntervalKeyColumn`** — `begin` + `end` + `labels`
   *   (`StringColumn | Float64Column` per `labelKind`).
   *
   * **Treat the returned buffers as read-only.** Same caveat as
   * `column(name)` — the `Float64Array` itself is mutable at
   * runtime; writing to `keyColumn().begin[i]` would corrupt the
   * trusted-construction substrate.
   *
   * **Step 8d narrowing:** the return type is now
   * `KeyColumnForSchema<S>` (RFC §7.5) — a `time`-keyed schema
   * returns `TimeKeyColumn`, `interval` returns `IntervalKeyColumn`,
   * `timeRange` returns `TimeRangeKeyColumn`. Consumers no longer
   * need `instanceof` / discriminator checks just to access kind-
   * specific fields like `.labels`.
   */
  keyColumn(): KeyColumnForSchema<S> {
    return this.#store.store.keys as KeyColumnForSchema<S>;
  }

  /** Example: `series.rows`. Returns the normalized row view of the series. */
  get rows(): ReadonlyArray<NormalizedRowForSchema<S>> {
    return toRows(this.schema, this.events) as ReadonlyArray<
      NormalizedRowForSchema<S>
    >;
  }

  /** Example: `series.toRows()`. Returns normalized row arrays using `Time`/`TimeRange`/`Interval` keys and `undefined` for missing payload values. */
  toRows(): ReadonlyArray<NormalizedRowForSchema<S>> {
    return this.rows;
  }

  /** Example: `series.toObjects()`. Returns normalized schema-keyed object rows using temporal key objects and `undefined` for missing payload values. */
  toObjects(): ReadonlyArray<NormalizedObjectRow> {
    return toObjects(this.schema, this.events);
  }

  /**
   * Example: `series.at(0)`. Returns the event at the supplied
   * zero-based position, if present.
   *
   * Routes through the columnar store's per-row `eventAt` cache
   * directly (O(1) materialization for the requested row) rather
   * than indexing `this.events` (which would force a full lazy
   * materialization of every row in the series on first call).
   * The cache's identity invariant means `series.at(i) ===
   * series.events[i]` holds whenever both are accessed.
   */
  at(index: number): EventForSchema<S> | undefined {
    // Match pre-2a array-indexing semantics: non-integer or NaN
    // inputs return undefined rather than throwing downstream from
    // `#store.eventAt`. `this.events[NaN]` returned undefined per
    // JS array semantics (key coercion + miss); the direct route
    // to `#store.eventAt(NaN)` would proceed past the bounds check
    // and attempt key materialization at the invalid row. Closed
    // Codex round 4's medium finding on PR #150.
    if (!Number.isInteger(index) || index < 0 || index >= this.#store.length) {
      return undefined;
    }
    return this.#store.eventAt(index) as unknown as EventForSchema<S>;
  }

  /** Example: `series.first()`. Returns the first event in the series, if present. */
  first(): EventForSchema<S> | undefined {
    return this.at(0);
  }

  /** Example: `series.last()`. Returns the last event in the series, if present. */
  last(): EventForSchema<S> | undefined {
    const n = this.#store.length;
    return n === 0 ? undefined : this.at(n - 1);
  }

  /** Example: `series.map(nextSchema, event => event)`. Maps each event into a new typed schema and returns a new series. */
  map<NextSchema extends SeriesSchema>(
    schema: NextSchema,
    mapper: (
      event: EventForSchema<S>,
      index: number,
    ) => EventForSchema<NextSchema>,
  ): TimeSeries<NextSchema> {
    const mappedEvents = this.events.map((event, index) =>
      mapper(event, index),
    );

    return new TimeSeries({
      name: this.name,
      schema,
      rows: toRows(schema, mappedEvents),
    });
  }

  /**
   * Example: `series.mapColumns({ celsius: (c) => c * 1.8 + 32 })`.
   * Applies a per-cell value transform to one or more value columns and
   * returns a new series. Each mapper is `(value) => newValue` and must
   * return the **same kind** it received (number→number, string→string,
   * …), so the schema is unchanged.
   *
   * This is the column-scoped counterpart of {@link TimeSeries.map}:
   * `map` rebuilds whole rows through an `Event => Event` closure (and
   * can change the schema or key), whereas `mapColumns` transforms
   * individual columns' values in place — it reads the columns directly
   * (no per-row `Event`), so it stays on the fast columnar path.
   *
   * **Missing cells carry:** the mapper is called only on defined
   * values; a missing (`undefined`) cell stays missing. A stored `NaN`
   * is a defined number, so the mapper *is* called on it.
   *
   * **Multi-entity series:** `mapColumns` is per-cell and stateless, so
   * it is unaffected by entity interleaving (unlike `cumulative` /
   * `diff`); no `partitionBy` scoping is needed.
   */
  mapColumns<const Targets extends ValueColumnNameForSchema<S>>(spec: {
    [K in Targets]: (
      value: NonNullable<EventDataForSchema<S>[K]>,
    ) => NonNullable<EventDataForSchema<S>[K]>;
  }): TimeSeries<S> {
    // Column-native (Step 4): the per-cell transform is applied straight
    // off the store's columns in the extracted `mapOp` — no `this.events`
    // materialization, no per-row `Event`. Same kind in/out ⇒ schema is
    // unchanged. The method is a thin delegate.
    const entries = Object.entries(spec) as Array<[string, ColumnMapper]>;
    if (entries.length === 0) {
      throw new Error('mapColumns() requires at least one column');
    }
    const { store, schema } = mapOp<S>(
      this.#store.store,
      this.schema,
      new Map(entries),
    );
    return TimeSeries.#fromTrustedStore(
      this.name,
      schema,
      store as unknown as ColumnarStore<ColumnSchema>,
    );
  }

  /** Example: `series.asTime({ at: "center" })`. Converts the series key type to `"time"` using the supplied anchor within each event extent. */
  asTime(
    options: { at?: 'begin' | 'center' | 'end' } = {},
  ): TimeSeries<TimeKeyedSchema<S>> {
    // Column-native rekey: reinterpret the key as `time` straight off the
    // existing key's begin/end buffers — no `this.events`. `begin`/`end`
    // reuse the source buffer zero-copy; `center` computes midpoints.
    const schema = Object.freeze([
      { name: 'time', kind: 'time' as const },
      ...this.schema.slice(1),
    ]) as TimeKeyedSchema<S>;
    const keys = this.#store.store.keys;
    const at = options.at ?? 'begin';
    const n = keys.length;
    let beginBuf: Float64Array;
    if (at === 'center') {
      beginBuf = new Float64Array(n);
      for (let i = 0; i < n; i += 1) {
        beginBuf[i] = (keys.begin[i]! + keys.end[i]!) / 2;
      }
    } else {
      beginBuf = at === 'end' ? keys.end : keys.begin;
    }
    // The source is ordered by `begin`, so `begin` stays monotonic — but for a
    // ranged source with overlapping extents, anchoring at `end` / `center`
    // can REORDER rows, producing a non-monotonic time axis. The pre-#200 path
    // routed these anchors through the validating constructor, which threw on
    // an unsorted result; `withKeyColumn` → `#fromTrustedStore` trusts the key
    // and would silently accept it (breaking `bisect` / `timeRange` / key-range
    // ops). Restore the throw with an O(n) scan. (`begin` can't reorder, so it
    // is exempt — and `withKeyColumn` documents the monotonic-key precondition.)
    if (at !== 'begin') {
      for (let i = 1; i < n; i += 1) {
        if (beginBuf[i]! < beginBuf[i - 1]!) {
          throw new Error(
            `asTime({ at: '${at}' }) produced a non-monotonic time axis at ` +
              `row ${i} (${beginBuf[i]} < ${beginBuf[i - 1]}): the source ` +
              `extents overlap, so anchoring at '${at}' reorders rows. Anchor ` +
              `at 'begin', or re-sort after converting.`,
          );
        }
      }
    }
    const store = withKeyColumn(
      this.#store.store,
      schema[0]!,
      new TimeKeyColumn(beginBuf, keys.length),
    );
    return TimeSeries.#fromTrustedStore(
      this.name,
      schema,
      store as unknown as ColumnarStore<ColumnSchema>,
    );
  }

  /** Example: `series.asTimeRange()`. Converts the series key type to `"timeRange"` while preserving each event extent. */
  asTimeRange(): TimeSeries<TimeRangeKeyedSchema<S>> {
    // Column-native rekey: the timeRange covers each row's existing extent —
    // reuse the key's begin/end buffers zero-copy, no events.
    const schema = Object.freeze([
      { name: 'timeRange', kind: 'timeRange' as const },
      ...this.schema.slice(1),
    ]) as TimeRangeKeyedSchema<S>;
    const keys = this.#store.store.keys;
    const store = withKeyColumn(
      this.#store.store,
      schema[0]!,
      new TimeRangeKeyColumn(keys.begin, keys.end, keys.length),
    );
    return TimeSeries.#fromTrustedStore(
      this.name,
      schema,
      store as unknown as ColumnarStore<ColumnSchema>,
    );
  }

  /** Example: `series.asInterval(range => range.begin())`. Converts the series key type to `"interval"` while preserving each event extent and supplying interval labels. */
  asInterval(value: IntervalValue): TimeSeries<IntervalKeyedSchema<S>>;
  asInterval(
    value: (range: TimeRange, index: number) => IntervalValue,
  ): TimeSeries<IntervalKeyedSchema<S>>;
  asInterval(
    value: IntervalValue | ((range: TimeRange, index: number) => IntervalValue),
  ): TimeSeries<IntervalKeyedSchema<S>> {
    // Column-native rekey: build the interval labels straight off the key's
    // begin/end buffers — no events. The label fn receives the interval's
    // TimeRange (its [begin, end] extent) + index, NOT the whole event
    // (breaking — see CHANGELOG [Unreleased]). Label kind is inferred from the
    // first label — the two `IntervalValue` kinds, string → StringColumn /
    // number → Float64Column — and must be consistent across rows (a mix
    // throws, as at event intake). A type-defeated non-string/number label
    // (e.g. a boolean via `as any`) is rejected here rather than coerced the
    // way intake would (`true → 1`); throwing on the nonsense input is safer.
    const schema = Object.freeze([
      { name: 'interval', kind: 'interval' as const },
      ...this.schema.slice(1),
    ]) as IntervalKeyedSchema<S>;
    const keys = this.#store.store.keys;
    const n = keys.length;

    const labels: IntervalValue[] = new Array(n);
    if (typeof value === 'function') {
      for (let i = 0; i < n; i += 1) {
        labels[i] = value(new TimeRange([keys.begin[i]!, keys.end[i]!]), i);
      }
    } else {
      labels.fill(value);
    }

    const labelKind = n > 0 ? typeof labels[0] : 'string';
    for (let i = 1; i < n; i += 1) {
      if (typeof labels[i] !== labelKind) {
        throw new Error(
          `asInterval: interval label at row ${i} is ${typeof labels[i]} but earlier rows were ${labelKind} — interval labels must be one type throughout`,
        );
      }
    }
    const labelCol =
      labelKind === 'number'
        ? float64ColumnFromArray(labels as number[])
        : stringColumnFromArray(labels as string[]);

    const store = withKeyColumn(
      this.#store.store,
      schema[0]!,
      new IntervalKeyColumn(keys.begin, keys.end, labelCol, n),
    );
    return TimeSeries.#fromTrustedStore(
      this.name,
      schema,
      store as unknown as ColumnarStore<ColumnSchema>,
    );
  }

  /**
   * Example: `left.join(right, { type: "left" })`.
   * Performs an exact-key join of two series with the same key kind.
   *
   * Join types:
   * - `"outer"`: keep keys from either side
   * - `"left"`: keep all keys from the left series
   * - `"right"`: keep all keys from the right series
   * - `"inner"`: keep only keys present on both sides
   *
   * Defaults:
   * - `type`: `"outer"`
   * - `onConflict`: `"error"`
   *
   * Value columns from both series are included in the result and are optional because joined rows
   * may have missing values on either side. If both series use the same payload column name,
   * you can either rename one side before joining or use `{ onConflict: "prefix", prefixes: [...] }`.
   */
  join<Other extends SeriesSchema>(
    other: TimeSeries<Other>,
    options?: ErrorJoinOptions,
  ): TimeSeries<JoinSchema<S, Other>>;
  join<
    Other extends SeriesSchema,
    const Prefixes extends readonly [string, string],
  >(
    other: TimeSeries<Other>,
    options: PrefixJoinOptions<Prefixes>,
  ): TimeSeries<PrefixedJoinSchema<S, Other, Prefixes>>;
  join<Other extends SeriesSchema>(
    other: TimeSeries<Other>,
    options: JoinOptions = {},
  ): any {
    const [left, right] = prepareSeriesForJoin(
      [
        this as unknown as TimeSeries<SeriesSchema>,
        other as unknown as TimeSeries<SeriesSchema>,
      ],
      options,
    ) as [TimeSeries<SeriesSchema>, TimeSeries<SeriesSchema>];
    const joinType = options.type ?? 'outer';

    if (left.firstColumnKind !== right.firstColumnKind) {
      throw new TypeError('cannot join series with different key kinds');
    }

    const resultSchema = Object.freeze([
      left.schema[0],
      ...left.schema
        .slice(1)
        .map((column) => ({ ...column, required: false as const })),
      ...right.schema
        .slice(1)
        .map((column) => ({ ...column, required: false as const })),
    ]) as unknown as SeriesSchema;

    const joinedEvents: EventForSchema<SeriesSchema>[] = [];
    let leftIndex = 0;
    let rightIndex = 0;

    while (leftIndex < left.events.length || rightIndex < right.events.length) {
      const leftEvent = left.events[leftIndex];
      const rightEvent = right.events[rightIndex];

      if (leftEvent && !rightEvent) {
        if (joinType === 'left' || joinType === 'outer') {
          joinedEvents.push(
            leftEvent.merge({}) as unknown as EventForSchema<SeriesSchema>,
          );
        }
        leftIndex += 1;
        continue;
      }

      if (rightEvent && !leftEvent) {
        if (joinType === 'right' || joinType === 'outer') {
          joinedEvents.push(
            rightEvent.merge({}) as unknown as EventForSchema<SeriesSchema>,
          );
        }
        rightIndex += 1;
        continue;
      }

      const comparison = leftEvent!.key().compare(rightEvent!.key());
      if (comparison === 0) {
        joinedEvents.push(
          leftEvent!.merge(
            rightEvent!.data(),
          ) as unknown as EventForSchema<SeriesSchema>,
        );
        leftIndex += 1;
        rightIndex += 1;
      } else if (comparison < 0) {
        if (joinType === 'left' || joinType === 'outer') {
          joinedEvents.push(
            leftEvent!.merge({}) as unknown as EventForSchema<SeriesSchema>,
          );
        }
        leftIndex += 1;
      } else {
        if (joinType === 'right' || joinType === 'outer') {
          joinedEvents.push(
            rightEvent!.merge({}) as unknown as EventForSchema<SeriesSchema>,
          );
        }
        rightIndex += 1;
      }
    }

    return TimeSeries.#fromTrustedEvents(left.name, resultSchema, joinedEvents);
  }

  /**
   * Example: `series.align(Sequence.every("1m"))`.
   * Aligns the series onto a `Sequence` grid or `BoundedSequence` and returns an interval-keyed series.
   *
   * `hold` carries forward the latest known value to each sample position. `linear` interpolates
   * numeric columns between neighboring time-keyed events and falls back to hold behavior for
   * non-numeric columns. Aligned columns are optional because edge buckets may have no value.
   *
   * Defaults:
   * - `method`: `"hold"`
   * - `sample`: `"begin"`
   * - `range`: `series.timeRange()`
   *
   * For `Sequence` inputs, the sequence anchor still comes from the grid definition itself. For
   * procedural sequences created with `Sequence.every(...)`, that anchor defaults to Unix epoch
   * `0`. The `range` only decides which finite slice of that grid is bounded for this alignment.
   *
   * When a `BoundedSequence` is supplied, its intervals are used directly.
   *
   * Example:
   * - `Sequence.every("1m")` defines an epoch-anchored minute grid
   * - `series.align(Sequence.every("1m"))` aligns onto the slice of that minute grid spanning the
   *   current series extent
   *
   * **Multi-entity series:** alignment samples cross entity boundaries —
   * `host-A`'s aligned bucket would interpolate or hold against
   * `host-B`'s value. On a series carrying multiple entities (host,
   * region, device id), use
   * `series.partitionBy(col).align(...).collect()` to scope per entity.
   * See {@link TimeSeries.partitionBy}.
   */
  align(
    sequence: SequenceLike,
    options: {
      method?: AlignMethod;
      sample?: AlignSample;
      range?: TemporalLike;
    } = {},
  ): TimeSeries<AlignSchema<S>> {
    const method = options.method ?? 'hold';
    const sample = options.sample ?? 'begin';
    const range = options.range ?? this.timeRange();
    const resultSchema = makeAlignedSchema(this.schema);

    if (!range) {
      return new TimeSeries({
        name: this.name,
        schema: resultSchema as unknown as SeriesSchema,
        rows: [],
      }) as unknown as TimeSeries<AlignSchema<S>>;
    }

    if (method === 'linear' && !isTimeKeyed(this)) {
      throw new TypeError(
        'linear alignment currently requires a time-keyed series',
      );
    }

    const intervals = toBoundedSequence(sequence, range, sample).intervals();
    const valueColumns = this.schema.slice(1) as ValueColumnsForSchema<S>;
    const resultColumns = resultSchema.slice(1);

    const alignedRows =
      method === 'linear'
        ? (() => {
            const cursor: AlignCursor = { index: 0 };
            const rows = new Array(intervals.length);

            for (let i = 0; i < intervals.length; i += 1) {
              const interval = intervals[i]!;
              const t = sampleTime(interval, sample);
              const data = alignLinearAt(this, t, valueColumns, cursor);
              const row = new Array(resultColumns.length + 1);
              row[0] = interval;

              for (let j = 0; j < resultColumns.length; j += 1) {
                const column = resultColumns[j]!;
                row[j + 1] = data[column.name as keyof typeof data];
              }

              rows[i] = Object.freeze(row);
            }

            return rows;
          })()
        : intervals.map((interval) => {
            const t = sampleTime(interval, sample);
            const data = alignHoldAt(this, t);

            return Object.freeze([
              interval,
              ...resultSchema
                .slice(1)
                .map((column) => data[column.name as keyof typeof data]),
            ]);
          });

    return new TimeSeries({
      name: this.name,
      schema: resultSchema as unknown as SeriesSchema,
      rows: alignedRows as unknown as TimeSeriesInput<SeriesSchema>['rows'],
    }) as unknown as TimeSeries<AlignSchema<S>>;
  }

  /**
   * Example: `series.materialize(Sequence.every("1m"))`.
   * Materializes the series onto a sequence grid, emitting one
   * **time-keyed** row per bucket. For each bucket, populate value
   * columns from a chosen source event whose `begin()` falls in
   * `[bucket.begin, bucket.end)`; for empty buckets, emit a row with
   * all value columns `undefined`.
   *
   * The natural pre-step to gap-capped fill — `materialize` only
   * regularizes the grid, leaving fill policy as a separate decision:
   *
   * ```ts
   * series
   *   .partitionBy('host')
   *   .dedupe({ keep: 'last' })
   *   .materialize(Sequence.every('1m'))           // regularize, undefined for empty
   *   .fill({ cpu: 'linear' }, { maxGap: '3m' })   // explicit fill policy
   *   .collect();
   * ```
   *
   * Distinct from `align()` (which mandates a `'hold'` or `'linear'`
   * fill method and returns interval-keyed) and `aggregate()` (which
   * applies a per-column reducer). `materialize` does only the grid
   * step; fill is a separate composition.
   *
   * Options:
   *
   * - **`sample`** (`'begin' | 'center' | 'end'`, default `'begin'`)
   *   — bucket anchor for the output time. Matches `align`'s
   *   convention.
   * - **`select`** (`'first' | 'last' | 'nearest'`, default `'last'`)
   *   — which source event in each bucket wins. `'first'` /
   *   `'last'` pick the boundary event by `begin()` order.
   *   `'nearest'` picks the source event whose `begin()` is closest
   *   to the bucket's sample time **among events in the bucket**.
   *   All three use half-open `[bucket.begin, bucket.end)`
   *   membership; an empty bucket emits `undefined` regardless of
   *   `select`.
   * - **`range`** (`TemporalLike`, default `series.timeRange()`) —
   *   bounded slice for procedural sequences (`Sequence.every(...)`).
   *   When a `BoundedSequence` is supplied directly, its intervals
   *   are used as-is.
   *
   * **Multi-entity series:** every cell of an empty-bucket row is
   * `undefined` — including string/categorical columns like `host`.
   * On a series carrying multiple entities, use
   * `series.partitionBy(col).materialize(seq).collect()` so the
   * partition column auto-populates on every output row (including
   * empty buckets) — `host`'s value is known per partition.
   * See {@link TimeSeries.partitionBy}.
   */
  materialize(
    sequence: SequenceLike,
    options: {
      sample?: AlignSample;
      select?: 'first' | 'last' | 'nearest';
      range?: TemporalLike;
    } = {},
  ): TimeSeries<MaterializeSchema<S>> {
    const sample = options.sample ?? 'begin';
    const select = options.select ?? 'last';
    const range = options.range ?? this.timeRange();
    const resultSchema = makeMaterializedSchema(this.schema);

    if (!range) {
      return new TimeSeries({
        name: this.name,
        schema: resultSchema as unknown as SeriesSchema,
        rows: [],
      }) as unknown as TimeSeries<MaterializeSchema<S>>;
    }

    const intervals = toBoundedSequence(sequence, range, sample).intervals();
    const valueColumnNames = this.schema.slice(1).map((c) => c.name);
    const sourceEvents = this.events;
    const sourceLen = sourceEvents.length;
    const colCount = valueColumnNames.length;

    // Single forward cursor over source events. Each bucket advances
    // it past events whose begin() < bucket.begin(); within the
    // bucket, scan inline to find the chosen event without buffering
    // the bucket's event indexes in a temporary array.
    let cursor = 0;
    const rows: unknown[][] = new Array(intervals.length);

    for (let i = 0; i < intervals.length; i += 1) {
      const interval = intervals[i]!;
      const bStart = interval.begin();
      const bEnd = interval.end();
      const sampleAt = sampleTime(interval, sample);

      // Skip events before this bucket's start.
      while (cursor < sourceLen && sourceEvents[cursor]!.begin() < bStart) {
        cursor += 1;
      }

      // Find the chosen event index in [bStart, bEnd) inline. -1 means
      // empty bucket. Per-mode logic:
      // - 'first': early-exit at the first in-bucket event — O(1)
      // - 'last': walk forward, last index in-bucket wins — O(K_i)
      // - 'nearest': walk forward, track min distance with strict `<`
      //   so the earliest tied event wins — O(K_i)
      let pick = -1;
      if (select === 'first') {
        if (cursor < sourceLen && sourceEvents[cursor]!.begin() < bEnd) {
          pick = cursor;
        }
      } else if (select === 'last') {
        let scan = cursor;
        while (scan < sourceLen && sourceEvents[scan]!.begin() < bEnd) {
          pick = scan;
          scan += 1;
        }
      } else {
        let scan = cursor;
        let bestDist = Infinity;
        while (scan < sourceLen && sourceEvents[scan]!.begin() < bEnd) {
          const d = Math.abs(sourceEvents[scan]!.begin() - sampleAt);
          if (d < bestDist) {
            pick = scan;
            bestDist = d;
          }
          scan += 1;
        }
      }

      const row = new Array(colCount + 1);
      row[0] = new Time(sampleAt);

      if (pick === -1) {
        // Empty bucket — every value column is undefined.
        for (let j = 0; j < colCount; j += 1) {
          row[j + 1] = undefined;
        }
      } else {
        const data = sourceEvents[pick]!.data() as Record<string, unknown>;
        for (let j = 0; j < colCount; j += 1) {
          row[j + 1] = data[valueColumnNames[j]!];
        }
      }

      rows[i] = row;
      // Cursor stays at the first event of (or just past) the current
      // bucket; the next iteration's skip-loop advances it past events
      // < bStart_{i+1}. Half-open membership ensures an event at
      // begin() === bEnd belongs to the next bucket, not this one.
    }

    return new TimeSeries({
      name: this.name,
      schema: resultSchema as unknown as SeriesSchema,
      rows: rows as unknown as TimeSeriesInput<SeriesSchema>['rows'],
    }) as unknown as TimeSeries<MaterializeSchema<S>>;
  }

  /**
   * Example: `series.aggregate(Sequence.every("1m"), { value: "avg" })`.
   * Aggregates events into sequence buckets using built-in reducer names or custom reducers.
   *
   * Buckets use half-open membership semantics: `[begin, end)`. Point events contribute to the
   * bucket containing their timestamp. Interval-like events contribute to every bucket they
   * overlap under half-open overlap rules.
   *
   * Defaults:
   * - `range`: `series.timeRange()`
   *
   * As with `align(...)`, `Sequence` defines the underlying grid and `range` selects which portion
   * of that grid is bounded. With `Sequence.every(...)`, the default grid anchor is Unix epoch `0`,
   * but the default aggregation range is always the source series extent. When a
   * `BoundedSequence` is supplied, its intervals are used directly.
   *
   * Override `range` when you need multiple series aggregated over the same reporting window,
   * including leading or trailing empty buckets outside an individual series extent.
   *
   * Custom reducer contract:
   * - input: `ReadonlyArray<ScalarValue | undefined>`
   * - output: `ScalarValue | undefined`
   *
   * To align buckets to the beginning of the current series instead of epoch boundaries, override
   * the sequence anchor rather than the aggregation range:
   *
   * ```ts
   * const range = series.timeRange();
   * if (!range) {
   *   throw new Error("empty series");
   * }
   *
   * const aggregated = series.aggregate(
   *   Sequence.every("1m", { anchor: range.begin() }),
   *   { value: "avg" },
   * );
   * ```
   *
   * **Multi-entity series:** every entity's events go into the same
   * bucket and are aggregated together — the result is one number per
   * bucket spanning *all* entities, not per-entity. On a series
   * carrying multiple entities (host, region, device id), use
   * `series.partitionBy(col).aggregate(seq, mapping).collect()` to
   * aggregate per entity. See {@link TimeSeries.partitionBy}.
   */
  aggregate<const Mapping extends AggregateMap<S>>(
    sequence: SequenceLike,
    mapping: Mapping,
    options?: { range?: TemporalLike },
  ): TimeSeries<AggregateSchema<S, Mapping>>;
  aggregate<const Mapping extends AggregateOutputMap<S>>(
    sequence: SequenceLike,
    mapping: Mapping,
    options?: { range?: TemporalLike },
  ): TimeSeries<AggregateOutputMapResultSchema<S, Mapping>>;
  aggregate(
    sequence: SequenceLike,
    mapping: AggregateMap<S> | AggregateOutputMap<S>,
    options: { range?: TemporalLike } = {},
  ): any {
    return aggregateInternal(this, sequence, mapping, options);
  }

  /**
   * Example: `series.reduce("value", "avg")`.
   * Collapses the entire series to a single scalar value using the specified reducer.
   *
   * Example: `series.reduce({ cpu: "avg", requests: "sum" })`.
   * Collapses the entire series to a record with one entry per mapped column.
   *
   * Uses the same reducer specs as `aggregate(...)` — built-in names like `"avg"`, `"sum"`,
   * `"count"`, or custom functions `(values) => result`. Where `aggregate` buckets by time and
   * produces a new `TimeSeries`, `reduce` treats the whole series as one bucket and produces
   * a plain value or record.
   */
  reduce(
    column: ValueColumnsForSchema<S>[number]['name'],
    reducer: AggregateReducer,
  ): ColumnValue | undefined;
  reduce<const Mapping extends AggregateMap<S>>(
    mapping: Mapping,
  ): ReduceResult<S, Mapping>;
  reduce<const Mapping extends AggregateOutputMap<S>>(
    mapping: Mapping,
  ): ReduceResult<S, Mapping>;
  reduce(
    columnOrMapping:
      | ValueColumnsForSchema<S>[number]['name']
      | AggregateMap<S>
      | AggregateOutputMap<S>,
    reducer?: AggregateReducer,
  ): ColumnValue | undefined | Record<string, ColumnValue | undefined> {
    if (typeof columnOrMapping === 'string') {
      // Column-fast-path: when the reducer is a built-in numeric
      // reducer (sum/avg/count/min/max/stdev/median/percentile) and
      // the target column is a packed Float64Column, walk the typed
      // array directly via reducer.reduceColumn. Skips the lazy
      // `series.events` materialization + the `defined`/`numeric`
      // row-API filter passes. Phase 4.7 step 3.
      const fastPath = tryReduceColumnFastPath(
        reducer!,
        this.column(columnOrMapping),
      );
      if (fastPath.ok) return fastPath.value;
      const values = this.events.map((event) => {
        const data = event.data();
        return data[columnOrMapping as keyof typeof data];
      }) as ReadonlyArray<ColumnValue | undefined>;
      return applyAggregateReducer(reducer!, values);
    }

    const columns = normalizeAggregateColumns(this.schema, columnOrMapping);
    const result: Record<string, ColumnValue | undefined> = {};
    for (const col of columns) {
      // Same fast path as the single-column branch — applied per
      // entry of the column-spec map.
      const fastPath = tryReduceColumnFastPath(
        col.reducer,
        this.column(col.source),
      );
      if (fastPath.ok) {
        result[col.output] = fastPath.value;
        continue;
      }
      const values = this.events.map((event) => {
        const data = event.data();
        return data[col.source as keyof typeof data];
      }) as ReadonlyArray<ColumnValue | undefined>;
      result[col.output] = applyAggregateReducer(col.reducer, values);
    }
    return result;
  }

  /**
   * Example: `series.groupBy("host")`.
   * Partitions the series into groups keyed by the distinct values of a payload column.
   * Each group is a `TimeSeries` with the same schema, preserving event order.
   *
   * Example: `series.groupBy("host", group => group.rolling("5m", { cpu: "avg" }))`.
   * When a transform callback is supplied, it is applied to each group and the result
   * map contains the transform outputs instead of raw sub-series.
   */
  groupBy(
    column: keyof EventDataForSchema<S> & string,
  ): Map<string, TimeSeries<S>>;
  groupBy<R>(
    column: keyof EventDataForSchema<S> & string,
    transform: (group: TimeSeries<S>, key: string) => R,
  ): Map<string, R>;
  groupBy<R>(
    column: keyof EventDataForSchema<S> & string,
    transform?: (group: TimeSeries<S>, key: string) => R,
  ): Map<string, TimeSeries<S>> | Map<string, R> {
    const buckets = new Map<string, EventForSchema<S>[]>();

    for (const event of this.events) {
      const raw = event.data()[column as keyof EventDataForSchema<S>];
      const key = raw === undefined ? 'undefined' : String(raw);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = [];
        buckets.set(key, bucket);
      }
      bucket.push(event);
    }

    const buildGroup = (events: EventForSchema<S>[]): TimeSeries<S> =>
      new TimeSeries({
        name: this.name,
        schema: this.schema,
        rows: toRows(this.schema, events) as TimeSeriesInput<S>['rows'],
      });

    if (transform) {
      const result = new Map<string, R>();
      for (const [key, events] of buckets) {
        result.set(key, transform(buildGroup(events), key));
      }
      return result;
    }

    const result = new Map<string, TimeSeries<S>>();
    for (const [key, events] of buckets) {
      result.set(key, buildGroup(events));
    }
    return result;
  }

  /**
   * Example: `series.partitionBy('host').fill({ cpu: 'linear' })`.
   * Returns a {@link PartitionedTimeSeries} view that scopes stateful
   * transforms to within each partition. Most stateful operators
   * (`fill`, `align`, `rolling`, `smooth`, `baseline`, `outliers`,
   * `diff`, `rate`, `pctChange`, `cumulative`, `shift`, `aggregate`,
   * `dedupe`, `materialize`) read neighboring events when computing
   * each output and silently cross entity boundaries on multi-entity
   * series — `partitionBy` fixes that by running the op independently
   * per partition and reassembling.
   *
   * Composite partitioning by multiple columns is supported by passing
   * an array: `series.partitionBy(['host', 'region'])`.
   *
   * **Typed groups (single-column only).** Passing
   * `{ groups: HOSTS as const }` declares the expected partition values
   * up front. The returned view's `K` type narrows from `string` to
   * the literal union of declared values, propagating through
   * `toMap()` so its return type becomes
   * `Map<typeof HOSTS[number], TimeSeries<S>>`. Behavior changes:
   * `toMap` iterates in declared order (not insertion order), empty
   * declared groups still produce empty `TimeSeries` entries, and
   * partition values not in the declared set throw at construction
   * time. Mirrors {@link TimeSeries.pivotByGroup}'s typed-groups
   * pattern. Composite partitions, empty `groups`, and duplicate
   * values throw upfront. Numeric and boolean partition columns are
   * stringified by the encoder, so declared groups must be the
   * stringified form (`groups: ['1', '2'] as const` for a numeric
   * column with values `1` and `2`).
   *
   * @example
   * ```ts
   * // Per-host fill — no cross-host interpolation
   * series.partitionBy('host').fill({ cpu: 'linear' });
   *
   * // Composite partitioning
   * series.partitionBy(['host', 'region']).rolling('5m', { cpu: 'avg' });
   *
   * // Typed groups — narrows toMap key type
   * const HOSTS = ['api-1', 'api-2', 'api-3'] as const;
   * const byHost = series
   *   .partitionBy('host', { groups: HOSTS })
   *   .fill({ cpu: 'linear' })
   *   .toMap();
   * // byHost: Map<'api-1' | 'api-2' | 'api-3', TimeSeries<S>>
   *
   * // Arbitrary composition via .apply()
   * series.partitionBy('host').apply(g =>
   *   g.fill({ cpu: 'linear' }).rolling('5m', { cpu: 'avg' }),
   * );
   * ```
   */
  partitionBy<
    Col extends keyof EventDataForSchema<S> & string,
    const Groups extends ReadonlyArray<string>,
  >(
    by: Col | readonly [Col],
    options: { groups: Groups },
  ): PartitionedTimeSeries<S, Groups[number]>;
  partitionBy(
    by:
      | (keyof EventDataForSchema<S> & string)
      | ReadonlyArray<keyof EventDataForSchema<S> & string>,
  ): PartitionedTimeSeries<S>;
  partitionBy(
    by:
      | (keyof EventDataForSchema<S> & string)
      | ReadonlyArray<keyof EventDataForSchema<S> & string>,
    options?: { groups?: ReadonlyArray<string> },
  ): PartitionedTimeSeries<S> {
    return new PartitionedTimeSeries(this, by, options);
  }

  /**
   * Example: `series.pivotByGroup("host", "cpu")`.
   * Reshapes long-form data into wide rows. Each distinct value of
   * `groupCol` becomes its own column in the output schema named
   * `${group}_${valueCol}`, holding the value from `valueCol` at that
   * timestamp.
   *
   * Rows sharing a timestamp collapse into one output row. Cells where
   * a group has no event at a given timestamp are `undefined`. The
   * wide-row counterpart of `groupBy` for the case where you want one
   * wide `TimeSeries` instead of N separate ones — typically because
   * the downstream chart expects wide rows.
   *
   * If two events share both a timestamp AND a group value the call
   * throws by default. Pass `{ aggregate: "avg" }` (or any reducer name
   * that `aggregate()` accepts: `"sum"`, `"first"`, `"last"`, `"min"`,
   * `"max"`, `"median"`, percentiles like `"p95"`, etc.) to combine
   * duplicates instead. The aggregator's output kind must match the
   * value column's kind — e.g. `count`, `unique`, `topN` produce
   * non-source kinds and are rejected upfront. Use `aggregate()` first
   * if you need a kind-changing reduction.
   *
   * Output schema is dynamic — column names depend on runtime data —
   * so the return type is `TimeSeries<SeriesSchema>` (loosely typed).
   * Group values are sorted alphabetically for stable column order.
   * Requires a time-keyed input series.
   *
   * Known limitation: a group column containing both literal
   * `"undefined"` strings and actually-undefined values collapses both
   * into a single `"undefined"` output column. Edge case — open an
   * issue if you hit it.
   *
   * Example: `series.pivotByGroup("host", "cpu", { aggregate: "avg" })`.
   * Averages values when multiple rows share `(timestamp, host)`.
   *
   * Example (typed output via declared `groups`):
   *
   * ```ts
   * const HOSTS = ['api-1', 'api-2'] as const;
   * const wide = series.pivotByGroup('host', 'cpu', { groups: HOSTS });
   * // wide.schema is now literal-typed:
   * //   [time, { name: 'api-1_cpu', kind: 'number', required: false },
   * //          { name: 'api-2_cpu', kind: 'number', required: false }]
   * wide.baseline('api-1_cpu', { window: '1m', sigma: 2 }); // no cast
   * ```
   *
   * When `groups` is supplied:
   * - Output column order matches declaration order, not alphabetical —
   *   declaration is the user's intent.
   * - Declared groups with no events still produce a column (all-undefined
   *   cells), so the schema is stable across runs even when data is sparse.
   * - Runtime values not in `groups` throw upfront. Use the untyped form
   *   (no `groups` option) when the group set is open or unknown.
   */
  pivotByGroup<
    G extends keyof EventDataForSchema<S> & string,
    V extends keyof EventDataForSchema<S> & string,
  >(
    groupCol: G,
    valueCol: V,
    options?: PivotByGroupOptions,
  ): TimeSeries<SeriesSchema>;
  pivotByGroup<
    G extends keyof EventDataForSchema<S> & string,
    V extends keyof EventDataForSchema<S> & string,
    const Groups extends readonly string[],
  >(
    groupCol: G,
    valueCol: V,
    options: PivotByGroupOptionsTyped<Groups>,
  ): TimeSeries<PivotByGroupSchema<S, V, Groups>>;
  pivotByGroup<
    G extends keyof EventDataForSchema<S> & string,
    V extends keyof EventDataForSchema<S> & string,
  >(
    groupCol: G,
    valueCol: V,
    options:
      | PivotByGroupOptions
      | PivotByGroupOptionsTyped<readonly string[]> = {},
  ): TimeSeries<SeriesSchema> {
    if (this.schema[0].kind !== 'time') {
      throw new TypeError(
        `pivotByGroup requires a time-keyed series; got ${this.schema[0].kind}`,
      );
    }
    const valueColumnDef = this.schema.find(
      (c): c is ValueColumn => c.name === valueCol,
    );
    if (!valueColumnDef) {
      throw new TypeError(
        `pivotByGroup: value column "${String(valueCol)}" not in schema`,
      );
    }
    if (!this.schema.some((c) => c.name === groupCol)) {
      throw new TypeError(
        `pivotByGroup: group column "${String(groupCol)}" not in schema`,
      );
    }

    const aggregator = options.aggregate;
    const valueKind = valueColumnDef.kind;

    if (aggregator !== undefined && isBuiltInAggregateReducer(aggregator)) {
      const outputKind = resolveReducer(aggregator).outputKind;
      if (outputKind !== 'source' && outputKind !== valueKind) {
        throw new TypeError(
          `pivotByGroup: aggregator "${aggregator}" produces ` +
            `${outputKind} output, but value column "${String(valueCol)}" ` +
            `has kind "${valueKind}". Aggregate first with the kind change, ` +
            `then pivot.`,
        );
      }
    }

    const declaredGroups = 'groups' in options ? options.groups : undefined;
    const declaredSet =
      declaredGroups === undefined ? undefined : new Set(declaredGroups);

    type Cell = ColumnValue | undefined;
    const groupSeen = new Set<string>();
    const byTs = new Map<number, Map<string, Cell[]>>();

    for (const event of this.events) {
      const ts = event.begin();
      const data = event.data() as Record<string, ColumnValue | undefined>;
      const rawGroup = data[groupCol];
      const groupKey = rawGroup === undefined ? 'undefined' : String(rawGroup);
      const value = data[valueCol];

      if (declaredSet !== undefined && !declaredSet.has(groupKey)) {
        throw new TypeError(
          `pivotByGroup: encountered group value "${groupKey}" that is ` +
            `not in declared groups [${declaredGroups!
              .map((g) => `"${g}"`)
              .join(', ')}]. Drop the \`groups\` option to discover ` +
            `groups dynamically, or add this value to the declared set.`,
        );
      }

      groupSeen.add(groupKey);

      let tsBucket = byTs.get(ts);
      if (!tsBucket) {
        tsBucket = new Map();
        byTs.set(ts, tsBucket);
      }
      let groupBucket = tsBucket.get(groupKey);
      if (!groupBucket) {
        groupBucket = [];
        tsBucket.set(groupKey, groupBucket);
      }
      groupBucket.push(value);
    }

    // When `groups` is declared, output columns follow declaration order so
    // a downstream chart can rely on a stable column layout — and declared
    // groups with no events still emit a column. Otherwise, sort
    // alphabetically over discovered groups.
    const outputGroups: readonly string[] =
      declaredGroups ?? [...groupSeen].sort();
    const outputSchema = [
      this.schema[0],
      ...outputGroups.map((g) => ({
        name: `${g}_${String(valueCol)}`,
        kind: valueKind,
        required: false,
      })),
    ] as unknown as SeriesSchema;

    const sortedTimestamps = [...byTs.keys()].sort((a, b) => a - b);
    const outputRows: unknown[][] = [];
    for (const ts of sortedTimestamps) {
      const tsBucket = byTs.get(ts)!;
      const row: unknown[] = [ts];
      for (const groupKey of outputGroups) {
        const cell = tsBucket.get(groupKey);
        if (cell === undefined) {
          row.push(undefined);
          continue;
        }
        if (cell.length === 1) {
          row.push(cell[0]);
          continue;
        }
        if (aggregator === undefined) {
          throw new Error(
            `pivotByGroup: ${cell.length} events share timestamp ${ts} ` +
              `and group "${groupKey}". Pass ` +
              `{ aggregate: "avg" | "sum" | "first" | "last" | ... } ` +
              `to combine duplicates.`,
          );
        }
        row.push(applyAggregateReducer(aggregator, cell));
      }
      outputRows.push(row);
    }

    return new TimeSeries({
      name: this.name,
      schema: outputSchema,
      rows: outputRows as unknown as TimeSeriesInput<SeriesSchema>['rows'],
    });
  }

  /**
   * Example: `series.diff("requests")`.
   * Computes per-event differences for the specified numeric columns.
   * Non-specified columns pass through unchanged. The first event gets
   * `undefined` in affected columns unless `{ drop: true }` is passed,
   * which removes the first event entirely.
   *
   * Example: `series.diff(["requests", "cpu"])`.
   * Multiple columns can be diffed in a single call.
   *
   * Example: `series.diff("requests", { drop: true })`.
   * Drops the first event instead of keeping it with undefined values.
   *
   * **Multi-entity series:** the "previous event" may belong to a
   * different entity, producing meaningless deltas across entity
   * boundaries. On a series carrying multiple entities (host, region,
   * device id), use
   * `series.partitionBy(col).diff(...).collect()` to scope per entity.
   * See {@link TimeSeries.partitionBy}.
   */
  diff<const Target extends NumericColumnNameForSchema<S>>(
    columns: Target | readonly Target[],
    options?: { drop?: boolean },
  ): TimeSeries<DiffSchema<S, Target>> {
    return TimeSeries.#diffOrRate(this, 'diff', columns, options);
  }

  /**
   * Example: `series.rate("requests")`.
   * Computes the per-second rate of change for the specified numeric columns.
   * Non-specified columns pass through unchanged. The first event gets
   * `undefined` in affected columns unless `{ drop: true }` is passed,
   * which removes the first event entirely.
   *
   * Example: `series.rate(["requests", "cpu"])`.
   * Multiple columns can be rated in a single call.
   *
   * Example: `series.rate("requests", { drop: true })`.
   * Drops the first event instead of keeping it with undefined values.
   *
   * **Multi-entity series:** the "previous event" may belong to a
   * different entity, producing meaningless rates across entity
   * boundaries. On a series carrying multiple entities (host, region,
   * device id), use
   * `series.partitionBy(col).rate(...).collect()` to scope per entity.
   * See {@link TimeSeries.partitionBy}.
   */
  rate<const Target extends NumericColumnNameForSchema<S>>(
    columns: Target | readonly Target[],
    options?: { drop?: boolean },
  ): TimeSeries<DiffSchema<S, Target>> {
    return TimeSeries.#diffOrRate(this, 'rate', columns, options);
  }

  /**
   * Example: `series.pctChange("requests")`.
   * Computes the percentage change `(curr - prev) / prev` for the specified
   * numeric columns. Non-specified columns pass through unchanged. The first
   * event gets `undefined` in affected columns unless `{ drop: true }` is
   * passed.
   *
   * **Multi-entity series:** the "previous event" may belong to a
   * different entity, producing meaningless percentages across entity
   * boundaries. On a series carrying multiple entities (host, region,
   * device id), use
   * `series.partitionBy(col).pctChange(...).collect()` to scope per
   * entity. See {@link TimeSeries.partitionBy}.
   */
  pctChange<const Target extends NumericColumnNameForSchema<S>>(
    columns: Target | readonly Target[],
    options?: { drop?: boolean },
  ): TimeSeries<DiffSchema<S, Target>> {
    return TimeSeries.#diffOrRate(this, 'pctChange', columns, options);
  }

  // Static private — the brand check is on the class itself, which
  // exists regardless of how individual instances were constructed.
  // This keeps the impl runtime-private (not reachable via
  // `series.diffOrRateImpl(...)` like a TS-only `private` field would
  // have been) while still working on instances built via
  // `#fromTrustedEvents`.
  static #diffOrRate<
    SX extends SeriesSchema,
    Target extends NumericColumnNameForSchema<SX>,
  >(
    series: TimeSeries<SX>,
    mode: DiffRateMode,
    columns: Target | readonly Target[],
    options?: { drop?: boolean },
  ): TimeSeries<DiffSchema<SX, Target>> {
    type OutSchema = DiffSchema<SX, Target>;
    // Column-native (Step 4): successive differences are folded straight
    // off the store's columns in the extracted `diffRateOp` — no
    // `series.events` materialization, no per-row `Event`. `drop: true`
    // slices off the predecessor-less first row via `withRowRange`. The
    // method is a thin delegate; the operator body lives in
    // `operators/diff-rate.ts`.
    const cols = typeof columns === 'string' ? [columns] : columns;
    const { store, schema } = diffRateOp<SX, OutSchema>(
      series.#store.store,
      series.schema,
      mode,
      cols as readonly string[],
      options?.drop === true,
    );
    return TimeSeries.#fromTrustedStore(
      series.name,
      schema,
      store as unknown as ColumnarStore<ColumnSchema>,
    );
  }

  /**
   * Example: `series.cumulative({ requests: "sum" })`.
   * Computes running accumulations for the specified numeric columns.
   * Non-accumulated columns pass through unchanged.
   *
   * Built-in accumulators: `"sum"`, `"max"`, `"min"`, `"count"`.
   * Custom accumulators: `(acc: number, value: number) => number`.
   *
   * **Multi-entity series:** the running accumulation interleaves
   * across entities — `host-A`'s next event sums on top of
   * `host-B`'s last value rather than `host-A`'s. On a series carrying
   * multiple entities (host, region, device id), use
   * `series.partitionBy(col).cumulative(...).collect()` to scope per
   * entity. See {@link TimeSeries.partitionBy}.
   */
  cumulative<const Targets extends NumericColumnNameForSchema<S>>(spec: {
    [K in Targets]:
      | 'sum'
      | 'max'
      | 'min'
      | 'count'
      | ((acc: number, value: number) => number);
  }): TimeSeries<DiffSchema<S, Targets>> {
    type OutSchema = DiffSchema<S, Targets>;
    // Column-native (Step 4): the running accumulation is computed straight
    // off the store's columns in the extracted `cumulativeOp` — no
    // `this.events` materialization, no per-row `Event`. The method is a
    // thin delegate; the operator body lives in `operators/cumulative.ts`.
    const { store, schema } = cumulativeOp<S, OutSchema>(
      this.#store.store,
      this.schema,
      spec as unknown as Readonly<Record<string, CumulativeReducer>>,
    );
    return TimeSeries.#fromTrustedStore(
      this.name,
      schema,
      store as unknown as ColumnarStore<ColumnSchema>,
    );
  }

  /**
   * Example: `series.shift("value", 1)`.
   * Lags column values by N events (positive N) or leads them (negative N).
   * Vacated positions get `undefined`.
   *
   * **Multi-entity series:** the value pulled in from N positions away
   * may belong to a different entity, producing meaningless lagged
   * values across entity boundaries. On a series carrying multiple
   * entities (host, region, device id), use
   * `series.partitionBy(col).shift(...).collect()` to scope per entity.
   * See {@link TimeSeries.partitionBy}.
   */
  shift<const Target extends NumericColumnNameForSchema<S>>(
    columns: Target | readonly Target[],
    n: number,
  ): TimeSeries<DiffSchema<S, Target>> {
    type OutSchema = DiffSchema<S, Target>;
    // Column-native (Step 4): each target column is shifted by `n` rows
    // straight off the store in the extracted `shiftOp` — row i takes the
    // value at row i−n (else undefined-pad) — no `this.events`
    // materialization, no per-row `Event`. The method is a thin delegate.
    const cols = typeof columns === 'string' ? [columns] : columns;
    const { store, schema } = shiftOp<S, OutSchema>(
      this.#store.store,
      this.schema,
      cols as readonly string[],
      n,
    );
    return TimeSeries.#fromTrustedStore(
      this.name,
      schema,
      store as unknown as ColumnarStore<ColumnSchema>,
    );
  }

  /**
   * Example: `series.fill("hold")`.
   * Fills `undefined` values using the given strategy for all payload columns.
   *
   * Example: `series.fill({ cpu: "linear", host: "hold" })`.
   * Per-column fill strategies. Unmentioned columns are left as-is.
   * Strategy names: `"hold"` (forward fill), `"bfill"` (backward fill),
   * `"linear"` (time-interpolated), `"zero"` (fill with 0). A non-string
   * value is used as a literal fill value.
   *
   * **Gap semantics — all-or-nothing.** A "gap" is a run of consecutive
   * `undefined` cells in one column. For each gap:
   * - With no options: fill the whole gap (existing default).
   * - With `{ limit: N }`: fill only if the gap length is at most N
   *   cells. Otherwise leave the gap fully unfilled.
   * - With `{ maxGap: '3m' }`: fill only if the gap's *temporal* span
   *   (from the prior known value to the next known value) is at most
   *   the duration. Otherwise leave the gap fully unfilled.
   * - With both: fill only if both caps are met.
   *
   * The all-or-nothing semantic is the v0.9.0 default. Earlier
   * versions partially filled (`limit: 3` on a 5-cell gap filled 3,
   * left 2 unfilled). The new semantic avoids fabricating data
   * across what's actually a long outage — partial fills propagate
   * stale values past their useful lifetime.
   *
   * `"linear"` requires known values on both sides of a gap; leading
   * and trailing gaps are unfilled. `"hold"` fills any internal or
   * trailing gap (leading has no prior value). `"bfill"` fills any
   * internal or leading gap (trailing has no next value). `"zero"`
   * and literal fills work on any gap that fits the size caps.
   *
   * **Kind-sensitive strategies.** `"zero"` and `"linear"` are
   * numeric-only — they're only meaningful for `kind: 'number'`
   * columns. When applied via the bare-string form
   * (`fill('zero')` / `fill('linear')`) on a mixed-kind schema,
   * non-numeric columns silently skip — their gaps stay unfilled
   * because the strategy has no kind-appropriate value to place
   * there. The user's natural intent for `fill('zero')` on a
   * `{ metric: number, host: string }` series is "fill numeric
   * gaps with 0", not "fill every gap with the literal number 0
   * regardless of column kind". To fill non-numeric gaps too,
   * use the object form with a per-column kind-appropriate
   * strategy, e.g. `fill({ value: 'zero', host: 'hold' })` or
   * `fill({ host: 'unknown' })` (literal). `"hold"` / `"bfill"`
   * are kind-agnostic (they copy whatever value is at the
   * neighbor); a `"literal"` whose runtime type doesn't match the
   * column kind (e.g. a string fill on a numeric column — type-
   * allowed, since mapping values are the broad
   * `FillStrategy | ScalarValue`) **throws** a `RangeError` naming
   * the column when it would be placed (gap-dependent). This is a
   * deliberate change from the pre-columnar path, which silently
   * produced an internally-inconsistent series (the event view
   * returned the literal while the numeric column read `NaN`); the
   * column-native single representation makes fail-fast the
   * principled replacement.
   *
   * **Multi-entity series:** fill walks one chronological event
   * sequence — `host-A`'s missing cell would `linear`-interpolate or
   * `hold`-carry against `host-B`'s neighboring value. On a series
   * carrying multiple entities (host, region, device id), use
   * `series.partitionBy(col).fill(...).collect()` to scope per entity.
   * See {@link TimeSeries.partitionBy}.
   */
  fill(
    strategy: FillStrategy | FillMapping<S>,
    options?: { limit?: number; maxGap?: DurationInput },
  ): TimeSeries<S> {
    // Column-native (Step 4): fill walks each column's gaps straight off
    // the store in the extracted `fillOp` — no `this.events`
    // materialization, no per-row `Event`. Only columns that actually
    // change are rebuilt; the rest (and the key) pass through by
    // reference. The method resolves the user-facing strategy input into
    // a per-column spec map, then delegates.
    if (this.#store.store.length === 0) {
      return this;
    }

    const specs: Map<string, ResolvedFillSpec> = new Map();
    if (typeof strategy === 'string') {
      // Bare-string strategy applies to every value column. `'zero'` /
      // `'linear'` are numeric-only and silently skip non-numeric
      // columns inside `fillOp` (the kind-sensitive contract: a
      // mixed-kind `fill('zero')` means "fill numeric gaps with 0", not
      // "put 0 in every column" — Codex round 2 on PR #150). To fill
      // non-numeric gaps too, use the object form with a per-column
      // kind-appropriate strategy.
      for (let i = 1; i < this.schema.length; i += 1) {
        specs.set(this.schema[i]!.name, { mode: strategy });
      }
    } else {
      const strategies: Set<string> = new Set([
        'hold',
        'bfill',
        'linear',
        'zero',
      ]);
      for (const [name, spec] of Object.entries(strategy)) {
        if (typeof spec === 'string' && strategies.has(spec)) {
          specs.set(name, { mode: spec as FillStrategy });
        } else {
          specs.set(name, { mode: 'literal', value: spec as ScalarValue });
        }
      }
    }

    const maxGapMs =
      options?.maxGap === undefined ? undefined : parseDuration(options.maxGap);

    const { store, schema } = fillOp<S>(
      this.#store.store,
      this.schema,
      specs,
      options?.limit,
      maxGapMs,
    );
    return TimeSeries.#fromTrustedStore(
      this.name,
      schema,
      store as unknown as ColumnarStore<ColumnSchema>,
    );
  }

  /**
   * Example: `series.dedupe()`.
   * Collapses events that share a key. The default key is the full
   * event key — `begin()` for time-keyed series, `begin()`+`end()` for
   * time-range, and `begin()`+`end()`+`value` for interval-keyed
   * series. Two events with the same full key are treated as
   * duplicates. The default resolution is `'last'` wins.
   *
   * **Multi-entity series:** events from different entities at the
   * same key collapse as if they were duplicates of each other —
   * `host-A`@t and `host-B`@t collide on the timestamp alone. On a
   * series carrying multiple entities (host, region, device id), use
   * `series.partitionBy(col).dedupe(...).collect()` so the partition
   * column is part of the duplicate identity. See
   * {@link TimeSeries.partitionBy}.
   *
   * ```ts
   * // Per-host dedupe — same time AND same host is the duplicate key.
   * series.partitionBy('host').dedupe({ keep: 'last' }).collect();
   * ```
   *
   * The `keep` option chooses the resolution policy:
   *
   * - `'first'` — keep the first occurrence at each key.
   * - `'last'` — keep the last occurrence (default; matches WebSocket
   *   replay semantics).
   * - `'error'` — throw on the first duplicate seen. Useful for
   *   ingestion paths that want to fail loudly on shape violations.
   * - `'drop'` — discard *every* event at any duplicate key.
   *   Conservative; the value of "1.5 events at this timestamp" is
   *   rarely defensible.
   * - `{ min: col }` / `{ max: col }` — keep the event with the
   *   smallest / largest value at the named numeric column. Ties keep
   *   the earliest tied event. Events with `undefined` at that column
   *   lose to any event with a defined value.
   * - `(events) => Event` — custom resolver. Receives all duplicates
   *   at a single key (length ≥ 2) and returns one. The cleanest
   *   pattern is to start from one of the input events and use
   *   `event.set(field, value)` so the type stays narrow:
   *
   *   ```ts
   *   series.dedupe({
   *     keep: (events) => {
   *       const last = events[events.length - 1];
   *       const avg =
   *         events.reduce((a, e) => a + (e.get('cpu') ?? 0), 0) /
   *         events.length;
   *       return last.set('cpu', avg);
   *     },
   *   });
   *   ```
   *
   * Real-world ingest produces duplicates: WebSocket replays, Kafka
   * at-least-once, retried HTTP fetches, polling overlaps. `dedupe()`
   * is the post-ingest cleanup primitive.
   */
  dedupe(options: { keep?: DedupeKeep<S> } = {}): TimeSeries<S> {
    const keep = options.keep ?? 'last';
    if (this.events.length === 0) {
      return this;
    }

    // Bucket key encoder. For time-keyed series, `begin()` alone fully
    // identifies an event key; for time-range, both `begin()` and
    // `end()` matter; for interval-keyed, the labeled `value` is part
    // of identity too. A naive `begin()`-only key would silently
    // collapse semantically distinct interval/timeRange events.
    const firstKind = this.schema[0]!.kind;
    const keyOf = (event: EventForSchema<S>): string => {
      if (firstKind === 'time') {
        return `${event.begin()}`;
      }
      if (firstKind === 'timeRange') {
        return `${event.begin()}:${event.end()}`;
      }
      // interval
      const k = event.key() as unknown as Interval;
      return `${event.begin()}:${event.end()}:${String(k.value)}`;
    };

    // Single-pass bucket by full event key. Map iteration is insertion-
    // order; since the input events are already sorted by key, each
    // bucket corresponds to a unique key and the buckets traverse in
    // input order. No re-sort needed.
    const buckets = new Map<string, EventForSchema<S>[]>();
    for (const event of this.events) {
      const k = keyOf(event);
      let bucket = buckets.get(k);
      if (!bucket) {
        bucket = [];
        buckets.set(k, bucket);
      }
      bucket.push(event);
    }

    const resolved: EventForSchema<S>[] = [];
    for (const [keyStr, bucket] of buckets) {
      if (bucket.length === 1) {
        resolved.push(bucket[0]!);
        continue;
      }

      // Multiple events sharing the same key — apply the policy.
      if (typeof keep === 'function') {
        resolved.push(keep(bucket));
        continue;
      }
      if (keep === 'first') {
        resolved.push(bucket[0]!);
        continue;
      }
      if (keep === 'last') {
        resolved.push(bucket[bucket.length - 1]!);
        continue;
      }
      if (keep === 'error') {
        // Use the first event's begin() for the human-readable timestamp.
        // For interval/timeRange-keyed series, also include the full
        // encoded key so the failure mode names the exact collision.
        const t = bucket[0]!.begin();
        const detail =
          firstKind === 'time'
            ? `${new Date(t).toISOString()} (${t})`
            : `key "${keyStr}"`;
        throw new Error(
          `dedupe: ${bucket.length} events at ${detail}. ` +
            `Specify a different 'keep' policy or fix upstream.`,
        );
      }
      if (keep === 'drop') {
        continue;
      }
      if ('min' in keep || 'max' in keep) {
        const isMin = 'min' in keep;
        const col = (isMin ? keep.min : keep.max) as string;
        let best = bucket[0]!;
        let bestVal = best.get(col) as number | undefined;
        for (let i = 1; i < bucket.length; i += 1) {
          const candidate = bucket[i]!;
          const v = candidate.get(col) as number | undefined;
          if (v === undefined) continue;
          if (bestVal === undefined || (isMin ? v < bestVal : v > bestVal)) {
            best = candidate;
            bestVal = v;
          }
        }
        resolved.push(best);
        continue;
      }
      // Defensive fallthrough: unrecognized keep shape.
      throw new TypeError(
        `dedupe: invalid keep option ${JSON.stringify(keep)}. ` +
          `Expected 'first' | 'last' | 'error' | 'drop' | { min: col } | { max: col } | (events) => Event.`,
      );
    }

    return TimeSeries.#fromTrustedEvents<S>(this.name, this.schema, resolved);
  }

  /**
   * Example: `series.rolling("1h", { value: "avg" })`.
   * Computes event-driven rolling aggregations over the ordered series.
   *
   * Example: `series.rolling(Sequence.every("1m"), "5m", { value: "avg" })`.
   * Computes sequence-driven rolling aggregations and returns an interval-keyed series on the
   * supplied grid.
   *
   * Rolling windows are anchored either at each event's `begin()` time or at the sample point of
   * each sequence bucket. Membership is determined from source event `begin()` times.
   *
   * Supported alignments:
   * - `"trailing"`: `(t - window, t]`
   * - `"leading"`: `[t, t + window)`
   * - `"centered"`: `[t - window/2, t + window/2)`
   *
   * Defaults:
   * - `alignment`: `"trailing"`
   * - `minSamples`: `0` (no gate)
   * - sequence-driven only: `sample: "begin"`
   * - sequence-driven only: `range: series.timeRange()`
   *
   * `minSamples` suppresses output until the window contains at least
   * that many source events: rows where the count is below the threshold
   * emit `undefined` for every reducer column. Use it to hide warmup
   * artifacts on rolling stats whose stability depends on having enough
   * samples (e.g. the rolling stdev that feeds {@link TimeSeries.baseline}'s
   * ±σ bands). The default of `0` is a no-op — every window emits, and
   * empty windows still invoke each reducer with the empty input list
   * so custom reducers can return their preferred sentinel.
   *
   * **Multi-entity series:** the rolling window includes events from
   * every entity within the window — `host-A`'s rolling average mixes
   * `host-B`'s and `host-C`'s values into the same number. On a
   * series carrying multiple entities (host, region, device id), use
   * `series.partitionBy(col).rolling(...).collect()` to scope per
   * entity. See {@link TimeSeries.partitionBy}.
   */
  rolling<const Mapping extends AggregateMap<S>>(
    window: DurationInput,
    mapping: Mapping,
    options?: { alignment?: RollingAlignment; minSamples?: number },
  ): TimeSeries<RollingSchema<S, Mapping>>;
  rolling<const Mapping extends AggregateOutputMap<S>>(
    window: DurationInput,
    mapping: Mapping,
    options?: { alignment?: RollingAlignment; minSamples?: number },
  ): TimeSeries<RollingOutputMapSchema<S, Mapping>>;
  rolling<const Mapping extends AggregateMap<S>>(
    sequence: SequenceLike,
    window: DurationInput,
    mapping: Mapping,
    options?: {
      alignment?: RollingAlignment;
      sample?: AlignSample;
      range?: TemporalLike;
      minSamples?: number;
    },
  ): TimeSeries<AggregateSchema<S, Mapping>>;
  rolling<const Mapping extends AggregateOutputMap<S>>(
    sequence: SequenceLike,
    window: DurationInput,
    mapping: Mapping,
    options?: {
      alignment?: RollingAlignment;
      sample?: AlignSample;
      range?: TemporalLike;
      minSamples?: number;
    },
  ): TimeSeries<AggregateOutputMapResultSchema<S, Mapping>>;
  rolling(
    sequenceOrWindow: SequenceLike | DurationInput,
    windowOrMapping: DurationInput | AggregateMap<S> | AggregateOutputMap<S>,
    mappingOrOptions?:
      | AggregateMap<S>
      | AggregateOutputMap<S>
      | {
          alignment?: RollingAlignment;
          sample?: AlignSample;
          range?: TemporalLike;
          minSamples?: number;
        },
    maybeOptions: {
      alignment?: RollingAlignment;
      sample?: AlignSample;
      range?: TemporalLike;
      minSamples?: number;
    } = {},
  ): TimeSeries<SeriesSchema> {
    let mapping: AggregateMap<S> | AggregateOutputMap<S>;
    let options: {
      alignment?: RollingAlignment;
      sample?: AlignSample;
      range?: TemporalLike;
      minSamples?: number;
    };
    let sequence: SequenceLike | undefined;
    let window: DurationInput;

    if (
      sequenceOrWindow instanceof Sequence ||
      sequenceOrWindow instanceof BoundedSequence
    ) {
      sequence = sequenceOrWindow;
      window = windowOrMapping as DurationInput;
      mapping = mappingOrOptions as AggregateMap<S> | AggregateOutputMap<S>;
      options = maybeOptions;
    } else {
      window = sequenceOrWindow;
      mapping = windowOrMapping as AggregateMap<S> | AggregateOutputMap<S>;
      options =
        (mappingOrOptions as { alignment?: RollingAlignment } | undefined) ??
        {};
    }

    // Normalize both mapping shapes (`AggregateMap` and `AggregateOutputMap`)
    // into a uniform spec list of `{ output, source, reducer, kind }`. Source
    // and output names can differ, which is how `AggregateOutputMap` expresses
    // "multiple reducers keyed off the same source column."
    //
    // For `AggregateMap` inputs (where output === source === schema column),
    // reorder by schema-column order so the runtime row layout lines up with
    // the `RollingSchema<S, Mapping>` type's column inference. For
    // `AggregateOutputMap` inputs the schema is erased to `SeriesSchema`, so
    // insertion order is the natural ordering — consistent with `aggregate`.
    const isOutputMap = Object.values(mapping as Record<string, unknown>).some(
      (v) => isAggregateOutputSpec<S>(v),
    );
    let columnSpecs = normalizeAggregateColumns(this.schema, mapping);
    if (!isOutputMap) {
      const schemaOrder = new Map(
        this.schema.slice(1).map((col, index) => [col.name, index] as const),
      );
      columnSpecs = [...columnSpecs].sort(
        (a, b) =>
          (schemaOrder.get(a.output) ?? 0) - (schemaOrder.get(b.output) ?? 0),
      );
    }

    const resultColumnDefs = columnSpecs.map((spec) => ({
      name: spec.output,
      kind: spec.kind,
      required: false as const,
    }));

    const windowMs = parseDuration(window);
    const alignment = options.alignment ?? 'trailing';
    // Default 0 disables the gate — preserves prior behavior where
    // empty windows still invoke the reducer (custom reducers may
    // return a sentinel for empty input).
    const minSamples = options.minSamples ?? 0;
    if (!Number.isInteger(minSamples) || minSamples < 0) {
      throw new TypeError(
        'rolling minSamples must be a non-negative integer (default 0)',
      );
    }
    const undefinedRow = columnSpecs.map(() => undefined);
    const anchorInWindow = (candidate: number, anchor: number): boolean => {
      if (alignment === 'trailing') {
        return candidate > anchor - windowMs && candidate <= anchor;
      }
      if (alignment === 'leading') {
        return candidate >= anchor && candidate < anchor + windowMs;
      }
      const halfWindow = windowMs / 2;
      return (
        candidate >= anchor - halfWindow && candidate < anchor + halfWindow
      );
    };

    if (sequence) {
      const sample = options.sample ?? 'begin';
      const range = options.range ?? this.timeRange();
      const resultSchema = Object.freeze([
        { name: 'interval', kind: 'interval' as const },
        ...resultColumnDefs,
      ]) as unknown as SeriesSchema;

      if (!range) {
        return new TimeSeries({
          name: this.name,
          schema: resultSchema,
          rows: [],
        });
      }

      const buckets = toBoundedSequence(sequence, range, sample).intervals();
      const resultRows = buckets.map((bucket) => {
        const anchor = sampleTime(bucket, sample);
        const contributors = this.events.filter((candidate) =>
          anchorInWindow(candidate.begin(), anchor),
        );
        const aggregated =
          contributors.length < minSamples
            ? undefinedRow
            : columnSpecs.map((spec) => {
                const values = contributors.map((candidate) => {
                  const data = candidate.data();
                  return data[spec.source as keyof typeof data];
                }) as ReadonlyArray<ColumnValue | undefined>;
                return applyAggregateReducer(spec.reducer, values);
              });

        return Object.freeze([bucket, ...aggregated]);
      });

      return new TimeSeries({
        name: this.name,
        schema: resultSchema,
        rows: resultRows as unknown as TimeSeriesInput<SeriesSchema>['rows'],
      });
    }

    const resultSchema = Object.freeze([
      this.schema[0],
      ...resultColumnDefs,
    ]) as unknown as SeriesSchema;
    const reducerStates = columnSpecs.map((spec) =>
      isBuiltInAggregateReducer(spec.reducer)
        ? createRollingReducerState(spec.reducer)
        : null,
    );
    const beginTimes = this.events.map((event) => event.begin());
    const resultRows: TimeSeriesInput<SeriesSchema>['rows'][number][] =
      new Array(this.events.length);
    let windowStart = 0;
    let windowEnd = 0;
    const addEvent = (index: number): void => {
      const event = this.events[index]!;
      const data = event.data();
      for (let i = 0; i < reducerStates.length; i++) {
        const state = reducerStates[i];
        if (state) {
          const spec = columnSpecs[i]!;
          state.add(
            index,
            data[spec.source as keyof typeof data] as ColumnValue | undefined,
          );
        }
      }
    };
    const removeEvent = (index: number): void => {
      const event = this.events[index]!;
      const data = event.data();
      for (let i = 0; i < reducerStates.length; i++) {
        const state = reducerStates[i];
        if (state) {
          const spec = columnSpecs[i]!;
          state.remove(
            index,
            data[spec.source as keyof typeof data] as ColumnValue | undefined,
          );
        }
      }
    };
    const snapshotWindow = (): (ColumnValue | undefined)[] => {
      if (windowEnd - windowStart < minSamples) return undefinedRow;
      return columnSpecs.map((spec, i) => {
        const state = reducerStates[i];
        if (state) return state.snapshot();
        const values = this.events
          .slice(windowStart, windowEnd)
          .map((event) => {
            const data = event.data();
            return data[spec.source as keyof typeof data];
          }) as ReadonlyArray<ColumnValue | undefined>;
        return applyAggregateReducer(spec.reducer, values);
      });
    };

    if (alignment === 'trailing') {
      for (let groupStart = 0; groupStart < this.events.length; ) {
        const anchor = beginTimes[groupStart]!;
        let groupEnd = groupStart + 1;
        while (
          groupEnd < this.events.length &&
          beginTimes[groupEnd] === anchor
        ) {
          groupEnd += 1;
        }

        while (
          windowEnd < this.events.length &&
          beginTimes[windowEnd]! <= anchor
        ) {
          addEvent(windowEnd);
          windowEnd += 1;
        }

        const lowerBound = anchor - windowMs;
        while (
          windowStart < windowEnd &&
          beginTimes[windowStart]! <= lowerBound
        ) {
          removeEvent(windowStart);
          windowStart += 1;
        }

        const aggregated = snapshotWindow();
        for (let index = groupStart; index < groupEnd; index++) {
          resultRows[index] = Object.freeze([
            this.events[index]!.key(),
            ...aggregated,
          ]) as unknown as TimeSeriesInput<SeriesSchema>['rows'][number];
        }

        groupStart = groupEnd;
      }
    } else if (alignment === 'leading') {
      for (let groupStart = 0; groupStart < this.events.length; ) {
        const anchor = beginTimes[groupStart]!;
        let groupEnd = groupStart + 1;
        while (
          groupEnd < this.events.length &&
          beginTimes[groupEnd] === anchor
        ) {
          groupEnd += 1;
        }

        const lowerBound = anchor;
        while (
          windowStart < windowEnd &&
          beginTimes[windowStart]! < lowerBound
        ) {
          removeEvent(windowStart);
          windowStart += 1;
        }

        const upperBound = anchor + windowMs;
        while (
          windowEnd < this.events.length &&
          beginTimes[windowEnd]! < upperBound
        ) {
          addEvent(windowEnd);
          windowEnd += 1;
        }

        const aggregated = snapshotWindow();
        for (let index = groupStart; index < groupEnd; index++) {
          resultRows[index] = Object.freeze([
            this.events[index]!.key(),
            ...aggregated,
          ]) as unknown as TimeSeriesInput<SeriesSchema>['rows'][number];
        }

        groupStart = groupEnd;
      }
    } else {
      const halfWindow = windowMs / 2;
      for (let groupStart = 0; groupStart < this.events.length; ) {
        const anchor = beginTimes[groupStart]!;
        let groupEnd = groupStart + 1;
        while (
          groupEnd < this.events.length &&
          beginTimes[groupEnd] === anchor
        ) {
          groupEnd += 1;
        }

        const lowerBound = anchor - halfWindow;
        while (
          windowStart < windowEnd &&
          beginTimes[windowStart]! < lowerBound
        ) {
          removeEvent(windowStart);
          windowStart += 1;
        }

        const upperBound = anchor + halfWindow;
        while (
          windowEnd < this.events.length &&
          beginTimes[windowEnd]! < upperBound
        ) {
          addEvent(windowEnd);
          windowEnd += 1;
        }

        const aggregated = snapshotWindow();
        for (let index = groupStart; index < groupEnd; index++) {
          resultRows[index] = Object.freeze([
            this.events[index]!.key(),
            ...aggregated,
          ]) as unknown as TimeSeriesInput<SeriesSchema>['rows'][number];
        }

        groupStart = groupEnd;
      }
    }

    return new TimeSeries({
      name: this.name,
      schema: resultSchema,
      rows: resultRows as unknown as TimeSeriesInput<SeriesSchema>['rows'],
    });
  }

  /**
   * Example: `series.smooth("value", "ema", { alpha: 0.2 })`.
   * Applies a smoothing transform to one numeric payload column while preserving the original key
   * type, key values, and all non-target payload fields.
   *
   * Example: `series.smooth("value", "movingAverage", { window: "5m", alignment: "centered", output: "valueAvg" })`.
   * Computes a moving average over the selected numeric column using anchor points derived from
   * event keys. `Time` keys use their timestamp. `TimeRange` and `Interval` keys use the midpoint
   * of their extent.
   *
   * Example: `series.smooth("value", "loess", { span: 0.75 })`.
   * Computes a LOESS-smoothed value for the selected numeric column using local weighted linear
   * regression over those same anchor points.
   *
   * When `output` is omitted, the smoothed values replace the target column. When `output` is
   * supplied, the smoothed values are appended as a new optional numeric column.
   *
   * **Multi-entity series:** the smoothing window pulls values from
   * every entity into each smoothed point — `host-A`'s smoothed value
   * is blended with `host-B`'s and `host-C`'s. On a series carrying
   * multiple entities (host, region, device id), use
   * `series.partitionBy(col).smooth(...).collect()` to scope per
   * entity. See {@link TimeSeries.partitionBy}.
   */
  smooth<
    const Target extends NumericColumnNameForSchema<S>,
    const Output extends string | undefined = undefined,
  >(
    column: Target,
    method: SmoothMethod,
    options:
      | { alpha: number; warmup?: number; output?: Output }
      | { window: DurationInput; alignment?: RollingAlignment; output?: Output }
      | { span: number; output?: Output },
  ): TimeSeries<
    Output extends string
      ? SmoothAppendSchema<S, Output>
      : SmoothSchema<S, Target>
  > {
    const output = options.output;
    const resultSchema =
      output === undefined
        ? makeSmoothSchema(this.schema, column)
        : makeSmoothSchema(this.schema, column, output);

    const anchors = this.events.map((event) => eventAnchorTime(event.key()));
    const sourceValues: ReadonlyArray<number | undefined> = this.events.map(
      (event) => {
        const raw = event.get(column);
        return typeof raw === 'number' ? raw : undefined;
      },
    );

    if (method === 'ema') {
      if (!('alpha' in options)) {
        throw new TypeError('ema smoothing requires an alpha option');
      }
      const alpha = options.alpha;
      if (
        typeof alpha !== 'number' ||
        !Number.isFinite(alpha) ||
        alpha <= 0 ||
        alpha > 1
      ) {
        throw new TypeError(
          'ema smoothing requires alpha to be a finite number in the range (0, 1]',
        );
      }

      // Optional warm-up: drop the first N output rows to hide the
      // noisy initial convergence of the EMA. The smoother still
      // processes those events so `previous` is correctly warmed up
      // by the time we keep a row.
      const warmup =
        'warmup' in options && options.warmup !== undefined
          ? options.warmup
          : 0;
      if (!Number.isInteger(warmup) || warmup < 0 || !Number.isFinite(warmup)) {
        throw new TypeError(
          'ema smoothing requires warmup to be a non-negative integer',
        );
      }

      let previous: number | undefined;
      const resultRows = this.events.map((event) => {
        const raw = event.get(column);
        const smoothed =
          typeof raw !== 'number'
            ? undefined
            : previous === undefined
              ? raw
              : alpha * raw + (1 - alpha) * previous;

        if (smoothed !== undefined) {
          previous = smoothed;
        }

        const nextEvent =
          output === undefined
            ? event.set(column, smoothed as EventDataForSchema<S>[Target])
            : event.merge({ [output]: smoothed });
        return Object.freeze([
          nextEvent.key(),
          ...resultSchema
            .slice(1)
            .map(
              (nextColumn) =>
                nextEvent.data()[
                  nextColumn.name as keyof ReturnType<typeof nextEvent.data>
                ],
            ),
        ]);
      });

      const keptRows = warmup > 0 ? resultRows.slice(warmup) : resultRows;

      return new TimeSeries({
        name: this.name,
        schema: resultSchema as unknown as SeriesSchema,
        rows: keptRows as unknown as TimeSeriesInput<SeriesSchema>['rows'],
      }) as unknown as TimeSeries<
        Output extends string
          ? SmoothAppendSchema<S, Output>
          : SmoothSchema<S, Target>
      >;
    }

    if (method === 'loess') {
      if (!('span' in options)) {
        throw new TypeError('loess smoothing requires a span option');
      }
      const span = options.span;
      if (
        typeof span !== 'number' ||
        !Number.isFinite(span) ||
        span <= 0 ||
        span > 1
      ) {
        throw new TypeError(
          'loess smoothing requires span to be a finite number in the range (0, 1]',
        );
      }

      const loessAnchors: number[] = [];
      const loessValues: number[] = [];
      for (let index = 0; index < anchors.length; index++) {
        const value = sourceValues[index];
        if (typeof value === 'number') {
          loessAnchors.push(anchors[index]!);
          loessValues.push(value);
        }
      }

      const resultRows = this.events.map((event, index) => {
        const smoothed = loessAt(
          anchors[index]!,
          loessAnchors,
          loessValues,
          span,
        );
        const nextEvent =
          output === undefined
            ? event.set(column, smoothed as EventDataForSchema<S>[Target])
            : event.merge({ [output]: smoothed });
        return Object.freeze([
          nextEvent.key(),
          ...resultSchema
            .slice(1)
            .map(
              (nextColumn) =>
                nextEvent.data()[
                  nextColumn.name as keyof ReturnType<typeof nextEvent.data>
                ],
            ),
        ]);
      });

      return new TimeSeries({
        name: this.name,
        schema: resultSchema as unknown as SeriesSchema,
        rows: resultRows as unknown as TimeSeriesInput<SeriesSchema>['rows'],
      }) as unknown as TimeSeries<
        Output extends string
          ? SmoothAppendSchema<S, Output>
          : SmoothSchema<S, Target>
      >;
    }

    if (!('window' in options)) {
      throw new TypeError('movingAverage smoothing requires a window option');
    }
    const window = options.window;
    const windowMs = parseDuration(window!);
    const alignment = options.alignment ?? 'trailing';
    const resultValues = new Array<number | undefined>(this.events.length);
    let windowStart = 0;
    let windowEnd = 0;
    let numericSum = 0;
    let numericCount = 0;
    const addEvent = (index: number): void => {
      const value = sourceValues[index];
      if (typeof value === 'number') {
        numericSum += value;
        numericCount += 1;
      }
    };
    const removeEvent = (index: number): void => {
      const value = sourceValues[index];
      if (typeof value === 'number') {
        numericSum -= value;
        numericCount -= 1;
      }
    };
    const snapshot = (): number | undefined =>
      numericCount === 0 ? undefined : numericSum / numericCount;

    for (let groupStart = 0; groupStart < this.events.length; ) {
      const anchor = anchors[groupStart]!;
      let groupEnd = groupStart + 1;
      while (groupEnd < this.events.length && anchors[groupEnd] === anchor) {
        groupEnd += 1;
      }

      if (alignment === 'trailing') {
        while (
          windowEnd < this.events.length &&
          anchors[windowEnd]! <= anchor
        ) {
          addEvent(windowEnd);
          windowEnd += 1;
        }

        const lowerBound = anchor - windowMs;
        while (windowStart < windowEnd && anchors[windowStart]! <= lowerBound) {
          removeEvent(windowStart);
          windowStart += 1;
        }
      } else if (alignment === 'leading') {
        while (windowStart < windowEnd && anchors[windowStart]! < anchor) {
          removeEvent(windowStart);
          windowStart += 1;
        }

        const upperBound = anchor + windowMs;
        while (
          windowEnd < this.events.length &&
          anchors[windowEnd]! < upperBound
        ) {
          addEvent(windowEnd);
          windowEnd += 1;
        }
      } else {
        const halfWindow = windowMs / 2;
        while (
          windowStart < windowEnd &&
          anchors[windowStart]! < anchor - halfWindow
        ) {
          removeEvent(windowStart);
          windowStart += 1;
        }

        const upperBound = anchor + halfWindow;
        while (
          windowEnd < this.events.length &&
          anchors[windowEnd]! < upperBound
        ) {
          addEvent(windowEnd);
          windowEnd += 1;
        }
      }

      const smoothed = snapshot();
      for (let index = groupStart; index < groupEnd; index++) {
        resultValues[index] = smoothed;
      }

      groupStart = groupEnd;
    }

    const resultRows = this.events.map((event, index) => {
      const smoothed = resultValues[index];
      const nextEvent =
        output === undefined
          ? event.set(column, smoothed as EventDataForSchema<S>[Target])
          : event.merge({ [output]: smoothed });
      return Object.freeze([
        nextEvent.key(),
        ...resultSchema
          .slice(1)
          .map(
            (nextColumn) =>
              nextEvent.data()[
                nextColumn.name as keyof ReturnType<typeof nextEvent.data>
              ],
          ),
      ]);
    });

    return new TimeSeries({
      name: this.name,
      schema: resultSchema as unknown as SeriesSchema,
      rows: resultRows as unknown as TimeSeriesInput<SeriesSchema>['rows'],
    }) as unknown as TimeSeries<
      Output extends string
        ? SmoothAppendSchema<S, Output>
        : SmoothSchema<S, Target>
    >;
  }

  /** Example: `series.slice(0, 10)`. Returns a positional half-open slice of the series. */
  slice(beginIndex?: number, endIndex?: number): TimeSeries<S> {
    // Column-native (Step 4): reshape the store's row range directly via
    // `withRowRange` — no `this.events` materialization. The public contract
    // is `Array.prototype.slice` (negative indices count from the end,
    // non-integers truncate toward zero, out-of-range clamps), which
    // `withRowRange` does not implement, so normalize to an absolute
    // `[start, end)` here first (matching `Array.prototype.slice`'s
    // `ToInteger` + from-end semantics), then slice the store.
    const n = this.#store.store.length;
    const toIndex = (i: number | undefined, dflt: number): number => {
      if (i === undefined) return dflt;
      if (Number.isNaN(i)) return 0; // ToInteger(NaN) === 0
      const t = Math.trunc(i);
      return t < 0 ? Math.max(0, n + t) : Math.min(t, n);
    };
    const start = toIndex(beginIndex, 0);
    const end = toIndex(endIndex, n);
    return TimeSeries.#fromTrustedStore(
      this.name,
      this.schema,
      withRowRange(
        this.#store.store,
        start,
        end,
      ) as unknown as ColumnarStore<ColumnSchema>,
    );
  }

  /** Example: `series.filter(event => event.get("active"))`. Returns a new series containing only events that match the predicate. */
  filter(
    predicate: (event: EventForSchema<S>, index: number) => boolean,
  ): TimeSeries<S> {
    return TimeSeries.#fromTrustedEvents(
      this.name,
      this.schema,
      this.events.filter((event, index) => predicate(event, index)),
    );
  }

  /**
   * Example: `series.sample({ stride: 10 })` — keep every 10th event,
   * uniformly over time. `series.sample({ reservoir: { size: 500 } })`
   * — random K-of-N (single-pass Algorithm R), the canonical
   * visualization shape (`series.sample({reservoir:{size:500}}).toRows()`
   * gives uncorrelated points without `aggregate`'s grid collapse).
   *
   * Snapshot-side reservoir is single-pass over a known-N events
   * array — no eviction-protocol concerns, no `Set` bookkeeping —
   * and ships in v0.17.0. Returns a new `TimeSeries<S>` of K events
   * (or `events.length` for stride if `events.length < stride`).
   *
   * For the live counterpart, see `LiveSeries.sample` /
   * `LivePartitionedSeries.sample`. Live ships **stride only** in
   * v0.17.0; reservoir is deferred — see {@link BatchSampleStrategy}
   * JSDoc for the rationale.
   */
  sample(strategy: BatchSampleStrategy): TimeSeries<S> {
    if ('stride' in strategy) {
      const stride = strategy.stride;
      if (!Number.isInteger(stride) || stride < 1) {
        throw new TypeError(
          `sample({ stride }): stride must be a positive integer (got ${String(stride)})`,
        );
      }
      const sampled: EventForSchema<S>[] = [];
      for (let i = stride - 1; i < this.events.length; i += stride) {
        sampled.push(this.events[i]!);
      }
      return TimeSeries.#fromTrustedEvents(this.name, this.schema, sampled);
    }
    const k = strategy.reservoir.size;
    if (!Number.isInteger(k) || k < 1) {
      throw new TypeError(
        `sample({ reservoir }): size must be a positive integer (got ${String(k)})`,
      );
    }
    const n = this.events.length;
    if (n <= k) {
      // K >= N — return all events, in original order.
      return TimeSeries.#fromTrustedEvents(this.name, this.schema, [
        ...this.events,
      ]);
    }
    // Algorithm R, single pass.
    const reservoir: EventForSchema<S>[] = this.events.slice(0, k);
    for (let i = k; i < n; i++) {
      const j = Math.floor(Math.random() * (i + 1));
      if (j < k) reservoir[j] = this.events[i]!;
    }
    // Reservoir is unordered (random replacement). Sort by key to
    // restore the chronological invariant TimeSeries promises.
    reservoir.sort((a, b) => a.key().compare(b.key()));
    return TimeSeries.#fromTrustedEvents(this.name, this.schema, reservoir);
  }

  /**
   * Example: `series.find(event => event.get("value") > 0)`.
   * Returns the first event that matches the predicate, if any.
   *
   * Routes per-row through `#store.eventAt(i)` — stops at the
   * first match without forcing materialization of the rest. The
   * cache populates rows on demand, so a predicate that hits
   * early in a 10M-row series only pays for the rows it touches.
   */
  find(
    predicate: (event: EventForSchema<S>, index: number) => boolean,
  ): EventForSchema<S> | undefined {
    const n = this.#store.length;
    for (let i = 0; i < n; i += 1) {
      const event = this.#store.eventAt(i) as unknown as EventForSchema<S>;
      if (predicate(event, i)) return event;
    }
    return undefined;
  }

  /** Example: `series.some(event => event.get("healthy"))`. Returns `true` when at least one event matches the predicate. */
  some(
    predicate: (event: EventForSchema<S>, index: number) => boolean,
  ): boolean {
    const n = this.#store.length;
    for (let i = 0; i < n; i += 1) {
      const event = this.#store.eventAt(i) as unknown as EventForSchema<S>;
      if (predicate(event, i)) return true;
    }
    return false;
  }

  /** Example: `series.every(event => event.get("healthy"))`. Returns `true` when every event matches the predicate. */
  every(
    predicate: (event: EventForSchema<S>, index: number) => boolean,
  ): boolean {
    const n = this.#store.length;
    for (let i = 0; i < n; i += 1) {
      const event = this.#store.eventAt(i) as unknown as EventForSchema<S>;
      if (!predicate(event, i)) return false;
    }
    return true;
  }

  /** Example: `series.includesKey(new Time(Date.now()))`. Returns `true` when the series contains an event with an exactly matching key. */
  includesKey(key: KeyLike): boolean {
    const normalizedKey = toKey(key);
    const index = this.bisect(normalizedKey);
    if (index >= this.#store.length) return false;
    // `keyAt` is cheap — only resolves the key column buffer, not
    // the full event materialization.
    return this.#store.keyAt(index).equals(normalizedKey);
  }

  /**
   * Example: `series.bisect(new Time(Date.now()))`. Returns the
   * insertion index for the supplied key in the ordered event
   * sequence.
   *
   * Walks the columnar key buffer via `#store.keyAt(i)` rather
   * than materializing events for the binary-search probes.
   * O(log N) keys touched; no Event allocations.
   */
  bisect(key: KeyLike): number {
    const normalizedKey = toKey(key);
    let low = 0;
    let high = this.#store.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.#store.keyAt(mid).compare(normalizedKey) < 0) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  /** Example: `series.atOrBefore(new Time(Date.now()))`. Returns the event with the exact key or the nearest earlier event, if any. */
  atOrBefore(key: KeyLike): EventForSchema<S> | undefined {
    const normalizedKey = toKey(key);
    const index = this.bisect(normalizedKey);
    const n = this.#store.length;
    if (index < n && this.#store.keyAt(index).equals(normalizedKey)) {
      return this.at(index);
    }
    return index === 0 ? undefined : this.at(index - 1);
  }

  /** Example: `series.atOrAfter(new Time(Date.now()))`. Returns the event with the exact key or the nearest later event, if any. */
  atOrAfter(key: KeyLike): EventForSchema<S> | undefined {
    return this.at(this.bisect(key));
  }

  /** Example: `series.timeRange()`. Returns the overall temporal extent of the series, if the series is not empty. */
  timeRange(): TimeRange | undefined {
    const first = this.first();
    if (!first) {
      return undefined;
    }

    const start = first.begin();
    const end = this.events.reduce(
      (maxEnd, event) => Math.max(maxEnd, event.end()),
      first.end(),
    );
    return new TimeRange({ start, end });
  }

  /** Example: `series.overlaps(range)`. Returns `true` when the overall series extent overlaps the supplied temporal value. */
  overlaps(other: SeriesRangeLike): boolean {
    const range = this.timeRange();
    const otherRange = toOptionalSeriesRange(other);
    if (!range || !otherRange) {
      return false;
    }
    return range.overlaps(otherRange);
  }

  /** Example: `series.contains(range)`. Returns `true` when the overall series extent fully contains the supplied temporal value. */
  contains(other: SeriesRangeLike): boolean {
    const range = this.timeRange();
    const otherRange = toOptionalSeriesRange(other);
    if (!range || !otherRange) {
      return false;
    }
    return range.contains(otherRange);
  }

  /** Example: `series.intersection(range)`. Returns the overlap between the overall series extent and the supplied temporal value, if any. */
  intersection(other: SeriesRangeLike): TimeRange | undefined {
    const range = this.timeRange();
    const otherRange = toOptionalSeriesRange(other);
    if (!range || !otherRange) {
      return undefined;
    }
    return range.intersection(otherRange);
  }

  /**
   * Example: `series.overlapping(range)`.
   * Returns the portion of the series whose event extents overlap the supplied range.
   *
   * Unlike `within(...)`, this keeps partially overlapping events without modifying their keys.
   * Use `trim(...)` when you want those overlapping keys clipped to the supplied range.
   */
  overlapping(range: RangeLike): TimeSeries<S> {
    return this.filter((event) => event.overlaps(range));
  }

  /**
   * Example: `series.containedBy(range)`.
   * Returns the portion of the series whose event extents are fully contained by the supplied range.
   *
   * This is the strict containment selector:
   * events must start at or after the range start and end at or before the range end.
   * Unlike `overlapping(...)`, partially overlapping events are excluded.
   */
  containedBy(range: RangeLike): TimeSeries<S> {
    const selectionRange = toSelectionRange(range);
    return this.filter((event) => selectionRange.contains(event));
  }

  /**
   * Example: `series.trim(range)`.
   * Returns the series trimmed to the supplied range by clipping overlapping event keys.
   *
   * Non-overlapping events are dropped. Overlapping `TimeRange` and `Interval` keys are clipped
   * to the supplied range. Overlapping `Time` keys are preserved unchanged.
   */
  trim(range: RangeLike): TimeSeries<S> {
    const trimmedEvents = this.events
      .map((event) => event.trim(range))
      .filter((event): event is EventForSchema<S> => event !== undefined);

    return TimeSeries.#fromTrustedEvents(this.name, this.schema, trimmedEvents);
  }

  /** Example: `series.before(Date.now())`. Returns the events ending strictly before the supplied temporal boundary. */
  before(boundary: BoundaryLike): TimeSeries<S> {
    const limit = toBoundaryTimestamp(boundary);
    return this.filter((event) => event.end() < limit);
  }

  /** Example: `series.after(Date.now())`. Returns the events beginning strictly after the supplied temporal boundary. */
  after(boundary: BoundaryLike): TimeSeries<S> {
    const limit = toBoundaryTimestamp(boundary);
    return this.filter((event) => event.begin() > limit);
  }

  /**
   * Example: `series.tail('30s')`.
   * Returns the trailing portion of the series covering the supplied
   * duration, measured backward from the last event's `begin()`. Events
   * whose `begin()` is strictly greater than `lastBegin - duration` are
   * kept. If the series is empty, or the argument is omitted, the series
   * is returned unchanged — `tail()` with no argument is the identity.
   *
   * This is the temporal counterpart to `Array.slice(-n)`, and composes
   * naturally with `reduce` to express "current" state:
   *
   * ```ts
   * series.tail('30s').reduce({ cpu: 'avg', host: 'unique' });
   * // => { cpu: number | undefined, host: ArrayValue | undefined }
   * ```
   */
  tail(duration?: DurationInput): TimeSeries<S> {
    if (duration === undefined) return this;
    if (this.events.length === 0) return this;
    const durationMs = parseDuration(duration);
    const lastBegin = this.events[this.events.length - 1]!.begin();
    const cutoff = lastBegin - durationMs;
    return this.filter((event) => event.begin() > cutoff);
  }

  /**
   * Example: `series.within(start, end)`.
   * Returns the portion of the series fully contained by the supplied inclusive temporal range.
   *
   * This is equivalent in behavior to `containedBy(...)`, but accepts either explicit begin/end
   * boundaries or a single range-like value.
   */
  within(begin: TimestampInput, end: TimestampInput): TimeSeries<S>;
  /**
   * Example: `series.within(range)`.
   * Returns the portion of the series fully contained by the supplied inclusive temporal range.
   *
   * Use `overlapping(...)` for intersection-based selection or `trim(...)` for clipped output.
   */
  within(range: RangeLike): TimeSeries<S>;
  within(
    beginOrRange: TimestampInput | RangeLike,
    end?: TimestampInput,
  ): TimeSeries<S> {
    const range =
      end === undefined
        ? toSelectionRange(beginOrRange as RangeLike)
        : new TimeRange({ start: beginOrRange as TimestampInput, end });
    return this.filter(
      (event) => event.begin() >= range.begin() && event.end() <= range.end(),
    );
  }

  /** Example: `series.select("cpu", "healthy")`. Returns a new series containing only the selected payload fields. */
  select<const Keys extends readonly (keyof EventDataForSchema<S>)[]>(
    ...keys: Keys
  ): TimeSeries<SelectSchema<S, Keys[number] & string>> {
    const firstColumn = this.schema[0]!;
    const selectedColumns = this.schema
      .slice(1)
      .filter((column) => keys.includes(column.name as Keys[number]));
    const resultSchema = Object.freeze([
      firstColumn,
      ...selectedColumns,
    ]) as unknown as SelectSchema<S, Keys[number] & string>;

    // Column-native (Step 4): reshape the store's columns directly —
    // a zero-copy reference of the selected value columns + the shared
    // key axis — instead of materializing `this.events`, building one
    // new `Event` per row, and re-storing. Recovers the columnar
    // construction win for pipeline users at the first transform.
    const reshaped = withColumnsSelected(
      this.#store.store,
      selectedColumns.map((column) => column.name),
    );
    return TimeSeries.#fromTrustedStore(
      this.name,
      resultSchema as unknown as SeriesSchema,
      reshaped,
    ) as unknown as TimeSeries<SelectSchema<S, Keys[number] & string>>;
  }

  /** Example: `series.rename({ cpu: "usage" })`. Returns a new series with payload field names renamed according to the supplied mapping. */
  rename<const Mapping extends RenameMap<EventDataForSchema<S>>>(
    mapping: Mapping,
  ): TimeSeries<RenameSchema<S, Mapping>> {
    const firstColumn = this.schema[0]!;
    // `hasOwnProperty` lookup (not bracket access) so a column named
    // `toString` / `valueOf` / etc. doesn't pick up an inherited
    // `Object.prototype` member as its rename target — matches
    // `withColumnsRenamed`'s guard. Preserve the full def (incl.
    // `required`) on the result schema.
    const renamedColumns = this.schema.slice(1).map((column) => ({
      ...column,
      name: Object.prototype.hasOwnProperty.call(mapping, column.name)
        ? (mapping as Record<string, string>)[column.name]!
        : column.name,
    }));
    const resultSchema = Object.freeze([
      firstColumn,
      ...renamedColumns,
    ]) as unknown as RenameSchema<S, Mapping>;

    // Column-native (Step 4): relabel the store's columns directly — a
    // zero-copy reference of the same value columns under new names +
    // the shared key axis — instead of materializing `this.events` and
    // building one renamed `Event` per row. `withColumnsRenamed` also
    // rejects key renames + target-name collisions (the old event path
    // silently produced a duplicate-named schema).
    const reshaped = withColumnsRenamed(
      this.#store.store,
      mapping as Readonly<Record<string, string>>,
    );
    return TimeSeries.#fromTrustedStore(
      this.name,
      resultSchema as unknown as SeriesSchema,
      reshaped,
    ) as unknown as TimeSeries<RenameSchema<S, Mapping>>;
  }

  /** Example: `series.collapse(["in", "out"], "avg", fn)`. Collapses selected payload fields into a single derived field across each event in the series. */
  collapse<
    const Keys extends readonly (keyof EventDataForSchema<S>)[],
    Name extends string,
    R extends ScalarValue,
  >(
    keys: Keys,
    output: Name,
    reducer: (values: Pick<EventDataForSchema<S>, Keys[number]>) => R,
  ): TimeSeries<CollapseSchema<S, Keys[number] & string, Name, R>>;

  collapse<
    const Keys extends readonly (keyof EventDataForSchema<S>)[],
    Name extends string,
    R extends ScalarValue,
  >(
    keys: Keys,
    output: Name,
    reducer: (values: Pick<EventDataForSchema<S>, Keys[number]>) => R,
    options: { append: true },
  ): TimeSeries<CollapseSchema<S, Keys[number] & string, Name, R, true>>;

  collapse<
    const Keys extends readonly (keyof EventDataForSchema<S>)[],
    Name extends string,
    R extends ScalarValue,
  >(
    keys: Keys,
    output: Name,
    reducer: (values: Pick<EventDataForSchema<S>, Keys[number]>) => R,
    options?: { append?: boolean },
  ): any {
    // Column-native (Step 4): the reducer runs over the keyed columns read
    // straight off the store in the extracted `collapseOp` — no
    // `this.events` materialization, no per-row `Event`. Kept columns + the
    // key pass through by reference; the output column is appended. The
    // method is a thin delegate.
    const { store, schema } = collapseOp<
      S,
      CollapseSchema<S, Keys[number] & string, Name, R, boolean>
    >(
      this.#store.store,
      this.schema,
      keys as readonly string[],
      output,
      reducer as unknown as CollapseReducer,
      options?.append === true,
    );
    return TimeSeries.#fromTrustedStore(
      this.name,
      schema as unknown as SeriesSchema,
      store as unknown as ColumnarStore<ColumnSchema>,
    ) as unknown as TimeSeries<
      CollapseSchema<S, Keys[number] & string, Name, R, boolean>
    >;
  }

  /**
   * Example: `series.arrayContains("tags", "critical")`.
   * Keeps events whose array column `col` contains `value`. Events with an
   * `undefined` value are dropped. Use on array-kind columns produced by
   * reducers like `"unique"`, or on tag-style columns where each event
   * carries a list of scalars.
   */
  arrayContains<const Col extends ArrayColumnNameForSchema<S> & string>(
    col: Col,
    value: ScalarValue,
  ): TimeSeries<S> {
    return TimeSeries.#fromTrustedEvents(
      this.name,
      this.schema,
      this.events.filter((event) => {
        const data = event.data();
        const arr = data[col as keyof typeof data] as ArrayValue | undefined;
        return Array.isArray(arr) && arr.includes(value);
      }),
    );
  }

  /**
   * Example: `series.arrayContainsAll("tags", ["web", "east"])`.
   * Keeps events whose array column `col` contains _every_ value in
   * `values` (subset / set-containment AND). `values` of length 0 keeps
   * every event with a defined array on `col`. Events with an `undefined`
   * array are dropped.
   */
  arrayContainsAll<const Col extends ArrayColumnNameForSchema<S> & string>(
    col: Col,
    values: readonly ScalarValue[],
  ): TimeSeries<S> {
    return TimeSeries.#fromTrustedEvents(
      this.name,
      this.schema,
      this.events.filter((event) => {
        const data = event.data();
        const arr = data[col as keyof typeof data] as ArrayValue | undefined;
        if (!Array.isArray(arr)) return false;
        for (const needle of values) {
          if (!arr.includes(needle)) return false;
        }
        return true;
      }),
    );
  }

  /**
   * Example: `series.arrayContainsAny("tags", ["critical", "warning"])`.
   * Keeps events whose array column `col` contains _at least one_ value in
   * `values` (set-intersection OR). `values` of length 0 always returns
   * an empty series. Events with an `undefined` array are dropped.
   */
  arrayContainsAny<const Col extends ArrayColumnNameForSchema<S> & string>(
    col: Col,
    values: readonly ScalarValue[],
  ): TimeSeries<S> {
    return TimeSeries.#fromTrustedEvents(
      this.name,
      this.schema,
      this.events.filter((event) => {
        const data = event.data();
        const arr = data[col as keyof typeof data] as ArrayValue | undefined;
        if (!Array.isArray(arr)) return false;
        for (const needle of values) {
          if (arr.includes(needle)) return true;
        }
        return false;
      }),
    );
  }

  /**
   * Example: `series.arrayAggregate("tags", "count")`.
   * Per-event reduction of an array column. Feeds each event's array into
   * the reducer as if it were a bucket, reusing the built-in reducer
   * registry (`count`, `sum`, `avg`, `min`, `max`, `median`, `stdev`,
   * `difference`, `pNN`, `first`, `last`, `keep`, `unique`) and any custom
   * `(values) => result` function. Output kind is inferred:
   *
   * - numeric reducers (`count`, `sum`, `avg`, `min`, `max`, `median`,
   *   `stdev`, `difference`, `pNN`) → `"number"`
   * - `"unique"` → `"array"` (dedupes within the event's array)
   * - `"first"` / `"last"` / `"keep"` / custom → `"string"` by default;
   *   override with `{ kind: "..." }`
   *
   * Without `as`, the source column is replaced in place. With
   * `{ as: "name" }`, a new column is appended and the source array column
   * is preserved.
   *
   * Example: `series.arrayAggregate("tags", "count", { as: "tagCount" })`.
   */
  arrayAggregate<
    const Col extends ArrayColumnNameForSchema<S> & string,
    const Op extends AggregateReducer,
    const ExplicitKind extends ScalarKind | undefined = undefined,
  >(
    col: Col,
    reducer: Op,
    options?: { kind?: ExplicitKind },
  ): TimeSeries<ArrayAggregateReplaceSchema<S, Col, Op, ExplicitKind>>;
  arrayAggregate<
    const Col extends ArrayColumnNameForSchema<S> & string,
    const Op extends AggregateReducer,
    const Name extends string,
    const ExplicitKind extends ScalarKind | undefined = undefined,
  >(
    col: Col,
    reducer: Op,
    options: { as: Name; kind?: ExplicitKind },
  ): TimeSeries<ArrayAggregateAppendSchema<S, Name, Op, ExplicitKind>>;
  arrayAggregate(
    col: string,
    reducer: AggregateReducer,
    options?: { as?: string; kind?: ScalarKind },
  ): TimeSeries<SeriesSchema> {
    const outputName = options?.as ?? col;
    const appendMode = options?.as !== undefined && options.as !== col;
    const outputKind = resolveArrayAggregateKind(reducer, options?.kind);

    const outputColumn: ValueColumn = {
      name: outputName,
      kind: outputKind,
      required: false,
    } as ValueColumn;

    const resultSchema = Object.freeze(
      appendMode
        ? [...this.schema, outputColumn]
        : this.schema.map((column) =>
            column.name === col ? outputColumn : column,
          ),
    ) as unknown as SeriesSchema;

    const resultRows = this.events.map((event) => {
      const data = event.data();
      const arr = data[col as keyof typeof data] as ArrayValue | undefined;
      const reduced = Array.isArray(arr)
        ? applyAggregateReducer(reducer, arr as ReadonlyArray<ColumnValue>)
        : undefined;
      return Object.freeze(
        (resultSchema as readonly ValueColumn[]).map((column, index) => {
          if (index === 0) return event.key();
          if (appendMode && column.name === outputName) return reduced;
          if (!appendMode && column.name === col) return reduced;
          return data[column.name as keyof typeof data];
        }),
      );
    });

    return new TimeSeries({
      name: this.name,
      schema: resultSchema,
      rows: resultRows as unknown as TimeSeriesInput<SeriesSchema>['rows'],
    });
  }

  /**
   * Example: `series.arrayExplode("tags")`.
   * Fans each event out into one event per element of the array column
   * `col`. Events with an empty or `undefined` array are dropped. Emitted
   * events share the source event's key, so the result may contain events
   * with duplicate timestamps.
   *
   * Without `as`, the array column is replaced by a scalar column of the
   * chosen `kind` (default `"string"`).
   *
   * Example: `series.arrayExplode("tags", { as: "tag" })`.
   * With `as`, a new scalar column is appended carrying the per-element
   * value and the source array column is kept intact (every fanned-out
   * event still carries the full array on `col`).
   */
  arrayExplode<
    const Col extends ArrayColumnNameForSchema<S> & string,
    const OutputKind extends ScalarKind = 'string',
  >(
    col: Col,
    options?: { kind?: OutputKind },
  ): TimeSeries<ArrayExplodeReplaceSchema<S, Col, OutputKind>>;
  arrayExplode<
    const Col extends ArrayColumnNameForSchema<S> & string,
    const Name extends string,
    const OutputKind extends ScalarKind = 'string',
  >(
    col: Col,
    options: { as: Name; kind?: OutputKind },
  ): TimeSeries<ArrayExplodeAppendSchema<S, Name, OutputKind>>;
  arrayExplode(
    col: string,
    options?: { as?: string; kind?: ScalarKind },
  ): TimeSeries<SeriesSchema> {
    const outputKind: ScalarKind = options?.kind ?? 'string';
    const outputName = options?.as ?? col;
    const appendMode = options?.as !== undefined && options.as !== col;

    const outputColumn: ValueColumn = {
      name: outputName,
      kind: outputKind,
      required: false,
    } as ValueColumn;

    const resultSchema = Object.freeze(
      appendMode
        ? [...this.schema, outputColumn]
        : this.schema.map((column) =>
            column.name === col ? outputColumn : column,
          ),
    ) as unknown as SeriesSchema;

    const resultRows: unknown[][] = [];
    for (const event of this.events) {
      const data = event.data();
      const arr = data[col as keyof typeof data] as ArrayValue | undefined;
      if (!Array.isArray(arr) || arr.length === 0) continue;
      for (const element of arr) {
        resultRows.push(
          (resultSchema as readonly ValueColumn[]).map((column, index) => {
            if (index === 0) return event.key();
            if (appendMode && column.name === outputName) return element;
            if (!appendMode && column.name === col) return element;
            return data[column.name as keyof typeof data];
          }),
        );
      }
    }

    return new TimeSeries({
      name: this.name,
      schema: resultSchema,
      rows: resultRows as unknown as TimeSeriesInput<SeriesSchema>['rows'],
    });
  }

  /**
   * Example: `series.length`. Returns the number of events in the
   * series. Delegates to the columnar store (avoids materializing
   * the lazy `events` array just to read its length).
   */
  get length(): number {
    return this.#store.length;
  }

  /**
   * Example: `for (const event of series) { ... }`. Iterates events in order.
   *
   * Pulls one event at a time via `#store.eventAt(i)` rather than
   * materializing the full events array up front. A `break` or
   * early-exit inside the loop only pays for the rows it touched.
   * The store's per-row cache means re-iteration (or a subsequent
   * `series.events` call) reuses the same Event references.
   */
  [Symbol.iterator](): Iterator<EventForSchema<S>> {
    let index = 0;
    const store = this.#store;
    return {
      next(): IteratorResult<EventForSchema<S>> {
        if (index < store.length) {
          const event = store.eventAt(index) as unknown as EventForSchema<S>;
          index += 1;
          return { value: event, done: false };
        }
        return { value: undefined as unknown as EventForSchema<S>, done: true };
      },
    };
  }

  /** Example: `series.toArray()`. Returns a shallow copy of the event array. */
  toArray(): EventForSchema<S>[] {
    return this.events.slice();
  }

  /**
   * Example: `series.toPoints()`.
   * Wide-row export: `{ ts, ...valueColumns }[]`. Every event in the
   * series produces one row; every value column from the schema
   * appears as a top-level key. Missing values stay `undefined`
   * (chart libraries render those as gaps under `connectNulls={false}`
   * or equivalent).
   *
   * `ts` is `event.begin()` — for `Time` keys this is the timestamp,
   * for `TimeRange` / `Interval` keys this is the interval start.
   *
   * Need a single column? Compose with `select`:
   *
   * ```ts
   * const data = series.select('cpu').toPoints();
   * // [{ ts: number, cpu: number | undefined }, ...]
   * ```
   *
   * The shape — flat `{ ts, ... }[]` — is what every mainstream chart
   * library accepts directly (Recharts, Observable Plot, visx, raw d3).
   */
  toPoints(): ReadonlyArray<PointRowForSchema<S>> {
    const valueCols = this.schema.slice(1) as ReadonlyArray<{ name: string }>;
    return Object.freeze(
      this.events.map((event) => {
        const row: Record<string, unknown> = { ts: event.begin() };
        const data = event.data() as Record<string, unknown>;
        for (const col of valueCols) {
          row[col.name] = data[col.name];
        }
        return Object.freeze(row) as PointRowForSchema<S>;
      }),
    );
  }

  /**
   * Example: `series.baseline('cpu', { window: '1m', sigma: 2 })`.
   * Appends rolling-baseline statistics as four new columns on every
   * event: the rolling average (`avg`), rolling standard deviation
   * (`sd`), and the band edges (`upper = avg + sigma * sd`,
   * `lower = avg - sigma * sd`). The source schema is preserved
   * intact, so downstream code can filter, render, and compose freely.
   *
   * This is the primitive behind band charts and outlier detection:
   *
   * ```ts
   * const baseline = series.baseline('cpu', { window: '1m', sigma: 2 });
   *
   * // Band charts: one wide-row export covers every column at once.
   * const data = baseline.toPoints();
   * // [{ ts, cpu, ..., avg, sd, upper, lower }, ...]
   *
   * // Anomaly detection: one filter, no extra rolling pass.
   * const anomalies = baseline.filter((e) => {
   *   const cpu = e.get('cpu');
   *   const upper = e.get('upper');
   *   const lower = e.get('lower');
   *   return cpu != null && upper != null && lower != null
   *     && (cpu > upper || cpu < lower);
   * });
   * ```
   *
   * The `sigma` option controls band width — `sigma: 2` is the common
   * "95% envelope" for normally distributed data. Opening events
   * before the rolling window has a meaningful baseline get
   * `undefined` for all four new columns. Inside the warm-up region,
   * events where `sd === 0` (a flat window) keep the `avg` / `sd`
   * values but emit `undefined` for `upper` / `lower` — a zero-width
   * band would flag every non-equal point as anomalous, which is not
   * the primitive callers want. Filters that compare against the
   * band should null-check `upper` / `lower`.
   *
   * The `minSamples` option (forwarded to {@link TimeSeries.rolling})
   * widens the warm-up region: rows whose window contains fewer than
   * `minSamples` source events emit `undefined` for all four columns.
   * Use it on noisy data where a tiny sample count produces a
   * collapsed `sd` and false-flags the early events as anomalies; a
   * value of `20` is a reasonable default for sub-second telemetry on
   * a 1-minute window. Defaults to `0` (no warm-up gate).
   *
   * Custom column names via the `names` option if the defaults would
   * collide with source columns.
   *
   * Internally a single `rolling(window, { avg, sd })` pass over the
   * source; band edges are derived arithmetically per event.
   *
   * **Multi-entity series:** the baseline window aggregates across
   * every entity, so `host-A`'s `avg`/`sd` reflect the cross-entity
   * mean/spread rather than `host-A`'s own. Anomaly detection on a
   * multi-entity baseline flags events relative to the wrong
   * population. On a series carrying multiple entities (host, region,
   * device id), use
   * `series.partitionBy(col).baseline(...).collect()` to scope per
   * entity. See {@link TimeSeries.partitionBy}.
   */
  baseline<
    const Col extends NumericColumnNameForSchema<S>,
    const AvgName extends string = 'avg',
    const SdName extends string = 'sd',
    const UpperName extends string = 'upper',
    const LowerName extends string = 'lower',
  >(
    col: Col,
    options: {
      window: DurationInput;
      sigma: number;
      alignment?: RollingAlignment;
      minSamples?: number;
      names?: {
        avg?: AvgName;
        sd?: SdName;
        upper?: UpperName;
        lower?: LowerName;
      };
    },
  ): TimeSeries<BaselineSchema<S, AvgName, SdName, UpperName, LowerName>> {
    const { window, sigma, alignment, minSamples } = options;
    if (!Number.isFinite(sigma) || sigma <= 0) {
      throw new TypeError('baseline sigma must be a positive finite number');
    }
    const avgName = (options.names?.avg ?? 'avg') as AvgName;
    const sdName = (options.names?.sd ?? 'sd') as SdName;
    const upperName = (options.names?.upper ?? 'upper') as UpperName;
    const lowerName = (options.names?.lower ?? 'lower') as LowerName;

    // Guard against name collisions with existing source columns.
    const existing = new Set(this.schema.slice(1).map((c) => c.name));
    for (const n of [avgName, sdName, upperName, lowerName]) {
      if (existing.has(n)) {
        throw new TypeError(
          `baseline output column '${n}' collides with an existing schema column; use the 'names' option to rename`,
        );
      }
    }

    // Single rolling pass; output names match our output schema so we
    // can read them back by name.
    const rollingOptions: {
      alignment?: RollingAlignment;
      minSamples?: number;
    } = {};
    if (alignment !== undefined) rollingOptions.alignment = alignment;
    if (minSamples !== undefined) rollingOptions.minSamples = minSamples;
    const rolling = this.rolling(
      window,
      {
        [avgName]: { from: col as string, using: 'avg' as const },
        [sdName]: { from: col as string, using: 'stdev' as const },
      } as unknown as AggregateOutputMap<S>,
      rollingOptions,
    ) as unknown as TimeSeries<SeriesSchema>;

    const resultSchema = Object.freeze([
      ...this.schema,
      { name: avgName, kind: 'number' as const, required: false as const },
      { name: sdName, kind: 'number' as const, required: false as const },
      { name: upperName, kind: 'number' as const, required: false as const },
      { name: lowerName, kind: 'number' as const, required: false as const },
    ]) as unknown as BaselineSchema<S, AvgName, SdName, UpperName, LowerName>;

    const resultRows = this.events.map((event, index) => {
      const data = event.data() as Record<string, unknown>;
      const rollEvent = rolling.at(index);
      const rollData = (rollEvent?.data() ?? {}) as Record<string, unknown>;
      const avg = rollData[avgName];
      const sd = rollData[sdName];
      const avgNum = typeof avg === 'number' ? avg : undefined;
      const sdNum = typeof sd === 'number' ? sd : undefined;
      // sd === 0 means a flat rolling window — there is no meaningful
      // deviation against it. Matching outliers(), we emit undefined
      // bands so `value > upper || value < lower` doesn't flag every
      // non-equal point as anomalous.
      const bandValid =
        avgNum !== undefined && sdNum !== undefined && sdNum > 0;
      const upperNum = bandValid ? avgNum + sigma * sdNum : undefined;
      const lowerNum = bandValid ? avgNum - sigma * sdNum : undefined;
      return Object.freeze([
        event.key(),
        ...this.schema.slice(1).map((c) => data[c.name]),
        avgNum,
        sdNum,
        upperNum,
        lowerNum,
      ]);
    });

    return new TimeSeries({
      name: this.name,
      schema: resultSchema as unknown as SeriesSchema,
      rows: resultRows as unknown as TimeSeriesInput<SeriesSchema>['rows'],
    }) as unknown as TimeSeries<
      BaselineSchema<S, AvgName, SdName, UpperName, LowerName>
    >;
  }

  /**
   * Example: `series.outliers('cpu', { window: '1m', sigma: 2 })`.
   * Rolling-baseline outlier detection: returns the subset of events
   * whose value on `col` deviates from the trailing rolling average
   * by more than `sigma * rolling_stdev`. Same schema as the input,
   * so the result composes with every other `TimeSeries` method —
   * `.aggregate(seq, { col: 'count' })` for bucketed anomaly counts,
   * `.groupBy('host')` for per-host outlier lists, etc.
   *
   * Events before the rolling window has a meaningful baseline (stdev
   * is zero or undefined) are not flagged — can't detect deviation
   * against a flat or empty reference. The `minSamples` option
   * (forwarded to {@link TimeSeries.rolling}) widens that warm-up:
   * rows whose window contains fewer than `minSamples` source events
   * are skipped before the comparison. Defaults to `0` (no gate).
   *
   * Conceptually equivalent to `baseline(col, { window, sigma })`
   * followed by a `|value - avg| > sigma * sd` filter — both share
   * the same flat-window skip behavior. Implemented independently
   * (one rolling pass, no intermediate schema), so reach for
   * `baseline(...)` directly when you also want to render the
   * `avg` / `upper` / `lower` columns.
   *
   * Internally: computes `rolling(window, { avg, sd })` using the
   * output-map form, zips with the source events by index, and keeps
   * events where `|value - avg| > sigma * sd`.
   *
   * **Multi-entity series:** the rolling baseline aggregates across
   * every entity, so the deviation threshold reflects the wrong
   * population — `host-A`'s "outlier" status is decided against the
   * cross-entity mean rather than `host-A`'s own. On a series carrying
   * multiple entities (host, region, device id), use
   * `series.partitionBy(col).outliers(...).collect()` to scope per
   * entity. See {@link TimeSeries.partitionBy}.
   */
  outliers<const Col extends NumericColumnNameForSchema<S>>(
    col: Col,
    options: {
      window: DurationInput;
      sigma: number;
      alignment?: RollingAlignment;
      minSamples?: number;
    },
  ): TimeSeries<S> {
    const { window, sigma, alignment, minSamples } = options;
    if (!Number.isFinite(sigma) || sigma <= 0) {
      throw new TypeError('outliers sigma must be a positive finite number');
    }
    // Internal names chosen so the rolling output can't collide with
    // any user column — the output-map form accepts any distinct keys.
    const ROLL_AVG = '__pond_outliers_avg__';
    const ROLL_SD = '__pond_outliers_sd__';
    const rollingMapping = {
      [ROLL_AVG]: { from: col as string, using: 'avg' as const },
      [ROLL_SD]: { from: col as string, using: 'stdev' as const },
    } as unknown as AggregateOutputMap<S>;
    const rollingOptions: {
      alignment?: RollingAlignment;
      minSamples?: number;
    } = {};
    if (alignment !== undefined) rollingOptions.alignment = alignment;
    if (minSamples !== undefined) rollingOptions.minSamples = minSamples;
    const rolling = this.rolling(
      window,
      rollingMapping,
      rollingOptions,
    ) as unknown as TimeSeries<SeriesSchema>;

    const kept: EventForSchema<S>[] = [];
    for (let i = 0; i < this.events.length; i += 1) {
      const src = this.events[i]!;
      const rollEvent = rolling.at(i);
      if (!rollEvent) continue;
      const data = rollEvent.data() as Record<string, unknown>;
      const avg = data[ROLL_AVG];
      const sd = data[ROLL_SD];
      if (typeof avg !== 'number' || typeof sd !== 'number') continue;
      if (sd === 0) continue; // flat window — nothing to deviate from
      const raw = src.get(col);
      if (typeof raw !== 'number') continue;
      if (Math.abs(raw - avg) > sigma * sd) {
        kept.push(src);
      }
    }
    return TimeSeries.#fromTrustedEvents(this.name, this.schema, kept);
  }

  /**
   * Example: `TimeSeries.fromPoints(pts, { schema: [...] })`.
   * Construct a `TimeSeries` from a flat array of wide-row points —
   * the inverse of `toPoints()`. Each point carries `ts` plus one key
   * per value column from the schema; missing keys become `undefined`.
   *
   * The schema's first column must be `kind: 'time'` — `ts` is a
   * single timestamp and can't reconstruct a `TimeRange` or
   * `Interval` extent. Schemas may have any number of value columns.
   *
   * Useful for round-tripping chart data back into pond-native
   * operations — e.g. bucketing a flat list of anomaly points via
   * `aggregate(Sequence.every('15s'), { cpu: 'count' })`.
   */
  static fromPoints<S extends SeriesSchema>(
    points: ReadonlyArray<{ ts: TimestampInput } & Record<string, unknown>>,
    options: { schema: S; name?: string },
  ): TimeSeries<S> {
    const schema = options.schema;
    if (schema.length < 2) {
      throw new TypeError(
        'TimeSeries.fromPoints expects a schema with at least one value column',
      );
    }
    if (schema[0]!.kind !== 'time') {
      throw new TypeError(
        `TimeSeries.fromPoints requires a time-keyed schema; got first column kind '${schema[0]!.kind}'`,
      );
    }
    const valueCols = schema.slice(1);
    return new TimeSeries({
      name: options.name ?? 'points',
      schema,
      rows: points.map(
        (p) =>
          [
            p.ts,
            ...valueCols.map((col) => p[col.name] as ScalarValue | undefined),
          ] as unknown,
      ) as unknown as TimeSeriesInput<S>['rows'],
    });
  }
}

function aggregateInternal<S extends SeriesSchema>(
  series: TimeSeries<S>,
  sequence: SequenceLike,
  mapping: AggregateMap<S> | AggregateOutputMap<S>,
  options: { range?: TemporalLike } = {},
): TimeSeries<SeriesSchema> {
  const range = options.range ?? series.timeRange();
  const aggregateColumns = normalizeAggregateColumns(series.schema, mapping);
  const resultSchema = Object.freeze([
    { name: 'interval', kind: 'interval' as const },
    ...aggregateColumns.map((column) => ({
      name: column.output,
      kind: column.kind,
      required: false as const,
    })),
  ]) as unknown as SeriesSchema;

  if (!range) {
    return new TimeSeries({
      name: series.name,
      schema: resultSchema,
      rows: [],
    });
  }

  const buckets = toBoundedSequence(sequence, range, 'begin').intervals();
  const columns = aggregateColumns;

  if (isTimeKeyed(series)) {
    // Step 3B columnar fast path: when every mapped column is a built-in
    // numeric reducer with a `reduceColumn` kernel over a packed
    // `Float64Column` source, reduce each bucket's contiguous index range
    // off the typed arrays — no `series.events` materialization. Returns
    // null (→ the row path below, unchanged) for any non-qualifying column.
    const columnarRows = tryAggregateColumnarTimeKeyed(
      series.keyColumn().begin,
      (name) => series.column(name as ValueColumnsForSchema<S>[number]['name']),
      buckets,
      columns,
    );
    if (columnarRows !== null) {
      return new TimeSeries({
        name: series.name,
        schema: resultSchema as unknown as SeriesSchema,
        rows: columnarRows as unknown as TimeSeriesInput<SeriesSchema>['rows'],
      });
    }

    const builtInOnly = columns.every((column) =>
      isBuiltInAggregateReducer(column.reducer),
    );
    let eventIndex = 0;
    const resultRows = buckets.map((bucket) => {
      const states = builtInOnly
        ? columns.map((column) =>
            createAggregateBucketState(column.reducer as AggregateFunction),
          )
        : undefined;

      while (
        eventIndex < series.events.length &&
        series.events[eventIndex]!.begin() < bucket.begin()
      ) {
        eventIndex += 1;
      }

      const bucketStart = eventIndex;
      let scanIndex = bucketStart;
      while (
        scanIndex < series.events.length &&
        series.events[scanIndex]!.begin() < bucket.end()
      ) {
        if (states) {
          const data = series.events[scanIndex]!.data();
          for (let index = 0; index < columns.length; index += 1) {
            const column = columns[index]!;
            states[index]!.add(
              data[column.source as keyof typeof data] as
                | ColumnValue
                | undefined,
            );
          }
        }
        scanIndex += 1;
      }

      eventIndex = scanIndex;
      if (states) {
        return Object.freeze([
          bucket,
          ...states.map((state) => state.snapshot()),
        ]);
      }
      const contributors = series.events.slice(bucketStart, scanIndex);
      const aggregated = columns.map((column) => {
        const values = contributors.map((event) => {
          const data = event.data();
          return data[column.source as keyof typeof data];
        }) as ReadonlyArray<ColumnValue | undefined>;
        return applyAggregateReducer(column.reducer, values);
      });
      return Object.freeze([bucket, ...aggregated]);
    });

    return new TimeSeries({
      name: series.name,
      schema: resultSchema as unknown as SeriesSchema,
      rows: resultRows as unknown as TimeSeriesInput<SeriesSchema>['rows'],
    });
  }

  const resultRows = buckets.map((bucket) => {
    const contributors = series.events.filter((event) =>
      bucketOverlapsHalfOpen(bucket, event.key()),
    );
    const aggregated = columns.map((column) => {
      const values = contributors.map((event) => {
        const data = event.data();
        return data[column.source as keyof typeof data];
      }) as ReadonlyArray<ColumnValue | undefined>;
      return applyAggregateReducer(column.reducer, values);
    });
    return Object.freeze([bucket, ...aggregated]);
  });

  return new TimeSeries({
    name: series.name,
    schema: resultSchema,
    rows: resultRows as unknown as TimeSeriesInput<SeriesSchema>['rows'],
  });
}

function alignHoldAt<S extends SeriesSchema>(
  series: TimeSeries<S>,
  t: number,
): EventDataForSchema<S> {
  const event = series.atOrBefore(new Time(t));
  return (event?.data() ?? {}) as EventDataForSchema<S>;
}

function alignLinearAt<S extends SeriesSchema>(
  series: TimeSeries<S>,
  t: number,
  valueColumns: ValueColumnsForSchema<S>,
  cursor?: AlignCursor,
): EventDataForSchema<S> {
  const events = series.events;
  const hasCursor = cursor !== undefined;
  let index = hasCursor ? cursor.index : series.bisect(t);

  if (hasCursor) {
    while (index < events.length && events[index]!.begin() < t) {
      index += 1;
    }
    cursor.index = index;
  }

  if (index < events.length && events[index]!.begin() === t) {
    return events[index]!.data() as EventDataForSchema<S>;
  }

  if (index === 0) {
    return {} as EventDataForSchema<S>;
  }

  const previous = events[index - 1]!;
  const next = events[index];
  if (!next || previous.begin() === next.begin()) {
    return previous.data() as EventDataForSchema<S>;
  }

  const ratio = (t - previous.begin()) / (next.begin() - previous.begin());
  const result: Record<string, unknown> = {};
  const previousData = previous.data();
  const nextData = next.data();

  for (const column of valueColumns) {
    const previousValue =
      previousData[column.name as keyof typeof previousData];
    const nextValue = nextData[column.name as keyof typeof nextData];

    if (
      column.kind === 'number' &&
      typeof previousValue === 'number' &&
      typeof nextValue === 'number'
    ) {
      result[column.name] = previousValue + (nextValue - previousValue) * ratio;
      continue;
    }

    result[column.name] = previousValue;
  }

  return result as EventDataForSchema<S>;
}
