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
    if (length < 0) {
      throw new RangeError(
        `ValidityBitmap length must be non-negative, got ${length}`,
      );
    }
    const requiredBytes = (length + 7) >> 3;
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
  if (length < 0) {
    throw new RangeError(
      `ValidityBitmap length must be non-negative, got ${length}`,
    );
  }
  const bits = new Uint8Array((length + 7) >> 3);
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
  if (length === 0) return undefined;
  const bits = new Uint8Array((length + 7) >> 3);
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
 * Snapshot via `freeze()` produces a `ValidityBitmap`. After
 * freezing, do not mutate the source bits.
 */
export class MutableValidityBitmap {
  readonly bits: Uint8Array;
  readonly length: number;
  #definedCount: number;

  constructor(bits: Uint8Array, length: number) {
    this.bits = bits;
    this.length = length;
    this.#definedCount = popcount(bits, length);
  }

  get definedCount(): number {
    return this.#definedCount;
  }

  isDefined(i: number): boolean {
    if (i < 0 || i >= this.length) return false;
    return (this.bits[i >> 3]! & (1 << (i & 7))) !== 0;
  }

  /** Marks `i` as defined. Returns true if the bit changed. */
  set(i: number): boolean {
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
   * needed" convention).
   */
  freeze(): ValidityBitmap | undefined {
    if (this.#definedCount === this.length) return undefined;
    return new PackedValidityBitmap(this.bits, this.length);
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
  const bits = new Uint8Array((outLength + 7) >> 3);
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
  const outLength = indices.length;
  if (outLength === 0) return undefined;
  if (!source) {
    // All source cells defined; gather is all defined iff every index in range.
    for (let i = 0; i < outLength; i += 1) {
      const idx = indices[i]!;
      if (idx < 0 || idx >= sourceLength) {
        // Out-of-range gather → emit a bitmap marking those slots invalid.
        const bits = new Uint8Array((outLength + 7) >> 3);
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
  const bits = new Uint8Array((outLength + 7) >> 3);
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
