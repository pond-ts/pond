// Financial studies through @pond-ts/rs ([PND-RUST-R4] J2a) against
// @pond-ts/financial on the same 1M one-minute bars (NYSE sessions, so
// sessionVwap has real days). Series in, series out on both sides: the
// bars are built once; each timing is one study call plus freeing its
// result on the bridge.
//
//     npm run build --workspace=pond-ts
//     npm run build --workspace=@pond-ts/financial
//     packages/rs/build.sh
//     node packages/rs/scripts/perf-studies.mjs

import { performance } from 'node:perf_hooks';
import * as rs from '../index.js';

// pond-ts as @pond-ts/financial resolves it, so both share one TimeSeries.
const ts = await import('pond-ts');
const fin = await import('../../financial/dist/index.js');
const BARS = Number(process.env.PERF_N ?? 1_000_000);
const WARMUP = 3;
const REPEATS = 9;

let seed = 20261031;
const next = () => {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 4294967296;
};

// Enough NYSE days for BARS one-minute bars (390 a day).
const rules = {
  timeZone: 'America/New_York',
  open: '09:30',
  close: '16:00',
};
const days = Math.ceil(BARS / 390);
const to = new Date(Date.UTC(2010, 0, 4) + Math.ceil(days * 1.45) * 86_400_000);
const range = { from: '2010-01-04', to: to.toISOString().slice(0, 10) };
const tsCal = fin.TradingCalendar.fromRules(rules, range);
const rsCal = rs.TradingCalendar.fromRules(rules, range);

const rows = [];
let close = 100;
for (const s of tsCal.sessions()) {
  for (let t = s.open; t < s.close && rows.length < BARS; t += 60_000) {
    const open = close;
    close = Math.max(1, close + (next() - 0.5) * 0.4);
    const high = Math.max(open, close) + next() * 0.2;
    const low = Math.min(open, close) - next() * 0.2;
    rows.push([t, open, high, low, close, 1000 + Math.floor(next() * 9000)]);
  }
  if (rows.length >= BARS) break;
}
const spec = {
  name: 'bars',
  schema: ['time', 'open', 'high', 'low', 'close', 'volume'].map((name, i) => ({
    name,
    kind: i ? 'number' : 'time',
  })),
  rows,
};
const a = new ts.TimeSeries(spec);
const b = new rs.TimeSeries(spec);

function benchmark(fn) {
  const run = () => {
    const r = fn();
    if (r instanceof rs.TimeSeries) r.free();
  };
  for (let i = 0; i < WARMUP; i += 1) run();
  const samples = [];
  for (let i = 0; i < REPEATS; i += 1) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  samples.sort((x, y) => x - y);
  return Number(samples[REPEATS >> 1].toFixed(1));
}

const cases = [
  ['sma', { period: 20 }],
  ['ema', { period: 20 }],
  ['rsi', { period: 14 }],
  ['bollinger', { period: 20, stdDev: 2 }],
  ['macd', {}],
  ['atr', { period: 14 }],
  ['sessionVwap', { sessions: 'calendar' }],
];

const results = cases.map(([study, options]) => {
  const withCal = (cal) =>
    options.sessions ? { ...options, sessions: cal } : options;
  const pondTsMs = benchmark(() => fin[study](a, withCal(tsCal)));
  const rsMs = benchmark(() => b[study](withCal(rsCal)));
  return {
    study,
    rsMs,
    pondTsMs,
    speedup: Number((pondTsMs / rsMs).toFixed(1)),
  };
});
console.log(JSON.stringify({ bars: rows.length, results }, null, 2));
b.free();
rsCal.free();
