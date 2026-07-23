// Benchmarks the financial studies' hot path at market-data scale: SMA /
// EMA / Bollinger on a 1M-bar series, against the hand-rolled Float64Array
// floor (the "what a bespoke loop costs" honesty reference — it skips
// missing-cell handling, minSamples, and TimeSeries construction, so treat
// it as a floor, not a target). The studies compose on core's count-window
// `rolling` columnar fast path and `smooth('ema')`'s columnar fast path;
// run from `packages/financial/` after `npm run build` at the repo root.
import { performance } from 'node:perf_hooks';
import { TimeSeries } from 'pond-ts';
import { bollinger, ema, sma } from '../dist/index.js';

const PERIOD = 20;

function makeBars(length) {
  const time = new Float64Array(length);
  const close = new Float64Array(length);
  const volume = new Float64Array(length);
  let px = 100;
  for (let i = 0; i < length; i += 1) {
    time[i] = 1_700_000_000_000 + i * 60_000;
    px += Math.sin(i * 0.001) * 0.3 + ((i * 2654435761) % 97) / 970 - 0.05;
    close[i] = px;
    volume[i] = 1_000 + ((i * 40_503) % 5_000);
  }
  const series = TimeSeries.fromColumns({
    name: 'bars',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'close', kind: 'number' },
      { name: 'volume', kind: 'number' },
    ],
    columns: { time, close, volume },
  });
  return { series, close };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function benchmark(label, fn, repeats = 5) {
  fn(); // warm-up
  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
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

function handRolledSma(close) {
  const out = new Float64Array(close.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < close.length; i += 1) {
    sum += close[i];
    if (i >= PERIOD) sum -= close[i - PERIOD];
    if (i >= PERIOD - 1) out[i] = sum / PERIOD;
  }
  return out;
}

function handRolledEma(close) {
  const out = new Float64Array(close.length).fill(NaN);
  const alpha = 2 / (PERIOD + 1);
  let prev = close[0];
  for (let i = 1; i < close.length; i += 1) {
    prev = alpha * close[i] + (1 - alpha) * prev;
    if (i >= PERIOD - 1) out[i] = prev;
  }
  return out;
}

function scaleResults(length) {
  const { series, close } = makeBars(length);
  return {
    length,
    results: [
      benchmark('hand-rolled sma floor', () => handRolledSma(close)),
      benchmark('hand-rolled ema floor', () => handRolledEma(close)),
      benchmark('sma({ period: 20 })', () => sma(series, { period: PERIOD })),
      benchmark('ema({ period: 20 })', () => ema(series, { period: PERIOD })),
      benchmark('bollinger({ period: 20 })', () =>
        bollinger(series, { period: PERIOD }),
      ),
      benchmark('rolling({ count: 20 }, avg) [core substrate]', () =>
        series.rolling(
          { count: PERIOD },
          { value: { from: 'close', using: 'avg' } },
          { minSamples: PERIOD },
        ),
      ),
    ],
  };
}

const scales = [100_000, 1_000_000];
console.log(JSON.stringify(scales.map(scaleResults), null, 2));
