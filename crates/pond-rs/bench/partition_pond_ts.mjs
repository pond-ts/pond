// pond-ts side of examples/perf_partition.rs: same data, same ops.
//
//     npm run build --workspace=pond-ts
//     node crates/pond-rs/bench/partition_pond_ts.mjs
import { TimeSeries } from '../../../packages/core/dist/index.js';

const SYMBOLS = 500;
const BARS = 1000;
let seed = 20261019;
const next = () => {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 4294967296;
};
const walk = new Array(SYMBOLS).fill(100);
const rows = [];
for (let b = 0; b < BARS; b++) {
  for (let s = 0; s < SYMBOLS; s++) {
    walk[s] += next() - 0.5;
    const name = `s${String(s).padStart(3, '0')}`;
    rows.push([b * 60_000, name, next() >= 0.02 ? walk[s] : undefined]);
  }
}
const series = new TimeSeries({
  name: 'panel',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'symbol', kind: 'string' },
    { name: 'close', kind: 'number', required: false },
  ],
  rows,
});
let sum = 0;
let gaps = 0;
for (const r of rows) {
  if (r[2] === undefined) gaps += 1;
  else sum += r[2];
}
console.log(`${rows.length} rows, ${gaps} gaps, sum ${sum}`);

const stats = {
  mean: { from: 'close', using: 'avg' },
  sd: { from: 'close', using: 'stdev' },
  close: 'last',
};
// Five warm-up runs, as in rowwise_pond_ts.mjs.
const median = (f) => {
  for (let i = 0; i < 5; i++) f();
  const t = [];
  for (let i = 0; i < 7; i++) {
    const a = performance.now();
    f();
    t.push(performance.now() - a);
  }
  t.sort((a, b) => a - b);
  return t[3];
};
const cases = [
  ['split', () => series.partitionBy('symbol').toMap()],
  [
    'diff + collect',
    () => series.partitionBy('symbol').diff('close').collect(),
  ],
  [
    'fill linear + collect',
    () => series.partitionBy('symbol').fill('linear').collect(),
  ],
  [
    'rolling 60m mean/sd + collect',
    () => series.partitionBy('symbol').rolling('60m', stats).collect(),
  ],
  [
    'Q11: rolling 60m, last z per symbol, top 20',
    () => {
      const parts = series.partitionBy('symbol').rolling('60m', stats).toMap();
      const z = [];
      for (const [name, s] of parts) {
        const last = s.at(s.length - 1);
        const x = last.get('close');
        const m = last.get('mean');
        const sd = last.get('sd');
        if (x === undefined || m === undefined || sd === undefined) continue;
        if (sd > 0) z.push([name, (x - m) / sd]);
      }
      z.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
      if (z.slice(0, 20).length !== 20) throw new Error('short');
    },
  ],
];
for (const [name, f] of cases) {
  console.log(`| ${name} | ${median(f).toFixed(1)} ms |`);
}
