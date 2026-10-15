// [PND-LVWIN] — cost of keeping a `live.window()` view up to date.
//
// Before the fix, the view evicted with `events.splice(0, count)` after
// every arriving event, shifting the whole window each time: O(W) per
// event, O(B·W) per push of B events into a full window of W. It now
// advances a head index and compacts the array once the evicted prefix
// outgrows the window: O(1) amortized per event, O(B) per push. The push
// that triggers a compaction copies the window once, O(B + W), about
// every W/B pushes — so each scenario runs at least 2.2 compaction cycles
// and reports the mean and max alongside the median, which never sees
// those pushes. Reads (`keyColumn()` / `column()`) stay O(W).
//
// Every scenario pushes into the same source, with no retention, so the
// "no view" rows differ from the window rows only by the view. One
// untimed pass of each kind runs first to warm up the JIT.
//
// Scenarios: time and count windows from 1k to 100k events, 160 and 1,600
// ticks a push (10k and 100k ticks/s every 16 ms); a window of 1 (the
// per-event floor); two windows on a retention-capped source; and a
// per-frame column read at 50k.
//
// The retention rows cost more for a reason outside the window: a view
// listens for the source's `'evict'` (to mirror its eviction), and a
// columnar source with an `'evict'` listener builds an Event for every
// row it drops, about 1 ms a push at 1,600 rows. The same listener on a
// source with no view costs the same.
//
//   npm run build --workspace=pond-ts
//   node scripts/perf-live-window.mjs

import { performance } from 'node:perf_hooks';
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

/** The window's time span when `windowEvents` events arrive `batch` per 16 ms. */
const spanMs = (windowEvents, batch) => (windowEvents * 16) / batch;

/**
 * Per-push timings once the window is full. `window` is what to pass to
 * `live.window()` (or null for no view); `windowEvents` how many events
 * the window holds, so it can be filled first and timed for at least 2.2
 * compaction cycles. `trimMs` lists the pushes that compacted the view's
 * buffer (seen through the internal `_bufferLength`). The max can be
 * larger than any of them: it also catches garbage-collection pauses,
 * which land on whichever push is running.
 */
function benchmark({ window, windowEvents, batch, retention }) {
  const next = makeFeed(batch);
  const live = new LiveSeries({ name: 'w', schema, retention });
  const view = window === null ? null : live.window(window);
  const fill = Math.ceil((windowEvents * 1.2) / batch) + 3;
  for (let k = 0; k < fill; k++) live.pushMany(next());
  const pushes = Math.max(30, Math.ceil((windowEvents * 2.2) / batch));
  const samples = [];
  const trims = [];
  for (let k = 0; k < pushes; k++) {
    const rows = next();
    const slots = view?._bufferLength;
    const start = performance.now();
    live.pushMany(rows);
    const ms = performance.now() - start;
    samples.push(ms);
    if (view && view._bufferLength < slots) trims.push(ms);
  }
  const length = view ? view.length : live.length;
  view?.dispose();
  const trimMs = trims.map((ms) => Number(ms.toFixed(3)));
  return { ...stats(samples), trimMs, length };
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
  benchmark({ window, windowEvents: 1_000, batch: 160 }); // warm-up, untimed

const results = [];
const print = (name, r, unit) =>
  console.log(
    `${name.padEnd(48)} median ${String(r.medianMs).padStart(8)}  mean ${String(r.meanMs).padStart(8)}  max ${String(r.maxMs).padStart(8)} ms/${unit}  (${r.samples} ${unit === 'push' ? 'pushes' : 'reads'}${r.length === undefined ? '' : `, ${r.length} events`})${r.trimMs?.length ? `  trims ${r.trimMs.join(', ')} ms` : ''}`,
  );
const run = (name, args) => {
  const r = benchmark(args);
  results.push({ name, ...r });
  print(name, r, 'push');
};

for (const batch of [160, 1600])
  for (const W of [1_000, 10_000, 50_000, 100_000]) {
    run(`no view        W=${W} batch=${batch}`, {
      window: null,
      windowEvents: W,
      batch,
    });
    run(`time window    W=${W} batch=${batch}`, {
      window: `${spanMs(W, batch)}ms`,
      windowEvents: W,
      batch,
    });
    run(`count window   W=${W} batch=${batch}`, {
      window: W,
      windowEvents: W,
      batch,
    });
  }
run('count window   W=1 batch=1600 (per-event floor)', {
  window: 1,
  windowEvents: 1,
  batch: 1600,
});
run('time window 50k, source retention 2x, batch=1600', {
  window: `${spanMs(50_000, 1600)}ms`,
  windowEvents: 50_000,
  batch: 1600,
  retention: { maxAge: `${2 * spanMs(50_000, 1600)}ms` },
});
run('retention 50k + count window 100k, batch=1600', {
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
