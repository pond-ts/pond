/**
 * The range-scoped rolling kernel behind the parallel studies —
 * [PND-SCANKERN].
 *
 * ## Why this exists as its own function
 *
 * A rolling window is **not** a recurrence. Output cell `i` depends only
 * on rows `[i-period+1, i]`, so a chunk of the output can be computed
 * from a chunk of the input plus a `period-1` element overlap, with no
 * communication. That is what makes the study partitionable across
 * workers at all, and this function is the partition: the same sweep
 * core runs whole-column, restricted to `[start, end)`.
 *
 * ## It mirrors core's sweep deliberately, arithmetic for arithmetic
 *
 * The Welford add/remove below is transcribed from core's
 * `sweepRollingColumn`, including the two exact-reset branches
 * (`wN <= 1`, `wN === 1`) and the `wM2 < 0` clamp. That is not
 * tidiness — it is what confines the difference between the parallel and
 * sequential answers to **chunk boundaries only**. A kernel that merely
 * computed "a rolling stdev" would differ everywhere, and the deviation
 * would be uncharacterisable rather than bounded.
 *
 * Chunk 0 starts where the whole-column sweep starts and so reproduces
 * it bit for bit. Every later chunk begins its Welford state fresh at its
 * own warm-up row rather than carrying the rounding history of every row
 * before it — which is the entire source of the divergence, and is
 * measured in `spikes/parallel-rolling/`: not one cell in 1.5 million
 * moves by more than 1e-9 relative.
 *
 * ## Missing cells
 *
 * `values` arrives NaN-as-missing ([PND-STUDYBOX]), so the contributor
 * test collapses to `Number.isFinite`. A window is emitted only when it
 * holds `minSamples` contributors, matching `rolling`'s
 * `{ minSamples: period }`; since the window is exactly `period` rows,
 * that means every row in it must be present and finite.
 */

/** Writes `mean` and `sd` for `[start, end)` into caller-owned buffers. */
export function rollingMeanSd(
  values: Float64Array,
  period: number,
  start: number,
  end: number,
  mean: Float64Array,
  sd: Float64Array,
): void {
  // The chunk's own warm-up: the earliest row any output in this range
  // reads. `period - 1` rows of overlap with the previous chunk.
  const warm = Math.max(0, start - period + 1);
  let windowStart = warm;
  let windowEnd = warm;
  // The mean is a running sum, NOT Welford's `wMean`. Core runs `avg` and
  // `stdev` as two separate reducers over one sweep, and the two means are
  // not the same arithmetic — reading `wMean` here would diverge from the
  // sequential study on every cell rather than only at chunk boundaries.
  let runningSum = 0;
  let runningCount = 0;
  let wN = 0;
  let wMean = 0;
  let wM2 = 0;

  for (let i = start; i < end; i += 1) {
    const lo = i - period + 1 > 0 ? i - period + 1 : 0;

    while (windowEnd <= i) {
      const v = values[windowEnd]!;
      if (Number.isFinite(v)) {
        runningSum += v;
        runningCount += 1;
        wN += 1;
        const delta = v - wMean;
        wMean += delta / wN;
        wM2 += delta * (v - wMean);
      }
      windowEnd += 1;
    }
    while (windowStart < lo) {
      const v = values[windowStart]!;
      if (Number.isFinite(v)) {
        runningSum -= v;
        runningCount -= 1;
        if (wN <= 1) {
          // Removing the final contributor — reset exactly (no 0/0, no drift).
          wN = 0;
          wMean = 0;
          wM2 = 0;
        } else {
          const meanWith = wMean;
          wN -= 1;
          if (wN === 1) {
            wMean = meanWith * 2 - v; // the survivor: 2·mean₂ − removed
            wM2 = 0;
          } else {
            // Deviation-space mean update, then reverse Welford.
            wMean = meanWith - (v - meanWith) / wN;
            wM2 -= (v - wMean) * (v - meanWith);
            if (wM2 < 0) wM2 = 0;
          }
        }
      }
      windowStart += 1;
    }

    // `minSamples` counts ROWS in the window, not contributors — core's
    // guard is `windowEnd - windowStart < minSamples`. A window that is
    // full-width but partly missing still emits, over whatever
    // contributors it has; only an all-missing window emits nothing.
    // (Counting contributors instead blanked ~108k cells of a gapped
    // 200k-row column that the sequential study fills.)
    if (windowEnd - windowStart < period || wN === 0 || runningCount === 0) {
      mean[i] = NaN;
      sd[i] = NaN;
    } else {
      mean[i] = runningSum / runningCount;
      sd[i] = Math.sqrt(wM2 / wN > 0 ? wM2 / wN : 0);
    }
  }
}

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
