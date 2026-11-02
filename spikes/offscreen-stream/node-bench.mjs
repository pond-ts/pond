// Node-side measurements the report quotes, so every number has a script.
// Run from the repo root after `npm run build --workspace=pond-ts`:
//
//   node spikes/offscreen-stream/node-bench.mjs > spikes/offscreen-stream/results/node.txt
//
// `node-bench.mjs 3` runs only section 3 (any list of section numbers works).
//
// 1. Reading a LiveSeries out as arrays: toTimeSeries() vs a LiveView's
//    column readers vs copying the stored chunks (what a column hand-over
//    would start from).
// 2. Ingest: where the time goes between the wire buffer and LiveSeries,
//    plus the batch columnar ingest (`TimeSeries.fromColumns`) on the same
//    batches as a stand-in for what a columnar LiveSeries push would cost.
// 3. A `live.window()` LiveView's per-push cost as the window grows, at 10k
//    and 100k ticks/s.
// 4. History download speed into a plain Node WebSocket client.
import { LiveSeries, TimeSeries } from '../../packages/core/dist/index.js';
import { WebSocket } from 'ws';
import { startServer } from './server.mjs';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'price', kind: 'number' },
  { name: 'size', kind: 'number' },
];
const only = process.argv.slice(2).map(Number);
const run = (n) => only.length === 0 || only.includes(n);
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
if (run(1)) {
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
}

if (run(2)) {
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
}

if (run(3)) {
  console.log(
    '\n## 3. pushMany cost with a live.window() LiveView attached (ms per push, window already full, median of 3)',
  );
  console.log(
    'window(events)   10k ticks/s (160 a push): no view  with view   100k ticks/s (1,600 a push): no view  with view',
  );
  // One push every 16 ms; the window holds W events. The series is filled past
  // the window first (no view, so it's quick), then the view is attached (its
  // construction walks the window once) and 10 further pushes are timed.
  function windowCost(W, batch, withView) {
    const step = 16 / batch; // ms between ticks
    const span = `${W * step}ms`;
    const live = new LiveSeries({
      name: 't',
      schema,
      retention: { maxAge: span },
    });
    let t = 1e12;
    const next = () => {
      const r = rowsOf(frame(batch, t, step));
      t += 16;
      return r;
    };
    for (let k = 0; k < Math.ceil((W * 1.2) / batch); k++)
      live.pushMany(next());
    const view = withView ? live.window(span) : null;
    for (let k = 0; k < 3; k++) live.pushMany(next());
    let ms = 0;
    for (let k = 0; k < 10; k++) {
      const r = next();
      const a = performance.now();
      live.pushMany(r);
      ms += performance.now() - a;
    }
    view?.dispose?.();
    return ms / 10;
  }
  for (const W of [1_000, 10_000, 50_000, 100_000]) {
    const cells = [];
    for (const batch of [160, 1600])
      for (const withView of [false, true]) {
        const runs = [0, 1, 2].map(() => windowCost(W, batch, withView));
        cells.push(median(runs));
      }
    console.log(
      `${String(W).padEnd(15)} ${cells[0].toFixed(2).padStart(36)} ${cells[1].toFixed(2).padStart(10)}   ${cells[2].toFixed(2).padStart(38)} ${cells[3].toFixed(2).padStart(10)}`,
    );
  }
}

if (run(4)) {
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
}
process.exit(0);
