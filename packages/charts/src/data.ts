import { ValueSeries } from 'pond-ts';
import type {
  SeriesSchema,
  TimeSeries,
  ValueSeriesColumnName,
  ValueSeriesSchema,
} from 'pond-ts';

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
 * A chart-ready view of an OHLC series ({@link Candlestick}): the candle's
 * horizontal slot (`x` = left edge, `xEnd` = right edge) plus the four price
 * channels per mark — `open`/`high`/`low`/`close`. The chart derives the body
 * extents (`min`/`max` of open/close) itself at draw time; only the four raw
 * columns are read here.
 *
 * A mark is drawn only where **all four** prices are finite; any one `NaN` is a
 * gap (the candle draws nothing — same gap contract as {@link BoxSeries}).
 *
 * Unlike {@link BoxSeries} (interval-keyed only), the OHLC view supports **both**
 * key shapes, like {@link BarSeries}: an **interval**-keyed series (an
 * `aggregate` rollup — weekly/monthly bars) uses the key's own `[begin, end)` as
 * the slot; a **point**-keyed series (raw daily OHLCV) derives the slot from
 * neighbour spacing (see {@link ohlcFromTimeSeries}), so it feeds straight in
 * with no `aggregate` pass.
 */
export interface OhlcSeries {
  readonly x: Float64Array;
  readonly xEnd: Float64Array;
  readonly open: Float64Array;
  readonly high: Float64Array;
  readonly low: Float64Array;
  readonly close: Float64Array;
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
 * A chart-ready view of a **stacked / histogram** bar series — the multi-segment
 * generalization of {@link BarSeries}. Each of the `length` bins spans
 * `[begin[i], end[i]]` on the **bin axis** (time ms, a value, or a band edge) and
 * carries one value per `group` (a stack segment). `groups` lists the segment
 * identities **bottom → top**; `values` is a flat `length × groups.length` grid
 * in **row-major** order, so bin `b`'s segment `g` is `values[b * groups.length + g]`.
 *
 * A single-series bar (the {@link BarSeries} case) is just `groups.length === 1`.
 * Missing / non-finite segment values are `NaN` — the gap signal a stack skips
 * (no segment, and it contributes nothing to the running total), the same
 * `Number.isFinite` contract as {@link BarSeries}. Segment values are assumed
 * **non-negative** (counts / durations); a negative value is treated as a gap
 * (diverging stacks are out of scope — see the histogram guide).
 *
 * The bin axis is x for a **vertical** histogram (bars grow up) and y for a
 * **horizontal** one (bars grow right); the same grid drives both — the draw
 * layer transposes by orientation, the data does not change.
 */
export interface StackedBarSeries {
  readonly begin: Float64Array;
  readonly end: Float64Array;
  readonly groups: readonly string[];
  readonly values: Float64Array;
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

/**
 * Read a numeric column from a `ValueSeries` into a `Float64Array`, missing
 * cells as `NaN` — the value-axis sibling of {@link readNumericColumn}, sharing
 * its per-element `read(i)` rationale (the bulk reader is tree-shaken away in
 * bundled browser builds).
 *
 * @throws RangeError if `column` does not exist.
 * @throws TypeError if `column` is not a numeric column.
 */
function readValueColumn<VS extends ValueSeriesSchema>(
  series: ValueSeries<VS>,
  column: string,
): Float64Array {
  const col = series.column(column as ValueSeriesColumnName<VS>);
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
    out[i] = v === undefined ? NaN : (v as number);
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

/** The four OHLC column names {@link ohlcFromTimeSeries} reads. */
export interface OhlcColumns {
  /** Opening price column. */
  readonly open: string;
  /** Session high column. */
  readonly high: string;
  /** Session low column. */
  readonly low: string;
  /** Closing price column. */
  readonly close: string;
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
 * Build a {@link ChartSeries} from a pond `ValueSeries` — the value-axis sibling
 * of {@link fromTimeSeries}. The x axis is the series' monotonic value axis
 * (`axisValues()`, e.g. cumulative distance) instead of time; `column` names a
 * numeric value channel (HR, pace, …). The resulting `ChartSeries` is identical
 * in shape — the chart draws it exactly as it draws a time series, only the x
 * scale differs (a value scale rather than `scaleTime`).
 *
 * `x` is the axis key buffer zero-copy (immutable by contract — do not mutate);
 * `y` is the channel materialized to a `Float64Array`, missing cells as `NaN`
 * (the gap signal, same `Number.isFinite` contract as {@link fromTimeSeries}).
 *
 * @throws RangeError if `column` does not exist.
 * @throws TypeError if `column` is not a numeric column.
 */
export function fromValueSeries<VS extends ValueSeriesSchema>(
  series: ValueSeries<VS>,
  column: string,
): ChartSeries {
  // axisValues() is the key buffer already trimmed to length (zero-copy).
  return {
    x: series.axisValues(),
    y: readValueColumn(series, column),
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
 * Build a {@link BandSeries} from a pond `ValueSeries` — the value-axis sibling
 * of {@link bandFromTimeSeries}. The x axis is the series' monotonic value axis
 * (`axisValues()`, e.g. cumulative distance) instead of time; `lower`/`upper`
 * name the two numeric edge columns (typically `rollingByColumn` percentiles).
 * The resulting `BandSeries` is identical in shape — the chart draws it exactly
 * as a time band, only the x scale differs (a value scale rather than
 * `scaleTime`). A sample with either edge missing reads as a gap in the fill
 * (same contract as {@link bandFromTimeSeries}).
 *
 * @throws RangeError if `lower` or `upper` does not exist.
 * @throws TypeError if `lower` or `upper` is not a numeric column.
 */
export function bandFromValueSeries<VS extends ValueSeriesSchema>(
  series: ValueSeries<VS>,
  lower: string,
  upper: string,
): BandSeries {
  return {
    x: series.axisValues(),
    lower: readValueColumn(series, lower),
    upper: readValueColumn(series, upper),
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

/**
 * Build an {@link OhlcSeries} from a pond `TimeSeries` — four numeric price
 * columns (`open`/`high`/`low`/`close`) plus the candle's horizontal slot.
 *
 * **Key-shape aware, like {@link barsFromTimeSeries}.** An **interval /
 * timeRange**-keyed series (an `aggregate` rollup — weekly / monthly bars) uses
 * the key's own `[begin, end)` as the slot. A **point**-keyed (`time`) series —
 * raw daily OHLCV — has `begin === end` (zero width), so the slot is derived from
 * neighbour spacing (each candle centred on its timestamp, reaching halfway to
 * each neighbour; see {@link neighbourSpans}). This is the ergonomic win over the
 * interval-only {@link boxFromTimeSeries}: raw OHLC feeds straight in with no
 * `aggregate` pass.
 *
 * A key with any of the four prices missing reads as a gap (the candle draws
 * nothing). Detected by `keyColumn().kind === 'time'`.
 *
 * @throws RangeError if any price column does not exist.
 * @throws TypeError if any price column is not a numeric column.
 */
export function ohlcFromTimeSeries<S extends SeriesSchema>(
  series: TimeSeries<S>,
  columns: OhlcColumns,
): OhlcSeries {
  const open = readNumericColumn(series, columns.open);
  const high = readNumericColumn(series, columns.high);
  const low = readNumericColumn(series, columns.low);
  const close = readNumericColumn(series, columns.close);
  const n = series.length;
  if (series.keyColumn().kind !== 'time') {
    // Interval / timeRange: the key's own endpoints are the candle slot.
    const { begin, end } = keyBeginEnd(series);
    return { x: begin, xEnd: end, open, high, low, close, length: n };
  }
  // Point key (begin === end): synthesize the slot from neighbour spacing so raw
  // daily OHLCV renders as contiguous candles without a pre-key to intervals.
  const { begin, end } = neighbourSpans(series.keyColumn().begin, n);
  return { x: begin, xEnd: end, open, high, low, close, length: n };
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
 * Synthesize per-point `[begin, end]` spans from a monotonic axis buffer by
 * **neighbour spacing**: each point is centred on its own value and reaches
 * halfway to each neighbour (a Voronoi cell on the axis). The first / last points
 * mirror their single adjacent gap so the end cells match their interior width; a
 * lone point (length 1) keeps zero width (the renderer's `minWidth` floor takes
 * over). Shared by the point-keyed `TimeSeries` bars, the `ValueSeries` bars, and
 * the point-keyed OHLC reader. `axis` is a zero-copy key buffer (must not be
 * mutated) — fresh output buffers are allocated.
 */
function neighbourSpans(
  axis: Float64Array,
  n: number,
): { begin: Float64Array; end: Float64Array } {
  const begin = new Float64Array(n);
  const end = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const x = axis[i]!;
    // Half-gap to the previous neighbour (mirror the next gap at the left edge).
    const prevGap = i > 0 ? x - axis[i - 1]! : i + 1 < n ? axis[i + 1]! - x : 0;
    // Half-gap to the next neighbour (mirror the previous gap at the right edge).
    const nextGap = i + 1 < n ? axis[i + 1]! - x : i > 0 ? x - axis[i - 1]! : 0;
    begin[i] = x - prevGap / 2;
    end[i] = x + nextGap / 2;
  }
  return { begin, end };
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
  // bars have width (see neighbourSpans).
  const { begin, end } = neighbourSpans(series.keyColumn().begin, n);
  return { begin, end, y, length: n };
}

/**
 * Build a {@link BarSeries} from a pond `ValueSeries` — the value-axis sibling
 * of {@link barsFromTimeSeries}. A `ValueSeries` is **point-keyed** on its value
 * axis (one axis value per row, no per-row span), so — exactly like the
 * point-keyed `time` case of {@link barsFromTimeSeries} — each bar is centred on
 * its axis value and synthesises a span from **neighbour spacing**: it reaches
 * halfway to each neighbour (a Voronoi cell on the value axis). The first / last
 * bars mirror their single adjacent gap; a lone point (length 1) keeps zero
 * width and falls back to the renderer's `minWidth`.
 *
 * For evenly-spaced contiguous keys (e.g. uniform splits centred on their
 * midpoints) the cell boundaries land exactly on the segment boundaries; for
 * unevenly-spaced keys a boundary sits at the midpoint between adjacent centres
 * (a slight drift from a true segment edge — fine for the bar look; key an
 * interval/timeRange `TimeSeries` instead if exact edges matter).
 *
 * @throws RangeError if `column` does not exist.
 * @throws TypeError if `column` is not a numeric column.
 */
export function barsFromValueSeries<VS extends ValueSeriesSchema>(
  series: ValueSeries<VS>,
  column: string,
): BarSeries {
  const y = readValueColumn(series, column);
  const n = series.length;
  // axisValues() is the monotonic key buffer (zero-copy); neighbourSpans reads it
  // and allocates fresh span buffers (never mutates the source).
  const { begin, end } = neighbourSpans(series.axisValues(), n);
  return { begin, end, y, length: n };
}

/**
 * The per-bin `[begin, end]` slots for a `TimeSeries`, key-shape aware — the same
 * rule {@link barsFromTimeSeries} applies: an interval / timeRange key uses its
 * own endpoints; a point (`time`) key synthesizes a span from neighbour spacing
 * (see {@link neighbourSpans}). Shared by the stacked readers so a stack draws
 * true bucket spans over an `aggregate` rollup and contiguous bars over a raw
 * point series.
 */
function seriesSlots<S extends SeriesSchema>(
  series: TimeSeries<S>,
): { begin: Float64Array; end: Float64Array } {
  const n = series.length;
  if (series.keyColumn().kind !== 'time') {
    return keyBeginEnd(series);
  }
  return neighbourSpans(series.keyColumn().begin, n);
}

/**
 * Build a {@link StackedBarSeries} from a **`Map` of grouped series** — one series
 * per stack group. This is the natural reader for pond's grouped-aggregate output:
 * `series.partitionBy('host', { groups }).aggregate(Sequence.every('5m'), { n: 'count' }).toMap()`
 * yields a `Map<host, TimeSeries>`, one interval-keyed series per host. The stack
 * order (`groups`, bottom → top) is the map's **insertion order** (stable when you
 * pass `partitionBy`'s `{ groups }` option).
 *
 * **Aligned by bucket key, not by index.** Each partition's `aggregate` spans only
 * *its own* events' range, so the groups generally have **different** grids (host A
 * might have buckets 0–8, host B buckets 3–9). This reader takes the **union** of
 * every group's `[begin, end)` slots (ascending) and places each group's `column`
 * value at the matching `begin`; a bucket a group is missing reads as a gap
 * (`NaN`, contributing nothing to that stack). So the segments always line up on
 * the real bucket, never on a positional accident. (Pass `aggregate`'s
 * `{ range }` option if you want every group padded to one dense grid — the union
 * is then that grid.) When two groups carry the **same `begin`**, the first
 * group's `end` sets that slot's width — correct for the uniform-width buckets
 * `aggregate` / `pivotByGroup` produce (all groups share the grid width), which is
 * the intended input.
 *
 * @throws Error if `groups` is empty.
 * @throws RangeError / TypeError (via {@link readNumericColumn}) if `column` is
 *   missing or non-numeric in any member.
 */
export function stacksFromGroups<S extends SeriesSchema>(
  groups: ReadonlyMap<string, TimeSeries<S>>,
  column: string,
): StackedBarSeries {
  const names = [...groups.keys()];
  if (names.length === 0) {
    throw new Error('stacksFromGroups: `groups` map is empty');
  }
  const series = [...groups.values()];
  const G = names.length;
  // Union of all groups' slots, keyed by begin (each begin → its end).
  const ends = new Map<number, number>();
  const perGroupSlots = series.map((s) => seriesSlots(s));
  for (let g = 0; g < G; g += 1) {
    const { begin, end } = perGroupSlots[g]!;
    for (let i = 0; i < series[g]!.length; i += 1) {
      if (!ends.has(begin[i]!)) ends.set(begin[i]!, end[i]!);
    }
  }
  const begins = [...ends.keys()].sort((a, b) => a - b);
  const n = begins.length;
  const beginArr = new Float64Array(n);
  const endArr = new Float64Array(n);
  const slotOf = new Map<number, number>();
  for (let i = 0; i < n; i += 1) {
    beginArr[i] = begins[i]!;
    endArr[i] = ends.get(begins[i]!)!;
    slotOf.set(begins[i]!, i);
  }
  const values = new Float64Array(n * G);
  values.fill(NaN);
  for (let g = 0; g < G; g += 1) {
    const { begin } = perGroupSlots[g]!;
    const col = readNumericColumn(series[g]!, column);
    for (let i = 0; i < series[g]!.length; i += 1) {
      const slot = slotOf.get(begin[i]!);
      if (slot !== undefined) values[slot * G + g] = col[i]!;
    }
  }
  return { begin: beginArr, end: endArr, groups: names, values, length: n };
}

/**
 * Build a {@link StackedBarSeries} from a **wide** series — one numeric column
 * per stack group. This is the reader for pond's `pivotByGroup` output (long →
 * wide reshape: each group value becomes its own column), or any series that is
 * already wide (e.g. `in` / `out` traffic). `columns` names the segment columns
 * **bottom → top**; a `ValueSeries` bins on its value axis (neighbour-spaced
 * slots), a `TimeSeries` on its key (interval spans or neighbour-spaced points).
 *
 * @throws RangeError / TypeError if any column is missing or non-numeric.
 */
export function stacksFromColumns<
  S extends SeriesSchema,
  VS extends ValueSeriesSchema,
>(
  series: TimeSeries<S> | ValueSeries<VS>,
  columns: readonly string[],
): StackedBarSeries {
  const n = series.length;
  const G = columns.length;
  const isValue = series instanceof ValueSeries;
  const { begin, end } = isValue
    ? neighbourSpans((series as ValueSeries<VS>).axisValues(), n)
    : seriesSlots(series as TimeSeries<S>);
  const values = new Float64Array(n * G);
  for (let g = 0; g < G; g += 1) {
    const col = isValue
      ? readValueColumn(series as ValueSeries<VS>, columns[g]!)
      : readNumericColumn(series as TimeSeries<S>, columns[g]!);
    for (let i = 0; i < n; i += 1) {
      values[i * G + g] = col[i]!;
    }
  }
  return { begin, end, groups: columns, values, length: n };
}

/**
 * A single bin record from `byColumn` — its `[start, end)` range plus the mapped
 * aggregate columns (read by name via {@link stacksFromBins}). Deliberately just
 * the `start`/`end` shape (no index signature) so pond's
 * `byColumn(...): Array<{ start, end } & ReduceResult>` assigns to it structurally
 * — the aggregate fields ride along and are read out by the reader.
 */
export type BinRecord = { readonly start: number; readonly end: number };

/** Options for {@link stacksFromBins}. */
export interface StacksFromBinsOptions {
  /**
   * Use uniform **unit slots** (`[i, i+1]`) for the bins instead of their numeric
   * `[start, end]` edges — an **ordinal** band axis (heart-rate zones, Coggan
   * power zones) where every band reads the same width regardless of its numeric
   * span. The caller labels the slots via `<YAxis ticks>` at `i + 0.5`. Omitted /
   * `false` ⇒ real numeric edges (a true value axis — power W, risk %).
   */
  readonly ordinal?: boolean;
}

/**
 * Build a {@link StackedBarSeries} from **`byColumn` bin records** — the array of
 * `{ start, end, …aggregates }` a value-band aggregation returns
 * (`series.byColumn('power', { width: 20 }, { seconds: { from: 'dt', using: 'sum' } })`).
 * `columns` names the aggregate field(s) to draw as segments (`['seconds']` for a
 * plain distribution; several for a stacked value-band histogram).
 *
 * By default each bin keeps its real numeric `[start, end]` edges — a true value
 * axis (power W, risk %). Pass `{ ordinal: true }` for uniform unit slots
 * (`[i, i+1]`) when the bins are **categories** whose numeric width shouldn't
 * distort the layout (heart-rate zones); label them with `<YAxis ticks>`.
 *
 * A missing / non-finite aggregate reads as a gap (`NaN`).
 */
export function stacksFromBins(
  bins: readonly BinRecord[],
  columns: readonly string[],
  options: StacksFromBinsOptions = {},
): StackedBarSeries {
  const n = bins.length;
  const G = columns.length;
  const begin = new Float64Array(n);
  const end = new Float64Array(n);
  const values = new Float64Array(n * G);
  for (let i = 0; i < n; i += 1) {
    const bin = bins[i]!;
    if (options.ordinal) {
      begin[i] = i;
      end[i] = i + 1;
    } else {
      begin[i] = bin.start;
      end[i] = bin.end;
    }
    const fields = bin as unknown as Record<string, unknown>;
    for (let g = 0; g < G; g += 1) {
      const v = fields[columns[g]!];
      values[i * G + g] = typeof v === 'number' && Number.isFinite(v) ? v : NaN;
    }
  }
  return { begin, end, groups: columns, values, length: n };
}

/**
 * One category's `{ label, value }` for a categorical bar chart — the row-read /
 * transpose view's `(columnName, cell)` pair (categorical-axis RFC, Phase 1). An
 * ordered list of these is the explicit categorical data source; Phase 2's
 * transpose reader produces the same list from a wide series' row.
 */
export interface CategoryDatum {
  readonly label: string;
  readonly value: number;
}

/**
 * Build a {@link StackedBarSeries} (single group, `G === 1`) from an ordered list
 * of `{ label, value }` categories — one **unit slot** `[i, i+1]` per category, in
 * order. This is the categorical row-read's geometry: the slots are ordinal
 * indices (the bar's pixel span comes from the container's {@link ScaleBand}), and
 * the `label`s become the axis's ordered category names (`xCategories`). A
 * non-finite value reads as a gap (`NaN`). Reuses the shipped stacked geometry —
 * no new draw path.
 */
export function categoryStack(
  records: readonly CategoryDatum[],
): StackedBarSeries {
  const n = records.length;
  const begin = new Float64Array(n);
  const end = new Float64Array(n);
  const values = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    begin[i] = i;
    end[i] = i + 1;
    const v = records[i]!.value;
    values[i] = Number.isFinite(v) ? v : NaN;
  }
  return { begin, end, groups: ['value'], values, length: n };
}
