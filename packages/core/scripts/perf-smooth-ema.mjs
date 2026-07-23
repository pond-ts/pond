// Benchmarks `smooth('ema')` — the columnar fast path (packed numeric
// source → typed result column via trusted construction, no event
// materialization, no intake re-pack). The 1M scale is the financial
// studies workload (`ema({ period })` composes on this); the small scales
// guard the per-call fixed cost. `sparse` runs the same sweep over a
// source with a missing cell every 4 rows (validity-gated reads).
import { performance } from 'node:perf_hooks';
import { TimeSeries } from '../dist/index.js';

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number', required: false },
  { name: 'load', kind: 'number' },
]);

function makeSeries(length, { sparse = false } = {}) {
  return new TimeSeries({
    name: 'cpu',
    schema,
    rows: Array.from({ length }, (_, index) => [
      index * 1_000,
      sparse && index % 4 === 3 ? undefined : index % 100,
      (index % 7) + 1,
    ]),
  });
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function benchmark(length, options, repeats = 5) {
  const series = makeSeries(length, options);
  const run = () =>
    series.smooth('value', 'ema', {
      span: 20,
      minSamples: 20,
      output: 'ema',
    });

  run(); // warm-up

  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
    const start = performance.now();
    const smoothed = run();
    const end = performance.now();
    if (smoothed.length !== length) {
      throw new Error(
        `unexpected output length for ${length}: ${smoothed.length}`,
      );
    }
    samples.push(end - start);
  }

  return {
    length,
    medianMs: Number(median(samples).toFixed(2)),
    minMs: Number(Math.min(...samples).toFixed(2)),
    maxMs: Number(Math.max(...samples).toFixed(2)),
  };
}

const scales = [1_000, 10_000, 100_000, 1_000_000];
const results = {
  dense: scales.map((scale) => benchmark(scale, { sparse: false })),
  sparse: scales.map((scale) => benchmark(scale, { sparse: true })),
};

console.log(JSON.stringify(results, null, 2));
