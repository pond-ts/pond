/**
 * Node driver for the columnar WASM benchmark.
 *
 *   node bench/node.mjs                  # full sweep, human-readable
 *   node bench/node.mjs --json out.json  # also write raw results
 *   node bench/node.mjs --quick          # smaller sizes, shorter budget
 *
 * Refuses to run if the parity harness hasn't passed — a performance
 * number from an implementation that gives different answers is worse
 * than no number, because it looks like evidence.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync, brotliCompressSync, constants as zc } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  Float64Column,
  validityFromBits,
} from '../../../packages/core/dist/columnar/index.js';
import '../../../packages/core/dist/column.js'; // side-effect: mounts bin/minMax/…
import { loadSubstrate, hasSimd, instantiateAgain } from '../js/loader.mjs';
import { WasmFloat64Column, makeBridge } from '../js/wasm-column.mjs';
import {
  bench,
  runKernelSweep,
  runBoundarySweep,
  makeValues,
  timerResolutionMs,
} from './suite.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const argv = process.argv.slice(2);
const QUICK = argv.includes('--quick');
const jsonIdx = argv.indexOf('--json');
const JSON_OUT = jsonIdx >= 0 ? argv[jsonIdx + 1] : null;

/* ── gate on parity ───────────────────────────────────────────────── */
process.stdout.write('verifying parity against pond-ts… ');
try {
  execFileSync(process.execPath, [resolve(ROOT, 'test/parity.mjs')], {
    stdio: 'pipe',
  });
  console.log('ok\n');
} catch (e) {
  console.error('FAILED\n');
  console.error(e.stdout?.toString() ?? '', e.stderr?.toString() ?? '');
  console.error(
    'Refusing to benchmark an implementation that disagrees with pond-ts.',
  );
  process.exit(1);
}

/* ── environment ──────────────────────────────────────────────────── */

console.log('═'.repeat(78));
console.log('pond-ts columnar substrate — Rust/WASM spike');
console.log('═'.repeat(78));
console.log(`node        ${process.version}  (v8 ${process.versions.v8})`);
console.log(`platform    ${process.platform}/${process.arch}`);
console.log(`simd128     ${hasSimd() ? 'available' : 'NOT available'}`);
console.log(`timer res   ${(timerResolutionMs() * 1000).toFixed(3)} µs`);
console.log();

/* ── artifact size + startup ──────────────────────────────────────── */

console.log(
  '── artifact size ───────────────────────────────────────────────────────',
);
const artifacts = [
  ['baseline (wasm MVP)', 'pkg/pond_columnar.wasm'],
  ['simd128', 'pkg/pond_columnar.simd.wasm'],
  ['baseline, opt-level=z', 'pkg/pond_columnar.small.wasm'],
];
const sizeRows = [];
for (const [label, rel] of artifacts) {
  const buf = readFileSync(resolve(ROOT, rel));
  const gz = gzipSync(buf, { level: 9 }).length;
  const br = brotliCompressSync(buf, {
    params: { [zc.BROTLI_PARAM_QUALITY]: 11 },
  }).length;
  sizeRows.push({ label, raw: buf.length, gzip: gz, brotli: br });
  console.log(
    `  ${label.padEnd(24)} ${String(buf.length).padStart(7)} B raw   ` +
      `${String(gz).padStart(6)} B gzip   ${String(br).padStart(6)} B brotli`,
  );
}
console.log();

const rtProbe = await loadSubstrate();
console.log(
  '── startup ─────────────────────────────────────────────────────────────',
);
const bytes = readFileSync(
  resolve(
    ROOT,
    rtProbe.simd ? 'pkg/pond_columnar.simd.wasm' : 'pkg/pond_columnar.wasm',
  ),
);
const compile = bench(() => WebAssembly.validate(bytes), { budgetMs: 200 });
const mod = await WebAssembly.compile(bytes);
const inst = await instantiateAgain(mod, () => {});
// Instantiate is the per-worker cost; compile is the per-process cost
// (and is cached by the engine across instantiations of the same bytes).
const instRepeat = [];
for (let i = 0; i < 20; i += 1)
  instRepeat.push((await instantiateAgain(mod, () => {})).ms);
instRepeat.sort((a, b) => a - b);
const startup = {
  validateMs: compile.medianMs,
  firstInstantiateMs: inst.ms,
  medianInstantiateMs: instRepeat[10],
  loadAndInstantiateMs: rtProbe.instantiateMs,
};
console.log(`  validate module            ${startup.validateMs.toFixed(3)} ms`);
console.log(
  `  compile + instantiate      ${startup.loadAndInstantiateMs.toFixed(3)} ms`,
);
console.log(
  `  instantiate (precompiled)  ${startup.medianInstantiateMs.toFixed(3)} ms  (median of 20)`,
);
console.log();

/* ── the real runtime, with a swappable host callback ─────────────── */

let hostEmitImpl = () => {};
const rt = await loadSubstrate({ hostEmit: (v, i) => hostEmitImpl(v, i) });
const env = {
  rt,
  WasmFloat64Column,
  makeBridge,
  Float64Column,
  validityFromBits,
  setHostEmit: (fn) => {
    hostEmitImpl = fn;
  },
};

/* ── boundary sweep ───────────────────────────────────────────────── */

console.log(
  '── boundary costs ──────────────────────────────────────────────────────',
);
const boundary = runBoundarySweep(env, { budgetMs: QUICK ? 60 : 150 });
for (const r of boundary) {
  const bits = [];
  if (r.nsPerCall !== undefined) bits.push(`${r.nsPerCall.toFixed(1)} ns/call`);
  if (r.ms !== undefined) bits.push(`${r.ms.toFixed(3)} ms`);
  if (r.gbPerSec !== undefined) bits.push(`${r.gbPerSec.toFixed(2)} GB/s`);
  if (r.nsPerElem !== undefined) bits.push(`${r.nsPerElem.toFixed(2)} ns/elem`);
  console.log(`  ${r.what.padEnd(50)} ${bits.join('   ')}`);
}
console.log();

/* ── kernel sweeps ────────────────────────────────────────────────── */

const SIZES = QUICK
  ? [10_000, 100_000]
  : [10_000, 100_000, 1_000_000, 10_000_000];
const budgetMs = QUICK ? 60 : 140;

function header() {
  console.log(
    `  ${'op'.padEnd(30)} ${'n'.padStart(10)}  ${'pond-ts'.padStart(10)}  ` +
      `${'wasm'.padStart(10)}  ${'×'.padStart(7)}   ns/elem (js → wasm)`,
  );
  console.log(`  ${'─'.repeat(94)}`);
}

function printRow(r) {
  const mark = r.speedup >= 1.15 ? '▲' : r.speedup <= 0.87 ? '▼' : ' ';
  console.log(
    `  ${r.op.padEnd(30)} ${r.n.toLocaleString().padStart(10)}  ` +
      `${r.jsMs.toFixed(3).padStart(9)}ms  ${r.wasmMs.toFixed(3).padStart(9)}ms  ` +
      `${r.speedup.toFixed(2).padStart(6)}× ${mark}  ` +
      `${r.jsNsPerElem.toFixed(2)} → ${r.wasmNsPerElem.toFixed(2)}`,
  );
}

console.log(
  '── A. size sweep (dense, allFinite) ────────────────────────────────────',
);
header();
const sweepA = runKernelSweep(env, {
  sizes: SIZES,
  shapes: ['dense'],
  includeBridged: false,
  budgetMs,
  onCase: printRow,
});
console.log();

console.log(
  '── B. shape sweep (n = 1M) ─────────────────────────────────────────────',
);
console.log('   dense    = no validity bitmap, allFinite: true');
console.log('   gappy30  = 30% cells missing (validity path)');
console.log(
  '   guarded  = finite data, allFinite: false (per-element isFinite guard)',
);
header();
const sweepB = runKernelSweep(env, {
  sizes: [QUICK ? 100_000 : 1_000_000],
  shapes: ['gappy30', 'guarded'],
  includeBridged: false,
  budgetMs,
  onCase: printRow,
});
console.log();

console.log(
  '── C. resident vs bridged (copy-in per call) ───────────────────────────',
);
header();
const sweepC = runKernelSweep(env, {
  sizes: QUICK ? [10_000, 100_000] : [10_000, 100_000, 1_000_000],
  shapes: ['dense'],
  includeBridged: true,
  budgetMs,
  onCase: (r) => {
    if (r.op.includes('[bridged]')) printRow(r);
  },
});
console.log();

/* ── SIMD build comparison ────────────────────────────────────────── */

console.log(
  '── D. simd128 build vs baseline build ──────────────────────────────────',
);
const rtScalar = await loadSubstrate({ simd: false });
const rtSimd = await loadSubstrate({ simd: true });
const simdRows = [];
for (const n of QUICK ? [100_000] : [100_000, 1_000_000, 10_000_000]) {
  const values = makeValues(n);
  const cS = WasmFloat64Column.from(rtScalar, values, null, true);
  const cV = WasmFloat64Column.from(rtSimd, values, null, true);
  const cases = [
    ['sum (sequential)', () => cS.sum(), () => cV.sum()],
    [
      'sum (reassociated)',
      () => cS.sumReassociated(),
      () => cV.sumReassociated(),
    ],
    ['minMax', () => cS.minMax(), () => cV.minMax()],
    ['minMax (lane form)', () => cS.minMax(true), () => cV.minMax(true)],
    [
      `bin(1024,'minMax')`,
      () => cS.bin(1024, 'minMax'),
      () => cV.bin(1024, 'minMax'),
    ],
  ];
  for (const [op, fs, fv] of cases) {
    const s = bench(fs, { budgetMs });
    const v = bench(fv, { budgetMs });
    const row = {
      n,
      op,
      scalarMs: s.medianMs,
      simdMs: v.medianMs,
      speedup: s.medianMs / v.medianMs,
    };
    simdRows.push(row);
    console.log(
      `  ${op.padEnd(30)} ${n.toLocaleString().padStart(10)}  ` +
        `${s.medianMs.toFixed(3).padStart(9)}ms  ${v.medianMs.toFixed(3).padStart(9)}ms  ` +
        `${row.speedup.toFixed(2).padStart(6)}×`,
    );
  }
  cS.free();
  cV.free();
}
console.log();

/* ── ingest: the cost of getting data into WASM at all ────────────── */

console.log(
  '── E. ingest cost (build a resident column from JS data) ───────────────',
);
const ingestRows = [];
for (const n of QUICK ? [100_000] : [100_000, 1_000_000, 10_000_000]) {
  const values = makeValues(n);
  const jsBuild = bench(
    () => new Float64Column(values, n, undefined, true).length,
    { budgetMs },
  );
  const wasmBuild = bench(
    () => {
      const c = WasmFloat64Column.from(rt, values, null, true);
      const l = c.length;
      c.free();
      return l;
    },
    { budgetMs },
  );
  const row = {
    n,
    jsMs: jsBuild.medianMs,
    wasmMs: wasmBuild.medianMs,
    overheadMs: wasmBuild.medianMs - jsBuild.medianMs,
  };
  ingestRows.push(row);
  console.log(
    `  ${'construct column'.padEnd(30)} ${n.toLocaleString().padStart(10)}  ` +
      `${jsBuild.medianMs.toFixed(4).padStart(9)}ms  ${wasmBuild.medianMs.toFixed(4).padStart(9)}ms  ` +
      `+${row.overheadMs.toFixed(4)}ms one-time`,
  );
}
console.log();

/* ── output ───────────────────────────────────────────────────────── */

const results = {
  meta: {
    node: process.version,
    v8: process.versions.v8,
    platform: `${process.platform}/${process.arch}`,
    simdAvailable: hasSimd(),
    quick: QUICK,
  },
  artifacts: sizeRows,
  startup,
  boundary,
  sweepA,
  sweepB,
  sweepC: sweepC.filter((r) => r.op.includes('[bridged]')),
  sweepCResident: sweepC.filter((r) => !r.op.includes('[bridged]')),
  simd: simdRows,
  ingest: ingestRows,
};

if (JSON_OUT) {
  writeFileSync(
    resolve(process.cwd(), JSON_OUT),
    JSON.stringify(results, null, 2),
  );
  console.log(`raw results → ${JSON_OUT}`);
}

/* ── headline summary ─────────────────────────────────────────────── */

console.log('═'.repeat(78));
console.log('summary — median speedup by op (resident, dense, all sizes)');
console.log('═'.repeat(78));
const byOp = new Map();
for (const r of sweepA) {
  if (!byOp.has(r.op)) byOp.set(r.op, []);
  byOp.get(r.op).push(r.speedup);
}
const summary = [...byOp.entries()]
  .map(([op, xs]) => [op, xs.sort((a, b) => a - b)[xs.length >> 1]])
  .sort((a, b) => b[1] - a[1]);
for (const [op, sp] of summary) {
  const bar =
    sp >= 1 ? '█'.repeat(Math.min(40, Math.round((sp - 1) * 20))) : '';
  console.log(`  ${op.padEnd(30)} ${sp.toFixed(2).padStart(6)}×  ${bar}`);
}
console.log();
