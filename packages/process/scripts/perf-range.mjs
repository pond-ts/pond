// [PND-PROCRANGE] — recompute only the rows a change reached.
//
// Measured: 209 -> 6.5 ms/tick, 32x, bit-identical. The plan projected
// 26x, and getting there took the `ctx.out` contract — see the note at
// the foot of this script for the two wrong turns on the way.
//
// [PND-PROCHIST] answers the same hot-edge workload at 1.3 ms/tick by
// slicing, with no incremental machinery. So the number to care about is
// not the ratio against a full recompute — it is whether ranging beats
// slicing, and where each applies.
//
// Slicing wins when the consumer only needs the visible window. Ranging
// wins when it needs the WHOLE column materialized while one row
// arrives — a chart drawing all 500k points, a fold over all history.
//
// Correctness first, as ever: every tick is checked against a
// from-scratch pass, cell for cell, before anything is timed.
//
// Run: node packages/process/scripts/perf-range.mjs

import { performance } from 'node:perf_hooks';
import { bind, run, createRegistry, int } from '../dist/index.js';
import { TimeSeries } from 'pond-ts';

const ROWS = Number(process.env.ROWS ?? 500_000);
const TICKS = Number(process.env.TICKS ?? 20);
const PERIODS = [10, 20, 50, 100, 200];
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

function bars(n) {
  const time = new Float64Array(n);
  const px = new Float64Array(n);
  let p = 100;
  for (let i = 0; i < n; i += 1) {
    p = Math.max(1, p + Math.sin(i * 7919) * 0.4);
    time[i] = i * 60_000;
    px[i] = p;
  }
  return TimeSeries.fromColumns({
    name: 'bars',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'px', kind: 'number' },
    ],
    columns: { time, px },
  });
}

// A rolling mean whose every output cell is computed from its input
// window alone — no accumulator crosses the boundary, so a patched
// result is bit-identical by construction. That independence is exactly
// the property `runRange` requires an op to have before declaring it.
function windowMean(v, i, period) {
  if (i < period - 1) return undefined;
  let sum = 0;
  for (let k = i - period + 1; k <= i; k += 1) sum += v[k];
  return sum / period;
}
function readRaw(ctx, role) {
  const col = ctx.series.column(ctx.inputs[role]);
  return col._values ?? col;
}

const registry = createRegistry().define({
  name: 'sma',
  family: 'trend',
  summary: 'Rolling mean.',
  params: { period: int({ min: 2, default: 3 }) },
  inputs: [{ role: 'source' }],
  outputs: [{ id: '', unit: 'inherit' }],
  lookback: (p) => p.period - 1,
  run: (ctx) => {
    const v = readRaw(ctx, 'source');
    const period = ctx.params.period;
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i += 1) out[i] = windowMean(v, i, period);
    return out;
  },
  runRange: (ctx) => {
    const v = readRaw(ctx, 'source');
    const period = ctx.params.period;
    // Writes ONLY [from, to). The prefix — values and validity both —
    // arrived as a block in `ctx.out`, which is what makes this O(dirty)
    // instead of O(n), and what keeps warm-up gaps as gaps.
    const out = ctx.out[0];
    for (let i = ctx.from; i < ctx.to; i += 1) {
      const m = windowMean(v, i, period);
      if (m === undefined) out.clear(i);
      else out.set(i, m);
    }
  },
});

const plan = PERIODS.map((period) => ({
  op: 'sma',
  params: { period },
  inputs: ['px'],
}));
const select = plan.map((s) => ({ on: s }));

console.log(
  `${ROWS.toLocaleString()} rows · ${PERIODS.length} studies · ${TICKS} ticks · node ${process.versions.node}\n`,
);

// ── correctness, before any timing ──────────────────────────────
const graph = bind(bars(ROWS), { registry });
run(graph, { plan, select, assemble: false });
let mismatched = 0;
for (let t = 1; t <= 5; t += 1) {
  const grown = bars(ROWS + t);
  graph.setSourceFrom(grown, ROWS + t - 1);
  const inc = run(graph, { plan, select, assemble: false });
  const scratch = run(bind(grown, { registry }), {
    plan,
    select,
    assemble: false,
  });
  for (const name of Object.keys(inc.columns)) {
    const a = inc.columns[name];
    const b = scratch.columns[name];
    for (let i = 0; i < a.length; i += 1) {
      if (!Object.is(a.at(i), b.at(i))) mismatched += 1;
    }
  }
}
console.log(
  `  bit-identical to from-scratch   ${mismatched === 0 ? '✅ over 5 ticks × 5 studies' : `❌ ${mismatched} cells differ`}\n`,
);

// ── cost ────────────────────────────────────────────────────────
function tickFull() {
  const g = bind(bars(ROWS), { registry });
  run(g, { plan, select, assemble: false });
  const t = [];
  for (let i = 1; i <= TICKS; i += 1) {
    const grown = bars(ROWS + i);
    g.setSource(grown); // no claim ⇒ full recompute
    const s = performance.now();
    run(g, { plan, select, assemble: false });
    t.push(performance.now() - s);
  }
  return { ms: median(t), recomputes: g.recomputes };
}
function tickRanged() {
  const g = bind(bars(ROWS), { registry });
  run(g, { plan, select, assemble: false });
  const t = [];
  for (let i = 1; i <= TICKS; i += 1) {
    const grown = bars(ROWS + i);
    g.setSourceFrom(grown, ROWS + i - 1);
    const s = performance.now();
    run(g, { plan, select, assemble: false });
    t.push(performance.now() - s);
  }
  return { ms: median(t), recomputes: g.recomputes };
}

const full = tickFull();
const ranged = tickRanged();
console.log(
  `  full recompute        ${full.ms.toFixed(2).padStart(9)} ms/tick   ranged ${full.recomputes.ranged}`,
);
console.log(
  `  dirty-per-range       ${ranged.ms.toFixed(2).padStart(9)} ms/tick   ranged ${ranged.recomputes.ranged}   ` +
    `${(full.ms / ranged.ms).toFixed(0)}×`,
);
console.log(
  `\n  The op writes ONLY [from, to). An earlier version rebuilt the whole\n` +
    `  output, carrying the ${ROWS.toLocaleString()}-cell prefix by hand with a \`.at(i)\` per\n` +
    `  cell into a boxed Array — O(n) per study per tick, and it held this\n` +
    `  at 4x. The graph was never the bottleneck; the prefix walk was.\n\n` +
    `  Copying the prefix as a typed-array block got 13x AND 1,875 WRONG\n` +
    `  CELLS: packed storage holds 0 at a missing cell, not NaN, so the\n` +
    `  memcpy turned every warm-up gap into a defined zero. Validity has to\n` +
    `  move with the values, which is why \`ctx.out\` exists rather than a\n` +
    `  documented convention — the graph prepares both as blocks and the op\n` +
    `  cannot get it wrong by omission.\n\n` +
    `  For scale: [PND-PROCHIST] answers the hot-edge workload at ~1.3\n` +
    `  ms/tick by slicing, with no incremental machinery at all. Ranging\n` +
    `  earns its keep where the whole column must stay materialized — a\n` +
    `  chart drawing every point while one row arrives.`,
);
