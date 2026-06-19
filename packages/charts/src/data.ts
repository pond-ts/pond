import type { SeriesSchema, TimeSeries } from 'pond-ts';

/**
 * A chart-ready columnar view of a series: parallel typed arrays for the time
 * (x) and value (y) axes, plus the logical row count.
 *
 * Missing / non-finite values are `NaN` in `y` — the gap signal the draw layers
 * break the line on (`Number.isFinite`, never `!= null`; see
 * `docs/rfcs/charts.md` trap #2).
 *
 * Both arrays are length `length`. `x` is a zero-copy view of the key column's
 * `begin` buffer (immutable by contract — do not mutate); `y` is the value
 * column materialized to a `Float64Array`.
 */
export interface ChartSeries {
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly length: number;
}

/**
 * A chart-ready view of a band (variance envelope): the time axis plus a paired
 * `lower`/`upper` edge per sample. A sample is part of the filled band only
 * where **both** edges are finite; either edge `NaN` is a gap (the fill breaks,
 * it does not bridge — same contract as {@link ChartSeries}).
 */
export interface BandSeries {
  readonly x: Float64Array;
  readonly lower: Float64Array;
  readonly upper: Float64Array;
  readonly length: number;
}

/**
 * Index of the sample whose time (`x`) is nearest `time`, by binary search, or
 * `-1` for an empty axis. The scrub tracker uses it to snap to the closest data
 * point. `x` must be ascending (the key column always is).
 */
export function nearestIndex(
  x: Float64Array,
  length: number,
  time: number,
): number {
  if (length === 0) return -1;
  if (time <= x[0]!) return 0;
  if (time >= x[length - 1]!) return length - 1;
  let lo = 0;
  let hi = length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = x[mid]!;
    if (v === time) return mid;
    if (v < time) lo = mid + 1;
    else hi = mid - 1;
  }
  // lo is the first index past `time`; hi === lo - 1. Pick the closer neighbour.
  return time - x[hi]! <= x[lo]! - time ? hi : lo;
}

/**
 * Read a numeric column into a `Float64Array`, missing cells as `NaN`.
 *
 * Uses `read(i)` — a method on the column *class* — rather than the bulk
 * `toFloat64Array()`. The bulk reader is mounted on the prototype by a
 * side-effect import in pond-ts, which Vite/Rollup production builds tree-shake
 * away (despite the package's `sideEffects` field), so it throws "not a
 * function" in a bundled browser app. See `docs/notes/charts-m1-friction.md`.
 *
 * TODO(charts-perf): restore the bulk typed-array fast-path once the column-API
 * augmentation is bundle-safe in core — that's the columnar throughput win.
 *
 * @throws RangeError if `column` does not exist.
 * @throws TypeError if `column` is not a numeric column.
 */
function readNumericColumn<S extends SeriesSchema>(
  series: TimeSeries<S>,
  column: string,
): Float64Array {
  // Runtime-necessary even though it reads as dead code: `column()` returns
  // `undefined` for an unknown name at runtime, but core's public overload
  // currently types the result as non-`undefined` (see F-3 in the M1 friction
  // note). Keep the guard — the "throws on unknown column" test exercises it.
  const col = series.column(column);
  if (col === undefined) {
    throw new RangeError(`unknown column '${column}'`);
  }
  if (col.kind !== 'number') {
    throw new TypeError(
      `column '${column}' must be numeric (got '${col.kind}')`,
    );
  }
  const length = series.length;
  const out = new Float64Array(length);
  for (let i = 0; i < length; i += 1) {
    const v = col.read(i);
    out[i] = v === undefined ? NaN : v;
  }
  return out;
}

/** The key column's `begin` buffer aligned to the logical length (zero-copy). */
function timeAxis<S extends SeriesSchema>(series: TimeSeries<S>): Float64Array {
  // `begin` may carry trailing capacity beyond the logical length; subarray so
  // it lines up with the value arrays.
  return series.keyColumn().begin.subarray(0, series.length);
}

/**
 * Build a {@link ChartSeries} from a pond `TimeSeries` by reading its columnar
 * buffers directly — no per-event materialization. `column` names a numeric
 * value column; the key column supplies the time axis (`begin`, in ms).
 *
 * @throws RangeError if `column` does not exist.
 * @throws TypeError if `column` is not a numeric column.
 */
export function fromTimeSeries<S extends SeriesSchema>(
  series: TimeSeries<S>,
  column: string,
): ChartSeries {
  return {
    x: timeAxis(series),
    y: readNumericColumn(series, column),
    length: series.length,
  };
}

/**
 * Build a {@link BandSeries} from a pond `TimeSeries` — two numeric columns for
 * the `lower`/`upper` edges sharing the series' time axis. The edge columns are
 * typically `rollingByColumn` percentiles (e.g. p25/p75); a sample with either
 * edge missing reads as a gap in the fill.
 *
 * @throws RangeError if `lower` or `upper` does not exist.
 * @throws TypeError if `lower` or `upper` is not a numeric column.
 */
export function bandFromTimeSeries<S extends SeriesSchema>(
  series: TimeSeries<S>,
  lower: string,
  upper: string,
): BandSeries {
  return {
    x: timeAxis(series),
    lower: readNumericColumn(series, lower),
    upper: readNumericColumn(series, upper),
    length: series.length,
  };
}
