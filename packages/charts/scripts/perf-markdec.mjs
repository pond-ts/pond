// Perf bench for bar column decimation ([PND-MARKDEC]) — the 2026-07 external
// bench's finding 4: a dense bar column chart has no decimation path, so it falls
// off where line/area/candle don't ("column dead by 5M").
//
// Measures the main-thread draw cost of `drawBars` against a NO-OP context (Node
// has no canvas raster), comparing:
//   - FULL  = every visible bar (the pre-PR path): per bar a `barSpanPx` (two
//     scale calls) + a `fillRect`.
//   - DECIM = one envelope rect per pixel column: two O(N) value-bin walks +
//     ~W `fillRect`s.
// The JS-side delta is the per-bar scale + dispatch overhead the binning avoids;
// the LARGER win is browser-side — N filled-rect rasterizations collapse to ~W —
// which a no-op ctx can't see (same caveat as the area-fill bench).
//
// Run: node scripts/perf-markdec.mjs   (build first: npm run build)

import { performance } from 'node:perf_hooks';
import { scaleLinear } from 'd3-scale';
import { drawBars } from '../dist/bars.js';

const style = {
  fill: '#abc',
  opacity: 0.85,
  highlight: '#fff',
  gap: 0,
  minWidth: 1,
  outlineWidth: 2,
};

/** `n` unit bars over [0, n], random-walk values (straddle the baseline). */
function makeBars(n) {
  const begin = new Float64Array(n);
  const end = new Float64Array(n);
  const y = new Float64Array(n);
  let prev = 0;
  for (let i = 0; i < n; i += 1) {
    begin[i] = i;
    end[i] = i + 1;
    prev += Math.sin(i / 999) * 3; // deterministic walk (no Math.random in bench)
    y[i] = prev;
  }
  return { begin, end, y, length: n };
}

function scale(d0, d1, widthCss) {
  return scaleLinear().domain([d0, d1]).range([0, widthCss]);
}

/** A no-op ctx with a device-pixel backing width (the decimation bucket count). */
function sizedCtx(widthPx) {
  const noop = () => {};
  return new Proxy(
    { canvas: { width: widthPx } },
    { get: (t, p) => (p in t ? t[p] : noop), set: () => true },
  );
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function benchmark(label, fn, repeats = 40) {
  for (let i = 0; i < 3; i += 1) fn();
  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return { label, medianMs: Number(median(samples).toFixed(4)) };
}

const PLOT_WIDTH_CSS = 800;
const W = PLOT_WIDTH_CSS * 2; // device columns at DPR 2
const results = [];

for (const n of [100_000, 1_000_000, 5_000_000]) {
  const bars = makeBars(n);
  const ctx = sizedCtx(W);
  const x = scale(0, n, PLOT_WIDTH_CSS);
  const y = scale(-2000, 2000, 400);
  results.push(
    benchmark(`N=${n} FULL (every bar)`, () =>
      drawBars(ctx, bars, x, y, style, 0, 0, 'c', null, null, false),
    ),
  );
  results.push(
    benchmark(`N=${n} DECIM (column envelope)`, () =>
      drawBars(ctx, bars, x, y, style, 0, 0, 'c', null, null, true),
    ),
  );
}

console.log(
  JSON.stringify({ plotWidthCss: PLOT_WIDTH_CSS, W, results }, null, 2),
);
