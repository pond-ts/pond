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
 *   2^53 values, so it is the old accumulator, bit for bit — data that never
 *   reaches the threshold (all realistic data) computes exactly as before,
 *   for the cost of one magnitude compare per add / remove.
 * - The **big lane** takes the rest, **scaled down by a power of two**
 *   (exact for values this large — no subnormal is involved), so it cannot
 *   overflow either. It is reset to exactly zero when its last value leaves,
 *   so no residue outlives the huge values.
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

/** Values with `|v| >= SUM_SPLIT` go to the big lane of a running sum.
 * Below it, a window of < 2^53 values sums to < 2^1013 — no overflow. */
export const SUM_SPLIT = 2 ** 960;
/** Exact scale into the sum big lane: `|v| · 2^-960 ∈ [1, 2^64)`. */
export const SUM_SCALE = 2 ** -960;
/** Exact scale back out of the sum big lane. */
export const SUM_UNSCALE = 2 ** 960;

/** Values with `|v| >= STDEV_SPLIT` go to the big Welford lane. Below it,
 * deviations stay < 2^481 and `m2` < 2^1015 for < 2^53 values. */
export const STDEV_SPLIT = 2 ** 480;
/** Exact scale into the stdev big lane (big values land in `[2^-120, 2^424)`). */
export const STDEV_SCALE = 2 ** -600;
/** Exact scale back out of the stdev big lane. */
export const STDEV_UNSCALE = 2 ** 600;

/** A Welford accumulator holding **scaled** values (`v · STDEV_SCALE`). */
export type WelfordLane = { n: number; mean: number; m2: number };

export function welfordLane(): WelfordLane {
  return { n: 0, mean: 0, m2: 0 };
}

/** Adds an unscaled big value to the lane. */
export function welfordLaneAdd(lane: WelfordLane, value: number): void {
  const v = value * STDEV_SCALE;
  lane.n += 1;
  const delta = v - lane.mean;
  lane.mean += delta / lane.n;
  lane.m2 += delta * (v - lane.mean);
}

/** Removes an unscaled big value — the same order-independent delete (and
 * the same exact resets) as `stdev`'s `rollingState`. */
export function welfordLaneRemove(lane: WelfordLane, value: number): void {
  const v = value * STDEV_SCALE;
  if (lane.n <= 1) {
    lane.n = 0;
    lane.mean = 0;
    lane.m2 = 0;
    return;
  }
  const meanWith = lane.mean;
  lane.n -= 1;
  if (lane.n === 1) {
    lane.mean = meanWith * 2 - v;
    lane.m2 = 0;
    return;
  }
  lane.mean = meanWith - (v - meanWith) / lane.n;
  lane.m2 -= (v - lane.mean) * (v - meanWith);
  if (lane.m2 < 0) lane.m2 = 0;
}

/**
 * Population stdev of the small lane (`n`, `mean`, `m2`, unscaled) merged
 * with a non-empty big lane — Chan's parallel combination, done in the
 * scaled domain and scaled back at the end. Non-finite only when the
 * window's stdev itself exceeds `Number.MAX_VALUE`.
 */
export function stdevWithBigLane(
  n: number,
  mean: number,
  m2: number,
  big: WelfordLane,
): number {
  if (n === 0) return Math.sqrt(Math.max(0, big.m2 / big.n)) * STDEV_UNSCALE;
  const total = n + big.n;
  const d = big.mean - mean * STDEV_SCALE;
  const merged =
    m2 * STDEV_SCALE * STDEV_SCALE + big.m2 + d * d * (n / total) * big.n;
  return Math.sqrt(Math.max(0, merged / total)) * STDEV_UNSCALE;
}
