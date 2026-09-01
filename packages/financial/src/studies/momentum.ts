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

export interface MomentumOptions<
  S extends SeriesSchema,
  Output extends string,
> {
  /** Look-back in **bars**. **Default `10`** (TA-Lib's own). */
  period?: number;
  /** Source column. **Default `'close'`.** */
  column?: NumericColumnNameForSchema<S>;
  /** Name of the appended column. **Default `'momentum'`.** */
  output?: Output;
}

/**
 * **Momentum** — the absolute difference from `period` bars ago:
 * `value − value[i − period]`. Appends one column; `undefined` for the first
 * `period` rows (no look-back). `period` counts **bars**, so it's gap-correct
 * on a trading axis.
 *
 * This is the additive companion to {@link percentChange}, which is the same
 * look-back as a ratio (`(value / value[i − period] − 1) × 100`, i.e. rate of
 * change). Momentum is in the **units of the price**, so it scales with it
 * and is not comparable across instruments at different price levels — reach
 * for `percentChange` when you want that.
 *
 * ## Definition
 *
 * **TA-Lib's `MOM`**, exactly: verified against it bar-for-bar in the oracle
 * fixture, with identical warm-up masks, at both periods tested. There is no
 * smoothing and no seed, so there is no definition delta to document.
 *
 * ## Edges
 *
 * - A missing cell at either end of the look-back makes the difference
 *   missing — nothing is invented across a gap.
 * - A leading gap (another study's own warm-up) shifts the start by that
 *   much and is otherwise unaffected.
 */
export function momentum<
  S extends SeriesSchema,
  const Output extends string = 'momentum',
>(series: TimeSeries<S>, options: MomentumOptions<S, Output> = {}) {
  const period = options.period ?? 10;
  assertPeriod(period);
  const column = (options.column ?? DEFAULT_SOURCE) as string;
  const output = (options.output ?? 'momentum') as Output;
  const wide = series as unknown as TimeSeries<SeriesSchema>;
  assertNoColumn(wide, output);

  const v = columnValues(wide, column);
  // Missing cells are `NaN` and propagate through the subtraction on their
  // own ([PND-STUDYBOX]); the only guard is "no predecessor yet".
  const out = new Float64Array(v.length);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = i < period ? NaN : v[i]! - v[i - period]!;
  }
  return series.withColumn(output, out);
}
