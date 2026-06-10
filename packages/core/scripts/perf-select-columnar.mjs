// Perf check — Step 4 column-native select() (transforms read columns).
//
// The consultant's finding: batch operators read this.events, so the 3.6×
// columnar construction win evaporates for pipeline users at the first
// transform. select() now reshapes the store directly (withColumnsSelected +
// #fromTrustedStore) — zero-copy column reference, no events materialized.
//
// Complexity. Old: materialize N events (lazy) + N per-event .select() (new
// Event each) + columnarize back into a store — all O(N), event-touching.
// New: pick the chosen column refs + share the key axis — O(#columns), zero
// events.
//
// Honest framing (the 3B baseline lesson): the realistic comparison is the
// PIPELINE build → select → read. `build` is shared by both, so it's reported
// separately; the new pipeline ≈ build (select adds ~nothing), the old ≈
// build + the event tax. The `old` proxy materializes events + per-event
// select but skips the rebuild, so it UNDER-states the old cost slightly —
// the real win is a touch larger, not smaller.
//
//   npm run build --workspace=pond-ts
//   node --expose-gc scripts/perf-select-columnar.mjs

import { performance } from 'node:perf_hooks';
import { TimeSeries } from '../dist/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'a', kind: 'number' },
  { name: 'b', kind: 'number' },
  { name: 'c', kind: 'number' },
  { name: 'd', kind: 'number' },
];

function median(values) {
  const s = [...values].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function bench(fn, repeats = 7) {
  for (let i = 0; i < 2; i += 1) fn();
  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return Number(median(samples).toFixed(3));
}

function makeRows(n) {
  const rows = new Array(n);
  for (let i = 0; i < n; i += 1) rows[i] = [1000 + i, i % 97, i % 13, i, -i];
  return rows;
}

const CELLS = [100_000, 1_000_000];

const out = [];
for (const n of CELLS) {
  const rows = makeRows(n);

  // build alone (shared by both pipelines).
  const buildMs = bench(() => new TimeSeries({ name: 's', schema, rows }));

  // NEW pipeline: build → column-native select → read a column. No events.
  const newMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows });
    return s.select('a', 'b').column('a').sum();
  });

  // OLD proxy: build → materialize events → per-event .select() → read.
  // (Skips the rebuild the old select also did, so this under-states it.)
  const oldMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows });
    let acc = 0;
    for (const e of s.events) {
      const sel = e.select('a', 'b');
      acc += sel.get('a');
    }
    return acc;
  });

  out.push({
    rows: n,
    buildMs,
    newPipelineMs: newMs,
    oldPipelineMs: oldMs,
    selectTaxRecovered: Number((oldMs - newMs).toFixed(3)),
    pipelineSpeedup: Number((oldMs / newMs).toFixed(1)),
  });
}

console.log(JSON.stringify({ selectColumnar: out }, null, 2));
console.log(
  '\nbuild is shared. newPipeline ≈ build (select adds ~nothing, zero-copy);\n' +
    'oldPipeline ≈ build + the event-materialization tax that select used to\n' +
    'force. selectTaxRecovered = the per-transform cost the column-native\n' +
    'path removes (the consultant\'s "3.6× evaporates at the first transform").',
);
if (!globalThis.gc)
  console.error('\n[note] run with --expose-gc for stable GC timing');
