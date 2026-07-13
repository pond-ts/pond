import type {
  NumericColumnNameForSchema,
  SeriesSchema,
  TimeSeries,
} from 'pond-ts';
import { DEFAULT_SOURCE } from '../contract/columns.js';
import { assertNoColumn, columnValues } from '../kernels/rolling.js';

export interface PercentChangeOptions<
  S extends SeriesSchema,
  Output extends string,
> {
  /** Look-back in **bars**. **Default `1`** (bar-over-bar). */
  periods?: number;
  /** Source column. **Default `'close'`.** */
  column?: NumericColumnNameForSchema<S>;
  /** Name of the appended column. **Default `'pctChange'`.** */
  output?: Output;
}

/**
 * **Percent change** (rate of change) — the percent difference from `periods`
 * bars ago: `(value / value[i − periods] − 1) × 100`. Appends one column;
 * `undefined` for the first `periods` rows (no look-back) and where the prior
 * value is `0`/missing. `periods` counts **bars**, so it's gap-correct on a
 * trading axis.
 */
export function percentChange<
  S extends SeriesSchema,
  const Output extends string = 'pctChange',
>(series: TimeSeries<S>, options: PercentChangeOptions<S, Output> = {}) {
  const periods = options.periods ?? 1;
  if (!Number.isInteger(periods) || periods < 1) {
    throw new TypeError('percentChange periods must be a positive integer');
  }
  const column = (options.column ?? DEFAULT_SOURCE) as string;
  const output = (options.output ?? 'pctChange') as Output;
  const wide = series as unknown as TimeSeries<SeriesSchema>;
  assertNoColumn(wide, output);

  const v = columnValues(wide, column);
  const pc = v.map((cur, i) => {
    if (i < periods) return undefined;
    const prev = v[i - periods];
    return cur === undefined || prev === undefined || prev === 0
      ? undefined
      : (cur / prev - 1) * 100;
  });
  return series.withColumn(output, pc);
}
