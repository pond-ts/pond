import { TimeSeries } from '../dist/index.js';

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

function memoryMb() {
  if (global.gc) global.gc();
  const memory = process.memoryUsage();
  const heap = memory.heapUsed / 1024 / 1024;
  const arrayBuffers = memory.arrayBuffers / 1024 / 1024;
  return {
    heap: Number(heap.toFixed(2)),
    arrayBuffers: Number(arrayBuffers.toFixed(2)),
    heapPlusArrayBuffers: Number((heap + arrayBuffers).toFixed(2)),
  };
}

function deltaMb(after, before) {
  return {
    heap: Number((after.heap - before.heap).toFixed(2)),
    arrayBuffers: Number((after.arrayBuffers - before.arrayBuffers).toFixed(2)),
    heapPlusArrayBuffers: Number(
      (after.heapPlusArrayBuffers - before.heapPlusArrayBuffers).toFixed(2),
    ),
  };
}

function buildSeries(scenario) {
  const rows = makeRows(
    scenario.length,
    scenario.distinctHosts,
    scenario.sparseEvery,
  );
  return {
    rowsMemoryMb: memoryMb(),
    series: new TimeSeries({ name: 'metrics', schema, rows }),
  };
}

const scenarios = [
  { length: 100_000, distinctHosts: 10, sparseEvery: 0 },
  { length: 100_000, distinctHosts: 10_000, sparseEvery: 10 },
  { length: 1_000_000, distinctHosts: 100, sparseEvery: 0 },
];

function measureScenario(scenario) {
  const baselineMemoryMb = memoryMb();
  const { rowsMemoryMb, series } = buildSeries(scenario);
  const lazySeriesMemoryMb = memoryMb();
  const reduceResult = series.reduce('cpu', 'avg');
  const afterStoreReadMemoryMb = memoryMb();
  const materializedEvents = series.events;
  const afterEventsMemoryMb = memoryMb();

  return {
    scenario,
    baselineMemoryMb,
    rowsMemoryMb,
    lazySeriesMemoryMb,
    afterStoreReadMemoryMb,
    afterEventsMemoryMb,
    rowsDeltaMb: deltaMb(rowsMemoryMb, baselineMemoryMb),
    lazySeriesDeltaMb: deltaMb(lazySeriesMemoryMb, baselineMemoryMb),
    materializedEventsDeltaMb: deltaMb(afterEventsMemoryMb, lazySeriesMemoryMb),
    retainedEventCount: materializedEvents.length,
    reduceResult,
  };
}

console.log(JSON.stringify(scenarios.map(measureScenario), null, 2));
