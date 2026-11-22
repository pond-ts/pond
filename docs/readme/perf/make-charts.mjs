// Draws the performance figures in the README as SVG, one light and one dark
// file per figure. No dependencies:
//
//   node docs/readme/perf/make-charts.mjs
//
// Every number below is copied from the page named beside it. When a benchmark
// page changes, change the number here and run this again.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

// website/docs/reference/charts-benchmarks.mdx (first paint) and
// website/docs/reference/charts-scale-benchmarks.mdx (frames per second).
const CHARTS = [
  {
    title: 'First paint of 166,650 points',
    unit: 'milliseconds, lower is better',
    rows: [
      ['pond', 11.4],
      ['uPlot', 14.5],
      ['Chart.js', 36.4],
    ],
  },
  {
    title: 'Area chart of 10 million points',
    unit: 'frames a second, higher is better',
    rows: [
      ['pond', 117],
      ['SciChart (GPU)', 119],
      ['uPlot', 18],
    ],
  },
  {
    title: '100,000 points changing every frame',
    unit: 'frames a second, higher is better',
    rows: [
      ['pond', 18],
      ['SciChart (GPU)', 119],
      ['uPlot', 37],
    ],
  },
];

// website/docs/reference/benchmarks.mdx, 500,000 rows, 30 July 2026.
// Each value is pond-ts's time divided by the other library's time for the
// same query: below 1 pond-ts is faster, above 1 it is slower.
const POND_TS = [
  {
    title: 'pond-ts against pandas',
    rows: [
      ['ema', 0.59],
      ['mean', 0.65],
      ['median', 0.88],
      ['five studies', 1.28],
      ['bollinger', 1.4],
      ['envelope', 1.85],
    ],
  },
  {
    title: 'pond-ts against polars on one core',
    rows: [
      ['ema', 0.32],
      ['bollinger', 0.53],
      ['five studies', 0.85],
      ['sma', 1.2],
      ['mean', 3.82],
      ['stdev', 8.93],
    ],
    extra: ['five studies, polars on 10 cores', 3.49],
  },
];

// crates/pond-rs/bench/COMPARISON.md, 22 October 2026.
const POND_RS = {
  hero: '7.5×',
  heroLabel: ['median speed-up', 'over pond-ts, 4 cores'],
  bars: [
    {
      title: 'Against pond-ts: faster in 170 of 173 cases',
      parts: { faster: 170, level: 0, slower: 3 },
    },
    {
      title:
        'Against polars, 4 cores each: faster in 73 cases, level in 9, slower in 59',
      parts: { faster: 73, level: 9, slower: 59 },
    },
  ],
};

// ---------------------------------------------------------------------------
// Colours. The background is transparent, so each set is chosen for the page
// it sits on: GitHub's white, and GitHub's dark #0d1117.
// ---------------------------------------------------------------------------

const THEMES = {
  light: {
    ink: '#0b0b0b',
    ink2: '#52514e',
    muted: '#76746e',
    rule: '#c3c2b7',
    blue: '#2a78d6',
    red: '#e34948',
    grey: '#b9b7ae',
    surface: '#ffffff',
  },
  dark: {
    ink: '#f0efec',
    ink2: '#c3c2b7',
    muted: '#9a988f',
    rule: '#3d3d3a',
    blue: '#3987e5',
    red: '#e66767',
    grey: '#55544f',
    surface: '#0d1117',
  },
};

const FONT =
  'system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif';
const W = 800;

// ---------------------------------------------------------------------------
// Small SVG helpers
// ---------------------------------------------------------------------------

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function text(x, y, s, { size = 13, fill, anchor = 'start', weight = 400 }) {
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" text-anchor="${anchor}" font-weight="${weight}">${esc(s)}</text>`;
}

// A bar growing right from x (w > 0) or left from x (w < 0): square where it
// meets the baseline, rounded at the far end.
function bar(x, y, w, h, fill) {
  const r = Math.min(4, Math.abs(w));
  if (w >= 0) {
    return `<path d="M${x},${y} h${w - r} a${r},${r} 0 0 1 ${r},${r} v${h - 2 * r} a${r},${r} 0 0 1 ${-r},${r} h${-(w - r)} z" fill="${fill}"/>`;
  }
  const a = -w;
  return `<path d="M${x},${y} h${-(a - r)} a${r},${r} 0 0 0 ${-r},${r} v${h - 2 * r} a${r},${r} 0 0 0 ${r},${r} h${a - r} z" fill="${fill}"/>`;
}

function svg(height, label, body) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${height}" width="${W}" height="${height}" font-family='${FONT}' role="img" aria-label="${esc(label)}">\n` +
    body.join('\n') +
    '\n</svg>\n'
  );
}

// ---------------------------------------------------------------------------
// Figure 1: the charts. Three small panels, pond in blue, the others in grey.
// ---------------------------------------------------------------------------

function chartsFigure(t) {
  const out = [];
  const panelW = 256;
  const gap = 16;
  const nameW = 104;
  const barMax = 96;
  const rowH = 30;
  const top = 58;
  CHARTS.forEach((p, i) => {
    const x0 = i * (panelW + gap);
    out.push(text(x0, 18, p.title, { fill: t.ink, weight: 600 }));
    out.push(text(x0, 37, p.unit, { size: 12, fill: t.muted }));
    const max = Math.max(...p.rows.map((r) => r[1]));
    p.rows.forEach(([name, v], j) => {
      const y = top + j * rowH;
      const w = Math.max(2, (v / max) * barMax);
      const isPond = name === 'pond';
      out.push(
        text(x0, y + 13, name, {
          size: 12.5,
          fill: isPond ? t.ink : t.ink2,
          weight: isPond ? 600 : 400,
        }),
      );
      out.push(bar(x0 + nameW, y, w, 18, isPond ? t.blue : t.grey));
      out.push(
        text(x0 + nameW + w + 7, y + 13, String(v), {
          size: 12.5,
          fill: isPond ? t.ink : t.ink2,
          weight: isPond ? 600 : 400,
        }),
      );
    });
    out.push(
      `<line x1="${x0 + nameW}" y1="${top - 6}" x2="${x0 + nameW}" y2="${top + 3 * rowH - 6}" stroke="${t.rule}" stroke-width="1"/>`,
    );
  });
  const label = CHARTS.map(
    (p) =>
      `${p.title} (${p.unit}): ` +
      p.rows.map((r) => `${r[0]} ${r[1]}`).join(', '),
  ).join('. ');
  return svg(top + 3 * rowH, label, out);
}

// ---------------------------------------------------------------------------
// Figure 2: pond-ts against pandas and polars. Bars grow left of the centre
// line where pond-ts is faster and right where it is slower, on a log scale so
// that "twice as fast" and "twice as slow" are the same length.
// ---------------------------------------------------------------------------

function times(v) {
  const f = v < 1 ? 1 / v : v;
  return (f >= 10 ? f.toFixed(0) : f.toFixed(1)) + '×';
}

function pondTsFigure(t) {
  const out = [];
  const panelW = 392;
  const gap = 16;
  const nameW = 96;
  const half = 108; // pixels for a factor of 10
  const rowH = 26;
  const top = 62;
  let height = 0;
  POND_TS.forEach((p, i) => {
    const x0 = i * (panelW + gap);
    const cx = x0 + nameW + half + 34;
    out.push(text(x0, 18, p.title, { fill: t.ink, weight: 600 }));
    out.push(
      text(cx - 8, 42, '← faster', { size: 12, fill: t.muted, anchor: 'end' }),
    );
    out.push(text(cx + 8, 42, 'slower →', { size: 12, fill: t.muted }));
    const rows = [...p.rows];
    rows.forEach(([name, v], j) => {
      const y = top + j * rowH;
      const len = Math.max(2, Math.abs(Math.log10(v)) * half);
      const faster = v < 1;
      out.push(text(x0, y + 12, name, { size: 12.5, fill: t.ink2 }));
      out.push(bar(cx, y, faster ? -len : len, 16, faster ? t.blue : t.red));
      out.push(
        text(faster ? cx - len - 6 : cx + len + 6, y + 12, times(v), {
          size: 12.5,
          fill: t.ink,
          anchor: faster ? 'end' : 'start',
        }),
      );
    });
    let bottom = top + rows.length * rowH;
    out.push(
      `<line x1="${cx}" y1="${top - 8}" x2="${cx}" y2="${bottom - 4}" stroke="${t.rule}" stroke-width="1"/>`,
    );
    if (p.extra) {
      const [name, v] = p.extra;
      const y = bottom + 26;
      const len = Math.log10(v) * half;
      out.push(text(x0, y - 8, name, { size: 12.5, fill: t.ink2 }));
      out.push(
        `<line x1="${cx}" y1="${y - 2}" x2="${cx}" y2="${y + 18}" stroke="${t.rule}" stroke-width="1"/>`,
      );
      out.push(bar(cx, y, len, 16, t.red));
      out.push(
        text(cx + len + 6, y + 12, times(v), { size: 12.5, fill: t.ink }),
      );
      bottom = y + 22;
    }
    height = Math.max(height, bottom);
  });
  const label = POND_TS.map(
    (p) =>
      `${p.title}: ` +
      [...p.rows, ...(p.extra ? [p.extra] : [])]
        .map((r) => `${r[0]} ${times(r[1])} ${r[1] < 1 ? 'faster' : 'slower'}`)
        .join(', '),
  ).join('. ');
  return svg(height + 4, label, out);
}

// ---------------------------------------------------------------------------
// Figure 3: pond-rs. One headline number, and two bars that split the cases
// into faster, level and slower.
// ---------------------------------------------------------------------------

function pondRsFigure(t) {
  const out = [];
  const heroW = 200;
  const x0 = heroW;
  const barW = W - heroW;
  const barH = 28;
  out.push(text(0, 62, POND_RS.hero, { size: 64, fill: t.ink, weight: 600 }));
  POND_RS.heroLabel.forEach((s, i) =>
    out.push(text(2, 88 + i * 17, s, { size: 12.5, fill: t.ink2 })),
  );
  const colour = { faster: t.blue, level: t.grey, slower: t.red };
  POND_RS.bars.forEach((b, i) => {
    const y = 26 + i * 68;
    out.push(
      text(x0, y - 9, b.title, { size: 12.5, fill: t.ink, weight: 600 }),
    );
    const total = b.parts.faster + b.parts.level + b.parts.slower;
    const keys = ['faster', 'level', 'slower'].filter((k) => b.parts[k] > 0);
    const gaps = (keys.length - 1) * 2;
    let x = x0;
    keys.forEach((k) => {
      const w = (b.parts[k] / total) * (barW - gaps);
      out.push(
        `<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${barH}" rx="4" fill="${colour[k]}"/>`,
      );
      const s = String(b.parts[k]);
      if (w > s.length * 8 + 14) {
        out.push(
          text(x + 8, y + 19, s, {
            size: 13,
            fill: k === 'level' && t === THEMES.light ? '#0b0b0b' : '#ffffff',
            weight: 600,
          }),
        );
      }
      x += w + 2;
    });
  });
  // Legend.
  const ly = 26 + 2 * 68 - 6;
  let lx = x0;
  [
    ['faster', 'pond-rs faster'],
    ['level', 'level'],
    ['slower', 'pond-rs slower'],
  ].forEach(([k, s]) => {
    out.push(
      `<rect x="${lx}" y="${ly}" width="12" height="12" rx="3" fill="${colour[k]}"/>`,
    );
    out.push(text(lx + 18, ly + 10.5, s, { size: 12.5, fill: t.ink2 }));
    lx += 18 + s.length * 6.6 + 26;
  });
  const label =
    `pond-rs: ${POND_RS.hero} ${POND_RS.heroLabel.join(' ')}. ` +
    POND_RS.bars.map((b) => b.title).join('. ');
  return svg(ly + 16, label, out);
}

// ---------------------------------------------------------------------------

const FIGURES = {
  'perf-charts': chartsFigure,
  'perf-pond-ts': pondTsFigure,
  'perf-pond-rs': pondRsFigure,
};

for (const [name, draw] of Object.entries(FIGURES)) {
  for (const [mode, theme] of Object.entries(THEMES)) {
    const file = join(OUT, `${name}-${mode}.svg`);
    writeFileSync(file, draw(theme));
    console.log('wrote', file);
  }
}
