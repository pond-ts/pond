/**
 * Worker for the parallel rolling kernel — [PND-SCANKERN].
 *
 * Sleeps on `Atomics.wait` and is woken by the main thread, rather than
 * receiving jobs by `postMessage`. That is what keeps the *studies*
 * synchronous: `bollinger(bars, …)` must not become a promise merely
 * because it got faster, so the main thread has to dispatch and join
 * without yielding to its event loop. `Atomics` can do that; message
 * passing cannot.
 *
 * The consequence, deliberately accepted: every buffer this worker will
 * ever touch is handed over once at construction, because a thread
 * parked in `Atomics.wait` never runs its event loop and so can never
 * receive a `postMessage`. Hence the fixed per-series arena.
 */

import { workerData } from 'node:worker_threads';
import { ctrl, rollingMeanSd } from './kernel.js';

const { control, arena, rows, slot } = workerData as {
  control: SharedArrayBuffer;
  arena: SharedArrayBuffer;
  rows: number;
  slot: number;
};

const sig = new Int32Array(control);
const values = new Float64Array(arena, 0, rows);
const mean = new Float64Array(arena, rows * 8, rows);
const sd = new Float64Array(arena, rows * 16, rows);

for (;;) {
  // `load` before `wait`: the main thread may have posted the job before
  // this thread arrived, and waiting on an already-changed value would
  // park forever. This is the lost-wakeup guard.
  while (Atomics.load(sig, ctrl.JOB + slot) === 0) {
    if (Atomics.load(sig, ctrl.STOP) === 1) process.exit(0);
    Atomics.wait(sig, ctrl.JOB + slot, 0, 50);
  }
  if (Atomics.load(sig, ctrl.STOP) === 1) process.exit(0);

  const start = Atomics.load(sig, ctrl.RANGE + slot * 2);
  const end = Atomics.load(sig, ctrl.RANGE + slot * 2 + 1);
  const period = Atomics.load(sig, ctrl.PERIOD);
  if (end > start) rollingMeanSd(values, period, start, end, mean, sd);

  Atomics.store(sig, ctrl.JOB + slot, 0);
  Atomics.add(sig, ctrl.DONE, 1);
  Atomics.notify(sig, ctrl.DONE);
}
