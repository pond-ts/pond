// Arc P1 sizing — is the downsampled band gather actually hot?
//
// The split bench (perf-baseline-memo-split.mjs) measured the gather on a
// DENSE synthetic collected series. But the synchronized rolling output is
// clock-DOWNSAMPLED: sync/fused emit one frame per partition per clock tick,
// so the collected baseline has only (window / clock) points per host, not
// one per raw event. This bench measures the band-specific gather (avg + sd
// per host) at realistic (clock rate × host count) cells, vs the 16.7ms frame
// budget — to decide whether chunking the rolling output earns ANY change, or
// whether the bands stay on increment-1's allocation-skip gather.
//
//   npm run build --workspace=pond-ts
//   node --expose-gc scripts/perf-band-gather.mjs

import { performance } from 'node:perf_hooks';
import { LiveSeries } from '../dist/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'host', kind: 'string' },
  { name: 'cpu', kind: 'number' },
  { name: 'avg', kind: 'number' },
  { name: 'sd', kind: 'number' },
  { name: 'n', kind: 'number' },
];

const WINDOW_MS = 300_000; // 5-minute chart window
const FRAME_MS = 1000 / 60; // 16.7ms budget

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
  return Number(median(samples).toFixed(3));
}

// A collected rolling output: synchronized frames — for each tick, one
// partition-tagged row per host (the interleaved order #emitTick produces).
function makeView(hosts, ptsPerHost, clockMs) {
  const live = new LiveSeries({
    name: 'collected',
    schema,
    ordering: 'strict',
    retention: { maxEvents: hosts * ptsPerHost },
    __backing: 'array', // collect() output
  });
  const BATCH = 4_000;
  let buf = [];
  for (let t = 0; t < ptsPerHost; t += 1) {
    const ts = 1000 + t * clockMs;
    for (let h = 0; h < hosts; h += 1) {
      const v = (t + h) % 97;
      buf.push([ts, `host-${h}`, v, v + 0.5, (t % 13) / 7, 30]);
      if (buf.length === BATCH) {
        live.pushMany(buf);
        buf = [];
      }
    }
  }
  if (buf.length) live.pushMany(buf);
  return live.window(hosts * ptsPerHost);
}

// The band gather: per host, extract avg + sd as typed arrays (what the
// dashboard's ±σ band needs). This is the cost a zero-copy read would attack.
function bandGather(view) {
  return view.partitionBy('host').toMap((g) => ({
    avg: g.column('avg').toFloat64Array(),
    sd: g.column('sd').toFloat64Array(),
  }));
}

const CLOCKS = [
  { clockMs: 1000, label: '1s' },
  { clockMs: 500, label: '500ms' },
  { clockMs: 200, label: '200ms' },
];
const HOSTS = [8, 32, 64, 256];

// Global JIT warmup — so the first measured cell isn't cold (an earlier run
// showed a ~1ms fixed overhead only the first-timed cell paid).
{
  const w = makeView(16, 500, 1000);
  for (let i = 0; i < 30; i += 1) bandGather(w);
}

const rows = [];
for (const { clockMs, label } of CLOCKS) {
  const ptsPerHost = Math.round(WINDOW_MS / clockMs);
  for (const hosts of HOSTS) {
    const view = makeView(hosts, ptsPerHost, clockMs);
    const ms = bench(() => bandGather(view));
    rows.push({
      clock: label,
      hosts,
      ptsPerHost,
      rows: hosts * ptsPerHost,
      bandGatherMs: ms,
      pctFrame: Number(((100 * ms) / FRAME_MS).toFixed(1)),
    });
  }
}

console.log(JSON.stringify({ bandGather: rows }, null, 2));
console.log(
  `\npctFrame = bandGatherMs / ${FRAME_MS.toFixed(1)}ms frame budget.\n` +
    'Low (<~10%) at typical cells → bands stay on increment-1; the gather\n' +
    'is not the bottleneck and chunking the rolling output earns no change.\n' +
    'High only at fast-clock × high-host ceilings → revisit only if that is\n' +
    'a real target (and even then, prefer no new public surface).',
);
if (!globalThis.gc)
  console.error('\n[note] run with --expose-gc for stable GC timing');
