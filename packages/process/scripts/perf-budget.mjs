// [PND-PROCCACHE] — does the byte budget actually hold memory steady?
//
// The unit test asserts `retainedBytes <= budget`, which is the graph
// agreeing with its own bookkeeping. This asks the process: walk a slider
// across many distinct params and watch RSS, bounded and unbounded.
//
// It also checks the thing a budget can silently break — that a
// repeat-heavy workload still HITS. A cache that bounds memory by
// throwing away what you are about to ask for is not a cache, and the
// difference shows up as recompiles rather than as memory.
//
// Run: node --expose-gc packages/process/scripts/perf-budget.mjs

import { performance } from 'node:perf_hooks';
import { bind, run } from '../dist/index.js';
import setup, { makeBars } from './fixtures/studies-setup.mjs';

const ROWS = Number(process.env.ROWS ?? 200_000);
const DISTINCT = Number(process.env.DISTINCT ?? 60);
const mb = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`;
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

const { registry } = setup({ rows: ROWS });
const series = makeBars(ROWS);
const spec = (period) => ({ op: 'sma', params: { period }, inputs: ['close'] });

function sweep(graph, periods) {
  for (const p of periods) {
    const s = spec(p);
    run(graph, { plan: [s], select: [{ on: s }], assemble: false });
  }
}

function measure(label, budgetBytes) {
  globalThis.gc?.();
  const before = process.memoryUsage();
  const graph = bind(series, {
    registry,
    ...(budgetBytes ? { budgetBytes } : {}),
  });

  // A slider walk: every param distinct, so nothing is a hit.
  const distinct = Array.from({ length: DISTINCT }, (_, i) => 5 + i);
  const t0 = performance.now();
  sweep(graph, distinct);
  const walkMs = performance.now() - t0;

  globalThis.gc?.();
  const after = process.memoryUsage();

  // Then the shape a cache exists for: a handful, re-asked. Under a
  // budget these must still hit, or the bound has eaten the benefit.
  const hot = distinct.slice(-4);
  sweep(graph, hot);
  const evictionsBefore = graph.evictions;
  const t1 = performance.now();
  for (let i = 0; i < 20; i += 1) sweep(graph, hot);
  const repeatMs = (performance.now() - t1) / 20;

  console.log(
    `  ${label.padEnd(22)} rss ${mb(after.rss - before.rss).padStart(7)}   ` +
      `retained ${mb(graph.retainedBytes).padStart(7)}   ` +
      `nodes ${String(graph.ids.length).padStart(3)}   ` +
      `evicted ${String(graph.evictions).padStart(3)}`,
  );
  console.log(
    `  ${''.padEnd(22)} walk ${walkMs.toFixed(0).padStart(5)} ms   ` +
      `repeat ${repeatMs.toFixed(2).padStart(6)} ms/pass   ` +
      `${graph.evictions === evictionsBefore ? 'repeats HIT (no eviction churn)' : `THRASHING: ${graph.evictions - evictionsBefore} evictions while repeating`}`,
  );
  return { rss: after.rss - before.rss, repeatMs };
}

console.log(
  `${DISTINCT} distinct params x ${ROWS.toLocaleString()} rows · node ${process.versions.node}\n`,
);
const unbounded = measure('unbounded', 0);
console.log();
const budget = 8 * ROWS * 8;
const bounded = measure(`budget ${mb(budget)}`, budget);
console.log(
  `\n  ${(unbounded.rss / Math.max(1, bounded.rss)).toFixed(1)}x less rss, ` +
    `repeats ${(bounded.repeatMs / unbounded.repeatMs).toFixed(2)}x the unbounded cost.`,
);
console.log(
  `  The second number is the one to watch: a budget that bounds memory by\n` +
    `  discarding what the caller asks for next reads as ~1.0x on the first\n` +
    `  and badly on the second.`,
);
