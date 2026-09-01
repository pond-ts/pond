/**
 * **True range** — the widest of the three spans a bar can cover:
 *
 * ```
 * TR[i] = max(high − low, |high − prevClose|, |low − prevClose|)
 * ```
 *
 * The two `prevClose` terms are what make it *true* range rather than plain
 * range. A bar that opens away from the previous close covers ground its own
 * high-to-low span does not show, and an average of plain ranges understates
 * volatility exactly when it matters most.
 *
 * ## Why a kernel and not a loop inside `atr`
 *
 * True range is a named, reusable quantity: ATR smooths it, and ADX, NATR,
 * Keltner channels and SuperTrend all need the same array. The studies README
 * asks for the loop to live here for that reason — a study is
 * options-validation plus kernel calls, so that a kernel improvement lifts
 * every consumer at once rather than one study at a time.
 *
 * ## Missing cells
 *
 * `NaN` marks a gap ([PND-STUDYBOX]) and `Math.max` returns `NaN` if any
 * argument is `NaN`, which is the answer this wants: a bar with an unknown
 * high, low, or previous close has an unknown true range.
 *
 * Note which bar a missing close costs. True range reads only the
 * **previous** close, so a bar whose own close is missing is unaffected — it
 * is the **next** bar, for which that value is `prevClose`, that has no
 * answer. The intuition runs the other way, so it is pinned by a test.
 *
 * `TR[0]` is `NaN`: the first bar has no previous close, so its true range is
 * undefined rather than its plain range. Callers smoothing this should pass
 * `start = 1` — the leading `NaN` would be stepped over anyway, but saying so
 * is what makes the intent explicit rather than incidental.
 *
 * O(N), one pass, one allocation.
 */
export function trueRangeValues(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
): Float64Array {
  const length = high.length;
  const out = new Float64Array(length);
  if (length === 0) return out;

  out[0] = NaN;
  for (let i = 1; i < length; i += 1) {
    const prevClose = close[i - 1]!;
    out[i] = Math.max(
      high[i]! - low[i]!,
      Math.abs(high[i]! - prevClose),
      Math.abs(low[i]! - prevClose),
    );
  }
  return out;
}
