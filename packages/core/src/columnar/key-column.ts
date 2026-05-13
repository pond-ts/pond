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
 *   plus a label column. Labels follow the public `IntervalValue`
 *   contract (`string | number`); the label column is
 *   discriminated by `labelKind`:
 *   - `labelKind: 'string'` → `labels: StringColumn` (typically
 *     dict-encoded for cardinality wins on rolled-up tiles).
 *   - `labelKind: 'number'` → `labels: Float64Column` (the
 *     `Sequence` / numeric-tag pattern).
 *
 *   `keyAt(i)` materializes `Interval` instances with the
 *   original-typed label, so `Interval.equals` /
 *   `compareIntervalValues` semantics round-trip unchanged.
 *
 * Each variant exposes `keyAt(i)` which materializes a concrete
 * `Time` / `TimeRange` / `Interval` instance from the underlying
 * buffers, with a lazy per-row cache so repeated reads (operator
 * hot paths, chart hover handlers, `eventAt`) reuse the same
 * `EventKey` reference.
 *
 * **Buffer-immutability contract.** The `begin` / `end` typed arrays
 * and the `values` `StringColumn` are treated as immutable after
 * construction. Mutating them externally (e.g., writing into
 * `column.begin[i]` directly) is a contract violation: the cache
 * keyed by row index will not invalidate, so subsequent `keyAt(i)`
 * calls return the stale `EventKey` instance. The framework's
 * intake paths and copy-on-write slice operations honor this
 * contract; consumers must too.
 *
 * **Cache growth.** The `Map<number, EventKey>` cache is
 * unbounded; access patterns that touch every row materialize one
 * `EventKey` per row. For typical operator workloads this is
 * negligible, but high-row-count cold-start access (1M+ rows
 * traversed once) accumulates the cache for the column's lifetime.
 * TODO (step 2 / TimeSeries integration): consider a wrapping
 * `ColumnarStore` layer that bounds the cache or wires it through
 * a shared budget, if benches show this is a real cost.
 *
 * Framework-internal; not exported from `packages/core/src/index.ts`.
 */

import { Interval } from '../Interval.js';
import { Time } from '../Time.js';
import { TimeRange } from '../TimeRange.js';
import type { EventKey, IntervalValue } from '../temporal.js';
import { Float64Column } from './column.js';
import { StringColumn } from './string-column.js';
import { validateColumnLength } from './validity.js';

/** The framework's key-column discriminated union. */
export type KeyColumn = TimeKeyColumn | TimeRangeKeyColumn | IntervalKeyColumn;

/**
 * Shared eager validation that every active timestamp slot is a
 * finite number. The `Time` / `TimeRange` / `Interval` concrete
 * classes reject non-finite timestamps via `normalizeTimestamp`;
 * the key-column primitives must reject them at construction time
 * too — otherwise `NaN` bypasses the `begin <= end` check and
 * `Infinity` feeds bogus values into ordering / range logic before
 * the (deferred) `keyAt` materialization throws.
 */
function assertFiniteTimestamps(
  buffer: Float64Array,
  length: number,
  label: string,
  field: string,
): void {
  for (let i = 0; i < length; i += 1) {
    if (!Number.isFinite(buffer[i]!)) {
      throw new RangeError(
        `${label}: ${field}[${i}] = ${buffer[i]} must be a finite number`,
      );
    }
  }
}

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
    assertFiniteTimestamps(begin, length, 'TimeKeyColumn', 'begin');
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
    assertFiniteTimestamps(begin, length, 'TimeRangeKeyColumn', 'begin');
    assertFiniteTimestamps(end, length, 'TimeRangeKeyColumn', 'end');
    // Eager `begin[i] <= end[i]` validation, matching
    // `timeRangeKeyColumnFromPairs`. Deferring this to `keyAt` time
    // (when `new TimeRange(...)` would otherwise reject the inverted
    // pair) leaves rows that may never be accessed silently malformed
    // and surfaces the error far from the construction site.
    for (let i = 0; i < length; i += 1) {
      if (begin[i]! > end[i]!) {
        throw new RangeError(
          `TimeRangeKeyColumn: row ${i} has begin ${begin[i]} > end ${end[i]}`,
        );
      }
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

/**
 * Discriminated label column for `IntervalKeyColumn`. `string`
 * labels go into a `StringColumn` (typically dict-encoded);
 * `number` labels go into a `Float64Column`. The discriminator
 * lets `keyAt` materialize `Interval` instances with the original
 * `IntervalValue` type intact — no implicit `1` → `'1'`
 * stringification, no `compareIntervalValues` semantic drift.
 */
export type IntervalLabelKind = 'string' | 'number';

export class IntervalKeyColumn implements KeyColumnBase<'interval'> {
  readonly kind = 'interval' as const;
  readonly length: number;
  readonly begin: Float64Array;
  readonly end: Float64Array;
  /**
   * Discriminator for the `labels` column. Lets consumers narrow on
   * the typed label representation without an instanceof check.
   */
  readonly labelKind: IntervalLabelKind;
  /**
   * Interval labels per row. The column type is discriminated by
   * `labelKind`. Both representations share the column-infrastructure
   * benefits (validity, slicing, dictionary for strings).
   */
  readonly labels: StringColumn | Float64Column;
  readonly #cache = new Map<number, Interval>();

  constructor(
    begin: Float64Array,
    end: Float64Array,
    labels: StringColumn | Float64Column,
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
    if (labels.length !== length) {
      throw new RangeError(
        `IntervalKeyColumn label column length ${labels.length} does not match column length ${length}`,
      );
    }
    assertFiniteTimestamps(begin, length, 'IntervalKeyColumn', 'begin');
    assertFiniteTimestamps(end, length, 'IntervalKeyColumn', 'end');
    // Eager `begin[i] <= end[i]` validation — same rationale as
    // `TimeRangeKeyColumn`.
    for (let i = 0; i < length; i += 1) {
      if (begin[i]! > end[i]!) {
        throw new RangeError(
          `IntervalKeyColumn: row ${i} has begin ${begin[i]} > end ${end[i]}`,
        );
      }
    }
    // **Discriminate the label column by `kind` exactly.** TypeScript
    // accepts the `StringColumn | Float64Column` parameter, but at
    // runtime a caller can pass anything via a cast — a `BooleanColumn`,
    // an `ArrayColumn`, or a future custom column. The else-branch
    // "everything not string is number" classifier would silently
    // accept those and advertise `labelKind: 'number'`, corrupting
    // any downstream code that branches on the discriminator.
    let labelKind: IntervalLabelKind;
    if (labels.kind === 'string') {
      labelKind = 'string';
    } else if (labels.kind === 'number') {
      labelKind = 'number';
    } else {
      throw new TypeError(
        `IntervalKeyColumn: labels must be a StringColumn ('string') or Float64Column ('number'); got kind '${(labels as { kind: string }).kind}'`,
      );
    }
    // Every row must have a defined label that matches the
    // discriminator. The label-defined check covers validity (Codex
    // round 1); the type + finite check covers the round-3 hole.
    for (let i = 0; i < length; i += 1) {
      const label = labels.read(i);
      if (label === undefined) {
        throw new RangeError(
          `IntervalKeyColumn: row ${i} has no label (labels column marks it as undefined); every interval row must carry a label`,
        );
      }
      if (labelKind === 'string') {
        if (typeof label !== 'string') {
          throw new TypeError(
            `IntervalKeyColumn: row ${i} label is not a string despite labelKind='string' (got ${typeof label}); reject cast-bypass at the boundary`,
          );
        }
      } else {
        if (typeof label !== 'number' || !Number.isFinite(label)) {
          throw new RangeError(
            `IntervalKeyColumn: row ${i} numeric label ${label} is not a finite number; numeric interval labels must be finite for ordering semantics`,
          );
        }
      }
    }
    this.length = length;
    this.begin = begin;
    this.end = end;
    this.labels = labels;
    this.labelKind = labelKind;
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

  /**
   * Direct label read; returns `string | number` per `IntervalValue`,
   * preserving the original type. May return `undefined` only if a
   * caller bypassed the constructor invariant by mutating the label
   * column post-construction (a documented contract violation).
   */
  labelAt(i: number): IntervalValue | undefined {
    return this.labels.read(i);
  }

  keyAt(i: number): Interval {
    if (i < 0 || i >= this.length) {
      throw new RangeError(
        `IntervalKeyColumn.keyAt out of range: ${i} not in [0, ${this.length})`,
      );
    }
    let cached = this.#cache.get(i);
    if (cached === undefined) {
      const label = this.labels.read(i);
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
