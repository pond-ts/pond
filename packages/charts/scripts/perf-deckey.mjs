// Perf bench for the decimation cache ([PND-DECKEY]) — the 2026-07 external-bench
// profile's finding 3: at mountain@1M the decimation walk (~19% of the frame)
// re-runs an x-only computation under y-only invalidation (every y-zoom /
// y-autorange frame re-bins the same points to the same polyline).
//
// Measures the per-frame cost of the cull+M4-decimate step, comparing:
//   - RECOMPUTE = `cullChartSeries` + `decimateM4` every call — the pre-PR
//     behaviour (and still what a pan / x-zoom frame pays: a fresh x-domain
//     misses the cache).
//   - CACHED    = `decimateM4Cached` with a stable (source, xScale, W) — a y-only
//     frame, which after the first call is an O(1) WeakMap hit (no re-bin).
// The delta is the O(N) binBy walk the cache eliminates on every y-only repaint.
//
// The decimation output never reads the y-scale, so the cached result is
// byte-identical to the recomputed one — this is pure work avoided, not an
// approximation.
//
// Run: node scripts/perf-deckey.mjs   (build first: npm run build)

import { performance } from 'node:perf_hooks';
import { scaleLinear } from 'd3-scale';
import { decimateM4, decimateM4Cached } from '../dist/decimate.js';
import { cullChartSeries } from '../dist/culling.js';

/** A dense ChartSeries of `n` points on a uniform 1s grid, sine values. */
function makeSeries(n) {
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    x[i] = i * 1000;
    y[i] = 50 + 35 * Math.sin(i / 5_000) + 10 * Math.sin(i / 137);
  }
  return { x, y, length: n };
}

/** A real d3 scaleLinear over the full series → CSS px range [0, widthCss]. */
function scale(d0, d1, widthCss) {
  return scaleLinear().domain([d0, d1]).range([0, widthCss]);
}

/** A no-op ctx with a device-pixel backing width (the M4 bucket count W). */
function sizedCtx(widthPx) {
  const noop = () => {};
  return new Proxy(
    { canvas: { width: widthPx } },
    { get: (t, p) => (p in t ? t[p] : noop), set: () => true },
  );
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}

function benchmark(label, fn, repeats = 50) {
  for (let i = 0; i < 3; i += 1) fn();
  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return {
    label,
    medianMs: Number(median(samples).toFixed(4)),
    minMs: Number(Math.min(...samples).toFixed(4)),
    maxMs: Number(Math.max(...samples).toFixed(4)),
  };
}

const PLOT_WIDTH_CSS = 800;
const W = PLOT_WIDTH_CSS * 2; // device-pixel columns at DPR 2
const results = [];

for (const n of [100_000, 500_000, 1_000_000]) {
  const cs = makeSeries(n);
  const ctx = sizedCtx(W);
  const s = scale(cs.x[0], cs.x[n - 1], PLOT_WIDTH_CSS);

  // Pre-PR / pan-frame cost: cull + re-bin every call.
  results.push(
    benchmark(`N=${n} RECOMPUTE (pan / pre-PR)`, () => {
      const culled = cullChartSeries(cs, s);
      decimateM4(culled, s, ctx);
    }),
  );
  // y-only frame: prime once (warm-up does), then O(1) hits.
  results.push(
    benchmark(`N=${n} CACHED (y-zoom hit)`, () => decimateM4Cached(cs, s, ctx)),
  );
}

console.log(
  JSON.stringify({ plotWidthCss: PLOT_WIDTH_CSS, W, results }, null, 2),
);
