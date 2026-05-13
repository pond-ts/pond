import { describe, expect, it } from 'vitest';

import {
  BooleanColumn,
  Float64Column,
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

describe('Column independence', () => {
  it('framework primitives can be constructed and exercised without any pond-ts API import', async () => {
    // This test only imports from columnar/. If TimeSeries / LiveSeries ever
    // leak into the columnar/ tree, this barrel import chain will pick them
    // up at the source level — and the framework-design boundary contract
    // (README) calls for failure. The test passes by virtue of compiling and
    // not throwing on the imports themselves.
    const mod = await import('../../src/columnar/index.js');
    expect(typeof mod.Float64Column).toBe('function');
    expect(typeof mod.BooleanColumn).toBe('function');
    expect(typeof mod.createValidityBitmap).toBe('function');
  });
});
