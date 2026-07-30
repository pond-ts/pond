/**
 * The pool's worker entry — [PND-PROCPAR].
 *
 * One long-lived {@link Host} per worker, built once from the caller's
 * setup module, then answering whole envelopes. The **long-lived** part
 * is the point: a per-request graph would discard every compiled node
 * and cached column between questions, which is precisely the cost this
 * package exists to avoid. A worker that rebuilt its host per request
 * would be slower than not having a pool at all.
 *
 * Why a *setup module specifier* rather than a config object: a registry
 * is functions (`OpDef.run`), and functions do not survive structured
 * clone. The plan is data and crosses freely; the code behind it has to
 * be imported at both ends. So the caller names a module, both isolates
 * import it, and the ops are ordinary shared code.
 *
 * This file is only ever loaded *as* a worker. It is Node-only by nature
 * (`node:worker_threads`), which is why it sits behind its own entry
 * point rather than in the package index.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { Host } from '../plan/host.js';
import { toWire } from './wire.js';
import type { PoolSetup, WorkerRequest, WorkerResponse } from './protocol.js';

if (parentPort === null) {
  throw new Error('@pond-ts/process worker: loaded outside a worker thread');
}
const port = parentPort;

const data = workerData as { setup: string; setupOptions?: unknown };

/**
 * Built once, awaited by every request. Errors here are reported against
 * the first request rather than crashing the worker silently — a bad
 * setup module is a caller mistake and should read as one.
 */
const ready: Promise<Host> = (async () => {
  const module = (await import(data.setup)) as {
    default?: PoolSetup;
    setup?: PoolSetup;
  };
  const factory = module.default ?? module.setup;
  if (typeof factory !== 'function') {
    throw new Error(
      `@pond-ts/process worker: '${data.setup}' must export a setup function ` +
        `(as \`default\` or \`setup\`) returning { registry, units?, sources?, datasets? }`,
    );
  }
  const config = await factory(data.setupOptions);
  const host = new Host({
    registry: config.registry,
    ...(config.units !== undefined && { units: config.units }),
    ...(config.sources !== undefined && { sources: config.sources }),
  });
  for (const [id, series] of Object.entries(config.datasets ?? {})) {
    host.add(id, series);
  }
  return host;
})();

// Surfaced through the first request instead of as an unhandled rejection.
ready.catch(() => undefined);

port.on('message', (message: WorkerRequest) => {
  void (async () => {
    try {
      const host = await ready;
      // `assemble: false` always. The pool answers columns; assembling a
      // `TimeSeries` here would build something that cannot cross the
      // boundary and that the caller can rebuild from the columns.
      const result = await host.runAsync({
        ...message.envelope,
        assemble: false,
      } as Parameters<Host['runAsync']>[0]);
      const { wire, transfer } = toWire(result);
      const response: WorkerResponse = { id: message.id, ok: true, wire };
      port.postMessage(response, transfer);
    } catch (e) {
      const response: WorkerResponse = {
        id: message.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        ...(e instanceof Error && e.name !== 'Error' && { name: e.name }),
      };
      port.postMessage(response);
    }
  })();
});
