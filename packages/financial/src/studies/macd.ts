import type {
  NumericColumnNameForSchema,
  SeriesSchema,
  TimeSeries,
} from 'pond-ts';
import { DEFAULT_SOURCE } from '../contract/columns.js';
import { assertNoColumn, assertPeriod, emaValues } from '../kernels/rolling.js';

export interface MacdOptions<S extends SeriesSchema, Prefix extends string> {
  /** Fast EMA span in **bars**. **Default `12`.** */
  fastPeriod?: number;
  /** Slow EMA span in **bars**. **Default `26`.** */
  slowPeriod?: number;
  /** Signal EMA span in **bars**, taken over the MACD line. **Default `9`.** */
  signalPeriod?: number;
  /** Source column. **Default `'close'`.** */
  column?: NumericColumnNameForSchema<S>;
  /** Column-family prefix — appends `${prefix}Line` / `${prefix}Signal` /
   *  `${prefix}Hist`. **Default `'macd'`.** */
  prefix?: Prefix;
}

/** Scratch column the signal EMA is taken over. Never returned. */
const MACD_SCRATCH = '__macdLine__';

/**
 * **MACD** (Moving Average Convergence/Divergence, Gerald Appel) — the spread
 * between a fast and a slow EMA, with its own EMA as a signal line:
 *
 * - `${prefix}Line` = `EMA(fastPeriod) − EMA(slowPeriod)`
 * - `${prefix}Signal` = `EMA(signalPeriod)` of that line
 * - `${prefix}Hist` = line − signal
 *
 * Appends three columns. Each warms up when it can rather than all three
 * waiting for the slowest: at the defaults the line starts at bar 25 (the slow
 * EMA's own warm-up) and the signal and histogram at bar 33. **TA-Lib instead
 * masks all three to bar 33**; emitting the line where it is genuinely defined
 * keeps eight real values TA-Lib discards, and matches how every other study
 * here warms up per column.
 *
 * ## Which EMA
 *
 * The EMAs are pond's own — {@link emaValues}, i.e. `α = 2/(span+1)` seeded on
 * the **first sample**, which is what `ema()` already ships and what the
 * oracle already pins. TA-Lib instead seeds each EMA on the SMA of its first
 * `n` values, so its MACD differs slightly from this one.
 *
 * That delta is small and shrinking, unlike RSI's: measured on the package's
 * oracle input, **0.142 at worst on a line whose magnitude reaches 3.74**
 * (≈3.8%), falling to **0.0033 (0.19%) by bar 79**. It is small because MACD
 * is a *difference* of two EMAs, so the seed error largely cancels, and
 * because it decays at `(1−α)^k` with `α = 2/13` and `2/27` — far faster than
 * RSI's `1/14`.
 *
 * The alternative would be to seed these EMAs TA-Lib's way. That was rejected:
 * it would make `macd()` disagree with `ema(fast) − ema(slow)` *inside this
 * package*, which is a worse and more confusing surprise than a sub-percent
 * divergence from a vendor whose bar-for-bar parity is an explicit non-goal.
 * Making pond's MACD TA-Lib-identical means changing `ema()`'s seed
 * convention everywhere — a breaking, package-wide decision, not something to
 * smuggle in under a new study. Contrast {@link rsi}, where the same choice
 * was worth a dedicated kernel because the error there was 7 points on a
 * bounded 0–100 oscillator and crossed its conventional thresholds.
 */
export function macd<
  S extends SeriesSchema,
  const Prefix extends string = 'macd',
>(series: TimeSeries<S>, options: MacdOptions<S, Prefix> = {}) {
  const fastPeriod = options.fastPeriod ?? 12;
  const slowPeriod = options.slowPeriod ?? 26;
  const signalPeriod = options.signalPeriod ?? 9;
  assertPeriod(fastPeriod, 'fastPeriod');
  assertPeriod(slowPeriod, 'slowPeriod');
  assertPeriod(signalPeriod, 'signalPeriod');
  if (fastPeriod >= slowPeriod) {
    throw new TypeError(
      `macd fastPeriod (${fastPeriod}) must be shorter than slowPeriod (${slowPeriod})`,
    );
  }

  const column = (options.column ?? DEFAULT_SOURCE) as string;
  const prefix = (options.prefix ?? 'macd') as Prefix;
  const lineName = `${prefix}Line` as const;
  const signalName = `${prefix}Signal` as const;
  const histName = `${prefix}Hist` as const;

  const wide = series as unknown as TimeSeries<SeriesSchema>;
  for (const name of [lineName, signalName, histName, MACD_SCRATCH]) {
    // MACD_SCRATCH is checked too: a caller who already has a column by that
    // name would otherwise hit a confusing failure from inside the signal
    // EMA rather than a clear one naming the collision.
    assertNoColumn(wide, name);
  }

  const fast = emaValues(wide, column, fastPeriod);
  const slow = emaValues(wide, column, slowPeriod);
  const length = fast.length;

  // Missing cells are NaN and propagate through the subtraction on their own
  // ([PND-STUDYBOX]), so the line is NaN wherever either EMA is still warming.
  const line = new Float64Array(length);
  for (let i = 0; i < length; i += 1) line[i] = fast[i]! - slow[i]!;

  // The signal is an EMA *of the line*, so it goes back through the same
  // kernel rather than a hand-rolled recursion — that is what guarantees
  // `macdSignal` is the same EMA `ema()` would give over the same values.
  // `emaValues` shifts its warm-up past a leading gap, so the signal starts
  // `signalPeriod - 1` bars after the line does, with no arithmetic here.
  //
  // The round trip through a scratch column is bought deliberately: it is
  // what makes `macdSignal` *the same* EMA `ema()` produces, rather than a
  // second implementation that could drift from it. At 1M bars the whole
  // study is ~103 ms against ~33 ms for its three EMAs alone, so the column
  // plumbing is most of the cost — a kernel taking a raw array would reclaim
  // it, at the price of a second EMA recursion to keep in step. Not worth it
  // until someone measures it as a problem.
  const scratch = wide.withColumn(
    MACD_SCRATCH as never,
    line,
  ) as unknown as TimeSeries<SeriesSchema>;
  const signal = emaValues(scratch, MACD_SCRATCH, signalPeriod);

  const hist = new Float64Array(length);
  for (let i = 0; i < length; i += 1) hist[i] = line[i]! - signal[i]!;

  return series
    .withColumn(lineName, line)
    .withColumn(signalName, signal)
    .withColumn(histName, hist);
}
