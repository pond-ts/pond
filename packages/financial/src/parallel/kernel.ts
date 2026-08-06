/**
 * The range-scoped rolling kernel behind the parallel studies —
 * [PND-SCANKERN].
 *
 * ## Why this exists as its own function
 *
 * A rolling window is **not** a recurrence. Output cell `i` depends only
 * on rows `[i-period+1, i]`, so a chunk of the output can be computed
 * from a chunk of the input plus an overlap, with no communication. That
 * is what makes the study partitionable across workers at all.
 *
 * ## It is now the same code the sequential path runs
 *
 * This used to be a careful transcription of core's sweep, arithmetic for
 * arithmetic, so that the difference between the parallel and sequential
 * answers stayed confined to chunk boundaries — bounded and
 * characterisable rather than arbitrary, but not zero. Chunk 0 matched
 * bit for bit; every later chunk began its accumulators fresh at its own
 * warm-up row instead of carrying the rounding history of the rows before
 * it, and no amount of care removes that.
 *
 * [PND-PROCKERN] removed it, from the other end. `rollingMeanSdInto` pins
 * its accumulator rebuilds to **absolute** row index, so a chunk that
 * reads back to the last aligned rebuild reconstructs exactly the state a
 * whole-column pass held there. The partitioned answer is now **bit-identical
 * to the sequential one** — not close, equal — and the accuracy table this
 * package used to carry per study collapses to a single row.
 *
 * There is nothing left to transcribe, so this delegates. Keeping two
 * implementations of one sweep in sync by hand was the risk; one of them
 * winning is the fix.
 */
export { rollingMeanSdInto as rollingMeanSd } from '../kernels/ranged.js';

/**
 * Turns a `[start, end)` slice of rolling mean/sd into Bollinger's three
 * bands, in place.
 *
 * σ = 0 (a flat window) has no meaningful band and emits missing,
 * matching the sequential study. `d === 0` is false for NaN, so a
 * warm-up row falls through to the arithmetic and stays NaN — which is
 * the wanted answer.
 */
export function bollingerBands(
  mean: Float64Array,
  sd: Float64Array,
  stdDev: number,
  start: number,
  end: number,
  middle: Float64Array,
  upper: Float64Array,
  lower: Float64Array,
): void {
  for (let i = start; i < end; i += 1) {
    const m = mean[i]!;
    const d = sd[i]!;
    middle[i] = m;
    upper[i] = d === 0 ? NaN : m + stdDev * d;
    lower[i] = d === 0 ? NaN : m - stdDev * d;
  }
}

/* ── the shared control block ────────────────────────────────────── */

/**
 * The job description lives in an `Int32Array`, not in a message: the
 * main thread cannot `postMessage` to a worker parked in `Atomics.wait`,
 * so everything a worker needs has to be readable from shared memory.
 *
 * There is exactly **one** job kind — "compute rolling mean and sd for
 * this range". Every rolling study reduces to that: `sma` and `envelope`
 * want the mean, `bollinger` and `zScore` want both, and each study's own
 * pointwise arithmetic (`m ± k·d`, `(v − m)/d`) stays in the main thread
 * where it already lives, costs a millisecond, and needs no second
 * implementation to drift from the first.
 */
export const MAX_WORKERS = 32;

/** Index layout of the shared `Int32Array` control block. */
export const ctrl = {
  /** Per-worker job flag: 0 idle, 1 job posted. */
  JOB: 0,
  /** Completion counter, reset per dispatch. */
  DONE: MAX_WORKERS,
  PERIOD: MAX_WORKERS + 1,
  /** Set to 1 to tell workers to exit their loop. */
  STOP: MAX_WORKERS + 2,
  /** Per-worker `[start, end)`, two slots each. */
  RANGE: MAX_WORKERS + 4,
  BYTES: (MAX_WORKERS * 3 + 8) * 4,
} as const;

/** Arena slots per series: the source values, then mean and sd. */
export const ARENA_SLOTS = 3;
