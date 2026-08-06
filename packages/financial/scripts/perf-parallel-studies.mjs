// `withWorkers` across the rolling studies — [PND-SCANKERN].
//
// Reports **speed and agreement together**. The parallel path changes
// the answer slightly, by different amounts per study, so a speedup
// printed without the accompanying error is a number nobody should act
// on — and `zScore`'s error is the reason the opt-in is documented
// rather than defaulted.
//
// Run:
//   npm run build --workspaces
//   node packages/financial/scripts/perf-parallel-studies.mjs

import { performance } from 'node:perf_hooks';
import { availableParallelism } from 'node:os';
import { TimeSeries } from 'pond-ts';
import { bollinger, envelope, sma, zScore } from '../dist/index.js';
import {
  withWorkers,
  shutdownWorkers,
  MIN_ROWS,
} from '../dist/parallel/index.js';

const N = Number(process.env.PERF_ROWS ?? 500_000);
const P = 20;
const WORKERS = Number(
  process.env.PERF_WORKERS ?? Math.max(1, availableParallelism() - 2),
);

function bars(n) {
  const time = new Float64Array(n);
  const close = new Float64Array(n);
  let price = 100;
  let seed = 0x5eed;
  for (let i = 0; i < n; i += 1) {
    seed = (seed + 0x6d2b79f5) >>> 0;
    const r = ((seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    price = Math.max(1, price + (r - 0.5) * 0.4);
    time[i] = i * 60_000;
    close[i] = price;
  }
  return TimeSeries.fromColumns({
    name: 'bars',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'close', kind: 'number' },
    ],
    columns: { time, close },
  });
}

const med = (t) => [...t].sort((a, b) => a - b)[t.length >> 1];
function bench(f) {
  for (let i = 0; i < 6; i += 1) f(); // past V8's tier-up cliff
  const t = [];
  for (let i = 0; i < 9; i += 1) {
    const s = performance.now();
    f();
    t.push(performance.now() - s);
  }
  return med(t);
}

/** Worst relative difference and the tail count, over named columns. */
function agree(a, b, columns, n) {
  let worst = 0;
  let over = 0;
  for (const name of columns) {
    const ca = a.column(name);
    const cb = b.column(name);
    for (let i = 0; i < n; i += 1) {
      const x = ca.at(i);
      const y = cb.at(i);
      if (x === undefined || y === undefined) continue;
      const rel = Math.abs(x - y) / Math.max(1e-300, Math.abs(y));
      if (rel > worst) worst = rel;
      if (rel > 1e-9) over += 1;
    }
  }
  return { worst, over };
}

const STUDIES = [
  ['sma(20)', (s) => sma(s, { period: P }), ['sma']],
  [
    'envelope(20)',
    (s) => envelope(s, { period: P }),
    ['envMiddle', 'envUpper'],
  ],
  [
    'bollinger(20)',
    (s) => bollinger(s, { period: P }),
    ['bbMiddle', 'bbUpper', 'bbLower'],
  ],
  ['zScore(20)', (s) => zScore(s, { period: P }), ['zscore']],
  [
    'stack: sma+bollinger+zScore',
    (s) =>
      zScore(bollinger(sma(s, { period: P }), { period: P }), { period: P }),
    ['sma', 'bbMiddle', 'zscore'],
  ],
];

const plain = bars(N);
const seqResults = STUDIES.map(([, run]) => run(plain));
const seqMs = STUDIES.map(([, run]) => bench(() => run(plain)));

const fast = withWorkers(bars(N), { workers: WORKERS });
console.log(
  `${N.toLocaleString()} bars · period ${P} · ${WORKERS} workers · ${availableParallelism()} cores\n`,
);
console.log(
  '  study                        sequential    workers   speedup    worst rel   >1e-9',
);
console.log(`  ${'─'.repeat(84)}`);
STUDIES.forEach(([label, run, columns], i) => {
  const parMs = bench(() => run(fast));
  const { worst, over } = agree(run(fast), seqResults[i], columns, N);
  console.log(
    `  ${label.padEnd(28)} ${(seqMs[i].toFixed(2) + 'ms').padStart(10)}` +
      ` ${(parMs.toFixed(2) + 'ms').padStart(10)}` +
      ` ${((seqMs[i] / parMs).toFixed(2) + 'x').padStart(9)}` +
      ` ${worst.toExponential(1).padStart(12)}` +
      ` ${String(over).padStart(7)}`,
  );
});
shutdownWorkers();
console.log(
  `\n  Below MIN_ROWS (${MIN_ROWS.toLocaleString()}) a registered series still runs\n` +
    '  sequentially, so small inputs are bit-identical by construction.\n' +
    "  zScore's tail is expected: it divides by a near-zero rolling sigma.",
);
