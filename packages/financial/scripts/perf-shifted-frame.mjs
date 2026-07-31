// [PND-SHIFTFRAME] — what the numerically-stable `zScore` costs.
//
// `rollingDeviationSd` replaces "one sweep, then `v − mean`" with a sweep
// in a shifted frame plus a periodic O(period) state rebuild. Two things
// need measuring: the steady-state overhead of carrying the shift, and
// the amortised cost of the rebuilds — which is the part that could have
// been quadratic (see the rate limit in the kernel).
//
// Complexity: O(N) for the sweep + O(period) per rebuild, rebuilding once
// per `period` rows — so the rebuild term is exactly one extra
// accumulation per row and the whole kernel is O(N), independent of
// `period`. The sweep below is the test of that claim: flat is the pass,
// and it goes to 100k because a Codex pass broke an earlier version that
// was flat to 1024 and 11x worse at 100k (a fixed 1024-row rebuild
// interval makes the cost O(N + N*period/1024)).
//
// Run: node packages/financial/scripts/perf-shifted-frame.mjs

import { performance } from 'node:perf_hooks';
import { TimeSeries } from 'pond-ts';
import { zScore, sma } from '../dist/index.js';

const N = Number(process.env.ROWS ?? 500_000);
let lastClose;
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

function series(gen) {
  const time = new Float64Array(N),
    close = new Float64Array(N);
  lastClose = close;
  for (let i = 0; i < N; i += 1) {
    time[i] = i * 60_000;
    close[i] = gen(i);
  }
  return TimeSeries.fromColumns({
    name: 'x',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'close', kind: 'number' },
    ],
    columns: { time, close },
  });
}
// The PREVIOUS formulation, transcribed: one rolling sweep of Welford over
// raw values, consumed as `(v[i] − mean[i]) / sd[i]`. Same work the study
// used to do, so the gap to `zScore` is the price of the fix.
function legacyZ(v, p) {
  const n = v.length,
    z = new Float64Array(n).fill(NaN);
  let wN = 0,
    wMean = 0,
    wM2 = 0;
  for (let i = 0; i < n; i += 1) {
    const x = v[i];
    wN += 1;
    const d = x - wMean;
    wMean += d / wN;
    wM2 += d * (x - wMean);
    if (i >= p) {
      const o = v[i - p],
        meanWith = wMean;
      wN -= 1;
      if (wN === 1) {
        wMean = meanWith * 2 - o;
        wM2 = 0;
      } else {
        wMean = meanWith - (o - meanWith) / wN;
        wM2 -= (o - wMean) * (o - meanWith);
        if (wM2 < 0) wM2 = 0;
      }
    }
    if (i >= p - 1) {
      const sd = Math.sqrt(wM2 / wN);
      z[i] = sd === 0 ? NaN : (x - wMean) / sd;
    }
  }
  return z;
}

function bench(fn, reps = 7, warm = 3) {
  for (let i = 0; i < warm; i += 1) fn();
  const t = [];
  for (let i = 0; i < reps; i += 1) {
    const s = performance.now();
    fn();
    t.push(performance.now() - s);
  }
  return median(t);
}

let px = 100;
const walk = series(() => (px = Math.max(1, px + Math.sin(px * 7919) * 0.4)));
// σ ≈ 0 but non-zero, with the value moving every row: the shape that
// would fire the magnitude trigger on every row if it were not rate-limited.
const walkClose = lastClose;
const tiny = series((i) => 1e6 + i * 1e-9);

// Warm BOTH kernels and let the heap settle before anything is measured.
// Without this the first measured call reads ~60% high and the same call
// repeated later reads correctly — a warm-heap artifact that would have
// been reported as the cost of the shift.
const raw = walkClose;
for (let i = 0; i < 4; i += 1) {
  sma(walk, { period: 20 });
  zScore(walk, { period: 20 });
  zScore(tiny, { period: 252 });
  legacyZ(raw, 20);
}

console.log(`${N.toLocaleString()} rows · node ${process.versions.node}\n`);

// `sma` is the reference for an unshifted single-sweep rolling study over
// the same data — the cost of the shift is the gap between them.
const base = bench(() => sma(walk, { period: 20 }));
console.log(
  `  sma(20)              ${base.toFixed(1).padStart(7)} ms   one unshifted sweep, mean only — for scale`,
);
const legacy = bench(() => legacyZ(raw, 20));
console.log(
  `  zScore(20) previous  ${legacy.toFixed(1).padStart(7)} ms   raw-frame sweep, transcribed`,
);
const z20 = bench(() => zScore(walk, { period: 20 }));
console.log(
  `  zScore(20) shifted   ${z20.toFixed(1).padStart(7)} ms   ${(z20 / legacy).toFixed(2)}× the previous formulation`,
);
console.log(`
    Read that ratio as an UPPER bound: the transcribed baseline is a bare
    loop over a Float64Array, while \`zScore\` also reads the column and
    builds the result series. \`sma\` carries that same plumbing for a
    mean-only study, and the shifted \`zScore\` — mean AND σ AND a divide —
    lands at ${(z20 / base).toFixed(2)}× it. The shift itself is cheap; it is the same
    number of flops on smaller operands.
`);

console.log('  period sweep — the O(N)-independent-of-period claim');
console.log(`  ${'─'.repeat(56)}`);
for (const p of [2, 5, 20, 63, 252, 1024, 10_000, 100_000]) {
  const t = bench(() => zScore(walk, { period: p }));
  console.log(
    `    period ${String(p).padStart(4)}       ${t.toFixed(1).padStart(7)} ms   ${((t / N) * 1e6).toFixed(1)} ns/row`,
  );
}

console.log(
  '\n  tiny-σ series — the rate limit, without which this is O(N·period)',
);
console.log(`  ${'─'.repeat(56)}`);
for (const p of [20, 252]) {
  const t = bench(() => zScore(tiny, { period: p }));
  console.log(
    `    period ${String(p).padStart(4)}       ${t.toFixed(1).padStart(7)} ms   ${((t / N) * 1e6).toFixed(1)} ns/row`,
  );
}
