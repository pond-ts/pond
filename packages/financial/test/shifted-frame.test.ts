import { describe, expect, it } from 'vitest';
import { TimeSeries } from 'pond-ts';
import { zScore } from '../src/index.js';

/**
 * [PND-SHIFTFRAME] — `zScore` computes its deviation in a shifted frame
 * rather than as `value − rollingMean`.
 *
 * The reference below is the whole test. `deviation = −(1/p)·Σ(v[k] − v[i])`
 * is algebraically identical to `v[i] − mean`, but every term is a
 * difference of two values from the *same window*, so it never forms the
 * large intermediate that cancels — and by Sterbenz each subtraction is
 * exact when the two are within a factor of two. It is `O(period)` per
 * row, which is why the kernel does not use it, and exact, which is why
 * the test does.
 *
 * A previous version of this reasoning shipped wrong in three files: the
 * error was blamed on dividing by a small σ, and on parallelism. It is
 * neither. Decomposing the two contributions put σ at 0.97% and the
 * numerator at 60%, and the sequential path is exposed identically. The
 * cases below are the evidence, so keep them adversarial.
 */
describe('[PND-SHIFTFRAME] zScore in a shifted frame', () => {
  const P = 20;
  const N = 20_000;

  function build(gen: (i: number) => number) {
    const time = new Float64Array(N);
    const close = new Float64Array(N);
    for (let i = 0; i < N; i += 1) {
      time[i] = i * 60_000;
      close[i] = gen(i);
    }
    return {
      close,
      series: TimeSeries.fromColumns({
        name: 'bars',
        schema: [
          { name: 'time', kind: 'time' },
          { name: 'close', kind: 'number' },
        ],
        columns: { time, close },
      }),
    };
  }

  /** Exact deviation, Kahan-summed over within-window differences. */
  function refDeviation(v: Float64Array, i: number, p: number): number {
    let s = 0;
    let c = 0;
    for (let k = i - p + 1; k <= i; k += 1) {
      const y = v[k]! - v[i]! - c;
      const t = s + y;
      c = t - s - y;
      s = t;
    }
    return -s / p;
  }
  function refSd(v: Float64Array, i: number, p: number): number {
    let m = 0;
    for (let k = i - p + 1; k <= i; k += 1) m += v[k]! - v[i]!;
    m /= p;
    let q = 0;
    for (let k = i - p + 1; k <= i; k += 1) {
      const d = v[k]! - v[i]! - m;
      q += d * d;
    }
    return Math.sqrt(q / p);
  }

  /** The formulation `zScore` used to have, transcribed. */
  function naive(v: Float64Array, p: number): Float64Array {
    const z = new Float64Array(v.length).fill(NaN);
    let wN = 0;
    let wMean = 0;
    let wM2 = 0;
    for (let i = 0; i < v.length; i += 1) {
      const x = v[i]!;
      wN += 1;
      const d = x - wMean;
      wMean += d / wN;
      wM2 += d * (x - wMean);
      if (i >= p) {
        const o = v[i - p]!;
        const meanWith = wMean;
        wN -= 1;
        if (wN === 1) {
          wMean = meanWith * 2 - o;
          wM2 = 0;
        } else {
          wMean = meanWith - (o - meanWith) / wN;
          wM2 -= (o - wMean) * (o - meanWith);
          if (wM2 < 0) wM2 = 0;
        }
      }
      if (i >= p - 1) {
        const sd = Math.sqrt(wM2 / wN);
        z[i] = sd === 0 ? NaN : (x - wMean) / sd;
      }
    }
    return z;
  }

  function worstError(gen: (i: number) => number) {
    const { close, series } = build(gen);
    const got = zScore(series, { period: P }).column('zscore');
    const was = naive(close, P);
    let shifted = 0;
    let previous = 0;
    for (let i = P - 1; i < N; i += 1) {
      const sd = refSd(close, i, P);
      if (sd === 0) continue;
      const want = refDeviation(close, i, P) / sd;
      if (!Number.isFinite(want) || Math.abs(want) < 1e-12) continue;
      const a = got.at(i) as number;
      if (Number.isFinite(a))
        shifted = Math.max(shifted, Math.abs(a - want) / Math.abs(want));
      if (Number.isFinite(was[i]!))
        previous = Math.max(
          previous,
          Math.abs(was[i]! - want) / Math.abs(want),
        );
    }
    return { shifted, previous };
  }

  it('is accurate on a near-flat series at large magnitude', () => {
    // The counterexample a Codex pass supplied, which invalidated the
    // bound this feature was first documented with. `ulp(1e15) = 0.125`
    // and the window spans ±3, so a stored mean resolves the deviation
    // to about three bits. Measured at 100% relative error before.
    const { shifted, previous } = worstError((i) => 1e15 + ((i % 7) - 3));
    expect(
      previous,
      'the old formulation must stay visibly broken',
    ).toBeGreaterThan(0.1);
    expect(shifted).toBeLessThan(1e-12);
  });

  it('is accurate at mid magnitude, where the old path was also wrong', () => {
    // Not a contrived extreme: 1e9 is an ordinary notional. This one is
    // the argument that the fix was not optional — the old path returns
    // an error larger than the answer here.
    // The old path's error grows with row count — its running mean drifts
    // — so this reads ~1% over 20k rows and ~400% over 200k. Pinned at the
    // 20k figure; the point is that it is a whole-percent error, not an ulp.
    const { shifted, previous } = worstError((i) => 1e9 + Math.sin(i / 13) * 5);
    expect(previous).toBeGreaterThan(0.005);
    expect(shifted).toBeLessThan(1e-9);
  });

  it('improves an ordinary random walk too', () => {
    // Cancellation is a matter of degree, not a cliff at one magnitude,
    // so the benign case should improve as well — and it must, or the
    // shift is being defeated somewhere and only the extremes would say so.
    let px = 100;
    const { shifted, previous } = worstError(
      () => (px = Math.max(1, px + Math.sin(px * 7919) * 0.4)),
    );
    expect(shifted).toBeLessThan(previous);
    expect(shifted).toBeLessThan(1e-9);
  });

  it('holds while the series trends away from its anchor', () => {
    // The magnitude re-anchor trigger. Periodic re-anchoring alone leaves
    // an anchor up to 1024 rows stale, and this moves ~5e7 in that span
    // while the window spread stays ~1 — so a test with only the flat
    // cases above would pass with that trigger deleted.
    const { shifted } = worstError((i) => 1e12 * (1 + i / N) + Math.sin(i / 7));
    expect(shifted).toBeLessThan(1e-9);
  });

  it('keeps the warm-up head and gap semantics', () => {
    // The shift changed how the mean is carried, not what the study
    // emits: `period - 1` undefined cells, then values, row count kept.
    const { series } = build((i) => 100 + Math.sin(i / 10));
    const out = zScore(series, { period: P });
    expect(out.length).toBe(N);
    const col = out.column('zscore');
    for (let i = 0; i < P - 1; i += 1) expect(col.at(i)).toBeUndefined();
    expect(typeof col.at(P - 1)).toBe('number');
  });

  it('reports a missing cell where sigma is zero, not Infinity', () => {
    // A constant window has no dispersion, so the z-score is undefined
    // rather than infinite. The study writes NaN and the column surfaces
    // that as a missing cell — the same way a gap reads.
    const { series } = build(() => 42);
    const col = zScore(series, { period: P }).column('zscore');
    expect(col.at(N - 1)).toBeUndefined();
  });
});
