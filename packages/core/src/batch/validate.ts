import { Interval } from '../core/interval.js';
import { Event } from '../core/event.js';
import { Time } from '../core/time.js';
import { TimeRange } from '../core/time-range.js';
import type {
  EventKey,
  IntervalInput,
  TimeRangeInput,
} from '../core/temporal.js';
import {
  type Column,
  type KeyColumn,
  BooleanColumn,
  Float64Column,
  IntervalKeyColumn,
  TimeKeyColumn,
  TimeRangeKeyColumn,
  arrayColumnFromArray,
  bitmapByteCount,
  stringColumnFromArray,
  validityFromBits,
} from '../columnar/index.js';
import { ValidationError } from '../core/errors.js';
import type {
  ArrayValue,
  EventForSchema,
  EventKeyForSchema,
  FirstColKind,
  SeriesSchema,
  TimeSeriesInput,
  ValueForKind,
} from '../schema/index.js';

const FIRST_COLUMN_KINDS: ReadonlySet<FirstColKind> = new Set([
  'time',
  'interval',
  'timeRange',
]);

function assertCellKind(
  kind: string,
  value: unknown,
  row: number,
  col: number,
): void {
  if (value === undefined) {
    return;
  }

  switch (kind) {
    case 'time': {
      const ok =
        value instanceof Time ||
        (value instanceof Date && Number.isFinite(value.getTime())) ||
        (typeof value === 'number' && Number.isFinite(value));
      if (!ok) {
        throw new ValidationError(
          `row ${row} col ${col}: expected time as Time, Date or finite number`,
        );
      }
      return;
    }
    case 'interval': {
      const ok =
        value instanceof Interval ||
        (Array.isArray(value) &&
          value.length === 3 &&
          (typeof value[0] === 'string' || typeof value[0] === 'number')) ||
        (!Array.isArray(value) &&
          typeof value === 'object' &&
          value !== null &&
          'value' in value &&
          'start' in value &&
          'end' in value);
      if (!ok) {
        throw new ValidationError(
          `row ${row} col ${col}: expected interval as Interval or { value, start, end }`,
        );
      }
      return;
    }
    case 'timeRange': {
      const ok =
        value instanceof TimeRange ||
        (Array.isArray(value) && value.length === 2) ||
        (!Array.isArray(value) &&
          typeof value === 'object' &&
          value !== null &&
          'start' in value &&
          'end' in value);
      if (!ok) {
        throw new ValidationError(
          `row ${row} col ${col}: expected timeRange as TimeRange or { start, end }`,
        );
      }
      return;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ValidationError(
          `row ${row} col ${col}: expected finite number`,
        );
      }
      return;
    }
    case 'string': {
      if (typeof value !== 'string') {
        throw new ValidationError(`row ${row} col ${col}: expected string`);
      }
      return;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        throw new ValidationError(`row ${row} col ${col}: expected boolean`);
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        throw new ValidationError(
          `row ${row} col ${col}: expected array of scalars`,
        );
      }
      for (let i = 0; i < value.length; i += 1) {
        const element = value[i];
        const ok =
          (typeof element === 'number' && Number.isFinite(element)) ||
          typeof element === 'string' ||
          typeof element === 'boolean';
        if (!ok) {
          throw new ValidationError(
            `row ${row} col ${col}: array element ${i} must be a finite number, string, or boolean`,
          );
        }
      }
      return;
    }
    default:
      throw new ValidationError(
        `row ${row} col ${col}: unknown kind '${kind}'`,
      );
  }
}

function normalizeKey(
  kind: FirstColKind,
  value: unknown,
  row: number,
  col: number,
): Time | TimeRange | Interval {
  try {
    switch (kind) {
      case 'time':
        return value instanceof Time ? value : new Time(value as number | Date);
      case 'timeRange':
        return value instanceof TimeRange
          ? value
          : new TimeRange(value as TimeRangeInput);
      case 'interval':
        return value instanceof Interval
          ? value
          : new Interval(value as IntervalInput);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid key';
    throw new ValidationError(`row ${row} col ${col}: ${message}`);
  }
}

function compareKeys(left: EventKey, right: EventKey): number {
  if (left.begin() !== right.begin()) {
    return left.begin() - right.begin();
  }
  return left.end() - right.end();
}

export function validateAndNormalize<S extends SeriesSchema>(
  input: TimeSeriesInput<S>,
): EventForSchema<S>[] {
  const { schema, rows } = input;

  if (!schema.length) {
    throw new ValidationError('schema must have at least one column');
  }

  if (!FIRST_COLUMN_KINDS.has(schema[0]!.kind)) {
    throw new ValidationError(
      'first column must be one of: time, interval, timeRange',
    );
  }

  for (let col = 1; col < schema.length; col += 1) {
    const kind = schema[col]!.kind;
    if (
      kind !== 'number' &&
      kind !== 'string' &&
      kind !== 'boolean' &&
      kind !== 'array'
    ) {
      throw new ValidationError(
        `column ${col} has unsupported value kind '${kind}'`,
      );
    }
  }

  const normalized = rows.map((row, rowIndex) => {
    if (row.length !== schema.length) {
      throw new ValidationError(
        `row ${rowIndex} expected ${schema.length} values, got ${row.length}`,
      );
    }

    const keyDef = schema[0]!;
    const rawKey = row[0] as ValueForKind<typeof keyDef.kind>;
    const normalizedKey = normalizeKey(
      keyDef.kind,
      rawKey,
      rowIndex,
      0,
    ) as unknown as EventKeyForSchema<S>;
    const data: Record<string, unknown> = {};

    for (let col = 1; col < schema.length; col += 1) {
      const def = schema[col]!;
      const value = row[col] as ValueForKind<typeof def.kind> | undefined;
      const required = def.required !== false;

      if (value === undefined && required) {
        throw new ValidationError(
          `row ${rowIndex} col ${col} (${def.name}) is required`,
        );
      }

      assertCellKind(def.kind, value, rowIndex, col);
      // Array cells are frozen (after a shallow copy) so downstream consumers
      // can safely treat them as immutable without callers losing control of
      // the input array.
      if (def.kind === 'array' && Array.isArray(value)) {
        data[def.name] = Object.freeze(value.slice());
      } else {
        data[def.name] = value;
      }
    }

    return new Event(normalizedKey, data) as unknown as EventForSchema<S>;
  });

  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1]!;
    const current = normalized[index]!;
    if (compareKeys(previous.key(), current.key()) > 0) {
      throw new ValidationError(`row ${index} is out of order`);
    }
  }

  return Object.freeze(normalized.slice()) as EventForSchema<S>[];
}

/**
 * Column-native intake — walks rows once, writes directly into
 * per-column typed-array buffers + per-row key buffers, returns
 * the inputs to `ColumnarStore.fromTrustedStore` (key column +
 * value column map). **Skips Event allocation entirely**: the
 * existing `validateAndNormalize` builds N `Event` instances + N
 * frozen data dicts en route to producing the events array; this
 * path bypasses both because the columnar substrate doesn't need
 * row-shaped objects.
 *
 * **Same validation rules** as `validateAndNormalize`:
 * - First-column-kind allowlist (`time` / `timeRange` / `interval`)
 * - Value-column kind allowlist (`number` / `boolean` / `string` /
 *   `array`)
 * - Per-row length check
 * - Per-cell kind assertion (defined cells must match the
 *   declared kind; finite numbers / typed strings / well-formed
 *   intervals / shape-validated arrays)
 * - Required-field check (defaults to `required: true`)
 * - Sort order: rows must be in non-decreasing key order by
 *   `(begin, end)` (interval label is NOT part of the sort key,
 *   matching the existing `compareKeys`)
 * - Interval label-kind consistency: every row's interval label
 *   must share the kind (string vs number) of the first row's
 *   label
 *
 * **Optimization for sub-step 2c.** On a 100k-row schema with two
 * value columns, the existing `validateAndNormalize` + the column
 * builder loop in `buildSeriesStoreFromEvents` totaled ~20 ms vs
 * the pre-2a row-array baseline's ~14 ms. The bulk of the
 * remaining cost was Event + data-dict allocation. This function
 * removes both. Events lazy-materialize on first
 * `SeriesStore.eventAt(i)` call via the existing per-row cache
 * mechanism — preserving the identity invariant `eventAt(i) ===
 * eventAt(i)` for the store's lifetime.
 */
export function validateAndNormalizeColumnar<S extends SeriesSchema>(
  input: TimeSeriesInput<S>,
): { keys: KeyColumn; columns: Map<string, Column> } {
  const { schema, rows } = input;
  if (!schema.length) {
    throw new ValidationError('schema must have at least one column');
  }
  const keyKind = schema[0]!.kind as FirstColKind;
  if (!FIRST_COLUMN_KINDS.has(keyKind)) {
    throw new ValidationError(
      'first column must be one of: time, interval, timeRange',
    );
  }
  for (let col = 1; col < schema.length; col += 1) {
    const kind = schema[col]!.kind;
    if (
      kind !== 'number' &&
      kind !== 'string' &&
      kind !== 'boolean' &&
      kind !== 'array'
    ) {
      throw new ValidationError(
        `column ${col} has unsupported value kind '${kind}'`,
      );
    }
  }

  const length = rows.length;

  // Key buffers. `Time` keys share `end === begin` (same reference).
  const beginBuf = new Float64Array(length);
  const endBuf = keyKind === 'time' ? beginBuf : new Float64Array(length);
  const labelArr: Array<string | number> | undefined =
    keyKind === 'interval' ? new Array<string | number>(length) : undefined;
  let labelKind: 'string' | 'number' | undefined;

  // Per-value-column buffers. Allocated up-front sized to N to
  // avoid the growth-and-copy steps the generic ColumnBuilder
  // would otherwise pay.
  const colCount = schema.length - 1;
  const colNames = new Array<string>(colCount);
  const colKinds = new Array<'number' | 'boolean' | 'string' | 'array'>(
    colCount,
  );
  const numberBufs = new Array<Float64Array | null>(colCount);
  const booleanBufs = new Array<Uint8Array | null>(colCount);
  const stringBufs = new Array<Array<string | undefined> | null>(colCount);
  const arrayBufs = new Array<Array<ArrayValue | undefined> | null>(colCount);
  // Lazy validity bitmaps per number/boolean column. Allocated on
  // first missing cell; null until then (the "all defined ⇒ no
  // bitmap" framework convention).
  const validityBits = new Array<Uint8Array | null>(colCount);
  for (let c = 0; c < colCount; c += 1) {
    const def = schema[c + 1]!;
    const kind = def.kind as 'number' | 'boolean' | 'string' | 'array';
    colNames[c] = def.name;
    colKinds[c] = kind;
    numberBufs[c] = kind === 'number' ? new Float64Array(length) : null;
    booleanBufs[c] =
      kind === 'boolean' ? new Uint8Array(bitmapByteCount(length)) : null;
    stringBufs[c] =
      kind === 'string' ? new Array<string | undefined>(length) : null;
    arrayBufs[c] =
      kind === 'array' ? new Array<ArrayValue | undefined>(length) : null;
    validityBits[c] = null;
  }

  for (let i = 0; i < length; i += 1) {
    const row = rows[i] as ReadonlyArray<unknown>;
    if (row.length !== schema.length) {
      throw new ValidationError(
        `row ${i} expected ${schema.length} values, got ${row.length}`,
      );
    }
    // Key normalization. `normalizeKey` still allocates a
    // `Time` / `TimeRange` / `Interval` instance — we discard it
    // after extracting numeric begin/end/label. The class
    // allocation is small (3-4 fields each) and lets us reuse
    // the existing kind-specific input validation rather than
    // duplicating it here. The big-ticket savings (Event + data
    // dict allocations) come from the value-column path below.
    const key = normalizeKey(keyKind, row[0], i, 0);
    beginBuf[i] = key.begin();
    if (endBuf !== beginBuf) endBuf[i] = key.end();
    if (labelArr !== undefined) {
      const label = (key as Interval).value;
      if (labelKind === undefined) {
        labelKind = typeof label === 'string' ? 'string' : 'number';
      } else if (typeof label !== labelKind) {
        // `RangeError` (not `ValidationError`) for parity with the
        // pre-2c throw site at `buildSeriesStoreFromEvents`. Some
        // callers may catch by class name; matching the pre-existing
        // error class avoids a downstream-caller break.
        throw new RangeError(
          `row ${i} has interval label of type ${typeof label} but earlier rows had ${labelKind} labels — interval-keyed series must use one label type throughout`,
        );
      }
      labelArr[i] = label;
    }

    // Value columns — direct per-kind buffer writes with inline
    // validity tracking. The first-missing-cell handler is
    // inlined per kind (rather than via a closure) to avoid
    // allocating one closure per (row, column) on the hot path
    // — for N=1M × 2 cols that's 2M short-lived closures.
    for (let c = 0; c < colCount; c += 1) {
      const def = schema[c + 1]!;
      const value = row[c + 1];
      const required = def.required !== false;
      if (value === undefined && required) {
        throw new ValidationError(
          `row ${i} col ${c + 1} (${def.name}) is required`,
        );
      }
      assertCellKind(def.kind, value, i, c + 1);
      switch (colKinds[c]) {
        case 'number': {
          const buf = numberBufs[c]!;
          if (typeof value === 'number') {
            buf[i] = value;
            const bits = validityBits[c];
            // Validity bitmap exists ⇒ this row's bit needs setting
            // (the bitmap covers every defined cell). No bitmap yet
            // ⇒ every prior row has been defined, no back-fill needed.
            if (bits !== null && bits !== undefined)
              bits[i >> 3]! |= 1 << (i & 7);
          } else {
            // First missing cell at column `c` ⇒ allocate the
            // validity bitmap (lazy) + back-fill bits for the
            // previously-defined rows `[0, i)`. Subsequent missing
            // cells skip the alloc + back-fill (bitmap already
            // exists), leaving the bit cleared which is the
            // missing-cell signal.
            let bits = validityBits[c] ?? null;
            if (bits === null) {
              bits = new Uint8Array(bitmapByteCount(length));
              for (let j = 0; j < i; j += 1) {
                bits[j >> 3]! |= 1 << (j & 7);
              }
              validityBits[c] = bits;
            }
          }
          break;
        }
        case 'boolean': {
          const buf = booleanBufs[c]!;
          if (typeof value === 'boolean') {
            if (value) buf[i >> 3]! |= 1 << (i & 7);
            const bits = validityBits[c];
            if (bits !== null && bits !== undefined)
              bits[i >> 3]! |= 1 << (i & 7);
          } else {
            let bits = validityBits[c] ?? null;
            if (bits === null) {
              bits = new Uint8Array(bitmapByteCount(length));
              for (let j = 0; j < i; j += 1) {
                bits[j >> 3]! |= 1 << (j & 7);
              }
              validityBits[c] = bits;
            }
          }
          break;
        }
        case 'string': {
          const buf = stringBufs[c]!;
          buf[i] = typeof value === 'string' ? value : undefined;
          break;
        }
        case 'array': {
          const buf = arrayBufs[c]!;
          // Defensive shallow freeze, matching `validateAndNormalize`'s
          // post-validation freeze step. Element-wise contract was
          // checked by `assertCellKind` above.
          buf[i] = Array.isArray(value)
            ? (Object.freeze(value.slice()) as ArrayValue)
            : undefined;
          break;
        }
      }
    }
  }

  // Sort order check: rows must be non-decreasing by (begin, end).
  // Lexicographic compare on Float64Array, no key-object
  // allocations during the walk.
  for (let i = 1; i < length; i += 1) {
    const prevBegin = beginBuf[i - 1]!;
    const curBegin = beginBuf[i]!;
    if (prevBegin > curBegin) {
      throw new ValidationError(
        `row ${i} is out of order — keys must be non-decreasing; pass { sort: true } to sort rows on construction, or pre-sort them`,
      );
    }
    if (prevBegin === curBegin && endBuf !== beginBuf) {
      if (endBuf[i - 1]! > endBuf[i]!) {
        throw new ValidationError(
          `row ${i} is out of order — keys must be non-decreasing; pass { sort: true } to sort rows on construction, or pre-sort them`,
        );
      }
    }
  }

  // Build the key column.
  let keys: KeyColumn;
  if (keyKind === 'time') {
    keys = new TimeKeyColumn(beginBuf, length);
  } else if (keyKind === 'timeRange') {
    keys = new TimeRangeKeyColumn(beginBuf, endBuf, length);
  } else {
    // interval
    let labelCol;
    if (labelKind === 'number') {
      const buf = new Float64Array(length);
      for (let i = 0; i < length; i += 1) buf[i] = labelArr![i] as number;
      labelCol = new Float64Column(buf, length);
    } else {
      labelCol = stringColumnFromArray(
        labelArr === undefined ? [] : (labelArr as ReadonlyArray<string>),
        { forceDict: true },
      );
    }
    keys = new IntervalKeyColumn(beginBuf, endBuf, labelCol, length);
  }

  // Build value columns.
  const columns = new Map<string, Column>();
  for (let c = 0; c < colCount; c += 1) {
    const name = colNames[c]!;
    const kind = colKinds[c];
    const bits = validityBits[c] ?? null;
    const validity = bits === null ? undefined : validityFromBits(bits, length);
    let column: Column;
    switch (kind) {
      case 'number':
        column = new Float64Column(numberBufs[c]!, length, validity);
        break;
      case 'boolean':
        column = new BooleanColumn(booleanBufs[c]!, length, validity);
        break;
      case 'string':
        column = stringColumnFromArray(stringBufs[c]!);
        break;
      case 'array':
        column = arrayColumnFromArray(
          arrayBufs[c]! as Parameters<typeof arrayColumnFromArray>[0],
        );
        break;
    }
    columns.set(name, column!);
  }

  return { keys, columns };
}
