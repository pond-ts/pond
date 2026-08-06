import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';
import { resolveReducer, rollingStateFor } from '../src/reducers/index.js';

/* -------------------------------------------------------------------------- */
/* [PND-ROLLKERN] — the inlined `stdev` must be BIT-identical to the state.    */
/*                                                                             */
/* `rolling(count, 'stdev')` now runs Welford inline in the sweep instead of   */
/* calling the reducer state's add / remove / snapshot per row. The recurrence  */
/* was transcribed verbatim, and the whole value of that recurrence is its     */
/* numerical behaviour:                                                        */
/*                                                                             */
/*   - the deviation-space mean update avoids the `n·mean − v` product, which  */
/*     loses precision at large magnitudes                                     */
/*   - the `n → 1` case is SET directly rather than reached by the reverse     */
/*     step, which leaves rounding residue (~0.016 on 1e10 offsets)            */
/*   - `m2 < 0` is clamped, absorbing round-off and gross-outlier cancellation */
/*                                                                             */
/* So the assertion here is `Object.is`, not `toBeCloseTo`. A "close enough"   */
/* test would pass for a transcription that quietly dropped one of those       */
/* cases — which is exactly the regression worth catching, because it would    */
/* only show up on data with large offsets that no ordinary fixture has.       */
/*                                                                             */
/* The reference drives the REAL `rollingState()` object through the same      */
/* window walk, so any drift between the two implementations fails here.       */
/* -------------------------------------------------------------------------- */

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number', required: false },
] as const;

type Cell = number | undefined;

const series = (cells: Cell[]) =>
  new TimeSeries({
    name: 's',
    schema,
    rows: cells.map((v, i) => [i * 1000, v] as const) as never,
  });

const readColumn = (s: unknown, name: string): Cell[] => {
  const r = s as {
    readonly length: number;
    column(n: string): { at(i: number): unknown };
  };
  return Array.from(
    { length: r.length },
    (_, i) => r.column(name).at(i) as Cell,
  );
};

/**
 * Trailing count-window `stdev` computed by driving the actual reducer
 * state — the implementation the inlined version replaced.
 */
function referenceRollingStdev(
  cells: Cell[],
  count: number,
  minSamples: number,
  allFiniteAndDense: boolean,
): Cell[] {
  // Mirrors the kernel's own choice: the bare built-in state is only safe
  // when the source is provably all-finite and fully defined; otherwise the
  // wrapper applies the non-finite policy.
  const state = allFiniteAndDense
    ? resolveReducer('stdev').rollingState()
    : rollingStateFor('stdev');
  const out: Cell[] = new Array(cells.length);
  let windowStart = 0;
  let windowEnd = 0;
  for (let index = 0; index < cells.length; index += 1) {
    const lo = Math.max(0, index - count + 1);
    const hi = index;
    while (windowEnd <= hi) {
      state.add(windowEnd, cells[windowEnd]);
      windowEnd += 1;
    }
    while (windowStart < lo) {
      state.remove(windowStart, cells[windowStart]);
      windowStart += 1;
    }
    if (windowEnd - windowStart < minSamples) continue;
    const v = state.snapshot();
    out[index] = v as Cell;
  }
  return out;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(0x57de);

const SHAPES: Record<string, Cell[]> = {
  random: Array.from({ length: 300 }, () => rnd() * 200 - 100),
  // The case the deviation-space update exists for: near-equal values at a
  // large offset, where a naive `n·mean − v` cancels catastrophically.
  'large offset, near-equal': Array.from(
    { length: 300 },
    (_, i) => 1e10 + (i % 7) * 0.25,
  ),
  'very large offset': Array.from({ length: 200 }, () => 1e12 + rnd() * 3),
  // Exercises the `n → 1` exact-reset branch on every eviction.
  'flat then spike': [
    ...Array.from({ length: 50 }, () => 42),
    1e6,
    ...Array.from({ length: 50 }, () => 42),
  ],
  // The gross-outlier eviction the doc warns about: `m2 -= huge` cancels.
  'outlier evicted': [
    ...Array.from({ length: 20 }, () => 0.01 * rnd()),
    1e6,
    ...Array.from({ length: 40 }, () => 0.01 * rnd()),
  ],
  constant: Array.from({ length: 100 }, () => 7),
  'two values': Array.from({ length: 100 }, (_, i) => (i % 2 ? 1 : 1.0000001)),
  monotonic: Array.from({ length: 200 }, (_, i) => i * 1.5),
  negatives: Array.from({ length: 150 }, () => -rnd() * 1000),
  'signed zeros': Array.from({ length: 40 }, (_, i) => (i % 2 ? 0 : -0)),
  denormals: Array.from({ length: 60 }, () => 5e-324 * (1 + rnd())),
  'with gaps': Array.from({ length: 200 }, (_, i) =>
    i % 9 === 4 ? undefined : rnd() * 50,
  ),
  'long gap run': [
    ...Array.from({ length: 30 }, () => rnd() * 10),
    ...Array.from({ length: 25 }, () => undefined),
    ...Array.from({ length: 30 }, () => rnd() * 10),
  ],
  'all missing': Array.from({ length: 40 }, () => undefined),
  'single defined among gaps': Array.from({ length: 40 }, (_, i) =>
    i === 20 ? 5 : undefined,
  ),
};

const PERIODS = [2, 3, 5, 20, 64];

describe('[PND-ROLLKERN] inlined rolling stdev is bit-identical to the state path', () => {
  for (const [name, cells] of Object.entries(SHAPES)) {
    it(`'${name}' matches exactly at every period`, () => {
      const dense = cells.every((c) => typeof c === 'number');
      for (const period of PERIODS) {
        if (period > cells.length) continue;
        const actual = readColumn(
          series(cells).rolling({ count: period }, { v: 'stdev' }, {
            minSamples: period,
          } as never),
          'v',
        );
        const expected = referenceRollingStdev(cells, period, period, dense);
        for (let i = 0; i < cells.length; i += 1) {
          // Object.is, not toBeCloseTo — see the header.
          expect(
            Object.is(actual[i], expected[i]),
            `${name} period=${period} row ${i}: got ${actual[i]}, want ${expected[i]}`,
          ).toBe(true);
        }
      }
    });
  }

  it('matches exactly across 150 randomised shapes', () => {
    const r = mulberry32(0xc0ffee);
    for (let trial = 0; trial < 150; trial += 1) {
      const n = 2 + Math.floor(r() * 80);
      // Mix magnitudes so the deviation-space path and the plain path both
      // get exercised, and sprinkle gaps so the wrapper choice flips.
      const offset = trial % 4 === 0 ? 1e10 : trial % 4 === 1 ? 1e6 : 0;
      const cells: Cell[] = Array.from({ length: n }, () =>
        r() < 0.12 ? undefined : offset + r() * (offset === 0 ? 100 : 5),
      );
      const dense = cells.every((c) => typeof c === 'number');
      const period = 2 + Math.floor(r() * Math.min(n - 1, 30));
      const actual = readColumn(
        series(cells).rolling({ count: period }, { v: 'stdev' }, {
          minSamples: period,
        } as never),
        'v',
      );
      const expected = referenceRollingStdev(cells, period, period, dense);
      for (let i = 0; i < n; i += 1) {
        expect(
          Object.is(actual[i], expected[i]),
          `trial ${trial} n=${n} period=${period} row ${i}: ` +
            `got ${actual[i]}, want ${expected[i]}`,
        ).toBe(true);
      }
    }
  });

  it('keeps the large-offset case exact rather than merely close', () => {
    // The regression the `n → 1` direct set exists to prevent: reaching it
    // via the reverse step alone leaves residue around 0.016 at 1e10.
    const cells = [1e10, 1e10 + 1, 1e10 + 2, 1e10 + 3, 1e10 + 4];
    const out = readColumn(
      series(cells).rolling({ count: 2 }, { v: 'stdev' }, {
        minSamples: 2,
      } as never),
      'v',
    );
    // Every 2-wide window here is two values one apart → population σ = 0.5.
    for (let i = 1; i < cells.length; i += 1) {
      expect(out[i], `row ${i}`).toBe(0.5);
    }
  });

  it('multi-column mappings still agree (bollinger’s shape)', () => {
    // `bollinger` reduces avg + stdev in one call; the per-column sweep
    // means they no longer share a walk, so pin that they still line up.
    const cells = Array.from({ length: 200 }, () => rnd() * 100);
    const out = series(cells).rolling(
      { count: 20 },
      { mean: { from: 'v', using: 'avg' }, sd: { from: 'v', using: 'stdev' } },
      { minSamples: 20 } as never,
    );
    const sd = readColumn(out, 'sd');
    const expected = referenceRollingStdev(cells, 20, 20, true);
    for (let i = 0; i < cells.length; i += 1) {
      expect(Object.is(sd[i], expected[i]), `row ${i}`).toBe(true);
    }
  });
});
