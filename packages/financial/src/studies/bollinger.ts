import type {
  NumericColumnNameForSchema,
  SeriesSchema,
  TimeSeries,
} from 'pond-ts';
import { DEFAULT_SOURCE } from '../contract/columns.js';
import {
  assertNoColumn,
  assertPeriod,
  rollingColumns,
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

  // One rolling pass reduces both the middle (avg) and the band width (stdev).
  const rolled = rollingColumns(
    wide,
    {
      middle: { from: column, using: 'avg' },
      sd: { from: column, using: 'stdev' },
    },
    options.period,
  );
  const middle = rolled['middle']!;
  const sd = rolled['sd']!;
  // σ = 0 (a flat window) has no meaningful band — emit missing, matching
  // `TimeSeries.baseline`, so downstream "outside the band" tests don't fire on
  // every bar of a flat stretch.
  //
  // A missing centre or σ is `NaN` ([PND-STUDYBOX]) and propagates through the
  // arithmetic on its own, so the only guard left is the study-specific one.
  // `d === 0` is false when `d` is NaN, so a warm-up bar falls through to the
  // arithmetic and stays NaN — which is the answer we want.
  const band = (sign: 1 | -1): Float64Array => {
    const out = new Float64Array(middle.length);
    for (let i = 0; i < out.length; i += 1) {
      const d = sd[i]!;
      out[i] = d === 0 ? NaN : middle[i]! + sign * stdDev * d;
    }
    return out;
  };

  return series
    .withColumn(middleName, middle)
    .withColumn(upperName, band(1))
    .withColumn(lowerName, band(-1));
}
