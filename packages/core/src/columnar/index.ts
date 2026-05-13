/**
 * Columnar framework — internal barrel export.
 *
 * This module surfaces every primitive that lives under
 * `packages/core/src/columnar/` for use by other parts of pond-ts
 * (`TimeSeries`, `LiveSeries`, reducers, etc.). **It is not
 * re-exported from `packages/core/src/index.ts`** — the framework's
 * API surface stays mobile during v1.0 development.
 *
 * See `docs/briefs/columnar-framework-design.md` for the full design.
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
  type ScanOptions,
  BooleanColumn,
  Float64Column,
  booleanColumnFromArray,
  float64ColumnFromArray,
} from './column.js';

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
  timeKeyColumnFromArray,
  timeRangeKeyColumnFromPairs,
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
