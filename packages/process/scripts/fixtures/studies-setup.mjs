// Registry wrapping the REAL @pond-ts/financial studies — the ones the
// benchmarks page measures — so the pool is exercised on the documented
// workload rather than a hand-rolled toy op.
import { TimeSeries } from 'pond-ts';
import { createRegistry, int, num } from '../../dist/index.js';
import {
  sma,
  ema,
  bollinger,
  zScore,
  envelope,
  percentChange,
} from '../../../financial/dist/index.js';

const src = (ctx) => ctx.inputs['source'];

export default function setup(options) {
  const rows = Number(options?.rows ?? 500_000);
  const registry = createRegistry()
    .define({
      name: 'sma',
      family: 'trend',
      summary: 'SMA.',
      params: { period: int({ min: 2, default: 20 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      run: (ctx) =>
        sma(ctx.series, { period: ctx.params.period, column: src(ctx) }).column(
          'sma',
        ),
    })
    .define({
      name: 'ema',
      family: 'trend',
      summary: 'EMA.',
      params: { period: int({ min: 2, default: 20 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      run: (ctx) =>
        ema(ctx.series, { period: ctx.params.period, column: src(ctx) }).column(
          'ema',
        ),
    })
    .define({
      name: 'bollinger',
      family: 'bands',
      summary: 'Bollinger.',
      params: { period: int({ min: 2, default: 20 }) },
      inputs: [{ role: 'source' }],
      outputs: [
        { id: 'Middle', unit: 'inherit' },
        { id: 'Upper', unit: 'inherit' },
        { id: 'Lower', unit: 'inherit' },
      ],
      run: (ctx) => {
        const o = bollinger(ctx.series, {
          period: ctx.params.period,
          column: src(ctx),
        });
        return [o.column('bbMiddle'), o.column('bbUpper'), o.column('bbLower')];
      },
    })
    .define({
      name: 'zscore',
      family: 'stats',
      summary: 'Z-score.',
      params: { period: int({ min: 2, default: 20 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      run: (ctx) =>
        zScore(ctx.series, {
          period: ctx.params.period,
          column: src(ctx),
        }).column('zscore'),
    })
    .define({
      name: 'envelope',
      family: 'bands',
      summary: 'Envelope.',
      params: { period: int({ min: 2, default: 20 }) },
      inputs: [{ role: 'source' }],
      outputs: [
        { id: 'Middle', unit: 'inherit' },
        { id: 'Upper', unit: 'inherit' },
        { id: 'Lower', unit: 'inherit' },
      ],
      run: (ctx) => {
        const o = envelope(ctx.series, {
          period: ctx.params.period,
          column: src(ctx),
        });
        return [
          o.column('envMiddle'),
          o.column('envUpper'),
          o.column('envLower'),
        ];
      },
    })
    .define({
      name: 'pctChange',
      family: 'returns',
      summary: 'Percent change.',
      params: {},
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: '%' }],
      run: (ctx) =>
        percentChange(ctx.series, { column: src(ctx) }).column('percentChange'),
    });
  return { registry, datasets: { bars: makeBars(rows) } };
}

export function makeBars(n) {
  const MIN = 60000;
  let seed = 0x5eed;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const time = new Float64Array(n),
    open = new Float64Array(n),
    high = new Float64Array(n),
    low = new Float64Array(n),
    close = new Float64Array(n),
    volume = new Float64Array(n);
  let price = 100;
  for (let i = 0; i < n; i += 1) {
    const drift = (rnd() - 0.5) * 0.4,
      o = price,
      c = Math.max(1, price + drift);
    time[i] = i * MIN;
    open[i] = o;
    close[i] = c;
    high[i] = Math.max(o, c) + rnd() * 0.2;
    low[i] = Math.min(o, c) - rnd() * 0.2;
    volume[i] = Math.floor(rnd() * 10000);
    price = c;
  }
  return TimeSeries.fromColumns({
    name: 'bars',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'open', kind: 'number' },
      { name: 'high', kind: 'number' },
      { name: 'low', kind: 'number' },
      { name: 'close', kind: 'number' },
      { name: 'volume', kind: 'number' },
    ],
    columns: { time, open, high, low, close, volume },
  });
}
