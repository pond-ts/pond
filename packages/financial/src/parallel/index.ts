/**
 * `@pond-ts/financial/parallel` — partitioned rolling studies
 * ([PND-SCANKERN]).
 *
 * A separate entry point because it is **Node-only**: it needs worker
 * threads, and `Atomics.wait` on the main thread — which browsers forbid
 * — is what lets the studies stay synchronous while workers do the work.
 * The main package never imports this and stays portable.
 *
 * Opt in once, at ingest. See {@link withWorkers} for what it costs in
 * accuracy, which differs per study and is the reason this is a
 * documented choice rather than a default.
 */

export { withWorkers, shutdownWorkers, MIN_ROWS } from './pool.js';
export type { WithWorkersOptions } from './pool.js';
export { rollingMeanSd } from './kernel.js';
