/**
 * `@pond-ts/financial/parallel` — partitioned rolling studies
 * ([PND-SCANKERN]).
 *
 * A separate entry point because it is **Node-only**: it needs worker
 * threads, and `Atomics.wait` on the main thread — which browsers forbid
 * — is what lets the studies stay synchronous while workers do the work.
 * The main package never imports this and stays portable.
 *
 * ```ts
 * import '@pond-ts/financial/fluent';
 * import '@pond-ts/financial/parallel';
 *
 * const study = TimeSeries.fromArrow(tableFromIPC(bytes), { time: 'ts' })
 *   .withWorkers({ workers: 8 })
 *   .sma({ period: 20 })
 *   .bollinger({ period: 20 })
 *   .zScore({ period: 20 });
 * ```
 *
 * Importing this module **mounts `.withWorkers()` on `TimeSeries`**, the
 * same opt-in-by-import prototype augmentation `/fluent` uses for the
 * studies. The free function is exported too, for callers who would
 * rather not augment a prototype.
 *
 * See {@link withWorkers} for what it costs in accuracy — which differs
 * per study, and is the reason this is a documented choice rather than a
 * default.
 */

import { TimeSeries } from 'pond-ts';
import type { SeriesSchema } from 'pond-ts';
import { withWorkers as withWorkersFn } from './pool.js';
import type { WithWorkersOptions } from './pool.js';

export {
  withWorkers,
  shutdownWorkers,
  parallelDispatches,
  MIN_ROWS,
} from './pool.js';
export type { WithWorkersOptions } from './pool.js';
export { rollingMeanSd } from './kernel.js';

declare module 'pond-ts' {
  interface TimeSeries<S extends SeriesSchema> {
    /**
     * Opts this series into partitioned rolling studies, and returns it
     * unchanged — requires `import '@pond-ts/financial/parallel'`
     * (Node only).
     *
     * **Position in a chain is meaningful.** It returns the same series,
     * so it reads as a no-op link and can sit anywhere; but it takes
     * effect from that point onward. Put it first and the whole chain is
     * partitioned; put it after `.sma()` and that `sma` has already run
     * sequentially.
     *
     * See the free {@link withWorkers} for the per-study accuracy table
     * — bounded at ~5.1e-13 across the studies it accelerates.
     */
    withWorkers(options?: WithWorkersOptions): TimeSeries<S>;
  }
}

const proto = TimeSeries.prototype as unknown as Record<string, unknown>;
proto.withWorkers = function (
  this: TimeSeries<SeriesSchema>,
  options: WithWorkersOptions = {},
) {
  return withWorkersFn(this, options);
};
