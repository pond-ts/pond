/**
 * **Opt-in fluent studies.** Importing this module for its side effect mounts
 * the studies as chainable methods on `TimeSeries`, so composition reads like
 * the core operators it sits beside:
 *
 * ```ts
 * import '@pond-ts/financial/fluent';
 *
 * const study = bars
 *   .sma({ period: 20 })
 *   .ema({ period: 12 })
 *   .bollinger({ period: 20, stdDev: 2 });
 * ```
 *
 * It is **opt-in by import** — the default entry (`import { sma } from
 * '@pond-ts/financial'`) leaves `TimeSeries` untouched, so a non-financial
 * project never sees `.sma()` on its series. The methods are exactly the
 * standalone {@link sma}/{@link ema}/{@link bollinger} functions bound to
 * `this`; this file adds no new behaviour, only the calling style. (Same
 * prototype-augmentation pattern core uses to mount the column methods.)
 *
 * **Caveats (prototype augmentation):**
 * - Import it for its **runtime** side effect, not only its types. The
 *   `declare module` merge is compilation-global (once any file imports this,
 *   `.sma()` type-checks everywhere), but the methods only exist at runtime in a
 *   program that actually loaded this module — so `import '@pond-ts/financial/fluent'`
 *   in your entry, not just where the types are handy.
 * - **ESM only.** The `./fluent` subpath ships no CJS build; `require()` can't
 *   opt in. Use the standalone functions from a CJS context.
 * - If core ever adds a `TimeSeries` method named `sma`/`ema`/`bollinger`, this
 *   would shadow it — a deliberate, reviewable collision, not a silent surprise.
 */
import { TimeSeries } from 'pond-ts';
import type {
  OptionalNumberColumn,
  SeriesSchema,
  SmoothAppendSchema,
  ValueColumnsForSchema,
} from 'pond-ts';
import { sma as smaStudy, ema as emaStudy } from './studies/moving-average.js';
import type { MovingAverageOptions } from './studies/moving-average.js';
import { bollinger as bollingerStudy } from './studies/bollinger.js';
import type { BollingerOptions } from './studies/bollinger.js';
import {
  rollingStdev as rollingStdevStudy,
  rollingMin as rollingMinStudy,
  rollingMax as rollingMaxStudy,
  rollingPercentile as rollingPercentileStudy,
} from './studies/rolling-stat.js';
import type {
  RollingStatOptions,
  RollingPercentileOptions,
} from './studies/rolling-stat.js';
import { zScore as zScoreStudy } from './studies/z-score.js';
import type { ZScoreOptions } from './studies/z-score.js';
import { envelope as envelopeStudy } from './studies/envelope.js';
import type { EnvelopeOptions } from './studies/envelope.js';
import { percentChange as percentChangeStudy } from './studies/percent-change.js';
import type { PercentChangeOptions } from './studies/percent-change.js';

/** A series schema with one optional number column appended — the shape
 *  `TimeSeries.withColumn` (and hence `sma`) yields. */
type AppendOpt<S extends SeriesSchema, Name extends string> = readonly [
  S[0],
  ...ValueColumnsForSchema<S>,
  OptionalNumberColumn<Name>,
];

declare module 'pond-ts' {
  interface TimeSeries<S extends SeriesSchema> {
    /** Fluent {@link sma} — requires `import '@pond-ts/financial/fluent'`. */
    sma<const Output extends string = 'sma'>(
      options: MovingAverageOptions<S, Output>,
    ): TimeSeries<AppendOpt<S, Output>>;
    /** Fluent {@link ema} — requires `import '@pond-ts/financial/fluent'`. */
    ema<const Output extends string = 'ema'>(
      options: MovingAverageOptions<S, Output>,
    ): TimeSeries<SmoothAppendSchema<S, Output>>;
    /** Fluent {@link bollinger} — requires `import '@pond-ts/financial/fluent'`. */
    bollinger<const Prefix extends string = 'bb'>(
      options: BollingerOptions<S, Prefix>,
    ): TimeSeries<
      AppendOpt<
        AppendOpt<AppendOpt<S, `${Prefix}Middle`>, `${Prefix}Upper`>,
        `${Prefix}Lower`
      >
    >;
    /** Fluent rolling standard deviation. */
    rollingStdev<const Output extends string = 'stdev'>(
      options: RollingStatOptions<S, Output>,
    ): TimeSeries<AppendOpt<S, Output>>;
    /** Fluent rolling minimum. */
    rollingMin<const Output extends string = 'min'>(
      options: RollingStatOptions<S, Output>,
    ): TimeSeries<AppendOpt<S, Output>>;
    /** Fluent rolling maximum. */
    rollingMax<const Output extends string = 'max'>(
      options: RollingStatOptions<S, Output>,
    ): TimeSeries<AppendOpt<S, Output>>;
    /** Fluent rolling percentile. */
    rollingPercentile<const Output extends string = string>(
      options: RollingPercentileOptions<S, Output>,
    ): TimeSeries<AppendOpt<S, Output>>;
    /** Fluent rolling z-score. */
    zScore<const Output extends string = 'zscore'>(
      options: ZScoreOptions<S, Output>,
    ): TimeSeries<AppendOpt<S, Output>>;
    /** Fluent moving-average envelope. */
    envelope<const Prefix extends string = 'env'>(
      options: EnvelopeOptions<S, Prefix>,
    ): TimeSeries<
      AppendOpt<
        AppendOpt<AppendOpt<S, `${Prefix}Middle`>, `${Prefix}Upper`>,
        `${Prefix}Lower`
      >
    >;
    /** Fluent percent change (rate of change). */
    percentChange<const Output extends string = 'pctChange'>(
      options?: PercentChangeOptions<S, Output>,
    ): TimeSeries<AppendOpt<S, Output>>;
  }
}

// Runtime mount. Each method delegates to the standalone study bound to `this`;
// the declared signatures above carry the precise per-study return types.
const proto = TimeSeries.prototype as unknown as Record<string, unknown>;
proto.sma = function (
  this: TimeSeries<SeriesSchema>,
  options: MovingAverageOptions<SeriesSchema, string>,
) {
  return smaStudy(this, options);
};
proto.ema = function (
  this: TimeSeries<SeriesSchema>,
  options: MovingAverageOptions<SeriesSchema, string>,
) {
  return emaStudy(this, options);
};
proto.bollinger = function (
  this: TimeSeries<SeriesSchema>,
  options: BollingerOptions<SeriesSchema, string>,
) {
  return bollingerStudy(this, options);
};
proto.rollingStdev = function (
  this: TimeSeries<SeriesSchema>,
  options: RollingStatOptions<SeriesSchema, string>,
) {
  return rollingStdevStudy(this, options);
};
proto.rollingMin = function (
  this: TimeSeries<SeriesSchema>,
  options: RollingStatOptions<SeriesSchema, string>,
) {
  return rollingMinStudy(this, options);
};
proto.rollingMax = function (
  this: TimeSeries<SeriesSchema>,
  options: RollingStatOptions<SeriesSchema, string>,
) {
  return rollingMaxStudy(this, options);
};
proto.rollingPercentile = function (
  this: TimeSeries<SeriesSchema>,
  options: RollingPercentileOptions<SeriesSchema, string>,
) {
  return rollingPercentileStudy(this, options);
};
proto.zScore = function (
  this: TimeSeries<SeriesSchema>,
  options: ZScoreOptions<SeriesSchema, string>,
) {
  return zScoreStudy(this, options);
};
proto.envelope = function (
  this: TimeSeries<SeriesSchema>,
  options: EnvelopeOptions<SeriesSchema, string>,
) {
  return envelopeStudy(this, options);
};
proto.percentChange = function (
  this: TimeSeries<SeriesSchema>,
  options?: PercentChangeOptions<SeriesSchema, string>,
) {
  return percentChangeStudy(this, options);
};
