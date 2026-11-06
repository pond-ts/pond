// Benchmark for `TimeSeries.concat` and the partitioned ops that end in it
// (`collect`) — moved onto a k-way merge of the key columns in
// [PND-CONCATSORT]. Prints one
// JSON line per scenario. `DIST=/path/to/dist/index.js` benchmarks another
// build; `ONLY=name,name` runs a subset.
import { performance } from 'node:perf_hooks';

const dist = process.env.DIST ?? '../dist/index.js';
const { TimeSeries } = await import(dist);
const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
const repeats = Number(process.env.REPEATS ?? 7);
const warmups = Number(process.env.WARMUPS ?? 3);

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'close', kind: 'number', required: false },
  { name: 'symbol', kind: 'string' },
]);

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

// `symbols` symbols, `perSymbol` rows each, all on the same 1 s grid
// (so every partition interleaves with every other).
function makePanel(symbols, perSymbol) {
  const rows = [];
  for (let i = 0; i < perSymbol; i += 1) {
    for (let s = 0; s < symbols; s += 1) {
      rows.push([i * 1000, 100 + ((i * 31 + s * 7) % 50) / 10, `S${s}`]);
    }
  }
  return new TimeSeries({ name: 'panel', schema, rows });
}

function makeRun(start, length) {
  return new TimeSeries({
    name: 'run',
    schema,
    rows: Array.from({ length }, (_, i) => [
      (start + i) * 1000,
      i % 13 === 0 ? undefined : i / 10,
      'S0',
    ]),
  });
}

// Typical: 500 symbols x 1000 rows, partitioned diff (the PLAN repro).
const panel = makePanel(500, 1000);
benchmark('partitioned-diff-500x1k', () =>
  panel.partitionBy('symbol').diff('close').collect(),
);
const parts = [...panel.partitionBy('symbol').toMap().values()];
benchmark('concat-500x1k-interleaved', () => TimeSeries.concat(parts));

// Few large interleaved inputs: 2 x 500k on the same grid.
const big = [...makePanel(2, 500_000).partitionBy('symbol').toMap().values()];
benchmark('concat-2x500k-interleaved', () => TimeSeries.concat(big));

// Inputs already end to end: 10 x 100k.
const runs = Array.from({ length: 10 }, (_, k) =>
  makeRun(k * 100_000, 100_000),
);
benchmark('concat-10x100k-in-order', () => TimeSeries.concat(runs));

// Per-row floor: 100k one-row inputs.
const singles = Array.from({ length: 100_000 }, (_, k) => makeRun(k, 1));
benchmark('concat-100k-single-rows', () => TimeSeries.concat(singles));

// The realistic many-partition case: one row per partition, through a
// partitioned op (each piece is a fresh series, nothing cached).
const unique = makePanel(100_000, 1);
benchmark('partitioned-fill-100k-partitions', () =>
  unique.partitionBy('symbol').fill('hold').collect(),
);
