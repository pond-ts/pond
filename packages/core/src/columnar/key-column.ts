/**
 * Key columns — the axis along which `ColumnarStore` rows are ordered.
 *
 * Three concrete shapes, one per `FirstColumn` kind in `types.ts`:
 *
 * - **`TimeKeyColumn`** (`kind: 'time'`): single `Float64Array` of
 *   millisecond timestamps. `begin` and `end` semantically coincide.
 * - **`TimeRangeKeyColumn`** (`kind: 'timeRange'`): `begin` /
 *   `end` `Float64Array`s representing half-open `[begin, end)` intervals.
 * - **`IntervalKeyColumn`** (`kind: 'interval'`): `begin` / `end`
 *   plus a `StringColumn` of interval labels (typically
 *   dict-encoded for cardinality wins on rolled-up tiles).
 *
 * Each variant exposes `keyAt(i)` which materializes a concrete
 * `Time` / `TimeRange` / `Interval` instance from the underlying
 * buffers, with a lazy per-row cache so repeated reads (operator
 * hot paths, chart hover handlers, `eventAt`) reuse the same
 * `EventKey` reference.
 *
 * Framework-internal; not exported from `packages/core/src/index.ts`.
 */

import { Interval } from '../Interval.js';
import { Time } from '../Time.js';
import { TimeRange } from '../TimeRange.js';
import type { EventKey } from '../temporal.js';
import { StringColumn } from './string-column.js';
import { validateColumnLength } from './validity.js';

/** The framework's key-column discriminated union. */
export type KeyColumn = TimeKeyColumn | TimeRangeKeyColumn | IntervalKeyColumn;

/**
 * Shared interface implemented by every key-column class. Provides
 * row-indexed access to the typed-array buffers and lazy
 * materialization of the concrete `EventKey` instance.
 */
interface KeyColumnBase<K extends EventKey['kind']> {
  readonly kind: K;
  /** Row count. */
  readonly length: number;
  /** Half-open interval start in epoch milliseconds. */
  readonly begin: Float64Array;
  /** Half-open interval end. For `time` keys, equal to `begin`. */
  readonly end: Float64Array;

  /** Direct buffer read: `begin[i]`. */
  beginAt(i: number): number;
  /** Direct buffer read: `end[i]`. */
  endAt(i: number): number;

  /**
   * Returns the concrete `EventKey` instance for row `i`. Lazily
   * constructed on first access and cached via an internal
   * `Map<number, EventKey>` keyed by row index. Subsequent calls
   * return the same reference — pinning `keyAt(i) === keyAt(i)`
   * for the operator hot path.
   *
   * Out-of-range indices throw `RangeError`.
   */
  keyAt(i: number): EventKey;
}

/* -------------------------------------------------------------------------- */
/* TimeKeyColumn — single-buffer point-in-time key.                           */
/* -------------------------------------------------------------------------- */

export class TimeKeyColumn implements KeyColumnBase<'time'> {
  readonly kind = 'time' as const;
  readonly length: number;
  readonly begin: Float64Array;
  /**
   * For `time` keys, `end === begin`. Exposed as a separate field so
   * callers writing generic key code (`endAt(i) - beginAt(i)`) get
   * the right answer (`0` for a point in time).
   */
  readonly end: Float64Array;
  readonly #cache = new Map<number, Time>();

  constructor(begin: Float64Array, length: number) {
    validateColumnLength(length, 'TimeKeyColumn');
    if (length > begin.length) {
      throw new RangeError(
        `TimeKeyColumn buffer underflow: length ${length} exceeds begin.length ${begin.length}`,
      );
    }
    this.length = length;
    this.begin = begin;
    // For time keys, end is the same buffer — same timestamps.
    this.end = begin;
  }

  beginAt(i: number): number {
    if (i < 0 || i >= this.length) {
      throw new RangeError(
        `TimeKeyColumn.beginAt out of range: ${i} not in [0, ${this.length})`,
      );
    }
    return this.begin[i]!;
  }

  endAt(i: number): number {
    return this.beginAt(i);
  }

  keyAt(i: number): Time {
    if (i < 0 || i >= this.length) {
      throw new RangeError(
        `TimeKeyColumn.keyAt out of range: ${i} not in [0, ${this.length})`,
      );
    }
    let cached = this.#cache.get(i);
    if (cached === undefined) {
      cached = new Time(this.begin[i]!);
      this.#cache.set(i, cached);
    }
    return cached;
  }
}

/* -------------------------------------------------------------------------- */
/* TimeRangeKeyColumn — begin + end buffers.                                  */
/* -------------------------------------------------------------------------- */

export class TimeRangeKeyColumn implements KeyColumnBase<'timeRange'> {
  readonly kind = 'timeRange' as const;
  readonly length: number;
  readonly begin: Float64Array;
  readonly end: Float64Array;
  readonly #cache = new Map<number, TimeRange>();

  constructor(begin: Float64Array, end: Float64Array, length: number) {
    validateColumnLength(length, 'TimeRangeKeyColumn');
    if (length > begin.length) {
      throw new RangeError(
        `TimeRangeKeyColumn buffer underflow: length ${length} exceeds begin.length ${begin.length}`,
      );
    }
    if (length > end.length) {
      throw new RangeError(
        `TimeRangeKeyColumn buffer underflow: length ${length} exceeds end.length ${end.length}`,
      );
    }
    this.length = length;
    this.begin = begin;
    this.end = end;
  }

  beginAt(i: number): number {
    if (i < 0 || i >= this.length) {
      throw new RangeError(
        `TimeRangeKeyColumn.beginAt out of range: ${i} not in [0, ${this.length})`,
      );
    }
    return this.begin[i]!;
  }

  endAt(i: number): number {
    if (i < 0 || i >= this.length) {
      throw new RangeError(
        `TimeRangeKeyColumn.endAt out of range: ${i} not in [0, ${this.length})`,
      );
    }
    return this.end[i]!;
  }

  keyAt(i: number): TimeRange {
    if (i < 0 || i >= this.length) {
      throw new RangeError(
        `TimeRangeKeyColumn.keyAt out of range: ${i} not in [0, ${this.length})`,
      );
    }
    let cached = this.#cache.get(i);
    if (cached === undefined) {
      cached = new TimeRange({ start: this.begin[i]!, end: this.end[i]! });
      this.#cache.set(i, cached);
    }
    return cached;
  }
}

/* -------------------------------------------------------------------------- */
/* IntervalKeyColumn — begin + end + dict-encoded label column.               */
/* -------------------------------------------------------------------------- */

export class IntervalKeyColumn implements KeyColumnBase<'interval'> {
  readonly kind = 'interval' as const;
  readonly length: number;
  readonly begin: Float64Array;
  readonly end: Float64Array;
  /**
   * Interval labels per row. Typically dict-encoded (cardinality is
   * usually small — e.g., `"1d-..."`, `"month-2025-01"`). Stored as
   * a `StringColumn` rather than a raw string array to share the
   * column infrastructure (slicing, validity, dictionary).
   */
  readonly values: StringColumn;
  readonly #cache = new Map<number, Interval>();

  constructor(
    begin: Float64Array,
    end: Float64Array,
    values: StringColumn,
    length: number,
  ) {
    validateColumnLength(length, 'IntervalKeyColumn');
    if (length > begin.length) {
      throw new RangeError(
        `IntervalKeyColumn buffer underflow: length ${length} exceeds begin.length ${begin.length}`,
      );
    }
    if (length > end.length) {
      throw new RangeError(
        `IntervalKeyColumn buffer underflow: length ${length} exceeds end.length ${end.length}`,
      );
    }
    if (values.length !== length) {
      throw new RangeError(
        `IntervalKeyColumn label column length ${values.length} does not match column length ${length}`,
      );
    }
    this.length = length;
    this.begin = begin;
    this.end = end;
    this.values = values;
  }

  beginAt(i: number): number {
    if (i < 0 || i >= this.length) {
      throw new RangeError(
        `IntervalKeyColumn.beginAt out of range: ${i} not in [0, ${this.length})`,
      );
    }
    return this.begin[i]!;
  }

  endAt(i: number): number {
    if (i < 0 || i >= this.length) {
      throw new RangeError(
        `IntervalKeyColumn.endAt out of range: ${i} not in [0, ${this.length})`,
      );
    }
    return this.end[i]!;
  }

  /** Direct label read; may return `undefined` for invalid label rows. */
  labelAt(i: number): string | undefined {
    return this.values.read(i);
  }

  keyAt(i: number): Interval {
    if (i < 0 || i >= this.length) {
      throw new RangeError(
        `IntervalKeyColumn.keyAt out of range: ${i} not in [0, ${this.length})`,
      );
    }
    let cached = this.#cache.get(i);
    if (cached === undefined) {
      const label = this.values.read(i);
      if (label === undefined) {
        throw new Error(
          `IntervalKeyColumn.keyAt: row ${i} has no interval label (validity bit is 0)`,
        );
      }
      cached = new Interval({
        value: label,
        start: this.begin[i]!,
        end: this.end[i]!,
      });
      this.#cache.set(i, cached);
    }
    return cached;
  }
}

/* -------------------------------------------------------------------------- */
/* Convenience factories — assemble key columns from rows / arrays.           */
/* -------------------------------------------------------------------------- */

/**
 * Builds a `TimeKeyColumn` from an array of millisecond timestamps.
 * Length validation runs through the same `MAX_COLUMN_LENGTH` cap as
 * value columns.
 */
export function timeKeyColumnFromArray(
  timestamps: ReadonlyArray<number>,
): TimeKeyColumn {
  const length = timestamps.length;
  validateColumnLength(length, 'TimeKeyColumn');
  const begin = new Float64Array(length);
  for (let i = 0; i < length; i += 1) {
    begin[i] = timestamps[i]!;
  }
  return new TimeKeyColumn(begin, length);
}

/**
 * Builds a `TimeRangeKeyColumn` from `[begin, end]` pairs. Each pair
 * must satisfy `begin <= end`.
 */
export function timeRangeKeyColumnFromPairs(
  pairs: ReadonlyArray<readonly [number, number]>,
): TimeRangeKeyColumn {
  const length = pairs.length;
  validateColumnLength(length, 'TimeRangeKeyColumn');
  const begin = new Float64Array(length);
  const end = new Float64Array(length);
  for (let i = 0; i < length; i += 1) {
    const [b, e] = pairs[i]!;
    if (b > e) {
      throw new RangeError(
        `TimeRangeKeyColumn: pair ${i} has begin ${b} > end ${e}`,
      );
    }
    begin[i] = b;
    end[i] = e;
  }
  return new TimeRangeKeyColumn(begin, end, length);
}
