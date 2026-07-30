/**
 * Worker entry for the parallel studies — [PND-SCANKERN].
 *
 * Deliberately stateless. Every buffer it touches is a
 * `SharedArrayBuffer` supplied per job, so a worker holds no data
 * between jobs and there is nothing to invalidate when the caller's
 * series changes. That is the opposite trade from
 * `@pond-ts/process`'s `HostPool`, which keeps a resident graph — and
 * it is right here, because the unit of work is a *range of one
 * column*, not a query.
 */

import { parentPort } from 'node:worker_threads';
import { bollingerBands, rollingMeanSd } from './kernel.js';
import type { KernelRequest, KernelResponse } from './protocol.js';

if (parentPort === null) {
  throw new Error('@pond-ts/financial/parallel: loaded outside a worker');
}
const port = parentPort;

port.on('message', (job: KernelRequest) => {
  try {
    if (job.kind === 'ping') {
      port.postMessage({ id: job.id, ok: true } satisfies KernelResponse);
      return;
    }
    const values = new Float64Array(job.values);
    const mean = new Float64Array(job.mean);
    const sd = new Float64Array(job.sd);
    rollingMeanSd(values, job.period, job.start, job.end, mean, sd);
    if (job.kind === 'bollinger') {
      bollingerBands(
        mean,
        sd,
        job.stdDev,
        job.start,
        job.end,
        new Float64Array(job.middle),
        new Float64Array(job.upper),
        new Float64Array(job.lower),
      );
    }
    port.postMessage({ id: job.id, ok: true } satisfies KernelResponse);
  } catch (e) {
    port.postMessage({
      id: job.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    } satisfies KernelResponse);
  }
});
