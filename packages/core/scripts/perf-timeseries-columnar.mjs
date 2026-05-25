// Benchmark for Phase 4.7 step 2a — TimeSeries columnar integration.
//
// Measures construction + common point-access patterns to track the
// substrate's overhead vs the pre-2a row-array baseline. Run via:
//
//     npm run build --workspace=pond-ts
//     node scripts/perf-timeseries-columnar.mjs
//
// To compare against pre-2a behavior, check out the commit before
// the integration landed, rebuild, and re-run.

import { performance } from 'node:perf_hooks';
import { Time, TimeSeries } from '../dist/index.js';

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
  { name: 'load', kind: 'number' },
]);

function makeRows(length) {
  return Array.from({ length }, (_, i) => [1_000 + i, i % 100, (i % 7) + 1]);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}

function bench(label, fn, repeats = 20) {
  for (let i = 0; i < 3; i += 1) fn();
  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return {
    label,
    medianMs: Number(median(samples).toFixed(3)),
    minMs: Number(Math.min(...samples).toFixed(3)),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  };
}

const results = [];
const sizes = [10_000, 100_000, 1_000_000];

for (const N of sizes) {
  const rows = makeRows(N);

  results.push(
    bench(`build only / N=${N}`, () => {
      new TimeSeries({ name: 's', schema, rows });
    }),
  );

  results.push(
    bench(`build + 100 at(i) / N=${N}`, () => {
      const s = new TimeSeries({ name: 's', schema, rows });
      for (let k = 0; k < 100; k += 1) s.at(k * Math.floor(N / 100));
    }),
  );

  results.push(
    bench(`build + find(i=5) / N=${N}`, () => {
      const s = new TimeSeries({ name: 's', schema, rows });
      let seen = 0;
      s.find(() => {
        seen += 1;
        return seen === 5;
      });
    }),
  );

  results.push(
    bench(`build + bisect(midKey) / N=${N}`, () => {
      const s = new TimeSeries({ name: 's', schema, rows });
      s.bisect(new Time(1_000 + Math.floor(N / 2)));
    }),
  );

  results.push(
    bench(`build + .events full materialize / N=${N}`, () => {
      const s = new TimeSeries({ name: 's', schema, rows });
      const arr = s.events;
      if (arr.length !== N) throw new Error('len mismatch');
    }),
  );
}

console.log(JSON.stringify(results, null, 2));
