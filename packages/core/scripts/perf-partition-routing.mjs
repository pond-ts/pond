// Phase 2 in-pond bench — column-native partition routing.
//
// Compares partitioned live ingest with the partition sub-series on the
// chunked columnar backing (column-native routing via scatter, the
// gRPC-V6-earned OOM fix) vs the Event[] backing (per-event routing, the
// pre-Phase-2 behavior). A/B'd via the SOURCE's `__backing`: a chunked
// source routes column-native into chunked partitions; an array source
// routes per-event into Event[] partitions.
//
//   npm run build --workspace=pond-ts
//   node --expose-gc scripts/perf-partition-routing.mjs                 # timing
//   node --expose-gc scripts/perf-partition-routing.mjs --heap=auto     # chunked partitions
//   node --expose-gc scripts/perf-partition-routing.mjs --heap=array    # Event[] partitions
//
// Mirrors the gRPC aggregator shape: 100 hosts, time + two numbers + a
// host string, partitionBy('host'). Heap is measured in process
// isolation per backing (the retained-partition-window heap is the
// headline the V6 re-bench said #170 missed).
//
// CAVEAT — the heap numbers here are INDICATIVE, not authoritative.
// `process.memoryUsage().heapUsed` after forced GC proved unreliable
// during this work (it misreported a >37 MB retained state as ~6.6 MB in
// one configuration). Trust the DIRECTION + the committed-chunk count
// (deterministic, from the flush threshold) and the throughput timing
// (stable); for the real retained-heap verdict, the gRPC experiment's
// heap-snapshot tooling (V6/V7/V8 in friction-notes/columnar-rebench.md)
// is the arbiter.

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

function bench(label, fn, repeats = 6) {
  for (let i = 0; i < 2; i += 1) fn();
  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return { label, medianMs: Number(median(samples).toFixed(2)) };
}

// `__backing: 'array'` forces the source (and thus its partitions) onto
// the Event[] path; `'auto'` lets the strict+time source pick chunked,
// which routes column-native into chunked partitions.
function makePartitioned(backing, retention) {
  const live = new LiveSeries({
    name: 's',
    schema,
    ordering: 'strict',
    retention,
    __backing: backing,
  });
  const byHost = live.partitionBy('host');
  return { live, byHost };
}

function heapMB() {
  globalThis.gc?.();
  globalThis.gc?.();
  globalThis.gc?.();
  return process.memoryUsage();
}

/* ── Heap mode: one backing, full retained window across 100 partitions ── */
const heapMode = process.argv
  .find((a) => a.startsWith('--heap='))
  ?.slice('--heap='.length);

if (heapMode) {
  const W = 200_000; // total events; ~2k per host across 100 hosts
  const backing = heapMode === 'array' ? 'array' : 'auto';
  let batches = makeBatches(W, 1_000);
  // No retention: keep the full window so the retained-partition heap is
  // the whole W split across partitions (the OOM-shaped measurement).
  const { live, byHost } = makePartitioned(backing, undefined);
  for (let b = 0; b < batches.length; b += 1) live.pushMany(batches[b]);
  batches = null;
  const parts = byHost.toMap();
  let total = 0;
  for (const p of parts.values()) total += p.length;
  const m = heapMB();
  if (total !== W) throw new Error(`bad partition total ${total} (want ${W})`);
  console.log(
    JSON.stringify({
      heap: {
        backing:
          backing === 'array' ? 'Event[] partitions' : 'chunked partitions',
        windowSize: W,
        partitions: parts.size,
        retainedHeapMB: Number((m.heapUsed / 1048576).toFixed(1)),
        rssMB: Number((m.rss / 1048576).toFixed(1)),
        perPartition: total / parts.size,
      },
    }),
  );
  process.exit(0);
}

/* ── Timing: batched partitioned ingest throughput ──────────────────── */
const results = [];
const TOTAL = 300_000;
const BATCH = 1_000;
const batches = makeBatches(TOTAL, BATCH);

for (const backing of ['auto', 'array']) {
  const label = backing === 'auto' ? 'chunked-routed' : 'Event[]-routed';
  results.push(
    bench(`partitioned pushMany ${TOTAL} / 100 hosts / ${label}`, () => {
      const { live } = makePartitioned(backing, { maxEvents: 50_000 });
      for (let b = 0; b < batches.length; b += 1) live.pushMany(batches[b]);
    }),
  );
}

console.log(JSON.stringify({ timing: results }, null, 2));
if (!globalThis.gc)
  console.error('\n[warn] run with --expose-gc for heap mode');
