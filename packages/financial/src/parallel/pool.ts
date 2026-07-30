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
 * Without it, nothing changes at all — the same call, single-threaded:
 *
 * ```ts
 * const bands = bollinger(loadBars(), { period: 20 });
 * ```
 *
 * The fluent layer needs nothing special either. Each link returns a
 * derived series, and derived series stay registered (see below), so a
 * whole chain is accelerated — measured 55.95 ms → 25.63 ms (2.18×) for
 * `.sma().bollinger().zScore()` over 500k bars:
 *
 * ```ts
 * import '@pond-ts/financial/fluent';
 *
 * const study = withWorkers(loadBars(), { workers: 8 })
 *   .sma({ period: 20 })
 *   .bollinger({ period: 20 })
 *   .zScore({ period: 20 });
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
 * | study        | speedup | observed worst rel. difference |
 * | ------------ | ------- | ------------------------------ |
 * | `sma`        | 1.85×   | 3.9e-14                        |
 * | `envelope`   | 1.35×   | 3.9e-14                        |
 * | `bollinger`  | 1.92×   | 5.1e-13                        |
 * | 3-study stack | 2.00×  | 5.1e-13                        |
 *
 * `zScore` is absent because it is **no longer accelerated**. It used to
 * be the fastest entry here at 2.44×, and the only one with a caveat —
 * 2.6e-6 on ~0.8% of cells. [PND-SHIFTFRAME] moved it onto
 * `rollingDeviationSd`, which this pool does not hook, so opting in
 * neither speeds it up nor changes its answer by a single bit. That is
 * the right trade: the speedup was real and the answer was wrong.
 *
 * **Those are observations on a benign workload, not bounds.** An
 * earlier version of this doc presented a `zScore` figure as if it
 * bounded the error. It did not, and a Codex review supplied the
 * counterexample: on a legal near-flat series at large magnitude
 * (`1e15 + ((i % 7) - 3)`, period 20, 4 chunks) the partitioned z-score
 * differed from the sequential one by **38% relative** — verified, and
 * still pinned as a regression test, now as the reason `zScore` is
 * formulated the way it is.
 *
 * **The mechanism is not the division, and it is fixable.** Decomposed at
 * the worst-disagreeing row: σ differs between the two sweeps by 0.97%,
 * while `v − mean` differs by **60%**. `ulp(1e15)` is `0.125`, so a
 * window spanning ±3 covers ~48 ulps — computing `v − mean` with both
 * operands ≈1e15 and the answer ≈1.0 leaves about three bits. A one-ulp
 * disagreement in `mean` is then ~12% of the answer.
 *
 * So the exposure was **catastrophic cancellation in the numerator**,
 * set by the data's magnitude-to-spread ratio, and **not caused by
 * parallelism** — the sequential study computed the same subtraction and
 * had the same exposure. Partitioning only changed which rounding
 * history each cell carried, landing one ulp apart, which this input
 * amplifies.
 *
 * [PND-SHIFTFRAME] fixed the formulation rather than the caveat.
 * `rollingDeviationSd` accumulates `v − anchor` and emits the deviation
 * directly, so nothing cancels: **100% → 4.1e-15** on the counterexample,
 * and better on benign data too. It is a study-level fix, so the
 * sequential path gained the same accuracy — which is the point, since
 * the sequential path was never actually safe here.
 *
 * **So: `sma`, `envelope` and `bollinger` shift by rounding error, and
 * `zScore` does not shift at all.** The studies this pool accelerates
 * are exactly the ones whose error it bounds.
 *
 * There is also a semantic gap worth knowing: core rejects a non-finite
 * rolling result outright, where this kernel can emit `Infinity` or
 * clamp a `NaN` variance to zero. Same class of exposure, same
 * near-degenerate windows.
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

/**
 * How long one partitioned pass may take before it is treated as a dead
 * worker rather than a slow one.
 *
 * Generous on purpose — a 10M-row pass on a loaded machine sits well
 * inside it — because the two failure directions are not symmetric: too
 * short aborts real work, too long is merely a slower failure. What it
 * must never be is absent, which is what turned a dead worker into a
 * permanent hang.
 */
const DISPATCH_TIMEOUT_MS = 30_000;

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
 * Keyed on the key column's **`Float64Array` object**, not the series and
 * not its `ArrayBuffer`.
 *
 * Not the series, because a study returns a new `TimeSeries` and
 * `withColumn` shares the key column — keying on the series would drop
 * acceleration after the first link of a chain.
 *
 * Not the buffer, because `fromArrow` views the IPC byte array directly:
 * two independent `tableFromIPC(bytes)` decodes of the same bytes share
 * one `ArrayBuffer`, so buffer-keying let `withWorkers(a)` silently opt
 * in an unrelated `b`. Harmless to the answers (identical data) but a
 * leak in an explicit opt-in, and it quietly accelerated the baseline of
 * the first benchmark written against this API.
 */
const registry = new WeakMap<Float64Array, Registration>();
const live = new Set<Registration>();
/**
 * Started pools, keyed `rows:workers` — so re-ingesting a same-shaped
 * series reuses its threads instead of starting more.
 *
 * This matters because `withWorkers` reads naturally *inside* a pipeline
 * (`fromArrow(...).withWorkers({ workers: 8 }).sma(...)`), and a pipeline
 * gets re-run. Without reuse each run minted a fresh pool: measured at
 * 1.03× — all the speedup spent starting threads. Workers are bound to
 * their arena at construction (a thread parked in `Atomics.wait` cannot
 * be sent new buffers), so the arena size is part of the key; the arena
 * is refilled from the series on every pass anyway, so sharing one
 * across same-length series is safe.
 */
const pools = new Map<string, Registration>();
let installed = false;

function keyBufferOf(series: TimeSeries<SeriesSchema>): Float64Array {
  return (series.keyColumn() as unknown as { begin: Float64Array }).begin;
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
  // Bounded, not merely timed out per iteration. The earlier version
  // looped forever on a 100 ms wait and checked `reg.stopped`, which only
  // `shutdownWorkers` ever sets — so a worker that threw, exited, or
  // failed to start left `DONE` short of `k` and the "death detector"
  // spun for good. Worse, a worker's `error` / `exit` callbacks **cannot
  // run at all** while the main thread is parked in `Atomics.wait`: the
  // event loop is precisely what blocking gives up. Liveness therefore
  // has to come from a deadline, never from an event handler.
  const deadline = Date.now() + DISPATCH_TIMEOUT_MS;
  for (;;) {
    const done = Atomics.load(reg.sig, ctrl.DONE);
    if (done >= k) break;
    if (reg.stopped) {
      throw new Error('withWorkers: pool was shut down mid-pass');
    }
    if (Date.now() > deadline) {
      reg.stopped = true;
      throw new Error(
        `withWorkers: ${k - done} of ${k} workers did not report within ` +
          `${DISPATCH_TIMEOUT_MS} ms — a worker has probably died. The pool ` +
          `is now stopped; studies fall back to the sequential path.`,
      );
    }
    Atomics.wait(reg.sig, ctrl.DONE, done, 100);
  }
}

/**
 * The accelerator installed into the rolling kernel.
 *
 * Declines (returns `null`) unless every condition holds: the series was
 * registered, it is big enough to be worth partitioning, and every spec
 * asks for `avg` or `stdev` off **one** column — which is exactly what
 * `sma`, `envelope` and `bollinger` ask for. Anything else
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
  dispatched += 1;

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
 * Idempotent per series, and pools are reused across same-shaped series
 * — so this is safe to write inside a pipeline that gets re-run, which
 * is how it reads most naturally:
 *
 * ```ts
 * TimeSeries.fromArrow(table, { time: 'ts' })
 *   .withWorkers({ workers: 8 })
 *   .sma({ period: 20 })
 * ```
 *
 * Even so, starting the first pool costs ~25–85 ms of thread start-up
 * plus an arena of 24 bytes per row, so the natural place for it is
 * where the data is ingested.
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
  const poolKey = `${rows}:${size}`;
  const reusable = pools.get(poolKey);
  if (reusable !== undefined && !reusable.stopped) {
    registry.set(key, reusable);
    return series;
  }

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
  pools.set(poolKey, reg);
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
let dispatched = 0;

/**
 * How many rolling passes have actually run on worker threads since the
 * process started.
 *
 * Acceleration is otherwise invisible: {@link withWorkers} is a no-op
 * when the pool declines a series (too few rows, a crop that no longer
 * matches the arena, a reducer the kernel does not implement, a study
 * that does not go through the rolling kernel at all), and a declined
 * pass returns the same answer the sequential path would — just slower
 * than the caller expected. This is how you check.
 *
 * ```ts
 * const before = parallelDispatches();
 * const out = sma(withWorkers(bars, { workers: 8 }), { period: 20 });
 * if (parallelDispatches() === before) console.warn('ran sequentially');
 * ```
 *
 * It counts passes, not studies: a study asking for both a mean and a σ
 * over the same column is one pass. The counter is process-wide and
 * never resets, including across {@link shutdownWorkers} — compare two
 * readings rather than testing against zero.
 */
export function parallelDispatches(): number {
  return dispatched;
}

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
  pools.clear();
  setRollingAccelerator(undefined);
  installed = false;
}
