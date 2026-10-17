import { performance } from 'node:perf_hooks';
import { TimeSeries } from '../dist/index.js';

// Perf check for [PND-ROLLSTD]: rolling `sum` / `avg` / `stdev` moved from
// plain running doubles (running sum; Welford add/delete) to double-double
// running sums (`reducers/window-accumulators.ts`), which do not drift.
// Still O(1) per add / remove with no buffer; the cost is a few more flops
// per step (twoSum, plus Dekker's twoProd for stdev) and, for stdev, an
// occasional shift of the reference point. Covers both window kinds (the
// duration-window sweep drives the reducer states; the count-window sweep
// drives the accumulators inline), the 1-event-per-window floor, a gappy
// source and a partitioned run. Min of N runs (the box is noisy; the min is
// the stable figure).

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number', required: false },
  { name: 'host', kind: 'string' },
]);

function makeSeries(length, { partitions = 1, gapEvery = 0 } = {}) {
  return new TimeSeries({
    name: 'cpu',
    schema,
    rows: Array.from({ length }, (_, index) => [
      index * 1_000,
      gapEvery && index % gapEvery === 0
        ? undefined
        : Math.sin(index / 17) * 100 + (index % 13),
      `host-${index % partitions}`,
    ]),
  });
}

function benchmark(label, fn, repeats = 25) {
  for (let i = 0; i < 5; i += 1) fn(); // warm-up
  const samples = [];
  for (let run = 0; run < repeats; run += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return {
    label,
    minMs: Number(samples[0].toFixed(2)),
    medianMs: Number(samples[samples.length >> 1].toFixed(2)),
  };
}

const N = 100_000;
const typical = makeSeries(N);
const gappy = makeSeries(N, { gapEvery: 20 });
const partitioned = makeSeries(N, { partitions: 100 });

const results = [];
for (const using of ['sum', 'avg', 'stdev']) {
  const m = { out: { from: 'value', using } };
  results.push(
    benchmark(`${using} · 100k · 60s window`, () => typical.rolling('60s', m)),
    benchmark(`${using} · 100k · 1s window (1 event)`, () =>
      typical.rolling('1s', m),
    ),
    // ~5 events on a fast-moving signal: for stdev the reference point is
    // re-centred on most reads, the worst case for the shift.
    benchmark(`${using} · 100k · 5s window (~5 events)`, () =>
      typical.rolling('5s', m),
    ),
    benchmark(`${using} · 100k gappy · 60s window`, () =>
      gappy.rolling('60s', m),
    ),
    benchmark(`${using} · 100k · 20-row count window`, () =>
      typical.rolling(20, m),
    ),
    benchmark(`${using} · 100k / 100 parts · 60s window`, () =>
      partitioned.partitionBy('host').rolling('60s', m),
    ),
  );
}

console.log(JSON.stringify(results, null, 2));
