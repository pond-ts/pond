import { describe, expect, it } from 'vitest';

import {
  DICT_ENCODE_MIN_LENGTH,
  DICT_ENCODE_RATIO,
  MAX_COLUMN_LENGTH,
  StringColumn,
  buildDictionaryIndex,
  estimateDictionaryBytes,
  remapColumnToDictionary,
  remapIndicesToDictionary,
  stringColumnDictEncoded,
  stringColumnFallback,
  stringColumnFromArray,
  validityFromBits,
} from '../../src/columnar/index.js';

/* -------------------------------------------------------------------------- */
/* Construction & read — dict-encoded mode                                    */
/* -------------------------------------------------------------------------- */

describe('StringColumn construction (dict-encoded)', () => {
  it('builds a dict-encoded column with shared dictionary', () => {
    const col = stringColumnDictEncoded(
      ['us-east', 'us-west'],
      Int32Array.of(0, 1, 0, 0, 1),
    );
    expect(col.kind).toBe('string');
    expect(col.isDictEncoded).toBe(true);
    expect(col.length).toBe(5);
    expect(col.dictionary).toEqual(['us-east', 'us-west']);
    expect(col.indices).toBeDefined();
    expect(col.fallback).toBeUndefined();
    expect(col.validity).toBeUndefined();
  });

  it('reads through the dictionary', () => {
    const col = stringColumnDictEncoded(
      ['a', 'b', 'c'],
      Int32Array.of(2, 0, 1, 2, 0),
    );
    expect(col.read(0)).toBe('c');
    expect(col.read(1)).toBe('a');
    expect(col.read(2)).toBe('b');
    expect(col.read(3)).toBe('c');
    expect(col.read(4)).toBe('a');
  });

  it('reads out-of-range as undefined', () => {
    const col = stringColumnDictEncoded(['x'], Int32Array.of(0));
    expect(col.read(-1)).toBeUndefined();
    expect(col.read(1)).toBeUndefined();
  });

  it('respects validity bitmap', () => {
    const validity = validityFromBits(new Uint8Array([0b101]), 3);
    const col = stringColumnDictEncoded(
      ['a', 'b'],
      Int32Array.of(0, 1, 1),
      validity,
    );
    expect(col.read(0)).toBe('a');
    expect(col.read(1)).toBeUndefined();
    expect(col.read(2)).toBe('b');
  });

  it('rejects out-of-range dictionary indices at construction', () => {
    expect(() =>
      stringColumnDictEncoded(['x', 'y'], Int32Array.of(0, 2)),
    ).toThrow(RangeError);
    expect(() =>
      stringColumnDictEncoded(['x', 'y'], Int32Array.of(0, -1)),
    ).toThrow(RangeError);
  });

  it('rejects validity-length mismatch', () => {
    const validity = validityFromBits(new Uint8Array([0xff]), 5);
    expect(() =>
      stringColumnDictEncoded(['a'], Int32Array.of(0, 0, 0), validity),
    ).toThrow(RangeError);
  });
});

/* -------------------------------------------------------------------------- */
/* Construction & read — fallback mode                                        */
/* -------------------------------------------------------------------------- */

describe('StringColumn construction (fallback)', () => {
  it('builds a fallback column', () => {
    const col = stringColumnFallback(['hello', 'world', 'foo']);
    expect(col.kind).toBe('string');
    expect(col.isDictEncoded).toBe(false);
    expect(col.length).toBe(3);
    expect(col.fallback).toEqual(['hello', 'world', 'foo']);
    expect(col.dictionary).toBeUndefined();
    expect(col.indices).toBeUndefined();
  });

  it('derives validity from undefined slots when none is supplied', () => {
    const col = stringColumnFallback(['a', undefined, 'b', undefined]);
    expect(col.validity).toBeDefined();
    expect(col.validity!.definedCount).toBe(2);
    expect(col.read(0)).toBe('a');
    expect(col.read(1)).toBeUndefined();
    expect(col.read(2)).toBe('b');
    expect(col.read(3)).toBeUndefined();
  });

  it('omits validity bitmap when every slot is defined', () => {
    const col = stringColumnFallback(['a', 'b', 'c']);
    expect(col.validity).toBeUndefined();
  });

  it('accepts an explicit validity bitmap', () => {
    const validity = validityFromBits(new Uint8Array([0b101]), 3);
    const col = stringColumnFallback(['a', 'b', 'c'], validity);
    expect(col.validity).toBe(validity);
    expect(col.read(1)).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Mutual exclusion of internal modes                                         */
/* -------------------------------------------------------------------------- */

describe('StringColumn mode validation', () => {
  it('rejects construction with both dict and fallback', () => {
    expect(
      () =>
        new StringColumn(2, {
          dictionary: ['x'],
          indices: Int32Array.of(0, 0),
          fallback: ['x', 'x'],
        }),
    ).toThrow(/exactly one of/);
  });

  it('rejects construction with neither dict nor fallback', () => {
    expect(() => new StringColumn(2, {})).toThrow(/exactly one of/);
  });

  it('rejects construction with dict but no indices', () => {
    expect(() => new StringColumn(2, { dictionary: ['x'] })).toThrow(
      /exactly one of/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Length validation                                                          */
/* -------------------------------------------------------------------------- */

describe('StringColumn length validation', () => {
  it('rejects 2**31', () => {
    expect(() =>
      stringColumnDictEncoded(['x'], new Int32Array(2 ** 31)),
    ).toThrow(RangeError);
  });

  it('rejects negative length via direct constructor', () => {
    expect(() => new StringColumn(-1, { fallback: [] })).toThrow(RangeError);
  });

  it('rejects MAX_COLUMN_LENGTH + 1', () => {
    // Can't actually allocate; just verify validation runs.
    expect(
      () =>
        new StringColumn(MAX_COLUMN_LENGTH + 1, {
          fallback: [],
        }),
    ).toThrow(RangeError);
  });
});

/* -------------------------------------------------------------------------- */
/* scan                                                                       */
/* -------------------------------------------------------------------------- */

describe('StringColumn.scan (dict-encoded)', () => {
  it('iterates strings in row order', () => {
    const col = stringColumnDictEncoded(
      ['a', 'b'],
      Int32Array.of(1, 0, 1, 1, 0),
    );
    const visited: Array<[string, number]> = [];
    col.scan((v, i) => visited.push([v, i]));
    expect(visited).toEqual([
      ['b', 0],
      ['a', 1],
      ['b', 2],
      ['b', 3],
      ['a', 4],
    ]);
  });

  it('skips invalid cells by default', () => {
    const validity = validityFromBits(new Uint8Array([0b101]), 3);
    const col = stringColumnDictEncoded(
      ['x', 'y'],
      Int32Array.of(0, 1, 0),
      validity,
    );
    const visited: Array<[string, number]> = [];
    col.scan((v, i) => visited.push([v, i]));
    expect(visited).toEqual([
      ['x', 0],
      ['x', 2],
    ]);
  });

  it('visits every slot when skipInvalid is false; invalid rows get "" sentinel', () => {
    const validity = validityFromBits(new Uint8Array([0b101]), 3);
    const col = stringColumnDictEncoded(
      ['x', 'y'],
      Int32Array.of(0, 1, 0),
      validity,
    );
    const visited: Array<[string, number]> = [];
    col.scan((v, i) => visited.push([v, i]), { skipInvalid: false });
    expect(visited).toEqual([
      ['x', 0],
      ['', 1], // sentinel, not the placeholder dict[1] = 'y'
      ['x', 2],
    ]);
  });
});

describe('StringColumn.scan (fallback)', () => {
  it('iterates strings, skipping undefined slots', () => {
    const col = stringColumnFallback(['a', undefined, 'b', undefined, 'c']);
    const visited: Array<[string, number]> = [];
    col.scan((v, i) => visited.push([v, i]));
    expect(visited).toEqual([
      ['a', 0],
      ['b', 2],
      ['c', 4],
    ]);
  });

  it('respects explicit validity bitmap', () => {
    const validity = validityFromBits(new Uint8Array([0b011]), 3);
    const col = stringColumnFallback(['a', 'b', 'c'], validity);
    const visited: string[] = [];
    col.scan((v) => visited.push(v));
    expect(visited).toEqual(['a', 'b']);
  });
});

/* -------------------------------------------------------------------------- */
/* sliceByRange                                                               */
/* -------------------------------------------------------------------------- */

describe('StringColumn.sliceByRange (dict-encoded)', () => {
  it('indices are a subarray view sharing the source buffer', () => {
    const indices = Int32Array.of(0, 1, 0, 2, 1);
    const col = stringColumnDictEncoded(['a', 'b', 'c'], indices);
    const slice = col.sliceByRange(1, 4);
    expect(slice.length).toBe(3);
    expect(slice.indices!.buffer).toBe(indices.buffer);
    expect(Array.from(slice.indices!)).toEqual([1, 0, 2]);
    // Dictionary identity shared by reference.
    expect(slice.dictionary).toBe(col.dictionary);
  });

  it('preserves read semantics across slice', () => {
    const col = stringColumnDictEncoded(
      ['a', 'b', 'c'],
      Int32Array.of(0, 1, 2, 0, 1),
    );
    const slice = col.sliceByRange(1, 4);
    expect(slice.read(0)).toBe('b');
    expect(slice.read(1)).toBe('c');
    expect(slice.read(2)).toBe('a');
  });

  it('propagates validity', () => {
    const validity = validityFromBits(new Uint8Array([0b10101]), 5);
    const col = stringColumnDictEncoded(
      ['x'],
      Int32Array.of(0, 0, 0, 0, 0),
      validity,
    );
    const slice = col.sliceByRange(1, 4);
    expect(slice.length).toBe(3);
    expect(slice.read(0)).toBeUndefined();
    expect(slice.read(1)).toBe('x');
    expect(slice.read(2)).toBeUndefined();
  });

  it('empty range returns a zero-length column', () => {
    const col = stringColumnDictEncoded(['x'], Int32Array.of(0, 0, 0));
    const slice = col.sliceByRange(2, 2);
    expect(slice.length).toBe(0);
  });
});

describe('StringColumn.sliceByRange (fallback)', () => {
  it('produces a sliced array', () => {
    const col = stringColumnFallback(['a', 'b', 'c', 'd', 'e']);
    const slice = col.sliceByRange(1, 4);
    expect(slice.length).toBe(3);
    expect(slice.fallback).toEqual(['b', 'c', 'd']);
  });

  it('clamps slice bounds to column length', () => {
    const col = stringColumnFallback(['a', 'b']);
    const slice = col.sliceByRange(-5, 100);
    expect(slice.length).toBe(2);
    expect(slice.read(0)).toBe('a');
    expect(slice.read(1)).toBe('b');
  });
});

/* -------------------------------------------------------------------------- */
/* sliceByIndices                                                             */
/* -------------------------------------------------------------------------- */

describe('StringColumn.sliceByIndices (dict-encoded)', () => {
  it('gathers indices, retaining the dictionary by reference', () => {
    const col = stringColumnDictEncoded(
      ['a', 'b', 'c'],
      Int32Array.of(0, 1, 2, 0, 1),
    );
    const slice = col.sliceByIndices(Int32Array.of(4, 0, 2));
    expect(slice.length).toBe(3);
    expect(slice.dictionary).toBe(col.dictionary);
    expect(Array.from(slice.indices!)).toEqual([1, 0, 2]);
    expect(slice.read(0)).toBe('b');
    expect(slice.read(1)).toBe('a');
    expect(slice.read(2)).toBe('c');
  });

  it('marks out-of-range source indices invalid', () => {
    const col = stringColumnDictEncoded(['a'], Int32Array.of(0, 0));
    const slice = col.sliceByIndices(Int32Array.of(0, 5, 1));
    expect(slice.read(0)).toBe('a');
    expect(slice.read(1)).toBeUndefined();
    expect(slice.read(2)).toBe('a');
  });
});

describe('StringColumn.sliceByIndices (fallback)', () => {
  it('gathers strings into a new array', () => {
    const col = stringColumnFallback(['a', 'b', 'c', 'd']);
    const slice = col.sliceByIndices(Int32Array.of(3, 1, 0));
    expect(slice.length).toBe(3);
    expect(slice.fallback).toEqual(['d', 'b', 'a']);
  });

  it('marks out-of-range source indices undefined', () => {
    const col = stringColumnFallback(['a', 'b']);
    const slice = col.sliceByIndices(Int32Array.of(0, 5, 1));
    expect(slice.read(0)).toBe('a');
    expect(slice.read(1)).toBeUndefined();
    expect(slice.read(2)).toBe('b');
  });
});

/* -------------------------------------------------------------------------- */
/* stringColumnFromArray — heuristic encoding choice                          */
/* -------------------------------------------------------------------------- */

describe('stringColumnFromArray', () => {
  it('dict-encodes when distinct/length ratio is low', () => {
    // 20 rows, 3 distinct values → ratio 0.15, well below default 0.5.
    const source = Array.from({ length: 20 }, (_, i) => ['a', 'b', 'c'][i % 3]);
    const col = stringColumnFromArray(source);
    expect(col.isDictEncoded).toBe(true);
    expect(col.dictionary).toEqual(['a', 'b', 'c']);
    expect(col.length).toBe(20);
  });

  it('falls back when every row is distinct', () => {
    const source = Array.from({ length: 20 }, (_, i) => `unique-${i}`);
    const col = stringColumnFromArray(source);
    expect(col.isDictEncoded).toBe(false);
    expect(col.length).toBe(20);
  });

  it('falls back for short inputs even with low cardinality', () => {
    // length < DICT_ENCODE_MIN_LENGTH (16) → fallback regardless of ratio.
    const source = ['a', 'a', 'b', 'a'];
    const col = stringColumnFromArray(source);
    expect(col.isDictEncoded).toBe(false);
    expect(col.length).toBe(4);
  });

  it('honors forceDict override', () => {
    const source = ['a', 'b', 'c', 'd'];
    const col = stringColumnFromArray(source, { forceDict: true });
    expect(col.isDictEncoded).toBe(true);
  });

  it('honors forceFallback override', () => {
    const source = Array.from({ length: 20 }, () => 'same');
    const col = stringColumnFromArray(source, { forceFallback: true });
    expect(col.isDictEncoded).toBe(false);
  });

  it('rejects setting both forceDict and forceFallback', () => {
    expect(() =>
      stringColumnFromArray(['a'], { forceDict: true, forceFallback: true }),
    ).toThrow(/mutually exclusive/);
  });

  it('handles undefined / null entries via validity bitmap', () => {
    const source = ['a', undefined, 'b', null, 'a'];
    const col = stringColumnFromArray(source, { forceDict: true });
    expect(col.isDictEncoded).toBe(true);
    expect(col.validity).toBeDefined();
    expect(col.validity!.definedCount).toBe(3);
    expect(col.read(0)).toBe('a');
    expect(col.read(1)).toBeUndefined();
    expect(col.read(2)).toBe('b');
    expect(col.read(3)).toBeUndefined();
    expect(col.read(4)).toBe('a');
  });

  it('handles all-missing dict-encoded source via placeholder + validity', () => {
    const source: ReadonlyArray<undefined> = [
      undefined,
      undefined,
      undefined,
      undefined,
    ];
    const col = stringColumnFromArray(source, { forceDict: true });
    expect(col.isDictEncoded).toBe(true);
    expect(col.dictionary!.length).toBeGreaterThan(0);
    expect(col.validity!.definedCount).toBe(0);
    expect(col.read(0)).toBeUndefined();
  });

  it('empty source dict-encodes by default', () => {
    const col = stringColumnFromArray([]);
    expect(col.length).toBe(0);
    expect(col.isDictEncoded).toBe(true);
    expect(col.dictionary!.length).toBe(0);
  });

  it('empty source with forceFallback yields fallback mode', () => {
    const col = stringColumnFromArray([], { forceFallback: true });
    expect(col.length).toBe(0);
    expect(col.isDictEncoded).toBe(false);
  });

  it('custom dictRatio threshold honored', () => {
    // 4 distinct in 16 → ratio 0.25. Default would dict-encode.
    const source = Array.from(
      { length: 16 },
      (_, i) => ['a', 'b', 'c', 'd'][i % 4],
    );
    const tight = stringColumnFromArray(source, { dictRatio: 0.1 });
    expect(tight.isDictEncoded).toBe(false);

    const loose = stringColumnFromArray(source, { dictRatio: 0.5 });
    expect(loose.isDictEncoded).toBe(true);
  });

  it('custom minDictLength threshold honored', () => {
    // length 3, distinct/length = 1/3, well below the 0.5 ratio.
    // Default minDictLength (16) blocks dict encoding; lowering it allows.
    const source = ['a', 'a', 'a'];
    const aggressive = stringColumnFromArray(source, { minDictLength: 2 });
    expect(aggressive.isDictEncoded).toBe(true);

    const conservative = stringColumnFromArray(source, { minDictLength: 100 });
    expect(conservative.isDictEncoded).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Heuristic constants                                                        */
/* -------------------------------------------------------------------------- */

describe('Heuristic constants', () => {
  it('DICT_ENCODE_RATIO has a sane default', () => {
    expect(DICT_ENCODE_RATIO).toBeGreaterThan(0);
    expect(DICT_ENCODE_RATIO).toBeLessThan(1);
  });

  it('DICT_ENCODE_MIN_LENGTH is positive', () => {
    expect(DICT_ENCODE_MIN_LENGTH).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Dictionary operations                                                      */
/* -------------------------------------------------------------------------- */

describe('buildDictionaryIndex', () => {
  it('inverts a dictionary array', () => {
    const dict = ['us-east', 'us-west', 'eu-west'];
    const map = buildDictionaryIndex(dict);
    expect(map.size).toBe(3);
    expect(map.get('us-east')).toBe(0);
    expect(map.get('us-west')).toBe(1);
    expect(map.get('eu-west')).toBe(2);
    expect(map.get('unknown')).toBeUndefined();
  });

  it('handles empty dictionaries', () => {
    expect(buildDictionaryIndex([]).size).toBe(0);
  });
});

describe('estimateDictionaryBytes', () => {
  it('returns 0 for an empty dictionary', () => {
    expect(estimateDictionaryBytes([])).toBe(0);
  });

  it('uses 2 bytes per code unit', () => {
    expect(estimateDictionaryBytes(['hi', 'hey'])).toBe(2 * 2 + 3 * 2);
  });

  it('scales with string length', () => {
    const dict = ['short', 'much-longer-string'];
    expect(estimateDictionaryBytes(dict)).toBe(
      'short'.length * 2 + 'much-longer-string'.length * 2,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Dictionary identity across slice/gather                                    */
/* -------------------------------------------------------------------------- */

describe('Dictionary sharing across operations', () => {
  it('sliceByRange shares dictionary reference', () => {
    const col = stringColumnFromArray(
      Array.from({ length: 20 }, (_, i) => ['a', 'b', 'c'][i % 3]),
    );
    const slice = col.sliceByRange(2, 10);
    expect(slice.dictionary).toBe(col.dictionary);
  });

  it('sliceByIndices shares dictionary reference', () => {
    const col = stringColumnFromArray(
      Array.from({ length: 20 }, (_, i) => ['a', 'b'][i % 2]),
    );
    const slice = col.sliceByIndices(Int32Array.of(5, 10, 15));
    expect(slice.dictionary).toBe(col.dictionary);
  });

  it('dictionary is retained even when slicing produces unused entries', () => {
    // Pin the documented contract: sliced output keeps the full source
    // dictionary even if some entries are no longer referenced.
    const col = stringColumnDictEncoded(
      ['a', 'b', 'c', 'd'],
      Int32Array.of(0, 1, 2, 3),
    );
    const slice = col.sliceByIndices(Int32Array.of(0));
    expect(slice.dictionary).toEqual(['a', 'b', 'c', 'd']);
    expect(slice.dictionary!.length).toBe(4);
  });
});

/* -------------------------------------------------------------------------- */
/* Empty-source slice/gather — pins the "invalid cells skip dict range check"  */
/* contract added in response to L2 review on PR #133.                        */
/* -------------------------------------------------------------------------- */

describe('Empty dict-encoded column slice/gather', () => {
  it('sliceByIndices on an empty dict-encoded column produces all-invalid output', () => {
    // Previously: constructor's index-range check rejected the `0`
    // placeholder against an empty dictionary, throwing RangeError.
    // Now: the check skips invalid cells (since validity says they're
    // missing), so the output is a length-K all-invalid column.
    const col = stringColumnFromArray([]);
    expect(col.length).toBe(0);
    expect(col.isDictEncoded).toBe(true);

    const slice = col.sliceByIndices(Int32Array.of(0, 1, 2));
    expect(slice.length).toBe(3);
    expect(slice.isDictEncoded).toBe(true);
    expect(slice.dictionary!.length).toBe(0);
    expect(slice.validity).toBeDefined();
    expect(slice.validity!.definedCount).toBe(0);
    expect(slice.read(0)).toBeUndefined();
    expect(slice.read(1)).toBeUndefined();
    expect(slice.read(2)).toBeUndefined();
  });

  it('sliceByIndices with mixed in-range / out-of-range source indices', () => {
    // Source has dict ['a','b'] and length 2. Gather indices 0 (in),
    // 5 (out), 1 (in) → output validity marks position 1 invalid; the
    // other positions resolve to valid dictionary entries.
    const col = stringColumnDictEncoded(['a', 'b'], Int32Array.of(0, 1));
    const slice = col.sliceByIndices(Int32Array.of(0, 5, 1));
    expect(slice.length).toBe(3);
    expect(slice.read(0)).toBe('a');
    expect(slice.read(1)).toBeUndefined();
    expect(slice.read(2)).toBe('b');
  });

  it('constructor accepts indices = 0 for invalid cells when dictionary is empty', () => {
    // Direct construction path mirroring sliceByIndices output.
    const validity = validityFromBits(new Uint8Array([0b000]), 3);
    const col = new StringColumn(3, {
      dictionary: [],
      indices: Int32Array.of(0, 0, 0),
      validity,
    });
    expect(col.dictionary).toEqual([]);
    expect(col.length).toBe(3);
    expect(col.read(0)).toBeUndefined();
    expect(col.read(1)).toBeUndefined();
    expect(col.read(2)).toBeUndefined();
  });

  it('constructor still rejects in-range indices that exceed an empty dictionary', () => {
    // Validity says cell is defined but dictionary is empty → must throw.
    expect(
      () => new StringColumn(1, { dictionary: [], indices: Int32Array.of(0) }),
    ).toThrow(RangeError);
  });
});

/* -------------------------------------------------------------------------- */
/* Heuristic boundary tests — pin both sides of length / ratio thresholds.    */
/* -------------------------------------------------------------------------- */

describe('stringColumnFromArray heuristic boundaries', () => {
  it('length = 15 (one below DICT_ENCODE_MIN_LENGTH) falls back', () => {
    // Even with cardinality ratio well below 0.5, length must reach
    // DICT_ENCODE_MIN_LENGTH for dict mode under defaults.
    const source = Array.from({ length: 15 }, (_, i) => ['a', 'b'][i % 2]);
    expect(stringColumnFromArray(source).isDictEncoded).toBe(false);
  });

  it('length = 16 (exactly DICT_ENCODE_MIN_LENGTH) dict-encodes', () => {
    const source = Array.from({ length: 16 }, (_, i) => ['a', 'b'][i % 2]);
    expect(stringColumnFromArray(source).isDictEncoded).toBe(true);
  });

  it('distinct/length = 0.5 (the threshold) falls to fallback (strict <)', () => {
    // 20 rows, 10 distinct → ratio 0.5 exactly. Strict `<` means fallback.
    const source = Array.from({ length: 20 }, (_, i) => `v${i % 10}`);
    expect(stringColumnFromArray(source).isDictEncoded).toBe(false);
  });

  it('distinct/length just below threshold dict-encodes', () => {
    // 20 rows, 9 distinct → ratio 0.45, below 0.5.
    const source = Array.from({ length: 20 }, (_, i) => `v${i % 9}`);
    expect(stringColumnFromArray(source).isDictEncoded).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Codex round-2 regression: scan never passes undefined to a `string` callback. */
/* -------------------------------------------------------------------------- */

describe('scan row-aligned every-slot contract (skipInvalid: false)', () => {
  // Codex round-2 raised that `StringColumn.scan(skipInvalid: false)`
  // must match the shared `ColumnBase` contract — the callback fires
  // for every row in `[0, length)`. Invalid rows whose effective value
  // would be `undefined` receive the empty-string sentinel `''`, the
  // string-mode equivalent of the numeric columns' `0` / `false`
  // buffer-default. To distinguish a real `''` from a sentinel `''`,
  // callers consult `column.validity` directly — identical pattern
  // to numeric columns' `0` sentinel.
  it('empty-dict all-invalid column fires the callback length times, sentinel = ""', () => {
    const col = stringColumnFromArray([]);
    const slice = col.sliceByIndices(Int32Array.of(0, 1, 2));
    const visited: Array<[string, number]> = [];
    slice.scan(
      (v, i) => {
        expect(typeof v).toBe('string'); // never undefined
        visited.push([v, i]);
      },
      { skipInvalid: false },
    );
    expect(visited).toEqual([
      ['', 0],
      ['', 1],
      ['', 2],
    ]);
    // Validity is the source of truth for distinguishing sentinel from real ''.
    expect(slice.validity!.definedCount).toBe(0);
  });

  it('mixed-validity dict-encoded scan: invalid rows get "" sentinel even when placeholder points to a real dict entry', () => {
    // The placeholder index `0` points at `dict[0] = 'a'`, but the
    // framework contract is that invalid cells receive the documented
    // `''` sentinel. This pins no-mode-divergence: dict-encoded and
    // fallback behave identically for invalid rows under `skipInvalid:
    // false`.
    const col = stringColumnDictEncoded(['a', 'b'], Int32Array.of(0, 1));
    const slice = col.sliceByIndices(Int32Array.of(0, 5, 1));
    const visited: Array<[string, number]> = [];
    slice.scan(
      (v, i) => {
        expect(typeof v).toBe('string');
        visited.push([v, i]);
      },
      { skipInvalid: false },
    );
    expect(visited).toEqual([
      ['a', 0],
      ['', 1], // sentinel, NOT dict[0] = 'a'
      ['b', 2],
    ]);
    expect(slice.validity!.isDefined(1)).toBe(false);
  });

  it('no mode divergence: same input shape produces same scan output in dict-encoded vs fallback', () => {
    // The exact same logical column (['a' valid, missing, 'b' valid])
    // expressed in both representations should produce identical scan
    // output under skipInvalid: false.
    const validity = validityFromBits(new Uint8Array([0b101]), 3);
    const dictCol = stringColumnDictEncoded(
      ['a', 'b'],
      Int32Array.of(0, 0, 1),
      validity,
    );
    const fallbackCol = stringColumnFallback(['a', undefined, 'b'], validity);

    const dictVisited: Array<[string, number]> = [];
    dictCol.scan((v, i) => dictVisited.push([v, i]), { skipInvalid: false });

    const fbVisited: Array<[string, number]> = [];
    fallbackCol.scan((v, i) => fbVisited.push([v, i]), {
      skipInvalid: false,
    });

    expect(dictVisited).toEqual(fbVisited);
    expect(dictVisited).toEqual([
      ['a', 0],
      ['', 1],
      ['b', 2],
    ]);
  });

  it('fallback with explicit invalid validity: callback receives "" sentinel for the invalid row', () => {
    const validity = validityFromBits(new Uint8Array([0b101]), 3);
    const col = stringColumnFallback(['a', undefined, 'b'], validity);
    const visited: Array<[string, number]> = [];
    col.scan((v, i) => visited.push([v, i]), { skipInvalid: false });
    expect(visited).toEqual([
      ['a', 0],
      ['', 1], // sentinel
      ['b', 2],
    ]);
  });

  it('skipInvalid: true (default) still skips invalid rows', () => {
    const col = stringColumnDictEncoded(['a', 'b'], Int32Array.of(0, 1));
    const slice = col.sliceByIndices(Int32Array.of(0, 5, 1));
    const visited: Array<[string, number]> = [];
    slice.scan((v, i) => visited.push([v, i]));
    expect(visited).toEqual([
      ['a', 0],
      ['b', 2],
    ]);
  });

  it('row-aligned consumer: scan(skipInvalid:false) output is exactly column.length entries', () => {
    // Pin the contract that row-aligned consumers depend on.
    const col = stringColumnFromArray(
      Array.from({ length: 25 }, (_, i) => (i % 5 === 0 ? undefined : `v${i}`)),
    );
    let count = 0;
    col.scan(() => (count += 1), { skipInvalid: false });
    expect(count).toBe(col.length);
  });

  it('dict-encoded scan with no validity bitmap visits every slot', () => {
    const col = stringColumnDictEncoded(['x', 'y'], Int32Array.of(0, 1));
    const visited: string[] = [];
    col.scan((v) => visited.push(v));
    expect(visited).toEqual(['x', 'y']);
  });
});

/* -------------------------------------------------------------------------- */
/* Codex round-2 regression: explicit fallback validity must be consistent.    */
/* -------------------------------------------------------------------------- */

describe('Explicit fallback validity consistency', () => {
  it('throws when validity marks a row as defined but fallback[i] is undefined', () => {
    // Reproduces the Codex high finding: silent data drop in scan.
    // Caller passes all-defined validity but fallback has undefined at i=1.
    const allDefined = validityFromBits(new Uint8Array([0b111]), 3);
    expect(() =>
      stringColumnFallback(['a', undefined, 'b'], allDefined),
    ).toThrow(/defined but fallback/);
  });

  it('throws via the direct constructor on the same inconsistency', () => {
    const validity = validityFromBits(new Uint8Array([0b111]), 3);
    expect(
      () =>
        new StringColumn(3, {
          fallback: ['a', undefined, 'b'],
          validity,
        }),
    ).toThrow(/defined but fallback/);
  });

  it('accepts consistent explicit validity for fallback mode', () => {
    // validity says i=0 and i=2 are defined; fallback has strings there.
    // i=1 is undefined in both — consistent.
    const validity = validityFromBits(new Uint8Array([0b101]), 3);
    const col = stringColumnFallback(['a', undefined, 'b'], validity);
    expect(col.read(0)).toBe('a');
    expect(col.read(1)).toBeUndefined();
    expect(col.read(2)).toBe('b');
  });

  it('derived-validity factory path remains internally consistent', () => {
    // When the factory derives validity, it cannot be inconsistent
    // because it's built directly from typeof checks.
    const col = stringColumnFallback(['a', undefined, 'b', undefined]);
    expect(col.validity!.definedCount).toBe(2);
    const visited: string[] = [];
    col.scan((v) => visited.push(v));
    expect(visited).toEqual(['a', 'b']);
  });
});

/* -------------------------------------------------------------------------- */
/* Codex round-2: cross-dictionary remap for join paths.                      */
/* -------------------------------------------------------------------------- */

describe('remapIndicesToDictionary', () => {
  it('translates source indices to target dictionary positions', () => {
    const srcDict = ['us-east', 'us-west', 'eu-west'];
    const targetDict = ['eu-west', 'us-west', 'asia', 'us-east'];
    // Source row 0 = 'us-east' → target idx 3
    // Source row 1 = 'us-west' → target idx 1
    // Source row 2 = 'eu-west' → target idx 0
    const srcIndices = Int32Array.of(0, 1, 2);
    const remapped = remapIndicesToDictionary(srcIndices, srcDict, targetDict);
    expect(Array.from(remapped)).toEqual([3, 1, 0]);
  });

  it('marks missing target strings with -1', () => {
    const srcDict = ['a', 'b', 'c'];
    const targetDict = ['a', 'c']; // 'b' is absent
    const srcIndices = Int32Array.of(0, 1, 2);
    const remapped = remapIndicesToDictionary(srcIndices, srcDict, targetDict);
    expect(Array.from(remapped)).toEqual([0, -1, 1]);
  });

  it('marks out-of-range source indices with -1', () => {
    const srcDict = ['a', 'b'];
    const targetDict = ['a', 'b'];
    const srcIndices = Int32Array.of(0, 5, -1);
    const remapped = remapIndicesToDictionary(srcIndices, srcDict, targetDict);
    expect(Array.from(remapped)).toEqual([0, -1, -1]);
  });

  it('reversed dictionaries — the cross-column join scenario', () => {
    // Two columns with the same strings but reversed dictionary orders.
    // Raw integer comparison would give false matches; remap fixes it.
    const dictA = ['x', 'y'];
    const dictB = ['y', 'x'];
    const indicesA = Int32Array.of(0, 1, 0, 1); // x, y, x, y
    const remapped = remapIndicesToDictionary(indicesA, dictA, dictB);
    // After remap, indicesA[i] === dictB-index-of-dictA[indicesA[i]]
    expect(Array.from(remapped)).toEqual([1, 0, 1, 0]);
  });

  it('handles empty source dictionary', () => {
    const remapped = remapIndicesToDictionary(
      new Int32Array(0),
      [],
      ['a', 'b'],
    );
    expect(remapped.length).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Codex round-2 regression: validity-aware remap closes the join-corruption  */
/* gap where invalid placeholder indices remapped to real strings.            */
/* -------------------------------------------------------------------------- */

describe('remapIndicesToDictionary validity-aware mode', () => {
  it('marks invalid rows as -1 when validity is supplied', () => {
    // Source has indices [0, 0, 0] where index 1 is invalid.
    // Without validity, all three would remap to dict[0] = 'a' → target[0].
    // With validity, the invalid row gets -1.
    const srcDict = ['a', 'b'];
    const targetDict = ['a', 'b'];
    const indices = Int32Array.of(0, 0, 0);
    const validity = validityFromBits(new Uint8Array([0b101]), 3);

    const naive = remapIndicesToDictionary(indices, srcDict, targetDict);
    expect(Array.from(naive)).toEqual([0, 0, 0]); // bug pattern Codex flagged

    const safe = remapIndicesToDictionary(
      indices,
      srcDict,
      targetDict,
      validity,
    );
    expect(Array.from(safe)).toEqual([0, -1, 0]);
  });

  it('canonical join-corruption regression: invalid placeholder 0 cannot match dictionary[0]', () => {
    // Codex's specific scenario: a column with placeholder `0` for
    // missing rows would silently join as `dictionary[0]` without
    // validity. Pin that the validity-aware variant blocks this.
    const srcDict = ['us-east', 'us-west'];
    const targetDict = ['us-east', 'eu-west'];
    const indices = Int32Array.of(0, 0); // first row real, second is placeholder
    const validity = validityFromBits(new Uint8Array([0b01]), 2); // only row 0 is defined

    const remapped = remapIndicesToDictionary(
      indices,
      srcDict,
      targetDict,
      validity,
    );
    // Row 0: real 'us-east' → target idx 0. Row 1: invalid → -1.
    // Without validity, row 1 would also resolve to target idx 0 (a join hit
    // on a value that was actually missing). The -1 here is the fix.
    expect(Array.from(remapped)).toEqual([0, -1]);
  });

  it('omitting validity preserves the existing behavior (every row treated as valid)', () => {
    const srcDict = ['a', 'b'];
    const targetDict = ['a', 'b'];
    const remapped = remapIndicesToDictionary(
      Int32Array.of(0, 1),
      srcDict,
      targetDict,
    );
    expect(Array.from(remapped)).toEqual([0, 1]);
  });
});

describe('remapColumnToDictionary', () => {
  it('uses the column validity automatically', () => {
    // Build a column with an invalid row via sliceByIndices off a small source.
    const src = stringColumnDictEncoded(['a', 'b'], Int32Array.of(0, 1));
    const col = src.sliceByIndices(Int32Array.of(0, 5, 1));
    // Resulting column: dict=['a','b'], indices=[0,0,1], validity has bit 1 cleared.
    const remapped = remapColumnToDictionary(col, ['b', 'a']);
    // Row 0: valid 'a' → target idx 1. Row 1: invalid → -1.
    // Row 2: valid 'b' → target idx 0.
    expect(Array.from(remapped)).toEqual([1, -1, 0]);
  });

  it('throws for fallback-mode columns', () => {
    const col = stringColumnFallback(['a', 'b', 'c']);
    expect(() => remapColumnToDictionary(col, ['a', 'b'])).toThrow(
      /must be dict-encoded/,
    );
  });

  it('handles a column with no validity bitmap (every row defined)', () => {
    const col = stringColumnDictEncoded(['a', 'b'], Int32Array.of(0, 1, 0));
    const remapped = remapColumnToDictionary(col, ['x', 'a', 'b']);
    expect(Array.from(remapped)).toEqual([1, 2, 1]);
  });
});

/* -------------------------------------------------------------------------- */
/* Codex round-3 regressions: scan-with-non-empty-dict + validity-length mismatch */
/* -------------------------------------------------------------------------- */

describe('scan sentinel regressions (Codex round 3)', () => {
  it('dict-encoded sliceByIndices out-of-range row with non-empty dictionary emits "" sentinel', () => {
    // Codex's specific concern: placeholder index `0` against a non-empty
    // dictionary would otherwise scan as `dict[0]` — a real string. Pin
    // that the sentinel `''` is emitted instead.
    const col = stringColumnDictEncoded(
      ['us-east', 'us-west'],
      Int32Array.of(0, 1),
    );
    const slice = col.sliceByIndices(Int32Array.of(0, 99));
    const visited: Array<[string, number]> = [];
    slice.scan((v, i) => visited.push([v, i]), { skipInvalid: false });
    expect(visited).toEqual([
      ['us-east', 0],
      ['', 1], // sentinel, NOT 'us-east' (which would silently match dict[0])
    ]);
  });

  it('row-aligned consumer cannot accidentally surface a missing row as a real first-dictionary value', () => {
    // The exact failure mode Codex named: a downstream consumer that
    // materializes scan output without separately carrying validity
    // can no longer produce a fake match against dict[0].
    const col = stringColumnDictEncoded(
      ['active', 'inactive'],
      Int32Array.of(0, 1, 0, 1),
    );
    const slice = col.sliceByIndices(Int32Array.of(0, 99, 1, 99));
    const materialized: string[] = [];
    slice.scan((v) => materialized.push(v), { skipInvalid: false });
    // Without the fix, positions 1 and 3 would be 'active' (dict[0]).
    expect(materialized).toEqual(['active', '', 'inactive', '']);
  });
});

describe('remapIndicesToDictionary validity-length validation (Codex round 3)', () => {
  it('throws on validity bitmap longer than srcIndices', () => {
    const indices = Int32Array.of(0, 1);
    const validity = validityFromBits(new Uint8Array([0b1111]), 4);
    expect(() =>
      remapIndicesToDictionary(indices, ['a', 'b'], ['a', 'b'], validity),
    ).toThrow(/validity length/);
  });

  it('throws on validity bitmap shorter than srcIndices', () => {
    const indices = Int32Array.of(0, 1, 0);
    const validity = validityFromBits(new Uint8Array([0b11]), 2);
    expect(() =>
      remapIndicesToDictionary(indices, ['a', 'b'], ['a', 'b'], validity),
    ).toThrow(/validity length/);
  });

  it('accepts matching validity length', () => {
    const indices = Int32Array.of(0, 1, 0);
    const validity = validityFromBits(new Uint8Array([0b101]), 3);
    expect(() =>
      remapIndicesToDictionary(indices, ['a', 'b'], ['a', 'b'], validity),
    ).not.toThrow();
  });
});
