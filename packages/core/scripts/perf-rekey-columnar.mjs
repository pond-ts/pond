// Perf check — column-native asTime / asTimeRange / asInterval (rekeys).
//
// These used to materialize this.events, rekey each event, and rebuild the
// series. Now they read the key's begin/end buffers and build one new
// KeyColumn via withKeyColumn — value columns pass through by reference, no
// events. asTimeRange/asTime{begin,end} reuse the source buffer zero-copy;
// asTime{center} computes midpoints (one O(N) pass); asInterval allocates the
// label column (+ a per-row TimeRange + fn call for the function form).
//
// Honest framing: `build` is shared. The `old` proxy materializes events +
// per-event rekey but SKIPS the re-columnarize the old path also forced, so it
// UNDER-states the old cost. asInterval(fn) still allocates a TimeRange + calls
// the user fn per row on both paths, so its win is the more modest "drop the
// Event materialization" rather than a full vectorization.
//
//   npm run build --workspace=pond-ts
//   node --expose-gc scripts/perf-rekey-columnar.mjs

import { performance } from 'node:perf_hooks';
import { TimeSeries } from '../dist/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'a', kind: 'number' },
  { name: 'b', kind: 'number' },
  { name: 'c', kind: 'number' },
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
  for (let i = 0; i < n; i += 1) rows[i] = [1000 + i, i % 97, i % 13, i];
  return rows;
}

const CELLS = [100_000, 1_000_000];

const out = [];
for (const n of CELLS) {
  const rows = makeRows(n);
  const buildMs = bench(() => new TimeSeries({ name: 's', schema, rows }));

  // NEW: build → rekey → read the key (forces the result).
  const timeRangeNewMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows });
    return s.asTimeRange().length;
  });
  const centerNewMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows });
    return s.asTimeRange().asTime({ at: 'center' }).length;
  });
  const intervalNewMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows });
    return s.asInterval((r) => r.begin()).length;
  });

  // OLD proxy: build → materialize events → per-event rekey → read.
  const timeRangeOldMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows });
    return s.events.map((e) => e.asTimeRange()).length;
  });

  out.push({
    rows: n,
    buildMs,
    asTimeRangeNewMs: timeRangeNewMs,
    asTimeRangeOldMs: timeRangeOldMs,
    asTimeRangeSpeedup: Number((timeRangeOldMs / timeRangeNewMs).toFixed(1)),
    asTimeCenterNewMs: centerNewMs,
    asIntervalFnNewMs: intervalNewMs,
  });
}

console.log(JSON.stringify({ rekeyColumnar: out }, null, 2));
console.log(
  '\nbuild is shared. asTimeRange/asTime{begin,end} reuse the key buffer\n' +
    'zero-copy (≈ build); asTime{center} adds one O(N) midpoint pass;\n' +
    'asInterval(fn) adds a per-row TimeRange + fn call (modest, like collapse).',
);
if (!globalThis.gc)
  console.error('\n[note] run with --expose-gc for stable GC timing');
