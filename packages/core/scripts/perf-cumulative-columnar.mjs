// Perf check — Step 4 column-native cumulative() (transforms read columns).
//
// cumulative() used to materialize this.events, spread each event's data into
// a fresh object, fold the running accumulator, and build a new Event per row
// — then the result re-columnarized on first column access. The consultant's
// finding: that event round-trip burns the 3.6× columnar construction win at
// the first transform. cumulativeOp now folds straight off the store's columns
// (col.read(i) → out array → float64ColumnFromArray → withColumnReplaced),
// references the untouched columns + key axis zero-copy, and builds NO events.
//
// Complexity (T targets, N rows, C columns):
//   Old: materialize N events O(N·C) + N×{...data()} spreads + N new Event +
//        re-columnarize O(N·C). Event-touching, T folds interleaved per row.
//   New: per target, one O(N) col.read scan + O(N) validity derive; untouched
//        columns + key shared by reference. O(T·N + C), zero events.
//
// Honest framing (the select/3B baseline lesson): the realistic comparison is
// the PIPELINE build → cumulative → read. `build` is shared by both, reported
// separately. The new pipeline ≈ build + one column scan per target; the old ≈
// build + the event-materialization-and-rebuild tax. The `old` proxy below
// materializes events + folds per-event but SKIPS the re-columnarize the old
// path also forced, so it UNDER-states the old cost — the real win is a touch
// larger, not smaller.
//
//   npm run build --workspace=pond-ts
//   node --expose-gc scripts/perf-cumulative-columnar.mjs

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

// Recreate the old per-event fold (single target, 'sum') without the rebuild.
function oldCumulativeProxy(series) {
  let acc;
  let last;
  for (const e of series.events) {
    const v = e.get('a');
    if (typeof v === 'number') acc = (acc ?? 0) + v;
    last = acc;
  }
  return last;
}

const CELLS = [100_000, 1_000_000];

const out = [];
for (const n of CELLS) {
  const rows = makeRows(n);

  // build alone (shared by both pipelines).
  const buildMs = bench(() => new TimeSeries({ name: 's', schema, rows }));

  // NEW pipeline: build → column-native cumulative → read a column. No events.
  const singleNewMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows });
    return s.cumulative({ a: 'sum' }).column('a').sum();
  });

  // OLD proxy: build → materialize events → per-event fold → read.
  // (Skips the re-columnarize the old cumulative also did, so under-states it.)
  const singleOldMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows });
    return oldCumulativeProxy(s);
  });

  // Multi-target: the per-row event path folded all targets interleaved; the
  // column-native path scans each target column independently. Confirms the
  // win holds (and doesn't invert) as target count grows.
  const multiNewMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows });
    return s
      .cumulative({ a: 'sum', b: 'max', c: 'min', d: 'sum' })
      .column('a')
      .sum();
  });

  out.push({
    rows: n,
    buildMs,
    cumulativeNewMs: singleNewMs,
    cumulativeOldMs: singleOldMs,
    cumulativeSpeedup: Number((singleOldMs / singleNewMs).toFixed(1)),
    multiTargetNewMs: multiNewMs,
  });
}

console.log(JSON.stringify({ cumulativeColumnar: out }, null, 2));
console.log(
  '\nbuild is shared. cumulativeNew ≈ build + one column scan per target;\n' +
    'cumulativeOld ≈ build + the event-materialization tax the old fold forced\n' +
    '(and the proxy still skips the re-columnarize, so the real win is larger).',
);
if (!globalThis.gc)
  console.error('\n[note] run with --expose-gc for stable GC timing');
