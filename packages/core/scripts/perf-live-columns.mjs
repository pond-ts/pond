// [PND-COLOUT] What a listener costs on a live push: `'batch'` (one Event
// per row) against `'columns'` (the pushed rows as a TimeSeries over the
// stored columns). Each consumer does the same job both ways: sum a
// column, copy a column into a chart-style ring buffer, or write JSON rows
// (the gRPC fan-out shape).
//
//   npm run build --workspace=pond-ts
//   node --expose-gc scripts/perf-live-columns.mjs
//   ONLY=columns node --expose-gc scripts/perf-live-columns.mjs   # some cases
//
// Prints one JSON line per case: median ms of 5 (after 2 warm-ups) and the
// median number of garbage collections during the run.

import { performance, PerformanceObserver } from 'node:perf_hooks';

const dist =
  process.env.POND_DIST ?? new URL('../dist', import.meta.url).pathname;
const { LiveSeries } = await import(`${dist}/index.js`);

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'requests', kind: 'number' },
  { name: 'host', kind: 'string' },
]);
const HOSTS = Array.from({ length: 100 }, (_, i) => `api-${i}`);

function makeBatches(total, size) {
  const out = [];
  for (let b = 0; b < total / size; b += 1) {
    const rows = new Array(size);
    for (let i = 0; i < size; i += 1) {
      const k = b * size + i;
      rows[i] = [1000 + k, k % 100, (k % 7) + 1, HOSTS[k % 100]];
    }
    out.push(rows);
  }
  return out;
}

let gcCount = 0;
new PerformanceObserver((list) => {
  gcCount += list.getEntries().length;
}).observe({ entryTypes: ['gc'] });

let sink = 0;
const ring = new Float64Array(1 << 16);
let w = 0;

const consumers = {
  'no listener': () => {},
  "'batch': sum cpu": (s) =>
    s.on('batch', (events) => {
      let t = 0;
      for (const e of events) t += e.get('cpu');
      sink += t;
    }),
  "'columns': sum cpu": (s) =>
    s.on('columns', (batch) => {
      const cpu = batch.column('cpu');
      let t = 0;
      for (let i = 0; i < batch.length; i += 1) t += cpu.read(i);
      sink += t;
    }),
  "'batch': copy cpu": (s) =>
    s.on('batch', (events) => {
      for (const e of events) {
        ring[w] = e.get('cpu');
        w = (w + 1) & 0xffff;
      }
    }),
  "'columns': copy cpu": (s) =>
    s.on('columns', (batch) => {
      const cpu = batch.column('cpu');
      for (let i = 0; i < batch.length; i += 1) {
        ring[w] = cpu.read(i);
        w = (w + 1) & 0xffff;
      }
    }),
  "'batch': JSON rows": (s) =>
    s.on('batch', (events) => {
      const rows = events.map((e) => [
        e.begin(),
        e.get('cpu'),
        e.get('requests'),
        e.get('host'),
      ]);
      sink += JSON.stringify(rows).length;
    }),
  "'columns': JSON rows": (s) =>
    s.on('columns', (batch) => {
      const key = batch.keyColumn();
      const cpu = batch.column('cpu');
      const req = batch.column('requests');
      const host = batch.column('host');
      const rows = new Array(batch.length);
      for (let i = 0; i < batch.length; i += 1) {
        rows[i] = [key.beginAt(i), cpu.read(i), req.read(i), host.read(i)];
      }
      sink += JSON.stringify(rows).length;
    }),
};

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const only = process.env.ONLY;
for (const [total, size] of [
  [1_000_000, 1000],
  [1_000_000, 100],
  [200_000, 10],
  [100_000, 1],
]) {
  const batches = makeBatches(total, size);
  for (const [name, attach] of Object.entries(consumers)) {
    if (only && !name.includes(only)) continue;
    const times = [];
    const gcs = [];
    for (let r = 0; r < 7; r += 1) {
      const s = new LiveSeries({
        name: 's',
        schema,
        retention: { maxEvents: 10_000 },
      });
      attach(s);
      globalThis.gc?.();
      const g0 = gcCount;
      const t0 = performance.now();
      for (const b of batches) s.pushMany(b);
      times.push(performance.now() - t0);
      await new Promise((resolve) => setTimeout(resolve, 0));
      gcs.push(gcCount - g0);
    }
    console.log(
      JSON.stringify({
        rows: total,
        batch: size,
        consumer: name,
        ms: Number(median(times.slice(2)).toFixed(1)),
        gcs: median(gcs.slice(2)),
      }),
    );
  }
}
void sink;
