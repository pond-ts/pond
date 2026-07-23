import type {
  AggregateOutputMap,
  NumericColumnNameForSchema,
  SeriesSchema,
  TimeSeries,
} from 'pond-ts';

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
 * Row-aligned columns from a **single** trailing count-window pass: each named
 * spec (`{ from, using }`) becomes an array of one value per input row,
 * `undefined` for the first `period - 1` warm-up rows (length-preserving). One
 * `rolling` scan for all specs (so a multi-output study like Bollinger reduces
 * avg + stdev in one pass); the bar-count window is correct across session gaps.
 */
export function rollingColumns(
  series: TimeSeries<SeriesSchema>,
  specs: Record<string, { from: string; using: RollingReducer }>,
  period: number,
): Record<string, Array<number | undefined>> {
  const rolled = series.rolling(
    { count: period },
    specs as AggregateOutputMap<SeriesSchema>,
    { minSamples: period },
  );
  const out: Record<string, Array<number | undefined>> = {};
  for (const name of Object.keys(specs)) {
    // Read the result column directly off the columnar store — materializing
    // `rolled.events` costs ~50× the whole rolling scan at 1M rows (one Event
    // + one data object per row) for what is a single numeric column read.
    out[name] = readNumericColumn(rolled, name);
  }
  return out;
}

/**
 * Row-aligned values of a single trailing count-window reducer over `column` —
 * the one-column case of {@link rollingColumns} (SMA, rolling stdev/min/max/…).
 */
export function rollingValues(
  series: TimeSeries<SeriesSchema>,
  column: string,
  reducer: RollingReducer,
  period: number,
): Array<number | undefined> {
  return rollingColumns(
    series,
    { value: { from: column, using: reducer } },
    period,
  )['value']!;
}

/** A raw numeric column read as `(number | undefined)[]`, row-aligned — the
 *  source values a study derives from (percent-change, z-score numerator). */
export function columnValues(
  series: TimeSeries<SeriesSchema>,
  column: string,
): Array<number | undefined> {
  return readNumericColumn(series, column);
}

/**
 * Row-aligned `(number | undefined)[]` read of one numeric column via the
 * public column API — no `series.events` materialization (an Event + data
 * object per row), which dominated study cost on large series. A column
 * that doesn't exist, or a non-number cell, reads as `undefined` — the same
 * values the old `event.data()[column]` walk produced.
 */
function readNumericColumn(
  series: TimeSeries<SeriesSchema>,
  column: string,
): Array<number | undefined> {
  const col = series.column(
    column as Parameters<TimeSeries<SeriesSchema>['column']>[0],
  ) as { at(i: number): unknown } | undefined;
  const length = series.length;
  const values = new Array<number | undefined>(length);
  if (col === undefined) {
    return values.fill(undefined);
  }
  for (let i = 0; i < length; i += 1) {
    const v = col.at(i);
    values[i] = typeof v === 'number' ? v : undefined;
  }
  return values;
}

/** Row-aligned `period`-span EMA values over `column` (`α = 2/(period+1)`),
 *  length-preserving warm-up — the moving-average alternative for a study whose
 *  centre line can be an EMA (e.g. an EMA envelope). Composes on `smooth`. */
export function emaValues(
  series: TimeSeries<SeriesSchema>,
  column: string,
  period: number,
): Array<number | undefined> {
  const smoothed = series.smooth(
    column as NumericColumnNameForSchema<SeriesSchema>,
    'ema',
    { span: period, minSamples: period, output: '__ema__' },
  );
  return columnValues(
    smoothed as unknown as TimeSeries<SeriesSchema>,
    '__ema__',
  );
}
