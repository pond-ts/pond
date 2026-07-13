import { performance } from 'node:perf_hooks';
import { TimeSeries } from '../dist/index.js';

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
  { name: 'load', kind: 'number' },
]);

function makeSeries(length) {
  return new TimeSeries({
    name: 'cpu',
    schema,
    rows: Array.from({ length }, (_, index) => [
      index * 1_000,
      index % 100,
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

function benchmark(length, repeats = 5) {
  const series = makeSeries(length);

  // Warm-up run so measurement is less dominated by one-time setup.
  series.rolling(60_000, { value: 'avg', load: 'sum' });

  const samples = [];
  for (let run = 0; run < repeats; run += 1) {
    const start = performance.now();
    const rolled = series.rolling(60_000, { value: 'avg', load: 'sum' });
    const end = performance.now();
    if (rolled.length !== length) {
      throw new Error(
        `unexpected output length for ${length}: ${rolled.length}`,
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

/** Count-based ({ count: N }) window — the N-bar sweep. Same two-pointer
 *  structure as the duration trailing path (each row enters/leaves once), so
 *  this should track the duration numbers, not regress against them. */
function benchmarkCount(length, count = 60, repeats = 5) {
  const series = makeSeries(length);
  series.rolling(
    { count },
    { value: 'avg', load: 'sum' },
    { minSamples: count },
  );

  const samples = [];
  for (let run = 0; run < repeats; run += 1) {
    const start = performance.now();
    const rolled = series.rolling(
      { count },
      { value: 'avg', load: 'sum' },
      { minSamples: count },
    );
    const end = performance.now();
    if (rolled.length !== length) {
      throw new Error(
        `unexpected count output length for ${length}: ${rolled.length}`,
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

const scales = [250, 500, 1_000, 2_000, 4_000, 100_000];
const results = {
  duration: scales.map((scale) => benchmark(scale)),
  count: scales.map((scale) => benchmarkCount(scale)),
};

console.log(JSON.stringify(results, null, 2));
