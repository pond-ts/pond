import type {
  NumericColumnNameForSchema,
  SeriesSchema,
  TimeSeries,
} from 'pond-ts';
import { DEFAULT_SOURCE } from '../contract/columns.js';
import {
  assertNoColumn,
  assertPeriod,
  emaValues,
  rollingValues,
} from '../kernels/rolling.js';

export interface EnvelopeOptions<
  S extends SeriesSchema,
  Prefix extends string,
> {
  /** Window length in **bars**. */
  period: number;
  /** Band half-width as a **percent** of the centre line. **Default `2.5`.** */
  percent?: number;
  /** Centre-line moving average. **Default `'sma'`.** */
  maType?: 'sma' | 'ema';
  /** Source column. **Default `'close'`.** */
  column?: NumericColumnNameForSchema<S>;
  /** Column-family prefix — `${prefix}Middle` / `Upper` / `Lower`. **Default
   *  `'env'`.** */
  prefix?: Prefix;
}

/**
 * **Moving-average envelope** — a moving average (`maType`, default SMA) with
 * upper/lower bands at ±`percent` % of the centre line: `middle × (1 ±
 * percent/100)`. Appends `${prefix}Middle` / `${prefix}Upper` /
 * `${prefix}Lower`; warm-up rows `undefined`. (Bollinger bands scale with
 * volatility, an envelope by a fixed percent.)
 */
export function envelope<
  S extends SeriesSchema,
  const Prefix extends string = 'env',
>(series: TimeSeries<S>, options: EnvelopeOptions<S, Prefix>) {
  assertPeriod(options.period);
  const percent = options.percent ?? 2.5;
  if (!Number.isFinite(percent) || percent <= 0) {
    throw new TypeError('envelope percent must be a positive finite number');
  }
  const column = (options.column ?? DEFAULT_SOURCE) as string;
  const prefix = (options.prefix ?? 'env') as Prefix;
  const middleName = `${prefix}Middle` as const;
  const upperName = `${prefix}Upper` as const;
  const lowerName = `${prefix}Lower` as const;

  const wide = series as unknown as TimeSeries<SeriesSchema>;
  for (const name of [middleName, upperName, lowerName]) {
    assertNoColumn(wide, name);
  }

  const middle =
    (options.maType ?? 'sma') === 'ema'
      ? emaValues(wide, column, options.period)
      : rollingValues(wide, column, 'avg', options.period);
  const f = percent / 100;
  const scale = (factor: number): Array<number | undefined> =>
    middle.map((m) => (m === undefined ? undefined : m * factor));

  return series
    .withColumn(middleName, middle)
    .withColumn(upperName, scale(1 + f))
    .withColumn(lowerName, scale(1 - f));
}
