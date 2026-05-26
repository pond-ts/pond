// Phase 4.7 step 3 — column-fast-path reducer perf.
//
// Measures `series.reduce(col, reducer)` for the 8 built-in numeric
// reducers (sum / count / min / max / avg / stdev / median / p95).
//
// To compare against the pre-step-3 row-API path: check out main,
// rebuild, re-run.
//
// Measured (post-step-3, N=1M): 32-72× speedup on simple
// aggregates (sum / count / min / max / avg / stdev), 3.4× on
// sort-dominated (median / p95). Stdev is 32× rather than the
// 60+× of the others because the column path walks twice (two-pass
// formula) to match the row-API's numerical stability — closed L2
// review finding on PR #153. The pre-step-3 path materializes
// `series.events` (N Event allocations) then filters into defined +
// numeric arrays (2N more allocations), then walks. The post-step-3
// path walks `col.values: Float64Array` directly — no allocations
// beyond the result.

import { performance } from 'node:perf_hooks';
import { TimeSeries } from '../dist/index.js';

const SCHEMA = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
]);

function makeSeries(length) {
  return new TimeSeries({
    name: 's',
    schema: SCHEMA,
    rows: Array.from({ length }, (_, i) => [1_000 + i, Math.sin(i / 100) * 50]),
  });
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
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

const reducers = [
  'sum',
  'count',
  'min',
  'max',
  'avg',
  'stdev',
  'median',
  'p95',
];
const sizes = [100_000, 1_000_000];

const results = [];
for (const N of sizes) {
  const series = makeSeries(N);
  for (const reducer of reducers) {
    results.push(
      bench(`reduce('value', '${reducer}') / N=${N}`, () => {
        series.reduce('value', reducer);
      }),
    );
  }
}

console.log(JSON.stringify(results, null, 2));
