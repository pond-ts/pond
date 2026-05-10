import { performance } from 'node:perf_hooks';
import { TimeSeries } from '../dist/index.js';
import { ColumnarStore } from '../dist/internal/columnar-store.js';

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number', required: false },
  { name: 'mem', kind: 'number', required: false },
  { name: 'healthy', kind: 'boolean', required: false },
  { name: 'host', kind: 'string', required: false },
]);

function makeRows(length, distinctHosts, sparseEvery = 0) {
  return Array.from({ length }, (_, index) => [
    index * 1000,
    sparseEvery > 0 && index % sparseEvery === 0
      ? undefined
      : Math.sin(index * 0.01) * 50 + 50,
    Math.cos(index * 0.01) * 25 + 75,
    index % 19 !== 0,
    `host-${index % distinctHosts}`,
  ]);
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function benchmark(fn, repeats = 5) {
  for (let run = 0; run < 1; run += 1) fn();
  const samples = [];
  for (let run = 0; run < repeats; run += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return Number(median(samples).toFixed(3));
}

const scenarios = [
  { length: 100_000, distinctHosts: 10, sparseEvery: 0 },
  { length: 100_000, distinctHosts: 10_000, sparseEvery: 10 },
  { length: 1_000_000, distinctHosts: 100, sparseEvery: 0 },
];

const results = [];
for (const scenario of scenarios) {
  const rows = makeRows(
    scenario.length,
    scenario.distinctHosts,
    scenario.sparseEvery,
  );
  const series = new TimeSeries({ name: 'metrics', schema, rows });

  results.push({
    scenario,
    timeSeriesConstructionMs: benchmark(
      () => new TimeSeries({ name: 'metrics', schema, rows }),
      3,
    ),
    sidecarConstructionMs: benchmark(
      () => ColumnarStore.fromEvents(series.schema, series.events),
      5,
    ),
  });
}

console.log(JSON.stringify(results, null, 2));
