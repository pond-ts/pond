import { performance } from 'node:perf_hooks';
import { TimeSeries } from '../dist/index.js';
import { ColumnarStore } from '../dist/internal/columnar-store.js';

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number', required: false },
  { name: 'requests', kind: 'number', required: false },
  { name: 'host', kind: 'string', required: false },
]);

function makeSeries(length, distinctHosts, sparseEvery = 0) {
  return new TimeSeries({
    name: 'metrics',
    schema,
    rows: Array.from({ length }, (_, index) => [
      index * 1000,
      sparseEvery > 0 && index % sparseEvery === 0
        ? undefined
        : Math.sin(index * 0.01) * 50 + 50,
      index % 10,
      `host-${index % distinctHosts}`,
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

function benchmark(fn, repeats = 7) {
  for (let run = 0; run < 2; run += 1) fn();
  const samples = [];
  for (let run = 0; run < repeats; run += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return Number(median(samples).toFixed(3));
}

function eventBackedAvg(series, column) {
  let sum = 0;
  let count = 0;
  for (const event of series.events) {
    const value = event.data()[column];
    if (typeof value === 'number') {
      sum += value;
      count += 1;
    }
  }
  return count === 0 ? undefined : sum / count;
}

function eventBackedUnique(series, column) {
  const values = new Set();
  for (const event of series.events) {
    const value = event.data()[column];
    if (value !== undefined) values.add(value);
  }
  return [...values].sort();
}

const scenarios = [
  { length: 100_000, distinctHosts: 10, sparseEvery: 0 },
  { length: 100_000, distinctHosts: 1000, sparseEvery: 10 },
  { length: 1_000_000, distinctHosts: 100, sparseEvery: 0 },
];

const results = [];
for (const scenario of scenarios) {
  const series = makeSeries(
    scenario.length,
    scenario.distinctHosts,
    scenario.sparseEvery,
  );
  const store = ColumnarStore.fromEvents(series.schema, series.events);

  results.push({
    scenario,
    avg: {
      eventBackedMs: benchmark(() => eventBackedAvg(series, 'cpu')),
      columnarStoreMs: benchmark(() => store.reduceColumn('cpu', 'avg')),
      publicReduceMs: benchmark(() => series.reduce('cpu', 'avg')),
    },
    unique: {
      eventBackedMs: benchmark(() => eventBackedUnique(series, 'host'), 5),
      columnarStoreMs: benchmark(() => store.reduceColumn('host', 'unique'), 5),
      publicReduceMs: benchmark(() => series.reduce('host', 'unique'), 5),
    },
  });
}

console.log(JSON.stringify(results, null, 2));
