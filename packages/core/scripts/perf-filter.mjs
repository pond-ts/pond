// Perf bench for `TimeSeries.filter` — [PND-FILTERTAKE]. Same data as
// `crates/pond-rs/bench/rowwise_pond_ts.mjs` (1M rows, ~2% of `v` missing
// in short runs), plus a text column so the copy covers a non-number kind.
//
//     npm run build --workspace=pond-ts
//     node packages/core/scripts/perf-filter.mjs
//
// `POND_DIST=<dir>` benchmarks another build (resolved from the cwd; it must
// sit inside the repo so its imports resolve). `PERF_WARMUP` sets the
// warm-up count: results differ a lot between few (5) and many (40) warm-up
// calls, so report both (see PND_COLUMNAR_PLAN [PND-BOXFREE] notes).
//
// The predicate takes `Event`s, so the source's events are built on the
// first call and cached on the series; every timed call after that pays
// only the predicate walk plus building the result.

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
    rows.push([i * 1000, undefined, `h${i % 7}`]);
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

const half = (e) => {
  const x = e.get('v');
  return x !== undefined && x > 500;
};
const cases = [
  ['filter v > 500 (keeps ~49%)', () => s.filter(half)],
  ['filter keep all', () => s.filter(() => true)],
  ['filter keep 1%', () => s.filter((_, i) => i % 100 === 0)],
  ['filter keep none', () => s.filter(() => false)],
  // Downstream use of the result's events: the old path handed the kept
  // Event objects straight to the result, so this was free; make sure the
  // new path does not just move the cost here.
  ['filter v > 500 then .events', () => s.filter(half).events.length],
  ['filter v > 500 then sum(v)', () => s.filter(half).column('v').sum()],
];
const results = cases.map(([label, fn]) => benchmark(label, fn));
console.log(
  JSON.stringify({ dist, rows: ROWS, warmup: WARMUP, results }, null, 2),
);
