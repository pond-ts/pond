/**
 * Columnar value-column primitives.
 *
 * Step 1a scope: number (`Float64Column`) and boolean (`BooleanColumn`)
 * concrete types plus the shared `Column` discriminated union. String
 * (`StringColumn`) and array (`ArrayColumn`) variants land in
 * subsequent sub-steps and extend the same shape.
 *
 * Framework-internal; not exported from `packages/core/src/index.ts`.
 */

import type { ArrayColumn } from './array-column.js';
import type { StringColumn } from './string-column.js';
import {
  type ValidityBitmap,
  bitmapByteCount,
  validateColumnLength,
  validityFromPredicate,
  validityGatherByIndices,
  validitySliceByRange,
} from './validity.js';

/**
 * Discriminator tag for a value column. Step 1a populates `'number'`
 * and `'boolean'`; later sub-steps add `'string'` and `'array'`.
 */
export type ColumnKind = 'number' | 'boolean' | 'string' | 'array';

/**
 * Options controlling `Column.scan`. By default invalid cells are
 * skipped; pass `{ skipInvalid: false }` to receive every slot
 * including those whose validity bit is zero (the value at invalid
 * slots is implementation-defined).
 */
export interface ScanOptions {
  readonly skipInvalid?: boolean;
}

/**
 * Shared interface implemented by every concrete value-column class.
 * `Column` (the union below) is the type external callers use.
 */
interface ColumnBase<T, K extends ColumnKind> {
  readonly kind: K;
  /** Logical row count (number of cells), independent of buffer capacity. */
  readonly length: number;
  /**
   * Optional validity bitmap. Absent ⇒ "every cell is defined." Build
   * code only allocates a bitmap when at least one cell is undefined.
   */
  readonly validity?: ValidityBitmap;

  /** Reads cell `i`. Out-of-range or invalid → `undefined`. */
  read(i: number): T | undefined;

  /**
   * Linear scan with callback. `skipInvalid` defaults to `true`. The
   * callback receives the cell value and the row index; row indices
   * are always relative to this column, not the source it may have
   * been sliced from.
   */
  scan(fn: (value: T, i: number) => void, options?: ScanOptions): void;

  /**
   * Returns a column covering the half-open range `[start, end)`.
   * For `Float64Column` the underlying buffer is a `subarray` view
   * (zero-copy); other column kinds may repack.
   */
  sliceByRange(start: number, end: number): Column;

  /**
   * Returns a column whose row `i` is this column's row `indices[i]`.
   * Always materializes — gather cannot be expressed as a view over a
   * single typed array. For zero-copy index projection at the store
   * level use `withRowSelection` (lands in sub-step 1f).
   */
  sliceByIndices(indices: Int32Array): Column;
}

/**
 * The framework's value-column discriminated union. Narrow on
 * `column.kind` to recover the concrete shape:
 *
 *     if (col.kind === 'number') { col.values; // Float64Array
 *     }
 *
 * All four kinds (`'number'`, `'boolean'`, `'string'`, `'array'`)
 * are now concrete classes after sub-step 1c lands.
 */
export type Column = Float64Column | BooleanColumn | StringColumn | ArrayColumn;

/* -------------------------------------------------------------------------- */
/* Float64Column — packed numeric column.                                     */
/* -------------------------------------------------------------------------- */

/**
 * Numeric value column backed by a `Float64Array`. The values buffer
 * is dense — undefined / missing cells are tracked solely by the
 * `validity` bitmap. Buffer slots corresponding to invalid cells hold
 * an arbitrary value (typically `0`); callers must consult `validity`
 * before treating a slot as meaningful.
 */
export class Float64Column implements ColumnBase<number, 'number'> {
  readonly kind = 'number' as const;
  readonly length: number;
  readonly values: Float64Array;
  readonly validity?: ValidityBitmap;

  constructor(values: Float64Array, length: number, validity?: ValidityBitmap) {
    validateColumnLength(length, 'Float64Column');
    if (length > values.length) {
      throw new RangeError(
        `Float64Column buffer underflow: length ${length} exceeds values.length ${values.length}`,
      );
    }
    if (validity !== undefined && validity.length !== length) {
      throw new RangeError(
        `Float64Column validity length mismatch: column ${length}, validity ${validity.length}`,
      );
    }
    this.values = values;
    this.length = length;
    if (validity !== undefined) this.validity = validity;
  }

  read(i: number): number | undefined {
    if (i < 0 || i >= this.length) return undefined;
    if (this.validity && !this.validity.isDefined(i)) return undefined;
    return this.values[i];
  }

  scan(fn: (value: number, i: number) => void, options?: ScanOptions): void {
    const skipInvalid = options?.skipInvalid ?? true;
    const v = this.validity;
    const values = this.values;
    if (!v) {
      for (let i = 0; i < this.length; i += 1) {
        fn(values[i]!, i);
      }
      return;
    }
    for (let i = 0; i < this.length; i += 1) {
      if (v.isDefined(i)) {
        fn(values[i]!, i);
      } else if (!skipInvalid) {
        fn(values[i]!, i);
      }
    }
  }

  sliceByRange(start: number, end: number): Float64Column {
    const lo = Math.max(0, start);
    const hi = Math.min(this.length, end);
    if (hi <= lo) {
      return new Float64Column(new Float64Array(0), 0);
    }
    const valuesSlice = this.values.subarray(lo, hi);
    const validitySlice = validitySliceByRange(
      this.validity,
      lo,
      hi,
      this.length,
    );
    return new Float64Column(valuesSlice, hi - lo, validitySlice);
  }

  sliceByIndices(indices: Int32Array): Float64Column {
    const out = new Float64Array(indices.length);
    for (let i = 0; i < indices.length; i += 1) {
      const idx = indices[i]!;
      // Out-of-range indices read 0 (the buffer default); validity
      // gather marks those slots invalid below.
      out[i] = idx >= 0 && idx < this.length ? this.values[idx]! : 0;
    }
    const validity = validityGatherByIndices(
      this.validity,
      indices,
      this.length,
    );
    return new Float64Column(out, indices.length, validity);
  }
}

/* -------------------------------------------------------------------------- */
/* BooleanColumn — bit-packed boolean column.                                 */
/* -------------------------------------------------------------------------- */

/**
 * Boolean value column with 1 bit per cell, packed into a
 * `Uint8Array`. The bit layout matches `ValidityBitmap`:
 * `bits[i >> 3] & (1 << (i & 7))`. Validity is tracked separately so
 * `read(i)` distinguishes `false` from `undefined`.
 */
export class BooleanColumn implements ColumnBase<boolean, 'boolean'> {
  readonly kind = 'boolean' as const;
  readonly length: number;
  readonly values: Uint8Array;
  readonly validity?: ValidityBitmap;

  constructor(values: Uint8Array, length: number, validity?: ValidityBitmap) {
    validateColumnLength(length, 'BooleanColumn');
    const requiredBytes = bitmapByteCount(length);
    if (values.length < requiredBytes) {
      throw new RangeError(
        `BooleanColumn buffer underflow: need ${requiredBytes} bytes for length ${length}, got ${values.length}`,
      );
    }
    if (validity !== undefined && validity.length !== length) {
      throw new RangeError(
        `BooleanColumn validity length mismatch: column ${length}, validity ${validity.length}`,
      );
    }
    this.values = values;
    this.length = length;
    if (validity !== undefined) this.validity = validity;
  }

  read(i: number): boolean | undefined {
    if (i < 0 || i >= this.length) return undefined;
    if (this.validity && !this.validity.isDefined(i)) return undefined;
    return (this.values[i >> 3]! & (1 << (i & 7))) !== 0;
  }

  scan(fn: (value: boolean, i: number) => void, options?: ScanOptions): void {
    const skipInvalid = options?.skipInvalid ?? true;
    const v = this.validity;
    const values = this.values;
    if (!v) {
      for (let i = 0; i < this.length; i += 1) {
        fn((values[i >> 3]! & (1 << (i & 7))) !== 0, i);
      }
      return;
    }
    for (let i = 0; i < this.length; i += 1) {
      if (v.isDefined(i)) {
        fn((values[i >> 3]! & (1 << (i & 7))) !== 0, i);
      } else if (!skipInvalid) {
        fn((values[i >> 3]! & (1 << (i & 7))) !== 0, i);
      }
    }
  }

  sliceByRange(start: number, end: number): BooleanColumn {
    const lo = Math.max(0, start);
    const hi = Math.min(this.length, end);
    const outLength = Math.max(0, hi - lo);
    if (outLength === 0) {
      return new BooleanColumn(new Uint8Array(0), 0);
    }
    const bytes = new Uint8Array(bitmapByteCount(outLength));
    for (let i = 0; i < outLength; i += 1) {
      const srcIdx = lo + i;
      if ((this.values[srcIdx >> 3]! & (1 << (srcIdx & 7))) !== 0) {
        bytes[i >> 3]! |= 1 << (i & 7);
      }
    }
    const validity = validitySliceByRange(this.validity, lo, hi, this.length);
    return new BooleanColumn(bytes, outLength, validity);
  }

  sliceByIndices(indices: Int32Array): BooleanColumn {
    const outLength = indices.length;
    const bytes = new Uint8Array(bitmapByteCount(outLength));
    for (let i = 0; i < outLength; i += 1) {
      const idx = indices[i]!;
      if (
        idx >= 0 &&
        idx < this.length &&
        (this.values[idx >> 3]! & (1 << (idx & 7))) !== 0
      ) {
        bytes[i >> 3]! |= 1 << (i & 7);
      }
    }
    const validity = validityGatherByIndices(
      this.validity,
      indices,
      this.length,
    );
    return new BooleanColumn(bytes, outLength, validity);
  }
}

/* -------------------------------------------------------------------------- */
/* Construction helpers — convenience wrappers over the class constructors.   */
/* -------------------------------------------------------------------------- */

/**
 * Builds a `Float64Column` from an array of `number | null | undefined`
 * values. The output's `validity` bitmap is allocated only when at
 * least one input slot is missing.
 */
export function float64ColumnFromArray(
  source: ReadonlyArray<number | null | undefined>,
): Float64Column {
  const length = source.length;
  validateColumnLength(length, 'Float64Column');
  const values = new Float64Array(length);
  for (let i = 0; i < length; i += 1) {
    const v = source[i];
    values[i] = typeof v === 'number' ? v : 0;
  }
  const validity = validityFromPredicate(length, (i) => {
    const v = source[i];
    return typeof v === 'number';
  });
  return new Float64Column(values, length, validity);
}

/**
 * Builds a `BooleanColumn` from an array of `boolean | null | undefined`
 * values. The output's `validity` bitmap is allocated only when at
 * least one input slot is missing.
 */
export function booleanColumnFromArray(
  source: ReadonlyArray<boolean | null | undefined>,
): BooleanColumn {
  const length = source.length;
  validateColumnLength(length, 'BooleanColumn');
  const bytes = new Uint8Array(bitmapByteCount(length));
  for (let i = 0; i < length; i += 1) {
    if (source[i] === true) {
      bytes[i >> 3]! |= 1 << (i & 7);
    }
  }
  const validity = validityFromPredicate(
    length,
    (i) => typeof source[i] === 'boolean',
  );
  return new BooleanColumn(bytes, length, validity);
}
