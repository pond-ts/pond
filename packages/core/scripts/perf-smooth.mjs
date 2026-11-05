// Benchmark for `smooth` (movingAverage / loess), `baseline` and `outliers`
// — moved onto columns in [PND-SMOOTHSLOW]. Prints one
// JSON line per scenario. `DIST=/path/to/dist/index.js` benchmarks another
// build; `ONLY=name,name` runs a subset.
import { performance } from 'node:perf_hooks';

const dist = process.env.DIST ?? '../dist/index.js';
const { Sequence, TimeSeries } = await import(dist);
const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
const repeats = Number(process.env.REPEATS ?? 7);
const warmups = Number(process.env.WARMUPS ?? 3);

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number', required: false },
  { name: 'host', kind: 'string' },
]);

// `length` rows `stepMs` apart; every `dupEvery`-th row repeats the
// previous row's time (10% duplicates at dupEvery = 10).
function makeSeries(length, stepMs, { hosts = 1, dupEvery = 0 } = {}) {
  let t = 0;
  return new TimeSeries({
    name: 'cpu',
    schema,
    rows: Array.from({ length }, (_, i) => {
      if (!(dupEvery > 0 && i % dupEvery === dupEvery - 1)) t += stepMs;
      return [
        t,
        i % 17 === 0 ? undefined : ((i * 7919) % 1000) / 10,
        `h${i % hosts}`,
      ];
    }),
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
const s1m = makeSeries(1_000_000, 1_000);
benchmark('movingAverage-5m-1M', () =>
  s1m.smooth('v', 'movingAverage', { window: 5 * MIN }),
);
benchmark('movingAverage-5m-centered-skip-1M', () =>
  s1m.smooth('v', 'movingAverage', {
    window: 5 * MIN,
    alignment: 'centered',
    missing: 'skip',
    output: 'avg',
  }),
);
benchmark('baseline-5m-1M', () =>
  s1m.baseline('v', { window: 5 * MIN, sigma: 2 }),
);
benchmark('outliers-5m-1M', () =>
  s1m.outliers('v', { window: 5 * MIN, sigma: 1 }),
);

// LOESS costs O(N · span · N); keep N small.
const s20k = makeSeries(20_000, 1_000);
benchmark('loess-0.05-20k', () => s20k.smooth('v', 'loess', { span: 0.05 }));

// Per-row floor: a window holding one row.
benchmark('movingAverage-1ms-1M', () =>
  s1m.smooth('v', 'movingAverage', { window: 1 }),
);

// Partitioned: 4 hosts, 250k rows each.
const parted = makeSeries(1_000_000, 250, { hosts: 4 });
benchmark('partitioned-baseline-4x250k', () =>
  parted
    .partitionBy('host')
    .baseline('v', { window: 5 * MIN, sigma: 2 })
    .collect(),
);

benchmark('sample-stride10-1M', () => s1m.sample({ stride: 10 }));
