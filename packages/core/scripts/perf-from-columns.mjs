import { performance } from 'node:perf_hooks';
import { TimeSeries } from '../dist/index.js';

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'open', kind: 'number' },
  { name: 'high', kind: 'number' },
  { name: 'low', kind: 'number' },
  { name: 'close', kind: 'number' },
  { name: 'volume', kind: 'number' },
  { name: 'vwap', kind: 'number' },
]);

function makeColumns(length, { typed, sparse = false, shuffled = false } = {}) {
  const time = new Float64Array(length);
  // `shuffled` builds a descending key so `sort: true` does a full reorder
  // (worst case for the permutation + copy); otherwise ascending (the fast path).
  for (let i = 0; i < length; i += 1) {
    time[i] = (shuffled ? length - 1 - i : i) * 1_000;
  }

  const valueNames = ['open', 'high', 'low', 'close', 'volume', 'vwap'];
  const columns = { time };
  for (const name of valueNames) {
    if (typed) {
      const col = new Float64Array(length);
      for (let i = 0; i < length; i += 1) {
        col[i] = sparse && i % 10 === 0 ? NaN : i % 100;
      }
      columns[name] = col;
    } else {
      const col = new Array(length);
      for (let i = 0; i < length; i += 1) {
        col[i] = sparse && i % 10 === 0 ? null : i % 100;
      }
      columns[name] = col;
    }
  }
  return columns;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function benchmark(name, columns, { sort = false, repeats = 7 } = {}) {
  // warmup
  TimeSeries.fromColumns({ name: 'w', schema, columns, sort });

  const samples = [];
  for (let run = 0; run < repeats; run += 1) {
    const start = performance.now();
    const series = TimeSeries.fromColumns({ name, schema, columns, sort });
    const end = performance.now();
    if (series.length !== columns.time.length) {
      throw new Error(`unexpected length for ${name}`);
    }
    samples.push(end - start);
  }

  return {
    scenario: name,
    length: columns.time.length,
    medianMs: Number(median(samples).toFixed(3)),
    minMs: Number(Math.min(...samples).toFixed(3)),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  };
}

const LENGTH = 100_000;

const results = [
  benchmark(
    'number[] columns, dense (100k x 7 cols)',
    makeColumns(LENGTH, { typed: false }),
  ),
  benchmark(
    'number[] columns, sparse ~10% gaps (100k x 7 cols)',
    makeColumns(LENGTH, { typed: false, sparse: true }),
  ),
  benchmark(
    'Float64Array columns, dense — adopt path (100k x 7 cols)',
    makeColumns(LENGTH, { typed: true }),
  ),
  benchmark(
    'Float64Array columns, sparse ~10% gaps — adopt path (100k x 7 cols)',
    makeColumns(LENGTH, { typed: true, sparse: true }),
  ),
  benchmark(
    'number[] columns, per-element floor (1k x 7 cols)',
    makeColumns(1_000, { typed: false }),
  ),
  // sort: true — the opt-in reorder path. Descending input so the sort does a
  // full O(n log n) permutation + a per-column copy (no zero-copy adoption).
  benchmark(
    'number[] columns, sort: true, descending (100k x 7 cols)',
    makeColumns(LENGTH, { typed: false, shuffled: true }),
    { sort: true },
  ),
  benchmark(
    'Float64Array columns, sort: true, descending — copy path (100k x 7 cols)',
    makeColumns(LENGTH, { typed: true, shuffled: true }),
    { sort: true },
  ),
];

console.log(JSON.stringify(results, null, 2));
