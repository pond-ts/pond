// Perf check — byValue() (TimeSeries → ValueSeries projection) + the
// ordering-based ValueSeries ops (nearestIndex, sliceByValue).
//
// byValue is a thin projection: one O(N) assertMonotonicAxis scan over the axis
// column (read(i) + finite + non-decreasing checks), one Float64Array key
// allocation, and an O(C) zero-copy reshare of the other value columns (their
// buffers are shared by reference; only the axis column is dropped). So
// byValue ≈ build's key-scan cost, NOT a full re-materialization.
//
// nearestIndex is a binary search (O(log N)); sliceByValue is a binary search +
// withRowRange (O(log N + C) zero-copy subarray views, no per-row walk). This
// script confirms byValue is a small fraction of build and that the per-op
// cursor/cull paths don't hide an O(N) walk.
//
//   npm run build --workspace=pond-ts
//   node --expose-gc scripts/perf-byvalue.mjs

import { performance } from 'node:perf_hooks';
import { TimeSeries } from '../dist/index.js';

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

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cumDist', kind: 'number' },
  { name: 'hr', kind: 'number' },
  { name: 'pace', kind: 'number' },
  { name: 'ele', kind: 'number' },
];

function makeRows(n) {
  const rows = new Array(n);
  let cum = 0;
  for (let i = 0; i < n; i += 1) {
    cum += 2 + (i % 3); // monotonic distance axis
    rows[i] = [1000 + i, cum, 120 + (i % 60), 200 + (i % 90), 100 + (i % 40)];
  }
  return rows;
}

const CELLS = [100_000, 1_000_000];
const out = [];

for (const n of CELLS) {
  const rows = makeRows(n);

  const buildMs = bench(() => new TimeSeries({ name: 's', schema, rows }));

  // byValue projection: build → byValue → read the axis (force materialization).
  const byValueMs = bench(() => {
    const s = new TimeSeries({ name: 's', schema, rows });
    return s.byValue('cumDist').axisValues().length;
  });

  // nearestIndex: one ValueSeries, K lookups across the axis extent (O(log N)).
  const vs = new TimeSeries({ name: 's', schema, rows }).byValue('cumDist');
  const maxAxis = vs.axisAt(vs.length - 1);
  const K = 100_000;
  const nearestMs = bench(() => {
    let acc = 0;
    for (let k = 0; k < K; k += 1) {
      acc += vs.nearestIndex((maxAxis * k) / K);
    }
    return acc;
  });

  // sliceByValue: K windowed culls (O(log N + C) zero-copy each).
  const sliceMs = bench(() => {
    let acc = 0;
    for (let k = 0; k < K; k += 1) {
      const lo = (maxAxis * k) / K;
      acc += vs.sliceByValue(lo, lo + maxAxis / 20).length;
    }
    return acc;
  });

  out.push({
    rows: n,
    buildMs,
    byValueMs,
    byValueOverBuild: Number((byValueMs / buildMs).toFixed(2)),
    nearestMsPer100k: nearestMs,
    sliceMsPer100k: sliceMs,
  });
}

console.log(JSON.stringify({ byValue: out }, null, 2));
console.log(
  '\nbuild is shared. byValue ≈ build + one axis scan + a key alloc (the other\n' +
    'columns reshare zero-copy), so byValueOverBuild should be ~1.x, NOT 2x+.\n' +
    'nearestMsPer100k / sliceMsPer100k are 100k ops each — they should barely\n' +
    'grow from the 100k-row to the 1M-row series (O(log N) / O(log N + C)).',
);
if (!globalThis.gc)
  console.error('\n[note] run with --expose-gc for stable GC timing');
