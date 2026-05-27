/**
 * Runtime tests for Phase 4.7 step 8b — the column-API method
 * surface mounted on `Float64Column` / `BooleanColumn` /
 * `StringColumn` / `ArrayColumn` via prototype augmentation in
 * `src/column.ts`.
 *
 * The reducer-backed methods (min/max/sum/mean/stdev/median/
 * percentile/count) delegate to PR #153's
 * `ReducerDef.reduceColumn` fast path; we don't re-verify the
 * reducer math here (that's covered by `TimeSeries.aggregators.test.ts`).
 * The point of this file is to pin the method-level contract:
 * methods exist, dispatch to the right reducer, propagate NaN /
 * empty / validity edge cases per the column-api RFC §7.3.
 *
 * The inline-implemented methods (`minMax`, `hasMissing`,
 * `nullCount`, `first`, `last`, `firstDefined`, `lastDefined`,
 * `at`, `slice`, plus BooleanColumn `all`/`any`/`none` and
 * StringColumn `uniqueCount`) get full behavioral coverage.
 */

import { describe, expect, it } from 'vitest';
import { createValidityBitmap } from '../src/columnar/index.js';
import {
  ArrayColumn,
  arrayColumnFromArray,
} from '../src/columnar/array-column.js';
import { BooleanColumn, Float64Column } from '../src/columnar/column.js';
import {
  StringColumn,
  stringColumnFromArray,
} from '../src/columnar/string-column.js';

// `column.ts` mounts the methods via side-effect import. The
// public barrel (`src/index.ts`) imports it; the side-effect
// import below installs the prototype augmentations on the
// in-tree substrate classes that the test references via the
// `'../src/...'` paths below.
import '../src/column.js';

// ─── Helpers ────────────────────────────────────────────────────

function f64(values: number[], validity?: boolean[]): Float64Column {
  const buf = Float64Array.from(values);
  if (!validity) return new Float64Column(buf, values.length);
  const v = createValidityBitmap(values.length);
  for (let i = 0; i < values.length; i += 1) {
    if (validity[i]) v.set(i);
  }
  return new Float64Column(buf, values.length, v.freeze());
}

function bool(values: boolean[], validity?: boolean[]): BooleanColumn {
  const bits = new Uint8Array(Math.ceil(values.length / 8));
  for (let i = 0; i < values.length; i += 1) {
    if (values[i]) bits[i >> 3]! |= 1 << (i & 7);
  }
  if (!validity) return new BooleanColumn(bits, values.length);
  const v = createValidityBitmap(values.length);
  for (let i = 0; i < values.length; i += 1) {
    if (validity[i]) v.set(i);
  }
  return new BooleanColumn(bits, values.length, v.freeze());
}

// ─── Float64Column ──────────────────────────────────────────────

describe('Float64Column public methods', () => {
  describe('access', () => {
    it('at() returns the value at the index', () => {
      const c = f64([10, 20, 30]);
      expect(c.at(0)).toBe(10);
      expect(c.at(2)).toBe(30);
    });

    it('at() returns undefined for out-of-range index', () => {
      const c = f64([10, 20, 30]);
      expect(c.at(-1)).toBeUndefined();
      expect(c.at(3)).toBeUndefined();
    });

    it('at() returns undefined for cells outside validity', () => {
      const c = f64([10, 20, 30], [true, false, true]);
      expect(c.at(0)).toBe(10);
      expect(c.at(1)).toBeUndefined();
      expect(c.at(2)).toBe(30);
    });

    it('slice() returns a zero-copy view with the right length', () => {
      const c = f64([1, 2, 3, 4, 5]);
      const s = c.slice(1, 4);
      expect(s).toBeInstanceOf(Float64Column);
      expect(s.length).toBe(3);
      expect(s.at(0)).toBe(2);
      expect(s.at(2)).toBe(4);
    });
  });

  describe('reductions', () => {
    it('min/max on simple input', () => {
      const c = f64([3, 1, 4, 1, 5, 9, 2, 6]);
      expect(c.min()).toBe(1);
      expect(c.max()).toBe(9);
    });

    it('sum / mean / stdev', () => {
      const c = f64([1, 2, 3, 4, 5]);
      expect(c.sum()).toBe(15);
      expect(c.mean()).toBeCloseTo(3);
      expect(c.stdev()).toBeCloseTo(Math.sqrt(2), 10);
    });

    it('median / percentile', () => {
      const c = f64([10, 20, 30, 40, 50]);
      expect(c.median()).toBe(30);
      expect(c.percentile(0)).toBe(10);
      expect(c.percentile(100)).toBe(50);
      expect(c.percentile(50)).toBe(30);
    });

    it('percentile rejects q outside [0, 100]', () => {
      const c = f64([1, 2, 3]);
      expect(() => c.percentile(-1)).toThrow(RangeError);
      expect(() => c.percentile(101)).toThrow(RangeError);
      expect(() => c.percentile(NaN)).toThrow(RangeError);
    });

    it('count returns defined-cell count (not event count)', () => {
      const all = f64([10, 20, 30]);
      expect(all.count()).toBe(3);
      const some = f64([10, 20, 30], [true, false, true]);
      expect(some.count()).toBe(2);
    });

    it('returns undefined for empty column', () => {
      const c = f64([]);
      expect(c.min()).toBeUndefined();
      expect(c.max()).toBeUndefined();
      expect(c.mean()).toBeUndefined();
      expect(c.median()).toBeUndefined();
      expect(c.percentile(50)).toBeUndefined();
      expect(c.sum()).toBe(0);
      expect(c.count()).toBe(0);
    });
  });

  describe('minMax (fused single-pass)', () => {
    it('returns [min, max] for non-empty column', () => {
      const c = f64([3, 1, 4, 1, 5, 9, 2, 6]);
      expect(c.minMax()).toEqual([1, 9]);
    });

    it('agrees with [min(), max()] on standard input', () => {
      const c = f64([7, 2, 8, 1, 9, 4, 6, 3, 5]);
      const [lo, hi] = c.minMax()!;
      expect(lo).toBe(c.min());
      expect(hi).toBe(c.max());
    });

    it('returns undefined for empty column', () => {
      expect(f64([]).minMax()).toBeUndefined();
    });

    it('returns undefined for all-invalid column', () => {
      const c = f64([1, 2, 3], [false, false, false]);
      expect(c.minMax()).toBeUndefined();
    });

    it('respects validity (skips undefined cells)', () => {
      const c = f64([100, 5, 200, 3, 50], [false, true, false, true, true]);
      expect(c.minMax()).toEqual([3, 50]);
    });

    it('single-value column returns [v, v]', () => {
      const c = f64([42]);
      expect(c.minMax()).toEqual([42, 42]);
    });
  });

  describe('value-vector predicates', () => {
    it('hasMissing / nullCount with no validity bitmap', () => {
      const c = f64([1, 2, 3]);
      expect(c.hasMissing()).toBe(false);
      expect(c.nullCount()).toBe(0);
    });

    it('hasMissing / nullCount with validity gaps', () => {
      const c = f64([1, 2, 3, 4, 5], [true, false, true, false, true]);
      expect(c.hasMissing()).toBe(true);
      expect(c.nullCount()).toBe(2);
    });

    it('hasMissing false when validity exists but no gaps', () => {
      const c = f64([1, 2, 3], [true, true, true]);
      expect(c.hasMissing()).toBe(false);
      expect(c.nullCount()).toBe(0);
    });
  });

  describe('position-indexed', () => {
    it('first / last on simple input', () => {
      const c = f64([10, 20, 30]);
      expect(c.first()).toBe(10);
      expect(c.last()).toBe(30);
    });

    it('first / last respect validity (undefined for invalid cell)', () => {
      const c = f64([10, 20, 30], [false, true, false]);
      expect(c.first()).toBeUndefined();
      expect(c.last()).toBeUndefined();
    });

    it('firstDefined / lastDefined skip leading/trailing invalids', () => {
      const c = f64([10, 20, 30, 40, 50], [false, false, true, true, false]);
      expect(c.firstDefined()).toBe(30);
      expect(c.lastDefined()).toBe(40);
    });

    it('firstDefined / lastDefined return undefined when all invalid', () => {
      const c = f64([1, 2, 3], [false, false, false]);
      expect(c.firstDefined()).toBeUndefined();
      expect(c.lastDefined()).toBeUndefined();
    });

    it('first / last / firstDefined / lastDefined undefined for empty', () => {
      const c = f64([]);
      expect(c.first()).toBeUndefined();
      expect(c.last()).toBeUndefined();
      expect(c.firstDefined()).toBeUndefined();
      expect(c.lastDefined()).toBeUndefined();
    });
  });

  describe('toFloat64Array — storage-agnostic gather', () => {
    it('packed: returns the underlying .values reference (no allocation)', () => {
      const c = f64([1, 2, 3, 4, 5]);
      const out = c.toFloat64Array();
      // Identity: same Float64Array reference as .values. Caller
      // shares the column's trusted-buffer read-only contract.
      // This is the load-bearing contract for adapters that
      // compare reference equality.
      expect(out).toBe(c.values);
      expect(out).toBeInstanceOf(Float64Array);
      expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
    });

    it('packed empty column returns an empty Float64Array', () => {
      const c = f64([]);
      const out = c.toFloat64Array();
      expect(out).toBeInstanceOf(Float64Array);
      expect(out.length).toBe(0);
      // Identity holds for the empty case too.
      expect(out).toBe(c.values);
    });

    it('packed with oversized buffer: bounded subarray (NOT raw values)', () => {
      // Float64Column's constructor permits `length < values.length`
      // — used by ColumnarRingBuffer and other capacity-grown
      // patterns. The contract is "returns Float64Array of length
      // this.length"; if we returned `this.values` directly, callers
      // would see the tail capacity (slots that read / scan / reducers
      // never expose). Regression test pinned by Codex finding on
      // PR #165.
      const buf = Float64Array.of(1, 2, 999, 999);
      const c = new Float64Column(buf, 2); // logical length 2, buffer length 4
      const out = c.toFloat64Array();
      expect(out.length).toBe(2);
      expect(out.length).toBe(c.length);
      expect(Array.from(out)).toEqual([1, 2]);
      // Still a view over the same buffer (no copy) — just bounded.
      expect(out.buffer).toBe(buf.buffer);
      // NOT identity with .values in this case (subarray is a fresh
      // TypedArray view object).
      expect(out).not.toBe(c.values);
    });

    it('packed with validity: returns raw values including undefined-marked slots', () => {
      // The undefined-marked positions still carry whatever value
      // the source put there — toFloat64Array doesn't replace
      // them with NaN. Validity-aware iteration is a separate
      // concern via .validity / .scan.
      const c = f64([10, 999, 20, 999, 30], [true, false, true, false, true]);
      const out = c.toFloat64Array();
      expect(Array.from(out)).toEqual([10, 999, 20, 999, 30]);
    });

    it('packed slice: identity holds against slice.values (NOT the source)', () => {
      // Stronger contract than buffer-identity. The slice has its
      // own subarray view; toFloat64Array on the slice returns
      // THAT view, not the source's .values. Buffer is shared
      // (subarray semantics), but the Float64Array objects are
      // distinct between source and slice.
      const c = f64([1, 2, 3, 4, 5]);
      const slice = c.slice(1, 4);
      const out = slice.toFloat64Array();
      expect(out).toBe(slice.values);
      expect(out).not.toBe(c.values);
      // Buffer-identity still holds (subarray shares backing).
      expect(out.buffer).toBe(c.values.buffer);
      expect(Array.from(out)).toEqual([2, 3, 4]);
    });

    it('chunked: gathers all chunks; out.length === col.length exactly', async () => {
      // Import lazily so the test file can stay symmetric with the
      // other per-kind blocks above.
      const { ChunkedFloat64Column } =
        await import('../src/columnar/chunked-column.js');
      const chunked = new ChunkedFloat64Column([
        new Float64Column(Float64Array.from([1, 2, 3]), 3),
        new Float64Column(Float64Array.from([4, 5]), 2),
        new Float64Column(Float64Array.from([6, 7, 8, 9]), 4),
      ]);
      const out = chunked.toFloat64Array();
      expect(out).toBeInstanceOf(Float64Array);
      // Length matches the chunked column's length exactly — NOT
      // the sum of chunks' raw values.length (which could include
      // unused tail capacity per chunk if the chunk was
      // constructed with a logical length < buffer length).
      expect(out.length).toBe(chunked.length);
      expect(out.length).toBe(9);
      expect(Array.from(out)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('chunked: each call allocates fresh (chunked has no aliasable buffer)', async () => {
      const { ChunkedFloat64Column } =
        await import('../src/columnar/chunked-column.js');
      const chunked = new ChunkedFloat64Column([
        new Float64Column(Float64Array.from([1, 2]), 2),
        new Float64Column(Float64Array.from([3, 4]), 2),
      ]);
      const a = chunked.toFloat64Array();
      const b = chunked.toFloat64Array();
      expect(Array.from(a)).toEqual([1, 2, 3, 4]);
      expect(Array.from(b)).toEqual([1, 2, 3, 4]);
      // Two distinct allocations — chunked has no single buffer
      // to alias, so successive calls must each materialize.
      expect(a).not.toBe(b);
    });

    it('chunked: single-chunk column still gathers correctly', async () => {
      // Degenerate case — a chunked column with only one chunk.
      // The gather should still produce a fresh Float64Array with
      // the right contents (it materialises through the
      // multi-chunk path uniformly rather than aliasing the
      // single chunk's values buffer).
      const { ChunkedFloat64Column } =
        await import('../src/columnar/chunked-column.js');
      const chunked = new ChunkedFloat64Column([
        new Float64Column(Float64Array.from([10, 20, 30]), 3),
      ]);
      const out = chunked.toFloat64Array();
      expect(out.length).toBe(chunked.length);
      expect(Array.from(out)).toEqual([10, 20, 30]);
    });

    it('chunked: zero-length column returns an empty Float64Array', async () => {
      // Well-formed edge case — chunked column constructed with
      // no data. Gather should produce a zero-length array.
      const { ChunkedFloat64Column } =
        await import('../src/columnar/chunked-column.js');
      const chunked = new ChunkedFloat64Column([]);
      const out = chunked.toFloat64Array();
      expect(out).toBeInstanceOf(Float64Array);
      expect(out.length).toBe(0);
      expect(out.length).toBe(chunked.length);
    });
  });
});

// ─── BooleanColumn ──────────────────────────────────────────────

describe('BooleanColumn public methods', () => {
  it('at / slice', () => {
    const c = bool([true, false, true]);
    expect(c.at(0)).toBe(true);
    expect(c.at(1)).toBe(false);
    expect(c.slice(0, 2).length).toBe(2);
  });

  it('all returns true only when every defined cell is true', () => {
    expect(bool([true, true, true]).all()).toBe(true);
    expect(bool([true, false, true]).all()).toBe(false);
    expect(bool([]).all()).toBe(true); // vacuously
  });

  it('any returns true iff at least one defined cell is true', () => {
    expect(bool([false, false, true]).any()).toBe(true);
    expect(bool([false, false, false]).any()).toBe(false);
    expect(bool([]).any()).toBe(false); // vacuously
  });

  it('none is !any', () => {
    expect(bool([false, false, false]).none()).toBe(true);
    expect(bool([false, true, false]).none()).toBe(false);
  });

  it('all skips invalid cells', () => {
    // false at index 0 is invalid, so all-defined = [true, true]
    const c = bool([false, true, true], [false, true, true]);
    expect(c.all()).toBe(true);
  });

  it('any skips invalid cells', () => {
    // true at index 0 is invalid, so any-defined = [false, false] → false
    const c = bool([true, false, false], [false, true, true]);
    expect(c.any()).toBe(false);
  });

  it('none skips invalid cells', () => {
    // true at index 0 is invalid, so none-defined = [false, false] → true
    const c = bool([true, false, false], [false, true, true]);
    expect(c.none()).toBe(true);
  });

  it('count / hasMissing / nullCount', () => {
    expect(bool([true, false, true]).count()).toBe(3);
    expect(bool([true, false, true]).hasMissing()).toBe(false);
    const partial = bool([true, false, true], [true, false, true]);
    expect(partial.count()).toBe(2);
    expect(partial.hasMissing()).toBe(true);
    expect(partial.nullCount()).toBe(1);
  });

  it('first / last / firstDefined / lastDefined', () => {
    const c = bool([true, false, true]);
    expect(c.first()).toBe(true);
    expect(c.last()).toBe(true);
    const skip = bool(
      [false, true, false, true, false],
      [false, true, true, true, false],
    );
    expect(skip.firstDefined()).toBe(true);
    expect(skip.lastDefined()).toBe(true);
  });
});

// ─── StringColumn ───────────────────────────────────────────────

describe('StringColumn public methods', () => {
  it('at / slice', () => {
    const c = stringColumnFromArray(['a', 'b', 'c']);
    expect(c.at(0)).toBe('a');
    expect(c.at(2)).toBe('c');
    expect(c.slice(0, 2).length).toBe(2);
  });

  it('uniqueCount counts distinct defined values', () => {
    const c = stringColumnFromArray(['a', 'b', 'a', 'c', 'a']);
    expect(c.uniqueCount()).toBe(3);
  });

  it('uniqueCount ignores undefined cells', () => {
    const c = stringColumnFromArray(['a', undefined, 'b', undefined, 'a']);
    expect(c.uniqueCount()).toBe(2);
  });

  it('uniqueCount on empty column', () => {
    expect(stringColumnFromArray([]).uniqueCount()).toBe(0);
  });

  it('first / last / firstDefined / lastDefined', () => {
    const c = stringColumnFromArray([undefined, 'apple', 'banana', undefined]);
    expect(c.first()).toBeUndefined();
    expect(c.last()).toBeUndefined();
    expect(c.firstDefined()).toBe('apple');
    expect(c.lastDefined()).toBe('banana');
  });

  it('hasMissing / nullCount', () => {
    const all = stringColumnFromArray(['a', 'b']);
    expect(all.hasMissing()).toBe(false);
    expect(all.nullCount()).toBe(0);
    const some = stringColumnFromArray(['a', undefined, 'b']);
    expect(some.hasMissing()).toBe(true);
    expect(some.nullCount()).toBe(1);
  });

  it('returned StringColumn instance preserves the public methods after slice()', () => {
    const c = stringColumnFromArray(['x', 'y', 'z']);
    const sliced = c.slice(1, 3);
    expect(sliced).toBeInstanceOf(StringColumn);
    expect(sliced.at(0)).toBe('y');
    expect(sliced.uniqueCount()).toBe(2);
  });
});

// ─── ArrayColumn ────────────────────────────────────────────────

describe('ArrayColumn public methods', () => {
  it('at / slice', () => {
    const c = arrayColumnFromArray([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    expect(c.at(0)).toEqual([1, 2]);
    expect(c.slice(0, 2).length).toBe(2);
  });

  it('first / last / firstDefined / lastDefined', () => {
    const c = arrayColumnFromArray([undefined, [1, 2], [3, 4], undefined]);
    expect(c.first()).toBeUndefined();
    expect(c.last()).toBeUndefined();
    expect(c.firstDefined()).toEqual([1, 2]);
    expect(c.lastDefined()).toEqual([3, 4]);
  });

  it('hasMissing / nullCount', () => {
    const all = arrayColumnFromArray([[1], [2]]);
    expect(all.hasMissing()).toBe(false);
    const some = arrayColumnFromArray([[1], undefined, [2]]);
    expect(some.hasMissing()).toBe(true);
    expect(some.nullCount()).toBe(1);
  });

  it('slice returns an ArrayColumn instance with public methods', () => {
    const c = arrayColumnFromArray([[1], [2], [3]]);
    const sliced = c.slice(0, 2);
    expect(sliced).toBeInstanceOf(ArrayColumn);
    expect(sliced.at(0)).toEqual([1]);
  });
});

// ─── Cross-call integration: methods accessible from series.column() ─

describe('series.column(name).method() — RFC §8 worked example', () => {
  it('returns a Float64Column with all public methods after series.column()', async () => {
    // Import from the in-tree source path so the class object is
    // the same one whose prototype the side-effect import above
    // augmented. Importing from `'pond-ts'` would resolve to the
    // built dist/, which is a separate Float64Column class
    // instance — the instanceof check would fail spuriously even
    // though the methods work.
    const { TimeSeries } = await import('../src/index.js');
    const series = new TimeSeries({
      name: 's',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'value', kind: 'number' },
      ] as const,
      rows: [
        [0, 10],
        [1000, 20],
        [2000, 30],
        [3000, 40],
        [4000, 50],
      ],
    });
    const col = series.column('value');
    expect(col).toBeInstanceOf(Float64Column);
    expect(col.min()).toBe(10);
    expect(col.max()).toBe(50);
    expect(col.mean()).toBeCloseTo(30);
    expect(col.median()).toBe(30);
    expect(col.minMax()).toEqual([10, 50]);
    expect(col.slice(1, 4).mean()).toBeCloseTo(30);
  });
});
