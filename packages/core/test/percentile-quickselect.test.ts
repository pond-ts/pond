import { describe, expect, it } from 'vitest';
import { Float64Column, validityFromPredicate } from '../src/columnar/index.js';
import { reducePercentileColumn } from '../src/reducers/percentile.js';
import { resolveReducer } from '../src/reducers/index.js';

/* -------------------------------------------------------------------------- */
/* Percentile via quickselect must equal percentile via a full sort.           */
/*                                                                             */
/* `reducePercentileColumn` used to densify then call                          */
/* `Float64Array.prototype.sort()`. It now runs quickselect, which answers     */
/* the same question in O(n) instead of O(n log n). The contract is that the   */
/* answer is unchanged — so every test here computes the reference by          */
/* actually sorting, rather than by hard-coding what we think it should be.    */
/*                                                                             */
/* The hazards quickselect has and a sort does not:                            */
/*   - already-sorted / reverse-sorted input degrading to O(n^2)               */
/*   - heavy duplicates stalling or mis-partitioning a Hoare loop              */
/*   - the two-rank interpolation path selecting from the wrong sub-range      */
/* Each gets its own case.                                                     */
/* -------------------------------------------------------------------------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function column(
  source: ReadonlyArray<number | undefined>,
  allFinite = true,
): Float64Column {
  const n = source.length;
  const values = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    values[i] = typeof source[i] === 'number' ? (source[i] as number) : 0;
  }
  const validity = validityFromPredicate(
    n,
    (i) => typeof source[i] === 'number',
  );
  return new Float64Column(values, n, validity, allFinite);
}

/**
 * The reference: densify exactly as the reducer does, then sort — using
 * the **row path's** comparator, `(a, b) => a - b`, not
 * `Float64Array.prototype.sort()`.
 *
 * The two differ on signed zero. `Float64Array.sort()` implements the
 * spec's total order, which places `-0` strictly before `+0`; the
 * comparator returns `-0` for that pair, which `Array.prototype.sort`
 * reads as "equal" and (being stable) leaves in input order. So on
 * `[0, -0, 0, -0, 0]` the typed-array sort yields `-0` for p0 and the
 * row path yields `+0`.
 *
 * That means the old column path — which used `Float64Array.sort()` —
 * **disagreed with the row path** on signed-zero input, and quickselect
 * (which compares with `<` / `>`, under which `-0` and `+0` are equal)
 * agrees with it. Pinning against the row path is therefore pinning
 * against the library's canonical order, and it is what makes the
 * `aggregate` fast-path gate safe to flip per call.
 */
function referencePercentile(
  source: ReadonlyArray<number | undefined>,
  q: number,
  allFinite = true,
): number | undefined {
  const dense = source.filter((v): v is number => typeof v === 'number');
  const finite = allFinite ? dense : dense.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return undefined;
  const sorted = finite.slice().sort((a, b) => a - b);
  const rank = (q / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
}

const QUANTILES = [0, 0.1, 1, 5, 25, 33.3, 50, 66.7, 75, 95, 99, 99.9, 100];

describe('percentile via quickselect matches percentile via sort', () => {
  const rnd = mulberry32(0x51c7);

  const SHAPES: Record<string, ReadonlyArray<number | undefined>> = {
    random: Array.from({ length: 1001 }, () => rnd() * 2000 - 1000),
    // The O(n^2) traps: a naive pivot choice turns these quadratic, and
    // columnar percentile input is often exactly this (a monotonic key,
    // a cumulative result, a byValue materialisation).
    'already sorted': Array.from({ length: 1001 }, (_, i) => i),
    'reverse sorted': Array.from({ length: 1001 }, (_, i) => 1000 - i),
    'sorted with a tail': [
      ...Array.from({ length: 900 }, (_, i) => i),
      ...Array.from({ length: 101 }, () => rnd() * 100),
    ],
    // Heavy duplicates: the classic Hoare-partition stall.
    'all equal': Array.from({ length: 501 }, () => 7),
    'two values': Array.from({ length: 501 }, (_, i) => (i % 2 ? 1 : 9)),
    'few distinct': Array.from({ length: 997 }, () => Math.floor(rnd() * 3)),
    'mostly one value': Array.from({ length: 999 }, (_, i) =>
      i % 97 === 0 ? rnd() * 100 : 42,
    ),
    // Sizes around the insertion-sort threshold (16).
    single: [5],
    pair: [9, 3],
    'exactly 16': Array.from({ length: 16 }, () => rnd() * 10),
    'exactly 17': Array.from({ length: 17 }, () => rnd() * 10),
    // Gaps, so the densify path is exercised too.
    'with gaps': Array.from({ length: 1001 }, (_, i) =>
      i % 7 === 0 ? undefined : rnd() * 500,
    ),
    'mostly missing': Array.from({ length: 1001 }, (_, i) =>
      i % 101 === 0 ? rnd() * 500 : undefined,
    ),
    negatives: Array.from({ length: 501 }, () => -rnd() * 1000),
    'signed zeros': [0, -0, 0, -0, 0],
    extremes: [Number.MAX_VALUE, -Number.MAX_VALUE, 0, 1, -1],
    denormals: [5e-324, 1e-320, -5e-324, 0],
  };

  for (const [name, source] of Object.entries(SHAPES)) {
    it(`'${name}' agrees with the sorted reference at every quantile`, () => {
      const col = column(source);
      for (const q of QUANTILES) {
        expect(reducePercentileColumn(col, q), `${name} @ p${q}`).toStrictEqual(
          referencePercentile(source, q),
        );
      }
    });
  }

  it('agrees on non-finite input (guarded path)', () => {
    const source = Array.from({ length: 997 }, (_, i) => {
      if (i % 11 === 0) return NaN;
      if (i % 17 === 0) return Infinity;
      if (i % 23 === 0) return -Infinity;
      if (i % 5 === 0) return undefined;
      return i - 500;
    });
    const col = column(source, false);
    for (const q of QUANTILES) {
      expect(reducePercentileColumn(col, q), `p${q}`).toStrictEqual(
        referencePercentile(source, q, false),
      );
    }
  });

  it('agrees across many random shapes and sizes', () => {
    const r = mulberry32(0xd1ce);
    for (let trial = 0; trial < 200; trial += 1) {
      const n = 1 + Math.floor(r() * 60);
      // Deliberately narrow value range so duplicates are common.
      const spread = trial % 3 === 0 ? 3 : 1000;
      const source = Array.from({ length: n }, () =>
        r() < 0.1 ? undefined : Math.floor(r() * spread),
      );
      const col = column(source);
      for (const q of [0, 25, 50, 75, 100, 37.5]) {
        expect(
          reducePercentileColumn(col, q),
          `trial ${trial} n=${n} p${q}: ${JSON.stringify(source)}`,
        ).toStrictEqual(referencePercentile(source, q));
      }
    }
  });

  it('does not go quadratic on sorted input', () => {
    // A first-element pivot would make this O(n^2): 200k sorted cells is
    // ~2e10 comparisons, i.e. it would not finish. Median-of-three keeps
    // it linear. The assertion is the wall clock — a bound loose enough
    // never to flake, tight enough that quadratic cannot pass it.
    const n = 200_000;
    const values = new Float64Array(n);
    for (let i = 0; i < n; i += 1) values[i] = i;
    const col = new Float64Column(values, n, undefined, true);
    const started = Date.now();
    expect(reducePercentileColumn(col, 50)).toBe((n - 1) / 2);
    expect(reducePercentileColumn(col, 95)).toBeCloseTo((n - 1) * 0.95, 6);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('now agrees with the row path on signed zero (it used not to)', () => {
    // Regression pin for a cross-path drift the switch to quickselect
    // closed. `Float64Array.sort()` places -0 strictly before +0, so the
    // old column path returned -0 here while the row path returned +0.
    // Quickselect compares with < / >, under which they are equal, so the
    // two paths now agree. Worth pinning: the aggregate fast path decides
    // per call which one runs, so a disagreement is a data-dependent
    // wrong answer.
    const source = [0, -0, 0, -0, 0];
    const col = column(source);
    const p0 = reducePercentileColumn(col, 0);
    expect(Object.is(p0, 0)).toBe(true);
    expect(Object.is(p0, -0)).toBe(false);
    expect(p0).toStrictEqual(resolveReducer('p0').reduce!([], source));
  });

  it('leaves the reducer registry consistent (median === p50)', () => {
    const source = Array.from({ length: 333 }, () => mulberry32(9)() * 100);
    const col = column(source);
    expect(resolveReducer('median').reduceColumn!(col)).toStrictEqual(
      resolveReducer('p50').reduceColumn!(col),
    );
  });

  it('agrees with the row path, which still sorts', () => {
    // `reduce(defined, numeric)` is unchanged and sorts a boxed array.
    // The columnar path now quickselects. Cross-path agreement is the
    // property the library's aggregate fast-path gate depends on.
    const r = mulberry32(0xa11);
    const source = Array.from({ length: 777 }, () => r() * 100 - 50);
    const col = column(source);
    for (const q of QUANTILES) {
      const def = resolveReducer(`p${q}`);
      expect(def.reduceColumn!(col), `p${q}`).toStrictEqual(
        def.reduce!([], source),
      );
    }
  });
});
