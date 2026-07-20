// Perf bench for viewport culling (charts decimator wave, Phase 2).
//
// Measures the **main-thread draw cost** a pan/zoom repaint pays — the d3-shape
// path generation that walks every point and issues a moveTo/lineTo per sample
// (the JS work that precedes canvas rasterization). Culling clips the series to
// the visible window before this walk, so the cost drops from O(N) to
// O(visible). This bench runs `drawLine` against a no-op recording context (so
// the number reflects path-gen CPU, not GPU raster, which Node has no canvas
// for) at each size, comparing a **full-view** domain (no cull — the whole
// series is on screen) against a **zoomed-in** domain (the pan hot path — a
// narrow window over a huge series).
//
// Complexity: per layer per frame, drawLine is O(N) path ops without culling;
// with culling it is O(log N) to bisect + O(visible) to walk. `visible` is
// bounded by the plot's pixel width for a decimated draw, but even undecimated
// (Phase 2) it is only the points inside the view — for a 1M series zoomed to
// ~2k visible points that is a ~500x reduction in path ops.
//
// Run: node scripts/perf-culling.mjs   (build first: npm run build)

import { performance } from 'node:perf_hooks';
import { drawLine } from '../dist/line.js';
import { drawBars } from '../dist/bars.js';

const style = { color: '#000', width: 1 };
const barStyle = {
  fill: '#abc',
  opacity: 0.85,
  highlight: '#fff',
  gap: 0,
  minWidth: 1,
  outlineWidth: 2,
};

/** A BarSeries of `n` contiguous interval bars on a uniform 1s grid. */
function makeBars(n) {
  const begin = new Float64Array(n);
  const end = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    begin[i] = i * 1000;
    end[i] = i * 1000 + 1000;
    y[i] = 50 + 35 * Math.sin(i / 5_000);
  }
  return { begin, end, y, length: n };
}

/** A ChartSeries of `n` points on a uniform 1s grid, sine values. */
function makeSeries(n) {
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    x[i] = i * 1000;
    y[i] = 50 + 35 * Math.sin(i / 5_000) + 10 * Math.sin(i / 137);
  }
  return { x, y, length: n };
}

/**
 * A callable value→pixel scale that also carries `.domain()` (the real d3 shape
 * culling reads). Maps the domain `[d0, d1]` across `[0, width]`.
 */
function scale(d0, d1, width) {
  const f = (v) => ((v - d0) / (d1 - d0)) * width;
  f.domain = () => [d0, d1];
  return f;
}

/** A no-op 2D context — records nothing, so the timing is pure path-gen CPU. */
function stubContext() {
  const noop = () => {};
  return new Proxy(
    {},
    {
      get: (_t, p) => (p === 'measureText' ? () => ({ width: 0 }) : noop),
      set: () => true,
    },
  );
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}

function benchmark(label, fn, repeats = 30) {
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

const PLOT_WIDTH = 800;
const results = [];

for (const n of [100_000, 500_000, 1_000_000]) {
  const cs = makeSeries(n);
  const ctx = stubContext();
  const lo = cs.x[0];
  const hi = cs.x[n - 1];
  const span = hi - lo;

  // Full view: the whole series on screen (no cull — the baseline draw cost).
  const fullScale = scale(lo, hi, PLOT_WIDTH);
  results.push(
    benchmark(`N=${n} full-view (no cull)`, () => {
      drawLine(ctx, cs, fullScale, (v) => v, style);
    }),
  );

  // Zoomed in to ~0.2% of the span — the pan/zoom hot path over a large series.
  // Only the points inside the window (+1 each side) are walked.
  const zLo = lo + span * 0.4;
  const zHi = zLo + span * 0.002;
  const zoomScale = scale(zLo, zHi, PLOT_WIDTH);
  const visible = Math.round(n * 0.002);
  results.push(
    benchmark(`N=${n} zoomed (~${visible} visible, culled)`, () => {
      drawLine(ctx, cs, zoomScale, (v) => v, style);
    }),
  );
}

// Interval-keyed marks (bars) — the span-overlap cull path. One representative
// size; candles / boxes share the same visibleSpanRange loop-bound cull.
{
  const n = 500_000;
  const bars = makeBars(n);
  const ctx = stubContext();
  const lo = bars.begin[0];
  const hi = bars.end[n - 1];
  const span = hi - lo;
  const fullScale = scale(lo, hi, PLOT_WIDTH);
  results.push(
    benchmark(`bars N=${n} full-view (no cull)`, () => {
      drawBars(
        ctx,
        bars,
        fullScale,
        (v) => v,
        barStyle,
        0,
        0,
        undefined,
        null,
        null,
      );
    }),
  );
  const zLo = lo + span * 0.4;
  const zHi = zLo + span * 0.002;
  const zoomScale = scale(zLo, zHi, PLOT_WIDTH);
  const visible = Math.round(n * 0.002);
  results.push(
    benchmark(`bars N=${n} zoomed (~${visible} visible, culled)`, () => {
      drawBars(
        ctx,
        bars,
        zoomScale,
        (v) => v,
        barStyle,
        0,
        0,
        undefined,
        null,
        null,
      );
    }),
  );
}

console.log(JSON.stringify({ plotWidth: PLOT_WIDTH, results }, null, 2));
