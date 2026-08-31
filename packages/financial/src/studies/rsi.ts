import type {
  NumericColumnNameForSchema,
  SeriesSchema,
  TimeSeries,
} from 'pond-ts';
import { DEFAULT_SOURCE } from '../contract/columns.js';
import {
  assertNoColumn,
  assertPeriod,
  columnValues,
} from '../kernels/rolling.js';
import { wilderValues } from '../kernels/wilder.js';

export interface RsiOptions<S extends SeriesSchema, Output extends string> {
  /** Look-back in **bars**. **Default `14`** (Wilder's own). */
  period?: number;
  /** Source column. **Default `'close'`.** */
  column?: NumericColumnNameForSchema<S>;
  /** Name of the appended column. **Default `'rsi'`.** */
  output?: Output;
}

/**
 * **Relative Strength Index** — Wilder's momentum oscillator, bounded `0..100`:
 * `100 − 100/(1 + avgGain/avgLoss)`, where the averages are
 * {@link wilderValues | Wilder-smoothed} over `period` bars.
 *
 * Appends one column; `undefined` for the first `period` rows. Note that is
 * `period`, not `period − 1`: RSI is computed from **differences**, so a
 * `period`-bar average of them needs `period + 1` bars of input.
 *
 * ## Definition
 *
 * This is **TA-Lib's RSI**, which is Wilder's original (with one deliberate
 * delta on a flat window — see *Edges*): the gain/loss averages
 * are seeded on the arithmetic mean of the first `period` differences and then
 * carried by `avg[i] = (avg[i−1]·(period−1) + x[i]) / period`. Verified against
 * TA-Lib bar-for-bar in the oracle fixture — agreement to `1.4e-14`.
 *
 * The delta worth knowing about is against implementations that smooth with a
 * plain first-sample-seeded EMA (`α = 1/period` with no seed window), which is
 * what you get from a naive `close.ewm(alpha=1/n, adjust=False)`. That is a
 * different indicator, not a rounding difference: on this package's own oracle
 * input it sits up to **7.03 RSI points** away, still **0.15** out 65 bars
 * later. If you need that variant, it is `ema(...)` over your own gain/loss
 * columns rather than an option here — one RSI, matching the reference
 * implementation, is worth more than two that differ invisibly.
 *
 * ## Edges
 *
 * - **No losses in the window** (`avgLoss = 0`) → RSI `100`, the limit of the
 *   formula rather than a division by zero.
 * - **A perfectly flat window** (`avgGain = avgLoss = 0`) → `undefined`.
 *   **This is a deliberate delta from TA-Lib**, which returns `0` there. The
 *   ratio is `0/0`: there is no relative strength to report, and `0` is the
 *   same value TA-Lib gives for "every bar fell", so it conflates the
 *   strongest possible downtrend with no movement at all. pond's studies
 *   distinguish "no answer" from "an answer that happens to be zero"
 *   everywhere else, so it does here too. Everything outside this case
 *   matches TA-Lib to `1.4e-14`.
 * - **A leading gap shifts the start, it doesn't kill the study.** Running
 *   over another study's output (whose own warm-up leaves missing rows at the
 *   head) begins that many bars later and is otherwise unaffected.
 * - **An interior gap propagates to the end**, because a recursion has no
 *   state to carry across a hole. That is inherent to Wilder smoothing rather
 *   than a choice; fill before smoothing if you need continuity across one.
 */
export function rsi<
  S extends SeriesSchema,
  const Output extends string = 'rsi',
>(series: TimeSeries<S>, options: RsiOptions<S, Output> = {}) {
  const period = options.period ?? 14;
  assertPeriod(period);
  const column = (options.column ?? DEFAULT_SOURCE) as string;
  const output = (options.output ?? 'rsi') as Output;
  const wide = series as unknown as TimeSeries<SeriesSchema>;
  assertNoColumn(wide, output);

  const v = columnValues(wide, column);
  const length = v.length;

  // Split each bar-over-bar difference into its gain and loss legs. Missing
  // cells are `NaN` and propagate on their own ([PND-STUDYBOX]); index 0 has
  // no predecessor, and `start = 1` below is what tells the smoother so.
  const gains = new Float64Array(length);
  const losses = new Float64Array(length);
  for (let i = 1; i < length; i += 1) {
    const d = v[i]! - v[i - 1]!;
    gains[i] = d > 0 ? d : Number.isNaN(d) ? NaN : 0;
    losses[i] = d < 0 ? -d : Number.isNaN(d) ? NaN : 0;
  }

  const avgGain = wilderValues(gains, period, 1);
  const avgLoss = wilderValues(losses, period, 1);

  const out = new Float64Array(length);
  for (let i = 0; i < length; i += 1) {
    const g = avgGain[i]!;
    const l = avgLoss[i]!;
    if (l === 0) {
      // All gains: the ratio diverges and RSI's limit is 100. A flat window
      // (no gains either) has no relative strength at all.
      out[i] = g === 0 ? NaN : 100;
      continue;
    }
    out[i] = 100 - 100 / (1 + g / l);
  }
  return series.withColumn(output, out);
}
