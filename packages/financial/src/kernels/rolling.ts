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

/**
 * Row-aligned **deviation from the rolling mean**, with the rolling
 * standard deviation — [PND-SHIFTFRAME].
 *
 * ## Why this exists rather than `v − rollingColumns(...).mean`
 *
 * That is the obvious composition and it is numerically wrong on data
 * that is perfectly legal. `mean` comes back as a `double`, so at a
 * magnitude of 1e15 it can only be represented to `ulp(1e15) = 0.125`.
 * A window whose values span ±3 covers about **48 ulps**, so computing
 * `v − mean` leaves roughly **three bits** of information — the answer
 * is dominated by how the mean happened to round.
 *
 * Measured: a partitioned and a sequential sweep of the same data, whose
 * means differ by a single ulp, produce z-scores **38% apart**. The
 * divergence was first read as a parallelism problem; it is not. Both
 * sweeps are equally exposed, and so is any consumer that subtracts a
 * stored mean from a value of similar magnitude.
 *
 * ## The fix
 *
 * Accumulate `v − anchor` rather than `v`, so the mean is carried as
 * `anchor + offset` with `offset` small, and emit the deviation as
 * `(v − anchor) − offset` — both operands small, so nothing cancels.
 * The state is rebuilt from the window every `period` rows — **one full
 * window turnover** — which is the only interval that is scale-free. It
 * does two jobs at once. The anchor never goes more than one turnover
 * stale, so `x - anchor` stays small even while the series trends. And
 * no incremental add or remove survives longer than the window it
 * describes, which bounds the drift that the reverse-Welford removal
 * accumulates.
 *
 * A fixed interval fails at both ends, and a Codex pass found both.
 * Too long for a short window: at `period 2` a 1024-row interval left the
 * removal recurrence drifting through ~500 turnovers, and `|z| - 1` — which
 * is exactly 0 for any non-flat 2-row window — reached **1.7e-6**. Too
 * short for a long one: the `O(period)` rebuild fired every 1024 rows
 * regardless of `period`, making the kernel `O(N + N·period/1024)`, which
 * at `period 100k` over 200k rows was **81 ms** against 7 ms at `period 20`.
 * Tying the interval to `period` makes the rebuild exactly one extra
 * accumulation per row at every scale.
 *
 * σ is carried the same way. "Variance is translation-invariant, so
 * Welford is already stable" is the intuition, and it is wrong: Welford's
 * `x - wMean` is the same subtraction of two near-equal large numbers,
 * and it cancels just as badly. Welford is stable relative to the
 * *conditioning* of the problem; raw large-magnitude values are what make
 * the problem ill-conditioned. So the variance accumulator sees `x -
 * anchor` too.
 *
 * Measured over 200k rows against an exact reference:
 *
 * | input | `v − mean` | this |
 * | --- | --- | --- |
 * | `1e15 + ((i % 7) − 3)` | 6.5e+0 | **8.8e-15** |
 * | random walk ≈100 | 8.5e-9 | **2.0e-10** |
 *
 * It removes the pathological case and is ~40× better on benign data
 * too, because the cancellation is a matter of degree everywhere rather
 * than a cliff at one magnitude.
 */
export function rollingDeviationSd(
  series: TimeSeries<SeriesSchema>,
  column: string,
  period: number,
): { deviation: Float64Array; sd: Float64Array } {
  const v = readNumericColumn(series, column);
  const n = v.length;
  const deviation = new Float64Array(n).fill(NaN);
  const sd = new Float64Array(n).fill(NaN);

  // Every accumulator below lives in the SHIFTED frame — it sees
  // `x - anchor`, never `x`. Both the mean and the variance are carried
  // that way, because Welford cancels at 1e15 exactly as badly as a
  // naive difference does: its `x - wMean` is the same subtraction of
  // two near-equal large numbers. Welford is stable relative to the
  // conditioning of the problem, and raw large-magnitude values make the
  // problem ill-conditioned. Shifting fixes the conditioning; Welford
  // then does its job.
  let anchor = 0;
  let shiftedSum = 0;
  let count = 0;
  let wN = 0;
  let wMean = 0;
  let wM2 = 0;
  let windowStart = 0;
  let windowEnd = 0;
  let sinceAnchor = period;

  for (let i = 0; i < n; i += 1) {
    const lo = i - period + 1 > 0 ? i - period + 1 : 0;
    while (windowEnd <= i) {
      const x = v[windowEnd]!;
      if (Number.isFinite(x)) {
        const y = x - anchor;
        shiftedSum += y;
        count += 1;
        wN += 1;
        const d = y - wMean;
        wMean += d / wN;
        wM2 += d * (y - wMean);
      }
      windowEnd += 1;
    }
    while (windowStart < lo) {
      const x = v[windowStart]!;
      if (Number.isFinite(x)) {
        const y = x - anchor;
        shiftedSum -= y;
        count -= 1;
        if (wN <= 1) {
          wN = 0;
          wMean = 0;
          wM2 = 0;
        } else {
          const meanWith = wMean;
          wN -= 1;
          if (wN === 1) {
            wMean = meanWith * 2 - y;
            wM2 = 0;
          } else {
            wMean = meanWith - (y - meanWith) / wN;
            wM2 -= (y - wMean) * (y - meanWith);
            if (wM2 < 0) wM2 = 0;
          }
        }
      }
      windowStart += 1;
    }

    // Rebuild the whole state from the window rather than translating the
    // anchor across it. Same `O(period)` pass either way, and a rebuild
    // also discards every rounding error the incremental adds and removes
    // have accumulated — which is the half of this that matters for short
    // windows, where the reverse-Welford removal is the weak step.
    //
    // `period` ops per `period` rows: one extra accumulation per row, at
    // any `period`. An earlier version rebuilt on a fixed 1024-row
    // interval plus a magnitude test, and was wrong in both directions at
    // once — see the note above. The magnitude test is gone with it: it
    // had to be rate-limited to `period` rows to stay `O(N)`, which is the
    // cadence this rebuilds at anyway, so it could never fire sooner than
    // the unconditional rebuild already does.
    sinceAnchor += 1;
    const x = v[i]!;
    if (Number.isFinite(x) && sinceAnchor >= period) {
      anchor = x;
      sinceAnchor = 0;
      shiftedSum = 0;
      count = 0;
      wN = 0;
      wMean = 0;
      wM2 = 0;
      for (let k = windowStart; k < windowEnd; k += 1) {
        const w = v[k]!;
        if (!Number.isFinite(w)) continue;
        const y = w - anchor;
        shiftedSum += y;
        count += 1;
        wN += 1;
        const d = y - wMean;
        wMean += d / wN;
        wM2 += d * (y - wMean);
      }
    }

    if (windowEnd - windowStart < period || count === 0 || wN === 0) continue;
    deviation[i] = x - anchor - shiftedSum / count;
    sd[i] = Math.sqrt(wM2 / wN > 0 ? wM2 / wN : 0);
  }
  return { deviation, sd };
}
