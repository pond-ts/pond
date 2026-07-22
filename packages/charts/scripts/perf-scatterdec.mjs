// Perf bench for scatter decimation ([PND-MARKDEC] scatter half) — the SciChart
// suite's point-update / scatter categories, where an un-decimated scatter draws
// every one of N marks each frame (the one mark type with no decimation path).
//
// Complexity. drawScatter FULL = O(visible): per finite point a beginPath + arc +
// fill (+ outline stroke) + a per-point encoding lookup. DECIM = O(visible) once
// through decimateScatter's 2D occupancy sweep (a per-column row Set), then one
// arc/fill per OCCUPIED CELL (~min(N, plotArea/cell²)) with fillStyle set once.
// So the walk stays O(N) but the draw + rasterization collapses from N marks to
// ~cells. Against a NO-OP ctx (Node has no canvas raster) this shows only the JS
// dispatch delta — the arc/fill *rasterization* win is larger, browser-side,
// same caveat as perf-markdec / the area-fill bench.
//
// Run: node scripts/perf-scatterdec.mjs   (build first: npm run build)

import { performance } from 'node:perf_hooks';
import { scaleLinear } from 'd3-scale';
import { drawScatter } from '../dist/scatter.js';
import { decimateScatter } from '../dist/decimate.js';

const style = {
  color: '#3366cc',
  radius: 4,
  outline: '#fff',
  outlineWidth: 1,
  selectedOutline: '#000',
  selectedWidth: 2,
  label: '#333',
};
const font = { family: 'sans-serif', size: 11 };
// A fixed (uniform), opaque encoding — the decimatable case.
const encoding = { radiusAt: () => 4, colorAt: () => '#3366cc', uniform: true };

/** A no-op 2D context with a backing width (drives deviceBucketCount = W). */
function noopCtx(deviceWidth) {
  const noop = () => {};
  return {
    canvas: { width: deviceWidth },
    save: noop,
    restore: noop,
    beginPath: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    fillText: noop,
  };
}

/** `n` points on a 1s grid, y a seeded sine + jitter spread over the plot. */
function makeSeries(n) {
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  let a = 12345;
  const rand = () => (a = (a * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < n; i += 1) {
    x[i] = i;
    y[i] = 50 + 40 * Math.sin(i / 200) + (rand() - 0.5) * 60;
  }
  return { x, y, length: n };
}

const median = (xs) => {
  const s = [...xs].sort((p, q) => p - q);
  return s.length % 2
    ? s[(s.length - 1) / 2]
    : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

function benchmark(label, fn, iters = 30) {
  for (let i = 0; i < 3; i += 1) fn(); // warmup
  const ts = [];
  for (let i = 0; i < iters; i += 1) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  return { label, ms: median(ts) };
}

const PLOT_CSS = 900; // CSS px wide plot
const DPR = 2;
const results = [];
for (const n of [50_000, 100_000, 500_000, 1_000_000]) {
  const cs = makeSeries(n);
  const xS = scaleLinear().domain([0, n]).range([0, PLOT_CSS]);
  const yS = scaleLinear().domain([0, 100]).range([600, 0]);
  const ctx = noopCtx(PLOT_CSS * DPR);
  const keyAt = (i) => cs.x[i];

  const full = benchmark(`full  n=${n}`, () =>
    drawScatter(
      ctx,
      cs,
      xS,
      yS,
      style,
      encoding,
      keyAt,
      undefined,
      font,
      null,
      undefined,
      0,
      false,
    ),
  );
  const decim = benchmark(`decim n=${n}`, () =>
    drawScatter(
      ctx,
      cs,
      xS,
      yS,
      style,
      encoding,
      keyAt,
      undefined,
      font,
      null,
      undefined,
      0,
      true,
    ),
  );
  const reduced = decimateScatter(cs, xS, yS, 4, 0, n);
  results.push({
    n,
    fullMs: +full.ms.toFixed(2),
    decimMs: +decim.ms.toFixed(2),
    speedup: +(full.ms / decim.ms).toFixed(1),
    marks: `${n} → ${reduced.length}`,
  });
}

console.log(
  'scatter decimation — drawScatter cost (no-op ctx; JS dispatch only)\n',
);
console.log('n\t\tfull(ms)\tdecim(ms)\tspeedup\tmarks drawn');
for (const r of results) {
  console.log(
    `${r.n}\t${r.fullMs}\t\t${r.decimMs}\t\t${r.speedup}x\t${r.marks}`,
  );
}
console.log(
  '\n(JS-only; the arc/fill rasterization win is larger browser-side.)',
);
console.log(JSON.stringify(results));
