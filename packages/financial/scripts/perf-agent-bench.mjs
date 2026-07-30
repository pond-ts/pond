// [PND-AGENTBENCH] — the two shapes an agent produces unprompted, and the
// two nobody had timed.
//
//   Q11  cross-sectional: N symbols × a rolling study × a rank ACROSS
//        symbols. "Which of my 500 names moved most unusually today?"
//   Q12  flurry: the same handful of questions re-asked, which is what a
//        session with an agent actually looks like.
//
// These decide more than a speedup. Q11 settles whether pond is the
// client or the viewer in a ClickHouse architecture: if a resident panel
// answers a flurry faster than N round trips, analytics stay here; if it
// does not, they belong in SQL and pond renders. Q12 measures whether the
// process graph's content-addressed cache — its entire reason to exist —
// pays at flurry scale, having only ever been measured on one reduction.
//
// Acceptance gate: < 100 ms per question over a 500k–1M point panel.
//
// Run:
//   npm run build --workspaces
//   node packages/financial/scripts/perf-agent-bench.mjs
//   PANEL=1000x1000 node packages/financial/scripts/perf-agent-bench.mjs

import { performance } from 'node:perf_hooks';
import { availableParallelism } from 'node:os';
import { TimeSeries } from 'pond-ts';
import { zScore } from '../dist/index.js';
import { withWorkers, shutdownWorkers } from '../dist/parallel/index.js';

const [SYMBOLS, BARS] = (process.env.PANEL ?? '500x1000')
  .split('x')
  .map(Number);
const POINTS = SYMBOLS * BARS;
const WORKERS = Number(
  process.env.PERF_WORKERS ?? Math.max(1, availableParallelism() - 2),
);
const TOP = 20;

/** One panel: N symbols × M bars, as a single series with a symbol column. */
function panel() {
  const n = POINTS;
  const time = new Float64Array(n);
  const close = new Float64Array(n);
  const symbol = new Array(n);
  let seed = 0x5eed;
  let w = 0;
  for (let s = 0; s < SYMBOLS; s += 1) {
    const name = `S${String(s).padStart(4, '0')}`;
    let price = 50 + (s % 200);
    for (let b = 0; b < BARS; b += 1) {
      seed = (seed + 0x6d2b79f5) >>> 0;
      const r = ((seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      price = Math.max(1, price + (r - 0.5) * 0.4);
      // Keys must be non-decreasing across the whole panel, so symbols
      // are laid out consecutively and time restarts per block. Partition
      // order, not calendar order — which is what `partitionBy` wants.
      time[w] = w * 60_000;
      close[w] = price;
      symbol[w] = name;
      w += 1;
    }
  }
  return TimeSeries.fromColumns({
    name: 'panel',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'close', kind: 'number' },
      { name: 'symbol', kind: 'string' },
    ],
    columns: { time, close, symbol },
  });
}

const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
function bench(fn, reps = 5, warm = 2) {
  for (let i = 0; i < warm; i += 1) fn();
  const t = [];
  for (let i = 0; i < reps; i += 1) {
    const s = performance.now();
    fn();
    t.push(performance.now() - s);
  }
  return median(t);
}

/**
 * Q11 — per-symbol rolling study, last value, rank across symbols.
 *
 * `toMap(transform)` is the natural composition: it is what the docs
 * point at and what an agent would emit for "per symbol, then compare".
 */
function crossSectional(series, period) {
  const scores = series.partitionBy('symbol').toMap((group) => {
    const z = zScore(group, { period });
    const col = z.column('zscore');
    return col.at(group.length - 1);
  });
  const ranked = [];
  for (const [sym, v] of scores) {
    if (typeof v === 'number' && Number.isFinite(v)) ranked.push([sym, v]);
  }
  ranked.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return ranked.slice(0, TOP);
}

console.log(
  `panel ${SYMBOLS} symbols × ${BARS} bars = ${POINTS.toLocaleString()} points · ` +
    `${availableParallelism()} cores · node ${process.versions.node}\n`,
);

const built = performance.now();
const series = panel();
console.log(
  `  panel build              ${(performance.now() - built).toFixed(0)} ms (setup, not measured)\n`,
);

// ── Q11 ────────────────────────────────────────────────────────────
console.log('  Q11 — cross-sectional: per-symbol zScore, rank across symbols');
console.log(`  ${'─'.repeat(66)}`);
const q11 = bench(() => crossSectional(series, 20));
console.log(
  `    single-threaded        ${q11.toFixed(1).padStart(8)} ms   ` +
    `${q11 < 100 ? '✅ under gate' : '❌ OVER 100 ms GATE'}`,
);
console.log(
  `    per symbol             ${(q11 / SYMBOLS).toFixed(3).padStart(8)} ms`,
);

// Decomposition, because "add more workers" is the wrong reflex until you
// know what fraction is even parallelisable.
const groups = [
  ...series
    .partitionBy('symbol')
    .toMap((g) => g)
    .values(),
];
const split = bench(() => series.partitionBy('symbol').toMap((g) => g));
const studies = bench(() => {
  for (const g of groups) zScore(g, { period: 20 });
});
console.log(
  `      partitionBy+toMap    ${split.toFixed(1).padStart(8)} ms   ` +
    `${((split / q11) * 100).toFixed(0)}% — SERIAL, and the surprise`,
);
console.log(
  `      ${SYMBOLS} studies         ${studies.toFixed(1).padStart(8)} ms   ` +
    `${((studies / q11) * 100).toFixed(0)}% — embarrassingly parallel`,
);
console.log(
  `      Amdahl @${WORKERS} workers   ${(split + studies / WORKERS).toFixed(1).padStart(8)} ms   ` +
    `${(q11 / (split + studies / WORKERS)).toFixed(2)}× ceiling — the split caps it\n`,
);

// Does `withWorkers` help here? Each partition is BARS rows — far below
// MIN_ROWS — so the expectation is "no", and the number says whether the
// per-series threshold is the right control for a panel.
const fast = withWorkers(series, { workers: WORKERS });
const q11w = bench(() => crossSectional(fast, 20));
shutdownWorkers();
console.log(
  `    with workers(${WORKERS})         ${q11w.toFixed(1).padStart(8)} ms   ${(q11 / q11w).toFixed(2)}×` +
    `   (each partition is ${BARS} rows — below MIN_ROWS)\n`,
);

// ── Q12 ────────────────────────────────────────────────────────────
// A realistic session: 21 questions drawn from 7 distinct ones. The
// question is what repetition is worth — which is the cache's whole
// premise, and the reason the process graph exists.
const PERIODS = [5, 10, 21, 42, 63, 126, 252];
const FLURRY = Array.from(
  { length: 21 },
  (_, i) => PERIODS[i % PERIODS.length],
);

console.log('  Q12 — flurry: 21 questions drawn from 7 distinct');
console.log(`  ${'─'.repeat(66)}`);

const one = series
  .partitionBy('symbol')
  .toMap((g) => g)
  .values()
  .next().value;
const cold = bench(
  () => {
    for (const p of FLURRY) zScore(one, { period: p });
  },
  3,
  1,
);
const distinct = bench(
  () => {
    for (const p of PERIODS) zScore(one, { period: p });
  },
  3,
  1,
);
console.log(`    21 questions, recomputed  ${cold.toFixed(1).padStart(8)} ms`);
console.log(
  `    7 distinct only           ${distinct.toFixed(1).padStart(8)} ms`,
);
console.log(
  `    → repetition is ${(((cold - distinct) / cold) * 100).toFixed(0)}% of the work a cache could remove\n`,
);

// The same flurry across the whole panel — the actual agent shape.
const panelFlurry = bench(
  () => {
    for (const p of PERIODS) crossSectional(series, p);
  },
  3,
  1,
);
console.log(
  `    7 cross-sectional passes  ${panelFlurry.toFixed(1).padStart(8)} ms   ` +
    `(${(panelFlurry / 7).toFixed(1)} ms per question ` +
    `${panelFlurry / 7 < 100 ? '✅ under gate' : '❌ over gate'})`,
);
console.log(
  `      The gate is per QUESTION, not per session: an agent asking seven\n` +
    `      things waits ${(panelFlurry / 7).toFixed(0)} ms each, not ${panelFlurry.toFixed(0)} ms for the set.\n`,
);

// ── the architectural read ────────────────────────────────────────
console.log(`  ${'═'.repeat(66)}`);
console.log('  Client or viewer?');
console.log(
  `    A resident panel answers one cross-sectional question in ${q11.toFixed(0)} ms.\n` +
    `    A ClickHouse round trip is ~20–50 ms of network and query even when\n` +
    `    the answer is small. So a ${PERIODS.length}-question flurry is ~${(PERIODS.length * 20).toFixed(0)}–${(PERIODS.length * 50).toFixed(0)} ms\n` +
    `    of round trips against ${panelFlurry.toFixed(0)} ms resident.`,
);
console.log(
  `    (Round-trip figure is a stated assumption, not measured here —\n` +
    `     no cluster. The resident number is measured.)`,
);
