/**
 * `withWorkers` — opt a series into partitioned rolling studies
 * ([PND-SCANKERN]).
 *
 * ```ts
 * import { withWorkers } from '@pond-ts/financial/parallel'; // Node only
 *
 * const bars = withWorkers(loadBars(), { workers: 8 });
 * const bands = bollinger(bars, { period: 20 });   // still synchronous
 * ```
 *
 * ## The shape of the opt-in
 *
 * You choose it **once, where the data is ingested**, and every rolling
 * study over that series is partitioned from then on. The studies keep
 * their signatures — same arguments, same return type, still synchronous —
 * so nothing downstream has to know. Without `withWorkers` the library
 * behaves exactly as it always has: **single-threaded is the default and
 * this file is never even loaded.**
 *
 * Derived series inherit it. A study returns a new `TimeSeries`, and
 * `withColumn` shares the key column, so registration is keyed on the key
 * buffer — `sma(sma(bars))` stays accelerated all the way down.
 *
 * ## Node only, by construction
 *
 * `Atomics.wait` on the main thread is what lets a study stay
 * synchronous while workers do the work, and browsers forbid it. There
 * is nothing to feature-detect and nothing to polyfill: on the browser
 * you simply do not import this entry point, and the ordinary studies
 * run as they always do.
 *
 * ## What it costs in accuracy — read this before opting in
 *
 * Partitioning changes the answer slightly, and by different amounts for
 * different studies. Chunk 0 reproduces the sequential sweep exactly;
 * every later chunk starts its Welford state fresh at its own warm-up
 * row rather than carrying the rounding history of the rows before it.
 *
 * Measured over 500k bars, period 20, 8 workers
 * (`scripts/perf-parallel-studies.mjs`):
 *
 * | study        | speedup | worst rel. difference | cells beyond 1e-9 |
 * | ------------ | ------- | --------------------- | ----------------- |
 * | `sma`        | 1.83×   | 3.9e-14               | none              |
 * | `envelope`   | 1.32×   | 3.9e-14               | none              |
 * | `bollinger`  | 1.86×   | 5.1e-13               | none              |
 * | **`zScore`** | 2.45×   | **2.6e-6**            | **4,051 (0.8%)**  |
 * | 3-study stack | 1.98×  | (as `zScore`)         |                   |
 *
 * `zScore` is the outlier and the reason this is a documented opt-in
 * rather than a default. It divides by the rolling standard deviation,
 * so wherever a window is nearly flat, a last-ulp difference in the mean
 * or σ is amplified without bound. If you compare z-scores against a
 * fixed threshold, or reproduce numbers against `@pond-ts/financial`'s
 * pandas oracle, that difference is visible. Nothing else measured here
 * moves by more than a rounding error.
 *
 * The speedups are modest next to the raw kernel, which partitions
 * 13.8× (`spikes/parallel-rolling/`). The gap is the work that stays on
 * the main thread either way: copying the source column into the arena,
 * copying each answer back out, and each study's own pointwise
 * arithmetic (`m ± k·σ`). Accelerating only the rolling pass — rather
 * than reimplementing every study inside the worker — is what lets one
 * hook serve `sma`, `envelope`, `bollinger` and `zScore` with no second
 * copy of any study's logic to drift from the first.
 *
 * ## When it pays
 *
 * Below {@link MIN_ROWS} rows the series runs sequentially regardless —
 * dispatch costs more than the work, and quietly being slower than the
 * function you replaced is the worst outcome available. Above it,
 * see the table above for what each study actually gains.
 */

import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { availableParallelism, cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import type {
  NumericColumnNameForSchema,
  SeriesSchema,
  TimeSeries,
} from 'pond-ts';
import {
  setRollingAccelerator,
  type RollingReducer,
} from '../kernels/rolling.js';
import { ARENA_SLOTS, MAX_WORKERS, ctrl } from './kernel.js';

export interface WithWorkersOptions {
  /**
   * Worker threads to use. Default `availableParallelism() - 1`, capped
   * at 32. `1` is legal and simply runs the partitioned kernel on one
   * worker — useful for isolating the partitioning from the concurrency.
   */
  workers?: number;
}

/**
 * Below this many rows a registered series still runs sequentially.
 *
 * Dispatch plus the input copy is a fixed cost of roughly a millisecond,
 * and a 25k-row `bollinger` is only 1.3 ms of work to begin with. At
 * 100k the pooled study measures 2.40×, so the win is already clear at
 * the boundary and this threshold is, if anything, conservative.
 */
export const MIN_ROWS = 100_000;

interface Registration {
  readonly workers: Worker[];
  readonly sig: Int32Array;
  readonly rows: number;
  readonly values: Float64Array;
  readonly mean: Float64Array;
  readonly sd: Float64Array;
  stopped: boolean;
}

/**
 * Keyed on the **key column's buffer**, not the series object, so every
 * series derived from a registered one is registered too. A study
 * returns a new `TimeSeries` and `withColumn` shares the key column, so
 * without this a chained study would silently fall back to sequential
 * after the first step.
 */
const registry = new WeakMap<ArrayBufferLike, Registration>();
const live = new Set<Registration>();
let installed = false;

function keyBufferOf(series: TimeSeries<SeriesSchema>): ArrayBufferLike {
  return (series.keyColumn() as unknown as { begin: Float64Array }).begin
    .buffer;
}

/** Reads one numeric column into the arena, NaN marking missing. */
function readInto(
  out: Float64Array,
  series: TimeSeries<SeriesSchema>,
  column: string,
): boolean {
  const length = series.length;
  const col = series.column(
    column as NumericColumnNameForSchema<SeriesSchema>,
  ) as unknown as
    | {
        kind?: string;
        storage?: string;
        validity?: { bits: Uint8Array };
        toFloat64Array?: () => Float64Array;
      }
    | undefined;
  if (col === undefined || col.kind !== 'number') return false;
  if (col.storage !== 'packed' || col.toFloat64Array === undefined)
    return false;
  out.set(col.toFloat64Array().subarray(0, length));
  const bits = col.validity?.bits;
  if (bits !== undefined) {
    for (let i = 0; i < length; i += 1) {
      if ((bits[i >> 3]! & (1 << (i & 7))) === 0) out[i] = NaN;
    }
  }
  return true;
}

/**
 * Dispatches the rolling pass across the pool and blocks until every
 * worker reports done.
 *
 * Blocking is the point: it is what lets the study stay synchronous. It
 * also means the event loop does not turn while the pass runs — fine for
 * a CLI or an agent that is waiting on the answer anyway, and worth
 * knowing about in a server that is serving other requests.
 */
function dispatch(reg: Registration, period: number): void {
  const k = reg.workers.length;
  const step = Math.ceil(reg.rows / k);
  Atomics.store(reg.sig, ctrl.DONE, 0);
  Atomics.store(reg.sig, ctrl.PERIOD, period);
  for (let i = 0; i < k; i += 1) {
    const start = Math.min(reg.rows, i * step);
    const end = Math.min(reg.rows, start + step);
    Atomics.store(reg.sig, ctrl.RANGE + i * 2, start);
    Atomics.store(reg.sig, ctrl.RANGE + i * 2 + 1, end);
    Atomics.store(reg.sig, ctrl.JOB + i, 1);
    Atomics.notify(reg.sig, ctrl.JOB + i);
  }
  for (;;) {
    const done = Atomics.load(reg.sig, ctrl.DONE);
    if (done >= k) break;
    // A timeout rather than an indefinite park: a worker that died would
    // otherwise hang the main thread with no way to notice.
    Atomics.wait(reg.sig, ctrl.DONE, done, 100);
    if (reg.stopped)
      throw new Error('withWorkers: pool was shut down mid-pass');
  }
}

/**
 * The accelerator installed into the rolling kernel.
 *
 * Declines (returns `null`) unless every condition holds: the series was
 * registered, it is big enough to be worth partitioning, and every spec
 * asks for `avg` or `stdev` off **one** column — which is exactly what
 * `sma`, `envelope`, `bollinger` and `zScore` ask for. Anything else
 * runs sequentially, unchanged.
 */
function accelerate(
  series: TimeSeries<SeriesSchema>,
  specs: Record<string, { from: string; using: RollingReducer }>,
  period: number,
): Record<string, Float64Array> | null {
  const entries = Object.entries(specs);
  if (entries.length === 0) return null;

  const reg = registry.get(keyBufferOf(series));
  if (reg === undefined || reg.stopped) return null;
  if (series.length !== reg.rows) return null; // a crop/slice — not this arena
  if (series.length < MIN_ROWS) return null;
  if (series.length < reg.workers.length * period) return null;

  const column = entries[0]![1].from;
  for (const [, spec] of entries) {
    if (spec.from !== column) return null;
    if (spec.using !== 'avg' && spec.using !== 'stdev') return null;
  }
  if (!readInto(reg.values, series, column)) return null;

  dispatch(reg, period);

  const out: Record<string, Float64Array> = {};
  for (const [name, spec] of entries) {
    // A copy out of the arena: the next study over this series reuses
    // those buffers, and a caller holding the previous answer must not
    // watch it change underneath them.
    out[name] = (spec.using === 'avg' ? reg.mean : reg.sd).slice(0, reg.rows);
  }
  return out;
}

/**
 * Opts `series` into partitioned rolling studies, and returns it
 * unchanged.
 *
 * Idempotent per series. Starting the pool is the expensive part
 * (~25–85 ms of worker start-up plus an arena of 24 bytes per row), so
 * do it once at ingest rather than per query.
 */
export function withWorkers<S extends SeriesSchema>(
  series: TimeSeries<S>,
  options: WithWorkersOptions = {},
): TimeSeries<S> {
  const wide = series as unknown as TimeSeries<SeriesSchema>;
  const key = keyBufferOf(wide);
  const existing = registry.get(key);
  if (existing !== undefined && !existing.stopped) return series;

  const requested = options.workers ?? 0;
  const size =
    requested > 0
      ? Math.min(MAX_WORKERS, Math.floor(requested))
      : Math.min(MAX_WORKERS, Math.max(1, defaultParallelism() - 1));
  if (!Number.isFinite(size) || size < 1) {
    throw new RangeError(`withWorkers: workers must be >= 1, got ${requested}`);
  }

  const entry = fileURLToPath(new URL('./worker.js', import.meta.url));
  if (!existsSync(entry)) {
    throw new Error(
      `withWorkers: worker entry not found at '${entry}'. This needs the ` +
        `built package — import '@pond-ts/financial/parallel', not the ` +
        `TypeScript source, which a worker thread cannot load.`,
    );
  }

  const rows = wide.length;
  const control = new SharedArrayBuffer(ctrl.BYTES);
  const arena = new SharedArrayBuffer(rows * 8 * ARENA_SLOTS);
  const sig = new Int32Array(control);
  const workers = Array.from({ length: size }, (_, slot) => {
    const w = new Worker(entry, {
      workerData: { control, arena, rows, slot },
    });
    // An idle pool must not hold the process open. The main thread blocks
    // in `Atomics.wait` during a pass, so nothing here needs the event
    // loop kept alive on its behalf.
    w.unref();
    return w;
  });

  const reg: Registration = {
    workers,
    sig,
    rows,
    values: new Float64Array(arena, 0, rows),
    mean: new Float64Array(arena, rows * 8, rows),
    sd: new Float64Array(arena, rows * 16, rows),
    stopped: false,
  };
  registry.set(key, reg);
  live.add(reg);
  if (!installed) {
    setRollingAccelerator(accelerate);
    installed = true;
  }
  return series;
}

function defaultParallelism(): number {
  return availableParallelism?.() ?? cpus().length;
}

/**
 * Stops every pool started by {@link withWorkers} and restores the
 * sequential path.
 *
 * Workers are `unref`'d, so a program will exit without this; call it
 * when you want the threads gone sooner, or between test cases.
 */
export function shutdownWorkers(): void {
  for (const reg of live) {
    reg.stopped = true;
    Atomics.store(reg.sig, ctrl.STOP, 1);
    for (let i = 0; i < reg.workers.length; i += 1) {
      Atomics.notify(reg.sig, ctrl.JOB + i);
    }
    for (const w of reg.workers) void w.terminate();
  }
  live.clear();
  setRollingAccelerator(undefined);
  installed = false;
}
