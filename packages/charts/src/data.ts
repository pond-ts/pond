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
 * A chart-ready view of a box-and-whisker series ({@link BoxPlot}): the
 * interval-keyed time axis (`x` = key `begin`, `xEnd` = key `end`, the box's
 * horizontal span) plus the five quantile edges per key —
 * `lower`/`q1`/`median`/`q3`/`upper`. The quantiles are pre-computed columns
 * (a `rolling`/`aggregate` percentile pass upstream); the chart only reads them.
 *
 * A key is drawn only where **all five** quantiles are finite; any one `NaN` is
 * a gap (the box draws nothing — same gap contract as {@link BandSeries}).
 *
 * `x` and `xEnd` are zero-copy views of the key column's `begin`/`end` buffers
 * (immutable by contract — do not mutate). For a point-in-time key the column's
 * `end` coincides with `begin`, so `xEnd === x` and the box collapses to a
 * minimum-width mark via `barSpanPx`; an interval key gives the box real width.
 */
export interface BoxSeries {
  readonly x: Float64Array;
  readonly xEnd: Float64Array;
  readonly lower: Float64Array;
  readonly q1: Float64Array;
  readonly median: Float64Array;
  readonly q3: Float64Array;
  readonly upper: Float64Array;
  readonly length: number;
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
 * The key column's `end` buffer aligned to the logical length (zero-copy). For a
 * point-in-time key the column sets `end === begin`, so this returns the same
 * timestamps as {@link timeAxis} — an interval key gives a distinct span.
 */
function timeEndAxis<S extends SeriesSchema>(
  series: TimeSeries<S>,
): Float64Array {
  return series.keyColumn().end.subarray(0, series.length);
}

/** The five quantile column names a {@link boxFromTimeSeries} reads, in order. */
export interface BoxColumns {
  /** Lower whisker end (e.g. `p5` / `min`). */
  readonly lower: string;
  /** Box bottom — first quartile (e.g. `p25`). */
  readonly q1: string;
  /** Median line inside the box (e.g. `p50`). */
  readonly median: string;
  /** Box top — third quartile (e.g. `p75`). */
  readonly q3: string;
  /** Upper whisker end (e.g. `p95` / `max`). */
  readonly upper: string;
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

/**
 * Build a {@link BoxSeries} from a pond `TimeSeries` — five numeric quantile
 * columns (`lower`/`q1`/`median`/`q3`/`upper`) sharing the series' interval time
 * axis (`begin`/`end`, the box's horizontal span). The quantile columns are
 * typically `rolling`/`aggregate` percentiles (e.g. p5/p25/p50/p75/p95); a key
 * with any quantile missing reads as a gap (the box draws nothing).
 *
 * @throws RangeError if any quantile column does not exist.
 * @throws TypeError if any quantile column is not a numeric column.
 */
export function boxFromTimeSeries<S extends SeriesSchema>(
  series: TimeSeries<S>,
  columns: BoxColumns,
): BoxSeries {
  return {
    x: timeAxis(series),
    xEnd: timeEndAxis(series),
    lower: readNumericColumn(series, columns.lower),
    q1: readNumericColumn(series, columns.q1),
    median: readNumericColumn(series, columns.median),
    q3: readNumericColumn(series, columns.q3),
    upper: readNumericColumn(series, columns.upper),
    length: series.length,
  };
}
