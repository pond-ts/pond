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
  rollingColumns,
} from '../kernels/rolling.js';

export interface ZScoreOptions<S extends SeriesSchema, Output extends string> {
  /** Window length in **bars**. */
  period: number;
  /** Source column. **Default `'close'`.** */
  column?: NumericColumnNameForSchema<S>;
  /** Name of the appended column. **Default `'zscore'`.** */
  output?: Output;
}

/**
 * **Rolling z-score** — how many rolling standard deviations the value sits
 * from its rolling mean: `(value − SMA(period)) / stdev(period)` (population
 * stdev). Appends one column; `undefined` on the warm-up and on any flat
 * (σ = 0) window. One rolling pass (mean + stdev).
 */
export function zScore<
  S extends SeriesSchema,
  const Output extends string = 'zscore',
>(series: TimeSeries<S>, options: ZScoreOptions<S, Output>) {
  assertPeriod(options.period);
  const column = (options.column ?? DEFAULT_SOURCE) as string;
  const output = (options.output ?? 'zscore') as Output;
  const wide = series as unknown as TimeSeries<SeriesSchema>;
  assertNoColumn(wide, output);

  const rolled = rollingColumns(
    wide,
    {
      mean: { from: column, using: 'avg' },
      sd: { from: column, using: 'stdev' },
    },
    options.period,
  );
  const mean = rolled['mean']!;
  const sd = rolled['sd']!;
  const src = columnValues(wide, column);
  // A missing value, mean or σ is `NaN` and propagates ([PND-STUDYBOX]); the
  // only guard left is σ = 0, where the z-score is undefined rather than
  // infinite. `s === 0` is false for NaN, so warm-up bars fall through to the
  // arithmetic and stay NaN.
  const z = new Float64Array(src.length);
  for (let i = 0; i < z.length; i += 1) {
    const s = sd[i]!;
    z[i] = s === 0 ? NaN : (src[i]! - mean[i]!) / s;
  }
  return series.withColumn(output, z);
}
