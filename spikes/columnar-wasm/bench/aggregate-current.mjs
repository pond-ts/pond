/**
 * `aggregate` deep dive, against the CURRENT library.
 *
 * `bench/aggregate.mjs` measured `aggregate` before [PND-IVLCOL] and
 * [PND-AGGALLOC] landed. Both of its sides are now stale, in opposite
 * directions:
 *
 *   - pond-ts got 2.0-2.55x faster, so the gap it measured is mostly gone.
 *   - its WASM path still materialises frozen rows and re-columnarises
 *     them, which the library no longer does — so that side is now
 *     carrying a cost the baseline dropped.
 *
 * Re-running it unchanged would report ~1.3x and be wrong twice. This
 * gives both sides the current output path — an interval-keyed
 * `ColumnarStore` via trusted construction — so the only difference left
 * is the one under test: who runs the per-bucket reduction.
 *
 * Run: node bench/aggregate-current.mjs [--json out.json] [--quick]
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  Sequence,
  TimeRange,
  TimeSeries,
} from '../../../packages/core/dist/index.js';
import {
  ColumnarStore,
  Float64Column,
  IntervalKeyColumn,
} from '../../../packages/core/dist/columnar/index.js';
import { SeriesStore } from '../../../packages/core/dist/live/series-store.js';
import '../../../packages/core/dist/column.js';
import { loadSubstrate } from '../js/loader.mjs';
import { bench } from './suite.mjs';

const argv = process.argv.slice(2);
const jsonIdx = argv.indexOf('--json');
const JSON_OUT = jsonIdx >= 0 ? argv[jsonIdx + 1] : null;
const QUICK = argv.includes('--quick');

const rt = await loadSubstrate();
const budgetMs = QUICK ? 60 : 140;
const N = QUICK ? 200_000 : 1_000_000;
const STEP_MS = 1_000;

function makeSeries(n, c) {
  const schema = Object.freeze([
    { name: 'time', kind: 'time' },
    ...Array.from({ length: c }, (_, i) => ({
      name: `v${i}`,
      kind: 'number',
      required: false,
    })),
  ]);
  const rows = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const row = new Array(c + 1);
    row[0] = i * STEP_MS;
    for (let k = 0; k < c; k += 1) {
      row[k + 1] = 50 + 35 * Math.sin(i / 5000 + k) + 10 * Math.sin(i / 137);
    }
    rows[i] = row;
  }
  return new TimeSeries({ name: 'metrics', schema, rows });
}

/** The output path the library now uses, available to both sides. */
function storeFromColumns(schema, begin, end, valueColumns) {
  const B = begin.length;
  const keys = new IntervalKeyColumn(
    begin,
    end,
    new Float64Column(begin, B, undefined, true),
    B,
  );
  const columns = new Map();
  for (let k = 1; k < schema.length; k += 1) {
    columns.set(schema[k].name, valueColumns[k - 1]);
  }
  return SeriesStore.fromTrustedStore(
    ColumnarStore.fromTrustedStore(schema, keys, columns),
  );
}

console.log('═'.repeat(96));
console.log('`aggregate` — where the time goes, and what Rust could take');
console.log('═'.repeat(96));
console.log(
  `node ${process.version} · ${process.platform}/${process.arch} · ` +
    `N = ${N.toLocaleString()} on a 1 s grid · measured against the CURRENT library`,
);
console.log();

const SHAPES = QUICK
  ? [{ bucketMs: 60_000, c: 4 }]
  : [
      { bucketMs: 10_000, c: 4 },
      { bucketMs: 60_000, c: 1 },
      { bucketMs: 60_000, c: 4 },
      { bucketMs: 600_000, c: 4 },
      { bucketMs: 3_600_000, c: 4 },
    ];

const pad = (x, w) => String(x).padStart(w);
const rows = [];

for (const { bucketMs, c } of SHAPES) {
  const series = makeSeries(N, c);
  const range = new TimeRange({ start: 0, end: (N - 1) * STEP_MS });
  const sequence = Sequence.every(bucketMs);
  const mapping = Object.fromEntries(
    Array.from({ length: c }, (_, i) => [`v${i}`, 'avg']),
  );
  const schemaOut = Object.freeze([
    { name: 'interval', kind: 'interval' },
    ...Object.keys(mapping).map((n) => ({
      name: n,
      kind: 'number',
      required: false,
    })),
  ]);

  const buckets = sequence.bounded(range, { sample: 'begin' }).intervals();
  const B = buckets.length;
  const begin = new Float64Array(B);
  const end = new Float64Array(B);
  const edges = new Float64Array(B + 1);
  for (let b = 0; b < B; b += 1) {
    begin[b] = buckets[b].begin();
    end[b] = buckets[b].end();
    edges[b] = buckets[b].begin();
  }
  edges[B] = buckets[B - 1].end();

  // Resident copies of the key axis and every value column.
  const { exports, mem } = rt;
  const begins = series.keyColumn().begin;
  const keyPtr = exports.pond_alloc(N * 8);
  mem.sync().f64.set(begins, keyPtr >>> 3);
  const colPtrs = [];
  for (let k = 0; k < c; k += 1) {
    const p = exports.pond_alloc(N * 8);
    mem.sync().f64.set(series.column(`v${k}`).toFloat64Array(), p >>> 3);
    colPtrs.push(p);
  }
  const edgesPtr = exports.pond_alloc((B + 1) * 8);
  mem.sync().f64.set(edges, edgesPtr >>> 3);
  const boundsPtr = exports.pond_alloc((B + 1) * 4);
  const outPtr = exports.pond_alloc(c * B * 8);

  /* ── stages, measured in isolation ──────────────────────────────── */
  const tDerive = bench(
    () => sequence.bounded(range, { sample: 'begin' }).intervals().length,
    { budgetMs },
  ).medianMs;

  const precomputed = Array.from(
    { length: c },
    () => new Float64Column(new Float64Array(B), B, undefined, true),
  );
  const tOutput = bench(
    () => storeFromColumns(schemaOut, begin, end, precomputed).length,
    { budgetMs },
  ).medianMs;

  const tKernelWasm = bench(
    () => {
      exports.bounds_from_edges(keyPtr, N, edgesPtr, B, 0, boundsPtr);
      for (let k = 0; k < c; k += 1) {
        exports.reduce_bounds_scalar(
          colPtrs[k],
          0,
          1,
          boundsPtr,
          B,
          3,
          0,
          outPtr + k * B * 8,
          0,
        );
      }
      return B;
    },
    { budgetMs },
  ).medianMs;

  const tTotal = bench(
    () => series.aggregate(sequence, mapping, { range }).length,
    { budgetMs },
  ).medianMs;

  // What is left once the two non-kernel stages are accounted for. Both
  // are measured, not fitted, so this subtraction has directly-measured
  // terms on both sides.
  const tKernelPond = Math.max(0, tTotal - tDerive - tOutput);
  const ported = tDerive + tOutput + tKernelWasm;

  rows.push({
    bucketMs,
    c,
    B,
    perBucket: Math.round(N / B),
    tTotal,
    tDerive,
    tOutput,
    tKernelPond,
    tKernelWasm,
    kernelSharePct: (tKernelPond / tTotal) * 100,
    kernelX: tKernelWasm > 0 ? tKernelPond / tKernelWasm : 1,
    ported,
    ceiling: tTotal / ported,
  });

  exports.pond_free(keyPtr, N * 8);
  for (const p of colPtrs) exports.pond_free(p, N * 8);
  exports.pond_free(edgesPtr, (B + 1) * 8);
  exports.pond_free(boundsPtr, (B + 1) * 4);
  exports.pond_free(outPtr, c * B * 8);
}

console.log(
  `  ${pad('ev/bkt', 7)} ${pad('C', 2)} ${pad('buckets', 8)} ${pad('total', 9)} ` +
    `${pad('1.derive', 9)} ${pad('2.reduce', 9)} ${pad('3.output', 9)} ${pad('kernel', 7)}`,
);
console.log(`  ${'─'.repeat(88)}`);
for (const r of rows) {
  console.log(
    `  ${pad(r.perBucket, 7)} ${pad(r.c, 2)} ${pad(r.B.toLocaleString(), 8)} ` +
      `${pad(r.tTotal.toFixed(2) + 'ms', 9)} ${pad(r.tDerive.toFixed(2) + 'ms', 9)} ` +
      `${pad(r.tKernelPond.toFixed(2) + 'ms', 9)} ${pad(r.tOutput.toFixed(2) + 'ms', 9)} ` +
      `${pad(r.kernelSharePct.toFixed(0) + '%', 7)}`,
  );
}
console.log();
console.log(
  `  ${pad('ev/bkt', 7)} ${pad('C', 2)} ${pad('reduce (pond)', 14)} ${pad('reduce (rust)', 14)} ` +
    `${pad('kernel x', 9)} ${pad('CEILING', 8)}`,
);
console.log(`  ${'─'.repeat(70)}`);
for (const r of rows) {
  console.log(
    `  ${pad(r.perBucket, 7)} ${pad(r.c, 2)} ${pad(r.tKernelPond.toFixed(2) + 'ms', 14)} ` +
      `${pad(r.tKernelWasm.toFixed(2) + 'ms', 14)} ${pad(r.kernelX.toFixed(2) + 'x', 9)} ` +
      `${pad(r.ceiling.toFixed(2) + 'x', 8)}`,
  );
}
console.log();
console.log(
  '  1.derive = Sequence.bounded().intervals() — B Interval objects (JS, unportable)\n' +
    '  2.reduce = what is left: the per-bucket reduction. What Rust would own.\n' +
    '  3.output = interval-keyed columnar store construction (JS, unportable)\n' +
    '  CEILING  = (derive + output + rust reduce) vs today. Upper bound: assumes\n' +
    '             columns already resident, zero boundary, zero ingest.',
);
console.log();

if (JSON_OUT) {
  writeFileSync(
    resolve(process.cwd(), JSON_OUT),
    JSON.stringify(rows, null, 2),
  );
  console.log(`raw results → ${JSON_OUT}`);
}
