// Perf bench for `shift`, `fill` and `mapColumns` — [PND-BOXFREE] second
// tranche. Same data as `crates/pond-rs/bench/rowwise_pond_ts.mjs`
// (1M rows, ~2% of cells missing in short runs of 1–4), so the numbers
// line up with the pond-rs comparison that found the cost.
//
//     npm run build --workspace=pond-ts
//     node packages/core/scripts/perf-fill-shift-map.mjs
//
// `POND_DIST=/path/to/dist` benchmarks another build (e.g. a copy of
// `dist/` taken before a change), so before/after run the same script.
//
// Warm-up is by iteration count (see perf-operators-unboxed.mjs for why
// elapsed-time warm-up misleads). 1M rows keeps each call in the tens of
// ms, so 40 warm-up iterations is affordable even for the slow build.

import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const dist = process.env.POND_DIST
  ? pathToFileURL(path.resolve(process.env.POND_DIST, 'index.js')).href
  : '../dist/index.js';
const { TimeSeries } = await import(dist);

const ROWS = Number(process.env.PERF_N ?? 1_000_000);
const WARMUP = Number(process.env.PERF_WARMUP ?? 40);
const REPEATS = Number(process.env.PERF_REPEATS ?? 15);

let seed = 20261019;
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
  if (gap > 0) {
    gap -= 1;
    rows.push([i * 1000, undefined, undefined]);
  } else {
    rows.push([i * 1000, (i % 1000) + next(), `h${i % 7}`]);
  }
}
const s = new TimeSeries({
  name: 'data',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'v', kind: 'number', required: false },
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

function benchmark(label, fn) {
  for (let i = 0; i < WARMUP; i += 1) fn();
  const samples = [];
  for (let i = 0; i < REPEATS; i += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return { label, medianMs: Number(median(samples).toFixed(2)) };
}

const cases = [
  ['diff (reference, already unboxed)', () => s.diff('v')],
  ['shift 1', () => s.shift('v', 1)],
  ['shift -3', () => s.shift('v', -3)],
  ['fill hold', () => s.fill({ v: 'hold' })],
  ['fill bfill', () => s.fill({ v: 'bfill' })],
  ['fill zero', () => s.fill({ v: 'zero' })],
  ['fill linear', () => s.fill({ v: 'linear' })],
  ['fill linear maxGap 3s', () => s.fill({ v: 'linear' }, { maxGap: '3s' })],
  ['fill hold limit 2', () => s.fill({ v: 'hold' }, { limit: 2 })],
  ['fill hold (text column)', () => s.fill({ host: 'hold' })],
  ['mapColumns v*2', () => s.mapColumns({ v: (x) => x * 2 })],
];
const results = cases.map(([label, fn]) => benchmark(label, fn));
console.log(JSON.stringify({ dist, rows: ROWS, results }, null, 2));
