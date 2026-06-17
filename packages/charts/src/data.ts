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
  // Runtime-necessary even though it reads as dead code: `column()` returns
  // `undefined` for an unknown name at runtime, but core's public overload
  // currently types the result as non-`undefined` (see F-3 in the M1 friction
  // note). Keep the guard — the "throws on unknown column" test exercises it.
  const col = series.column(column);
  if (col === undefined) {
    throw new RangeError(`fromTimeSeries: unknown column '${column}'`);
  }
  if (col.kind !== 'number') {
    throw new TypeError(
      `fromTimeSeries: column '${column}' must be numeric (got '${col.kind}')`,
    );
  }
  const length = series.length;
  // `begin` is the key buffer, which may carry trailing capacity beyond the
  // logical length; align with a zero-copy subarray so x and y match.
  const x = series.keyColumn().begin.subarray(0, length);
  // Build y via `read(i)` — a method on the column *class* — rather than the
  // bulk `toFloat64Array()`. The bulk reader is mounted on the prototype by a
  // side-effect import in pond-ts, which Vite/Rollup production builds tree-shake
  // away (despite the package's `sideEffects` field), so it throws "not a
  // function" in a bundled browser app. See `docs/notes/charts-m1-friction.md`.
  // `read(i)` returns `undefined` for missing cells → NaN, the gap signal the
  // draw layers break on (`Number.isFinite`); without it a coast would render as
  // a line dropping to zero.
  // TODO(charts-perf): restore the bulk typed-array fast-path once the column-API
  // augmentation is bundle-safe in core — that's the columnar throughput win.
  const y = new Float64Array(length);
  for (let i = 0; i < length; i += 1) {
    const v = col.read(i);
    y[i] = v === undefined ? NaN : v;
  }
  return { x, y, length };
}
