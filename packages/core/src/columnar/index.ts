/**
 * Columnar framework — internal barrel export.
 *
 * This module surfaces every primitive that lives under
 * `packages/core/src/columnar/` for use by other parts of pond-ts
 * (`TimeSeries`, `LiveSeries`, reducers, etc.).
 *
 * **Partial public re-export (Phase 4.7 step 8a, 2026-05-27).**
 * A curated subset of the symbols below is re-exported from
 * `packages/core/src/index.ts` per the column-api RFC
 * (`docs/rfcs/column-api.md`). Specifically: the per-kind column
 * classes (`Float64Column`, `BooleanColumn`, `StringColumn`,
 * `ArrayColumn`), the chunked variants, the key-column variants
 * (`TimeKeyColumn`, `TimeRangeKeyColumn`, `IntervalKeyColumn`),
 * and the union/discriminator types (`Column`, `KeyColumn`,
 * `ColumnKind`, `ColumnStorage`, `ScanOptions`,
 * `IntervalLabelKind`, `ValidityBitmap`).
 *
 * The rest stays substrate-internal — builders, validity helpers,
 * `ColumnarStore`, view transforms, `concatSorted`,
 * `scatterByPartition`, `ColumnarRingBuffer`. These can evolve
 * without a major version bump.
 *
 * See `docs/briefs/columnar-framework-design.md` for the full
 * substrate design and `docs/rfcs/column-api.md` for the public
 * Column API contract.
 */

export {
  type ValidityBitmap,
  MAX_COLUMN_LENGTH,
  MutableValidityBitmap,
  bitmapByteCount,
  createValidityBitmap,
  validateColumnLength,
  validityFromBits,
  validityFromPredicate,
  validityGatherByIndices,
  validitySliceByRange,
} from './validity.js';

export {
  type Column,
  type ColumnKind,
  type ColumnStorage,
  type ScanOptions,
  BooleanColumn,
  Float64Column,
  booleanColumnFromArray,
  float64ColumnFromArray,
} from './column.js';

export {
  ChunkedArrayColumn,
  ChunkedBooleanColumn,
  ChunkedFloat64Column,
  ChunkedStringColumn,
  materializeChunkedArray,
  materializeChunkedBoolean,
  materializeChunkedFloat64,
  materializeChunkedString,
} from './chunked-column.js';

export { concatSorted } from './concat.js';

export {
  type ColumnarRingBufferOptions,
  ColumnarRingBuffer,
} from './ring-buffer.js';

export {
  type OnUndefinedPartition,
  type ScatterByPartitionOptions,
  scatterByPartition,
} from './scatter.js';

export {
  DICT_ENCODE_MIN_LENGTH,
  DICT_ENCODE_RATIO,
  StringColumn,
  buildDictionaryIndex,
  estimateDictionaryBytes,
  remapColumnToDictionary,
  remapIndicesToDictionary,
  stringColumnDictEncoded,
  stringColumnFallback,
  stringColumnFromArray,
} from './string-column.js';

export {
  ArrayColumn,
  EMPTY_ARRAY_SENTINEL,
  arrayColumnFromArray,
} from './array-column.js';

export {
  type IntervalLabelKind,
  type KeyColumn,
  IntervalKeyColumn,
  TimeKeyColumn,
  TimeRangeKeyColumn,
  ValueKeyColumn,
  timeKeyColumnFromArray,
  timeRangeKeyColumnFromPairs,
  valueKeyColumnFromArray,
} from './key-column.js';

export { type FromTrustedStoreOptions, ColumnarStore } from './store.js';

export {
  type ColumnBuilder,
  ArrayColumnBuilder,
  BooleanColumnBuilder,
  Float64ColumnBuilder,
  StringColumnBuilder,
  columnBuilderForKind,
} from './builder.js';

export {
  type AnyColumnKind,
  type ArrayValue,
  type ColumnDef,
  type ColumnSchema,
  type KeyKind,
  type ScalarValue,
} from './types.js';

export {
  materialize,
  withColumnAppended,
  withColumnReplaced,
  withColumnsRenamed,
  withColumnsSelected,
  withKeyColumn,
  withRowRange,
  withRowSelection,
} from './view.js';
