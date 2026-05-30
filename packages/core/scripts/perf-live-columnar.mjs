// Phase 1 in-pond bench — chunked columnar LiveSeries vs Event[] backing.
//
// Confirms the spike's win (investigate-batch.mjs) survives the real
// LiveSeries integration: batched pushMany on a top-level strict
// time-keyed series, chunked (auto-selected) vs array (forced via the
// internal __backing option). Measures ingest throughput, toTimeSeries
// cost, and — the headline — retained heap for a full window.
//
//   npm run build --workspace=pond-ts
//   node --expose-gc scripts/perf-live-columnar.mjs                 # timing
//   node --expose-gc scripts/perf-live-columnar.mjs --heap=chunked
//   node --expose-gc scripts/perf-live-columnar.mjs --heap=array
//
// Schema mirrors the gRPC aggregator shape: time + two numbers + a
// host string (the string column dict-encodes repeated hosts — part
// of the heap win). Heap is measured in process isolation per backing.

import { performance } from 'node:perf_hooks';
import { LiveSeries } from '../dist/index.js';

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'requests', kind: 'number' },
  { name: 'host', kind: 'string' },
]);

const HOSTS = Array.from({ length: 100 }, (_, i) => `api-${i}`);

function makeBatches(total, batchSize) {
  const batches = [];
  for (let b = 0; b < total / batchSize; b += 1) {
    const rows = new Array(batchSize);
    for (let i = 0; i < batchSize; i += 1) {
      const idx = b * batchSize + i;
      rows[i] = [
        1000 + idx,
        idx % 100,
        (idx % 7) + 1,
        HOSTS[idx % HOSTS.length],
      ];
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

function bench(label, fn, repeats = 8) {
  for (let i = 0; i < 2; i += 1) fn();
  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return {
    label,
    medianMs: Number(median(samples).toFixed(2)),
  };
}

function makeLive(backing, maxEvents) {
  return new LiveSeries({
    name: 's',
    schema,
    ordering: 'strict',
    retention: { maxEvents },
    __backing: backing, // 'auto' → chunked (strict+time); 'array' → Event[]
  });
}

function heapMB() {
  globalThis.gc?.();
  globalThis.gc?.();
  globalThis.gc?.();
  return process.memoryUsage();
}

/* ── Heap mode: one backing, full window, settled ─────────────────── */
const heapMode = process.argv
  .find((a) => a.startsWith('--heap='))
  ?.slice('--heap='.length);

if (heapMode) {
  const W = 200_000;
  const backing = heapMode === 'array' ? 'array' : 'auto';
  let batches = makeBatches(W, 1_000);
  const live = makeLive(backing, W);
  for (let b = 0; b < batches.length; b += 1) live.pushMany(batches[b]);
  batches = null;
  const m = heapMB();
  if (live.length !== W) throw new Error(`bad length ${live.length}`);
  console.log(
    JSON.stringify({
      heap: {
        backing: heapMode === 'array' ? 'Event[]' : 'chunked',
        windowSize: W,
        retainedHeapMB: Number((m.heapUsed / 1048576).toFixed(1)),
        rssMB: Number((m.rss / 1048576).toFixed(1)),
        length: live.length,
      },
    }),
  );
  process.exit(0);
}

/* ── Timing: batched ingest (with + without an 'event' listener) ──── */
const results = [];
const TOTAL = 300_000;
const BATCH = 1_000;
const W = 50_000;
const batches = makeBatches(TOTAL, BATCH);

for (const backing of ['auto', 'array']) {
  const label = backing === 'auto' ? 'chunked' : 'Event[]';

  // No listeners — the pure storage win (chunked creates no Event).
  results.push(
    bench(`pushMany ${TOTAL} (no listener) / ${label}`, () => {
      const live = makeLive(backing, W);
      for (let b = 0; b < batches.length; b += 1) live.pushMany(batches[b]);
    }),
  );

  // With an 'event' listener — the realistic case (e.g. the partition
  // router subscribes). Chunked materializes transient events here.
  results.push(
    bench(`pushMany ${TOTAL} (event listener) / ${label}`, () => {
      const live = makeLive(backing, W);
      let sink = 0;
      live.on('event', (e) => {
        sink += e.get('cpu');
      });
      for (let b = 0; b < batches.length; b += 1) live.pushMany(batches[b]);
      if (sink < 0) throw new Error('unreachable');
    }),
  );
}

/* ── toTimeSeries over a full window ──────────────────────────────── */
for (const backing of ['auto', 'array']) {
  const label = backing === 'auto' ? 'chunked' : 'Event[]';
  const live = makeLive(backing, 50_000);
  for (let b = 0; b < 50; b += 1) live.pushMany(batches[b]);
  results.push(
    bench(`toTimeSeries (window=50k) / ${label}`, () => {
      live.toTimeSeries();
    }),
  );
}

console.log(JSON.stringify({ timing: results }, null, 2));
if (!globalThis.gc)
  console.error('\n[warn] run with --expose-gc for heap mode');
