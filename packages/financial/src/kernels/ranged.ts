/**
 * The **range-exact** rolling mean/σ kernel — [PND-PROCKERN].
 *
 * ## What "range-exact" means, and why it is the whole point
 *
 * `rollingMeanSdInto(v, p, lo, hi, …)` fills `[lo, hi)` with exactly the
 * bits a full pass over the whole column would have written there. Not
 * "within rounding" — the same doubles.
 *
 * That property is what makes incremental recompute an *optimisation*
 * rather than a semantic change. An ordinary sliding accumulator carries
 * rounding history from row 0, so restarting it mid-column lands a few
 * ulps off — measured at **every cell** of a recomputed range, ~1e-10
 * relative. Which sounds harmless until you notice what it implies: the
 * value you get depends on *which ranges happened to be dirty*, so two
 * callers holding identical data see different numbers because they
 * edited in a different order. A cache that returns a different answer
 * than a cold compute is not a cache.
 *
 * ## How
 *
 * Two ideas, and they are the same idea twice.
 *
 * **Rebuild, so history cannot accumulate.** Every `period` rows the
 * accumulators are thrown away and rebuilt from the window. Nothing that
 * happened more than one window turnover ago can affect the answer.
 * `O(period)` every `period` rows — one extra accumulation per row, at
 * any `period`.
 *
 * **Align the rebuilds to absolute index**, `i % period === 0`, rather
 * than to "every N rows since this sweep started". This is the part that
 * buys exactness: a ranged sweep reading back to the last aligned rebuild
 * reconstructs precisely the state the full sweep held there, and every
 * row after it evolves identically. Read-back is at most `2·period - 1`
 * rows.
 *
 * The accumulators also work in a **shifted frame** (`x - anchor`), for
 * the reason [PND-SHIFTFRAME] established on `zScore`: at 1e15 a window
 * spanning ±3 leaves a raw-value accumulator about three bits, and
 * Welford's `x - wMean` cancels exactly as badly as a naive difference.
 * The rebuild row is the natural place to take the anchor, so the two
 * changes compose into one pass. Aligning *without* shifting made the
 * large-magnitude case **worse** (3.6e-3 → 1.7e-2), because rebuilding
 * more often only re-does ill-conditioned arithmetic more often — which
 * is why these ship together rather than in sequence.
 *
 * ## Measured
 *
 * 200k rows, period 20, worst relative error against an exact reference,
 * and whether three arbitrary ranges recompute bit-identically
 * (`spikes/ranged-exact/probe.mjs`):
 *
 * | input                  | before  | this    | ranged        |
 * | ---------------------- | ------- | ------- | ------------- |
 * | random walk ≈100       | 5.3e-9  | 3.9e-14 | identical     |
 * | `1e9 + sin`            | 1.4e-3  | 6.3e-14 | identical     |
 * | `1e15 + ((i % 7) − 3)` | 3.6e-3  | 4.4e-16 | identical     |
 *
 * Before, every cell of every recomputed range differed. The kernel costs
 * ~1.4× the sliding accumulator it replaces.
 *
 * ## Gap semantics
 *
 * `values` arrives NaN-as-missing ([PND-STUDYBOX]). A row is emitted once
 * its window spans `period` **rows** — which is what core's
 * `{ minSamples: period }` actually tests, rows and not contributors — and
 * is computed from whichever of them are finite. A window with no finite
 * contributor emits `NaN`.
 */

/** How far back a ranged fill must read to be exact. */
export function rollingReadBack(start: number, period: number): number {
  return Math.max(0, Math.floor(start / period) * period - period + 1);
}

/**
 * Fills `mean` and `sd` for `[start, end)` from `values`, writing at the
 * caller's own row indices.
 *
 * Pass `undefined` for either output to skip it — `sma` wants no σ, and
 * the σ accumulator is the expensive half.
 */
export function rollingMeanSdInto(
  values: Float64Array,
  period: number,
  start: number,
  end: number,
  mean: Float64Array | undefined,
  sd: Float64Array | undefined,
): void {
  // `sma` asks for a mean and no σ, and it is the most-called study there
  // is. Skipping only the *write* left it paying for the variance
  // accumulator anyway — 1.6× slower than the sweep this replaced. The
  // Welford triple is the expensive half, so it is skipped outright.
  const wantSd = sd !== undefined;
  const from = rollingReadBack(start, period);
  let windowStart = from;
  let windowEnd = from;
  let anchor = 0;
  let shiftedSum = 0;
  let count = 0;
  let wN = 0;
  let wMean = 0;
  let wM2 = 0;

  for (let i = from; i < end; i += 1) {
    const lo = i - period + 1 > from ? i - period + 1 : from;
    while (windowEnd <= i) {
      const x = values[windowEnd]!;
      if (Number.isFinite(x)) {
        const y = x - anchor;
        shiftedSum += y;
        count += 1;
        if (wantSd) {
          wN += 1;
          const d = y - wMean;
          wMean += d / wN;
          wM2 += d * (y - wMean);
        }
      }
      windowEnd += 1;
    }
    while (windowStart < lo) {
      const x = values[windowStart]!;
      if (Number.isFinite(x)) {
        const y = x - anchor;
        shiftedSum -= y;
        count -= 1;
        if (!wantSd) {
          // nothing to unwind
        } else if (wN <= 1) {
          wN = 0;
          wMean = 0;
          wM2 = 0;
        } else {
          const meanWith = wMean;
          wN -= 1;
          if (wN === 1) {
            wMean = meanWith * 2 - y;
            wM2 = 0;
          } else {
            wMean = meanWith - (y - meanWith) / wN;
            wM2 -= (y - wMean) * (y - meanWith);
            if (wM2 < 0) wM2 = 0;
          }
        }
      }
      windowStart += 1;
    }

    // The aligned rebuild. `i % period` and not a counter: a ranged sweep
    // has to land on the same rows the full sweep did, or the state it
    // reconstructs is merely similar rather than equal.
    if (i % period === 0) {
      const at = values[i]!;
      anchor = Number.isFinite(at) ? at : 0;
      shiftedSum = 0;
      count = 0;
      wN = 0;
      wMean = 0;
      wM2 = 0;
      for (let k = windowStart; k < windowEnd; k += 1) {
        const x = values[k]!;
        if (!Number.isFinite(x)) continue;
        const y = x - anchor;
        shiftedSum += y;
        count += 1;
        if (wantSd) {
          wN += 1;
          const d = y - wMean;
          wMean += d / wN;
          wM2 += d * (y - wMean);
        }
      }
    }

    // Rows before `start` exist only to rebuild the state; they are read,
    // never written. A caller's buffer outside `[start, end)` is untouched.
    if (i < start) continue;
    if (windowEnd - windowStart < period || count === 0) {
      if (mean !== undefined) mean[i] = NaN;
      if (sd !== undefined) sd[i] = NaN;
      continue;
    }
    if (mean !== undefined) mean[i] = anchor + shiftedSum / count;
    if (sd !== undefined) {
      sd[i] = wN === 0 ? NaN : Math.sqrt(wM2 / wN > 0 ? wM2 / wN : 0);
    }
  }
}
