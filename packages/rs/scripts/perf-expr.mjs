// Column expressions through @pond-ts/rs ([PND-EXPR] E2b): each rule as a
// JavaScript function (called once per row from WebAssembly), as an
// expression (runs inside pond-rs), and as pond-ts's expression. Same
// data and cases as packages/core/scripts/perf-expr.mjs.
//
//     npm run build --workspace=pond-ts && packages/rs/build.sh
//     node packages/rs/scripts/perf-expr.mjs

import { performance } from 'node:perf_hooks';
import * as rs from '../index.js';

const ts = await import('../../core/dist/index.js');
const ROWS = Number(process.env.PERF_N ?? 1_000_000);
const WARMUP = 5;
const REPEATS = 11;

let seed = 20261031;
const next = () => {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 4294967296;
};
const rows = [];
let gap = 0;
for (let i = 0; i < ROWS; i++) {
  if (gap === 0 && next() < 0.02) gap = 1 + Math.floor(next() * 4);
  const w = (i % 13) + 1;
  if (gap > 0) {
    gap -= 1;
    rows.push([i * 1000, undefined, w, `h${i % 7}`]);
  } else {
    rows.push([i * 1000, (i % 1000) - 500 + next(), w, `h${i % 7}`]);
  }
}
const spec = {
  name: 'data',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'v', kind: 'number', required: false },
    { name: 'w', kind: 'number' },
    { name: 'host', kind: 'string', required: false },
  ],
  rows,
};
const a = new ts.TimeSeries(spec);
const b = new rs.TimeSeries(spec);

function benchmark(fn) {
  const run = () => {
    const r = fn();
    if (r instanceof rs.TimeSeries) r.free();
  };
  for (let i = 0; i < WARMUP; i += 1) run();
  const samples = [];
  for (let i = 0; i < REPEATS; i += 1) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  samples.sort((x, y) => x - y);
  return Number(samples[REPEATS >> 1].toFixed(2));
}

// [label, rule as (lib) => expression, rule as a function, method]
const cases = [
  ['filter v > 0', (l) => l.col('v').gt(0), (e) => e.get('v') > 0, 'filter'],
  [
    'filter v / w > 10 and host = h3',
    (l) => l.col('v').div(l.col('w')).gt(10).and(l.col('host').eq('h3')),
    (e) => e.get('v') / e.get('w') > 10 && e.get('host') === 'h3',
    'filter',
  ],
  [
    'filter sparse (v > 499.9)',
    (l) => l.col('v').gt(499.9),
    (e) => e.get('v') > 499.9,
    'filter',
  ],
  [
    'some (no match)',
    (l) => l.col('v').gt(1e9),
    (e) => e.get('v') > 1e9,
    'some',
  ],
  [
    'mapColumns v * 1.8 + 32',
    (l) => ({ v: l.col('v').mul(1.8).add(32) }),
    { v: (x) => x * 1.8 + 32 },
    'mapColumns',
  ],
];

const results = cases.map(([label, expr, fn, method]) => ({
  label,
  rsFunctionMs: benchmark(() => b[method](fn)),
  rsExprMs: benchmark(() => b[method](expr(rs))),
  pondTsExprMs: benchmark(() => a[method](expr(ts))),
}));
results.push({
  label: 'withColumn v / w',
  rsExprMs: benchmark(() => b.withColumn('r', rs.col('v').div(rs.col('w')))),
  pondTsExprMs: benchmark(() =>
    a.withColumn('r', ts.col('v').div(ts.col('w'))),
  ),
});
console.log(JSON.stringify({ rows: ROWS, results }, null, 2));
b.free();
