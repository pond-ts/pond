import type {
  NumericColumnNameForSchema,
  SeriesSchema,
  TimeSeries,
} from 'pond-ts';
import { DEFAULT_SOURCE } from '../contract/columns.js';
import {
  assertNoColumn,
  assertPeriod,
  rollingValues,
  type RollingReducer,
} from '../kernels/rolling.js';

/** Options for a single-reducer rolling statistic. */
export interface RollingStatOptions<
  S extends SeriesSchema,
  Output extends string,
> {
  /** Window length in **bars**. */
  period: number;
  /** Source column. **Default `'close'`.** */
  column?: NumericColumnNameForSchema<S>;
  /** Name of the appended column. **Default the statistic name.** */
  output?: Output;
}

/** Shared body: append a trailing count-window reducer over `column`. */
function appendStat<S extends SeriesSchema, Output extends string>(
  series: TimeSeries<S>,
  reducer: RollingReducer,
  period: number,
  column: string,
  output: Output,
) {
  const wide = series as unknown as TimeSeries<SeriesSchema>;
  assertNoColumn(wide, output);
  return series.withColumn(
    output,
    rollingValues(wide, column, reducer, period),
  );
}

/** **Rolling standard deviation** (population, `ddof=0`) over the last `period`
 *  bars. Length-preserving warm-up. Default output `'stdev'`. */
export function rollingStdev<
  S extends SeriesSchema,
  const Output extends string = 'stdev',
>(series: TimeSeries<S>, options: RollingStatOptions<S, Output>) {
  assertPeriod(options.period);
  return appendStat(
    series,
    'stdev',
    options.period,
    (options.column ?? DEFAULT_SOURCE) as string,
    (options.output ?? 'stdev') as Output,
  );
}

/** **Rolling minimum** over the last `period` bars (Donchian lower). Default
 *  output `'min'`. */
export function rollingMin<
  S extends SeriesSchema,
  const Output extends string = 'min',
>(series: TimeSeries<S>, options: RollingStatOptions<S, Output>) {
  assertPeriod(options.period);
  return appendStat(
    series,
    'min',
    options.period,
    (options.column ?? DEFAULT_SOURCE) as string,
    (options.output ?? 'min') as Output,
  );
}

/** **Rolling maximum** over the last `period` bars (Donchian upper). Default
 *  output `'max'`. */
export function rollingMax<
  S extends SeriesSchema,
  const Output extends string = 'max',
>(series: TimeSeries<S>, options: RollingStatOptions<S, Output>) {
  assertPeriod(options.period);
  return appendStat(
    series,
    'max',
    options.period,
    (options.column ?? DEFAULT_SOURCE) as string,
    (options.output ?? 'max') as Output,
  );
}

/** Options for {@link rollingPercentile}. */
export interface RollingPercentileOptions<
  S extends SeriesSchema,
  Output extends string,
> extends RollingStatOptions<S, Output> {
  /** Percentile rank in `[0, 100]` (e.g. `90` for p90). Linear interpolation. */
  q: number;
}

/** **Rolling percentile** — the `q`-th percentile of the last `period` bars
 *  (linear interpolation, matching NumPy/pandas). Default output `p{q}` (e.g.
 *  `'p90'`). */
export function rollingPercentile<
  S extends SeriesSchema,
  const Output extends string = string,
>(series: TimeSeries<S>, options: RollingPercentileOptions<S, Output>) {
  assertPeriod(options.period);
  if (!(options.q >= 0 && options.q <= 100)) {
    throw new TypeError('rollingPercentile q must be in [0, 100]');
  }
  return appendStat(
    series,
    `p${options.q}` as RollingReducer,
    options.period,
    (options.column ?? DEFAULT_SOURCE) as string,
    (options.output ?? `p${options.q}`) as Output,
  );
}
