import type {
  NumericColumnNameForSchema,
  SeriesSchema,
  TimeSeries,
} from 'pond-ts';
import { DEFAULT_OHLCV } from '../contract/columns.js';
import {
  assertNoColumn,
  assertPeriod,
  columnValues,
} from '../kernels/rolling.js';
import { wilderValues } from '../kernels/wilder.js';

export interface AtrOptions<S extends SeriesSchema, Output extends string> {
  /** Look-back in **bars**. **Default `14`** (Wilder's own). */
  period?: number;
  /** High column. **Default `'high'`.** */
  high?: NumericColumnNameForSchema<S>;
  /** Low column. **Default `'low'`.** */
  low?: NumericColumnNameForSchema<S>;
  /** Close column. **Default `'close'`.** */
  close?: NumericColumnNameForSchema<S>;
  /** Name of the appended column. **Default `'atr'`.** */
  output?: Output;
}

/**
 * **Average True Range** — Wilder's volatility measure: the
 * {@link wilderValues | Wilder-smoothed} average of the **true range**, where
 * true range is the widest of the three spans a bar can cover:
 *
 * ```
 * TR = max(high − low, |high − prevClose|, |low − prevClose|)
 * ```
 *
 * The last two terms are what make it *true* range rather than plain range:
 * a bar that gaps away from the previous close covers ground the bar's own
 * high-to-low span does not show.
 *
 * Appends one column; `undefined` for the first `period` rows. True range
 * needs a previous close, so it is undefined on bar 0 and a `period`-bar
 * average of it first lands on bar `period` — the same off-by-one {@link rsi}
 * has, for the same reason.
 *
 * ## Three inputs, not one
 *
 * Every study before this took a single `column`. ATR reads **high, low and
 * close**, so instead of one source option it names each input, each
 * defaulting to its conventional bar-column name from `DEFAULT_OHLCV`. That
 * is the same rule the single-input studies follow — never hard-code a
 * column, always let the caller redirect it — applied three times rather
 * than a new mechanism.
 *
 * Because all three are columns of one series, they are aligned by
 * construction: there is no way to hand ATR a `high` of a different length
 * from its `close`, which is a class of error array-based libraries have to
 * check for at every call.
 *
 * ## Definition
 *
 * **TA-Lib's ATR**, which is Wilder's: the true ranges are seeded on their
 * arithmetic mean over the first `period` values and then carried by
 * `avg[i] = (avg[i−1]·(period−1) + TR[i]) / period`. Verified against TA-Lib
 * bar-for-bar in the oracle fixture — exact agreement, and identical warm-up.
 *
 * ## Edges
 *
 * - **ATR is an absolute quantity, in the units of the price.** It does not
 *   normalise, so it is not comparable across instruments at different price
 *   levels; divide by close for that (the "ATR percent" a caller can build
 *   with {@link percentChange}-style arithmetic, deliberately not baked in).
 * - **A leading gap shifts the start**, so running over columns that begin
 *   with missing rows delays the study rather than emptying it.
 * - **An interior gap propagates to the end**, inherent to Wilder smoothing —
 *   a recursion has no state to carry across a hole. Note this differs from
 *   `ema()`, whose interior gaps are skipped and recovered from; the two
 *   smoothers genuinely differ here, and Wilder's answer is the conservative
 *   one: a bar with no close leaves the true range of the NEXT bar unknown
 *   too, so there is no honest value to resume from.
 */
export function atr<
  S extends SeriesSchema,
  const Output extends string = 'atr',
>(series: TimeSeries<S>, options: AtrOptions<S, Output> = {}) {
  const period = options.period ?? 14;
  assertPeriod(period);
  const highName = (options.high ?? DEFAULT_OHLCV.high) as string;
  const lowName = (options.low ?? DEFAULT_OHLCV.low) as string;
  const closeName = (options.close ?? DEFAULT_OHLCV.close) as string;
  const output = (options.output ?? 'atr') as Output;
  const wide = series as unknown as TimeSeries<SeriesSchema>;
  assertNoColumn(wide, output);

  const high = columnValues(wide, highName);
  const low = columnValues(wide, lowName);
  const close = columnValues(wide, closeName);
  const length = high.length;

  // True range. Bar 0 has no previous close, and `start = 1` below is what
  // tells the smoother so. Missing cells are NaN and propagate through the
  // comparisons on their own ([PND-STUDYBOX]) — `Math.max` returns NaN if any
  // argument is NaN, which is the answer we want: an unknown close makes the
  // whole true range unknown.
  const tr = new Float64Array(length);
  tr[0] = NaN;
  for (let i = 1; i < length; i += 1) {
    const prevClose = close[i - 1]!;
    tr[i] = Math.max(
      high[i]! - low[i]!,
      Math.abs(high[i]! - prevClose),
      Math.abs(low[i]! - prevClose),
    );
  }

  return series.withColumn(output, wilderValues(tr, period, 1));
}
