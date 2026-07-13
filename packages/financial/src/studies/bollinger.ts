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
} from '../kernels/rolling.js';

export interface BollingerOptions<
  S extends SeriesSchema,
  Prefix extends string,
> {
  /** Window length in **bars**. */
  period: number;
  /** Band half-width in standard deviations. **Default `2`.** */
  stdDev?: number;
  /** Source column. **Default `'close'`.** */
  column?: NumericColumnNameForSchema<S>;
  /** Column-family prefix — appends `${prefix}Middle` / `Upper` / `Lower`.
   *  **Default `'bb'`.** */
  prefix?: Prefix;
}

/**
 * **Bollinger Bands®** (John Bollinger) — a `period`-bar simple moving average
 * (the middle band) with an upper/lower band at ±`stdDev` population standard
 * deviations. Appends three columns (`${prefix}Middle` / `${prefix}Upper` /
 * `${prefix}Lower`); the warm-up rows and any flat window (σ = 0) emit
 * `undefined` bands. One rolling pass (avg + stdev) over a bar-count window.
 */
export function bollinger<
  S extends SeriesSchema,
  const Prefix extends string = 'bb',
>(series: TimeSeries<S>, options: BollingerOptions<S, Prefix>) {
  assertPeriod(options.period);
  const stdDev = options.stdDev ?? 2;
  if (!Number.isFinite(stdDev) || stdDev <= 0) {
    throw new TypeError('bollinger stdDev must be a positive finite number');
  }
  const column = (options.column ?? DEFAULT_SOURCE) as string;
  const prefix = (options.prefix ?? 'bb') as Prefix;
  const middleName = `${prefix}Middle` as const;
  const upperName = `${prefix}Upper` as const;
  const lowerName = `${prefix}Lower` as const;

  const wide = series as unknown as TimeSeries<SeriesSchema>;
  for (const name of [middleName, upperName, lowerName]) {
    assertNoColumn(wide, name);
  }

  const middle = rollingValues(wide, column, 'avg', options.period);
  const sd = rollingValues(wide, column, 'stdev', options.period);
  // σ = 0 (a flat window) has no meaningful band — emit undefined, matching
  // `TimeSeries.baseline`, so downstream "outside the band" tests don't fire on
  // every bar of a flat stretch.
  const band = (sign: 1 | -1): Array<number | undefined> =>
    middle.map((m, i) => {
      const d = sd[i];
      return m === undefined || d === undefined || d === 0
        ? undefined
        : m + sign * stdDev * d;
    });

  return series
    .withColumn(middleName, middle)
    .withColumn(upperName, band(1))
    .withColumn(lowerName, band(-1));
}
