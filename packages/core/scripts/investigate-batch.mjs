// Step 7 re-investigation — the BATCHED ingest case (option C).
//
// In the batched `pushMany` path the eviction is already amortized
// (one splice per batch), so the dominant cost is the per-row `Event`
// explosion (`new Time` + `Object.freeze(data)` + `Object.freeze`).
// This spike tests "keep the batch columnar" instead:
//
//   A. array-events    — per-row Event + Event[] push + splice evict
//                        (today's LiveSeries mechanics)
//   C. chunked-columnar — each batch validated into a ColumnarStore
//                        chunk via the column-native intake path
//                        (validateAndNormalizeColumnar, Step 2c — NO
//                        per-row Event), evict whole chunks off the
//                        front (batch-granular retention)
//
// Both pay validation. The difference: (A) materializes N Events;
// (C) writes N rows into typed-array columns and keeps them. We
// measure ingest throughput, a windowed columnar-vs-Event reduction
// (the consume side), and retained heap.
//
//   node --expose-gc scripts/investigate-batch.mjs
//   node --expose-gc scripts/investigate-batch.mjs --heap=array
//   node --expose-gc scripts/investigate-batch.mjs --heap=chunked

import { performance } from 'node:perf_hooks';
import { Event, Time } from '../dist/index.js';
import { validateAndNormalizeColumnar } from '../dist/batch/validate.js';
import { ColumnarStore } from '../dist/columnar/store.js';

const SCHEMA = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
  { name: 'load', kind: 'number' },
]);

function makeBatches(total, batchSize) {
  const batches = [];
  for (let b = 0; b < total / batchSize; b += 1) {
    const rows = new Array(batchSize);
    for (let i = 0; i < batchSize; i += 1) {
      const idx = b * batchSize + i;
      rows[i] = [1000 + idx, idx % 100, (idx % 7) + 1];
    }
    batches.push(rows);
  }
  return batches;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

/* ── A: array of Events + splice ──────────────────────────────────── */
class ArrayEvents {
  #evts = [];
  #w;
  constructor(w) {
    this.#w = w;
  }
  appendBatch(rows) {
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      // Mirrors LiveSeries #validateRow: Time + frozen data + frozen event.
      this.#evts.push(new Event(new Time(r[0]), { value: r[1], load: r[2] }));
    }
    if (this.#evts.length > this.#w) {
      this.#evts.splice(0, this.#evts.length - this.#w);
    }
  }
  sumValue() {
    let s = 0;
    for (let i = 0; i < this.#evts.length; i += 1) s += this.#evts[i].get('value');
    return s;
  }
  get length() {
    return this.#evts.length;
  }
}

/* ── C: chunked columnar buffer, batch-granular retention ─────────── */
class ChunkedColumnar {
  #chunks = [];
  #total = 0;
  #w;
  constructor(w) {
    this.#w = w;
  }
  appendBatch(rows) {
    // Column-native intake: rows → typed-array columns, NO per-row Event.
    const { keys, columns } = validateAndNormalizeColumnar({
      name: 'c',
      schema: SCHEMA,
      rows,
    });
    const store = ColumnarStore.fromTrustedStore(SCHEMA, keys, columns);
    this.#chunks.push(store);
    this.#total += store.length;
    // Evict whole chunks off the front while dropping the oldest still
    // leaves us at or above the window. Batch-granular — O(chunks),
    // no per-row work, no copy.
    while (
      this.#chunks.length > 1 &&
      this.#total - this.#chunks[0].length >= this.#w
    ) {
      this.#total -= this.#chunks.shift().length;
    }
  }
  sumValue() {
    // Columnar consume: walk each chunk's value column as a typed array.
    let s = 0;
    for (let c = 0; c < this.#chunks.length; c += 1) {
      const arr = this.#chunks[c].columns.get('value').toFloat64Array();
      for (let i = 0; i < arr.length; i += 1) s += arr[i];
    }
    return s;
  }
  get length() {
    return this.#total;
  }
}

const strategies = { array: (w) => new ArrayEvents(w), chunked: (w) => new ChunkedColumnar(w) };

function heapMB() {
  globalThis.gc?.();
  globalThis.gc?.();
  globalThis.gc?.();
  return process.memoryUsage();
}

/* ── Heap mode: one strategy, full window, settled ────────────────── */
const heapMode = process.argv
  .find((a) => a.startsWith('--heap='))
  ?.slice('--heap='.length);

if (heapMode) {
  const W = 200_000;
  const batchSize = 1_000;
  let batches = makeBatches(W, batchSize);
  const store = strategies[heapMode](W);
  for (let b = 0; b < batches.length; b += 1) store.appendBatch(batches[b]);
  batches = null; // drop the raw input; retained set is the buffer only
  const m = heapMB();
  if (store.length < W) throw new Error(`bad length ${store.length}`);
  console.log(
    JSON.stringify({
      heap: {
        strategy: heapMode,
        windowSize: W,
        retainedHeapMB: Number((m.heapUsed / 1048576).toFixed(1)),
        rssMB: Number((m.rss / 1048576).toFixed(1)),
        length: store.length,
      },
    }),
  );
  process.exit(0);
}

/* ── Timing: batched ingest + windowed consume ────────────────────── */
const results = [];
const TOTAL = 300_000;
const BATCH = 1_000;
const W = 50_000;
const batches = makeBatches(TOTAL, BATCH);

for (const [name, make] of Object.entries(strategies)) {
  // warmup
  {
    const s = make(W);
    for (let b = 0; b < batches.length; b += 1) s.appendBatch(batches[b]);
    s.sumValue();
  }
  const ingestSamples = [];
  const consumeSamples = [];
  for (let r = 0; r < 8; r += 1) {
    const s = make(W);
    const t0 = performance.now();
    for (let b = 0; b < batches.length; b += 1) s.appendBatch(batches[b]);
    ingestSamples.push(performance.now() - t0);
    const t1 = performance.now();
    s.sumValue();
    consumeSamples.push(performance.now() - t1);
  }
  results.push({
    strategy: name,
    workload: `batched ingest (total=${TOTAL}, batch=${BATCH}, window=${W})`,
    ingestMedianMs: Number(median(ingestSamples).toFixed(2)),
    ingestThroughputKps: Number((TOTAL / median(ingestSamples)).toFixed(0)),
    consumeMedianMs: Number(median(consumeSamples).toFixed(3)),
  });
}

console.log(JSON.stringify({ timing: results }, null, 2));
if (!globalThis.gc) console.error('\n[warn] run with --expose-gc for heap mode');
