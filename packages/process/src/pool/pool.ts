/**
 * `HostPool` — whole requests across resident workers ([PND-PROCPAR]).
 *
 * ## Which parallelism this is
 *
 * The worker-threads assessment
 * (`docs/notes/worker-threads-assessment-2026-07.md`) found two distinct
 * wins and warned against conflating them:
 *
 * - **Latency** of one composite query — split its nodes across workers.
 *   Measured 2.42× on a 5-study stack, and it needs an engine change: a
 *   node's value can only be produced by its own `compute`, so a result
 *   computed elsewhere has nowhere to land. Still ahead of us.
 * - **Throughput** under concurrent queries — run *whole* requests, each
 *   single-threaded, on a pool of resident hosts. Near-linear, no
 *   decomposition, no numeric-semantics questions, **and no engine
 *   change at all**.
 *
 * This is the second. It is deliberately first: the agent workload is
 * many overlapping questions, so throughput is what it feels, and this
 * shape cannot get an answer wrong — each request runs the same
 * single-threaded code it runs today, in a different isolate.
 *
 * ## What makes it cheap
 *
 * Each worker holds a **long-lived `Host`**, so compiled nodes and
 * cached columns survive between requests exactly as they do in-process.
 * The pool is only a router. What crosses the boundary is a plan
 * (JSON by construction) and a result whose columns travel as
 * transferable buffers rather than boxed values.
 *
 * ## What it is not
 *
 * Not a cache-sharing scheme. Each worker warms its own graph, so N
 * workers hold up to N copies of a hot column and a question already
 * answered by worker 2 is cold on worker 3. That is the honest cost of
 * the simple shape: it buys throughput, not deduplication. Route related
 * requests to the same worker (see {@link HostPool.run}'s `affinity`) if
 * repeat-hit rate matters more than even spread.
 */

import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ProcessError } from '../errors.js';
import { fromWire } from './wire.js';
import type { WorkerRequest, WorkerResponse } from './protocol.js';
import type { AsyncEnvelope } from '../plan/host.js';
import type { RunResult } from '../plan/run.js';

export interface HostPoolOptions {
  /**
   * Module specifier for the worker's setup module — a `URL`, or an
   * absolute path/specifier a worker can `import()`.
   *
   * It must export a setup function (as `default` or `setup`) returning
   * `{ registry, units?, sources?, datasets? }`. A module, not a value,
   * because a registry is functions and functions do not survive
   * structured clone.
   */
  readonly setup: URL | string;
  /** Workers to start. Default: `availableParallelism() - 1`, min 1. */
  readonly size?: number;
  /** Passed to the setup function, so one module can serve several pools. */
  readonly setupOptions?: unknown;
}

interface Pending {
  readonly resolve: (result: RunResult) => void;
  readonly reject: (error: Error) => void;
}

interface Slot {
  readonly worker: Worker;
  /** Requests dispatched to this worker and not yet answered. */
  inFlight: number;
}

/** Default pool size: leave a core for the main thread. */
async function defaultSize(): Promise<number> {
  const os = await import('node:os');
  const cores = os.availableParallelism?.() ?? os.cpus().length;
  return Math.max(1, cores - 1);
}

export class HostPool {
  readonly #slots: Slot[];
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #closed = false;
  /**
   * Set when a worker dies unexpectedly. A dead worker cannot answer, so
   * every *later* request must fail too — rejecting only the in-flight
   * ones left a pool that looked alive and swallowed everything sent to
   * it. A pool is not self-healing: replacing a worker would silently
   * discard its warm graph, so failing loudly is the honest response.
   */
  #fatal: Error | undefined;

  private constructor(slots: Slot[]) {
    this.#slots = slots;
  }

  /**
   * Starts the pool and waits for every worker to be listening.
   *
   * Setup modules are imported lazily *inside* each worker on its first
   * request, so `start` resolving does not mean the registry loaded — a
   * broken setup module surfaces as that first request's error, where a
   * caller can read it, rather than as a start-up crash with no
   * request to attach it to.
   */
  static async start(options: HostPoolOptions): Promise<HostPool> {
    const size = options.size ?? (await defaultSize());
    if (!Number.isInteger(size) || size < 1) {
      throw new ProcessError(`HostPool: size must be >= 1, got ${size}`);
    }
    const setup =
      options.setup instanceof URL ? options.setup.href : String(options.setup);

    // The worker entry sits next to this module in `dist`. Checked
    // rather than assumed: a caller running the package from TypeScript
    // source (a test runner, a bundler) resolves this to a `.ts` file no
    // Node worker can load, and `new Worker` on a missing file fails
    // asynchronously — which used to leave a pool whose workers were all
    // dead and whose requests hung forever. A named error at start beats
    // a silent hang later.
    const entry = fileURLToPath(new URL('./worker.js', import.meta.url));
    if (!existsSync(entry)) {
      throw new ProcessError(
        `HostPool: worker entry not found at '${entry}'. The pool needs the ` +
          `built package — run \`npm run build\` and import ` +
          `'@pond-ts/process/pool' (or dist/pool/index.js) rather than the ` +
          `TypeScript source, which a worker thread cannot load.`,
      );
    }

    const slots: Slot[] = [];
    for (let i = 0; i < size; i += 1) {
      const worker = new Worker(entry, {
        workerData: {
          setup,
          ...(options.setupOptions !== undefined && {
            setupOptions: options.setupOptions,
          }),
        },
      });
      // Idle workers must not hold the process open — a pool someone
      // forgot to close should not stop `node script.js` from exiting.
      // Re-`ref`'d while a request is in flight (see `#dispatch`),
      // because a pending promise does *not* keep the event loop alive
      // on its own: unref'd throughout, a program awaiting `run()` could
      // exit before its answer arrived.
      worker.unref();
      slots.push({ worker, inFlight: 0 });
    }

    const pool = new HostPool(slots);
    for (const slot of slots) {
      slot.worker.on('message', (m: WorkerResponse) => pool.#settle(slot, m));
      slot.worker.on('error', (e: Error) => pool.#die(e));
      // ANY unexpected exit is fatal, not just a non-zero one. A worker
      // that left cleanly is exactly as unable to answer as one that
      // crashed, and treating `code === 0` as benign left every later
      // request routed to that slot hanging forever — the same silent
      // hang the fatal latch exists to stop.
      slot.worker.on('exit', (code: number) => {
        if (!pool.#closed) {
          pool.#die(
            new ProcessError(`HostPool: worker exited with code ${code}`),
          );
        }
      });
    }
    return pool;
  }

  /** Workers in the pool. */
  get size(): number {
    return this.#slots.length;
  }

  /** Requests dispatched and not yet answered. */
  get inFlight(): number {
    return this.#pending.size;
  }

  /**
   * Runs one envelope on the least-busy worker.
   *
   * `assemble` is forced off — the pool answers `columns`, and the caller
   * assembles a `TimeSeries` from them if it wants one. Assembling
   * worker-side would build an object that cannot cross the boundary.
   *
   * Pass `affinity` to pin related requests to one worker. Requests
   * sharing an affinity key land on the same host, so its warm nodes are
   * reused — worth it when a caller re-asks overlapping questions about
   * one dataset, and pointless when every request is unrelated.
   */
  async run(envelope: AsyncEnvelope, affinity?: string): Promise<RunResult> {
    if (this.#closed) throw new ProcessError('HostPool: pool is closed');
    if (this.#fatal !== undefined) throw this.#fatal;
    const slot = this.#pick(affinity);
    const id = this.#nextId++;
    const request: WorkerRequest = { id, envelope };

    return new Promise<RunResult>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      if (slot.inFlight === 0) slot.worker.ref();
      slot.inFlight += 1;
      slot.worker.postMessage(request);
    });
  }

  /** Terminates every worker. Outstanding requests reject. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new ProcessError('HostPool: pool closed'));
    await Promise.all(this.#slots.map((s) => s.worker.terminate()));
  }

  /**
   * Least-in-flight, not round-robin: requests here differ by orders of
   * magnitude (a cached fact against a cold 500k-row study), so spreading
   * by count would queue short work behind long work on the same worker.
   */
  #pick(affinity?: string): Slot {
    if (affinity !== undefined) {
      let hash = 0;
      for (let i = 0; i < affinity.length; i += 1) {
        hash = (hash * 31 + affinity.charCodeAt(i)) | 0;
      }
      return this.#slots[Math.abs(hash) % this.#slots.length]!;
    }
    let best = this.#slots[0]!;
    for (const slot of this.#slots) {
      if (slot.inFlight < best.inFlight) best = slot;
    }
    return best;
  }

  #settle(slot: Slot, message: WorkerResponse): void {
    // Identify the request FIRST. A worker's `parentPort` is in scope for
    // the caller's own setup module, so a stray `postMessage` from it
    // reaches here — and decrementing on that would `unref` a worker with
    // real work outstanding, letting the process exit before the answer
    // arrived. That is exactly the hang ref/unref exists to prevent, and
    // a `Math.max(0, …)` guard hides it as an early unref rather than a
    // negative count. Only a message we are actually waiting on counts.
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    slot.inFlight = Math.max(0, slot.inFlight - 1);
    if (slot.inFlight === 0) slot.worker.unref();
    if (message.ok) {
      pending.resolve(fromWire(message.wire));
    } else {
      const error = new ProcessError(message.error);
      if (message.name !== undefined) error.name = message.name;
      pending.reject(error);
    }
  }

  /** A worker died: fail what is outstanding, and everything after it. */
  #die(error: Error): void {
    this.#fatal ??= error;
    this.#failAll(error);
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const slot of this.#slots) {
      slot.inFlight = 0;
      slot.worker.unref();
    }
  }
}
