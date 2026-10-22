// Benchmark for `align` / `materialize` / `dedupe` — the grid and duplicate
// ops moved onto columns in [PND-ALIGNHOLD] / [PND-DEDUPEMAP]. Prints one
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

// Typical: 1M rows 1 s apart onto a 1 s grid (one bucket per row).
const s1m = makeSeries(1_000_000, 1_000);
benchmark('align-hold-1s-1M', () => s1m.align(Sequence.every('1s')));
benchmark('align-linear-1s-1M', () =>
  s1m.align(Sequence.every('1s'), { method: 'linear', sample: 'center' }),
);
benchmark('materialize-last-1s-1M', () =>
  s1m.materialize(Sequence.every('1s')),
);
benchmark('materialize-nearest-1s-1M', () =>
  s1m.materialize(Sequence.every('1s'), { select: 'nearest' }),
);

// Coarse grid: 1M rows onto 1-minute buckets (most rows skipped).
benchmark('align-hold-1m-1M', () => s1m.align(Sequence.every('1m')));
benchmark('materialize-last-1m-1M', () =>
  s1m.materialize(Sequence.every('1m')),
);

// Sparse source on a dense grid: 10k rows 1 min apart onto 1 s buckets
// (600k buckets, almost all empty or held).
const sparse = makeSeries(10_000, 60_000);
benchmark('align-hold-sparse-600k', () => sparse.align(Sequence.every('1s')));
benchmark('materialize-sparse-600k', () =>
  sparse.materialize(Sequence.every('1s')),
);

// dedupe: 1M rows with 10% repeated times.
const dup = makeSeries(1_000_000, 1_000, { dupEvery: 10 });
benchmark('dedupe-last-1M', () => dup.dedupe());
benchmark('dedupe-first-1M', () => dup.dedupe({ keep: 'first' }));
benchmark('dedupe-max-1M', () => dup.dedupe({ keep: { max: 'v' } }));
benchmark('dedupe-none-1M', () => s1m.dedupe());

// Partitioned: 4 hosts, 100k rows each, align + materialize per host.
const parted = makeSeries(400_000, 250, { hosts: 4 });
benchmark('partitioned-align-4x100k', () =>
  parted.partitionBy('host').align(Sequence.every('1s')).collect(),
);
benchmark('partitioned-dedupe-materialize-4x100k', () =>
  parted
    .partitionBy('host')
    .dedupe({ keep: 'last' })
    .materialize(Sequence.every('1s'))
    .collect(),
);
