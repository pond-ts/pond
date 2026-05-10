import { performance } from 'node:perf_hooks';
import { TimeSeries } from '../dist/index.js';
import { ColumnarStore } from '../dist/internal/columnar-store.js';

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number', required: false },
  { name: 'mem', kind: 'number', required: false },
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
      Math.cos(index * 0.01) * 25 + 75,
      index % 100,
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

function benchmark(label, fn, repeats = 7) {
  for (let run = 0; run < 2; run += 1) fn();
  const samples = [];
  for (let run = 0; run < repeats; run += 1) {
    const start = performance.now();
    const result = fn();
    samples.push(performance.now() - start);
    if (!result || result.length === 0) {
      throw new Error(`unexpected empty result for ${label}`);
    }
  }
  return {
    label,
    medianMs: Number(median(samples).toFixed(3)),
    minMs: Number(Math.min(...samples).toFixed(3)),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  };
}

function chartBufferLength(buffer) {
  let columns = 0;
  for (const values of buffer.yByColumn.values()) {
    columns += values.length;
  }
  return buffer.x.length + columns;
}

const scenarios = [
  { length: 100_000, distinctHosts: 10, sparseEvery: 0, repeats: 9 },
  { length: 100_000, distinctHosts: 10_000, sparseEvery: 10, repeats: 9 },
  { length: 1_000_000, distinctHosts: 100, sparseEvery: 0, repeats: 5 },
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
    toPoints: benchmark(
      'series.toPoints()',
      () => series.toPoints(),
      scenario.repeats,
    ),
    chartBuffer: benchmark(
      'store.toChartBuffer(["cpu", "mem", "requests"]) zero-copy',
      () => {
        const buffer = store.toChartBuffer(['cpu', 'mem', 'requests']);
        return { length: chartBufferLength(buffer) };
      },
      scenario.repeats,
    ),
    chartBufferCopy: benchmark(
      'store.toChartBuffer(["cpu", "mem", "requests"], { copy: true })',
      () => {
        const buffer = store.toChartBuffer(['cpu', 'mem', 'requests'], {
          copy: true,
        });
        return { length: chartBufferLength(buffer) };
      },
      scenario.repeats,
    ),
  });
}

console.log(JSON.stringify(results, null, 2));
