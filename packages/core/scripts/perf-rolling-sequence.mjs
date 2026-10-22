// Benchmark for `rolling(sequence, window, mapping)` — the grid-driven
// rolling form ([PND-ROLLGRID]). Prints one JSON line per scenario as it
// finishes. `DIST=/path/to/dist/index.js` benchmarks another build;
// `ONLY=name,name` runs a subset (the old O(B·N) build needs minutes on
// the large scenarios).
import { performance } from 'node:perf_hooks';

const dist = process.env.DIST ?? '../dist/index.js';
const { Sequence, TimeSeries } = await import(dist);
const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
const repeats = Number(process.env.REPEATS ?? 7);
const warmups = Number(process.env.WARMUPS ?? 5);

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number', required: false },
  { name: 'host', kind: 'string' },
]);

function makeSeries(length, stepMs, hosts = 1) {
  return new TimeSeries({
    name: 'cpu',
    schema,
    rows: Array.from({ length }, (_, i) => [
      i * stepMs,
      i % 17 === 0 ? undefined : ((i * 7919) % 1000) / 10,
      `h${i % hosts}`,
    ]),
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function benchmark(name, run) {
  if (only && !only.includes(name)) return;
  for (let i = 0; i < warmups; i += 1) run();
  const samples = [];
  let rows = 0;
  for (let i = 0; i < repeats; i += 1) {
    const start = performance.now();
    const out = run();
    samples.push(performance.now() - start);
    rows = out.length;
  }
  console.log(
    JSON.stringify({
      name,
      rows,
      medianMs: Number(median(samples).toFixed(2)),
      minMs: Number(Math.min(...samples).toFixed(2)),
      maxMs: Number(Math.max(...samples).toFixed(2)),
    }),
  );
}

const MIN = 60_000;

// Typical: 100k rows 1 s apart, 1-minute grid, 5-minute trailing avg
// (B ≈ 1.7k buckets, W = 300 rows).
const s100k = makeSeries(100_000, 1_000);
benchmark('grid1m-avg5m-100k', () =>
  s100k.rolling(Sequence.every('1m'), 5 * MIN, { v: 'avg' }),
);

// Same at 1M rows, two reducers.
const s1m = makeSeries(1_000_000, 1_000);
benchmark('grid1m-avg-sd-5m-1M', () =>
  s1m.rolling(Sequence.every('1m'), 5 * MIN, {
    mean: { from: 'v', using: 'avg' },
    sd: { from: 'v', using: 'stdev' },
  }),
);

// Per-element floor: one row per bucket (grid step = row step, W = 1).
benchmark('grid1s-win1s-100k', () =>
  s100k.rolling(Sequence.every('1s'), 1_000, { v: 'avg' }),
);

// Sparse source on a dense grid: 10k rows 100 s apart, 1-second grid
// (B = 1M buckets, most windows empty).
const sparse = makeSeries(10_000, 100_000);
benchmark('sparse-10k-grid1s-win5m', () =>
  sparse.rolling(Sequence.every('1s'), 5 * MIN, { v: 'avg' }),
);

// Wide window: reduce cost is O(B·W) — 1-hour windows on a 1-minute grid.
benchmark('grid1m-avg1h-100k', () =>
  s100k.rolling(Sequence.every('1m'), 60 * MIN, { v: 'avg' }),
);

// Partitioned: 4 hosts interleaved, per-host grid rolling + collect.
const parts = makeSeries(100_000, 250, 4);
benchmark('partitioned-4hosts-grid1m-avg5m', () =>
  parts
    .partitionBy('host')
    .rolling(Sequence.every('1m'), 5 * MIN, { v: 'avg' })
    .collect(),
);
