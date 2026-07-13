import type { AggregateOutputMap, SeriesSchema, TimeSeries } from 'pond-ts';

/**
 * The count-window reducers the studies compose on — pond's built-in aggregate
 * reducers plus percentile (`p95`, `p5`, …). All run over a **bar-count** window
 * (core G1), which is the correct window for N-bar studies across session gaps.
 */
export type RollingReducer =
  | 'avg'
  | 'stdev'
  | 'min'
  | 'max'
  | 'median'
  | 'sum'
  | `p${number}`;

/** Assert a bar-count `period` is a positive integer. */
export function assertPeriod(period: number, name = 'period'): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new TypeError(`${name} must be a positive integer (bar count)`);
  }
}

/**
 * Throw if `output` would collide with a column already on the series — studies
 * **append**, and a silent overwrite is a footgun (points the caller at the
 * `output` / `prefix` knob, matching `TimeSeries.baseline`).
 */
export function assertNoColumn(
  series: TimeSeries<SeriesSchema>,
  output: string,
): void {
  if (series.schema.slice(1).some((c) => c.name === output)) {
    throw new TypeError(
      `study output column '${output}' collides with an existing column; pass a different 'output'`,
    );
  }
}

/**
 * Row-aligned values of a trailing **count-window** reducer over `column` — an
 * N-bar rolling statistic, one value per input row, `undefined` for the first
 * `period - 1` warm-up rows (the length-preserving convention). Reuses core's
 * `rolling({ count })`; the bar-count window is correct across session gaps
 * where a duration window would span the wrong number of bars.
 */
export function rollingValues(
  series: TimeSeries<SeriesSchema>,
  column: string,
  reducer: RollingReducer,
  period: number,
): Array<number | undefined> {
  const rolled = series.rolling(
    { count: period },
    {
      value: { from: column, using: reducer },
    } as AggregateOutputMap<SeriesSchema>,
    { minSamples: period },
  );
  return rolled.events.map((event) => {
    const v = (event.data() as Record<string, unknown>)['value'];
    return typeof v === 'number' ? v : undefined;
  });
}
