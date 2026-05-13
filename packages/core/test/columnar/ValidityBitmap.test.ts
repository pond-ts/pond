import { describe, expect, it } from 'vitest';

import {
  MutableValidityBitmap,
  createValidityBitmap,
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
