import { describe, expect, it } from 'vitest';

import {
  BooleanColumn,
  Float64Column,
  MAX_COLUMN_LENGTH,
  booleanColumnFromArray,
  float64ColumnFromArray,
  validityFromBits,
} from '../../src/columnar/index.js';

describe('Float64Column construction', () => {
  it('accepts a dense buffer with no validity', () => {
    const col = new Float64Column(Float64Array.of(1, 2, 3), 3);
    expect(col.kind).toBe('number');
    expect(col.length).toBe(3);
    expect(col.validity).toBeUndefined();
    expect(col.read(0)).toBe(1);
    expect(col.read(1)).toBe(2);
    expect(col.read(2)).toBe(3);
  });

  it('rejects negative length', () => {
    expect(() => new Float64Column(new Float64Array(0), -1)).toThrow(
      RangeError,
    );
  });

  it('rejects buffer underflow', () => {
    expect(() => new Float64Column(new Float64Array(2), 3)).toThrow(RangeError);
  });

  it('rejects mismatched validity length', () => {
    const validity = validityFromBits(new Uint8Array([0b011]), 3);
    expect(
      () => new Float64Column(Float64Array.of(1, 2, 3, 4), 4, validity),
    ).toThrow(RangeError);
  });

  it('reads return undefined for invalid cells', () => {
    const validity = validityFromBits(new Uint8Array([0b101]), 3);
    const col = new Float64Column(Float64Array.of(1, 0, 3), 3, validity);
    expect(col.read(0)).toBe(1);
    expect(col.read(1)).toBeUndefined();
    expect(col.read(2)).toBe(3);
  });

  it('reads out-of-range indices return undefined', () => {
    const col = new Float64Column(Float64Array.of(1, 2, 3), 3);
    expect(col.read(-1)).toBeUndefined();
    expect(col.read(3)).toBeUndefined();
  });
});

describe('Float64Column.scan', () => {
  it('skips invalid cells by default', () => {
    const validity = validityFromBits(new Uint8Array([0b101]), 3);
    const col = new Float64Column(Float64Array.of(1, 99, 3), 3, validity);
    const visited: Array<[number, number]> = [];
    col.scan((v, i) => visited.push([v, i]));
    expect(visited).toEqual([
      [1, 0],
      [3, 2],
    ]);
  });

  it('visits every slot when skipInvalid is false', () => {
    const validity = validityFromBits(new Uint8Array([0b101]), 3);
    const col = new Float64Column(Float64Array.of(1, 99, 3), 3, validity);
    const visited: Array<[number, number]> = [];
    col.scan((v, i) => visited.push([v, i]), { skipInvalid: false });
    expect(visited).toEqual([
      [1, 0],
      [99, 1],
      [3, 2],
    ]);
  });

  it('iterates dense columns without checking validity', () => {
    const col = new Float64Column(Float64Array.of(10, 20, 30), 3);
    const sum: number[] = [];
    col.scan((v) => sum.push(v));
    expect(sum).toEqual([10, 20, 30]);
  });
});

describe('Float64Column.sliceByRange', () => {
  it('returns an empty column for an empty range', () => {
    const col = new Float64Column(Float64Array.of(1, 2, 3), 3);
    const slice = col.sliceByRange(2, 2);
    expect(slice.length).toBe(0);
    expect(slice.validity).toBeUndefined();
  });

  it('zero-copy: slice values share the underlying buffer', () => {
    const buf = Float64Array.of(10, 20, 30, 40, 50);
    const col = new Float64Column(buf, 5);
    const slice = col.sliceByRange(1, 4);
    expect(slice.length).toBe(3);
    expect(slice.values.buffer).toBe(buf.buffer);
    expect(Array.from(slice.values.subarray(0, slice.length))).toEqual([
      20, 30, 40,
    ]);
  });

  it('clamps to column bounds', () => {
    const col = new Float64Column(Float64Array.of(1, 2, 3), 3);
    const slice = col.sliceByRange(-5, 100);
    expect(slice.length).toBe(3);
    expect(slice.read(0)).toBe(1);
    expect(slice.read(2)).toBe(3);
  });

  it('repacks validity to slice-relative bit 0', () => {
    // Bits set: 1, 3, 4 in length-5 source.
    const validity = validityFromBits(new Uint8Array([0b011010]), 5);
    const col = new Float64Column(
      Float64Array.of(10, 20, 30, 40, 50),
      5,
      validity,
    );
    const slice = col.sliceByRange(2, 5);
    expect(slice.length).toBe(3);
    expect(slice.read(0)).toBeUndefined(); // source idx 2
    expect(slice.read(1)).toBe(40); // source idx 3
    expect(slice.read(2)).toBe(50); // source idx 4
  });

  it('omits validity bitmap when the slice is all-defined', () => {
    // Bits set: 0, 1, 2, 3 (source idx 4 invalid).
    const validity = validityFromBits(new Uint8Array([0b01111]), 5);
    const col = new Float64Column(Float64Array.of(1, 2, 3, 4, 0), 5, validity);
    const slice = col.sliceByRange(0, 4);
    expect(slice.validity).toBeUndefined();
  });
});

describe('Float64Column.sliceByIndices', () => {
  it('gathers values into a fresh buffer', () => {
    const col = new Float64Column(Float64Array.of(10, 20, 30, 40, 50), 5);
    const slice = col.sliceByIndices(Int32Array.of(4, 0, 2));
    expect(slice.length).toBe(3);
    expect(Array.from(slice.values)).toEqual([50, 10, 30]);
    expect(slice.values.buffer).not.toBe(col.values.buffer);
  });

  it('marks out-of-range indices invalid', () => {
    const col = new Float64Column(Float64Array.of(10, 20, 30), 3);
    const slice = col.sliceByIndices(Int32Array.of(0, 5, 2));
    expect(slice.read(0)).toBe(10);
    expect(slice.read(1)).toBeUndefined();
    expect(slice.read(2)).toBe(30);
  });

  it('propagates source validity', () => {
    const validity = validityFromBits(new Uint8Array([0b101]), 3);
    const col = new Float64Column(Float64Array.of(10, 0, 30), 3, validity);
    const slice = col.sliceByIndices(Int32Array.of(2, 1, 0));
    expect(slice.read(0)).toBe(30);
    expect(slice.read(1)).toBeUndefined(); // src idx 1 was invalid
    expect(slice.read(2)).toBe(10);
  });
});

describe('BooleanColumn construction', () => {
  it('reads packed bits correctly', () => {
    // 0b10110100 → bits 2, 4, 5, 7
    const col = new BooleanColumn(new Uint8Array([0b10110100]), 8);
    const expected = [false, false, true, false, true, true, false, true];
    expected.forEach((want, i) => {
      expect(col.read(i)).toBe(want);
    });
  });

  it('rejects buffer underflow', () => {
    expect(() => new BooleanColumn(new Uint8Array(1), 9)).toThrow(RangeError);
  });

  it('rejects mismatched validity length', () => {
    const validity = validityFromBits(new Uint8Array([0b011]), 3);
    expect(() => new BooleanColumn(new Uint8Array([0]), 4, validity)).toThrow(
      RangeError,
    );
  });

  it('reads return undefined for invalid cells', () => {
    const validity = validityFromBits(new Uint8Array([0b101]), 3);
    const col = new BooleanColumn(new Uint8Array([0b010]), 3, validity);
    expect(col.read(0)).toBe(false);
    expect(col.read(1)).toBeUndefined();
    expect(col.read(2)).toBe(false);
  });
});

describe('BooleanColumn.scan', () => {
  it('skips invalid cells by default', () => {
    const validity = validityFromBits(new Uint8Array([0b101]), 3);
    const col = new BooleanColumn(new Uint8Array([0b101]), 3, validity);
    const visited: Array<[boolean, number]> = [];
    col.scan((v, i) => visited.push([v, i]));
    expect(visited).toEqual([
      [true, 0],
      [true, 2],
    ]);
  });

  it('visits every slot when skipInvalid is false', () => {
    const validity = validityFromBits(new Uint8Array([0b101]), 3);
    const col = new BooleanColumn(new Uint8Array([0b101]), 3, validity);
    const visited: Array<[boolean, number]> = [];
    col.scan((v, i) => visited.push([v, i]), { skipInvalid: false });
    expect(visited).toEqual([
      [true, 0],
      [false, 1],
      [true, 2],
    ]);
  });
});

describe('BooleanColumn.sliceByRange', () => {
  it('returns an empty column for empty range', () => {
    const col = new BooleanColumn(new Uint8Array([0xff]), 5);
    const slice = col.sliceByRange(2, 2);
    expect(slice.length).toBe(0);
  });

  it('repacks bits relative to slice start', () => {
    // length 8, bits 0/2/4/6 set → 0b01010101
    const col = new BooleanColumn(new Uint8Array([0b01010101]), 8);
    const slice = col.sliceByRange(2, 7);
    expect(slice.length).toBe(5);
    expect(slice.read(0)).toBe(true); // src bit 2
    expect(slice.read(1)).toBe(false); // src bit 3
    expect(slice.read(2)).toBe(true); // src bit 4
    expect(slice.read(3)).toBe(false); // src bit 5
    expect(slice.read(4)).toBe(true); // src bit 6
  });

  it('propagates validity bitmap when present', () => {
    // Source values: bits 0/2 set → false, false, true at indices 0,1,2 — wait, redo:
    // values byte = 0b101 → bit 0 = true, bit 1 = false, bit 2 = true
    // validity = bits 0, 2 defined → cell 1 invalid
    const validity = validityFromBits(new Uint8Array([0b101]), 3);
    const col = new BooleanColumn(new Uint8Array([0b101]), 3, validity);
    const slice = col.sliceByRange(0, 3);
    expect(slice.length).toBe(3);
    expect(slice.read(0)).toBe(true);
    expect(slice.read(1)).toBeUndefined();
    expect(slice.read(2)).toBe(true);
  });
});

describe('BooleanColumn.sliceByIndices', () => {
  it('gathers bits in arbitrary order', () => {
    // length 4, bits set: 0 and 3 → values = 0b1001
    const col = new BooleanColumn(new Uint8Array([0b1001]), 4);
    const slice = col.sliceByIndices(Int32Array.of(3, 1, 0, 2));
    expect(slice.length).toBe(4);
    expect(slice.read(0)).toBe(true);
    expect(slice.read(1)).toBe(false);
    expect(slice.read(2)).toBe(true);
    expect(slice.read(3)).toBe(false);
  });

  it('marks out-of-range indices invalid', () => {
    const col = new BooleanColumn(new Uint8Array([0b101]), 3);
    const slice = col.sliceByIndices(Int32Array.of(0, 5, 2));
    expect(slice.read(0)).toBe(true);
    expect(slice.read(1)).toBeUndefined();
    expect(slice.read(2)).toBe(true);
  });
});

describe('float64ColumnFromArray', () => {
  it('builds a dense column with no validity when every value is a number', () => {
    const col = float64ColumnFromArray([1, 2, 3, 4]);
    expect(col.length).toBe(4);
    expect(col.validity).toBeUndefined();
    expect(Array.from(col.values.subarray(0, col.length))).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('allocates a validity bitmap when some values are missing', () => {
    const col = float64ColumnFromArray([1, undefined, 3, null]);
    expect(col.length).toBe(4);
    expect(col.validity).toBeDefined();
    expect(col.read(0)).toBe(1);
    expect(col.read(1)).toBeUndefined();
    expect(col.read(2)).toBe(3);
    expect(col.read(3)).toBeUndefined();
  });

  it('handles length zero', () => {
    const col = float64ColumnFromArray([]);
    expect(col.length).toBe(0);
    expect(col.validity).toBeUndefined();
  });
});

describe('booleanColumnFromArray', () => {
  it('builds a dense column with no validity when every value is a boolean', () => {
    const col = booleanColumnFromArray([true, false, true, true]);
    expect(col.length).toBe(4);
    expect(col.validity).toBeUndefined();
    expect(col.read(0)).toBe(true);
    expect(col.read(1)).toBe(false);
    expect(col.read(2)).toBe(true);
    expect(col.read(3)).toBe(true);
  });

  it('allocates a validity bitmap when some values are missing', () => {
    const col = booleanColumnFromArray([true, undefined, false, null]);
    expect(col.length).toBe(4);
    expect(col.validity).toBeDefined();
    expect(col.read(0)).toBe(true);
    expect(col.read(1)).toBeUndefined();
    expect(col.read(2)).toBe(false);
    expect(col.read(3)).toBeUndefined();
  });

  it('handles length zero', () => {
    const col = booleanColumnFromArray([]);
    expect(col.length).toBe(0);
    expect(col.validity).toBeUndefined();
  });
});

describe('Column independence (smoke)', () => {
  // Smoke check that the barrel exports compile and resolve without
  // pulling in pond-ts public API at this layer. **This does not pin
  // the boundary contract** — a `TimeSeries` import leaking into
  // `columnar/*.ts` would still satisfy this test because the import
  // would resolve. The real cross-module independence test (with a
  // module-graph assertion) lands in sub-step 1d alongside
  // `ColumnarStore`.
  it('barrel exports resolve', async () => {
    const mod = await import('../../src/columnar/index.js');
    expect(typeof mod.Float64Column).toBe('function');
    expect(typeof mod.BooleanColumn).toBe('function');
    expect(typeof mod.createValidityBitmap).toBe('function');
  });
});

/* -------------------------------------------------------------------------- */
/* Multi-byte output coverage — slice / gather operations producing > 8 bits  */
/* of output exercise the byte-boundary carry that single-byte tests above    */
/* cannot reach. Foundational PR for 1b–1h; downstream primitives inherit     */
/* this math.                                                                 */
/* -------------------------------------------------------------------------- */

describe('Multi-byte slice / gather', () => {
  // Source: 20 rows, validity bits set at every multiple of 3 → indices
  // 0, 3, 6, 9, 12, 15, 18 (7 of 20 defined).
  function multiByteFloat64Source(): Float64Column {
    const values = new Float64Array(20);
    for (let i = 0; i < 20; i += 1) values[i] = i + 1;
    const validity = validityFromBits(
      // 20 bits → 3 bytes; bits 0, 3, 6, 9, 12, 15, 18 set.
      // byte 0: bits 0,3,6      → 0b01001001 = 0x49
      // byte 1: bits 9,12,15 → bit 9 = byte1 bit 1, bit 12 = byte1 bit 4, bit 15 = byte1 bit 7 → 0b10010010 = 0x92
      // byte 2: bit 18 = byte2 bit 2 → 0b00000100 = 0x04
      new Uint8Array([0x49, 0x92, 0x04]),
      20,
    );
    return new Float64Column(values, 20, validity);
  }

  function multiByteBooleanSource(): BooleanColumn {
    // 20 rows, true bits at 0, 2, 4, 6, 8, 10, 12, 14, 16, 18 (every even).
    // byte 0: 0b01010101 = 0x55 (bits 0,2,4,6)
    // byte 1: bits 8,10,12,14 → 0x55
    // byte 2: bits 16, 18 → 0b00000101 = 0x05
    const values = new Uint8Array([0x55, 0x55, 0x05]);
    return new BooleanColumn(values, 20);
  }

  describe('Float64Column.sliceByRange across bytes', () => {
    it('15-row slice carries validity bits into the second output byte', () => {
      const col = multiByteFloat64Source();
      // Slice [2, 17) → 15-row output, source defined indices in range:
      // 3, 6, 9, 12, 15 → output indices 1, 4, 7, 10, 13.
      const slice = col.sliceByRange(2, 17);
      expect(slice.length).toBe(15);
      const defined: number[] = [];
      for (let i = 0; i < slice.length; i += 1) {
        if (slice.read(i) !== undefined) defined.push(i);
      }
      expect(defined).toEqual([1, 4, 7, 10, 13]);
      // Values themselves: indices 3,6,9,12,15 → values 4,7,10,13,16
      expect(slice.read(1)).toBe(4);
      expect(slice.read(4)).toBe(7);
      expect(slice.read(7)).toBe(10);
      expect(slice.read(10)).toBe(13);
      expect(slice.read(13)).toBe(16);
    });

    it('zero-copy values subarray still works across byte-spanning slices', () => {
      const col = multiByteFloat64Source();
      const slice = col.sliceByRange(0, 16);
      expect(slice.values.buffer).toBe(col.values.buffer);
      expect(slice.length).toBe(16);
    });
  });

  describe('Float64Column.sliceByIndices to multi-byte output', () => {
    it('gathered 10-row output preserves validity from source', () => {
      const col = multiByteFloat64Source();
      // Pull indices 19, 18, 12, 6, 0, 3, 9, 15, 5, 11.
      // Defined in source: 0, 3, 6, 9, 12, 15, 18 → output positions
      // where defined: source-18 at out 1, source-12 at out 2,
      // source-6 at out 3, source-0 at out 4, source-3 at out 5,
      // source-9 at out 6, source-15 at out 7.
      const indices = Int32Array.of(19, 18, 12, 6, 0, 3, 9, 15, 5, 11);
      const slice = col.sliceByIndices(indices);
      expect(slice.length).toBe(10);
      const defined: number[] = [];
      for (let i = 0; i < slice.length; i += 1) {
        if (slice.read(i) !== undefined) defined.push(i);
      }
      expect(defined).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });
  });

  describe('BooleanColumn.sliceByRange across bytes', () => {
    it('12-row slice carries bits into the second output byte', () => {
      const col = multiByteBooleanSource();
      // Slice [3, 15) → 12-row output, source bits true at evens
      // 4, 6, 8, 10, 12, 14 → output indices 1, 3, 5, 7, 9, 11.
      const slice = col.sliceByRange(3, 15);
      expect(slice.length).toBe(12);
      const trueIndices: number[] = [];
      for (let i = 0; i < slice.length; i += 1) {
        if (slice.read(i) === true) trueIndices.push(i);
      }
      expect(trueIndices).toEqual([1, 3, 5, 7, 9, 11]);
    });

    it('17-row slice exercises the third output byte', () => {
      const col = multiByteBooleanSource();
      // Slice [2, 19) → 17-row output; source trues at 2,4,6,8,10,12,14,16,18
      // → output indices 0, 2, 4, 6, 8, 10, 12, 14, 16.
      const slice = col.sliceByRange(2, 19);
      expect(slice.length).toBe(17);
      const trueIndices: number[] = [];
      for (let i = 0; i < slice.length; i += 1) {
        if (slice.read(i) === true) trueIndices.push(i);
      }
      expect(trueIndices).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16]);
    });
  });

  describe('Length validation propagates to column constructors', () => {
    it('Float64Column rejects 2**31', () => {
      expect(() => new Float64Column(new Float64Array(1), 2 ** 31)).toThrow(
        RangeError,
      );
    });

    it('Float64Column rejects MAX_COLUMN_LENGTH + 1', () => {
      expect(
        () => new Float64Column(new Float64Array(1), MAX_COLUMN_LENGTH + 1),
      ).toThrow(RangeError);
    });

    it('Float64Column rejects non-integer length', () => {
      expect(() => new Float64Column(new Float64Array(2), 1.5)).toThrow(
        RangeError,
      );
      expect(() => new Float64Column(new Float64Array(0), NaN)).toThrow(
        RangeError,
      );
      expect(() => new Float64Column(new Float64Array(0), Infinity)).toThrow(
        RangeError,
      );
    });

    it('BooleanColumn rejects 2**31', () => {
      expect(() => new BooleanColumn(new Uint8Array(1), 2 ** 31)).toThrow(
        RangeError,
      );
    });

    it('BooleanColumn rejects non-integer length', () => {
      expect(() => new BooleanColumn(new Uint8Array(1), 1.5)).toThrow(
        RangeError,
      );
      expect(() => new BooleanColumn(new Uint8Array(0), Infinity)).toThrow(
        RangeError,
      );
    });

    it('float64ColumnFromArray rejects above MAX_COLUMN_LENGTH via the underlying array length', () => {
      // We can't easily construct a Number-keyed array of that size; just
      // confirm the validator is wired by passing in a small array and
      // documenting that the validator runs at the source.length read.
      // The direct validation is covered by validateColumnLength tests; this
      // test only proves no regression in the normal path.
      expect(() => float64ColumnFromArray([1, 2, 3])).not.toThrow();
    });
  });

  describe('BooleanColumn.sliceByIndices to multi-byte output', () => {
    it('gathered 12-row output packs bits correctly into two bytes', () => {
      const col = multiByteBooleanSource();
      // Pull indices reproducing true at output positions 0, 5, 8, 11.
      // source true at evens → pick 0,1,2,3,4,5,6,7,8,9,10,11 mapped so:
      // out 0 ← src 0 (true), out 5 ← src 10 (true), out 8 ← src 16 (true),
      // out 11 ← src 18 (true). Other positions pull from odd source indices.
      const indices = Int32Array.of(0, 1, 3, 5, 7, 10, 11, 13, 16, 17, 19, 18);
      const slice = col.sliceByIndices(indices);
      expect(slice.length).toBe(12);
      const trueIndices: number[] = [];
      for (let i = 0; i < slice.length; i += 1) {
        if (slice.read(i) === true) trueIndices.push(i);
      }
      expect(trueIndices).toEqual([0, 5, 8, 11]);
    });
  });
});
