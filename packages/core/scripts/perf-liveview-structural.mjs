// §A increment 2 — realized-win measurement (structural zero-copy read).
//
// The split bench (perf-baseline-memo-split.mjs) sized the COST a columnar
// read attacks (gather = ~90-96% of the baseline memo). This sizes the
// REALIZED win: how much faster is reading a window of numeric columns off
// the chunked store's typed-array chunks (windowColumn — zero-copy / one
// concat, no Event) than increment 1's per-tick Event.get() gather off the
// Event[] backing (LiveView.column().toFloat64Array(), shipped 0.19.0)?
//
// Same data, same 3 columns (cpu/avg/sd), same window, three reads:
//   - chunked/multi  — windowColumn over many chunks → one Float64Array concat
//   - chunked/single — windowColumn over one chunk    → zero-copy subarray view
//   - array (inc-1)  — LiveView.column().toFloat64Array() — the N×Event.get() gather
//
//   npm run build --workspace=pond-ts
//   node --expose-gc scripts/perf-liveview-structural.mjs

import { performance } from 'node:perf_hooks';
import { LiveSeries } from '../dist/index.js';
import { ChunkedColumnarLiveStorage } from '../dist/live/live-chunked-storage.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'host', kind: 'string' },
  { name: 'cpu', kind: 'number' },
  { name: 'avg', kind: 'number' },
  { name: 'sd', kind: 'number' },
  { name: 'n', kind: 'number' },
];

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function bench(fn, repeats = 9) {
  for (let i = 0; i < 3; i += 1) fn();
  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return Number(median(samples).toFixed(3));
}

function row(i, hosts) {
  const v = i % 97;
  return [1000 + i, `host-${i % hosts}`, v, v + 0.5, (i % 13) / 7, 30];
}

function makeChunked(n, hosts, batchSize) {
  const store = new ChunkedColumnarLiveStorage(schema);
  let buf = [];
  for (let i = 0; i < n; i += 1) {
    buf.push(row(i, hosts));
    if (buf.length === batchSize) {
      store.appendChunkFromRows(buf);
      buf = [];
    }
  }
  if (buf.length) store.appendChunkFromRows(buf);
  return store;
}

function makeArrayView(n, hosts) {
  const live = new LiveSeries({
    name: 'baseline',
    schema,
    ordering: 'strict',
    retention: { maxEvents: n },
    __backing: 'array',
  });
  let buf = [];
  for (let i = 0; i < n; i += 1) {
    buf.push(row(i, hosts));
    if (buf.length === 2000) {
      live.pushMany(buf);
      buf = [];
    }
  }
  if (buf.length) live.pushMany(buf);
  return live.window(n);
}

// chunked read: 3 numeric columns over the whole window (touch to defeat DCE).
function readChunked(store, n) {
  const cpu = store.windowColumn('cpu', 0, n);
  const avg = store.windowColumn('avg', 0, n);
  const sd = store.windowColumn('sd', 0, n);
  return cpu.length + avg.length + sd.length + cpu[0] + avg[0] + sd[0];
}

// increment-1 read: the same 3 columns via the Event.get() gather.
function readArray(view) {
  const cpu = view.column('cpu').toFloat64Array();
  const avg = view.column('avg').toFloat64Array();
  const sd = view.column('sd').toFloat64Array();
  return cpu.length + avg.length + sd.length + cpu[0] + avg[0] + sd[0];
}

const CELLS = [
  { n: 12_000, hosts: 8 },
  { n: 48_000, hosts: 32 },
  { n: 96_000, hosts: 64 },
];

const CHUNK_BATCH = 2_000; // realistic: each pushMany batch is one chunk

const rows = [];
for (const { n, hosts } of CELLS) {
  const multi = makeChunked(n, hosts, CHUNK_BATCH);
  const single = makeChunked(n, hosts, n); // one chunk → zero-copy path
  const view = makeArrayView(n, hosts);

  const arrayMs = bench(() => readArray(view));
  const multiMs = bench(() => readChunked(multi, n));
  const singleMs = bench(() => readChunked(single, n));

  rows.push({
    n,
    hosts,
    chunks: Math.ceil(n / CHUNK_BATCH),
    arrayInc1Ms: arrayMs,
    chunkedConcatMs: multiMs,
    chunkedZeroCopyMs: singleMs,
    concatSpeedup: Number((arrayMs / multiMs).toFixed(1)),
    zeroCopySpeedup: Number((arrayMs / singleMs).toFixed(1)),
  });
}

console.log(JSON.stringify({ structuralReadWin: rows }, null, 2));
console.log(
  '\nReading cpu/avg/sd over the whole window, no Event materialized:\n' +
    '  chunkedConcat   — windowColumn across many chunks → one Float64Array concat\n' +
    '  chunkedZeroCopy — windowColumn over a single chunk → subarray view (no copy)\n' +
    '  arrayInc1       — LiveView.column().toFloat64Array() (the 0.19.0 gather)\n' +
    'concatSpeedup/zeroCopySpeedup = arrayInc1 / chunked — the realized win bracket.',
);
if (!globalThis.gc)
  console.error('\n[note] run with --expose-gc for stable GC timing');
