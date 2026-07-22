// Perf bench for the affine fast path ([PND-AFFINE]) + the gradient-extent cache
// ([PND-GRADX]) — the two levers the 2026-07 external bench profile surfaced
// (docs/notes/charts-bench-vs-scichart-suite-2026-07.md, findings 1 + 2).
//
// Measures the **main-thread path-gen CPU** a stroke-bound repaint pays, against
// a NO-OP context (Node has no canvas raster). The two paths compared are the
// real before/after of this change:
//   - SLOW  = the d3-shape generator + per-point d3-scale closures — the path
//             every line/area draw took *before* PND-AFFINE. Forced here by
//             stripping the scale's domain/range so `affineOf` returns null.
//   - FAST  = the inline `k·v + b` loop over the typed arrays — the new path,
//             engaged when both scales are affine (a real d3 scaleLinear here).
// Both draw the identical picture; the delta is pure mapping + shape overhead.
//
// The context is unsized (no `canvas.width`), so decimation bails and every
// point strokes — the stroke-bound regime the N×M-collapse profile measured
// (1000×1000, all points below the per-series M4 threshold).
//
// Complexity: drawLine/drawArea are O(N) path ops either way; the fast path
// removes a per-point d3-scale `scale()` (deinterpolate → interpolate closures)
// and the d3-shape `line`/`area` generator dispatch, replacing them with two
// multiplies + an add. PND-GRADX additionally removes the O(N) gradient-extent
// walk on every repaint (memoized per value buffer) — the y-zoom hot path where
// the data is unchanged.
//
// Run: node scripts/perf-affine.mjs   (build first: npm run build)

import { performance } from 'node:perf_hooks';
import { scaleLinear } from 'd3-scale';
import { drawLine } from '../dist/line.js';
import { drawArea, columnFiniteExtent } from '../dist/area.js';

const lineStyle = { color: '#000', width: 1 };
const areaStyle = {
  color: '#000',
  width: 1,
  fill: '#2563eb',
  fillOpacity: 0.3,
};

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

/** A **real** d3 `scaleLinear` — the exact scale a chart runs. `affineOf`
 *  accepts it (probes affine) so the FAST path extracts its coefficients and
 *  never calls it per point. */
function affineScale(d0, d1, width) {
  return scaleLinear().domain([d0, d1]).range([0, width]);
}

/** The same d3 scale hidden behind a plain arrow: no `.domain()`/`.range()` for
 *  `affineOf` to read → the SLOW (d3-shape) path — but each call still pays the
 *  real d3-scale deinterpolate → interpolate cost, i.e. the true pre-PND-AFFINE
 *  behaviour the profile measured. */
function stripped(scale) {
  return (v) => scale(v);
}

/** A no-op 2D context — records nothing, so timing is pure path-gen CPU. Unsized
 *  (no `canvas.width`) ⇒ decimation bails ⇒ every point strokes. */
function stubContext() {
  const noop = () => {};
  return new Proxy(
    {},
    {
      get: (_t, p) =>
        p === 'measureText'
          ? () => ({ width: 0 })
          : p === 'createLinearGradient'
            ? () => ({ addColorStop: noop })
            : noop,
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
  const fast = affineScale(lo, hi, PLOT_WIDTH);
  const fastY = affineScale(0, 100, 400);
  const slow = stripped(fast);
  const slowY = stripped(fastY);

  // Line: full-view, stroke-bound (no decimation) — the N×M regime.
  results.push(
    benchmark(`line N=${n} SLOW (d3-shape)`, () =>
      drawLine(ctx, cs, slow, slowY, lineStyle),
    ),
  );
  results.push(
    benchmark(`line N=${n} FAST (affine)`, () =>
      drawLine(ctx, cs, fast, fastY, lineStyle),
    ),
  );

  // Area: fill polygon + outline, stroke-bound.
  results.push(
    benchmark(`area N=${n} SLOW (d3-area)`, () =>
      drawArea(ctx, cs, slow, slowY, areaStyle, 0),
    ),
  );
  results.push(
    benchmark(`area N=${n} FAST (affine)`, () =>
      drawArea(ctx, cs, fast, fastY, areaStyle, 0),
    ),
  );
}

// PND-GRADX — the gradient-extent computation in isolation (the O(N) min/max
// walk `buildGradient` ran on **every** repaint, including each y-zoom frame
// where the data is unchanged). "walk/frame" calls a distinct pre-allocated
// buffer each time (a fresh cache key ⇒ the walk runs — the pre-PND-GRADX cost);
// "cached" reuses one buffer (the y-zoom hot path ⇒ one walk, then O(1) hits).
// Buffers are pre-allocated outside the timed region so allocation/GC doesn't
// pollute the walk signal. This is what the fill drops per repaint; in-browser
// the profile put it at ~21% of the mountain@1M frame (fill rasterizes on the
// GPU, so the JS walk is a larger share there than in this JS-only harness).
for (const n of [500_000, 1_000_000]) {
  const cs = makeSeries(n);
  const POOL = 40;
  const pool = Array.from({ length: POOL }, () => cs.y.slice());
  let poolIdx = 0;
  results.push(
    benchmark(`gradient N=${n} walk/frame (uncached)`, () => {
      // A distinct buffer per call ⇒ a cache miss ⇒ the O(N) extent walk.
      columnFiniteExtent(pool[poolIdx++ % POOL], n);
    }),
  );
  columnFiniteExtent(cs.y, n); // prime
  results.push(
    benchmark(`gradient N=${n} cached (y-zoom hit)`, () =>
      columnFiniteExtent(cs.y, n),
    ),
  );
}

console.log(JSON.stringify({ plotWidth: PLOT_WIDTH, results }, null, 2));
