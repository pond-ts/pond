// §A prong-2 spike bench — allocation-skip of a walk-now grouped column
// read vs the snapshot→partitionBy→toMap path the dashboard uses today.
//
// Brief: docs/briefs/column-on-liveview-spike.md (increment 1,
// allocation-skip-first). This measures the LOWER-RISK cut: both paths
// read the SAME Event[]-backed LiveView; the only difference is how the
// per-partition typed arrays are produced.
//
//   Path A (today): view.toTimeSeries().partitionBy('host').toMap(g => ({
//                     ts:  g.keyColumn().begin,
//                     cpu: g.column('cpu').toFloat64Array(), ...}))
//                   → 1 snapshot TimeSeries + N per-partition TimeSeries,
//                     each building EVERY column's store, per tick.
//
//   Path B (spike): gatherByPartition(view, 'host', g => ({
//                     ts:  g.keyColumn(),       // Float64Array
//                     cpu: g.column('cpu'), ...}))
//                   → buckets event indices by host, gathers only the
//                     columns read directly into Float64Arrays. Zero
//                     TimeSeries constructed (by construction).
//
// Both produce the SAME output: Map<host, { ts, cpu, avg, sd }> of
// Float64Arrays. Time is the robust signal — transient allocation shows
// up as GC overhead in the per-tick median. (The in-pond heapUsed gauge
// is unreliable for transient churn; see perf-live-columnar.mjs caveat.
// The structural / zero-copy cut over a chunked view is increment 2.)
//
//   npm run build --workspace=pond-ts
//   node --expose-gc scripts/perf-liveview-columns.mjs

import { performance } from 'node:perf_hooks';
import { LiveSeries } from '../dist/index.js';

const schema = Object.freeze([
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'avg', kind: 'number' },
  { name: 'sd', kind: 'number' },
  { name: 'host', kind: 'string' },
]);

// Columns the chart reads per partition (the dashboard's baseline shape:
// raw value + band inputs). 'host' is the partition key, not gathered.
const READ = ['cpu', 'avg', 'sd'];

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function bench(fn, repeats = 5) {
  for (let i = 0; i < 2; i += 1) fn();
  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  return Number(median(samples).toFixed(2));
}

// Build a LiveView holding `events` rows spread across `hosts` partitions.
function makeView(hosts, events) {
  const live = new LiveSeries({
    name: 's',
    schema,
    ordering: 'strict',
    retention: { maxEvents: events },
  });
  const BATCH = 1_000;
  let rows = new Array(BATCH);
  let n = 0;
  for (let i = 0; i < events; i += 1) {
    const v = i % 97;
    rows[n++] = [1000 + i, v, v + 0.5, (i % 13) / 7, `host-${i % hosts}`];
    if (n === BATCH) {
      live.pushMany(rows);
      n = 0;
    }
  }
  if (n > 0) live.pushMany(rows.slice(0, n));
  return live.window(events); // count window over the whole buffer
}

// Path A — the snapshot path the dashboard uses today.
function pathA(view) {
  return view
    .toTimeSeries()
    .partitionBy('host')
    .toMap((g) => {
      const out = { ts: g.keyColumn().begin };
      for (const name of READ) out[name] = g.column(name).toFloat64Array();
      return out;
    });
}

// Path B — walk-now grouped gather. Buckets event indices by the
// partition column, then gathers only the read columns into Float64Arrays.
// Reads the view through the public LiveSource surface (length / at(i));
// constructs no TimeSeries. This is the spike's allocation-skip prototype.
function pathB(view) {
  const n = view.length;
  const buckets = new Map();
  for (let i = 0; i < n; i += 1) {
    const key = view.at(i).get('host');
    let idxs = buckets.get(key);
    if (idxs === undefined) {
      idxs = [];
      buckets.set(key, idxs);
    }
    idxs.push(i);
  }
  const result = new Map();
  for (const [key, idxs] of buckets) {
    const len = idxs.length;
    const ts = new Float64Array(len);
    for (let j = 0; j < len; j += 1) ts[j] = view.at(idxs[j]).begin();
    const out = { ts };
    for (const name of READ) {
      const arr = new Float64Array(len);
      for (let j = 0; j < len; j += 1) {
        const v = view.at(idxs[j]).get(name);
        arr[j] = typeof v === 'number' ? v : NaN;
      }
      out[name] = arr;
    }
    result.set(key, out);
  }
  return result;
}

// Correctness gate — both paths must produce identical arrays.
function assertParity(hosts, events) {
  const view = makeView(hosts, events);
  const a = pathA(view);
  const b = pathB(view);
  if (a.size !== b.size) throw new Error(`size ${a.size} != ${b.size}`);
  for (const [key, av] of a) {
    const bv = b.get(key);
    if (!bv) throw new Error(`missing ${key} in B`);
    for (const col of ['ts', ...READ]) {
      if (av[col].length !== bv[col].length)
        throw new Error(`${key}.${col} length mismatch`);
      for (let i = 0; i < av[col].length; i += 1) {
        if (
          av[col][i] !== bv[col][i] &&
          !(Number.isNaN(av[col][i]) && Number.isNaN(bv[col][i]))
        )
          throw new Error(`${key}.${col}[${i}] ${av[col][i]} != ${bv[col][i]}`);
      }
    }
  }
}

const CELLS = [
  { hosts: 8, events: 12_000 },
  { hosts: 32, events: 48_000 },
  { hosts: 64, events: 96_000 },
  { hosts: 256, events: 384_000 },
];

assertParity(8, 4_000);
assertParity(64, 12_800);

const rows = [];
for (const { hosts, events } of CELLS) {
  const view = makeView(hosts, events);
  const a = bench(() => pathA(view));
  const b = bench(() => pathB(view));
  rows.push({
    hosts,
    events,
    snapshotMs: a,
    walkNowMs: b,
    speedup: Number((a / b).toFixed(2)),
  });
}

console.log(JSON.stringify({ liveviewColumnGather: rows }, null, 2));
if (!globalThis.gc)
  console.error('\n[note] run with --expose-gc for stable GC timing');
