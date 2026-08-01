import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const HERE = dirname(fileURLToPath(import.meta.url));

const N = Number(process.env.N ?? 2_000_000);
const PERIOD = Number(process.env.PERIOD ?? 20), alpha = 2 / (PERIOD + 1), a = 1 - alpha;
const K = Number(process.env.K ?? 8);

const xs = new SharedArrayBuffer(N * 8), ys = new SharedArrayBuffer(N * 8);
const cs = new SharedArrayBuffer(K * 2 * 8);
const x = new Float64Array(xs), y = new Float64Array(ys), carry = new Float64Array(cs);
for (let i = 0; i < N; i += 1) x[i] = 100 + Math.sin(i / 1000) * 10;

// The reference: the ordinary sequential recurrence.
const ref = new Float64Array(N);
function sequential() { let v = 0; for (let i = 0; i < N; i += 1) { v = a * v + alpha * x[i]; ref[i] = v; } }

const median = (t) => [...t].sort((p, q) => p - q)[t.length >> 1];
const bench = (f, r = 7) => { const t = []; for (let i = 0; i < r; i += 1) { const s = performance.now(); f(); t.push(performance.now() - s); } return median(t); };
const benchA = async (f, r = 7) => { const t = []; for (let i = 0; i < r; i += 1) { const s = performance.now(); await f(); t.push(performance.now() - s); } return median(t); };

const workers = Array.from({ length: K }, () => new Worker(join(HERE, 'worker.mjs'), { workerData: { x: xs, y: ys, carry: cs } }));
let id = 1; const waits = new Map();
for (const w of workers) w.on('message', (m) => { waits.get(m.id)?.(); waits.delete(m.id); });
const call = (w, msg) => new Promise((res) => { const i = id++; waits.set(i, res); w.postMessage({ ...msg, id: i }); });
await Promise.all(workers.map((w) => call(w, { kind: 'ping' })));

const step = Math.ceil(N / K);
const bounds = Array.from({ length: K }, (_, c) => [c * step, Math.min(N, (c + 1) * step)]);

async function parallelScan() {
  // Phase 1 — every chunk independently, in parallel.
  await Promise.all(bounds.map(([s, e], c) => call(workers[c], { kind: 'p1', s, e, c, a, alpha })));
  // Phase 2 — K sequential steps on the main thread. K is 8, not N.
  const incoming = new Float64Array(K);
  let v = 0;
  for (let c = 0; c < K; c += 1) { incoming[c] = v; v = carry[c * 2] + carry[c * 2 + 1] * v; }
  // Phase 3 — apply each chunk's correction, in parallel.
  await Promise.all(bounds.map(([s, e], c) => call(workers[c], { kind: 'p3', s, e, a, incoming: incoming[c] })));
}

// Warm both paths past V8's tier-up cliff before timing anything.
for (let i = 0; i < 12; i += 1) { sequential(); await parallelScan(); }

const seqMs = bench(sequential);
const parMs = await benchA(parallelScan);

let maxRel = 0, exact = 0;
for (let i = 0; i < N; i += 1) {
  const d = Math.abs(y[i] - ref[i]);
  if (d === 0) exact += 1;
  const r = d / Math.max(1e-300, Math.abs(ref[i]));
  if (r > maxRel) maxRel = r;
}
console.log(`EMA(${PERIOD}) over ${N.toLocaleString()} · ${K} workers\n`);
console.log(`  sequential recurrence   ${seqMs.toFixed(2)} ms`);
console.log(`  parallel scan (3-phase) ${parMs.toFixed(2)} ms   ${(seqMs / parMs).toFixed(2)}x`);
console.log(`\n  bit-identical cells     ${((exact / N) * 100).toFixed(2)}%`);
console.log(`  max relative difference ${maxRel.toExponential(2)}`);
for (const w of workers) await w.terminate();
