// Perf check — Step 4 column-native shift() (transforms read columns).
//
// shift used to materialize this.events, spread each event's data, copy the
// value from event[i-n], and build a new Event per row — then re-columnarize
// on first access. shiftOp now builds each target's shifted array straight off
// the store (out[i] = col.read(i-n) else undefined) and rebuilds the column —
// no events.
//
// Complexity (T targets, N rows, C columns):
//   Old: materialize N events O(N·C) + N×{...data()} + N new Event +
//        re-columnarize O(N·C). Event-touching.
//   New: per target one O(N) col.read scan + O(N) validity derive; untouched
//        columns + key shared by reference. O(T·N), zero events.
//
// Honest framing (the cumulative/diff lesson): the realistic comparison is the
// PIPELINE build → shift → read. `build` is shared, reported separately. The
// new pipeline ≈ build + one column scan per target; the `old` proxy
// materializes events + reads event[i-n] but SKIPS the re-columnarize the old
// path also forced, so it UNDER-states the old cost.
//
//   npm run build --workspace=pond-ts
//   node --expose-gc scripts/perf-shift-columnar.mjs

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

// Old per-event shift of one column (no rebuild).
function oldShiftProxy(series, n) {
  const events = series.events;
  let acc = 0;
  for (let i = 0; i < events.length; i += 1) {
    const src = i - n;
    const v =
      src >= 0 && src < events.length ? events[src].get('a') : undefined;
    if (typeof v === 'number') acc += v;
  }
  return acc;
}

const CELLS = [100_000, 1_000_000];

const out = [];
for (const n of CELLS) {
  const rows = makeRows(n);

  const buildMs = bench(() => new TimeSeries({ name: 's', schema, rows }));

  // NEW pipeline: build → column-native shift → read. No events.
  const shiftNewMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows });
    return s.shift('a', 1).column('a').sum();
  });

  // OLD proxy: build → materialize events → per-event shift → read.
  const shiftOldMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows });
    return oldShiftProxy(s, 1);
  });

  // multi-target — confirms the win holds as target count grows.
  const multiNewMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows });
    return s.shift(['a', 'b', 'c', 'd'], 1).column('a').sum();
  });

  out.push({
    rows: n,
    buildMs,
    shiftNewMs,
    shiftOldMs,
    shiftSpeedup: Number((shiftOldMs / shiftNewMs).toFixed(1)),
    multiTargetNewMs: multiNewMs,
  });
}

console.log(JSON.stringify({ shiftColumnar: out }, null, 2));
console.log(
  '\nbuild is shared. shiftNew ≈ build + one column scan per target;\n' +
    'shiftOld ≈ build + the event-materialization tax the old shift forced\n' +
    '(and the proxy still skips the re-columnarize, so the real win is larger).',
);
if (!globalThis.gc)
  console.error('\n[note] run with --expose-gc for stable GC timing');
