/**
 * Validity bitmap — 1 bit per row, packed into a `Uint8Array`.
 *
 * A column's `validity` field is **optional**. Absent means
 * "every cell is defined." Allocated only when at least one cell is
 * undefined; consumers branch on its presence.
 *
 * Storage layout: `bits[i >> 3] & (1 << (i & 7))` is the validity bit
 * for row `i`. Bits beyond `length` within the last byte are reserved
 * (must be zero) but not counted.
 *
 * Framework-internal; not exported from `packages/core/src/index.ts`.
 */

/**
 * Upper bound on a single column's `length`. Keeps the byte-sizing and
 * bit-indexing math in safe 31-bit territory regardless of the integer
 * involved, and falls well below `Float64Array`'s practical allocation
 * ceiling on any current engine. Single columns above this size are
 * a `ChunkedColumn` concern (sub-step 1g).
 */
export const MAX_COLUMN_LENGTH = 2 ** 31 - 8;

/**
 * Validates that `length` is a non-negative safe integer not exceeding
 * `MAX_COLUMN_LENGTH`. Throws `RangeError` otherwise. Every public
 * factory and class constructor that derives a packed-bit byte count
 * from `length` calls this first.
 */
export function validateColumnLength(length: number, label: string): void {
  if (!Number.isInteger(length) || length < 0) {
    throw new RangeError(
      `${label} length must be a non-negative integer, got ${length}`,
    );
  }
  if (length > MAX_COLUMN_LENGTH) {
    throw new RangeError(
      `${label} length ${length} exceeds MAX_COLUMN_LENGTH (${MAX_COLUMN_LENGTH})`,
    );
  }
}

/**
 * Bytes required to pack `length` bits. Uses floating-point ceil to
 * stay correct even if callers skip `validateColumnLength` somehow;
 * the bitwise `>> 3` indexing used inside hot loops still applies
 * because validated lengths fit in 31-bit signed range.
 */
export function bitmapByteCount(length: number): number {
  return Math.ceil(length / 8);
}
export interface ValidityBitmap {
  /** Packed validity bits — `ceil(length / 8)` bytes. */
  readonly bits: Uint8Array;
  /** Logical row count covered by the bitmap. */
  readonly length: number;
  /** Number of cells with their validity bit set. Cached at construction. */
  readonly definedCount: number;

  /** Returns true if the cell at `i` is defined. Out-of-range → false. */
  isDefined(i: number): boolean;

  /** Counts defined cells in the half-open range `[start, end)`. */
  countInRange(start: number, end: number): number;
}

/**
 * Concrete bitmap backed by an owned `Uint8Array`. The constructor
 * trusts inputs; use the factory helpers below to construct from
 * row-shaped data.
 */
class PackedValidityBitmap implements ValidityBitmap {
  readonly bits: Uint8Array;
  readonly length: number;
  readonly definedCount: number;

  constructor(bits: Uint8Array, length: number) {
    validateColumnLength(length, 'ValidityBitmap');
    const requiredBytes = bitmapByteCount(length);
    if (bits.length < requiredBytes) {
      throw new RangeError(
        `ValidityBitmap bits underflow: need ${requiredBytes} bytes for length ${length}, got ${bits.length}`,
      );
    }
    this.bits = bits;
    this.length = length;
    this.definedCount = popcount(bits, length);
  }

  isDefined(i: number): boolean {
    if (i < 0 || i >= this.length) return false;
    return (this.bits[i >> 3]! & (1 << (i & 7))) !== 0;
  }

  countInRange(start: number, end: number): number {
    if (end <= start) return 0;
    const lo = Math.max(0, start);
    const hi = Math.min(this.length, end);
    if (hi <= lo) return 0;
    return countBitsInRange(this.bits, lo, hi);
  }
}

/**
 * Creates a fresh validity bitmap covering `length` rows, with every
 * cell initially marked invalid (all bits zero). Used by builders that
 * fill validity incrementally.
 */
export function createValidityBitmap(length: number): MutableValidityBitmap {
  validateColumnLength(length, 'ValidityBitmap');
  const bits = new Uint8Array(bitmapByteCount(length));
  return new MutableValidityBitmap(bits, length);
}

/**
 * Wraps an already-prepared bit buffer as a finalized bitmap. The
 * `bits` array becomes the bitmap's storage — do not mutate after
 * passing in.
 */
export function validityFromBits(
  bits: Uint8Array,
  length: number,
): ValidityBitmap {
  return new PackedValidityBitmap(bits, length);
}

/**
 * Builds a bitmap from a callback returning truthy/falsy per row.
 * Returns `undefined` when every cell is defined — the framework's
 * "all defined ⇒ no bitmap" convention.
 */
export function validityFromPredicate(
  length: number,
  isDefined: (i: number) => boolean,
): ValidityBitmap | undefined {
  validateColumnLength(length, 'ValidityBitmap');
  if (length === 0) return undefined;
  const bits = new Uint8Array(bitmapByteCount(length));
  let defined = 0;
  for (let i = 0; i < length; i += 1) {
    if (isDefined(i)) {
      bits[i >> 3]! |= 1 << (i & 7);
      defined += 1;
    }
  }
  if (defined === length) return undefined;
  return new PackedValidityBitmap(bits, length);
}

/**
 * Mutable variant — used by builders during column construction.
 * Snapshot via `freeze()` produces a `ValidityBitmap`. The freeze is
 * **one-shot**: subsequent `set` / `clear` / `freeze` calls throw,
 * which prevents a builder from corrupting an already-finalized
 * column. Callers who need to keep mutating after a snapshot must
 * allocate a fresh `MutableValidityBitmap`.
 *
 * Direct mutation of the underlying `bits` array (which is exposed
 * as `readonly` at the TS layer but `Uint8Array` at runtime) is the
 * caller's contract to avoid — `readonly` is a type-system marker,
 * not a runtime barrier.
 */
export class MutableValidityBitmap {
  readonly bits: Uint8Array;
  readonly length: number;
  #definedCount: number;
  #consumed = false;

  constructor(bits: Uint8Array, length: number) {
    validateColumnLength(length, 'MutableValidityBitmap');
    const requiredBytes = bitmapByteCount(length);
    if (bits.length < requiredBytes) {
      throw new RangeError(
        `MutableValidityBitmap bits underflow: need ${requiredBytes} bytes for length ${length}, got ${bits.length}`,
      );
    }
    this.bits = bits;
    this.length = length;
    this.#definedCount = popcount(bits, length);
  }

  get definedCount(): number {
    return this.#definedCount;
  }

  /** True once `freeze()` has been called. After that, mutation throws. */
  get consumed(): boolean {
    return this.#consumed;
  }

  isDefined(i: number): boolean {
    if (i < 0 || i >= this.length) return false;
    return (this.bits[i >> 3]! & (1 << (i & 7))) !== 0;
  }

  /** Marks `i` as defined. Returns true if the bit changed. */
  set(i: number): boolean {
    if (this.#consumed) {
      throw new Error(
        'MutableValidityBitmap.set: this bitmap has already been frozen',
      );
    }
    if (i < 0 || i >= this.length) {
      throw new RangeError(
        `ValidityBitmap.set out of range: ${i} not in [0, ${this.length})`,
      );
    }
    const byte = i >> 3;
    const mask = 1 << (i & 7);
    if ((this.bits[byte]! & mask) !== 0) return false;
    this.bits[byte]! |= mask;
    this.#definedCount += 1;
    return true;
  }

  /** Marks `i` as invalid. Returns true if the bit changed. */
  clear(i: number): boolean {
    if (this.#consumed) {
      throw new Error(
        'MutableValidityBitmap.clear: this bitmap has already been frozen',
      );
    }
    if (i < 0 || i >= this.length) {
      throw new RangeError(
        `ValidityBitmap.clear out of range: ${i} not in [0, ${this.length})`,
      );
    }
    const byte = i >> 3;
    const mask = 1 << (i & 7);
    if ((this.bits[byte]! & mask) === 0) return false;
    this.bits[byte]! &= ~mask;
    this.#definedCount -= 1;
    return true;
  }

  /**
   * Freezes the mutable bitmap into a `ValidityBitmap`, returning
   * `undefined` when every cell is defined (the framework "no bitmap
   * needed" convention). **One-shot**: subsequent `set` / `clear` /
   * `freeze` calls throw.
   *
   * The frozen snapshot owns a **copy** of the underlying byte
   * buffer — direct mutation of `bm.bits` after freeze (a runtime
   * possibility despite the `readonly` TS modifier) cannot affect
   * the returned bitmap. The cost is an O(length / 8) byte copy at
   * freeze time, which is a once-per-builder operation and not a
   * hot-path concern.
   */
  freeze(): ValidityBitmap | undefined {
    if (this.#consumed) {
      throw new Error(
        'MutableValidityBitmap.freeze: this bitmap has already been frozen',
      );
    }
    this.#consumed = true;
    if (this.#definedCount === this.length) return undefined;
    // Copy bytes so the frozen bitmap does not alias the mutable buffer.
    const ownedBits = new Uint8Array(this.bits);
    return new PackedValidityBitmap(ownedBits, this.length);
  }
}

/**
 * Copies validity bits for the half-open range `[start, end)` into a
 * fresh bitmap whose bit 0 corresponds to source bit `start`.
 *
 * Returns `undefined` when all bits in the range are set — keeps the
 * "no bitmap needed" convention.
 */
export function validitySliceByRange(
  source: ValidityBitmap | undefined,
  start: number,
  end: number,
  sourceLength: number,
): ValidityBitmap | undefined {
  validateColumnLength(sourceLength, 'validitySliceByRange.sourceLength');
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new RangeError(
      `validitySliceByRange: start (${start}) and end (${end}) must be finite`,
    );
  }
  if (end < start) {
    throw new RangeError(
      `validitySliceByRange: end (${end}) precedes start (${start})`,
    );
  }
  const lo = Math.max(0, start);
  const hi = Math.min(sourceLength, end);
  const outLength = Math.max(0, hi - lo);
  if (outLength === 0) return undefined;
  if (!source) return undefined; // all defined
  const bits = new Uint8Array(bitmapByteCount(outLength));
  let definedCount = 0;
  for (let i = 0; i < outLength; i += 1) {
    const srcIdx = lo + i;
    if ((source.bits[srcIdx >> 3]! & (1 << (srcIdx & 7))) !== 0) {
      bits[i >> 3]! |= 1 << (i & 7);
      definedCount += 1;
    }
  }
  if (definedCount === outLength) return undefined;
  return new PackedValidityBitmap(bits, outLength);
}

/**
 * Gathers validity bits for a row-index selection. The output's bit
 * `i` is the source's bit at `indices[i]`. Returns `undefined` when
 * all gathered bits are set.
 */
export function validityGatherByIndices(
  source: ValidityBitmap | undefined,
  indices: Int32Array,
  sourceLength: number,
): ValidityBitmap | undefined {
  validateColumnLength(sourceLength, 'validityGatherByIndices.sourceLength');
  validateColumnLength(
    indices.length,
    'validityGatherByIndices.indices.length',
  );
  const outLength = indices.length;
  if (outLength === 0) return undefined;
  if (!source) {
    // All source cells defined; gather is all defined iff every index in range.
    for (let i = 0; i < outLength; i += 1) {
      const idx = indices[i]!;
      if (idx < 0 || idx >= sourceLength) {
        // Out-of-range gather → emit a bitmap marking those slots invalid.
        const bits = new Uint8Array(bitmapByteCount(outLength));
        let defined = 0;
        for (let j = 0; j < outLength; j += 1) {
          const k = indices[j]!;
          if (k >= 0 && k < sourceLength) {
            bits[j >> 3]! |= 1 << (j & 7);
            defined += 1;
          }
        }
        if (defined === outLength) return undefined;
        return new PackedValidityBitmap(bits, outLength);
      }
    }
    return undefined;
  }
  const bits = new Uint8Array(bitmapByteCount(outLength));
  let definedCount = 0;
  for (let i = 0; i < outLength; i += 1) {
    const srcIdx = indices[i]!;
    if (
      srcIdx >= 0 &&
      srcIdx < sourceLength &&
      (source.bits[srcIdx >> 3]! & (1 << (srcIdx & 7))) !== 0
    ) {
      bits[i >> 3]! |= 1 << (i & 7);
      definedCount += 1;
    }
  }
  if (definedCount === outLength) return undefined;
  return new PackedValidityBitmap(bits, outLength);
}

/** Counts set bits across the first `length` bits of `bits`. */
function popcount(bits: Uint8Array, length: number): number {
  if (length === 0) return 0;
  const fullBytes = length >> 3;
  let total = 0;
  for (let i = 0; i < fullBytes; i += 1) {
    total += POPCOUNT_TABLE[bits[i]!]!;
  }
  const remaining = length & 7;
  if (remaining > 0) {
    const mask = (1 << remaining) - 1;
    total += POPCOUNT_TABLE[bits[fullBytes]! & mask]!;
  }
  return total;
}

/** Counts set bits in `[start, end)` of a packed bit buffer. */
function countBitsInRange(
  bits: Uint8Array,
  start: number,
  end: number,
): number {
  if (end <= start) return 0;
  let total = 0;
  // Leading partial byte.
  const startByte = start >> 3;
  const endByte = end >> 3;
  const startBit = start & 7;
  const endBit = end & 7;

  if (startByte === endByte) {
    const mask = ((1 << endBit) - 1) & ~((1 << startBit) - 1);
    return POPCOUNT_TABLE[bits[startByte]! & mask]!;
  }

  if (startBit > 0) {
    const mask = ~((1 << startBit) - 1) & 0xff;
    total += POPCOUNT_TABLE[bits[startByte]! & mask]!;
  } else {
    total += POPCOUNT_TABLE[bits[startByte]!]!;
  }
  for (let i = startByte + 1; i < endByte; i += 1) {
    total += POPCOUNT_TABLE[bits[i]!]!;
  }
  if (endBit > 0) {
    const mask = (1 << endBit) - 1;
    total += POPCOUNT_TABLE[bits[endByte]! & mask]!;
  }
  return total;
}

/** 256-entry popcount table — fastest portable approach for byte-at-a-time scans. */
const POPCOUNT_TABLE: Readonly<Uint8Array> = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) {
    let v = i;
    let c = 0;
    while (v) {
      c += v & 1;
      v >>= 1;
    }
    t[i] = c;
  }
  return t;
})();
