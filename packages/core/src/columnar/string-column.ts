/**
 * `StringColumn` — value-column variant for `kind: 'string'`.
 *
 * A single class with two internal representations:
 *
 * 1. **Dictionary-encoded.** `dictionary: ReadonlyArray<string>` and
 *    `indices: Int32Array` — every row stores an `Int32` index into
 *    the shared dictionary. Optimal for low-cardinality columns
 *    (partition keys, region labels, status codes, etc.).
 * 2. **Fallback.** `fallback: ReadonlyArray<string | undefined>` —
 *    the raw string array. Used when dict encoding doesn't pay
 *    (free-text columns, URLs, high-cardinality identifiers).
 *
 * The two modes are discriminated by which fields are present;
 * never both. Validity tracks missing values via the shared
 * `ValidityBitmap` primitive — identical convention to the numeric
 * columns. Dictionary entries themselves are always defined strings;
 * `undefined` is expressed via the validity bitmap, not a
 * dictionary slot.
 *
 * Framework-internal; not exported from `packages/core/src/index.ts`.
 */

import type { ScanOptions } from './column.js';
import {
  type ValidityBitmap,
  bitmapByteCount,
  validateColumnLength,
  validityFromPredicate,
  validityGatherByIndices,
  validitySliceByRange,
} from './validity.js';

/**
 * Threshold heuristic for whether a fresh `stringColumnFromArray`
 * call dict-encodes its input. Encoding wins when
 * `distinct * avg_str_bytes + length * 4 < length * avg_str_bytes`;
 * with `Int32` indices and typical short-label string sizes the
 * crossover sits near `distinct / length ≈ 0.5`. Below this ratio
 * we dict-encode; above it (or for very small `length`) we fall
 * back to a plain string array.
 *
 * Exported so callers building from low-level primitives can pick
 * the same default.
 */
export const DICT_ENCODE_RATIO = 0.5;

/**
 * Minimum length at which dict encoding's overhead earns its keep.
 * Below this the dictionary structure costs more memory than a
 * plain `string[]` regardless of cardinality.
 */
export const DICT_ENCODE_MIN_LENGTH = 16;

/**
 * Single class covering both dictionary-encoded and fallback string
 * columns. `dictionary` / `indices` populated iff dict-encoded;
 * `fallback` populated otherwise. Exactly one mode is active per
 * instance.
 */
export class StringColumn {
  readonly kind = 'string' as const;
  readonly length: number;
  readonly dictionary?: ReadonlyArray<string>;
  readonly indices?: Int32Array;
  readonly fallback?: ReadonlyArray<string | undefined>;
  readonly validity?: ValidityBitmap;

  /**
   * Private. Construct via `stringColumnDictEncoded`,
   * `stringColumnFallback`, or the higher-level
   * `stringColumnFromArray`. Validates that exactly one of the two
   * storage modes is populated.
   */
  constructor(
    length: number,
    options: {
      dictionary?: ReadonlyArray<string>;
      indices?: Int32Array;
      fallback?: ReadonlyArray<string | undefined>;
      validity?: ValidityBitmap;
    },
  ) {
    validateColumnLength(length, 'StringColumn');
    const hasDict =
      options.dictionary !== undefined && options.indices !== undefined;
    const hasFallback = options.fallback !== undefined;
    if (hasDict === hasFallback) {
      throw new Error(
        'StringColumn: exactly one of {dictionary+indices, fallback} must be provided',
      );
    }
    if (options.validity !== undefined && options.validity.length !== length) {
      throw new RangeError(
        `StringColumn: validity length ${options.validity.length} does not match column length ${length}`,
      );
    }
    const validity = options.validity;
    if (hasDict) {
      if (options.indices!.length !== length) {
        throw new RangeError(
          `StringColumn: indices length ${options.indices!.length} does not match column length ${length}`,
        );
      }
      // Validate every index falls within the dictionary range, **only for
      // cells the validity bitmap marks as defined**. Invalid cells hold an
      // arbitrary placeholder by framework convention (writes never reach
      // the dictionary lookup because `read` short-circuits on validity).
      // This permits empty-dictionary results from `sliceByIndices` where
      // every output row was an out-of-range gather.
      const dictLen = options.dictionary!.length;
      for (let i = 0; i < length; i += 1) {
        if (validity && !validity.isDefined(i)) continue;
        const idx = options.indices![i]!;
        if (idx < 0 || idx >= dictLen) {
          throw new RangeError(
            `StringColumn: indices[${i}] = ${idx} out of dictionary range [0, ${dictLen})`,
          );
        }
      }
      this.dictionary = options.dictionary!;
      this.indices = options.indices!;
    } else {
      if (options.fallback!.length !== length) {
        throw new RangeError(
          `StringColumn: fallback length ${options.fallback!.length} does not match column length ${length}`,
        );
      }
      // If validity is supplied, every row it marks as defined must
      // contain a string in the fallback array. Otherwise reads would
      // return `undefined` for a "defined" cell — silent data drop in
      // scan. Without explicit validity, the fallback factory derives
      // validity from `undefined` slots, so the two are consistent
      // by construction.
      if (validity !== undefined) {
        const fb = options.fallback!;
        for (let i = 0; i < length; i += 1) {
          if (validity.isDefined(i) && typeof fb[i] !== 'string') {
            throw new RangeError(
              `StringColumn: validity marks index ${i} as defined but fallback[${i}] is not a string`,
            );
          }
        }
      }
      this.fallback = options.fallback!;
    }
    this.length = length;
    if (validity !== undefined) this.validity = validity;
  }

  /** True if this column uses dictionary encoding. */
  get isDictEncoded(): boolean {
    return this.dictionary !== undefined;
  }

  read(i: number): string | undefined {
    if (i < 0 || i >= this.length) return undefined;
    if (this.validity && !this.validity.isDefined(i)) return undefined;
    if (this.dictionary !== undefined) {
      return this.dictionary[this.indices![i]!];
    }
    // Fallback mode: even without a validity bitmap, a slot can be
    // undefined (the framework convention is that validity tracks
    // missing-ness, but fallback arrays may carry undefined directly).
    return this.fallback![i];
  }

  /**
   * Linear scan with callback. `skipInvalid` defaults to true. When
   * `skipInvalid: false`, the scan considers every row but **still
   * only invokes the callback for rows whose effective string value
   * is defined** — the callback's `value` parameter is typed as
   * `string`, so we never pass `undefined`. This matches the
   * fallback-mode behavior and protects against the dict-encoded
   * empty-placeholder path where an invalid row's index points
   * outside the dictionary.
   *
   * To distinguish "missing" from "skipped" when iterating, consult
   * `column.validity` directly.
   */
  scan(fn: (value: string, i: number) => void, options?: ScanOptions): void {
    const skipInvalid = options?.skipInvalid ?? true;
    const v = this.validity;
    if (this.dictionary !== undefined) {
      const dict = this.dictionary;
      const idxBuf = this.indices!;
      if (!v) {
        for (let i = 0; i < this.length; i += 1) {
          const val = dict[idxBuf[i]!];
          if (val !== undefined) fn(val, i);
        }
        return;
      }
      for (let i = 0; i < this.length; i += 1) {
        const valid = v.isDefined(i);
        if (valid || !skipInvalid) {
          const val = dict[idxBuf[i]!];
          if (val !== undefined) fn(val, i);
        }
      }
      return;
    }
    const fb = this.fallback!;
    if (!v) {
      for (let i = 0; i < this.length; i += 1) {
        const val = fb[i];
        if (val !== undefined) {
          fn(val, i);
        }
      }
      return;
    }
    for (let i = 0; i < this.length; i += 1) {
      const valid = v.isDefined(i);
      if (valid || !skipInvalid) {
        const val = fb[i];
        if (val !== undefined) fn(val, i);
      }
    }
  }

  /**
   * Returns a column covering rows `[start, end)`. Dict-encoded:
   * `indices` becomes an `Int32Array.subarray` view and the
   * dictionary is shared by reference. Fallback: slices the array.
   */
  sliceByRange(start: number, end: number): StringColumn {
    const lo = Math.max(0, start);
    const hi = Math.min(this.length, end);
    const outLength = Math.max(0, hi - lo);
    if (outLength === 0) {
      // Empty slice; use whichever mode is cheapest to represent.
      if (this.dictionary !== undefined) {
        return new StringColumn(0, {
          dictionary: this.dictionary,
          indices: new Int32Array(0),
        });
      }
      return new StringColumn(0, { fallback: [] });
    }
    const validity = validitySliceByRange(this.validity, lo, hi, this.length);
    if (this.dictionary !== undefined) {
      const indices = this.indices!.subarray(lo, hi);
      return new StringColumn(outLength, {
        dictionary: this.dictionary,
        indices,
        ...(validity !== undefined ? { validity } : {}),
      });
    }
    const fallback = this.fallback!.slice(lo, hi);
    return new StringColumn(outLength, {
      fallback,
      ...(validity !== undefined ? { validity } : {}),
    });
  }

  /**
   * Returns a column whose row `i` is this column's row
   * `indices[i]`. Dict-encoded: gathers `Int32` indices, dictionary
   * shared. Fallback: gathers strings into a new array.
   *
   * **Dictionary retention.** The output keeps the full source
   * dictionary even if some entries are no longer referenced. A
   * future `compactDictionary` op (deferred until a use case
   * justifies it) trims unused entries.
   */
  sliceByIndices(sourceRowIndices: Int32Array): StringColumn {
    const outLength = sourceRowIndices.length;
    const validity = validityGatherByIndices(
      this.validity,
      sourceRowIndices,
      this.length,
    );
    if (this.dictionary !== undefined) {
      const srcIndices = this.indices!;
      const out = new Int32Array(outLength);
      for (let i = 0; i < outLength; i += 1) {
        const idx = sourceRowIndices[i]!;
        // Out-of-range source rows write dictionary slot 0; validity
        // gather above marks those slots invalid so reads still return
        // undefined.
        out[i] = idx >= 0 && idx < this.length ? srcIndices[idx]! : 0;
      }
      return new StringColumn(outLength, {
        dictionary: this.dictionary,
        indices: out,
        ...(validity !== undefined ? { validity } : {}),
      });
    }
    const src = this.fallback!;
    const out = new Array<string | undefined>(outLength);
    for (let i = 0; i < outLength; i += 1) {
      const idx = sourceRowIndices[i]!;
      out[i] = idx >= 0 && idx < this.length ? src[idx] : undefined;
    }
    return new StringColumn(outLength, {
      fallback: out,
      ...(validity !== undefined ? { validity } : {}),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Construction helpers.                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Wraps an already-prepared dictionary and indices array into a
 * dict-encoded `StringColumn`. The caller owns dictionary
 * uniqueness — entries are assumed distinct.
 */
export function stringColumnDictEncoded(
  dictionary: ReadonlyArray<string>,
  indices: Int32Array,
  validity?: ValidityBitmap,
): StringColumn {
  return new StringColumn(indices.length, {
    dictionary,
    indices,
    ...(validity !== undefined ? { validity } : {}),
  });
}

/**
 * Wraps a plain `string | undefined` array as a fallback-mode
 * `StringColumn`. Validity is derived from the array's `undefined`
 * entries when no bitmap is supplied — this matches the framework's
 * "no bitmap when all defined" convention.
 */
export function stringColumnFallback(
  fallback: ReadonlyArray<string | undefined>,
  validity?: ValidityBitmap,
): StringColumn {
  if (validity !== undefined) {
    return new StringColumn(fallback.length, { fallback, validity });
  }
  const derived = validityFromPredicate(
    fallback.length,
    (i) => typeof fallback[i] === 'string',
  );
  return new StringColumn(fallback.length, {
    fallback,
    ...(derived !== undefined ? { validity: derived } : {}),
  });
}

/**
 * Builds a `StringColumn` from an array of `string | null |
 * undefined` values, choosing dict-encoded vs fallback mode based
 * on cardinality. Use when you don't have a pre-built dictionary
 * and want the framework to make the encoding decision.
 *
 * The heuristic: dict-encode when `length >= DICT_ENCODE_MIN_LENGTH`
 * and `distinct / length < DICT_ENCODE_RATIO`. Override either
 * threshold via `options` for benchmarks or specific use cases.
 */
export function stringColumnFromArray(
  source: ReadonlyArray<string | null | undefined>,
  options?: {
    /** Force dict encoding regardless of heuristic. */
    forceDict?: boolean;
    /** Force fallback regardless of heuristic. */
    forceFallback?: boolean;
    /** Override the `distinct / length` threshold (default 0.5). */
    dictRatio?: number;
    /** Override the minimum length for dict encoding (default 16). */
    minDictLength?: number;
  },
): StringColumn {
  const length = source.length;
  validateColumnLength(length, 'StringColumn');

  if (options?.forceDict && options?.forceFallback) {
    throw new Error(
      'stringColumnFromArray: forceDict and forceFallback are mutually exclusive',
    );
  }

  // Empty source: pick the cheaper representation.
  if (length === 0) {
    return options?.forceFallback
      ? new StringColumn(0, { fallback: [] })
      : new StringColumn(0, { dictionary: [], indices: new Int32Array(0) });
  }

  // Single pass: build a dictionary + indices, and track missing slots.
  const dictionary: string[] = [];
  const dictionaryIndex = new Map<string, number>();
  const indices = new Int32Array(length);
  let missing = 0;

  for (let i = 0; i < length; i += 1) {
    const v = source[i];
    if (typeof v !== 'string') {
      indices[i] = 0; // placeholder; validity bitmap will mark invalid
      missing += 1;
      continue;
    }
    let dictIdx = dictionaryIndex.get(v);
    if (dictIdx === undefined) {
      dictIdx = dictionary.length;
      dictionaryIndex.set(v, dictIdx);
      dictionary.push(v);
    }
    indices[i] = dictIdx;
  }

  const validity =
    missing === 0
      ? undefined
      : validityFromPredicate(length, (i) => typeof source[i] === 'string');

  // Decide encoding mode.
  const forceDict = options?.forceDict === true;
  const forceFallback = options?.forceFallback === true;
  const ratio = options?.dictRatio ?? DICT_ENCODE_RATIO;
  const minLen = options?.minDictLength ?? DICT_ENCODE_MIN_LENGTH;
  const distinct = dictionary.length;
  const dictWins =
    forceDict ||
    (!forceFallback && length >= minLen && distinct / length < ratio);

  if (dictWins) {
    if (dictionary.length === 0) {
      // Every slot was missing. Add a placeholder so indices[0] is in
      // dictionary range (validity covers the missingness).
      dictionary.push('');
    }
    return new StringColumn(length, {
      dictionary,
      indices,
      ...(validity !== undefined ? { validity } : {}),
    });
  }

  // Fallback mode: rebuild the raw array. Cheaper to copy than to
  // re-walk; iterations above produced `indices`, not the strings.
  const fallback = new Array<string | undefined>(length);
  for (let i = 0; i < length; i += 1) {
    const v = source[i];
    fallback[i] = typeof v === 'string' ? v : undefined;
  }
  return new StringColumn(length, {
    fallback,
    ...(validity !== undefined ? { validity } : {}),
  });
}

/* -------------------------------------------------------------------------- */
/* Dictionary operations — exposed for callers that want to inspect or        */
/* manipulate the dictionary directly.                                        */
/* -------------------------------------------------------------------------- */

/**
 * Builds an inverse map `string → dictionary-index` from a
 * dictionary array. Used to filter or compare values **within a
 * single column** — the caller looks up a target string's index in
 * the column's dictionary, then compares against `indices[i]` with
 * integer equality.
 *
 * **Same-dictionary only.** The returned indices are meaningful only
 * against the dictionary they were built from. Comparing indices
 * across two columns with different dictionaries gives false
 * positives and false negatives. For cross-column joins, use
 * `remapIndicesToDictionary` to translate first.
 */
export function buildDictionaryIndex(
  dictionary: ReadonlyArray<string>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < dictionary.length; i += 1) {
    map.set(dictionary[i]!, i);
  }
  return map;
}

/**
 * Translates a buffer of dictionary indices from one dictionary to
 * another. The returned `Int32Array` is `srcIndices.length` long,
 * with entry `i = targetDictionary` index of the string at
 * `srcIndices[i]`, or `-1` when the source string is absent from
 * the target dictionary.
 *
 * Use this when joining or filtering across two `StringColumn`s
 * with different dictionaries: remap one side's indices to the
 * other's vocabulary so integer-equality comparison becomes
 * meaningful again.
 *
 * Complexity: O(srcIndices.length + targetDictionary.length).
 */
export function remapIndicesToDictionary(
  srcIndices: Int32Array,
  srcDictionary: ReadonlyArray<string>,
  targetDictionary: ReadonlyArray<string>,
): Int32Array {
  const targetIndex = buildDictionaryIndex(targetDictionary);
  const out = new Int32Array(srcIndices.length);
  for (let i = 0; i < srcIndices.length; i += 1) {
    const srcIdx = srcIndices[i]!;
    if (srcIdx < 0 || srcIdx >= srcDictionary.length) {
      out[i] = -1;
      continue;
    }
    const value = srcDictionary[srcIdx]!;
    const mapped = targetIndex.get(value);
    out[i] = mapped === undefined ? -1 : mapped;
  }
  return out;
}

/**
 * Counts the byte footprint of a dictionary. Uses 2 bytes per code
 * unit (the typical V8 representation for non-ASCII strings is
 * UTF-16; pure ASCII strings often use 1-byte encoding internally
 * but the heuristic is conservative). Caller code uses this to
 * compare encoded vs fallback memory.
 */
export function estimateDictionaryBytes(
  dictionary: ReadonlyArray<string>,
): number {
  let bytes = 0;
  for (let i = 0; i < dictionary.length; i += 1) {
    bytes += dictionary[i]!.length * 2;
  }
  return bytes;
}
