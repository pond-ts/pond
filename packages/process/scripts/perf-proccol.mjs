// [PND-PROCCOL] — what the boxed fold path costs, and what removing it saves.
//
// Node values became columns some time ago; what stayed boxed was the fold
// context. `densify()` allocated an `Array<number | undefined>` per fold
// input per version — the graph's single largest heap cost, and pure waste
// for a fold like `latest`, which reads one cell.
//
// Two numbers matter and they are different numbers. HEAP is what becomes GC
// pause time. TIME is what the caller waits. The columnar path is expected to
// win the first decisively and roughly tie the second — a buffer walk only
// reaches parity with a boxed array, and `Column.scan()` is slower than both.
// Anyone claiming columns are "faster to read" has not measured it.
//
// Run:  node --expose-gc packages/process/scripts/perf-proccol.mjs
//       BOXED=1 node --expose-gc packages/process/scripts/perf-proccol.mjs

import { performance } from 'node:perf_hooks';
import { bind, run } from '../dist/index.js';
import setup, { makeBars } from './fixtures/studies-setup.mjs';

const ROWS = Number(process.env.ROWS ?? 500_000);
const FOLDS = Number(process.env.FOLDS ?? 20);
const BOXED = process.env.BOXED === '1';
const mb = (n) => `${(n / 1024 / 1024).toFixed(0)} MB`;
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

// The boxed path is still reachable — `ctx.values` is a lazy getter, not a
// deletion — so both can be measured against one fixture in one script.
const latestBoxed = {
  kind: 'fold',
  name: 'latestBoxed',
  family: 'read',
  summary: 'latest, via the boxed fold context.',
  params: {},
  inputs: [{ role: 'source' }],
  unit: 'inherit',
  label: () => 'latestBoxed',
  fold: (ctx) => {
    const v = ctx.values['source'];
    for (let i = v.length - 1; i >= 0; i -= 1) {
      if (v[i] !== undefined) return { value: v[i], at: ctx.at(i) };
    }
    return { value: null };
  },
};

const base = setup({ rows: ROWS }).registry;
const registry = BOXED ? base.define(latestBoxed) : base;
const foldName = BOXED ? 'latestBoxed' : 'last';
const series = makeBars(ROWS);

// N distinct SMAs, each read by a fold: N fold evaluations over N packed
// columns, which is the shape a fact-heavy agent session produces.
const smas = Array.from({ length: FOLDS }, (_, i) => ({
  op: 'sma',
  params: { period: 10 + i },
  inputs: ['close'],
}));
const folds = smas.map((s) => ({ op: foldName, inputs: [s] }));

function once() {
  const graph = bind(series, { registry });
  return run(graph, {
    plan: folds,
    select: folds.map((f) => ({ on: f })),
    assemble: false,
  });
}

globalThis.gc?.();
const before = process.memoryUsage();
const t0 = performance.now();
const out = once();
const cold = performance.now() - t0;
// Measured BEFORE collecting. The densified arrays are garbage the moment
// the fold returns, so a post-gc delta reports ~0 for both paths and says
// nothing — what costs pause time is the garbage produced, not the bytes
// retained. This is allocation pressure, which is the thing.
const peak = process.memoryUsage();
globalThis.gc?.();
const after = process.memoryUsage();

const t = [];
for (let i = 0; i < 5; i += 1) {
  const s = performance.now();
  once();
  t.push(performance.now() - s);
}

console.log(
  `${BOXED ? 'BOXED    (ctx.values)' : 'COLUMNAR (ctx.numeric)'} · ` +
    `${FOLDS} folds x ${ROWS.toLocaleString()} rows · node ${process.versions.node}`,
);
console.log(
  `  heap at peak  ${mb(peak.heapUsed - before.heapUsed).padStart(8)}   <- garbage produced; this is pause time`,
);
console.log(
  `  heap retained ${mb(after.heapUsed - before.heapUsed).padStart(8)}   <- after gc`,
);
console.log(
  `  arrayBuffers  ${mb(after.arrayBuffers - before.arrayBuffers).padStart(8)}   <- off-heap, sizeable, transferable`,
);
console.log(`  rss           ${mb(after.rss - before.rss).padStart(8)}`);
console.log(`  cold          ${cold.toFixed(1).padStart(8)} ms`);
console.log(`  warm          ${median(t).toFixed(1).padStart(8)} ms`);
console.log(`  facts         ${String(out.facts?.length ?? 0).padStart(8)}`);

// `last` reads ONE cell, so the boxed path's densify is pure waste and the
// gap is total. `extremes` walks the whole column, and is the honest other
// end: it is the MIGRATED fold in both runs, so the line below is not a
// comparison — it is the absolute cost of a full-scan fold on the columnar
// path, for scale against the `last` numbers above. The parity claim itself
// was measured separately (max over 500k: boxed 0.91 ms, buffer+bitmap
// 0.96 ms, `Column.scan()` 4.27 ms) and is why the case for columns here is
// allocation, not read throughput.
const scanning = smas.map((sp) => ({ op: 'extremes', inputs: [sp] }));
function scanOnce() {
  const graph = bind(series, { registry });
  return run(graph, {
    plan: scanning,
    select: scanning.map((f) => ({ on: f })),
    assemble: false,
  });
}
scanOnce();
const st = [];
for (let i = 0; i < 5; i += 1) {
  const a = performance.now();
  scanOnce();
  st.push(performance.now() - a);
}
console.log(
  `  full-scan     ${median(st).toFixed(1).padStart(8)} ms   <- 'extremes', columnar in both runs`,
);
