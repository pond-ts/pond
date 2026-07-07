/**
 * Runtime tests for `Float64Column.binBy` — key-domain bucketed
 * reduction (the M4 decimator's correct form for irregular / gappy
 * data). Where `bin` splits by equal index count, `binBy` buckets by
 * explicit sorted `edges` over a parallel monotonic `key`, so a
 * bucket maps to a range of the key axis, not of indices.
 *
 * Coverage:
 * - Basic key-domain bucketing (minMax, minMaxFirstLast, scalar).
 * - The headline correctness property: an empty pixel bucket over a
 *   gap → NaN, where index-domain `bin` would smear clusters together.
 * - Final-edge inclusivity; ties landing in the right bucket.
 * - Validity-aware; empty / all-invalid buckets → NaN.
 * - Argument validation (length mismatch, too-few edges, non-ascending).
 * - `number[]` and `Float64Array` edges both accepted (ArrayLike).
 * - Chunked variant parity.
 */

import { describe, expect, it } from 'vitest';
import { createValidityBitmap } from '../src/columnar/index.js';
import { Float64Column } from '../src/columnar/column.js';
import {
  ChunkedFloat64Column,
  materializeChunkedFloat64,
} from '../src/columnar/chunked-column.js';
import '../src/column.js'; // installs the augmentations

function f64(values: number[], validity?: boolean[]): Float64Column {
  const buf = Float64Array.from(values);
  if (!validity) return new Float64Column(buf, values.length);
  const v = createValidityBitmap(values.length);
  for (let i = 0; i < values.length; i += 1) {
    if (validity[i]) v.set(i);
  }
  return new Float64Column(buf, values.length, v.freeze());
}

// ─── Basic key-domain bucketing ─────────────────────────────────

describe('Float64Column.binBy — basic bucketing', () => {
  it('buckets samples by key against edges (minMax)', () => {
    // key:    0  10  20  30  40
    // value:  1   2   3   4   5
    // edges [0, 20, 40] → 2 buckets:
    //   [0, 20)  → keys 0,10   → values 1,2  → lo=1 hi=2
    //   [20, 40] → keys 20,30,40 (40 inclusive) → 3,4,5 → lo=3 hi=5
    const c = f64([1, 2, 3, 4, 5]);
    const key = [0, 10, 20, 30, 40];
    const { lo, hi } = c.binBy(key, [0, 20, 40], 'minMax');
    expect(Array.from(lo)).toEqual([1, 3]);
    expect(Array.from(hi)).toEqual([2, 5]);
  });

  it('minMaxFirstLast carries entry/exit of each key bucket', () => {
    // Same layout; first/last are the first/last sample by key order.
    const c = f64([1, 2, 3, 4, 5]);
    const key = [0, 10, 20, 30, 40];
    const { lo, hi, first, last } = c.binBy(
      key,
      [0, 20, 40],
      'minMaxFirstLast',
    );
    expect(Array.from(lo)).toEqual([1, 3]);
    expect(Array.from(hi)).toEqual([2, 5]);
    expect(Array.from(first)).toEqual([1, 3]);
    expect(Array.from(last)).toEqual([2, 5]);
  });

  it('scalar reducers reduce per key bucket', () => {
    const c = f64([1, 2, 3, 4, 5]);
    const key = [0, 10, 20, 30, 40];
    expect(Array.from(c.binBy(key, [0, 20, 40], 'sum'))).toEqual([3, 12]);
    expect(Array.from(c.binBy(key, [0, 20, 40], 'count'))).toEqual([2, 3]);
    expect(Array.from(c.binBy(key, [0, 20, 40], 'mean'))).toEqual([1.5, 4]);
  });
});

// ─── The headline correctness property: gaps → NaN ──────────────

describe('Float64Column.binBy — gappy data (the §2.1 win over bin)', () => {
  it('an empty pixel bucket over a gap reduces to NaN', () => {
    // Two clusters of samples with a wide key gap between them.
    // key:   0 1 2            50 51 52
    // value: 5 6 7            8  9  10
    // 6 uniform pixel buckets of width 10 over [0, 60]:
    //   [0,10)  keys 0,1,2      → lo=5 hi=7
    //   [10,20) —— empty ——     → NaN
    //   [20,30) —— empty ——     → NaN
    //   [30,40) —— empty ——     → NaN
    //   [40,50) —— empty ——     → NaN
    //   [50,60] keys 50,51,52   → lo=8 hi=10
    const c = f64([5, 6, 7, 8, 9, 10]);
    const key = [0, 1, 2, 50, 51, 52];
    const edges = [0, 10, 20, 30, 40, 50, 60];
    const { lo, hi } = c.binBy(key, edges, 'minMax');
    expect(lo[0]).toBe(5);
    expect(hi[0]).toBe(7);
    expect(Number.isNaN(lo[1]!)).toBe(true);
    expect(Number.isNaN(lo[2]!)).toBe(true);
    expect(Number.isNaN(lo[3]!)).toBe(true);
    expect(Number.isNaN(lo[4]!)).toBe(true);
    expect(lo[5]).toBe(8);
    expect(hi[5]).toBe(10);
  });

  it('contrast: index-domain bin cannot surface the gap at any bucket count', () => {
    // The exact reason binBy exists. Same data + key as the test
    // above. Index `bin` never looks at the key axis, so no bucket
    // count reveals the [2, 50] gap: at bins=6 it's per-cell (every
    // sample its own bucket, no NaN), and any coarser count just
    // merges adjacent *indices* — the two clusters, being adjacent in
    // index order, never land in separate-with-a-hole buckets the way
    // pixel-aligned edges put them. So the gap is invisible to `bin`;
    // only `binBy` (asserted in the test above) surfaces it as NaN.
    const c = f64([5, 6, 7, 8, 9, 10]);
    const idx = c.bin(6, 'minMax');
    expect(Array.from(idx.lo)).toEqual([5, 6, 7, 8, 9, 10]);
    // No NaN anywhere — the gap left no trace.
    expect(Array.from(idx.lo).some((v) => Number.isNaN(v))).toBe(false);
  });
});

// ─── Edge semantics ─────────────────────────────────────────────

describe('Float64Column.binBy — edge semantics', () => {
  it('the final upper edge is inclusive', () => {
    // key:   0 5 10 ; a sample exactly at the max edge (10) must land
    // in the last bucket, not be dropped.
    //   [0,5)  → key 0        → value 1
    //   [5,10] → keys 5,10    → values 2,3   (10 inclusive)
    const c = f64([1, 2, 3]);
    const { lo, hi } = c.binBy([0, 5, 10], [0, 5, 10], 'minMax');
    expect(Array.from(lo)).toEqual([1, 2]);
    expect(Array.from(hi)).toEqual([1, 3]);
  });

  it('a tie at a lower edge lands in the upper bucket (>= lower bound)', () => {
    // All three keys equal 10; edges [0,10,20].
    //   [0,10)  → empty (10 is not < 10) → NaN
    //   [10,20] → keys 10,10,10          → values 1,2,3
    const c = f64([1, 2, 3]);
    const { lo, hi } = c.binBy([10, 10, 10], [0, 10, 20], 'minMax');
    expect(Number.isNaN(lo[0]!)).toBe(true);
    expect(lo[1]).toBe(1);
    expect(hi[1]).toBe(3);
  });

  it('samples before the first edge or after the last are excluded', () => {
    // key -5 is below edges[0]=0; key 100 is above edges[W]=60.
    // Only the interior samples land in buckets.
    const c = f64([99, 5, 6, 88]);
    const key = [-5, 10, 20, 100];
    const { lo, hi } = c.binBy(key, [0, 30, 60], 'minMax');
    //   [0,30)  → keys 10,20 → values 5,6 → lo=5 hi=6
    //   [30,60] → none        → NaN
    expect(lo[0]).toBe(5);
    expect(hi[0]).toBe(6);
    expect(Number.isNaN(lo[1]!)).toBe(true);
  });
});

// ─── Validity-aware ─────────────────────────────────────────────

describe('Float64Column.binBy — validity-aware', () => {
  it('skips undefined cells; an all-invalid bucket → NaN', () => {
    // key:   0  10  20  30
    // value: 10 999 30  999   (idx 1,3 invalid)
    // edges [0, 20, 40]:
    //   [0,20)  → keys 0,10 → defined [10]     → lo=hi=first=last=10
    //   [20,40] → keys 20,30 → defined [30]    → lo=hi=first=last=30
    const c = f64([10, 999, 30, 999], [true, false, true, false]);
    const key = [0, 10, 20, 30];
    const { lo, hi, first, last } = c.binBy(
      key,
      [0, 20, 40],
      'minMaxFirstLast',
    );
    expect(Array.from(lo)).toEqual([10, 30]);
    expect(Array.from(hi)).toEqual([10, 30]);
    expect(Array.from(first)).toEqual([10, 30]);
    expect(Array.from(last)).toEqual([10, 30]);
  });

  it('a bucket whose only samples are all-invalid → NaN', () => {
    const c = f64([10, 999, 999, 40], [true, false, false, true]);
    const key = [0, 10, 20, 30];
    // edges [0, 15, 30, 45]:
    //   [0,15)  key 0        defined [10] → 10
    //   [15,30) keys 20      invalid only → NaN
    //   [30,45] key 30       defined [40] → 40
    const { lo } = c.binBy(key, [0, 15, 30, 45], 'minMax');
    expect(lo[0]).toBe(10);
    expect(Number.isNaN(lo[1]!)).toBe(true);
    expect(lo[2]).toBe(40);
  });
});

// ─── Argument validation ────────────────────────────────────────

describe('Float64Column.binBy — argument validation', () => {
  const c = f64([1, 2, 3]);

  it('rejects a key whose length !== column length', () => {
    expect(() => c.binBy([0, 1], [0, 1, 2], 'min')).toThrow(RangeError);
  });
  it('rejects fewer than 2 edges (no bucket)', () => {
    expect(() => c.binBy([0, 1, 2], [5], 'min')).toThrow(RangeError);
  });
  it('rejects non-ascending edges', () => {
    expect(() => c.binBy([0, 1, 2], [0, 20, 10], 'min')).toThrow(RangeError);
  });
  it('rejects an unknown reducer (message names binBy)', () => {
    expect(() => c.binBy([0, 1, 2], [0, 3], 'nope' as 'min')).toThrow(
      /binBy: unknown reducer/,
    );
  });
});

// ─── ArrayLike inputs ───────────────────────────────────────────

describe('Float64Column.binBy — accepts number[] and Float64Array', () => {
  it('Float64Array key and edges produce the same result as number[]', () => {
    const c = f64([1, 2, 3, 4, 5]);
    const keyArr = [0, 10, 20, 30, 40];
    const edgesArr = [0, 20, 40];
    const fromArrays = c.binBy(keyArr, edgesArr, 'minMax');
    const fromTyped = c.binBy(
      Float64Array.from(keyArr),
      Float64Array.from(edgesArr),
      'minMax',
    );
    expect(Array.from(fromTyped.lo)).toEqual(Array.from(fromArrays.lo));
    expect(Array.from(fromTyped.hi)).toEqual(Array.from(fromArrays.hi));
  });
});

// ─── Chunked variant ────────────────────────────────────────────

describe('ChunkedFloat64Column.binBy — same output as packed', () => {
  it('matches the packed result over a 3-chunk column', () => {
    const chunked = new ChunkedFloat64Column(
      [
        [5, 6, 7],
        [8, 9],
        [10, 11, 12],
      ].map((c) => new Float64Column(Float64Array.from(c), c.length)),
    );
    const packed = materializeChunkedFloat64(chunked);
    const key = [0, 1, 2, 50, 51, 60, 61, 62];
    const edges = [0, 10, 20, 30, 40, 50, 60, 70];
    const cOut = chunked.binBy(key, edges, 'minMaxFirstLast');
    const pOut = packed.binBy(key, edges, 'minMaxFirstLast');
    expect(Array.from(cOut.lo)).toEqual(Array.from(pOut.lo));
    expect(Array.from(cOut.hi)).toEqual(Array.from(pOut.hi));
    expect(Array.from(cOut.first)).toEqual(Array.from(pOut.first));
    expect(Array.from(cOut.last)).toEqual(Array.from(pOut.last));
  });
});
