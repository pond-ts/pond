export { BoundedSequence } from './sequence/bounded-sequence.js';
export { Event } from './core/event.js';
export { Interval } from './core/interval.js';
export { LiveAggregation } from './live/live-aggregation.js';
export type { LiveAggregationOptions } from './live/live-aggregation.js';
export {
  LivePartitionedSeries,
  LivePartitionedView,
  type LivePartitionedOptions,
} from './live/live-partitioned-series.js';
export { LiveSeries } from './live/live-series.js';
export { LiveView } from './live/live-view.js';
export type { LiveFillMapping, LiveFillStrategy } from './live/live-view.js';
export { LiveRollingAggregation } from './live/live-rolling-aggregation.js';
export { LiveFusedRolling } from './live/live-fused-rolling.js';
export { LivePartitionedFusedRolling } from './live/live-partitioned-fused-rolling.js';
export { LiveReduce } from './live/live-reduce.js';
export type { SampleStrategy, BatchSampleStrategy } from './sequence/sample.js';
export { Trigger } from './live/triggers.js';
export type {
  ClockTrigger,
  CountTrigger,
  EventTrigger,
} from './live/triggers.js';
export { PartitionedTimeSeries } from './batch/partitioned-time-series.js';
export { Time } from './core/time.js';
export { TimeRange, toTimeRange } from './core/time-range.js';
export { Sequence } from './sequence/sequence.js';
export { TimeSeries, type KeyLike } from './batch/time-series.js';
export { top } from './reducers/index.js';
export { ValidationError } from './core/errors.js';

// ─── Column-centric public API (Phase 4.7 steps 8a + 8b) ────────
//
// Step 8b: side-effect import of `./column-api.js` mounts the
// public methods (min, max, sum, mean, ..., scan-friendly access,
// `at`, `slice`, etc.) onto the substrate column classes via
// prototype augmentation. The augmentation lives outside
// `columnar/` so the substrate stays pure (no reducer dependency
// in `columnar/*.ts`; the `series-store` purity test enforces it).
import './column-api.js';
// Step 8c: re-export the binnedByIndex reducer-name + output type
// helpers so downstream consumers can build typed wrappers (e.g. a
// chart-package `binnedToImage(col, W, 'minMax') => ImageData`
// wrapper that takes the BinnedByIndexOutput<'minMax'> shape
// explicitly without re-deriving the conditional return type).
export type {
  BinnedByIndexOutput,
  BinnedByIndexReducerName,
  PublicColumnForKind,
} from './column-api.js';

// Step 8a: type re-exports. ────────────────────────────────────
//
// Public column types per docs/rfcs/column-api.md (V3, adopted
// 2026-05-27). The substrate classes that back `series.column('x')`
// and `series.keyColumn()` are now part of the public surface.
// Consumers can import them by name (for type annotations and
// `instanceof` checks) rather than reaching into `pond-ts/columnar`
// or eliding the type and relying on TS inference.
//
// What's exposed: the per-kind column classes (Float64Column,
// BooleanColumn, StringColumn, ArrayColumn), the chunked variants
// (ChunkedFloat64Column, etc.) so storage-discriminator narrowing
// works at the consumer call site, the key-column variants
// (TimeKeyColumn, TimeRangeKeyColumn, IntervalKeyColumn), and the
// union/discriminator types (Column, KeyColumn, ColumnKind,
// ColumnStorage, ScanOptions, ValidityBitmap, IntervalLabelKind).
//
// What's NOT exposed (intentionally — still substrate-internal):
// builders, validity helpers, ColumnarStore, view transforms,
// concatSorted, scatterByPartition, ColumnarRingBuffer. These
// remain reachable via internal paths but aren't part of the
// public Column API surface; they may evolve without a major
// version bump.
export {
  type Column,
  type ColumnKind,
  type ColumnStorage,
  type ScanOptions,
  BooleanColumn,
  Float64Column,
} from './columnar/column.js';
export { StringColumn } from './columnar/string-column.js';
export { ArrayColumn } from './columnar/array-column.js';
export {
  ChunkedArrayColumn,
  ChunkedBooleanColumn,
  ChunkedFloat64Column,
  ChunkedStringColumn,
} from './columnar/chunked-column.js';
export {
  type IntervalLabelKind,
  type KeyColumn,
  IntervalKeyColumn,
  TimeKeyColumn,
  TimeRangeKeyColumn,
} from './columnar/key-column.js';
export { type ValidityBitmap } from './columnar/validity.js';
export type {
  AlignSchema,
  ArrayColumnNameForSchema,
  BaselineSchema,
  AggregateFunction,
  AggregateReducer,
  AggregateOutputMap,
  AggregateOutputSpec,
  AggregateMap,
  AggregateSchema,
  ColumnDef,
  CollapseData,
  ArrayAggregateAppendSchema,
  ArrayAggregateKind,
  ArrayAggregateReplaceSchema,
  ArrayExplodeAppendSchema,
  ArrayExplodeReplaceSchema,
  CollapseSchema,
  DedupeKeep,
  EventDataForSchema,
  EventForSchema,
  EventKeyForKind,
  FillMapping,
  FillStrategy,
  MaterializeSchema,
  EventKeyForSchema,
  FirstColKind,
  FirstColumn,
  IntervalKeyedSchema,
  JsonIntervalInput,
  JsonObjectRowForSchema,
  JsonRowFormat,
  JsonRowForSchema,
  JsonTimeRangeInput,
  JsonTimestampInput,
  JsonValueForKind,
  RollingAlignment,
  RollingSchema,
  JoinConflictMode,
  JoinManySchema,
  PrefixedJoinManySchema,
  PrefixedJoinSchema,
  LiveSource,
  JoinType,
  JoinSchema,
  NormalizedRowForSchema,
  NormalizedObjectRowForSchema,
  NormalizedObjectRow,
  NormalizedValueForKind,
  ReduceResult,
  RenameData,
  RenameMap,
  RenameSchema,
  RekeySchema,
  RowForSchema,
  ArrayValue,
  ColumnValue,
  ScalarKind,
  ScalarValue,
  CustomAggregateReducer,
  DiffSchema,
  NumericColumnNameForSchema,
  SmoothMethod,
  SmoothAppendSchema,
  SmoothSchema,
  SelectData,
  SelectSchema,
  SeriesSchema,
  TimeKeyedSchema,
  TimeSeriesInput,
  TimeSeriesJsonInput,
  TimeRangeKeyedSchema,
  ValueColumnsForSchema,
  ValueColumn,
  ValueForKind,
} from './schema/index.js';
export type {
  CalendarOptions,
  CalendarUnit,
  TimeZoneOptions,
} from './core/calendar.js';
export type {
  EventKey,
  IntervalInput,
  IntervalValue,
  TemporalLike,
  TimeRangeInput,
  TimestampInput,
} from './core/temporal.js';
export type { DurationInput } from './core/duration.js';
export type { SequenceSample } from './sequence/sequence.js';
export type {
  LiveSeriesOptions,
  OrderingMode,
  RetentionPolicy,
} from './live/live-series.js';
export type {
  LiveRollingOptions,
  RollingWindow,
} from './live/live-rolling-aggregation.js';
export type {
  DurationString,
  FusedMapping,
  FusedMappingElaborated,
  FusedMappingValue,
  FusedRollingSchema,
  FusedPartitionedRollingSchema,
} from './schema/index.js';
