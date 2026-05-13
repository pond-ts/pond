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
      /not a valid ArrayValue/,
    );
  });

  it('rejects fallback with non-array scalar slot and no validity bitmap', () => {
    expect(
      () =>
        new ArrayColumn(2, {
          fallback: [[1], 42 as unknown as ReadonlyArray<number>],
        }),
    ).toThrow(/not a valid ArrayValue/);
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

/* -------------------------------------------------------------------------- */
/* Codex round-1 regressions: ArrayValue element contract                     */
/* -------------------------------------------------------------------------- */

describe('ArrayValue element-contract validation (Codex round 1)', () => {
  it('constructor rejects arrays containing NaN', () => {
    expect(
      () =>
        new ArrayColumn(1, {
          fallback: [[1, NaN, 3] as unknown as ReadonlyArray<number>],
        }),
    ).toThrow(/not a valid ArrayValue/);
  });

  it('constructor rejects arrays containing objects', () => {
    expect(
      () =>
        new ArrayColumn(1, {
          fallback: [[{ x: 1 }] as unknown as ReadonlyArray<number>],
        }),
    ).toThrow(/not a valid ArrayValue/);
  });

  it('constructor rejects nested arrays', () => {
    expect(
      () =>
        new ArrayColumn(1, {
          fallback: [[[1, 2]] as unknown as ReadonlyArray<number>],
        }),
    ).toThrow(/not a valid ArrayValue/);
  });

  it('constructor rejects arrays containing null', () => {
    expect(
      () =>
        new ArrayColumn(1, {
          fallback: [[null] as unknown as ReadonlyArray<number>],
        }),
    ).toThrow(/not a valid ArrayValue/);
  });

  it('constructor accepts mixed scalar arrays', () => {
    const col = new ArrayColumn(2, {
      fallback: [
        [1, 'two', true],
        [false, 'x', 42],
      ],
    });
    expect(col.read(0)).toEqual([1, 'two', true]);
    expect(col.read(1)).toEqual([false, 'x', 42]);
  });

  it('constructor accepts Infinity and -Infinity as element... wait, no — finite only', () => {
    expect(
      () =>
        new ArrayColumn(1, {
          fallback: [[Infinity] as unknown as ReadonlyArray<number>],
        }),
    ).toThrow(/not a valid ArrayValue/);
  });

  it('arrayColumnFromArray treats malformed arrays as invalid cells', () => {
    // Codex's specific concern: factory must mirror validate.ts. A
    // malformed array becomes an invalid cell rather than slipping
    // through.
    const col = arrayColumnFromArray([
      [1, 2],
      [NaN, 3] as unknown as ReadonlyArray<number>,
      [4],
    ]);
    expect(col.validity).toBeDefined();
    expect(col.validity!.definedCount).toBe(2);
    expect(col.read(0)).toEqual([1, 2]);
    expect(col.read(1)).toBeUndefined(); // malformed → invalid
    expect(col.read(2)).toEqual([4]);
  });

  it('arrayColumnFromArray treats nested-array slots as invalid cells', () => {
    const col = arrayColumnFromArray([
      [1],
      [[2, 3]] as unknown as ReadonlyArray<number>,
      [4],
    ]);
    expect(col.validity).toBeDefined();
    expect(col.read(1)).toBeUndefined();
  });

  it('validity-supplied path also enforces the element contract', () => {
    const validity = validityFromBits(new Uint8Array([0b11]), 2);
    expect(
      () =>
        new ArrayColumn(2, {
          fallback: [[1], [NaN] as unknown as ReadonlyArray<number>],
          validity,
        }),
    ).toThrow(/not a valid ArrayValue/);
  });
});

/* -------------------------------------------------------------------------- */
/* Codex round-2 regressions: cell-ownership / immutability                    */
/* -------------------------------------------------------------------------- */

describe('ArrayColumn defensive cell ownership (Codex round 2)', () => {
  it('mutating the source array after construction does not affect column reads', () => {
    // Pin the defense: caller mutates a cell array after construction;
    // column reads / scans are unchanged.
    const source: number[] = [1, 2, 3];
    const col = new ArrayColumn(1, { fallback: [source] });
    expect(col.read(0)).toEqual([1, 2, 3]);

    // Mutate the original source array — would invalidate the
    // contract if the column stored the reference directly.
    source.push(NaN);
    source[0] = Infinity;

    // Column data is independent.
    expect(col.read(0)).toEqual([1, 2, 3]);
  });

  it('column-stored arrays are frozen', () => {
    const col = new ArrayColumn(2, { fallback: [[1, 2], [3]] });
    const a = col.read(0)!;
    const b = col.read(1)!;
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(b)).toBe(true);
    // Attempting to mutate the returned reference throws in strict mode.
    expect(() => {
      (a as number[]).push(99);
    }).toThrow();
  });

  it('factory path also produces defensive cells', () => {
    const source: number[] = [10, 20];
    const col = arrayColumnFromArray([source, [30]]);
    source.push(99);
    expect(col.read(0)).toEqual([10, 20]);
    expect(Object.isFrozen(col.read(0))).toBe(true);
  });

  it('sliced columns inherit frozen-cell ownership', () => {
    const col = arrayColumnFromArray([[1], [2], [3]]);
    const slice = col.sliceByRange(0, 2);
    expect(Object.isFrozen(slice.read(0))).toBe(true);
    expect(Object.isFrozen(slice.read(1))).toBe(true);
  });

  it('gathered columns inherit frozen-cell ownership', () => {
    const col = arrayColumnFromArray([[1], [2], [3]]);
    const slice = col.sliceByIndices(Int32Array.of(2, 0));
    expect(Object.isFrozen(slice.read(0))).toBe(true);
    expect(slice.read(0)).toEqual([3]);
  });
});
