// Step 7 re-investigation — isolate the storage-mechanics question.
//
// Three storage strategies for a bounded high-churn window, compared
// head-to-head on the operations that actually churn:
//
//   A. Array + splice   — push to tail, splice(0,n) to evict (current
//                          LiveSeries backing's mechanics)
//   B. Ring of refs      — circular Event[] with head/length, O(1)
//                          evict by advancing head (the "write into
//                          existing memory, track begin/end" idea)
//   C. Columnar ring     — ColumnarRingBuffer + _appendRowTrusted,
//                          decompose Event into typed-array columns
//
// Events are PRE-BUILT and shared across strategies, so Event
// creation is excluded from the timed region — this isolates the
// store/evict mechanics, which is the churn question the array's
// splice eviction raises.
//
//   node --expose-gc scripts/investigate-ring.mjs              # timing
//   node --expose-gc scripts/investigate-ring.mjs --heap=array
//   node --expose-gc scripts/investigate-ring.mjs --heap=ref
//   node --expose-gc scripts/investigate-ring.mjs --heap=col
//
// Heap mode builds one strategy to a full W-row window, NULLS the
// builder array, settles GC, and reports retained heapUsed + RSS.

import { performance } from 'node:perf_hooks';
import { Event, Time } from '../dist/index.js';
// ColumnarRingBuffer is framework-internal (not in the public barrel).
import { ColumnarRingBuffer } from '../dist/columnar/ring-buffer.js';

const SCHEMA = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
  { name: 'load', kind: 'number' },
]);

function makeEvents(n) {
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = new Event(new Time(1000 + i), { value: i % 100, load: (i % 7) + 1 });
  }
  return out;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

/* ── Strategy A: Array + splice ───────────────────────────────────── */
class ArrayStore {
  #evts = [];
  #w;
  constructor(w) {
    this.#w = w;
  }
  pushOne(e) {
    this.#evts.push(e);
    if (this.#evts.length > this.#w) this.#evts.splice(0, this.#evts.length - this.#w);
  }
  get length() {
    return this.#evts.length;
  }
}

/* ── Strategy B: Ring of Event refs ───────────────────────────────── */
class RefRing {
  #buf;
  #head = 0;
  #len = 0;
  #cap;
  constructor(w) {
    this.#cap = w;
    this.#buf = new Array(w).fill(undefined);
  }
  pushOne(e) {
    if (this.#len < this.#cap) {
      this.#buf[(this.#head + this.#len) % this.#cap] = e;
      this.#len += 1;
    } else {
      // full: overwrite oldest, advance head. O(1), no shift, no realloc.
      this.#buf[this.#head] = e;
      this.#head = (this.#head + 1) % this.#cap;
    }
  }
  get length() {
    return this.#len;
  }
}

/* ── Strategy C: Columnar ring (ColumnarRingBuffer) ───────────────── */
class ColRing {
  #ring;
  #scratch = [0, 0];
  constructor(w) {
    this.#ring = new ColumnarRingBuffer(SCHEMA, { retention: w, lazyGrowth: false });
  }
  pushOne(e) {
    const b = e.begin();
    this.#scratch[0] = e.get('value');
    this.#scratch[1] = e.get('load');
    this.#ring._appendRowTrusted(b, b, undefined, this.#scratch);
  }
  get length() {
    return this.#ring.length;
  }
}

const strategies = {
  array: (w) => new ArrayStore(w),
  ref: (w) => new RefRing(w),
  col: (w) => new ColRing(w),
};

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
  let events = makeEvents(W);
  const store = strategies[heapMode](W);
  for (let i = 0; i < W; i += 1) store.pushOne(events[i]);
  // Null the builder array: for array/ref the store still holds W
  // event refs (retained by design); for col the events are now
  // unreferenced and collectable — only the typed arrays remain.
  events = null;
  const before = heapMB();
  const m = before; // already settled
  if (store.length !== W) throw new Error('bad length');
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

/* ── Timing: single-push high churn + batched ─────────────────────── */
const results = [];

// Single-push high churn: window W, push N one-at-a-time. Once the
// window fills, every push evicts one — the case where the array's
// splice is O(W)/push and the rings are O(1)/push.
{
  const W = 10_000;
  const N = 100_000;
  const events = makeEvents(N);
  for (const [name, make] of Object.entries(strategies)) {
    const repeats = name === 'array' ? 3 : 8; // array is slow here; fewer reps
    for (let r = 0; r < 1; r += 1) {
      // 1 warmup
      const s = make(W);
      for (let i = 0; i < N; i += 1) s.pushOne(events[i]);
    }
    const samples = [];
    for (let r = 0; r < repeats; r += 1) {
      const s = make(W);
      const t0 = performance.now();
      for (let i = 0; i < N; i += 1) s.pushOne(events[i]);
      samples.push(performance.now() - t0);
    }
    results.push({
      workload: `single-push churn (W=${W}, N=${N})`,
      strategy: name,
      medianMs: Number(median(samples).toFixed(2)),
      throughputKps: Number((N / median(samples)).toFixed(0)),
    });
  }
}

console.log(JSON.stringify({ timing: results }, null, 2));
if (!globalThis.gc) console.error('\n[warn] run with --expose-gc for heap mode');
