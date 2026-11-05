import { performance } from 'node:perf_hooks';
import { TimeSeries } from '../dist/index.js';

// Perf check for duration-window `rolling` ([PND-ROLLTIME]). The windows are
// found once from the keys (two indices that only move forward, O(N)), then
// each output column sweeps its source with add/remove/read on one reducer
// state: O(N) per column for avg / sum / stdev / count / first / last, plus
// the state's own cost for min / max (monotone deque, amortised O(1)) and
// median / percentiles (O(log W) per step). Before, every row also built a
// boxed result array and the result columns were re-checked and re-packed.
//
// Covers: a typical 1 s grid, ~1 row per window (the per-row floor), the
// three alignments, gaps in the values, duplicate keys, and the state-driven
// reducers.

function makeSeries(length, { gaps = false, dupes = false } = {}) {
  const time = new Float64Array(length);
  const power = new Float64Array(length);
  const hr = new Float64Array(length);
  let t = 0;
  for (let i = 0; i < length; i++) {
    t += dupes && i % 3 === 1 ? 0 : 1000;
    time[i] = t;
    power[i] = gaps && i % 17 === 0 ? NaN : 200 + 80 * Math.sin(i / 45);
    hr[i] = gaps && i % 97 === 0 ? NaN : 140 + (i % 20);
  }
  return TimeSeries.fromColumns({
    name: 'ride',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'power', kind: 'number', required: false },
      { name: 'hr', kind: 'number', required: false },
    ],
    columns: { time, power, hr },
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}

function benchmark(label, fn, repeats = 7) {
  fn(); // warm-up
  const samples = [];
  for (let r = 0; r < repeats; r += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return {
    label,
    medianMs: Number(median(samples).toFixed(2)),
    minMs: Number(Math.min(...samples).toFixed(2)),
    maxMs: Number(Math.max(...samples).toFixed(2)),
  };
}

const s36k = makeSeries(36_000);
const s100k = makeSeries(100_000);
const s1m = makeSeries(1_000_000);
const gappy = makeSeries(100_000, { gaps: true });
const dupes = makeSeries(100_000, { dupes: true });

const results = [
  benchmark('36k · 30s avg (normalized power)', () =>
    s36k.rolling('30s', { power: 'avg' }),
  ),
  benchmark('100k · 60s avg + sum', () =>
    s100k.rolling('60s', { power: 'avg', hr: 'sum' }),
  ),
  benchmark('1M · 60s avg + sum', () =>
    s1m.rolling('60s', { power: 'avg', hr: 'sum' }),
  ),
  benchmark('100k · 1ms avg (one row per window)', () =>
    s100k.rolling('1ms', { power: 'avg' }),
  ),
  benchmark('100k · 60s avg, leading', () =>
    s100k.rolling('60s', { power: 'avg' }, { alignment: 'leading' }),
  ),
  benchmark('100k · 60s avg, centered', () =>
    s100k.rolling('60s', { power: 'avg' }, { alignment: 'centered' }),
  ),
  benchmark('100k · 60s avg + sum, gaps in values', () =>
    gappy.rolling('60s', { power: 'avg', hr: 'sum' }),
  ),
  benchmark('100k · 60s avg, duplicate keys', () =>
    dupes.rolling('60s', { power: 'avg' }),
  ),
  benchmark('100k · 60s stdev', () => s100k.rolling('60s', { power: 'stdev' })),
  benchmark('100k · 60s min + max', () =>
    s100k.rolling('60s', {
      lo: { from: 'power', using: 'min' },
      hi: { from: 'power', using: 'max' },
    }),
  ),
  benchmark('100k · 60s median', () =>
    s100k.rolling('60s', { power: 'median' }),
  ),
];

console.log(JSON.stringify(results, null, 2));
