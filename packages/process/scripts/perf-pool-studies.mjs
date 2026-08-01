// The pool on the REAL agent-query workload — [PND-PROCPAR].
//
// `perf-pool.mjs` sweeps a hand-rolled op to find where a pool pays.
// This asks the question that actually matters: what does it do to the
// workload the benchmarks page documents — the @pond-ts/financial
// studies, at the size that page measures them (500k 1-minute bars)?
//
// It measures a DIFFERENT AXIS from that page. Every number there is
// per-query latency, and a pool does not improve any of them: one query
// still runs single-threaded on one worker. What a pool changes is
// throughput when an agent has several questions outstanding at once,
// which that page does not measure at all.
//
// Imports the financial package by relative dist path. @pond-ts/process
// does not depend on it, and should not — this is a workspace-local
// benchmark, not a package dependency.
//
// Run:
//   npm run build --workspaces
//   node packages/process/scripts/perf-pool-studies.mjs
import { performance } from 'node:perf_hooks';
import { bind, run } from '../dist/index.js';
import { HostPool } from '../dist/pool/index.js';
import setup, { makeBars } from './fixtures/studies-setup.mjs';

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const SETUP = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/studies-setup.mjs',
);
const ROWS = 500_000,
  WORKERS = 8,
  PASSES = 3;
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

// An agent session: many DISTINCT study queries over one resident series.
// Periods vary so nothing is a cache hit — the shape the pool helps.
const OPS = ['sma', 'ema', 'bollinger', 'zscore', 'envelope'];
function distinct(n, offset = 0) {
  return Array.from({ length: n }, (_, i) => {
    const op = OPS[(i + offset) % OPS.length];
    const spec = {
      op,
      params: op === 'pctChange' ? {} : { period: 10 + i + offset },
      inputs: ['close'],
    };
    return { process: [spec], select: [{ on: spec }] };
  });
}
// The same handful of questions re-asked — the cache-friendly shape.
function repeated(n) {
  const p = distinct(5);
  return Array.from({ length: n }, (_, i) => p[i % 5]);
}

const BATCH = 16;
function inProc(plans) {
  const { registry } = setup({ rows: ROWS });
  const graph = bind(makeBars(ROWS), { registry });
  const times = [];
  for (let b = 0; b < PASSES; b += 1) {
    const batch = plans.slice(b * BATCH, (b + 1) * BATCH);
    const t = performance.now();
    for (const p of batch)
      run(graph, { plan: p.process, select: p.select, assemble: false });
    times.push(performance.now() - t);
  }
  return median(times);
}
async function viaPool(plans) {
  const pool = await HostPool.start({
    setup: SETUP,
    size: WORKERS,
    setupOptions: { rows: ROWS },
  });
  try {
    // Warm-up outside every timed batch, and enough of it to clear V8's tier.
    const warm = distinct(WORKERS * 2, 500);
    for (let r = 0; r < 2; r += 1)
      await Promise.all(warm.map((p) => pool.run({ from: 'bars', ...p })));
    const times = [];
    for (let b = 0; b < PASSES; b += 1) {
      const batch = plans.slice(b * BATCH, (b + 1) * BATCH);
      const t = performance.now();
      await Promise.all(batch.map((p) => pool.run({ from: 'bars', ...p })));
      times.push(performance.now() - t);
    }
    return median(times);
  } finally {
    await pool.close();
  }
}

console.log(
  `agent session · ${BATCH} queries/batch · ${ROWS.toLocaleString()} bars · pool(${WORKERS})\n`,
);
console.log('  workload      in-process       pool   speedup   per-query');
console.log('  ' + '─'.repeat(58));
for (const [label, plans] of [
  ['distinct', distinct(BATCH * PASSES)],
  ['repeated', repeated(BATCH * PASSES)],
]) {
  const base = inProc(plans);
  const ms = await viaPool(plans);
  console.log(
    `  ${label.padEnd(12)} ${(base.toFixed(0) + 'ms').padStart(10)} ${(ms.toFixed(0) + 'ms').padStart(10)} ${((base / ms).toFixed(2) + 'x').padStart(9)}   ${(base / BATCH).toFixed(1)}ms`,
  );
}
