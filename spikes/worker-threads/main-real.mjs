import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { availableParallelism } from 'node:os';
import { TimeSeries } from '../../packages/core/dist/index.js';
import { sma, bollinger, zScore } from '../../packages/financial/dist/index.js';

const N = 500_000;
const timeSab = new SharedArrayBuffer(N * 8);
const closeSab = new SharedArrayBuffer(N * 8);
const time = new Float64Array(timeSab);
const close = new Float64Array(closeSab);
let price = 100;
let seed = 0x5eed;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) & 0xffffffff;
  return ((seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
};
for (let i = 0; i < N; i += 1) {
  time[i] = i * 60_000;
  price = Math.max(1, price + (rnd() - 0.5) * 0.4);
  close[i] = price;
}

const bars = TimeSeries.fromColumns({
  name: 'bars',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'close', kind: 'number' },
  ],
  columns: { time, close },
});

// The 5-study stack: job → (study, column to read back)
const STACK = [
  ['bollinger20', 'bbMiddle'],
  ['zscore20', 'zscore'],
  ['sma200', 'sma'],
  ['sma50', 'sma'],
  ['sma20', 'sma'],
];
const MAIN = {
  sma20: () => sma(bars, { period: 20 }),
  sma50: () => sma(bars, { period: 50 }),
  sma200: () => sma(bars, { period: 200 }),
  bollinger20: () => bollinger(bars, { period: 20 }),
  zscore20: () => zScore(bars, { period: 20 }),
};

function median(xs) {
  const a = [...xs].sort((p, q) => p - q);
  return a[a.length >> 1];
}
async function benchAsync(fn, reps = 11) {
  const t = [];
  for (let r = 0; r < reps; r += 1) {
    const a = performance.now();
    await fn();
    t.push(performance.now() - a);
  }
  return median(t);
}

// pool sized to the stack
const POOL = 5;
const t0 = performance.now();
const workers = Array.from(
  { length: POOL },
  () =>
    new Worker(new URL('./worker-real.mjs', import.meta.url), {
      workerData: { timeSab, closeSab },
    }),
);
let nextId = 1;
const waiters = new Map();
for (const w of workers)
  w.on('message', (m) => {
    waiters.get(m.id)(m);
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

// Warm both sides through tier-up: full-size jobs, enough reps.
for (let r = 0; r < 8; r += 1) {
  for (const [study] of STACK) MAIN[study]();
  await Promise.all(
    STACK.map(([study, readback], i) =>
      call(workers[i], { kind: 'study', study, readback }),
    ),
  );
}

const seqMs = await benchAsync(() => {
  for (const [study] of STACK) MAIN[study]();
});
const parMs = await benchAsync(() =>
  Promise.all(
    STACK.map(([study, readback], i) =>
      call(workers[i], { kind: 'study', study, readback }),
    ),
  ),
);

// Per-study times on main, for the critical-path check
const per = {};
for (const [study] of STACK) {
  const t = [];
  for (let r = 0; r < 9; r += 1) {
    const a = performance.now();
    MAIN[study]();
    t.push(performance.now() - a);
  }
  per[study] = median(t).toFixed(2);
}

console.log(
  JSON.stringify(
    {
      cores: availableParallelism(),
      poolStartMs: poolStartMs.toFixed(1),
      perStudyMainMs: per,
      stackSequentialMs: seqMs.toFixed(2),
      stackParallelMs: parMs.toFixed(2),
      speedup: (seqMs / parMs).toFixed(2),
    },
    null,
    2,
  ),
);
for (const w of workers) await w.terminate();
