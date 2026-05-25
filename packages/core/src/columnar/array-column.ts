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

import type { ScanOptions } from './column.js';
import type { ArrayValue } from './types.js';
import {
  type ValidityBitmap,
  validateColumnLength,
  validityFromPredicate,
  validityGatherByIndices,
  validitySliceByRange,
} from './validity.js';

/**
 * Returns true when every element of `value` is a finite number, a
 * string, or a boolean — the `ArrayValue` element contract that
 * `validate.ts` enforces for `kind: 'array'` row intake. Used to
 * reject malformed arrays at `ArrayColumn` construction so the
 * "defined cell ⇒ contract-valid value" invariant holds across
 * intake paths.
 */
function isArrayValue(value: unknown): value is ArrayValue {
  if (!Array.isArray(value)) return false;
  for (let i = 0; i < value.length; i += 1) {
    const el = value[i];
    if (typeof el === 'number') {
      if (!Number.isFinite(el)) return false;
    } else if (typeof el !== 'string' && typeof el !== 'boolean') {
      return false;
    }
  }
  return true;
}

/**
 * Array-kind value column. Currently single-mode (fallback). The
 * `offsets` / `values` length-prefix fields appear in the framework
 * design as future-optimization slots but are not populated by 1c
 * construction paths; they remain `undefined`.
 */
export class ArrayColumn {
  readonly kind = 'array' as const;
  readonly storage = 'packed' as const;
  readonly length: number;
  readonly fallback: ReadonlyArray<ArrayValue | undefined>;
  readonly validity?: ValidityBitmap;

  // `offsets` / nested `values` fields appear in the framework
  // design as the length-prefix optimization slots for `ArrayColumn`.
  // They are not exposed on the class today — direct construction
  // and access happen through `fallback`. When the optimization
  // earns its slot in a later phase, the additional fields will
  // be added here and the storage-mode discrimination will mirror
  // the dict-vs-fallback pattern used by `StringColumn`.

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
      // carry an `ArrayValue`-shaped array in the fallback. Otherwise
      // reads would return `undefined` for a "defined" cell — silent
      // drop in scan. Element-wise validation matches the
      // `validate.ts` rules: every element must be a finite number,
      // string, or boolean.
      for (let i = 0; i < length; i += 1) {
        if (validity.isDefined(i) && !isArrayValue(options.fallback[i])) {
          throw new RangeError(
            `ArrayColumn: validity marks index ${i} as defined but fallback[${i}] is not a valid ArrayValue (must be an array of finite number, string, or boolean elements)`,
          );
        }
      }
    } else {
      // No-validity invariant: every cell must be a contract-valid
      // `ArrayValue`. Direct construction with `undefined` slots and
      // no bitmap is the boundary-drift class of bug closed for
      // `StringColumn` (PR #133 round 4); element-wise validation is
      // the Codex round-1 finding on PR #134 closed here.
      for (let i = 0; i < length; i += 1) {
        if (!isArrayValue(options.fallback[i])) {
          throw new RangeError(
            `ArrayColumn: fallback[${i}] is not a valid ArrayValue (must be an array of finite number, string, or boolean elements). Use arrayColumnFromArray() to filter invalid slots into a validity bitmap, or pass an explicit validity bitmap.`,
          );
        }
      }
    }
    // Defensive copy + freeze each defined cell. `ReadonlyArray` is
    // a TypeScript constraint only — without this, a caller could
    // construct a valid column with `[[1]]`, then mutate the original
    // cell to include `NaN` / an object / a `Symbol`, and the column
    // would later read/scan a value that violates the invariant the
    // constructor checked. Shallow copy is sufficient because every
    // element is a primitive (`number | string | boolean`).
    //
    // Cost: O(length × avg-cell-length) extra allocation at
    // construction. For typical reducer-output array columns (small
    // length, small cells) this is negligible. For pathological
    // bulk-array workloads, see the framework design's future-doors
    // section on a trusted-construction skip.
    const ownedFallback = new Array<ArrayValue | undefined>(length);
    for (let i = 0; i < length; i += 1) {
      const cell = options.fallback[i];
      if (cell !== undefined && Array.isArray(cell)) {
        // Copy and freeze. Elements are primitives so shallow freeze
        // is sufficient.
        ownedFallback[i] = Object.freeze(cell.slice() as ArrayValue);
      } else {
        // Validation already established this is OK only when validity
        // marks the row invalid; leave the slot undefined.
        ownedFallback[i] = undefined;
      }
    }
    this.length = length;
    this.fallback = ownedFallback;
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
  // Normalize: non-array slots AND malformed arrays (those containing
  // non-scalar / non-finite elements) become invalid cells. Matches
  // the `validate.ts` array-element contract — a column built from
  // arrays-with-junk surfaces the junk as missing rather than passing
  // bad data through. Callers who want strict failure can construct
  // via `new ArrayColumn(...)` directly (which throws on the same
  // input).
  const fallback = new Array<ArrayValue | undefined>(length);
  for (let i = 0; i < length; i += 1) {
    const v = source[i];
    fallback[i] = isArrayValue(v) ? (v as ArrayValue) : undefined;
  }
  const validity = validityFromPredicate(length, (i) =>
    isArrayValue(source[i]),
  );
  if (validity === undefined) {
    // Every slot was a real `ArrayValue`; fallback is already pure.
    return new ArrayColumn(length, {
      fallback: fallback as ReadonlyArray<ArrayValue>,
    });
  }
  return new ArrayColumn(length, { fallback, validity });
}
