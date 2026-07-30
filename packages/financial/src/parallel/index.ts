/**
 * `@pond-ts/financial/parallel` — studies partitioned across worker
 * threads ([PND-SCANKERN]).
 *
 * A separate entry point because it is **Node-only** (`worker_threads`)
 * and **asynchronous**, neither of which the ordinary studies are. The
 * main package stays runtime-neutral and synchronous.
 *
 * See {@link StudyPool} for what is parallelised, what it costs, why the
 * answer is not bit-identical to the sequential study, and why small
 * inputs fall back instead of losing.
 */

export { StudyPool } from './pool.js';
export type { StudyPoolOptions } from './pool.js';
export { rollingMeanSd, bollingerBands } from './kernel.js';
