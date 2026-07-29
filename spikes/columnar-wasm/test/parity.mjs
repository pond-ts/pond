/**
 * Parity harness — every WASM kernel against the *real* pond-ts
 * implementation it would replace.
 *
 * A performance report on a port nobody has checked for correctness is
 * worth nothing, and "faster" is trivially achievable by being wrong.
 * So this runs first and the benchmark refuses to publish numbers if it
 * fails.
 *
 * The interesting cases are not the happy path — they're the seams
 * where pond-ts has *specific* documented behaviour that a
 * reimplementation would plausibly get wrong:
 *
 *  - non-finite cells are **missing**, not propagating (reducer
 *    non-finite policy) — including a column that is *entirely*
 *    non-finite, which must reduce to `undefined`, not `NaN`
 *  - `allFinite: false` must take the guarded path even when the data
 *    happens to be finite (the flag is a promise, not a fact)
 *  - the "all defined ⇒ no bitmap" convention on gather output
 *  - empty bins are `NaN` for min/max/mean/stdev/median, `0` for
 *    sum/count
 *  - `binBy`'s final edge is **inclusive** so a sample exactly on the
 *    max edge lands in the last bucket
 *  - stdev is *population* (÷n), via Welford, matching the recurrence
 *    the JS uses so the two agree bit-for-bit rather than approximately
 *
 * Run: node test/parity.mjs
 */

import {
  Float64Column,
  validityFromPredicate,
} from '../../../packages/core/dist/columnar/index.js';
import '../../../packages/core/dist/column.js'; // side-effect: mounts the public column API
import { loadSubstrate } from '../js/loader.mjs';
import { WasmFloat64Column } from '../js/wasm-column.mjs';

let failures = 0;
let checks = 0;

function eq(actual, expected, label) {
  checks += 1;
  const same =
    (Number.isNaN(actual) && Number.isNaN(expected)) ||
    Object.is(actual, expected) ||
    actual === expected;
  if (!same) {
    failures += 1;
    console.error(
      `  ✗ ${label}\n      wasm: ${actual}\n      pond: ${expected}`,
    );
  }
}

/** Float comparison with an explicit ULP budget, used only where the
 *  two implementations legitimately differ in operation order. */
function close(actual, expected, label, ulps = 4) {
  checks += 1;
  if (actual === undefined || expected === undefined)
    return eq(actual, expected, label);
  if (Number.isNaN(actual) && Number.isNaN(expected)) return;
  const scale = Math.max(
    Math.abs(actual),
    Math.abs(expected),
    Number.MIN_VALUE,
  );
  const tol = ulps * Number.EPSILON * scale;
  if (!(Math.abs(actual - expected) <= tol)) {
    failures += 1;
    console.error(
      `  ✗ ${label}\n      wasm: ${actual}\n      pond: ${expected}\n      Δ=${Math.abs(actual - expected)} tol=${tol}`,
    );
  }
}

function eqArray(actual, expected, label) {
  checks += 1;
  if (actual.length !== expected.length) {
    failures += 1;
    console.error(
      `  ✗ ${label}: length ${actual.length} vs ${expected.length}`,
    );
    return;
  }
  for (let i = 0; i < actual.length; i += 1) {
    const a = actual[i];
    const e = expected[i];
    if (!(Object.is(a, e) || (Number.isNaN(a) && Number.isNaN(e)))) {
      failures += 1;
      console.error(`  ✗ ${label}[${i}]: wasm ${a} vs pond ${e}`);
      return;
    }
  }
}

/* ── deterministic RNG so a failure is reproducible ──────────────── */
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
 * Builds a matched pair: a real pond-ts `Float64Column` and a WASM
 * column over the identical bytes and flags.
 */
function makePair(rt, source, { allFinite } = {}) {
  const n = source.length;
  const values = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const v = source[i];
    values[i] = typeof v === 'number' ? v : 0;
  }
  const validity = validityFromPredicate(
    n,
    (i) => typeof source[i] === 'number',
  );
  // Data-derive `allFinite` the way `float64ColumnFromArray` does,
  // unless the caller is deliberately testing a pessimistic flag.
  const af =
    allFinite ??
    source.every((v) => typeof v !== 'number' || Number.isFinite(v));

  const js = new Float64Column(values, n, validity, af);
  const wasm = WasmFloat64Column.from(rt, values, validity?.bits, af);
  return { js, wasm, values, validity, n, af };
}

const rt = await loadSubstrate();
console.log(
  `substrate: ${rt.simd ? 'simd128' : 'baseline'}  ${rt.byteLength} B  ` +
    `instantiate ${rt.instantiateMs.toFixed(2)} ms\n`,
);

/* ══════════════════════════════════════════════════════════════════ */
/* Case matrix                                                        */
/* ══════════════════════════════════════════════════════════════════ */

const rnd = mulberry32(0xc01d);

const CASES = {
  'dense finite': Array.from({ length: 5000 }, () => rnd() * 200 - 100),
  'dense, large magnitude (FP stress)': Array.from(
    { length: 5000 },
    () => 1e10 + rnd() * 4,
  ),
  'sparse (10% missing)': Array.from({ length: 5000 }, () =>
    rnd() < 0.1 ? undefined : rnd() * 50,
  ),
  'very sparse (90% missing)': Array.from({ length: 5000 }, () =>
    rnd() < 0.9 ? undefined : rnd() * 50,
  ),
  'NaN and Inf mixed in': Array.from({ length: 5000 }, () => {
    const r = rnd();
    if (r < 0.05) return NaN;
    if (r < 0.08) return Infinity;
    if (r < 0.11) return -Infinity;
    if (r < 0.2) return undefined;
    return rnd() * 100 - 50;
  }),
  'all missing': Array.from({ length: 64 }, () => undefined),
  'all non-finite': Array.from({ length: 64 }, () => NaN),
  'single value': [42],
  'single missing': [undefined],
  empty: [],
  'two values': [3, -7],
  constant: Array.from({ length: 1000 }, () => 5),
  'negative zero': [-0, 0, -0],
  denormals: [5e-324, 1e-320, -5e-324],
  extremes: [Number.MAX_VALUE, -Number.MAX_VALUE, 1],
};

console.log('── scalar reductions ─────────────────────────────────');
for (const [name, source] of Object.entries(CASES)) {
  const { js, wasm } = makePair(rt, source);
  eq(wasm.sum(), js.sum(), `${name}: sum`);
  eq(wasm.count(), js.count(), `${name}: count`);
  eq(wasm.mean(), js.mean(), `${name}: mean`);
  eq(wasm.min(), js.min(), `${name}: min`);
  eq(wasm.max(), js.max(), `${name}: max`);
  eq(wasm.stdev(), js.stdev(), `${name}: stdev`);
  eq(wasm.median(), js.median(), `${name}: median (quickselect)`);
  eq(wasm.median({ sorted: true }), js.median(), `${name}: median (full sort)`);
  for (const q of [0, 1, 25, 50, 95, 99.9, 100]) {
    eq(wasm.percentile(q), js.percentile(q), `${name}: p${q}`);
  }
  const mmW = wasm.minMax();
  const mmJ = js.minMax();
  eq(JSON.stringify(mmW), JSON.stringify(mmJ), `${name}: minMax`);
  const mmS = wasm.minMax(true);
  eq(JSON.stringify(mmS), JSON.stringify(mmJ), `${name}: minMax (simd shape)`);
  wasm.free();
}
console.log(`  ${checks} checks, ${failures} failures so far`);

/* ── the flag-is-a-promise case ──────────────────────────────────── */
console.log('\n── allFinite=false on finite data (guarded path) ─────');
{
  const source = Array.from({ length: 3000 }, () => rnd() * 10);
  const { js, wasm } = makePair(rt, source, { allFinite: false });
  eq(wasm.sum(), js.sum(), 'pessimistic flag: sum');
  eq(wasm.stdev(), js.stdev(), 'pessimistic flag: stdev');
  eq(wasm.median(), js.median(), 'pessimistic flag: median');
  eq(
    JSON.stringify(wasm.minMax()),
    JSON.stringify(js.minMax()),
    'pessimistic flag: minMax',
  );
  wasm.free();
}

/* ── reassociated sum: quantify the divergence, don't assert equality ── */
console.log('\n── reassociated sum (expected to differ) ─────────────');
{
  const worst = { name: null, relErr: 0 };
  for (const [name, source] of Object.entries(CASES)) {
    if (source.length === 0) continue;
    const { js, wasm } = makePair(rt, source);
    const seq = js.sum();
    const re = wasm.sumReassociated();
    const rel = seq === 0 ? Math.abs(re) : Math.abs((re - seq) / seq);
    if (rel > worst.relErr) {
      worst.relErr = rel;
      worst.name = name;
    }
    wasm.free();
  }
  console.log(
    `  worst relative divergence: ${worst.relErr.toExponential(3)} on "${worst.name}"` +
      `  (${(worst.relErr / Number.EPSILON).toFixed(1)} × eps)`,
  );
}

/* ── binning ─────────────────────────────────────────────────────── */
console.log('\n── bin() ────────────────────────────────────────────');
for (const [name, source] of Object.entries(CASES)) {
  if (source.length === 0) continue;
  const { js, wasm } = makePair(rt, source);
  for (const bins of [1, 7, 64, 1024, source.length * 2]) {
    const jm = js.bin(bins, 'minMax');
    const wm = wasm.bin(bins, 'minMax');
    eqArray(wm.lo, jm.lo, `${name}/bins=${bins}: minMax.lo`);
    eqArray(wm.hi, jm.hi, `${name}/bins=${bins}: minMax.hi`);

    const j4 = js.bin(bins, 'minMaxFirstLast');
    const w4 = wasm.bin(bins, 'minMaxFirstLast');
    eqArray(w4.lo, j4.lo, `${name}/bins=${bins}: m4.lo`);
    eqArray(w4.hi, j4.hi, `${name}/bins=${bins}: m4.hi`);
    eqArray(w4.first, j4.first, `${name}/bins=${bins}: m4.first`);
    eqArray(w4.last, j4.last, `${name}/bins=${bins}: m4.last`);

    for (const r of [
      'min',
      'max',
      'sum',
      'mean',
      'count',
      'stdev',
      'median',
      'p95',
    ]) {
      eqArray(wasm.bin(bins, r), js.bin(bins, r), `${name}/bins=${bins}: ${r}`);
    }
  }
  wasm.free();
}
console.log(`  ${checks} checks, ${failures} failures so far`);

/* ── binBy ───────────────────────────────────────────────────────── */
console.log('\n── binBy() ──────────────────────────────────────────');
{
  const n = 4000;
  // Irregular / gappy key axis — the case `binBy` exists for.
  const keys = new Float64Array(n);
  let t = 1_700_000_000_000;
  for (let i = 0; i < n; i += 1) {
    t += rnd() < 0.02 ? 60_000 + rnd() * 300_000 : 900 + rnd() * 200;
    keys[i] = t;
  }
  const source = Array.from({ length: n }, (_, i) =>
    rnd() < 0.08 ? undefined : Math.sin(i / 50) * 30 + rnd() * 4,
  );
  const { js, wasm } = makePair(rt, source);

  const keyPtr = rt.exports.pond_alloc(n * 8);
  rt.mem.sync().f64.set(keys, keyPtr >>> 3);

  for (const W of [1, 3, 137, 1024]) {
    const lo = keys[0];
    const hi = keys[n - 1];
    const edges = new Float64Array(W + 1);
    for (let b = 0; b <= W; b += 1) edges[b] = lo + ((hi - lo) * b) / W;

    const edgesPtr = rt.exports.pond_alloc((W + 1) * 8);
    rt.mem.sync().f64.set(edges, edgesPtr >>> 3);

    const jm = js.binBy(keys, edges, 'minMaxFirstLast');
    const wm = wasm.binBy(keyPtr, edgesPtr, W, 'minMaxFirstLast');
    eqArray(wm.lo, jm.lo, `binBy W=${W}: lo`);
    eqArray(wm.hi, jm.hi, `binBy W=${W}: hi`);
    eqArray(wm.first, jm.first, `binBy W=${W}: first`);
    eqArray(wm.last, jm.last, `binBy W=${W}: last`);

    for (const r of ['min', 'max', 'sum', 'mean', 'count', 'median']) {
      eqArray(
        wasm.binBy(keyPtr, edgesPtr, W, r),
        js.binBy(keys, edges, r),
        `binBy W=${W}: ${r}`,
      );
    }
    rt.exports.pond_free(edgesPtr, (W + 1) * 8);
  }

  // Max-edge inclusivity: a sample exactly on the last edge must land
  // in the final bucket, not fall off the end.
  {
    const W = 4;
    const edges = new Float64Array(W + 1);
    for (let b = 0; b <= W; b += 1)
      edges[b] = keys[0] + ((keys[n - 1] - keys[0]) * b) / W;
    edges[W] = keys[n - 1]; // exactly the last key
    const edgesPtr = rt.exports.pond_alloc((W + 1) * 8);
    rt.mem.sync().f64.set(edges, edgesPtr >>> 3);
    eqArray(
      wasm.binBy(keyPtr, edgesPtr, W, 'count'),
      js.binBy(keys, edges, 'count'),
      'binBy: max edge inclusive',
    );
    rt.exports.pond_free(edgesPtr, (W + 1) * 8);
  }

  rt.exports.pond_free(keyPtr, n * 8);
  wasm.free();
}

/* ── gather ──────────────────────────────────────────────────────── */
console.log('\n── gather (sliceByIndices + validity gather) ────────');
{
  for (const [name, source] of Object.entries(CASES)) {
    if (source.length === 0) continue;
    const { js, wasm, n } = makePair(rt, source);
    const m = Math.min(n, 777);
    const indices = new Int32Array(m);
    for (let i = 0; i < m; i += 1) {
      // Deliberately include out-of-range indices: pond-ts reads 0 and
      // marks the slot invalid, which is easy to get wrong.
      indices[i] = rnd() < 0.05 ? -1 : Math.floor(rnd() * (n + 3));
    }
    const idxPtr = rt.exports.pond_alloc(m * 4);
    rt.mem.sync().i32.set(indices, idxPtr >>> 2);

    const jg = js.sliceByIndices(indices);
    const wg = wasm.gather(idxPtr, m);

    eq(wg.length, jg.length, `${name}: gather length`);
    // Compare through `read`-equivalent semantics on both sides.
    let mismatch = -1;
    for (let i = 0; i < m; i += 1) {
      const a = wg.percentileAt === undefined ? undefined : undefined; // unused
      void a;
    }
    // Value+validity comparison: materialise both to (value|undefined).
    const jsOut = new Array(m);
    for (let i = 0; i < m; i += 1) jsOut[i] = jg.read(i);
    const wView = wg.view();
    const wValidityPtr = wg.validityPtr;
    const u8 = rt.mem.sync().u8;
    for (let i = 0; i < m; i += 1) {
      const defined =
        wValidityPtr === 0
          ? true
          : (u8[wValidityPtr + (i >> 3)] & (1 << (i & 7))) !== 0;
      const wv = defined ? wView[i] : undefined;
      if (
        !Object.is(wv, jsOut[i]) &&
        !(Number.isNaN(wv) && Number.isNaN(jsOut[i]))
      ) {
        mismatch = i;
        break;
      }
    }
    checks += 1;
    if (mismatch >= 0) {
      failures += 1;
      console.error(`  ✗ ${name}: gather cell ${mismatch} differs`);
    }
    // "all defined ⇒ no bitmap" convention.
    checks += 1;
    const jsHasBitmap = jg.validity !== undefined;
    const wasmHasBitmap = wg.validityPtr !== 0;
    if (jsHasBitmap !== wasmHasBitmap) {
      failures += 1;
      console.error(
        `  ✗ ${name}: bitmap-presence convention differs (pond ${jsHasBitmap}, wasm ${wasmHasBitmap})`,
      );
    }

    rt.exports.pond_free(idxPtr, m * 4);
    wg.free();
    wasm.free();
  }
}

/* ── validity bitmap ops ─────────────────────────────────────────── */
console.log('\n── validity popcount / countInRange ─────────────────');
{
  for (const len of [0, 1, 7, 8, 9, 63, 64, 65, 1000, 100_000]) {
    const source = Array.from({ length: len }, () =>
      rnd() < 0.3 ? undefined : rnd(),
    );
    const validity = validityFromPredicate(
      len,
      (i) => typeof source[i] === 'number',
    );
    if (!validity) continue;
    const ptr = rt.exports.pond_alloc(validity.bits.length);
    rt.mem.sync().u8.set(validity.bits, ptr);
    eq(
      rt.exports.validity_popcount(ptr, len),
      validity.definedCount,
      `popcount len=${len}`,
    );
    for (const [s, e] of [
      [0, len],
      [1, len - 1],
      [3, 11],
      [len >> 1, len],
      [8, 16],
      [0, 1],
      [len, len],
    ]) {
      if (s < 0 || e < s || e > len) continue;
      eq(
        rt.exports.validity_count_range(ptr, s, e),
        validity.countInRange(s, e),
        `countInRange len=${len} [${s},${e})`,
      );
    }
    rt.exports.pond_free(ptr, validity.bits.length);
  }
}

/* ── verdict ─────────────────────────────────────────────────────── */
console.log(`\n${'═'.repeat(56)}`);
if (failures === 0) {
  console.log(`✓ parity: ${checks} checks, 0 failures`);
  process.exit(0);
} else {
  console.error(`✗ parity: ${checks} checks, ${failures} FAILURES`);
  process.exit(1);
}
