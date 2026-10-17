/**
 * Overflow lanes for the subtractive sliding-window states ([PND-NANREP]).
 *
 * A rolling `sum` / `avg` / `stdev` keeps a running accumulator and
 * *subtracts* a value when it leaves the window. Once that accumulator
 * overflows to `±Infinity` it can never come back (`Infinity − x` is
 * `Infinity`, `Infinity − Infinity` is `NaN`), so every later row would read
 * missing — for the rest of a batch series, or the rest of a live stream —
 * even after the huge values have left the window.
 *
 * The fix splits the accumulator by magnitude:
 *
 * - The **small lane** takes every value below a split threshold. The
 *   threshold is chosen so the lane *cannot* overflow for any window under
 *   2^53 values, so it is the plain accumulator (`./window-accumulators.ts`)
 *   — data that never reaches the threshold (all realistic data) computes
 *   exactly as the unlaned accumulator does, for the cost of one magnitude
 *   compare per add / remove.
 * - The **big lane** takes the rest and is **exact**: every double at or
 *   above the split is an integer multiple of a fixed power of two, so the
 *   lane holds `BigInt` sums of those integers. Adding and removing is then
 *   exact in any order — no cancellation, no rounding residue, and the lane
 *   is exactly zero once its last value leaves. `BigInt` is slow, but only
 *   values ≥ ~3e144 (stdev) / ~1e289 (sums) ever reach it.
 *
 * The snapshot recombines the lanes back at full scale. That can still
 * overflow — when the *current* window's sum (or stdev) genuinely isn't
 * representable — and the non-finite result then reads missing, as policy
 * says. But it is recomputed per snapshot rather than stuck in the running
 * state, so the next window that fits reads finite again.
 *
 * A value is always classified by its own magnitude, so `remove` reaches the
 * lane `add` put it in — removal stays by value, as the live layer's
 * `reorder`-mode eviction requires.
 *
 * Users: the `sum` / `avg` / `stdev` reducer states and
 * `smooth('movingAverage')`. The packed count-window sweep
 * (`batch/aggregate-columns.ts`) instead runs plain accumulators and re-runs a
 * column through these laned states only once it sees an overflow. See
 * docs/notes/reducer-nan-policy.md.
 */

import { WindowSum } from './window-accumulators.js';

/** Values with `|v| >= SUM_SPLIT` go to the big lane of a running sum.
 * Below it, a window of < 2^53 values sums to < 2^1013 — no overflow. */
export const SUM_SPLIT = 2 ** 960;
/** A double ≥ 2^960 is an integer multiple of `2^(960 − 52)`. */
const SUM_UNIT = 2 ** 908;
const SUM_PER_UNIT = 2 ** -908;

/**
 * A running sum split into a small lane and an exact big lane. The small lane
 * is the inherited drift-free double-double {@link WindowSum} ([PND-ROLLSTD])
 * — inherited rather than held, to save an indirection per add / remove — so
 * a window with no value ≥ `SUM_SPLIT` sums exactly as a plain
 * {@link WindowSum} does. Callers pass finite numbers.
 * Used by `sum` / `avg` `rollingState` and `smooth('movingAverage')`.
 */
export class LanedSum extends WindowSum {
  /** Σ v / 2^908 over the big values — exact. */
  big = 0n;
  bigN = 0;

  override add(v: number): void {
    if (v < SUM_SPLIT && v > -SUM_SPLIT) super.add(v);
    else {
      this.big += BigInt(v * SUM_PER_UNIT);
      this.bigN += 1;
    }
  }

  override remove(v: number): void {
    if (v < SUM_SPLIT && v > -SUM_SPLIT) super.remove(v);
    else {
      this.big -= BigInt(v * SUM_PER_UNIT);
      this.bigN -= 1;
    }
  }

  /** The window's sum; `±Infinity` only while it genuinely overflows. */
  override total(): number {
    const small = super.total();
    return this.bigN === 0 ? small : small + Number(this.big) * SUM_UNIT;
  }
}

/** Values with `|v| >= STDEV_SPLIT` go to the big stdev lane. Below it,
 * deviations stay < 2^481 and `m2` < 2^1015 for < 2^53 values. */
export const STDEV_SPLIT = 2 ** 480;
/** A double ≥ 2^480 is an integer multiple of `2^(480 − 52)`. */
const STDEV_PER_UNIT = 2 ** -428;
/** Scale of the domain the lanes are merged in (big values land in
 * `[2^-120, 2^424)`, so neither the mean nor `m2` can overflow). */
const STDEV_SCALE = 2 ** -600;
const STDEV_UNSCALE = 2 ** 600;

/**
 * The exact big lane of a running stdev: count, `Σu` and `Σu²` over the big
 * values' integer units `u = v / 2^428`, as `BigInt`s.
 */
export type StdevBigLane = { n: number; s1: bigint; s2: bigint };

export function stdevBigLane(): StdevBigLane {
  return { n: 0, s1: 0n, s2: 0n };
}

export function stdevBigLaneAdd(lane: StdevBigLane, value: number): void {
  const u = BigInt(value * STDEV_PER_UNIT);
  lane.n += 1;
  lane.s1 += u;
  lane.s2 += u * u;
}

export function stdevBigLaneRemove(lane: StdevBigLane, value: number): void {
  const u = BigInt(value * STDEV_PER_UNIT);
  lane.n -= 1;
  lane.s1 -= u;
  lane.s2 -= u * u;
}

/** `Number(x) · 2^exp` without `Number(x)` overflowing for a huge `x`. */
const BIG_LIMIT = 1n << 1000n;
function bigToScaledNumber(x: bigint, exp: number): number {
  while (x >= BIG_LIMIT || x <= -BIG_LIMIT) {
    x >>= 64n; // drops bits ~2^-936 below the leading one
    exp += 64;
  }
  return Number(x) * 2 ** exp;
}

/**
 * Population stdev of the small lane (`n`, `mean`, `m2`, unscaled) merged
 * with a non-empty big lane — Chan's parallel combination, done in the
 * scaled domain and scaled back at the end. The big lane's mean and `m2`
 * come from its exact sums (`m2 = (n·Σu² − (Σu)²) / n`, an exact,
 * non-negative integer numerator), so removing a big value never cancels.
 * Every merged term is non-negative. Non-finite only when the window's
 * stdev itself exceeds `Number.MAX_VALUE`.
 */
export function stdevWithBigLane(
  n: number,
  mean: number,
  m2: number,
  big: StdevBigLane,
): number {
  const bn = BigInt(big.n);
  // Units are 2^428; the merge domain is 2^-600 → mean · 2^-172, m2 · 2^-344.
  const bigMean = bigToScaledNumber(big.s1, -172) / big.n;
  const bigM2 = bigToScaledNumber(bn * big.s2 - big.s1 * big.s1, -344) / big.n;
  if (n === 0) return Math.sqrt(bigM2 / big.n) * STDEV_UNSCALE;
  const total = n + big.n;
  const d = bigMean - mean * STDEV_SCALE;
  const merged =
    m2 * STDEV_SCALE * STDEV_SCALE + bigM2 + d * d * (n / total) * big.n;
  return Math.sqrt(Math.max(0, merged / total)) * STDEV_UNSCALE;
}
