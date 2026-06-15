import { performance } from 'node:perf_hooks';
import { TimeSeries } from '../dist/index.js';

// Perf check for rolling('stdev') after replacing the one-pass `sq/n − mean²`
// rollingState with a two-stack Welford-Chan FIFO aggregator (numerical
// stability — docs/notes/reducer-nan-policy.md + stdev.ts). The old path did
// O(1) arithmetic per add/remove with ZERO allocation; the two-stack allocates
// a small entry per add and one merged partition per flip, so this measures
// what the stability win costs in time + GC. Narrow windows are the allocation
// worst case (every step flips the back stack into the front).

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
  { name: 'host', kind: 'string' },
]);

function makeSeries(length, partitions = 1) {
  return new TimeSeries({
    name: 'cpu',
    schema,
    rows: Array.from({ length }, (_, index) => [
      index * 1_000,
      // A non-degenerate value stream so the variance actually moves.
      Math.sin(index / 17) * 100 + (index % 13),
      `host-${index % partitions}`,
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
  fn(); // warm-up
  const samples = [];
  for (let run = 0; run < repeats; run += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return {
    label,
    medianMs: Number(median(samples).toFixed(2)),
    minMs: Number(Math.min(...samples).toFixed(2)),
    maxMs: Number(Math.max(...samples).toFixed(2)),
  };
}

const N = 100_000;
const typical = makeSeries(N);
const partitioned = makeSeries(N, 100);

const results = [
  // Typical: 100k events on a 1s grid, 60-event trailing window.
  benchmark('100k · window 60s (~60 events)', () =>
    typical.rolling(60_000, { value: 'stdev' }),
  ),
  // Narrow window: ~5 events. Maximum stack-flip churn (allocation worst case).
  benchmark('100k · window 5s (~5 events, flip-heavy)', () =>
    typical.rolling(5_000, { value: 'stdev' }),
  ),
  // Per-element floor: 1 event per window — constant flip on every step.
  benchmark('100k · window 1s (1 event, per-step floor)', () =>
    typical.rolling(1_000, { value: 'stdev' }),
  ),
  // Wide window: ~3600 events. Remove-light, large running aggregate.
  benchmark('100k · window 3600s (~3600 events, wide)', () =>
    typical.rolling(3_600_000, { value: 'stdev' }),
  ),
  // Partitioned: 100 hosts, 60-event window each.
  benchmark('100k / 100 parts · window 60s', () =>
    partitioned.partitionBy('host').rolling(60_000, { value: 'stdev' }),
  ),
];

console.log(JSON.stringify(results, null, 2));
