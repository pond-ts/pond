/**
 * Runs the algorithmic controls: for every kernel where WASM beat
 * pond-ts, measure the *same algorithm* written in plain JS.
 *
 *   node bench/controls-node.mjs [--json out.json]
 *
 * Output columns:
 *   pond-ts    what the library does today
 *   js-algo    the same algorithm the Rust uses, written in JS
 *   wasm       the Rust/WASM kernel, resident (no copy)
 *
 * and the decomposition
 *
 *   algo×      pond-ts / js-algo    — available without leaving JS
 *   lang×      js-algo  / wasm      — what the port actually buys
 *
 * Correctness first: each control is checked against pond-ts's own
 * answer before it is timed.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  Float64Column,
  validityFromBits,
} from '../../../packages/core/dist/columnar/index.js';
import '../../../packages/core/dist/column.js';
import { loadSubstrate } from '../js/loader.mjs';
import { WasmFloat64Column } from '../js/wasm-column.mjs';
import { bench, makeValues, makeValidityBits, makeIndices } from './suite.mjs';
import {
  sumJsReassociated,
  minMaxJsLanes,
  percentileJsQuickselect,
  gatherJsFused,
  sumJsGuardedBranchless,
} from './controls.mjs';

const argv = process.argv.slice(2);
const jsonIdx = argv.indexOf('--json');
const JSON_OUT = jsonIdx >= 0 ? argv[jsonIdx + 1] : null;
const QUICK = argv.includes('--quick');

const rt = await loadSubstrate();
const SIZES = QUICK ? [100_000] : [100_000, 1_000_000, 10_000_000];
const budgetMs = QUICK ? 60 : 140;

console.log('═'.repeat(96));
console.log(
  'Algorithmic controls — is the win the language, or the algorithm?',
);
console.log('═'.repeat(96));
console.log(
  `node ${process.version} · ${process.platform}/${process.arch} · ${rt.simd ? 'simd128' : 'baseline'} build`,
);
console.log();

const rows = [];
let correctness = [];

function check(label, a, b) {
  const same =
    Object.is(a, b) ||
    (Number.isNaN(a) && Number.isNaN(b)) ||
    (typeof a === 'number' &&
      typeof b === 'number' &&
      Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)));
  if (!same) correctness.push(`${label}: js-algo ${a} vs pond-ts ${b}`);
  return same;
}

function row(op, n, shape, pondMs, jsAlgoMs, wasmMs, note) {
  const r = {
    op,
    n,
    shape,
    pondMs,
    jsAlgoMs,
    wasmMs,
    algoX: pondMs / jsAlgoMs,
    langX: jsAlgoMs / wasmMs,
    totalX: pondMs / wasmMs,
    note,
  };
  rows.push(r);
  console.log(
    `  ${op.padEnd(26)} ${shape.padEnd(8)} ${n.toLocaleString().padStart(10)}  ` +
      `${pondMs.toFixed(3).padStart(9)}  ${jsAlgoMs.toFixed(3).padStart(9)}  ${wasmMs.toFixed(3).padStart(9)}  ` +
      `${r.algoX.toFixed(2).padStart(7)}×  ${r.langX.toFixed(2).padStart(7)}×  ${r.totalX.toFixed(2).padStart(7)}×`,
  );
  return r;
}

console.log(
  `  ${'op'.padEnd(26)} ${'shape'.padEnd(8)} ${'n'.padStart(10)}  ` +
    `${'pond-ts'.padStart(9)}  ${'js-algo'.padStart(9)}  ${'wasm'.padStart(9)}  ` +
    `${'algo'.padStart(8)}  ${'lang'.padStart(8)}  ${'total'.padStart(8)}`,
);
console.log(`  ${'─'.repeat(94)}`);

for (const n of SIZES) {
  const values = makeValues(n);

  /* ── dense shape ─────────────────────────────────────────────── */
  {
    const jsCol = new Float64Column(values, n, undefined, true);
    const wCol = WasmFloat64Column.from(rt, values, null, true);
    const scratch = new Float64Array(n);

    check('sum(reassoc)', sumJsReassociated(values, n), wCol.sumReassociated());
    check('minMax(lanes)', minMaxJsLanes(values, n)[0], jsCol.minMax()[0]);
    check('minMax(lanes) hi', minMaxJsLanes(values, n)[1], jsCol.minMax()[1]);
    check(
      'median(quickselect)',
      percentileJsQuickselect(jsCol, 50, scratch),
      jsCol.median(),
    );
    check(
      'p95(quickselect)',
      percentileJsQuickselect(jsCol, 95, scratch),
      jsCol.percentile(95),
    );

    row(
      'sum',
      n,
      'dense',
      bench(() => jsCol.sum(), { budgetMs }).medianMs,
      bench(() => sumJsReassociated(values, n), { budgetMs }).medianMs,
      bench(() => wCol.sumReassociated(), { budgetMs }).medianMs,
      'reassociated — NOT bit-identical to sequential sum',
    );
    row(
      'minMax',
      n,
      'dense',
      bench(() => jsCol.minMax(), { budgetMs }).medianMs,
      bench(() => minMaxJsLanes(values, n), { budgetMs }).medianMs,
      bench(() => wCol.minMax(true), { budgetMs }).medianMs,
      'lane form — bit-identical, adoptable as-is',
    );
    row(
      'median',
      n,
      'dense',
      bench(() => jsCol.median(), { budgetMs }).medianMs,
      bench(() => percentileJsQuickselect(jsCol, 50, scratch), { budgetMs })
        .medianMs,
      bench(() => wCol.median(), { budgetMs }).medianMs,
      'quickselect vs full sort',
    );
    row(
      'p95',
      n,
      'dense',
      bench(() => jsCol.percentile(95), { budgetMs }).medianMs,
      bench(() => percentileJsQuickselect(jsCol, 95, scratch), { budgetMs })
        .medianMs,
      bench(() => wCol.percentile(95), { budgetMs }).medianMs,
      'quickselect vs full sort',
    );

    // gather — fused single pass vs pond-ts's two passes
    const gCount = Math.max(1, n >> 2);
    const indices = makeIndices(n, gCount);
    const idxPtr = rt.exports.pond_alloc(gCount * 4);
    rt.mem.sync().i32.set(indices, idxPtr >>> 2);
    const fused = gatherJsFused(jsCol, indices);
    const pondG = jsCol.sliceByIndices(indices);
    check('gather[0]', fused.values[0], pondG._values[0]);
    check('gather[last]', fused.values[gCount - 1], pondG._values[gCount - 1]);
    row(
      'gather(n/4)',
      n,
      'dense',
      bench(() => jsCol.sliceByIndices(indices), { budgetMs }).medianMs,
      bench(() => gatherJsFused(jsCol, indices), { budgetMs }).medianMs,
      bench(
        () => {
          const g = wCol.gather(idxPtr, gCount);
          g.free();
          return g.length;
        },
        { budgetMs },
      ).medianMs,
      'one fused pass vs two passes over the index array',
    );
    rt.exports.pond_free(idxPtr, gCount * 4);
    wCol.free();
  }

  /* ── guarded shape (allFinite: false) — the regression case ──── */
  {
    const jsCol = new Float64Column(values, n, undefined, false);
    const wCol = WasmFloat64Column.from(rt, values, null, false);
    check(
      'sum guarded branchless',
      sumJsGuardedBranchless(values, n),
      jsCol.sum(),
    );
    row(
      'sum',
      n,
      'guarded',
      bench(() => jsCol.sum(), { budgetMs }).medianMs,
      bench(() => sumJsGuardedBranchless(values, n), { budgetMs }).medianMs,
      bench(() => wCol.sum(), { budgetMs }).medianMs,
      'naive Rust port of the guarded path',
    );
    row(
      'sum (rust branchless)',
      n,
      'guarded',
      bench(() => jsCol.sum(), { budgetMs }).medianMs,
      bench(() => sumJsGuardedBranchless(values, n), { budgetMs }).medianMs,
      bench(() => rt.exports.col_sum_guarded_branchless(wCol.ptr, n, 0), {
        budgetMs,
      }).medianMs,
      'same select-not-branch fix applied in Rust',
    );
    wCol.free();
  }

  /* ── gappy shape — the validity-bitmap path ──────────────────── */
  {
    const vb = makeValidityBits(n, 0.3);
    const jsCol = new Float64Column(
      values,
      n,
      validityFromBits(vb.bits, n),
      true,
    );
    const wCol = WasmFloat64Column.from(rt, values, vb.bits, true);
    const gCount = Math.max(1, n >> 2);
    const indices = makeIndices(n, gCount);
    const idxPtr = rt.exports.pond_alloc(gCount * 4);
    rt.mem.sync().i32.set(indices, idxPtr >>> 2);
    const fused = gatherJsFused(jsCol, indices);
    const pondG = jsCol.sliceByIndices(indices);
    check('gappy gather[0]', fused.values[0], pondG._values[0]);
    check(
      'gappy gather defined',
      fused.defined,
      pondG.validity?.definedCount ?? gCount,
    );
    row(
      'gather(n/4)',
      n,
      'gappy30',
      bench(() => jsCol.sliceByIndices(indices), { budgetMs }).medianMs,
      bench(() => gatherJsFused(jsCol, indices), { budgetMs }).medianMs,
      bench(
        () => {
          const g = wCol.gather(idxPtr, gCount);
          g.free();
          return g.length;
        },
        { budgetMs },
      ).medianMs,
      'validity walk fused into the value walk',
    );
    rt.exports.pond_free(idxPtr, gCount * 4);
    wCol.free();
  }
}

console.log();
if (correctness.length) {
  console.error('✗ control correctness failures:');
  for (const c of correctness) console.error(`    ${c}`);
  process.exitCode = 1;
} else {
  console.log('✓ every JS control agrees with pond-ts before timing');
}

/* ── decomposition summary ───────────────────────────────────────── */
console.log();
console.log('═'.repeat(96));
console.log('decomposition — where does each speedup actually come from?');
console.log('═'.repeat(96));
const byOp = new Map();
for (const r of rows) {
  const key = `${r.op} [${r.shape}]`;
  if (!byOp.has(key)) byOp.set(key, []);
  byOp.get(key).push(r);
}
const med = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const MATERIAL = 1.25;
const summary = [];
for (const [key, rs] of byOp) {
  const algo = med(rs.map((r) => r.algoX));
  const lang = med(rs.map((r) => r.langX));
  const total = med(rs.map((r) => r.totalX));
  // Share of the total speedup (in log space, since the terms multiply)
  // that a JS-only change already captures.
  //
  // Undefined when there's no speedup to apportion: as `total` → 1 the
  // denominator → 0 and the ratio explodes (a kernel at 1.00× total once
  // printed "776%"). Gate on a real gap rather than on `total > 1`.
  const jsShare =
    total > 1.05 ? Math.log(Math.max(algo, 1)) / Math.log(total) : null;
  let verdict;
  if (algo < MATERIAL && lang < MATERIAL) verdict = 'neither — no material win';
  else if (algo >= MATERIAL && lang < MATERIAL)
    verdict = 'ALGORITHM — no port needed';
  else if (lang >= MATERIAL && algo < MATERIAL)
    verdict = 'LANGUAGE — the port is the win';
  else
    verdict =
      algo >= lang ? 'both, algorithm dominates' : 'both, language dominates';
  summary.push({ key, algo, lang, total, jsShare, verdict });
  console.log(
    `  ${key.padEnd(34)} total ${total.toFixed(2).padStart(6)}×  =  ` +
      `algo ${algo.toFixed(2).padStart(5)}×  ×  lang ${lang.toFixed(2).padStart(5)}×  ` +
      `│ JS-only reaches ${
        jsShare === null ? ' n/a' : `${(jsShare * 100).toFixed(0).padStart(3)}%`
      }  → ${verdict}`,
  );
}
console.log();
console.log(
  '  "JS-only reaches" = share of the total speedup (log scale, since the two\n' +
    '  terms multiply) that a same-day JS PR captures without any Rust at all.',
);
console.log();

if (JSON_OUT) {
  writeFileSync(
    resolve(process.cwd(), JSON_OUT),
    JSON.stringify({ rows, correctness, summary }, null, 2),
  );
  console.log(`raw results → ${JSON_OUT}`);
}
