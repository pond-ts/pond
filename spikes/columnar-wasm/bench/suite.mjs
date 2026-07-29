/**
 * Benchmark suite — environment-agnostic.
 *
 * Node and the browser both import this and hand it a loaded substrate
 * plus pond-ts's real column classes. Keeping the case definitions in
 * one file is what makes the two environments' numbers comparable; if
 * the browser suite drifted from the Node suite, the cross-engine
 * comparison in the report would be meaningless.
 *
 * ── Methodology ──────────────────────────────────────────────────────
 *
 * - **Median, not mean.** GC pauses and CPU migration produce a
 *   long right tail; the mean reports the tail, the median reports the
 *   steady state. Min and max are carried through so the tail is still
 *   visible rather than hidden.
 * - **Adaptive repetition.** Each case runs until it has spent a fixed
 *   time budget, bounded below by 5 reps. A 10M-element scan and a
 *   10k-element scan otherwise get wildly different statistical power.
 * - **Warm-up before sampling.** V8 needs a few thousand iterations to
 *   tier up to TurboFan. Benchmarking a cold interpreter against
 *   ahead-of-time-compiled WASM is the single easiest way to publish a
 *   flattering and completely fake speedup.
 * - **`sink` consumes every result.** Without it, V8's escape analysis
 *   can delete a pure reduction whose result is unused, and the JS
 *   baseline "wins" by not running.
 * - **The comparison is against pond-ts's shipped code**, not a
 *   hand-written straw-man loop. `Float64Column.prototype.bin` et al.
 *   are already tuned (hoisted validity branches, fused minMax, the
 *   `allFinite` fast path). Beating an untuned baseline would prove
 *   nothing about whether porting is worth it.
 */

/* ── timing primitives ────────────────────────────────────────────── */

const now =
  typeof performance !== 'undefined' && performance.now
    ? () => performance.now()
    : () => Number(process.hrtime.bigint()) / 1e6;

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Consumes results so dead-code elimination can't delete the work. */
let SINK = 0;
export function sink(v) {
  if (v === undefined || v === null) {
    SINK += 1;
  } else if (typeof v === 'number') {
    SINK += v === v ? v : 1; // NaN-safe
  } else if (ArrayBuffer.isView(v)) {
    // A typed array: touch the ends, never enumerate.
    //
    // `for...in` over a `Float64Array` walks **every index**, so a
    // benchmark whose function returned a 500k-element buffer was timing
    // this sink rather than its own work — 33 ms of phantom cost against
    // 0.57 ms of real work. Caught because the reported number was larger
    // than the whole operation that produces the buffer.
    SINK += (v[0] ?? 0) + (v[v.length - 1] ?? 0);
  } else if (typeof v === 'object') {
    // Touch one element of each channel of a multi-output result.
    for (const k in v) {
      const ch = v[k];
      SINK +=
        typeof ch === 'number'
          ? ch
          : (ch?.[0] ?? 0) + (ch?.[ch.length - 1] ?? 0);
    }
  }
  return SINK;
}
export const sinkValue = () => SINK;

/**
 * Effective resolution of `now()`, in ms — the smallest non-zero delta
 * it will report.
 *
 * This is not a detail. Browsers clamp `performance.now()` as a Spectre
 * mitigation: **100 µs** in a page that isn't cross-origin-isolated,
 * versus nanoseconds under Node. The first browser run of this suite
 * reported `0.000 ms` and `Infinity×` for every kernel under ~100 µs —
 * which is most of them — because each sample was quantised to a single
 * clock tick. A suite that doesn't probe for this silently publishes
 * garbage in exactly one of its two environments.
 */
export function timerResolutionMs() {
  let best = Infinity;
  for (let trial = 0; trial < 5; trial += 1) {
    const t0 = now();
    let t1 = now();
    let spins = 0;
    while (t1 === t0 && spins < 5_000_000) {
      t1 = now();
      spins += 1;
    }
    if (t1 > t0) best = Math.min(best, t1 - t0);
  }
  return Number.isFinite(best) ? best : 1e-6;
}

const TIMER_RES = timerResolutionMs();
/**
 * Floor for a single timed sample. Set at 200 clock ticks so quantisation
 * contributes well under 1% — 20 ms in a clamped browser, ~0.2 ms under
 * Node's high-resolution clock, with a 2 ms floor so cheap kernels still
 * get a meaningful inner loop even on a fast timer.
 */
const MIN_SAMPLE_MS = Math.max(2, TIMER_RES * 200);

/**
 * Number of warm-up iterations before sampling.
 *
 * **Iterations, not milliseconds.** The original harness warmed for a
 * fixed 40 ms, which is fine for a 10 µs kernel (4,000 iterations) and
 * badly wrong for a 4 ms operation (10 iterations). V8's optimising tier
 * kicks in as a *cliff*, not a curve: measured on `Float64Column.sum()`
 * over 1M cells, the median sat at 3.82 ms through 400 warm-up
 * iterations and dropped to 1.41 ms between 400 and 800, stable
 * thereafter. A time-based warm-up therefore reported operations slower
 * than they are, in proportion to how slow they already were.
 *
 * That bias is **not symmetric**: WASM is compiled ahead of time and has
 * no tier-up, so under-warming inflates only the JavaScript side — which
 * systematically overstates every JS-vs-Rust ratio this suite produces.
 */
const WARMUP_ITERATIONS = 1000;
/**
 * Cap so a very slow operation cannot warm up indefinitely.
 *
 * 3 s was not enough: a 20 ms operation reached only ~150 iterations,
 * well under the ~800 where V8 tiers up, and the symptom was that
 * whichever configuration ran **first** in a process measured 3–7×
 * slow while the second — by then warm — measured true. Reversing the
 * loop order reversed which number was wrong.
 *
 * 15 s covers operations up to ~19 ms/iteration. Anything slower still
 * truncates, which is why `warmTruncated` is returned: a truncated
 * warm-up means the JS side may be reported slow, and for a JS-vs-Rust
 * ratio that is a one-directional error. Measure those in a fresh
 * process, one configuration at a time.
 */
const WARMUP_CAP_MS = Number(
  globalThis.process?.env?.POND_BENCH_WARMUP_CAP_MS ?? 15000,
);

/**
 * Runs `fn` under warm-up, inner-loop calibration, and adaptive
 * repetition.
 *
 * **Inner-loop calibration** is what makes the browser and Node numbers
 * comparable: `fn` is repeated `inner` times *inside* one timed region,
 * chosen so the region clears `MIN_SAMPLE_MS`, and the result divided
 * back down. Both environments then measure the same way rather than one
 * of them measuring clock ticks.
 *
 * The returned `warmIters` / `warmTruncated` say whether warm-up
 * actually reached the tier-up threshold. A truncated warm-up does not
 * invalidate the number, but it means the JS side may still be reported
 * slow — so it is surfaced rather than hidden.
 *
 * `budgetMs` is a sampling budget, not a deadline — a single slow
 * iteration always runs to completion.
 */
export function bench(
  fn,
  { budgetMs = 120, minReps = 5, maxReps = 400, warmupMs = 40 } = {},
) {
  // Warm-up — V8 needs to tier up before it's fair to compare it to
  // ahead-of-time-compiled WASM. Counted in iterations (see
  // WARMUP_ITERATIONS); `warmupMs` is retained only as the floor for the
  // time cap so callers that passed it still behave sensibly.
  const w0 = now();
  let warm = 0;
  const warmCap = Math.max(warmupMs, WARMUP_CAP_MS);
  while (warm < WARMUP_ITERATIONS && now() - w0 < warmCap) {
    sink(fn());
    warm += 1;
  }
  const warmTruncated = warm < WARMUP_ITERATIONS;

  // Calibrate the inner repeat count.
  let inner = 1;
  for (let guard = 0; guard < 32; guard += 1) {
    const t = now();
    for (let i = 0; i < inner; i += 1) sink(fn());
    const dt = now() - t;
    if (dt >= MIN_SAMPLE_MS || inner >= 1 << 22) break;
    // dt can be exactly 0 under a clamped timer — grow blind in that case.
    const factor = dt > 0 ? Math.ceil((MIN_SAMPLE_MS / dt) * 1.3) : 16;
    inner = Math.min(1 << 22, inner * Math.max(2, factor));
  }

  const samples = [];
  const t0 = now();
  while (
    samples.length < maxReps &&
    (samples.length < minReps || now() - t0 < budgetMs)
  ) {
    const s = now();
    for (let i = 0; i < inner; i += 1) sink(fn());
    samples.push((now() - s) / inner);
  }
  return {
    medianMs: median(samples),
    minMs: Math.min(...samples),
    maxMs: Math.max(...samples),
    reps: samples.length,
    inner,
    warmIters: warm,
    warmTruncated,
    timerResMs: TIMER_RES,
  };
}

/* ── data generation ──────────────────────────────────────────────── */

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
 * A plausible time-series value column: slow trend + fast component +
 * noise. Deliberately not `Math.random()` alone — a pure-noise column
 * is unrealistically friendly to branch prediction in the min/max
 * comparison (the running extremum stops updating almost immediately),
 * which would overstate every min/max number in the report.
 */
export function makeValues(n, seed = 0x5eed) {
  const rnd = mulberry32(seed);
  const v = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    v[i] =
      50 + 35 * Math.sin(i / 5000) + 10 * Math.sin(i / 137) + (rnd() - 0.5) * 4;
  }
  return v;
}

/** A non-decreasing key axis with occasional gaps — the `binBy` case. */
export function makeKeys(n, seed = 0xa11e) {
  const rnd = mulberry32(seed);
  const k = new Float64Array(n);
  let t = 1_700_000_000_000;
  for (let i = 0; i < n; i += 1) {
    t += rnd() < 0.01 ? 60_000 + rnd() * 120_000 : 1000;
    k[i] = t;
  }
  return k;
}

export function makeEdges(keys, w) {
  const lo = keys[0];
  const hi = keys[keys.length - 1];
  const e = new Float64Array(w + 1);
  for (let b = 0; b <= w; b += 1) e[b] = lo + ((hi - lo) * b) / w;
  return e;
}

/** Deterministic ~`missingFraction` validity bitmap, or `null` for dense. */
export function makeValidityBits(n, missingFraction, seed = 0xbee5) {
  if (missingFraction <= 0) return null;
  const rnd = mulberry32(seed);
  const bits = new Uint8Array((n + 7) >> 3);
  let defined = 0;
  for (let i = 0; i < n; i += 1) {
    if (rnd() >= missingFraction) {
      bits[i >> 3] |= 1 << (i & 7);
      defined += 1;
    }
  }
  return { bits, defined };
}

/** Shuffled gather indices — the cache-hostile view case. */
export function makeIndices(n, count, seed = 0x1de1) {
  const rnd = mulberry32(seed);
  const idx = new Int32Array(count);
  for (let i = 0; i < count; i += 1) idx[i] = Math.floor(rnd() * n);
  return idx;
}

/* ── the case matrix ──────────────────────────────────────────────── */

const W = 1024; // device-pixel bin count — the chart's real per-frame W

/**
 * Builds every case for one (size, shape) pair.
 *
 * `env` supplies the pieces each host resolves differently:
 *   { rt, WasmFloat64Column, makeBridge, Float64Column, validityFromBits }
 */
function casesFor(env, { n, shape, includeBridged }) {
  const { rt, WasmFloat64Column, makeBridge, Float64Column, validityFromBits } =
    env;

  const values = makeValues(n);
  const missing = shape === 'gappy30' ? 0.3 : 0;
  const vb = makeValidityBits(n, missing);
  // `guarded` is finite data with the flag deliberately off — it
  // measures the per-element `Number.isFinite` guard that pond-ts must
  // pay whenever a producer can't prove finiteness. That's the *common*
  // case for computed columns, so benchmarking only `allFinite: true`
  // would report the library's best case as if it were its typical one.
  const allFinite = shape !== 'guarded';

  const jsValidity = vb ? validityFromBits(vb.bits, n) : undefined;
  const jsCol = new Float64Column(values, n, jsValidity, allFinite);
  const wCol = WasmFloat64Column.from(rt, values, vb?.bits, allFinite);

  // Resident key + edges for binBy (the chart holds these across frames).
  const keys = makeKeys(n);
  const edges = makeEdges(keys, W);
  const keyPtr = rt.exports.pond_alloc(n * 8);
  rt.mem.sync().f64.set(keys, keyPtr >>> 3);
  const edgesPtr = rt.exports.pond_alloc((W + 1) * 8);
  rt.mem.sync().f64.set(edges, edgesPtr >>> 3);

  // Gather: a quarter of the rows, in shuffled order.
  const gCount = Math.max(1, n >> 2);
  const indices = makeIndices(n, gCount);
  const idxPtr = rt.exports.pond_alloc(gCount * 4);
  rt.mem.sync().i32.set(indices, idxPtr >>> 2);

  const bridge = includeBridged ? makeBridge(rt, n) : null;

  const ops = [
    { op: 'sum', js: () => jsCol.sum(), wasm: () => wCol.sum(), elems: n },
    {
      op: 'count',
      js: () => jsCol.count(),
      wasm: () => wCol.count(),
      elems: n,
    },
    {
      op: 'minMax',
      js: () => jsCol.minMax(),
      wasm: () => wCol.minMax(),
      elems: n,
    },
    { op: 'mean', js: () => jsCol.mean(), wasm: () => wCol.mean(), elems: n },
    {
      op: 'stdev',
      js: () => jsCol.stdev(),
      wasm: () => wCol.stdev(),
      elems: n,
    },
    {
      op: 'median',
      js: () => jsCol.median(),
      // Full-sort variant: apples-to-apples with the JS, which sorts.
      wasm: () => wCol.median({ sorted: true }),
      elems: n,
    },
    {
      op: 'median (quickselect)',
      js: () => jsCol.median(),
      wasm: () => wCol.median(),
      elems: n,
      note: 'algorithmic change, not a language win — JS could adopt it too',
    },
    {
      op: 'p95',
      js: () => jsCol.percentile(95),
      wasm: () => wCol.percentile(95),
      elems: n,
    },
    {
      op: `bin(${W},'minMax')`,
      js: () => jsCol.bin(W, 'minMax'),
      wasm: () => wCol.bin(W, 'minMax'),
      elems: n,
    },
    {
      op: `bin(${W},'minMaxFirstLast')`,
      js: () => jsCol.bin(W, 'minMaxFirstLast'),
      wasm: () => wCol.bin(W, 'minMaxFirstLast'),
      elems: n,
    },
    {
      op: `bin(${W},'mean')`,
      js: () => jsCol.bin(W, 'mean'),
      wasm: () => wCol.bin(W, 'mean'),
      elems: n,
    },
    {
      op: `binBy(${W},'minMaxFirstLast')`,
      js: () => jsCol.binBy(keys, edges, 'minMaxFirstLast'),
      wasm: () => wCol.binBy(keyPtr, edgesPtr, W, 'minMaxFirstLast'),
      elems: n,
    },
    {
      op: `gather(n/4)`,
      js: () => jsCol.sliceByIndices(indices),
      wasm: () => {
        const g = wCol.gather(idxPtr, gCount);
        g.free();
        return g.length;
      },
      elems: gCount,
    },
  ];

  if (bridge) {
    ops.push(
      {
        op: 'sum [bridged]',
        js: () => jsCol.sum(),
        wasm: () => bridge.sum(values, allFinite),
        elems: n,
      },
      {
        op: 'minMax [bridged]',
        js: () => jsCol.minMax(),
        wasm: () => bridge.minMax(values, allFinite),
        elems: n,
      },
      {
        op: `bin(${W},'minMax') [bridged]`,
        js: () => jsCol.bin(W, 'minMax'),
        wasm: () => bridge.binMinMax(values, W, allFinite),
        elems: n,
      },
      {
        op: 'copy-in only [bridged]',
        js: () => values.length, // nothing: the JS baseline has no copy
        wasm: () => bridge.uploadOnly(values),
        elems: n,
      },
    );
  }

  const cleanup = () => {
    wCol.free();
    bridge?.free();
    rt.exports.pond_free(keyPtr, n * 8);
    rt.exports.pond_free(edgesPtr, (W + 1) * 8);
    rt.exports.pond_free(idxPtr, gCount * 4);
  };

  return { ops, cleanup, jsCol, wCol, values, n, shape };
}

/* ── runners ──────────────────────────────────────────────────────── */

export function runKernelSweep(
  env,
  {
    sizes,
    shapes,
    includeBridged = false,
    onlyBridged = false,
    budgetMs,
    onCase,
  },
) {
  const rows = [];
  for (const shape of shapes) {
    for (const n of sizes) {
      const { ops, cleanup } = casesFor(env, { n, shape, includeBridged });
      const selected = onlyBridged
        ? ops.filter((o) => o.op.includes('[bridged]'))
        : ops;
      for (const { op, js, wasm, elems, note } of selected) {
        const j = bench(js, { budgetMs });
        const w = bench(wasm, { budgetMs });
        const row = {
          shape,
          n,
          op,
          jsMs: j.medianMs,
          wasmMs: w.medianMs,
          speedup: j.medianMs / w.medianMs,
          jsNsPerElem: (j.medianMs * 1e6) / elems,
          wasmNsPerElem: (w.medianMs * 1e6) / elems,
          jsReps: j.reps,
          wasmReps: w.reps,
          note,
        };
        rows.push(row);
        onCase?.(row);
      }
      cleanup();
    }
  }
  return rows;
}

/**
 * Costs that have nothing to do with the kernels and everything to do
 * with whether a port is viable: the per-call boundary, the cost of
 * moving bytes across it, and what happens if a row-shaped API tries to
 * cross it per element.
 */
export function runBoundarySweep(env, { budgetMs } = {}) {
  const { rt, Float64Column } = env;
  const { exports } = rt;
  const rows = [];

  // 1. Empty call. The floor for *any* WASM operation.
  //    Measured in batches because a single call is below timer noise.
  const BATCH = 100_000;
  const noop = bench(
    () => {
      for (let i = 0; i < BATCH; i += 1) exports.pond_noop();
      return BATCH;
    },
    { budgetMs },
  );
  rows.push({
    what: 'empty JS→WASM call',
    nsPerCall: (noop.medianMs * 1e6) / BATCH,
  });

  const noopArgs = bench(
    () => {
      for (let i = 0; i < BATCH; i += 1) exports.pond_noop_args(0, 0, 0, 0);
      return BATCH;
    },
    { budgetMs },
  );
  rows.push({
    what: 'JS→WASM call, 4 args + f64 return',
    nsPerCall: (noopArgs.medianMs * 1e6) / BATCH,
  });

  // 2. Byte movement across the boundary, both directions.
  for (const n of [1_000, 100_000, 1_000_000]) {
    const src = makeValues(n);
    const ptr = exports.pond_alloc(n * 8);
    const inb = bench(
      () => {
        rt.mem.sync().f64.set(src, ptr >>> 3);
        return n;
      },
      { budgetMs },
    );
    const outb = bench(
      () => {
        const f = rt.mem.sync().f64;
        return f.slice(ptr >>> 3, (ptr >>> 3) + n).length;
      },
      { budgetMs },
    );
    rows.push({
      what: `copy ${n.toLocaleString()} f64 JS→WASM`,
      ms: inb.medianMs,
      gbPerSec: (n * 8) / (inb.medianMs / 1000) / 1e9,
    });
    rows.push({
      what: `copy ${n.toLocaleString()} f64 WASM→JS`,
      ms: outb.medianMs,
      gbPerSec: (n * 8) / (outb.medianMs / 1000) / 1e9,
    });
    exports.pond_free(ptr, n * 8);
  }

  // 3. The row-shaped API across the boundary: one host call per cell.
  //    This is what `Float64Column.scan(fn)` becomes if the values live
  //    in WASM. Measured against the JS `scan` doing identical work.
  {
    const n = 1_000_000;
    const values = makeValues(n);
    const jsCol = new Float64Column(values, n, undefined, true);
    const ptr = exports.pond_alloc(n * 8);
    rt.mem.sync().f64.set(values, ptr >>> 3);

    let acc = 0;
    env.setHostEmit?.((v) => {
      acc += v;
    });

    const jsScan = bench(
      () => {
        acc = 0;
        jsCol.scan((v) => {
          acc += v;
        });
        return acc;
      },
      { budgetMs },
    );
    const wasmScan = bench(
      () => {
        acc = 0;
        exports.col_scan_host(ptr, n, 0);
        return acc;
      },
      { budgetMs },
    );
    rows.push({
      what: `scan(fn) over ${n.toLocaleString()} cells — JS closure`,
      ms: jsScan.medianMs,
      nsPerElem: (jsScan.medianMs * 1e6) / n,
    });
    rows.push({
      what: `scan(fn) over ${n.toLocaleString()} cells — WASM→JS per cell`,
      ms: wasmScan.medianMs,
      nsPerElem: (wasmScan.medianMs * 1e6) / n,
    });
    exports.pond_free(ptr, n * 8);
  }

  return rows;
}
