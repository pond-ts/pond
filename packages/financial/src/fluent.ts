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
  }
}

// Runtime mount. Each method delegates to the standalone study bound to `this`;
// the declared signatures above carry the precise per-study return types.
const proto = TimeSeries.prototype as unknown as {
  sma: unknown;
  ema: unknown;
  bollinger: unknown;
};
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
