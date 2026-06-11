// Perf check — Step 4 column-native collapse() (reducer reads keyed columns).
//
// collapse used to materialize this.events and call event.collapse per event
// (build the keyed-values object + a new Event per row), then re-columnarize.
// collapseOp now reads ONLY the keyed columns off the store, builds the small
// {key: value} object per row, calls the reducer, and appends one output
// column — kept columns + key pass through by reference, no Event.
//
// Honest framing: unlike the pure folds (cumulative/diff/shift), collapse
// still allocates a per-row object and calls the user reducer per row on BOTH
// paths — so the win is the more modest "drop the Event materialization + read
// only the keyed columns (not all C) + share the kept columns" rather than a
// full vectorization. Expect a smaller multiple than the folds.
//
// Complexity (K keyed cols, N rows, C columns):
//   Old: materialize N events O(N·C) + N event.collapse (object + new Event) +
//        re-columnarize O(N·C). Event-touching, reads all C.
//   New: per row read K keyed cells + build a K-object + reducer; one O(N)
//        output column build; kept columns + key shared. O(N·K), zero events.
//
// `build` is shared; the `old` proxy materializes events + per-event reducer
// but SKIPS the re-columnarize, so it UNDER-states the old cost.
//
//   npm run build --workspace=pond-ts
//   node --expose-gc scripts/perf-collapse-columnar.mjs

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

const reducer = (v) => v.a + v.b;

// Old per-event collapse of two columns (no rebuild).
function oldCollapseProxy(series) {
  let acc = 0;
  for (const e of series.events) {
    acc += reducer({ a: e.get('a'), b: e.get('b') });
  }
  return acc;
}

const CELLS = [100_000, 1_000_000];

const out = [];
for (const n of CELLS) {
  const rows = makeRows(n);

  const buildMs = bench(() => new TimeSeries({ name: 's', schema, rows }));

  // NEW pipeline: build → column-native collapse → read the output.
  const collapseNewMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows });
    return s.collapse(['a', 'b'], 'r', reducer).column('r').sum();
  });

  // OLD proxy: build → materialize events → per-event reducer → read.
  const collapseOldMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows });
    return oldCollapseProxy(s);
  });

  out.push({
    rows: n,
    buildMs,
    collapseNewMs,
    collapseOldMs,
    collapseSpeedup: Number((collapseOldMs / collapseNewMs).toFixed(1)),
  });
}

console.log(JSON.stringify({ collapseColumnar: out }, null, 2));
console.log(
  '\nbuild is shared. collapseNew ≈ build + (read K keyed cols + per-row\n' +
    'reducer + one output column); collapseOld ≈ build + the event-\n' +
    'materialization tax (and the proxy skips the re-columnarize). The win is\n' +
    'more modest than the pure folds — the per-row reducer dominates both.',
);
if (!globalThis.gc)
  console.error('\n[note] run with --expose-gc for stable GC timing');
