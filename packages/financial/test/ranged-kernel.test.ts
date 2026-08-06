import { describe, expect, it } from 'vitest';
import { rollingMeanSdInto, rollingReadBack } from '../src/kernels/ranged.js';

/**
 * [PND-PROCKERN] — the range-exact rolling kernel.
 *
 * The acceptance bar from the plan is "at least one corpus study can
 * recompute `[lo, hi)` and match a from-scratch pass **exactly**". Exactly
 * is the load-bearing word: [PND-PROCRANGE] recomputes only dirty ranges,
 * so anything less means the value a caller sees depends on which ranges
 * happened to be dirty — on their edit history rather than their data.
 * These assert `Object.is`, not a tolerance.
 */
describe('[PND-PROCKERN] range-exact rolling mean/sd', () => {
  const N = 20_000;

  function gen(kind: 'walk' | 'mid' | 'huge' | 'gappy'): Float64Array {
    const v = new Float64Array(N);
    let px = 100;
    for (let i = 0; i < N; i += 1) {
      if (kind === 'walk')
        v[i] = px = Math.max(1, px + Math.sin(px * 7919) * 0.4);
      else if (kind === 'mid') v[i] = 1e9 + Math.sin(i / 13) * 5;
      else if (kind === 'huge') v[i] = 1e15 + ((i % 7) - 3);
      else v[i] = i % 37 === 0 ? NaN : 100 + Math.sin(i / 11);
    }
    return v;
  }

  function full(v: Float64Array, period: number) {
    const mean = new Float64Array(N);
    const sd = new Float64Array(N);
    rollingMeanSdInto(v, period, 0, N, mean, sd);
    return { mean, sd };
  }

  const KINDS = ['walk', 'mid', 'huge', 'gappy'] as const;

  it.each(KINDS)(
    'a ranged fill is bit-identical to a full pass — %s',
    (kind) => {
      const v = gen(kind);
      const period = 20;
      const whole = full(v, period);
      // Ranges chosen to land on and off the rebuild alignment deliberately:
      // 4000 is a multiple of the period, 137 and 4003 are not, and one range
      // is shorter than a single window.
      const ranges: readonly (readonly [number, number])[] = [
        [4000, 4500],
        [4003, 9001],
        [137, 200],
        [N - 3, N],
        [period - 1, period + 1],
      ];
      for (const [lo, hi] of ranges) {
        const mean = new Float64Array(N);
        const sd = new Float64Array(N);
        rollingMeanSdInto(v, period, lo, hi, mean, sd);
        for (let i = lo; i < hi; i += 1) {
          expect(Object.is(mean[i], whole.mean[i]), `${kind} mean @${i}`).toBe(
            true,
          );
          expect(Object.is(sd[i], whole.sd[i]), `${kind} sd @${i}`).toBe(true);
        }
      }
    },
  );

  it('is exact at every start offset across a full alignment cycle', () => {
    // The failure mode a hand-picked range would miss: an off-by-one in the
    // read-back leaves exactly one residue class wrong. Sweeping every
    // offset through a period catches it.
    const v = gen('walk');
    const period = 16;
    const whole = full(v, period);
    for (let lo = 1000; lo < 1000 + period * 2; lo += 1) {
      const mean = new Float64Array(N);
      const sd = new Float64Array(N);
      rollingMeanSdInto(v, period, lo, lo + 50, mean, sd);
      for (let i = lo; i < lo + 50; i += 1) {
        expect(Object.is(mean[i], whole.mean[i]), `mean @${i} from ${lo}`).toBe(
          true,
        );
        expect(Object.is(sd[i], whole.sd[i]), `sd @${i} from ${lo}`).toBe(true);
      }
    }
  });

  it.each([2, 3, 16, 20, 63, 257])('is exact at period %i', (period) => {
    const v = gen('walk');
    const whole = full(v, period);
    const lo = 5000;
    const hi = 5000 + 3 * period + 7;
    const mean = new Float64Array(N);
    const sd = new Float64Array(N);
    rollingMeanSdInto(v, period, lo, hi, mean, sd);
    for (let i = lo; i < hi; i += 1) {
      expect(Object.is(mean[i], whole.mean[i]), `mean @${i}`).toBe(true);
      expect(Object.is(sd[i], whole.sd[i]), `sd @${i}`).toBe(true);
    }
  });

  it('writes nothing outside the requested range', () => {
    // A caller patching one range of a live buffer must keep every other
    // cell. The read-back means the sweep *visits* rows before `start`.
    const v = gen('walk');
    const mean = new Float64Array(N).fill(-1);
    const sd = new Float64Array(N).fill(-1);
    rollingMeanSdInto(v, 20, 4000, 4500, mean, sd);
    for (let i = 0; i < N; i += 1) {
      if (i >= 4000 && i < 4500) continue;
      expect(mean[i], `mean @${i}`).toBe(-1);
      expect(sd[i], `sd @${i}`).toBe(-1);
    }
  });

  it('skips the output a caller did not ask for', () => {
    // `sma` wants no σ, and the σ accumulator is the expensive half.
    const v = gen('walk');
    const whole = full(v, 20);
    const mean = new Float64Array(N);
    rollingMeanSdInto(v, 20, 0, N, mean, undefined);
    for (let i = 0; i < N; i += 1) {
      expect(Object.is(mean[i], whole.mean[i])).toBe(true);
    }
    const sd = new Float64Array(N);
    rollingMeanSdInto(v, 20, 0, N, undefined, sd);
    for (let i = 0; i < N; i += 1) {
      expect(Object.is(sd[i], whole.sd[i])).toBe(true);
    }
  });

  it('reads back at most two periods, and never past zero', () => {
    expect(rollingReadBack(0, 20)).toBe(0);
    expect(rollingReadBack(5, 20)).toBe(0);
    expect(rollingReadBack(4000, 20)).toBe(3981);
    expect(rollingReadBack(4019, 20)).toBe(3981);
    for (const period of [2, 7, 20, 257]) {
      for (const start of [0, 1, 999, 5000, 65_536]) {
        const back = rollingReadBack(start, period);
        expect(back).toBeGreaterThanOrEqual(0);
        expect(start - back).toBeLessThan(2 * period);
      }
    }
  });

  it('is more accurate than the sliding accumulator it replaced', () => {
    // Not a side benefit — a precondition. Aligning the rebuilds without
    // also shifting the frame made the large-magnitude case WORSE
    // (3.6e-3 → 1.7e-2), because rebuilding more often only re-does
    // ill-conditioned arithmetic more often. The two ship together.
    const v = gen('huge');
    const period = 20;
    const { sd } = full(v, period);
    let worst = 0;
    for (let i = period - 1; i < N; i += 1) {
      // Exact σ, summed over within-window differences so nothing cancels.
      let m = 0;
      for (let k = i - period + 1; k <= i; k += 1) m += v[k]! - v[i]!;
      m /= period;
      let q = 0;
      for (let k = i - period + 1; k <= i; k += 1) {
        const d = v[k]! - v[i]! - m;
        q += d * d;
      }
      const want = Math.sqrt(q / period);
      if (want === 0) continue;
      worst = Math.max(worst, Math.abs(sd[i]! - want) / want);
    }
    expect(worst).toBeLessThan(1e-12);
  });
});
