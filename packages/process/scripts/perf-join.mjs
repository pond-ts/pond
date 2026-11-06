// [PND-PROCJOIN] — the join node, and what per-source invalidation buys.
//
// Complexity: the join is O(Σ rows) — every source is key-sorted, so
// inner is a k-way pointer walk and as-of a single forward pointer per
// non-base source — plus O(rows × columns) to gather the aligned columns.
// It runs once per source change, not per node.
//
// The comparison that matters is against Tidal's interim workaround: join
// the legs by hand into ONE bound series and `setSource` it, which
// dirties every node — a compare-leg tick cold-starts the primary leg.
//
// Run: node packages/process/scripts/perf-join.mjs

import { performance } from 'node:perf_hooks';
import { bind, createRegistry, int } from '../dist/index.js';
import { TimeSeries } from 'pond-ts';

const ROWS = Number(process.env.ROWS ?? 100_000);
const TICKS = Number(process.env.TICKS ?? 15);
const PERIODS = [10, 20, 50, 100, 200];
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

function bars(n, seed, skipEvery = 0) {
  const time = [];
  const px = [];
  let p = 100;
  for (let i = 0; i < n; i += 1) {
    p = Math.max(1, p + Math.sin(i * seed) * 0.4);
    if (skipEvery && i % skipEvery === 3) continue;
    time.push(i * 60_000);
    px.push(p);
  }
  return TimeSeries.fromColumns({
    name: 'bars',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'px', kind: 'number' },
    ],
    columns: { time: Float64Array.from(time), px: Float64Array.from(px) },
  });
}

const registry = createRegistry().define({
  name: 'sma',
  family: 'trend',
  summary: 'Rolling mean.',
  params: { period: int({ min: 2, default: 3 }) },
  inputs: [{ role: 'source' }],
  outputs: [{ id: '', unit: 'inherit' }],
  run: (ctx) => {
    const v = ctx.series.column(ctx.inputs.source).toFloat64Array();
    const p = ctx.params.period;
    const out = new Float64Array(v.length).fill(NaN);
    let s = 0;
    for (let i = 0; i < v.length; i += 1) {
      s += v[i];
      if (i >= p) s -= v[i - p];
      if (i >= p - 1) out[i] = s / p;
    }
    return Array.from(out, (x) => (Number.isNaN(x) ? undefined : x));
  },
});

function benchmark(label, setup) {
  const { tick, pull } = setup();
  pull();
  const times = [];
  for (let t = 0; t < TICKS; t += 1) {
    const t0 = performance.now();
    tick(t);
    pull();
    times.push(performance.now() - t0);
  }
  return { label, msPerTick: +median(times).toFixed(2) };
}

const primary = bars(ROWS, 7919);
const compareA = bars(ROWS, 104729, 50);
const compareB = bars(ROWS, 15485863, 50);
const both = (t) => (t % 2 === 0 ? compareB : compareA);

const specs = (keys) =>
  keys.flatMap((k) =>
    PERIODS.map((period) => ({ op: 'sma', params: { period }, inputs: [k] })),
  );

const results = [];
for (const how of ['inner', 'asof']) {
  const join = how === 'inner' ? { how } : { how, base: 'primary' };
  results.push(
    benchmark(`joined ${how}: compare-leg tick`, () => {
      const graph = bind({ primary, compare: compareA }, { registry, join });
      const all = specs(['primary:px', 'compare:px']);
      return {
        tick: (t) => graph.setSource('compare', both(t)),
        pull: () => all.forEach((s) => graph.columnOf(graph.compile(s), '')),
      };
    }),
  );
  results.push(
    benchmark(`hand-joined single binding (${how}): same tick`, () => {
      // The workaround: join outside, bind the result, setSource it.
      const pre = (c) =>
        bind({ primary, compare: c }, { registry, join }).series;
      const joinedA = pre(compareA);
      const joinedB = pre(compareB);
      const graph = bind(joinedA, { registry });
      const all = specs(['primary:px', 'compare:px']);
      return {
        tick: (t) => graph.setSource(t % 2 === 0 ? joinedB : joinedA),
        pull: () => all.forEach((s) => graph.columnOf(graph.compile(s), '')),
      };
    }),
  );
}
results.push(
  benchmark('join alone (inner, re-aligned per tick)', () => {
    const graph = bind(
      { primary, compare: compareA },
      { registry, join: { how: 'inner' } },
    );
    return {
      tick: (t) => graph.setSource('compare', both(t)),
      pull: () => graph.series,
    };
  }),
);

console.log(JSON.stringify({ rows: ROWS, ticks: TICKS, results }, null, 2));
