// Throughput scaling for `HostPool` — [PND-PROCPAR].
//
// The worker-threads assessment separates two wins and warns against
// conflating them. This measures the one `HostPool` implements:
// **throughput under concurrent queries**, whole requests routed across
// resident hosts. (The other — splitting one query's nodes to cut its
// latency — needs an engine change and is not what this measures.)
//
// What it compares, on the same work:
//
//   in-process   one Host, requests answered one after another
//   pool(N)      N workers, each a long-lived Host, requests in flight
//
// Two workloads, because they answer different questions:
//
//   distinct   every request is a different study, so nothing is cached
//              and the pool is scaling real compute. This is the honest
//              scaling number.
//   repeated   the same handful of questions re-asked. Each worker warms
//              its OWN graph, so a pool holds up to N copies of a hot
//              column and wins less than the distinct case — the cost of
//              the simple shape, measured rather than hand-waved.
//
// Run:
//   npm run build --workspaces
//   node packages/process/scripts/perf-pool.mjs

import { performance } from 'node:perf_hooks';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { TimeSeries } from 'pond-ts';
import { bind, run } from '../dist/index.js';
import { HostPool } from '../dist/pool/index.js';
import setup, { makeSeries } from './fixtures/perf-setup.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SETUP = resolve(HERE, 'fixtures/perf-setup.mjs');
let ROWS = Number(process.env.PERF_ROWS ?? 200_000);
/** The sweep varies per-request work by varying the row count. */
function setRows(rows) {
  ROWS = rows;
}
const REQUESTS = Number(process.env.PERF_REQUESTS ?? 32);

function median(xs) {
  const a = [...xs].sort((p, q) => p - q);
  return a[a.length >> 1];
}

/** `n` distinct studies — every request is fresh compute. */
function distinctPlans(n) {
  return Array.from({ length: n }, (_, i) => {
    const spec = { op: 'sma', params: { period: 5 + i }, inputs: ['px'] };
    return { process: [spec], select: [{ on: spec }] };
  });
}

/** `n` requests drawn from 4 distinct questions — cache-friendly. */
function repeatedPlans(n) {
  const pool = distinctPlans(4);
  return Array.from({ length: n }, (_, i) => pool[i % pool.length]);
}

async function inProcess(plans) {
  const { registry } = setup({ rows: ROWS });
  const graph = bind(makeSeries(ROWS), { registry });
  // `run` takes `plan`; an envelope carries the same list as `process`.
  const start = performance.now();
  for (const p of plans) {
    run(graph, { plan: p.process, select: p.select, assemble: false });
  }
  return performance.now() - start;
}

async function viaPool(plans, size) {
  const pool = await HostPool.start({
    setup: SETUP,
    size,
    setupOptions: { rows: ROWS },
  });
  try {
    // Warm every worker: the first request per worker pays module import
    // and JIT tier-up, which is start-up cost, not per-request cost.
    await Promise.all(
      Array.from({ length: size }, () => pool.run({ from: 'px', ...plans[0] })),
    );
    const start = performance.now();
    await Promise.all(plans.map((p) => pool.run({ from: 'px', ...p })));
    return performance.now() - start;
  } finally {
    await pool.close();
  }
}

const cores = availableParallelism();
const WORKERS = Number(
  process.env.PERF_WORKERS ?? Math.min(8, Math.max(1, cores - 1)),
);

// The output that matters is the CROSSOVER, not one number. A pool wins
// only when a request's own compute outweighs what routing it costs —
// dispatch, plus copying and shipping its answer. Below that line it
// loses, and the loss is not small. So the sweep is over per-request
// work, and the per-request millisecond column is the x-axis a reader
// should actually match their own workload against.
const SIZES = (process.env.PERF_SWEEP ?? '50000,200000,500000,2000000')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

console.log(
  `${REQUESTS} requests · pool(${WORKERS}) · ${cores} cores · node ${process.versions.node}\n`,
);
console.log(
  '  workload                rows    per-req   in-process       pool   speedup',
);
console.log(`  ${'─'.repeat(72)}`);

for (const [name, build] of [
  ['distinct', distinctPlans],
  ['repeated', repeatedPlans],
]) {
  for (const rows of SIZES) {
    setRows(rows);
    const plans = build(REQUESTS);
    const base = median([
      await inProcess(plans),
      await inProcess(plans),
      await inProcess(plans),
    ]);
    const ms = await viaPool(plans, WORKERS);
    const perRequest = base / REQUESTS;
    console.log(
      `  ${name.padEnd(10)} ${rows.toLocaleString().padStart(11)}` +
        ` ${(perRequest.toFixed(1) + 'ms').padStart(10)}` +
        ` ${(base.toFixed(0) + 'ms').padStart(12)}` +
        ` ${(ms.toFixed(0) + 'ms').padStart(10)}` +
        ` ${((base / ms).toFixed(2) + 'x').padStart(9)}`,
    );
  }
  console.log();
}

console.log(
  '  distinct = every request a different study (no cache reuse).\n' +
    '  repeated = 4 questions re-asked; in-process serves those from cache,\n' +
    '  while a pool still ships every answer — so it wins less, not more.',
);
