import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TimeSeries } from 'pond-ts';
const R = '/Users/peter/Code/pond-ts/.claude/worktrees/unruffled-bardeen-b42902';
const { bollinger, zScore } = await import(R + '/packages/financial/dist/index.js');
const HERE = dirname(fileURLToPath(import.meta.url));

const N = Number(process.env.N ?? 500_000), P = 20, KMAX = 8;
const xs = new SharedArrayBuffer(N * 8);
const x = new Float64Array(xs);
let price = 100, seed = 0x5eed;
const time = new Float64Array(N);
for (let i = 0; i < N; i += 1) {
  seed = (seed + 0x6d2b79f5) >>> 0;
  const r = ((seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  price = Math.max(1, price + (r - 0.5) * 0.4);
  time[i] = i * 60000; x[i] = price;
}
const bars = TimeSeries.fromColumns({ name: 'bars',
  schema: [{ name: 'time', kind: 'time' }, { name: 'close', kind: 'number' }],
  columns: { time, close: Float64Array.from(x) } });

const outs = Array.from({ length: 3 }, () => new SharedArrayBuffer(N * 8));
const views = outs.map((b) => new Float64Array(b));
const workers = Array.from({ length: KMAX }, () => new Worker(join(HERE, 'worker.mjs'), { workerData: { x: xs, out: outs } }));
let id = 1; const waits = new Map();
for (const w of workers) w.on('message', (m) => { waits.get(m.id)?.(); waits.delete(m.id); });
const call = (w, msg) => new Promise((res) => { const i = id++; waits.set(i, res); w.postMessage({ ...msg, id: i }); });
await Promise.all(workers.map((w) => call(w, { kind: 'ping' })));

async function chunked(study, K) {
  const step = Math.ceil(N / K);
  await Promise.all(Array.from({ length: K }, (_, c) =>
    call(workers[c], { kind: 'run', study, s: c * step, e: Math.min(N, (c + 1) * step), p: P, k: 2 })));
}
const median = (t) => [...t].sort((a, b) => a - b)[t.length >> 1];
const benchA = async (f, r = 7) => { const t = []; for (let i = 0; i < r; i += 1) { const s = performance.now(); await f(); t.push(performance.now() - s); } return median(t); };
const bench = (f, r = 7) => { const t = []; for (let i = 0; i < r; i += 1) { const s = performance.now(); f(); t.push(performance.now() - s); } return median(t); };

console.log(`${N.toLocaleString()} bars · period ${P} · ${KMAX} workers\n`);
for (const study of ['bollinger', 'zScore']) {
  // Warm everything past V8's tier cliff before timing.
  for (let i = 0; i < 12; i += 1) { await chunked(study, KMAX); await chunked(study, 1); }
  const pondFn = study === 'bollinger' ? () => bollinger(bars, { period: P }) : () => zScore(bars, { period: P });
  for (let i = 0; i < 12; i += 1) pondFn();

  const one = await benchA(() => chunked(study, 1));
  const many = await benchA(() => chunked(study, KMAX));
  const pondMs = bench(pondFn);

  // Numerics: chunked vs the SAME kernel unchunked — the meaningful
  // comparison for "does partitioning change the answer".
  await chunked(study, KMAX);
  const par = views.map((v) => Float64Array.from(v));
  await chunked(study, 1);
  const seq = views.map((v) => Float64Array.from(v));
  let maxRel = 0, exact = 0, cells = 0; const rels = []; let worstSd = 0;
  const nOut = study === 'bollinger' ? 3 : 1;
  for (let j = 0; j < nOut; j += 1) for (let i = P; i < N; i += 1) {
    cells += 1;
    const d = Math.abs(par[j][i] - seq[j][i]);
    if (d === 0) exact += 1;
    const rel = d / Math.max(1e-300, Math.abs(seq[j][i]));
    if (rel > maxRel) maxRel = rel;
    if (rel > 0) rels.push(rel);
  }
  console.log(`  ${study}`);
  console.log(`    pond today (1 thread)      ${pondMs.toFixed(2)} ms`);
  console.log(`    spike kernel, 1 worker     ${one.toFixed(2)} ms`);
  console.log(`    spike kernel, ${KMAX} workers    ${many.toFixed(2)} ms   ${(one / many).toFixed(2)}x vs itself, ${(pondMs / many).toFixed(2)}x vs pond`);
  rels.sort((a,b)=>a-b);
  const q = (f) => rels.length ? rels[Math.floor(rels.length*f)] : 0;
  console.log(`    chunk-vs-whole: ${((exact / cells) * 100).toFixed(2)}% bit-identical, max rel ${maxRel.toExponential(2)}`);
  console.log(`    differing-cell rel error: median ${q(0.5).toExponential(1)}, p99 ${q(0.99).toExponential(1)}, worst ${maxRel.toExponential(1)}`);
  console.log(`    cells worse than 1e-9: ${rels.filter(r=>r>1e-9).length} of ${cells}\n`);
}
for (const w of workers) await w.terminate();
