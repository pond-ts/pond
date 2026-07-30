import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const N = 500_000;

const sab = new SharedArrayBuffer(N * 8);
const values = new Float64Array(sab);
for (let i = 0; i < N; i += 1) values[i] = 50 + 35 * Math.sin(i / 5000);

// Main-thread twins of the worker kernels (identical code) so the
// comparison isolates parallelism, not kernel differences.
function rollingMean(out, start, end, w) {
  let s = 0;
  const from = Math.max(0, start - w + 1);
  for (let i = from; i < Math.min(start, from + w); i += 1) s += values[i];
  for (let i = start; i < end; i += 1) {
    s += values[i];
    if (i >= w) s -= values[i - w];
    out[i] = i >= w - 1 ? s / w : NaN;
  }
}
function rollingStd(out, start, end, w) {
  let s = 0,
    s2 = 0;
  const from = Math.max(0, start - w + 1);
  for (let i = from; i < Math.min(start, from + w); i += 1) {
    s += values[i];
    s2 += values[i] * values[i];
  }
  for (let i = start; i < end; i += 1) {
    s += values[i];
    s2 += values[i] * values[i];
    if (i >= w) {
      s -= values[i - w];
      s2 -= values[i - w] * values[i - w];
    }
    if (i >= w - 1) {
      const m = s / w;
      const v = s2 / w - m * m;
      out[i] = v > 0 ? Math.sqrt(v) : 0;
    } else out[i] = NaN;
  }
}

function median(xs) {
  const a = [...xs].sort((p, q) => p - q);
  return a[a.length >> 1];
}
function bench(fn, reps = 15) {
  const t = [];
  for (let r = 0; r < reps; r += 1) {
    const a = performance.now();
    fn();
    t.push(performance.now() - a);
  }
  return median(t);
}
async function benchAsync(fn, reps = 15) {
  const t = [];
  for (let r = 0; r < reps; r += 1) {
    const a = performance.now();
    await fn();
    t.push(performance.now() - a);
  }
  return median(t);
}

// ── pool ──
const POOL = 8;
const t0 = performance.now();
const workers = [];
for (let i = 0; i < POOL; i += 1)
  workers.push(new Worker(join(HERE, 'worker.mjs'), { workerData: { sab } }));
let nextId = 1;
const waiters = new Map();
for (const w of workers)
  w.on('message', (m) => {
    waiters.get(m.id)();
    waiters.delete(m.id);
  });
const call = (w, msg) =>
  new Promise((res) => {
    const id = nextId++;
    waiters.set(id, res);
    w.postMessage({ ...msg, id });
  });
await Promise.all(workers.map((w) => call(w, { kind: 'ping' })));
const poolStartMs = performance.now() - t0;

// warm every worker's kernels through tier-up (small jobs, many reps)
const warmOut = new SharedArrayBuffer(N * 8);
for (let r = 0; r < 300; r += 1) {
  await Promise.all(
    workers.map((w, i) =>
      call(w, {
        kind: r % 2 ? 'mean' : 'std',
        outSab: warmOut,
        start: i * 2000,
        end: i * 2000 + 1000,
        w: 20,
      }),
    ),
  );
}
// warm main twins too
{
  const o = new Float64Array(N);
  for (let r = 0; r < 300; r += 1) {
    rollingMean(o, 0, 1000, 20);
    rollingStd(o, 0, 1000, 20);
  }
}

// 1 ── dispatch/join floor: one no-op round trip, and an 8-way join
const ping1 = await benchAsync(() => call(workers[0], { kind: 'ping' }), 200);
const ping8 = await benchAsync(
  () => Promise.all(workers.map((w) => call(w, { kind: 'ping' }))),
  200,
);

// 2 ── the polars-mt shape: four independent full-column outputs
// (sma20, sma50, sma200, std20 — the strategy-stack ingredients)
const outs = Array.from({ length: 4 }, () => new SharedArrayBuffer(N * 8));
const outViews = outs.map((o) => new Float64Array(o));
const JOBS = [
  { kind: 'mean', w: 20 },
  { kind: 'mean', w: 50 },
  { kind: 'mean', w: 200 },
  { kind: 'std', w: 20 },
];
const seqMain = bench(() => {
  rollingMean(outViews[0], 0, N, 20);
  rollingMean(outViews[1], 0, N, 50);
  rollingMean(outViews[2], 0, N, 200);
  rollingStd(outViews[3], 0, N, 20);
});
const parWorkers = await benchAsync(() =>
  Promise.all(
    JOBS.map((j, i) =>
      call(workers[i], { ...j, outSab: outs[i], start: 0, end: N }),
    ),
  ),
);

// 3 ── intra-kernel: ONE sma(20) chunked across k workers, fixed grid
const oneOut = new SharedArrayBuffer(N * 8);
const seqOne = bench(() => rollingMean(new Float64Array(oneOut), 0, N, 20));
const chunkRows = [];
for (const k of [1, 2, 4, 8]) {
  const step = Math.ceil(N / k);
  const ms = await benchAsync(() =>
    Promise.all(
      Array.from({ length: k }, (_, i) =>
        call(workers[i], {
          kind: 'mean',
          outSab: oneOut,
          start: i * step,
          end: Math.min(N, (i + 1) * step),
          w: 20,
        }),
      ),
    ),
  );
  chunkRows.push({ k, ms: ms.toFixed(3), x: (seqOne / ms).toFixed(2) });
}

console.log(
  JSON.stringify(
    {
      cores: (await import('node:os')).availableParallelism(),
      poolStartMs: poolStartMs.toFixed(1),
      ping1Ms: ping1.toFixed(4),
      ping8Ms: ping8.toFixed(4),
      fourOutputs: {
        seqMainMs: seqMain.toFixed(2),
        parWorkersMs: parWorkers.toFixed(2),
        speedup: (seqMain / parWorkers).toFixed(2),
      },
      oneSmaChunked: { seqMs: seqOne.toFixed(2), rows: chunkRows },
    },
    null,
    2,
  ),
);
for (const w of workers) await w.terminate();
