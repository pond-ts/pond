// Chart-extraction spike for Phase 4.7 step 2 → step 8.
//
// Hypothesis: a chart adapter walking the typed-array buffers directly
// via `series.column('value').toFloat64Array()` + `series.keyColumn().begin` is
// dramatically faster than the row-API path
// (`series.events[i].get('value')` + `series.events[i].begin()`).
//
// What we measure:
//   1. Pure walk cost — N rows, two reads per row (X, Y), arithmetic
//      simulating a draw call. No actual canvas — Node has no
//      built-in 2D context. The walk is the proxy for "how much can
//      the chart push before per-frame becomes the bottleneck."
//   2. Three access paths:
//      (a) Row API: `series.events[i].get('value')` — what a chart
//          adapter would write today if it didn't know about the
//          substrate. Forces full event materialization on first
//          access.
//      (b) Columnar API: `series.column('value').toFloat64Array()[i]` — the
//          minimum-viable shape this spike adds.
//      (c) Hoisted refs: same as (b) but the typed arrays are
//          dereferenced once before the loop, so the inner loop is
//          pure typed-array access. Models "chart caches the typed-
//          array view between renders."
//
// Frame target: 60 fps ⇒ 16.7 ms / frame. A render that walks every
// point in 16 ms can sustain 60 fps. Past that, the chart has to
// downsample or render incrementally.

import { performance } from 'node:perf_hooks';
import { TimeSeries } from '../dist/index.js';

const SCHEMA = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
]);

function makeRows(length) {
  return Array.from({ length }, (_, i) => [1_000 + i, Math.sin(i / 100) * 50]);
}

function median(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}

function bench(label, fn, repeats = 10) {
  // Warm up.
  for (let i = 0; i < 3; i += 1) fn();
  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return {
    label,
    medianMs: Number(median(samples).toFixed(2)),
    minMs: Number(Math.min(...samples).toFixed(2)),
    maxMs: Number(Math.max(...samples).toFixed(2)),
  };
}

const N = 1_000_000;
const rows = makeRows(N);

const results = [];

// (a) Row API — what a chart adapter would write without substrate access.
{
  const series = new TimeSeries({ name: 's', schema: SCHEMA, rows });
  results.push(
    bench(`(a) row API — series.events[i].get('value') × ${N}`, () => {
      // First access triggers full lazy event materialization.
      const events = series.events;
      let sum = 0;
      for (let i = 0; i < events.length; i += 1) {
        const e = events[i];
        sum += e.begin() + e.get('value');
      }
      // Use sum so JIT can't dead-code-eliminate.
      if (sum === 1 / 0) throw new Error('unreachable');
    }),
  );
}

// (b) Columnar API — fresh series each call (chart re-renders against
//     a new series, like after a store update).
results.push(
  bench(
    `(b) columnar API — series.column('value').toFloat64Array()[i] × ${N} (fresh series)`,
    () => {
      const series = new TimeSeries({ name: 's', schema: SCHEMA, rows });
      const xs = series.keyColumn().begin;
      const ys = series.column('value').toFloat64Array();
      let sum = 0;
      for (let i = 0; i < xs.length; i += 1) {
        sum += xs[i] + ys[i];
      }
      if (sum === 1 / 0) throw new Error('unreachable');
    },
  ),
);

// (c) Hoisted refs — typed-array views dereferenced once outside the
//     bench loop. Models "chart caches the typed arrays between
//     renders; only the inner loop runs per frame."
{
  const series = new TimeSeries({ name: 's', schema: SCHEMA, rows });
  const xs = series.keyColumn().begin;
  const ys = series.column('value').toFloat64Array();
  results.push(
    bench(`(c) hoisted typed arrays — pure inner loop × ${N}`, () => {
      let sum = 0;
      for (let i = 0; i < xs.length; i += 1) {
        sum += xs[i] + ys[i];
      }
      if (sum === 1 / 0) throw new Error('unreachable');
    }),
  );
}

// (d) Compare: cost of just building the series (sub-step 2c benchmark
//     anchor). Lets us see whether substrate access is dominated by
//     build or by walk.
results.push(
  bench(`(d) build only — new TimeSeries × ${N}`, () => {
    new TimeSeries({ name: 's', schema: SCHEMA, rows });
  }),
);

console.log(JSON.stringify(results, null, 2));

// Quick frame-budget translation: at 60 fps the budget is 16.7 ms.
const c = results[2];
const fps = 1000 / c.medianMs;
console.log(
  `\nframe-budget translation: hoisted-typed-array walk = ${c.medianMs} ms ⇒ ` +
    `${fps.toFixed(0)} fps single-pass, ` +
    `${Math.floor(16.7 / c.medianMs)} sustained 60-fps frames per render.`,
);
