/**
 * Column builders — dynamic-append construction for the framework's
 * value-column types.
 *
 * A `ColumnBuilder<T>` accumulates per-row values via `append(value)`
 * (or `appendAt(i, value)` for sparse fill), then materializes into
 * an immutable `Column` via `finalize()`. Used by:
 *
 * - Row-intake factories at the row-API adapter layer
 *   (`SeriesStore.fromValidatedRows`).
 * - `pivotByGroup`-style operators where the column count and
 *   contents aren't known up-front.
 * - The `LiveSeries` numeric ring buffer (sub-step 1h adds a
 *   specialized ring-builder variant).
 *
 * Each builder doubles its underlying capacity on overflow —
 * amortized O(1) per append, matching `Array.push` semantics.
 *
 * Finalization is **one-shot**: subsequent `append` / `appendAt` /
 * `finalize` calls throw, mirroring the
 * `MutableValidityBitmap.freeze` discipline established in 1a.
 *
 * Framework-internal; not exported from `packages/core/src/index.ts`.
 */

import {
  BooleanColumn,
  Float64Column,
  type Column,
  type ColumnKind,
} from './column.js';
import { ArrayColumn, arrayColumnFromArray } from './array-column.js';
import type { ArrayValue, ScalarValue } from './types.js';
import {
  DICT_ENCODE_MIN_LENGTH,
  DICT_ENCODE_RATIO,
  StringColumn,
  stringColumnFromArray,
} from './string-column.js';
import {
  MAX_COLUMN_LENGTH,
  type ValidityBitmap,
  bitmapByteCount,
  validateColumnLength,
  validityFromBits,
} from './validity.js';

/**
 * Shared builder shape. Each value column kind has its own concrete
 * builder; `ColumnBuilder.forKind(kind, capacity)` is the
 * polymorphic factory.
 */
export interface ColumnBuilder<T> {
  readonly kind: ColumnKind;
  readonly length: number;
  readonly consumed: boolean;

  /**
   * Append a value at the next row. `undefined` marks the row as
   * invalid (the framework's validity-bitmap convention).
   */
  append(value: T | undefined): void;

  /**
   * Sparse fill — write a value at an explicit row index. Used by
   * `pivotByGroup` and other reshape operators that fill rows
   * out-of-order. The builder's `length` becomes `max(length,
   * rowIndex + 1)` automatically.
   */
  appendAt(rowIndex: number, value: T | undefined): void;

  /**
   * Materializes the column. One-shot — subsequent `append` /
   * `appendAt` / `finalize` calls throw.
   */
  finalize(): Column;
}

/* -------------------------------------------------------------------------- */
/* Shared base — common length tracking, validity, and consumed semantics.    */
/* -------------------------------------------------------------------------- */

abstract class ColumnBuilderBase<T> implements ColumnBuilder<T> {
  abstract readonly kind: ColumnKind;
  protected _length = 0;
  protected _consumed = false;
  protected _hasInvalid = false;

  get length(): number {
    return this._length;
  }

  get consumed(): boolean {
    return this._consumed;
  }

  protected assertNotConsumed(op: string): void {
    if (this._consumed) {
      throw new Error(
        `ColumnBuilder.${op}: this builder has already been finalized`,
      );
    }
  }

  protected assertValidRowIndex(rowIndex: number): void {
    if (
      !Number.isInteger(rowIndex) ||
      rowIndex < 0 ||
      rowIndex > MAX_COLUMN_LENGTH
    ) {
      throw new RangeError(
        `ColumnBuilder.appendAt: rowIndex ${rowIndex} must be a non-negative integer at most MAX_COLUMN_LENGTH (${MAX_COLUMN_LENGTH})`,
      );
    }
  }

  abstract append(value: T | undefined): void;
  abstract appendAt(rowIndex: number, value: T | undefined): void;
  abstract finalize(): Column;
}

/* -------------------------------------------------------------------------- */
/* Float64ColumnBuilder                                                       */
/* -------------------------------------------------------------------------- */

const MIN_NUMERIC_CAPACITY = 8;

export class Float64ColumnBuilder extends ColumnBuilderBase<number> {
  readonly kind = 'number' as const;
  #values: Float64Array;
  // Bit-packed validity. Mirrors the column shape; same convention
  // (1 = defined, 0 = missing). Lazily allocated — many builders
  // will have every row defined and skip the allocation entirely.
  #validityBits?: Uint8Array;
  #definedCount = 0;

  constructor(initialCapacity = MIN_NUMERIC_CAPACITY) {
    super();
    this.#values = new Float64Array(Math.max(1, initialCapacity));
  }

  append(value: number | undefined): void {
    this.assertNotConsumed('append');
    this.#ensureCapacity(this._length + 1);
    this.#writeAt(this._length, value);
    this._length += 1;
  }

  appendAt(rowIndex: number, value: number | undefined): void {
    this.assertNotConsumed('appendAt');
    this.assertValidRowIndex(rowIndex);
    this.#ensureCapacity(rowIndex + 1);
    // Backfill any gap with explicit invalid cells.
    for (let gap = this._length; gap < rowIndex; gap += 1) {
      this.#writeAt(gap, undefined);
    }
    this.#writeAt(rowIndex, value);
    if (rowIndex + 1 > this._length) this._length = rowIndex + 1;
  }

  finalize(): Float64Column {
    this.assertNotConsumed('finalize');
    this._consumed = true;
    validateColumnLength(this._length, 'Float64ColumnBuilder');
    // Trim to logical length so consumers don't see padding slots.
    const values =
      this._length === this.#values.length
        ? this.#values
        : this.#values.slice(0, this._length);
    let validity: ValidityBitmap | undefined;
    if (this.#hasInvalidCells()) {
      // Trim the validity bitmap to the exact byte count for the
      // logical length.
      const byteCount = bitmapByteCount(this._length);
      const bits =
        this.#validityBits!.length === byteCount
          ? this.#validityBits!
          : this.#validityBits!.slice(0, byteCount);
      validity = validityFromBits(bits, this._length);
    }
    return new Float64Column(values, this._length, validity);
  }

  #writeAt(rowIndex: number, value: number | undefined): void {
    if (value === undefined) {
      // Lazily allocate validity bitmap on first invalid cell.
      this.#ensureValidityCapacity(rowIndex + 1);
      // Bit stays 0 (invalid); values[rowIndex] is 0 by default.
      this.#values[rowIndex] = 0;
      this._hasInvalid = true;
    } else {
      this.#values[rowIndex] = value;
      // If we have a validity bitmap, mark this cell defined.
      if (this.#validityBits !== undefined) {
        const byte = rowIndex >> 3;
        const mask = 1 << (rowIndex & 7);
        if ((this.#validityBits[byte]! & mask) === 0) {
          this.#validityBits[byte]! |= mask;
          this.#definedCount += 1;
        }
      } else {
        // Implicitly defined.
        this.#definedCount += 1;
      }
    }
  }

  #ensureCapacity(required: number): void {
    if (required <= this.#values.length) return;
    validateColumnLength(required, 'Float64ColumnBuilder');
    let next = this.#values.length;
    while (next < required) next *= 2;
    if (next > MAX_COLUMN_LENGTH) next = MAX_COLUMN_LENGTH;
    const grown = new Float64Array(next);
    grown.set(this.#values);
    this.#values = grown;
    if (this.#validityBits !== undefined) {
      this.#ensureValidityCapacity(required);
    }
  }

  #ensureValidityCapacity(requiredLength: number): void {
    const requiredBytes = bitmapByteCount(requiredLength);
    if (this.#validityBits === undefined) {
      // First invalid cell encountered — backfill: every prior cell
      // is defined (we'd have allocated otherwise).
      const bits = new Uint8Array(
        Math.max(requiredBytes, bitmapByteCount(this.#values.length)),
      );
      for (let i = 0; i < this._length; i += 1) {
        bits[i >> 3]! |= 1 << (i & 7);
      }
      this.#validityBits = bits;
      return;
    }
    if (this.#validityBits.length >= requiredBytes) return;
    let next = this.#validityBits.length;
    while (next < requiredBytes) next *= 2;
    const grown = new Uint8Array(next);
    grown.set(this.#validityBits);
    this.#validityBits = grown;
  }

  #hasInvalidCells(): boolean {
    return this._hasInvalid && this.#definedCount !== this._length;
  }
}

/* -------------------------------------------------------------------------- */
/* BooleanColumnBuilder                                                       */
/* -------------------------------------------------------------------------- */

export class BooleanColumnBuilder extends ColumnBuilderBase<boolean> {
  readonly kind = 'boolean' as const;
  #values: Uint8Array;
  #valuesCapacity: number; // bits, not bytes
  #validityBits?: Uint8Array;
  #definedCount = 0;

  constructor(initialCapacity = MIN_NUMERIC_CAPACITY) {
    super();
    const cap = Math.max(8, initialCapacity);
    this.#values = new Uint8Array(bitmapByteCount(cap));
    this.#valuesCapacity = cap;
  }

  append(value: boolean | undefined): void {
    this.assertNotConsumed('append');
    this.#ensureCapacity(this._length + 1);
    this.#writeAt(this._length, value);
    this._length += 1;
  }

  appendAt(rowIndex: number, value: boolean | undefined): void {
    this.assertNotConsumed('appendAt');
    this.assertValidRowIndex(rowIndex);
    this.#ensureCapacity(rowIndex + 1);
    for (let gap = this._length; gap < rowIndex; gap += 1) {
      this.#writeAt(gap, undefined);
    }
    this.#writeAt(rowIndex, value);
    if (rowIndex + 1 > this._length) this._length = rowIndex + 1;
  }

  finalize(): BooleanColumn {
    this.assertNotConsumed('finalize');
    this._consumed = true;
    validateColumnLength(this._length, 'BooleanColumnBuilder');
    const byteCount = bitmapByteCount(this._length);
    const values =
      this.#values.length === byteCount
        ? this.#values
        : this.#values.slice(0, byteCount);
    let validity: ValidityBitmap | undefined;
    if (this._hasInvalid && this.#definedCount !== this._length) {
      const validityBytes = bitmapByteCount(this._length);
      const bits =
        this.#validityBits!.length === validityBytes
          ? this.#validityBits!
          : this.#validityBits!.slice(0, validityBytes);
      validity = validityFromBits(bits, this._length);
    }
    return new BooleanColumn(values, this._length, validity);
  }

  #writeAt(rowIndex: number, value: boolean | undefined): void {
    const byte = rowIndex >> 3;
    const mask = 1 << (rowIndex & 7);
    if (value === undefined) {
      this.#ensureValidityCapacity(rowIndex + 1);
      // Clear the value bit (sentinel for invalid cells).
      this.#values[byte]! &= ~mask;
      this._hasInvalid = true;
    } else {
      if (value) {
        this.#values[byte]! |= mask;
      } else {
        this.#values[byte]! &= ~mask;
      }
      if (this.#validityBits !== undefined) {
        if ((this.#validityBits[byte]! & mask) === 0) {
          this.#validityBits[byte]! |= mask;
          this.#definedCount += 1;
        }
      } else {
        this.#definedCount += 1;
      }
    }
  }

  #ensureCapacity(requiredLength: number): void {
    if (requiredLength <= this.#valuesCapacity) return;
    validateColumnLength(requiredLength, 'BooleanColumnBuilder');
    let next = this.#valuesCapacity;
    while (next < requiredLength) next *= 2;
    if (next > MAX_COLUMN_LENGTH) next = MAX_COLUMN_LENGTH;
    const grownBytes = bitmapByteCount(next);
    const grown = new Uint8Array(grownBytes);
    grown.set(this.#values);
    this.#values = grown;
    this.#valuesCapacity = next;
    if (this.#validityBits !== undefined) {
      this.#ensureValidityCapacity(requiredLength);
    }
  }

  #ensureValidityCapacity(requiredLength: number): void {
    const requiredBytes = bitmapByteCount(requiredLength);
    if (this.#validityBits === undefined) {
      // First invalid cell — backfill prior cells as defined.
      const bits = new Uint8Array(
        Math.max(requiredBytes, bitmapByteCount(this.#valuesCapacity)),
      );
      for (let i = 0; i < this._length; i += 1) {
        bits[i >> 3]! |= 1 << (i & 7);
      }
      this.#validityBits = bits;
      return;
    }
    if (this.#validityBits.length >= requiredBytes) return;
    let next = this.#validityBits.length;
    while (next < requiredBytes) next *= 2;
    const grown = new Uint8Array(next);
    grown.set(this.#validityBits);
    this.#validityBits = grown;
  }
}

/* -------------------------------------------------------------------------- */
/* StringColumnBuilder                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Accumulates strings into a flat fallback array. At `finalize()`
 * time, decides whether to dict-encode based on the same heuristic
 * as `stringColumnFromArray` (cardinality ratio + minimum length).
 *
 * For very high cardinality + long inputs, callers can force
 * fallback mode via `new StringColumnBuilder({ forceFallback: true })`.
 */
export class StringColumnBuilder extends ColumnBuilderBase<string> {
  readonly kind = 'string' as const;
  #fallback: Array<string | undefined>;
  readonly #forceDict: boolean;
  readonly #forceFallback: boolean;
  readonly #dictRatio: number;
  readonly #minDictLength: number;

  constructor(options?: {
    initialCapacity?: number;
    forceDict?: boolean;
    forceFallback?: boolean;
    dictRatio?: number;
    minDictLength?: number;
  }) {
    super();
    const cap = options?.initialCapacity ?? MIN_NUMERIC_CAPACITY;
    this.#fallback = new Array<string | undefined>(Math.max(1, cap));
    if (options?.forceDict && options?.forceFallback) {
      throw new Error(
        'StringColumnBuilder: forceDict and forceFallback are mutually exclusive',
      );
    }
    this.#forceDict = options?.forceDict === true;
    this.#forceFallback = options?.forceFallback === true;
    this.#dictRatio = options?.dictRatio ?? DICT_ENCODE_RATIO;
    this.#minDictLength = options?.minDictLength ?? DICT_ENCODE_MIN_LENGTH;
  }

  append(value: string | undefined): void {
    this.assertNotConsumed('append');
    this.#ensureCapacity(this._length + 1);
    if (value === undefined) {
      this.#fallback[this._length] = undefined;
      this._hasInvalid = true;
    } else {
      this.#fallback[this._length] = value;
    }
    this._length += 1;
  }

  appendAt(rowIndex: number, value: string | undefined): void {
    this.assertNotConsumed('appendAt');
    this.assertValidRowIndex(rowIndex);
    this.#ensureCapacity(rowIndex + 1);
    // Pad gaps with undefined (sparse fill).
    while (this._length < rowIndex) {
      this.#fallback[this._length] = undefined;
      this._hasInvalid = true;
      this._length += 1;
    }
    if (value === undefined) {
      this.#fallback[rowIndex] = undefined;
      this._hasInvalid = true;
    } else {
      this.#fallback[rowIndex] = value;
    }
    if (rowIndex + 1 > this._length) this._length = rowIndex + 1;
  }

  finalize(): StringColumn {
    this.assertNotConsumed('finalize');
    this._consumed = true;
    validateColumnLength(this._length, 'StringColumnBuilder');
    // Trim to logical length.
    const source =
      this.#fallback.length === this._length
        ? this.#fallback
        : this.#fallback.slice(0, this._length);
    return this.#buildColumn(source);
  }

  #buildColumn(source: ReadonlyArray<string | undefined>): StringColumn {
    // Lean on the existing `stringColumnFromArray` heuristic and
    // options surface to avoid duplicating dict-vs-fallback logic.
    const opts: Parameters<typeof stringColumnFromArray>[1] = {
      dictRatio: this.#dictRatio,
      minDictLength: this.#minDictLength,
    };
    if (this.#forceDict) opts.forceDict = true;
    if (this.#forceFallback) opts.forceFallback = true;
    return stringColumnFromArray(source, opts);
  }

  #ensureCapacity(required: number): void {
    if (required <= this.#fallback.length) return;
    validateColumnLength(required, 'StringColumnBuilder');
    let next = this.#fallback.length;
    while (next < required) next *= 2;
    if (next > MAX_COLUMN_LENGTH) next = MAX_COLUMN_LENGTH;
    this.#fallback.length = next;
  }
}

/* -------------------------------------------------------------------------- */
/* ArrayColumnBuilder                                                         */
/* -------------------------------------------------------------------------- */

export class ArrayColumnBuilder extends ColumnBuilderBase<ArrayValue> {
  readonly kind = 'array' as const;
  #fallback: Array<ArrayValue | undefined>;

  constructor(initialCapacity = MIN_NUMERIC_CAPACITY) {
    super();
    this.#fallback = new Array<ArrayValue | undefined>(
      Math.max(1, initialCapacity),
    );
  }

  append(value: ArrayValue | undefined): void {
    this.assertNotConsumed('append');
    this.#ensureCapacity(this._length + 1);
    // Defensively copy at append time. The source array may be mutated
    // by the caller before finalize() runs; the builder needs to be
    // immune to that. `arrayColumnFromArray` (called from finalize)
    // does a second defensive copy at column-construction time, but
    // by then the values are already snapshot.
    if (value === undefined) {
      this.#fallback[this._length] = undefined;
      this._hasInvalid = true;
    } else {
      this.#fallback[this._length] = value.slice() as ArrayValue;
    }
    this._length += 1;
  }

  appendAt(rowIndex: number, value: ArrayValue | undefined): void {
    this.assertNotConsumed('appendAt');
    this.assertValidRowIndex(rowIndex);
    this.#ensureCapacity(rowIndex + 1);
    while (this._length < rowIndex) {
      this.#fallback[this._length] = undefined;
      this._hasInvalid = true;
      this._length += 1;
    }
    if (value === undefined) {
      this.#fallback[rowIndex] = undefined;
      this._hasInvalid = true;
    } else {
      this.#fallback[rowIndex] = value.slice() as ArrayValue;
    }
    if (rowIndex + 1 > this._length) this._length = rowIndex + 1;
  }

  finalize(): ArrayColumn {
    this.assertNotConsumed('finalize');
    this._consumed = true;
    validateColumnLength(this._length, 'ArrayColumnBuilder');
    // Trim to logical length, then defer the dedup + defensive
    // freeze to `arrayColumnFromArray` which already enforces the
    // element-wise `ArrayValue` contract.
    const source =
      this.#fallback.length === this._length
        ? this.#fallback
        : this.#fallback.slice(0, this._length);
    return arrayColumnFromArray(source);
  }

  #ensureCapacity(required: number): void {
    if (required <= this.#fallback.length) return;
    validateColumnLength(required, 'ArrayColumnBuilder');
    let next = this.#fallback.length;
    while (next < required) next *= 2;
    if (next > MAX_COLUMN_LENGTH) next = MAX_COLUMN_LENGTH;
    this.#fallback.length = next;
  }
}

/* -------------------------------------------------------------------------- */
/* Polymorphic factory                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Build a column builder for a given column kind. Returns the
 * appropriate concrete class without exposing it to the caller.
 *
 * `T` is widened to `ScalarValue | ArrayValue` because the
 * polymorphic factory can produce any of the four column kinds.
 * Callers narrow on `builder.kind` to recover the concrete value
 * type.
 */
export function columnBuilderForKind(
  kind: ColumnKind,
  initialCapacity?: number,
): ColumnBuilder<ScalarValue | ArrayValue> {
  switch (kind) {
    case 'number':
      return new Float64ColumnBuilder(initialCapacity) as ColumnBuilder<
        ScalarValue | ArrayValue
      >;
    case 'boolean':
      return new BooleanColumnBuilder(initialCapacity) as ColumnBuilder<
        ScalarValue | ArrayValue
      >;
    case 'string':
      return new StringColumnBuilder({
        ...(initialCapacity !== undefined ? { initialCapacity } : {}),
      }) as ColumnBuilder<ScalarValue | ArrayValue>;
    case 'array':
      return new ArrayColumnBuilder(initialCapacity) as ColumnBuilder<
        ScalarValue | ArrayValue
      >;
    default:
      throw new TypeError(
        `columnBuilderForKind: unknown column kind '${kind as string}'`,
      );
  }
}
