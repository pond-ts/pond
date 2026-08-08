// Perf bench for the <MultiSelector> sweep (interaction RFC §8 / A7.6/A7.7)
// — the per-pointermove work the gesture adds, measured at large N.
//
// COMPLEXITY. Per coalesced frame of a live sweep:
//
//   re-cut      O(log N)      two binary searches over the layer's sorted
//                             begin/end (sweep1D.update); an unchanged
//                             covered set stops here (the delta gate).
//   materialise O(C)          only when the covered set changed — C covered
//                             marks into SelectInfos, cached until the next
//                             change (so release is O(1): the commit payload
//                             IS the cached preview, RFC A5.2).
//   repaint     O(V·C)        the honest term: the preview lights through
//                             plural `hovered`, and the bar draw's membership
//                             scan is linear over the hovered set per visible
//                             bar (barMatchesAny — "a selection is a handful
//                             of marks", which a sweep preview is NOT). V is
//                             view-scale (≲2·plotWidth before M4 column
//                             decimation engages, and the decimated envelope
//                             path skips per-bar highlight entirely), but the
//                             quadratic shape must be MEASURED at the largest
//                             non-decimated density, not assumed away — a
//                             recent heat-map change measured +41% on a path
//                             that "looked free" at small sizes.
//
//   Consumers who never sweep pay zero: no session exists outside a drag, no
//   new branch on the draw path, no memory (A7.7).
//
// Scenarios:
//
//   CUT-NOCHANGE   100k bars, 10k update() calls that never cross a mark —
//                  the per-pointermove floor (pure re-cut, delta-gated).
//   CUT-GROW       100k bars, a sweep extending one bar per update across
//                  50k bars — re-cut + O(C) re-materialisation per step.
//                  This is deliberately the WORST materialisation cadence
//                  (every step changes the set); real gestures coalesce to
//                  one step per frame.
//   COMMIT         the release path after a 50k sweep: hits() must be the
//                  cached array (O(1)), benched against a fresh materialise.
//   DRAW-REST      2,600 visible bars (max non-decimated density at ~1300px),
//                  empty hover — the repaint floor.
//   DRAW-PREVIEW   the same 2,600 bars with ALL of them in the hovered set —
//                  the O(V·C) worst case the live preview can create.
//   DRAW-P-10K     10k bars, all hovered, decimation forced OFF — the torture
//                  case past realistic density, to expose the quadratic shape.
//   DRAW-P-100K    100k bars, all hovered, decimation forced OFF — the case
//                  that measured 6.2 SECONDS per frame on the linear scan and
//                  motivated the set index (a decimate={false} consumer can
//                  reach it for real).
//   DRAW-DECIMATED 100k bars, 100k hovered, decimation ON — the envelope path
//                  must stay at its floor (per-bar highlight is suppressed).
//
// Run: node scripts/perf-multiselect.mjs   (build first: npm run build)

import { performance } from 'node:perf_hooks';
import { TimeSeries } from 'pond-ts';
import { barsFromTimeSeries } from '../dist/data.js';
import { drawBars } from '../dist/bars.js';
import { sweep1D } from '../dist/sweep.js';

const BASE = 1.7e12;

const barStyle = {
  fill: '#abc',
  opacity: 0.85,
  highlight: '#fff',
  gap: 0,
  minWidth: 1,
  outlineWidth: 2,
};

function makeSeries(n, stepMs = 1000) {
  const rows = new Array(n);
  for (let i = 0; i < n; i += 1) {
    rows[i] = [BASE + i * stepMs, 50 + 35 * Math.sin(i / 5_000)];
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

function scale(d0, d1, width) {
  const f = (v) => ((v - d0) / (d1 - d0)) * width;
  f.domain = () => [d0, d1];
  f.range = () => [0, width];
  // Real chart scales invert; without this the M4 envelope path silently
  // declines (`scaleInvert` returns null) and "decimated" cases measure the
  // full per-bar loop instead.
  f.invert = (px) => d0 + (px / width) * (d1 - d0);
  return f;
}

function stubContext(widthPx = 1300) {
  const noop = () => {};
  // `canvas.width` must be real: the M4 density gate reads it
  // (`deviceBucketCount`), and a stub without it silently disables
  // decimation — which is how the first run of this bench measured the
  // undecimated path while labelled "decimation ON".
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

/** A sweep session over a BarSeries, materialising the same SelectInfos the
 *  BarChart layer does (id/key/value/color/label). */
function sessionOver(bs) {
  return sweep1D({
    id: 'v',
    begin: bs.begin,
    end: bs.end,
    length: bs.length,
    selectable: (i) => Number.isFinite(bs.y[i]),
    materialize: (lo, hi) => {
      const out = [];
      for (let i = lo; i < hi; i += 1) {
        const v = bs.y[i];
        if (!Number.isFinite(v)) continue;
        out.push({
          id: 'v',
          key: bs.begin[i],
          value: v,
          color: '#abc',
          label: 'v',
        });
      }
      return out;
    },
  });
}

const results = [];
const ctx = stubContext();
const N = 100_000;
const big = barsFromTimeSeries(makeSeries(N), 'v');

// ── The session: re-cut floor and growth cadence ───────────────────────────
{
  const s = sessionOver(big);
  const mid = BASE + (N / 2) * 1000;
  s.update(mid, mid + 10_000 * 1000);
  s.hits();
  results.push(
    benchmark('CUT-NOCHANGE 100k bars, 10k gated re-cuts', () => {
      for (let i = 0; i < 10_000; i += 1) {
        // Wiggle inside the same covered set — the delta gate must hold.
        s.update(mid + (i % 500), mid + 10_000 * 1000 + (i % 500));
        s.hits();
      }
    }),
  );

  results.push(
    benchmark(
      'CUT-GROW     100k bars, sweep across 50k in 500 frames',
      () => {
        const g = sessionOver(big);
        const from = BASE + 1000;
        for (let i = 1; i <= 500; i += 1) {
          g.update(from, from + i * 100 * 1000); // +100 bars per frame
          g.hits();
        }
      },
      10,
    ),
  );

  const done = sessionOver(big);
  done.update(BASE, BASE + 50_000 * 1000);
  done.hits(); // materialised once — the live preview did this already
  results.push(
    benchmark('COMMIT       release after a 50k sweep (cached hits)', () => {
      done.hits();
      done.extent();
    }),
  );
  results.push(
    benchmark(
      'COMMIT-FRESH the same release as a fresh range query (what A7.7 forbids)',
      () => {
        const f = sessionOver(big);
        f.update(BASE, BASE + 50_000 * 1000);
        f.hits();
      },
      10,
    ),
  );
}

// ── The repaint: the O(V·C) preview term ────────────────────────────────────
function drawCase(bs, hovered, decimate) {
  const xScale = scale(bs.begin[0], bs.end[bs.length - 1], 1300);
  const yScale = scale(0, 100, 400);
  return () =>
    drawBars(
      ctx,
      bs,
      xScale,
      yScale,
      barStyle,
      0,
      0,
      'v',
      [],
      hovered,
      decimate,
    );
}
{
  const dense = barsFromTimeSeries(makeSeries(2_600), 'v');
  const s = sessionOver(dense);
  s.update(dense.begin[0], dense.end[dense.length - 1]);
  const allHits = s.hits();
  results.push(
    benchmark(
      'DRAW-REST     2.6k visible bars, no hover',
      drawCase(dense, [], false),
    ),
  );
  results.push(
    benchmark(
      'DRAW-PREVIEW  2.6k visible bars, ALL 2.6k hovered (worst preview)',
      drawCase(dense, allHits, false),
    ),
  );
}
{
  const torture = barsFromTimeSeries(makeSeries(10_000), 'v');
  const s = sessionOver(torture);
  s.update(torture.begin[0], torture.end[torture.length - 1]);
  results.push(
    benchmark(
      'DRAW-P-10K    10k bars all hovered, decimation OFF (torture)',
      drawCase(torture, s.hits(), false),
      10,
    ),
  );
}
{
  const s = sessionOver(big);
  s.update(big.begin[0], big.end[big.length - 1]);
  results.push(
    benchmark(
      'DRAW-P-100K   100k bars all hovered, decimation OFF (the 6.2s case)',
      drawCase(big, s.hits(), false),
      10,
    ),
  );
}
{
  const s = sessionOver(big);
  s.update(big.begin[0], big.end[big.length - 1]);
  results.push(
    benchmark(
      'DRAW-DECIMATED 100k bars all hovered, decimation ON (envelope floor)',
      drawCase(big, s.hits(), true),
      10,
    ),
  );
  results.push(
    benchmark(
      'DRAW-DEC-REST  100k bars no hover, decimation ON (the same floor)',
      drawCase(big, [], true),
      10,
    ),
  );
}

console.log(JSON.stringify(results, null, 2));
