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
/**
 * An optional accelerator for {@link rollingColumns} — [PND-SCANKERN].
 *
 * A rolling window is not a recurrence: output cell `i` reads only rows
 * `[i-period+1, i]`, so the output can be cut into ranges and computed
 * in parallel. That needs worker threads, which are Node-only and would
 * make this package non-portable if imported here — so the parallel
 * implementation lives behind `@pond-ts/financial/parallel` and installs
 * itself through this hook.
 *
 * Returning `null` means "not accelerating this call" — a series the
 * caller never opted in, a reducer the accelerator does not implement,
 * an input too small to be worth partitioning. The sequential path then
 * runs exactly as it always has. **Nothing changes unless a caller opts
 * in**, which is the whole point of the hook rather than a flag.
 */
export type RollingAccelerator = (
  series: TimeSeries<SeriesSchema>,
  specs: Record<string, { from: string; using: RollingReducer }>,
  period: number,
) => Record<string, Float64Array> | null;

let accelerator: RollingAccelerator | undefined;

/**
 * Installs (or clears, with `undefined`) the rolling accelerator.
 *
 * @internal Called by `@pond-ts/financial/parallel`. Not part of the
 * package's public surface — a caller opts in with `withWorkers`.
 */
export function setRollingAccelerator(
  next: RollingAccelerator | undefined,
): void {
  accelerator = next;
}

export function rollingColumns(
  series: TimeSeries<SeriesSchema>,
  specs: Record<string, { from: string; using: RollingReducer }>,
  period: number,
): Record<string, Float64Array> {
  // Opted-in callers only; `null` means run sequentially, as always.
  if (accelerator !== undefined) {
    const accelerated = accelerator(series, specs, period);
    if (accelerated !== null) return accelerated;
  }
  const rolled = series.rolling(
    { count: period },
    specs as AggregateOutputMap<SeriesSchema>,
    { minSamples: period },
  );
  const out: Record<string, Float64Array> = {};
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
): Float64Array {
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
): Float64Array {
  return readNumericColumn(series, column);
}

/**
 * Row-aligned read of one numeric column into a `Float64Array`, with
 * **`NaN` marking a missing cell** — [PND-STUDYBOX].
 *
 * This used to build an `Array<number | undefined>` by walking the column
 * with the polymorphic `col.at(i)`: `n` megamorphic reads and `n` boxed
 * slots, per study, per source column. Measured at 8.28 ms of `sma(20)`'s
 * 22 ms on 500k bars, against 0.40 ms for the same read into a typed
 * buffer.
 *
 * `NaN` as the gap marker is what makes the rest of the package
 * simplify: it **propagates through arithmetic for free**, so a study's
 * derivation (`m + sign * k * d`, `(v - m) / s`) no longer needs a
 * per-cell `undefined` check on every input — only the genuinely
 * study-specific guards survive, like "a zero standard deviation has no
 * band". `TimeSeries.withColumn` accepts the same convention on its
 * typed door ([PND-WCNAN]), so the result goes back without boxing.
 *
 * A column that doesn't exist, or a non-numeric one, reads as all-`NaN` —
 * the same all-missing answer the boxed version produced.
 *
 * The buffer is a fresh copy: `toFloat64Array()` can hand back the
 * column's own storage, and callers here derive in place.
 */
function readNumericColumn(
  series: TimeSeries<SeriesSchema>,
  column: string,
): Float64Array {
  const length = series.length;
  const out = new Float64Array(length);
  const col = series.column(
    column as Parameters<TimeSeries<SeriesSchema>['column']>[0],
  ) as
    | {
        kind?: string;
        storage?: string;
        validity?: { bits: Uint8Array };
        toFloat64Array?: () => Float64Array;
        at(i: number): unknown;
      }
    | undefined;

  if (col === undefined || col.kind !== 'number') {
    out.fill(NaN);
    return out;
  }

  if (col.storage === 'packed' && col.toFloat64Array !== undefined) {
    out.set(col.toFloat64Array());
    const bits = col.validity?.bits;
    if (bits !== undefined) {
      // Gap slots hold an arbitrary buffer value (typically 0); punch the
      // marker in so downstream arithmetic propagates it.
      for (let i = 0; i < length; i += 1) {
        if ((bits[i >> 3]! & (1 << (i & 7))) === 0) out[i] = NaN;
      }
    }
    return out;
  }

  // Chunked or otherwise non-packed: fall back to the polymorphic read.
  for (let i = 0; i < length; i += 1) {
    const v = col.at(i);
    out[i] = typeof v === 'number' ? v : NaN;
  }
  return out;
}

/** Row-aligned `period`-span EMA values over `column` (`α = 2/(period+1)`),
 *  length-preserving warm-up — the moving-average alternative for a study whose
 *  centre line can be an EMA (e.g. an EMA envelope). Composes on `smooth`. */
export function emaValues(
  series: TimeSeries<SeriesSchema>,
  column: string,
  period: number,
): Float64Array {
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
