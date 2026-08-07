// Perf bench for the heat-map draw layer ([PND-HEATMAP]) — a grid of cells,
// bins on x and the series' columns as rows.
//
// COMPLEXITY. `drawHeat` is O(V·G) over V visible bins and G rows: one
// `fillRect` per cell, which is irreducible — the layer's whole job is to paint
// V·G rectangles. What is *not* irreducible is the per-cell setup around it,
// and that is what this bench exists to size.
//
// The first cut called `cellRect` per cell, which:
//
//   - calls `barSpanPx` (two scale calls) — but the x span depends only on the
//     BIN, so a 45-row grid computed it 45 times per column;
//   - calls `yScale(g)` and `yScale(g + 1)` — but the row band depends only on
//     the ROW, so it recomputed the same G+1 boundaries once per visible bin;
//   - allocates a 4-element array to return the rect.
//
// So the setup was O(V·G) scale calls and O(V·G) allocations where O(V + G) and
// zero would do. On the Niño 3.4 grid at day resolution — 365 bins × 45 years =
// 16,425 cells, the largest grid this repo actually draws — that is ~33k scale
// calls and ~16k short-lived arrays per frame, every frame, and hover repaints
// the whole grid.
//
// `cellRect` itself stays: `heatAt` calls it ONCE per hit-test, where the
// hoisting has nothing to amortize over and the array is free. It is the draw
// loop that needed the hoist, so the two paths diverge deliberately.
//
// Scenarios, and why each is here:
//
//   - NINO       365×45, full view. The real workload, and the one whose frame
//                time a reader feels when they drag across the plot.
//   - STRIPE     365×1. The climate-stripes case; G=1 is the same path, so this
//                is the per-BIN floor with the row loop degenerate.
//   - TALL       365×200. Scales G hard — this is where per-cell y-scale calls
//                would show up as super-linear in rows.
//   - ZOOMED     20000×45 with a viewport over ~365 bins. Culling should make
//                this cost the same as NINO; if it does not, `visibleSpanRange`
//                is not doing its job.
//   - HOVER      NINO with a hovered mark, so `matchesCell` runs per cell. Hover
//                repaints the grid, so this is the interactive path, not an
//                edge case.
//   - GAPS       NINO with half the values non-finite. The skip path should be
//                CHEAPER than NINO; if it is not, gaps are costing setup work
//                before they are discarded.
//
// RESULTS (Apple M-series, node 24). Two optimizations shipped:
//
//   1. Hoist the per-bin x span and the per-row y band out of the cell loop,
//      and drop `cellRect`'s per-cell array. O(V·G) scale calls and allocations
//      become O(V + G) and zero.
//   2. Assign `ctx.fillStyle` only when the colour changes.
//
//   scenario                         before     after    delta
//   NINO   365x45 full              2.230ms   0.798ms     -64%
//   STRIPE 365x1  full              0.084ms   0.076ms      -10%  (control)
//   TALL   365x200 full             9.649ms   3.682ms     -62%
//   ZOOMED 20000x45 -> ~365 vis     2.267ms   0.830ms     -63%
//   HOVER  365x45 one cell live     2.082ms   0.873ms     -58%
//   GAPS   365x45 half holes        1.069ms   0.463ms     -57%
//
// DENSE was added after the fact and is not part of the before/after: it is the
// open question, not a regression. 20000 bins x 45 rows all in view is 900k
// cells painted into a plot that can only resolve ~36k of them — 48ms, ~25x
// overdraw, and it is linear in cells (53 ns/cell, the same rate as NINO), so a
// real canvas is worse than this, not better. See the decimation note in
// PND_CHARTS_PLAN.md.
//
// STRIPE is the control and is meant to be flat: with G=1 the row loop is
// degenerate, so there is nothing to hoist. That it did not move is the
// evidence the win comes from the row loop and not from somewhere else.
//
// TWO OPTIMIZATIONS WERE MEASURED AND REJECTED, which is worth recording so the
// next person does not re-derive them:
//
//   - Short-circuiting the two per-cell `matchesCell` calls when neither a
//     selection nor a hover exists. Sounds free; measured 1.033ms vs 0.971ms on
//     NINO — no win, and a branch and a flag for it. The checks already exit on
//     their first line when the mark is null.
//   - Caching `ctx.globalAlpha` the way `fillStyle` is cached. This measures
//     enormously well here — a further -31% on NINO — and that number is an
//     ARTEFACT. The bench's context is a `Proxy`, so every property set pays a
//     trap crossing; a real canvas stores a number. `fillStyle` is kept because
//     a real canvas genuinely parses the colour string on assignment, so the
//     saving survives outside the bench. Alpha caching's would not, and it cost
//     three tests that (rightly) pin what is drawn.
//
// That asymmetry is the thing to remember about this harness: it charges every
// ctx property write far more than a browser does, so it OVERSTATES any
// optimization whose only effect is doing fewer writes. It is honest about work
// that is actually work — scale calls, allocation, arithmetic.
//
// Run: node scripts/perf-heat.mjs   (build first: npm run build)

import { performance } from 'node:perf_hooks';
import { scaleLinear } from 'd3-scale';
import { drawHeat, bandedColor } from '../dist/heat.js';

const RAMP = ['#1b0c41', '#781c6d', '#cf4446', '#fb9b06', '#f7d13d'];

const style = {
  opacity: 1,
  highlight: '#fff',
  outlineWidth: 1,
  gap: 0,
  minWidth: 1,
};

/**
 * A `bins × rows` grid on a unit bin axis. Values sweep the ramp deterministically
 * so every band is exercised; `gapEvery` makes every nth cell a hole.
 */
function makeGrid(bins, rows, gapEvery = 0) {
  const begin = new Float64Array(bins);
  const end = new Float64Array(bins);
  const values = new Float64Array(bins * rows);
  for (let b = 0; b < bins; b += 1) {
    begin[b] = b;
    end[b] = b + 1;
    for (let g = 0; g < rows; g += 1) {
      const i = b * rows + g;
      values[i] =
        gapEvery > 0 && i % gapEvery === 0
          ? NaN
          : 2 + Math.sin(b / 37) * 1.5 + Math.cos(g / 11);
    }
  }
  return {
    begin,
    end,
    values,
    groups: Array.from({ length: rows }, (_, g) => `r${g}`),
    length: bins,
  };
}

/** The layer's own colour closure, banded across the ramp — the per-cell work
 *  `<HeatMap>` actually hands `drawHeat`, not a precomputed lookup. */
function colorFor(ss, lo, hi) {
  const G = ss.groups.length;
  return (b, g) => bandedColor(ss.values[b * G + g], RAMP, lo, hi);
}

function sizedCtx(widthPx) {
  const noop = () => {};
  return new Proxy(
    { canvas: { width: widthPx } },
    { get: (t, p) => (p in t ? t[p] : noop), set: () => true },
  );
}

function scale(d0, d1, r0, r1) {
  return scaleLinear().domain([d0, d1]).range([r0, r1]);
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function benchmark(label, fn, repeats = 60) {
  for (let i = 0; i < 8; i += 1) fn();
  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
    const t = performance.now();
    fn();
    samples.push(performance.now() - t);
  }
  return { label, medianMs: Number(median(samples).toFixed(4)) };
}

const PLOT_W = 800;
const PLOT_H = 420;
const ctx = sizedCtx(PLOT_W * 2);
const y = (rows) => scale(0, rows, PLOT_H, 0);

const results = [];
const run = (label, ss, xScale, yScale, sel = null, hov = null) => {
  const colorAt = colorFor(ss, 0, 4);
  const r = benchmark(label, () =>
    drawHeat(ctx, ss, xScale, yScale, style, colorAt, 'h', sel, hov),
  );
  const cells = ss.length * ss.groups.length;
  results.push({
    ...r,
    cells,
    nsPerCell: Number(((r.medianMs * 1e6) / cells).toFixed(1)),
  });
};

// ── The real workload, and the two shapes that bracket it. ──────────────────
{
  const ss = makeGrid(365, 45);
  run('NINO   365x45 full', ss, scale(0, 365, 0, PLOT_W), y(45));
}
{
  const ss = makeGrid(365, 1);
  run('STRIPE 365x1  full', ss, scale(0, 365, 0, PLOT_W), y(1));
}
{
  const ss = makeGrid(365, 200);
  run('TALL   365x200 full', ss, scale(0, 365, 0, PLOT_W), y(200));
}

// ── Culling: a huge series with a small viewport should cost like NINO. ─────
{
  const ss = makeGrid(20000, 45);
  // Domain covers ~365 bins of a 20000-bin series.
  run('ZOOMED 20000x45 -> ~365 visible', ss, scale(0, 365, 0, PLOT_W), y(45));
}

// ── The interactive path: hover repaints, and matches run per cell. ─────────
{
  const ss = makeGrid(365, 45);
  run(
    'HOVER  365x45 one cell live',
    ss,
    scale(0, 365, 0, PLOT_W),
    y(45),
    null,
    {
      id: 'h',
      key: 200,
      label: 'r22',
    },
  );
}

// ── Sub-pixel bins: every bin visible, far more bins than pixels. ──────────
// `barSpanPx` widens a bin narrower than `minWidth` to 1px around its midpoint,
// so at this density adjacent cells OVERLAP and later draws overpaint earlier
// ones. Nothing is culled — culling only drops what is off-domain — so the layer
// paints 20000 rects per row into an 800px-wide plot: ~25x overdraw, and what
// survives per pixel column is whichever bin happened to be drawn last.
{
  const ss = makeGrid(20000, 45);
  run('DENSE  20000x45 all visible', ss, scale(0, 20000, 0, PLOT_W), y(45));
}

// ── Gaps should be cheaper, not dearer. ────────────────────────────────────
{
  const ss = makeGrid(365, 45, 2);
  run('GAPS   365x45 half holes', ss, scale(0, 365, 0, PLOT_W), y(45));
}

const width = Math.max(...results.map((r) => r.label.length));
console.log('');
console.log(
  `${'scenario'.padEnd(width)}  ${'cells'.padStart(7)}  ${'median ms'.padStart(9)}  ${'ns/cell'.padStart(8)}`,
);
for (const r of results) {
  console.log(
    `${r.label.padEnd(width)}  ${String(r.cells).padStart(7)}  ${r.medianMs
      .toFixed(3)
      .padStart(9)}  ${r.nsPerCell.toFixed(1).padStart(8)}`,
  );
}
console.log('');
console.log(JSON.stringify(results));
