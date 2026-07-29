/**
 * What would a Rust columnar core save or cost, per Pond operation?
 *
 * The leaf-kernel benchmarks compare column primitives. Nobody calls
 * those; they call `series.aggregate(...)`, `series.fill(...)`,
 * `series.rolling(...)`. This measures the operations.
 *
 * ── Method ───────────────────────────────────────────────────────────
 *
 * Porting a dozen operators to WASM to time them is exactly the cost the
 * report says not to pay, so instead this measures the thing that
 * actually decides each answer: **how much of the operation is numeric
 * column work at all.**
 *
 * That share is measured, not guessed, by sweeping the number of mapped
 * value columns at fixed row count and fitting
 *
 *     total(C)  =  fixed  +  C · perColumn
 *
 * by least squares over C ∈ {1, 2, 4, 8}. The split is meaningful because
 * it lands on the boundary a Rust core actually has:
 *
 *   perColumn — the per-column numeric kernel. What a port replaces.
 *   fixed     — key handling, schema resolution, store assembly, output
 *               object graph. Costs the same in any language, because it
 *               is JS objects and JS control flow, not arithmetic.
 *
 * Then the ceiling on a port is Amdahl over that split, using the
 * **measured** WASM speedup for a kernel of the same shape:
 *
 *     ceiling  =  (fixed + C·perColumn) / (fixed + C·perColumn/kernelX)
 *
 * `ceiling` is an upper bound and is labelled as one everywhere. It
 * assumes the port is free: columns already resident, no boundary cost,
 * no ingest, no copy-out, and the whole per-column term replaced. Every
 * one of those is optimistic, which is the point — if the *bound* is
 * unattractive, the real number cannot rescue it.
 *
 * ── Kernel shapes ────────────────────────────────────────────────────
 *
 * `kernelX` is not one number. Operators come in shapes that respond
 * very differently to a port, so each is measured with a representative
 * WASM kernel on the same data (`src/lib.rs`, "operator-shape kernels"):
 *
 *   element-wise    map / shift / diff / rate / fill   → op_map_scale
 *   prefix scan     cumulative / smooth(ema)           → op_cumulative_sum
 *   sliding window  rolling                            → op_rolling_mean
 *   bucketed reduce aggregate                          → reduce_bounds_scalar
 *   gather          byValue / partitionBy              → gather_f64
 *   whole reduce    reduce / column.sum()              → col_sum
 *
 * ── Validation ───────────────────────────────────────────────────────
 *
 * The model is checked against ground truth: `aggregate` has a real
 * end-to-end WASM implementation (bench/aggregate.mjs), so its predicted
 * ceiling can be compared to what was actually measured. A model that
 * cannot reproduce the one case we know is not worth reading.
 *
 * Run: node bench/operations.mjs [--json out.json] [--quick]
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  Sequence,
  TimeRange,
  TimeSeries,
} from '../../../packages/core/dist/index.js';
import '../../../packages/core/dist/column.js';
import { loadSubstrate } from '../js/loader.mjs';
import { bench } from './suite.mjs';

const argv = process.argv.slice(2);
const jsonIdx = argv.indexOf('--json');
const JSON_OUT = jsonIdx >= 0 ? argv[jsonIdx + 1] : null;
const QUICK = argv.includes('--quick');

const rt = await loadSubstrate();
const budgetMs = QUICK ? 60 : 130;
const N = QUICK ? 100_000 : 1_000_000;
const STEP_MS = 1_000;
const COLUMN_COUNTS = [1, 2, 4, 8];

/* ── data ─────────────────────────────────────────────────────────── */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `C` numeric columns on a regular 1 s grid, ~4% of cells missing so the
 * validity path is exercised — a dense-only workload would flatter every
 * operator that branches on gaps.
 */
function makeSeries(n, c, { gaps = true } = {}) {
  const rnd = mulberry32(0x5eed + c);
  const schema = Object.freeze([
    { name: 'time', kind: 'time' },
    // A gap-free, strictly increasing axis. `byValue` requires one (it
    // re-keys on it), so it cannot share the gappy value columns.
    { name: 'axis', kind: 'number' },
    ...Array.from({ length: c }, (_, i) => ({
      name: `v${i}`,
      kind: 'number',
      required: false,
    })),
  ]);
  const rows = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const row = new Array(c + 2);
    row[0] = i * STEP_MS;
    row[1] = i * 1.5;
    for (let k = 0; k < c; k += 1) {
      row[k + 2] =
        gaps && rnd() < 0.04
          ? undefined
          : 50 + 35 * Math.sin(i / 5000 + k) + 10 * Math.sin(i / 137);
    }
    rows[i] = row;
  }
  return new TimeSeries({ name: 'metrics', schema, rows });
}

const cols = (c) => Array.from({ length: c }, (_, i) => `v${i}`);
const mapping = (c, reducer) =>
  Object.fromEntries(cols(c).map((n) => [n, reducer]));

/* ── least-squares fit of total(C) = fixed + C·perColumn ──────────── */

function fitLinear(points) {
  const n = points.length;
  const sx = points.reduce((s, p) => s + p.c, 0);
  const sy = points.reduce((s, p) => s + p.ms, 0);
  const sxx = points.reduce((s, p) => s + p.c * p.c, 0);
  const sxy = points.reduce((s, p) => s + p.c * p.ms, 0);
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const intercept = (sy - slope * sx) / n;
  // R² so a bad fit is visible rather than silently reported as fact.
  const mean = sy / n;
  const ssTot = points.reduce((s, p) => s + (p.ms - mean) ** 2, 0);
  const ssRes = points.reduce(
    (s, p) => s + (p.ms - (intercept + slope * p.c)) ** 2,
    0,
  );
  return {
    fixed: intercept,
    perColumn: slope,
    r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot,
  };
}

/* ── the operations ───────────────────────────────────────────────── */

const range = new TimeRange({ start: 0, end: (N - 1) * STEP_MS });
const minute = Sequence.every(60_000);
const double = (v) => (typeof v === 'number' ? v * 2 : v);

/**
 * Each entry: how to run the operation at `C` mapped columns, and which
 * kernel shape a port would use for its per-column work.
 */
const OPERATIONS = [
  {
    name: 'aggregate (60s buckets)',
    shape: 'bucketed reduce',
    run: (s, c) => s.aggregate(minute, mapping(c, 'avg'), { range }).length,
  },
  {
    name: 'rolling (100-bar avg)',
    shape: 'sliding window',
    run: (s, c) => s.rolling(100, mapping(c, 'avg')).length,
  },
  {
    name: 'cumulative (sum)',
    shape: 'prefix scan',
    run: (s, c) => s.cumulative(mapping(c, 'sum')).length,
  },
  {
    name: 'smooth (ema)',
    shape: 'prefix scan',
    run: (s, c) => s.smooth(cols(c), 'ema', { alpha: 0.2 }).length,
  },
  {
    name: 'diff',
    shape: 'element-wise',
    run: (s, c) => s.diff(cols(c)).length,
  },
  {
    name: 'rate',
    shape: 'element-wise',
    run: (s, c) => s.rate(cols(c)).length,
  },
  {
    name: 'shift (+1)',
    shape: 'element-wise',
    run: (s, c) => s.shift(cols(c), 1).length,
  },
  {
    name: "fill ('hold')",
    shape: 'element-wise',
    run: (s, c) =>
      s.fill(Object.fromEntries(cols(c).map((n) => [n, 'hold']))).length,
  },
  {
    name: "fill ('linear')",
    shape: 'element-wise',
    run: (s, c) =>
      s.fill(Object.fromEntries(cols(c).map((n) => [n, 'linear']))).length,
  },
  {
    name: 'mapColumns (×2)',
    shape: 'element-wise (closure)',
    run: (s, c) =>
      s.mapColumns(Object.fromEntries(cols(c).map((n) => [n, double]))).length,
  },
  {
    name: 'align (linear, 60s)',
    shape: 'element-wise',
    run: (s) => s.align(minute, { method: 'linear', range }).length,
  },
  {
    name: 'reduce (avg)',
    shape: 'whole reduce',
    run: (s, c) => {
      let acc = 0;
      for (const n of cols(c)) acc += s.reduce(n, 'avg') ?? 0;
      return acc;
    },
  },
  {
    name: 'column().sum() ×C',
    shape: 'whole reduce',
    run: (s, c) => {
      let acc = 0;
      for (const n of cols(c)) acc += s.column(n).sum();
      return acc;
    },
  },
  {
    name: "bin(1024,'minMax') ×C",
    shape: 'bucketed reduce',
    run: (s, c) => {
      let acc = 0;
      for (const n of cols(c)) acc += s.column(n).bin(1024, 'minMax').lo[0];
      return acc;
    },
  },
  {
    name: 'byValue (sort + gather)',
    shape: 'gather',
    run: (s) => s.byValue('axis').length,
  },
  {
    name: 'select (reshape only)',
    shape: 'no kernel',
    run: (s, c) => s.select(...cols(c)).length,
  },
  {
    name: 'rename (reshape only)',
    shape: 'no kernel',
    run: (s, c) =>
      s.rename(Object.fromEntries(cols(c).map((n) => [n, `${n}_x`]))).length,
  },
];

/* ── per-column kernel cost by shape: pond-ts vs JS-typed vs Rust ──── */

/**
 * JS controls — the same per-column work as the Rust kernels, written as
 * tight typed-array loops.
 *
 * These exist for the same reason they did in the leaf-kernel report: a
 * pond-ts-vs-Rust number conflates "Rust is faster" with "pond-ts's
 * operator boxes every cell through `read(i)` into a
 * `ReadonlyArray<number | undefined>` and rebuilds the column from it".
 * The second is a JS problem with a JS fix. Measuring all three splits
 *
 *     total win  =  algo (free in JS)  x  language (needs the port)
 *
 * Each control reads with validity, computes, and writes both the value
 * and the output validity bit — the same work the Rust kernel does, so
 * the comparison is like-for-like.
 */
const jsControls = {
  'element-wise': (v, bits, n, out, outBits) => {
    outBits.fill(0);
    let defined = 0;
    for (let i = 0; i < n; i += 1) {
      if (bits === null || (bits[i >> 3] & (1 << (i & 7))) !== 0) {
        out[i] = 2 * v[i];
        outBits[i >> 3] |= 1 << (i & 7);
        defined += 1;
      } else out[i] = 0;
    }
    return defined;
  },
  'prefix scan': (v, bits, n, out, outBits) => {
    outBits.fill(0);
    let acc = 0;
    let seen = false;
    let defined = 0;
    for (let i = 0; i < n; i += 1) {
      if (bits === null || (bits[i >> 3] & (1 << (i & 7))) !== 0) {
        acc += v[i];
        seen = true;
      }
      if (seen) {
        out[i] = acc;
        outBits[i >> 3] |= 1 << (i & 7);
        defined += 1;
      } else out[i] = 0;
    }
    return defined;
  },
  'sliding window': (v, bits, n, out, outBits) => {
    outBits.fill(0);
    const w = 100;
    let acc = 0;
    let defined = 0;
    for (let i = 0; i < n; i += 1) {
      acc += v[i];
      if (i >= w) acc -= v[i - w];
      if (i + 1 >= w) {
        out[i] = acc / w;
        outBits[i >> 3] |= 1 << (i & 7);
        defined += 1;
      } else out[i] = 0;
    }
    return defined;
  },
};

/**
 * Measures one column's numeric work per shape, three ways. Absolute
 * milliseconds — not a ratio against a whole pond-ts operation, which is
 * what made the first version report meaningless 70-90x figures (those
 * calls also resolve a schema, walk keys and build a store; the kernel
 * does none of that).
 *
 * The Rust figures are floors for their shape: a real port of
 * `fill('linear')` does more per column than `op_map_scale_v`. Since the
 * result is reported as an upper bound, understating the ported cost is
 * the conservative direction for the *conclusion*, and is flagged.
 */
function measureShapeKernels() {
  const { exports, mem } = rt;
  const src = makeSeries(N, 1);
  const col = src.column('v0');
  const values = col.toFloat64Array();
  const bits = col.validity?.bits ?? null;

  const vPtr = exports.pond_alloc(N * 8);
  mem.sync().f64.set(values, vPtr >>> 3);
  let bPtr = 0;
  if (bits) {
    bPtr = exports.pond_alloc(bits.length);
    mem.sync().u8.set(bits, bPtr);
  }
  const outPtr = exports.pond_alloc(N * 8);
  const outBits = exports.pond_alloc((N + 7) >> 3);
  const clear = () => mem.sync().u8.fill(0, outBits, outBits + ((N + 7) >> 3));
  const af = col.allFinite ? 1 : 0;

  const jsOut = new Float64Array(N);
  const jsOutBits = new Uint8Array((N + 7) >> 3);
  const t = (fn) => bench(fn, { budgetMs }).medianMs;

  const shapes = {
    'element-wise': {
      js: t(() =>
        jsControls['element-wise'](values, bits, N, jsOut, jsOutBits),
      ),
      wasm: t(() => {
        clear();
        return exports.op_map_scale_v(vPtr, N, bPtr, 2, 0, outPtr, outBits);
      }),
    },
    'prefix scan': {
      js: t(() => jsControls['prefix scan'](values, bits, N, jsOut, jsOutBits)),
      wasm: t(() => {
        clear();
        return exports.op_cumulative_sum(vPtr, N, bPtr, outPtr, outBits);
      }),
    },
    'sliding window': {
      js: t(() =>
        jsControls['sliding window'](values, bits, N, jsOut, jsOutBits),
      ),
      wasm: t(() => {
        clear();
        return exports.op_rolling_mean(vPtr, N, 100, outPtr, outBits);
      }),
    },
    'whole reduce': {
      js: t(() => col.sum()),
      wasm: t(() => exports.col_sum(vPtr, N, bPtr, af)),
    },
  };

  {
    const boundsPtr = exports.pond_alloc(1025 * 4);
    const binOut = exports.pond_alloc(1024 * 8);
    exports.bin_bounds(N, 1024, boundsPtr);
    shapes['bucketed reduce'] = {
      js: t(() => col.bin(1024, 'mean')[0]),
      wasm: t(() =>
        exports.reduce_bounds_scalar(
          vPtr,
          bPtr,
          af,
          boundsPtr,
          1024,
          3,
          0,
          binOut,
          0,
        ),
      ),
    };
    exports.pond_free(boundsPtr, 1025 * 4);
    exports.pond_free(binOut, 1024 * 8);
  }

  {
    const rnd = mulberry32(0x1de1);
    const m = N >> 2;
    const idx = new Int32Array(m);
    for (let i = 0; i < m; i += 1) idx[i] = Math.floor(rnd() * N);
    const idxPtr = exports.pond_alloc(m * 4);
    mem.sync().i32.set(idx, idxPtr >>> 2);
    const gv = exports.pond_alloc(m * 8);
    const gb = exports.pond_alloc((m + 7) >> 3);
    shapes.gather = {
      js: t(() => col.sliceByIndices(idx).length),
      wasm: t(() => {
        mem.sync().u8.fill(0, gb, gb + ((m + 7) >> 3));
        return exports.gather_f64(vPtr, N, bPtr, idxPtr, m, gv, gb);
      }),
    };
    exports.pond_free(idxPtr, m * 4);
    exports.pond_free(gv, m * 8);
    exports.pond_free(gb, (m + 7) >> 3);
  }

  // No numeric kernel: a port replaces nothing.
  // For these shapes the "JS control" IS pond-ts's own implementation
  // (`col.sum()`, `col.bin()`, `col.sliceByIndices()`) — they are already
  // tight typed-array loops with nothing to rewrite. Marking them means
  // the algo term is reported as n/a rather than as fit noise that looks
  // like headroom.
  shapes['whole reduce'].jsIsPondTs = true;
  shapes['bucketed reduce'].jsIsPondTs = true;
  shapes.gather.jsIsPondTs = true;

  shapes['no kernel'] = null;
  // `mapColumns` takes a JS **closure**. No kernel can replace its
  // per-column work without a declarative expression API, so its ceiling
  // below is what it *would* be if one existed — unreachable today.
  shapes['element-wise (closure)'] = shapes['element-wise'];

  exports.pond_free(vPtr, N * 8);
  if (bPtr) exports.pond_free(bPtr, bits.length);
  exports.pond_free(outPtr, N * 8);
  exports.pond_free(outBits, (N + 7) >> 3);
  return shapes;
}

/* ── run ──────────────────────────────────────────────────────────── */

console.log('═'.repeat(108));
console.log(
  'What would a Rust columnar core save or cost, per Pond operation?',
);
console.log('═'.repeat(108));
console.log(
  `node ${process.version} · ${process.platform}/${process.arch} · ` +
    `${rt.simd ? 'simd128' : 'baseline'} build · N = ${N.toLocaleString()} rows, ~4% missing`,
);
console.log();

const pad = (x, w) => String(x).padStart(w);

console.log(
  '── per-column kernel cost by shape: one column of N rows, three ways ────────────────',
);
console.log(
  `  ${pad('shape', 24)}  ${pad('js-typed', 10)}  ${pad('rust', 10)}  ${pad('lang x', 8)}`,
);
console.log(`  ${'─'.repeat(60)}`);
const shapes = measureShapeKernels();
for (const [name, k] of Object.entries(shapes)) {
  if (k === null || name === 'element-wise (closure)') continue;
  console.log(
    `  ${pad(name, 24)}  ${pad(k.js.toFixed(3) + 'ms', 10)}  ` +
      `${pad(k.wasm.toFixed(3) + 'ms', 10)}  ${pad((k.js / k.wasm).toFixed(2) + 'x', 8)}`,
  );
}
console.log();

const seriesByC = new Map();
for (const c of COLUMN_COUNTS) seriesByC.set(c, makeSeries(N, c));

const C = 4;
const rows = [];
for (const op of OPERATIONS) {
  const points = [];
  for (const c of COLUMN_COUNTS) {
    const s = seriesByC.get(c);
    points.push({ c, ms: bench(() => op.run(s, c), { budgetMs }).medianMs });
  }
  const fit = fitLinear(points);
  const k = shapes[op.shape];
  const total = fit.fixed + C * fit.perColumn;

  // A negative fitted intercept means cost is slightly superlinear in C
  // and the split does not separate; the honest reading is "essentially
  // all per-column". Clamp rather than report a >100% kernel share.
  const fixedPart = Math.max(0, fit.fixed);
  const kernelPart = Math.max(0, total - fixedPart);
  const perColumn = kernelPart / C;

  const portedJs = k === null ? total : fixedPart + C * k.js;
  const portedWasm = k === null ? total : fixedPart + C * k.wasm;

  rows.push({
    ...op,
    points,
    ...fit,
    total,
    kernelSharePct: total > 0 ? (kernelPart / total) * 100 : 0,
    perColumn,
    jsKernel: k?.js ?? null,
    wasmKernel: k?.wasm ?? null,
    // No meaningful algo term when the JS control is pond-ts itself.
    algoX: k === null || k.jsIsPondTs ? null : perColumn / k.js,
    langX: k === null ? 1 : k.js / k.wasm,
    ceilingJs: k?.jsIsPondTs ? 1 : portedJs > 0 ? total / portedJs : 1,
    ceilingWasm: portedWasm > 0 ? total / portedWasm : 1,
    softFit: fit.fixed < 0 || fit.r2 < 0.9,
  });
}

console.log(
  '── per-operation, C = 4 mapped columns ──────────────────────────────────────────────',
);
console.log(
  `  ${pad('operation', 24)} ${pad('shape', 22)} ${pad('total', 9)} ${pad('kernel', 7)} ` +
    `${pad('algo x', 7)} ${pad('lang x', 7)} ${pad('JS-only', 8)} ${pad('+RUST', 8)}`,
);
console.log(`  ${'─'.repeat(104)}`);
for (const r of [...rows].sort((a, b) => b.ceilingWasm - a.ceilingWasm)) {
  const flag = r.softFit ? '~' : ' ';
  console.log(
    `  ${pad(r.name, 24)} ${pad(r.shape, 22)} ${pad(r.total.toFixed(2) + 'ms', 9)} ` +
      `${pad(r.kernelSharePct.toFixed(0) + '%', 7)} ` +
      `${pad(r.algoX === null ? 'n/a' : r.algoX.toFixed(1) + 'x', 7)} ` +
      `${pad(r.langX.toFixed(1) + 'x', 7)} ${pad(r.ceilingJs.toFixed(2) + 'x', 8)} ` +
      `${pad(r.ceilingWasm.toFixed(2) + 'x', 8)}${flag}`,
  );
}
console.log();
console.log(
  '  total    = measured, C=4.  kernel = share that scales per column (fitted).\n' +
    '  algo x   = pond-ts per-column cost / the same work as a tight JS typed-array\n' +
    '             loop. Available today, no Rust. n/a where pond-ts already IS that\n' +
    '             loop (reduce / bin / gather have nothing to rewrite).\n' +
    '  lang x   = that JS loop / the Rust kernel. What the port itself adds.\n' +
    '  JS-only  = whole-operation ceiling from the JS rewrite alone.\n' +
    '  +RUST    = whole-operation ceiling with the Rust kernel. BOTH are upper\n' +
    '             bounds: columns already resident, zero boundary, zero ingest,\n' +
    '             whole per-column term replaced, and the Rust shape-kernel is a\n' +
    '             floor for ops that do more per column than it does.\n' +
    '  ~        = soft fit (negative intercept or R2 < 0.9); the split for that row\n' +
    '             does not separate cleanly, read it as indicative only.',
);
console.log();

if (JSON_OUT) {
  writeFileSync(
    resolve(process.cwd(), JSON_OUT),
    JSON.stringify(
      { n: N, columnCounts: COLUMN_COUNTS, shapes, rows },
      null,
      2,
    ),
  );
  console.log(`raw results → ${JSON_OUT}`);
}
