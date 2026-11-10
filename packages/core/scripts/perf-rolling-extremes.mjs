// Rolling `max` / `min` on the columnar sweep, and the finance studies that
// stand on them.
//
// Cost: O(N) per column — each row enters the deque once and leaves it at
// most once (popped by a larger/smaller row, or dropped off the head), flat
// in the window length. Before the sweep had its own deque, these ran the
// reducer state's deque, which allocates an `{ index, value }` object per
// row behind a comparator closure.
//
// Scenarios (1M rows unless ROWS is set):
//   count  — `{ count: 20 }` and `{ count: 200 }`, trailing, dense source
//   sparse — the same over a source with 90% of cells missing
//   rising / falling — the deque's best and worst shapes
//   time   — a 20-minute duration window over one-minute rows
//   avg    — `{ count: 20 }` avg, the floor every rolling study pays
//   studies — the @pond-ts/financial studies built on rolling max/min
//   controls — two studies with their own extremes kernel (should not move)
//
// Warm-up 8 calls, then the median of RUNS. Each call is timed on its own.
//
// Run:  npm run build --workspace=pond-ts --workspace=@pond-ts/financial
//       node packages/core/scripts/perf-rolling-extremes.mjs
import { performance } from 'node:perf_hooks';
import { TimeSeries } from '../dist/index.js';
import {
  donchian,
  stochastic,
  williamsR,
  ichimoku,
  choppinessIndex,
  stochasticRsi,
} from '../../financial/dist/index.js';

const ROWS = Number(process.env.ROWS ?? 1_000_000);
const RUNS = Number(process.env.RUNS ?? 7);
const WARMUP = Number(process.env.WARMUP ?? 8);
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

function bars(n, shape = 'walk', missingShare = 0) {
  let seed = 0x5eed;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const time = new Float64Array(n);
  const open = new Float64Array(n);
  const high = new Float64Array(n);
  const low = new Float64Array(n);
  const close = new Float64Array(n);
  let price = 100;
  for (let i = 0; i < n; i += 1) {
    const c =
      shape === 'rising'
        ? i
        : shape === 'falling'
          ? n - i
          : Math.max(1, price + (rnd() - 0.5) * 0.4);
    time[i] = i * 60_000;
    open[i] = price;
    close[i] = c;
    high[i] = Math.max(price, c) + rnd() * 0.2;
    low[i] = Math.min(price, c) - rnd() * 0.2;
    if (missingShare > 0 && rnd() < missingShare) close[i] = NaN;
    price = c;
  }
  return TimeSeries.fromColumns({
    name: 'bars',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'open', kind: 'number' },
      { name: 'high', kind: 'number' },
      { name: 'low', kind: 'number' },
      { name: 'close', kind: 'number', required: false },
    ],
    columns: { time, open, high, low, close },
  });
}

function time(fn) {
  for (let w = 0; w < WARMUP; w += 1) fn();
  const xs = [];
  for (let r = 0; r < RUNS; r += 1) {
    const t = performance.now();
    fn();
    xs.push(performance.now() - t);
  }
  return Number(median(xs).toFixed(1));
}

const dense = bars(ROWS);
const sparse = bars(ROWS, 'walk', 0.9);
const rising = bars(ROWS, 'rising');
const falling = bars(ROWS, 'falling');

const roll = (s, window, using) => () =>
  s.rolling(window, { x: { from: 'close', using } }, { minSamples: 0 });

const out = {
  rows: ROWS,
  runs: RUNS,
  rolling: {
    // First, so nothing timed before it changes what V8 makes of it.
    'avg count 20 (floor)': time(roll(dense, { count: 20 }, 'avg')),
    'max count 20': time(roll(dense, { count: 20 }, 'max')),
    'min count 20': time(roll(dense, { count: 20 }, 'min')),
    'max count 200': time(roll(dense, { count: 200 }, 'max')),
    'max count 20, 90% missing': time(roll(sparse, { count: 20 }, 'max')),
    'max count 20, rising': time(roll(rising, { count: 20 }, 'max')),
    'max count 20, falling': time(roll(falling, { count: 20 }, 'max')),
    'max 20m duration': time(roll(dense, '20m', 'max')),
  },
  studies: {
    donchian: time(() => donchian(dense)),
    stochastic: time(() => stochastic(dense)),
    williamsR: time(() => williamsR(dense)),
    choppinessIndex: time(() => choppinessIndex(dense)),
  },
  // Controls: these run their own extremes kernel, not rolling max/min, so
  // they should not move.
  controls: {
    ichimoku: time(() => ichimoku(dense)),
    stochasticRsi: time(() => stochasticRsi(dense)),
  },
};
console.log(JSON.stringify(out, null, 2));
