import { describe, expect, it } from 'vitest';

import {
  ArrayColumn,
  EMPTY_ARRAY_SENTINEL,
  MAX_COLUMN_LENGTH,
  arrayColumnFromArray,
  validityFromBits,
} from '../../src/columnar/index.js';

/* -------------------------------------------------------------------------- */
/* Construction & read                                                        */
/* -------------------------------------------------------------------------- */

describe('ArrayColumn construction', () => {
  it('builds a column from an array of arrays', () => {
    const col = arrayColumnFromArray([[1, 2, 3], ['a', 'b'], [true]]);
    expect(col.kind).toBe('array');
    expect(col.length).toBe(3);
    expect(col.validity).toBeUndefined();
    expect(col.read(0)).toEqual([1, 2, 3]);
    expect(col.read(1)).toEqual(['a', 'b']);
    expect(col.read(2)).toEqual([true]);
  });

  it('derives validity from undefined / null / non-array slots', () => {
    const col = arrayColumnFromArray([[1, 2], undefined, [3], null]);
    expect(col.validity).toBeDefined();
    expect(col.validity!.definedCount).toBe(2);
    expect(col.read(0)).toEqual([1, 2]);
    expect(col.read(1)).toBeUndefined();
    expect(col.read(2)).toEqual([3]);
    expect(col.read(3)).toBeUndefined();
  });

  it('empty source produces a zero-length column', () => {
    const col = arrayColumnFromArray([]);
    expect(col.length).toBe(0);
    expect(col.validity).toBeUndefined();
  });

  it('out-of-range reads return undefined', () => {
    const col = arrayColumnFromArray([[1]]);
    expect(col.read(-1)).toBeUndefined();
    expect(col.read(5)).toBeUndefined();
  });
});

describe('ArrayColumn length validation', () => {
  it('rejects 2**31', () => {
    expect(() => new ArrayColumn(2 ** 31, { fallback: [] })).toThrow(
      RangeError,
    );
  });

  it('rejects MAX_COLUMN_LENGTH + 1', () => {
    expect(
      () => new ArrayColumn(MAX_COLUMN_LENGTH + 1, { fallback: [] }),
    ).toThrow(RangeError);
  });

  it('rejects mismatched fallback length', () => {
    expect(() => new ArrayColumn(3, { fallback: [[1]] })).toThrow(RangeError);
  });

  it('rejects mismatched validity length', () => {
    const validity = validityFromBits(new Uint8Array([0xff]), 5);
    expect(
      () =>
        new ArrayColumn(3, {
          fallback: [[1], [2], [3]],
          validity,
        }),
    ).toThrow(RangeError);
  });
});

describe('ArrayColumn no-validity invariant (inherited 1b boundary discipline)', () => {
  it('rejects fallback with undefined slot and no validity bitmap', () => {
    expect(() => new ArrayColumn(2, { fallback: [[1], undefined] })).toThrow(
      /no validity bitmap was supplied/,
    );
  });

  it('rejects fallback with non-array scalar slot and no validity bitmap', () => {
    expect(
      () =>
        new ArrayColumn(2, {
          fallback: [[1], 42 as unknown as ReadonlyArray<number>],
        }),
    ).toThrow(/no validity bitmap was supplied/);
  });

  it('accepts fallback with every slot a real array (no validity needed)', () => {
    const col = new ArrayColumn(3, {
      fallback: [[1], [2, 3], []],
    });
    expect(col.validity).toBeUndefined();
    expect(col.read(0)).toEqual([1]);
    expect(col.read(2)).toEqual([]);
  });

  it('accepts fallback with undefined slots when validity is supplied', () => {
    const validity = validityFromBits(new Uint8Array([0b101]), 3);
    const col = new ArrayColumn(3, {
      fallback: [[1], undefined, [3]],
      validity,
    });
    expect(col.read(0)).toEqual([1]);
    expect(col.read(1)).toBeUndefined();
    expect(col.read(2)).toEqual([3]);
  });

  it('rejects validity marking a row as defined but fallback[i] is not an array', () => {
    const allDefined = validityFromBits(new Uint8Array([0b111]), 3);
    expect(
      () =>
        new ArrayColumn(3, {
          fallback: [[1], undefined, [3]],
          validity: allDefined,
        }),
    ).toThrow(/defined but fallback/);
  });
});

/* -------------------------------------------------------------------------- */
/* scan                                                                       */
/* -------------------------------------------------------------------------- */

describe('ArrayColumn.scan', () => {
  it('skips invalid cells by default', () => {
    const col = arrayColumnFromArray([[1], undefined, [3]]);
    const visited: Array<[ReadonlyArray<unknown>, number]> = [];
    col.scan((v, i) => visited.push([v, i]));
    expect(visited).toEqual([
      [[1], 0],
      [[3], 2],
    ]);
  });

  it('emits EMPTY_ARRAY_SENTINEL for invalid rows when skipInvalid:false', () => {
    const col = arrayColumnFromArray([[1], undefined, [3]]);
    const visited: Array<[ReadonlyArray<unknown>, number]> = [];
    col.scan((v, i) => visited.push([v, i]), { skipInvalid: false });
    expect(visited.length).toBe(3);
    expect(visited[0]![0]).toEqual([1]);
    expect(visited[1]![0]).toBe(EMPTY_ARRAY_SENTINEL); // identity check
    expect(visited[2]![0]).toEqual([3]);
  });

  it('EMPTY_ARRAY_SENTINEL is frozen', () => {
    expect(Object.isFrozen(EMPTY_ARRAY_SENTINEL)).toBe(true);
  });

  it('row-aligned consumer pattern: scan(skipInvalid:false) output is exactly length entries', () => {
    const col = arrayColumnFromArray(
      Array.from({ length: 20 }, (_, i) =>
        i % 4 === 0 ? undefined : ([i, i + 1] as ReadonlyArray<number>),
      ),
    );
    let count = 0;
    col.scan(() => (count += 1), { skipInvalid: false });
    expect(count).toBe(col.length);
  });
});

/* -------------------------------------------------------------------------- */
/* sliceByRange / sliceByIndices                                              */
/* -------------------------------------------------------------------------- */

describe('ArrayColumn.sliceByRange', () => {
  it('produces a sliced fallback array', () => {
    const col = arrayColumnFromArray([[1], [2], [3], [4], [5]]);
    const slice = col.sliceByRange(1, 4);
    expect(slice.length).toBe(3);
    expect(slice.read(0)).toEqual([2]);
    expect(slice.read(1)).toEqual([3]);
    expect(slice.read(2)).toEqual([4]);
  });

  it('preserves validity bitmap', () => {
    const col = arrayColumnFromArray([[1], undefined, [3], [4], undefined]);
    const slice = col.sliceByRange(0, 4);
    expect(slice.read(0)).toEqual([1]);
    expect(slice.read(1)).toBeUndefined();
    expect(slice.read(2)).toEqual([3]);
    expect(slice.read(3)).toEqual([4]);
  });

  it('empty range returns a zero-length column', () => {
    const col = arrayColumnFromArray([[1], [2]]);
    const slice = col.sliceByRange(1, 1);
    expect(slice.length).toBe(0);
  });

  it('clamps to column bounds', () => {
    const col = arrayColumnFromArray([[1], [2]]);
    const slice = col.sliceByRange(-5, 100);
    expect(slice.length).toBe(2);
    expect(slice.read(0)).toEqual([1]);
    expect(slice.read(1)).toEqual([2]);
  });
});

describe('ArrayColumn.sliceByIndices', () => {
  it('gathers arrays in arbitrary order', () => {
    const col = arrayColumnFromArray([['a'], ['b'], ['c'], ['d']]);
    const slice = col.sliceByIndices(Int32Array.of(3, 0, 2));
    expect(slice.length).toBe(3);
    expect(slice.read(0)).toEqual(['d']);
    expect(slice.read(1)).toEqual(['a']);
    expect(slice.read(2)).toEqual(['c']);
  });

  it('marks out-of-range source indices invalid', () => {
    const col = arrayColumnFromArray([[1], [2]]);
    const slice = col.sliceByIndices(Int32Array.of(0, 5, 1));
    expect(slice.read(0)).toEqual([1]);
    expect(slice.read(1)).toBeUndefined();
    expect(slice.read(2)).toEqual([2]);
  });
});
