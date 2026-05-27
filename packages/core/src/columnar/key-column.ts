/**
 * Key columns — the axis along which `ColumnarStore` rows are ordered.
 *
 * Three concrete shapes, matching the three pond-ts key kinds at the
 * row-API layer but exposing only typed-buffer access here. The
 * framework treats keys as **pure indexed numeric data**; concrete
 * `EventKey` materialization (`Time` / `TimeRange` / `Interval`
 * instances) lives in the row-API adapter layer
 * (`packages/core/src/series-store.ts`), not in the framework.
 *
 * - **`TimeKeyColumn`** (`kind: 'time'`): single `Float64Array` of
 *   millisecond timestamps. `begin` and `end` semantically coincide
 *   (same buffer reference).
 * - **`TimeRangeKeyColumn`** (`kind: 'timeRange'`): `begin` / `end`
 *   `Float64Array`s representing half-open `[begin, end)` intervals.
 * - **`IntervalKeyColumn`** (`kind: 'interval'`): `begin` / `end`
 *   plus a label column. The label column is discriminated by
 *   `labelKind`:
 *   - `labelKind: 'string'` → `labels: StringColumn` (typically
 *     dict-encoded for cardinality wins on rolled-up tiles).
 *   - `labelKind: 'number'` → `labels: Float64Column` (the numeric-
 *     tag pattern used by some producers).
 *
 * **Buffer-immutability contract.** The `begin` / `end` typed arrays
 * and the `labels` column are treated as immutable after
 * construction. Mutating them externally (`column.begin[i] = ...`)
 * is a contract violation; the framework intake paths and
 * copy-on-write slice operations honor this, and consumers must
 * too.
 *
 * Framework-internal; not exported from `packages/core/src/index.ts`.
 */

import { Float64Column } from './column.js';
import { StringColumn } from './string-column.js';
import { validateColumnLength } from './validity.js';

/** The framework's key-column discriminated union. */
export type KeyColumn = TimeKeyColumn | TimeRangeKeyColumn | IntervalKeyColumn;

/**
 * Shared eager validation that every active timestamp slot is a
 * finite number. The row-API layer's `Time` / `TimeRange` /
 * `Interval` constructors reject non-finite timestamps via
 * `normalizeTimestamp`; the columnar substrate enforces the same
 * invariant at the buffer level so `NaN` / `Infinity` can't slip
 * past the inverted-pair check or feed bogus values to ordering /
 * range logic.
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
 * Shared interface implemented by every key-column class. Pure
 * indexed buffer access; the framework knows nothing about
 * `EventKey` / `Time` / `TimeRange` / `Interval`.
 */
interface KeyColumnBase<K extends 'time' | 'timeRange' | 'interval'> {
  readonly kind: K;
  /** Row count. */
  readonly length: number;
  /** Half-open interval start in epoch milliseconds. */
  readonly begin: Float64Array;
  /** Half-open interval end. For `time` keys, equal to `begin`. */
  readonly end: Float64Array;

  /** Direct buffer read: `begin[i]`. Throws on out-of-range. */
  beginAt(i: number): number;
  /** Direct buffer read: `end[i]`. Throws on out-of-range. */
  endAt(i: number): number;
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

  /**
   * Zero-copy index-range view: returns a `TimeKeyColumn` over
   * `begin.subarray(start, end)`. Same trusted-buffer-immutability
   * contract as the source — the underlying `Float64Array` is
   * shared. `start` clamps to `[0, length]`; `end` clamps to
   * `[start, length]`. Empty range produces a `length: 0` column.
   *
   * Mirrors `Float64Column.sliceByRange` in shape and semantics so
   * `series.column('x').slice(s, e)` and
   * `series.keyColumn().slice(s, e)` compose with the same
   * boundary handling.
   */
  sliceByRange(start: number, end: number): TimeKeyColumn {
    const s = Math.max(0, Math.min(start | 0, this.length));
    const e = Math.max(s, Math.min(end | 0, this.length));
    return new TimeKeyColumn(this.begin.subarray(s, e), e - s);
  }

  /**
   * Gathers rows by index into a new `TimeKeyColumn`. Out-of-range
   * source indices produce a `0` slot in the output buffer — the
   * caller is responsible for ensuring `indices` are valid (typically
   * from a prior filter / range-query that returned source-row
   * indices).
   */
  sliceByIndices(indices: Int32Array): TimeKeyColumn {
    const outLength = indices.length;
    const out = new Float64Array(outLength);
    for (let i = 0; i < outLength; i += 1) {
      const idx = indices[i]!;
      out[i] = idx >= 0 && idx < this.length ? this.begin[idx]! : 0;
    }
    return new TimeKeyColumn(out, outLength);
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

  /**
   * Zero-copy index-range view: returns a `TimeRangeKeyColumn` over
   * `begin.subarray(s, e)` + `end.subarray(s, e)`. Same trusted-
   * buffer-immutability contract as the source.
   *
   * Note on max-end: the range-key invariant says `begin[i] <=
   * end[i]` per row, NOT that `end[i]` is monotonically increasing.
   * A long early event can extend past the final row's end. The
   * slice preserves this — `out.end[length - 1]` is the end of the
   * final row in the slice, NOT the maximum end across the slice.
   * See RFC §4 close-cases for why range-key max-end is deferred.
   */
  sliceByRange(start: number, end: number): TimeRangeKeyColumn {
    const s = Math.max(0, Math.min(start | 0, this.length));
    const e = Math.max(s, Math.min(end | 0, this.length));
    return new TimeRangeKeyColumn(
      this.begin.subarray(s, e),
      this.end.subarray(s, e),
      e - s,
    );
  }

  /**
   * Gathers rows by index into a new `TimeRangeKeyColumn`. See
   * `TimeKeyColumn.sliceByIndices` for the out-of-range semantics.
   */
  sliceByIndices(indices: Int32Array): TimeRangeKeyColumn {
    const outLength = indices.length;
    const outBegin = new Float64Array(outLength);
    const outEnd = new Float64Array(outLength);
    for (let i = 0; i < outLength; i += 1) {
      const idx = indices[i]!;
      if (idx >= 0 && idx < this.length) {
        outBegin[i] = this.begin[idx]!;
        outEnd[i] = this.end[idx]!;
      }
    }
    return new TimeRangeKeyColumn(outBegin, outEnd, outLength);
  }
}

/* -------------------------------------------------------------------------- */
/* IntervalKeyColumn — begin + end + dict-encoded label column.               */
/* -------------------------------------------------------------------------- */

/**
 * Discriminated label storage for `IntervalKeyColumn`. `'string'`
 * labels go into a `StringColumn` (typically dict-encoded);
 * `'number'` labels go into a `Float64Column`. The discriminator
 * lets row-API consumers materialize labels with the correct type
 * (preserving `string | number` `IntervalValue` semantics) without
 * an instanceof check.
 */
export type IntervalLabelKind = 'string' | 'number';

export class IntervalKeyColumn implements KeyColumnBase<'interval'> {
  readonly kind = 'interval' as const;
  readonly length: number;
  readonly begin: Float64Array;
  readonly end: Float64Array;
  readonly labelKind: IntervalLabelKind;
  readonly labels: StringColumn | Float64Column;

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
    // Discriminate the label column by `kind` exactly. TypeScript
    // accepts the `StringColumn | Float64Column` parameter, but at
    // runtime a caller can pass anything via a cast — a
    // `BooleanColumn`, an `ArrayColumn`, or a future custom column.
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
    // discriminator. The label-defined check covers validity; the
    // type + finite check covers cast-bypass and `NaN`-label holes.
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
            `IntervalKeyColumn: row ${i} label is not a string despite labelKind='string' (got ${typeof label})`,
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
   * Direct label read. Returns the underlying `string | number`
   * value per the label-column kind, or `undefined` only if a
   * caller violated the buffer-immutability contract.
   */
  labelAt(i: number): string | number | undefined {
    return this.labels.read(i);
  }

  /**
   * Zero-copy index-range view: returns an `IntervalKeyColumn` over
   * `begin.subarray(s, e)`, `end.subarray(s, e)`, and the labels
   * column's `sliceByRange(s, e)` (string-dict shared by reference;
   * numeric-label buffer subarrayed). Same trusted-buffer-
   * immutability contract as the source.
   *
   * Same caveat as `TimeRangeKeyColumn.sliceByRange` for max-end:
   * the slice preserves per-row `begin[i] <= end[i]` but does NOT
   * compute the maximum end across the slice (which may exceed
   * `end[length - 1]`).
   */
  sliceByRange(start: number, end: number): IntervalKeyColumn {
    const s = Math.max(0, Math.min(start | 0, this.length));
    const e = Math.max(s, Math.min(end | 0, this.length));
    const slicedLabels = this.labels.sliceByRange(s, e);
    return new IntervalKeyColumn(
      this.begin.subarray(s, e),
      this.end.subarray(s, e),
      slicedLabels as StringColumn | Float64Column,
      e - s,
    );
  }

  /**
   * Gathers rows by index into a new `IntervalKeyColumn`. The label
   * column is `sliceByIndices`'d as well — for string labels the
   * dictionary is shared by reference (cheap), for numeric labels
   * the buffer is materialized via `Float64Column.sliceByIndices`.
   *
   * Out-of-range source indices would produce undefined labels in
   * the output column; the constructor's label-defined check then
   * rejects them. Callers must therefore ensure `indices` covers
   * only valid source rows.
   */
  sliceByIndices(indices: Int32Array): IntervalKeyColumn {
    const outLength = indices.length;
    const outBegin = new Float64Array(outLength);
    const outEnd = new Float64Array(outLength);
    for (let i = 0; i < outLength; i += 1) {
      const idx = indices[i]!;
      if (idx >= 0 && idx < this.length) {
        outBegin[i] = this.begin[idx]!;
        outEnd[i] = this.end[idx]!;
      }
    }
    const outLabels = this.labels.sliceByIndices(indices);
    return new IntervalKeyColumn(outBegin, outEnd, outLabels, outLength);
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
