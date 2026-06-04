// Perf check — LiveView.toTimeSeries() identical-state snapshot cache.
//
// Dashboard flush-cost friction: back-to-back identical view.toTimeSeries()
// calls (multiple subscribers, React commit batching, StrictMode double-
// invoke) rebuilt the whole TimeSeries each time — ~28 redundant flushes per
// worst commit × ~40ms = >1s React commits at 256 hosts. The cache memoizes
// the built snapshot keyed by a mutation counter, so identical-state calls
// return by reference.
//
// This addresses the report's issue #1 (identical-state caching). It does NOT
// change issue #2 (O(buffer) not O(delta) when events DID arrive — the cold
// build below is unchanged; an incremental build is a separate optimization).
//
//   npm run build --workspace=pond-ts
//   node --expose-gc scripts/perf-snapshot-cache.mjs

import { performance } from 'node:perf_hooks';
import { LiveSeries } from '../dist/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
  { name: 'host', kind: 'string' },
];

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function bench(fn, repeats = 9) {
  for (let i = 0; i < 3; i += 1) fn();
  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return median(samples);
}

function prime(bufferSize) {
  const live = new LiveSeries({
    name: 's',
    schema,
    retention: { maxEvents: bufferSize },
  });
  const rows = new Array(bufferSize);
  for (let i = 0; i < bufferSize; i += 1)
    rows[i] = [1000 + i, i % 97, `h${i % 64}`];
  live.pushMany(rows);
  const view = live.filter(() => true);
  return { live, view };
}

const SIZES = [16_384, 65_536, 262_144];
const out = [];
for (const n of SIZES) {
  // Cache hit: prime the cache once, then time back-to-back identical calls.
  const warm = prime(n);
  warm.view.toTimeSeries(); // prime
  const cachedHitMs = bench(() => warm.view.toTimeSeries());

  // Cold build: each iter a single event arrives (evicting one, buffer
  // stable), forcing a fresh rebuild — the per-call cost without a cache.
  const cold = prime(n);
  let t = 1000 + n;
  const coldBuildMs = bench(() => {
    cold.live.push([t++, t % 97, 'h0']);
    cold.view.toTimeSeries();
  });

  out.push({
    events: n,
    coldBuildMs: Number(coldBuildMs.toFixed(3)),
    cachedHitMs: Number(cachedHitMs.toFixed(4)),
    speedup: Math.round(coldBuildMs / Math.max(cachedHitMs, 1e-4)),
  });
}

console.log(JSON.stringify({ snapshotCache: out }, null, 2));
console.log(
  '\ncoldBuildMs = a rebuild after an event arrived (unchanged by this PR).\n' +
    'cachedHitMs = a back-to-back identical-state call (the redundant flushes\n' +
    'the dashboard hit). speedup = how much those redundant calls now cost less.',
);
if (!globalThis.gc)
  console.error('\n[note] run with --expose-gc for stable GC timing');
