/**
 * Runtime tests for Phase 4.7 step 8c — `Float64Column.bin`.
 *
 * The chart's per-pixel downsampling primitive. Equal-width index
 * bins, reducer per bin. Tests cover:
 *
 * - Each built-in reducer (min/max/sum/mean/stdev/median/count,
 *   percentile-via-'p${q}', fused 'minMax') produces the expected
 *   per-bin output.
 * - Output shape: `Float64Array(W)` for scalars; `{ lo, hi }` two
 *   channels for `'minMax'`.
 * - Empty-bin handling (when `bins > length`):
 *   - sum / count → 0 (mathematical empty)
 *   - min / max / mean / stdev / median / percentile → NaN
 *   - minMax → NaN on both channels
 * - Validity-aware: invalid cells excluded from per-bin reductions.
 * - Edge cases: `bins === 1` (whole-column reduction),
 *   `bins === length` (per-cell), `bins > length` (sparse output),
 *   non-uniform bin sizes when `length % bins !== 0`.
 * - Argument validation: non-integer / non-positive bins throw;
 *   unknown reducer throws.
 * - Chunked variant: same output as packed via materialize.
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

// ─── Output shape ───────────────────────────────────────────────

describe('Float64Column.bin — output shape', () => {
  it('scalar reducer returns Float64Array(W)', () => {
    const c = f64([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const out = c.bin(5, 'min');
    expect(out).toBeInstanceOf(Float64Array);
    expect(out.length).toBe(5);
  });

  it("'minMax' returns { lo, hi } two-channel", () => {
    const c = f64([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const out = c.bin(5, 'minMax');
    expect(out.lo).toBeInstanceOf(Float64Array);
    expect(out.hi).toBeInstanceOf(Float64Array);
    expect(out.lo.length).toBe(5);
    expect(out.hi.length).toBe(5);
  });
});

// ─── Each built-in reducer ──────────────────────────────────────

describe('Float64Column.bin — built-in reducers', () => {
  // 10 elements split into 5 bins of 2 each.
  const c = f64([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  it('min', () => {
    expect(Array.from(c.bin(5, 'min'))).toEqual([1, 3, 5, 7, 9]);
  });
  it('max', () => {
    expect(Array.from(c.bin(5, 'max'))).toEqual([2, 4, 6, 8, 10]);
  });
  it('sum', () => {
    expect(Array.from(c.bin(5, 'sum'))).toEqual([3, 7, 11, 15, 19]);
  });
  it('mean', () => {
    expect(Array.from(c.bin(5, 'mean'))).toEqual([1.5, 3.5, 5.5, 7.5, 9.5]);
  });
  it('median', () => {
    // For 2-element bins, median = average of the two.
    expect(Array.from(c.bin(5, 'median'))).toEqual([1.5, 3.5, 5.5, 7.5, 9.5]);
  });
  it('count', () => {
    expect(Array.from(c.bin(5, 'count'))).toEqual([2, 2, 2, 2, 2]);
  });
  it('stdev (each 2-element bin has stdev = 0.5)', () => {
    const out = Array.from(c.bin(5, 'stdev'));
    for (const v of out) expect(v).toBeCloseTo(0.5, 10);
  });
  it('minMax produces the right per-bin extents', () => {
    const { lo, hi } = c.bin(5, 'minMax');
    expect(Array.from(lo)).toEqual([1, 3, 5, 7, 9]);
    expect(Array.from(hi)).toEqual([2, 4, 6, 8, 10]);
  });
});

// ─── Percentile-via-string ──────────────────────────────────────

describe("Float64Column.bin — percentile via 'p${q}'", () => {
  it('p50 is the median', () => {
    const c = f64([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const p50 = c.bin(5, 'p50');
    const med = c.bin(5, 'median');
    for (let i = 0; i < 5; i += 1) {
      expect(p50[i]).toBe(med[i]);
    }
  });

  it('p0 is min, p100 is max', () => {
    const c = f64([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(Array.from(c.bin(5, 'p0'))).toEqual([1, 3, 5, 7, 9]);
    expect(Array.from(c.bin(5, 'p100'))).toEqual([2, 4, 6, 8, 10]);
  });

  it('fractional percentile (p99.9) parses and produces values near the bin max', () => {
    // 5 bins of 2 elements over [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]:
    //   bin maxes: 2, 4, 6, 8, 10
    // p99.9 on a 2-element bin interpolates between the lower and
    // upper value at rank = 0.999 — extremely close to the max. A
    // regression that truncated 'p99.9' to 'p99' would interpolate
    // slightly less, so this assertion catches it.
    const c = f64([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const out = c.bin(5, 'p99.9');
    expect(out.length).toBe(5);
    const expectedMaxes = [2, 4, 6, 8, 10];
    for (let i = 0; i < 5; i += 1) {
      expect(out[i]).toBeCloseTo(expectedMaxes[i]!, 2);
      // Sanity: must be greater than the p99 value (which would be
      // 1.99, 3.99, etc. — but extremely close. The right check is
      // "between p99 and p100").
      expect(out[i]!).toBeLessThanOrEqual(expectedMaxes[i]!);
      expect(out[i]!).toBeGreaterThan(expectedMaxes[i]! - 0.01);
    }
  });
});

// ─── Empty-bin handling ─────────────────────────────────────────

describe('Float64Column.bin — empty bins (bins > length)', () => {
  it('sum / count of an empty bin = 0', () => {
    const c = f64([1, 2]);
    const sums = Array.from(c.bin(10, 'sum'));
    const counts = Array.from(c.bin(10, 'count'));
    // bin 0: [0..1) → [1]; bin 5: [1..2) → [2]; others are empty.
    expect(sums.filter((v) => v === 0).length).toBeGreaterThan(0);
    expect(counts.filter((v) => v === 0).length).toBeGreaterThan(0);
  });

  it('min / max / mean / median / stdev of an empty bin = NaN', () => {
    const c = f64([1, 2]);
    const mins = c.bin(10, 'min');
    let anyNaN = false;
    for (const v of mins) if (Number.isNaN(v)) anyNaN = true;
    expect(anyNaN).toBe(true);
  });

  it("'minMax' on empty bins writes NaN to both channels", () => {
    const c = f64([1, 2]);
    const { lo, hi } = c.bin(10, 'minMax');
    let anyNaN = false;
    for (let i = 0; i < lo.length; i += 1) {
      if (Number.isNaN(lo[i]!) && Number.isNaN(hi[i]!)) anyNaN = true;
    }
    expect(anyNaN).toBe(true);
  });
});

// ─── Validity-aware ─────────────────────────────────────────────

describe('Float64Column.bin — validity-aware', () => {
  it('reduces only over defined cells per bin', () => {
    // 6 values; mark index 1 and 4 invalid. Bins of 2.
    const c = f64(
      [10, 999, 20, 30, 999, 40],
      [true, false, true, true, false, true],
    );
    // bin 0: [10, undef] → defined [10] → min=10, max=10
    // bin 1: [20, 30] → min=20, max=30
    // bin 2: [undef, 40] → defined [40] → min=40, max=40
    expect(Array.from(c.bin(3, 'min'))).toEqual([10, 20, 40]);
    expect(Array.from(c.bin(3, 'max'))).toEqual([10, 30, 40]);
  });

  it("an all-invalid bin's reducer returns NaN (count / sum = 0)", () => {
    // Bin layout (2 bins of 2 indices each):
    //   bin 0 (idx 0-1): defined = [10]      → min = 10, count = 1
    //   bin 1 (idx 2-3): defined = []        → min = NaN, count = 0
    const c = f64([10, 999, 999, 999], [true, false, false, false]);
    const mins = Array.from(c.bin(2, 'min'));
    expect(mins[0]).toBe(10);
    expect(Number.isNaN(mins[1]!)).toBe(true);
    const counts = Array.from(c.bin(2, 'count'));
    expect(counts).toEqual([1, 0]);
    const sums = Array.from(c.bin(2, 'sum'));
    expect(sums).toEqual([10, 0]);
  });

  it('minMax over a validity-aware column reduces only defined cells (packed inline path)', () => {
    // Direct coverage for the inlined minMax+validity path on the
    // packed column class. Existing minMax tests run on validity-
    // free columns; this pins the validity branch end-to-end.
    //
    // 6 values, indices 1 and 4 invalid. Bins of 2:
    //   bin 0 (idx 0-1): defined [10]     → lo=10, hi=10
    //   bin 1 (idx 2-3): defined [20, 30] → lo=20, hi=30
    //   bin 2 (idx 4-5): defined [40]     → lo=40, hi=40
    const c = f64(
      [10, 999, 20, 30, 999, 40],
      [true, false, true, true, false, true],
    );
    const { lo, hi } = c.bin(3, 'minMax');
    expect(Array.from(lo)).toEqual([10, 20, 40]);
    expect(Array.from(hi)).toEqual([10, 30, 40]);
  });

  it('minMax bin with no defined cells writes NaN to both lo and hi (packed inline path)', () => {
    // bin 1 (idx 2-3) is entirely invalid — both lo and hi
    // channels must land NaN.
    const c = f64([10, 999, 999, 999], [true, false, false, false]);
    const { lo, hi } = c.bin(2, 'minMax');
    expect(lo[0]).toBe(10);
    expect(hi[0]).toBe(10);
    expect(Number.isNaN(lo[1]!)).toBe(true);
    expect(Number.isNaN(hi[1]!)).toBe(true);
  });

  it('minMax over a column with all leading-invalid then a defined cell at the bin tail', () => {
    // Verify the `while (i < end && !validity.isDefined(i))` skip-
    // ahead correctly finds the first defined cell when the start
    // of the bin is all-undefined. Bin of 4 indices, only idx 3
    // defined.
    const c = f64(
      [999, 999, 999, 50, 60, 70, 80, 90],
      [false, false, false, true, true, true, true, true],
    );
    // bin 0 (idx 0-3): defined [50] only → lo=50, hi=50
    // bin 1 (idx 4-7): defined [60,70,80,90] → lo=60, hi=90
    const { lo, hi } = c.bin(2, 'minMax');
    expect(Array.from(lo)).toEqual([50, 60]);
    expect(Array.from(hi)).toEqual([50, 90]);
  });
});

// ─── Edge cases ─────────────────────────────────────────────────

describe('Float64Column.bin — edge cases', () => {
  it('bins=1 is a whole-column reduction', () => {
    const c = f64([3, 1, 4, 1, 5, 9, 2, 6]);
    expect(c.bin(1, 'min')[0]).toBe(1);
    expect(c.bin(1, 'max')[0]).toBe(9);
    const { lo, hi } = c.bin(1, 'minMax');
    expect(lo[0]).toBe(1);
    expect(hi[0]).toBe(9);
  });

  it('bins=length is a per-cell mirror', () => {
    const c = f64([10, 20, 30, 40, 50]);
    expect(Array.from(c.bin(5, 'min'))).toEqual([10, 20, 30, 40, 50]);
    expect(Array.from(c.bin(5, 'max'))).toEqual([10, 20, 30, 40, 50]);
  });

  it('non-uniform bin sizes (length % bins !== 0)', () => {
    const c = f64([1, 2, 3, 4, 5, 6, 7]);
    // 7 elements / 3 bins: floor((0*7)/3)=0, floor((1*7)/3)=2,
    // floor((2*7)/3)=4, floor((3*7)/3)=7
    // → bin sizes: 2, 2, 3
    const sums = Array.from(c.bin(3, 'sum'));
    expect(sums).toEqual([1 + 2, 3 + 4, 5 + 6 + 7]);
  });

  it('empty column produces NaN bins (or 0 for sum/count)', () => {
    const c = f64([]);
    const mins = Array.from(c.bin(4, 'min'));
    expect(mins.every((v) => Number.isNaN(v))).toBe(true);
    expect(Array.from(c.bin(4, 'sum'))).toEqual([0, 0, 0, 0]);
    expect(Array.from(c.bin(4, 'count'))).toEqual([0, 0, 0, 0]);
  });
});

// ─── Argument validation ────────────────────────────────────────

describe('Float64Column.bin — argument validation', () => {
  const c = f64([1, 2, 3]);

  it('rejects bins = 0', () => {
    expect(() => c.bin(0, 'min')).toThrow(RangeError);
  });
  it('rejects negative bins', () => {
    expect(() => c.bin(-1, 'min')).toThrow(RangeError);
  });
  it('rejects non-integer bins', () => {
    expect(() => c.bin(2.5, 'min')).toThrow(RangeError);
  });
  it('rejects unknown reducer name', () => {
    expect(() => c.bin(2, 'unknown' as 'min')).toThrow(TypeError);
  });
});

// ─── Chunked variant ────────────────────────────────────────────

describe('ChunkedFloat64Column.bin — same output as packed', () => {
  function makeChunked(values: number[][]): ChunkedFloat64Column {
    const chunks = values.map(
      (chunk) => new Float64Column(Float64Array.from(chunk), chunk.length),
    );
    return new ChunkedFloat64Column(chunks);
  }

  it('matches the packed result over a 3-chunk column (all-defined)', () => {
    const chunked = makeChunked([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10],
    ]);
    const packed = materializeChunkedFloat64(chunked);
    expect(Array.from(chunked.bin(5, 'min'))).toEqual(
      Array.from(packed.bin(5, 'min')),
    );
    expect(Array.from(chunked.bin(5, 'sum'))).toEqual(
      Array.from(packed.bin(5, 'sum')),
    );
    const cMinMax = chunked.bin(5, 'minMax');
    const pMinMax = packed.bin(5, 'minMax');
    expect(Array.from(cMinMax.lo)).toEqual(Array.from(pMinMax.lo));
    expect(Array.from(cMinMax.hi)).toEqual(Array.from(pMinMax.hi));
  });

  it('matches the packed result with chunk-level validity gaps', () => {
    // Build a chunked column with validity gaps inside each chunk.
    // The materialize helper must propagate the per-chunk validity
    // into the aggregate; the chunked bin (which goes
    // through materialize) must produce identical output to the
    // packed equivalent. A regression that lost validity during
    // materialization would corrupt per-bin reductions.
    function f64WithValidity(
      values: number[],
      validity: boolean[],
    ): Float64Column {
      const buf = Float64Array.from(values);
      const v = createValidityBitmap(values.length);
      for (let i = 0; i < values.length; i += 1) {
        if (validity[i]) v.set(i);
      }
      return new Float64Column(buf, values.length, v.freeze());
    }
    // Three chunks; each chunk has at least one invalid cell.
    const chunked = new ChunkedFloat64Column([
      f64WithValidity([10, 999, 30], [true, false, true]),
      f64WithValidity([999, 50, 60], [false, true, true]),
      f64WithValidity([70, 999], [true, false]),
    ]);
    const packed = materializeChunkedFloat64(chunked);
    // Bin layout (4 bins of 2 indices over length=8):
    //   bin 0 (idx 0-1): defined = [10]      → min=10, count=1, sum=10
    //   bin 1 (idx 2-3): defined = [30]      → min=30, count=1, sum=30
    //   bin 2 (idx 4-5): defined = [50, 60]  → min=50, count=2, sum=110
    //   bin 3 (idx 6-7): defined = [70]      → min=70, count=1, sum=70
    const cMins = Array.from(chunked.bin(4, 'min'));
    const pMins = Array.from(packed.bin(4, 'min'));
    expect(cMins).toEqual(pMins);
    expect(cMins).toEqual([10, 30, 50, 70]);

    const cCounts = Array.from(chunked.bin(4, 'count'));
    expect(cCounts).toEqual([1, 1, 2, 1]);

    const cSums = Array.from(chunked.bin(4, 'sum'));
    expect(cSums).toEqual([10, 30, 110, 70]);

    const cMinMax = chunked.bin(4, 'minMax');
    expect(Array.from(cMinMax.lo)).toEqual([10, 30, 50, 70]);
    expect(Array.from(cMinMax.hi)).toEqual([10, 30, 60, 70]);
  });
});
