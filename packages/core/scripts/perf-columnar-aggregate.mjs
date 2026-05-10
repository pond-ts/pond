import { performance } from 'node:perf_hooks';
import { Sequence, TimeRange, TimeSeries } from '../dist/index.js';
import { ColumnarStore } from '../dist/internal/columnar-store.js';

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number', required: false },
  { name: 'load', kind: 'number', required: false },
  { name: 'host', kind: 'string', required: false },
]);
const numericAggregateSchema = Object.freeze([
  { name: 'interval', kind: 'interval' },
  { name: 'valueAvg', kind: 'number', required: false },
  { name: 'loadSum', kind: 'number', required: false },
  { name: 'hostCount', kind: 'number', required: false },
]);
const uniqueAggregateSchema = Object.freeze([
  { name: 'interval', kind: 'interval' },
  { name: 'host', kind: 'array', required: false },
]);

function makeSeries(length, spacingMs, sparseEvery = 0) {
  return new TimeSeries({
    name: 'metrics',
    schema,
    rows: Array.from({ length }, (_, index) => [
      index * spacingMs,
      sparseEvery > 0 && index % sparseEvery === 0
        ? undefined
        : Math.sin(index * 0.01) * 50 + 50,
      index % 11,
      `host-${index % 20}`,
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

function benchmark(label, fn, repeats = 5) {
  for (let run = 0; run < 2; run += 1) fn();
  const samples = [];
  for (let run = 0; run < repeats; run += 1) {
    const start = performance.now();
    const result = fn();
    samples.push(performance.now() - start);
    if (result.length === 0) {
      throw new Error(`unexpected empty output for ${label}`);
    }
  }
  return {
    label,
    medianMs: Number(median(samples).toFixed(3)),
    minMs: Number(Math.min(...samples).toFixed(3)),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  };
}

function eventBackedNumericAggregate(series, buckets) {
  let eventIndex = 0;
  const rows = [];
  for (const bucket of buckets) {
    while (
      eventIndex < series.events.length &&
      series.events[eventIndex].begin() < bucket.begin()
    ) {
      eventIndex += 1;
    }

    let scanIndex = eventIndex;
    let valueSum = 0;
    let valueCount = 0;
    let loadSum = 0;
    let hostCount = 0;
    while (
      scanIndex < series.events.length &&
      series.events[scanIndex].begin() < bucket.end()
    ) {
      const data = series.events[scanIndex].data();
      if (typeof data.value === 'number') {
        valueSum += data.value;
        valueCount += 1;
      }
      if (typeof data.load === 'number') {
        loadSum += data.load;
      }
      if (data.host !== undefined) {
        hostCount += 1;
      }
      scanIndex += 1;
    }
    eventIndex = scanIndex;
    rows.push([
      bucket,
      valueCount === 0 ? undefined : valueSum / valueCount,
      loadSum,
      hostCount,
    ]);
  }
  return new TimeSeries({
    name: series.name,
    schema: numericAggregateSchema,
    rows,
  });
}

function eventBackedUniqueAggregate(series, buckets) {
  let eventIndex = 0;
  const rows = [];
  for (const bucket of buckets) {
    while (
      eventIndex < series.events.length &&
      series.events[eventIndex].begin() < bucket.begin()
    ) {
      eventIndex += 1;
    }

    let scanIndex = eventIndex;
    const values = new Set();
    while (
      scanIndex < series.events.length &&
      series.events[scanIndex].begin() < bucket.end()
    ) {
      const value = series.events[scanIndex].data().host;
      if (value !== undefined) values.add(value);
      scanIndex += 1;
    }
    eventIndex = scanIndex;
    rows.push([bucket, [...values].sort()]);
  }
  return new TimeSeries({
    name: series.name,
    schema: uniqueAggregateSchema,
    rows,
  });
}

function bucketSpans(series, buckets) {
  let eventIndex = 0;
  const spans = [];
  for (const bucket of buckets) {
    while (
      eventIndex < series.events.length &&
      series.events[eventIndex].begin() < bucket.begin()
    ) {
      eventIndex += 1;
    }

    const start = eventIndex;
    let end = start;
    while (
      end < series.events.length &&
      series.events[end].begin() < bucket.end()
    ) {
      end += 1;
    }
    eventIndex = end;
    spans.push([start, end]);
  }
  return spans;
}

function columnarNumericAggregate(series, store, buckets, spans) {
  const rows = buckets.map((bucket, index) => {
    const [start, end] = spans[index];
    return [
      bucket,
      store.reduceColumnRange('value', 'avg', start, end),
      store.reduceColumnRange('load', 'sum', start, end),
      store.reduceColumnRange('host', 'count', start, end),
    ];
  });
  return new TimeSeries({
    name: series.name,
    schema: numericAggregateSchema,
    rows,
  });
}

function columnarUniqueAggregate(series, store, buckets, spans) {
  const rows = buckets.map((bucket, index) => {
    const [start, end] = spans[index];
    return [bucket, store.reduceColumnRange('host', 'unique', start, end)];
  });
  return new TimeSeries({
    name: series.name,
    schema: uniqueAggregateSchema,
    rows,
  });
}

const scenarios = [
  {
    label: '100k rows, 10 events/bucket, dense numeric',
    length: 100_000,
    spacingMs: 100,
    sparseEvery: 0,
    bucketMs: 1000,
    repeats: 7,
  },
  {
    label: '100k rows, 10 events/bucket, 10% sparse numeric',
    length: 100_000,
    spacingMs: 100,
    sparseEvery: 10,
    bucketMs: 1000,
    repeats: 7,
  },
  {
    label: '1M rows, 60 events/bucket, dense numeric',
    length: 1_000_000,
    spacingMs: 1000,
    sparseEvery: 0,
    bucketMs: 60_000,
    repeats: 5,
  },
];

const results = [];
for (const scenario of scenarios) {
  const series = makeSeries(
    scenario.length,
    scenario.spacingMs,
    scenario.sparseEvery,
  );
  const range = new TimeRange({
    start: 0,
    end: (scenario.length - 1) * scenario.spacingMs,
  });
  const sequence = Sequence.every(scenario.bucketMs);
  const buckets = sequence.bounded(range, { sample: 'begin' }).intervals();
  const spans = bucketSpans(series, buckets);
  const store = ColumnarStore.fromEvents(series.schema, series.events);

  results.push(
    benchmark(
      `${scenario.label}: event-backed avg/sum/count`,
      () => eventBackedNumericAggregate(series, buckets),
      scenario.repeats,
    ),
  );

  results.push(
    benchmark(
      `${scenario.label}: experimental columnar avg/sum/count`,
      () => columnarNumericAggregate(series, store, buckets, spans),
      scenario.repeats,
    ),
  );

  results.push(
    benchmark(
      `${scenario.label}: event-backed unique(host)`,
      () => eventBackedUniqueAggregate(series, buckets),
      Math.max(3, Math.min(5, scenario.repeats)),
    ),
  );

  results.push(
    benchmark(
      `${scenario.label}: experimental columnar unique(host)`,
      () => columnarUniqueAggregate(series, store, buckets, spans),
      Math.max(3, Math.min(5, scenario.repeats)),
    ),
  );
}

console.log(JSON.stringify(results, null, 2));
