/**
 * `StudyPool` — rolling studies partitioned across worker threads
 * ([PND-SCANKERN]).
 *
 * ## What it parallelises, and why that works
 *
 * A rolling window is not a recurrence. Output cell `i` reads only rows
 * `[i-period+1, i]`, so the *output* can be cut into ranges that share a
 * `period-1` element overlap and computed with no communication between
 * workers. There is no scan, no barrier beyond the single join, and no
 * cross-chunk dependency to get wrong.
 *
 * Measured end to end, `scripts/perf-parallel-bollinger.mjs`, 8 workers:
 *
 * | rows | sequential | pooled  |           |
 * | ---- | ---------- | ------- | --------- |
 * | 100k | 4.83 ms    | 2.01 ms | **2.40×** |
 * | 500k | 24.88 ms   | 9.24 ms | **2.69×** |
 * | 2M   | 96.15 ms   | 33.8 ms | **2.85×** |
 *
 * **The kernel alone is far faster than that — and the difference is the
 * point.** Partitioned, the rolling sweep drops from ~26 ms to ~1.9 ms at
 * 500k (13.8×, superlinear because a 62.5k-row chunk stays in cache while
 * one long sweep streams 4 MB in and 12 MB out past a single core). What
 * the caller actually sees is 2.69×, because the remaining ~7 ms is work
 * neither implementation avoids: copying the source column into shared
 * memory, and the three `withColumn` appends that build the result. Those
 * appends are the floor here, and the sequential study pays them too.
 *
 * Quoting the kernel number as the study's speedup would be the easiest
 * mistake to make with this code, so the benchmark reports end to end.
 *
 * ## Why it is opt-in, async, and Node-only
 *
 * Workers are Node-only and asynchronous, and `bollinger` is neither, so
 * this cannot be a drop-in replacement — hence a separate entry point
 * (`@pond-ts/financial/parallel`) rather than a flag on the study.
 *
 * ## The answer is not bit-identical, and that is the interesting part
 *
 * Chunk 0 begins where the whole-column sweep begins and reproduces it
 * exactly; every later chunk starts its Welford state fresh at its own
 * warm-up row instead of carrying the rounding history of the rows before
 * it. For `bollinger` the resulting difference is tiny and bounded —
 * **not one cell in 1.5 million moves by more than 1e-9 relative**, worst
 * observed 5.3e-13 — which is why `bollinger` is the study offered here
 * and `zScore` is not: dividing by a near-zero rolling σ amplifies the
 * same difference to ~5e-6, which is too large to ship without a
 * decision about the pandas oracle.
 *
 * ## Small inputs fall back, rather than losing
 *
 * Below {@link StudyPool.MIN_ROWS} the pool calls the ordinary
 * sequential study and returns its **bit-identical** result. Dispatch and
 * the input copy cost more than the work at that size, and quietly being
 * slower than the function you replaced is a worse failure than being
 * unavailable.
 */

import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  NumericColumnNameForSchema,
  SeriesSchema,
  TimeSeries,
} from 'pond-ts';
import { bollinger } from '../studies/bollinger.js';
import type { BollingerOptions } from '../studies/bollinger.js';
import { DEFAULT_SOURCE } from '../contract/columns.js';
import { assertPeriod } from '../kernels/rolling.js';
import type { KernelRequest, KernelResponse } from './protocol.js';

export interface StudyPoolOptions {
  /** Workers to start. Default: `availableParallelism() - 1`, min 1. */
  size?: number;
}

interface Pending {
  readonly resolve: () => void;
  readonly reject: (e: Error) => void;
}

async function defaultSize(): Promise<number> {
  const os = await import('node:os');
  const cores = os.availableParallelism?.() ?? os.cpus().length;
  return Math.max(1, cores - 1);
}

/** Reads one numeric column into a shared buffer, NaN marking missing. */
function sharedColumn(
  series: TimeSeries<SeriesSchema>,
  column: string,
): SharedArrayBuffer {
  const length = series.length;
  const sab = new SharedArrayBuffer(length * 8);
  const out = new Float64Array(sab);
  const col = series.column(
    column as NumericColumnNameForSchema<SeriesSchema>,
  ) as unknown as
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
    return sab;
  }
  if (col.storage === 'packed' && col.toFloat64Array !== undefined) {
    out.set(col.toFloat64Array());
    const bits = col.validity?.bits;
    if (bits !== undefined) {
      for (let i = 0; i < length; i += 1) {
        if ((bits[i >> 3]! & (1 << (i & 7))) === 0) out[i] = NaN;
      }
    }
    return sab;
  }
  for (let i = 0; i < length; i += 1) {
    const v = col.at(i);
    out[i] = typeof v === 'number' ? v : NaN;
  }
  return sab;
}

export class StudyPool {
  /**
   * Below this row count, studies run sequentially instead.
   *
   * Dispatch plus the input copy is a fixed cost of roughly a
   * millisecond, and a 25k-row `bollinger` is only 1.3 ms of work to
   * begin with — so partitioning it is a loss. At 100k the pooled study
   * measures 2.40×, so the win is already clear at the boundary and this
   * threshold is, if anything, conservative. Taken from the sweep in
   * `scripts/perf-parallel-bollinger.mjs` rather than guessed.
   */
  static readonly MIN_ROWS = 100_000;

  readonly #workers: Worker[];
  readonly #pending = new Map<number, Pending>();
  #next = 1;
  #closed = false;
  #fatal: Error | undefined;

  private constructor(workers: Worker[]) {
    this.#workers = workers;
  }

  static async start(options: StudyPoolOptions = {}): Promise<StudyPool> {
    const size = options.size ?? (await defaultSize());
    if (!Number.isInteger(size) || size < 1) {
      throw new RangeError(`StudyPool: size must be >= 1, got ${size}`);
    }
    // Checked rather than assumed: loaded from TypeScript source (a test
    // runner, a bundler) this resolves to a `.ts` no worker can execute,
    // and `new Worker` fails asynchronously — which presents as a hang
    // rather than an error.
    const entry = fileURLToPath(new URL('./worker.js', import.meta.url));
    if (!existsSync(entry)) {
      throw new Error(
        `StudyPool: worker entry not found at '${entry}'. The pool needs the ` +
          `built package — import '@pond-ts/financial/parallel' rather than ` +
          `the TypeScript source, which a worker thread cannot load.`,
      );
    }

    const workers = Array.from({ length: size }, () => {
      const w = new Worker(entry);
      w.unref();
      return w;
    });
    const pool = new StudyPool(workers);
    for (const w of workers) {
      w.on('message', (m: KernelResponse) => pool.#settle(m));
      w.on('error', (e: Error) => pool.#die(e));
      w.on('exit', (code) => {
        if (!pool.#closed) {
          pool.#die(new Error(`StudyPool: worker exited with code ${code}`));
        }
      });
    }
    await Promise.all(
      workers.map((w) => pool.#send(w, { kind: 'ping', id: 0 })),
    );
    return pool;
  }

  get size(): number {
    return this.#workers.length;
  }

  /**
   * **Bollinger Bands®**, computed across the pool.
   *
   * Same options, same three columns, and the same `undefined` warm-up
   * and flat-window rows as {@link bollinger}. The band values may differ
   * from the sequential study in the last few ulps — see the class doc;
   * below {@link StudyPool.MIN_ROWS} rows the sequential study runs
   * instead and the result is bit-identical.
   */
  async bollinger<S extends SeriesSchema, const Prefix extends string = 'bb'>(
    series: TimeSeries<S>,
    options: BollingerOptions<S, Prefix>,
  ): Promise<ReturnType<typeof bollinger<S, Prefix>>> {
    if (this.#closed) throw new Error('StudyPool: pool is closed');
    if (this.#fatal !== undefined) throw this.#fatal;

    assertPeriod(options.period);
    const stdDev = options.stdDev ?? 2;
    if (!Number.isFinite(stdDev) || stdDev <= 0) {
      throw new TypeError('bollinger stdDev must be a positive finite number');
    }
    const length = series.length;
    // Too small to be worth partitioning, or too short for one row per
    // worker — run the ordinary study and return its exact answer.
    if (length < StudyPool.MIN_ROWS || length < this.size * options.period) {
      return bollinger(series, options);
    }

    const column = (options.column ?? DEFAULT_SOURCE) as string;
    const prefix = (options.prefix ?? 'bb') as Prefix;
    const values = sharedColumn(
      series as unknown as TimeSeries<SeriesSchema>,
      column,
    );
    const buffer = (): SharedArrayBuffer => new SharedArrayBuffer(length * 8);
    // `mean` / `sd` are scratch for the rolling pass; the three bands are
    // the answer, and become the result columns without a further copy.
    const mean = buffer();
    const sd = buffer();
    const middle = buffer();
    const upper = buffer();
    const lower = buffer();

    const k = this.#workers.length;
    const step = Math.ceil(length / k);
    await Promise.all(
      this.#workers.map((w, i) => {
        const start = i * step;
        const end = Math.min(length, start + step);
        if (start >= end) return Promise.resolve();
        return this.#send(w, {
          kind: 'bollinger',
          id: 0,
          values,
          mean,
          sd,
          middle,
          upper,
          lower,
          period: options.period,
          stdDev,
          start,
          end,
        });
      }),
    );

    // `withColumn`'s typed door adopts a `Float64Array` and reads NaN as
    // missing ([PND-WCNAN]), so the shared buffers become the columns
    // without a copy or a boxing pass.
    // The same three `withColumn` appends the sequential study makes, so
    // the schema it produces is the schema declared by its return type.
    // Routed through `unknown` because that equivalence is a property of
    // the two implementations agreeing, not something the compiler can
    // see through a variadic tuple.
    const wide = series as unknown as TimeSeries<SeriesSchema>;
    const out = wide
      .withColumn(`${prefix}Middle`, new Float64Array(middle))
      .withColumn(`${prefix}Upper`, new Float64Array(upper))
      .withColumn(`${prefix}Lower`, new Float64Array(lower));
    return out as unknown as ReturnType<typeof bollinger<S, Prefix>>;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new Error('StudyPool: pool closed'));
    await Promise.all(this.#workers.map((w) => w.terminate()));
  }

  /**
   * Dispatches one job and resolves when that job answers.
   *
   * Workers are `unref`'d while idle so a pool nobody closed cannot hold
   * the process open, and `ref`'d while work is outstanding — a pending
   * promise does not keep the event loop alive on its own, so an
   * always-unref'd pool could let the process exit before an answer
   * arrived.
   */
  #send(worker: Worker, job: KernelRequest): Promise<void> {
    const id = this.#next++;
    return new Promise<void>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      worker.ref();
      worker.postMessage({ ...job, id });
    });
  }

  #settle(message: KernelResponse): void {
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    if (this.#pending.size === 0) {
      for (const w of this.#workers) w.unref();
    }
    if (message.ok) pending.resolve();
    else pending.reject(new Error(message.error ?? 'StudyPool: worker failed'));
  }

  #die(error: Error): void {
    this.#fatal ??= error;
    this.#failAll(error);
  }

  #failAll(error: Error): void {
    for (const p of this.#pending.values()) p.reject(error);
    this.#pending.clear();
    for (const w of this.#workers) w.unref();
  }
}
