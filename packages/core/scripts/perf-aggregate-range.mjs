// Perf check — Step 3B aggregate() columnar fast path (per-bucket reduce).
//
// Complexity. Row path: materialize all N events (lazy), then per bucket
// per column walk the bucket's events with per-cell object access —
// O(N·C) cell reads + the full N-event materialization (the dominant cost
// on large series). Fast path: O(N) boundary walk over the key column's
// begins (typed array, no events) + per bucket per column a reduceColumn
// over the contiguous [start,scan) slice — O(N·C) typed-array reads
// (scalar reducers) or O(b·log b) per bucket (median/percentile), B
// zero-copy slice wrappers, ZERO events materialized.
//
// The risk the consultant flagged: at the per-element floor (1 event per
// bucket, B≈N) the B slice-wrapper allocs + B reduce-call overheads could
// approach the row walk. This bench keeps that scenario front and center.
//
// Baseline = the same reducer expressed as a custom function, which forces
// the row path (typeof reducer !== 'string' → fast path declines). Honest
// stand-in for the event-materialization cost the fast path removes.
//
//   npm run build --workspace=pond-ts
//   node --expose-gc scripts/perf-aggregate-range.mjs

import { performance } from 'node:perf_hooks';
import { Sequence, TimeSeries } from '../dist/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
];

function median(values) {
  const s = [...values].sort((a, b) => a - b);
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

// n events at `eventStepMs` spacing.
function makeSeries(n, eventStepMs) {
  const rows = new Array(n);
  for (let i = 0; i < n; i += 1) rows[i] = [1000 + i * eventStepMs, i % 97];
  return new TimeSeries({ name: 'agg', schema, rows });
}

const numbersOf = (xs) =>
  xs.filter((v) => typeof v === 'number' && !Number.isNaN(v));
const BUILTIN = {
  s: { from: 'value', using: 'sum' },
  a: { from: 'value', using: 'avg' },
  mn: { from: 'value', using: 'min' },
  mx: { from: 'value', using: 'max' },
  p: { from: 'value', using: 'p95' },
};
const CUSTOM = {
  s: { from: 'value', using: (xs) => numbersOf(xs).reduce((a, b) => a + b, 0) },
  a: {
    from: 'value',
    using: (xs) => {
      const n = numbersOf(xs);
      return n.length ? n.reduce((a, b) => a + b, 0) / n.length : undefined;
    },
  },
  mn: {
    from: 'value',
    using: (xs) => {
      const n = numbersOf(xs);
      return n.length ? Math.min(...n) : undefined;
    },
  },
  mx: {
    from: 'value',
    using: (xs) => {
      const n = numbersOf(xs);
      return n.length ? Math.max(...n) : undefined;
    },
  },
  p: {
    from: 'value',
    using: (xs) => {
      const n = numbersOf(xs).sort((a, b) => a - b);
      return n.length
        ? n[Math.min(n.length - 1, Math.floor(0.95 * n.length))]
        : undefined;
    },
  },
};

// [label, n events, event spacing ms, bucket duration]
const CELLS = [
  ['dense (100k ev, ~1000/bucket)', 100_000, 1, '1s'],
  ['typical (100k ev, ~100/bucket)', 100_000, 1, '100ms'],
  ['per-element floor (100k ev, 1/bucket)', 100_000, 100, '100ms'],
  ['sparse (1k ev on 100k-bucket grid)', 1_000, 10_000, '100ms'],
];

const rows = [];
for (const [label, n, stepMs, bucketDur] of CELLS) {
  const series = makeSeries(n, stepMs);
  const seq = Sequence.every(bucketDur);
  const fastMs = bench(() => series.aggregate(seq, BUILTIN));
  const rowMs = bench(() => series.aggregate(seq, CUSTOM));
  rows.push({
    scenario: label,
    rowPathMs: rowMs,
    fastPathMs: fastMs,
    speedup: Number((rowMs / fastMs).toFixed(1)),
  });
}

console.log(JSON.stringify({ aggregateRange: rows }, null, 2));
console.log(
  '\nrowPath = custom-fn reducers (forces the event-walk path);\n' +
    'fastPath = built-in reducers (columnar per-bucket reduce). 5 reducers\n' +
    '(sum/avg/min/max/p95) per call. Floor scenario must not regress badly.',
);
if (!globalThis.gc)
  console.error('\n[note] run with --expose-gc for stable GC timing');
