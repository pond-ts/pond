import type {
  AppendColumn,
  NumericColumnNameForSchema,
  SeriesSchema,
  SmoothAppendSchema,
  TimeSeries,
} from 'pond-ts';
import { DEFAULT_SOURCE } from '../contract/columns.js';
import {
  assertNoColumn,
  assertPeriod,
  rollingValues,
} from '../kernels/rolling.js';

/** Options shared by the single-line moving averages. `column` is the source
 *  field (default `close`); `output` names the appended column. */
export interface MovingAverageOptions<
  S extends SeriesSchema,
  Output extends string,
> {
  /** Window length in **bars** (a count, not a duration). */
  period: number;
  /** Source column to average. **Default `'close'`.** */
  column?: NumericColumnNameForSchema<S>;
  /** Name of the appended column. **Default the study name** (`'sma'` / `'ema'`);
   *  pass an explicit name to stack several (e.g. `sma20`, `sma50`). */
  output?: Output;
}

/**
 * **Simple moving average** — the mean of the last `period` bars, appended as a
 * new column. A trailing **count** window (correct across session gaps), warmed
 * up length-preservingly (`undefined` for the first `period - 1` bars). Runs
 * over any numeric `column`, including another study's output.
 */
export function sma<
  S extends SeriesSchema,
  const Output extends string = 'sma',
>(
  series: TimeSeries<S>,
  options: MovingAverageOptions<S, Output>,
): TimeSeries<AppendColumn<S, Output, 'number'>> {
  assertPeriod(options.period);
  const column = (options.column ?? DEFAULT_SOURCE) as string;
  const output = (options.output ?? 'sma') as Output;
  const wide = series as unknown as TimeSeries<SeriesSchema>;
  assertNoColumn(wide, output);
  const values = rollingValues(wide, column, 'avg', options.period);
  return series.withColumn(output, values);
}

/**
 * **Exponential moving average** — a `period`-span EMA (`α = 2/(period+1)`, the
 * financial convention), appended as a new column. Length-preserving warm-up
 * (`undefined` for the first `period - 1` bars) via the ema `minSamples` gate,
 * so it lines up on the source's time axis. Composes on core's `smooth('ema')`.
 */
export function ema<
  S extends SeriesSchema,
  const Output extends string = 'ema',
>(
  series: TimeSeries<S>,
  options: MovingAverageOptions<S, Output>,
): TimeSeries<SmoothAppendSchema<S, Output>> {
  assertPeriod(options.period);
  const column = (options.column ??
    DEFAULT_SOURCE) as NumericColumnNameForSchema<S>;
  const output = (options.output ?? 'ema') as Output;
  assertNoColumn(series as unknown as TimeSeries<SeriesSchema>, output);
  // `output` is always supplied, so smooth resolves to its append branch; the
  // declared return is that branch (a cast past smooth's deferred conditional).
  return series.smooth(column, 'ema', {
    span: options.period,
    minSamples: options.period,
    output,
  }) as unknown as TimeSeries<SmoothAppendSchema<S, Output>>;
}
