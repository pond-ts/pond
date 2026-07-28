// Perf bench for the workload that actually drives this library right now:
// an agent repeatedly interrogating a large historical bar series to build
// and test trading strategies.
//
// The existing perf scripts measure synthetic metrics data through core
// operators. That is not what gets run. What gets run is: load years of
// OHLCV bars once, then ask the same series hundreds of questions — moving
// averages at several periods, bands, z-scores, returns, resamples to
// higher timeframes, and summary statistics — with an agent waiting on
// each answer.
//
// Two properties of that workload change what matters:
//
//   1. The series is RESIDENT and long-lived. Load cost amortises to
//      nothing across hundreds of queries, so per-query latency is the
//      whole story.
//   2. Queries are REPEATED and overlapping. `sma(20)`, `sma(50)` and
//      `sma(200)` each re-read the same close column; a study battery
//      re-walks the same bars many times.
//
// So this measures per-query cost on a resident series, grouped the way an
// agent actually asks: studies, resamples, and summary facts.
//
// Warm-up is by iteration count, not elapsed time — see
// `scripts/perf-operators-unboxed.mjs` for why that distinction is
// load-bearing (V8's optimising tier is a cliff, and a time-based warm-up
// silently reports whichever configuration runs first as 3-7x slow).

import { performance } from 'node:perf_hooks';
import { TimeSeries } from 'pond-ts';
import {
  sma,
  ema,
  bollinger,
  zScore,
  percentChange,
  envelope,
} from '../dist/index.js';

const BARS = Number(process.env.PERF_BARS ?? 500_000);
const WARMUP_ITERATIONS = Number(process.env.PERF_WARMUP ?? 200);
const MINUTE = 60_000;

/** OHLCV bars with a plausible random walk — dense within sessions, which
 *  is what a bar series looks like once a calendar has filtered it. */
function makeBars(n) {
  let seed = 0x5eed;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const schema = Object.freeze([
    { name: 'time', kind: 'time' },
    { name: 'open', kind: 'number' },
    { name: 'high', kind: 'number' },
    { name: 'low', kind: 'number' },
    { name: 'close', kind: 'number' },
    { name: 'volume', kind: 'number' },
  ]);
  const rows = new Array(n);
  let price = 100;
  for (let i = 0; i < n; i += 1) {
    const drift = (rnd() - 0.5) * 0.4;
    const open = price;
    const close = Math.max(1, price + drift);
    const high = Math.max(open, close) + rnd() * 0.2;
    const low = Math.min(open, close) - rnd() * 0.2;
    rows[i] = [i * MINUTE, open, high, low, close, Math.floor(rnd() * 10_000)];
    price = close;
  }
  return new TimeSeries({ name: 'bars', schema, rows });
}

function median(values) {
  const sorted = [...values].sort((l, r) => l - r);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}

function benchmark(label, group, fn, repeats = 15) {
  for (let i = 0; i < WARMUP_ITERATIONS; i += 1) fn();
  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return {
    group,
    label,
    medianMs: Number(median(samples).toFixed(3)),
    minMs: Number(Math.min(...samples).toFixed(3)),
    maxMs: Number(Math.max(...samples).toFixed(3)),
  };
}

const bars = makeBars(BARS);
const results = [];

/* ── studies: what an agent asks for a strategy ─────────────────────── */
for (const [label, fn] of [
  ['sma(20)', () => sma(bars, { period: 20 }).length],
  ['sma(200)', () => sma(bars, { period: 200 }).length],
  ['ema(20)', () => ema(bars, { period: 20 }).length],
  ['bollinger(20)', () => bollinger(bars, { period: 20 }).length],
  ['zScore(20)', () => zScore(bars, { period: 20 }).length],
  ['percentChange()', () => percentChange(bars, {}).length],
  ['envelope(20)', () => envelope(bars, { period: 20 }).length],
]) {
  results.push(benchmark(label, 'study', fn));
}

/* ── a whole strategy pass: several studies stacked ─────────────────── */
results.push(
  benchmark(
    'stack: sma20+sma50+sma200+bollinger+zscore',
    'strategy',
    () => {
      let s = sma(bars, { period: 20, output: 'sma20' });
      s = sma(s, { period: 50, output: 'sma50' });
      s = sma(s, { period: 200, output: 'sma200' });
      s = bollinger(s, { period: 20 });
      s = zScore(s, { period: 20 });
      return s.length;
    },
    5,
  ),
);

/* ── summary facts: the "tell me about this series" queries ─────────── */
for (const [label, fn] of [
  ['close.minMax()', () => bars.column('close').minMax()],
  ['close.mean()', () => bars.column('close').mean()],
  ['close.stdev()', () => bars.column('close').stdev()],
  ['close.median()', () => bars.column('close').median()],
  ['close.percentile(95)', () => bars.column('close').percentile(95)],
  [
    'volume.sum() + close.minMax()',
    () => bars.column('volume').sum() + bars.column('close').minMax()[0],
  ],
]) {
  results.push(benchmark(label, 'summary', fn, 25));
}

console.log(JSON.stringify({ bars: BARS, results }, null, 2));
