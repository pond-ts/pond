/**
 * `ArrayColumn` — value-column variant for `kind: 'array'`.
 *
 * Array-kind columns appear when reducers like `unique`, `top`, or
 * `samples` collapse a bucket into a list of scalars. Each cell is a
 * `ReadonlyArray<ScalarValue>` (a `ScalarValue` being a number,
 * string, or boolean per `types.ts`).
 *
 * **Storage modes (sub-step 1c scope).** The fallback representation
 * — `fallback: ReadonlyArray<ReadonlyArray<ScalarValue> | undefined>`
 * — is the only one shipping for v1.0. The framework design also
 * sketches a length-prefix-encoded mode (`offsets: Int32Array` +
 * `values: Column`) for a future optimization where many arrays
 * share a homogeneous scalar element kind; that path is deferred
 * until a use case earns it.
 *
 * Framework-internal; not exported from `packages/core/src/index.ts`.
 */

import type { ArrayValue } from '../types.js';
import type { ScanOptions } from './column.js';
import {
  type ValidityBitmap,
  validateColumnLength,
  validityFromPredicate,
  validityGatherByIndices,
  validitySliceByRange,
} from './validity.js';

/**
 * Array-kind value column. Currently single-mode (fallback). The
 * `offsets` / `values` length-prefix fields appear in the framework
 * design as future-optimization slots but are not populated by 1c
 * construction paths; they remain `undefined`.
 */
export class ArrayColumn {
  readonly kind = 'array' as const;
  readonly length: number;
  readonly fallback: ReadonlyArray<ArrayValue | undefined>;
  readonly validity?: ValidityBitmap;

  // Reserved for the future length-prefix optimization. Always
  // `undefined` for 1c-constructed columns.
  readonly offsets?: Int32Array;
  readonly values?: never;

  constructor(
    length: number,
    options: {
      fallback: ReadonlyArray<ArrayValue | undefined>;
      validity?: ValidityBitmap;
    },
  ) {
    validateColumnLength(length, 'ArrayColumn');
    if (options.fallback.length !== length) {
      throw new RangeError(
        `ArrayColumn: fallback length ${options.fallback.length} does not match column length ${length}`,
      );
    }
    const validity = options.validity;
    if (validity !== undefined && validity.length !== length) {
      throw new RangeError(
        `ArrayColumn: validity length ${validity.length} does not match column length ${length}`,
      );
    }
    if (validity !== undefined) {
      // If validity is supplied, every row it marks as defined must
      // contain an array in the fallback. Otherwise reads would
      // return `undefined` for a "defined" cell — silent drop in scan.
      for (let i = 0; i < length; i += 1) {
        if (validity.isDefined(i) && !Array.isArray(options.fallback[i])) {
          throw new RangeError(
            `ArrayColumn: validity marks index ${i} as defined but fallback[${i}] is not an array`,
          );
        }
      }
    } else {
      // No-validity invariant: every cell must be a real array (or
      // throw). Direct construction with `undefined` slots and no
      // bitmap is the boundary-drift class of bug we closed for
      // StringColumn (PR #133 round 4) — same enforcement here.
      for (let i = 0; i < length; i += 1) {
        if (!Array.isArray(options.fallback[i])) {
          throw new RangeError(
            `ArrayColumn: fallback[${i}] is not an array but no validity bitmap was supplied; use arrayColumnFromArray() to derive validity automatically, or pass an explicit validity bitmap`,
          );
        }
      }
    }
    this.length = length;
    this.fallback = options.fallback;
    if (validity !== undefined) this.validity = validity;
  }

  read(i: number): ArrayValue | undefined {
    if (i < 0 || i >= this.length) return undefined;
    if (this.validity && !this.validity.isDefined(i)) return undefined;
    return this.fallback[i];
  }

  /**
   * Linear scan with callback. `skipInvalid` defaults to `true`.
   * When `skipInvalid: false`, invalid rows receive the empty-array
   * sentinel `EMPTY_ARRAY_SENTINEL` (a single shared frozen empty
   * array), matching the no-mode-divergence pattern that the
   * `StringColumn` `''` sentinel established in 1b. Callers consult
   * `column.validity` to disambiguate a real empty array from the
   * sentinel.
   */
  scan(
    fn: (value: ArrayValue, i: number) => void,
    options?: ScanOptions,
  ): void {
    const skipInvalid = options?.skipInvalid ?? true;
    const v = this.validity;
    if (!v) {
      // No validity ⇒ every cell is an array (constructor enforced).
      for (let i = 0; i < this.length; i += 1) {
        fn(this.fallback[i]!, i);
      }
      return;
    }
    for (let i = 0; i < this.length; i += 1) {
      if (v.isDefined(i)) {
        fn(this.fallback[i]!, i);
      } else if (!skipInvalid) {
        fn(EMPTY_ARRAY_SENTINEL, i);
      }
    }
  }

  sliceByRange(start: number, end: number): ArrayColumn {
    const lo = Math.max(0, start);
    const hi = Math.min(this.length, end);
    const outLength = Math.max(0, hi - lo);
    if (outLength === 0) {
      return new ArrayColumn(0, { fallback: [] });
    }
    const validity = validitySliceByRange(this.validity, lo, hi, this.length);
    const fallback = this.fallback.slice(lo, hi);
    return new ArrayColumn(outLength, {
      fallback,
      ...(validity !== undefined ? { validity } : {}),
    });
  }

  sliceByIndices(sourceRowIndices: Int32Array): ArrayColumn {
    const outLength = sourceRowIndices.length;
    const validity = validityGatherByIndices(
      this.validity,
      sourceRowIndices,
      this.length,
    );
    const out = new Array<ArrayValue | undefined>(outLength);
    for (let i = 0; i < outLength; i += 1) {
      const idx = sourceRowIndices[i]!;
      out[i] = idx >= 0 && idx < this.length ? this.fallback[idx] : undefined;
    }
    return new ArrayColumn(outLength, {
      fallback: out,
      ...(validity !== undefined ? { validity } : {}),
    });
  }
}

/**
 * The shared empty-array sentinel that `scan({ skipInvalid: false })`
 * emits for invalid rows. Frozen so callers can't mutate it. Identity
 * is reused across all invocations — comparing
 * `value === EMPTY_ARRAY_SENTINEL` cheaply detects "this row was
 * invalid in the scan." Callers can also consult `column.validity`
 * for the same disambiguation.
 */
export const EMPTY_ARRAY_SENTINEL: ArrayValue = Object.freeze([] as ArrayValue);

/**
 * Builds an `ArrayColumn` from a possibly-sparse source. Slots that
 * are not arrays (null, undefined, scalars) become invalid cells.
 * Derives a validity bitmap automatically. Use this when you have a
 * raw array-of-arrays input with possible holes.
 */
export function arrayColumnFromArray(
  source: ReadonlyArray<ArrayValue | null | undefined>,
): ArrayColumn {
  const length = source.length;
  validateColumnLength(length, 'ArrayColumn');
  if (length === 0) {
    return new ArrayColumn(0, { fallback: [] });
  }
  // Normalize: non-array slots become `undefined` so the storage is
  // tight, validity bitmap derives from "is this slot an array?".
  const fallback = new Array<ArrayValue | undefined>(length);
  for (let i = 0; i < length; i += 1) {
    const v = source[i];
    fallback[i] = Array.isArray(v) ? (v as ArrayValue) : undefined;
  }
  const validity = validityFromPredicate(length, (i) =>
    Array.isArray(source[i]),
  );
  if (validity === undefined) {
    // Every slot was a real array; fallback is already pure.
    return new ArrayColumn(length, {
      fallback: fallback as ReadonlyArray<ArrayValue>,
    });
  }
  return new ArrayColumn(length, { fallback, validity });
}
