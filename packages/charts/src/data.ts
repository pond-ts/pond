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
 * A chart-ready view of an interval-keyed series for bars: each mark spans
 * `[begin[i], end[i]]` (the key's range) with height `y[i]`. Unlike
 * {@link ChartSeries} (a single `x` point per row), a bar needs **both** key
 * endpoints to know its x-span, so the time axis is split into `begin`/`end`.
 *
 * Missing / non-finite values are `NaN` in `y` — the gap signal {@link drawBars}
 * skips (no bar), same `Number.isFinite` contract as {@link ChartSeries}. For a
 * **point-keyed** series (`begin === end`), `barsFromTimeSeries` derives a span
 * from neighbour spacing so the bars still have width (see there).
 */
export interface BarSeries {
  readonly begin: Float64Array;
  readonly end: Float64Array;
  readonly y: Float64Array;
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
 * Per-row begin/end buffers for the key column, each aligned to the logical
 * length (zero-copy views). For an interval / timeRange key these are the key's
 * own endpoints; for a point (`time`) key `end === begin`, which
 * {@link barsFromTimeSeries} then widens into a span.
 */
function keyBeginEnd<S extends SeriesSchema>(
  series: TimeSeries<S>,
): { begin: Float64Array; end: Float64Array } {
  const key = series.keyColumn();
  const n = series.length;
  // `begin`/`end` may carry trailing capacity beyond the logical length; subarray
  // so they line up with the value array. A `time` key's `end` aliases `begin`
  // (point-in-time), which the caller's point-key fallback replaces.
  return { begin: key.begin.subarray(0, n), end: key.end.subarray(0, n) };
}

/**
 * Build a {@link BarSeries} from a pond `TimeSeries` — one bar per event, the
 * key's `[begin, end]` as the x-span and `column` as the height.
 *
 * **Key-shape fallback (point-keyed series).** The primary form is
 * interval / timeRange-keyed, where each key already carries a `[begin, end]`
 * span. A **point-keyed** (`time`) series has `begin === end` (zero width), so
 * this derives a span from neighbour spacing: each bar is centred on its
 * timestamp and reaches **halfway to each neighbour** (a Voronoi cell on the
 * time axis). The first/last bars mirror their single adjacent gap so the row's
 * end bars match their interior width. A lone point (length 1) has no
 * neighbour, so it keeps zero width and falls back to the renderer's `minWidth`.
 *
 * This makes a uniformly-sampled point series render as contiguous bars (the
 * histogram look) without the caller pre-keying to intervals, while an
 * interval-keyed series (e.g. an `aggregate`/`window` rollup) draws its true
 * bucket spans. Detected by `keyColumn().kind === 'time'`.
 *
 * @throws RangeError if `column` does not exist.
 * @throws TypeError if `column` is not a numeric column.
 */
export function barsFromTimeSeries<S extends SeriesSchema>(
  series: TimeSeries<S>,
  column: string,
): BarSeries {
  const y = readNumericColumn(series, column);
  const n = series.length;
  const kind = series.keyColumn().kind;
  if (kind !== 'time') {
    // Interval / timeRange: the key's own endpoints are the bar span.
    const { begin, end } = keyBeginEnd(series);
    return { begin, end, y, length: n };
  }
  // Point key (begin === end): synthesize a span from neighbour spacing so the
  // bars have width. Copy into fresh buffers — the key's begin buffer is shared
  // (zero-copy) and must not be mutated.
  const src = series.keyColumn().begin;
  const begin = new Float64Array(n);
  const end = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = src[i]!;
    // Half-gap to the previous point (mirror the next gap at the left edge).
    const prevGap = i > 0 ? t - src[i - 1]! : i + 1 < n ? src[i + 1]! - t : 0;
    // Half-gap to the next point (mirror the previous gap at the right edge).
    const nextGap = i + 1 < n ? src[i + 1]! - t : i > 0 ? t - src[i - 1]! : 0;
    begin[i] = t - prevGap / 2;
    end[i] = t + nextGap / 2;
  }
  return { begin, end, y, length: n };
}
