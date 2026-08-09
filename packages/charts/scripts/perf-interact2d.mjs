// Perf bench for the 2-D rect gesture and the two state ladders it lit up
// ([PND-INTERACT2D]) — the per-pointermove and per-repaint work a scatter or
// heat-map selection adds.
//
// This exists because of A8.1. The 1-D band's live preview measured **6.2
// SECONDS per frame** at 100k before its membership scan was re-priced, and a
// rect lights strictly more marks per move than a band does: a band is a run
// of columns, a rect is a region. Nothing here may be assumed free.
//
// COMPLEXITY.
//
//   sweep2D.update      O(log N)   two binary searches over the sorted key
//                                  spans, then a 4-compare delta gate that
//                                  now includes the y window (a purely
//                                  vertical drag MUST re-cut). The press-edge
//                                  pullback is O(k) over marks sharing the
//                                  exact press key — 1 in practice, N on a
//                                  degenerate all-same-key series.
//   scatter materialise O(R)       R = marks in the x run; the y filter is a
//                                  scan of it, not a second index.
//   heat materialise    O(B·G')    B = bins in the run, G' = ROWS IN THE
//                                  RECT — not G. A one-row rect over 365
//                                  bins is 365 cells, not 16,425.
//
//   Both are gated: an unchanged (run, y-window) re-materialises nothing.
//
//   drawScatter+states  O(V)       one extra branch per point; live points
//                                  are deferred whole into a flat array
//                                  (allocated on first hit, so a resting
//                                  frame still allocates nothing) and drawn
//                                  in a second O(live) pass.
//   drawHeat+states     O(W·G)     the honest new term: a neighbour grid,
//                                  precomputed one column wider than the
//                                  culling window so the union perimeter can
//                                  ask about a cell's four neighbours. Only
//                                  when something is selected. PLUS one veil
//                                  fillRect per unselected cell, which is the
//                                  term to watch — it is per CELL, and it
//                                  alternates `fillStyle` against the ramp's
//                                  run-length optimisation.
//
// Scenarios:
//
//   CUT-GATED      100k points, 10k updates inside one cut — the floor.
//   CUT-YONLY      100k points, 10k updates moving ONLY y. The gate must NOT
//                  hold here (that is the bug fix), so this is the true
//                  per-move cost of a vertical drag: re-cut + re-materialise.
//   CUT-GROW       100k points, a rect growing one point per update — the
//                  worst materialisation cadence (real gestures coalesce).
//   HEAT-CUT       365×45 grid, a rect growing one bin per update.
//   HEAT-CUT-1ROW  the same, one row tall — proves the cut is O(B·G'), not
//                  O(B·G).
//   SC-REST        100k points, nothing selected. States ON vs OFF: the floor
//                  that must not move.
//   SC-SEL         100k points, a span covering half — dimming + the live
//                  deferral, ON vs OFF.
//   SC-HOVER-10K   100k points, 10k in the plural `hovered` — the live-preview
//   SC-HOVER-50K   repaint a rect drag actually produces, at two sizes. THE
//                  case A8.1 is about: the membership test runs once per
//                  visible point over the whole hovered set.
//   HEAT-REST      365×45, nothing selected. ON vs OFF.
//   HEAT-SEL       365×45, a span over a third of it — the pre-pass, the veil
//                  and the perimeter together, ON vs OFF.
//   HEAT-SEL-WIDE  1000×45 (45,000 cells), the same span shape — where an
//                  O(W·G) term shows itself if it is going to.
//
// Run: node scripts/perf-interact2d.mjs   (build first: npm run build)

import { performance } from 'node:perf_hooks';
import { TimeSeries } from 'pond-ts';
import { fromTimeSeries, stacksFromColumns } from '../dist/data.js';
import { drawScatter } from '../dist/scatter.js';
import { drawHeat, bandedColor } from '../dist/heat.js';
import { sweep2D } from '../dist/sweep.js';
import { defaultTheme } from '../dist/theme.js';

const BASE = 1.7e12;
const RAMP = ['#e0f2f1', '#7FC8BF', '#2A9D8F', '#1F7A6F'];

// ── Harness (the shape perf-multiselect.mjs uses) ──────────────────────────

function scale(d0, d1, width) {
  const f = (v) => ((v - d0) / (d1 - d0)) * width;
  f.domain = () => [d0, d1];
  f.range = () => [0, width];
  f.invert = (px) => d0 + (px / width) * (d1 - d0);
  return f;
}

function stubContext(widthPx = 1300) {
  const noop = () => {};
  const carrier = { canvas: { width: widthPx } };
  return new Proxy(carrier, {
    get: (t, p) =>
      p in t ? t[p] : p === 'measureText' ? () => ({ width: 0 }) : noop,
    set: () => true,
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}

function benchmark(label, fn, repeats = 20) {
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

// ── Fixtures ───────────────────────────────────────────────────────────────

function makePoints(n) {
  const rows = new Array(n);
  for (let i = 0; i < n; i += 1) {
    rows[i] = [BASE + i * 1000, 50 + 35 * Math.sin(i / 5_000)];
  }
  return fromTimeSeries(
    new TimeSeries({
      name: 's',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ],
      rows,
    }),
    'v',
  );
}

function makeGrid(bins, rows) {
  const names = Array.from({ length: rows }, (_, g) => `r${g}`);
  const columns = { time: new Array(bins) };
  for (const name of names) columns[name] = new Array(bins);
  for (let b = 0; b < bins; b += 1) {
    columns.time[b] = BASE + b * 86_400_000;
    for (let g = 0; g < rows; g += 1) {
      columns[names[g]][b] = 10 + 8 * Math.sin(b / 30 + g / 4);
    }
  }
  const ss = stacksFromColumns(
    TimeSeries.fromColumns({
      name: 'grid',
      schema: [
        { name: 'time', kind: 'time' },
        ...names.map((n) => ({ name: n, kind: 'number' })),
      ],
      columns,
    }),
    names,
  );
  return { ss, names };
}

const encodingFor = (cs) => ({
  uniform: true,
  radiusAt: () => 4.5,
  colorAt: () => '#2A9D8F',
  length: cs.length,
});

const scatterStyle = (states) => ({
  ...defaultTheme.scatter.default,
  ...(states ? {} : { states: undefined }),
});

const heatStyle = (states) => ({
  opacity: 1,
  highlight: defaultTheme.bar.default.highlight,
  outlineWidth: defaultTheme.bar.default.outlineWidth,
  gap: 0,
  minWidth: 1,
  gridColor: '#eee',
  ...(states ? { states: defaultTheme.heat.default } : {}),
});

const results = [];
const ctx = stubContext();

// ── The cut ────────────────────────────────────────────────────────────────

const N = 100_000;
const pts = makePoints(N);

function pointSession() {
  return sweep2D({
    id: 'v',
    begin: pts.x,
    end: pts.x,
    length: pts.length,
    spanFrom: 'drag',
    materialize: (lo, hi, y0, y1) => {
      const out = [];
      for (let i = lo; i < hi; i += 1) {
        const v = pts.y[i];
        if (!Number.isFinite(v) || v < y0 || v >= y1) continue;
        out.push({
          id: 'v',
          key: pts.x[i],
          value: v,
          color: '#abc',
          label: 'v',
        });
      }
      return out;
    },
    channels: (_h, y0, y1) => ({ y: [y0, y1] }),
  });
}

{
  const s = pointSession();
  const mid = BASE + (N / 2) * 1000;
  s.update(mid, mid + 10_000_000, 0, 100);
  s.hits();
  results.push(
    benchmark('CUT-GATED      100k pts, 10k updates inside one cut', () => {
      for (let i = 0; i < 10_000; i += 1) {
        // Wiggle STRICTLY BETWEEN two keys, so the covered set cannot change.
        // `mid` itself is a key, and straddling it flips the run every other
        // move (the press-edge pullback pulls the mark on `x0` back in) — the
        // first draft of this scenario did exactly that and measured 9,999
        // re-cuts while claiming to be the gated floor.
        s.update(mid + 1 + (i % 2), mid + 10_000_000, 0, 100);
        s.hits();
      }
    }),
  );
}
{
  const s = pointSession();
  const mid = BASE + (N / 2) * 1000;
  results.push(
    benchmark('CUT-YONLY      100k pts, 10k y-only moves (must re-cut)', () => {
      for (let i = 0; i < 10_000; i += 1) {
        // The x run is fixed; only the rect's height changes. The gate must
        // NOT hold, so every one of these re-materialises ~10k points.
        s.update(mid, mid + 10_000_000, 20 + (i % 100) / 1000, 100);
        s.hits();
      }
    }),
  );
}
{
  const s = pointSession();
  const from = BASE;
  results.push(
    benchmark(
      'CUT-GROW       100k pts, rect grows 1 pt/update ×5k',
      () => {
        for (let i = 0; i < 5_000; i += 1) {
          s.update(from, from + i * 1000, 0, 100);
          s.hits();
        }
      },
      5,
    ),
  );
}

const { ss: grid365, names: rows45 } = makeGrid(365, 45);
function heatSession(ss, G) {
  return sweep2D({
    id: 'h',
    begin: ss.begin,
    end: ss.end,
    length: ss.length,
    spanFrom: 'bins',
    materialize: (lo, hi, y0, y1) => {
      const g0 = Math.max(0, Math.floor(y0));
      const g1 = Math.min(G, Math.ceil(y1));
      const out = [];
      for (let b = lo; b < hi; b += 1) {
        for (let g = g0; g < g1; g += 1) {
          const v = ss.values[b * G + g];
          if (!Number.isFinite(v)) continue;
          out.push({
            id: 'h',
            key: ss.begin[b],
            value: v,
            color: '#abc',
            label: ss.groups[g],
          });
        }
      }
      return out;
    },
    channels: (_h, y0, y1) => ({
      rows: ss.groups.slice(
        Math.max(0, Math.floor(y0)),
        Math.min(G, Math.ceil(y1)),
      ),
    }),
  });
}
{
  const s = heatSession(grid365, 45);
  const b0 = grid365.begin[0];
  results.push(
    benchmark(
      'HEAT-CUT       365×45, rect grows 1 bin/update, all 45 rows',
      () => {
        for (let b = 1; b < 365; b += 1) {
          s.update(b0, grid365.end[b], 0, 45);
          s.hits();
        }
      },
    ),
  );
  const s1 = heatSession(grid365, 45);
  results.push(
    benchmark(
      'HEAT-CUT-1ROW  the same, ONE row tall (O(B·G′), not O(B·G))',
      () => {
        for (let b = 1; b < 365; b += 1) {
          s1.update(b0, grid365.end[b], 3, 4);
          s1.hits();
        }
      },
    ),
  );
}

// ── The repaint ────────────────────────────────────────────────────────────

const enc = encodingFor(pts);
const xs = scale(BASE, BASE + N * 1000, 1300);
const ys = scale(0, 100, 400);
const NO = [];

function scatterCase(style, selected, hovered, spans) {
  return () =>
    drawScatter(
      ctx,
      pts,
      xs,
      ys,
      style,
      enc,
      (i) => pts.x[i],
      undefined,
      { family: 'sans', size: 10 },
      selected,
      hovered,
      'v',
      0,
      false,
      spans,
    );
}

const HALF_SPAN = [
  { kind: 'span', id: 'v', x: [BASE, BASE + (N / 2) * 1000], y: [0, 100] },
];
{
  results.push(
    benchmark(
      'SC-REST-OFF    100k pts, nothing selected, states OFF',
      scatterCase(scatterStyle(false), NO, NO, NO),
      10,
    ),
    benchmark(
      'SC-REST-ON     100k pts, nothing selected, states ON  (the floor)',
      scatterCase(scatterStyle(true), NO, NO, NO),
      10,
    ),
    benchmark(
      'SC-SEL-OFF     100k pts, span over half, states OFF',
      scatterCase(scatterStyle(false), NO, NO, HALF_SPAN),
      10,
    ),
    benchmark(
      'SC-SEL-ON      100k pts, span over half, states ON  (dim + defer)',
      scatterCase(scatterStyle(true), NO, NO, HALF_SPAN),
      10,
    ),
  );
  // The live preview: the sweep lights its covered marks through the plural
  // `hovered`, so the draw's membership test runs once per visible point over
  // the WHOLE hovered set. This is the A8.1 shape, and a rect fills that set
  // faster than a band can — hence two sizes, the second deliberately past
  // what a real plot shows.
  const hovered = (n) => {
    const out = [];
    for (let i = 0; i < n; i += 1) {
      out.push({
        id: 'v',
        key: pts.x[i],
        value: pts.y[i],
        color: '#abc',
        label: 'v',
      });
    }
    return out;
  };
  results.push(
    benchmark(
      'SC-HOVER-10K   100k pts, 10k in `hovered` (a modest rect preview)',
      scatterCase(scatterStyle(true), NO, hovered(10_000), NO),
      5,
    ),
    benchmark(
      'SC-HOVER-50K   100k pts, 50k in `hovered` (the A8.1 torture case)',
      scatterCase(scatterStyle(true), NO, hovered(50_000), NO),
      3,
    ),
  );
}

const colorOf = (v) => bandedColor(v, RAMP, 2, 18, 'linear');

function heatCase(ss, style, spans) {
  const bx = scale(ss.begin[0], ss.end[ss.length - 1], 1300);
  const by = scale(0, ss.groups.length, 400);
  return () =>
    drawHeat(
      ctx,
      ss,
      bx,
      by,
      style,
      colorOf,
      'h',
      NO,
      NO,
      false,
      'vertical',
      'blank',
      spans,
    );
}

function thirdSpan(ss, rows) {
  const b1 = Math.floor(ss.length / 3);
  return [
    {
      kind: 'span',
      id: 'h',
      x: [ss.begin[0], ss.begin[b1]],
      rows: rows.slice(0, Math.ceil(rows.length / 2)),
    },
  ];
}
{
  const span = thirdSpan(grid365, rows45);
  results.push(
    benchmark(
      'HEAT-REST-OFF  365×45, nothing selected, states OFF',
      heatCase(grid365, heatStyle(false), NO),
      10,
    ),
    benchmark(
      'HEAT-REST-ON   365×45, nothing selected, states ON  (the floor)',
      heatCase(grid365, heatStyle(true), NO),
      10,
    ),
    benchmark(
      'HEAT-SEL-OFF   365×45, span over a third, states OFF',
      heatCase(grid365, heatStyle(false), span),
      10,
    ),
    benchmark(
      'HEAT-SEL-ON    365×45, span over a third, states ON  (grid+veil+edges)',
      heatCase(grid365, heatStyle(true), span),
      10,
    ),
  );
}
{
  // The heat map's live preview, the counterpart of SC-HOVER: a rect over a
  // third of the grid lights ~5.5k cells through `hovered`, and the per-bin
  // narrowing scans the WHOLE set once per bin.
  const b1 = Math.floor(365 / 3);
  const hov = [];
  for (let b = 0; b < b1; b += 1) {
    for (let g = 0; g < 23; g += 1) {
      hov.push({
        id: 'h',
        key: grid365.begin[b],
        value: grid365.values[b * 45 + g],
        color: '#abc',
        label: rows45[g],
      });
    }
  }
  const bx = scale(grid365.begin[0], grid365.end[364], 1300);
  const by = scale(0, 45, 400);
  results.push(
    benchmark(
      `HEAT-HOVER     365×45, ${hov.length} cells in \`hovered\` (rect preview)`,
      () =>
        drawHeat(
          ctx,
          grid365,
          bx,
          by,
          heatStyle(true),
          colorOf,
          'h',
          NO,
          hov,
          false,
          'vertical',
          'blank',
          NO,
        ),
      5,
    ),
  );
}
{
  const { ss, names } = makeGrid(1000, 45);
  const span = thirdSpan(ss, names);
  results.push(
    benchmark(
      'HEAT-WIDE-OFF  1000×45 (45k cells), span over a third, states OFF',
      heatCase(ss, heatStyle(false), span),
      5,
    ),
    benchmark(
      'HEAT-WIDE-ON   1000×45 (45k cells), span over a third, states ON',
      heatCase(ss, heatStyle(true), span),
      5,
    ),
  );
}

console.log(JSON.stringify(results, null, 2));
