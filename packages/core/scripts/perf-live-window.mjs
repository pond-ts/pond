// [PND-LVWIN] — cost of keeping a `live.window()` view up to date.
//
// Before the fix, the view evicted with `events.splice(0, count)` after
// every arriving event, shifting the whole window each time: O(W) per
// event, O(B·W) per push of B events into a full window of W. It now
// advances a head index and compacts the array once the evicted prefix
// outgrows the window: O(1) amortized per event, O(B) per push. Reads
// (`keyColumn()` / `column()`) stay O(W).
//
// Scenarios: time and count windows from 1k to 100k events, 160 and 1,600
// ticks a push (10k and 100k ticks/s every 16 ms); a window of 1 (the
// per-event floor); a window on a retention-capped source (eviction
// mirrored from the source); and a per-frame column read at 50k.
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

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
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

/**
 * Median ms per push once the window is full. `window` is what to pass to
 * `live.window()` (or null for no view); `windowEvents` how many events
 * the window holds, so it can be filled first.
 */
function benchmark({ window, windowEvents, batch, retention, pushes = 30 }) {
  const next = makeFeed(batch);
  const live = new LiveSeries({ name: 'w', schema, retention });
  const view = window === null ? null : live.window(window);
  const fill = Math.ceil((windowEvents * 1.2) / batch) + 3;
  for (let k = 0; k < fill; k++) live.pushMany(next());
  const samples = [];
  for (let k = 0; k < pushes; k++) {
    const rows = next();
    const start = performance.now();
    live.pushMany(rows);
    samples.push(performance.now() - start);
  }
  const length = view ? view.length : live.length;
  view?.dispose();
  return { medianMs: Number(median(samples).toFixed(3)), length };
}

function readBenchmark(windowEvents, repeats = 30) {
  const batch = 160;
  const next = makeFeed(batch);
  const live = new LiveSeries({ name: 'w', schema });
  const view = live.window(`${(windowEvents * 16) / batch}ms`);
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
  return { medianMs: Number(median(samples).toFixed(3)) };
}

const results = [];
const run = (name, args) => {
  const r = benchmark(args);
  results.push({ name, ...r });
  console.log(
    `${name.padEnd(48)} ${String(r.medianMs).padStart(9)} ms/push  (${r.length} events)`,
  );
};

for (const batch of [160, 1600])
  for (const W of [1_000, 10_000, 50_000, 100_000]) {
    const ms = (W * 16) / batch;
    run(`no view        W=${W} batch=${batch}`, {
      window: null,
      windowEvents: W,
      batch,
      retention: { maxAge: `${ms}ms` },
    });
    run(`time window    W=${W} batch=${batch}`, {
      window: `${ms}ms`,
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
run('retention 50k + count window 100k, batch=1600', {
  window: 100_000,
  windowEvents: 50_000,
  batch: 1600,
  retention: { maxEvents: 50_000 },
});
{
  const r = readBenchmark(50_000);
  results.push({ name: 'read keyColumn + column, W=50k', ...r });
  console.log(
    `${'read keyColumn + column, W=50k'.padEnd(48)} ${String(r.medianMs).padStart(9)} ms/read`,
  );
}

console.log(JSON.stringify({ node: process.version, results }));
