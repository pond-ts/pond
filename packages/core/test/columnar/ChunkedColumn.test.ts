import { describe, expect, it } from 'vitest';

import {
  ArrayColumn,
  BooleanColumn,
  ChunkedArrayColumn,
  ChunkedBooleanColumn,
  ChunkedFloat64Column,
  ChunkedStringColumn,
  Float64Column,
  StringColumn,
  arrayColumnFromArray,
  booleanColumnFromArray,
  float64ColumnFromArray,
  materializeChunkedArray,
  materializeChunkedBoolean,
  materializeChunkedFloat64,
  materializeChunkedString,
  stringColumnFromArray,
  validityFromBits,
} from '../../src/columnar/index.js';

/* -------------------------------------------------------------------------- */
/* ChunkedFloat64Column                                                       */
/* -------------------------------------------------------------------------- */

describe('ChunkedFloat64Column', () => {
  function makeChunked() {
    return new ChunkedFloat64Column([
      new Float64Column(Float64Array.of(1, 2, 3), 3),
      new Float64Column(Float64Array.of(4, 5), 2),
      new Float64Column(Float64Array.of(6, 7, 8, 9), 4),
    ]);
  }

  it('kind and storage discriminators', () => {
    const col = makeChunked();
    expect(col.kind).toBe('number');
    expect(col.storage).toBe('chunked');
  });

  it('length is the sum of chunk lengths', () => {
    const col = makeChunked();
    expect(col.length).toBe(9);
  });

  it('chunkOffsets is the prefix sum + total', () => {
    const col = makeChunked();
    expect(Array.from(col.chunkOffsets)).toEqual([0, 3, 5, 9]);
  });

  it('read crosses chunk boundaries correctly', () => {
    const col = makeChunked();
    expect(col.read(0)).toBe(1);
    expect(col.read(2)).toBe(3);
    expect(col.read(3)).toBe(4); // first row of chunk 1
    expect(col.read(4)).toBe(5);
    expect(col.read(5)).toBe(6); // first row of chunk 2
    expect(col.read(8)).toBe(9);
  });

  it('read out of range returns undefined', () => {
    const col = makeChunked();
    expect(col.read(-1)).toBeUndefined();
    expect(col.read(9)).toBeUndefined();
    expect(col.read(100)).toBeUndefined();
  });

  it('scan visits every row with the global index', () => {
    const col = makeChunked();
    const seen: Array<[number, number]> = [];
    col.scan((v, i) => seen.push([v, i]));
    expect(seen).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
      [4, 3],
      [5, 4],
      [6, 5],
      [7, 6],
      [8, 7],
      [9, 8],
    ]);
  });

  it('aggregate validity is undefined when every chunk is all-defined', () => {
    const col = makeChunked();
    expect(col.validity).toBeUndefined();
  });

  it('aggregate validity is built when any chunk has validity', () => {
    // Chunk 0: rows 0..2, row 1 undefined.
    const c0Validity = validityFromBits(new Uint8Array([0b101]), 3);
    const c0 = new Float64Column(Float64Array.of(1, 999, 3), 3, c0Validity);
    // Chunk 1: rows 0..1, all defined (no per-chunk bitmap).
    const c1 = new Float64Column(Float64Array.of(4, 5), 2);
    const col = new ChunkedFloat64Column([c0, c1]);
    expect(col.validity).toBeDefined();
    // Aggregate at globalIndex 1 (= c0 local 1) is undefined.
    expect(col.read(1)).toBeUndefined();
    // Aggregate at globalIndex 3 (= c1 local 0) is defined.
    expect(col.read(3)).toBe(4);
    expect(col.validity!.definedCount).toBe(4);
  });

  it('aggregate validity is undefined when every chunk has all-defined per-chunk validity', () => {
    // Two chunks, each carrying a per-chunk validity but all bits set.
    const c0Validity = validityFromBits(new Uint8Array([0b111]), 3);
    const c0 = new Float64Column(Float64Array.of(1, 2, 3), 3, c0Validity);
    const c1Validity = validityFromBits(new Uint8Array([0b11]), 2);
    const c1 = new Float64Column(Float64Array.of(4, 5), 2, c1Validity);
    const col = new ChunkedFloat64Column([c0, c1]);
    // Constructor walked both validities and saw all 5 cells defined →
    // aggregate dropped.
    expect(col.validity).toBeUndefined();
  });

  it('sliceByRange within a single chunk returns plain', () => {
    const col = makeChunked();
    // Range [0, 2) lies in chunk 0 — returns plain Float64Column.
    const slice = col.sliceByRange(0, 2);
    expect(slice).toBeInstanceOf(Float64Column);
    expect(slice.length).toBe(2);
    expect(slice.read(0)).toBe(1);
    expect(slice.read(1)).toBe(2);
  });

  it('sliceByRange spanning chunks returns chunked', () => {
    const col = makeChunked();
    // Range [1, 7) spans chunks 0, 1, 2.
    const slice = col.sliceByRange(1, 7);
    expect(slice).toBeInstanceOf(ChunkedFloat64Column);
    expect(slice.length).toBe(6);
    expect(slice.read(0)).toBe(2); // c0[1]
    expect(slice.read(1)).toBe(3); // c0[2]
    expect(slice.read(2)).toBe(4); // c1[0]
    expect(slice.read(3)).toBe(5); // c1[1]
    expect(slice.read(4)).toBe(6); // c2[0]
    expect(slice.read(5)).toBe(7); // c2[1]
  });

  it('sliceByRange empty range returns empty plain', () => {
    const col = makeChunked();
    const slice = col.sliceByRange(3, 3);
    expect(slice).toBeInstanceOf(Float64Column);
    expect(slice.length).toBe(0);
  });

  it('sliceByIndices materializes to plain', () => {
    const col = makeChunked();
    const slice = col.sliceByIndices(Int32Array.of(0, 5, 8));
    expect(slice).toBeInstanceOf(Float64Column);
    expect(slice.length).toBe(3);
    expect(slice.read(0)).toBe(1);
    expect(slice.read(1)).toBe(6);
    expect(slice.read(2)).toBe(9);
  });

  it('sliceByIndices marks out-of-range gather as invalid', () => {
    const col = makeChunked();
    const slice = col.sliceByIndices(Int32Array.of(0, 100, 2));
    expect(slice.read(0)).toBe(1);
    expect(slice.read(1)).toBeUndefined();
    expect(slice.read(2)).toBe(3);
  });

  it('rejects chunks of wrong kind', () => {
    const fakeBool = booleanColumnFromArray([true]) as unknown as Float64Column;
    expect(() => new ChunkedFloat64Column([fakeBool])).toThrow(TypeError);
  });

  it('empty chunks list is a zero-length column', () => {
    const col = new ChunkedFloat64Column([]);
    expect(col.length).toBe(0);
    expect(col.read(0)).toBeUndefined();
  });

  it('mutating the chunks array after construction does not affect the column', () => {
    const chunks = [new Float64Column(Float64Array.of(1, 2, 3), 3)];
    const col = new ChunkedFloat64Column(chunks);
    chunks.push(new Float64Column(Float64Array.of(4), 1));
    expect(col.length).toBe(3);
    expect(col.chunks.length).toBe(1);
  });

  // Pins the binary-search path of `findChunkForRow`. The linear/binary
  // crossover sits at `chunkOffsets.length > 9` (i.e., ≥9 chunks); 16
  // single-row chunks exercises the binary-search branch end-to-end,
  // including the boundary indices that trip off-by-one errors.
  it('read works correctly with many chunks (exercises binary-search path)', () => {
    const chunks: Float64Column[] = [];
    for (let i = 0; i < 16; i += 1) {
      chunks.push(new Float64Column(Float64Array.of(i * 10), 1));
    }
    const col = new ChunkedFloat64Column(chunks);
    expect(col.length).toBe(16);
    // Every row, including chunk-boundary indices.
    for (let i = 0; i < 16; i += 1) {
      expect(col.read(i)).toBe(i * 10);
    }
    // Edges and out-of-range still return undefined.
    expect(col.read(-1)).toBeUndefined();
    expect(col.read(16)).toBeUndefined();
    // sliceByRange spanning a binary-search slice.
    const middle = col.sliceByRange(3, 12);
    expect(middle.length).toBe(9);
    expect(middle.read(0)).toBe(30);
    expect(middle.read(8)).toBe(110);
  });
});

/* -------------------------------------------------------------------------- */
/* ChunkedBooleanColumn                                                       */
/* -------------------------------------------------------------------------- */

describe('ChunkedBooleanColumn', () => {
  function makeChunked() {
    return new ChunkedBooleanColumn([
      booleanColumnFromArray([true, false, true]),
      booleanColumnFromArray([false, true]),
    ]);
  }

  it('kind and storage discriminators', () => {
    const col = makeChunked();
    expect(col.kind).toBe('boolean');
    expect(col.storage).toBe('chunked');
  });

  it('read crosses chunk boundaries', () => {
    const col = makeChunked();
    expect(col.read(0)).toBe(true);
    expect(col.read(1)).toBe(false);
    expect(col.read(2)).toBe(true);
    expect(col.read(3)).toBe(false); // chunk 1, local 0
    expect(col.read(4)).toBe(true); // chunk 1, local 1
  });

  it('scan visits every row with global index', () => {
    const col = makeChunked();
    const seen: Array<[boolean, number]> = [];
    col.scan((v, i) => seen.push([v, i]));
    expect(seen).toEqual([
      [true, 0],
      [false, 1],
      [true, 2],
      [false, 3],
      [true, 4],
    ]);
  });

  it('sliceByRange within single chunk returns plain', () => {
    const col = makeChunked();
    const slice = col.sliceByRange(0, 2);
    expect(slice).toBeInstanceOf(BooleanColumn);
    expect(slice.length).toBe(2);
    expect(slice.read(0)).toBe(true);
    expect(slice.read(1)).toBe(false);
  });

  it('sliceByRange spanning chunks returns chunked', () => {
    const col = makeChunked();
    const slice = col.sliceByRange(2, 5);
    expect(slice).toBeInstanceOf(ChunkedBooleanColumn);
    expect(slice.length).toBe(3);
    expect(slice.read(0)).toBe(true);
    expect(slice.read(1)).toBe(false);
    expect(slice.read(2)).toBe(true);
  });

  it('sliceByIndices materializes to plain', () => {
    const col = makeChunked();
    const slice = col.sliceByIndices(Int32Array.of(0, 3, 4));
    expect(slice).toBeInstanceOf(BooleanColumn);
    expect(slice.read(0)).toBe(true);
    expect(slice.read(1)).toBe(false);
    expect(slice.read(2)).toBe(true);
  });

  it('aggregate validity surfaces per-chunk gaps', () => {
    const c0 = booleanColumnFromArray([true, null, true]);
    const c1 = booleanColumnFromArray([false]);
    const col = new ChunkedBooleanColumn([c0, c1]);
    expect(col.validity).toBeDefined();
    expect(col.read(0)).toBe(true);
    expect(col.read(1)).toBeUndefined();
    expect(col.read(2)).toBe(true);
    expect(col.read(3)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* ChunkedStringColumn                                                        */
/* -------------------------------------------------------------------------- */

describe('ChunkedStringColumn', () => {
  function makeChunked() {
    return new ChunkedStringColumn([
      stringColumnFromArray(['a', 'b', 'a']),
      stringColumnFromArray(['c', 'd']),
    ]);
  }

  it('kind and storage', () => {
    const col = makeChunked();
    expect(col.kind).toBe('string');
    expect(col.storage).toBe('chunked');
  });

  it('read across chunks', () => {
    const col = makeChunked();
    expect(col.read(0)).toBe('a');
    expect(col.read(2)).toBe('a');
    expect(col.read(3)).toBe('c');
    expect(col.read(4)).toBe('d');
  });

  it('scan visits every row', () => {
    const col = makeChunked();
    const seen: string[] = [];
    col.scan((v) => seen.push(v));
    expect(seen).toEqual(['a', 'b', 'a', 'c', 'd']);
  });

  it('sliceByRange within single chunk returns plain', () => {
    const col = makeChunked();
    const slice = col.sliceByRange(0, 2);
    expect(slice).toBeInstanceOf(StringColumn);
    expect(slice.read(0)).toBe('a');
    expect(slice.read(1)).toBe('b');
  });

  it('sliceByRange spanning chunks returns chunked', () => {
    const col = makeChunked();
    const slice = col.sliceByRange(1, 4);
    expect(slice).toBeInstanceOf(ChunkedStringColumn);
    expect(slice.length).toBe(3);
    expect(slice.read(0)).toBe('b');
    expect(slice.read(1)).toBe('a');
    expect(slice.read(2)).toBe('c');
  });

  it('sliceByIndices materializes to plain', () => {
    const col = makeChunked();
    const slice = col.sliceByIndices(Int32Array.of(4, 0, 2));
    expect(slice).toBeInstanceOf(StringColumn);
    expect(slice.read(0)).toBe('d');
    expect(slice.read(1)).toBe('a');
    expect(slice.read(2)).toBe('a');
  });

  it('handles per-chunk dictionary divergence transparently via read', () => {
    // Two chunks with disjoint dictionaries.
    const c0 = stringColumnFromArray(['x', 'y', 'x'], { forceDict: true });
    const c1 = stringColumnFromArray(['p', 'q', 'p'], { forceDict: true });
    const col = new ChunkedStringColumn([c0, c1]);
    expect(col.read(0)).toBe('x');
    expect(col.read(2)).toBe('x');
    expect(col.read(3)).toBe('p');
    expect(col.read(5)).toBe('p');
  });
});

/* -------------------------------------------------------------------------- */
/* ChunkedArrayColumn                                                         */
/* -------------------------------------------------------------------------- */

describe('ChunkedArrayColumn', () => {
  function makeChunked() {
    return new ChunkedArrayColumn([
      arrayColumnFromArray([[1], [2, 3], []]),
      arrayColumnFromArray([['a'], [true, 'b']]),
    ]);
  }

  it('kind and storage', () => {
    const col = makeChunked();
    expect(col.kind).toBe('array');
    expect(col.storage).toBe('chunked');
  });

  it('read across chunks', () => {
    const col = makeChunked();
    expect(col.read(0)).toEqual([1]);
    expect(col.read(1)).toEqual([2, 3]);
    expect(col.read(2)).toEqual([]);
    expect(col.read(3)).toEqual(['a']);
    expect(col.read(4)).toEqual([true, 'b']);
  });

  it('sliceByRange spanning chunks', () => {
    const col = makeChunked();
    const slice = col.sliceByRange(2, 4);
    expect(slice).toBeInstanceOf(ChunkedArrayColumn);
    expect(slice.length).toBe(2);
    expect(slice.read(0)).toEqual([]);
    expect(slice.read(1)).toEqual(['a']);
  });

  it('sliceByIndices materializes to plain', () => {
    const col = makeChunked();
    const slice = col.sliceByIndices(Int32Array.of(4, 0));
    expect(slice).toBeInstanceOf(ArrayColumn);
    expect(slice.read(0)).toEqual([true, 'b']);
    expect(slice.read(1)).toEqual([1]);
  });

  it('aggregate validity handles missing array cells', () => {
    const c0 = arrayColumnFromArray([[1], null, [2]]);
    const c1 = arrayColumnFromArray([[3]]);
    const col = new ChunkedArrayColumn([c0, c1]);
    expect(col.validity).toBeDefined();
    expect(col.read(0)).toEqual([1]);
    expect(col.read(1)).toBeUndefined();
    expect(col.read(2)).toEqual([2]);
    expect(col.read(3)).toEqual([3]);
  });
});

/* -------------------------------------------------------------------------- */
/* materializeChunked* — one-off compact helpers (also covered indirectly via */
/* `materialize(store)` in Concat.test.ts).                                   */
/* -------------------------------------------------------------------------- */

describe('materializeChunked* helpers', () => {
  it('Float64: concatenates buffers and preserves aggregate validity', () => {
    const c0Validity = validityFromBits(new Uint8Array([0b101]), 3);
    const c0 = new Float64Column(Float64Array.of(1, 99, 3), 3, c0Validity);
    const c1 = new Float64Column(Float64Array.of(4, 5), 2);
    const chunked = new ChunkedFloat64Column([c0, c1]);
    const plain = materializeChunkedFloat64(chunked);
    expect(plain).toBeInstanceOf(Float64Column);
    expect(plain.length).toBe(5);
    expect(Array.from(plain.values)).toEqual([1, 99, 3, 4, 5]);
    expect(plain.validity).toBeDefined();
    expect(plain.read(0)).toBe(1);
    expect(plain.read(1)).toBeUndefined();
    expect(plain.read(2)).toBe(3);
    expect(plain.read(3)).toBe(4);
    expect(plain.read(4)).toBe(5);
  });

  it('Boolean: rebuilds the bit buffer for the compacted column', () => {
    const c0 = booleanColumnFromArray([true, false, true]);
    const c1 = booleanColumnFromArray([false, true]);
    const chunked = new ChunkedBooleanColumn([c0, c1]);
    const plain = materializeChunkedBoolean(chunked);
    expect(plain).toBeInstanceOf(BooleanColumn);
    expect(plain.length).toBe(5);
    expect(plain.read(0)).toBe(true);
    expect(plain.read(1)).toBe(false);
    expect(plain.read(2)).toBe(true);
    expect(plain.read(3)).toBe(false);
    expect(plain.read(4)).toBe(true);
  });

  it('String: compacts and re-runs the dict-vs-fallback heuristic', () => {
    // 18 rows total → above DICT_ENCODE_MIN_LENGTH; 2 distinct values
    // → distinct/length = 2/18 well below 0.5 → expect dict.
    const c0 = stringColumnFromArray(
      Array.from({ length: 9 }, (_, i) => (i % 2 === 0 ? 'a' : 'b')),
    );
    const c1 = stringColumnFromArray(Array.from({ length: 9 }, () => 'a'));
    const chunked = new ChunkedStringColumn([c0, c1]);
    const plain = materializeChunkedString(chunked);
    expect(plain).toBeInstanceOf(StringColumn);
    expect(plain.length).toBe(18);
    expect(plain.isDictEncoded).toBe(true);
    expect(plain.read(0)).toBe('a');
    expect(plain.read(8)).toBe('a');
    expect(plain.read(9)).toBe('a');
  });

  it('Array: compacts and derives validity for missing cells', () => {
    const c0 = arrayColumnFromArray([[1], null, [2]]);
    const c1 = arrayColumnFromArray([[3]]);
    const chunked = new ChunkedArrayColumn([c0, c1]);
    const plain = materializeChunkedArray(chunked);
    expect(plain).toBeInstanceOf(ArrayColumn);
    expect(plain.length).toBe(4);
    expect(plain.read(0)).toEqual([1]);
    expect(plain.read(1)).toBeUndefined();
    expect(plain.read(2)).toEqual([2]);
    expect(plain.read(3)).toEqual([3]);
  });

  // Silence unused-import lint when only types are referenced.
  it('float64ColumnFromArray re-exported', () => {
    const col = float64ColumnFromArray([1, 2]);
    expect(col.kind).toBe('number');
  });
});
