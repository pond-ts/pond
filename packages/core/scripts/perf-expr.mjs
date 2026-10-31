// Perf bench for column expressions — [PND-EXPR]. Each case times the
// function form and the expression form of the same rule on 1M rows
// (~2% of `v` missing in short runs, a text column with 7 values).
//
//     npm run build --workspace=pond-ts
//     node packages/core/scripts/perf-expr.mjs
//
// Cases cover the expression shapes: one comparison (literal spread), two
// columns combined, text equality, a sparse match (few kept rows), and
// mapColumns / withColumn (one output column). `PERF_N` changes the size.

import { performance } from 'node:perf_hooks';

const { TimeSeries, col } = await import('../dist/index.js');

const ROWS = Number(process.env.PERF_N ?? 1_000_000);
const WARMUP = Number(process.env.PERF_WARMUP ?? 10);
const REPEATS = Number(process.env.PERF_REPEATS ?? 15);

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
const s = new TimeSeries({
  name: 'data',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'v', kind: 'number', required: false },
    { name: 'w', kind: 'number' },
    { name: 'host', kind: 'string', required: false },
  ],
  rows,
});

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function benchmark(fn) {
  for (let i = 0; i < WARMUP; i += 1) fn();
  const samples = [];
  for (let i = 0; i < REPEATS; i += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return Number(median(samples).toFixed(2));
}

const cases = [
  [
    'filter v > 0',
    () => s.filter((e) => e.get('v') > 0),
    () => s.filter(col('v').gt(0)),
  ],
  [
    'filter v / w > 10 and host = h3',
    () =>
      s.filter((e) => e.get('v') / e.get('w') > 10 && e.get('host') === 'h3'),
    () => s.filter(col('v').div(col('w')).gt(10).and(col('host').eq('h3'))),
  ],
  [
    'filter sparse (v > 499.9)',
    () => s.filter((e) => e.get('v') > 499.9),
    () => s.filter(col('v').gt(499.9)),
  ],
  [
    'some (no match: scans all)',
    () => s.some((e) => e.get('v') > 1e9),
    () => s.some(col('v').gt(1e9)),
  ],
  [
    'mapColumns v * 1.8 + 32',
    () => s.mapColumns({ v: (x) => x * 1.8 + 32 }),
    () => s.mapColumns({ v: col('v').mul(1.8).add(32) }),
  ],
  [
    'withColumn v / w',
    () => {
      const v = s.column('v');
      const w = s.column('w');
      const out = new Float64Array(s.length);
      for (let i = 0; i < out.length; i += 1) out[i] = v.at(i) / w.at(i);
      return s.withColumn('r', out);
    },
    () => s.withColumn('r', col('v').div(col('w'))),
  ],
];

const results = cases.map(([label, fn, expr]) => {
  const fnMs = benchmark(fn);
  const exprMs = benchmark(expr);
  return { label, fnMs, exprMs, speedup: Number((fnMs / exprMs).toFixed(1)) };
});
console.log(JSON.stringify({ rows: ROWS, results }, null, 2));
