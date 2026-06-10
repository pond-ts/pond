// Perf check — Step 4 column-native diff/rate/pctChange (transforms read cols).
//
// diff/rate/pctChange used to materialize this.events, spread each event's
// data, read prev+curr, and build a new Event per row — then the result
// re-columnarized on first column access. The consultant's finding: that event
// round-trip burns the columnar construction win at the first transform.
// diffRateOp now folds straight off the store's columns (col.read(i) → out
// array → float64ColumnFromArray → withColumnReplaced; drop:true appends a
// withRowRange slice), references untouched columns + key zero-copy, builds NO
// events.
//
// Complexity (T targets, N rows, C columns):
//   Old: materialize N events O(N·C) + N×{...data()} + N new Event +
//        re-columnarize O(N·C). Event-touching.
//   New: per target one O(N) col.read scan + O(N) validity; rate adds one O(N)
//        dt precompute (shared across targets); drop adds O(C) slice. Untouched
//        columns + key shared by reference. O(T·N + C), zero events.
//
// Honest framing (the cumulative/select lesson): the realistic comparison is
// the PIPELINE build → diff → read. `build` is shared, reported separately. The
// new pipeline ≈ build + one column scan per target; the old ≈ build + the
// event-materialization-and-rebuild tax. The `old` proxy materializes events +
// folds per-event but SKIPS the re-columnarize the old path also forced, so it
// UNDER-states the old cost — the real win is a touch larger, not smaller.
//
//   npm run build --workspace=pond-ts
//   node --expose-gc scripts/perf-diff-rate-columnar.mjs

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

// Recreate the old per-event diff fold (single target) without the rebuild.
function oldDiffProxy(series) {
  const events = series.events;
  let acc = 0;
  for (let i = 1; i < events.length; i += 1) {
    const prev = events[i - 1].get('a');
    const curr = events[i].get('a');
    if (typeof prev === 'number' && typeof curr === 'number')
      acc += curr - prev;
  }
  return acc;
}

const CELLS = [100_000, 1_000_000];

const out = [];
for (const n of CELLS) {
  const rows = makeRows(n);

  // build alone (shared by both pipelines).
  const buildMs = bench(() => new TimeSeries({ name: 's', schema, rows }));

  // NEW pipeline: build → column-native diff → read a column. No events.
  const diffNewMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows });
    return s.diff('a').column('a').sum();
  });

  // OLD proxy: build → materialize events → per-event fold → read.
  // (Skips the re-columnarize the old diff also did, so under-states it.)
  const diffOldMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows });
    return oldDiffProxy(s);
  });

  // rate — exercises the per-row dt precompute (shared across targets).
  const rateNewMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows });
    return s.rate('a').column('a').sum();
  });

  // drop:true — exercises the withRowRange trailing slice.
  const dropNewMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows });
    return s.diff('a', { drop: true }).column('a').sum();
  });

  // multi-target — confirms the win holds as target count grows.
  const multiNewMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows });
    return s.diff(['a', 'b', 'c', 'd']).column('a').sum();
  });

  out.push({
    rows: n,
    buildMs,
    diffNewMs,
    diffOldMs,
    diffSpeedup: Number((diffOldMs / diffNewMs).toFixed(1)),
    rateNewMs,
    dropTrueNewMs: dropNewMs,
    multiTargetNewMs: multiNewMs,
  });
}

console.log(JSON.stringify({ diffRateColumnar: out }, null, 2));
console.log(
  '\nbuild is shared. diffNew ≈ build + one column scan per target;\n' +
    'diffOld ≈ build + the event-materialization tax the old fold forced\n' +
    '(and the proxy still skips the re-columnarize, so the real win is larger).',
);
if (!globalThis.gc)
  console.error('\n[note] run with --expose-gc for stable GC timing');
