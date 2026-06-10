// Perf check — Step 4 column-native fill() (gap-fill reads columns).
//
// fill used to materialize this.events, build a per-column value dict from each
// event's data() + a times array from begin(), gap-walk, then rebuild a new
// Event per row (re-columnarizing on first access). The consultant's finding:
// that event round-trip burns the columnar construction win at the first
// transform. fillOp now walks each column's gaps straight off the store
// (col.read(i)), rebuilds ONLY the columns that changed via the kind-
// appropriate builder, and shares untouched columns + the key by reference —
// no events.
//
// Complexity (T spec'd columns, N rows, C columns):
//   Old: materialize N events O(N·C) + N×data() reads + gap-walk O(T·N) +
//        N new Event + re-columnarize O(N·C). Event-touching; rebuilds ALL
//        columns regardless of whether they changed.
//   New: per spec'd column one O(N) col.read scan + gap-walk + O(N) rebuild
//        IF changed. times built once lazily (linear/maxGap only). Untouched
//        columns + key shared by reference. O(T·N), zero events.
//
// Honest framing (the cumulative/diff lesson): the realistic comparison is the
// PIPELINE build → fill → read. `build` is shared, reported separately. The
// new pipeline ≈ build + one column scan per spec'd column; the old ≈ build +
// the event-materialization-and-rebuild tax. The `old` proxy materializes
// events + gap-fills but SKIPS the re-columnarize the old path also forced, so
// it UNDER-states the old cost — the real win is a touch larger, not smaller.
//
//   npm run build --workspace=pond-ts
//   node --expose-gc scripts/perf-fill-columnar.mjs

import { performance } from 'node:perf_hooks';
import { TimeSeries } from '../dist/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'a', kind: 'number', required: false },
  { name: 'b', kind: 'number', required: false },
  { name: 'c', kind: 'number', required: false },
  { name: 'd', kind: 'number', required: false },
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

// ~1/3 of the cells in each column are gaps (undefined) for hold to fill.
function makeRows(n) {
  const rows = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const gap = i % 3 === 1;
    rows[i] = [
      1000 + i,
      gap ? undefined : i % 97,
      gap ? undefined : i % 13,
      gap ? undefined : i,
      gap ? undefined : -i,
    ];
  }
  return rows;
}

// Old per-event hold-fill of one column (no rebuild).
function oldFillProxy(series) {
  const events = series.events;
  let last;
  let acc = 0;
  for (let i = 0; i < events.length; i += 1) {
    const v = events[i].get('a');
    if (v !== undefined) last = v;
    acc += last ?? 0;
  }
  return acc;
}

const CELLS = [100_000, 1_000_000];

const out = [];
for (const n of CELLS) {
  const rows = makeRows(n);

  const buildMs = bench(() => new TimeSeries({ name: 's', schema, rows }));

  // NEW pipeline: build → column-native fill (single column) → read.
  const fillNewMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows });
    return s.fill({ a: 'hold' }).column('a').sum();
  });

  // OLD proxy: build → materialize events → per-event hold-fill → read.
  const fillOldMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows });
    return oldFillProxy(s);
  });

  // linear — exercises the lazy times build + interpolation.
  const linearNewMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows });
    return s.fill({ a: 'linear' }).column('a').sum();
  });

  // all-columns hold — every column rebuilt (worst case for the rebuild path).
  const allColsNewMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows });
    return s.fill('hold').column('a').sum();
  });

  out.push({
    rows: n,
    buildMs,
    fillNewMs,
    fillOldMs,
    fillSpeedup: Number((fillOldMs / fillNewMs).toFixed(1)),
    linearNewMs,
    allColsNewMs,
  });
}

console.log(JSON.stringify({ fillColumnar: out }, null, 2));
console.log(
  '\nbuild is shared. fillNew ≈ build + one column scan per spec’d column;\n' +
    'fillOld ≈ build + the event-materialization tax the old gap-fill forced\n' +
    '(and the proxy still skips the re-columnarize, so the real win is larger).',
);
if (!globalThis.gc)
  console.error('\n[note] run with --expose-gc for stable GC timing');
