/**
 * `ReducerDef.reduceCellRange` — the range kernels of `keep` /
 * `difference` / `unique` / `top${N}` / `samples` — must give exactly what
 * `reduce` gives over the same cells after the row path's filtering. Checked
 * on every column shape the kernels special-case (packed numbers,
 * dictionary strings — including a dictionary holding one string twice,
 * which public intake never builds) and the ones they hand to the general
 * read path (fallback strings, booleans, arrays, chunked numbers).
 */
import { describe, expect, it } from 'vitest';
import {
  ChunkedFloat64Column,
  arrayColumnFromArray,
  booleanColumnFromArray,
  float64ColumnFromArray,
  stringColumnDictEncoded,
  stringColumnFromArray,
  validityFromPredicate,
  type Column,
} from '../src/columnar/index.js';
import { resolveReducer } from '../src/reducers/index.js';
import type { ColumnValue } from '../src/schema/index.js';

const REDUCERS = ['keep', 'difference', 'unique', 'top1', 'top3', 'samples'];

function rowPath(
  name: string,
  col: Column,
  start: number,
  end: number,
): ColumnValue | undefined {
  const defined: ColumnValue[] = [];
  const numeric: number[] = [];
  for (let i = start; i < end; i += 1) {
    const v = col.read(i) as ColumnValue | undefined;
    if (v === undefined) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    if (typeof v === 'number') numeric.push(v);
    defined.push(v);
  }
  return resolveReducer(name).reduce(defined, numeric);
}

/** Like `toEqual`, but tells `-0` from `0`. */
function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => same(x, b[i]));
  }
  return Object.is(a, b);
}

function checkAllRanges(label: string, col: Column): void {
  for (const name of REDUCERS) {
    const kernel = resolveReducer(name).reduceCellRange!;
    for (let start = 0; start <= col.length; start += 1) {
      for (let end = start; end <= col.length; end += 1) {
        const got = kernel(col, start, end);
        const want = rowPath(name, col, start, end);
        if (!same(got, want)) {
          throw new Error(
            `${label} ${name} [${start}, ${end}): got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
          );
        }
      }
    }
  }
}

describe('reduceCellRange matches reduce', () => {
  it('packed numbers with gaps, repeats and signed zeros', () => {
    const values = [3, undefined, -0, 0, 3, 3, undefined, 0, -0, 5, 5, -2, 3];
    checkAllRanges('numbers', float64ColumnFromArray(values));
    checkAllRanges('one value', float64ColumnFromArray([4, 4, undefined, 4]));
    checkAllRanges(
      'all missing',
      float64ColumnFromArray([undefined, undefined]),
    );
  });

  it('ranges past the sort cutoff use the hash path, same answers', () => {
    // SORT_RANGE_MAX is 4096: whole-column calls here hash, short ones sort.
    const values = Array.from({ length: 5000 }, (_, i) =>
      i % 13 === 0 ? undefined : i % 29 === 0 ? -0 : ((i * 7919) % 50) - 25,
    );
    const col = float64ColumnFromArray(values);
    for (const name of REDUCERS) {
      const kernel = resolveReducer(name).reduceCellRange!;
      for (const [start, end] of [
        [0, 5000],
        [3, 4100],
        [900, 4996],
        [10, 70],
      ] as const) {
        expect(
          same(kernel(col, start, end), rowPath(name, col, start, end)),
          `${name} [${start}, ${end})`,
        ).toBe(true);
      }
    }
  });

  it('dictionary strings, including one string under two codes', () => {
    // 'a' is stored at codes 0 and 2.
    const dict = ['a', 'b', 'a', 'c'];
    const codes = Int32Array.from([0, 2, 1, 0, 3, 2, 2, 1, 0]);
    const missing = new Set([3, 6]);
    const col = stringColumnDictEncoded(
      dict,
      codes,
      validityFromPredicate(codes.length, (i) => !missing.has(i)),
    );
    checkAllRanges('dict', col);
    // Only the duplicated string: `keep` must still answer 'a'.
    const twice = stringColumnDictEncoded(['a', 'a'], Int32Array.from([0, 1]));
    expect(resolveReducer('keep').reduceCellRange!(twice, 0, 2)).toBe('a');
    expect(resolveReducer('unique').reduceCellRange!(twice, 0, 2)).toEqual([
      'a',
    ]);
    expect(resolveReducer('top1').reduceCellRange!(twice, 0, 2)).toEqual(['a']);
    checkAllRanges('dict twice', twice);
  });

  it('other column shapes take the read path', () => {
    checkAllRanges(
      'fallback strings',
      stringColumnFromArray(['x', undefined, 'y', 'x', 'x'], {
        forceFallback: true,
      }),
    );
    checkAllRanges(
      'booleans',
      booleanColumnFromArray([true, undefined, true, false, true]),
    );
    checkAllRanges(
      'arrays',
      arrayColumnFromArray([['a', 1], undefined, ['a'], [], ['b', 1, 1]]),
    );
    checkAllRanges(
      'chunked numbers',
      new ChunkedFloat64Column([
        float64ColumnFromArray([1, undefined, 1]),
        float64ColumnFromArray([-0, 0, 2]),
      ]),
    );
  });
});
