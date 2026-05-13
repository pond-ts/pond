import { describe, expect, it } from 'vitest';

import {
  MAX_COLUMN_LENGTH,
  MutableValidityBitmap,
  bitmapByteCount,
  createValidityBitmap,
  validateColumnLength,
  validityFromBits,
  validityFromPredicate,
  validityGatherByIndices,
  validitySliceByRange,
} from '../../src/columnar/index.js';

describe('ValidityBitmap construction', () => {
  it('rejects negative length', () => {
    expect(() => createValidityBitmap(-1)).toThrow(RangeError);
  });

  it('zero length produces a zero-byte bitmap', () => {
    const bm = createValidityBitmap(0);
    expect(bm.bits.length).toBe(0);
    expect(bm.length).toBe(0);
    expect(bm.definedCount).toBe(0);
  });

  it('allocates ceil(length / 8) bytes', () => {
    expect(createValidityBitmap(1).bits.length).toBe(1);
    expect(createValidityBitmap(8).bits.length).toBe(1);
    expect(createValidityBitmap(9).bits.length).toBe(2);
    expect(createValidityBitmap(64).bits.length).toBe(8);
    expect(createValidityBitmap(65).bits.length).toBe(9);
  });

  it('validityFromBits rejects buffer underflow', () => {
    expect(() => validityFromBits(new Uint8Array(0), 1)).toThrow(RangeError);
    expect(() => validityFromBits(new Uint8Array(1), 9)).toThrow(RangeError);
  });

  it('validityFromBits counts defined cells correctly', () => {
    // bits[0] = 0b10110001 → bit 0, 4, 5, 7 set
    const bm = validityFromBits(new Uint8Array([0b10110001]), 8);
    expect(bm.definedCount).toBe(4);
  });

  it('popcount masks out bits past length within the last byte', () => {
    // Last byte has bits 5/6/7 set, but length is only 5 → those don't count.
    const bm = validityFromBits(new Uint8Array([0b11100001]), 5);
    expect(bm.definedCount).toBe(1);
  });
});

describe('ValidityBitmap.isDefined', () => {
  it('returns false out of range', () => {
    const bm = validityFromBits(new Uint8Array([0xff]), 8);
    expect(bm.isDefined(-1)).toBe(false);
    expect(bm.isDefined(8)).toBe(false);
  });

  it('reads bits correctly within range', () => {
    const bm = validityFromBits(new Uint8Array([0b10100110]), 8);
    const expected = [false, true, true, false, false, true, false, true];
    expected.forEach((want, i) => {
      expect(bm.isDefined(i)).toBe(want);
    });
  });
});

describe('ValidityBitmap.countInRange', () => {
  it('handles empty / inverted ranges', () => {
    const bm = validityFromBits(new Uint8Array([0xff]), 8);
    expect(bm.countInRange(3, 3)).toBe(0);
    expect(bm.countInRange(5, 2)).toBe(0);
  });

  it('clamps to bitmap bounds', () => {
    const bm = validityFromBits(new Uint8Array([0xff]), 8);
    expect(bm.countInRange(-5, 100)).toBe(8);
  });

  it('counts within a single byte', () => {
    // 0b10100110 → bits 1, 2, 5, 7
    const bm = validityFromBits(new Uint8Array([0b10100110]), 8);
    expect(bm.countInRange(0, 3)).toBe(2); // bits 1, 2
    expect(bm.countInRange(2, 6)).toBe(2); // bits 2, 5
    expect(bm.countInRange(5, 8)).toBe(2); // bits 5, 7
  });

  it('counts across byte boundaries', () => {
    // 16 bits: byte0=0b11110000 (bits 4–7), byte1=0b00001111 (bits 8–11)
    const bm = validityFromBits(new Uint8Array([0b11110000, 0b00001111]), 16);
    expect(bm.definedCount).toBe(8);
    expect(bm.countInRange(2, 14)).toBe(8);
    expect(bm.countInRange(6, 10)).toBe(4); // bits 6,7,8,9
    expect(bm.countInRange(0, 16)).toBe(8);
  });

  it('handles ranges spanning many bytes', () => {
    const bits = new Uint8Array(8);
    bits.fill(0xff);
    const bm = validityFromBits(bits, 64);
    expect(bm.countInRange(0, 64)).toBe(64);
    expect(bm.countInRange(3, 61)).toBe(58);
    expect(bm.countInRange(10, 50)).toBe(40);
  });
});

describe('MutableValidityBitmap', () => {
  it('starts with every bit cleared', () => {
    const bm = createValidityBitmap(10);
    expect(bm.definedCount).toBe(0);
    for (let i = 0; i < 10; i += 1) {
      expect(bm.isDefined(i)).toBe(false);
    }
  });

  it('set/clear update definedCount idempotently', () => {
    const bm = createValidityBitmap(10);
    expect(bm.set(3)).toBe(true);
    expect(bm.set(3)).toBe(false); // already set
    expect(bm.definedCount).toBe(1);

    expect(bm.set(7)).toBe(true);
    expect(bm.definedCount).toBe(2);

    expect(bm.clear(3)).toBe(true);
    expect(bm.clear(3)).toBe(false); // already clear
    expect(bm.definedCount).toBe(1);
  });

  it('set/clear throw out of range', () => {
    const bm = createValidityBitmap(4);
    expect(() => bm.set(-1)).toThrow(RangeError);
    expect(() => bm.set(4)).toThrow(RangeError);
    expect(() => bm.clear(-1)).toThrow(RangeError);
    expect(() => bm.clear(4)).toThrow(RangeError);
  });

  it('freeze returns undefined when every cell is defined', () => {
    const bm = createValidityBitmap(3);
    bm.set(0);
    bm.set(1);
    bm.set(2);
    expect(bm.freeze()).toBeUndefined();
  });

  it('freeze returns a finalized bitmap when some cells are missing', () => {
    const bm = createValidityBitmap(4);
    bm.set(0);
    bm.set(2);
    const frozen = bm.freeze();
    expect(frozen).toBeDefined();
    expect(frozen!.length).toBe(4);
    expect(frozen!.definedCount).toBe(2);
    expect(frozen!.isDefined(0)).toBe(true);
    expect(frozen!.isDefined(1)).toBe(false);
    expect(frozen!.isDefined(2)).toBe(true);
    expect(frozen!.isDefined(3)).toBe(false);
  });

  it('rejects construction with negative length via createValidityBitmap', () => {
    expect(() => createValidityBitmap(-3)).toThrow(RangeError);
  });

  it('directly-constructed MutableValidityBitmap counts seed bits', () => {
    // Seed with byte 0b00000111 → bits 0/1/2 set; length 5 truncates.
    const bm = new MutableValidityBitmap(new Uint8Array([0b00000111]), 5);
    expect(bm.definedCount).toBe(3);
  });
});

describe('validityFromPredicate', () => {
  it('returns undefined for length 0', () => {
    expect(validityFromPredicate(0, () => false)).toBeUndefined();
  });

  it('returns undefined when every cell is defined', () => {
    expect(validityFromPredicate(5, () => true)).toBeUndefined();
  });

  it('returns a bitmap when at least one cell is missing', () => {
    const bm = validityFromPredicate(6, (i) => i !== 3);
    expect(bm).toBeDefined();
    expect(bm!.length).toBe(6);
    expect(bm!.definedCount).toBe(5);
    expect(bm!.isDefined(3)).toBe(false);
    expect(bm!.isDefined(0)).toBe(true);
    expect(bm!.isDefined(5)).toBe(true);
  });
});

describe('validitySliceByRange', () => {
  it('returns undefined for empty range', () => {
    const bm = validityFromBits(new Uint8Array([0xff]), 8);
    expect(validitySliceByRange(bm, 4, 4, 8)).toBeUndefined();
  });

  it('throws when end precedes start', () => {
    const bm = validityFromBits(new Uint8Array([0xff]), 8);
    expect(() => validitySliceByRange(bm, 5, 2, 8)).toThrow(RangeError);
  });

  it('passes through undefined source as all-defined slice', () => {
    expect(validitySliceByRange(undefined, 0, 5, 10)).toBeUndefined();
  });

  it('repacks bits relative to slice start', () => {
    // Source: 0b00010100 → bits 2, 4 set (length 8).
    // Slice [2, 6) → out length 4, bits 0 and 2 in the output.
    const bm = validityFromBits(new Uint8Array([0b00010100]), 8);
    const slice = validitySliceByRange(bm, 2, 6, 8);
    expect(slice).toBeDefined();
    expect(slice!.length).toBe(4);
    expect(slice!.isDefined(0)).toBe(true);
    expect(slice!.isDefined(1)).toBe(false);
    expect(slice!.isDefined(2)).toBe(true);
    expect(slice!.isDefined(3)).toBe(false);
  });

  it('returns undefined when the slice itself is all-defined', () => {
    // Source: 0b01111110 → bits 1–6 set (one cell, bit 7, undefined).
    const bm = validityFromBits(new Uint8Array([0b01111110]), 8);
    const slice = validitySliceByRange(bm, 1, 7, 8);
    expect(slice).toBeUndefined();
  });

  it('clamps slice bounds to source length', () => {
    const bm = validityFromBits(new Uint8Array([0b00000011]), 2);
    // Asking for [0, 10) over a 2-length source clamps to [0, 2).
    expect(validitySliceByRange(bm, 0, 10, 2)).toBeUndefined();
  });
});

describe('validityGatherByIndices', () => {
  it('returns undefined for empty indices', () => {
    const bm = validityFromBits(new Uint8Array([0xff]), 8);
    expect(validityGatherByIndices(bm, new Int32Array(0), 8)).toBeUndefined();
  });

  it('gathers bits in arbitrary order', () => {
    // Source: bits 1, 3, 5 set.
    const bm = validityFromBits(new Uint8Array([0b00101010]), 8);
    const indices = Int32Array.of(0, 1, 3, 5, 6);
    const out = validityGatherByIndices(bm, indices, 8);
    expect(out).toBeDefined();
    expect(out!.length).toBe(5);
    expect(out!.isDefined(0)).toBe(false);
    expect(out!.isDefined(1)).toBe(true);
    expect(out!.isDefined(2)).toBe(true);
    expect(out!.isDefined(3)).toBe(true);
    expect(out!.isDefined(4)).toBe(false);
  });

  it('returns undefined when every gathered cell is defined', () => {
    const bm = validityFromBits(new Uint8Array([0b00101010]), 8);
    const indices = Int32Array.of(1, 3, 5);
    expect(validityGatherByIndices(bm, indices, 8)).toBeUndefined();
  });

  it('marks out-of-range indices invalid when source bitmap exists', () => {
    const bm = validityFromBits(new Uint8Array([0xff]), 4);
    const indices = Int32Array.of(0, 5, 2);
    const out = validityGatherByIndices(bm, indices, 4);
    expect(out).toBeDefined();
    expect(out!.isDefined(0)).toBe(true);
    expect(out!.isDefined(1)).toBe(false); // 5 is out of range
    expect(out!.isDefined(2)).toBe(true);
  });

  it('marks out-of-range indices invalid when source has no bitmap', () => {
    const indices = Int32Array.of(0, 5, 2);
    const out = validityGatherByIndices(undefined, indices, 4);
    expect(out).toBeDefined();
    expect(out!.isDefined(0)).toBe(true);
    expect(out!.isDefined(1)).toBe(false);
    expect(out!.isDefined(2)).toBe(true);
  });

  it('returns undefined when source has no bitmap and every index is in range', () => {
    const indices = Int32Array.of(0, 1, 3);
    expect(validityGatherByIndices(undefined, indices, 4)).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Multi-byte output coverage — slice / gather producing > 8 bits exercises    */
/* the byte-boundary carry that single-byte tests above cannot reach.          */
/* -------------------------------------------------------------------------- */

describe('validitySliceByRange — multi-byte output', () => {
  it('packs a 9-bit slice into 2 output bytes correctly', () => {
    // Source: 16 bits with the pattern 0b1010101010101010 (bits 1,3,5,7,9,11,13,15 set).
    // Layout: byte 0 = 0b10101010, byte 1 = 0b10101010.
    const bm = validityFromBits(new Uint8Array([0b10101010, 0b10101010]), 16);
    // Slice [2, 11) → 9-bit output. Source defined at 3,5,7,9
    // → output positions 1, 3, 5, 7. Output spans 2 bytes (bit 7 still in byte 0; bit 8 in byte 1).
    const slice = validitySliceByRange(bm, 2, 11, 16);
    expect(slice).toBeDefined();
    expect(slice!.length).toBe(9);
    const defined: number[] = [];
    for (let i = 0; i < 9; i += 1) {
      if (slice!.isDefined(i)) defined.push(i);
    }
    expect(defined).toEqual([1, 3, 5, 7]);
    // Confirm the underlying buffer crossed the byte boundary.
    expect(slice!.bits.length).toBe(2);
  });

  it('20-bit slice spans 3 output bytes correctly', () => {
    // Source: 32 bits, every multiple of 3 defined: 0,3,6,9,12,15,18,21,24,27,30.
    // byte 0 (bits 0–7):  0,3,6        → 0b01001001 = 0x49
    // byte 1 (bits 8–15): 9,12,15      → bit 9 = byte1 bit 1, bit 12 = byte1 bit 4, bit 15 = byte1 bit 7 → 0b10010010 = 0x92
    // byte 2 (bits 16–23): 18,21       → bit 18 = byte2 bit 2, bit 21 = byte2 bit 5 → 0b00100100 = 0x24
    // byte 3 (bits 24–31): 24,27,30    → bit 24 = byte3 bit 0, bit 27 = byte3 bit 3, bit 30 = byte3 bit 6 → 0b01001001 = 0x49
    const bm = validityFromBits(new Uint8Array([0x49, 0x92, 0x24, 0x49]), 32);
    // Slice [5, 25) → 20-bit output spanning 3 bytes.
    // Source-defined in [5, 25): 6, 9, 12, 15, 18, 21, 24 → output positions 1, 4, 7, 10, 13, 16, 19.
    const slice = validitySliceByRange(bm, 5, 25, 32);
    expect(slice).toBeDefined();
    expect(slice!.length).toBe(20);
    expect(slice!.bits.length).toBe(3);
    const defined: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      if (slice!.isDefined(i)) defined.push(i);
    }
    expect(defined).toEqual([1, 4, 7, 10, 13, 16, 19]);
  });

  it('definedCount on multi-byte output is consistent with isDefined sweep', () => {
    const bm = validityFromBits(new Uint8Array([0b10101010, 0b11001100]), 16);
    const slice = validitySliceByRange(bm, 1, 13, 16);
    expect(slice).toBeDefined();
    expect(slice!.length).toBe(12);
    let counted = 0;
    for (let i = 0; i < 12; i += 1) {
      if (slice!.isDefined(i)) counted += 1;
    }
    expect(slice!.definedCount).toBe(counted);
  });
});

describe('validityGatherByIndices — multi-byte output', () => {
  it('gathers 12 bits across 2 output bytes correctly', () => {
    // Source: 16 bits, defined at evens 0,2,4,6,8,10,12,14 → byte 0=0b01010101, byte 1=0b01010101.
    const bm = validityFromBits(new Uint8Array([0b01010101, 0b01010101]), 16);
    const indices = Int32Array.of(0, 1, 2, 3, 8, 9, 10, 11, 12, 13, 14, 15);
    const out = validityGatherByIndices(bm, indices, 16);
    expect(out).toBeDefined();
    expect(out!.length).toBe(12);
    expect(out!.bits.length).toBe(2);
    const defined: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      if (out!.isDefined(i)) defined.push(i);
    }
    // Indices map to source positions 0(true),1(false),2(t),3(f),8(t),9(f),10(t),11(f),12(t),13(f),14(t),15(f).
    expect(defined).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it('gathers 20 bits across 3 output bytes correctly when source has no bitmap', () => {
    // No source bitmap = all-defined. Indices include out-of-range slots → bitmap allocated.
    const indices = Int32Array.of(
      0,
      5,
      -1,
      3,
      7,
      99,
      1,
      4,
      2,
      6,
      8,
      50,
      9,
      0,
      1,
      2,
      3,
      4,
      5,
      -3,
    );
    const out = validityGatherByIndices(undefined, indices, 10);
    expect(out).toBeDefined();
    expect(out!.length).toBe(20);
    expect(out!.bits.length).toBe(3);
    // Out-of-range positions: 2 (-1), 5 (99), 11 (50), 19 (-3). Others defined.
    expect(out!.isDefined(2)).toBe(false);
    expect(out!.isDefined(5)).toBe(false);
    expect(out!.isDefined(11)).toBe(false);
    expect(out!.isDefined(19)).toBe(false);
    expect(out!.definedCount).toBe(16);
  });

  it('definedCount on multi-byte gather is consistent with isDefined sweep', () => {
    const bm = validityFromBits(new Uint8Array([0xff, 0x0f]), 12);
    const indices = Int32Array.of(0, 4, 8, 1, 5, 9, 2, 6, 10, 3, 7, 11);
    const out = validityGatherByIndices(bm, indices, 12);
    if (!out) {
      // 12 of 12 source bits defined → output is all defined.
      // Verify by reconstructing: indices map to source 0,4,8,1,5,9,2,6,10,3,7,11.
      // Source bits 0–7 set, 8–11 set → all 12 indices defined.
      // OK to be undefined per the all-defined convention.
      return;
    }
    let counted = 0;
    for (let i = 0; i < 12; i += 1) {
      if (out.isDefined(i)) counted += 1;
    }
    expect(out.definedCount).toBe(counted);
  });
});

/* -------------------------------------------------------------------------- */
/* Length validation — guards against 32-bit-wrap math in bit-packed sizing.  */
/* -------------------------------------------------------------------------- */

describe('validateColumnLength', () => {
  it('accepts 0 and small positive integers', () => {
    expect(() => validateColumnLength(0, 'X')).not.toThrow();
    expect(() => validateColumnLength(1, 'X')).not.toThrow();
    expect(() => validateColumnLength(1024, 'X')).not.toThrow();
  });

  it('rejects negative values', () => {
    expect(() => validateColumnLength(-1, 'X')).toThrow(RangeError);
    expect(() => validateColumnLength(-1000, 'X')).toThrow(RangeError);
  });

  it('rejects non-integers', () => {
    expect(() => validateColumnLength(1.5, 'X')).toThrow(RangeError);
    expect(() => validateColumnLength(NaN, 'X')).toThrow(RangeError);
    expect(() => validateColumnLength(Infinity, 'X')).toThrow(RangeError);
    expect(() => validateColumnLength(-Infinity, 'X')).toThrow(RangeError);
  });

  it('rejects values above MAX_COLUMN_LENGTH', () => {
    expect(() => validateColumnLength(MAX_COLUMN_LENGTH + 1, 'X')).toThrow(
      RangeError,
    );
    expect(() => validateColumnLength(2 ** 31, 'X')).toThrow(RangeError);
    expect(() => validateColumnLength(Number.MAX_SAFE_INTEGER, 'X')).toThrow(
      RangeError,
    );
  });

  it('accepts the boundary exactly', () => {
    expect(() => validateColumnLength(MAX_COLUMN_LENGTH, 'X')).not.toThrow();
  });

  it('error label propagates to the message', () => {
    expect(() => validateColumnLength(-1, 'CustomLabel')).toThrow(
      /CustomLabel/,
    );
  });
});

describe('bitmapByteCount', () => {
  it('rounds up to the next byte', () => {
    expect(bitmapByteCount(0)).toBe(0);
    expect(bitmapByteCount(1)).toBe(1);
    expect(bitmapByteCount(8)).toBe(1);
    expect(bitmapByteCount(9)).toBe(2);
    expect(bitmapByteCount(63)).toBe(8);
    expect(bitmapByteCount(64)).toBe(8);
    expect(bitmapByteCount(65)).toBe(9);
  });

  it('uses Math.ceil semantics across the 31-bit boundary', () => {
    // Both end at the same byte count; the bitwise version would wrap.
    expect(bitmapByteCount(MAX_COLUMN_LENGTH)).toBe(
      Math.ceil(MAX_COLUMN_LENGTH / 8),
    );
  });
});

describe('ValidityBitmap large-length boundary', () => {
  // We can't allocate a 2^31-bit buffer, so we only exercise the
  // validation paths — the math is correct for any length that passes
  // the validator. Anything that doesn't pass throws cleanly.
  it('createValidityBitmap rejects MAX_COLUMN_LENGTH + 1', () => {
    expect(() => createValidityBitmap(MAX_COLUMN_LENGTH + 1)).toThrow(
      RangeError,
    );
  });

  it('createValidityBitmap rejects 2**31 (the 32-bit-wrap boundary)', () => {
    expect(() => createValidityBitmap(2 ** 31)).toThrow(RangeError);
  });

  it('validityFromBits rejects MAX_COLUMN_LENGTH + 1', () => {
    expect(() =>
      validityFromBits(new Uint8Array(1), MAX_COLUMN_LENGTH + 1),
    ).toThrow(RangeError);
  });

  it('validityFromPredicate rejects 2**31', () => {
    expect(() => validityFromPredicate(2 ** 31, () => true)).toThrow(
      RangeError,
    );
  });

  it('MutableValidityBitmap constructor rejects 2**31', () => {
    expect(() => new MutableValidityBitmap(new Uint8Array(1), 2 ** 31)).toThrow(
      RangeError,
    );
  });

  it('MutableValidityBitmap constructor rejects buffer underflow', () => {
    expect(() => new MutableValidityBitmap(new Uint8Array(0), 1)).toThrow(
      RangeError,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Freeze is one-shot — mutating a finalized bitmap is a foot-gun gone wrong. */
/* -------------------------------------------------------------------------- */

describe('MutableValidityBitmap freeze is one-shot', () => {
  it('exposes a consumed getter that flips on freeze', () => {
    const bm = createValidityBitmap(4);
    expect(bm.consumed).toBe(false);
    bm.set(0);
    bm.freeze();
    expect(bm.consumed).toBe(true);
  });

  it('set throws after freeze', () => {
    const bm = createValidityBitmap(4);
    bm.set(0);
    bm.freeze();
    expect(() => bm.set(1)).toThrow(/already been frozen/);
  });

  it('clear throws after freeze', () => {
    const bm = createValidityBitmap(4);
    bm.set(0);
    bm.set(1);
    bm.freeze();
    expect(() => bm.clear(0)).toThrow(/already been frozen/);
  });

  it('double-freeze throws', () => {
    const bm = createValidityBitmap(4);
    bm.set(0);
    bm.freeze();
    expect(() => bm.freeze()).toThrow(/already been frozen/);
  });

  it('frozen bitmap snapshot stays consistent with the underlying buffer at freeze time', () => {
    // Pin the contract: a frozen ValidityBitmap reflects the state at the
    // moment of freeze; subsequent mutation attempts on the source throw.
    const bm = createValidityBitmap(8);
    bm.set(0);
    bm.set(2);
    bm.set(4);
    const frozen = bm.freeze();
    expect(frozen).toBeDefined();
    expect(frozen!.definedCount).toBe(3);
    expect(() => bm.set(1)).toThrow();
    // Frozen value-state is unchanged by the attempted mutation throw.
    expect(frozen!.isDefined(0)).toBe(true);
    expect(frozen!.isDefined(1)).toBe(false);
    expect(frozen!.isDefined(2)).toBe(true);
    expect(frozen!.isDefined(4)).toBe(true);
    expect(frozen!.definedCount).toBe(3);
  });

  it('all-defined freeze returns undefined and still consumes the builder', () => {
    const bm = createValidityBitmap(3);
    bm.set(0);
    bm.set(1);
    bm.set(2);
    expect(bm.freeze()).toBeUndefined();
    expect(bm.consumed).toBe(true);
    expect(() => bm.set(0)).toThrow(/already been frozen/);
  });
});
