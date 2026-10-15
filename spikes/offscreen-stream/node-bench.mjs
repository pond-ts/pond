// Node-side measurements the report quotes, so every number has a script.
// Run from the repo root after `npm run build --workspace=pond-ts`:
//
//   node spikes/offscreen-stream/node-bench.mjs > spikes/offscreen-stream/results/node.txt
//
// 1. Reading a LiveSeries out as arrays: toTimeSeries() vs a LiveView's
//    column readers vs copying the stored chunks (what a column hand-over
//    would start from).
// 2. Ingest: where the time goes between the wire buffer and LiveSeries,
//    plus the batch columnar ingest (`TimeSeries.fromColumns`) on the same
//    batches as a stand-in for what a columnar LiveSeries push would cost.
// 3. A `live.window()` LiveView's per-push cost as the window grows.
// 4. History download speed into a plain Node WebSocket client.
import { LiveSeries, TimeSeries } from '../../packages/core/dist/index.js';
import { WebSocket } from 'ws';
import { startServer } from './server.mjs';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'price', kind: 'number' },
  { name: 'size', kind: 'number' },
];
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const time = (fn, reps = 5) => {
  const out = [];
  for (let i = 0; i < reps; i++) {
    const t = performance.now();
    fn();
    out.push(performance.now() - t);
  }
  return median(out);
};
/** One wire frame: [sendTime, n, dropped, t, price, size, …] like server.mjs. */
function frame(n, t0, step) {
  const b = new Float64Array(3 + n * 3);
  b[1] = n;
  let p = 100;
  for (let i = 0; i < n; i++) {
    p += Math.random() - 0.5;
    b[3 + i * 3] = t0 + i * step;
    b[4 + i * 3] = p;
    b[5 + i * 3] = 1;
  }
  return b;
}
const rowsOf = (b) => {
  const n = b[1];
  const rows = new Array(n);
  for (let i = 0; i < n; i++)
    rows[i] = [b[3 + i * 3], b[4 + i * 3], b[5 + i * 3]];
  return rows;
};
function fill(live, n, batch = 1600) {
  let t = 1e12;
  for (let k = 0; k < n / batch; k++) {
    live.pushMany(rowsOf(frame(batch, t, 0.01)));
    t += batch * 0.01;
  }
}

console.log(
  `# node ${process.version}, ${new Date().toISOString().slice(0, 10)}`,
);
console.log(
  '\n## 1. Reading N rows out of a LiveSeries as x/y arrays (median of 5, ms)',
);
console.log(
  'N         toTimeSeries+read   LiveView keyColumn+column   copy stored chunks',
);
for (const N of [60_000, 600_000, 3_000_000]) {
  const live = new LiveSeries({ name: 't', schema });
  const chunks = [];
  live._onChunk((s) => chunks.push(s));
  fill(live, N);
  const snap = time(
    () => {
      const ts = live.toTimeSeries();
      const c = ts.column('price');
      const y = new Float64Array(ts.length);
      for (let i = 0; i < ts.length; i++) y[i] = c.read(i);
    },
    N > 1e6 ? 3 : 5,
  );
  const concat = time(() => {
    const x = new Float64Array(live.length);
    const y = new Float64Array(live.length);
    let o = 0;
    for (const s of chunks) {
      const c = s.columns.get('price');
      for (let i = 0; i < s.length; i++, o++) {
        x[o] = s.beginAt(i);
        y[o] = c.read(i);
      }
    }
  });
  // A LiveView over the same rows (built after the fact: its construction
  // walks the source once; the gather is what a chart would pay per frame).
  let viewMs = '—';
  if (N <= 600_000) {
    const view = live.window(N); // count window ≥ N: holds every row
    viewMs = time(() => {
      const x = view.keyColumn().begin;
      const c = view.column('price');
      const y = new Float64Array(x.length);
      for (let i = 0; i < x.length; i++) y[i] = c.read(i);
    }).toFixed(1);
  }
  console.log(
    `${String(N).padEnd(9)} ${snap.toFixed(1).padStart(14)}   ${String(viewMs).padStart(20)}   ${concat.toFixed(1).padStart(18)}`,
  );
}

console.log(
  '\n## 2. Ingest at 100k ticks/s: cost per second of ticks, by step (median of 5, ms)',
);
console.log(
  'batch  build-rows  pushMany  pushMany+mirror(_onChunk)  raw typed copy  TimeSeries.fromColumns',
);
for (const batch of [16, 160, 400, 800, 1600, 5000]) {
  const frames = Array.from({ length: Math.ceil(100_000 / batch) }, (_, k) =>
    frame(batch, 1e12 + k * batch * 0.01, 0.01),
  );
  const build = time(() => {
    for (const f of frames) rowsOf(f);
  });
  const prebuilt = frames.map(rowsOf);
  const push = time(() => {
    const live = new LiveSeries({
      name: 't',
      schema,
      retention: { maxAge: '10s' },
    });
    for (const r of prebuilt) live.pushMany(r);
  });
  const mirror = time(() => {
    const live = new LiveSeries({
      name: 't',
      schema,
      retention: { maxAge: '10s' },
    });
    const x = new Float64Array(100_000);
    const y = new Float64Array(100_000);
    let o = 0;
    live._onChunk((s) => {
      const c = s.columns.get('price');
      for (let i = 0; i < s.length; i++, o++) {
        x[o] = s.beginAt(i);
        y[o] = c.read(i);
      }
    });
    for (const r of prebuilt) live.pushMany(r);
  });
  const raw = time(() => {
    const x = new Float64Array(100_000);
    const y = new Float64Array(100_000);
    let o = 0;
    for (const f of frames)
      for (let i = 0; i < f[1]; i++, o++) {
        x[o] = f[3 + i * 3];
        y[o] = f[4 + i * 3];
      }
  });
  // The same batches already split into one typed array per column (what a
  // columnar wire would deliver), through pond's columnar ingest engine.
  const colBatches = frames.map((f) => {
    const n = f[1];
    const c = {
      time: new Float64Array(n),
      price: new Float64Array(n),
      size: new Float64Array(n),
    };
    for (let i = 0; i < n; i++) {
      c.time[i] = f[3 + i * 3];
      c.price[i] = f[4 + i * 3];
      c.size[i] = f[5 + i * 3];
    }
    return c;
  });
  const cols = time(() => {
    for (const columns of colBatches)
      TimeSeries.fromColumns({ name: 't', schema, columns });
  });
  console.log(
    `${String(batch).padEnd(6)} ${build.toFixed(1).padStart(10)}  ${push.toFixed(1).padStart(8)}  ${mirror.toFixed(1).padStart(25)}  ${raw.toFixed(2).padStart(14)}  ${cols.toFixed(2).padStart(22)}`,
  );
}

console.log(
  '\n## 3. pushMany cost with a live.window() LiveView attached (ms per 160-row push, steady state)',
);
console.log('window(events)  no view   with view');
for (const W of [1_000, 10_000, 50_000, 100_000]) {
  const res = [];
  for (const withView of [false, true]) {
    const live = new LiveSeries({
      name: 't',
      schema,
      retention: { maxAge: `${W * 0.1}ms` },
    });
    const view = withView ? live.window(`${W * 0.1}ms`) : null;
    let t = 1e12;
    const pushes = Math.ceil((W * 3) / 160);
    let ms = 0;
    for (let k = 0; k < pushes; k++) {
      const rows = rowsOf(frame(160, t, 0.1));
      t += 16;
      const a = performance.now();
      live.pushMany(rows);
      if (k >= pushes / 2) ms += performance.now() - a; // after the window is full
    }
    res.push(ms / (pushes - Math.ceil(pushes / 2)));
    if (view) view.dispose?.();
  }
  console.log(
    `${String(W).padEnd(15)} ${res[0].toFixed(3).padStart(7)}   ${res[1].toFixed(3).padStart(9)}`,
  );
}

console.log('\n## 4. History download into a Node WebSocket client');
{
  const { server, port } = await startServer({ port: 0 });
  for (const ticks of [1_000_000, 6_000_000]) {
    const ms = await new Promise((resolve) => {
      const t0 = Date.now();
      let n = 0;
      const ws = new WebSocket(
        `ws://localhost:${port}/stream?rate=${ticks / 10}&prefill=10`,
      );
      ws.on('message', (d) => {
        n += d.readDoubleLE(8);
        if (n >= ticks) {
          ws.close();
          resolve(Date.now() - t0);
        }
      });
    });
    console.log(
      `${ticks.toLocaleString()} ticks (${((ticks * 24) / 1e6).toFixed(0)} MB): ${ms} ms`,
    );
  }
  server.close();
}
process.exit(0);
