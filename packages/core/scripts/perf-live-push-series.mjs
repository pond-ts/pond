// [PND-LPUSHCOL] LiveSeries.pushSeries vs pushMany.
//
// The same rows pushed two ways into twin live series:
//   - pushMany(rows)                          — row tuples, checked per cell
//   - pushSeries(TimeSeries.fromColumns(...)) — typed arrays; the timed
//     region includes building the batch, since that is what a caller
//     with columns pays
// plus `fromColumns` alone, the floor pushSeries can't go below.
//
//   npm run build --workspace=pond-ts
//   node --expose-gc scripts/perf-live-push-series.mjs            # timing
//   node --expose-gc scripts/perf-live-push-series.mjs --heap=rows
//   node --expose-gc scripts/perf-live-push-series.mjs --heap=series
//   node --expose-gc scripts/perf-live-push-series.mjs --heap=views
//   node --expose-gc scripts/perf-live-push-series.mjs --heap=slice
//   node --expose-gc scripts/perf-live-push-series.mjs --heap=center
//   node --expose-gc scripts/perf-live-push-series.mjs --heap=dict
//
// Cost model (N rows per push, C columns):
//   pushSeries, default series: O(C) shape check + O(1) per number column
//     for the required check (no gaps) + O(1) commit, on top of
//     fromColumns' O(N·C) scans. No Event per row.
//   pushSeries, other storage modes (drop / reorder / timeRange key):
//     O(N) Events + pushMany's per-row loop, so ≈ pushMany.
//   An 'event' / 'batch' listener (a window() view is one) builds an
//     Event per row on either path.
//   The copy check looks at each array once: O(C) per push (O(total
//     chunks) for a chunked column). A batch of 8 rows or fewer is copied
//     without checking. A batch whose buffers hold over twice the bytes its
//     rows use, or whose text dictionary has over twice as many entries as
//     rows (a slice() of a bigger series), is copied first: + O(N·C), and a
//     text column with such a dictionary is then trimmed: + O(N), plus
//     O(dictionary) when the lookup-table path fills its table.

import { performance } from 'node:perf_hooks';
import { LiveSeries, TimeSeries } from '../dist/index.js';

const TOTAL = 100_000;
const STEP = 1000; // 1s grid

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'price', kind: 'number' },
  { name: 'size', kind: 'number' },
]);

const HOSTS = Array.from({ length: 100 }, (_, i) => `api-${i}`);
const hostSchema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'requests', kind: 'number' },
  { name: 'host', kind: 'string' },
]);

/** Batches of `per` rows, both as row tuples and as columns. */
function makeSeries(per, { hosts = false, base = 0 } = {}) {
  const out = [];
  for (let start = 0; start < TOTAL; start += per) {
    const n = Math.min(per, TOTAL - start);
    const time = new Float64Array(n);
    const a = new Float64Array(n);
    const b = new Float64Array(n);
    const host = hosts ? new Array(n) : undefined;
    const rows = new Array(n);
    for (let i = 0; i < n; i += 1) {
      const idx = start + i;
      time[i] = base + idx * STEP;
      a[i] = 100 + (idx % 97) / 4;
      b[i] = (idx % 7) + 1;
      if (hosts) {
        host[i] = HOSTS[idx % HOSTS.length];
        rows[i] = [time[i], a[i], b[i], host[i]];
      } else {
        rows[i] = [time[i], a[i], b[i]];
      }
    }
    const columns = hosts
      ? { time, cpu: a, requests: b, host }
      : { time, price: a, size: b };
    out.push({ rows, columns, n });
  }
  return out;
}

function median(values) {
  const s = [...values].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function benchmark(fn, repeats = 8) {
  for (let i = 0; i < 2; i += 1) fn();
  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
    // No forced GC between samples: after a full GC the heap shrinks and
    // the next sample pays to grow it again, which swamped a 1 ms
    // workload (measured: fromColumns alone 0.8 ms without, 7-14 ms with).
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return Number(median(samples).toFixed(2));
}

const results = [];

/**
 * One scenario: `make()` builds a fresh live series (and anything hung
 * off it); every batch is pushed both ways.
 */
function scenario(label, batches, make, { s = schema, columnsOf } = {}) {
  const viaColumns = columnsOf ?? ((c) => c.columns);
  const pushMany = benchmark(() => {
    const live = make();
    for (const c of batches) live.pushMany(c.rows);
  });
  const pushSeries = benchmark(() => {
    const live = make();
    for (const c of batches) {
      live.pushSeries(
        TimeSeries.fromColumns({
          name: 'b',
          schema: s,
          columns: viaColumns(c),
        }),
      );
    }
  });
  const fromColumns = benchmark(() => {
    for (const c of batches) {
      TimeSeries.fromColumns({ name: 'b', schema: s, columns: viaColumns(c) });
    }
  });
  const row = {
    label,
    pushManyMs: pushMany,
    pushSeriesMs: pushSeries,
    fromColumnsOnlyMs: fromColumns,
    speedup: Number((pushMany / pushSeries).toFixed(1)),
  };
  results.push(row);
  console.error(JSON.stringify(row));
}

const live =
  (opts = {}) =>
  () =>
    new LiveSeries({ name: 's', schema, ...opts });

/* ── Heap mode: retained heap for a full window, one process each ──── */
const heapMode = process.argv
  .find((a) => a.startsWith('--heap='))
  ?.slice('--heap='.length);

if (heapMode === 'slice' || heapMode === 'center' || heapMode === 'dict') {
  // Seed a live series with the last 100 rows of a big history, then let
  // the history go: the live series should hold ~100 rows, not the
  // history. 'slice': a 1M-row history. 'center': the same slice re-keyed
  // with asTime({ at: 'center' }), which builds a new key but keeps the
  // history's number columns. 'dict': a 200k-row history whose text
  // column has 50k distinct values (a slice shares the whole dictionary).
  // Built inside a function and measured on a later tick, so nothing on
  // the stack still points at the history.
  const dictSchema = Object.freeze([
    { name: 'time', kind: 'time' },
    { name: 'price', kind: 'number' },
    { name: 'host', kind: 'string' },
  ]);
  const l = new LiveSeries({
    name: 's',
    schema: heapMode === 'dict' ? dictSchema : schema,
  });
  (() => {
    if (heapMode === 'dict') {
      const n = 200_000;
      const history = TimeSeries.fromColumns({
        name: 'history',
        schema: dictSchema,
        columns: {
          time: Float64Array.from({ length: n }, (_, i) => i * STEP),
          price: new Float64Array(n).fill(100),
          host: Array.from(
            { length: n },
            (_, i) => `host-${(i * 7) % 50_000}-${'x'.repeat(40)}`,
          ),
        },
      });
      l.pushSeries(history.slice(n - 100, n));
      return;
    }
    const n = 1_000_000;
    const history = TimeSeries.fromColumns({
      name: 'history',
      schema,
      columns: {
        time: Float64Array.from({ length: n }, (_, i) => i * STEP),
        price: new Float64Array(n).fill(100),
        size: new Float64Array(n).fill(1),
      },
    });
    const seed = history.slice(n - 100, n);
    l.pushSeries(heapMode === 'center' ? seed.asTime({ at: 'center' }) : seed);
  })();
  await new Promise((resolve) => setTimeout(resolve, 10));
  globalThis.gc?.();
  globalThis.gc?.();
  const m = process.memoryUsage();
  console.log(
    JSON.stringify({
      heap: {
        mode: heapMode,
        windowSize: l.length,
        heapUsedMB: Number((m.heapUsed / 1048576).toFixed(1)),
        arrayBuffersMB: Number((m.arrayBuffers / 1048576).toFixed(1)),
      },
    }),
  );
  process.exit(0);
}

if (heapMode) {
  const per = 1_000;
  let batches = makeSeries(per);
  const l = new LiveSeries({
    name: 's',
    schema,
    retention: { maxEvents: TOTAL },
  });
  for (const c of batches) {
    if (heapMode === 'rows') l.pushMany(c.rows);
    else if (heapMode === 'series') {
      l.pushSeries(
        TimeSeries.fromColumns({ name: 'b', schema, columns: c.columns }),
      );
    } else {
      // 'views': every column of a push is a view into one message
      // buffer twice the batch's size, as a worker message might be.
      const buf = new ArrayBuffer(per * 8 * 6);
      const time = new Float64Array(buf, 0, per);
      const price = new Float64Array(buf, per * 8, per);
      const size = new Float64Array(buf, per * 16, per);
      time.set(c.columns.time);
      price.set(c.columns.price);
      size.set(c.columns.size);
      l.pushSeries(
        TimeSeries.fromColumns({
          name: 'b',
          schema,
          columns: { time, price, size },
        }),
      );
    }
  }
  batches = null;
  globalThis.gc?.();
  globalThis.gc?.();
  const m = process.memoryUsage();
  console.log(
    JSON.stringify({
      heap: {
        mode: heapMode,
        windowSize: l.length,
        heapUsedMB: Number((m.heapUsed / 1048576).toFixed(1)),
        arrayBuffersMB: Number((m.arrayBuffers / 1048576).toFixed(1)),
      },
    }),
  );
  process.exit(0);
}

/* ── Typical and single-batch ceiling ─────────────────────────────── */
const b1600 = makeSeries(1_600);
scenario('100k rows, 1,600/push, no listener', b1600, live());
scenario('100k rows, one push', makeSeries(TOTAL), live());

/* ── Per-push floor ───────────────────────────────────────────────── */
const b16 = makeSeries(16);
scenario('100k rows, 16/push', b16, live());
scenario('100k rows, 1/push', makeSeries(1), live());

/* ── Retention (a boundary slice per push) ────────────────────────── */
scenario(
  'maxEvents 10k, 1,600/push',
  b1600,
  live({ retention: { maxEvents: 10_000 } }),
);
scenario(
  'maxEvents 10k, 16/push',
  b16,
  live({ retention: { maxEvents: 10_000 } }),
);
scenario(
  'maxAge 10000s, 1,600/push',
  b1600,
  live({ retention: { maxAge: '10000s' } }),
);

/* ── Row listeners bring back an Event per row ────────────────────── */
scenario('event listener, 1,600/push', b1600, () => {
  const l = new LiveSeries({ name: 's', schema });
  let sink = 0;
  l.on('event', (e) => {
    sink += e.get('price');
  });
  return l;
});
scenario('window(1000) view, 1,600/push', b1600, () => {
  const l = new LiveSeries({ name: 's', schema });
  l.window(1000);
  return l;
});

/* ── Partitioned source ───────────────────────────────────────────── */
const hosts1600 = makeSeries(1_600, { hosts: true });
scenario(
  'partitionBy host (100), strict partitions, 1,600/push',
  hosts1600,
  () => {
    const l = new LiveSeries({ name: 's', schema: hostSchema });
    l.partitionBy('host');
    return l;
  },
  { s: hostSchema },
);
scenario(
  'partitionBy host (100), drop partitions, 1,600/push',
  hosts1600,
  () => {
    const l = new LiveSeries({ name: 's', schema: hostSchema });
    l.partitionBy('host', { ordering: 'drop' });
    return l;
  },
  { s: hostSchema },
);

/* ── Other storage modes: no speed-up expected ────────────────────── */
scenario('drop, 1,600/push', b1600, live({ ordering: 'drop' }));
scenario(
  'reorder grace 5s, 1,600/push',
  b1600,
  live({ ordering: 'reorder', graceWindow: '5s' }),
);
{
  const trSchema = Object.freeze([
    { name: 'timeRange', kind: 'timeRange' },
    { name: 'price', kind: 'number' },
    { name: 'size', kind: 'number' },
  ]);
  const tr = b1600.map((c) => ({
    n: c.n,
    rows: c.rows.map((r) => [{ start: r[0], end: r[0] + 500 }, r[1], r[2]]),
    columns: {
      timeRange: c.columns.time,
      timeRangeEnd: c.columns.time.map((t) => t + 500),
      price: c.columns.price,
      size: c.columns.size,
    },
  }));
  scenario(
    'strict timeRange key, 1,600/push',
    tr,
    () => new LiveSeries({ name: 's', schema: trSchema }),
    { s: trSchema },
  );
}

/* ── Gateway shape: a dictionary string column ────────────────────── */
scenario(
  'time+cpu+requests+host, 1,600/push',
  hosts1600,
  () => new LiveSeries({ name: 's', schema: hostSchema }),
  { s: hostSchema },
);

/* ── Input form: adopted Float64Array vs copied ───────────────────── */
scenario('number[] columns (copied), 1,600/push', b1600, live(), {
  columnsOf: (c) => ({
    time: Array.from(c.columns.time),
    price: Array.from(c.columns.price),
    size: Array.from(c.columns.size),
  }),
});
scenario('Float64Array .slice() first (a copy), 1,600/push', b1600, live(), {
  columnsOf: (c) => ({
    time: c.columns.time.slice(),
    price: c.columns.price.slice(),
    size: c.columns.size.slice(),
  }),
});
scenario('Float64Array .slice() first, 16/push', b16, live(), {
  columnsOf: (c) => ({
    time: c.columns.time.slice(),
    price: c.columns.price.slice(),
    size: c.columns.size.slice(),
  }),
});

/* ── Slices of one big series (copied before storing) ──────────────── */
function sliceScenario(label, big, s, per) {
  const ranges = [];
  for (let start = 0; start < TOTAL; start += per) {
    const end = Math.min(TOTAL, start + per);
    ranges.push({ start, end, rows: big.slice(start, end).toRows() });
  }
  const pushMany = benchmark(() => {
    const l = new LiveSeries({ name: 's', schema: s });
    for (const r of ranges) l.pushMany(r.rows);
  });
  const pushSeries = benchmark(() => {
    const l = new LiveSeries({ name: 's', schema: s });
    for (const r of ranges) l.pushSeries(big.slice(r.start, r.end));
  });
  const row = {
    label,
    pushManyMs: pushMany,
    pushSeriesMs: pushSeries,
    speedup: Number((pushMany / pushSeries).toFixed(1)),
  };
  results.push(row);
  console.error(JSON.stringify(row));
}
{
  const big = TimeSeries.fromColumns({
    name: 'big',
    schema,
    columns: {
      time: Float64Array.from({ length: TOTAL }, (_, i) => i * STEP),
      price: Float64Array.from({ length: TOTAL }, (_, i) => 100 + (i % 97) / 4),
      size: Float64Array.from({ length: TOTAL }, (_, i) => (i % 7) + 1),
    },
  });
  sliceScenario(
    'slices of one 100k series, 1,600/push (copied)',
    big,
    schema,
    1_600,
  );
  // A text column of 100 hosts: each slice is copied (its number columns
  // view the parent's); its dictionary (100 entries) is within twice its
  // rows at 1,600 rows, so it stays shared, and beyond it at 16, so the copy
  // trims it.
  const hosts = TimeSeries.fromColumns({
    name: 'hosts',
    schema: hostSchema,
    columns: {
      time: Float64Array.from({ length: TOTAL }, (_, i) => i * STEP),
      cpu: Float64Array.from({ length: TOTAL }, (_, i) => 100 + (i % 97) / 4),
      requests: Float64Array.from({ length: TOTAL }, (_, i) => (i % 7) + 1),
      host: Array.from({ length: TOTAL }, (_, i) => HOSTS[i % HOSTS.length]),
    },
  });
  sliceScenario(
    'slices of a 100k hosts series, 1,600/push (copied)',
    hosts,
    hostSchema,
    1_600,
  );
  sliceScenario(
    'slices of a 100k hosts series, 16/push (copied)',
    hosts,
    hostSchema,
    16,
  );
}

/* ── No-op pushes ─────────────────────────────────────────────────── */
{
  const empty = TimeSeries.fromColumns({
    name: 'e',
    schema,
    columns: {
      time: new Float64Array(0),
      price: new Float64Array(0),
      size: new Float64Array(0),
    },
  });
  const l = new LiveSeries({ name: 's', schema });
  const ms = benchmark(() => {
    for (let i = 0; i < TOTAL; i += 1) l.pushSeries(empty);
  });
  const row = { label: '100k empty pushSeries calls', pushSeriesMs: ms };
  results.push(row);
  console.error(JSON.stringify(row));
}
{
  // Every row older than what the series holds: drop rejects them all.
  const late = makeSeries(1_600);
  const make = () => {
    const l = new LiveSeries({ name: 's', schema, ordering: 'drop' });
    l.push([TOTAL * STEP * 2, 1, 1]);
    return l;
  };
  scenario('drop, every row late, 1,600/push', late, make);
}

console.log(JSON.stringify({ timing: results }, null, 2));
if (!globalThis.gc) console.error('\n[warn] run with --expose-gc');
