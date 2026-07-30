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
// ── A correction this script exists to prevent ──────────────────────
//
// The first version of this benchmark warmed each worker with ONE
// request and timed a single pass. It reported the pool LOSING below
// ~2 ms per request (0.94x at 50k rows) and concluded there was a
// crossover. That was wrong, and wrong for a cause already documented in
// `docs/notes/blocked-summation.md`: **V8's optimising tier is a cliff
// at roughly 800 iterations, not a curve.** One warm-up request leaves a
// worker running unoptimised code, while the in-process baseline —
// timed over repeated passes — was fully warm. The comparison was warm
// against cold.
//
// Warmed properly, the same configuration scales 3.7-4.0x at 50k rows,
// and no crossover exists anywhere in the swept range. What actually
// decides whether a pool pays is the CACHE-HIT RATE, not request size.
//
// Hence: median of several batches, each batch distinct (re-timing one
// batch would measure cache hits), and warm-up plans deliberately
// outside every timed batch.
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
const N_LABEL = String(REQUESTS);

function median(xs) {
  const a = [...xs].sort((p, q) => p - q);
  return a[a.length >> 1];
}

/** `n` distinct studies — every request is fresh compute. */
function distinctPlans(n, op = 'smaTyped') {
  return Array.from({ length: n }, (_, i) => {
    const spec = { op, params: { period: 5 + i }, inputs: ['px'] };
    return { process: [spec], select: [{ on: spec }] };
  });
}

/** `n` requests drawn from 4 distinct questions — cache-friendly. */
function repeatedPlans(n, op = 'smaTyped') {
  const pool = distinctPlans(4, op);
  return Array.from({ length: n }, (_, i) => pool[i % pool.length]);
}

// Each measurement is the MEDIAN of `PASSES` batches, and every batch
// holds DISTINCT plans. Re-timing the same batch would be meaningless —
// the second pass would be all cache hits — so the batches are carved
// out of one long list of distinct requests. Single-sample pool runs
// varied by ±40% between runs, which is more than several of the
// differences being reported.
const PASSES = Number(process.env.PERF_PASSES ?? 3);

function batches(plans) {
  const per = Math.floor(plans.length / PASSES);
  return Array.from({ length: PASSES }, (_, i) =>
    plans.slice(i * per, (i + 1) * per),
  );
}

function inProcess(plans) {
  const { registry } = setup({ rows: ROWS });
  const graph = bind(makeSeries(ROWS), { registry });
  // `run` takes `plan`; an envelope carries the same list as `process`.
  return median(
    batches(plans).map((batch) => {
      const start = performance.now();
      for (const p of batch) {
        run(graph, { plan: p.process, select: p.select, assemble: false });
      }
      return performance.now() - start;
    }),
  );
}

async function viaPool(plans, size) {
  const pool = await HostPool.start({
    setup: SETUP,
    size,
    setupOptions: { rows: ROWS },
  });
  try {
    // Warm every worker: the first requests pay module import and JIT
    // tier-up, which is start-up cost, not per-request cost. Warmed with
    // plans NOT in the timed batches, so no batch starts cached.
    await Promise.all(
      Array.from({ length: size }, (_, i) =>
        pool.run({ from: 'px', ...warmPlan(i) }),
      ),
    );
    const times = [];
    for (const batch of batches(plans)) {
      const start = performance.now();
      await Promise.all(batch.map((p) => pool.run({ from: 'px', ...p })));
      times.push(performance.now() - start);
    }
    return median(times);
  } finally {
    await pool.close();
  }
}

/** A request outside every timed batch — warm-up must not prime the cache. */
function warmPlan(i) {
  const spec = { op: 'smaTyped', params: { period: 900 + i }, inputs: ['px'] };
  return { process: [spec], select: [{ on: spec }] };
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
    const plans = build(REQUESTS * PASSES);
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
    '  while a pool still ships every answer — so it wins less, not more.\n',
);

// ── 2. What the op does matters more than how many workers you have ──
//
// The ceiling above is not a property of the pool. It is a property of
// the op. `sma` returns `new Array(n)` — a boxed array, one JS number
// object per cell — and `smaTyped` writes the same arithmetic into a
// `Float64Array`. Allocation on that scale does not just cost more, it
// PARALLELISES WORSE: it contends on memory bandwidth and on each
// isolate's GC, which is exactly the resource extra workers cannot add.
//
// Read the two in-process numbers against the two pool numbers before
// concluding anything about workers.
const HEAVY = Number(process.env.PERF_HEAVY_ROWS ?? 2_000_000);
setRows(HEAVY);
console.log(
  `  output shape — ${N_LABEL} requests · ${HEAVY.toLocaleString()} rows\n`,
);
console.log('  op output               in-process       pool   speedup');
console.log(`  ${'─'.repeat(56)}`);
for (const [label, op] of [
  ['boxed (new Array)', 'sma'],
  ['typed (Float64Array)', 'smaTyped'],
]) {
  const plans = distinctPlans(REQUESTS * PASSES, op);
  const base = inProcess(plans);
  const ms = await viaPool(plans, WORKERS);
  console.log(
    `  ${label.padEnd(22)} ${(base.toFixed(0) + 'ms').padStart(10)}` +
      ` ${(ms.toFixed(0) + 'ms').padStart(10)}` +
      ` ${((base / ms).toFixed(2) + 'x').padStart(9)}`,
  );
}
console.log(
  '\n  If typed-on-one-thread beats boxed-on-N-threads, fix the op before\n' +
    '  reaching for the pool. The sweep above uses the typed op, so its\n' +
    '  crossover is the honest one; a boxing op both costs more per request\n' +
    '  and caps lower.',
);
