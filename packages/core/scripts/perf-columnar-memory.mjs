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

function heapMb() {
  if (global.gc) global.gc();
  return Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2));
}

const scenarios = [
  { length: 100_000, distinctHosts: 10, sparseEvery: 0 },
  { length: 100_000, distinctHosts: 10_000, sparseEvery: 10 },
  { length: 1_000_000, distinctHosts: 100, sparseEvery: 0 },
];

const results = [];
for (const scenario of scenarios) {
  const baselineHeapMb = heapMb();
  const rows = makeRows(
    scenario.length,
    scenario.distinctHosts,
    scenario.sparseEvery,
  );
  const rowsHeapMb = heapMb();
  const series = new TimeSeries({ name: 'metrics', schema, rows });
  const seriesHeapMb = heapMb();
  const store = ColumnarStore.fromEvents(series.schema, series.events);
  const storeHeapMb = heapMb();

  results.push({
    scenario,
    baselineHeapMb,
    rowsHeapMb,
    seriesHeapMb,
    seriesPlusSidecarHeapMb: storeHeapMb,
    sidecarEstimatedMb: Number(
      (store.estimatedBytes() / 1024 / 1024).toFixed(2),
    ),
  });
}

console.log(JSON.stringify(results, null, 2));
