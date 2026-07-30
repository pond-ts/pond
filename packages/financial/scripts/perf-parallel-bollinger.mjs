// `StudyPool.bollinger` against the sequential study — [PND-SCANKERN].
//
// Reports **speed and agreement together**, deliberately. The parallel
// study is only interesting if it tracks the sequential one closely
// enough that the pandas oracle would still hold, so a speedup printed
// without the accompanying error is a number nobody should act on.
//
// The sweep over row counts is what picks `StudyPool.MIN_ROWS`: below
// it, dispatch plus the input copy costs more than the work, and the
// pool falls back to the sequential study rather than quietly being
// slower than the function it replaces.
//
// Run:
//   npm run build --workspaces
//   node packages/financial/scripts/perf-parallel-bollinger.mjs

import { performance } from 'node:perf_hooks';
import { availableParallelism } from 'node:os';
import { TimeSeries } from 'pond-ts';
import { bollinger } from '../dist/index.js';
import { StudyPool } from '../dist/parallel/index.js';

const PERIOD = 20;
const SIZES = (process.env.PERF_SWEEP ?? '25000,100000,500000,2000000')
  .split(',')
  .map((s) => Number(s.trim()));
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

const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const bench = (f, r = 7) => {
  const t = [];
  for (let i = 0; i < r; i += 1) {
    const s = performance.now();
    f();
    t.push(performance.now() - s);
  }
  return median(t);
};
const benchA = async (f, r = 7) => {
  const t = [];
  for (let i = 0; i < r; i += 1) {
    const s = performance.now();
    await f();
    t.push(performance.now() - s);
  }
  return median(t);
};

/** Worst relative difference across the three bands, and the tail count. */
function agreement(a, b, n) {
  let worst = 0;
  let over = 0;
  let exact = 0;
  let cells = 0;
  for (const band of ['bbMiddle', 'bbUpper', 'bbLower']) {
    const ca = a.column(band);
    const cb = b.column(band);
    for (let i = 0; i < n; i += 1) {
      const x = ca.at(i);
      const y = cb.at(i);
      if (x === undefined || y === undefined) continue;
      cells += 1;
      if (x === y) exact += 1;
      const rel = Math.abs(x - y) / Math.max(1e-300, Math.abs(y));
      if (rel > worst) worst = rel;
      if (rel > 1e-9) over += 1;
    }
  }
  return { worst, over, exact, cells };
}

const pool = await StudyPool.start({ size: WORKERS });
console.log(
  `bollinger(${PERIOD}) · pool(${pool.size}) · ${availableParallelism()} cores · node ${process.versions.node}\n`,
);
console.log(
  '        rows   sequential     pooled   speedup   bit-identical   worst rel   >1e-9',
);
console.log(`  ${'─'.repeat(76)}`);

for (const n of SIZES) {
  const series = bars(n);
  const opts = { period: PERIOD };
  // Warm both paths past V8's tier-up cliff before timing either.
  for (let i = 0; i < 6; i += 1) {
    bollinger(series, opts);
    await pool.bollinger(series, opts);
  }
  const seqMs = bench(() => bollinger(series, opts));
  const parMs = await benchA(() => pool.bollinger(series, opts));
  const { worst, over, exact, cells } = agreement(
    await pool.bollinger(series, opts),
    bollinger(series, opts),
    n,
  );
  const fellBack = n < StudyPool.MIN_ROWS;
  console.log(
    `  ${n.toLocaleString().padStart(10)}` +
      ` ${(seqMs.toFixed(2) + 'ms').padStart(12)}` +
      ` ${(parMs.toFixed(2) + 'ms').padStart(10)}` +
      ` ${((seqMs / parMs).toFixed(2) + 'x').padStart(9)}` +
      ` ${(((exact / cells) * 100).toFixed(1) + '%').padStart(15)}` +
      ` ${worst.toExponential(1).padStart(11)}` +
      ` ${String(over).padStart(7)}` +
      (fellBack ? '   (fell back — sequential)' : ''),
  );
}

await pool.close();
console.log(
  `\n  Below StudyPool.MIN_ROWS (${StudyPool.MIN_ROWS.toLocaleString()}) the pool runs the\n` +
    '  sequential study, so those rows are bit-identical by construction.',
);
