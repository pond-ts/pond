// [PND-LVWIN] — cost of keeping a `live.window()` view up to date.
//
// Before the fix, the view evicted with `events.splice(0, count)` after
// every arriving event, shifting the whole window each time: O(W) per
// event, O(B·W) per push of B events into a full window of W. It now
// advances a head index and compacts the array once the evicted prefix
// outgrows the window: O(1) amortized per event, O(B) per push. The push
// that triggers a compaction copies the window once, O(B + W), about
// every W/B pushes — so each push scenario runs at least 2.2 compaction
// cycles and reports the mean, the max and each compacting push alongside
// the median, which never sees those pushes. Reads (`keyColumn()` /
// `column()`) stay O(W).
//
// Garbage collection lands on whichever push is running, so it is tracked
// per push (a `PerformanceObserver` on 'gc'): `maxNoGcMs` is the slowest
// push that no GC pause overlapped, `gcPushes` how many were overlapped,
// and a compacting push that one overlapped is marked `(gc)`.
//
// Scenarios: time and count windows from 1k to 100k events, 160 and 1,600
// ticks a push (10k and 100k ticks/s every 16 ms), each beside a "no
// view" row on the same unretained source, so the two differ only by the
// view; a window of 1 (the per-event floor); two windows on a
// retention-capped source, filled until retention is dropping rows; and
// 30 per-frame column reads at 50k. One untimed pass of each push kind
// runs first to warm up the JIT.
//
// The retention rows also pay for something outside the window: a view
// listens for the source's `'evict'` (to mirror its eviction), and a
// columnar source with an `'evict'` listener builds an Event for every
// row it drops ([PND-LVMIRROR]).
//
//   npm run build --workspace=pond-ts
//   node scripts/perf-live-window.mjs

import { performance, PerformanceObserver } from 'node:perf_hooks';
import { LiveSeries } from '../dist/index.js';

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'price', kind: 'number' },
  { name: 'size', kind: 'number' },
]);

function stats(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const round = (value) => Number(value.toFixed(3));
  return {
    medianMs: round(median),
    meanMs: round(mean),
    maxMs: round(sorted[sorted.length - 1]),
    samples: samples.length,
  };
}

/** A feed of `batch`-row pushes, `step` ms apart, 16 ms per push. */
function makeFeed(batch) {
  const step = 16 / batch;
  let t = 1e12;
  let p = 100;
  return () => {
    const rows = new Array(batch);
    for (let i = 0; i < batch; i++) {
      p += Math.sin(t + i) * 0.1;
      rows[i] = [t + i * step, p, 1];
    }
    t += 16;
    return rows;
  };
}

const gcPauses = [];
new PerformanceObserver((list) => {
  for (const entry of list.getEntries())
    gcPauses.push([entry.startTime, entry.startTime + entry.duration]);
}).observe({ entryTypes: ['gc'] });

/** Whether a GC pause overlapped [start, end]; call after GC entries flush. */
const hadGc = ([start, end]) =>
  gcPauses.some(([gcStart, gcEnd]) => gcStart < end && gcEnd > start);

/** The window's time span when `windowEvents` events arrive `batch` per 16 ms. */
const spanMs = (windowEvents, batch) => (windowEvents * 16) / batch;

/**
 * Per-push timings once the window is full. `window` is what to pass to
 * `live.window()` (or null for no view); `windowEvents` how many events
 * the window holds, so it can be filled first and timed for at least 2.2
 * compaction cycles; `fill` how many window-lengths to push first.
 * `trimMs` lists the pushes that compacted the view's buffer (seen
 * through the internal `_buffer`; absent on builds without it).
 */
async function benchmark({
  window,
  windowEvents,
  batch,
  retention,
  fill = 1.2,
}) {
  const next = makeFeed(batch);
  const live = new LiveSeries({ name: 'w', schema, retention });
  const view = window === null ? null : live.window(window);
  const fillPushes = Math.ceil((windowEvents * fill) / batch) + 3;
  for (let k = 0; k < fillPushes; k++) live.pushMany(next());
  const pushes = Math.max(30, Math.ceil((windowEvents * 2.2) / batch));
  const spans = [];
  const trimmed = [];
  for (let k = 0; k < pushes; k++) {
    const rows = next();
    const slots = view?._buffer?.length;
    const start = performance.now();
    live.pushMany(rows);
    spans.push([start, performance.now()]);
    if (slots !== undefined && view._buffer.length < slots) trimmed.push(k);
  }
  const length = view ? view.length : live.length;
  view?.dispose();
  await new Promise((resolve) => setTimeout(resolve, 20)); // flush GC entries
  const ms = (k) => spans[k][1] - spans[k][0];
  const clean = spans.filter((span) => !hadGc(span));
  const round = (value) => Number(value.toFixed(3));
  return {
    ...stats(spans.map((span) => span[1] - span[0])),
    maxNoGcMs: clean.length
      ? round(Math.max(...clean.map((span) => span[1] - span[0])))
      : null,
    gcPushes: spans.length - clean.length,
    trims: trimmed.map((k) => ({ ms: round(ms(k)), gc: hadGc(spans[k]) })),
    length,
  };
}

function readBenchmark(windowEvents, repeats = 30) {
  const batch = 160;
  const next = makeFeed(batch);
  const live = new LiveSeries({ name: 'w', schema });
  const view = live.window(`${spanMs(windowEvents, batch)}ms`);
  for (let k = 0; k < Math.ceil((windowEvents * 1.2) / batch) + 3; k++)
    live.pushMany(next());
  const samples = [];
  for (let k = 0; k < repeats; k++) {
    live.pushMany(next()); // leave an evicted prefix in front of the window
    const start = performance.now();
    const t = view.keyColumn().begin;
    const p = view.column('price').toFloat64Array();
    samples.push(performance.now() - start);
    if (t.length !== p.length) throw new Error('column lengths differ');
  }
  view.dispose();
  return stats(samples);
}

for (const window of [null, '160ms', 1_000])
  await benchmark({ window, windowEvents: 1_000, batch: 160 }); // warm-up

const results = [];
const print = (name, r, unit) =>
  console.log(
    `${name.padEnd(48)} median ${String(r.medianMs).padStart(8)}  mean ${String(r.meanMs).padStart(8)}  max ${String(r.maxMs).padStart(8)}${r.gcPushes === undefined ? '' : `  max without GC ${String(r.maxNoGcMs).padStart(8)}`} ms/${unit}  (${r.samples} ${unit === 'push' ? 'pushes' : 'reads'}${r.gcPushes === undefined ? '' : `, ${r.gcPushes} with GC`}${r.length === undefined ? '' : `, ${r.length} events`})${r.trims?.length ? `  trims ${r.trims.map((t) => `${t.ms}${t.gc ? '(gc)' : ''}`).join(', ')} ms` : ''}`,
  );
const run = async (name, args) => {
  const r = await benchmark(args);
  results.push({ name, ...r });
  print(name, r, 'push');
};

for (const batch of [160, 1600])
  for (const W of [1_000, 10_000, 50_000, 100_000]) {
    await run(`no view        W=${W} batch=${batch}`, {
      window: null,
      windowEvents: W,
      batch,
    });
    await run(`time window    W=${W} batch=${batch}`, {
      window: `${spanMs(W, batch)}ms`,
      windowEvents: W,
      batch,
    });
    await run(`count window   W=${W} batch=${batch}`, {
      window: W,
      windowEvents: W,
      batch,
    });
  }
await run('count window   W=1 batch=1600 (per-event floor)', {
  window: 1,
  windowEvents: 1,
  batch: 1600,
});
await run('time window 50k, source retention 2x, batch=1600', {
  window: `${spanMs(50_000, 1600)}ms`,
  windowEvents: 50_000,
  batch: 1600,
  retention: { maxAge: `${2 * spanMs(50_000, 1600)}ms` },
  fill: 2.2, // past the retention span, so every timed push drops rows
});
await run('retention 50k + count window 100k, batch=1600', {
  window: 100_000,
  windowEvents: 50_000,
  batch: 1600,
  retention: { maxEvents: 50_000 },
});
{
  const name = 'read keyColumn + column, W=50k';
  const r = readBenchmark(50_000);
  results.push({ name, ...r });
  print(name, r, 'read');
}

console.log(JSON.stringify({ node: process.version, results }));
