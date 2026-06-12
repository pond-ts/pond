// `@internal` so `stripInternal` drops this re-export from the emitted
// `.d.ts`. The symbol is `@internal` in `series.ts` (stripped from
// `series.d.ts`), so an un-annotated re-export here would dangle —
// `dist/schema/index.d.ts` referencing a name absent from `series.d.ts`,
// which fails strict consumer builds with TS2305 under `skipLibCheck: false`
// (audit v2 §5 F2). Internal live-layer code still imports it from this
// barrel at source-compile time; `stripInternal` only affects `.d.ts` emit.
/** @internal */
export { EMITS_EVICT } from './series.js';
export type {
  AppendColumn,
  ArrayColumnNameForSchema,
  ArrayValue,
  ColumnDef,
  ColumnValue,
  FirstColKind,
  FirstColumn,
  IntervalKeyedSchema,
  KindForValue,
  NormalizedValueForKind,
  NumericColumnNameForSchema,
  OptionalNumberColumn,
  OptionalizeColumn,
  OptionalizeColumns,
  RekeySchema,
  ReplaceColumnKind,
  RowForSchema,
  ScalarKind,
  ScalarValue,
  SeriesSchema,
  TimeKeyedSchema,
  TimeRangeKeyedSchema,
  ValueColumn,
  ValueColumnKindForName,
  ValueColumnNameForSchema,
  ValueColumnsForSchema,
  ValueForKind,
} from './series.js';
export type {
  EventDataForSchema,
  EventForSchema,
  EventKeyForKind,
  EventKeyForSchema,
  LiveSource,
  NormalizedObjectRow,
  NormalizedObjectRowForSchema,
  NormalizedRowForSchema,
  PointRowForSchema,
  TimeSeriesInput,
} from './events.js';
export type {
  JsonIntervalInput,
  JsonObjectRowForSchema,
  JsonRowForSchema,
  JsonRowFormat,
  JsonTimeRangeInput,
  JsonTimestampInput,
  JsonValueForKind,
  TimeSeriesJsonInput,
  TimeSeriesJsonOutputArray,
  TimeSeriesJsonOutputObject,
} from './json.js';
export type {
  AggregateColumns,
  AggregateFunction,
  AggregateMap,
  AggregateOutputMap,
  AggregateOutputMapResultSchema,
  AggregateOutputSpec,
  AggregateReducer,
  AggregateSchema,
  AlignSchema,
  ValidatedAggregateMap,
  ArrayAggregateAppendSchema,
  ArrayAggregateKind,
  ArrayAggregateReplaceSchema,
  ArrayExplodeAppendSchema,
  ArrayExplodeReplaceSchema,
  CustomAggregateReducer,
  MaterializeSchema,
  RollingOutputMapSchema,
} from './aggregate.js';
export type { ReduceResult } from './reduce.js';
export type {
  DurationString,
  FusedMapping,
  FusedMappingElaborated,
  FusedMappingValid,
  FusedMappingValue,
  FusedPartitionedRollingSchema,
  FusedRollingSchema,
  RollingAlignment,
  RollingSchema,
} from './rolling.js';
export type {
  CollapseColumns,
  CollapseData,
  CollapseSchema,
  DedupeKeep,
  FillMapping,
  FillStrategy,
  PivotByGroupSchema,
  RenameData,
  RenameMap,
  RenameSchema,
  SelectData,
  SelectSchema,
} from './reshape.js';
export type {
  BaselineSchema,
  DiffSchema,
  SmoothAppendSchema,
  SmoothMethod,
  SmoothSchema,
} from './diff.js';
export type {
  JoinConflictMode,
  JoinManySchema,
  JoinSchema,
  JoinType,
  PrefixedJoinManySchema,
  PrefixedJoinSchema,
} from './join.js';
