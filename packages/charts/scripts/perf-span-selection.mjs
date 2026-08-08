// Perf bench for span-selection membership (interaction RFC A5.2) — the
// per-mark test added to every draw path that evaluates selection.
//
// COMPLEXITY. A span entry costs each drawn mark one O(1) channel test
// (`spanContainsPoint`: two compares for the half-open x interval, two more
// for y when present, O(|rows|) for the label set) — never a scan over the
// marks the span covers, which is the whole point of the descriptor. Per draw
// that is O(V·(|marks| + |spans|)) over V visible marks, exactly the shape the
// mark-set scan already had; the heat map narrows the span x-test to once per
// BIN (the `binLabelsInto` hoist), so its row loop pays only for the spans
// that cover the column. The load-bearing constraint is the other direction:
// **a consumer who never sweeps pays nothing** — zero-span draws must cost
// what they did before the parameter existed, because the gate is one hoisted
// `spans.length > 0` (bars/stacks/heat) or a short-circuited `anySpan &&`
// (scatter/box) per mark.
//
// Scenarios, and why each is here:
//
//   BARS-REST      100k bars, no selection. The floor — the case that must
//                  not regress (every non-interactive chart draws this every
//                  frame).
//   BARS-1MARK     100k bars, one mark entry. The shipped 0-1-mark case —
//                  the second must-not-regress path.
//   BARS-SPAN      100k bars, one span covering half of them. The new
//                  currency's cost when it IS in play: 50k bars take the
//                  selected branch, so this includes the highlight work
//                  itself, not just the test.
//   BARS-MIX8      100k bars, 4 spans + 4 marks. The multi-entry case — a
//                  recent HeatMap change measured +41% on a "free-looking"
//                  path only once a multi-entry case was measured, so the
//                  fan-out is benched, not assumed.
//   SCATTER-SPAN   100k points, one 2-D span (x AND y). The continuous ×
//                  continuous test per point.
//   HEAT-REST      365×45 grid (the Niño 3.4 shape), no selection — the heat
//                  floor.
//   HEAT-SPAN      365×45, one month × 5 rows span. The per-bin narrowing at
//                  work: 334 of 365 bins should pay two compares and skip.
//   HEAT-MIX       365×45, 4 spans + 4 cell marks — the heat multi-entry
//                  case (see BARS-MIX8's rationale).
//
// Run: node scripts/perf-span-selection.mjs   (build first: npm run build)

import { performance } from 'node:perf_hooks';
import { TimeSeries } from 'pond-ts';
import {
  barsFromTimeSeries,
  fromTimeSeries,
  stacksFromColumns,
} from '../dist/data.js';
import { drawBars } from '../dist/bars.js';
import { drawScatter } from '../dist/scatter.js';
import { drawHeat } from '../dist/heat.js';

const BASE = 1.7e12;
const N = 100_000;

const barStyle = {
  fill: '#abc',
  opacity: 0.85,
  highlight: '#fff',
  gap: 0,
  minWidth: 1,
  outlineWidth: 2,
};
const scatterStyle = {
  radius: 3,
  outline: '#000',
  outlineWidth: 0,
  selectedOutline: '#fff',
  selectedWidth: 2,
  label: '#000',
};
const heatStyle = {
  opacity: 1,
  gap: 0,
  minWidth: 1,
  outlineWidth: 1,
  highlight: '#fff',
  gridColor: '#888',
};
const font = { family: 'sans-serif', size: 11 };

function makeSeries(n) {
  const rows = new Array(n);
  for (let i = 0; i < n; i += 1) {
    rows[i] = [BASE + i * 1000, 50 + 35 * Math.sin(i / 5_000)];
  }
  return new TimeSeries({
    name: 's',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ],
    rows,
  });
}

/** A bins×rows grid series (the heat shape). */
function makeGrid(bins, rowNames) {
  const rows = new Array(bins);
  for (let b = 0; b < bins; b += 1) {
    const r = [BASE + b * 86_400_000];
    for (let g = 0; g < rowNames.length; g += 1) {
      r.push(Math.sin(b / 30 + g));
    }
    rows[b] = r;
  }
  return new TimeSeries({
    name: 'grid',
    schema: [
      { name: 'time', kind: 'time' },
      ...rowNames.map((name) => ({ name, kind: 'number' })),
    ],
    rows,
  });
}

function scale(d0, d1, width) {
  const f = (v) => ((v - d0) / (d1 - d0)) * width;
  f.domain = () => [d0, d1];
  f.range = () => [0, width];
  return f;
}

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

const results = [];
const ctx = stubContext();

// ── Bars ────────────────────────────────────────────────────────────────────
{
  const series = makeSeries(N);
  const bs = barsFromTimeSeries(series, 'v');
  const last = BASE + (N - 1) * 1000;
  const xScale = scale(BASE - 500, last + 500, 1200);
  const yScale = scale(0, 100, 400);
  // Undecimated so the per-bar membership loop (the path under test) runs.
  const draw = (selection, spans) =>
    drawBars(
      ctx,
      bs,
      xScale,
      yScale,
      barStyle,
      0,
      0,
      'v',
      selection,
      [],
      false,
      undefined,
      undefined,
      spans,
    );

  const oneMark = [{ id: 'v', key: bs.begin[50_000], value: 50 }];
  const halfSpan = [
    { kind: 'span', id: 'v', x: [bs.begin[25_000], bs.end[74_999]] },
  ];
  const mix8 = [
    ...[0.1, 0.3, 0.5, 0.7].map((f) => ({
      kind: 'span',
      id: 'v',
      x: [bs.begin[(N * f) | 0], bs.end[((N * f) | 0) + 1000]],
    })),
    ...[0.2, 0.4, 0.6, 0.8].map((f) => ({
      id: 'v',
      key: bs.begin[(N * f) | 0],
      value: 50,
    })),
  ];

  results.push(benchmark(`BARS-REST   100k, no selection`, () => draw([], [])));
  results.push(
    benchmark(`BARS-1MARK  100k, one mark entry`, () => draw(oneMark, [])),
  );
  results.push(
    benchmark(`BARS-SPAN   100k, span over 50k`, () => draw([], halfSpan)),
  );
  results.push(
    benchmark(`BARS-MIX8   100k, 4 spans + 4 marks`, () =>
      draw(
        mix8.filter((e) => e.kind === undefined),
        mix8.filter((e) => e.kind === 'span'),
      ),
    ),
  );
}

// ── Scatter ─────────────────────────────────────────────────────────────────
{
  const series = makeSeries(N);
  const cs = fromTimeSeries(series, 'v');
  const last = BASE + (N - 1) * 1000;
  const xScale = scale(BASE, last, 1200);
  const yScale = scale(0, 100, 400);
  const encoding = {
    uniform: true,
    radiusAt: () => 3,
    colorAt: () => '#abc',
  };
  const keyAt = (i) => cs.x[i];
  const draw = (selected, spans) =>
    drawScatter(
      ctx,
      cs,
      xScale,
      yScale,
      scatterStyle,
      encoding,
      keyAt,
      undefined,
      font,
      selected,
      [],
      'v',
      0,
      false,
      spans,
    );

  const span2d = [
    {
      kind: 'span',
      id: 'v',
      x: [BASE + 0.25 * N * 1000, BASE + 0.75 * N * 1000],
      y: [40, 80],
    },
  ];
  results.push(benchmark(`SCAT-REST   100k, no selection`, () => draw([], [])));
  results.push(
    benchmark(`SCAT-SPAN   100k, one 2-D span`, () => draw([], span2d)),
  );
}

// ── Heat ────────────────────────────────────────────────────────────────────
{
  const ROWS = Array.from({ length: 45 }, (_, i) => `y${i}`);
  const grid = makeGrid(365, ROWS);
  const ss = stacksFromColumns(grid, ROWS);
  const xScale = scale(ss.begin[0], ss.end[364], 1200);
  const yScale = scale(0, ROWS.length, 500);
  const colorOf = (v) => (v > 0 ? '#c33' : '#33c');
  const draw = (selection, spans) =>
    drawHeat(
      ctx,
      ss,
      xScale,
      yScale,
      heatStyle,
      colorOf,
      'grid',
      selection,
      [],
      false,
      'vertical',
      'blank',
      spans,
    );

  const monthSpan = [
    {
      kind: 'span',
      id: 'grid',
      x: [ss.begin[180], ss.end[210]],
      rows: ['y10', 'y11', 'y12', 'y13', 'y14'],
    },
  ];
  const mix = [
    ...[0, 90, 180, 270].map((b) => ({
      kind: 'span',
      id: 'grid',
      x: [ss.begin[b], ss.end[b + 20]],
      rows: ['y5', 'y6'],
    })),
    ...[30, 120, 210, 300].map((b) => ({
      id: 'grid',
      key: ss.begin[b],
      value: 0,
      label: 'y20',
    })),
  ];
  results.push(
    benchmark(`HEAT-REST   365x45, no selection`, () => draw([], [])),
  );
  results.push(
    benchmark(`HEAT-SPAN   365x45, month x 5 rows`, () => draw([], monthSpan)),
  );
  results.push(
    benchmark(`HEAT-MIX    365x45, 4 spans + 4 marks`, () =>
      draw(
        mix.filter((e) => e.kind === undefined),
        mix.filter((e) => e.kind === 'span'),
      ),
    ),
  );
}

console.log(JSON.stringify(results, null, 2));
