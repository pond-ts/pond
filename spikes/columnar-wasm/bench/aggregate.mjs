/**
 * "What if aggregation happened in Rust?"
 *
 * `bin` is a leaf kernel over one column. `TimeSeries.aggregate` is a
 * *composite*: bucket a key column, reduce C value columns per bucket
 * with R reducers, and produce a whole new series. That is the best
 * possible shape for a WASM port — one boundary crossing amortised over
 * N × C elements of work, with no per-element callback — so it deserves
 * its own measurement rather than an extrapolation from the leaf-kernel
 * numbers.
 *
 * The experiment is staged, because the interesting answer is not "how
 * fast is the reduce" but "how much of `aggregate` is the reduce at all."
 * `aggregate` does four things:
 *
 *   1. bucket derivation   `Sequence.every(W).intervals()` → B Interval objects
 *   2. reduce              per bucket, per column → B × C values
 *   3. row materialisation `Object.freeze([bucket, ...reduced])` per bucket
 *   4. series construction `new TimeSeries({ rows })` — re-columnarises them
 *
 * A Rust port can only touch **stage 2**. Stages 1, 3 and 4 are JS object
 * graph work: `Interval` instances, frozen row arrays, schema validation,
 * and the row→column re-ingest. So the honest ceiling on any port is
 * Amdahl's law over stage 2's share, and this script measures that share
 * directly rather than assuming it.
 *
 * Three implementations of stage 2, all producing identical values
 * (checked before timing):
 *
 *   pond-ts   `tryAggregateColumnarTimeKeyed` — the shipped fast path
 *   js-algo   same algorithm, but range-scoped reducers (no per-bucket
 *             `sliceByRange` allocation) writing into typed output arrays
 *   wasm      `bounds_from_edges` + `reduce_bounds_scalar` per column
 *
 * Run: node bench/aggregate.mjs [--json out.json] [--quick]
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  Sequence,
  TimeRange,
  TimeSeries,
} from '../../../packages/core/dist/index.js';
import { tryAggregateColumnarTimeKeyed } from '../../../packages/core/dist/batch/aggregate-columns.js';
import { Float64Column } from '../../../packages/core/dist/columnar/index.js';
import '../../../packages/core/dist/column.js';
import { loadSubstrate } from '../js/loader.mjs';
import { bench } from './suite.mjs';

const argv = process.argv.slice(2);
const jsonIdx = argv.indexOf('--json');
const JSON_OUT = jsonIdx >= 0 ? argv[jsonIdx + 1] : null;
const QUICK = argv.includes('--quick');

const rt = await loadSubstrate();
const budgetMs = QUICK ? 60 : 140;

/* ══════════════════════════════════════════════════════════════════ */
/* Workload                                                           */
/* ══════════════════════════════════════════════════════════════════ */

const STEP_MS = 1_000; // 1 s sample grid

/**
 * A realistic metrics shape: `C` numeric columns on a regular 1 s grid,
 * aggregated into `bucketMs` windows. `C` is swept because the whole
 * argument for a composite port is that per-call overhead amortises over
 * more columns — if it doesn't improve with `C`, that argument is dead.
 */
function makeWorkload(n, c, bucketMs) {
  const schema = Object.freeze([
    { name: 'time', kind: 'time' },
    ...Array.from({ length: c }, (_, i) => ({
      name: `v${i}`,
      kind: 'number',
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
  const series = new TimeSeries({ name: 'metrics', schema, rows });
  const range = new TimeRange({ start: 0, end: (n - 1) * STEP_MS });
  const sequence = Sequence.every(bucketMs);
  return { series, range, sequence, c, n, bucketMs };
}

/** Reducers under test. `avg`/`sum` mirror `scripts/perf-aggregate.mjs`. */
const REDUCERS = ['avg', 'sum'];
const RUST_CODE = { min: 0, max: 1, sum: 2, avg: 3, stdev: 4, count: 5 };

function mappingFor(c) {
  const m = {};
  for (let i = 0; i < c; i += 1) m[`v${i}`] = REDUCERS[i % REDUCERS.length];
  return m;
}

/* ══════════════════════════════════════════════════════════════════ */
/* js-algo: the same algorithm without pond-ts's per-bucket allocation */
/* ══════════════════════════════════════════════════════════════════ */

/**
 * Range-scoped reducers. pond-ts reduces a bucket by *allocating a
 * `Float64Column` view* for it (`plan.column.sliceByRange(start, scan)`)
 * and handing that to `reduceColumn`. That is one object per bucket per
 * column — at B=16,667 and C=8 it's 133k `Float64Column` instances per
 * `aggregate` call, none of which outlive the reduction.
 *
 * Taking `(start, end)` instead costs nothing and allocates nothing. The
 * arithmetic and the non-finite / validity policy are unchanged, so the
 * outputs are bit-identical — checked before timing.
 */
function sumRange(v, start, end, bits, allFinite) {
  let acc = 0;
  if (bits === undefined && allFinite) {
    for (let i = start; i < end; i += 1) acc += v[i];
    return acc;
  }
  for (let i = start; i < end; i += 1) {
    if (bits !== undefined && (bits[i >> 3] & (1 << (i & 7))) === 0) continue;
    const x = v[i];
    if (!allFinite && !Number.isFinite(x)) continue;
    acc += x;
  }
  return acc;
}

function countRange(v, start, end, bits, allFinite) {
  if (bits === undefined && allFinite) return end - start;
  let n = 0;
  for (let i = start; i < end; i += 1) {
    if (bits !== undefined && (bits[i >> 3] & (1 << (i & 7))) === 0) continue;
    if (!allFinite && !Number.isFinite(v[i])) continue;
    n += 1;
  }
  return n;
}

function avgRange(v, start, end, bits, allFinite) {
  const n = countRange(v, start, end, bits, allFinite);
  if (n === 0) return undefined;
  return sumRange(v, start, end, bits, allFinite) / n;
}

const RANGE_REDUCER = { sum: sumRange, avg: avgRange, count: countRange };

/**
 * Stage 2 in JS: derive bucket bounds off the key axis in one merge walk,
 * then reduce each column over index ranges straight into a
 * `Float64Array` per output column. No per-bucket objects, no rows.
 */
function aggregateJsAlgo(begins, cols, reducers, edges) {
  const n = begins.length;
  const B = edges.length - 1;
  const bounds = new Int32Array(B + 1);
  let i = 0;
  for (let b = 0; b <= B; b += 1) {
    const e = edges[b];
    while (i < n && begins[i] < e) i += 1;
    bounds[b] = i;
  }
  const out = cols.map(() => new Float64Array(B));
  for (let k = 0; k < cols.length; k += 1) {
    const col = cols[k];
    const v = col._values;
    const bits = col.validity?.bits;
    const af = col.allFinite;
    const fn = RANGE_REDUCER[reducers[k]];
    const o = out[k];
    for (let b = 0; b < B; b += 1) {
      const r = fn(v, bounds[b], bounds[b + 1], bits, af);
      o[b] = r === undefined ? NaN : r;
    }
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════ */
/* wasm: resident key + value columns, one call per column            */
/* ══════════════════════════════════════════════════════════════════ */

/**
 * Uploads the key axis and every value column into linear memory once —
 * the resident model, since §4.4 of the report showed bridged mode is a
 * net loss. In a real port these would already live there; the upload is
 * measured separately as `ingest`.
 */
function residentWorkload(series, c) {
  const { exports, mem } = rt;
  const begins = series.keyColumn().begin;
  const n = begins.length;

  const keyPtr = exports.pond_alloc(n * 8);
  mem.sync().f64.set(begins, keyPtr >>> 3);

  const colPtrs = [];
  for (let k = 0; k < c; k += 1) {
    const col = series.column(`v${k}`);
    const p = exports.pond_alloc(n * 8);
    mem.sync().f64.set(col._values.subarray(0, n), p >>> 3);
    colPtrs.push({ ptr: p, allFinite: col.allFinite ? 1 : 0 });
  }
  return { keyPtr, colPtrs, n };
}

function aggregateWasm(resident, edgesPtr, B, boundsPtr, outPtr, reducers) {
  const { exports, mem } = rt;
  const { keyPtr, colPtrs, n } = resident;
  // Half-open on every bucket, including the last — matches
  // `tryAggregateColumnarTimeKeyed`. See the Rust doc on `bounds_from_edges`.
  exports.bounds_from_edges(keyPtr, n, edgesPtr, B, 0, boundsPtr);
  for (let k = 0; k < colPtrs.length; k += 1) {
    exports.reduce_bounds_scalar(
      colPtrs[k].ptr,
      0,
      colPtrs[k].allFinite,
      boundsPtr,
      B,
      RUST_CODE[reducers[k]],
      0,
      outPtr + k * B * 8,
      0,
    );
  }
  const f = mem.sync().f64;
  const base = outPtr >>> 3;
  return colPtrs.map((_, k) => f.subarray(base + k * B, base + (k + 1) * B));
}

/* ══════════════════════════════════════════════════════════════════ */
/* Full end-to-end replacements — same output type, same contents     */
/* ══════════════════════════════════════════════════════════════════ */

/**
 * Materialise reduced columns into the row shape `new TimeSeries` wants.
 *
 * The port has to do this, and it is worth seeing why: `aggregate`'s
 * output is **interval-keyed**, and pond-ts has no columnar door for
 * interval keys (`fromColumns` mints `TimeKeyColumn` / `ValueKeyColumn`
 * only). So even a substrate that computes the answer entirely in linear
 * memory has to hand it back as rows and let `TimeSeries` re-columnarise
 * them. The row round-trip is structural, not incidental.
 *
 * The `NaN → undefined` mapping is not cosmetic either: the reduced
 * columns use `NaN` for an empty bucket (the `Float64Array` convention),
 * while row intake wants `undefined`. That is the same sentinel
 * asymmetry [PND-WCNAN] tracks, met from the other direction.
 */
function rowsFromColumns(buckets, outCols) {
  const B = buckets.length;
  const c = outCols.length;
  const rows = new Array(B);
  for (let b = 0; b < B; b += 1) {
    const row = new Array(c + 1);
    row[0] = buckets[b];
    for (let k = 0; k < c; k += 1) {
      const v = outCols[k][b];
      row[k + 1] = Number.isNaN(v) ? undefined : v;
    }
    rows[b] = Object.freeze(row);
  }
  return rows;
}

function outputSchema(mapping) {
  return Object.freeze([
    { name: 'interval', kind: 'interval' },
    ...Object.keys(mapping).map((name) => ({
      name,
      kind: 'number',
      required: false,
    })),
  ]);
}

/* ══════════════════════════════════════════════════════════════════ */
/* Run                                                                */
/* ══════════════════════════════════════════════════════════════════ */

console.log('═'.repeat(98));
console.log('What if aggregation happened in Rust?');
console.log('═'.repeat(98));
console.log(
  `node ${process.version} · ${process.platform}/${process.arch} · ` +
    `${rt.simd ? 'simd128' : 'baseline'} build · 1 s sample grid · n = 1M`,
);
console.log();

/**
 * The axis that decides the answer is **events per bucket**, not row
 * count. A bucket costs a fixed amount (in pond-ts's fast path, one
 * `Float64Column` allocation per column plus a frozen row array) and a
 * variable amount (the scan). Wide buckets amortise the fixed cost into
 * nothing and the operation becomes the leaf-kernel scan that already
 * measured 1.00×; narrow buckets are dominated by per-bucket overhead,
 * which is exactly what a port removes.
 *
 * So sweep bucket width at fixed N, rather than sweeping N — which moves
 * both terms at once and hides the mechanism.
 */
const SHAPES = QUICK
  ? [{ n: 200_000, bucketMs: 60_000 }]
  : [
      { n: 1_000_000, bucketMs: 10_000 }, //        10 events/bucket
      { n: 1_000_000, bucketMs: 60_000 }, //        60 events/bucket — typical metrics
      { n: 1_000_000, bucketMs: 600_000 }, //      600 events/bucket
      { n: 1_000_000, bucketMs: 3_600_000 }, //   3600 events/bucket — hourly rollup
      { n: 1_000_000, bucketMs: 86_400_000 }, // 86400 events/bucket — daily rollup
    ];
const COLUMN_COUNTS = QUICK ? [2] : [1, 4];

const rows = [];
const mismatches = [];

for (const shape of SHAPES) {
  for (const c of COLUMN_COUNTS) {
    const { n, bucketMs } = shape;
    const { series, range, sequence } = makeWorkload(n, c, bucketMs);
    const mapping = mappingFor(c);
    const schemaOut = outputSchema(mapping);
    const reducers = Array.from(
      { length: c },
      (_, i) => REDUCERS[i % REDUCERS.length],
    );
    const specs = Object.entries(mapping).map(([out, red]) => ({
      output: out,
      source: out,
      reducer: red,
      kind: 'number',
    }));

    const begins = series.keyColumn().begin;
    const cols = Array.from({ length: c }, (_, k) => series.column(`v${k}`));
    const buckets = sequence.bounded(range, { sample: 'begin' }).intervals();
    const B = buckets.length;
    const edges = new Float64Array(B + 1);
    for (let b = 0; b < B; b += 1) edges[b] = buckets[b].begin();
    edges[B] = buckets[B - 1].end();

    const resident = residentWorkload(series, c);
    const { exports, mem } = rt;
    const edgesPtr = exports.pond_alloc((B + 1) * 8);
    mem.sync().f64.set(edges, edgesPtr >>> 3);
    const boundsPtr = exports.pond_alloc((B + 1) * 4);
    const outPtr = exports.pond_alloc(c * B * 8);

    /* ── the three end-to-end implementations ───────────────────── */
    const runPond = () => series.aggregate(sequence, mapping, { range });
    const runJs = () => {
      const bk = sequence.bounded(range, { sample: 'begin' }).intervals();
      const e = new Float64Array(bk.length + 1);
      for (let b = 0; b < bk.length; b += 1) e[b] = bk[b].begin();
      e[bk.length] = bk[bk.length - 1].end();
      const out = aggregateJsAlgo(begins, cols, reducers, e);
      return new TimeSeries({
        name: series.name,
        schema: schemaOut,
        rows: rowsFromColumns(bk, out),
      });
    };
    const runWasm = () => {
      const bk = sequence.bounded(range, { sample: 'begin' }).intervals();
      const out = aggregateWasm(
        resident,
        edgesPtr,
        bk.length,
        boundsPtr,
        outPtr,
        reducers,
      );
      return new TimeSeries({
        name: series.name,
        schema: schemaOut,
        rows: rowsFromColumns(bk, out),
      });
    };

    /* ── correctness gate: identical output series ──────────────── */
    {
      const a = runPond();
      const b = runJs();
      const d = runWasm();
      if (a.length !== b.length || a.length !== d.length) {
        mismatches.push(`n=${n} c=${c} bucket=${bucketMs}: length mismatch`);
      } else {
        for (let i = 0; i < a.length && mismatches.length < 8; i += 1) {
          for (let k = 0; k < c; k += 1) {
            const pv = a.column(`v${k}`).at(i);
            for (const [label, s] of [
              ['js-algo', b],
              ['wasm', d],
            ]) {
              const gv = s.column(`v${k}`).at(i);
              const same =
                Object.is(pv, gv) ||
                (Number.isNaN(pv) && Number.isNaN(gv)) ||
                (pv === undefined && gv === undefined);
              if (!same) {
                mismatches.push(
                  `n=${n} c=${c} bucket=${bucketMs} ${label} row ${i} v${k}: ${gv} vs pond ${pv}`,
                );
                break;
              }
            }
          }
        }
      }
    }

    /* ── directly measured, no subtraction anywhere ─────────────── */
    const tPond = bench(() => runPond().length, { budgetMs }).medianMs;
    const tJs = bench(() => runJs().length, { budgetMs }).medianMs;
    const tWasm = bench(() => runWasm().length, { budgetMs }).medianMs;

    // Stage 2 in isolation — the only stage a port replaces.
    const kPond = bench(
      () =>
        tryAggregateColumnarTimeKeyed(
          begins,
          (name) => series.column(name),
          buckets,
          specs,
        ).length,
      { budgetMs },
    ).medianMs;
    const kJs = bench(() => aggregateJsAlgo(begins, cols, reducers, edges), {
      budgetMs,
    }).medianMs;
    const kWasm = bench(
      () => aggregateWasm(resident, edgesPtr, B, boundsPtr, outPtr, reducers),
      { budgetMs },
    ).medianMs;

    // Fixed costs neither implementation avoids.
    const tDerive = bench(
      () => sequence.bounded(range, { sample: 'begin' }).intervals().length,
      { budgetMs },
    ).medianMs;
    const tIngest = bench(
      () => {
        const f = rt.mem.sync().f64;
        f.set(begins, resident.keyPtr >>> 3);
        for (let k = 0; k < c; k += 1) {
          f.set(cols[k]._values.subarray(0, n), resident.colPtrs[k].ptr >>> 3);
        }
        return c;
      },
      { budgetMs },
    ).medianMs;

    // Rows → TimeSeries, given the answer already computed. This is the
    // cost that survives *every* implementation, because `aggregate`'s
    // output is interval-keyed and pond-ts has no columnar door for
    // interval keys. Measuring it directly says what an interval-keyed
    // `fromColumns` would be worth — a JS change, not a Rust one.
    const precomputed = aggregateJsAlgo(begins, cols, reducers, edges);
    const tMaterialize = bench(
      () =>
        new TimeSeries({
          name: series.name,
          schema: schemaOut,
          rows: rowsFromColumns(buckets, precomputed),
        }).length,
      { budgetMs },
    ).medianMs;

    rows.push({
      n,
      c,
      bucketMs,
      B,
      perBucket: Math.round(n / B),
      tPond,
      tJs,
      tWasm,
      kPond,
      kJs,
      kWasm,
      tDerive,
      tIngest,
      tMaterialize,
      kernelShare: kPond / tPond,
      kernelAlgoX: kPond / kJs,
      kernelLangX: kJs / kWasm,
      kernelTotalX: kPond / kWasm,
      e2eJsX: tPond / tJs,
      e2eWasmX: tPond / tWasm,
      wasmOverJsX: tJs / tWasm,
      ingestAdjustedX: tPond / (tWasm + tIngest),
    });

    exports.pond_free(edgesPtr, (B + 1) * 8);
    exports.pond_free(boundsPtr, (B + 1) * 4);
    exports.pond_free(outPtr, c * B * 8);
    exports.pond_free(resident.keyPtr, n * 8);
    for (const p of resident.colPtrs) exports.pond_free(p.ptr, n * 8);
  }
}

if (mismatches.length) {
  console.error('✗ replacements disagree with pond-ts:');
  for (const m of mismatches) console.error(`    ${m}`);
  process.exit(1);
}
console.log(
  '✓ js-algo and wasm each produce a TimeSeries identical to pond-ts\n',
);

const pad = (x, w) => String(x).padStart(w);

console.log(
  '── the kernel: stage 2 in isolation (what a port actually replaces) ──────────────',
);
console.log(
  `  ${pad('ev/bkt', 7)} ${pad('C', 2)} ${pad('buckets', 8)}  ${pad('pond-ts', 9)}  ` +
    `${pad('js-algo', 9)}  ${pad('wasm', 9)}  ${pad('algo×', 6)} ${pad('lang×', 6)} ${pad('total×', 7)}`,
);
console.log(`  ${'─'.repeat(96)}`);
for (const r of rows) {
  console.log(
    `  ${pad(r.perBucket, 7)} ${pad(r.c, 2)} ${pad(r.B.toLocaleString(), 8)}  ` +
      `${pad(r.kPond.toFixed(2), 7)}ms  ${pad(r.kJs.toFixed(2), 7)}ms  ${pad(r.kWasm.toFixed(2), 7)}ms  ` +
      `${pad(r.kernelAlgoX.toFixed(2) + '×', 6)} ${pad(r.kernelLangX.toFixed(2) + '×', 6)} ` +
      `${pad(r.kernelTotalX.toFixed(2) + '×', 7)}`,
  );
}
console.log();

console.log(
  '── end to end: a whole `aggregate` call, producing the same TimeSeries ───────────',
);
console.log(
  `  ${pad('ev/bkt', 7)} ${pad('C', 2)}  ${pad('pond-ts', 9)}  ${pad('js-algo', 9)}  ` +
    `${pad('wasm', 9)}  ${pad('js×', 6)} ${pad('wasm×', 6)}  ${pad('kernel share', 12)}`,
);
console.log(`  ${'─'.repeat(96)}`);
for (const r of rows) {
  console.log(
    `  ${pad(r.perBucket, 7)} ${pad(r.c, 2)}  ${pad(r.tPond.toFixed(2), 7)}ms  ` +
      `${pad(r.tJs.toFixed(2), 7)}ms  ${pad(r.tWasm.toFixed(2), 7)}ms  ` +
      `${pad(r.e2eJsX.toFixed(2) + '×', 6)} ${pad(r.e2eWasmX.toFixed(2) + '×', 6)}  ` +
      `${pad((r.kernelShare * 100).toFixed(0) + '%', 12)}`,
  );
}
console.log();

console.log(
  '── what the port adds over the JS rewrite, and what it costs ─────────────────────',
);
console.log(
  `  ${pad('ev/bkt', 7)} ${pad('C', 2)}  ${pad('wasm vs js-algo', 15)}  ` +
    `${pad('derive', 8)}  ${pad('rows→series', 12)}  ${pad('ingest', 8)}  ${pad('wasm× w/ ingest', 15)}`,
);
console.log(`  ${'─'.repeat(96)}`);
for (const r of rows) {
  console.log(
    `  ${pad(r.perBucket, 7)} ${pad(r.c, 2)}  ${pad(r.wasmOverJsX.toFixed(2) + '×', 15)}  ` +
      `${pad(r.tDerive.toFixed(2) + 'ms', 8)}  ${pad(r.tMaterialize.toFixed(2) + 'ms', 12)}  ` +
      `${pad(r.tIngest.toFixed(2) + 'ms', 8)}  ${pad(r.ingestAdjustedX.toFixed(2) + '×', 15)}`,
  );
}
console.log();
console.log(
  '  derive      = `Sequence.bounded().intervals()` — B `Interval` objects. Paid by\n' +
    '                every implementation; a port cannot remove it without also owning\n' +
    '                the interval key column.\n' +
    '  rows→series = materialising the already-computed answer as rows and letting\n' +
    '                `new TimeSeries` re-columnarise them. Also paid by every\n' +
    '                implementation, because `aggregate` output is interval-keyed and\n' +
    '                pond-ts has no columnar door for interval keys. This is the\n' +
    '                remaining bottleneck once the kernel is fast — and removing it is\n' +
    '                a TypeScript change, not a Rust one.\n' +
    '  ingest      = putting key + value columns into linear memory. Zero only if the\n' +
    '                substrate owns storage end to end; the last column charges it per\n' +
    '                call, i.e. the drop-in-accelerator case.',
);
console.log();

if (JSON_OUT) {
  writeFileSync(
    resolve(process.cwd(), JSON_OUT),
    JSON.stringify(rows, null, 2),
  );
  console.log(`raw results → ${JSON_OUT}`);
}
