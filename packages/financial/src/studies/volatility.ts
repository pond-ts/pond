import type {
  NumericColumnNameForSchema,
  SeriesSchema,
  TimeSeries,
} from 'pond-ts';
import { DEFAULT_SOURCE } from '../contract/columns.js';
import { rollingMeanSdInto } from '../kernels/ranged.js';
import {
  assertNoColumn,
  assertPeriod,
  columnValues,
} from '../kernels/rolling.js';

export interface HistoricalVolatilityOptions<
  S extends SeriesSchema,
  Output extends string,
> {
  /** Window length in **bars** — how many log returns the σ is taken over.
   *  **Default `20`.** */
  period?: number;
  /**
   * Bars per year, applied as `√annualize`. **Default `252`** (trading days,
   * for daily bars). Pass `1` for the raw per-bar σ, or your own bar count —
   * `252 × 6.5 × 60` for one-minute bars on a 6.5-hour session, `365` for a
   * market that trades every calendar day.
   */
  annualize?: number;
  /** Source column. **Default `'close'`.** */
  column?: NumericColumnNameForSchema<S>;
  /** Name of the appended column. **Default `'hv'`.** */
  output?: Output;
}

/**
 * **Historical volatility** — the standard deviation of **log returns** over
 * `period` bars, annualised:
 *
 * ```
 * r[i] = ln(value[i] / value[i − 1])
 * hv[i] = σ(r[i − period + 1 .. i]) × √annualize
 * ```
 *
 * Appends one column; `undefined` for the first `period` rows. Note that is
 * `period`, not `period − 1`: HV is a σ of **returns**, and `period` returns
 * need `period + 1` prices — the same off-by-one {@link rsi} and {@link atr}
 * have, for the same reason.
 *
 * ## Conventions — the four choices that make two HVs disagree
 *
 * There is no TA-Lib function to arbitrate these (it has none for HV), so
 * they are pinned here and in the pandas oracle instead:
 *
 * - **Population σ (`ddof = 0`).** The package convention — {@link bollinger},
 *   {@link rollingStdev} and {@link zScore} all use it, and TA-Lib's own
 *   `STDDEV` does too. A sample σ (`ddof = 1`) is `√(period/(period − 1))`
 *   larger: 2.6% at `period 20`, 5.4% at `10`. If you need it, scale by that
 *   factor rather than looking for an option.
 * - **Log returns, not simple returns.** `ln(p[i]/p[i−1])` is symmetric (a
 *   move up and back down sums to zero) and additive across bars, which is
 *   what makes the `√time` annualisation below legitimate. On ordinary
 *   daily data the two differ in the third significant figure; on a large
 *   move they diverge materially.
 * - **Annualised by `√annualize`, default `252`.** Volatility scales with
 *   the square root of time, so a per-bar σ becomes annual by multiplying by
 *   the root of the bars per year. `252` is the US trading-day count and the
 *   right default for daily bars only — it is an **option**, not a hidden
 *   constant, precisely because intraday and 7-day markets need a different
 *   number. `annualize: 1` gives the raw per-bar σ.
 * - **A decimal, not a percent.** `0.18` means 18% annualised. That is the
 *   form volatility is consumed in (option pricing, position sizing, a
 *   `σ · √t` band), and the one every other study here uses — only
 *   {@link percentChange} multiplies by 100, because "percent" is its name.
 *
 * ## Edges
 *
 * - **A non-positive price has no log.** The two returns that touch it
 *   (its own and the next bar's) are missing, and the guard is explicit
 *   rather than left to `Math.log`: `ln(−4 / −5)` is a perfectly finite
 *   number that is not a return. Those missing returns then behave like any
 *   gap under the rolling kernel's contract — the window still spans
 *   `period` rows, σ is over the finite returns in it, and a window with no
 *   finite return is `undefined`.
 * - **A leading gap shifts the start** rather than shrinking the first
 *   window: over another study's output (whose warm-up leaves missing rows
 *   at the head) the first σ still covers `period` real returns. That is
 *   the Wilder-kernel convention {@link rsi} and {@link atr} follow, and it
 *   is also what pandas' `rolling(n).std()` does — so the oracle pins it.
 * - **Scale-invariant**: log returns are ratios, so multiplying every price
 *   by a constant leaves HV unchanged (pinned by a property test). Contrast
 *   {@link momentum} and {@link atr}, which are in the price's units.
 *
 * ## Why the kernel is called on a raw array
 *
 * The σ is `rollingMeanSdInto` — the same range-exact, shifted-frame kernel
 * {@link rollingStdev} and {@link bollinger} sit on — but over the derived
 * returns array rather than a scratch column. A scratch column would go
 * through `rollingValues`, whose window is a count of **rows**: with the
 * first return undefined (bar 0 has no predecessor) it would emit at bar
 * `period − 1` over `period − 1` returns, one bar early with one return
 * short. Calling the kernel directly on the returns, starting from the first
 * real one, is what makes the warm-up `period` without an index hack.
 */
export function historicalVolatility<
  S extends SeriesSchema,
  const Output extends string = 'hv',
>(series: TimeSeries<S>, options: HistoricalVolatilityOptions<S, Output> = {}) {
  const period = options.period ?? 20;
  assertPeriod(period);
  const annualize = options.annualize ?? 252;
  if (!(Number.isFinite(annualize) && annualize > 0)) {
    throw new TypeError(
      'historicalVolatility annualize must be a positive number (bars per year)',
    );
  }
  const column = (options.column ?? DEFAULT_SOURCE) as string;
  const output = (options.output ?? 'hv') as Output;
  const wide = series as unknown as TimeSeries<SeriesSchema>;
  assertNoColumn(wide, output);

  const v = columnValues(wide, column);
  const length = v.length;
  const out = new Float64Array(length).fill(NaN);
  if (length < 2) return series.withColumn(output, out);

  // Log returns, aligned to the bar each one ENDS on: `r[j]` is the return
  // from bar `j` to bar `j + 1`, so the array is one shorter than the prices
  // and has no leading gap of its own. Missing prices are `NaN` and fall
  // through the guard ([PND-STUDYBOX]); non-positive ones are caught by it.
  const r = new Float64Array(length - 1);
  for (let j = 0; j < r.length; j += 1) {
    const a = v[j]!;
    const b = v[j + 1]!;
    r[j] = a > 0 && b > 0 ? Math.log(b / a) : NaN;
  }

  // Step over a leading run of missing returns (a chained study's warm-up)
  // so the first window covers `period` real returns rather than emitting
  // early over a partial one — see "Edges".
  let first = 0;
  while (first < r.length && !Number.isFinite(r[first]!)) first += 1;
  const usable = r.length - first;
  if (usable < period) return series.withColumn(output, out);

  const sd = new Float64Array(usable);
  rollingMeanSdInto(r.subarray(first), period, 0, usable, undefined, sd);

  // `sd[m]` is the σ of the window ending on return `first + m`, which ends
  // on bar `first + m + 1`. The kernel emits `NaN` for its own warm-up and
  // for a window with no finite contributor, so no guard is needed here.
  const scale = Math.sqrt(annualize);
  for (let m = 0; m < usable; m += 1) out[first + m + 1] = sd[m]! * scale;
  return series.withColumn(output, out);
}
