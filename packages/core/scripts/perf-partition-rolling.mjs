// Partitioned live ingest feeding a per-partition fused rolling — the
// gRPC aggregator's hot path, in-process (no network).
//
//   npm run build --workspace=pond-ts
//   node scripts/perf-partition-rolling.mjs
//
// Shape (from pjm17971/pond-grpc-experiment `aggregate.ts`): strict
// time-keyed source with `maxAge` retention, `partitionBy('host')`, one
// fused rolling (1m stats + 200ms slice) on a 200ms clock trigger.
// Batches carry one row per host per tick, as the gRPC producer sends.
// A/B: `__backing: 'auto'` (chunked source, column-native routing into
// chunked partitions) vs `'array'` (Event[] source and partitions).
// [PND-PARTBATCH] (2026-10-27): before/after numbers in the commit message.
// `POND_DIST=<path to dist/index.js>` benches another build (an old one
// copied next to `dist/`) with the same script.

import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const { LiveSeries, Sequence, Trigger } = await import(
  process.env.POND_DIST
    ? pathToFileURL(process.env.POND_DIST).href
    : '../dist/index.js'
);

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'requests', kind: 'number' },
  { name: 'host', kind: 'string' },
]);

function makeBatches(hosts, ticks, perHostPerTick, stepMs) {
  const names = Array.from({ length: hosts }, (_, i) => `api-${i}`);
  const batches = [];
  let t = 1_700_000_000_000;
  for (let k = 0; k < ticks; k += 1) {
    const rows = [];
    for (let r = 0; r < perHostPerTick; r += 1) {
      for (let h = 0; h < hosts; h += 1) {
        rows.push([t, (h * 7 + k) % 100, (k % 5) + 1, names[h]]);
      }
      t += stepMs;
    }
    batches.push(rows);
  }
  return batches;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function run(backing, batches, withRolling) {
  const live = new LiveSeries({
    name: 's',
    schema,
    ordering: 'strict',
    retention: { maxAge: '30s' },
    __backing: backing,
  });
  const parts = live.partitionBy('host');
  let emitted = 0;
  if (withRolling) {
    const trigger = Trigger.clock(Sequence.every('200ms'));
    const fused = parts.rolling(
      {
        '1m': {
          cpu_avg: { from: 'cpu', using: 'avg' },
          cpu_sd: { from: 'cpu', using: 'stdev' },
          cpu_n: { from: 'cpu', using: 'count' },
          requests_sum: { from: 'requests', using: 'sum' },
        },
        '200ms': {
          cpu_samples: { from: 'cpu', using: 'samples' },
          cpu_min: { from: 'cpu', using: 'min' },
          cpu_max: { from: 'cpu', using: 'max' },
        },
      },
      { trigger },
    );
    fused.on('event', () => {
      emitted += 1;
    });
  }
  const t0 = performance.now();
  for (const b of batches) live.pushMany(b);
  return { ms: performance.now() - t0, emitted };
}

function bench(label, backing, batches, withRolling, repeats = 7) {
  for (let i = 0; i < 2; i += 1) run(backing, batches, withRolling);
  const samples = [];
  let emitted = 0;
  for (let i = 0; i < repeats; i += 1) {
    const r = run(backing, batches, withRolling);
    samples.push(r.ms);
    emitted = r.emitted;
  }
  const rows = batches.reduce((n, b) => n + b.length, 0);
  const ms = median(samples);
  return {
    label,
    backing,
    rows,
    medianMs: Number(ms.toFixed(1)),
    rowsPerSec: Math.round(rows / (ms / 1000)),
    emitted,
  };
}

const cells = [
  // name, hosts, ticks, rows per host per batch, ms between rows
  ['1000 hosts x 1 row/batch (100 ev/s/host)', 1000, 300, 1, 10],
  ['1000 hosts x 10 rows/batch (1000 ev/s/host)', 1000, 30, 10, 1],
  ['100 hosts x 10 rows/batch', 100, 300, 10, 1],
];

const results = [];
for (const [name, hosts, ticks, per, step] of cells) {
  const batches = makeBatches(hosts, ticks, per, step);
  for (const withRolling of [true, false]) {
    for (const backing of ['auto', 'array']) {
      results.push(
        bench(
          `${name}${withRolling ? ' + fused rolling' : ' (no listener)'}`,
          backing,
          batches,
          withRolling,
        ),
      );
    }
  }
}
console.log(JSON.stringify(results, null, 2));
