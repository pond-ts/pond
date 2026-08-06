// Perf bench for threshold banding ([PND-BANDBAR2]) — one bar coloured along
// its length against a ladder, replacing the N-overlaid-layers overpaint
// recipe.
//
// COMPLEXITY. The flat path is O(V) over visible bars: one `barSpanPx` (two
// scale calls) + one `fillRect` each. Banding makes it O(V·K) for a K-band
// ladder: the bin span is still computed once per bar, but each band costs a
// clip test, two scale calls and a `fillRect`. K is a small constant a caller
// writes by hand — 3 for the ok/warn/alarm ladder this exists for — and bands
// the bar never reaches exit before the scale calls, so a short bar on a long
// ladder is cheaper than the worst case.
//
// The clip test is `bandSpanInto`, which writes to module scratch rather than
// returning a tuple. That is not premature: the first cut returned `[lo, hi]`,
// and K tuples per bar per frame was the difference between banding measuring
// ~44% CHEAPER than the workaround below and ~44% DEARER than it.
//
// The comparison that matters is NOT flat-vs-banded (banding draws strictly
// more rects — of course it costs more). It is BANDED vs the WORKAROUND it
// replaces. Two arms, because they bracket the truth and the first one flatters
// the workaround badly:
//
//   - WORKAROUND-BARE: K `drawBars` passes over the same series. This is NOT
//     the real workaround — it draws K full-height bars rather than K clipped
//     ones — but it is the floor on what K passes can cost, so it is the
//     honest worst case for banding.
//   - WORKAROUND-REAL: K passes, each over a series whose values are clipped
//     to that band (`min(t_k, |v|)`), which is the work a consumer actually
//     does. On a live chart the values change every frame, so this clipping is
//     per-render, not amortized.
//
// Neither arm charges the workaround for the K× React layer registration, K×
// culling, K× hit-test registration or K legend rows — all of which are real,
// and none of which a no-op-context bench can see. So even WORKAROUND-REAL
// understates it.
//
// Also measured: the ladder must be FREE when unused, since every existing bar
// chart now runs through a path that knows about it.
//
// Run: node scripts/perf-bandbar.mjs   (build first: npm run build)

import { performance } from 'node:perf_hooks';
import { scaleLinear } from 'd3-scale';
import { drawBars, drawStacks } from '../dist/bars.js';

const style = {
  fill: '#abc',
  opacity: 0.85,
  highlight: '#fff',
  gap: 0,
  minWidth: 1,
  outlineWidth: 2,
};

const LADDER = { thresholds: [1, 2], colors: ['#0a0', '#fa0', '#f00'] };

/** `n` unit bars over [0, n], values sweeping the whole ladder and past it. */
function makeBars(n) {
  const begin = new Float64Array(n);
  const end = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    begin[i] = i;
    end[i] = i + 1;
    // Deterministic sweep across [0, 3] so every band gets exercised, including
    // the truncated-band and never-reached cases.
    y[i] = 1.5 + Math.sin(i / 997) * 1.5;
  }
  return { begin, end, y, length: n };
}

/**
 * The overpaint workaround's per-layer data prep: band `k`'s layer draws the
 * value clipped to that band's ceiling, so the outermost layer is overpainted
 * by each inner one. A live chart redoes this every frame.
 */
function clipTo(bars, k) {
  const ceiling =
    k < LADDER.thresholds.length ? LADDER.thresholds[k] : Infinity;
  const y = new Float64Array(bars.length);
  for (let i = 0; i < bars.length; i += 1) {
    const v = bars.y[i];
    const m = v < 0 ? -v : v;
    y[i] = (v < 0 ? -1 : 1) * (m < ceiling ? m : ceiling);
  }
  return { begin: bars.begin, end: bars.end, y, length: bars.length };
}

/** The same values as a one-group stack — the `categories` / horizontal path. */
function makeStack(n) {
  const b = makeBars(n);
  return {
    begin: b.begin,
    end: b.end,
    values: b.y,
    groups: ['v'],
    length: n,
  };
}

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
const W = PLOT_WIDTH_CSS * 2;
const stackStyle = { fills: ['#abc'], opacity: 0.85, outlineWidth: 2 };
const results = [];

// ── 1. Categorical scale — what this feature is actually for. ───────────────
// A threshold ladder lives on a category chart: tens of bars, not millions.
for (const n of [8, 50, 400]) {
  const bars = makeBars(n);
  const x = scale(0, n, PLOT_WIDTH_CSS);
  const y = scale(0, 4, 400);
  const ctx = sizedCtx(W);
  results.push(
    benchmark(`cat n=${n} FLAT`, () =>
      drawBars(ctx, bars, x, y, style, 0, 0, 'c', null, null, false),
    ),
  );
  results.push(
    benchmark(`cat n=${n} BANDED (K=3, one pass)`, () =>
      drawBars(
        ctx,
        bars,
        x,
        y,
        style,
        0,
        0,
        'c',
        null,
        null,
        false,
        undefined,
        LADDER,
      ),
    ),
  );
  results.push(
    benchmark(`cat n=${n} WORKAROUND-BARE (K=3 passes)`, () => {
      for (let k = 0; k < 3; k += 1) {
        drawBars(ctx, bars, x, y, style, 0, 0, 'c', null, null, false);
      }
    }),
  );
  results.push(
    benchmark(`cat n=${n} WORKAROUND-REAL (K=3 clipped)`, () => {
      for (let k = 0; k < 3; k += 1) {
        drawBars(
          ctx,
          clipTo(bars, k),
          x,
          y,
          style,
          0,
          0,
          'c',
          null,
          null,
          false,
        );
      }
    }),
  );
}

// ── 2. The unused-ladder floor: banding must cost nothing when absent. ──────
for (const n of [100_000]) {
  const bars = makeBars(n);
  const x = scale(0, n, PLOT_WIDTH_CSS);
  const y = scale(0, 4, 400);
  const ctx = sizedCtx(W);
  results.push(
    benchmark(`floor n=${n} no ladder, decimation ON`, () =>
      drawBars(ctx, bars, x, y, style, 0, 0, 'c', null, null, true),
    ),
  );
  results.push(
    benchmark(`floor n=${n} no ladder, decimation OFF`, () =>
      drawBars(ctx, bars, x, y, style, 0, 0, 'c', null, null, false),
    ),
  );
  results.push(
    benchmark(`floor n=${n} BANDED (decimation suppressed)`, () =>
      drawBars(
        ctx,
        bars,
        x,
        y,
        style,
        0,
        0,
        'c',
        null,
        null,
        true,
        undefined,
        LADDER,
      ),
    ),
  );
}

// ── 3. The stacked path — `categories` and every horizontal bar. ────────────
for (const n of [8, 400]) {
  const ss = makeStack(n);
  const x = scale(0, n, PLOT_WIDTH_CSS);
  const y = scale(0, 4, 400);
  const ctx = sizedCtx(W);
  for (const orientation of ['vertical', 'horizontal']) {
    results.push(
      benchmark(`stack ${orientation} n=${n} FLAT`, () =>
        drawStacks(
          ctx,
          ss,
          orientation,
          x,
          y,
          stackStyle,
          0,
          1,
          'c',
          null,
          null,
        ),
      ),
    );
    results.push(
      benchmark(`stack ${orientation} n=${n} BANDED`, () =>
        drawStacks(
          ctx,
          ss,
          orientation,
          x,
          y,
          stackStyle,
          0,
          1,
          'c',
          null,
          null,
          LADDER,
        ),
      ),
    );
  }
}

function scale(d0, d1, widthCss) {
  return scaleLinear().domain([d0, d1]).range([0, widthCss]);
}

console.log(
  JSON.stringify(
    { plotWidthCss: PLOT_WIDTH_CSS, W, ladder: LADDER, results },
    null,
    2,
  ),
);
