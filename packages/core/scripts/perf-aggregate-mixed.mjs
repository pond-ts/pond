// [PND-AGGSIBLING] aggregate calls that mix a column with a columnar kernel
// (`sum`, `avg`, …) and one without (`unique`, `count` over text, a custom
// function). Before the fix such a call went wholesale to the row path;
// now each column is planned on its own.
//
//   npm run build && node scripts/perf-aggregate-mixed.mjs
import { performance } from 'node:perf_hooks';
import { Sequence, TimeSeries } from '../dist/index.js';

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
  { name: 'w', kind: 'number' },
  { name: 'host', kind: 'string' },
]);

function makeSeries(length, stepMs) {
  return new TimeSeries({
    name: 'bench',
    schema,
    rows: Array.from({ length }, (_, i) => [
      i * stepMs,
      ((i * 2654435761) % 4294967291) / 4294967291,
      (i % 97) / 7,
      `h${i % 5}`,
    ]),
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function benchmark(run, repeats = 7) {
  run();
  const samples = [];
  for (let r = 0; r < repeats; r += 1) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  return Number(median(samples).toFixed(2));
}

const mappings = {
  numeric: { v: 'sum', w: 'avg' },
  'with unique': { v: 'sum', w: 'avg', u: { from: 'host', using: 'unique' } },
  'with text count': {
    v: 'sum',
    w: 'avg',
    n: { from: 'host', using: 'count' },
  },
  'with custom': {
    v: 'sum',
    w: 'avg',
    c: { from: 'host', using: (xs) => xs.length, kind: 'number' },
  },
};

const workloads = [
  // 100k events on a 1s grid, 1-minute buckets
  ['typical 100k / 1m', makeSeries(100_000, 1_000), Sequence.every('1m')],
  // ~1 event per bucket: the per-bucket fixed cost
  ['floor 100k / 1s', makeSeries(100_000, 1_000), Sequence.every('1s')],
  // sparse source on a dense grid: mostly empty buckets
  ['sparse 10k@10s / 1s', makeSeries(10_000, 10_000), Sequence.every('1s')],
];

const results = {};
for (const [label, series, seq] of workloads) {
  for (const [name, mapping] of Object.entries(mappings)) {
    results[`${label} ${name}`] = benchmark(() =>
      series.aggregate(seq, mapping),
    );
  }
}
// Partitioned by host (the auto-injected `host: 'first'` stays columnar).
const series = makeSeries(100_000, 1_000);
for (const [name, mapping] of Object.entries(mappings)) {
  results[`partitioned 100k / 1m ${name}`] = benchmark(() =>
    series
      .partitionBy('host')
      .aggregate(Sequence.every('1m'), mapping)
      .collect(),
  );
}
console.log(JSON.stringify(results, null, 2));
